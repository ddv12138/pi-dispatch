import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.mjs";
import { stripAnsi } from "../src/style.mjs";
import { deploymentTokenCaps, tokenWindowRows, tokenWindowSpecs, tokenWindowsSinceMs, foldWindowRecords, renderTokenWindows, runTokenWindows, UNATTRIBUTED } from "../src/token-windows.mjs";
import { dayKey, monthKey, weekKey } from "@edgehero/pi-dispatch/budget";
import { readDollarCounters } from "../src/read-model.mjs";
import { modelTokenKeyPrefix, parseScopedLimits, scopeTokenKeyPrefix } from "@edgehero/pi-dispatch/scoped-limits";

/**
 * Issue #501, part 7: the dollar windows the panel and `dispatch_costs` show. Two sources, never blended: the
 * COUNTER (spent and held, what the next job is admitted against) and the RUN RECORDS (how each run settled). Every
 * clock is injected (`now`), never the wall clock, so the suite holds under the 399-day shift.
 */

const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = piRequire("jiti");
const jiti = createJiti(import.meta.url);
const { makeDashboard, createDashboardDeps } = await jiti.import(fileURLToPath(new URL("../src/dashboard.ts", import.meta.url)));

const NOW = new Date(Date.UTC(2026, 9, 14, 12, 0, 0)); // a Wednesday
const iso = (ms) => new Date(ms).toISOString();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const record = (over = {}) => ({
  jobId: "gh-1",
  kind: "github",
  target: "acme/web#12",
  flow: "fix",
  startedAt: iso(NOW.getTime() - HOUR),
  endedAt: iso(NOW.getTime() - HOUR / 2),
  outcome: "completed",
  tokens: { total: 10, metered: true },
  tokensWindows: { reservedTokens: 2_000_000, settledTokens: 400_000, basis: "metered", modelBasis: null },
  ...over,
});

const LIMITS = [
  { scope: "acme/web", day: 3, week: null, month: null, concurrent: null, dayTokens: 5_000_000, weekTokens: null, monthTokens: null },
  { scope: "/srv/site", day: null, week: null, month: null, concurrent: null, dayTokens: null, weekTokens: 7_000_000, monthTokens: null },
  { scope: "acme/count-only", day: 2, week: null, month: null, concurrent: null, dayTokens: null, weekTokens: null, monthTokens: null },
  { scope: "model:openai/gpt-x", day: null, week: null, month: null, concurrent: null, dayTokens: null, weekTokens: null, monthTokens: 25_000_000 },
];

test("deploymentTokenCaps merges the overlay over the env, key by key, and names a value it cannot read", () => {
  const { caps, invalid } = deploymentTokenCaps({ dailyTokenCap: 10_000_000 }, { PI_DAILY_TOKEN_CAP: "99000000", PI_MONTHLY_TOKEN_CAP: "100000000", PI_WEEKLY_TOKEN_CAP: "" });
  assert.deepEqual(caps, { day: 10_000_000, week: null, month: 100_000_000 }, "the overlay wins, an empty env value is unset");
  assert.deepEqual(invalid, []);
  const bad = deploymentTokenCaps({ weeklyTokenCap: "1e3" }, {});
  assert.deepEqual(bad.caps, { day: null, week: null, month: null }, "never a guessed cap");
  assert.deepEqual(bad.invalid, ["weeklyTokenCap"]);
});

test("the specs are the deployment's windows first, then each token row in file order, under the worker's own keys", () => {
  const specs = tokenWindowSpecs({ caps: { day: 10_000_000, week: null, month: 50_000_000 }, limits: LIMITS, now: NOW });
  assert.deepEqual(
    specs.map((s) => [s.ledger, s.name, s.index, s.window, s.capTokens]),
    [
      ["deployment", null, null, "day", 10_000_000],
      ["deployment", null, null, "month", 50_000_000],
      ["scope", "acme/web", 0, "day", 5_000_000],
      ["scope", "/srv/site", 1, "week", 7_000_000],
      ["model", "openai/gpt-x", 3, "month", 25_000_000],
    ],
    "a count-only row has no token window",
  );
  assert.equal(specs[0].key, dayKey(NOW, "budget:tok"));
  assert.equal(specs[1].key, monthKey(NOW, "budget:tok"));
  assert.equal(specs[2].key, dayKey(NOW, scopeTokenKeyPrefix("acme/web")));
  assert.equal(specs[3].key, weekKey(NOW, scopeTokenKeyPrefix("/srv/site")));
  assert.equal(specs[4].key, monthKey(NOW, modelTokenKeyPrefix("openai/gpt-x")));
  assert.deepEqual(tokenWindowSpecs({ caps: { day: null, week: null, month: null }, limits: [], now: NOW }), [], "nothing set, nothing shown");
});

