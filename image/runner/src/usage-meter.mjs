// env-internal PI_SUBSCRIPTION_AUTH: host-approved access snapshot metadata, never an operator override.
import { validateSubscriptionRequest } from "./community-auth-adapter.mjs";
import { subscriptionAccess, subscriptionRequestOverrides } from "./subscription-credentials.mjs";
import { AsyncLocalStorage } from "node:async_hooks";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { types as utilTypes } from "node:util";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readPidNamespace, runnerIdentity } from "./child-route.mjs";
import { parseAllowedModels } from "./config.mjs";
import { configError, MODEL_NOT_ALLOWED, MODEL_POLICY_UNENFORCEABLE } from "./outcome.mjs";

/**
 * Process-wide usage meter (issue #58; REQ-TOKEN-ACCOUNTING-AND-CAPS, CONST-BUDGET-BEFORE-TOKENS).
 *
 * WHY THIS EXISTS -- the negative fact that forces it:
 *
 * token-budget.mjs meters by subscribing to ONE AgentSession's event bus. That bus is PER INSTANCE:
 * `AgentSession._eventListeners` is an array on the instance and `Agent.listeners` a Set on the
 * instance, and no event carries a sessionId. A subagent session an extension spawns through
 * `createAgentSession` therefore emits NOTHING on the parent's bus. A 16-wide fanout shows up on our
 * bus as roughly ONE turn, so the run record understates spend precisely on
 * the most expensive jobs -- the opposite of what a spend control is for.
 *
 * THE CHOKE POINT, at the 0.99.1 pin (issue #509): `ModelRuntime.prototype`. Every model call an
 * in-process session makes goes through a ModelRuntime instance: createAgentSession's streamFn returns
 * `modelRuntime.streamSimple(...)` (sdk.js:260), compaction and branch summaries reuse that streamFn
 * (agent-session.js, `streamFn: this.agent.streamFunction`), the cache warmer calls
 * `modelRuntime.streamSimple` (cache-warmer.js:239), and the ModelRegistry facade an extension sees as
 * `ctx.modelRegistry` forwards stream/streamSimple/complete/classify to its runtime (model-registry.js).
 * complete/completeSimple/fetchDeferred call the instance's own stream/streamSimple/streamDeferred, so they
 * are counted through those. Wrapping the PROTOTYPE covers every instance, the runner's and any a subagent
 * extension builds with `ModelRuntime.create`, and `options.sessionId` (a declared field on pi-ai's
 * StreamOptions) still reaches it, so per-session attribution comes free. A "call" (`calls`) is a stream,
 * or a classify/images promise, the meter observed, including one that then ended as aborted before sending
 * anything; a call the meter's own brake answered never reaches a provider and is not counted.
 *
 * What moved, and why the old choke point is dead: at 0.80.7 every session dispatched through pi-ai's
 * MODULE-LEVEL api-provider registry (compat's streamSimple resolved `model.api` in it), and the meter
 * wrapped each registry entry. At 0.99.1 a session never touches that registry: ModelRuntime calls each
 * builtin provider's own api object, and ModelRegistry.registerProvider no longer writes to it. Measured:
 * the 0.80.7 meter run against 0.99.1 logged `usage_meter_unavailable`, and had it installed it would
 * have counted nothing.
 *
 * The registry still exists (pi-ai/compat, "temporary"), and it is what an extension reaches when it calls
 * pi-ai's legacy global `streamSimple`/`completeSimple` directly: pi hands extensions the compat entry for a
 * bare `@earendil-works/pi-ai` import (virtual-modules.js, and loader.js's jiti aliases). So the registry
 * half is KEPT, as the second half, for exactly those legacy paths. The two never overlap: a ModelRuntime
 * call never enters the registry, and a registry call never enters a ModelRuntime.
 *
 * Traps, each verified by probe rather than by reading source:
 *
 * 1. A BARE pi-ai SPECIFIER IS NOT ASSUMED TO BE THE COPY pi USES. Up to pi 0.99.1, where the WORKER's deps
 *    were installed too (a dev checkout, the contract-tests job), pi-ai was on disk TWICE, with separate
 *    module-level registries: the hoisted one (the WORKER's dependency) and the one nested under
 *    pi-coding-agent by its shrinkwrap, which pi used. pi 1.0.1 dropped the shrinkwrap and the root `overrides`
 *    now pin every pi package to one version, so at the 1.0.3 pin there is one copy; but a layout is a fact
 *    about one install, not a guarantee (issue #587). Hence: no static pi import anywhere in this file. The ModelRuntime CLASS is injected by run-job.mjs, which
 *    imports it from pi-coding-agent itself, so there is no candidate to choose between; and the compat
 *    half's copy is decided at runtime by IDENTITY with the module pi hands its extensions
 *    (installProcessUsageMeter), never by a resolved path.
 * 2. `resetApiProviders()` -- which `AgentSession.reload()` still calls -- WIPES the registry. So the compat
 *    half cannot be install-once; it is RE-ARMABLE, hence the unref'd re-arm interval. The prototype half
 *    has no such hazard: nothing in pi reassigns ModelRuntime's methods.
 * 3. Overriding a BUILTIN api id changes compat's own dispatch: `getBuiltinProviderForModel` answers
 *    undefined once `getApiProvider(api)` is no longer the builtin instance, so compat calls US instead of
 *    its builtin provider. The compat wrapper therefore REPRODUCES that branch (fallbackModels) rather than
 *    blindly delegating to the registry entry -- the cloudflare providers substitute baseUrl placeholders in
 *    their auth layer, and bypassing it would break exactly those.
 * 4. A virtual model (`model.api === "pi-virtual"`, 0.99.0 experimental) re-enters: ModelRuntime.streamSimple
 *    routes it and calls `this.streamSimple(physicalModel, ...)`. Only the PHYSICAL call is counted, so one
 *    request is never counted twice and the ledger names the model that actually answered.
 * 5. The two halves DO meet on one path, and it is a common one: a provider with no builtin base for the
 *    model's api -- an operator's overlay models.json provider on `openai-completions`, say -- is composed by
 *    pi so that its stream resolves `getApiProvider(model.api)` in the compat registry
 *    (provider-composer.js, `streamWith`), which is our compat wrapper. The runtime half observes the
 *    outer stream and the compat wrapper the inner one, two different objects, so the `observed` set cannot
 *    dedupe them. So each runtime call carries a TOKEN of its own (issue #543): an AsyncLocalStorage shared by
 *    the two halves of one install holds it across the lazyStream setup's awaits, and the call's options carry
 *    it under DISPATCH_MARK (pi spreads the options into the provider's, so the mark reaches the composer's
 *    registry call). The first compat call whose options carry the context's unused token on the SAME (provider,
 *    model) pair is the runtime call's own dispatch (pi's composer), already judged and counted, so the compat
 *    wrapper skips it, once (measured by usage-meter.fidelity.test.mjs: counted once). A token-carrying call on
 *    ANOTHER pair (a provider forwarding to pi-ai's legacy streamSimple with the options spread) is a full call,
 *    judged, prepared, bounded and counted on its own model, and the runtime call stays bound and counted as well:
 *    nothing proves the runtime call's answer is the forward's (a fallback provider answers itself after a failed
 *    forward), so a passthrough proxy is counted for both calls, the safe side. Every other legacy call in that context -- one an
 *    extension makes from a before_provider_request hook or an onPayload, or from a timer or a promise
 *    scheduled there -- is judged and counted like a call from outside. Before the token, the context alone
 *    decided, and such a call was judged and counted by neither half.
 *
 * METERING ONLY: this meter has no per-job token budget. It accumulates totals, the per-model ledger, cost and
 * the `metered` flag; nothing here stops a job for crossing a token amount. The one stop it still carries is the
 * model policy (MODEL_NOT_ALLOWED), judged before a call by the guard, and the child meter's fail-closed stop
 * when its ledger can no longer be written. The only bound that precedes the container is the worker's token
 * reserve (DES-TOKEN-RESERVE-AND-SETTLE), settled from this meter's totals after the run.
 */

/** Where a runtime call's options carry its dispatch token (trap #5 above): a symbol, so it is never serialised. */
export const DISPATCH_MARK = Symbol("pi-dispatch.usage-meter.dispatch");

/**
 * A runtime call's dispatch token: the model it dispatches, whether its one compat re-entry has been seen, and whether
 * it FORWARDED (issue #571): another model call was dispatched under it (a router or proxy provider calling an
 * upstream, through either half). A forwarded call's own zero usage is the router's, not a lost count, so the meter
 * does not count it `usageUnreported`; the upstream call is metered on its own.
 */
export function dispatchToken(model) {
	return { provider: model?.provider, id: model?.id, api: model?.api, used: false, forwarded: false };
}

/** Mark the dispatch the current context runs under as forwarded (dispatchToken), when there is one. */
function markForwarded(dispatch) {
	const outer = dispatch?.getStore?.();
	if (outer !== undefined && outer !== null && typeof outer === "object") outer.forwarded = true;
}

/** The call's arguments with its options (the second argument after the model, in all three stream methods) marked. */
function markOptions(args, token) {
	const marked = [...args];
	marked[1] = { ...(marked[1] ?? {}), [DISPATCH_MARK]: token };
	return marked;
}

/**
 * Whether a compat call is the runtime call's own re-entry (trap #5): its options carry the UNUSED token of the
 * context it runs in, on the same (provider, model) pair and the same api. That is pi's composer dispatching the runtime call itself,
 * which the runtime half judged and counts, so it is skipped; the claim uses the token up, so it answers true once.
 * A token-carrying call on ANOTHER pair (an extension provider forwarding to pi-ai's legacy streamSimple with the
 * options spread) is NOT a re-entry: it is a full call, judged, prepared, bounded and counted on its own model, and
 * the runtime call stays bound and counted too. Nothing here can tell that the runtime call's answer is the
 * forward's (a fallback provider answers itself after a failed forward), so a passthrough proxy is counted for both
 * calls: the safe side (PR #547's final review).
 */
function claimReentry(token, model, options) {
	if (token === undefined || token === null || token.used || options?.[DISPATCH_MARK] !== token) return false;
	// The exact (provider, id, api) the runtime call dispatched: a call on the same pair through ANOTHER api (a provider's
	// own legacy call) is not the composer's re-entry, and is judged and counted like any other.
	if (model?.provider !== token.provider || model?.id !== token.id || model?.api !== token.api) return false;
	token.used = true;
	return true;
}

/**
 * Run an admitted call's dispatch, and when it THROWS synchronously, bind `undefined` before rethrowing (issue #571):
 * the guard's bind then releases the admission rather than a later admit flushing it uncounted. The throw itself is
 * not swallowed: a throw in here is still a provider's or our bug to see.
 */
function dispatchBinding(guard, verdict, run) {
	try {
		return run();
	} catch (error) {
		if (verdict === ADMITTED) guard.bind?.(undefined);
		throw error;
	}
}

/** The sourceId the compat half's per-api registrations are filed under in pi-ai's registry. */
export const METER_PROVIDER_PREFIX = "pi-dispatch-usage-meter";
/** pi's api id for a virtual catalog entry (pi-coding-agent 0.99.1, dist/core/virtual-models.js:3). */
export const VIRTUAL_MODEL_API = "pi-virtual";
/**
 * The ModelRuntime methods the runtime half wraps. The three stream methods return an event stream; the
 * two result methods return a Promise of a result that carries `usage` (pi-ai 0.99.1 ClassifierResult,
 * AssistantImages), and both cost money on a paid provider. Every other model call on a ModelRuntime goes
 * through one of these five.
 */
export const RUNTIME_STREAM_METHODS = Object.freeze(["streamSimple", "stream", "streamDeferred"]);
export const RUNTIME_RESULT_METHODS = Object.freeze(["classify", "generateImages"]);

/**
 * The one table of the meter's stops (issue #502), and the fail-closed reason a child uses when it can no longer
 * be metered. Each row is the `errorMessage` its hard stop carries, so every stopped call says WHICH policy
 * stopped it, in the session's own transcript as well as on the exit line. Frozen: the meter refuses a reason
 * that is not a key (meter.stop throws), so a typo cannot become a stop with an `undefined` message.
 *
 * `meter-failed` is INTERNAL to the child meter: a failed ledger write leaves the child unavoidable-unmetered,
 * so it refuses its later calls rather than spend unrecorded. It is never produced by run-job's own meter, and
 * there is no token-budget row: the per-job token budget is gone.
 */
export const METER_FAILED = "meter-failed";
export const STOP_MESSAGES = Object.freeze({
	[METER_FAILED]: "pi-dispatch: metering failed",
	[MODEL_NOT_ALLOWED]: "pi-dispatch: model not allowed",
});

/**
 * Coerce a possibly-absent numeric usage field. Never propagates NaN into the totals, and never a negative (issue
 * #500): an extension's provider may report one, and a negative amount would make the totals fall, which a child
 * ledger's fold reads as a shrink and counts the child unmetered. pi-ai's own providers already clamp at 0.
 */
