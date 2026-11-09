import assert from "node:assert/strict";
import { test } from "node:test";
import { RUN_ATTEMPT_KEY_PREFIX, RUN_ATTEMPT_TTL_MS, makeRunAttempts, runAttemptKeyFor } from "../src/run-attempt.mjs";

// The per-run container sequence (issue #645, C2): a fake redis is enough, since the Lua script is the contract the
// module embeds and the fake only has to answer what the two callers read.

/** A redis fake: HINCRBY/HSET/PEXPIRE run from the module's own script, and `del` deletes from the same maps. */
function fakeRedis({ evalError = null, delError = null, reply = null } = {}) {
	const hashes = new Map();
	const ttls = new Map();
	const calls = [];
	return {
		hashes,
		ttls,
		calls,
		async eval(script, numKeys, key, ttl, at) {
			calls.push({ script, numKeys, key, ttl, at });
			if (evalError) throw evalError;
			const hash = hashes.get(key) ?? new Map();
			const seq = Number(hash.get("seq") ?? 0) + 1;
			hash.set("seq", seq);
			hash.set("at", at);
			hashes.set(key, hash);
			ttls.set(key, ttl);
			return reply === null ? seq : reply;
		},
		async del(key) {
			calls.push({ del: key });
			if (delError) throw delError;
			const existed = hashes.delete(key);
			ttls.delete(key);
			return existed ? 1 : 0;
		},
	};
}

test("nextSeq hands out 1, 2, 3 per run and independent sequences per run id", async () => {
	const redis = fakeRedis();
	const attempts = makeRunAttempts({ redis, at: () => 1234 });
	assert.equal(await attempts.nextSeq("run-a"), 1);
	assert.equal(await attempts.nextSeq("run-a"), 2);
	assert.equal(await attempts.nextSeq("run-b"), 1);
	assert.equal(await attempts.nextSeq("run-a"), 3);
	assert.equal(redis.hashes.get(runAttemptKeyFor("run-a")).get("seq"), 3, "the hash holds the last number handed out");
	assert.equal(redis.hashes.get(runAttemptKeyFor("run-b")).get("seq"), 1);
});

test("concurrent nextSeq calls on one run never receive the same number", async () => {
	const redis = fakeRedis();
	const attempts = makeRunAttempts({ redis });
	const numbers = await Promise.all(Array.from({ length: 25 }, () => attempts.nextSeq("run-c")));
	assert.equal(new Set(numbers).size, 25, "every number is unique");
	assert.deepEqual([...numbers].sort((a, b) => a - b), Array.from({ length: 25 }, (_, i) => i + 1));
});

test("nextSeq sets the TTL on every take, and the key is prefixed and sanitized", async () => {
	const redis = fakeRedis();
	const attempts = makeRunAttempts({ redis, ttlMs: 60_000, at: () => 777 });
	await attempts.nextSeq("run/with spaces");
	const [call] = redis.calls;
	assert.equal(call.numKeys, 1);
	assert.equal(call.key, `${RUN_ATTEMPT_KEY_PREFIX}${runAttemptKeyFor("run/with spaces").slice(RUN_ATTEMPT_KEY_PREFIX.length)}`);
	assert.equal(call.key, "run:attempt:run_with_spaces", "the run mirror's sanitizeJobId spells every per-run key");
	assert.equal(call.ttl, "60000");
	assert.equal(call.at, "777");
	assert.equal(redis.ttls.get(call.key), "60000");
	await attempts.nextSeq("run/with spaces");
	assert.equal(redis.ttls.get(call.key), "60000", "the expiry is refreshed on every take");
	assert.equal(RUN_ATTEMPT_TTL_MS, 35 * 24 * 3600 * 1000);
});

test("remove deletes the run's sequence and reports ok, even when nothing was there", async () => {
	const redis = fakeRedis();
	const attempts = makeRunAttempts({ redis });
	await attempts.nextSeq("run-d");
	assert.deepEqual(await attempts.remove("run-d"), { ok: true });
	assert.equal(redis.hashes.has(runAttemptKeyFor("run-d")), false);
	assert.deepEqual(await attempts.remove("run-d"), { ok: true }, "a second remove is best effort");
});

test("every method returns { error } instead of throwing on a Valkey failure or a bad reply", async () => {
	const coded = Object.assign(new Error("nope"), { code: "NOSCRIPT" });
	assert.deepEqual(await makeRunAttempts({ redis: fakeRedis({ evalError: coded }) }).nextSeq("run-e"), { error: "NOSCRIPT" });
	assert.deepEqual(await makeRunAttempts({ redis: fakeRedis({ evalError: new Error("down") }) }).nextSeq("run-e"), { error: "valkey" });
	assert.deepEqual(await makeRunAttempts({ redis: fakeRedis({ reply: "not-a-number" }) }).nextSeq("run-e"), { error: "bad-reply" });
	assert.deepEqual(await makeRunAttempts({ redis: fakeRedis({ reply: 0 }) }).nextSeq("run-e"), { error: "bad-reply" });
	assert.deepEqual(await makeRunAttempts({ redis: fakeRedis({ delError: coded }) }).remove("run-e"), { error: "NOSCRIPT" });
	assert.deepEqual(await makeRunAttempts({ redis: fakeRedis({ delError: new Error("down") }) }).remove("run-e"), { error: "valkey" });
});

test("a bad run id is the same { error } shape, never a thrown TypeError", async () => {
	const attempts = makeRunAttempts({ redis: fakeRedis() });
	for (const bad of [undefined, null, "", 7]) {
		assert.deepEqual(await attempts.nextSeq(bad), { error: "bad-run-id" });
		assert.deepEqual(await attempts.remove(bad), { error: "bad-run-id" });
	}
});

test("a ttl that is not a positive safe integer is a wiring defect and throws at construction", () => {
	for (const ttlMs of [0, -1, 1.5, Number.NaN, "60000"]) {
		assert.throws(() => makeRunAttempts({ redis: fakeRedis(), ttlMs }), TypeError);
	}
});