test("the scan starts at the oldest active window: the month's first, or a Monday in the month before", () => {
  const specs = tokenWindowSpecs({ caps: { day: 1, week: 1, month: 1 }, limits: [], now: NOW });
  assert.equal(tokenWindowsSinceMs(specs, NOW), Date.UTC(2026, 9, 1));
  const early = new Date(Date.UTC(2026, 9, 2, 8)); // a Friday; its week began Monday 2026-09-28
  assert.equal(tokenWindowsSinceMs(tokenWindowSpecs({ caps: { day: 1, week: 1, month: 1 }, limits: [], now: early }), early), Date.UTC(2026, 8, 28));
  assert.equal(tokenWindowsSinceMs(tokenWindowSpecs({ caps: { day: 1, week: null, month: null }, limits: [], now: NOW }), NOW), Date.UTC(2026, 9, 14));
  assert.equal(tokenWindowsSinceMs([], NOW), null);
});

test("spent and held come from the COUNTER, settled from the records, and the two are never blended", () => {
  const specs = tokenWindowSpecs({ caps: { day: 10_000_000, week: null, month: null }, limits: [], now: NOW });
  // The counter holds a running job's whole hold (2,000,000) on top of what settled: the records cannot see it.
  const counters = { [specs[0].key]: 2_400_000 };
  const [row] = tokenWindowRows({ specs, counters, records: [record()] });
  assert.equal(row.counterTokens, 2_400_000, "spent and held is the counter, never the records' sum");
  assert.equal(row.records.settledTokens, 400_000);
  assert.equal(row.records.runs, 1);
  // An absent key is an honest 0 (nothing reserved yet); an unreadable queue is null, never an invented 0.
  assert.equal(tokenWindowRows({ specs, counters: {}, records: [] })[0].counterTokens, 0);
  assert.equal(tokenWindowRows({ specs, counters: { unreachable: "down" }, records: [record()] })[0].counterTokens, null);
});

test("the records' side counts each basis, keeps only runs that started in the window", () => {
  const specs = tokenWindowSpecs({ caps: { day: 10_000_000, week: null, month: 90_000_000 }, limits: [], now: NOW });
  const records = [
    record(),
    record({ jobId: "b", tokens: { boundExceeded: 2 }, tokensWindows: { reservedTokens: 2_000_000, settledTokens: 2_000_000, basis: "floor", modelBasis: null } }),
    record({ jobId: "c", tokensWindows: { reservedTokens: 2_000_000, settledTokens: 0, basis: "refunded", modelBasis: null } }),
    record({ jobId: "d", tokensWindows: { reservedTokens: 0, settledTokens: 0, basis: "unreserved", modelBasis: null } }),
    // Started yesterday: in the month, not in today's window, and it settled into yesterday's day key.
    record({ jobId: "e", startedAt: iso(NOW.getTime() - DAY), endedAt: iso(NOW.getTime() - DAY + HOUR), tokensWindows: { reservedTokens: 1, settledTokens: 1_000_000, basis: "metered", modelBasis: null } }),
    // No dollar window applied: no `dollars`, never counted.
    record({ jobId: "f", tokensWindows: null }),
    // A malformed amount is skipped and counted, never read as 0.
    record({ jobId: "g", tokensWindows: { reservedTokens: 1, settledMicros: "lots", basis: "metered", modelBasis: null } }),
  ];
  const [day, month] = tokenWindowRows({ specs, counters: {}, records });
  assert.deepEqual(day.records, { runs: 5, settledTokens: 2_400_000, basis: { metered: 2, floor: 1, refunded: 1, unreserved: 1 }, malformed: 1 });
  assert.equal(month.records.runs, 6);
  assert.equal(month.records.settledTokens, 3_400_000);
});

test("a repo row folds its own forge runs; a folder or model row says why its runs cannot be named", () => {
  const specs = tokenWindowSpecs({ caps: {}, limits: LIMITS, now: NOW });
  const records = [
    record(),
    record({ jobId: "other", target: "acme/api#3", tokensWindows: { reservedTokens: 1, settledTokens: 900_000, basis: "metered", modelBasis: "metered" } }),
    record({ jobId: "local", kind: "local", target: "local:web", tokensWindows: { reservedTokens: 1, settledTokens: 700_000, basis: "metered", modelBasis: null } }),
  ];
  const rows = tokenWindowRows({ specs, counters: {}, records });
  assert.equal(rows[0].name, "acme/web");
  assert.equal(rows[0].records.runs, 1, "only acme/web's own run, never another repo's or a local one");
  assert.equal(rows[0].records.settledTokens, 400_000);
  assert.equal(rows[1].records, null);
  assert.equal(rows[1].unattributed, UNATTRIBUTED.folder);
  assert.equal(rows[2].records, null);
  assert.equal(rows[2].unattributed, UNATTRIBUTED.model);
  assert.equal(foldWindowRecords(records, specs[2]).unattributed, UNATTRIBUTED.model);
});

