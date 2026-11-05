import assert from "node:assert/strict";
import { test } from "node:test";
import { governedTokens } from "../src/allocation.mjs";
import { parseEnvelope } from "../src/envelope.mjs";
import { runJob } from "../src/processor.mjs";
import { parseScopedLimits, projectTokenCapsFor, scopeTokenKeyPrefix, scopeKeyPrefix } from "../src/scoped-limits.mjs";

// Issue #504 part B (DES-DELEGATED-ALLOCATION-INSIDE-ENVELOPE, DES-DOLLAR-RESERVE-AND-SETTLE): under an envelope a
// job's token ledgers are the operator's narrowed by the applied split. A full window whose binding cap came from
// the split refuses as `allocation-cap`, pre-spend, and gives back like any token refusal; a host whose envelope is
// not the split's refuses `envelope-mismatch` before anything is spent.

const TOKENS = 1; // amounts are token counts now; the name keeps the N * TOKENS shapes readable
const NOW = new Date("2026-07-16T10:00:00Z");
const WEEK = "2026-07-13";
const G_DAY = "budget:2026-07-16";
const D_WEEK = `budget:tok:w:${WEEK}`;

function keyedRedis(preset = {}) {
	const store = new Map(Object.entries(preset));
	const ops = [];
	const at = (k) => store.get(k) ?? 0;
	return {
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
		async expire() {},
		async get() {
			return null;
		},
	};
}

const PROJECTS = [
	{ id: "shop", members: ["github:acme/web"] },
	{ id: "platform", members: ["github:acme/infra"] },
];
const envelope = parseEnvelope(
	JSON.stringify({ version: 1, window: "week", totalTokens: 100, floorsTokens: { shop: 1, platform: 1 }, delegation: { enabled: true, writers: ["operator-session"], maxStepPct: 25, minIntervalHours: 24, maxPlanDays: 14 } }),
	"/e/envelope.json",
	{ projects: PROJECTS, maxTokens: 2 },
);
const web = { kind: "github", repo: "acme/web", provider: "openai", model: "gpt-x", maxTurns: 20, maxTokens: 2 };
const loose = { kind: "github", repo: "acme/loose", provider: "openai", model: "gpt-x", maxTurns: 20, maxTokens: 2 };
const state = (shop, platform = 10, other = 10) => ({ allocations: { shop, platform, _other: other }, unallocated: 100 - shop - platform - other, repos: {} });
const SHOP_WEEK = `${scopeTokenKeyPrefix("project:shop")}:w:${WEEK}`;
const OTHER_WEEK = `${scopeTokenKeyPrefix("project:_other")}:w:${WEEK}`;
const TOKENS_OF = (total) => ({ input: 10, output: 5, total, metered: true, rootTotal: total, otherTotal: 0, looseTotal: 0, sessions: 1, calls: 2, unresolved: 0, childTotal: 0, childProcesses: 0, unmeteredChildren: 0, usageUnreported: 0, modelRefused: 0 });
const ranFor = (cost) => async () => ({ code: 0, aborted: false, exitLineCode: 0, tokens: TOKENS_OF(cost), usage: { v: 1, piAi: null, truncated: 0, models: [] } });

function deps(job, inputs, overrides = {}) {
	const comments = [];
	const logs = [];
	const calls = [];
	const base = {
		redis: keyedRedis(),
		caps: { day: 10, week: null, month: null },
		softHoldPct: null,
		scopedLedgers: [],
		mintToken: async () => (calls.push("mint"), "tok"),
		isDefaultBranchProtected: async () => true,
		prepareWorkspace: async () => (calls.push("prepare"), { workspaceDir: "/w", jobDir: "/j" }),
		runContainer: async () => (calls.push("run-container"), { code: 0, aborted: false }),
		collectChain: async () => ({ enqueued: 0, refused: 0 }),
		cleanup: async () => {},
		comment: async (_j, t) => comments.push(t),
		log: (e, f) => logs.push({ e, f }),
		now: NOW,
		...inputs,
	};
	return { deps: { ...base, ...overrides }, comments, logs, calls };
}

const governed = (job, st, operator = {}) => governedTokens({ envelope, state: st, member: job === web ? { id: "shop", member: "github:acme/web" } : null, operator });

