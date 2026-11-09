import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleInsightsView, heldMoneyOf, spendSummaryOf, spendChartsOf, recordSpendOf, assembleBudgetView, assembleGraph } from "../src/insights-assembly.mjs";
import { costsSinceMs, whatIfRuns } from "../src/costs.mjs";
import { makeWhatIfReader } from "../src/console/whatif.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";
import { join } from "node:path";
import { writeFileSync } from "node:fs";

const NOW = Date.parse("2026-10-29T12:00:00Z");
const DAY = 86_400_000;
const pricing = { piAiVersion: () => "test", getPricedModel: () => ({}), isZeroRated: () => false, reprice: (q) => ({ usd: q.input + 2 * q.output + 3 * q.cacheRead + 4 * q.cacheWrite + 5 * q.cacheWrite1h, ratesVersion: "test" }) };
const run = (id, over = {}) => ({ jobId: id, flow: "fix", project: "site", endedAt: new Date(NOW - 1000).toISOString(), usage: { v: 1, truncated: 0, models: [{ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cacheWrite1h: 5, total: 15 }] }, tokens: { total: 15, metered: true }, ...over });

function readsFixture() {
  const calls = [];
  const watch = (name, value) => (...args) => (calls.push({ name, args }), typeof value === "function" ? value(...args) : value);
  return { calls, reads: {
    projects: watch("projects", { projects: [{ id: "site", name: "Site" }] }),
    costs: watch("costs", { fold: { byFlow: [] }, records: [] }),
    graph: watch("graph", {}), budget: watch("budget", { tokens: {}, windows: { rows: [] } }),
    allocation: watch("allocation", { window: "week" }), capacity: watch("capacity", {}), sizing: watch("sizing", {}),
    hosts: watch("hosts", { hosts: [] }), scan: watch("scan", []), subscriptions: watch("subscriptions", { subscriptions: [] }), settings: watch("settings", { overlay: {} }),
  } };
}

for (const [view, expected] of [
  ["capacity", ["capacity", "hosts"]],
  ["budget-split", ["projects", "allocation", "hosts", "scan"]],
  ["breakdown", ["projects", "costs"]],
]) test(`${view} reads only its own slices`, async () => {
  const { reads, calls } = readsFixture();
  await assembleInsightsView({}, "7d", { view, pricing, nowMs: NOW, envFn: () => ({}), reads });
  assert.deepEqual(calls.map((c) => c.name), expected);
});

test("allocation reasons are requested only for operator loads, viewer full paths stay off and counts use envelope window", async () => {
  const { reads, calls } = readsFixture();
  await assembleInsightsView({}, "30d", { view: "budget-split", role: "viewer", fullPaths: true, pricing, nowMs: NOW, reads });
  const options = calls.find((c) => c.name === "allocation").args[2];
  assert.equal(options.role, "viewer");
  assert.equal(options.fullPaths, false);
  assert.equal(calls.find((c) => c.name === "scan").args[0].sinceMs, costsSinceMs("week", NOW));
  calls.length = 0;
  await assembleInsightsView({}, "7d", { view: "budget-split", role: "operator", fullPaths: true, pricing, nowMs: NOW, reads });
  assert.equal(calls.find((c) => c.name === "allocation").args[2].role, "operator");
});

test("holds use actual published amounts, distinguish old rows from zero, and keep prior-day reservations out of today", () => {
  const hosts = [
    { name: "new", jobsMore: "0", jobs: JSON.stringify([{ id: "a", p: "site", at: NOW - 1000, h: 3_000_000, ha: NOW - 1000 }, { id: "b", p: "site", at: NOW - DAY, h: 5_000_000, ha: NOW - DAY }, { id: "c", p: "site", at: NOW - 1000, h: 0, ha: NOW - 1000 }]) },
    { name: "old", jobsMore: "0", jobs: JSON.stringify([{ id: "d", p: "site", at: NOW - 1000 }]) },
  ];
  assert.deepEqual(heldMoneyOf(hosts, { nowMs: NOW, project: "site" }), { heldTokens: 3_000_000, heldJobs: 1, unknownHosts: ["old"] });
});