test("issue #499 part C: a project row's token window folds the records whose project is that id, a local run included", () => {
  const limits = parseScopedLimits(JSON.stringify({ version: 2, limits: [{ scope: "project:shop", dayTokens: 5_000_000 }, { scope: "project:constructor", dayTokens: 5_000_000 }] }), "sl.json");
  const specs = tokenWindowSpecs({ caps: {}, limits, now: NOW });
  assert.deepEqual(specs.map((s) => [s.ledger, s.name]), [["scope", "project:shop"], ["scope", "project:constructor"]]);
  const records = [
    record({ jobId: "gh-shop", project: "shop" }),
    record({ jobId: "local-shop", kind: "local", target: "local:site", project: "shop", tokensWindows: { reservedTokens: 1, settledTokens: 250_000, basis: "floor", modelBasis: null } }),
    // The same repo, recorded before it joined: never re-attributed from today's membership.
    record({ jobId: "gh-before", project: null, tokensWindows: { reservedTokens: 1, settledTokens: 900_000, basis: "metered", modelBasis: null } }),
    record({ jobId: "gh-other", project: "tools", tokensWindows: { reservedTokens: 1, settledTokens: 800_000, basis: "metered", modelBasis: null } }),
    record({ jobId: "gh-ctor", project: "constructor", tokensWindows: { reservedTokens: 1, settledTokens: 50_000, basis: "metered", modelBasis: null } }),
  ];
  const [shop, ctor] = tokenWindowRows({ specs, counters: {}, records });
  assert.equal(shop.unattributed, undefined, "attributed now, no longer marked");
  assert.equal(shop.records.runs, 2, "the github and the local run of shop, nothing else");
  assert.equal(shop.records.settledTokens, 650_000);
  assert.deepEqual([shop.records.basis.metered, shop.records.basis.floor], [1, 1]);
  assert.equal(ctor.records.runs, 1, "an id that is a prototype key is still just an id");
  assert.equal(ctor.records.settledTokens, 50_000);
  assert.ok(!("project" in UNATTRIBUTED), "no project sentence left to show");
});

test("issue #498: a qualified repo row folds only its own forge's runs; a bare row folds every forge's", () => {
  const limits = [
    { scope: "github:acme/web", day: null, week: null, month: null, concurrent: null, dayTokens: 5_000_000, weekTokens: null, monthTokens: null },
    { scope: "acme/api", day: null, week: null, month: null, concurrent: null, dayTokens: 5_000_000, weekTokens: null, monthTokens: null },
  ];
  const specs = tokenWindowSpecs({ caps: {}, limits, now: NOW });
  assert.equal(specs[0].keyPrefix, scopeTokenKeyPrefix("github:acme/web"), "the row's own key");
  const records = [
    record(),
    record({ jobId: "fj-web", kind: "forgejo", tokensWindows: { reservedTokens: 1, settledTokens: 900_000, basis: "metered", modelBasis: null } }),
    record({ jobId: "gh-api", target: "acme/api#3", tokensWindows: { reservedTokens: 1, settledTokens: 100_000, basis: "metered", modelBasis: null } }),
    record({ jobId: "fj-api", kind: "forgejo", target: "acme/api#4", tokensWindows: { reservedTokens: 1, settledTokens: 200_000, basis: "metered", modelBasis: null } }),
  ];
  const rows = tokenWindowRows({ specs, counters: {}, records });
  assert.equal(rows[0].records.runs, 1, "the Forgejo run on acme/web is not the GitHub row's");
  assert.equal(rows[0].records.settledTokens, 400_000);
  assert.equal(rows[1].records.runs, 2, "a bare row folds the repo on every forge");
  assert.equal(rows[1].records.settledTokens, 300_000);
});

test("only numbers, fixed tokens and the operator's own scope and model names leave the rows", () => {
  const specs = tokenWindowSpecs({ caps: { day: 10_000_000 }, limits: LIMITS, now: NOW });
  const poisoned = record({ flow: "SECRET-FLOW", target: "acme/web#12", jobId: "SECRET-JOB", reason: "SECRET-REASON" });
  const text = JSON.stringify(tokenWindowRows({ specs, counters: {}, records: [poisoned] }));
  for (const needle of ["SECRET", "#12", "fix"]) assert.ok(!text.includes(needle), `${needle} must not reach a row: ${text}`);
});

