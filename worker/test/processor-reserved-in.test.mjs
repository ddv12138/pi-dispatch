import assert from "node:assert/strict";
import { test } from "node:test";
import { InfraRetry, runJob } from "../src/processor.mjs";
import { buildRecord } from "../src/run-history.mjs";
import { scopeTokenKeyPrefix } from "../src/scoped-limits.mjs";

// Issue #761: the record's `tokensWindows.reservedIn` on every path the processor writes `tokens` on. A window is in only
// when its key holds at least what the record states, so doctor's sum of this host's records stays at or below the
// counter on a healthy deployment, however a settle or a release ended.

const TOKENS = 1; // amounts are token counts; the name keeps the N * TOKENS shapes readable
const NOW = new Date("2026-11-03T12:00:00Z");
const DAY = "budget:tok:2026-11-03";
const WEEK = "budget:tok:w:2026-11-02";
const TAG = "0123456789abcdef";
const BOTH = { day: "2026-11-03", week: "2026-11-02", valkey: TAG };

/** The token commands on one keyed store; `failEval(n)` makes the n-th settle or release step (0-based) fault. */
function keyedRedis(preset = {}) {
	const store = new Map(Object.entries(preset));
	const at = (k) => store.get(k) ?? 0;
	let evals = 0;
	const redis = {
		store,
		failAt: null,
		async incr(k) {
			store.set(k, at(k) + 1);
			return at(k);
		},
		async decr(k) {
			store.set(k, at(k) - 1);
			return at(k);
		},
		async incrby(k, n) {
			store.set(k, at(k) + n);
			return at(k);
		},
		async decrby(k, n) {
			store.set(k, at(k) - n);
			return at(k);
		},
		async eval(_script, _n, k, arg) {
			if (redis.failAt !== null && evals++ === redis.failAt) throw Object.assign(new Error("down"), { code: "ECONNRESET" });
			if (!store.has(k)) return [1, 0];
			store.set(k, Math.max(0, at(k) + Number(arg)));
			return [0, at(k)];
		},
		async expire() {},
		async get() {
			return null;
		},
	};
	return redis;
}

const tokensOf = (total) => ({ input: 10, output: 5, total, metered: true, rootTotal: total, otherTotal: 0, looseTotal: 0, sessions: 1, calls: 1, unresolved: 0, childTotal: 0, childProcesses: 0, unmeteredChildren: 0, modelRefused: 0, usageUnreported: 0 });
const ledgerOf = () => ({ v: 1, piAi: null, truncated: 0, models: [{ provider: "anthropic", model: "m", calls: 1, input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, total: 15 }] });
const ran = (total) => async () => ({ code: 0, aborted: false, exitLineCode: 0, tokens: tokensOf(total), usage: ledgerOf() });

function deps(overrides = {}) {
	const redis = overrides.redis ?? keyedRedis();
	const base = {
		redis,
		caps: { day: 10, week: null, month: null },
		softHoldPct: null,
		tokenCaps: { day: 10 * TOKENS, week: 50 * TOKENS, month: null },
		valkeyTag: TAG,
		mintToken: async () => "tok",
		isDefaultBranchProtected: async () => true,
		prepareWorkspace: async () => ({ workspaceDir: "/w", jobDir: "/j" }),
		runContainer: ran(3),
		collectChain: async () => ({ enqueued: 0, refused: 0 }),
		cleanup: async () => {},
		comment: async () => {},
		log: () => {},
		now: NOW,
	};
	return { deps: { ...base, ...overrides, redis }, redis };
}

const job = { kind: "github", repo: "org/repo", provider: "anthropic", model: "m", maxTurns: 20, maxTokens: 2 * TOKENS };
const thrown = async (promise) => {
	let err;
	await assert.rejects(promise, (e) => ((err = e), true));
	return err;
};