test("missing or capped live lists are unknown rather than a claim of no holds", () => {
  const r = heldMoneyOf([{ name: "missing" }, { name: "capped", jobs: "[]", jobsMore: "1" }], { nowMs: NOW });
  assert.deepEqual(r.unknownHosts, ["missing", "capped"]);
});

test("today names the counter remainder and never turns it into held tokens", () => {
  const budget = { tokens: {}, windows: { rows: [{ ledger: "deployment", window: "day", counterTokens: 10_000_000, capTokens: 20_000_000 }] } };
  const r = spendSummaryOf({ records: [run("a", { tokensWindows: { reservedTokens: 2_000_000, settledTokens: 2_000_000, basis: "metered" } })], hosts: [], budget, nowMs: NOW });
  assert.equal(r.today.heldTokens, 0);
  assert.equal(r.today.settledTokens, 2_000_000);
  assert.equal(r.today.unattributedTokens, 8_000_000);
});

test("project windows are chosen where configured, else deployment fallback is explicit", () => {
  const budget = { tokens: {}, windows: { rows: [{ ledger: "deployment", window: "day", counterTokens: 9, capTokens: 20 }, { ledger: "scope", name: "project:site", window: "day", counterTokens: 3, capTokens: 10 }] } };
  assert.equal(spendSummaryOf({ records: [], hosts: [], budget, project: "site", nowMs: NOW }).today.usedTokens, 3);
  const fallback = spendSummaryOf({ records: [], hosts: [], budget, project: "other", nowMs: NOW });
  assert.equal(fallback.today.usedTokens, 9);
  assert.equal(fallback.projectFallback, true);
});

test("run-set estimate sums full token totals per run, excluding missing and partial ledgers", () => {
  const records = [run("a"), run("b", { flow: "review" }), run("missing", { usage: null }), run("partial", { usage: { truncated: 1, models: [{ input: 1 }] } })];
  const r = whatIfRuns({ records, target: { provider: "test", id: "model" } });
  assert.equal(r.tokens, 2 * 15);
  assert.equal(r.runs, 2);
  assert.equal(r.excluded, 2);
});

test("what-if cache partitions project, window and run selection over one bounded scan", async () => {
  let scans = 0;
  const records = [run("today"), run("old", { endedAt: new Date(NOW - 2 * DAY).toISOString() }), run("other", { project: "other" })];
  const reader = makeWhatIfReader({ pricing, scan: () => (scans++, records), now: () => NOW });
  const args = { model: "test/model", runs: "24h", project: "site" };
  assert.equal((await reader(args)).runSet.runs, 1);
  assert.equal((await reader({ ...args, runs: "week" })).runSet.runs, 2);
  assert.equal((await reader({ ...args, project: "other" })).runSet.runs, 1);
  assert.equal(scans, 1);
});

test("flow total uses the requested window count while the per-run median retains the scan's evidence", async () => {
  const records = [run("new"), run("old", { endedAt: new Date(NOW - 20 * DAY).toISOString() })];
  const reader = makeWhatIfReader({ pricing, scan: () => records, now: () => NOW });
  const result = (await reader({ model: "test/model", flow: "fix", range: "7d" })).result;
  assert.equal(result.windowRuns, 1);
  assert.equal(result.tokens, result.perRun);
});

test("24h and Monday week starts use the injected instant", () => {
  assert.equal(costsSinceMs("24h", NOW), NOW - DAY);
  assert.equal(costsSinceMs("week", NOW), Date.parse("2026-10-26T00:00:00Z"));
});

test("tokens never enter the job soft hold band", async () => {
  const dir = tempDir("insights-token-cap-");
  const settingsFile = join(dir, "settings.json");
  writeFileSync(settingsFile, JSON.stringify({ dailyTokenCap: 100, softHoldPct: 50 }));
  const view = await assembleBudgetView({ valkeyUrl: "redis://localhost:6379", settingsFile }, { redisFn: () => ({ get: async (key) => (key.startsWith("budget:tok:") ? "75" : "0"), disconnect() {} }), nowMs: NOW });
  assert.equal(view.tokens.spent, 75);
  assert.equal(view.tokens.state, "ok");
});

