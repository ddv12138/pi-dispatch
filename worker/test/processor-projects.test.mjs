import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { InfraRetry, runJob } from "../src/processor.mjs";
import { configError } from "../src/config.mjs";
import { tokenCapsFor, parseScopedLimits, projectTokenCapsFor, scopeTokenKeyPrefix } from "../src/scoped-limits.mjs";

// Issue #499 part B (INT-SCOPED-LIMITS-FILE-CONTRACT): a `project:<id>` row caps every member of a project as one.
// The job-count tiers are gone with the job-start caps; the token ledgers keep the project tier in ONE hold, reserved
// after the repo or folder scope and before the model rows, and given back whole on any refusal.

const TOKENS = 1; // amounts are token counts now; the name keeps the N * TOKENS shapes readable
const NOW = new Date("2026-07-16T10:00:00Z");

/** A keyed fake: token INCRBY/DECRBY/settle on one store, every op in order. */
function keyedRedis(preset = {}) {
	const store = new Map(Object.entries(preset));
	const ops = [];
	const at = (k) => store.get(k) ?? 0;
	return {
		store,
		ops,
		async incrby(k, n) {
			ops.push(["incrby", k, n]);
			store.set(k, at(k) + n);
			return at(k);
		},
		async decrby(k, n) {
			ops.push(["decrby", k, n]);
			store.set(k, at(k) - n);
			return at(k);
		},
		async eval(_script, _n, k, arg) {
			const d = Number(arg);
			ops.push(["settle", k, d]);
			if (!store.has(k)) return [1, 0];
			store.set(k, Math.max(0, at(k) + d));
			return [0, at(k)];
		},
		// The token windows read the current value through eval in production; the fake get is a stub.
		async expire() {},
		async get() {
			return null;
		},
	};
}

const LIMITS = parseScopedLimits(JSON.stringify({ version: 2, limits: [{ scope: "project:shop", dayTokens: 3 }] }), "sl.json");
const web = { kind: "github", repo: "acme/web", provider: "anthropic", model: "m", maxTurns: 20 };
const api = { kind: "github", repo: "acme/api", provider: "anthropic", model: "m", maxTurns: 20 };

function deps(overrides = {}) {
	const comments = [];
	const logs = [];
	const calls = [];
	const base = {
		redis: keyedRedis(),
		mintToken: async () => "tok",
		isDefaultBranchProtected: async () => true,
		prepareWorkspace: async () => ({ workspaceDir: "/w", jobDir: "/j" }),
		runContainer: async () => (calls.push("run-container"), { code: 0, aborted: false }),
		collectChain: async () => ({ enqueued: 0, refused: 0 }),
		cleanup: async () => {},
		comment: async (_j, t) => comments.push(t),
		log: (e, f) => logs.push({ e, f }),
		now: NOW,
	};
	return { deps: { ...base, ...overrides }, comments, logs, calls };
}

// ── tokensWindows: the project tier ────────────────────────────────────────────────────────────────────────────

const DJOB = { ...web, provider: "openai", model: "gpt-x", maxTokens: 2 };
const P_TOKENS = projectTokenCapsFor(LIMITS, "shop");
const P_TOKENS_DAY = `${P_TOKENS.keyPrefix}:2026-07-16`;
const D_DAY = "budget:tok:2026-07-16";
const TOKENS_OF = (total) => ({ input: 10, output: 5, total, metered: true, rootTotal: total, otherTotal: 0, looseTotal: 0, sessions: 1, calls: 2, unresolved: 0, childTotal: 0, childProcesses: 0, unmeteredChildren: 0, usageUnreported: 0, modelRefused: 0 });
const ROW = (provider, model, total) => ({ provider, model, calls: 1, input: 5, output: 2, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, total });
const MODEL = { ref: "openai/gpt-x", keyPrefix: "budget:tok:mdl:feedfacefeedface", caps: { day: 100, week: null, month: null } };
const ranFor = (cost, modelCost) => async () => ({ code: 0, aborted: false, exitLineCode: 0, tokens: TOKENS_OF(cost), usage: { v: 1, piAi: null, truncated: 0, models: [ROW("openai", "gpt-x", modelCost)] } });