test("runTokenWindows lists each run's window settlement newest first, rebuilt from named fields, capped with a count", () => {
  const records = [
    record({ jobId: "old", endedAt: iso(NOW.getTime() - 3 * HOUR) }),
    record({ jobId: "new", endedAt: iso(NOW.getTime() - HOUR), tokensWindows: { reservedTokens: 2, settledTokens: 2, basis: "floor", modelBasis: "floor", extra: "SECRET" }, tokens: { total: 2, metered: true } }),
    record({ jobId: "none", tokensWindows: null }),
  ];
  const out = runTokenWindows(records, { limit: 1 });
  assert.deepEqual(out.runs, [{ jobId: "new", startedAt: records[1].startedAt, endedAt: records[1].endedAt, flow: "fix", outcome: "completed", tokensWindows: { reservedTokens: 2, settledTokens: 2, basis: "floor", modelBasis: "floor" } }]);
  assert.equal(out.more, 1, "the run with no window settlement is not a row");
  assert.ok(!JSON.stringify(out).includes("SECRET"));
});

test("the plain renderer is null when no window is set, and states both sources when one is", () => {
  assert.equal(renderTokenWindows(null), null);
  assert.equal(renderTokenWindows({ rows: [] }), null);
  const text = renderTokenWindows({ rows: [
    { ledger: "deployment", name: null, window: "day", capTokens: 10_000_000, counterTokens: 2_400_000, records: { runs: 2, settledTokens: 400_000, basis: { metered: 1, floor: 1, refunded: 0, unreserved: 0 } } },
    { ledger: "model", name: "openai/gpt-x", window: "month", capTokens: 25_000_000, counterTokens: null, records: null, unattributed: UNATTRIBUTED.model },
  ] });
  assert.match(text, /day   deployment  reserved\+held 2,400,000 of 10,000,000  settled 400,000 from 2 runs \(1 metered, 1 floor\)/);
  assert.match(text, /month model:openai\/gpt-x  reserved\+held - of 25,000,000  records n\/a/);
});

// --- the panel -------------------------------------------------------------------------------------------

const flush = () => new Promise((resolve) => setImmediate(resolve));
const BASE = {
  queue: { pausedState: false, counts: { waiting: 0, active: 0, paused: 0, delayed: 0, failed: 0 }, workers: 1 },
  budget: { day: 0, week: 0, month: 0 },
  settings: { path: "/s", overlay: {} },
  runs: [],
  stagedPackages: { stagedAt: null, packages: [] },
};

async function renderSnapshot(snap, width = 120) {
  const comp = makeDashboard({
    paths: {}, done() {}, tui: { requestRender() {} }, intervalMs: 100000,
    deps: { fetchSnapshot: async () => snap, pause: async () => {}, resume: async () => {}, dispose: async () => {}, now: () => NOW.getTime() },
  });
  await flush();
  const lines = comp.render(width).map((l) => stripAnsi(l));
  await comp.dispose();
  return lines;
}

test("the panel shows no dollar section when no token window is set", async () => {
  const lines = await renderSnapshot({ ...BASE, windows: null });
  assert.ok(!lines.some((l) => /token windows/i.test(l)));
});

test("the panel shows each window's counter over its cap, then what the records say", async () => {
  const lines = await renderSnapshot({ ...BASE, windows: { rows: [
    { ledger: "deployment", name: null, window: "day", capTokens: 10_000_000, counterTokens: 2_400_000, records: { runs: 2, settledTokens: 400_000, basis: { metered: 1, floor: 1, refunded: 0, unreserved: 0 }, boundExceeded: 3 } },
    { ledger: "scope", name: "/srv/site", window: "week", capTokens: 7_000_000, counterTokens: 7_000_000, records: null, unattributed: UNATTRIBUTED.folder },
  ] } });
  // A non-zero boundExceeded is drawn amber BEFORE the settled part (issue #507), so the settled part is what clips.
  assert.ok(lines.some((l) => /day\s+deployment\s+2,400,000\/10,000,000\s+settled 400,000 · 1 metered, 1 floor/.test(l)), lines.join("\n"));
  assert.ok(lines.some((l) => /week\s+\/srv\/site\s+7,000,000\/7,000,000\s+records n\/a/.test(l)));
});

// The rows the README's canned deployment exposed clipping at 80 columns (issue #507): exact micro-dollar amounts, so
// the words around them are what got shorter. Pinned as whole framed lines at width 80, where `inner` is 76.
const framed = (content) => `│ ${content.padEnd(76)} │`;
const metered = (runs, settledTokens, more = {}) => ({ runs, settledTokens, basis: { metered: runs, floor: 0, refunded: 0, unreserved: 0, ...more } });

