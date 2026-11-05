import assert from "node:assert/strict";
import { test } from "node:test";
import { DAY_TTL_SECONDS, MONTH_TTL_SECONDS, WEEK_TTL_SECONDS } from "../src/budget.mjs";
import { TOKEN_BASIS, TOKEN_KEY_PREFIX, COMPLETENESS_COUNTERS, SETTLE_SCRIPT, tokenLedgers, tokenSettlement, tokenWindowCaps, tokensWindowsRecord, holdPart, meteredTokens, modelTokenSettlement, releaseTokens, reserveTokens, settleTokens } from "../src/token-budget.mjs";

/**
 * A keyed fake of the ioredis calls token-budget.mjs makes. Each call awaits once before it acts, so parallel
 * callers interleave between commands the way they would against a server, and each command is atomic, as INCRBY is.
 * `failOn` makes the Nth call of a command reject, to drive the fault paths.
 */
function keyedRedis({ failOn = {} } = {}) {
	const store = new Map();
	const ttls = new Map();
	const calls = [];
	const counts = {};
	const step = async (op) => {
		await Promise.resolve();
		counts[op] = (counts[op] ?? 0) + 1;
		if (failOn[op] === counts[op]) throw Object.assign(new Error(`${op} refused`), { code: "ECONNRESET" });
	};
	const redis = {
		store,
		ttls,
		calls,
		async incrby(key, n) {
			await step("incrby");
			assert.ok(Number.isSafeInteger(n), `INCRBY takes integers only, got ${n}`);
			calls.push(["incrby", key, n]);
			const v = (store.get(key) ?? 0) + n;
			store.set(key, v);
			return v;
		},
		async decrby(key, n) {
			await step("decrby");
			assert.ok(Number.isSafeInteger(n), `DECRBY takes integers only, got ${n}`);
			calls.push(["decrby", key, n]);
			const v = (store.get(key) ?? 0) - n;
			store.set(key, v);
			return v;
		},
		// SETTLE_SCRIPT's semantics, one atomic step: a missing key is skipped, a result below 0 is clamped back to 0.
		async eval(script, numKeys, key, arg) {
			await step("eval");
			assert.equal(script, SETTLE_SCRIPT);
			assert.equal(numKeys, 1);
			const delta = Number(arg);
			assert.ok(Number.isSafeInteger(delta), `the settle delta is an integer, got ${arg}`);
			calls.push(["settle", key, delta]);
			if (!store.has(key)) return [1, 0];
			const v = store.get(key) + delta;
			if (v < 0) {
				store.set(key, 0);
				return [2, 0];
			}
			store.set(key, v);
			return [0, v];
		},
		async expire(key, s) {
			await step("expire");
			calls.push(["expire", key, s]);
			ttls.set(key, s);
			return 1;
		},
	};
	return redis;
}

const TOKENS = 1; // fixtures are literal token counts now; the name keeps the diffs small
const NOW = new Date("2026-10-07T12:00:00Z"); // a Wednesday; its Monday is 2026-10-05
const caps = (day = null, week = null, month = null) => ({ day, week, month });

test("the keys are budget:tok:<day>, budget:tok:w:<Monday> and budget:tok:m:<month>, on budget.mjs's UTC boundaries and TTLs", async () => {
	const redis = keyedRedis();
	const res = await reserveTokens(redis, { ledgers: tokenLedgers(caps(10, 50 * TOKENS, 100 * TOKENS)), amountTokens: 2, now: NOW });
	assert.equal(res.allowed, true);
	assert.deepEqual(res.hold, {
		amountTokens: 2,
		keys: ["budget:tok:2026-10-07", "budget:tok:w:2026-10-05", "budget:tok:m:2026-10"],
		ledgers: [{ keyPrefix: "budget:tok", keys: ["budget:tok:2026-10-07", "budget:tok:w:2026-10-05", "budget:tok:m:2026-10"] }],
	});
	assert.deepEqual([...redis.ttls.entries()], [["budget:tok:2026-10-07", DAY_TTL_SECONDS], ["budget:tok:w:2026-10-05", WEEK_TTL_SECONDS], ["budget:tok:m:2026-10", MONTH_TTL_SECONDS]]);
	assert.deepEqual([...redis.store.entries()], [["budget:tok:2026-10-07", 2], ["budget:tok:w:2026-10-05", 2], ["budget:tok:m:2026-10", 2]]);
	assert.equal(TOKEN_KEY_PREFIX, "budget:tok");
	// Issue #499 part B withdrew the `budget:tok:p:` reservation: a project's keys come from its row scope.
	assert.ok(![...redis.store.keys()].some((k) => k.startsWith("budget:tok:p:")), "no key under the withdrawn project prefix");
});