function finite(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Named-row cap for the exit line's `usage` ledger (INT-RUN-HISTORY-FILE-CONTRACT). Sized against the
 * worker's recovery path, not against taste: the run record is rebuilt from a bounded 8 KiB tail of
 * container stdout (worker/src/run-history.mjs, TAIL_CAP_BYTES), and an exit line the tail truncates
 * loses ALL token accounting at once -- tokens, turns and ledger together, not merely the rows that
 * pushed it over. Eight worst-case named rows keep the whole line under ~5 KB with headroom, which
 * usage-meter.test.mjs asserts against a maximal fixture; if the line ever grows, shrink THIS cap --
 * never the test's budget.
 */
const MAX_NAMED_ROWS = 8;

/**
 * The eight numerics a ledger row accumulates, zeroed. One shape for named rows and the fold bucket.
 * Token amounts only (REQ-TOKEN-ACCOUNTING-AND-CAPS): the cost/unpriced/providerBilled columns died with
 * the per-job cost guard; what a row says is what the provider reported in tokens, and nothing priced it.
 */
function emptyRow() {
	return { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, total: 0 };
}

/**
 * Add every counter of one row into another. This ONE routine is both how a call lands on its row and
 * how usageSnapshot() folds overflow rows into "other", so the ledger's invariant -- the rows partition
 * state.total exactly -- holds by construction rather than by two pieces of arithmetic agreeing.
 */
function foldRow(into, row) {
	into.calls += row.calls;
	into.input += row.input;
	into.output += row.output;
	into.cacheRead += row.cacheRead;
	into.cacheWrite += row.cacheWrite;
	into.cacheWrite1h += row.cacheWrite1h;
	into.reasoning += row.reasoning;
	into.total += row.total;
}

/**
 * The accumulator. Pure: no pi contact, no I/O, no timers -- everything pi-shaped is injected by
 * installProcessUsageMeter, so this is the part that is fully testable and always exercised.
 *
 * METERING ONLY. There is no token amount this meter can stop for: it is ALWAYS on so totals land in run
 * history, and it never aborts a session. `allowedModels` (issue #502) is the policy the brake must serve. This
 * meter only CARRIES it (as `allowed`) so the installer arms the brake for it and the exit decision can name
 * its stop; the per-call check that acts on it is the guard's (wrapModelRuntime's `guard`). It is null when
 * unset. The per-job cost guard (issue #501) and the per-job token budget are both gone.
 *
 * ONE STOP, FIRST WINS. `state.stopReason` is null until the first stop and is never overwritten: a job that
 * a model refusal stopped stays a model-not-allowed stop, and the exit line must name the cause rather than
 * the last thing to notice. `onStop(reason, detail)` fires once, on that first stop.
 *
 * `onChange()` (issue #500) fires after every change a child ledger must carry: when a call is observed (so
 * `calls` and `unresolved` rise before the provider answers, and a child killed mid-call leaves `unresolved`
 * behind), when it settles, and when the meter stops (a guard refusal raises a ledger counter). It never fires on
 * setChildren(): the parent folds on its own tick. A throw from
 * it is swallowed: it is the caller's I/O (a ledger write), and a failed write must not fail a provider call.
 *
 * `setChildren(fold)` (issue #500) hands the meter the children's totals (foldChildLedgers). From then on the
 * snapshot's totals include the children, `rootTotal`, `otherTotal` and `looseTotal` stay the parent's own,
 * and the new `childTotal` closes the partition: root + other + loose + child === total.
 */
export function createUsageMeter({ allowedModels = null, rootSessionId, onStop, onChange = null } = {}) {
	if (allowedModels !== null && (!Array.isArray(allowedModels) || allowedModels.length === 0)) {
		throw new Error("invalid PI_ALLOWED_MODELS: want a non-empty list or null");
	}
	const allowed = allowedModels === null ? null : Object.freeze(allowedModels.map((entry) => Object.freeze({ ...entry })));
	// Only a non-empty string can be the root. An undefined rootSessionId must NOT match an undefined
	// options.sessionId -- that would file every unattributed call as root and hide the fanout.
	const root = typeof rootSessionId === "string" && rootSessionId.length > 0 ? rootSessionId : null;

	const state = {
		input: 0,
		output: 0,
		// totalTokens is the BILLED total (input + output + cache read/write), so total >= input + output
		// -- deliberately. Metering keys on billed tokens; do not "fix".
		total: 0,
		// The attribution split. INVARIANT: rootTotal + otherTotal + looseTotal === total, because every
		// record() adds its billed tokens to exactly one of the three. otherTotal > 0 is spend the
		// per-session bus could not attribute to the root: a subagent session's, and at the 0.99.1 pin also
		// compaction and branch summaries, which pi sends under a FRESH session id when the caller passes
		// none (compaction.js completeSummarization, `sessionId: options.sessionId ?? uuidv7()`; measured
		// for issue #509). So otherTotal alone no longer proves a fanout; `sessions` counts the ids.
		rootTotal: 0,
		otherTotal: 0,
		looseTotal: 0,
		calls: 0,
		// Streams observed but not yet settled when the job ends. A non-zero value on the exit line means
		// the totals are a floor, not a total -- better surfaced than silently rounded down.
		unresolved: 0,
		// Calls whose answer carried no usable usage, or a broken one (issue #571, usageUnreported below):
		// pi recorded them as zeros or a partial count, or never sent a usage block, so the token total is
		// short. Counted on every run; a forward's outer call is not. This is the meter's ONE
		// completeness counter since the money floor counters died with the cost guard.
		unreported: 0,
		// The first stop's reason (a STOP_MESSAGES key), or null. Set once by stop(), never overwritten.
		stopReason: null,
		sessionIds: new Set(),
	};

	/**
	 * Stop the job for `reason`: the brake answers every later call with that reason's hard stop. First wins,
	 * and `onStop` fires only for the stop that won. SYNCHRONOUS, for record()'s reason below. A reason with
	 * no STOP_MESSAGES row throws: it is a bug in this file, and a stop with no message would brake with
	 * nothing to say.
	 */
	function stop(reason, detail) {
		if (!Object.hasOwn(STOP_MESSAGES, reason)) throw new Error(`unknown meter stop: ${reason}`);
		if (state.stopReason !== null) return false;
		state.stopReason = reason;
		onStop?.(reason, detail);
		// A stop is a change a child ledger carries (issue #500): every guard refusal stops the meter, so this is also
		// where a raised modelRefused reaches the ledger at once, not at the next call.
		changed();
		return true;
	}

	// Streams already accounted for. Two meters can sit in one dispatch chain -- a compat-half wrapper
	// re-armed over a third party's re-registration of it, or a prototype wrapper a second install layered
	// over the first -- and every link in such a chain hands us the SAME stream object; this makes the
	// double count impossible instead of merely unlikely.
	const observed = new WeakSet();

	// The per-(provider,model) ledger (issue #53; REQ-TOKEN-ACCOUNTING-AND-CAPS,
	// INT-RUN-HISTORY-FILE-CONTRACT). The flat totals above deliberately collapse the cache split --
	// `total` is the billed sum -- but WHICH model spent what is exactly the question the flat numbers
	// cannot answer, so every record also lands on a row keyed by the (provider, model) pair. NUL as
	// the separator because it is a byte neither id can carry; the ids themselves live on the row, so
	// the key never has to be parsed back apart.
	const byModel = new Map();
	// Where a call lands when its ctx names no model: kept OFF the map, so a provider literally named
	// "other" can never merge into it. Same honesty rule as `unresolved` -- a model-less call is
	// COUNTED here, never guessed onto whichever model a heuristic liked.
	const other = emptyRow();
	// The version of the pi-ai copy the meter observed with, stamped by installProcessUsageMeter once
	// it accepts a compat copy. PROVENANCE for the run record: history is observed once,
	// and a later pin bump must show as a different stamp on new records, not a silent reshaping of
	// old ones. null = unknown, and the exit line says so rather than inventing one.
	let piAiVersion = null;
	// The children's fold (setChildren), or null until the first one. null keeps the exit line exactly as it was
	// before issue #500: the three child keys appear only once a fold was handed over.
	let children = null;

	/** The caller's change hook, never allowed to throw into a provider call or a settle (see the header). */
	function changed() {
		if (onChange === null) return;
		try {
			onChange();
		} catch {
			// The hook owns its failures (a child ledger that is not rewritten reads as stale, then as unmetered).
		}
	}

	/**
	 * SYNCHRONOUS by design, like attachSessionMeter's listener: the totals must land before the caller's
	 * next line runs, so a child ledger written from the change hook already carries them.
	 */
	function record(usage, ctx = {}) {
		const u = usage ?? {};
		state.input += finite(u.input);
		state.output += finite(u.output);
		const billed = finite(u.totalTokens);
		state.total += billed;

		// A call that settled with NO usage object at all (a rejected result, a provider that sent none):
		// the token count is short by whatever it really used, which is the floor signal, counted here so
		// the rejection paths need no second bookkeeping. A usage object is judged by usageUnreported
		// (judgeUsage), which the observe paths call before this with the same message.
		if (usage === null || usage === undefined) state.unreported += 1;

		const id = typeof ctx.sessionId === "string" ? ctx.sessionId : "";
		if (id.length > 0) state.sessionIds.add(id);
		if (root !== null && id === root) state.rootTotal += billed;
		else if (id.length > 0) state.otherTotal += billed;
		else state.looseTotal += billed;

		// The ledger landing. BOTH ids or neither: a provider without a model id (or the reverse) is
		// not a pair, and a half-attributed row would be a guess wearing a label, so it goes to the
		// bucket with the other model-less calls. `billed` is the very value already
		// accumulated above, which is what makes the rows a PARTITION of the flat totals rather than a
		// second opinion on them. The cache split (cacheRead/cacheWrite/cacheWrite1h/reasoning) is kept
		// only here -- it is precisely what `total` collapses.
		const provider = typeof ctx.provider === "string" && ctx.provider.length > 0 ? ctx.provider : null;
		const modelId = typeof ctx.modelId === "string" && ctx.modelId.length > 0 ? ctx.modelId : null;
		let row = other;
		if (provider !== null && modelId !== null) {
			const key = `${provider}\u0000${modelId}`;
			row = byModel.get(key);
			if (!row) {
				row = { provider, model: modelId, ...emptyRow() };
				byModel.set(key, row);
			}
		}
		foldRow(row, {
			calls: 1,
			input: finite(u.input),
			output: finite(u.output),
			cacheRead: finite(u.cacheRead),
			cacheWrite: finite(u.cacheWrite),
			cacheWrite1h: finite(u.cacheWrite1h),
			reasoning: finite(u.reasoning),
			total: billed,
		});

		changed();
		return state;
	}

	/**
	 * Count `usageUnreported` (issue #571) for a settled answer, BEFORE record() writes the change, so a child ledger
	 * written on the settle carries it. Never for a call that forwarded (`ctx.forwarded()` true: under its dispatch
	 * another model call went out, which is metered on its own, so the outer call's zeros are a router's, not a lost
	 * count). A ctx with no model (a caller outside the two wrappers) is never counted either: the wrappers are the
	 * only observers, so such a ctx is a caller's own construction, not a call this meter can vouch for.
	 */
	function judgeUsage(message, ctx) {
		if (ctx.model === undefined) return;
		if (typeof ctx.forwarded === "function" && ctx.forwarded()) return;
		if (usageUnreported(message, ctx.model?.api)) state.unreported += 1;
	}

	/**
	 * Attach accounting to a provider stream WITHOUT consuming it.
	 *
	 * `EventStream.result()` is a memoised promise resolved from push()/end() on the terminal event,
	 * completely independent of the async iterator. Awaiting it observes; it does not steal events from
	 * pi. The stream object is returned untouched -- no proxy, no wrapper -- so identity comparisons and
	 * `instanceof` checks downstream in pi keep working.
	 */
	function observe(stream, ctx = {}) {
		if (!stream) return stream;
		// A PROMISE of a stream (issue #571): pi-ai's legacy `streamSimple`/`stream` (compat.js) return a registry
		// entry's answer as it is, so an extension's entry that answers with `Promise<stream>` reaches its caller as a
		// promise, and a caller that awaits it (a router forwarding to it) gets a working stream. pi's own paths never
		// hand one on: ModelRuntime and the provider composer wrap every provider call in lazyStream, which awaits it.
		// Counted at once, settled from the resolved stream's result(); a rejection, or a value with no result(), is a
		// call with no usage, counted `usageUnreported` as a rejected result() is.
		if (typeof stream.result !== "function") return typeof stream.then === "function" ? observePending(stream, ctx) : stream;
		if (observed.has(stream)) return stream;
		observed.add(stream);
		state.calls += 1;
		state.unresolved += 1;
		changed();
		stream.result().then(
			(message) => {
				state.unresolved -= 1;
				judgeUsage(message, ctx);
				record(message?.usage, ctx);
			},
			() => {
				// A rejected result() is pi's problem to report; swallow it here so we never turn an
				// accounting hook into an unhandled rejection that kills the container. Recorded as a call
				// with no usage, which record() counts on `unreported`: what it consumed is unknown, and
				// "unknown" is the one thing a token settlement must not read as zero.
				state.unresolved -= 1;
				record(undefined, ctx);
			},
		);
		return stream;
	}

	/** observe() for a promise of a stream (see there): the call counts now and settles from the stream it resolves to. */
	function observePending(promise, ctx) {
		if (observed.has(promise)) return promise;
		observed.add(promise);
		state.calls += 1;
		state.unresolved += 1;
		changed();
		promise
			.then((resolved) => {
				if (typeof resolved?.result !== "function") return { message: undefined };
				// A stream already observed (an async entry that forwards and resolves to the forward's own stream, which
				// this meter counted when it was dispatched): its usage is that call's. This call settles as a zero,
				// and is not judged for broken usage either, so the count lands once.
				if (observed.has(resolved)) return { counted: true };
				observed.add(resolved);
				return resolved.result().then((message) => ({ message }));
			})
			.then(
				({ message, counted }) => {
					state.unresolved -= 1;
					if (counted) {
						record(zeroUsage(), ctx);
						return;
					}
					judgeUsage(message, ctx);
					record(message?.usage, ctx);
				},
				() => {
					state.unresolved -= 1;
					record(undefined, ctx);
				},
			);
		return promise;
	}

	/**
	 * The same accounting for a call that answers with a PROMISE of a result rather than a stream:
	 * ModelRuntime.classify and generateImages (pi-ai 0.99.1), both of which carry `usage` on the result
	 * and cost money on a paid provider. Both are documented never to reject; a rejection is swallowed
	 * all the same, for observe()'s reason. The promise is returned untouched.
	 */
	function observeResult(promise, ctx = {}) {
		if (!promise || typeof promise.then !== "function") return promise;
		state.calls += 1;
		state.unresolved += 1;
		changed();
		promise.then(
			(result) => {
				state.unresolved -= 1;
				judgeUsage(result, ctx);
				record(result?.usage, ctx);
			},
			() => {
				state.unresolved -= 1;
				record(undefined, ctx);
			},
		);
		return promise;
	}

	/** The exit-line shape. `metered: true` marks totals that came from here, not from the session bus. */
	function snapshot() {
		const child = children ?? { input: 0, output: 0, total: 0, calls: 0, unresolved: 0, sessions: 0 };
		return {
			input: state.input + child.input,
			output: state.output + child.output,
			total: state.total + child.total,
			metered: true,
			// The parent's own split. With children, childTotal below is the fourth part of the partition.
			rootTotal: state.rootTotal,
			otherTotal: state.otherTotal,
			looseTotal: state.looseTotal,
			sessions: state.sessionIds.size + child.sessions,
			calls: state.calls + child.calls,
			unresolved: state.unresolved + child.unresolved,
			...(children === null ? {} : { childTotal: children.total, childProcesses: children.processes, unmeteredChildren: children.unmetered }),
			// Issue #571: on every metered line, the children's included (their ledgers carry it).
			usageUnreported: state.unreported + (children?.unreported ?? 0),
		};
	}

	/**
	 * Hand over the children's totals (issue #500): a foldChildLedgers result, cumulative. Two rules keep a bad fold
	 * from ever reading as less spend:
	 *   - SATURATE, never zero. A number the meter cannot carry (not a number, negative, not finite, or above
	 *     Number.MAX_SAFE_INTEGER) is taken as MAX_SAFE_INTEGER: "too much to count" must read as a lot, never as
	 *     nothing, or two forged ledgers whose sum overflows would erase a real child's spend.
	 *   - A HIGH-WATER MARK per field. Every total but `unresolved` is the larger of the last one and this one, and so
	 *     is every row field by pair, so a fold that lost its `prev` (a caught throw, a bug) cannot forget spend.
	 *     `unresolved` follows the fold: a call that settled is no longer in flight. So does `unmetered`, which the
	 *     children hook keeps itself (it may un-count a child that was slow to start).
	 * There is no cap check here: the fold feeds totals, the ledger and the child counts only.
	 */
	function setChildren(fold) {
		const carry = (value) => (typeof value === "number" && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : Number.MAX_SAFE_INTEGER);
		const totals = fold?.totals ?? {};
		const held = children;
		const high = (key, value) => Math.max(held?.[key] ?? 0, carry(value));
		const rows = new Map((held?.rows ?? []).map((row) => [rowKey(row), { ...row }]));
		for (const given of Array.isArray(fold?.rows) ? fold.rows : []) {
			const named = typeof given?.provider === "string" && typeof given?.model === "string";
			const row = { provider: named ? given.provider : null, model: named ? given.model : null };
			const into = rows.get(rowKey(row)) ?? { ...row, ...emptyRow() };
			for (const key of Object.keys(emptyRow())) into[key] = Math.max(into[key], carry(given[key]));
			rows.set(rowKey(row), into);
		}
		children = {
			input: high("input", totals.input),
			output: high("output", totals.output),
			total: high("total", totals.total),
			calls: high("calls", totals.calls),
			unresolved: carry(totals.unresolved),
			sessions: high("sessions", totals.sessions),
			processes: high("processes", fold?.processes),
			// Not a high-water mark (issue #500 part E's review): the hook's count only grows, except for a child it held
			// `starting` too long and then saw install its meter, which it un-counts.
			unmetered: carry(fold?.unmetered ?? 0),
			// Issue #571: the children's broken-usage calls, a high-water mark like the totals.
			unreported: high("unreported", fold?.usageUnreported ?? 0),
			rows: [...rows.values()],
		};
	}

	/**
	 * The meter's own rows for a child ledger (issue #500): named rows in FIRST-SEEN order, then at most one
	 * model-less row with `provider` and `model` null. First-seen, not top-by-total, so a row once written stays
	 * named and only grows; a sorted cut could move a row into the bucket, and the parent's fold would read that
	 * as a shrink. Capped at CHILD_LEDGER_ROWS rows: the named rows past CHILD_LEDGER_ROWS - 1, and any row whose
	 * id the worker's pattern refuses (USAGE_ID_PATTERN, after lowercasing as the worker does), fold into the
	 * model-less row, so the file the parent reads is never refused for a row the child could have kept honest.
	 * The rows partition the meter's settled totals, as usageSnapshot's do. Copies: the caller cannot reach state.
	 */
	function rows() {
		const kept = [];
		const bucket = { ...other };
		for (const row of byModel.values()) {
			const recordable = recordableId(row.provider) && recordableId(row.model);
			if (recordable && kept.length < CHILD_LEDGER_ROWS - 1) kept.push({ ...row });
			else foldRow(bucket, row);
		}
		if (bucket.calls > 0) kept.push({ provider: null, model: null, ...bucket });
		return kept;
	}

	/**
	 * The exit line's `usage` block (INT-RUN-HISTORY-FILE-CONTRACT), or null when the meter observed no
	 * provider call at all. run-job.mjs OMITS the key on null rather than emitting `usage: null`, so a
	 * zero-call run keeps the exit line a pre-ledger reader already knows -- absence IS the signal, the
	 * same way `metered: false` is for the fallback meter.
	 *
	 * Emission is bounded to MAX_NAMED_ROWS named rows -- top by billed total; sort() is stable, so
	 * ties keep first-seen order and re-emission is deterministic -- plus at most one "other" row that
	 * absorbs BOTH the folded overflow and the model-less calls. `truncated` counts only the folded
	 * NAMED rows: a model-less call was never a row to lose, merely a call that refused to be guessed
	 * about. The fold targets a COPY of the bucket, so calling this twice cannot compound overflow into
	 * live state, and because the fold is numeric the emitted rows still sum to state.total exactly.
	 */
	function usageSnapshot() {
		if (state.calls + (children?.calls ?? 0) === 0) return null;
		// The children's rows (issue #500) merge BEFORE the cut, onto the parent's row for the same pair or a row of
		// their own, and a model-less child row into the bucket, so the 8-row cut ranks the job's whole spend and the
		// emitted rows still sum to the snapshot's total. Merged on copies: live state is never touched.
		const merged = new Map([...byModel].map(([key, row]) => [key, { ...row }]));
		const overflow = { ...other };
		for (const row of children?.rows ?? []) {
			if (row.provider === null || row.model === null) {
				foldRow(overflow, row);
				continue;
			}
			const key = `${row.provider}\u0000${row.model}`;
			let into = merged.get(key);
			if (!into) {
				into = { provider: row.provider, model: row.model, ...emptyRow() };
				merged.set(key, into);
			}
			foldRow(into, row);
		}
		const named = [...merged.values()].sort((a, b) => b.total - a.total);
		const folded = named.slice(MAX_NAMED_ROWS);
		for (const row of folded) foldRow(overflow, row);
		const models = named.slice(0, MAX_NAMED_ROWS).map((row) => ({ ...row }));
		if (overflow.calls > 0) models.push({ provider: "other", model: "other", ...overflow });
		return { v: 1, piAi: piAiVersion, truncated: folded.length, models };
	}

	/**
	 * Stamp the ledger's provenance. Only a non-empty string is stored: the installer's version probe is
	 * best-effort, and `piAi` on the exit line must be a real version or null -- never "", never some
	 * object that would serialise into the run record as a shape its readers have to defend against.
	 */
	function setPiAiVersion(version) {
		if (typeof version === "string" && version.length > 0) piAiVersion = version;
	}

	return { state, allowed, stop, record, observe, observeResult, snapshot, usageSnapshot, setPiAiVersion, rows, setChildren };
}


/** The zero usage a call the meter's brake answered carries: nothing was spent, so nothing may be recorded as spent. */
function zeroUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/**
 * The copy of the model a call was made on that the guard judges AND pi is handed (issue #502, PR #538's review; made a
 * data-only deep copy in issue #587's review). pi reads the nested objects (the sampling layers, compat with its
 * fallbacks and maxTokensField, cost with its tiers) after an await, so anything handed over by reference could change
 * between the verdict and the request. THE RULE: every field is copied as plain own data, at any depth (dataCopy):
 * plain objects (prototype Object.prototype or null), arrays, primitives and typed arrays (copied). Anything else, a
 * class instance, a Proxy, an accessor, a property hidden from Object.keys, a symbol key, a function or a symbol where
 * data is expected, makes the copy UNREADABLE (isUnreadable), and both guards refuse it: no field is ever kept by
 * reference. The two sampling fields are copied into null-prototype objects, so a level pi reads by property access
 * (`byLevel?.[level]`) cannot come from Object.prototype either.
 */
function snapshotModel(model) {
	if (model === null || typeof model !== "object") return model;
	try {
		return ownDataObject(model, (key, value) => dataCopy(value, key === "samplingParamsByThinkingLevel" ? 2 : key === "samplingParams" ? 1 : 0), false);
	} catch (error) {
		if (error !== NOT_DATA) throw error;
		const copy = { ...model };
		UNREADABLE_COPIES.add(copy);
		return copy;
	}
}

/**
 * The call's options, copied for the same reason: one read of each own field, and a data-only deep copy of the two pi
 * reads after an await and the guards judge, `samplingParams` and `env` (the per-call deployment map,
 * PI_CACHE_RETENTION). Anything else is handed over as given (a signal, the caller's onPayload). Either of the two that
 * is not plain data makes the options UNREADABLE.
 */
function snapshotOptions(options) {
	if (options === null || typeof options !== "object") return options;
	const copy = { ...options };
	try {
		if (Object.hasOwn(copy, "samplingParams")) copy.samplingParams = dataCopy(copy.samplingParams, 1);
		if (Object.hasOwn(copy, "env")) copy.env = dataCopy(copy.env, 0);
	} catch (error) {
		if (error !== NOT_DATA) throw error;
		UNREADABLE_COPIES.add(copy);
	}
	return copy;
}

/** A call's arguments with its options (the LAST argument on every wrapped method) copied by snapshotOptions. */
function snapshotArgs(args) {
	if (!Array.isArray(args) || args.length === 0) return args;
	return [...args.slice(0, -1), snapshotOptions(args.at(-1))];
}

/** The copies (snapshotModel, snapshotOptions) that held something other than plain data: both guards refuse them. */
const UNREADABLE_COPIES = new WeakSet();
export function isUnreadable(value) {
	return value !== null && typeof value === "object" && UNREADABLE_COPIES.has(value);
}

/** Thrown inside dataCopy for a value that is not plain data; never escapes snapshotModel and snapshotOptions. */
const NOT_DATA = Symbol("not plain data");
const ARRAY_INDEX = /^(?:0|[1-9][0-9]*)$/;
const DATA_COPY_DEPTH = 64;

/**
 * A deep copy of plain data, or a throw of NOT_DATA (snapshotModel has the rule). Each property is read ONCE, from its
 * descriptor, so a Proxy's traps or a getter are never consulted twice; a Proxy is refused outright (util.types.isProxy).
 * `nullDepth` levels of plain objects from the top are copied with a null prototype (the sampling fields).
 */
function dataCopy(value, nullDepth = 0, depth = 0) {
	if (value === null || value === undefined) return value;
	const type = typeof value;
	if (type === "string" || type === "number" || type === "boolean" || type === "bigint") return value;
	if (type !== "object" || depth > DATA_COPY_DEPTH || utilTypes.isProxy(value)) throw NOT_DATA;
	if (ArrayBuffer.isView(value)) {
		if (value instanceof DataView) throw NOT_DATA;
		return value.slice();
	}
	if (Array.isArray(value)) {
		if (Object.getPrototypeOf(value) !== Array.prototype) throw NOT_DATA;
		const out = [];
		for (const key of Reflect.ownKeys(value)) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (key === "length") {
				out.length = descriptor.value;
				continue;
			}
			if (typeof key !== "string" || !ARRAY_INDEX.test(key) || !descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw NOT_DATA;
			out[Number(key)] = dataCopy(descriptor.value, 0, depth + 1);
		}
		return out;
	}
	return ownDataObject(value, (_key, inner) => dataCopy(inner, Math.max(0, nullDepth - 1), depth + 1), nullDepth > 0);
}

/** A plain object's own data, each value through `copyValue(key, value)`, or a throw of NOT_DATA. */
function ownDataObject(value, copyValue, nullProto) {
	if (utilTypes.isProxy(value)) throw NOT_DATA;
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) throw NOT_DATA;
	const out = nullProto ? Object.create(null) : {};
	for (const key of Reflect.ownKeys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (typeof key !== "string" || !descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw NOT_DATA;
		out[key] = copyValue(key, descriptor.value);
	}
	return out;
}

/**
 * Whether `value` is a plain object of own data: its prototype is Object.prototype or null, and every own key is a
 * string naming an enumerable data property (no getter, nothing hidden from Object.keys). pi reads a level by property
 * access (`byLevel?.[level]`), so an inherited, non-enumerable or accessor level reaches the request while Object.values
 * never sees it (issue #587's review measured `Object.create({ off: { model } })` on the wire, unrefused). The copies
 * pi is handed always pass it; a caller's own object judged without a copy is held to it here.
 */
function isOwnData(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) return false;
	for (const key of Reflect.ownKeys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (typeof key !== "string" || !descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return false;
	}
	return true;
}

/** The verdict for a call the guard judged and let through: dispatch it, and bind it to its settle. */
const ADMITTED = Symbol("admitted");

/**
 * What an `isStopped()` answer means (issue #500): null, undefined or false is "go"; a STOP_MESSAGES key is a stop
 * for that reason. Fail closed on everything else: any other truthy answer, or a throw, is a model-policy stop,
 * the brake's only policy message now that the token budget is gone. A STOP that cannot be read is still a STOP,
 * and a child that ignored a garbled one could call a model its parent's list forbids.
 */
function externalStop(isStopped) {
	let answer;
	try {
		answer = isStopped();
	} catch {
		return MODEL_NOT_ALLOWED;
	}
	if (answer === null || answer === undefined || answer === false) return null;
	return typeof answer === "string" && Object.hasOwn(STOP_MESSAGES, answer) ? answer : MODEL_NOT_ALLOWED;
}

/**
 * One call's verdict, for both halves: the stop reason that ends it, null to dispatch it unjudged, or ADMITTED.
 *
 * THE GUARD CONTRACT (issue #502). `guard.admit({ method, model, args })` answers null or undefined to let
 * the call through, or a STOP_MESSAGES key to refuse it. Nothing else: a falsy non-null answer (false, 0, "")
 * reaches meter.stop() and throws, on purpose, because a guard that meant "pass" and said `false` would otherwise
 * stop a job with a reason no table names. `guard.bind(result)`, when the guard has one, is called synchronously
 * with what the call it just admitted returned (a stream, or a promise for the two result methods), so the
 * guard can hold onto the call until it settles. A call is judged only while a brake exists, because a refusal
 * with no hard stop to answer with would have to dispatch the call it refused; `skip` is a call the guard must
 * not judge (a virtual model, whose physical re-entry is judged instead, or a compat call already judged by
 * the runtime half).
 */
function judge({ meter, hardStop, guard, method, model, args, skip, isStopped = null, legacy = false }) {
	if (!hardStop) return null;
	if (meter.state.stopReason !== null) return meter.state.stopReason;
	// A stop from OUTSIDE this process (issue #500: a child reads the parent's STOP file), asked before every
	// dispatch, so a parent's stop brakes the child's NEXT call. It becomes this meter's own stop (first wins).
	if (isStopped !== null) {
		const reason = externalStop(isStopped);
		if (reason !== null) {
			meter.stop(reason);
			return meter.state.stopReason;
		}
	}
	if (guard === null || skip) return null;
	const refused = guard.admit({ method, model, args, ...(legacy ? { legacy: true } : {}) });
	if (refused === null || refused === undefined) return ADMITTED;
	meter.stop(refused);
	return meter.state.stopReason;
}

/**
 * THE RUNTIME HALF: wrap ModelRuntime's model-calling methods on its PROTOTYPE, so every instance -- the
 * runner's own and any an extension creates -- is metered, and return how to undo it.
 *
 * Per call, in this order:
 *   1. The brake. Checked before dispatch, so a stop ends the NEXT call rather than merely recording it.
 *      A stream method answers with `hardStop(model, message)` (makeHardStopStream below), the message
 *      being the stop reason's STOP_MESSAGES row; a result method answers with an aborted result of its own
 *      kind, zero usage, and never calls the provider. Virtual or not: once stopped nothing is dispatched.
 *      `isStopped()`, when given (issue #500), is asked here too, before the guard and before dispatch: a stop
 *      decided outside this process (a parent's STOP file) becomes this meter's stop (externalStop has the rule).
 *   2. A virtual model passes straight through UNOBSERVED and UNGUARDED (trap #4 in the header):
 *      ModelRuntime routes it and calls `this.streamSimple` again with the physical model, which is the call
 *      that is guarded and counted, so one request is judged once and on the model that will answer it.
 *   3. THE GUARD SEAM (issue #502). A physical call is offered to `guard.admit({ method, model, args })`
 *      before dispatch (a guard is `{ enforces, admit }`, `enforces` listing the stop reasons it can refuse
 *      for, which is what assertPoliciesEnforceable reads). It answers null to let the call through, or a STOP_MESSAGES reason to refuse it: the
 *      meter stops with that reason and this call gets the hard stop, so the refused call is the first one
 *      braked. An admitted call is handed to `guard.bind` once dispatched (judge() above has the contract).
 *      The guard is consulted only while a brake exists, because a refusal with no hard stop to answer with
 *      would have to dispatch the call it just refused; the runner refuses before the first prompt when a
 *      policy is set and the brake is missing (assertPoliciesEnforceable). The guard is createPolicyGuard's
 *      model guard (issue #502, only when a list is set); with no list there is no guard, and every call goes
 *      through exactly as before. No token cap is judged here (there is none): the only stop this seam
 *      enforces is the model list.
 *   4. Everything else is the original method, its stream observed (or its promise, for classify and
 *      generateImages) with the (provider, model) pair read off the Model object dispatched on and the
 *      sessionId off the options -- never parsed back out of a settled message, whose provider/model a
 *      provider is free to normalise, alias or omit.
 *
 * `this` is preserved on every call, because the originals read instance state (credentials, providers).
 * There is deliberately NO swallowing try/catch: a throw in here is OUR bug, and swallowing it would turn a metering
 * defect into a silent provider outage that looks like a model error. The one catch (dispatchBinding) rethrows: it
 * only tells the guard that an admitted dispatch threw before it answered.
 *
 * `restore()` puts back each original only while the prototype still holds OUR wrapper, so a wrapper a
 * later install layered on top is never torn out from under it; in that case this layer is switched to
 * pass-through instead, so it stops counting without breaking the chain.
 */
export function wrapModelRuntime({ ModelRuntime, meter, hardStop = null, hardStopResult = defaultHardStopResult, guard = null, dispatch = new AsyncLocalStorage(), isStopped = null }) {
	const proto = ModelRuntime?.prototype;
	const originals = new Map();
	const wrappers = new Map();
	let active = true;
	// `model` and `forwarded` (issue #571) let the meter judge the settled answer's usage (judgeUsage).
	const ctxOf = (model, options, token) => ({ sessionId: options?.sessionId, provider: model?.provider, modelId: model?.id, model, forwarded: () => token.forwarded });
	// Steps 1 and 3 above, shared by every method: the stop reason that ends this call, or null to dispatch it
	// unjudged, or ADMITTED when the guard judged it and let it through (it is then bound to its settle below).
	// Only streamSimple re-enters with the physical model (trap #4); a virtual model on any other method is judged as
	// itself: under a list it is refused unless the list
	// names the virtual entry itself (pi then fails such an unrouted call without reaching a provider).
	const verdictFor = (method, model, args) => judge({ meter, hardStop, guard, method, model, args, isStopped, skip: method === "streamSimple" && model?.api === VIRTUAL_MODEL_API });
	// The call's arguments as the guard prepared them for an admitted call (the model guard wraps options.onPayload).
	const prepareFor = (verdict, method, model, args) => (verdict === ADMITTED && typeof guard.prepare === "function" ? guard.prepare({ method, model, args, stop: (reason) => meter.stop(reason) }) : args);
	// Judged and dispatched on ONE copy (issue #502, PR #538's review): a model whose fields are getters could
	// answer the guard with one id and the provider with another. Only while a guard can judge, so a job with no
	// policy dispatches the caller's own object exactly as before.
	const judgedModel = (model) => (guard !== null && hardStop ? snapshotModel(model) : model);
	// The options too, on the same condition (issue #587's review): their sampling parameters and env are read after an await.
	const judgedArgs = (args) => (guard !== null && hardStop ? snapshotArgs(args) : args);
	const dispatchOrUnanswered = (verdict, run) => dispatchBinding(guard, verdict, run);

	for (const name of RUNTIME_STREAM_METHODS) {
		const original = proto?.[name];
		if (typeof original !== "function") continue;
		const wrapper = function (requested, ...passed) {
			if (!active) return original.call(this, requested, ...passed);
			const model = judgedModel(requested);
			const given = judgedArgs(passed);
			const verdict = verdictFor(name, model, given);
			if (verdict !== null && verdict !== ADMITTED) return hardStop(model, STOP_MESSAGES[verdict]);
			// Trap #5: everything this call dispatches, across its awaits, runs under this call's own token, and its
			// options carry the token, so the compat half can tell this call's re-entry from any other call there.
			const token = dispatchToken(model);
			const rest = markOptions(prepareFor(verdict, name, model, given), token);
			// A call dispatched under another runtime call's dispatch is that call's forward (issue #571).
			markForwarded(dispatch);
			const stream = dispatchOrUnanswered(verdict, () => dispatch.run(token, () => original.call(this, model, ...rest)));
			if (verdict === ADMITTED) guard.bind?.(stream);
			if (model?.api === VIRTUAL_MODEL_API) return stream;
			// streamSimple/stream take (model, context, options); streamDeferred takes (model, handle, options).
			// Options are the LAST argument in all three.
			return meter.observe(stream, ctxOf(model, rest.at(-1), token));
		};
		originals.set(name, original);
		wrappers.set(name, wrapper);
	}
	for (const name of RUNTIME_RESULT_METHODS) {
		const original = proto?.[name];
		if (typeof original !== "function") continue;
		const wrapper = function (requested, context, passed) {
			if (!active) return original.call(this, requested, context, passed);
			const model = judgedModel(requested);
			const [, given] = judgedArgs([context, passed]);
			const verdict = verdictFor(name, model, [context, given]);
			if (verdict !== null && verdict !== ADMITTED) return Promise.resolve(hardStopResult(name, model, STOP_MESSAGES[verdict]));
			const [, options] = prepareFor(verdict, name, model, [context, given]);
			// A token too, though no result method re-enters the compat half: a legacy call made inside it is never its own.
			const token = dispatchToken(model);
			markForwarded(dispatch);
			const promise = dispatchOrUnanswered(verdict, () => dispatch.run(token, () => original.call(this, model, context, options)));
			if (verdict === ADMITTED) guard.bind?.(promise);
			if (model?.api === VIRTUAL_MODEL_API) return promise;
			return meter.observeResult(promise, ctxOf(model, options, token));
		};
		originals.set(name, original);
		wrappers.set(name, wrapper);
	}
	for (const [name, wrapper] of wrappers) proto[name] = wrapper;

	return {
		methods: [...wrappers.keys()],
		/** True when `runtime` dispatches through this layer: an instance of the class, no own-property shadow. */
		covers(runtime) {
			if (!(runtime instanceof ModelRuntime)) return false;
			return [...wrappers].every(([name, wrapper]) => runtime[name] === wrapper);
		},
		restore() {
			active = false;
			for (const [name, wrapper] of wrappers) {
				if (proto[name] === wrapper) proto[name] = originals.get(name);
			}
		},
	};
}

/**
 * The aborted result a braked classify or generateImages call answers with: the shape pi-ai's own
 * classifierErrorResult/imageErrorResult build (pi-ai 0.99.1, utils/model-operations.js), with zero usage
 * and `stopReason: "aborted"`, for the reason makeHardStopStream gives.
 */
export function defaultHardStopResult(method, model, message = STOP_MESSAGES[MODEL_NOT_ALLOWED]) {
	const base = { api: model?.api, provider: model?.provider, model: model?.id, usage: zeroUsage(), stopReason: "aborted", errorMessage: message, timestamp: Date.now() };
	return method === "generateImages" ? { ...base, output: [] } : { ...base, answers: {} };
}

/**
 * THE COMPAT HALF: a registry-entry-shaped `{ stream, streamSimple }` that mirrors compat's OWN dispatch and
 * meters the result, for extensions that call pi-ai's legacy global stream functions.
 *
 * Once we override an api id, compat's `getBuiltinProviderForModel` answers undefined and compat routes
 * catalog models to us instead of to its builtin provider. Reproducing that branch here is not
 * belt-and-braces (trap #3). It mirrors pi-ai 0.99.1 compat.js exactly: a model whose PROVIDER the builtin
 * catalog knows, with some model on the same api, goes to that provider's own stream function; the
 * cloudflare providers go through the catalog collection itself, whose auth layer substitutes their baseUrl
 * placeholders. compat decides the cloudflare case on whether the caller passed an explicit credential, and
 * it applies the env key BEFORE calling a registry entry, so by the time we are called that distinction is
 * gone; the collection's auth layer is correct whichever it was (it lets an explicit key win), so cloudflare
 * always takes it here.
 *
 * The ONE call that is a runtime call's own re-entry (`dispatch`, trap #5: its options carry the unused token of the
 * context it runs in, on the same (provider, model) pair) is routed the same way and NOT observed: the runtime half
 * already counted it. Nor is it offered to the guard: the runtime half already judged it, and judging one request
 * twice would double the admission. A FORWARD (the token on another pair) is a full call here: judged, prepared,
 * and observed below under its own model, while the runtime call keeps its own count. Every other legacy call, made
 * inside a runtime call's context (a hook, an onPayload, a timer scheduled there) or outside any, is guarded and
 * observed here exactly as wrapModelRuntime's step 3 guards a runtime call (issue #543).
 *
 * There is deliberately NO swallowing try/catch, for the reason wrapModelRuntime gives (dispatchBinding rethrows).
 */
export function wrapProviderStreams({ inner, fallbackModels, meter, hardStop, guard = null, dispatch = null, isStopped = null }) {
	const dispatchOrUnanswered = (verdict, run) => dispatchBinding(guard, verdict, run);
	function route(kind, requested, context, passed) {
		// One copy, judged and dispatched (wrapModelRuntime's judgedModel has the why), its options likewise.
		const model = guard !== null && hardStop ? snapshotModel(requested) : requested;
		const given = guard !== null && hardStop ? snapshotOptions(passed) : passed;
		// Checked before dispatch, so a stop ends the NEXT call rather than merely recording it.
		// The runtime call's own re-entry is skipped; any other call, a forward to another pair included, is judged.
		const reentry = claimReentry(dispatch?.getStore(), model, given);
		const verdict = judge({ meter, hardStop, guard, method: kind, model, args: [context, given], skip: reentry, isStopped, legacy: true });
		if (verdict !== null && verdict !== ADMITTED) return hardStop(model, STOP_MESSAGES[verdict]);
		const options = verdict === ADMITTED && typeof guard.prepare === "function" ? guard.prepare({ method: kind, model, args: [context, given], stop: (reason) => meter.stop(reason) })[1] : given;
		const provider = fallbackModels?.getProvider?.(model.provider);
		const builtin = provider?.getModels?.().some((candidate) => candidate.api === model.api) ? provider : null;
		// Any call other than the runtime call's own re-entry, made under a runtime call's dispatch, is that call's forward
		// (issue #571), marked BEFORE it is dispatched as the runtime half does, so a forward that throws marks it too.
		if (!reentry) markForwarded(dispatch);
		const stream = dispatchOrUnanswered(verdict, () =>
			builtin
				? model.provider.startsWith("cloudflare-")
					? fallbackModels[kind](model, context, options)
					: builtin[kind](model, context, options)
				: inner[kind](model, context, options),
		);
		if (verdict === ADMITTED) guard.bind?.(stream);
		if (reentry) return stream;
		return meter.observe(stream, { sessionId: options?.sessionId, provider: model.provider, modelId: model.id, model });
	}
	return {
		stream: (model, context, options) => route("stream", model, context, options),
		streamSimple: (model, context, options) => route("streamSimple", model, context, options),
	};
}

/**
 * A terminal stream that ends a call before it reaches a provider.
 *
 * Shape mirrors pi-ai's `createSetupErrorMessage` (dist/api/lazy.js) so pi's consumers see something
 * they already understand, with two deliberate differences: zero usage (nothing was spent, and
 * inventing usage here would corrupt the very totals this module exists to get right) and
 * `stopReason: "aborted"` rather than `"error"`. That second one matters: pi's
 * `isRetryableAssistantError` returns false whenever stopReason !== "error", so an aborted terminal
 * message will NOT spin pi's auto-retry. An "error" here would make a policy stop trigger paid retries.
 *
 * `createStream` is injected -- that is what keeps this function pure and this file free of any static
 * pi import. installProcessUsageMeter passes the real `createAssistantMessageEventStream` it pulled off
 * the accepted compat module; tests pass a fake.
 *
 * The returned function is `(model, message)`: the wrappers pass the stop reason's STOP_MESSAGES row, so one
 * brake serves every stop. `message` given here is only the default for a caller that passes none.
 */
export function makeHardStopStream({ createStream, message: defaultMessage = STOP_MESSAGES[MODEL_NOT_ALLOWED] }) {
	if (typeof createStream !== "function") throw new Error("makeHardStopStream requires createStream");
	return (model, message = defaultMessage) => {
		const stream = createStream();
		const aborted = {
			role: "assistant",
			content: [],
			api: model?.api,
			provider: model?.provider,
			model: model?.id,
			usage: zeroUsage(),
			stopReason: "aborted",
			errorMessage: message,
			timestamp: Date.now(),
		};
		// push() resolves result() via the terminal-event predicate; end() covers a stream implementation
		// that does not. Both are idempotent on pi's EventStream (`done` short-circuits push).
		stream.push({ type: "error", reason: "aborted", error: aborted });
		stream.end(aborted);
		return stream;
	};
}

/** Resolve a specifier to a URL string, or null when the package is not installed. */
function tryResolve(resolve, specifier) {
	try {
		const url = resolve(specifier);
		return typeof url === "string" && url.length > 0 ? url : null;
	} catch {
		return null;
	}
}

/**
 * The package directory of the copy of `@earendil-works/<name>` that pi-coding-agent's OWN bare imports resolve
 * to, or null. Found by identity of position, not by a fixed path: pi-coding-agent's package root is located from
 * its resolved entry, and then Node's own lookup for a bare import made from inside that package is walked (its
 * `node_modules`, then each ancestor's, skipping a directory that is itself a `node_modules`). Whatever npm does
 * with the tree, the first hit is the file pi's own `import "@earendil-works/<name>"` loads.
 *
 * Why not a fixed nested path (issue #587): up to pi 0.99.1 pi-coding-agent shipped an npm-shrinkwrap.json, so
 * pi-ai and pi-agent-core were always NESTED under it, and every site that wanted pi's copy hard-coded
 * `pi-coding-agent/node_modules/@earendil-works/...`. pi-coding-agent 1.0.1 dropped the shrinkwrap; at 1.0.3 the
 * siblings dedupe to the top level and every one of those paths named a file that no longer exists. Why not
 * `createRequire(entry).resolve`: pi's packages export only an `import` condition (and no ./package.json), so the
 * CJS resolver throws ERR_PACKAGE_PATH_NOT_EXPORTED. `resolve` and `exists` are injected so this stays pure.
 */
export function piOwnPackageDir(name, { resolve = (spec) => import.meta.resolve(spec), exists = defaultExists } = {}) {
	const agentEntry = tryResolve(resolve, "@earendil-works/pi-coding-agent");
	if (!agentEntry) return null;
	// dist/index.js -> dist -> package root.
	for (let dir = dirname(dirname(fileURLToPath(agentEntry))); ; dir = dirname(dir)) {
		if (basename(dir) !== "node_modules") {
			const candidate = join(dir, "node_modules", "@earendil-works", name);
			if (exists(pathToFileURL(join(candidate, "package.json")).href)) return candidate;
		}
		if (dirname(dir) === dir) return null;
	}
}

/**
 * The ORDERED compat candidate list, most-likely-correct first.
 *
 * WHY pi-ai IS NOT IN THE RUNNER'S package.json, even though this module depends on it. What the
 * meter needs is not "a pi-ai" but pi-coding-agent's OWN pi-ai -- the copy pi hands its extensions (trap
 * #1 above). No dependency declaration can express that: a declared `@earendil-works/pi-ai` is a request
 * for a copy at the runner's own tree position, which npm may satisfy with a different one, and the
 * meter would then have more wrong answers to choose between, not fewer. So the dependency stays
 * deliberately undeclared and the binding is settled where it can actually be settled: at runtime, by the
 * identity check in installProcessUsageMeter. (package.json admits no comment, which is why this note lives
 * here.)
 *
 * pi's OWN copy first (`pi`, piOwnPackageDir): the file pi-coding-agent's own imports resolve to, whatever the
 * layout. A bare specifier from this file (`hoisted`) second, only when it names ANOTHER file, as a degraded
 * fallback. At the 1.0.3 pin the two are one file in a dev checkout (the root `overrides` pin every pi package to
 * one version, so npm keeps one copy) and in the image (only the runner's tree is installed), so the list has one
 * entry. The ordering is a hypothesis, not a conclusion -- installProcessUsageMeter proves a candidate before
 * trusting it, because a resolved path is exactly the thing that lies here. Also read by the image contract job
 * (.github/workflows/pi-upgrade-check.yml), and by loadRetryPredicate for a runner whose compat half did not
 * install.
 *
 * `resolve` and `exists` are injected so this stays pure and testable.
 */
export function resolvePiAiCompat({ resolve = (spec) => import.meta.resolve(spec), exists = defaultExists } = {}) {
	const candidates = [];

	const own = piOwnPackageDir("pi-ai", { resolve, exists });
	if (own) {
		const url = pathToFileURL(join(own, "dist", "compat.js")).href;
		if (exists(url)) candidates.push({ tag: "pi", url });
	}

	const hoisted = tryResolve(resolve, "@earendil-works/pi-ai/compat");
	if (hoisted && !candidates.some((candidate) => candidate.url === hoisted)) candidates.push({ tag: "hoisted", url: hoisted });

	return candidates;
}

function defaultExists(url) {
	try {
		return existsSync(fileURLToPath(url));
	} catch {
		return false;
	}
}

/**
 * What makes a module "the pi-ai an extension gets". Since pi 1.5.0 extensions import a view, `pi-ai-extension-view.js`,
 * which re-exports pi-ai's compat entry and adds TypeBox's `Type` and a `StringEnum`, so it is a different namespace
 * object with the same functions. Those functions close over the one registry, so they are what must be identical. Two
 * copies of pi-ai export the same names, which is why a match on names proves nothing.
 */
export const PI_AI_REGISTRY_FUNCTIONS = Object.freeze(["registerApiProvider", "getApiProvider", "getApiProviders", "resetApiProviders", "createAssistantMessageEventStream"]);

/**
 * The module map pi hands its extensions, read from pi-coding-agent's own dist by FILE URL: the exports map
 * constrains bare specifiers only, and this file is not exported (the tools.mjs allToolNames trick). At the
 * 0.99.1 pin `VIRTUAL_MODULES["@earendil-works/pi-ai"]` IS the compat namespace pi's own code imports
 * (virtual-modules.js: `import * as bundledPiAiCompat from "@earendil-works/pi-ai/compat"`), which makes it
 * the one oracle for "the compat copy an extension gets": the Node build's jiti aliases resolve the same
 * specifier from the same package (loader.js getAliases). pinned-api.test.mjs pins both spellings.
 */
async function defaultLoadExtensionModules({ resolve = (spec) => import.meta.resolve(spec), load = (url) => import(url) } = {}) {
	const agentEntry = resolve("@earendil-works/pi-coding-agent");
	const modules = await load(new URL("./core/extensions/virtual-modules.js", agentEntry).href);
	return modules?.VIRTUAL_MODULES ?? null;
}

/**
 * Linux-only child-process sampler.
 *
 * A subagent fanout that shells out shows up as child processes long before it shows up as settled
 * usage, so this is the cheapest early signal that a job went wide. Purely diagnostic: it degrades to
 * null off Linux (macOS has no /proc) and its sample() swallows everything, because a metering
 * accessory must never be able to fail a job.
 */
function createChildSampler(platform) {
	if (platform !== "linux") return null;
	const seen = new Set();
	const children = { distinct: 0, peak: 0, ticks: 0, sample };
	function sample() {
		try {
			children.ticks += 1;
			let live = 0;
			for (const tid of readdirSync("/proc/self/task")) {
				let raw;
				try {
					raw = readFileSync(`/proc/self/task/${tid}/children`, "utf8");
				} catch {
					continue; // A thread can exit between readdir and read. Expected, not an error.
				}
				for (const pid of raw.split(/\s+/)) {
					if (!pid) continue;
					live += 1;
					seen.add(pid);
				}
			}
			children.distinct = seen.size;
			if (live > children.peak) children.peak = live;
		} catch {
			// Diagnostics only.
		}
		return children;
	}
	return children;
}

/** A code or name for a failure, never `error.message`: a module-resolution message carries a path, and run logs ship. */
function reasonOf(error) {
	return error?.code ?? error?.name ?? "unknown";
}

/**
 * Install both halves of the meter. Returns `ok: false` -- and the caller falls back to the per-session
 * token meter -- ONLY when the RUNTIME half cannot meter, because that half is the one every session
 * dispatches through. A compat half that could not install degrades the meter without disabling it, and is
 * named on the `usage_meter` line (`compat: false` with a reason) rather than hidden behind a plain ok:true.
 *
 * The runtime half. `ModelRuntime` is the class run-job.mjs imports from pi-coding-agent (injected, trap
 * #1). `runtime`, when given, is the instance the session will be created with, and it is the acceptance
 * test: after wrapping, the instance must dispatch through the wrappers (an instance of the class, no own
 * property shadowing a method). That is the runtime analogue of the old mutation probe -- it fails when the
 * class run-job imported is not the one the instance was built from, the wrong-copy failure trap #1 names.
 * A class with no streamSimple/stream is refused outright (ok:false, reason `no-runtime-methods`).
 *
 * The compat half. Each candidate from resolvePiAiCompat is loaded and accepted only when it IS, by object identity,
 * the module pi hands an extension for `@earendil-works/pi-ai` (defaultLoadExtensionModules), or a view of it whose
 * PI_AI_REGISTRY_FUNCTIONS are all identical to the candidate's. pi 1.5.0 hands a view, so a policy-armed job is
 * refused unless this holds.
 * The accepted module also supplies the brake's stream factory and the ledger's pricing provenance (the
 * `version` in the package.json above its dist/), because it is the copy whose providers priced the calls.
 * Registration goes straight through the accepted compat's own `registerApiProvider` (at 0.99.1 the
 * ModelRegistry no longer writes to this registry at all), filed under METER_PROVIDER_PREFIX so one api id
 * is one registration; the unref'd interval re-arms after `resetApiProviders()`.
 *
 * Four options serve a child meter (issue #500), each absent in the runner's own install, which is then exactly as
 * before: `compat: { module, fallbackModels?, version? }`, a compat copy handed over instead of resolved (tag
 * `injected`); `brake: true`, a hard stop with no policy; `isStopped`, a stop read from outside, asked before every
 * call on both halves (judge); and `children`, the detector hook that replaces the Linux sampler.
 */
export async function installProcessUsageMeter({
	ModelRuntime,
	runtime = null,
	meter,
	log = () => {},
	rearmMs = 1000,
	resolve,
	load = (url) => import(url),
	exists,
	loadExtensionModules = () => defaultLoadExtensionModules({ ...(resolve ? { resolve } : {}), load }),
	readText = (path) => readFileSync(path, "utf8"),
	platform = process.platform,
	guard = null,
	compat = null,
	brake = false,
	children: childrenHook = null,
	isStopped = null,
}) {
	// --- the compat half's copy, decided first: it supplies the brake's stream factory to BOTH halves ---
	// An INJECTED copy (issue #500, `compat: { module }`) skips resolution and the identity check: a pi child loads
	// child-meter.mjs through pi's virtual modules, so the module it hands over IS the copy pi gives extensions, and in
	// the bundle there is no file to resolve. It still has to be a compat module. It has no sibling on disk either, so
	// its catalog and version come with it or not at all (`fallbackModels`, `version`).
	const injected = compat !== null;
	const candidates = injected ? [] : resolvePiAiCompat({ resolve, exists });
	const tried = [];
	let accepted = null;
	let compatError = null;
	let extensionModules = null;
	if (injected) {
		const mod = compat?.module;
		if (typeof mod?.registerApiProvider === "function" && typeof mod?.getApiProvider === "function" && typeof mod?.getApiProviders === "function") {
			accepted = { candidate: { tag: "injected", url: null }, mod };
		} else compatError = "injected-not-compat";
	} else {
		try {
			extensionModules = await loadExtensionModules();
			if (!extensionModules) compatError = "no-extension-modules";
		} catch (error) {
			compatError = reasonOf(error);
		}
	}
	for (const candidate of extensionModules ? candidates : []) {
		tried.push(candidate.tag);
		let mod;
		try {
			mod = await load(candidate.url);
		} catch {
			continue;
		}
		if (typeof mod?.registerApiProvider !== "function" || typeof mod?.getApiProvider !== "function" || typeof mod?.getApiProviders !== "function") continue;
		// pi 1.5.0 wraps compat in an extension view. Namespace identity still proves the
		// pinned copy; a view must share every registry/reset/stream function by identity.
		// Matching names (or two absent exports) cannot prove shared module-level state.
		const extensionView = extensionModules["@earendil-works/pi-ai"];
		if (extensionView !== mod && !PI_AI_REGISTRY_FUNCTIONS.every((name) => typeof mod[name] === "function" && extensionView?.[name] === mod[name])) continue;
		accepted = { candidate, mod };
		break;
	}
	if (!accepted && !compatError) compatError = "no-candidate-matched";
	const module = accepted?.mod ?? null;

	// Stamp the ledger's pricing provenance from the ACCEPTED copy's package.json, a path built RELATIVE TO
	// the accepted compat url so it can only ever name that copy (resolving the package by specifier would
	// reopen trap #1). Best-effort and SILENT on any failure: `piAi` is null when unknown, and an error
	// logged here would carry the resolved path, which the no-path rule forbids shipping. `readText` is
	// injected so the pure tests need no disk.
	if (accepted && injected) meter.setPiAiVersion(compat.version);
	else if (accepted) {
		try {
			meter.setPiAiVersion(JSON.parse(readText(fileURLToPath(new URL("../package.json", accepted.candidate.url)))).version);
		} catch {
			// piAi stays null on the exit line; the ledger itself is unaffected.
		}
	}

	// Armed only when a POLICY exists -- the model list, or `brake: true` for a child that must answer a parent's
	// STOP -- so a job with none of them can never have a call stopped. The list is enforced BEFORE a call, by the
	// guard, and a refusal needs this hard stop to answer with. There is no token cap to arm it for.
	// The stream factory comes from the accepted compat copy, so a compat half that did not install leaves no
	// brake for either half, and the runner then refuses a list before the first prompt.
	const createStream = typeof module?.createAssistantMessageEventStream === "function"
		? module.createAssistantMessageEventStream
		: typeof module?.AssistantMessageEventStream === "function"
			? () => new module.AssistantMessageEventStream()
			: null;
	// `brake: true` (issue #500) arms it with no policy at all: a child meter has none of its own to arm it, and still
	// needs a hard stop to answer the parent's STOP with.
	const armed = brake === true || meter.allowed !== null;
	const hardStop = armed && createStream ? makeHardStopStream({ createStream }) : null;
	// A meter that was ASKED for a brake (`brake: true`, or an outside stop to answer, `isStopped`) and cannot build
	// one is not a meter (issue #500): judge() never asks isStopped without a hard stop, so a parent's STOP would be
	// silently ignored. ok:false, so the child records itself `metered: false` and the parent counts it unmetered.
	if ((brake === true || isStopped !== null) && hardStop === null) {
		log("usage_meter_unavailable", { reason: "no-hard-stop" });
		return { ok: false, arm: () => {}, uninstall: () => {} };
	}

	// --- the runtime half: THE choke point. Without it there is no process-wide meter. ---
	const methodsPresent = typeof ModelRuntime?.prototype?.streamSimple === "function" && typeof ModelRuntime?.prototype?.stream === "function";
	if (!methodsPresent) {
		// Never log a filesystem path: run logs are shipped, and the image layout is not public data.
		log("usage_meter_unavailable", { reason: "no-runtime-methods" });
		return { ok: false, arm: () => {}, uninstall: () => {} };
	}
	// One per install, shared by both halves (trap #5).
	const dispatch = new AsyncLocalStorage();
	const runtimeLayer = wrapModelRuntime({ ModelRuntime, meter, hardStop, guard, dispatch, isStopped });
	if (runtime !== null && !runtimeLayer.covers(runtime)) {
		runtimeLayer.restore();
		log("usage_meter_unavailable", { reason: "runtime-not-covered" });
		return { ok: false, arm: () => {}, uninstall: () => {} };
	}

	// --- the compat half, armed only on an accepted copy ---
	// The catalog path compat would have taken for builtin models, loaded as a SIBLING of the accepted
	// compat url so it comes from the same copy. Resolving it by specifier would reopen trap #1.
	let fallbackModels = null;
	let fallbackError = null;
	if (accepted && injected) {
		fallbackModels = compat.fallbackModels ?? null;
		if (!fallbackModels) fallbackError = "no-builtin-models";
	} else if (accepted) {
		try {
			const all = await load(new URL("./providers/all.js", accepted.candidate.url).href);
			fallbackModels = all?.builtinModels?.() ?? null;
			// A module that loaded but exposes no builtinModels() is the same loss as a module that did not
			// load, and it is the shape a pin bump would produce -- so it gets its own reason, not silence.
			if (!fallbackModels) fallbackError = "no-builtin-models";
		} catch (error) {
			// Degraded but still metering: without the catalog every compat call goes to the registry entry,
			// which is WRONG for the builtin providers (compat itself would have called their own provider)
			// and breaks the cloudflare ones outright.
			fallbackModels = null;
			fallbackError = reasonOf(error);
		}
	}

	// Object identity, not api id: the registry hands back a FRESH provider object on every registration,
	// so "did we install this one?" is answerable only by identity.
	const wrapped = new Set();
	const armedApis = new Set();
	// The child-process hook (issue #500): the detector that replaces the diagnostic sampler, `{ sample(), teardown() }`.
	// sample() runs on every re-arm tick; teardown(), if present, at uninstall, and what it returns is added to the
	// teardown line. Absent, the Linux sampler stays, and both lines are exactly as before.
	const children = childrenHook ?? createChildSampler(platform);
	// The hook runs on a timer, where a throw is an uncaught exception that ends the runner with no exit line. So a
	// throw is caught and logged, by name only and once, and the hook owns what a failed tick means.
	// FAIL CLOSED under a policy: in a parent the hook IS the children's fold and detector, and a tick that threw has
	// folded and detected nothing, so the job would run on with its children uncounted. With a model list the meter
	// stops, for the stop an unmetered child gets (model-not-allowed). With no policy there is nothing to enforce,
	// and the failure is only logged.
	// Failures are counted on the teardown line (`childrenFailed`).
	let hookFailures = 0;
	function tick(run) {
		try {
			return run();
		} catch (error) {
			if (hookFailures === 0) log("usage_meter_children_failed", { reason: reasonOf(error) });
			hookFailures += 1;
			const reason = meter.allowed !== null ? MODEL_NOT_ALLOWED : null;
			if (reason !== null) meter.stop(reason, { cause: "children-hook" });
			return null;
		}
	}

	const handle = {
		ok: true,
		// Whether a hard stop exists, and which stops the installed guard can refuse for: the two facts
		// assertPoliciesEnforceable reads before the first prompt. Per policy, not one flag, so a guard that
		// enforces one policy cannot pass for one that enforces the other.
		brake: hardStop !== null,
		enforces: Object.freeze([...(guard?.enforces ?? [])]),
		methods: runtimeLayer.methods,
		// Whether a runtime instance dispatches through this install's wrappers (issue #500): a child meter installs at
		// extension load, before any session exists, and checks the session's own runtime once it does.
		covers: (instance) => runtimeLayer.covers(instance),
		module,
		tag: accepted?.candidate.tag ?? null,
		apis: [],
		arm,
		rearms: 0,
		children,
		uninstall,
	};

	function arm() {
		if (!module) return handle;
		let entries;
		try {
			entries = module.getApiProviders();
		} catch {
			return handle;
		}
		let displaced = 0;
		for (const entry of entries ?? []) {
			const api = entry?.api;
			if (typeof api !== "string") continue;
			if (wrapped.has(entry)) continue;
			const streams = wrapProviderStreams({ inner: entry, fallbackModels, meter, hardStop, guard, dispatch, isStopped });
			// One sourceId per api id, and registerApiProvider keys the registry by api id, so re-arming
			// replaces our entry instead of piling up registrations.
			module.registerApiProvider({ api, ...streams }, `${METER_PROVIDER_PREFIX}:${api}`);
			const installed = module.getApiProvider(api);
			if (installed) wrapped.add(installed);
			if (armedApis.has(api)) {
				handle.rearms += 1;
				displaced += 1;
			} else armedApis.add(api);
		}
		handle.apis = [...armedApis].sort();
		// THE RE-ARM GAP UNDER A MODEL LIST (issue #502). An api id this half had wrapped was found replaced: by
		// resetApiProviders() (AgentSession.reload()), or by an extension re-registering it. Between that and this
		// arm, a legacy compat call on that api reached a provider UNGUARDED, and nothing can tell whether one did:
		// the call went through an entry that is not ours. So under a list a displacement stops the job, fail
		// closed. Judging in the runtime half alone would not close it: a legacy compat call never enters a
		// ModelRuntime (header, trap #5's converse). A job with no list keeps today's behaviour: re-wrap and count
		// the re-arm. A displaced entry with no list is only a gap in a LAGGING count, not a policy that silently
		// passed: there is no token cap to enforce, and the gap is a metering hole, not a bound.
		if (displaced > 0 && meter.allowed !== null && meter.state.stopReason === null) {
			log("model_guard_displaced", { apis: displaced });
			meter.stop(MODEL_NOT_ALLOWED);
		}
		return handle;
	}

	let toreDown = false;
	function uninstall() {
		clearInterval(timer);
		if (toreDown) return;
		toreDown = true;
		runtimeLayer.restore();
		// THE RE-ARM GAP, made inferable (REQ-TOKEN-ACCOUNTING-AND-CAPS). Compat half only: at 0.99.1 a
		// session's own calls never enter the registry, so this window can hide only a legacy extension call.
		//
		// `resetApiProviders()` wipes the compat wrappers and replays nothing, and the only thing that puts
		// them back is the unref'd `rearmMs` poll. A registry call landing between the wipe and the next arm()
		// is UNMETERED, and nothing else in the run record shows it. `rearms` counts the api IDS arm() found
		// displaced, not the wipes -- one wipe displaces every armed api at once, which is why `apis` is on
		// the same line, and `rearmMs` with it because the window's width is the other half of any estimate.
		// The hook's teardown runs FIRST, so its last fold is in the meter before the caller reads the snapshot.
		const extra = typeof childrenHook?.teardown === "function" ? tick(() => childrenHook.teardown()) : null;
		// The meter's own fields are never the hook's to set: a colliding key from the hook is dropped.
		const own = { rearms: handle.rearms, apis: handle.apis.length, rearmMs, ...(childrenHook === null ? {} : { childrenFailed: hookFailures }) };
		const added = extra !== null && typeof extra === "object" ? Object.fromEntries(Object.entries(extra).filter(([key]) => !Object.hasOwn(own, key))) : {};
		log("usage_meter_teardown", { ...own, ...added });
	}

	arm();
	// Once, on success. Tags and names -- never a path.
	//
	// `methods` is what the runtime half wrapped. `compat` is the compat half's accepted copy (a tag, or
	// false with `compatError`), and `fallback` whether its builtin catalog loaded; without it the compat
	// half sends builtin models to the wrong entry. `brake` is whether a hard-stop stream exists; `listed`
	// (issue #502) is the policy that arms it, so true beside `brake:false` is a policy the runner then refuses.
	// There is no `capped` field: the meter has no token budget.
	// Reporting a plain `ok:true` over any of these would be a degraded meter calling itself healthy.
	log("usage_meter", {
		ok: true,
		methods: handle.methods,
		compat: handle.tag ?? false,
		...(compatError ? { compatError, tried } : {}),
		apis: handle.apis,
		...(accepted ? { fallback: fallbackModels !== null } : {}),
		...(fallbackError ? { fallbackError } : {}),
		listed: meter.allowed !== null,
		brake: hardStop !== null,
	});

	const timer = setInterval(() => {
		arm();
		if (childrenHook === null) children?.sample();
		else tick(() => childrenHook.sample?.());
	}, rearmMs);
	// Unref'd: this must never be the reason the container stays alive after the job finishes.
	timer.unref?.();

	return handle;
}

/**
 * Refuse, before the first prompt, a model list this runner cannot enforce BEFORE a call
 * (issue #502; INT-RUNNER-EXIT-CODE-PROTOCOL). The list is pre-call by definition: a list
 * checked after a call has already paid the model it forbids. So it needs, together:
 *   - the process-wide meter installed (`meterOk`). The fallback bus meter (run-job's attachSessionMeter) sees a
 *     call only after it settled, which is exactly the after-the-fact enforcement this policy rules out;
 *   - a hard stop to answer a refused call with (`brake`), which needs the compat copy's stream factory;
 *   - a guard that judges each call FOR THAT POLICY (`enforces` lists the stop reasons the installed guard can
 *     refuse for: MODEL_NOT_ALLOWED for the list). The model guard (createModelGuard, issue #502) enforces it;
 *     run-job installs it only for this policy. There is no token cap to assert: the meter has no budget.
 * Missing any one, the job is refused as a tagged configError: exit 2, not retried, before any spend. Names
 * only, never values: the list is not echoed.
 */
export function assertPoliciesEnforceable({ allowedModels = null, meterOk, brake, enforces = [] }) {
	const missing = (stop) => (!meterOk
		? "the process-wide usage meter did not install"
		: !brake
			? "the usage meter has no hard-stop stream"
			: !enforces.includes(stop)
				? "this runner has no pre-call guard for it"
				: null);
	if (allowedModels !== null && missing(MODEL_NOT_ALLOWED) !== null) {
		throw configError(`PI_ALLOWED_MODELS is set but cannot be enforced before a call: ${missing(MODEL_NOT_ALLOWED)}`, MODEL_POLICY_UNENFORCEABLE);
	}
}

/**
 * The stop handler run-job.mjs gives the meter (issues #500, #502). A policy stop aborts the root session
 * synchronously, so no later turn starts under a policy already known to be violated. There is no token budget
 * and no token-abort log line. Pure, so the wiring is tested here rather than only read off run-job's source.
 */
export function meterStopHandler({ abort }) {
	return () => {
		abort();
	};
}

/**
 * The three facts assertPoliciesEnforceable reads, off an install handle. `brake` is true only for an installed
 * meter that has a hard stop: a handle with ok:false is the fallback bus meter, whose brake (if any field said
 * so) could never answer a call before it is sent.
 */
export function policyEnforcement(handle) {
	const ok = handle?.ok === true;
	return { meterOk: ok, brake: ok && handle.brake === true, enforces: ok ? handle.enforces ?? [] : [] };
}

/**
 * Whether a settled call had STARTED answering: its message holds any content block (text, thinking, a tool call,
 * an image), or an images result has output. Usage counts do not count, output included: anthropic-messages copies
 * message_start's `output_tokens` (Anthropic sends 1) into usage.output before an in-band `overloaded_error`, so a
 * call that never answered reports one output token.
 */
function started(message) {
	const blocks = (value) => Array.isArray(value) && value.length > 0;
	return blocks(message?.content) || blocks(message?.output);
}

/** An answer block that holds something the model produced: non-empty text or thinking, or a tool call. */
function answerContent(message) {
	if (!Array.isArray(message?.content)) return false;
	return message.content.some((block) => (block?.type === "text" && typeof block.text === "string" && block.text.length > 0) || (block?.type === "thinking" && typeof block.thinking === "string" && block.thinking.length > 0) || block?.type === "toolCall");
}

/**
 * Did this settled answer carry NO usable usage, or BROKEN usage (issue #571)? pi fills a missing usage block with
 * zeros, and keeps the part of a usage it did see, so a call's token count reads as 0 though the provider answered.
 * True when the answer carries no usage object at all (a provider that sent none; the token total is short by
 * whatever the call really used), and otherwise when:
 *   (a) it failed (`error` or `aborted`) after it started: its usage is partial (openai-completions and
 *       openai-responses report usage only at the stream's end, anthropic-messages what message_start carried);
 *   (b) its input side (input + cacheRead + cacheWrite) is 0: a call that reached a provider always consumed
 *       input, so a zero is pi's filled-in zeros, not a measurement;
 *   (c) it succeeded with answer content (answerContent) but an output count of 0, or of at most 1 on
 *       `anthropic-messages`, where pi keeps message_start's `output_tokens` (Anthropic sends 1) when a proxy's
 *       message_delta carries no output count (anthropic-messages.js at the pin). A genuine one-token answer there is
 *       floored too: the safe side.
 * The money precondition the old unreportedUsage had (a finite `cost.total`, the meter's `unpriced`) is gone with
 * the cost guard: a missing usage block is itself the floor signal now, not something a price column would paper
 * over. A call that never reached a provider (the meter's hard stop) is never observed here at all, so an honest
 * zero is never counted.
 * Pure: `api` is the api of the model the call was dispatched on.
 */
export function usageUnreported(message, api) {
	const usage = message?.usage;
	if (usage === null || usage === undefined || typeof usage !== "object") return true;
	const failed = message?.stopReason === "error" || message?.stopReason === "aborted";
	if (failed) return started(message);
	if (finite(usage.input) + finite(usage.cacheRead) + finite(usage.cacheWrite) === 0) return true;
	if (!answerContent(message)) return false;
	const output = finite(usage.output);
	return output === 0 || (api === "anthropic-messages" && output <= 1);
}

// ── Issue #502, part 4: the allowed-model list, checked before every provider call ────────────────────────

/** The one spelling of a (provider, model) pair the guard compares: NUL cannot appear in either id. */
function pairKey(provider, model) {
	return `${provider}\u0000${model}`;
}

/**
 * The api that sends a model's `compat.allowedFallbackModels` to the provider (as `params.fallbacks`, model ids only)
 * and names a fallback answer in `responseModel`. Pinned by needle: it is the only api module that reads the field.
 */
const FALLBACK_API = "anthropic-messages";

const SAMPLING_OVERRIDE_APIS = new Set(["openai-completions", "openai-responses", "azure-openai-responses"]);

/**
 * Every sampling-parameter object that can reach a call's request, or null when one cannot be read (fail closed).
 * pi 1.0.2 added `model.samplingParamsByThinkingLevel` (issue #587): `resolveSamplingParams` merges
 * `{ ...model.samplingParams, ...byLevel[level], ...options.samplingParams }`, with the level clamped per model and
 * chosen per call, and streamSimple resolves twice (buildBaseOptions, then the api), so keys of two levels can meet in
 * one request. The model guard tracks no level: it reads EVERY level, the model's own params and the call's, as layers.
 * A routing key in any layer refuses the call.
 */
function samplingLayers(model, options) {
	const layers = [];
	for (const layer of [model?.samplingParams, options?.samplingParams]) {
		if (layer === undefined || layer === null) continue;
		if (!isOwnData(layer)) return null;
		layers.push(layer);
	}
	const byLevel = model?.samplingParamsByThinkingLevel;
	if (byLevel !== undefined && byLevel !== null) {
		// Own data only (isOwnData): an inherited, hidden or accessor level is one pi reads and Object.values does not.
		if (!isOwnData(byLevel)) return null;
		for (const layer of Object.values(byLevel)) {
			if (layer === undefined || layer === null) continue;
			if (!isOwnData(layer)) return null;
			layers.push(layer);
		}
	}
	return layers;
}

/**
 * The samplingParams keys that pick, or widen, the model that answers, refused under a list on the three apis that
 * merge samplingParams into the request after it is built: `model` (bedrock's `modelId`), an OpenAI-compatible
 * router's `models` fallback list, anthropic's `fallbacks`, and `providerOptions`, where the Vercel AI Gateway reads
 * its own model fallbacks (`gateway.models`) and upstream order (PR #538's review, round 3).
 */
const SAMPLING_ROUTING_KEYS = Object.freeze(["model", "modelId", "models", "fallbacks", "providerOptions"]);

/**
 * Whether a call's sampling layers (samplingLayers: the model's samplingParams, EVERY samplingParamsByThinkingLevel
 * level, the call's) name a routing key (SAMPLING_ROUTING_KEYS), on the three apis that merge them into the request
 * after it is built (`resolveSamplingParams`, pinned). Every level, because pi picks the level per call (issue #587).
 * Only those keys, by decision (PR #538's review, round 2): any other key (`min_p`, `reasoning_effort`,
 * `chat_template_kwargs`, `service_tier`) changes how the model answers, never which model answers, so it passes under
 * a list alone. The cost guard keeps its own, wider price rule (`samplingOverridesRequest`). A layer that cannot be
 * read routes, so a list refuses it.
 */
function samplingRoutes(model, options) {
	if (!SAMPLING_OVERRIDE_APIS.has(model?.api)) return false;
	const layers = samplingLayers(model, options);
	if (layers === null) return true;
	return layers.some((layer) => SAMPLING_ROUTING_KEYS.some((key) => Object.hasOwn(layer, key)));
}

/**
 * THE ONE TABLE of what a payload hook may change under a list (PR #538's review, round 3, a lead decision): the
 * payload check is DENY BY DEFAULT. After the caller's `onPayload` (the session's `before_provider_request` hooks
 * included) runs, its result is compared with the payload pi built on EVERY key, at every depth, except these. A hook
 * may rewrite what is said and how it is sampled; anything else it adds, removes or changes (a model id, a fallback
 * list, google's `config.httpOptions`, whose URL path picks the model, a gateway's `providerOptions`, a field no one
 * has thought of yet) refuses the call. Enumerating the fields that route a request was tried first and missed two in
 * review; a list of what may change cannot miss a new way to route.
 *   - `top`: the message and content keys (`messages`, openai-responses' `input`, google's `contents`, anthropic's and
 *     bedrock's `system`, google's `systemInstruction`, `instructions`) and the sampling knobs, as TOP-LEVEL names only.
 *     Fail closed: a setting an api keeps elsewhere (bedrock's `inferenceConfig`, mistral's camelCase `maxTokens`,
 *     pi-messages' `context` and `options`) is not editable. Not `prompt` (on openai-responses a reference to a stored
 *     server-side prompt) and not `metadata` (a proxy such as LiteLLM can route on its tags);
 *   - `config`: inside google's `config` (google-generative-ai, google-vertex), only its sampling fields and its system
 *     instruction. Never `httpOptions`, and nothing else in it.
 */
const PAYLOAD_EDITABLE = Object.freeze({
	top: Object.freeze(["messages", "input", "contents", "system", "systemInstruction", "instructions", "temperature", "top_p", "top_k", "min_p", "stop", "seed", "presence_penalty", "frequency_penalty", "max_tokens", "max_output_tokens", "max_completion_tokens"]),
	config: Object.freeze(["temperature", "topP", "topK", "maxOutputTokens", "stopSequences", "systemInstruction"]),
});

/** A plain object: `{}` or `Object.create(null)`, never a class instance (an AbortSignal, a Date). */
function isPlain(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

/**
 * A deep copy of pi's payload, taken BEFORE the hook runs, so a hook that edits it in place cannot also edit what it is
 * compared with. Plain objects and arrays are copied, typed arrays (bedrock's image bytes) are copied byte for byte,
 * and anything else (an AbortSignal in google's `config`, a function) is kept by reference, as pi built it. Each value is
 * read once, so a getter cannot answer the copy and the wire differently.
 */
function snapshotPayload(value, seen = new Map()) {
	if (value === null || typeof value !== "object") return value;
	if (ArrayBuffer.isView(value)) return value instanceof DataView ? value : value.slice();
	if (seen.has(value)) return seen.get(value);
	if (Array.isArray(value)) {
		const out = [];
		seen.set(value, out);
		for (const item of value) out.push(snapshotPayload(item, seen));
		return out;
	}
	if (!isPlain(value)) return value;
	const out = {};
	seen.set(value, out);
	for (const key of Object.keys(value)) out[key] = snapshotPayload(value[key], seen);
	return out;
}

/** Deep structural equality, as the wire sees it: plain objects by own keys, arrays and typed arrays by content, the rest by identity. */
function samePayloadValue(a, b, depth = 0) {
	if (Object.is(a, b)) return true;
	if (depth > 64) return false;
	if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
		if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b) || a.constructor !== b.constructor || a.byteLength !== b.byteLength) return false;
		return Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
	}
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
		return a.every((item, index) => samePayloadValue(item, b[index], depth + 1));
	}
	if (!isPlain(a) || !isPlain(b)) return false;
	// Each value read ONCE (Object.entries), so a nested getter cannot answer the count and the comparison differently.
	const left = Object.entries(a).filter(([, value]) => value !== undefined);
	const right = new Map(Object.entries(b).filter(([, value]) => value !== undefined));
	if (left.length !== right.size) return false;
	return left.every(([key, value]) => right.has(key) && samePayloadValue(value, right.get(key), depth + 1));
}