test("an unread host registry makes both held money and its reconciliation unknown", async () => {
  const { reads } = readsFixture();
  reads.hosts = async () => ({ unreachable: "not answering" });
  reads.budget = async () => ({ tokens: {}, windows: { rows: [{ ledger: "deployment", window: "day", counterTokens: 100, capTokens: 200 }] } });
  const got = await assembleInsightsView({}, "7d", { pricing, nowMs: NOW, envFn: () => ({}), reads });
  assert.equal(got.spend.today.heldTokens, null);
  assert.equal(got.spend.today.unattributedTokens, null);
  assert.equal(got.spend.today.hostsUnreadable, true);
});

test("a project weekly limit does not disguise a deployment daily counter as the project's", () => {
  const budget = { tokens: {}, windows: { rows: [{ ledger: "deployment", window: "day", counterTokens: 9, capTokens: 20 }, { ledger: "scope", name: "project:site", window: "week", counterTokens: 3, capTokens: 10 }] } };
  const got = spendSummaryOf({ records: [], hosts: [], budget, project: "site", nowMs: NOW });
  assert.equal(got.today.usedTokens, 9);
  assert.equal(got.today.basis, "deployment");
  assert.equal(got.today.projectFallback, true);
  assert.equal(got.week.usedTokens, 3);
  assert.equal(got.week.basis, "project:site");
});

test("a counter smaller than visible records is a reconciliation mismatch, never negative held money", () => {
  const budget = { tokens: {}, windows: { rows: [{ ledger: "deployment", window: "day", counterTokens: 1, capTokens: 20 }] } };
  const got = spendSummaryOf({ records: [run("r", { tokensWindows: { reservedTokens: 3, settledTokens: 3, basis: "metered" } })], hosts: [], budget, nowMs: NOW });
  assert.equal(got.today.heldTokens, 0);
  assert.equal(got.today.unattributedTokens, -2);
  assert.equal(got.today.reconciliationMismatch, true);
});

test("job and token counter keys use the supplied instant, even when the wall clock differs", async () => {
  const dir = tempDir("insights-injected-budget-");
  const settingsFile = join(dir, "settings.json");
  writeFileSync(settingsFile, "{}");
  const keys = [];
  await assembleBudgetView({ valkeyUrl: "redis://localhost:6379", settingsFile }, { nowMs: NOW, redisFn: () => ({ get: async (key) => (keys.push(key), "0"), disconnect() {} }) });
  assert.deepEqual(keys.sort(), ["budget:tok:2026-10-29"]);
});

test("Spend daily bars are settled facts, today's live holds are separate, and cost bins use metered runs only", () => {
  const records = [run("a", { usage: { v: 1, truncated: 0, models: [{ total: 2_000_000 }] }, tokens: { total: 2_000_000, metered: true }, tokensWindows: { reservedTokens: 2_000_000, settledTokens: 2_000_000, basis: "metered" } }), run("plan", { usage: { v: 1, truncated: 0, models: [{ total: 7_000_000 }] }, provider: "plan", model: "paid", tokens: { total: 7_000_000, metered: true }, tokensWindows: { reservedTokens: 7_000_000, settledTokens: 7_000_000, basis: "metered" } }), run("yesterday", { usage: { v: 1, truncated: 0, models: [{ total: 4_000_000 }] }, endedAt: new Date(NOW - DAY).toISOString(), tokens: { total: 4_000_000, metered: true }, tokensWindows: { reservedTokens: 4_000_000, settledTokens: 4_000_000, basis: "metered" } })];
  const r = spendChartsOf({ records, sinceMs: NOW - 2 * DAY, nowMs: NOW, jobCapTokens: 10_000_000, heldTokens: 3_000_000 });
  assert.equal(r.daily.at(-1).settledTokens, 9_000_000);
  assert.equal(r.daily.at(-1).heldTokens, 3_000_000);
  assert.equal(r.daily.at(-2).heldTokens, 0);
  assert.equal(r.histogram.reduce((sum, b) => sum + b.runs, 0), 3, "every metered run's tokens bin, a plan run's included: they consumed real tokens");
  assert.equal(r.histogram[2].runs, 1);
  assert.equal(r.histogram[4].runs, 1);
  assert.equal(r.histogram[7].runs, 1);
  assert.equal(r.largestRangeTokens, 7_000_000);
});

