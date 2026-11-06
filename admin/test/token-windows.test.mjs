import { test } from "node:test";
import assert from "node:assert/strict";
import { deploymentTokenCaps, tokenWindowRows, tokenWindowSpecs, tokenWindowsSinceMs, foldWindowRecords, runTokenWindows, UNATTRIBUTED } from "../src/token-windows.mjs";
import { dayKey, monthKey, weekKey } from "@edgehero/pi-dispatch/budget";
import { readTokenCounters } from "../src/read-model.mjs";
import { modelTokenKeyPrefix, parseScopedLimits, scopeTokenKeyPrefix } from "@edgehero/pi-dispatch/scoped-limits";

/**
 * Issue #501, part 7: the dollar windows the spends show. Two sources, never blended: the
 * COUNTER (spent and held, what the next job is admitted against) and the RUN RECORDS (how each run settled). Every
 * clock is injected (`now`), never the wall clock, so the suite holds under the 399-day shift. The retired panel's
 * framed rows and its deps' counter/records schedule went with the panel (58ef2369); the plain renderer went with
 * them, its only reader having been the panel.
 */

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

test("readTokenCounters swallows ioredis' error events and gives up after its timeout", async () => {
  const handlers = [];
  const hung = { on: (ev, fn) => handlers.push(ev), mget: () => new Promise(() => {}), disconnect() {} };
  // The reader's timer is unref'd (a one-shot tool must not hold pi open), so the test holds the loop open with a
  // ref'd guard of its own, which also FAILS the test, rather than hanging it, if the reader never gives up.
  let guard;
  let out;
  try {
    out = await Promise.race([
      readTokenCounters({ url: "redis://127.0.0.1:1", keys: ["budget:tok:2026-10-14"], redisFn: () => hung, timeoutMs: 20 }),
      new Promise((_, reject) => { guard = setTimeout(() => reject(new Error("the reader never timed out")), 2000); }),
    ]);
  } finally {
    clearTimeout(guard);
  }
  assert.deepEqual(out, { unreachable: "timed out reaching the queue" });
  assert.deepEqual(handlers, ["error"], "an error listener, so a down Valkey prints no stack traces");
  const ok = { on() {}, async mget() { return ["5", null]; }, disconnect() {} };
  assert.deepEqual(await readTokenCounters({ url: "redis://127.0.0.1:1", keys: ["a", "b"], redisFn: () => ok }), { a: 5 });
});
