import assert from "node:assert/strict";
import { test } from "node:test";
import { configError } from "../src/config.mjs";
import { InfraRetry, isNeverStartedExit, runJob } from "../src/processor.mjs";
import { buildRecord } from "../src/run-history.mjs";
import { scopeKeyPrefix } from "../src/scoped-limits.mjs";
import { DOCKER_NEVER_STARTED_EXITS } from "../src/backends.mjs";

// The job-count ledger list the processor takes (issue #499 part B), from a `budgetCapsFor`-shaped object.
const asLedgers = (c) => (c ? [{ scope: c.scope, keyPrefix: scopeKeyPrefix(c.scope), caps: c.caps, reason: "scope-cap" }] : []);

// Issue #501, parts 3 and 4 (DES-DOLLAR-RESERVE-AND-SETTLE, the worker half), and #503 part 7: the processor reserves
// a job's per-job cap in the token windows after both job-count reserves and before the container, settles it once
// for every exit where the container ran, and refunds it whole where none did.


const NOW = new Date("2026-10-07T12:00:00Z");
const DAY = "budget:tok:2026-10-07";
const WEEK = "budget:tok:w:2026-10-05";

/** A keyed fake: the job-count INCR/DECR and the token INCRBY/DECRBY on one store, every command logged in order. */
function keyedRedis(preset = {}) {
	const store = new Map(Object.entries(preset));
	const ops = [];
	const at = (k) => store.get(k) ?? 0;
	const redis = {
		store,
		ops,
		async incr(k) {
			ops.push(["incr", k]);
			store.set(k, at(k) + 1);
			return at(k);
		},
		async decr(k) {
			ops.push(["decr", k]);
			store.set(k, at(k) - 1);
			return at(k);
		},
		async incrby(k, n) {
			assert.ok(Number.isSafeInteger(n), `INCRBY integers only, got ${n}`);
			ops.push(["incrby", k, n]);
			store.set(k, at(k) + n);
			return at(k);
		},
		async decrby(k, n) {
			assert.ok(Number.isSafeInteger(n), `DECRBY integers only, got ${n}`);
			ops.push(["decrby", k, n]);
			store.set(k, at(k) - n);
			return at(k);
		},
		async eval(_script, _n, k, arg) {
			const d = Number(arg);
			assert.ok(Number.isSafeInteger(d), `settle delta integers only, got ${arg}`);
			ops.push(["settle", k, d]);
			if (!store.has(k)) return [1, 0];
			store.set(k, Math.max(0, at(k) + d));
			return [0, at(k)];
		},
		async expire() {},
		async get() {
			return null;
		},
	};
	return redis;
}

const usdKeys = (redis) => [...redis.store.keys()].filter((k) => k.startsWith("budget:tok"));

const COMPLETE_TOKENS = { input: 10, output: 5, total: 15, metered: true, rootTotal: 15, otherTotal: 0, looseTotal: 0, sessions: 1, calls: 1, unresolved: 0, childTotal: 0, childProcesses: 0, unmeteredChildren: 0, usageUnreported: 0, modelRefused: 0 };
const LEDGER = { v: 1, piAi: null, truncated: 0, models: [{ provider: "anthropic", model: "m", calls: 1, input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, total: 15 }] };

function deps(overrides = {}) {
	const calls = [];
	const logs = [];
	const redis = overrides.redis ?? keyedRedis();
	const base = {
		redis,
		caps: { day: 10, week: null, month: null },
		softHoldPct: null,
		tokenCaps: { day: 10 * 1, week: 50 * 1, month: null },
		mintToken: async () => "tok",
		isDefaultBranchProtected: async () => true,
		prepareWorkspace: async () => ({ workspaceDir: "/w", jobDir: "/j" }),
		runContainer: async ({ job }) => (calls.push(["run-container", job.maxTokens]), { code: 0, aborted: false, exitLineCode: 0, tokens: COMPLETE_TOKENS, usage: LEDGER }),
		collectChain: async () => ({ enqueued: 0, refused: 0 }),
		cleanup: async () => {},
		comment: async (_j, t) => calls.push(["comment", t]),
		log: (event, fields) => logs.push([event, fields]),
		now: NOW,
	};
	return { deps: { ...base, ...overrides, redis }, calls, logs, redis };
}

const job = { kind: "github", repo: "org/repo", provider: "anthropic", model: "m", maxTurns: 20, maxTokens: 2 };

test("no token setting: nothing reserved or settled, no budget:tok key, the container gets the job unchanged, no tokensWindows", async () => {
	const { deps: d, calls, redis } = deps({ tokenCaps: null });
	const input = { ...job };
	const r = await runJob(input, d);
	assert.equal(r.outcome, "completed");
	assert.deepEqual(usdKeys(redis), []);
	assert.ok(!redis.ops.some((o) => o[0] === "incrby" || o[0] === "decrby" || o[0] === "settle"));
	assert.equal(Object.hasOwn(r, "tokensWindows"), false, "the result shape is the old one");
	assert.deepEqual(calls.find((c) => c[0] === "run-container"), ["run-container", 2]);
	assert.deepEqual(input, job, "job data untouched");
	assert.equal(buildRecord({ job: { id: "j", data: {} }, result: r }).tokensWindows, null);
});