/**
 * A key whose value is `undefined` is ABSENT, on both sides and at every level (PR #538's final review): pi's payloads
 * carry such keys (openai-completions' `prompt_cache_key`, bedrock's `additionalModelRequestFields`, pi-messages'
 * `options.*`), JSON drops them on the wire, and so does a hook that JSON-clones the payload, the common redaction
 * pattern. Counting them would refuse a hook whose request is byte-identical.
 */
function present(object, key) {
	return Object.hasOwn(object, key) && object[key] !== undefined;
}
function definedKeys(object) {
	return Object.keys(object).filter((key) => object[key] !== undefined);
}

/**
 * The payload to send after a hook, or null to refuse the call (PAYLOAD_EDITABLE has the rule). `before` is pi's payload
 * as snapshotted before the hook; `result` is the hook's return value, or pi's own object when the hook returned
 * nothing (it may have been edited in place). Refused: a result that is not a plain object (an array, a class instance),
 * one with a `toJSON` (own or inherited, which would replace the whole body when serialised) or an accessor on any key,
 * and any difference outside the editable keys. The object returned is FRESH: the editable keys as the hook left them,
 * every other key from the snapshot, which equals what the hook produced and which the hook never held. So the object
 * checked is the object sent, and pi never sends the hook's own object.
 */
