/**
 * The per-run CONTAINER SEQUENCE (issue #645, durable runs): a durable counter of how many containers a run has
 * started, so every checkpoint's `attempt` and every fork point's capture can name the container it came from.
 * Attempt 1 is 1, its BullMQ retry 2, and a recovery's container the next one after the crashed attempt's. A
 * container number is never reused, which is what the checkpoint comment means by "unique across retries and
 * recoveries" -- a BullMQ attempt count is not, because a retry and a recovery both start again at 1.
 *
 * THIS IS ONLY THE RUN'S CONTAINER NUMBER. No budget, no dollar or token hold, and no state machine live here:
 * that was the run budget ledger's other job, and it left with the run caps. A run that never reaches `remove`
 * only leaves one small hash behind, which the TTL removes.
 *
 * One hash per run, `run:attempt:<sanitized run id>` (the run mirror's `sanitizeJobId`, so every per-run key of
 * the deployment spells a run the same way), with fields:
 *   - `seq`: the last container number handed out (HINCRBY, so two callers can never receive the same one);
 *   - `at`: the injected clock at the last write, for an operator asking how stale the counter is. Nothing
 *     decides on it.
 *
 * `nextSeq` does the HINCRBY and the PEXPIRE in ONE Lua script, so a number is never handed out on a key with
 * no expiry: a worker that dies between the two calls would otherwise leave a hash behind for ever. The TTL is
 * refreshed on every take, so a run that keeps retrying keeps its counter.
 *
 * Every method NEVER throws on a Valkey failure (or on a client that throws synchronously): it returns
 * `{ error }`, where `error` is a short code, and the caller decides. A bad argument is returned the same way,
 * because a TypeError escaping a run-start path would be retried as an unknown failure instead of the
 * never-started retry the processor means to raise. `remove` is best effort: the TTL is the backstop.
 *
 * `redis` is any ioredis-compatible client with `eval` and `del`, injected so the error paths are testable
 * with a fake.
 */

import { sanitizeJobId } from "./run-history.mjs";

/** The key prefix of every run's container sequence. */
export const RUN_ATTEMPT_KEY_PREFIX = "run:attempt:";
/** The default TTL: 35 days, past the longest token window a hold used to live in, refreshed on every take. */
export const RUN_ATTEMPT_TTL_MS = 35 * 24 * 3600 * 1000;

/** The sequence key of `runId`. */
export function runAttemptKeyFor(runId) {
	return `${RUN_ATTEMPT_KEY_PREFIX}${sanitizeJobId(runId)}`;
}

// nextSeq: HINCRBY and the TTL in one script, so a container number is never handed out on a key with no expiry.
const SEQ_SCRIPT = `local n = redis.call('HINCRBY', KEYS[1], 'seq', 1)
redis.call('HSET', KEYS[1], 'at', ARGV[2])
redis.call('PEXPIRE', KEYS[1], ARGV[1])
return n`;

const isSeq = (n) => Number.isSafeInteger(n) && n >= 1;
const isRunId = (id) => typeof id === "string" && id !== "";

/**
 * Build the sequence. `ttlMs` is the hash's expiry, refreshed on every take; `at` (ms since the epoch) stamps
 * `at`. A `ttlMs` that is not a positive safe integer is a wiring defect and throws here, at construction, never
 * per call.
 */
export function makeRunAttempts({ redis, ttlMs = RUN_ATTEMPT_TTL_MS, at = () => Date.now() } = {}) {
	if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new TypeError("ttlMs must be a positive safe integer of milliseconds");
	const ttl = String(ttlMs);

	async function attempt(fn) {
		try {
			return { value: await fn() };
		} catch (error) {
			return { error: typeof error?.code === "string" ? error.code : "valkey" };
		}
	}

	return {
		/**
		 * The next container number of the run (attempt 1 is 1, attempt 2 is 2, a recovery's first container the
		 * next), or `{ error }`. The caller cannot name a checkpoint or a fork point without one, so it throws a
		 * never-started InfraRetry before the container.
		 */
		async nextSeq(runId) {
			if (!isRunId(runId)) return { error: "bad-run-id" };
			const r = await attempt(() => redis.eval(SEQ_SCRIPT, 1, runAttemptKeyFor(runId), ttl, String(at())));
			if (r.error) return { error: r.error };
			const n = Number(r.value);
			return isSeq(n) ? n : { error: "bad-reply" };
		},

		/** Delete the sequence at the run's final outcome: `{ ok: true }` or `{ error }` (the TTL removes it anyway). */
		async remove(runId) {
			if (!isRunId(runId)) return { error: "bad-run-id" };
			const r = await attempt(() => redis.del(runAttemptKeyFor(runId)));
			return r.error ? { error: r.error } : { ok: true };
		},
	};
}
