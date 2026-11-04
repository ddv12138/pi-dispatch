import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { COST_CLASSES, COSTS_WINDOWS, PROJECT_KEY_RE, costsSinceMs, matchesGlob, foldCosts, whatIfFlow, repoOfTarget, foldTriggerCosts, projectKeyOf, recordInProject, recordInRepo, repoKeyOf, whatIfRuns } from "../src/costs.mjs";
import { PROJECT_ID_RE } from "@edgehero/pi-dispatch/projects";

test("costs.mjs is pure: no fs, no redis, no queue, no env, no console -- records in, typed amounts out", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/costs.mjs", import.meta.url)), "utf8");
  assert.ok(
    !/readFileSync|\breadFile\b|require\(|import\s+.*node:fs|console\.|process\.env[.[]|ioredis|bullmq/.test(src),
    "the fold must do no I/O and read no env",
  );
  // Budget's dayKey is the ONE permitted worker coupling: the fold's daily buckets and the worker's
  // spend windows must agree on where a UTC day boundary falls, and importing the worker's own key
  // function is how the two sides cannot drift. There is no pricing facade to inject: prices died
  // with the cost era, and the fold reads records only.
  assert.ok(
    !/@edgehero\/pi-dispatch\/(?!budget\b)/.test(src),
    "the only worker import the fold may hold is @edgehero/pi-dispatch/budget (dayKey)",
  );
});

// ---- fixtures: the record shapes of INT-RUN-HISTORY-FILE-CONTRACT, one per rung of the ladder ----

/** A full record literal, overridable per fixture; defaults are a completed local run. */
function rec(over = {}) {
  return {
    jobId: "j1",
    kind: "local",
    target: "local:repo",
    flow: "fix",
    startedAt: "2026-07-14T09:00:00.000Z",
    endedAt: "2026-07-14T10:00:00.000Z",
    outcome: "completed",
    reason: null,
    exitCode: 0,
    turns: 5,
    tokens: null,
    usage: null,
    provider: null,
    model: null,
    budgetReserved: true,
    attempt: 1,
    parentJobId: null,
    chainDepth: null,
    chainRefused: null,
    replica: null,
    replicas: null,
    session: null,
    ...over,
  };
}

/** The flat per-job totals (`tokens`), process-wide-meter shape unless `metered:false` is forced. */
function tok(cost, { input = 1000, output = 500, unresolved = 0, usageUnreported = 0, unmeteredChildren = 0, calls = 3 } = {}) {
  void cost;
  return { input, output, total: input + output, metered: true, rootTotal: input + output, otherTotal: 0, looseTotal: 0, sessions: 1, calls, unresolved, usageUnreported, unmeteredChildren };
}

/** One per-(provider,model) ledger row, `total` following the rows-sum-to-total convention. */
function row(provider, model, { cost = 0, input = 1000, output = 500, cacheRead = 0, cacheWrite = 0, cacheWrite1h = 0, reasoning = 0, calls = 2 } = {}) {
  void cost;
  return { provider, model, calls, input, output, cacheRead, cacheWrite, cacheWrite1h, reasoning, total: input + output + cacheRead + cacheWrite + cacheWrite1h };
}

/** A `usage` ledger block around a set of rows. */
function usage(models, { piAi = "1.2.3", truncated = 0 } = {}) {
  return { v: 1, piAi, truncated, models };
}

// The degradation ladder, newest shape first (all endedAt on 2026-07-14, two days before NOW):
const ledgeredMetered = rec({
  jobId: "led-1",
  endedAt: "2026-07-14T10:00:00.000Z",
  tokens: tok(0),
  usage: usage([row("anthropic", "claude-sonnet-4")]),
  provider: "anthropic",
  model: "claude-sonnet-4",
});
const planCovered = rec({
  jobId: "plan-1",
  endedAt: "2026-07-14T11:00:00.000Z",
  tokens: tok(0, { input: 4_000_000, output: 2_000_000 }),
  usage: usage([row("kimi-coding", "kimi-k2", { input: 4_000_000, output: 2_000_000 })]),
  provider: "kimi-coding",
  model: "kimi-k2",
});
const zeroRatedUnmatched = rec({
  jobId: "zai-1",
  flow: null,
  endedAt: "2026-07-14T12:00:00.000Z",
  tokens: tok(0),
  usage: usage([row("qwen-token-plan", "deepseek-v4-pro")]),
  provider: "qwen-token-plan",
  model: "deepseek-v4-pro",
});
const preLedger = rec({
  jobId: "prelede-1",
  endedAt: "2026-07-14T13:00:00.000Z",
  tokens: tok(0),
  usage: null,
  provider: "anthropic",
  model: "claude-sonnet-4",
});
const legacyNoModel = rec({
  jobId: "legacy-1",
  flow: "tidy",
  endedAt: "2026-07-14T14:00:00.000Z",
  tokens: tok(0),
  usage: null,
  provider: null,
  model: null,
});
const preTokens = rec({
  jobId: "pre25-1",
  flow: "tidy",
  endedAt: "2026-07-14T15:00:00.000Z",
  tokens: null,
  usage: null,
  provider: null,
  model: null,
});
const floored = rec({
  jobId: "floor-1",
  endedAt: "2026-07-14T16:00:00.000Z",
  tokens: tok(0, { usageUnreported: 2 }),
  usage: usage([row("anthropic", "claude-sonnet-4")]),
  provider: "anthropic",
  model: "claude-sonnet-4",
});
const retried = rec({
  jobId: "retry-1",
  attempt: 2,
  endedAt: "2026-07-14T17:00:00.000Z",
  tokens: tok(0),
  usage: usage([row("anthropic", "claude-sonnet-4")]),
  provider: "anthropic",
  model: "claude-sonnet-4",
});

/** A normalized subscription entry (the parseSubscriptions output shape), overridable per test. */
function sub(over = {}) {
  return {
    id: "kimi",
    vendor: "Moonshot AI",
    provider: "kimi-coding",
    models: ["*"],
    sharedWithOtherProducts: false,
    hypothetical: false,
    windows: [],
    ...over,
  };
}

const NOW = Date.parse("2026-07-16T00:00:00.000Z");

function fold(records, { subscriptions = [], nowMs = NOW, piAiPin = "1.2.3", sinceMs = null } = {}) {
  return foldCosts({ records, subscriptions, nowMs, piAiPin, sinceMs });
}

// ---- classes ----

test("COST_CLASSES is the closed class set, and the pricing classes are not in it", () => {
  assert.deepEqual(COST_CLASSES, ["metered", "estimated", "unknown"]);
  assert.ok(!COST_CLASSES.includes("free"), "'free' is a claim the fold cannot make");
  assert.ok(!COST_CLASSES.includes("plan") && !COST_CLASSES.includes("zero-rated") && !COST_CLASSES.includes("seeded"), "the pricing classes died with pricing");
});

test("matchesGlob: '*' as prefix/suffix/middle, case-insensitive, everything else literal", () => {
  assert.equal(matchesGlob("kimi-k2", "*"), true);
  assert.equal(matchesGlob("claude-sonnet-4", "claude-*"), true, "suffix wildcard");
  assert.equal(matchesGlob("glm-4.7", "*-4.7"), true, "prefix wildcard");
  assert.equal(matchesGlob("kimi-k2-turbo", "kimi-*-turbo"), true, "middle wildcard");
  assert.equal(matchesGlob("Claude-Sonnet-4", "claude-sonnet-4"), true, "case-insensitive");
  assert.equal(matchesGlob("claude-opus", "claude-sonnet-*"), false);
  assert.equal(matchesGlob("kimi-k2", "kimi-k2"), true, "no star -> exact match");
  assert.equal(matchesGlob("kimi-k2", "kimi"), false, "no star -> no implicit prefix");
  assert.equal(matchesGlob("glm.4", "glm.4"), true);
  assert.equal(matchesGlob("glmx4", "glm.4"), false, "a dot in the glob is literal, never a regex any-char");
});

test("classes: a complete run is metered at its token total; a floored one is estimated; a pre-meter one unknown", () => {
  const f = fold([ledgeredMetered]);
  assert.deepEqual(f.provenance.total, { tokens: 1500, class: "metered", floor: false });
  const flooredFold = fold([floored]);
  assert.deepEqual(flooredFold.provenance.total, { tokens: 1500, class: "estimated", floor: true, coverage: 0 }, "a completeness counter above 0: estimated");
  assert.deepEqual(fold([preTokens]).provenance.total, { tokens: 0, class: "estimated", floor: true, coverage: 0 }, "tokens:null measured nothing: unknown, floored");
});

test("subscriptions no longer classify rows: prices died, and a covered run's tokens are just tokens", () => {
  const f = fold([planCovered], { subscriptions: [sub()] });
  assert.deepEqual(f.provenance.total, { tokens: 6_000_000, class: "metered", floor: false }, "the covered run's token total is the fact; there is no plan class to demote it to");
  assert.deepEqual(f.byModel.map((m) => m.amount.class), ["metered"]);
});

test("an all-metered bucket stays 'metered'; one floored addend demotes to 'estimated' with run coverage", () => {
  const pure = fold([ledgeredMetered, preLedger, retried]);
  assert.deepEqual(pure.provenance.total, { tokens: 4500, class: "metered", floor: false });
  const mixed = fold([ledgeredMetered, preLedger, retried, floored]);
  assert.equal(mixed.provenance.total.class, "estimated", "one floored addend demotes the sum");
  assert.equal(mixed.provenance.total.tokens, 6000, "every run's measured tokens contribute");
  assert.equal(mixed.provenance.total.coverage, 3 / 4, "3 of 4 runs contributed metered totals");
});

test("floor propagation: completeness counters, the fallback meter, and a pre-meter record all floor their aggregates", () => {
  const f = fold([ledgeredMetered, floored]);
  assert.equal(f.provenance.total.floor, true, "one floored addend floors the sum");
  assert.equal(f.provenance.total.class, "estimated", "floor is not orthogonal to class any more: a floored run IS an estimate");
  assert.equal(f.daily.find((d) => d.day === "2026-07-14").amount.floor, true, "the day bucket holding the floored run is a floor too");

  const fallback = rec({
    jobId: "fb-1",
    tokens: { input: 100, output: 50, total: 150, metered: false }, // the subscribe() fallback: 5 keys, no ledger
    provider: "anthropic",
    model: "claude-sonnet-4",
  });
  assert.equal(fold([fallback]).provenance.total.floor, true, "metered:false missed subagent/compaction tokens -- a floor");

  const pre = fold([preTokens]);
  assert.deepEqual(pre.provenance.total, { tokens: 0, class: "estimated", floor: true, coverage: 0 }, "tokens:null consumed something and measured nothing");
});

test("a refusal before any spend is an exact 0: metered, never a floor, never unmetered (#507)", () => {
  const refused = (over = {}) => rec({ jobId: "r-1", outcome: "policy", reason: "portfolio-snapshot-oversize", exitCode: null, turns: null, tokens: null, budgetReserved: false, ...over });
  const alone = fold([refused()]);
  assert.deepEqual(alone.provenance.total, { tokens: 0, class: "metered", floor: false });
  assert.equal(alone.provenance.runsTotal, 1);
  assert.equal(alone.provenance.runsUnmetered, 0);
  assert.equal(alone.provenance.runsUnledgered, 0);
  assert.deepEqual(alone.daily.find((d) => d.day === "2026-07-14").amount, { tokens: 0, class: "metered", floor: false });
  const beside = fold([ledgeredMetered, refused(), refused({ jobId: "r-2", outcome: "failed", reason: "container-never-started" })]);
  assert.deepEqual(beside.provenance.total, { tokens: 1500, class: "metered", floor: false }, "it leaves a metered bucket metered and exact");
  // Each of the three is needed: without any one of them the record may be a run that spent.
  const floors = [
    ["a pre-meter record of a run that started (no budgetReserved field)", (() => { const r = refused(); delete r.budgetReserved; return r; })()],
    ["budgetReserved null", refused({ budgetReserved: null })],
    ["budgetReserved true: the slot is held, so a container may have run", refused({ budgetReserved: true })],
    ["a container exit with no exit line", refused({ exitCode: 1 })],
    ["the pre-#25 shape: a completed run that recorded nothing", preTokens],
  ];
  for (const [what, r] of floors) {
    const f = fold([r]);
    assert.equal(f.provenance.total.floor, true, what);
    assert.equal(f.provenance.runsUnmetered, 1, what);
  }
});

test("a refusal before any spend stays out of plan math: no attribution, no demotion, no what-if run (#507)", () => {
  const refusal = (jobId, over = {}) => rec({ jobId, endedAt: "2026-07-14T12:00:00.000Z", outcome: "policy", reason: "token-cap", exitCode: null, turns: null, tokens: null, budgetReserved: false, provider: "kimi-coding", model: "kimi-k2", ...over });
  const refusals = [refusal("r-1"), refusal("r-2"), refusal("r-3")];
  const windows = [{ id: "5h", kind: "rolling", hours: 5, per: "5h", rolling: true, unit: "requests", limit: null }];
  const alone = fold([planCovered], { subscriptions: [sub({ windows })] });
  const beside = fold([planCovered, ...refusals], { subscriptions: [sub({ windows })] });
  // The plan's numbers: the refusals named its provider and model, and still never ran on it.
  for (const key of ["attributedRuns", "attributedTokens", "anyFloor", "windows"]) {
    assert.deepEqual(beside.plans[0][key], alone.plans[0][key], key);
  }
  // A refusal is classless, so it neither demotes nor dilutes coverage.
  assert.deepEqual(beside.provenance.total, alone.provenance.total);
  assert.equal(beside.provenance.total.class, "metered");
  const mixed = fold([planCovered, ledgeredMetered, ...refusals]);
  assert.equal(mixed.provenance.total.class, "metered", "both measured runs are metered; the refusals left out entirely");
  assert.ok(!("coverage" in mixed.provenance.total), "nothing demoted it, so there is no coverage to report");
  // A bucket of refusals alone is vacuously exact: metered 0, no floor.
  assert.deepEqual(fold(refusals).provenance.total, { tokens: 0, class: "metered", floor: false });
  // The what-if: a refusal is no run of the flow, so it is neither extrapolated nor counted as excluded.
  const target = { provider: "anthropic", id: "claude-sonnet-4", contextWindow: 200_000 };
  const plain = whatIfFlow({ records: [ledgeredMetered], flow: "fix", target });
  const withRefusals = whatIfFlow({ records: [ledgeredMetered, ...refusals], flow: "fix", target });
  assert.deepEqual(withRefusals, plain);
  assert.deepEqual(whatIfFlow({ records: refusals, flow: "fix", target }), whatIfFlow({ records: [], flow: "fix", target }), "a flow that was only refused never ran");
});

test("floor: the completeness counters floor the run; boundExceeded and the guard's dead keys do not", () => {
  const run = (extra) => rec({ jobId: "c-1", tokens: { ...tok(0), ...extra }, usage: usage([row("anthropic", "claude-sonnet-4")]) });
  const floorOf = (extra) => fold([run(extra)]).provenance.total.floor;
  assert.equal(floorOf({ childTotal: 900, childProcesses: 2, unmeteredChildren: 0 }), false, "a metered child's tokens are in the total");
  assert.equal(floorOf({ childTotal: 900, childProcesses: 2, unmeteredChildren: 1 }), true, "a pi child the runner could not count");
  assert.equal(floorOf({ unresolved: 1 }), true, "a call the meter could not finish counting");
  assert.equal(floorOf({ usageUnreported: 1 }), true, "a call whose usage the provider broke");
  assert.equal(floorOf({ boundExceeded: 1 }), false, "the guard's counter is dead with the guard: never a floor here");
  for (const key of ["longContext", "costUnjudged", "costUnanswered", "costUnreported", "costCapMicros", "costRefused"]) {
    assert.equal(floorOf({ [key]: 1 }), false, `${key}: a retired field, ignored`);
  }
  // Absence is exact: an image that never looked is not a floor, or every old record would read >=.
  assert.equal(floorOf({}), false);
  // A present counter that is not a whole number at least 0 is a floor, as the worker reads anything but 0.
  for (const key of ["unresolved", "usageUnreported", "unmeteredChildren"]) {
    for (const value of [-1, 0.5, Number.NaN, "1", null]) assert.equal(floorOf({ [key]: value }), true, `${key}: ${String(value)}`);
    assert.equal(floorOf({ [key]: 0 }), false, `${key}: 0`);
  }
});

test("daily: UTC dayKey buckets over endedAt -- 23:59Z and 00:01Z land on different days -- with gap days present", () => {
  const nowMs = Date.parse("2026-07-08T12:00:00.000Z");
  const a = rec({ jobId: "a", endedAt: "2026-07-05T23:59:00.000Z", tokens: tok(0), usage: usage([row("anthropic", "claude-sonnet-4")]), provider: "anthropic", model: "claude-sonnet-4" });
  const b = rec({ jobId: "b", endedAt: "2026-07-06T00:01:00.000Z", tokens: tok(0), usage: usage([row("anthropic", "claude-sonnet-4")]), provider: "anthropic", model: "claude-sonnet-4" });
  const f = fold([a, b], { nowMs });
  assert.deepEqual(f.daily.map((d) => d.day), ["2026-07-05", "2026-07-06", "2026-07-07", "2026-07-08"]);
  assert.deepEqual(f.daily.map((d) => d.runs), [1, 1, 0, 0]);
  assert.deepEqual(f.daily[0].amount, { tokens: 1500, class: "metered", floor: false });
  assert.deepEqual(f.daily[1].amount, { tokens: 1500, class: "metered", floor: false });
  assert.deepEqual(f.daily[2].amount, { tokens: 0, class: "metered", floor: false }, "a gap day is a zero-run ENTRY, so a sparkline renders quiet days as quiet");
  assert.deepEqual(f.window, { fromMs: Date.parse("2026-07-05T23:59:00.000Z"), toMs: nowMs, days: 3, firstRunMs: Date.parse("2026-07-05T23:59:00.000Z") });
});

test("an empty window folds to the empty shape, not an error", () => {
  const f = fold([]);
  assert.deepEqual(f.window, { fromMs: NOW, toMs: NOW, days: 0, firstRunMs: null });
  assert.deepEqual(f.daily, []);
  assert.deepEqual(f.byFlow, []);
  assert.deepEqual(f.byModel, []);
  assert.deepEqual(f.provenance.total, { tokens: 0, class: "metered", floor: false }, "vacuously metered: 0, fully measured");
});

// ---- the requested window (issue #175) ----

test("COSTS_WINDOWS and costsSinceMs: the one window vocabulary, 7d/30d spans and the UTC month edge", () => {
  assert.deepEqual([...COSTS_WINDOWS], ["7d", "30d", "mtd"]);
  const nowMs = Date.parse("2026-07-16T09:30:00.000Z");
  assert.equal(costsSinceMs("7d", nowMs), nowMs - 7 * 24 * 60 * 60 * 1000);
  assert.equal(costsSinceMs("30d", nowMs), nowMs - 30 * 24 * 60 * 60 * 1000);
  assert.equal(costsSinceMs("mtd", nowMs), Date.parse("2026-07-01T00:00:00.000Z"));
});

test("sinceMs spans the window the caller asked about: the daily series still starts at the first run", () => {
  const covered = { ...planCovered, endedAt: "2026-07-01T00:00:00.000Z" };
  const sinceMs = NOW - 30 * 24 * 60 * 60 * 1000;
  const f = fold([covered], { sinceMs });
  assert.deepEqual(f.window, { fromMs: sinceMs, toMs: NOW, days: 30, firstRunMs: Date.parse("2026-07-01T00:00:00.000Z") });
  // The daily series still starts at the FIRST RUN, not the requested edge: leading zero cells would
  // compress a young deployment's history; firstRunMs lets a renderer pad if it wants the full window.
  assert.equal(f.daily[0].day, "2026-07-01");
});

test("sinceMs edge cases: a future edge clamps to a 1-day window, and an empty requested window keeps its span", () => {
  const future = fold([], { sinceMs: NOW + 5 * 24 * 60 * 60 * 1000 });
  assert.deepEqual(future.window, { fromMs: NOW, toMs: NOW, days: 1, firstRunMs: null });
  const empty = fold([], { sinceMs: NOW - 7 * 24 * 60 * 60 * 1000 });
  assert.equal(empty.window.days, 7, "the operator asked about 7 days; that nothing ran does not shrink the question");
  assert.deepEqual(empty.daily, []);
});

// ---- dailyByFlow (issue #181, the line charts) ----

test("dailyByFlow: every flow gap-padded over the SHARED span, mixed days demoted, keys beside labels", () => {
  const nowMs = Date.parse("2026-07-08T12:00:00.000Z");
  const fixA = rec({ jobId: "a", flow: "fix", endedAt: "2026-07-05T10:00:00.000Z", tokens: tok(0), usage: usage([row("anthropic", "claude-sonnet-4")]), provider: "anthropic", model: "claude-sonnet-4" });
  const fixB = rec({ jobId: "b", flow: "fix", endedAt: "2026-07-07T10:00:00.000Z", tokens: tok(0), usage: usage([row("anthropic", "claude-sonnet-4")]), provider: "anthropic", model: "claude-sonnet-4" });
  const noflow = rec({ jobId: "c", flow: null, endedAt: "2026-07-06T10:00:00.000Z", tokens: tok(0), usage: usage([row("qwen-token-plan", "deepseek-v4-pro")]), provider: "qwen-token-plan", model: "deepseek-v4-pro" });
  const f = fold([fixA, fixB, noflow], { nowMs });

  assert.deepEqual(f.dailyByFlow.map((r) => [r.flow, r.flowKey]), [["fix", "fix"], ["(no flow)", null]], "window total desc; machine key beside the label, null for the no-flow bucket");
  const days = (r) => r.days.map((d) => d.day);
  assert.deepEqual(days(f.dailyByFlow[0]), ["2026-07-05", "2026-07-06", "2026-07-07", "2026-07-08"], "the shared cursor span");
  assert.deepEqual(days(f.dailyByFlow[1]), days(f.dailyByFlow[0]), "EVERY flow shares the x-domain -- multiples are only comparable on one axis");
  const fix = f.dailyByFlow[0];
  assert.deepEqual(fix.days.map((d) => d.runs), [1, 0, 1, 0], "a flow's quiet day is a zero-run entry, exactly as the global series keeps it");
  assert.deepEqual(fix.days[1].amount, { tokens: 0, class: "metered", floor: false }, "an empty bucket is vacuously metered 0");
  assert.deepEqual(f.dailyByFlow[1].days[1].amount.class, "metered", "a token-less run is still exact: nothing was measured, nothing is missing");
});

test("dailyByFlow: empty fold folds to [] and the series shares daily's first-run origin", () => {
  assert.deepEqual(fold([]).dailyByFlow, []);
  const sinceMs = NOW - 30 * 24 * 60 * 60 * 1000;
  const one = rec({ jobId: "o", flow: "fix", endedAt: "2026-07-14T10:00:00.000Z", tokens: tok(0), usage: usage([row("anthropic", "claude-sonnet-4")]), provider: "anthropic", model: "claude-sonnet-4" });
  const f = fold([one], { sinceMs });
  assert.equal(f.dailyByFlow[0].days[0].day, f.daily[0].day, "same origin as the global series: no month of leading zero cells");
  assert.equal(f.dailyByFlow[0].days.length, f.daily.length, "same span too");
});

// ---- byFlow ----

test("byFlow groups on flow with '(no flow)' for null, sorts by total desc, and folds token amounts", () => {
  const f = fold([ledgeredMetered, planCovered, zeroRatedUnmatched], { subscriptions: [sub()] });
  assert.deepEqual(f.byFlow.map((x) => x.flow), ["fix", "(no flow)"]);
  // flowKey is the machine key beside the display label: null for the no-flow bucket, so a what-if
  // filter matching `flow ?? null` can target it -- the display label matches no record (issue #175).
  assert.deepEqual(f.byFlow.map((x) => x.flowKey), ["fix", null]);
  const fix = f.byFlow[0];
  assert.equal(fix.runs, 2);
  assert.equal(fix.tokens, 1500 + 6_000_000);
  assert.equal(fix.amount.tokens, 6_000_000 + 1500);
  assert.equal(fix.amount.class, "metered", "both runs measured complete: the flow sum is exact");
  const noflow = f.byFlow[1];
  assert.equal(noflow.amount.tokens, 1500, "the token-plan run's own ledger total, as recorded");
  assert.equal(noflow.amount.class, "metered");
});

// ---- byModel ----

test("byModel attribution ladder: ledger rows, whole-run fallback via record.provider/model, then ('unknown','unknown')", () => {
  const f = fold([ledgeredMetered, preLedger, legacyNoModel, planCovered, zeroRatedUnmatched], { subscriptions: [sub()] });
  assert.deepEqual(
    f.byModel.map((m) => `${m.provider}/${m.model}`),
    ["kimi-coding/kimi-k2", "anthropic/claude-sonnet-4", "qwen-token-plan/deepseek-v4-pro", "unknown/unknown"],
    "sorted by total desc, ties alphabetical",
  );
  const [kimi, sonnet, zeroRated, unknown] = f.byModel;
  assert.equal(sonnet.runs, 2, "the ledgered run and the pre-ledger whole-run fallback");
  assert.equal(sonnet.calls, 2 + 3, "ledger row calls plus the pre-ledger run's flat tokens.calls");
  assert.equal(sonnet.tokens, 3000);
  assert.deepEqual(sonnet.amount, { tokens: 3000, class: "metered", floor: false });
  assert.deepEqual(unknown.amount, { tokens: 1500, class: "metered", floor: false }, "a legacy record with no provider/model attributes to ('unknown','unknown'), never to a guess");
  assert.deepEqual(kimi.amount, { tokens: 6_000_000, class: "metered", floor: false });
  assert.deepEqual(zeroRated.amount, { tokens: 1500, class: "metered", floor: false });
});

// ---- byTrigger / byRepo / foldTriggerCosts (issue #175) ----

test("byTrigger buckets on the passed-in join; chained/manual/unattributed are explicit and pinned to the tail", () => {
  const cronRun = rec({ jobId: "repeat:nightly:1752480000000", flow: "fix", tokens: tok(0), usage: usage([row("anthropic", "claude-sonnet-4")]), provider: "anthropic", model: "claude-sonnet-4" });
  const forgeRun = rec({ jobId: "gh-1", kind: "github", target: "acme/api#12", flow: "triage", outcome: "failed", tokens: tok(0), usage: usage([row("anthropic", "claude-sonnet-4")]), provider: "anthropic", model: "claude-sonnet-4" });
  const refusedJoin = rec({ jobId: "gh-2", kind: "github", target: "acme/api#13", flow: "triage", tokens: tok(0), usage: usage([row("anthropic", "claude-sonnet-4")]), provider: "anthropic", model: "claude-sonnet-4" });
  const chained = rec({ jobId: "ch-1", parentJobId: "repeat:nightly:1752480000000", flow: "fix", tokens: tok(0), usage: usage([row("anthropic", "claude-sonnet-4")]), provider: "anthropic", model: "claude-sonnet-4" });
  const manual = rec({ jobId: "loc-1", tokens: tok(0), usage: usage([row("anthropic", "claude-sonnet-4")]), provider: "anthropic", model: "claude-sonnet-4" });
  // The join is the read-model's job (attributeRunsToTriggers); the fold's contract is this SHAPE.
  const triggerJoin = {
    byJobId: {
      "repeat:nightly:1752480000000": { key: "trigger:0", index: 0, type: "cron", label: "nightly 0 3 * * *" },
      "gh-1": { key: "trigger:2", index: 2, type: "label", label: "any[dispatch]" },
      "gh-2": { key: "unattributed", index: null, type: null, label: null },
    },
  };
  const f = foldCosts({ records: [manual, chained, refusedJoin, forgeRun, cronRun], subscriptions: [], nowMs: NOW, triggerJoin });

  assert.deepEqual(
    f.byTrigger.map((t) => t.key),
    ["trigger:2", "trigger:0", "chained", "manual", "unattributed"],
    "real triggers by total desc, ties alphabetical by label, then the honesty tail in its fixed order",
  );
  const [label, nightly, chainedRow, manualRow, unattributed] = f.byTrigger;
  assert.equal(nightly.label, "nightly 0 3 * * *");
  assert.deepEqual(nightly.outcomes, { completed: 1, policy: 0, failed: 0 });
  assert.equal(nightly.failedAmount, null, "no failed member, no failed figure -- null, not 0");
  assert.deepEqual(nightly.amount, { tokens: 1500, class: "metered", floor: false });
  assert.deepEqual(label.outcomes, { completed: 0, policy: 0, failed: 1 });
  assert.deepEqual(label.failedAmount, { tokens: 1500, class: "metered", floor: false }, "what the trigger's failures consumed, typed like every amount");
  assert.equal(chainedRow.label, "(chained runs)");
  assert.equal(manualRow.label, "(manual/local)");
  assert.equal(unattributed.label, "(unattributed)");
  assert.equal(unattributed.runs, 1, "a refused join stays visible, never blended into manual");

  assert.equal(fold([cronRun]).byTrigger, null, "no join wired -> null, because 'not computed' and 'nothing attributed' are different sentences");
});

test("byRepo groups on the stripped target, forge-qualified; local targets ride whole and a missing target is its own stated bucket", () => {
  const gh1 = rec({ jobId: "r1", kind: "github", target: "acme/api#12", tokens: tok(0), usage: usage([row("anthropic", "claude-sonnet-4")]), provider: "anthropic", model: "claude-sonnet-4" });
  const gh2 = rec({ jobId: "r2", kind: "github", target: "acme/api#34", tokens: tok(0), usage: usage([row("anthropic", "claude-sonnet-4")]), provider: "anthropic", model: "claude-sonnet-4" });
  const gl = rec({ jobId: "r3", kind: "gitlab", target: "group/proj!3", tokens: tok(0), usage: usage([row("anthropic", "claude-sonnet-4")]), provider: "anthropic", model: "claude-sonnet-4" });
  const local = rec({ jobId: "r4", target: "local:site", tokens: tok(0), usage: usage([row("anthropic", "claude-sonnet-4")]), provider: "anthropic", model: "claude-sonnet-4" });
  const bare = rec({ jobId: "r5", target: null, tokens: tok(0), usage: usage([row("anthropic", "claude-sonnet-4")]), provider: "anthropic", model: "claude-sonnet-4" });
  const f = fold([gh1, gh2, gl, local, bare]);
  assert.deepEqual(
    f.byRepo.map((r) => [r.label, r.runs, r.kind]),
    [
      ["github:acme/api", 2, "github"],
      ["(no target)", 1, "local"],
      ["gitlab:group/proj", 1, "gitlab"],
      ["local:site", 1, "local"],
    ],
    "total desc, ties alphabetical; the issue/MR tail stripped; a target-less record is stated, not dropped",
  );
  assert.equal(f.byRepo[0].amount.tokens, 3000);
  assert.equal(f.byRepo.find((r) => r.key === null).runs, 1, "machine key null for the no-target bucket -- the flowKey lesson");
});

test("issue #498: one repo on two forges is two byRepo rows; a bare repo filter selects both, a qualified one selects one", () => {
  const priced = (jobId, kind, cost) => rec({ jobId, kind, target: "acme/web#1", tokens: tok(cost), usage: usage([row("anthropic", "claude-sonnet-4", { cost })]), provider: "anthropic", model: "claude-sonnet-4" });
  const gh = priced("g1", "github", 0.5);
  const fj = priced("f1", "forgejo", 0.25);
  const f = fold([gh, fj]);
  assert.deepEqual(f.byRepo.map((r) => [r.key, r.label, r.runs, r.kind]), [["forgejo:acme/web", "forgejo:acme/web", 1, "forgejo"], ["github:acme/web", "github:acme/web", 1, "github"]]);
  assert.equal(repoKeyOf(gh), "github:acme/web");
  assert.equal(repoKeyOf(rec({ target: "local:site" })), "local:site", "a local record keys by its target as before");
  assert.equal(repoKeyOf(rec({ target: null })), null);
  // dispatch_costs filters through recordInRepo: bare = every forge (today's result), qualified = one forge.
  assert.deepEqual([gh, fj].filter((r) => recordInRepo(r, "acme/web")).map((r) => r.jobId), ["g1", "f1"]);
  assert.deepEqual([gh, fj].filter((r) => recordInRepo(r, "github:acme/web")).map((r) => r.jobId), ["g1"]);
  assert.deepEqual([gh, fj].filter((r) => recordInRepo(r, "forgejo:acme/web")).map((r) => r.jobId), ["f1"]);
  assert.equal(recordInRepo(rec({ target: "local:site" }), "local:site"), true, "a local target still filters by its key");
  assert.equal(recordInRepo(gh, "gitlab:acme/web"), false);
  assert.equal(recordInRepo(gh, ""), false);
});

// ---- byProject (issue #499 part C) ----

test("byProject folds by the project id each record carries, with typed dollars and a (no project) bucket", () => {
  const priced = (jobId, project, cost, over = {}) => rec({ jobId, project, tokens: tok(cost), usage: usage([row("anthropic", "claude-sonnet-4", { cost })]), provider: "anthropic", model: "claude-sonnet-4", ...over });
  const a = priced("p1", "shop", 0.5, { kind: "github", target: "acme/web#1" });
  const b = priced("p2", "shop", 0.25, { kind: "local", target: "local:site" });
  const c = priced("p3", "tools", 0.1);
  const none = priced("p4", null, 0.05);
  const old = priced("p5", undefined, 0.02); // recorded before the field existed
  delete old.project;
  const junk = priced("p6", "Not An Id", 0.01); // a hand-edited value is not an id: no project
  const f = fold([a, b, c, none, old, junk]);
  assert.deepEqual(f.byProject.map((r) => [r.key, r.label, r.runs]), [[null, "(no project)", 3], ["shop", "shop", 2], ["tools", "tools", 1]]);
  assert.deepEqual(f.byProject.find((r) => r.key === "shop").amount, { tokens: 3000, class: "metered", floor: false }, "the same typed amounts as every bucket");
  assert.equal(f.byProject.find((r) => r.key === null).tokens, 3 * 1500, "tokens summed per bucket");
  const total = f.byProject.reduce((sum, r) => sum + r.amount.tokens, 0);
  assert.equal(total, 9000, "every run lands in exactly one bucket");
});

test("byProject is a Map fold: an id that is a prototype key keeps its own row", () => {
  const priced = (jobId, project, cost) => rec({ jobId, project, tokens: tok(cost), usage: usage([row("anthropic", "claude-sonnet-4", { cost })]), provider: "anthropic", model: "claude-sonnet-4" });
  const f = fold([priced("c1", "constructor", 0.5), priced("c2", "constructor", 0.25), priced("t1", "tostring", 0.1), priced("v1", "valueof", 0.05)]);
  assert.deepEqual(f.byProject.map((r) => [r.key, r.runs]), [["constructor", 2], ["tostring", 1], ["valueof", 1]]);
  assert.equal(f.byProject.find((r) => r.key === "constructor").amount.tokens, 3000);
});

test("byProject never re-attributes: a member's old record stays (no project), whatever the projects file says now", () => {
  // The fold takes no projects argument at all: the record's own field is the only input.
  const before = rec({ jobId: "o1", kind: "github", target: "acme/web#1", project: null, tokens: tok(0) });
  assert.deepEqual(fold([before]).byProject.map((r) => [r.key, r.runs]), [[null, 1]]);
});

test("the project filter and key: an id selects its runs, anything else none; the rule matches the worker's", () => {
  assert.equal(PROJECT_KEY_RE.source, PROJECT_ID_RE.source, "the restated rule is the worker's rule");
  const r = rec({ project: "shop" });
  assert.equal(projectKeyOf(r), "shop");
  assert.equal(projectKeyOf(rec({ project: null })), null);
  assert.equal(projectKeyOf(rec({ project: "Shop" })), null);
  assert.equal(recordInProject(r, "shop"), true);
  assert.equal(recordInProject(r, "tools"), false);
  assert.equal(recordInProject(rec({ project: null }), "(no project)"), false, "the display label is never a key");
  assert.equal(recordInProject(r, ""), false);
});

test("repoOfTarget strips exactly the forge issue/MR tail and nothing else", () => {
  assert.equal(repoOfTarget("acme/api#12"), "acme/api");
  assert.equal(repoOfTarget("group/proj!3"), "group/proj");
  assert.equal(repoOfTarget("local:site"), "local:site", "no numeric tail: rides through whole");
  assert.equal(repoOfTarget("acme/api"), "acme/api");
  assert.equal(repoOfTarget(""), null);
  assert.equal(repoOfTarget(null), null);
  assert.equal(repoOfTarget("#12"), null, "a bare tail strips to nothing and nothing is null, not an empty-string bucket");
});

test("foldTriggerCosts maps ONLY real triggers, keyed by the graph node id", () => {
  const cronRun = rec({ jobId: "repeat:nightly:1752480000000", tokens: tok(0), usage: usage([row("anthropic", "claude-sonnet-4")]), provider: "anthropic", model: "claude-sonnet-4" });
  const cronRun2 = rec({ jobId: "repeat:nightly:1752483600000", tokens: tok(0), usage: usage([row("anthropic", "claude-sonnet-4")]), provider: "anthropic", model: "claude-sonnet-4" });
  const manual = rec({ jobId: "loc-1", tokens: tok(1), usage: usage([row("anthropic", "claude-sonnet-4")]), provider: "anthropic", model: "claude-sonnet-4" });
  const refused = rec({ jobId: "gh-2", kind: "github", tokens: tok(1), usage: usage([row("anthropic", "claude-sonnet-4")]), provider: "anthropic", model: "claude-sonnet-4" });
  const triggerJoin = {
    byJobId: {
      "repeat:nightly:1752480000000": { key: "trigger:3", index: 3, type: "cron", label: "nightly 0 3 * * *" },
      "repeat:nightly:1752483600000": { key: "trigger:3", index: 3, type: "cron", label: "nightly 0 3 * * *" },
      "gh-2": { key: "unattributed", index: null, type: null, label: null },
    },
  };
  const map = foldTriggerCosts({ records: [cronRun, cronRun2, manual, refused], triggerJoin });
  assert.deepEqual(Object.keys(map), ["trigger:3"], "honesty buckets have no node to badge and stay out of the map");
  assert.equal(map["trigger:3"].runs, 2);
  assert.deepEqual(map["trigger:3"].amount, { tokens: 3000, class: "metered", floor: false });
});

// ---- plans ----

test("plan attribution: run/token tallies are FACTS; the money verdicts died with pricing", () => {
  const covered = { ...planCovered, endedAt: "2026-07-01T00:00:00.000Z" };
  const coveredNoLedger = rec({
    jobId: "plan-2",
    endedAt: "2026-07-02T00:00:00.000Z",
    tokens: tok(0),
    usage: null,
    provider: "kimi-coding",
    model: "kimi-k2",
  });
  const f = fold([covered, coveredNoLedger], { subscriptions: [sub()] });
  const plan = f.plans[0];
  assert.equal(plan.id, "kimi");
  assert.equal(plan.vendor, "Moonshot AI");
  assert.equal(plan.hypothetical, false);
  assert.equal(plan.attributedRuns, 2);
  assert.equal(plan.attributedTokens, 6_000_000 + 1500);
  assert.equal(plan.anyFloor, false);
  // No verdict, no proration, no apiEquiv: prices died with the cost era (DES-TOKEN-RESERVE-AND-SETTLE).
  assert.ok(!("verdict" in plan) && !("apiEquiv" in plan) && !("amortizedPerRun" in plan) && !("price" in plan));
  assert.equal(f.provenance.runsUnledgered, 1);
});

test("peak windows: a rolling 5h window takes a true sliding max; non-rolling approximates at day grain; limits are FACTS ONLY", () => {
  const windows = [
    { per: "5h", rolling: true, unit: "prompts", limit: 200, scope: null },
    { per: "5h", rolling: false, unit: null, limit: null, scope: null },
  ];
  const at = (jobId, iso) =>
    rec({
      jobId,
      endedAt: iso,
      tokens: tok(0, { input: 800, output: 200 }),
      usage: usage([row("kimi-coding", "kimi-k2", { input: 800, output: 200 })]),
      provider: "kimi-coding",
      model: "kimi-k2",
    });
  const f = fold(
    [at("w1", "2026-07-14T00:00:00.000Z"), at("w2", "2026-07-14T01:00:00.000Z"), at("w3", "2026-07-14T06:00:00.000Z")],
    { subscriptions: [sub({ windows })] },
  );
  const [rolling, calendar] = f.plans[0].windows;
  assert.equal(rolling.peakRuns, 2, "00:00 and 01:00 share a 5h window; 06:00 does not");
  assert.equal(rolling.peakTokens, 2000);
  assert.equal(rolling.limit, 200, "the declared limit rides through verbatim");
  assert.equal(rolling.unit, "prompts");
  assert.equal(calendar.peakRuns, 3, "non-rolling 5h approximates at day grain -- an over-count, never an undercount");
  assert.equal(calendar.limit, null, "null = vendor undisclosed, still verbatim");
  assert.ok(!("remaining" in rolling) && !("burnDown" in rolling), "peaks are FACTS; no remaining/burn-down is ever computed");
});

// ---- provenance ----

test("provenance: run tallies, and ratesDrifted counts records priced by a different pi-ai than the pin", () => {
  const drifted = {
    ...ledgeredMetered,
    jobId: "drift-1",
    usage: usage([row("anthropic", "claude-sonnet-4")], { piAi: "1.0.0" }),
  };
  const f = fold([ledgeredMetered, drifted, preLedger, preTokens], { piAiPin: "1.2.3" });
  assert.equal(f.provenance.runsTotal, 4);
  assert.equal(f.provenance.runsUnmetered, 1, "pre-#25: tokens null");
  assert.equal(f.provenance.runsUnledgered, 1, "pre-ledger: tokens but no usage");
  assert.equal(f.provenance.ratesDrifted, 1);
  assert.equal(f.provenance.piAiPin, "1.2.3");
  const unpinned = fold([drifted], { piAiPin: null });
  assert.equal(unpinned.provenance.ratesDrifted, 0, "an unknown pin cannot accuse a record of drifting");
});

test("provenance: runsLedgerTruncated counts runs whose ledger folded rows into `other` past the 8-row cap", () => {
  const truncated = {
    ...ledgeredMetered,
    jobId: "trunc-1",
    usage: usage([row("anthropic", "claude-sonnet-4"), row("other", "other")], { truncated: 3 }),
  };
  const f = fold([ledgeredMetered, truncated]);
  assert.equal(f.provenance.runsLedgerTruncated, 1, "the run's per-model attribution is partly anonymous and the fold says so");
  assert.equal(fold([ledgeredMetered]).provenance.runsLedgerTruncated, 0);
});

// ---- whatIfFlow ----

test("whatIfFlow: the median per-run token total (outlier-resistant) times observed runs, with the context share beside it", () => {
  const mk = (jobId, input) =>
    rec({
      jobId,
      endedAt: "2026-07-14T10:00:00.000Z",
      tokens: tok(0, { input, output: 0 }),
      usage: usage([row("anthropic", "claude-sonnet-4", { input, output: 0 })]),
      provider: "anthropic",
      model: "claude-sonnet-4",
    });
  const unledgered = rec({ jobId: "u1", tokens: tok(0), usage: null, provider: "anthropic", model: "claude-sonnet-4" });
  const res = whatIfFlow({
    records: [mk("m1", 100_000), mk("m2", 125_000), mk("m3", 1_000_000), unledgered],
    flow: "fix",
    target: { provider: "anthropic", id: "claude-sonnet-4", contextWindow: 200_000 },
  });
  assert.equal(res.class, "estimated");
  assert.equal(res.perRun, 125_000, "median input 125k -- the 1M outlier run does not move the estimate");
  assert.equal(res.tokens, 500_000, "per-run median times ALL 4 observed runs of the flow");
  assert.equal(res.coverage, 0.75);
  assert.equal(res.excluded, 1, "the un-ledgered run is excluded from the median, counted here instead");
  assert.equal(res.contextWindow, 200_000);
  assert.equal(res.contextShare, 125_000 / 200_000, "the profile comparison: how much of one context window a median run occupies");
});

test("whatIfFlow: no ledgered runs -> class 'unknown', never a number that looks like an answer (OQ-002's band died with its unit)", () => {
  const unledgered = rec({ jobId: "u1", flow: "mystery", tokens: tok(0), usage: null });
  const twice = [unledgered, { ...unledgered, jobId: "u2" }];
  assert.deepEqual(
    whatIfFlow({ records: twice, flow: "mystery", target: { provider: "anthropic", id: "claude-sonnet-4" } }),
    { class: "unknown", note: "unmeasured", runs: 2 },
  );
  assert.deepEqual(
    whatIfFlow({ records: [], flow: "never-ran", target: { provider: "anthropic", id: "claude-sonnet-4" } }),
    { class: "unknown", note: "unmeasured", runs: 1 },
  );
});

test("whatIfRuns: the SAME ledgered runs' token totals, no reprice, partial ledgers excluded and counted (#749)", () => {
  const m1 = rec({ jobId: "m1", tokens: tok(0), usage: usage([row("anthropic", "claude-sonnet-4", { input: 100_000, output: 0 })]) });
  const m2 = rec({ jobId: "m2", tokens: tok(0), usage: usage([row("anthropic", "claude-sonnet-4", { input: 50_000, output: 0 })]) });
  const partial = rec({ jobId: "p1", tokens: tok(0), usage: null, provider: "anthropic", model: "claude-sonnet-4" });
  const res = whatIfRuns({ records: [m1, m2, partial], target: { provider: "anthropic", id: "claude-sonnet-4" } });
  assert.equal(res.class, "estimated");
  assert.equal(res.tokens, 150_000);
  assert.equal(res.runs, 2);
  assert.equal(res.excluded, 1);
  assert.equal(res.coverage, 2 / 3);
});

test("plan-covered buckets are just metered: the plan chip died with pricing, and floors still demote", () => {
  // combineContributions once kept `plan:<id>` for a bucket every run of which one plan covered
  // (REQ-COST-ANALYTICS (b), a plan-covered run never rendered as $0.00). With prices retired there
  // is no plan class to keep: a covered run's tokens are tokens, and the bucket reads like any other.
  const covered = (jobId) => ({ ...planCovered, jobId });
  const metered = { ...ledgeredMetered, jobId: "m-1" };
  const subs = [sub(), sub({ id: "zai-max", provider: "zai" })];
  const join = (keys) => ({ byJobId: Object.fromEntries(Object.entries(keys).map(([jobId, idx]) => [jobId, { key: `trigger:${idx}`, index: idx, type: "cron", label: `t${idx}` }])) });
  const map = foldTriggerCosts({ records: [covered("p-1"), covered("p-2"), metered], triggerJoin: join({ "p-1": 0, "p-2": 0, "m-1": 1 }) });
  assert.deepEqual(map["trigger:0"].amount, { tokens: 12_000_000, class: "metered", floor: false }, "all covered, all complete: metered at the recorded totals");
  assert.equal(map["trigger:1"].amount.class, "metered");
  // A floored run still demotes its bucket: the completeness rule is the only demotion left.
  const flooredPlan = { ...planCovered, jobId: "f-1", tokens: { ...planCovered.tokens, metered: false } };
  const floorMap = foldTriggerCosts({ records: [covered("p-9"), flooredPlan], triggerJoin: join({ "p-9": 5, "f-1": 5 }) });
  assert.equal(floorMap["trigger:5"].amount.class, "estimated", "a bucket holding a floor is estimated");
  assert.equal(floorMap["trigger:5"].amount.floor, true, "with its floor");
  // The fold's own by-trigger table agrees with the badge map, row for row.
  const f = foldCosts({ records: [covered("p-1"), covered("p-2"), metered], subscriptions: subs, nowMs: NOW, piAiPin: "1.2.3", sinceMs: null, triggerJoin: join({ "p-1": 0, "p-2": 0, "m-1": 1 }) });
  const byKey = Object.fromEntries(f.byTrigger.map((r) => [r.key, r.amount]));
  assert.deepEqual(byKey["trigger:0"], { tokens: 12_000_000, class: "metered", floor: false });
});