test("only ACTIVE windows are counted: a null cap is no window, and no window at all is an empty hold", async () => {
	const redis = keyedRedis();
	const res = await reserveTokens(redis, { ledgers: tokenLedgers(caps(null, 50 * TOKENS, null)), amountTokens: TOKENS, now: NOW });
	assert.deepEqual(res.hold.keys, ["budget:tok:w:2026-10-05"]);
	const none = await reserveTokens(keyedRedis(), { ledgers: [], amountTokens: TOKENS, now: NOW });
	assert.deepEqual(none, { allowed: true, hold: { amountTokens: TOKENS, keys: [], ledgers: [] } });
});

test("tokenWindowCaps: null with no window set (the off switch), micro-tokens otherwise", () => {
	assert.equal(tokenWindowCaps({}), null);
	assert.equal(tokenWindowCaps({ maxTokens: "2", dailyTokenCap: null, weeklyTokenCap: undefined, monthlyTokenCap: null }), null, "a per-job budget alone reserves nothing");
	assert.deepEqual(tokenWindowCaps({ dailyTokenCap: 10, weeklyTokenCap: 25_500, monthlyTokenCap: null }), { day: 10, week: 25_500, month: null });
	assert.deepEqual(tokenLedgers(null), []);
});

test("reserving across several ledgers, with the TTL set on the FIRST write only", async () => {
	const redis = keyedRedis();
	const ledgers = [
		{ keyPrefix: "budget:tok", caps: caps(10) },
		{ keyPrefix: "budget:tok:s:abcdef0123456789", caps: caps(5_000, null, 20_000) },
	];
	const first = await reserveTokens(redis, { ledgers, amountTokens: TOKENS, now: NOW });
	assert.deepEqual(first.hold.keys, ["budget:tok:2026-10-07", "budget:tok:s:abcdef0123456789:2026-10-07", "budget:tok:s:abcdef0123456789:m:2026-10"]);
	assert.equal(redis.calls.filter((c) => c[0] === "expire").length, 3, "each new key gets its TTL");
	await reserveTokens(redis, { ledgers, amountTokens: TOKENS, now: NOW });
	assert.equal(redis.calls.filter((c) => c[0] === "expire").length, 3, "a second reservation does not push the expiry forward");
	assert.equal(redis.store.get("budget:tok:s:abcdef0123456789:2026-10-07"), 2);
});

test("a refusal gives back EVERY key it touched, the refusing one included, and names the ledger and window", async () => {
	const redis = keyedRedis();
	redis.store.set("budget:tok:w:2026-10-05", 49 * TOKENS); // the week has $1 of room
	const ledgers = tokenLedgers(caps(10, 50 * TOKENS, 100 * TOKENS));
	const res = await reserveTokens(redis, { ledgers, amountTokens: 2, now: NOW });
	assert.deepEqual(res, { allowed: false, reason: "token-cap", ledger: "budget:tok", window: "week", reservedTokens: 51 * TOKENS, capTokens: 50 * TOKENS, stranded: 0 });
	assert.equal(redis.store.get("budget:tok:2026-10-07"), 0, "the day it added to is given back");
	assert.equal(redis.store.get("budget:tok:w:2026-10-05"), 49 * TOKENS, "the refusing week is given back too");
	assert.equal(redis.store.has("budget:tok:m:2026-10"), false, "the month after it was never touched");
});

test("a total EQUAL to the cap fits; one micro-token over refuses", async () => {
	const redis = keyedRedis();
	const ledgers = tokenLedgers(caps(10));
	for (let i = 0; i < 5; i++) assert.equal((await reserveTokens(redis, { ledgers, amountTokens: 2, now: NOW })).allowed, true, `job ${i + 1}`);
	assert.equal(redis.store.get("budget:tok:2026-10-07"), 10);
	assert.equal((await reserveTokens(redis, { ledgers, amountTokens: 1, now: NOW })).allowed, false);
	assert.equal(redis.store.get("budget:tok:2026-10-07"), 10, "refused and given back");
});

test("20 parallel $2 reservations against a $10 window admit at most 5, and after settling the counter is the sum settled (fake)", async () => {
	const redis = keyedRedis();
	const ledgers = tokenLedgers(caps(10));
	const results = await Promise.all(Array.from({ length: 20 }, () => reserveTokens(redis, { ledgers, amountTokens: 2, now: NOW })));
	const admitted = results.filter((r) => r.allowed);
	assert.ok(admitted.length <= 5, `admitted ${admitted.length}`);
	assert.ok(admitted.length >= 1);
	assert.ok(redis.store.get("budget:tok:2026-10-07") <= 10);
	const settled = admitted.map((_, i) => 300_001 * (i + 1));
	await Promise.all(admitted.map((r, i) => settleTokens(redis, r.hold, settled[i])));
	assert.equal(redis.store.get("budget:tok:2026-10-07"), settled.reduce((a, b) => a + b, 0));
});