function payloadAfterHook(before, result) {
	// A `toJSON` needs no rule of its own: an own one is an added key, an inherited one makes the result not plain.
	if (!isPlain(result)) return null;
	for (const key of Object.keys(result)) {
		if (!Object.hasOwn(Object.getOwnPropertyDescriptor(result, key), "value")) return null;
	}
	const sent = {};
	for (const key of definedKeys(result)) {
		if (PAYLOAD_EDITABLE.top.includes(key)) sent[key] = result[key];
		else if (!present(before, key)) return null;
	}
	for (const key of definedKeys(before)) {
		if (PAYLOAD_EDITABLE.top.includes(key)) continue;
		if (!present(result, key)) return null;
		if (key === "config" && isPlain(before.config) && isPlain(result.config)) {
			const config = {};
			for (const sub of definedKeys(result.config)) {
				if (PAYLOAD_EDITABLE.config.includes(sub)) config[sub] = result.config[sub];
				else if (!present(before.config, sub)) return null;
			}
			for (const sub of definedKeys(before.config)) {
				if (PAYLOAD_EDITABLE.config.includes(sub)) continue;
				if (!present(result.config, sub) || !samePayloadValue(before.config[sub], result.config[sub])) return null;
				config[sub] = before.config[sub];
			}
			sent.config = config;
			continue;
		}
		if (!samePayloadValue(before[key], result[key])) return null;
		sent[key] = before[key];
	}
	// The hook's own key order, so a hook that changes nothing sends the same bytes pi would have.
	const ordered = {};
	for (const key of Object.keys(result)) if (Object.hasOwn(sent, key)) ordered[key] = sent[key];
	return ordered;
}