test("a token window row with exact amounts fits the panel at 80 columns (#507)", async () => {
  const lines = await renderSnapshot({ ...BASE, windows: { rows: [
    { ledger: "deployment", name: null, index: null, window: "day", capTokens: 25_000_000, counterTokens: 4_380_627, full: false, records: metered(4, 2_380_627) },
    { ledger: "deployment", name: null, index: null, window: "week", capTokens: 120_000_000, counterTokens: 8_938_198, full: false, records: metered(14, 6_938_198) },
    { ledger: "scope", name: "project:shop", index: 1, window: "week", capTokens: 45_000_000, counterTokens: 6_340_917, full: false, records: metered(5, 4_340_917) },
    { ledger: "deployment", name: null, index: null, window: "month", capTokens: 30_000_000, counterTokens: 893_819, full: false, records: { ...metered(13, 693_819), basis: { metered: 13, floor: 1, refunded: 0, unreserved: 0 }, runs: 14 } },
    { ledger: "scope", name: "acme/web", index: 0, window: "day", capTokens: 5_000_000, counterTokens: 0, full: false, records: { ...metered(0, 0), basis: { metered: 0, floor: 0, refunded: 0, unreserved: 0 } } },
  ] } }, 80);
  for (const want of [
    "day   deployment  4,380,627/25,000,000  settled 2,380,627 · 4 metered",
    "week  deployment  8,938,198/120,000,000  settled 6,938,198 · 14 metered",
    "week  project:shop  6,340,917/45,000,000  settled 4,340,917 · 5 metered",
    // A mix is counted by basis, the total implied, and still fits.
    "month deployment  893,819/30,000,000  settled 693,819 · 13 metered, 1 floor",
    "day   acme/web  0/5,000,000  settled 0 · 0 runs",
  ]) assert.ok(lines.includes(framed(want)), `${want}\n${lines.join("\n")}`);
  assert.ok(!lines.some((l) => l.includes("boundExceeded")), "the guard's counter is gone with the guard");
  assert.ok(!lines.some((l) => l.includes("…")), "no token row clips");
});

test("a token window row whose basis counts do not add up to its runs keeps the run total (#507)", async () => {
  // A record with a basis this panel does not know is a run in no count; "4 metered" alone would hide it.
  const lines = await renderSnapshot({ ...BASE, windows: { rows: [
    { ledger: "deployment", name: null, index: null, window: "day", capTokens: 5_000_000, counterTokens: 1_000_000, full: false, records: { ...metered(4, 750_000), runs: 5 } },
  ] } }, 80);
  assert.ok(lines.includes(framed("day   deployment  1,000,000/5,000,000  settled 750,000 · 5 runs (4 metered)")), lines.join("\n"));
});

test("a scoped limit row shows its token windows from the TOKEN WINDOWS rows of its own index (#507)", async () => {
  // A token-only row (a model row, a project row with weekTokens) used to show its scope and no cap at all.
  const scopedLimits = { limits: [
    { scope: "github:acme/web", day: 10, week: 40, month: null, concurrent: 1, dayTokens: null, weekTokens: null, monthTokens: null },
    { scope: "project:shop", day: null, week: null, month: null, concurrent: null, dayTokens: null, weekTokens: 45000000, monthTokens: null },
    { scope: "model:anthropic/claude-sonnet-4-5", day: null, week: null, month: null, concurrent: null, dayTokens: null, weekTokens: 80000000, monthTokens: null },
  ] };
  const scopedBudget = { rows: [{ day: 2, week: 4 }, {}, {}] };
  const projects = { projects: [{ id: "shop", members: ["github:acme/web", "github:acme/api"] }] };
  const dollars = { rows: [
    { ledger: "deployment", name: null, index: null, window: "week", capTokens: 120_000_000, counterTokens: 8_938_198, full: false, records: metered(14, 6_938_198) },
    { ledger: "scope", name: "project:shop", index: 1, window: "week", capTokens: 45_000_000, counterTokens: 6_340_917, full: false, records: metered(5, 4_340_917) },
    { ledger: "model", name: "anthropic/claude-sonnet-4-5", index: 2, window: "week", capTokens: 80_000_000, counterTokens: 79_000_000, full: true, records: null },
  ] };
  const lines = await renderSnapshot({ ...BASE, scopedLimits, scopedBudget, projects, windows: dollars }, 80);
  assert.ok(lines.includes(framed("○ github:acme/web  day 2/10  week 4/40  ≤1 at once")), "a count-only row is unchanged, and takes no deployment window");
  assert.ok(lines.some((l) => l.includes("project:shop") && l.includes("6,340,917/45,000,000")), lines.join("\n"));
  // Full on the TOKEN WINDOWS row's own verdict: amber, the word, and the clip at the panel edge.
  assert.ok(lines.some((l) => l.includes("model:anthropic/claude-sonnet-4-5") && l.includes("79,000,000/80,000,000 full")), lines.join("\n"));
});