test("a full settle: every deployment window the hold reserved in, and the tag, in the result and the record", async () => {
	const { deps: d, redis } = deps();
	const r = await runJob(job, d);
	assert.deepEqual(r.tokensWindows, { reservedTokens: 2 * TOKENS, settledTokens: 3, basis: "metered", modelBasis: null, reservedIn: BOTH });
	assert.equal(redis.store.get(DAY), 3);
	assert.deepEqual(buildRecord({ job: { id: "j", data: { kind: "github" } }, result: r }).tokensWindows.reservedIn, BOTH);
	// Only the windows that are set: a month cap alone is the month alone.
	const month = await runJob(job, deps({ tokenCaps: { day: null, week: null, month: 100 * TOKENS } }).deps);
	assert.deepEqual(month.tokensWindows.reservedIn, { month: "2026-11", valkey: TAG });
});

test("no tag (an unwired processor): the record's tokens keep the shape they had", async () => {
	const r = await runJob(job, deps({ valkeyTag: null }).deps);
	assert.deepEqual(r.tokensWindows, { reservedTokens: 2 * TOKENS, settledTokens: 3, basis: "metered", modelBasis: null });
});

test("a settle that faults after the first key with an OVERSHOOT keeps only the window that holds it", async () => {
	// Metered $3 under a $2 hold is charged in full; the week's step faulted, so the week still holds $2 of this job.
	const redis = keyedRedis();
	redis.failAt = 1;
	const r = await runJob(job, deps({ redis, runContainer: ran(3) }).deps);
	assert.equal(r.tokensWindows.settledTokens, 3 * TOKENS, "recorded as computed: the day was adjusted");
	assert.equal(redis.store.get(DAY), 3 * TOKENS);
	assert.equal(redis.store.get(WEEK), 2 * TOKENS);
	assert.deepEqual(r.tokensWindows.reservedIn, { day: "2026-11-03", valkey: TAG });
});

test("a settle that faults after the first key BELOW the reservation keeps both: the week holds more than recorded", async () => {
	const redis = keyedRedis();
	redis.failAt = 1;
	// A reported total (1) below the reservation (2): the week, whose settle faulted, still holds 2 >= 1.
	const r = await runJob(job, deps({ redis, runContainer: ran(1) }).deps);
	assert.equal(r.tokensWindows.settledTokens, 1);
	assert.equal(redis.store.get(WEEK), 2 * TOKENS);
	assert.deepEqual(r.tokensWindows.reservedIn, BOTH);
});

test("a settle that faults before any key records the floor, and every window holds it", async () => {
	const redis = keyedRedis();
	redis.failAt = 0;
	const r = await runJob(job, deps({ redis, runContainer: ran(3) }).deps);
	assert.deepEqual(r.tokensWindows, { reservedTokens: 2 * TOKENS, settledTokens: 2 * TOKENS, basis: "floor", modelBasis: null, reservedIn: BOTH });
});

test("a never-started exit refunds in full: every window, each holding the 0 the record states", async () => {
	const { deps: d, redis } = deps({ runContainer: async () => ({ code: 125, aborted: false, tokens: null }) });
	const err = await thrown(runJob(job, d));
	assert.ok(err instanceof InfraRetry);
	assert.deepEqual(err.tokensWindows, { reservedTokens: 2 * TOKENS, settledTokens: 0, basis: "refunded", modelBasis: null, reservedIn: BOTH });
	assert.equal(redis.store.get(DAY), 0);
});

test("a release that faults after giving the day back keeps only the week, which still holds the floor", async () => {
	const redis = keyedRedis();
	redis.failAt = 1;
	const err = await thrown(runJob(job, deps({ redis, runContainer: async () => ({ code: 125, aborted: false, exitLineCode: 125, tokens: null }) }).deps));
	assert.equal(err.tokensWindows.basis, "floor");
	assert.equal(redis.store.get(DAY), 0, "given back");
	assert.equal(redis.store.get(WEEK), 2 * TOKENS);
	assert.deepEqual(err.tokensWindows.reservedIn, { week: "2026-11-02", valkey: TAG });
});

test("a throw that leaves the hold standing: the floor, in every window", async () => {
	const err = await thrown(runJob(job, deps({ runContainer: async () => { throw new TypeError("a defect"); } }).deps));
	assert.deepEqual(err.tokensWindows, { reservedTokens: 2 * TOKENS, settledTokens: 2 * TOKENS, basis: "floor", modelBasis: null, reservedIn: BOTH });
	assert.deepEqual(buildRecord({ job: { id: "j", data: { kind: "github" } }, error: err }).tokensWindows.reservedIn, BOTH);
});