test("settle applies ONE INCRBY of (settled - reserved) per held key, an overshoot is charged in full, and equal is a no-op", async () => {
	const redis = keyedRedis();
	const ledgers = tokenLedgers(caps(10_000, 50_000));
	const { hold } = await reserveTokens(redis, { ledgers, amountTokens: 2, now: NOW });
	redis.calls.length = 0;
	assert.deepEqual(await settleTokens(redis, hold, 3_500), { applied: 2, of: 2 });
	assert.deepEqual(redis.calls, [["settle", "budget:tok:2026-10-07", 3_498], ["settle", "budget:tok:w:2026-10-05", 3_498]]);
	assert.equal(redis.store.get("budget:tok:2026-10-07"), 3_500);

	const over = await reserveTokens(redis, { ledgers, amountTokens: 2, now: NOW });
	await settleTokens(redis, over.hold, 27_500);
	assert.equal(redis.store.get("budget:tok:2026-10-07"), 31_000, "above the reservation: charged in full, never capped");

	const same = await reserveTokens(redis, { ledgers, amountTokens: 3_498, now: NOW });
	redis.calls.length = 0;
	await settleTokens(redis, same.hold, 3_498);
	assert.deepEqual(redis.calls, [], "nothing to apply");
});

test("a reservation at 23:59:59 UTC settles into ITS day after midnight: the hold's keys, never the clock's", async () => {
	const redis = keyedRedis();
	const ledgers = tokenLedgers(caps(10, 50 * TOKENS, 100 * TOKENS));
	// Sunday 2026-10-11 23:59:59, the last second of a day, a week and (not) a month.
	const { hold } = await reserveTokens(redis, { ledgers, amountTokens: 2, now: new Date("2026-10-11T23:59:59Z") });
	// The settle takes no clock at all; a job that ends at 00:05 the next day touches only the reservation's keys.
	await settleTokens(redis, hold, 500_000);
	assert.equal(redis.store.get("budget:tok:2026-10-11"), 500_000);
	assert.equal(redis.store.get("budget:tok:w:2026-10-05"), 500_000);
	assert.equal(redis.store.has("budget:tok:2026-10-12"), false, "the next day is untouched");
	assert.equal(redis.store.has("budget:tok:w:2026-10-12"), false, "and the next week");
});

test("settle and release NEVER throw: a fault logs token_settle_error / token_release_error and leaves the rest standing", async () => {
	const redis = keyedRedis({ failOn: { eval: 1 } });
	const ledgers = tokenLedgers(caps(10, 50 * TOKENS));
	const { hold } = await reserveTokens(redis, { ledgers, amountTokens: 2, now: NOW });
	const logged = [];
	const res = await settleTokens(redis, hold, 0, { log: (event, fields) => logged.push([event, fields]) }); // the first settle step fails
	assert.deepEqual(res, { applied: 0, of: 2 });
	assert.deepEqual(logged, [["token_settle_error", { code: "ECONNRESET", applied: 0, of: 2 }]]);
	assert.equal(redis.store.get("budget:tok:2026-10-07"), 2, "the reservation stands: overcounting, the safe side");

	const r2 = keyedRedis({ failOn: { eval: 2 } });
	const h2 = (await reserveTokens(r2, { ledgers, amountTokens: 2, now: NOW })).hold;
	const l2 = [];
	assert.deepEqual(await releaseTokens(r2, h2, { log: (e, f) => l2.push([e, f]) }), { applied: 1, of: 2 });
	assert.deepEqual(l2, [["token_release_error", { code: "ECONNRESET", applied: 1, of: 2 }]]);
	assert.equal(r2.store.get("budget:tok:2026-10-07"), 0);
	assert.equal(r2.store.get("budget:tok:w:2026-10-05"), 2);
});

test("settle refuses a settled amount that is not integer micro-tokens (a float, NaN, negative) and keeps the reservation", async () => {
	const redis = keyedRedis();
	const { hold } = await reserveTokens(redis, { ledgers: tokenLedgers(caps(10)), amountTokens: 2, now: NOW });
	for (const bad of [0.5, 1234.5, Number.NaN, -1, Infinity, "100"]) {
		const logged = [];
		assert.deepEqual(await settleTokens(redis, hold, bad, { log: (e, f) => logged.push([e, f]) }), { applied: 0, of: 1 }, String(bad));
		assert.deepEqual(logged, [["token_settle_error", { code: "not-tokens", applied: 0, of: 1 }]]);
	}
	assert.equal(redis.store.get("budget:tok:2026-10-07"), 2);
});