test("the project token window is under scopeTokenKeyPrefix(project:shop), reserved after the scope and before the models, in ONE hold", async () => {
	assert.equal(P_TOKENS.keyPrefix, scopeTokenKeyPrefix("project:shop"));
	assert.ok(!P_TOKENS.keyPrefix.startsWith("budget:tok:p:"), "no second token keyspace for projects");
	const scope = tokenCapsFor(web, parseScopedLimits(JSON.stringify({ version: 2, limits: [{ scope: "github:acme/web", dayTokens: 50 }] }), "sl.json"));
	const redis = keyedRedis();
	const d = deps({ redis, tokenCaps: { day: 50, week: null, month: null }, scopedTokens: scope, projectTokens: P_TOKENS, modelTokens: [MODEL], runContainer: ranFor(4, 2) });
	const r = await runJob(DJOB, d.deps);
	assert.equal(r.outcome, "completed");
	const reserved = redis.ops.filter((o) => o[0] === "incrby").map((o) => o[1]);
	assert.deepEqual(reserved, [D_DAY, `${scope.keyPrefix}:2026-07-16`, P_TOKENS_DAY, `${MODEL.keyPrefix}:2026-07-16`], "deployment, scope, project, models");
	// The project part settles to the JOB's cost, like the scope part; the model part to its own usage row.
	assert.equal(redis.store.get(P_TOKENS_DAY), 4, "the project window holds the job's metered tokens");
	assert.equal(redis.store.get(`${scope.keyPrefix}:2026-07-16`), 4);
	assert.equal(redis.store.get(D_DAY), 4);
	assert.equal(redis.store.get(`${MODEL.keyPrefix}:2026-07-16`), 2, "the model window holds its own row's tokens");
});

test("a full project token window refuses token-cap naming 'this project', and every token ledger goes back", async () => {
	const redis = keyedRedis({ [P_TOKENS_DAY]: 2 }); // 2 of 3 tokens used; a 2-token hold would make 4
	const d = deps({ redis, tokenCaps: { day: 50, week: null, month: null }, projectTokens: P_TOKENS });
	const r = await runJob(DJOB, d.deps);
	assert.equal(r.reason, "token-cap");
	assert.equal(r.budgetReserved, false);
	assert.ok(!d.calls.includes("run-container"));
	assert.match(d.comments[0], /^Refused: today's token budget for this project has no room left/);
	const logged = d.logs.find((l) => l.e === "over_token_budget").f;
	assert.equal(logged.ledger, "project");
	assert.equal(logged.key, P_TOKENS.keyPrefix);
	assert.equal(redis.store.get(P_TOKENS_DAY), 2, "the refusing window was given back");
	assert.equal(redis.store.get(D_DAY), 0, "the deployment window too");
});

test("a never-started container gives the project token hold back with the rest", async () => {
	const redis = keyedRedis();
	const d = deps({ redis, tokenCaps: { day: 50, week: null, month: null }, projectTokens: P_TOKENS, runContainer: async () => ({ code: 125, aborted: false }) });
	await assert.rejects(() => runJob(DJOB, d.deps), (e) => e.reason === "container-never-started");
	assert.equal(redis.store.get(P_TOKENS_DAY), 0);
	assert.equal(redis.store.get(D_DAY), 0);
});

test("a config-tagged throw before the container refuses config-refused", async () => {
	const redis = keyedRedis();
	const r = await runJob(web, deps({ redis, runContainer: async () => { throw configError("no provider credential"); } }).deps);
	assert.equal(r.reason, "config-refused");
	assert.equal(r.budgetReserved, false);
});

// ── the rule, not the sites ──────────────────────────────────────────────────────────────────────────────

test("processor.mjs has no job-count reserve or release left at all", () => {
	const src = readFileSync(new URL("../src/processor.mjs", import.meta.url), "utf8");
	const code = src
		.split("\n")
		.filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
		.join("\n");
	for (const name of ["reserveBudget", "releaseBudget", "reserveLedgers", "releaseLedgers", "scopedLedgers", "claimSlot", "globalHeld", "slotCarried", "slotOwnedByRun"]) {
		assert.doesNotMatch(code, new RegExp(`\\b${name}\\b`), `no ${name} remains in the processor`);
	}
	assert.doesNotMatch(code, /\bscopedReserved\b|\bscopedCaps\b/, "no per-ledger flag a new ledger could be forgotten in");
});