test("a full project share refuses allocation-cap before the container, gives every ledger back like scope-cap, and never says raise the budget (#504)", async () => {
	// No operator row for shop: the synthetic ledger alone. 2 spent of a 3 share; a 2 hold would make 4.
	const redis = keyedRedis({ [SHOP_WEEK]: 2 });
	const d = deps(web, governed(web, state(3)), { redis, scopedLedgers: [{ scope: "github:acme/web", keyPrefix: scopeKeyPrefix("github:acme/web"), caps: { day: 5, week: null, month: null }, reason: "scope-cap" }] });
	const r = await runJob(web, d.deps);
	assert.deepEqual([r.outcome, r.reason, r.budgetReserved], ["policy", "allocation-cap", false]);
	assert.ok(!d.calls.includes("run-container"));
	assert.equal(redis.store.get(SHOP_WEEK), 2, "the refusing window was given back");
	assert.equal(redis.store.get(D_WEEK), 0, "the deployment window (the envelope total) too");
	assert.equal(redis.store.get(`${scopeKeyPrefix("github:acme/web")}:2026-07-16`), 0, "the repo job-count slot went back, the scope-cap way");
	assert.equal(redis.store.get(G_DAY), 0, "and the global one");
	assert.match(d.comments[0], /^Refused: this week's share of the budget split for/);
	assert.doesNotMatch(d.comments.join(" "), /raise/i);
	const logged = d.logs.find((l) => l.e === "over_token_budget").f;
	assert.deepEqual([logged.ledger, logged.source, logged.window], ["project", "allocation", "week"]);
	assert.equal(r.tokensWindows.basis, "refunded");
});

test("a share below one job's cap says so in the allocation's own words (#504)", async () => {
	const d = deps(web, governed(web, state(1)));
	const r = await runJob(web, d.deps);
	assert.equal(r.reason, "allocation-cap");
	assert.match(d.comments[0], /^Refused: the weekly share of the budget split for .* is smaller than this run's token budget/);
	assert.doesNotMatch(d.comments[0], /raise the budget/);
});

test("whose number bound decides the reason: the operator's row is token-cap, a tie is token-cap, the envelope total on the deployment is allocation-cap (#504)", async () => {
	const limits = (weekTokens) => parseScopedLimits(JSON.stringify({ version: 2, limits: [{ scope: "project:shop", weekTokens }] }), "sl.json");
	// The row (3) under the share (50): the operator's number binds.
	{
		const redis = keyedRedis({ [SHOP_WEEK]: 2 });
		const r = await runJob(web, deps(web, governed(web, state(50), { projectTokens: projectTokenCapsFor(limits(3), "shop") }), { redis }).deps);
		assert.equal(r.reason, "token-cap");
	}
	// A tie (3 and 3): the operator's.
	{
		const redis = keyedRedis({ [SHOP_WEEK]: 2 });
		const r = await runJob(web, deps(web, governed(web, state(3), { projectTokens: projectTokenCapsFor(limits(3), "shop") }), { redis }).deps);
		assert.equal(r.reason, "token-cap");
	}
	// The deployment: an operator week of 500 above the envelope's 100 total, 99 spent: the total binds.
	{
		const redis = keyedRedis({ [D_WEEK]: 99 });
		const d = deps(web, governed(web, state(50), { tokenCaps: { day: null, week: 500, month: null } }), { redis });
		const r = await runJob(web, d.deps);
		assert.equal(r.reason, "allocation-cap");
		assert.equal(d.logs.find((l) => l.e === "over_token_budget").f.ledger, "deployment");
		// And with the operator's 90 under the total, the operator's number binds the same window.
		const redis2 = keyedRedis({ [D_WEEK]: 89 });
		const r2 = await runJob(web, deps(web, governed(web, state(50), { tokenCaps: { day: null, week: 90, month: null } }), { redis: redis2 }).deps);
		assert.equal(r2.reason, "token-cap");
	}
});

test("a project with no operator row reserves in a synthetic ledger and settles to the job's cost through holdPart (#504)", async () => {
	const redis = keyedRedis();
	const r = await runJob(web, deps(web, governed(web, state(50)), { redis, runContainer: ranFor(4) }).deps);
	assert.equal(r.outcome, "completed");
	assert.equal(redis.store.get(SHOP_WEEK), 4, "the project's share counter holds the job's metered total");
	assert.equal(redis.store.get(D_WEEK), 4, "and the envelope total's");
});

test("a job in no project reserves in _other's ledger, keyed project:_other, and settles to its cost (#504)", async () => {
	const redis = keyedRedis();
	const inputs = governed(loose, state(50));
	assert.equal(inputs.otherTokens.keyPrefix, scopeTokenKeyPrefix("project:_other"));
	const r = await runJob(loose, deps(loose, inputs, { redis, runContainer: ranFor(2) }).deps);
	assert.equal(r.outcome, "completed");
	assert.equal(redis.store.get(OTHER_WEEK), 2);
	// A full _other share refuses allocation-cap, naming the work in no project.
	const full = keyedRedis({ [OTHER_WEEK]: 9 });
	const d = deps(loose, inputs, { redis: full });
	const refused = await runJob(loose, d.deps);
	assert.equal(refused.reason, "allocation-cap");
	assert.match(d.comments[0], /for the work outside the budget split's projects/);
});

test("a shrink never touches a running job: its reservation stands and settles, and only the next start is refused (#504)", async () => {
	const redis = keyedRedis();
	let finish;
	const running = new Promise((resolve) => {
		finish = resolve;
	});
	let started;
	const startedP = new Promise((resolve) => {
		started = resolve;
	});
	const a = runJob(web, deps(web, governed(web, state(5)), { redis, runContainer: async () => (started(), await running, ranFor(3)()) }).deps);
	await startedP;
	assert.equal(redis.store.get(SHOP_WEEK), 2, "job A holds its 2");
	// The envelope shrinks: the share is now $1, below what A already holds. A new start is refused.
	const b = deps(web, governed(web, state(1)), { redis });
	const rb = await runJob(web, b.deps);
	assert.equal(rb.reason, "allocation-cap");
	assert.equal(redis.store.get(SHOP_WEEK), 2, "B gave back only its own amount; A's reservation was never taken back");
	finish();
	const ra = await a;
	assert.equal(ra.outcome, "completed");
	assert.equal(redis.store.get(SHOP_WEEK), 3, "A settled to its own cost");
	assert.ok(!redis.ops.some((o) => o[0] === "decrby" && o[1] === SHOP_WEEK && o[2] !== 2), "nothing decremented A's hold but its own settle");
});

test("envelope-mismatch is a free gate: refused before the mint, the clone and every reserve, never retried (#504)", async () => {
	const redis = keyedRedis();
	const d = deps(web, { envelopeMismatch: true, tokenCaps: { day: null, week: 100, month: null } }, { redis });
	const r = await runJob(web, d.deps);
	assert.deepEqual([r.outcome, r.reason, r.budgetReserved], ["policy", "envelope-mismatch", false]);
	assert.deepEqual(d.calls, [], "no mint, no prepare, no container");
	assert.deepEqual(redis.ops, [], "no key touched");
	assert.match(d.comments[0], /budget envelope differs/);
	assert.doesNotMatch(d.comments[0], /raise/i);
});

test("a repo share with no operator row reserves in a synthetic ledger keyed by the member, refuses allocation-cap when full, and settles through holdPart (#504)", async () => {
	const { scopeRef } = await import("../src/priorities.mjs");
	const repoKey = `${scopeTokenKeyPrefix("github:acme/web")}:w:${WEEK}`;
	const st = { ...state(50), repos: { shop: { [scopeRef("github:acme/web")]: 3 } } };
	const inputs = governed(web, st);
	assert.equal(inputs.scopedTokens.keyPrefix, scopeTokenKeyPrefix("github:acme/web"));
	const ran = keyedRedis();
	const ok = await runJob(web, deps(web, inputs, { redis: ran, runContainer: ranFor(6) }).deps);
	assert.equal(ok.outcome, "completed");
	assert.equal(ran.store.get(repoKey), 6, "the repo share's counter settled to the job's total");
	const full = keyedRedis({ [repoKey]: 2 });
	const d = deps(web, inputs, { redis: full });
	const r = await runJob(web, d.deps);
	assert.equal(r.reason, "allocation-cap");
	assert.equal(full.store.get(repoKey), 2, "given back");
	assert.equal(d.logs.find((l) => l.e === "over_token_budget").f.ledger, "scope");
});

test("a local job whose RESOLVED folder belongs to another project is refused before any reserve; one in no project is not (#504)", async () => {
	const local = { kind: "local", folder: "/srv/root/link", provider: "openai", model: "gpt-x", maxTurns: 20, maxTokens: 2 };
	const folderProject = (f) => ({ "/srv/platform": "platform", "/srv/root/link": "shop" })[f] ?? null;
	const prepareAt = (workspace) => async () => ({ workspace, jobDir: "/j", sha: "s" });
	const redis = keyedRedis();
	const d = deps(local, { pickupProject: "shop", folderProject }, { redis, prepareWorkspace: prepareAt("/srv/platform") });
	const r = await runJob(local, d.deps);
	assert.deepEqual([r.outcome, r.reason, r.budgetReserved], ["policy", "local-folder-project-changed", false]);
	assert.ok(!d.calls.includes("run-container"));
	assert.ok(!redis.ops.some((o) => o[0] === "incr" || o[0] === "incrby"), "nothing reserved");
	const same = await runJob(local, deps(local, { pickupProject: "shop", folderProject }, { prepareWorkspace: prepareAt("/srv/root/link") }).deps);
	assert.equal(same.outcome, "completed");
	const none = await runJob(local, deps(local, { pickupProject: "shop", folderProject }, { prepareWorkspace: prepareAt("/srv/elsewhere") }).deps);
	assert.equal(none.outcome, "completed", "a resolved folder in no project keeps the named membership");
});