test("a fallback-meter run never enters the token bins, whatever its top-level model says", () => {
  const mixed = run("mixed", { provider: "paid", model: "api", tokens: { total: 15, metered: false } });
  const charts = spendChartsOf({ records: [mixed], sinceMs: NOW - DAY, nowMs: NOW, jobCapTokens: 10_000_000 });
  const summary = spendSummaryOf({ records: [mixed], hosts: [], budget: {}, nowMs: NOW });
  assert.equal(charts.meteredRangeRuns, 0, "the fallback meter's total is a floor, not a bin");
  assert.equal(summary.average.runs, 0, "and it is no metered run in the average either");
});

test("a 7M-token run with unreserved/0 stays in Today and the daily chart with no window configured", () => {
  const paid = run("unreserved-paid", { tokens: { total: 7_000_000, metered: true }, tokensWindows: { reservedTokens: 0, settledTokens: 0, basis: "unreserved" } });
  const summary = spendSummaryOf({ records: [paid], hosts: [], budget: {}, nowMs: NOW });
  const day = spendChartsOf({ records: [paid], sinceMs: NOW - DAY, nowMs: NOW, jobCapTokens: null }).daily.at(-1);
  assert.equal(summary.today.settledTokens, 7_000_000);
  assert.equal(summary.today.ledgerTokens, 0, "an unreserved settlement is the ledger's honest 0");
  assert.equal(summary.today.usedTokens, 7_000_000);
  assert.equal(summary.today.counterConfigured, false);
  assert.equal(summary.today.usedSource, "records");
  assert.equal(day.settledTokens, 7_000_000);
  assert.equal(day.settledFloor, false);
});

test("an unmetered run without a settlement is unknown, not an exact empty day", () => {
  const unknown = run("unknown", { tokens: null, usage: null });
  const summary = spendSummaryOf({ records: [unknown], hosts: [], budget: {}, nowMs: NOW });
  const day = spendChartsOf({ records: [unknown], sinceMs: NOW - DAY, nowMs: NOW, jobCapTokens: null }).daily.at(-1);
  for (const result of [summary.today, day]) {
    assert.equal(result.settledTokens, null);
    assert.equal(result.settledFloor, true);
    assert.equal(result.unpriced, 1);
    assert.equal(result.ledgerTokens, null);
  }
  assert.equal(summary.today.usedTokens, null);
});

test("a meter-recorded total without usage detail is kept as a floor, and mixed known/unknown stays a floor", () => {
  const legacy = run("legacy", { usage: null, tokens: { total: 7_000_000, metered: true } });
  const unknown = run("unknown", { tokens: null, usage: null });
  const known = recordSpendOf(legacy);
  assert.equal(known.tokens, 7_000_000);
  assert.equal(known.floor, true, "a total with no per-model rows cannot claim exactness");
  const sum = spendSummaryOf({ records: [legacy, unknown], hosts: [], budget: {}, nowMs: NOW });
  assert.equal(sum.today.settledTokens, 7_000_000);
  assert.equal(sum.today.settledFloor, true);
  assert.equal(sum.today.usedFloor, true);
  assert.equal(sum.today.unpriced, 1);
});