/**
 * The options that pick the deployed model instead of model.id (`resolveDeploymentName` in pi-ai's
 * api/azure-openai-config.js, pinned): read by the azure-openai-responses api for any provider, and, since pi 1.0.3,
 * by the `azure` provider for EVERY api it serves (providers/azure.js rewrites `payload.model` in an onPayload wrapper
 * of its own, outside this guard's, so the payload check never sees the change; issue #587). Before 1.0.3 the
 * provider was `azure-openai-responses` and served one api.
 */
const AZURE_API = "azure-openai-responses";
const AZURE_PROVIDER = "azure";
const AZURE_DEPLOYMENT_MAP = "AZURE_OPENAI_DEPLOYMENT_NAME_MAP";

/**
 * The fallback that answered a settled call, or null: on anthropic-messages only (the one api that sends fallbacks),
 * a `responseModel` other than the requested id that is one of the requested model's `compat.allowedFallbackModels`.
 * Matched on the model id alone, whatever the entry's provider field says, because pi sends only the ids
 * (`{ model: fallback.model }`), so the provider may answer with any of them. Not every `responseModel` is a fallback:
 * openai-completions sets it for any chunk model other than the requested id, a provider's alias for the model asked
 * for, so other apis are never read here.
 */
function fallbackOf(model, message) {
	if (model?.api !== FALLBACK_API) return null;
	const answered = message?.responseModel;
	if (typeof answered !== "string" || answered === model.id) return null;
	const fallbacks = Array.isArray(model.compat?.allowedFallbackModels) ? model.compat.allowedFallbackModels : [];
	return fallbacks.find((fallback) => fallback?.model === answered) ?? null;
}