test("a scoped limit row with an unreachable token read draws no window figures, never an invented 0 (#507)", async () => {
  const scopedLimits = { limits: [
    { scope: "project:shop", day: null, week: null, month: null, concurrent: null, dayTokens: null, weekTokens: 45_000_000, monthTokens: null },
    { scope: "model:anthropic/claude-sonnet-4-5", day: null, week: null, month: null, concurrent: null, dayTokens: null, weekTokens: 80_000_000, monthTokens: null },
  ] };
  const projects = { projects: [{ id: "shop", members: ["github:acme/web", "github:acme/api"] }] };
  const lines = await renderSnapshot({ ...BASE, scopedLimits, scopedBudget: { rows: [{}, {}] }, projects, windows: { rows: [], unreachable: "EACCES" } }, 80);
  assert.ok(lines.some((l) => l.includes("project:shop") && l.includes("2 members")), lines.join("\n"));
  assert.ok(lines.some((l) => l.includes("model:anthropic/claude-sonnet-4-5")), lines.join("\n"));
  assert.ok(!lines.some((l) => l.includes("45,000,000") || l.includes("80,000,000")), "no cap figure without a counter: unknown is not zero");
});

test("a scoped limit row draws a full token window first, so the word is not what clips at 80 (#507)", async () => {
  const scopedLimits = { limits: [
    { scope: "model:anthropic/claude-sonnet-4-5", day: null, week: null, month: null, concurrent: null, dayTokens: 12500000, weekTokens: 80000000, monthTokens: 300123456 },
  ] };
  const dollars = { rows: [
    { ledger: "model", name: "anthropic/claude-sonnet-4-5", index: 0, window: "day", capTokens: 12_500_000, counterTokens: 1_000_000, full: false, records: null },
    { ledger: "model", name: "anthropic/claude-sonnet-4-5", index: 0, window: "week", capTokens: 80_000_000, counterTokens: 40_000_000, full: false, records: null },
    { ledger: "model", name: "anthropic/claude-sonnet-4-5", index: 0, window: "month", capTokens: 300_123_456, counterTokens: 299_000_000, full: true, records: null },
  ] };
  const lines = await renderSnapshot({ ...BASE, scopedLimits, scopedBudget: { rows: [{}] }, windows: dollars }, 80);
  // The FULL window's row is drawn first (window order day, week, month), and its amber word sits before the
  // narrower rows; the clipping test is that the word is not what got cut.
  assert.ok(lines.some((l) => l.includes("month model:anthropic/claude-sonnet-4-5  299,000,000/300,123,456 full")), lines.join("\n"));
  assert.ok(lines.some((l) => l.includes("day   model:anthropic/claude-sonnet-4-5  1,000,000/12,500,000")), lines.join("\n"));
});

test("the narrow plain-text panel shows a scoped row's token counter and verdict from the TOKEN WINDOWS rows (#507)", async () => {
  const scopedLimits = { limits: [
    { scope: "project:shop", day: null, week: null, month: null, concurrent: null, dayTokens: null, weekTokens: 45000000, monthTokens: null },
  ] };
  const dollars = { rows: [{ ledger: "scope", name: "project:shop", index: 0, window: "week", capTokens: 45_000_000, counterTokens: 46_000_000, full: true, records: null }] };
  const lines = await renderSnapshot({ ...BASE, scopedLimits, scopedBudget: { rows: [{}] }, windows: dollars }, 0);
  assert.ok(lines.some((l) => l.includes("project:shop") && l.includes("reserved+held 46,000,000 of 45,000,000 (full)")), lines.join("\n"));
});

test("the panel's REAL deps read the counters every tick and the records at most once per interval", async () => {
  const dir = tempDir("pd-501-p7-");
  const settingsFile = join(dir, "settings.json");
  writeFileSync(settingsFile, JSON.stringify({ maxTokens: 2_000_000, dailyTokenCap: 10_000_000 }));
  const queue = {
    async isPaused() { return false; }, async getJobCounts() { return { waiting: 0, active: 0, paused: 0, delayed: 0, failed: 0 }; },
    async getWorkers() { return []; }, async getJobSchedulers() { return []; }, async getActive() { return []; },
    async getFailed() { return []; }, async pause() {}, async resume() {}, async close() {},
  };
  const mgets = [];
  let counter = "2400000";
  const redis = {
    async get() { return "0"; }, async hgetall() { return {}; }, async smembers() { return []; }, on() {}, disconnect() {},
    async mget(...keys) { mgets.push(keys); return keys.map(() => counter); },
  };
  const scans = [];
  let clock = NOW.getTime();
  const deps = createDashboardDeps({ valkeyUrl: "redis://x", logsDir: join(dir, "logs"), schedulerStallMax: 3, settingsFile, triggersPath: join(dir, "t.json") }, {
    makeQueueFn: () => queue, parseConnectionFn: () => ({}), redisFn: () => redis,
    readLiveHostsFn: async () => ({ hosts: [] }), discoverHostQueuesFn: async () => [],
    budgetEnvFn: () => ({ PI_WEEKLY_TOKEN_CAP: "40000000" }),
    scanRecordsFn: (args) => { scans.push(args); return [record()]; },
    nowFn: () => clock,
  });
  const first = await deps.fetchSnapshot();
  assert.deepEqual(mgets[0], [dayKey(NOW, "budget:tok"), weekKey(NOW, "budget:tok")], "the overlay's day and the env's week, one MGET");
  assert.deepEqual(first.windows.rows.map((r) => [r.window, r.capTokens, r.counterTokens, r.records.settledTokens]), [["day", 10_000_000, 2_400_000, 400_000], ["week", 40_000_000, 2_400_000, 400_000]]);
  assert.equal(scans[0].sinceMs, Date.UTC(2026, 9, 12), "from the oldest window's start, the week's Monday");
  counter = "3000000";
  clock += 5_000;
  const second = await deps.fetchSnapshot();
  assert.equal(second.windows.rows[0].counterTokens, 3_000_000, "the counter is read every tick");
  assert.equal(scans.length, 1, "the records are not re-scanned within the interval");
  clock += 15_000;
  await deps.fetchSnapshot();
  assert.equal(scans.length, 2, "and are after it");
  await deps.dispose();
});