test("reserved settlements, refunds and floors keep the ledger semantics while unreserved prices do not enter reconciliation", () => {
  const ledger = run("settled", { tokensWindows: { reservedTokens: 9_000_000, settledTokens: 3_000_000, basis: "metered" } });
  const refunded = run("refunded", { tokens: { total: 0, metered: true }, tokensWindows: { reservedTokens: 9_000_000, settledTokens: 0, basis: "refunded" } });
  const floor = run("floor", { tokensWindows: { reservedTokens: 9_000_000, settledTokens: 9_000_000, basis: "floor" } });
  const unreserved = run("unreserved", { tokens: { total: 0, metered: true }, tokensWindows: { reservedTokens: 0, settledTokens: 0, basis: "unreserved" } });
  const budget = { tokens: {}, windows: { rows: [{ ledger: "deployment", window: "day", counterTokens: 12_000_000, capTokens: 20_000_000 }] } };
  const today = spendSummaryOf({ records: [ledger, refunded, floor, unreserved], hosts: [], budget, nowMs: NOW }).today;
  assert.equal(today.usedTokens, 12_000_000);
  assert.equal(today.settledTokens, 12_000_000, "settled 3M + refunded 0 + floor 9M + unreserved 0");
  assert.equal(today.ledgerTokens, 12_000_000);
  assert.equal(today.unattributedTokens, 0);
  assert.equal(today.settledFloor, true);
  assert.equal(today.counterAvailable, true);
  assert.equal(today.usedSource, "counter");
});

test("a configured but unread daily counter stays unknown despite readable priced records", () => {
  const budget = { tokens: {}, windows: { rows: [{ ledger: "deployment", window: "day", counterTokens: null, capTokens: 20_000_000 }] } };
  const today = spendSummaryOf({ records: [run("paid", { tokens: { total: 7_000_000, metered: true }, tokensWindows: { settledTokens: 0, basis: "unreserved" } })], hosts: [], budget, nowMs: NOW }).today;
  assert.equal(today.settledTokens, 7_000_000);
  assert.equal(today.usedTokens, null);
  assert.equal(today.counterConfigured, true);
  assert.equal(today.counterAvailable, false);
  assert.equal(today.usedSource, "unknown-counter");
});

test("an unreserved settlement keeps its 0 in the ledger while the meter's own tokens still count", () => {
  const paidPlan = run("plan-api", { provider: "plan", model: "paid", usage: { models: [{ provider: "plan", model: "paid", input: 1, total: 1_000_000 }] }, tokens: { total: 1_000_000, metered: true }, tokensWindows: { reservedTokens: 0, settledTokens: 0, basis: "unreserved" } });
  const got = recordSpendOf(paidPlan);
  assert.equal(got.tokens, 1_000_000);
  assert.equal(got.ledgerTokens, 0, "nothing was reserved, so nothing is settled against the window");
  assert.equal(got.floor, false);
});

test("a price floor is sticky for uncapped fallback meter records and their chart totals", () => {
  const partial = run("partial", { usage: null, tokens: { total: 7_000_000, metered: false }, tokensWindows: { settledTokens: 0, basis: "unreserved" } });
  const day = spendChartsOf({ records: [partial], sinceMs: NOW - DAY, nowMs: NOW, jobCapTokens: null }).daily.at(-1);
  assert.equal(day.settledTokens, 7_000_000);
  assert.equal(day.settledFloor, true);
  assert.equal(day.settledEstimated, true);
});

test("project charts use that project's holds even when Today's headline falls back to deployment windows", async () => {
  const { reads } = readsFixture();
  reads.hosts = async () => ({ hosts: [{ name: "worker", jobsMore: "0", jobs: JSON.stringify([{ id: "site-job", p: "site", at: NOW - 1000, ha: NOW - 1000, h: 2_000_000 }, { id: "other-job", p: "other", at: NOW - 1000, ha: NOW - 1000, h: 3_000_000 }]) }] });
  reads.budget = async () => ({ tokens: {}, windows: { rows: [{ ledger: "deployment", window: "day", capTokens: 10_000_000, counterTokens: 5_000_000 }] } });
  const data = await assembleInsightsView({}, "7d", { project: "site", pricing, nowMs: NOW, envFn: () => ({}), reads });
  assert.equal(data.spend.today.basis, "deployment");
  assert.equal(data.spend.today.heldTokens, 5_000_000);
  assert.equal(data.spend.daily.at(-1).heldTokens, 2_000_000);
});