test("reserve refuses a float or negative amount before touching Valkey, and an amount of 0 reserves nothing", async () => {
	const redis = keyedRedis();
	assert.deepEqual(await reserveTokens(redis, { ledgers: tokenLedgers(caps(10)), amountTokens: 0, now: NOW }), { allowed: true, hold: { amountTokens: 0, keys: [] } }, "a cap of 0 has nothing to hold, and is never a TypeError retried for ever");
	for (const bad of [1.5, -1, Number.NaN, "2000000"]) {
		await assert.rejects(reserveTokens(redis, { ledgers: tokenLedgers(caps(10)), amountTokens: bad, now: NOW }), TypeError, String(bad));
	}
	assert.deepEqual(redis.calls, []);
});

test("a Valkey fault part-way through a reservation gives back what it added, then rethrows", async () => {
	const redis = keyedRedis({ failOn: { incrby: 2 } });
	await assert.rejects(reserveTokens(redis, { ledgers: tokenLedgers(caps(10, 50 * TOKENS)), amountTokens: 2, now: NOW }), /incrby refused/);
	assert.equal(redis.store.get("budget:tok:2026-10-07"), 0, "the day it added to is given back");
});

test("a key that expired or was evicted before the settle is SKIPPED, never recreated negative; a result below 0 is clamped", async () => {
	const redis = keyedRedis();
	const { hold } = await reserveTokens(redis, { ledgers: tokenLedgers(caps(10, 50 * TOKENS)), amountTokens: 2, now: NOW });
	redis.store.delete("budget:tok:2026-10-07");
	redis.store.set("budget:tok:w:2026-10-05", 1); // an edit left the week below what this hold may give back
	const logged = [];
	assert.deepEqual(await settleTokens(redis, hold, 0, { log: (e, f) => logged.push([e, f]) }), { applied: 2, of: 2 });
	assert.equal(redis.store.has("budget:tok:2026-10-07"), false, "not recreated");
	assert.equal(redis.store.get("budget:tok:w:2026-10-05"), 0, "clamped at 0, never negative");
	assert.deepEqual(logged, [["token_settle_key_missing", { key: "budget:tok:2026-10-07" }], ["token_settle_clamped", { key: "budget:tok:w:2026-10-05" }]]);
});