test("ORDER: the scoped and global job-count reserves, then the token reserve, then the container, then one settle", async () => {
	const { deps: d, redis } = deps({ scopedLedgers: asLedgers({ scope: "org/repo", caps: { day: 5, week: null, month: null } }) });
	const marks = [];
	const run = d.runContainer;
	d.runContainer = async (ctx) => (marks.push(redis.ops.length), run(ctx));
	const r = await runJob(job, d);
	const before = redis.ops.slice(0, marks[0]).map((o) => o.slice(0, 2));
	assert.deepEqual(before, [
		["incr", `${scopeKeyPrefix("org/repo")}:2026-10-07`],
		["incr", "budget:2026-10-07"],
		["incrby", DAY],
		["incrby", WEEK],
	]);
	const after = redis.ops.slice(marks[0]);
	assert.deepEqual(after, [["settle", DAY, 15 - 2], ["settle", WEEK, 15 - 2]], "settled ONCE, to the metered cost");
	assert.equal(redis.store.get(DAY), 15);
	assert.deepEqual(r.tokensWindows, { reservedTokens: 2, settledTokens: 15, basis: "metered", modelBasis: null });
});

test("a full token window refuses token-cap, gives back BOTH job-count slots and its own tokensWindows, and starts nothing", async () => {
	const scope = { scope: "org/repo", caps: { day: 5, week: null, month: null } };
	const { deps: d, calls, logs, redis } = deps({ redis: keyedRedis({ [DAY]: 9 * 1 }), scopedLedgers: asLedgers(scope) });
	const r = await runJob(job, d);
	assert.deepEqual(r, { outcome: "policy", reason: "token-cap", exitCode: null, turns: null, tokens: null, provider: "anthropic", model: "m", budgetReserved: false, tokensWindows: { reservedTokens: 2, settledTokens: 0, basis: "refunded", modelBasis: null } });
	assert.ok(!calls.some((c) => c[0] === "run-container"), "no container");
	assert.equal(redis.store.get("budget:2026-10-07"), 0, "the global job-count slot is back");
	assert.equal(redis.store.get(`${scopeKeyPrefix("org/repo")}:2026-10-07`), 0, "the scoped slot is back");
	assert.equal(redis.store.get(DAY), 9 * 1, "the refused tokensWindows are back");
	assert.match(calls.find((c) => c[0] === "comment")[1], /^Refused: today's token budget/);
	assert.doesNotMatch(calls.find((c) => c[0] === "comment")[1], /\d/, "no amount in the comment");
	assert.deepEqual(logs.find((l) => l[0] === "over_token_budget")[1], { ledger: "deployment", window: "day", reservedTokens: 11 * 1, capTokens: 10 * 1, amountTokens: 2, refunded: true });
	assert.equal(buildRecord({ job: { id: "j", data: {} }, result: r }).reason, "token-cap");
});

test("settles ONCE on every path where the container ran: completed, policy, abort, exit 1, unknown exit, detached", async () => {
	const cases = [
		["completed", { code: 0, aborted: false, exitLineCode: 0, tokens: COMPLETE_TOKENS, usage: LEDGER }, "return", "metered", 15],
		["policy", { code: 2, aborted: false, exitLineCode: 2, tokens: COMPLETE_TOKENS, usage: LEDGER, exitReason: "model-not-allowed" }, "return", "metered", 15],
		["abort", { code: 137, aborted: true, tokens: null }, "return", "floor", 2],
		["cancel", { code: 137, aborted: true, abortReason: "operator-cancel", tokens: { ...COMPLETE_TOKENS, usageUnreported: 1 }, usage: LEDGER }, "return", "floor", 15],
		["exit-1", { code: 1, aborted: false, exitLineCode: 1, tokens: COMPLETE_TOKENS, usage: LEDGER }, "throw", "metered", 15],
		["unknown", { code: 99, aborted: false, exitLineCode: 99, tokens: null }, "throw", "floor", 2],
		// Detached: the worker stopped the container, so its exit line is not trusted (round 3): the floor, at the
		// known part (15 above the 2-token reservation).
		["detached", { code: 125, aborted: false, detached: true, exitLineCode: 125, tokens: COMPLETE_TOKENS, usage: LEDGER }, "throw", "floor", 15],
	];
	for (const [name, exit, how, basis, settled] of cases) {
		const { deps: d, redis } = deps({ runContainer: async () => exit });
		let out;
		if (how === "return") out = await runJob(job, d);
		else {
			await assert.rejects(runJob(job, d), (e) => (out = e) instanceof InfraRetry, name);
		}
		assert.deepEqual(out.tokensWindows, { reservedTokens: 2, settledTokens: settled, basis, modelBasis: null }, name);
		assert.equal(redis.store.get(DAY), settled, `${name}: the window holds the settled amount`);
		assert.equal(redis.ops.filter((o) => o[0] === "incrby" && o[1] === DAY).length, 1, `${name}: one reserve`);
		assert.equal(redis.ops.filter((o) => o[0] === "settle" && o[1] === DAY).length, settled === 2 ? 0 : 1, `${name}: at most one settle`);
		assert.equal(redis.ops.filter((o) => o[0] === "decrby").length, 0, `${name}: never also refunded`);
		const record = how === "return" ? buildRecord({ job: { id: "j", data: {} }, result: out }) : buildRecord({ job: { id: "j", data: {} }, error: out });
		assert.equal(record.tokensWindows.basis, basis, `${name}: the record says so`);
	}
});

test("tokens: null (no exit line) settles at the floor: the whole reservation stays", async () => {
	const { deps: d, redis } = deps({ runContainer: async () => ({ code: 0, aborted: false, exitLineCode: 0, tokens: null, usage: null }) });
	const r = await runJob(job, d);
	assert.deepEqual(r.tokensWindows, { reservedTokens: 2, settledTokens: 2, basis: "floor", modelBasis: null });
	assert.equal(redis.store.get(DAY), 2);
});

test("a never-started exit is NOT settled: the catch refunds the tokensWindows and the job-count slot together", async () => {
	for (const code of DOCKER_NEVER_STARTED_EXITS) {
		const { deps: d, redis, logs } = deps({ runContainer: async () => ({ code, aborted: false, tokens: null }) });
		let err;
		await assert.rejects(runJob(job, d), (e) => (err = e) instanceof InfraRetry);
		assert.equal(err.reason, "container-never-started");
		assert.deepEqual(err.tokensWindows, { reservedTokens: 2, settledTokens: 0, basis: "refunded", modelBasis: null }, String(code));
		assert.equal(err.budgetReserved, false);
		assert.equal(redis.store.get(DAY), 0, "tokensWindows back");
		assert.equal(redis.store.get("budget:2026-10-07"), 0, "job-count slot back");
		assert.ok(!logs.some((l) => l[0] === "token_settled"), "never settled");
	}
});

test("isNeverStartedExit: the one answer, false for a detached or aborted container and for the runner's own codes", () => {
	const nev = [125, 126, 127];
	assert.equal(isNeverStartedExit({ code: 125 }, nev), true);
	assert.equal(isNeverStartedExit({ code: 125, detached: true }, nev), false);
	assert.equal(isNeverStartedExit({ code: 125, aborted: true }, nev), false);
	for (const code of [0, 1, 2]) assert.equal(isNeverStartedExit({ code }, [0, 1, 2]), false, String(code));
	assert.equal(isNeverStartedExit({ code: 99 }, nev), false);
	assert.equal(isNeverStartedExit({ code: 125 }, null), false);
});

test("a spawn fault (runContainer throws never-started) and a config refusal from runContainer both refund the tokensWindows in full", async () => {
	{
		const { deps: d, redis } = deps({ runContainer: async () => { throw new InfraRetry("spawn", { reason: "container-never-started" }); } });
		let err;
		await assert.rejects(runJob(job, d), (e) => (err = e) instanceof InfraRetry);
		assert.equal(err.tokensWindows.basis, "refunded");
		assert.equal(redis.store.get(DAY), 0);
	}
	{
		const { deps: d, redis } = deps({ runContainer: async () => { throw configError("no forge"); } });
		const r = await runJob(job, d);
		assert.equal(r.reason, "config-refused");
		assert.deepEqual(r.tokensWindows, { reservedTokens: 2, settledTokens: 0, basis: "refunded", modelBasis: null });
		assert.equal(redis.store.get(DAY), 0);
		assert.equal(redis.store.get(WEEK), 0);
		assert.equal(redis.store.get("budget:2026-10-07"), 0);
	}
});

test("an unexpected throw after the reservation LEAVES the hold (the floor) and logs token_hold_unsettled", async () => {
	const { deps: d, redis, logs } = deps({ runContainer: async () => { throw new TypeError("a defect"); } });
	let err;
	await assert.rejects(runJob(job, d), (e) => (err = e) instanceof TypeError);
	assert.equal(redis.store.get(DAY), 2, "the reservation stands");
	assert.deepEqual(logs.find((l) => l[0] === "token_hold_unsettled")[1], { reservedTokens: 2, error: "TypeError" });
	assert.deepEqual(err.tokensWindows, { reservedTokens: 2, settledTokens: 2, basis: "floor", modelBasis: null });
	assert.equal(buildRecord({ job: { id: "j", data: {} }, error: err }).tokensWindows.basis, "floor");
});

test("a Valkey fault in the token reserve is a never-started retry: the job-count slot is refunded and nothing is held", async () => {
	const redis = keyedRedis();
	redis.incrby = async () => {
		throw Object.assign(new Error("down"), { code: "ECONNREFUSED" });
	};
	const { deps: d, calls, logs } = deps({ redis });
	let err;
	await assert.rejects(runJob(job, d), (e) => (err = e) instanceof InfraRetry);
	assert.equal(err.reason, "container-never-started");
	assert.equal(err.budgetReserved, false);
	assert.equal(redis.store.get("budget:2026-10-07"), 0);
	assert.ok(!calls.some((c) => c[0] === "run-container"));
	assert.deepEqual(logs.find((l) => l[0] === "token_reserve_error")[1], { code: "ECONNREFUSED" });
});

test("a token window with no per-job cap on the job is refused as configuration, both job-count slots refunded", async () => {
	const { deps: d, redis, calls } = deps();
	const r = await runJob({ ...job, maxTokens: null }, d);
	assert.equal(r.reason, "config-refused");
	assert.equal(r.budgetReserved, false);
	assert.equal(redis.store.get("budget:2026-10-07"), 0);
	assert.deepEqual(usdKeys(redis), []);
	assert.ok(!calls.some((c) => c[0] === "run-container"));
});

// ---- PR #542's review: zero-call runs, the floor's lower bound, and the paths no test held ----

// What the runner writes when it made no provider call: metered, calls 0, cost 0, the cap counters, and NO usage
// ledger (usage-meter.mjs `usageSnapshot` returns null for a zero-call run, so run-job.mjs omits the key).
const ZERO_CALL = { input: 0, output: 0, total: 0, metered: true, rootTotal: 0, otherTotal: 0, looseTotal: 0, sessions: 0, calls: 0, unresolved: 0, childTotal: 0, childProcesses: 0, unmeteredChildren: 0, usageUnreported: 0, modelRefused: 0 };

test("a run that made NO provider call settles metered at 0: the guard refused call 1, a command job, an early exit 1", async () => {
	const cases = [
		["first call refused by the guard", { code: 2, aborted: false, exitLineCode: 2, exitReason: "model-not-allowed", tokens: { ...ZERO_CALL, modelRefused: 1 } }, "return"],
		["a command job that called no model", { code: 0, aborted: false, exitLineCode: 0, tokens: ZERO_CALL }, "return"],
		["an early exit 1", { code: 1, aborted: false, exitLineCode: 1, tokens: ZERO_CALL }, "throw"],
	];
	for (const [name, exit, how] of cases) {
		const { deps: d, redis } = deps({ runContainer: async () => exit });
		let out;
		if (how === "return") out = await runJob(job, d);
		else await assert.rejects(runJob(job, d), (e) => (out = e) instanceof InfraRetry, name);
		assert.deepEqual(out.tokensWindows, { reservedTokens: 2, settledTokens: 0, basis: "metered", modelBasis: null }, name);
		assert.equal(redis.store.get(DAY), 0, `${name}: the window gets its whole cap back`);
		assert.equal(redis.store.get(WEEK), 0, name);
	}
});

test("a runner's config refusal AFTER a spent load-time call (issue #543) settles on the exit line, never refunded", async () => {
	// The runner writes its tokens on every exit line once the meter is installed, so a job whose extension spent at
	// load and that then failed a pre-prompt check (command-unregistered) settles at what it spent. A runner
	// config exit is a container that ran, so it is settled, never refunded like the worker's own config refusal;
	// without tokens (an older runner) it stays at the floor.
	const spent = { code: 2, aborted: false, exitLineCode: 2, exitReason: "command-unregistered", tokens: COMPLETE_TOKENS, usage: LEDGER };
	const { deps: d, redis } = deps({ runContainer: async () => spent });
	const out = await runJob(job, d).catch((error) => error);
	assert.deepEqual(out.tokensWindows, { reservedTokens: 2, settledTokens: 15, basis: "metered", modelBasis: null });
	assert.equal(redis.store.get(DAY), 15, "the window keeps what the load-time call spent");
	const old = deps({ runContainer: async () => ({ ...spent, tokens: null, usage: null }) });
	const floored = await runJob(job, old.deps).catch((error) => error);
	assert.deepEqual(floored.tokensWindows, { reservedTokens: 2, settledTokens: 2, basis: "floor", modelBasis: null });
});

test("a floor never charges less than a reported metered total: 5,000 tokens with unresolved 1 under a 2-token hold charges 5,000", async () => {
	const { deps: d, redis } = deps({ runContainer: async () => ({ code: 0, aborted: false, exitLineCode: 0, tokens: { ...COMPLETE_TOKENS, total: 5_000, unresolved: 1 }, usage: LEDGER }) });
	const r = await runJob(job, d);
	assert.deepEqual(r.tokensWindows, { reservedTokens: 2, settledTokens: 5_000, basis: "floor", modelBasis: null });
	assert.equal(redis.store.get(DAY), 5_000);
});

test("a settle that adjusted NO key records the floor, whatever the computed basis was", async () => {
	const redis = keyedRedis();
	redis.eval = async () => {
		throw Object.assign(new Error("down"), { code: "ECONNRESET" });
	};
	const { deps: d, logs } = deps({ redis });
	const r = await runJob(job, d);
	assert.deepEqual(r.tokensWindows, { reservedTokens: 2, settledTokens: 2, basis: "floor", modelBasis: null });
	assert.equal(redis.store.get(DAY), 2, "the reservation stands");
	assert.deepEqual(logs.find((l) => l[0] === "token_settle_error")[1], { code: "ECONNRESET", applied: 0, of: 2 });
});

test("an InfraRetry that is NOT never-started, thrown by runContainer, keeps the hold: the container may have run", async () => {
	const { deps: d, redis, logs } = deps({ runContainer: async () => { throw new InfraRetry("lost the daemon mid-run", { reason: "container-detached" }); } });
	let err;
	await assert.rejects(runJob(job, d), (e) => (err = e) instanceof InfraRetry);
	assert.equal(redis.store.get(DAY), 2);
	assert.deepEqual(err.tokensWindows, { reservedTokens: 2, settledTokens: 2, basis: "floor", modelBasis: null });
	assert.deepEqual(logs.find((l) => l[0] === "token_hold_unsettled")[1], { reservedTokens: 2, error: "infra-retry" });
});

test("a token refusal whose job-count refund FAILED says budgetReserved: true", async () => {
	const redis = keyedRedis({ [DAY]: 9 * 1 });
	redis.decr = async () => {
		throw Object.assign(new Error("down"), { code: "ECONNRESET" });
	};
	const { deps: d, logs } = deps({ redis });
	const r = await runJob(job, d);
	assert.equal(r.reason, "token-cap");
	assert.equal(r.budgetReserved, true, "the slot is still out there");
	assert.equal(logs.find((l) => l[0] === "over_token_budget")[1].refunded, false);
});

test("a token refusal whose token give-back failed for a key records the floor, not refunded", async () => {
	const redis = keyedRedis({ [WEEK]: 49 * 1 });
	const decrby = redis.decrby;
	let n = 0;
	redis.decrby = async (k, v) => {
		if (n++ === 0) throw Object.assign(new Error("down"), { code: "ECONNRESET" });
		return decrby(k, v);
	};
	const { deps: d, logs } = deps({ redis });
	const r = await runJob(job, d);
	assert.equal(r.reason, "token-cap");
	assert.deepEqual(r.tokensWindows, { reservedTokens: 2, settledTokens: 2, basis: "floor", modelBasis: null });
	assert.deepEqual(logs.find((l) => l[0] === "token_giveback_error")[1], { code: "ECONNRESET", key: DAY });
	assert.equal(redis.store.get(WEEK), 49 * 1, "the other key was still given back");
});

test("a never-started exit whose release only partly lands records the floor, not refunded", async () => {
	const redis = keyedRedis();
	const evalOk = redis.eval;
	let n = 0;
	redis.eval = async (...a) => {
		if (n++ === 1) throw Object.assign(new Error("down"), { code: "ECONNRESET" });
		return evalOk(...a);
	};
	const { deps: d } = deps({ redis, runContainer: async () => ({ code: 125, aborted: false, exitLineCode: 125, tokens: null }) });
	let err;
	await assert.rejects(runJob(job, d), (e) => (err = e) instanceof InfraRetry);
	assert.deepEqual(err.tokensWindows, { reservedTokens: 2, settledTokens: 2, basis: "floor", modelBasis: null });
	assert.equal(redis.store.get(DAY), 0);
	assert.equal(redis.store.get(WEEK), 2, "the week the release did not reach still holds it");
});

test("a job whose per-job cap is ALREADY 0 (and is not zero-rated) reserves nothing and records unreserved", async () => {
	const { deps: d, calls, redis } = deps();
	const r = await runJob({ ...job, maxTokens: 0 }, d);
	assert.equal(r.outcome, "completed");
	assert.deepEqual(r.tokensWindows, { reservedTokens: 0, settledTokens: 0, basis: "unreserved", modelBasis: null });
	assert.deepEqual(usdKeys(redis), []);
	assert.deepEqual(calls.find((c) => c[0] === "run-container"), ["run-container", 0]);
});

test("an unreserved job whose exit line reports tokens above 0 is logged token_unreserved_used, and still writes no key", async () => {
	const { deps: d, logs, redis } = deps({ modelEndpoints: { endpoints: [{ id: "mac-ollama", host: "host.docker.internal", port: 11434, slots: 2, keyless: true }], models: { providers: { "local-ollama": { baseUrl: "http://host.docker.internal:11434/v1", models: [{ id: "q" }] } } }, set: [] }, runContainer: async () => ({ code: 0, aborted: false, exitLineCode: 0, tokens: { ...COMPLETE_TOKENS, total: 2 }, usage: LEDGER }) });
	const r = await runJob({ ...job, provider: "local-ollama", model: "q" }, d);
	assert.equal(r.tokensWindows.basis, "unreserved");
	assert.deepEqual(logs.find((l) => l[0] === "token_unreserved_used")[1], { tokens: 2 });
	assert.deepEqual(usdKeys(redis), []);
});

// ---- PR #542's review, round 3: an exit line the job's own tools forged ----

// What a tool child writes to the runner's stdout before the container is stopped: a "clean" zero-call line.
const FORGED = { ...ZERO_CALL };

test("a forged $0 exit line followed by a worker stop (timeout, shutdown, cancel) settles at the FLOOR", async () => {
	for (const abortReason of [undefined, "operator-cancel"]) {
		const { deps: d, redis } = deps({ runContainer: async () => ({ code: 137, aborted: true, ...(abortReason ? { abortReason } : {}), exitLineCode: 0, tokens: FORGED }) });
		const r = await runJob(job, d);
		assert.deepEqual(r.tokensWindows, { reservedTokens: 2, settledTokens: 2, basis: "floor", modelBasis: null }, String(abortReason));
		assert.equal(redis.store.get(DAY), 2, "the hold stands");
	}
});

test("a forged line that GUESSES the stop code (137) is still the floor: a stopped container's line is never trusted", async () => {
	for (const abortReason of [undefined, "operator-cancel"]) {
		const { deps: d, redis } = deps({ runContainer: async () => ({ code: 137, aborted: true, ...(abortReason ? { abortReason } : {}), exitLineCode: 137, tokens: FORGED }) });
		const r = await runJob(job, d);
		assert.equal(r.tokensWindows.basis, "floor", String(abortReason));
		assert.equal(redis.store.get(DAY), 2);
	}
});

test("a forged exit line whose code is not the container's exit code settles at the floor; so does a missing one", async () => {
	for (const [exit, settled] of [
		[{ code: 137, aborted: false, exitLineCode: 0, tokens: FORGED }, 2], // the kernel's kill, a forged clean line
		[{ code: 1, aborted: false, exitLineCode: 0, tokens: FORGED }, 2],
		[{ code: 0, aborted: false, tokens: COMPLETE_TOKENS, usage: LEDGER }, 15], // a sink that reports no line code
		[{ code: 0, aborted: false, exitLineCode: "0", tokens: COMPLETE_TOKENS, usage: LEDGER }, 15],
	]) {
		const { deps: d, redis } = deps({ runContainer: async () => exit });
		let out;
		try {
			out = await runJob(job, d);
		} catch (e) {
			out = e;
		}
		assert.equal(out.tokensWindows.basis, "floor", JSON.stringify(exit));
		assert.equal(redis.store.get(DAY), settled, JSON.stringify(exit));
	}
});

test("a genuine clean run (not stopped, its line's code the container's) is still metered", async () => {
	const { deps: d, redis } = deps({ runContainer: async () => ({ code: 0, aborted: false, exitLineCode: 0, tokens: COMPLETE_TOKENS, usage: LEDGER }) });
	const r = await runJob(job, d);
	assert.equal(r.tokensWindows.basis, "metered");
	assert.equal(redis.store.get(DAY), 15);
});

// ---- #503 part 7: a job that cannot spend reserves nothing ----

const OVERLAY = {
	providers: {
		"local-ollama": { api: "openai-completions", baseUrl: "http://host.docker.internal:11434/v1", apiKey: "$PI_DISPATCH_KEYLESS", models: [{ id: "qwen2.5:0.5b" }, { id: "llama3:8b" }] },
		openai: { models: [{ id: "priced-local", api: "openai-completions", baseUrl: "http://host.docker.internal:11434/v1", cost: { input: 100, output: 200, cacheRead: 0, cacheWrite: 0 } }] },
	},
};
const ENDPOINTS = [{ id: "mac-ollama", host: "host.docker.internal", port: 11434, slots: 2, keyless: true }];
const snapshot = { endpoints: ENDPOINTS, models: OVERLAY, set: ENDPOINTS };
const localJob = { kind: "local", folder: "/x", task: "t", provider: "local-ollama", model: "qwen2.5:0.5b", maxTokens: 2 };

test("a zero-rated job on a declared endpoint writes NO budget:tok key, runs under a cap of 0, and records unreserved", async () => {
	const { deps: d, calls, redis } = deps({ modelEndpoints: snapshot });
	const r = await runJob(localJob, d);
	assert.equal(r.outcome, "completed");
	assert.deepEqual(usdKeys(redis), [], "no token key at all");
	assert.deepEqual(calls.find((c) => c[0] === "run-container"), ["run-container", 0], "PI_MAX_TOKENS=0 reaches the container");
	assert.deepEqual(r.tokensWindows, { reservedTokens: 0, settledTokens: 0, basis: "unreserved", modelBasis: null });
	assert.equal(localJob.maxTokens, 2, "the job itself is not mutated");
});

test("zero reservation reads the WHOLE allowed list: one listed model off the endpoint or priced means the job reserves", async () => {
	for (const models of [["local-ollama/qwen2.5:0.5b", "anthropic/claude-sonnet-4-5"], ["local-ollama/qwen2.5:0.5b", "openai/priced-local"]]) {
		const { deps: d, calls, redis } = deps({ modelEndpoints: snapshot });
		const r = await runJob({ ...localJob, models }, d);
		assert.equal(redis.store.get(DAY), 15, `${models[1]}: reserved and settled`);
		assert.deepEqual(calls.find((c) => c[0] === "run-container"), ["run-container", 2]);
		assert.equal(r.tokensWindows.basis, "metered");
	}
	const { deps: d, redis } = deps({ modelEndpoints: snapshot });
	await runJob({ ...localJob, models: ["local-ollama/qwen2.5:0.5b", "local-ollama/llama3:8b"] }, d);
	assert.deepEqual(usdKeys(redis), [], "every listed model local and zero-rated: nothing reserved");
});

test("no endpoint snapshot, or an overlay that could not be read, reserves as usual (fail closed)", async () => {
	for (const modelEndpoints of [null, { endpoints: ENDPOINTS, models: null, set: [] }, { endpoints: [], models: OVERLAY, set: [] }]) {
		const { deps: d, redis } = deps({ modelEndpoints });
		await runJob(localJob, d);
		assert.equal(redis.store.get(DAY), 15, JSON.stringify(modelEndpoints));
	}
});

// ---- the wiring: makeProcessor resolves the windows from the settings and hands them to runJob ----

let mod;
try {
	mod = await import("../src/index.mjs");
} catch (error) {
	if (process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") throw new Error(`processor-tokensWindows REQUIRES bullmq here.\n${error}`);
}
const skip = mod ? false : "bullmq not installed; CI runs these";

function harness(settings, redis) {
	const seen = { records: [], container: null };
	const processor = mod.makeProcessor({
		cancelJob: () => {},
		stopContainer: () => {},
		redis,
		getSettings: () => settings,
		recordRun: (rec) => seen.records.push(rec),
		timeoutMs: 100000,
		deps: {
			mintToken: async () => "tok",
			isDefaultBranchProtected: async () => true,
			prepareWorkspace: async () => ({ workspaceDir: "/w", jobDir: "/j" }),
			runContainer: async ({ job }) => ((seen.container = job), { code: 0, aborted: false, exitLineCode: 0, tokens: COMPLETE_TOKENS, usage: LEDGER }),
			cleanup: async () => {},
			comment: async () => {},
			log: () => {},
		},
	});
	return { processor, seen };
}

const settingsOf = (over = {}) => ({ provider: "anthropic", model: "claude-sonnet-4-5", maxTurns: 30, dailyCap: 10, weeklyCap: null, monthlyCap: null, concurrency: 3, softHoldPct: null, maxTokens: null, dailyTokenCap: null, weeklyTokenCap: null, monthlyTokenCap: null, ...over });
const bullJob = (data = {}) => ({ id: "d-1", attemptsMade: 0, name: "github", data: { kind: "github", repo: "o/r", flow: "fix", ...data } });

test("makeProcessor: windows in the settings reserve and settle the per-job cap; the record carries tokensWindows", { skip }, async () => {
	const redis = keyedRedis();
	const { processor, seen } = harness(settingsOf({ maxTokens: "2", dailyTokenCap: "10" }), redis);
	const result = await processor(bullJob(), undefined, new AbortController().signal);
	assert.equal(result.outcome, "completed");
	const day = `budget:tok:${new Date().toISOString().slice(0, 10)}`;
	assert.equal(redis.store.get(day), 15);
	assert.equal(seen.container.maxTokens, 2);
	assert.deepEqual(seen.records[0].result.tokensWindows, { reservedTokens: 2, settledTokens: 15, basis: "metered", modelBasis: null });
});

test("makeProcessor: with NO token setting nothing is written, job data is untouched, and the record's tokensWindows is null", { skip }, async () => {
	for (const settings of [settingsOf(), settingsOf({ maxTokens: "2" })]) {
		const redis = keyedRedis();
		const { processor, seen } = harness(settings, redis);
		const queued = bullJob();
		const before = JSON.stringify(queued.data);
		await processor(queued, undefined, new AbortController().signal);
		assert.deepEqual(usdKeys(redis), [], "no budget:tok key");
		assert.ok(!redis.ops.some((o) => o[0] === "incrby"), "no INCRBY at all");
		assert.equal(JSON.stringify(queued.data), before, "job data byte-identical");
		assert.equal(Object.hasOwn(seen.records[0].result, "tokensWindows"), false);
	}
});

test("makeProcessor: a job the operator cancelled while it was failing records its tokensWindows on the cancel record (endCancelled)", { skip }, async () => {
	const redis = keyedRedis();
	const controller = new AbortController();
	const seen = { records: [] };
	const processor = mod.makeProcessor({
		cancelJob: () => {},
		stopContainer: () => {},
		redis,
		getSettings: () => settingsOf({ maxTokens: "2", dailyTokenCap: "10" }),
		recordRun: (rec) => seen.records.push(rec),
		timeoutMs: 100000,
		deps: {
			mintToken: async () => "tok",
			isDefaultBranchProtected: async () => true,
			prepareWorkspace: async () => ({ workspaceDir: "/w", jobDir: "/j" }),
			// The container dies as infrastructure while the operator's cancel lands: the processor's catch ends the job as
			// the cancel (endCancelled) instead of retrying it, and that record must still say what the window was charged.
			runContainer: async () => {
				controller.abort("operator-cancel");
				throw new InfraRetry("the daemon went away mid-run", { reason: "container-detached" });
			},
			cleanup: async () => {},
			comment: async () => {},
			log: () => {},
		},
	});
	const result = await processor(bullJob(), undefined, controller.signal);
	assert.equal(result.reason, "operator-cancel");
	assert.deepEqual(result.tokensWindows, { reservedTokens: 2, settledTokens: 2, basis: "floor", modelBasis: null });
	assert.deepEqual(seen.records.at(-1).result.tokensWindows, result.tokensWindows);
});

// ---- issue #545: an image that signs its exit line ----

test("an image declaring exitAuth gets a key (runContainer exitAuth: true); one that does not, runs as before", async () => {
	for (const [capabilities, want] of [[["tokenBudget", "exitAuth"], true], [["tokenBudget"], undefined], [undefined, undefined]]) {
		let seen = "unset";
		const { deps: d, logs } = deps({
			imagePreflight: async () => ({ ok: true, image: "pi-job:x", ...(capabilities ? { capabilities } : {}) }),
			runContainer: async (args) => ((seen = args.exitAuth), { code: 0, aborted: false, exitLineCode: 0, tokens: COMPLETE_TOKENS, usage: LEDGER, ...(want ? { exitAuth: "verified" } : {}) }),
		});
		const r = await runJob(job, d);
		assert.equal(seen, want, JSON.stringify(capabilities));
		assert.equal(r.tokensWindows.basis, "metered");
		const exit = logs.find(([event]) => event === "container_exit")[1];
		assert.equal(exit.exitAuth, want ? "verified" : undefined);
	}
});

// The transcriptStderr and steerStdin forwards to runContainer (#686) went with the venues and image
// capabilities that armed them: no image declares the tokens any more, so the processor forwards neither.
test("an unverified run (a key issued, no signed line) settles at the FLOOR and records tokens as unknown", async () => {
	const { deps: d, redis, logs } = deps({
		imagePreflight: async () => ({ ok: true, image: "pi-job:x", capabilities: ["exitAuth"] }),
		runContainer: async () => ({ code: 0, aborted: false, turns: null, tokens: null, session: null, usage: null, context: null, exitReason: null, exitLineCode: null, exitAuth: "unverified" }),
	});
	const r = await runJob(job, d);
	assert.equal(r.tokensWindows.basis, "floor");
	assert.equal(r.tokens, null);
	assert.equal(redis.store.get(DAY), 2);
	assert.equal(logs.find(([event]) => event === "container_exit")[1].exitAuth, "unverified");
});

test("a verified line still meets the #542 rule: a stopped container's signed line settles at the floor", async () => {
	const { deps: d } = deps({
		imagePreflight: async () => ({ ok: true, image: "pi-job:x", capabilities: ["exitAuth"] }),
		runContainer: async () => ({ code: 143, aborted: true, exitLineCode: 143, tokens: COMPLETE_TOKENS, usage: LEDGER, exitAuth: "verified" }),
	});
	const r = await runJob(job, d);
	assert.equal(r.tokensWindows.basis, "floor");
	assert.equal(r.tokens.total, 15, "the token record keeps the runner's real count, which the SIGTERM handler now writes");
});


test("live hold reports the actual reserve once, then clears after settlement", async () => {
	const observed = [];
	const { deps: d } = deps({ onTokenHold: (hold) => observed.push(hold), runContainer: async () => {
		assert.deepEqual(observed, [{ amountTokens: 2, at: NOW.getTime() }]);
		return { code: 0, aborted: false, exitLineCode: 0, tokens: COMPLETE_TOKENS, usage: LEDGER };
	} });
	assert.equal((await runJob(job, d)).outcome, "completed");
	assert.deepEqual(observed, [{ amountTokens: 2, at: NOW.getTime() }, null]);
});

test("live hold is never published on a refused reserve and reporting cannot fail a paid run", async () => {
	const observed = [];
	const { deps: refused } = deps({ redis: keyedRedis({ [DAY]: 10 * 1 }), onTokenHold: (hold) => observed.push(hold) });
	assert.equal((await runJob(job, refused)).reason, "token-cap");
	assert.deepEqual(observed, []);
	const { deps: d } = deps({ onTokenHold: () => { throw new Error("observer unavailable"); } });
	assert.equal((await runJob(job, d)).outcome, "completed");
});

test("live hold clears on a never-started container refund", async () => {
	const observed = [];
	const { deps: d } = deps({ onTokenHold: (hold) => observed.push(hold), runContainer: async () => ({ code: 125, aborted: false }) });
	await assert.rejects(runJob(job, d), InfraRetry);
	assert.deepEqual(observed, [{ amountTokens: 2, at: NOW.getTime() }, null]);
});


test("live hold remains published while a never-started refund is in flight, including a failed give-back", async () => {
	for (const fails of [false, true]) {
		const observed = [];
		const redis = keyedRedis();
		const original = redis.eval;
		redis.eval = async (...args) => {
			assert.equal(observed.at(-1)?.amountTokens, 2, "still a hold until the release answers");
			if (fails) throw new Error("unreachable");
			return original(...args);
		};
		const { deps: d } = deps({ redis, onTokenHold: (hold) => observed.push(hold), runContainer: async () => ({ code: 125, aborted: false }) });
		const error = await runJob(job, d).catch((e) => e);
		assert.ok(error instanceof InfraRetry);
		assert.equal(error.tokensWindows.basis, fails ? "floor" : "refunded");
		assert.equal(observed.at(-1), null, "a retained floor is now charged, not held by a running job");
	}
});

test("a midnight-crossing container keeps its reservation's UTC day and reservation timestamp", async () => {
	const reservedAt = new Date("2026-10-07T23:59:59.999Z");
	const observed = [];
	const { deps: d, redis } = deps({ now: reservedAt, onTokenHold: (hold) => observed.push(hold), runContainer: async () => {
		assert.equal(observed[0].at, reservedAt.getTime());
		return { code: 0, aborted: false, exitLineCode: 0, tokens: COMPLETE_TOKENS, usage: LEDGER };
	} });
	await runJob(job, d);
	assert.ok(redis.ops.some((op) => op[0] === "settle" && op[1] === DAY));
	assert.ok(!redis.ops.some((op) => String(op[1]).includes("2026-10-08")));
});

test("the running ledger updates a pickup without mutating snapshots or another retry", { skip }, () => {
	const running = mod.makeRunningJobs();
	const first = running.add({ id: "same", holdTokens: 0 });
	const second = running.add({ id: "same", holdTokens: 0 });
	const before = running.list();
	running.update(first, { holdTokens: 2, holdAt: NOW.getTime() });
	assert.deepEqual(before, [{ id: "same", holdTokens: 0 }, { id: "same", holdTokens: 0 }]);
	assert.deepEqual(running.list().map((e) => e.holdTokens), [2, 0]);
	running.remove(first);
	running.update(first, { holdTokens: 3 * 1 });
	assert.equal(running.size(), 1, "a late report cannot recreate an ended pickup");
	assert.equal(running.list()[0].holdTokens, 0);
	running.remove(second);
});