test("the panel's REAL deps read no token key and scan nothing when no token window is set", async () => {
  const dir = tempDir("pd-501-p7-");
  const settingsFile = join(dir, "settings.json");
  writeFileSync(settingsFile, JSON.stringify({ maxTokens: 2_000_000 }));
  const queue = {
    async isPaused() { return false; }, async getJobCounts() { return {}; }, async getWorkers() { return []; },
    async getJobSchedulers() { return []; }, async getActive() { return []; }, async getFailed() { return []; }, async close() {},
  };
  const redis = { async get() { return "0"; }, async hgetall() { return {}; }, async smembers() { return []; }, on() {}, disconnect() {}, async mget() { throw new Error("no dollar key may be read"); } };
  let scanned = false;
  const deps = createDashboardDeps({ valkeyUrl: "redis://x", logsDir: join(dir, "logs"), schedulerStallMax: 3, settingsFile }, {
    makeQueueFn: () => queue, parseConnectionFn: () => ({}), redisFn: () => redis,
    readLiveHostsFn: async () => ({ hosts: [] }), discoverHostQueuesFn: async () => [],
    scanRecordsFn: () => { scanned = true; return []; }, nowFn: () => NOW.getTime(),
  });
  const snap = await deps.fetchSnapshot();
  await deps.dispose();
  assert.equal(snap.windows, null);
  assert.equal(scanned, false);
});

test("the panel shows a trigger's models and per-job cap on its row and in full in its drill-in (PR #536's obligation)", async () => {
  const t = { type: "label", any: ["bug"], all: [], none: [], flow: "fix", forge: "github", packages: false, instructions: false, secrets: 0, models: ["openai/gpt-x", "anthropic/claude-y"], maxTokens: 1_500_000 };
  const snap = { ...BASE, triggers: { triggers: [t] } };
  const comp = makeDashboard({
    paths: {}, done() {}, tui: { requestRender() {} }, intervalMs: 100000,
    deps: { fetchSnapshot: async () => snap, pause: async () => {}, resume: async () => {}, dispose: async () => {}, now: () => NOW.getTime() },
  });
  await flush();
  const row = comp.render(140).map((l) => stripAnsi(l)).find((l) => l.includes("bug"));
  assert.match(row, /\[models openai\/gpt-x, anthropic\/claude-y\] \[max 1500000\]/);
  comp.handleInput("\r");
  await flush();
  const detail = comp.render(100).map((l) => stripAnsi(l)).join("\n");
  await comp.dispose();
  assert.match(detail, /models\s+openai\/gpt-x, anthropic\/claude-y/);
  assert.match(detail, /max tokens\s+1500000 per job/);
});

// --- PR #550's review ----------------------------------------------------------------------------------------

test("a run is counted in the window it STARTED in: one that ran across midnight belongs to yesterday", () => {
  const midnight = Date.UTC(2026, 9, 14);
  const specs = tokenWindowSpecs({ caps: { day: 10_000_000 }, limits: [], now: NOW });
  const across = record({ startedAt: iso(midnight - 60_000), endedAt: iso(midnight + 60_000) });
  assert.equal(tokenWindowRows({ specs, counters: {}, records: [across] })[0].records.runs, 0, "its hold was reserved under yesterday's key");
  const yesterday = tokenWindowSpecs({ caps: { day: 10_000_000 }, limits: [], now: new Date(midnight - 1) });
  assert.equal(tokenWindowRows({ specs: yesterday, counters: {}, records: [across] })[0].records.runs, 1);
});