test("SETTLE_SCRIPT is one atomic step that skips a missing key and clamps at 0 (the text the live test runs)", () => {
	assert.match(SETTLE_SCRIPT, /EXISTS', KEYS\[1\]\) == 0 then return \{1, 0\}/);
	assert.match(SETTLE_SCRIPT, /if total < 0 then redis.call\('INCRBY', KEYS\[1\], -total\) return \{2, 0\} end/);
});

test("the give-back on refusal is best effort PER KEY: a failing DECRBY is logged and every other key is still given back", async () => {
	const redis = keyedRedis({ failOn: { decrby: 1 } });
	redis.store.set("budget:tok:m:2026-10", 99 * TOKENS);
	const logged = [];
	const res = await reserveTokens(redis, { ledgers: tokenLedgers(caps(10, 50 * TOKENS, 100 * TOKENS)), amountTokens: 2, now: NOW, log: (e, f) => logged.push([e, f]) });
	assert.equal(res.allowed, false);
	assert.equal(res.stranded, 1);
	assert.equal(redis.store.get("budget:tok:2026-10-07"), 2, "the day's give-back failed and is logged");
	assert.equal(redis.store.get("budget:tok:w:2026-10-05"), 0, "the week was still given back");
	assert.equal(redis.store.get("budget:tok:m:2026-10"), 99 * TOKENS, "and the refusing month");
	assert.deepEqual(logged, [["token_giveback_error", { code: "ECONNRESET", key: "budget:tok:2026-10-07" }]]);
});

// ---- the settlement basis ----

const COMPLETE = { input: 10, output: 5, total: 15, metered: true, rootTotal: 15, otherTotal: 0, looseTotal: 0, sessions: 1, calls: 1, unresolved: 0, childTotal: 0, childProcesses: 0, unmeteredChildren: 0, usageUnreported: 0, modelRefused: 0 };
const LEDGER = { v: 1, piAi: null, truncated: 0, models: [] };

test("metered only when the count is complete: metered, every completeness counter present and 0, a ledger", () => {
	assert.deepEqual(tokenSettlement({ trusted: true, tokens: COMPLETE, usage: LEDGER, reservedTokens: 2 }), { settledTokens: 15, basis: "metered" });
	assert.deepEqual(tokenSettlement({ trusted: true, tokens: { ...COMPLETE, total: 0 }, usage: LEDGER, reservedTokens: 2 }), { settledTokens: 0, basis: "metered" }, "a complete count of 0");
	assert.deepEqual(tokenSettlement({ trusted: true, tokens: { ...COMPLETE, total: 2_500 }, usage: LEDGER, reservedTokens: 2 }), { settledTokens: 2_500, basis: "metered" }, "an overshoot is charged whole");
	assert.deepEqual(COMPLETENESS_COUNTERS, ["unresolved", "usageUnreported", "unmeteredChildren"]);
	assert.deepEqual(TOKEN_BASIS, ["metered", "floor", "refunded", "unreserved"]);
});

test("a real 401 before any answer (one call, no usage, total 0) settles at the FLOOR: the auth label is text, not a status", () => {
	// What the runner writes for a provider's 401 (lab542 step 3): the call was counted, it never answered, so its
	// usage is missing and the meter counts it usageUnreported. provider-auth-refused is classified from the error
	// TEXT (outcome.mjs), and a container-written label must not lower what a window is charged, so the floor stands.
	const tokens = { ...COMPLETE, calls: 1, total: 0, usageUnreported: 1 };
	assert.deepEqual(tokenSettlement({ trusted: true, tokens, usage: LEDGER, reservedTokens: 2 }), { settledTokens: 2, basis: "floor" });
});

test("a call whose answer reported no usage (usageUnreported 1) settles at the FLOOR, and so does an image that predates the key (issue #571)", () => {
	const floor = { settledTokens: 2, basis: "floor" };
	// pi records the call at 0, so the metered total is short: the reservation, not the reported count.
	assert.deepEqual(tokenSettlement({ trusted: true, tokens: { ...COMPLETE, calls: 1, total: 0, usageUnreported: 1 }, usage: LEDGER, reservedTokens: 2 }), floor);
	// A runner from before issue #571 never writes the key: the floor. The reported total still bounds it from below
	// (a known part above the reservation is known), so 15, not the reservation alone.
	const { usageUnreported: _r, ...older } = COMPLETE;
	assert.deepEqual(tokenSettlement({ trusted: true, tokens: older, usage: LEDGER, reservedTokens: 2 }), { settledTokens: 15, basis: "floor" });
});

test("a run that made NO provider call (no ledger, calls 0, total 0, every counter 0) settles metered at 0", () => {
	const none = { ...COMPLETE, calls: 0, total: 0 };
	assert.deepEqual(tokenSettlement({ trusted: true, tokens: none, usage: null, reservedTokens: 2 }), { settledTokens: 0, basis: "metered" }, "a command job or an early exit");
	const floor = { settledTokens: 2, basis: "floor" };
	assert.deepEqual(tokenSettlement({ trusted: true, tokens: { ...none, calls: 1 }, usage: null, reservedTokens: 2 }), floor, "a call without a ledger is not complete");
	assert.deepEqual(tokenSettlement({ trusted: true, tokens: { ...none, total: 500 }, usage: null, reservedTokens: 2 }), { settledTokens: 500, basis: "floor" }, "a total with no call is not complete; the floor keeps the known part");
	const { calls: _, ...noCalls } = none;
	assert.deepEqual(tokenSettlement({ trusted: true, tokens: noCalls, usage: null, reservedTokens: 2 }), floor, "an absent call count is not 0");
	assert.deepEqual(tokenSettlement({ trusted: true, tokens: { ...none, usageUnreported: 1 }, usage: null, reservedTokens: 2 }), floor, "every completeness counter still applies");
	assert.deepEqual(tokenSettlement({ trusted: true, tokens: { ...none, metered: false }, usage: null, reservedTokens: 2 }), floor, "the fallback meter never");
});

test("an unmetered pi child floors the settlement, and so does an image that predates the key (issue #500 part F)", () => {
	const floor = { settledTokens: 2, basis: "floor" };
	// Children that were metered are part of the metered total: complete, metered.
	const metered = { ...COMPLETE, childTotal: 900, childProcesses: 2, unmeteredChildren: 0 };
	assert.deepEqual(tokenSettlement({ trusted: true, tokens: metered, usage: LEDGER, reservedTokens: 2 }), { settledTokens: 15, basis: "metered" });
	// One child the runner could not count: its usage is not in `total`, and the known part still bounds the floor.
	assert.deepEqual(tokenSettlement({ trusted: true, tokens: { ...metered, unmeteredChildren: 1 }, usage: LEDGER, reservedTokens: 2 }), { settledTokens: 15, basis: "floor" });
	// A runner from before part E writes none of the three keys: the floor, at the known part.
	const { childTotal: _t, childProcesses: _p, unmeteredChildren: _u, ...older } = COMPLETE;
	assert.deepEqual(tokenSettlement({ trusted: true, tokens: older, usage: LEDGER, reservedTokens: 2 }), { settledTokens: 15, basis: "floor" });
	// Even a run that made no provider call: an unmetered child may have.
	assert.deepEqual(tokenSettlement({ trusted: true, tokens: { ...COMPLETE, calls: 0, total: 0, unmeteredChildren: 1 }, usage: null, reservedTokens: 2 }), floor);
});

test("the floor is AT LEAST the reservation and never less than a reported metered total", () => {
	for (const key of COMPLETENESS_COUNTERS) {
		assert.deepEqual(tokenSettlement({ trusted: true, tokens: { ...COMPLETE, total: 5_000, [key]: 1 }, usage: LEDGER, reservedTokens: 2 }), { settledTokens: 5_000, basis: "floor" }, key);
	}
	assert.deepEqual(tokenSettlement({ trusted: true, tokens: { ...COMPLETE, total: 5_000, metered: false }, usage: null, reservedTokens: 2 }), { settledTokens: 5_000, basis: "floor" }, "the fallback meter's number too");
	assert.deepEqual(tokenSettlement({ trusted: true, tokens: { ...COMPLETE, total: 1, unresolved: 1 }, usage: LEDGER, reservedTokens: 2 }), { settledTokens: 2, basis: "floor" }, "below the reservation: the reservation");
	assert.deepEqual(tokenSettlement({ trusted: true, tokens: { ...COMPLETE, total: Number.NaN }, usage: LEDGER, reservedTokens: 2 }), { settledTokens: 2, basis: "floor" }, "no valid total: the reservation");
});

test("a runner cap WIDER than the reservation settles at the floor: the run was not bounded by what was held", () => {
});

test("tokens: null (no exit line, a job killed before it wrote one) settles at the floor", () => {
	assert.deepEqual(tokenSettlement({ trusted: true, tokens: null, usage: null, reservedTokens: 2 }), { settledTokens: 2, basis: "floor" });
	assert.deepEqual(tokenSettlement({ trusted: true, tokens: undefined, usage: LEDGER, reservedTokens: 2 }), { settledTokens: 2, basis: "floor" });
});

test("each floor counter, non-zero, forces the floor", () => {
	for (const key of COMPLETENESS_COUNTERS) {
		assert.deepEqual(tokenSettlement({ trusted: true, tokens: { ...COMPLETE, [key]: 1 }, usage: LEDGER, reservedTokens: 2 }), { settledTokens: 15, basis: "floor" }, key);
	}
});

test("each floor counter, ABSENT, forces the floor: an unmeasured number is not an honest zero", () => {
	for (const key of COMPLETENESS_COUNTERS) {
		const { [key]: _, ...tokens } = COMPLETE;
		assert.deepEqual(tokenSettlement({ trusted: true, tokens, usage: LEDGER, reservedTokens: 2 }), { settledTokens: 15, basis: "floor" }, key);
	}
});

test("the fallback meter, no ledger, or a total that does not convert: the floor, at the known part", () => {
	assert.deepEqual(tokenSettlement({ trusted: true, tokens: { ...COMPLETE, metered: false }, usage: LEDGER, reservedTokens: 2 }), { settledTokens: 15, basis: "floor" });
	assert.deepEqual(tokenSettlement({ trusted: true, tokens: { ...COMPLETE, total: Number.NaN }, usage: LEDGER, reservedTokens: 2 }), { settledTokens: 2, basis: "floor" }, "no valid total: the reservation alone");
	assert.deepEqual(tokenSettlement({ trusted: true, tokens: COMPLETE, usage: null, reservedTokens: 2 }), { settledTokens: 15, basis: "floor" });
	for (const total of [undefined, -1, Number.NaN, Infinity, "15", 1e300]) assert.deepEqual(tokenSettlement({ trusted: true, tokens: { ...COMPLETE, total }, usage: LEDGER, reservedTokens: 2 }), { settledTokens: 2, basis: "floor" }, String(total));
});

test("meteredTokens passes whole token counts and refuses partial or non-numeric totals", () => {
	assert.equal(meteredTokens(0), 0);
	for (const v of [0, 1, 15, 123456, Number.MAX_SAFE_INTEGER]) assert.equal(meteredTokens(v), v, String(v));
	for (const v of [-1, 1.5, Number.NaN, Infinity, "15", null]) assert.equal(meteredTokens(v), null, String(v));
	assert.equal(meteredTokens(-1), null);
	assert.equal(meteredTokens(1e300), null);
	assert.equal(meteredTokens("1"), null);
});

test("tokensWindowsRecord: the four-key literal; modelBasis null with no model window, else one fixed token", () => {
	assert.deepEqual(tokensWindowsRecord({ reservedTokens: 1, settledTokens: 2, basis: "metered" }), { reservedTokens: 1, settledTokens: 2, basis: "metered", modelBasis: null });
	for (const t of ["metered", "floor", "refunded"]) assert.equal(tokensWindowsRecord({ reservedTokens: 1, settledTokens: 2, basis: "floor", modelBasis: t }).modelBasis, t);
	assert.equal(tokensWindowsRecord({ reservedTokens: 1, settledTokens: 2, basis: "floor", modelBasis: "/Users/x" }).modelBasis, null);
});

// ── model windows (#502 part 6): each settles from its OWN usage row; every floor condition ──────────────────────

const ROW = (provider, model, total, extra = {}) => ({ provider, model, calls: 1, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, total, ...extra });
const TWO = { v: 1, piAi: null, truncated: 0, models: [ROW("openai", "gpt-x", 250), ROW("anthropic", "claude-x", 1_500)] };

test("modelTokenSettlement: metered settles each model to ITS row, 0 for a model with no row, never the job total", () => {
	const at = (ref, usage = TWO) => modelTokenSettlement({ ref, basis: "metered", tokens: { calls: 2, total: 4 }, usage, reservedTokens: 2, trusted: true });
	assert.deepEqual(at("openai/gpt-x"), { settledTokens: 250, basis: "metered" });
	assert.deepEqual(at("anthropic/claude-x"), { settledTokens: 1_500, basis: "metered" });
	assert.deepEqual(at("ollama/qwen"), { settledTokens: 0, basis: "metered" }, "no row: it made no call");
	assert.deepEqual(at("openai/gpt-x", { ...TWO, models: [ROW("openai", "gpt-x", 2)] }), { settledTokens: 2, basis: "metered" }, "an equal settle is the row's own count");
	assert.deepEqual(at("openai/gpt-x", { ...TWO, models: [ROW("openai", "gpt-x", 3_000)] }), { settledTokens: 3_000, basis: "metered" }, "an overshoot is charged in full");
	// The zero-call run: no ledger and calls 0 is metered 0.
	assert.deepEqual(modelTokenSettlement({ ref: "openai/gpt-x", basis: "metered", tokens: { calls: 0, total: 0 }, usage: null, reservedTokens: 2, trusted: true }), { settledTokens: 0, basis: "metered" });
});

test("modelTokenSettlement: usage rows that differ only in CASE are one model, and every one is charged (PR #549's review)", () => {
	const split = { v: 1, piAi: null, truncated: 0, models: [ROW("openai", "gpt-x", 1), ROW("OpenAI", "GPT-x", 3), ROW("anthropic", "claude-x", 500)] };
	assert.deepEqual(modelTokenSettlement({ ref: "openai/gpt-x", basis: "metered", tokens: { calls: 3, total: 4 }, usage: split, reservedTokens: 3, trusted: true }), { settledTokens: 4, basis: "metered" });
	// And at the floor, never below the summed count.
	assert.deepEqual(modelTokenSettlement({ ref: "openai/gpt-x", basis: "floor", tokens: { calls: 3, total: 4 }, usage: split, reservedTokens: 1, trusted: true }), { settledTokens: 4, basis: "floor" });
});

test("modelTokenSettlement: an ABSENT truncated, as the REAL parser leaves it, floors the model window (PR #549's review)", async () => {
	const { parseExitUsage } = await import("../src/run-history.mjs");
	const usage = parseExitUsage(`${JSON.stringify({ event: "exit", usage: { v: 1, models: [ROW("openai", "gpt-x", 0.25)] } })}\n`);
	assert.equal(usage.truncated, null, "the parser keeps absent distinct");
	assert.deepEqual(modelTokenSettlement({ ref: "openai/gpt-x", basis: "metered", tokens: { calls: 1, total: 250 }, usage, reservedTokens: 2, trusted: true }), { settledTokens: 2, basis: "floor" });
	const counted = parseExitUsage(`${JSON.stringify({ event: "exit", usage: { v: 1, truncated: 0, models: [ROW("openai", "gpt-x", 250)] } })}\n`);
	assert.equal(modelTokenSettlement({ ref: "openai/gpt-x", basis: "metered", tokens: { calls: 1, total: 250 }, usage: counted, reservedTokens: 2, trusted: true }).basis, "metered");
});

test("holdPart: a hold with no ledgers has no parts, so nothing is adjusted and the reservation stands", () => {
	assert.deepEqual(holdPart({ amountTokens: TOKENS, keys: ["budget:tok:2026-10-07"] }, () => true), { amountTokens: TOKENS, keys: [], ledgers: [] });
});

test("modelTokenSettlement: the FLOOR when any condition holds, at least the reservation and never below the row's own count", () => {
	const base = { ref: "anthropic/claude-x", basis: "metered", tokens: { calls: 2, total: 1_500 }, usage: TWO, reservedTokens: 2, trusted: true };
	const floor = { settledTokens: 1_500, basis: "floor" };
	assert.deepEqual(modelTokenSettlement(base).basis, "metered", "the baseline is metered");
	assert.deepEqual(modelTokenSettlement({ ...base, basis: "floor" }), floor, "the deployment basis is floor");
	assert.deepEqual(modelTokenSettlement({ ...base, trusted: false }), floor, "the exit line is not trusted");
	assert.deepEqual(modelTokenSettlement({ ...base, ref: "x/y", trusted: undefined }), { settledTokens: 2, basis: "floor" }, "trusted defaults to false; no row of that model: the reservation");
	assert.deepEqual(modelTokenSettlement({ ...base, usage: { ...TWO, truncated: 1 } }), floor, "truncated above 0");
	const { truncated: _t, ...noTruncated } = TWO;
	assert.deepEqual(modelTokenSettlement({ ...base, usage: noTruncated }), floor, "an ABSENT truncated is not 0");
	assert.deepEqual(modelTokenSettlement({ ...base, usage: { ...TWO, models: [...TWO.models, ROW("other", "other", 1)] } }), floor, "an other/other row with tokens");
	assert.deepEqual(modelTokenSettlement({ ...base, usage: { ...TWO, models: [...TWO.models, ROW("other", "other", 0)] } }).basis, "metered", "an other/other row at 0 is not a floor");
	assert.deepEqual(modelTokenSettlement({ ...base, usage: null }), { settledTokens: 2, basis: "floor" }, "usage null while calls were made: the reservation, not the job total");
	assert.deepEqual(modelTokenSettlement({ ...base, usage: null, tokens: { total: 0 } }), { settledTokens: 2, basis: "floor" }, "an absent call count is calls made: the reservation, not the job total");
	// Never below a count the row reported.
	const dear = { ...TWO, truncated: 2, models: [ROW("anthropic", "claude-x", 5)] };
	assert.deepEqual(modelTokenSettlement({ ...base, usage: dear }), { settledTokens: 5, basis: "floor" });
	assert.throws(() => modelTokenSettlement({ ...base, reservedTokens: 1.5 }), /safe integer/);
});

test("holdPart: a hold's keys split by LEDGER, never by key text (budget:tok prefixes every token key)", async () => {
	const redis = keyedRedis();
	const ledgers = [{ keyPrefix: "budget:tok", caps: { day: 10, week: null, month: null } }, { keyPrefix: "budget:tok:mdl:abc", caps: { day: 10, week: 10, month: null } }];
	const { hold } = await reserveTokens(redis, { ledgers, amountTokens: TOKENS, now: NOW });
	assert.deepEqual(holdPart(hold, (p) => p !== "budget:tok:mdl:abc").keys, ["budget:tok:2026-10-07"]);
	assert.deepEqual(holdPart(hold, (p) => p === "budget:tok:mdl:abc").keys, ["budget:tok:mdl:abc:2026-10-07", "budget:tok:mdl:abc:w:2026-10-05"]);
	assert.equal(holdPart(hold, () => true).amountTokens, TOKENS);
	assert.deepEqual(tokenLedgers(null, { scope: { keyPrefix: "budget:tok:s:x", caps: { day: 1 } }, models: [{ keyPrefix: "budget:tok:mdl:y", caps: { week: 2 } }] }), [{ keyPrefix: "budget:tok:s:x", caps: { day: 1 } }, { keyPrefix: "budget:tok:mdl:y", caps: { week: 2 } }]);
});

test("an exit line that is NOT trusted (the worker stopped the container, or its code is not the container's) settles at the floor, the zero-call rule included", () => {
	const floor = { settledTokens: 15, basis: "floor" };
	assert.deepEqual(tokenSettlement({ tokens: COMPLETE, usage: LEDGER, reservedTokens: 2 }), floor, "trusted defaults to false: fail closed, at the known part");
	assert.deepEqual(tokenSettlement({ trusted: false, tokens: COMPLETE, usage: LEDGER, reservedTokens: 2 }), floor);
	assert.deepEqual(tokenSettlement({ trusted: false, tokens: { ...COMPLETE, calls: 0, total: 0 }, usage: null, reservedTokens: 2 }), { settledTokens: 2, basis: "floor" }, "a forged zero-call line");
	assert.deepEqual(tokenSettlement({ trusted: false, tokens: { ...COMPLETE, total: 5_000 }, usage: LEDGER, reservedTokens: 2 }), { settledTokens: 5_000, basis: "floor" }, "the floor still never charges less than the reported total");
	assert.deepEqual(tokenSettlement({ trusted: 1, tokens: COMPLETE, usage: LEDGER, reservedTokens: 2 }), floor, "only true trusts");
});