/**
 * THE MODEL GUARD (issue #502, part 4; REQ-MODEL-POLICY, DES-MODEL-POLICY-AT-THE-PROVIDER-WRAPPER). A guard for the
 * meter's seam: `{ enforces: [MODEL_NOT_ALLOWED], admit, prepare, bind, snapshot }`.
 *
 * admit(call) refuses a call whose REQUESTED model, `${model.provider}/${model.id}`, is not on the list. Exact and
 * case-sensitive, on BOTH halves of the pair: the same model id under another provider is another route, another
 * credential and another bill. Every method is judged the same way, so a classifier or an image model a flow uses
 * must be on the list like a chat model. A virtual model is never seen here on streamSimple (the wrapper skips it and
 * judges the physical call pi makes next); on any other method it is judged as itself.
 *
 * The id on the call is not the only thing that picks the model that answers (PR #538's review), so admit also refuses
 * a listed call whose request would name another one:
 *   - samplingParams naming a routing key (`samplingRoutes`, SAMPLING_ROUTING_KEYS) on the three apis that merge them
 *     after the request is built: a `model` key there replaces the requested one;
 *   - a call option `fetch`, which sends the request after every hook and so could rewrite it unseen (pi passes none);
 *   - on api azure-openai-responses, and on provider `azure` whatever the api (issue #587), `options.azureDeploymentName`
 *     or a per-call `options.env` deployment map, either of which picks the deployment instead of model.id;
 *   - on anthropic-messages, a `compat.allowedFallbackModels` entry whose pair (the model's provider and the
 *     fallback's id, which is what pi sends) is not on the list: pi sends those ids as `fallbacks`, and the provider
 *     may answer with any of them.
 * prepare(call) wraps the admitted call's `options.onPayload`, always, also when the caller passed none, because pi
 * hands the session's `before_provider_request` hooks to the provider through it. Deny by default (PAYLOAD_EDITABLE):
 * the wrapper snapshots pi's payload, runs the caller's hook, and refuses any difference outside the keys a hook may
 * edit (the messages and the sampling knobs), at any depth; it hands pi a fresh object built from the two
 * (`payloadAfterHook`). A refused payload makes the hook throw, so pi fails the call before it is sent, and the job
 * stops as for any refusal.
 *
 * A refusal counts `modelRefused`, logs `model_refused` with numbers and a fixed token only (`method`, `refused`,
 * `why`; never a model id, which the job chose), and returns or stops with MODEL_NOT_ALLOWED.
 *
 * bind(stream) watches the admitted call's answer for a server-side fallback (fallbackOf) and logs `model_fallback`
 * with the requested and the answering ids. With the fallback rule above every such answer is a listed model; the
 * line says which one answered. Single-slot, like the cost guard's: admit, prepare and the dispatch after them are
 * synchronous and adjacent in both wrappers.
 */
/**
 * pi's parseDeploymentNameMap (api/azure-openai-config.js, pinned by needle): `id=deployment` pairs, comma separated,
 * each side trimmed, an entry missing either side skipped.
 */
export function parseDeploymentNameMap(value) {
	const map = new Map();
	if (!value) return map;
	for (const entry of String(value).split(",")) {
		const trimmed = entry.trim();
		if (!trimmed) continue;
		const [modelId, deploymentName] = trimmed.split("=", 2);
		if (!modelId || !deploymentName) continue;
		map.set(modelId.trim(), deploymentName.trim());
	}
	return map;
}

export function createModelGuard({ allowedModels, log = () => {}, env = process.env, now = Date.now, subscriptionAdmission = null }) {
	if (!Array.isArray(allowedModels) || allowedModels.length === 0) throw new Error("invalid PI_ALLOWED_MODELS: want a non-empty list");
	// The operator's own deployment map, read ONCE, now (issue #587's review): the environment the worker gave the job
	// (PI_FORWARD_ENV, which env-allowlist.mjs tells an Azure operator to use for it). A map that arrives later (a stored
	// credential's env, an edit of process.env) is not this one, and the payload check refuses what it picks.
	// The map is pi-ai's own variable, reserved from run.secrets (provider-steering.mjs).
	const startDeployments = parseDeploymentNameMap(env?.[AZURE_DEPLOYMENT_MAP]);
	const allowed = new Set(allowedModels.map((entry) => pairKey(entry.provider, entry.model)));
	let subscriptions;
	try { subscriptions = JSON.parse(env.PI_SUBSCRIPTION_AUTH ?? "[]"); } catch { subscriptions = null; }
	const subscriptionKeys = new Map((Array.isArray(subscriptions) ? subscriptions : []).map((row) => [row.provider, subscriptionAccess(row.provider, env)]));
	const state = { refused: 0 };
	let pending = null;

	function refuse(method, why) {
		state.refused += 1;
		log("model_refused", { method, why, refused: state.refused });
		return MODEL_NOT_ALLOWED;
	}

	/** Why a call on this model with these options would be answered by a model the list does not name, or null. */
	function offList(model, options) {
		if (!Array.isArray(subscriptions) || (subscriptions.length > 0 && (!model || !validateSubscriptionRequest(model, subscriptions, { now })))) return "subscription";
		if (subscriptionKeys.has(model?.provider)) {
			// Separate pi processes have the access env but no attested extension/runtime. They refuse until a
			// host-wired admission function establishes the same registration contract as this runner.
			if (!subscriptionAdmission || !subscriptionAdmission(model.provider)) return "subscription";
			if (subscriptionRequestOverrides(options, subscriptionKeys.get(model.provider)) || subscriptionRequestOverrides({ headers: model.headers }, subscriptionKeys.get(model.provider))) return "subscription";
		}
		const provider = model?.provider;
		const id = model?.id;
		if (typeof provider !== "string" || typeof id !== "string" || !allowed.has(pairKey(provider, id))) return "unlisted";
		// Issue #587's review: a model or options copy that held something other than plain data (snapshotModel).
		if (isUnreadable(model) || isUnreadable(options)) return "unreadable";
		if (samplingRoutes(model, options)) return "sampling";
		// A caller's own `fetch` sends the request after every hook ran, so it could rewrite the body unseen. pi never
		// passes one itself (only a caller does), so under a list it is refused rather than trusted.
		if (options?.fetch !== undefined) return "fetch";
		if ((model.api === AZURE_API || provider === AZURE_PROVIDER) && (options?.azureDeploymentName !== undefined || options?.env?.[AZURE_DEPLOYMENT_MAP] !== undefined)) return "deployment";
		if (model.api === FALLBACK_API) {
			const fallbacks = Array.isArray(model.compat?.allowedFallbackModels) ? model.compat.allowedFallbackModels : [];
			if (fallbacks.some((fallback) => !allowed.has(pairKey(provider, fallback?.model)))) return "fallback";
		}
		return null;
	}

	function admit({ method, model, args, legacy = false }) {
		if (legacy && model?.provider === "anthropic" && subscriptionKeys.has("anthropic")) return refuse(method, "subscription");
		pending = null;
		if (method === "classify" && model?.provider === "openai" && subscriptionKeys.has("openai")) return refuse(method, "subscription");
		const why = offList(model, args?.[1]);
		if (why !== null) return refuse(method, why);
		pending = model;
		return null;
	}

	function prepare({ method, model, args, stop }) {
		const options = args?.[1];
		const theirs = options?.onPayload;
		// Issue #587's review: on azure the deployment is resolved from options.env MERGED with the credential's own env
		// (ModelRuntime.prepareRequest, after admit), so a deployment map can arrive where admit cannot see it. The api
		// and the azure provider write that deployment as payload.model before this hook runs; it must be model.id.
		const deploymentChecked = model?.api === AZURE_API || model?.provider === AZURE_PROVIDER;
		// A `function`, so the caller's hook runs with the `this` pi gives it: pi calls `options.onPayload(...)` as a method
		// of the options object the provider received, which is this wrapper's `this` too.
		const onPayload = async function (payload, payloadModel) {
			let before = null;
			try {
				before = isPlain(payload) ? snapshotPayload(payload) : null;
			} catch {
				before = null;
			}
			if (deploymentChecked && (before === null || before.model !== (startDeployments.get(model.id) ?? model.id))) {
				refuse(method, "deployment");
				stop(MODEL_NOT_ALLOWED);
				throw new Error(STOP_MESSAGES[MODEL_NOT_ALLOWED]);
			}
			// The backstop (issue #587's review): the fallbacks pi itself put on the request, before any hook, must be on the
			// list under the model's provider, whatever admit read off the model.
			if (before !== null && present(before, "fallbacks") && !(Array.isArray(before.fallbacks) && before.fallbacks.every((fallback) => allowed.has(pairKey(model?.provider, fallback?.model))))) {
				refuse(method, "fallback");
				stop(MODEL_NOT_ALLOWED);
				throw new Error(STOP_MESSAGES[MODEL_NOT_ALLOWED]);
			}
			const next = typeof theirs === "function" ? await theirs.call(this, payload, payloadModel) : undefined;
			// The hook's result, or pi's payload as the hook may have changed it in place: compared, then sent as a fresh object.
			let sent = null;
			try {
				sent = before === null ? null : payloadAfterHook(before, next === undefined ? payload : next);
			} catch {
				sent = null;
			}
			if (sent === null) {
				refuse(method, "payload");
				stop(MODEL_NOT_ALLOWED);
				throw new Error(STOP_MESSAGES[MODEL_NOT_ALLOWED]);
			}
			return sent;
		};
		const prepared = [...(args ?? [])];
		prepared[1] = { ...(options ?? {}), onPayload, ...(subscriptionKeys.has(model?.provider) ? { apiKey: subscriptionKeys.get(model.provider) } : {}) };
		return prepared;
	}

	function bind(stream) {
		const model = pending;
		pending = null;
		if (model === null || typeof stream?.result !== "function") return;
		stream.result().then((message) => {
			const fallback = fallbackOf(model, message);
			if (fallback !== null) log("model_fallback", { provider: model.provider, requested: model.id, answered: fallback.model });
		}, () => {});
	}

	/** The exit line's model field, present only when a list is set (createPolicyGuard spreads it into `tokens`). */
	function snapshot() {
		return { modelRefused: state.refused };
	}

	return { enforces: Object.freeze([MODEL_NOT_ALLOWED]), admit, prepare, bind, snapshot, state };
}

/**
 * The one guard the runner hands both meter halves (issue #502): the model guard, or null when no list is set
 * (and then every call goes through exactly as before).
 *
 * The list decides which provider may be called at all, so a call it forbids must be refused as
 * `model-not-allowed` before dispatch. There is no token-cap guard to build: the meter has no token budget and
 * no pre-call spend bound.
 *
 * `enforces` is the guard's own list, so assertPoliciesEnforceable sees the policy only when its guard is here.
 * `snapshot()` is `modelRefused` (only with a list), the worker's TOKEN_KEYS position unchanged, so with no list
 * the exit line is byte-identical to before.
 */
export function createPolicyGuard({ allowedModels = null, log = () => {}, env = process.env, now = Date.now, subscriptionAdmission = null }) {
	const model = allowedModels === null ? null : createModelGuard({ allowedModels, log, env, now, subscriptionAdmission });
	if (model === null) return null;
	return {
		enforces: model.enforces,
		admit(call) {
			return model.admit(call);
		},
		prepare(call) {
			return model.prepare(call);
		},
		bind(result) {
			model.bind?.(result);
		},
		snapshot() {
			return model.snapshot();
		},
		model,
	};
}