test("a window is FULL when the next job's per-job cap would not fit, not only when the counter reaches the cap", () => {
  const specs = tokenWindowSpecs({ caps: { day: 10_000_000 }, limits: [], now: NOW });
  const row = (counter, jobCapTokens) => tokenWindowRows({ specs, counters: { [specs[0].key]: counter }, records: [], jobCapTokens })[0].full;
  assert.equal(row(8_000_000, 2_000_000), false, "exactly fits: five 2,000,000 jobs fill a 10,000,000 window");
  assert.equal(row(8_000_001, 2_000_000), true, "one token over: no 2,000,000 job fits");
  assert.equal(row(9_000_000, null), false, "no per-job cap known: judged on the counter alone");
  assert.equal(row(10_000_000, null), true);
  assert.equal(tokenWindowRows({ specs, counters: { unreachable: "x" }, records: [], jobCapTokens: 1 })[0].full, false, "no counter, no claim");
  assert.equal(deploymentTokenCaps({ maxTokens: 2_000_000 }, {}).jobCapTokens, 2_000_000);
  assert.equal(deploymentTokenCaps({}, { PI_MAX_TOKENS: "1500000" }).jobCapTokens, 1_500_000);
});

test("readDollarCounters swallows ioredis' error events and gives up after its timeout", async () => {
  const handlers = [];
  const hung = { on: (ev, fn) => handlers.push(ev), mget: () => new Promise(() => {}), disconnect() {} };
  // The reader's timer is unref'd (a one-shot tool must not hold pi open), so the test holds the loop open with a
  // ref'd guard of its own, which also FAILS the test, rather than hanging it, if the reader never gives up.
  let guard;
  let out;
  try {
    out = await Promise.race([
      readDollarCounters({ url: "redis://127.0.0.1:1", keys: ["budget:usd:2026-10-14"], redisFn: () => hung, timeoutMs: 20 }),
      new Promise((_, reject) => { guard = setTimeout(() => reject(new Error("the reader never timed out")), 2000); }),
    ]);
  } finally {
    clearTimeout(guard);
  }
  assert.deepEqual(out, { unreachable: "timed out reaching the queue" });
  assert.deepEqual(handlers, ["error"], "an error listener, so a down Valkey prints no stack traces");
  const ok = { on() {}, async mget() { return ["5", null]; }, disconnect() {} };
  assert.deepEqual(await readDollarCounters({ url: "redis://127.0.0.1:1", keys: ["a", "b"], redisFn: () => ok }), { a: 5 });
});

test("the panel names a dollar setting it cannot read, even when no window is left to show", async () => {
  const dir = tempDir("pd-501-p7-");
  const settingsFile = join(dir, "settings.json");
  // A malformed overlay value makes the whole overlay invalid (shown by the settings section), so the unreadable
  // window here comes from the env the console reads.
  writeFileSync(settingsFile, JSON.stringify({ maxTokens: 2_000_000 }));
  const queue = {
    async isPaused() { return false; }, async getJobCounts() { return {}; }, async getWorkers() { return []; },
    async getJobSchedulers() { return []; }, async getActive() { return []; }, async getFailed() { return []; }, async close() {},
  };
  const redis = { async get() { return "0"; }, async hgetall() { return {}; }, async smembers() { return []; }, on() {}, disconnect() {}, async mget() { throw new Error("no window, no read"); } };
  const deps = createDashboardDeps({ valkeyUrl: "redis://x", logsDir: join(dir, "logs"), schedulerStallMax: 3, settingsFile }, {
    makeQueueFn: () => queue, parseConnectionFn: () => ({}), redisFn: () => redis,
    readLiveHostsFn: async () => ({ hosts: [] }), discoverHostQueuesFn: async () => [], nowFn: () => NOW.getTime(),
    budgetEnvFn: () => ({ PI_DAILY_TOKEN_CAP: "1e3" }),
  });
  const snap = await deps.fetchSnapshot();
  await deps.dispose();
  assert.deepEqual(snap.windows, { rows: [], invalid: ["dailyTokenCap"] });
  const lines = await renderSnapshot({ ...BASE, windows: snap.windows });
  assert.ok(lines.some((l) => /not a whole number of tokens: dailyTokenCap/.test(l)), lines.join("\n"));
});

test("a full window renders amber and says so", async () => {
  const COL = { warning: 208 };
  const theme = { fg: (c, t) => `\x1b[38;5;${COL[c] ?? 15}m${t}\x1b[39m`, bold: (t) => t, bg: (_c, t) => t };
  const snap = { ...BASE, windows: { rows: [{ ledger: "deployment", name: null, window: "day", capTokens: 10_000_000, counterTokens: 9_000_000, full: true, records: null }] } };
  const comp = makeDashboard({
    paths: {}, done() {}, tui: { requestRender() {} }, intervalMs: 100000, theme,
    deps: { fetchSnapshot: async () => snap, pause: async () => {}, resume: async () => {}, dispose: async () => {}, now: () => NOW.getTime() },
  });
  await flush();
  const text = comp.render(120).join("\n");
  await comp.dispose();
  assert.ok(text.includes("\x1b[38;5;208m9,000,000/10,000,000 full"), "amber, with the word, so a monochrome terminal still says it");
});