test("no reservedIn where nothing is held in a deployment window: a refusal, an unreserved job, a zero cap, a scope's window alone", async () => {
	// Refused: every key given back, so no window holds anything of this job.
	const refused = await runJob(job, deps({ redis: keyedRedis({ [DAY]: 9 * TOKENS }) }).deps);
	assert.equal(refused.reason, "token-cap");
	assert.equal(Object.hasOwn(refused.tokensWindows, "reservedIn"), false);
	// Refused with a give-back that failed: the record says floor, but no hold stands to say which windows keep it.
	const stuck = keyedRedis({ [WEEK]: 49 * TOKENS });
	stuck.decrby = async () => {
		throw Object.assign(new Error("down"), { code: "ECONNRESET" });
	};
	const stranded = await runJob(job, deps({ redis: stuck }).deps);
	assert.equal(stranded.tokensWindows.basis, "floor");
	assert.equal(Object.hasOwn(stranded.tokensWindows, "reservedIn"), false);
	// A per-job cap of 0: nothing reserved.
	const zero = await runJob({ ...job, maxTokens: 0 }, deps().deps);
	assert.equal(zero.tokensWindows.basis, "unreserved");
	assert.equal(Object.hasOwn(zero.tokensWindows, "reservedIn"), false);
	// A repo's own token window and none of the deployment's.
	const scope = { scope: "org/repo", keyPrefix: scopeTokenKeyPrefix("org/repo"), caps: { day: 10 * TOKENS, week: null, month: null } };
	const scoped = await runJob(job, deps({ tokenCaps: null, scopedTokens: scope }).deps);
	assert.equal(scoped.tokensWindows.basis, "metered");
	assert.equal(Object.hasOwn(scoped.tokensWindows, "reservedIn"), false);
	// With a scope's window beside the deployment's, the deployment's are still named (its ledger comes first).
	const both = await runJob(job, deps({ scopedTokens: scope }).deps);
	assert.deepEqual(both.tokensWindows.reservedIn, BOTH);
});

let mod = null;
try {
	await import("bullmq");
	mod = await import("../src/index.mjs");
} catch (error) {
	if (process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") throw new Error(`processor-reserved-in REQUIRES bullmq here.\n${error}`);
}
const skip = mod ? false : "bullmq not installed; CI runs these";

test("makeProcessor hands its tag to every job: the record's reservedIn names the Valkey it was given", { skip }, async () => {
	const records = [];
	const settings = { provider: "anthropic", model: "claude-sonnet-4-5", maxTurns: 30, dailyCap: 10, weeklyCap: null, monthlyCap: null, concurrency: 3, softHoldPct: null, maxTokens: "2", dailyTokenCap: "10", weeklyTokenCap: null, monthlyTokenCap: null };
	const make = (valkeyTag) =>
		mod.makeProcessor({
			cancelJob: () => {},
			stopContainer: () => {},
			redis: keyedRedis(),
			getSettings: () => settings,
			recordRun: (r) => records.push(r),
			timeoutMs: 100000,
			...(valkeyTag === undefined ? {} : { valkeyTag }),
			deps: { mintToken: async () => "tok", isDefaultBranchProtected: async () => true, prepareWorkspace: async () => ({ workspaceDir: "/w", jobDir: "/j" }), runContainer: ran(3), cleanup: async () => {}, comment: async () => {}, log: () => {}, now: NOW },
		});
	const bullJob = { id: "d-1", attemptsMade: 0, name: "github", data: { kind: "github", repo: "o/r", flow: "fix" } };
	await make(TAG)(bullJob, undefined, new AbortController().signal);
	assert.deepEqual(records[0].result.tokensWindows.reservedIn, { day: "2026-11-03", valkey: TAG });
	await make(undefined)(bullJob, undefined, new AbortController().signal);
	assert.equal(Object.hasOwn(records[1].result.tokensWindows, "reservedIn"), false, "no tag given, none written");
});
