import assert from "node:assert/strict";
import { test } from "node:test";
import { runJob } from "../src/processor.mjs";
import { tokenCapsFor, modelTokenRows, parseScopedLimits } from "../src/scoped-limits.mjs";

// scoped-limits.json version 2 against a real Valkey (issues #501 part 5, #502 part 6): the processor's one
// reservation over the deployment, scope and model windows, the give-back on a refusal, and the per-model settle.
// Gated on VALKEY_TEST_URL; in CI PI_DISPATCH_REQUIRE_WORKER_TESTS=1 turns a missing URL into a hard failure. Each run
// names its own model and repo (so its token keys are its own), runs on a far-future day (so the job-count keys are
// too), and deletes every key it wrote.
const url = process.env.VALKEY_TEST_URL;
if (!url && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") {
	throw new Error("scoped-tokens.integration REQUIRES VALKEY_TEST_URL when PI_DISPATCH_REQUIRE_WORKER_TESTS=1");
}
const skip = url ? false : "needs VALKEY_TEST_URL";

test("a per-model window refuses the second job with token-cap, and every other window is given back (live Valkey)", { skip, timeout: 30_000 }, async (t) => {
	const { makeRedisClient } = await import("../src/connection.mjs");
	const redis = makeRedisClient(url, {});
	t.after(() => redis.disconnect());
	const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
	const model = `m-${tag}`;
	const repo = `pdtest/r-${tag}`;
	const now = new Date("2091-03-14T12:00:00Z");
	const limits = parseScopedLimits(JSON.stringify({ version: 2, limits: [{ scope: repo, dayTokens: 100 }, { scope: `model:PdTest/${model}`, dayTokens: 3 }] }), "sl.json");
	const scope = tokenCapsFor({ kind: "github", repo }, limits);
	const models = modelTokenRows(limits, null);
	assert.equal(models.length, 1);
	const modelDay = `${models[0].keyPrefix}:2091-03-14`;
	const scopeDay = `${scope.keyPrefix}:2091-03-14`;
	const written = [modelDay, scopeDay, "budget:2091-03-14"];
	// A per-job budget of 2 tokens against the model row's 3 a day: one job fits (2 <= 3), a second does not (2 + 2 = 4).
	const job = { kind: "github", repo, provider: "pdtest", model, maxTurns: 5, maxTokens: 2 };
	const tokens = { input: 1, output: 1, total: 2, calls: 1, metered: true, unresolved: 0, usageUnreported: 0, unmeteredChildren: 0 };
	const usage = { v: 1, piAi: null, truncated: 0, models: [{ provider: "pdtest", model, calls: 1, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, total: 2 }] };
	const deps = (runContainer) => ({
		redis,
		caps: { day: 1000, week: null, month: null },
		softHoldPct: null,
		tokenCaps: null,
		scopedTokens: scope,
		modelTokens: models,
		mintToken: async () => "tok",
		isDefaultBranchProtected: async () => true,
		prepareWorkspace: async () => ({ workspaceDir: "/w", jobDir: "/j" }),
		runContainer,
		collectChain: async () => ({ enqueued: 0, refused: 0 }),
		cleanup: async () => {},
		comment: async () => {},
		log: () => {},
		now,
	});
	try {
		const first = await runJob(job, deps(async () => ({ code: 0, aborted: false, exitLineCode: 0, tokens, usage })));
		assert.equal(first.outcome, "completed");
		assert.equal(Number(await redis.get(modelDay)), 2, "the model window settled to the model's own row");
		assert.equal(Number(await redis.get(scopeDay)), 2);
		assert.ok((await redis.ttl(modelDay)) > 0, "the model key has its TTL");
		// 2 tokens settled + 2 reserved = 4 > the model row's 3 a day: the second job is refused before any container.
		let ran = false;
		const second = await runJob(job, deps(async () => ((ran = true), { code: 0, aborted: false, exitLineCode: 0, tokens, usage })));
		assert.equal(second.reason, "token-cap");
		assert.equal(ran, false);
		assert.deepEqual(second.tokensWindows, { reservedTokens: 2, settledTokens: 0, basis: "refunded", modelBasis: "refunded" });
		assert.equal(Number(await redis.get(modelDay)), 2, "the refused reservation was given back");
		assert.equal(Number(await redis.get(scopeDay)), 2, "and the scope window's, reserved before the model refused");
		assert.equal(Number(await redis.get("budget:2091-03-14")), 1, "the job-count slot of the refused job went back");
	} finally {
		await redis.del(...written);
	}
});