// ── Issue #500: child ledgers, the files a pi child process reports its usage through ──────────────────────
//
// THE LEDGER FILE (issue #500; DES-USAGE-METER-VIA-API-PROVIDER-REGISTRY). A pi child process runs its own meter and
// reports through one file in the run's ledger directory, which the parent folds on its tick (foldChildLedgers).
//   - Name: `<pid>.<nonce>.json` (CHILD_LEDGER_NAME): the child's pid in decimal, a nonce of 16 lowercase hex
//     characters. Any other name is ignored, so the directory can also hold the parent's `STOP` and the
//     temporary file of an atomic write (it must not end in `.json`).
//   - Written whole, by rename, as compact JSON of at most CHILD_LEDGER_MAX_BYTES (64 KiB).
//   - Every field is required, in every state:
//       { "v": 4,
//         "state": "starting" | "running" | "done",
//         "metered": true | false,
//         "totals": { "input", "output", "total", "calls", "unresolved", "usageUnreported", "sessions" },
//         "rows": [ { "provider", "model", "calls", "input", "output", "cacheRead", "cacheWrite", "cacheWrite1h",
//                     "reasoning", "total" } ],
//         "modelRefused" }
//     `starting` is the preload's stub (zeros, `metered: true`), written before the meter installs; `running` once
//     it has; `done` at exit. `metered: false` says the child's meter did not install. `totals` is the child meter's
//     snapshot, `rows` its rows() (first-seen order, at most CHILD_LEDGER_ROWS written and CHILD_LEDGER_MAX_ROWS
//     read, a model-less row with both ids null), `modelRefused` the model guard's refusal counter, and
//     `usageUnreported` the METER's completeness counter (issue #571, written with or without a list; the parent's
//     meter adds it through setChildren). Token amounts only: the cost, unpriced, providerBilled and guard
//     micro-dollar columns died with the per-job cost guard (DES-TOKEN-RESERVE-AND-SETTLE). childLedger() builds
//     exactly this object. Version 4 is the token-only shape; a file of an older version is malformed (unmetered),
//     so a child from an older image floors the job rather than hiding a call it did not count.
//   - Numbers only. Token amounts are numbers from 0 to Number.MAX_SAFE_INTEGER; `calls`, `unresolved`,
//     `usageUnreported`, `sessions` and `modelRefused` are safe integers at least 0. Ids are printable ASCII and
//     match USAGE_ID_PATTERN after lowercasing, the worker's rule. The rows partition the totals: their calls sum to
//     `calls - unresolved`, and every other amount sums to its total.
//   - A fold reads at most CHILD_LEDGER_MAX_FILES names; any further name counts as unmetered unread.
//
// What the fold trusts, and why it is cooperative accounting rather than a boundary: the agent holds the provider key
// and shares the runner's uid, so it can delete or forge these files. The rules make that fail toward a floor or an
// overcount: a high-water mark per file; a file that shrinks, vanishes, is malformed in any part, or says
// `metered: false` counts ONCE as unmetered and keeps what it had reached; a forged larger number only overcounts.

/** A child ledger's file name: `<pid>.<nonce>.json`. */
export const CHILD_LEDGER_NAME = /^([1-9][0-9]{0,9})\.([0-9a-f]{16})\.json$/;
/** The largest ledger file the fold reads. Larger is malformed. */
export const CHILD_LEDGER_MAX_BYTES = 64 * 1024;
/** The most rows a ledger may carry. More is malformed. */
export const CHILD_LEDGER_MAX_ROWS = 256;
/**
 * The most rows a child meter WRITES (rows()): under half the read cap, so a ledger of worst-case rows (two 64-character
 * ids, every number at its longest) stays under CHILD_LEDGER_MAX_BYTES with 8 KiB to spare. child-ledger.test.mjs
 * builds that ledger through childLedger() and checks.
 */
export const CHILD_LEDGER_ROWS = 120;
/**
 * The most ledger names one fold reads. A job runs at most `--pids-limit=512` processes at once, so 512 ledgers is
 * every child a busy job can have alive; a name past it counts as unmetered without being opened. It bounds the tick's
 * synchronous reads and the marks held in memory against a flood of files in the directory.
 */
export const CHILD_LEDGER_MAX_FILES = 512;
export const CHILD_LEDGER_STATES = Object.freeze(["starting", "running", "done"]);
/** The ledger format's version. 2 added the guard counters (issue #500 part E's review), 3 `costUnreported` (issue #571), 4 is the token-only shape. */
export const CHILD_LEDGER_VERSION = 4;
/**
 * A COPY of the worker's id rule (worker/src/model-ref.mjs MODEL_REF_PATTERN, which run-history.mjs imports as
 * USAGE_ID_PATTERN), because the image does not carry the worker. A copy is held to its source by a test that reads
 * both (child-ledger.test.mjs). The worker refuses a whole usage block for one row it refuses, so a child row the fold
 * admits must be a row the worker admits.
 */
export const USAGE_ID_PATTERN = /^(?=.{1,64}$)[~@]?[a-z0-9][a-z0-9._:/@_-]*$/;

/**
 * Whether an id may name a ledger row: printable ASCII first, then the worker's rule after lowercasing. ASCII first
 * because lowercasing is not closed over ASCII (U+212A KELVIN SIGN lowercases to `k`), so a check after lowercasing
 * alone passes a 3-byte character per letter and a row three times the size the byte budgets assume.
 */
function recordableId(id) {
	return typeof id === "string" && /^[!-~]+$/.test(id) && USAGE_ID_PATTERN.test(id.toLowerCase());
}

const LEDGER_AMOUNTS = Object.freeze(["input", "output", "total"]);
const LEDGER_COUNTS = Object.freeze(["calls", "unresolved", "usageUnreported", "sessions"]);
const LEDGER_GUARD_COUNTS = Object.freeze(["modelRefused"]);
/** The completeness counters a ledger carries (version 4), the exit line's names. The money floor counters died with
 * the cost guard; the token count's own completeness signal is the meter's `usageUnreported` (issue #571), beside the
 * `unresolved` calls that were still in flight when the file was written. */
export const CHILD_FLOOR_COUNTERS = Object.freeze(["usageUnreported"]);
const ROW_AMOUNTS = Object.freeze(["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h", "reasoning", "total"]);
const ROW_COUNTS = Object.freeze(["calls"]);
/** What only ever grows in a live child: everything but `unresolved`. */
const MONOTONE_TOTALS = Object.freeze(["input", "output", "total", "calls", "sessions"]);
const MONOTONE_GUARD = Object.freeze(["modelRefused", "usageUnreported"]);

/**
 * An amount a ledger may carry: a number from 0 to Number.MAX_SAFE_INTEGER. The upper bound is what keeps a fold's
 * sums finite: two forged files at 1e308 would otherwise sum to Infinity, which no coercion can turn back into the
 * real children's spend. A larger number is malformed, so the file counts as unmetered (a floor).
 */
const amount = (value) => typeof value === "number" && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const whole = (value) => Number.isSafeInteger(value) && value >= 0;
/** Two sums of the same floats in another order agree to rounding, not to the bit. */
const agrees = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
/** A row's key: the pair, or "" for the model-less row (no id can be empty). */
const rowKey = (row) => (row.provider === null ? "" : `${row.provider}\u0000${row.model}`);

/** A ledger with nothing in it: the contribution of a file that was never good. */
function emptyLedger() {
	return { state: null, totals: { input: 0, output: 0, total: 0, calls: 0, unresolved: 0, usageUnreported: 0, sessions: 0 }, rows: new Map(), modelRefused: 0, usageUnreported: 0 };
}

/**
 * One ledger's text, validated whole: the ledger (rows as a Map by key, duplicates summed) or null. Null for ANY
 * violation, so no part of a bad file is ever trusted. Unknown keys are ignored, never read.
 */
export function parseChildLedger(text) {
	let raw;
	try {
		raw = JSON.parse(text);
	} catch {
		return null;
	}
	if (!isPlain(raw) || raw.v !== CHILD_LEDGER_VERSION || !CHILD_LEDGER_STATES.includes(raw.state) || typeof raw.metered !== "boolean") return null;
	if (!isPlain(raw.totals)) return null;
	const totals = {};
	for (const key of LEDGER_AMOUNTS) {
		if (!amount(raw.totals[key])) return null;
		totals[key] = raw.totals[key];
	}
	for (const key of LEDGER_COUNTS) {
		if (!whole(raw.totals[key])) return null;
		totals[key] = raw.totals[key];
	}
	if (totals.unresolved > totals.calls) return null;
	const ledger = { state: raw.state, metered: raw.metered, totals, rows: new Map() };
	for (const key of LEDGER_GUARD_COUNTS) {
		if (!whole(raw[key])) return null;
		ledger[key] = raw[key];
	}
	// `usageUnreported` lives inside `totals` on the file (the writer's shape), but the fold's machinery --
	// the high-water mark, the monotone check and the counters -- reads it beside `modelRefused` at the top
	// level, as its v3 spelling `costUnreported` was carried. Copy it up once, here, so one shape serves both.
	ledger.usageUnreported = totals.usageUnreported;
	if (!Array.isArray(raw.rows) || raw.rows.length > CHILD_LEDGER_MAX_ROWS) return null;
	const sum = { ...emptyRow() };
	for (const given of raw.rows) {
		if (!isPlain(given)) return null;
		const { provider, model } = given;
		const modelless = provider === null && model === null;
		const named = recordableId(provider) && recordableId(model);
		if (!modelless && !named) return null;
		const row = { provider: modelless ? null : provider, model: modelless ? null : model, ...emptyRow() };
		for (const key of ROW_AMOUNTS) {
			if (!amount(given[key])) return null;
			row[key] = given[key];
		}
		for (const key of ROW_COUNTS) {
			if (!whole(given[key])) return null;
			row[key] = given[key];
		}
		foldRow(sum, row);
		const key = rowKey(row);
		const into = ledger.rows.get(key);
		if (into) foldRow(into, row);
		else ledger.rows.set(key, row);
	}
	// The rows partition the totals (the meter's own invariant): a file whose rows say less than its totals, or more,
	// is not a ledger the meter wrote.
	if (sum.calls !== totals.calls - totals.unresolved) return null;
	if (!LEDGER_AMOUNTS.every((key) => agrees(sum[key], totals[key]))) return null;
	return ledger;
}

/** Whether `next` reached at least `high` in everything that only grows, row by row included. */
function reached(high, next) {
	if (!MONOTONE_TOTALS.every((key) => next.totals[key] >= high.totals[key])) return false;
	if (!MONOTONE_GUARD.every((key) => next[key] >= high[key])) return false;
	for (const [key, row] of high.rows) {
		const now = next.rows.get(key);
		if (!now || ![...ROW_AMOUNTS, ...ROW_COUNTS].every((field) => now[field] >= row[field])) return false;
	}
	return true;
}

const GONE = Symbol("gone");
const BAD = Symbol("bad");
const UNCHANGED = Symbol("unchanged");

/**
 * A file's identity and version, from a bigint stat: inode, size, and the change and modify times in nanoseconds.
 * A rename (the format's only way to write) changes the inode; an in-place write changes the ctime, which no user can
 * set back. Equal signatures mean the bytes the last read saw.
 */
