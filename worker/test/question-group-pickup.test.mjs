import assert from "node:assert/strict";
import { test } from "node:test";
import { makeProcessor } from "../src/index.mjs";
import { makeQuestionGroupRuntime, questionGroupConfigDigest } from "../src/question-group-runtime.mjs";

const NOW = Date.UTC(2026, 9, 30, 12);
const config = { capture: true, model: "test/classifier", maxTokens: 5000, confidence: 0.9, names: {} };
const digest = "b".repeat(64);
function fixture(currentProjects) {
	const ops = [];
	const records = [];
	const runtime = makeQuestionGroupRuntime({
		store: { privateInput: async () => ({ status: "ready", meta: { runId: "source", scopeId: "a".repeat(64), digest, project: "shop" }, excerpt: "private source", revision: 0, candidates: [] }), setStatus: async () => {} },
		triggersPath: "/triggers.json", readFile: () => JSON.stringify({ triggers: [], zeroTouch: config }),
		getSettings: () => ({ provider: "test", model: "chat" }), resolveClassifier: () => ({ type: "classifier", contextWindow: 4096, cost: { input: 0, output: 0 } }),
	});
	const redis = { get: async () => null, incr: async (key) => { ops.push(["incr", key]); return key.startsWith(scopeKeyPrefix("project:shop")) ? 2 : 1; }, decr: async () => 0, expire: async () => {}, del: async () => 0 };
	const processor = makeProcessor({
		redis, now: () => NOW, projects: () => currentProjects, scopedLimits: () => [],
		getSettings: () => ({ provider: "test", model: "chat", maxTurns: 1, maxTokens: 5000, concurrency: 1 }),
		recordRun: (row) => records.push(row),
		deps: { questionGroupRuntime: runtime, imagePreflight: async () => ({ ok: true, piVersion: "1.4.0", capabilities: ["questionGrouping", "tokenBudget", "modelPolicy"] }), prepareWorkspace: async () => ({ workspace: "/internal-empty-workspace", jobDir: "/job" }), runContainer: async () => ({ code: 0, aborted: false }), cleanup: async () => {}, comment: async () => {}, log: () => {} },
	});
	const job = { id: "grouping-job", data: { kind: "question-grouping", questionGrouping: { runId: "source", digest, configDigest: questionGroupConfigDigest(config) } }, timestamp: NOW, attemptsMade: 0, opts: { attempts: 1 } };
	return { processor, job, ops, records };
}

test("a resolved grouping job records its SOURCE project rather than the empty workspace's other tier", async () => {
	const { processor, job, ops, records } = fixture([{ id: "shop", members: ["github:acme/api"] }]);
	const result = await processor(job, "lock-token", new AbortController().signal);
	assert.equal(result.outcome, "completed");
	assert.equal(result.budgetReserved, true, "the classifier ran, so the record marks possible spend");
	assert.deepEqual(ops, [], "no job-count ledger exists to reserve in");
	assert.equal(records.at(-1).project, "shop");
});

test("a deleted grouping source project is refused before any ledger or container is reached", async () => {
	const { processor, job, ops, records } = fixture([]);
	const result = await processor(job, "lock-token", new AbortController().signal);
	assert.equal(result.reason, "question-group-config-changed");
	assert.equal(result.budgetReserved, false, "refused before any spend");
	assert.deepEqual(ops, []);
	assert.equal(records.at(-1).project, null);
});
