import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleInsightsView, spendSummaryOf, spendChartsOf, recordSpendOf, assembleGraph } from "../src/insights-assembly.mjs";
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
    graph: watch("graph", {}), capacity: watch("capacity", {}), sizing: watch("sizing", {}),
    hosts: watch("hosts", { hosts: [] }), scan: watch("scan", []), subscriptions: watch("subscriptions", { subscriptions: [] }), settings: watch("settings", { overlay: {} }),
  } };
}

for (const [view, expected] of [
  ["capacity", ["capacity", "hosts"]],
  ["breakdown", ["projects", "costs"]],
]) test(`${view} reads only its own slices`, async () => {
  const { reads, calls } = readsFixture();
  await assembleInsightsView({}, "7d", { view, pricing, nowMs: NOW, envFn: () => ({}), reads });
  assert.deepEqual(calls.map((c) => c.name), expected);
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

test("a 7M-token unreserved run stays in Today's records and the daily chart: the ledger's 0 is not the meter's claim", () => {
  const paid = run("unreserved-paid", { tokens: { total: 7_000_000, metered: true }, tokensWindows: { reservedTokens: 0, settledTokens: 0, basis: "unreserved" } });
  const summary = spendSummaryOf({ records: [paid], nowMs: NOW, pricing });
  const day = spendChartsOf({ records: [paid], sinceMs: NOW - DAY, nowMs: NOW, pricing }).daily.at(-1);
  assert.equal(summary.today.settledTokens, 7_000_000);
  assert.equal(summary.today.ledgerTokens, 0, "an unreserved settlement is the ledger's honest 0");
  assert.equal(summary.today.usedTokens, 7_000_000);
  assert.equal(summary.today.usedSource, "records");
  assert.equal(day.settledTokens, 7_000_000);
  assert.equal(day.settledFloor, false);
});

test("an unmetered run without a settlement is unknown, not an exact empty day", () => {
  const unknown = run("unknown", { tokens: null, usage: null });
  const summary = spendSummaryOf({ records: [unknown], nowMs: NOW, pricing });
  const day = spendChartsOf({ records: [unknown], sinceMs: NOW - DAY, nowMs: NOW, pricing }).daily.at(-1);
  for (const result of [summary.today, day]) {
    assert.equal(result.settledTokens, null);
    assert.equal(result.settledFloor, true);
    assert.equal(result.unpriced, 1);
    assert.equal(result.ledgerTokens, null);
  }
  assert.equal(summary.today.usedTokens, null);
});

test("a price floor is sticky for fallback meter records and their chart totals", () => {
  const partial = run("partial", { usage: null, tokens: { total: 7_000_000, metered: false }, tokensWindows: { settledTokens: 0, basis: "unreserved" } });
  const day = spendChartsOf({ records: [partial], sinceMs: NOW - DAY, nowMs: NOW, pricing }).daily.at(-1);
  assert.equal(day.settledTokens, 7_000_000);
  assert.equal(day.settledFloor, true);
  assert.equal(day.settledEstimated, true);
});

test("settlements, refunds and floors add up from the records alone: no counter is read or reconciled", () => {
  const ledger = run("settled", { tokensWindows: { reservedTokens: 9_000_000, settledTokens: 3_000_000, basis: "metered" } });
  const refunded = run("refunded", { tokens: { total: 0, metered: true }, tokensWindows: { reservedTokens: 9_000_000, settledTokens: 0, basis: "refunded" } });
  const floor = run("floor", { tokensWindows: { reservedTokens: 9_000_000, settledTokens: 9_000_000, basis: "floor" } });
  const unreserved = run("unreserved", { tokens: { total: 0, metered: true }, tokensWindows: { reservedTokens: 0, settledTokens: 0, basis: "unreserved" } });
  const today = spendSummaryOf({ records: [ledger, refunded, floor, unreserved], nowMs: NOW, pricing }).today;
  assert.equal(today.usedTokens, 12_000_000);
  assert.equal(today.settledTokens, 12_000_000, "settled 3M + refunded 0 + floor 9M + unreserved 0");
  assert.equal(today.ledgerTokens, 12_000_000);
  assert.equal(today.settledFloor, true);
  assert.equal(today.usedSource, "records");
  assert.ok(!("unattributedTokens" in today) && !("counterAvailable" in today), "no counter, no reconciliation");
});

test("an unreserved settlement keeps its 0 in the ledger while the meter's own tokens still count", () => {
  const paidPlan = run("plan-api", { provider: "plan", model: "paid", usage: { models: [{ provider: "plan", model: "paid", input: 1, total: 1_000_000 }] }, tokens: { total: 1_000_000, metered: true }, tokensWindows: { reservedTokens: 0, settledTokens: 0, basis: "unreserved" } });
  const got = recordSpendOf(paidPlan);
  assert.equal(got.tokens, 1_000_000);
  assert.equal(got.ledgerTokens, 0, "nothing was reserved, so nothing is settled against the window");
  assert.equal(got.floor, false);
});

test("the spend view counts a newer pi-dispatch's records of the selected project up to now, as dispatch_costs does (#761)", async () => {
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