function signature(stat) {
	return `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

/**
 * One file's `{ text, sig }`, or GONE (it vanished after the listing), BAD, or UNCHANGED (its signature is `known`, so
 * there is nothing new to read). Stat'ed first without following a link, so an unchanged file costs one lstat. Then
 * opened without following a symlink and without blocking (a FIFO opened for reading would hang the runner's event
 * loop, and with it every brake), held to a regular file of at most CHILD_LEDGER_MAX_BYTES, and read through the
 * descriptor so a swap after the check reads nothing new. Strict UTF-8.
 */
function readLedger(fs, path, known, maxBytes = CHILD_LEDGER_MAX_BYTES) {
	try {
		if (known !== null && signature(fs.lstatSync(path, { bigint: true })) === known) return UNCHANGED;
	} catch (error) {
		return error?.code === "ENOENT" ? GONE : BAD;
	}
	let fd;
	try {
		fd = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
	} catch (error) {
		return error?.code === "ENOENT" ? GONE : BAD;
	}
	try {
		const stat = fs.fstatSync(fd, { bigint: true });
		if (!stat.isFile() || stat.size > BigInt(maxBytes)) return BAD;
		const buffer = Buffer.alloc(maxBytes + 1);
		let length = 0;
		while (length < buffer.length) {
			const read = fs.readSync(fd, buffer, length, buffer.length - length, null);
			if (read === 0) break;
			length += read;
		}
		if (length > maxBytes) return BAD;
		return { text: new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)), sig: signature(stat) };
	} catch {
		return BAD;
	} finally {
		try {
			fs.closeSync(fd);
		} catch {
			// Nothing to do: the descriptor is gone either way.
		}
	}
}

const DEFAULT_LEDGER_FS = { readdirSync, lstatSync, openSync, fstatSync, readSync, closeSync, constants };

/**
 * Fold every child ledger in `dir` (issue #500): PURE apart from the injected `fs`, and cumulative through `prev`, the
 * last call's result (null the first time). Never throws. The rules (the ledger comment above has the why):
 *   - each file keeps a HIGH-WATER mark, its last good ledger, and contributes that;
 *   - a good ledger that reached its high-water mark in everything that only grows (every total but `unresolved`,
 *     every row, `modelRefused`) replaces it;
 *   - a file that is malformed in any part, says `metered: false`, shrank in anything, or vanished is counted
 *     unmetered ONCE, keeps the mark it had (nothing, if it was never good) and is never read again;
 *   - a file that vanished between the listing and the read is a vanished file if it was known, and unseen if not;
 *   - a file whose signature has not changed since its last read is not read again (one lstat; it is still listed,
 *     so it can still vanish). A `done` file is read like any other: `state` is not a number the mark holds, so a
 *     forged `done` with unchanged numbers would otherwise blind the fold to a live child's later writes;
 *   - RETIREMENT (issue #500 part E's review): a file, in ANY state, whose process `retire(pid, name, entry)` says is
 *     gone is folded into the `retired` aggregate as it stands (its mark, its pid; a `running` file's
 *     unresolved calls stay counted) and its name is kept in a set, so it is never read or listed again; a file of a
 *     live process, an unmetered one, or any with no `retire`, stays tracked. A child killed with SIGKILL never
 *     writes `done`, and must not hold an open slot for the rest of the job. A dead child's file cannot change
 *     what it reported, and a job that runs thousands of short pi children over its life must not flood;
 *   - at most CHILD_LEDGER_MAX_FILES OPEN names (tracked, not `done`, not already unmetered) are read; a new name past
 *     that is counted in `flooded`, unmetered and unread. `flooded` is a high-water mark of how many such names one
 *     listing held.
 * Returns `{ processes, unmetered, flooded, totals, rows, modelRefused, usageUnreported, missing, files, retired }`:
 * `processes` the ledger files ever seen (flooded and retired ones included), `unmetered` those counted unmetered
 * (flooded ones included), `totals` and the counters summed over every file's mark and the retired aggregate, `rows`
 * merged by pair (the model-less row last, ids null), `missing` true when the directory could not be listed, `files`
 * the per-file state for the next call (a Map by name of `{ pid, state, unmetered, why, high, sig }`, `why` one of
 * `malformed`, `unmetered`, `shrank`, `vanished`), which the detector reads for a file's pid and state, and `retired`
 * the aggregate (`{ count, names, pids, high }`). `meter.setChildren()` takes the result as it is.
 */
export function foldChildLedgers({ dir, fs = DEFAULT_LEDGER_FS, prev = null, retire = null } = {}) {
	const files = new Map(prev?.files ?? []);
	const retired = prev?.retired
		? { ...prev.retired, names: new Set(prev.retired.names), pids: new Set(prev.retired.pids), high: cloneLedger(prev.retired.high) }
		: { count: 0, names: new Set(), pids: new Set(), high: emptyLedger() };
	let names = [];
	let missing = false;
	try {
		names = [...fs.readdirSync(dir)].map(String).sort();
	} catch {
		missing = true;
	}
	const present = new Set();
	let open = 0;
	for (const entry of files.values()) if (!entry.unmetered && entry.state !== "done") open += 1;
	let beyond = 0;
	for (const name of names) {
		const match = CHILD_LEDGER_NAME.exec(name);
		if (!match || retired.names.has(name)) continue;
		const before = files.get(name) ?? null;
		if (before === null && open >= CHILD_LEDGER_MAX_FILES) {
			beyond += 1;
			continue;
		}
		if (before?.unmetered) {
			present.add(name);
			continue;
		}
		const read = readLedger(fs, join(dir, name), before?.sig ?? null);
		if (read === GONE) continue;
		present.add(name);
		if (read === UNCHANGED) continue;
		const ledger = read === BAD ? null : parseChildLedger(read.text);
		const high = before?.high ?? emptyLedger();
		const pid = Number(match[1]);
		const why = ledger === null ? "malformed" : !ledger.metered ? "unmetered" : before !== null && !reached(high, ledger) ? "shrank" : null;
		const next = why === null
			? { pid, state: ledger.state, unmetered: false, why: null, high: ledger, sig: read.sig }
			: { pid, state: ledger?.state ?? before?.state ?? null, unmetered: true, why, high, sig: null };
		const wasOpen = before !== null && !before.unmetered && before.state !== "done";
		const isOpen = !next.unmetered && next.state !== "done";
		open += (isOpen ? 1 : 0) - (wasOpen ? 1 : 0);
		files.set(name, next);
	}
	for (const [name, entry] of files) {
		if (!present.has(name) && !entry.unmetered) files.set(name, { ...entry, unmetered: true, why: "vanished" });
	}
	if (typeof retire === "function") {
		for (const [name, entry] of files) {
			let gone = false;
			try {
				gone = !entry.unmetered && retire(entry.pid, name, entry) === true;
			} catch {
				gone = false;
			}
			if (!gone) continue;
			files.delete(name);
			retired.names.add(name);
			retired.pids.add(entry.pid);
			retired.count += 1;
			addLedger(retired.high, entry.high);
		}
	}
	const flooded = Math.max(prev?.flooded ?? 0, beyond);

	const sum = cloneLedger(retired.high);
	let unmetered = flooded;
	for (const entry of files.values()) {
		if (entry.unmetered) unmetered += 1;
		addLedger(sum, entry.high);
	}
	// The model-less row last, as usageSnapshot emits its bucket.
	const merged = new Map(sum.rows);
	const modelless = merged.get("");
	merged.delete("");
	const rows = [...merged.values(), ...(modelless ? [modelless] : [])];
	const counters = Object.fromEntries([...LEDGER_GUARD_COUNTS, "usageUnreported"].map((key) => [key, sum[key]]));
	return { processes: files.size + flooded + retired.count, unmetered, flooded, totals: sum.totals, rows, ...counters, missing, files, retired };
}

/** A copy of a ledger mark, its rows copied too. */
function cloneLedger(ledger) {
	return { ...ledger, totals: { ...ledger.totals }, rows: new Map([...ledger.rows].map(([key, row]) => [key, { ...row }])) };
}

/** Add `from`'s totals, counters and rows into `into`, in place. */
function addLedger(into, from) {
	for (const key of Object.keys(into.totals)) into.totals[key] += from.totals[key];
	for (const key of LEDGER_GUARD_COUNTS) into[key] += from[key];
	// The completeness counter's TOP-LEVEL copy (parse lifts it beside modelRefused) summed beside them, so the
	// fold's counters line reads it without reaching into totals.
	into.usageUnreported += from.usageUnreported ?? from.totals.usageUnreported ?? 0;
	for (const [key, row] of from.rows) {
		const there = into.rows.get(key);
		if (there) foldRow(there, row);
		else into.rows.set(key, { ...row });
	}
}

const saturatingAdd = (a, b) => Math.min(Number.MAX_SAFE_INTEGER, a + b);

/**
 * A child ledger object, ready for JSON.stringify (issue #500; the format in the ledger comment above), built from the
 * child's meter and its policy guard (or null). `metered` false is the record of a meter that did not install, written
 * with zeros. Every number comes from the meter and the guard as they are: the writer adds nothing of its own.
 */
export function childLedger({ state, metered = true, meter = null, guard = null }) {
	const snap = metered && meter ? meter.snapshot() : null;
	const refused = metered && guard ? guard.snapshot() : {};
	return {
		v: CHILD_LEDGER_VERSION,
		state,
		metered,
		totals: {
			input: snap?.input ?? 0,
			output: snap?.output ?? 0,
			total: snap?.total ?? 0,
			calls: snap?.calls ?? 0,
			unresolved: snap?.unresolved ?? 0,
			usageUnreported: snap?.usageUnreported ?? 0,
			sessions: snap?.sessions ?? 0,
		},
		rows: snap ? meter.rows() : [],
		modelRefused: refused.modelRefused ?? 0,
	};
}

// ── Issue #500: the child side, the ledger directory a runner opens and the meter a pi child runs ─────────────────
//
// THE ROUTE (DES-USAGE-METER-VIA-API-PROVIDER-REGISTRY). Before it installs its own meter, the runner opens a ledger
// directory (openChildLedger) and puts three things in its own environment, which every descendant inherits: the
// directory, its own pid, and a NODE_OPTIONS `--import` of child-preload.mjs. In each Node child the preload decides
// whether the child is a pi session; if so, the child's own meter is started (startChildMeter) on the child's own
// ModelRuntime class and writes the child's ledger file. The parent folds those files (foldChildLedgers).
//
// THE CONTROL FILE. The parent writes one file into the same directory, whole by temp file and rename:
//   - `STOP`: `{ "v": 1, "reason": <a STOP_MESSAGES key> }` (stopFile). Once it exists, a child's next call is braked
//     with that reason. Present but not readable as that shape, it is a model-policy stop: a garbled STOP is still a
//     STOP (externalStop). Missing means go.
// It is read on every call, without blocking and without following a link (readLedger), so a FIFO or a symlink
// planted under that name refuses rather than hangs. Every file in the directory is written by writeFileAtomic, whose
// temporary file is created exclusively under a random name, so nothing planted there can block or redirect a writer.

/** The ledger directory, set by the runner for every descendant. */
export const CHILD_LEDGER_ENV = "PI_DISPATCH_CHILD_LEDGER";
/** The runner's own pid, so a process can tell the runner from a nested copy of it. */
export const RUNNER_PID_ENV = "PI_DISPATCH_RUNNER_PID";
export const STOP_FILE = "STOP";
/**
 * The globalThis key the preload hands its state over on: `{ dir, name, meter, library, child }`. A Symbol.for key,
 * because the preload, the child-meter extension (loaded by pi's own loader) and code appended to pi's
 * model-runtime.js (library mode) each reach it from a different module graph, and only the global is shared by all.
 */
export const CHILD_METER_HANDOFF = Symbol.for("pi-dispatch.child-meter");

/**
 * Open the run's child ledger directory and point every descendant at it (issue #500). `mkdtemp` makes it mode 0700
 * under the OS temp directory, made absolute (a relative TMPDIR would give each child a different directory), never
 * `/workspace` (the operator's tree) or `/job` (read-only). Sets, in `env`:
 *   - CHILD_LEDGER_ENV, the directory;
 *   - RUNNER_PID_ENV, `pid`, with this process's pid namespace where it can be read (`<pid>:<namespace>`,
 *     child-route.mjs runnerIdentity), so a process in another pid namespace that happens to have this pid is nested;
 *   - NODE_OPTIONS, what it held plus ` --import=<preloadUrl>` (once: a value that already carries it is left alone).
 *     `--import`, not `--require`: a load hook registered from a `--require` preload breaks every child that then uses
 *     asynchronous loader hooks (`module.register`, `--loader`). The price is named in DES: a Node older than 18.19
 *     refuses `--import` in NODE_OPTIONS and does not start.
 * The process that calls this is unaffected: NODE_OPTIONS is read when a Node process starts. Returns `{ dir }`, or
 * `{ error }` (a code, never a path) with CHILD_LEDGER_ENV DELETED from `env` and NODE_OPTIONS untouched, so with no
 * directory no child is pointed anywhere, not even at an inherited one, and every pi child stays unmetered, which the
 * parent's detector then counts. RUNNER_PID_ENV is set either way (issue #500 part D): it is what tells a nested copy
 * of the runner that it is one, and a nested runner with no directory stops with exit 2 instead of running the job
 * again. Never throws.
 */
export function openChildLedger({ env, pid, preloadUrl, mkdtemp = mkdtempSync, tmp = tmpdir, pidNamespace = readPidNamespace }) {
	// env-internal PI_DISPATCH_RUNNER_PID: set by the runner in its own environment, never by the worker.
	env.PI_DISPATCH_RUNNER_PID = runnerIdentity(pid, pidNamespace());
	let dir;
	try {
		dir = resolvePath(mkdtemp(join(tmp(), "pi-dispatch-meter-")));
	} catch (error) {
		// env-internal PI_DISPATCH_CHILD_LEDGER: set by the runner in its own environment, never by the worker.
		delete env.PI_DISPATCH_CHILD_LEDGER;
		return { error: reasonOf(error) };
	}
	env.PI_DISPATCH_CHILD_LEDGER = dir;
	// A file URL carries no whitespace (it is percent-encoded), so NODE_OPTIONS splits it as one argument.
	const flag = `--import=${preloadUrl}`;
	// env-internal NODE_OPTIONS: Node's own variable, extended here for the runner's descendants, never a deployment key.
	const existing = typeof env.NODE_OPTIONS === "string" ? env.NODE_OPTIONS.trim() : "";
	if (!existing.includes(flag)) env.NODE_OPTIONS = existing === "" ? flag : `${existing} ${flag}`;
	return { dir };
}

/** The STOP file's object for `reason`, a STOP_MESSAGES key. */
export function stopFile(reason) {
	if (!Object.hasOwn(STOP_MESSAGES, reason)) throw new Error(`unknown meter stop: ${reason}`);
	return { v: 1, reason };
}

/**
 * Write `text` to `<dir>/<name>` whole: a temporary file beside it, then a rename, so a reader sees the old file or the
 * new one and never half of one. Every writer of the ledger directory uses this: the child's ledger now, the parent's
 * STOP (issue #500 part E). The directory is shared with the agent's own processes, so the temporary file is
 * CREATED, never opened: `O_CREAT|O_EXCL|O_NOFOLLOW|O_NONBLOCK` under a random name, so a FIFO planted there cannot
 * block the writer (the parent's event loop, and with it every brake) and a symlink cannot send the bytes elsewhere.
 * A name that exists is retried under a new one, a few times. The descriptor must be a regular file. The temporary name
 * ends in `.tmp`, which no reader matches. Throws what the fs throws, and leaves no temporary file behind it.
 */
export function writeFileAtomic({ dir, name, text, fs = DEFAULT_WRITE_FS, random = (bytes) => globalThis.crypto.getRandomValues(bytes) }) {
	const path = join(dir, name);
	const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
	let temporary;
	let fd;
	for (let attempt = 0; ; attempt += 1) {
		temporary = `${path}.${[...random(new Uint8Array(8))].map((byte) => byte.toString(16).padStart(2, "0")).join("")}.tmp`;
		try {
			fd = fs.openSync(temporary, flags, 0o600);
			break;
		} catch (error) {
			if (error?.code !== "EEXIST" || attempt >= 7) throw error;
		}
	}
	try {
		try {
			if (!fs.fstatSync(fd).isFile()) throw Object.assign(new Error("not a regular file"), { code: "EFTYPE" });
			const bytes = Buffer.from(text, "utf8");
			let written = 0;
			while (written < bytes.length) written += fs.writeSync(fd, bytes, written, bytes.length - written);
		} finally {
			fs.closeSync(fd);
		}
		fs.renameSync(temporary, path);
	} catch (error) {
		try {
			fs.rmSync(temporary, { force: true });
		} catch {
			// The temporary file is the directory's to lose with it.
		}
		throw error;
	}
}

const DEFAULT_WRITE_FS = { openSync, fstatSync, writeSync, closeSync, renameSync, rmSync, constants };

/**
 * A control file's text, or null when it does not exist. Read like a ledger (readLedger: no link, no blocking open, a
 * regular file of at most CHILD_LEDGER_MAX_BYTES, strict UTF-8); anything else throws, and the caller fails closed.
 */
function readControl(fs, dir, name) {
	const read = readLedger(fs, join(dir, name), null);
	if (read === GONE) return null;
	if (read === BAD || read === UNCHANGED) throw new Error(`unreadable ${name}`);
	return read.text;
}

/**
 * The child's `isStopped` (issue #500): null while `<dir>/STOP` does not exist, its reason once it does. A STOP that is
 * not `{ v: 1, reason: <a STOP_MESSAGES key> }` answers true, and an unreadable one throws: externalStop turns both into
 * a model-policy stop.
 */
export function readStop({ dir, fs = DEFAULT_LEDGER_FS }) {
	const text = readControl(fs, dir, STOP_FILE);
	if (text === null) return null;
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return true;
	}
	return isPlain(parsed) && parsed.v === 1 && typeof parsed.reason === "string" && Object.hasOwn(STOP_MESSAGES, parsed.reason) ? parsed.reason : true;
}

/** A fresh ledger name for `pid`: `<pid>.<16 lowercase hex>.json`. */
export function childLedgerName(pid, random = (bytes) => globalThis.crypto.getRandomValues(bytes)) {
	const nonce = [...random(new Uint8Array(8))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	return `${pid}.${nonce}.json`;
}

/**
 * Start the meter a pi child process runs (issue #500), on the child's OWN ModelRuntime class, and keep its ledger
 * file. Called by child-meter.ts (a pi CLI or rpc child, at extension load) and by the preload's library hook (a Node
 * child that loads pi's unbundled model-runtime.js). Never throws.
 *
 *   - `ModelRuntime`: the class the child's sessions dispatch through. Never the runner's import of dist/index.js: a
 *     child started from the bundle runs the bundle's own copy, and wrapping another one counts nothing.
 *   - `compat`: `{ module, fallbackModels }`, the child's own pi-ai compat copy (installProcessUsageMeter `compat`). Its
 *     stream factory is the brake's.
 *   - `env`: the policy comes from it as the runner reads it: PI_ALLOWED_MODELS (the model guard). There is no token
 *     cap to inherit: the meter only accounts for tokens, and the parent brakes a child through STOP when a policy
 *     stop fires. A policy that does not parse leaves the child unmetered (`metered: false`), the floor, rather
 *     than unguarded.
 *   - `dir`, `name`: the ledger directory and this child's file in it.
 *   - `lazy`: write nothing until the first call is about to go out (the library route: a process that only imports pi
 *     and never calls leaves no file, so a test suite that imports pi hundreds of times cannot flood the directory).
 *     The file is born with the pre-dispatch write of that first call.
 *   - `state`: an object kept across calls in one process (the handoff's), so a second class handed over (two copies
 *     of pi in one process) is installed with the same meter and guard and the ledger stays one file.
 *
 * The install is `brake: true` (a hard stop with no policy, so a STOP can be answered) and `isStopped` reads STOP before
 * every call. The ledger is written whole (writeFileAtomic) after the install (unless `lazy`), on every change the meter
 * reports, BEFORE every call is dispatched with that call counted in flight (the child's guard, below), and once more
 * as `done` when the process exits. FAIL CLOSED ON A WRITE: the pre-dispatch write that fails refuses its call, so no
 * call goes out that the ledger does not already show; and once any write has failed (a full or unwritable /tmp, a
 * directory the agent removed), the child is unmetered and STOPPED: isStopped answers `meter-failed` for every later
 * call, and every later write that still succeeds says `metered: false`. With the install failed, the ledger says `metered: false` and carries zeros. Returns
 * the state: `{ ok, metered, meter, guard, handles, write, verify }`, where `verify(runtime)` marks the child unmetered
 * unless that runtime dispatches through an install (a session's runtime, checked at session_start).
 */
export async function startChildMeter({
	ModelRuntime,
	compat,
	env,
	dir,
	name,
	lazy = false,
	state = {},
	fs = DEFAULT_LEDGER_FS,
	writeFs = DEFAULT_WRITE_FS,
	onExit = (listener) => process.on("exit", listener),
	install = installProcessUsageMeter,
}) {
	try {
		if (state.child) {
			// A second class in one process (two copies of pi, or the library hook and then the extension on one class):
			// the same meter, the same guard, one ledger. A class already installed is not installed twice.
			const child = state.child;
			if (!child.metered || child.classes.has(ModelRuntime)) return child;
			if (typeof ModelRuntime !== "function" || !compat) {
				child.unmetered();
				return child;
			}
			child.classes.add(ModelRuntime);
			await child.installOn(ModelRuntime, compat);
			return child;
		}
		const child = { ok: false, metered: false, failed: false, live: !lazy, meter: null, guard: null, handles: [], classes: new Set([ModelRuntime]), write: () => {}, verify: () => false, installOn: async () => {}, unmetered: () => {} };
		state.child = child;
		let done = false;
		// The call count the ledger must show at least: the meter's own count, or one more while an admitted call is
		// between its pre-dispatch write and the meter seeing it. The gap is synchronous (admit, dispatch, observe), so
		// one reservation is the most there can be; a call that was admitted and never observed stays counted, unresolved.
		let floor = 0;
		child.write = (ledgerState) => {
			if (done) return;
			// A lazy child that never called writes nothing at all, not even at exit.
			if (!child.live) return;
			if (ledgerState === "done") done = true;
			try {
				const ledger = childLedger({ state: ledgerState, metered: child.metered, meter: child.meter, guard: child.guard });
				const reserved = child.metered ? Math.max(0, floor - ledger.totals.calls) : 0;
				ledger.totals.calls += reserved;
				ledger.totals.unresolved += reserved;
				writeFileAtomic({ dir, name, text: JSON.stringify(ledger), fs: writeFs });
			} catch {
				// The fold has no notion of a stale file, so a write that failed would leave an older, smaller ledger
				// that still says metered. Instead the child stops (isStopped below) and is unmetered from here on.
				child.failed = true;
				child.metered = false;
			}
		};
		child.unmetered = () => {
			child.metered = false;
			child.live = true;
			child.write("running");
		};
		onExit(() => child.write("done"));
		let allowedModels;
		try {
			allowedModels = parseAllowedModels(env, "PI_ALLOWED_MODELS");
		} catch {
			child.unmetered();
			return child;
		}
		// No class, or no compat copy to build the brake from: nothing to install on (the library hook found a
		// model-runtime.js it does not recognise, or a bundle it cannot reach). Unmetered, without trying the runner's
		// own resolution.
		if (typeof ModelRuntime !== "function" || !compat) {
			child.unmetered();
			return child;
		}
		child.metered = true;
		child.meter = createUsageMeter({ allowedModels, onChange: () => child.write("running") });
		const policy = createPolicyGuard({ allowedModels, env });
		// THE PRE-DISPATCH WRITE. The guard is the last thing a call passes before it is dispatched (judge), so the child's
		// guard wraps the policy guard (or stands alone, with no policy): once the policy admits a call, the ledger is
		// written with that call already counted, in flight (`unresolved`), and a write that fails refuses the call. So
		// every call that goes out is on disk before it does, at least as a floor; the settle then updates it. One write
		// per call, on top of the observe and settle writes. A lazy child's file is born here, at its first call.
		child.guard = {
			enforces: Object.freeze([...(policy?.enforces ?? [])]),
			admit(call) {
				const refused = policy ? policy.admit(call) : null;
				if (refused !== null && refused !== undefined) return refused;
				const before = floor;
				floor = Math.max(floor, child.meter.state.calls + 1);
				child.live = true;
				child.write("running");
				if (!child.failed) return null;
				floor = before;
				return METER_FAILED;
			},
			...(policy ? { prepare: (call) => policy.prepare(call) } : {}),
			bind: (result) => policy?.bind?.(result),
			// The refusal counter only. Not policy.snapshot(): the pre-dispatch write runs between an admission and its
			// bind, and the counter is read off the guard's state for the same reason (issue #500 part E's review).
			snapshot: () => ({
				...(policy?.model ? { modelRefused: policy.model.snapshot().modelRefused } : {}),
			}),
		};
		// After a failed write, nothing more goes out: the ledger can no longer record it.
		const isStopped = () => (child.failed ? METER_FAILED : readStop({ dir, fs }));
		child.installOn = async (Class, copy) => {
			const handle = await install({
				ModelRuntime: Class,
				meter: child.meter,
				guard: child.guard,
				compat: copy,
				brake: true,
				isStopped,
				// The parent's detector is the parent's; a child samples nothing.
				children: { sample() {} },
			});
			if (!handle?.ok) {
				child.unmetered();
				return;
			}
			child.handles.push(handle);
		};
		await child.installOn(ModelRuntime, compat);
		if (!child.metered) return child;
		child.ok = true;
		child.verify = (runtime) => {
			if (!child.metered) return false;
			if (child.handles.some((handle) => handle.covers?.(runtime))) return true;
			child.unmetered();
			return false;
		};
		child.write("running");
		return child;
	} catch {
		state.child?.unmetered?.();
		return state.child ?? null;
	}
}