test("the spend view counts a newer pi-dispatch's records of the selected project up to now, as dispatch_costs does (#761)", async () => {
  // Only the core is judged: the project and the times. One that ends after now is past every fold here.
  const newer = (id, project, over = {}) => run(id, { project, v: 3, ...over });
  const scanned = [run("site-ok"), newer("n-site-1", "site"), newer("n-site-2", "site", { flow: "other" }), newer("n-other", "other"), newer("n-none", undefined), newer("n-later", "site", { endedAt: new Date(NOW + 60_000).toISOString() })];
  const spendOf = async (project) => {
    const { reads } = readsFixture();
    reads.scan = () => scanned;
    return (await assembleInsightsView({}, "7d", { project, pricing, nowMs: NOW, envFn: () => ({}), reads })).spend;
  };
  assert.equal((await spendOf("site")).newerSkipped, 2, "the project's own, up to now");
  assert.equal((await spendOf("other")).newerSkipped, 1);
  assert.equal((await spendOf(null)).newerSkipped, 4, "no project: every one up to now");
  assert.equal(Object.hasOwn(await spendOf("absent"), "newerSkipped"), false, "a project with none has no count");
});


test("a real loader-invalid trigger file draws only the Flows error and performs no scheduler read", async () => {
  const dir = tempDir("insights-invalid-graph-");
  const triggersPath = join(dir, "triggers.json");
  writeFileSync(triggersPath, JSON.stringify({ triggers: [{ on: { type: "not-a-trigger" }, run: { flow: "fix" } }] }));
  const graph = await assembleGraph({ triggersPath }, { pricing, nowMs: NOW, readSchedulersFn: () => { throw new Error("an invalid graph must not dial the scheduler"); } });
  const { renderPage, parsePageQuery } = await import("../src/console/pages.mjs");
  const out = await renderPage("insights-flows", { query: parsePageQuery("insights-flows", "").query, session: { role: "viewer", name: "watcher" }, data: { now: NOW, insights: { graph } } });
  const text = String(out.html);
  assert.match(text, /on.type must be one of/);
  assert.match(text, /Nothing is drawn until it loads/);
  assert.doesNotMatch(text, /id="graph"/);
  assert.ok(!text.includes(dir));
});

test("Capacity joins current venue declarations by host name, preserving older and missing rows as unknown", async () => {
  const { reads } = readsFixture();
  reads.capacity = async (_paths, _window, _now, opts) => {
    assert.equal(opts.consoleDetails, true);
    return { hosts: [{ name: "new" }, { name: "old" }, { name: "gone" }] };
  };
  reads.hosts = async () => ({ hosts: [{ name: "new", concurrency: "4", backends: "blessed=podman,openshell;floor=;os=podman:up" }, { name: "old", concurrency: "2" }] });
  const got = await assembleInsightsView({}, "7d", { view: "capacity", pricing, nowMs: NOW, envFn: () => ({}), reads });
  assert.deepEqual(got.capacity.hosts[0].venues, ["podman", "openshell"]);
  assert.equal(got.capacity.hosts[0].defaultVenue, "podman");
  assert.equal(got.capacity.hosts[1].venues, null);
  assert.equal(got.capacity.hosts[2].venues, null);
  assert.equal(got.capacity.totalSlots, null, "a historical host without a live row has unknown current slots");
  assert.equal(got.capacity.venuesUnreadable, false);
});

test("an unread registry cannot publish venue or slot claims, while the capacity report stays readable", async () => {
  const { reads } = readsFixture();
  reads.capacity = async () => ({ hosts: [{ name: "worker" }], coverage: ["history was read"] });
  reads.hosts = async () => ({ unreachable: "not answering", hosts: [{ name: "worker", concurrency: "4", backends: "blessed=docker" }] });
  const got = await assembleInsightsView({}, "7d", { view: "capacity", pricing, nowMs: NOW, envFn: () => ({}), reads });
  assert.equal(got.capacity.hosts[0].venues, null);
  assert.equal(got.capacity.totalSlots, null);
  assert.equal(got.capacity.venuesUnreadable, true);
  assert.deepEqual(got.capacity.coverage, ["history was read"]);
});
