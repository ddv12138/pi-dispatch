import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { tempDir } from "./helpers/temp-dir.mjs";
import { resolvePaths } from "../src/read-model.mjs";
import { assembleInsights } from "../src/insights-assembly.mjs";
import * as html from "../src/insights-html.mjs";
import { bannersHtml, buildGraphScene } from "../src/graph-html.mjs";
import { uiText } from "../src/console/locale.mjs";
import * as ia from "../src/insights-assembly.mjs";
import { insightsBody } from "../src/console/panels.mjs";

/**
 * The insights assembly as the operator console uses it (issue #641): a separate process that never loads pi, so the
 * module is imported here directly (no jiti, no index.ts) and handed what the extension hands it: the pricing facade
 * and the deployment's environment.
 */

/** Every file a bundle of `entry` reaches, by esbuild's own resolution (the published bundles' resolver). */
async function reached(entry) {
  const res = await build({
    stdin: { contents: `import ${JSON.stringify(entry)};`, resolveDir: fileURLToPath(new URL("../src/", import.meta.url)), loader: "js" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    metafile: true,
    outfile: "unused.mjs",
    external: ["bullmq", "ioredis"],
    logLevel: "silent",
  });
  return Object.keys(res.metafile.inputs);
}

// pi-schema is what pi-ai reaches where it reached TypeBox up to 1.4. pi-ai itself is deliberately not in the set: the
// model catalog the worker's triggers read is pi-ai's, so this module has always reached it.
const PI_OR_TYPEBOX = /node_modules\/(?:@earendil-works\/(?:pi-coding-agent|pi-schema)|typebox)\//;

test("insights-assembly.mjs reaches neither the pi runtime nor typebox, and the walk would see them", async () => {
  const files = await reached("./insights-assembly.mjs");
  assert.ok(files.some((f) => f.endsWith("src/read-model.mjs")), "the walk followed the module's imports");
  assert.deepEqual(files.filter((f) => PI_OR_TYPEBOX.test(f)), []);
  // The control: the pricing export this module takes as a parameter instead of importing reaches pi-schema through pi-ai,
  // so a regression that imports it here turns this red.
  assert.ok((await reached("@edgehero/pi-dispatch/pricing")).some((f) => PI_OR_TYPEBOX.test(f)), "the walk finds pi-schema where it is");
});

// The facade's shape, canned like the costs tests' (no model is priced, so a metered run keeps its own cost).
const PRICING = { getPricedModel: () => null, isZeroRated: () => false, reprice: () => null, listPricedModels: () => [], piAiVersion: () => "1.2.3" };

function deployment() {
  const dir = tempDir("admin-insights-assembly-");
  const logs = join(dir, "logs");
  const env = {
    // Unparseable, so every Valkey read degrades synchronously (a dead port would leak an async error into the suite).
    VALKEY_URL: "not-a-url",
    PI_LOGS_DIR: logs,
    PI_SETTINGS_FILE: join(dir, "settings.json"),
    PI_TRIGGERS_FILE: join(dir, "triggers.json"),
    PI_SCOPED_LIMITS_FILE: join(dir, "scoped-limits.json"),
    PI_SUBSCRIPTIONS_FILE: join(dir, "subscriptions.json"),
    PI_PROJECTS_FILE: join(dir, "projects.json"),
    PI_GRAPH_DIR: join(dir, "graph"),
  };
  writeFileSync(env.PI_TRIGGERS_FILE, JSON.stringify({ triggers: [{ on: { type: "cron", id: "n", pattern: "0 3 * * *" }, run: { kind: "local", folder: join(dir, "absent"), flow: "tidy", task: "t" } }] }));
  writeFileSync(env.PI_SUBSCRIPTIONS_FILE, JSON.stringify({ version: 1, subscriptions: [{ id: "kimi", vendor: "Moonshot AI", provider: "kimi-coding", models: ["*"], price: { amount: 90, currency: "USD", per: "month" } }] }));
  writeFileSync(env.PI_PROJECTS_FILE, JSON.stringify({ version: 1, projects: [{ id: "site", name: "Site", members: ["github:acme/web"] }] }));
  const endedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const usage = { v: 1, piAi: "1.2.3", truncated: 0, models: [{ provider: "anthropic", model: "claude-sonnet-4", calls: 2, input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, total: 1500, cost: 0.5 }] };
  const record = { jobId: "cost-1", target: "local:repo", flow: "tidy", outcome: "completed", endedAt, provider: "anthropic", model: "claude-sonnet-4", tokens: { input: 1000, output: 500, total: 1500, cost: 0.5, metered: true, calls: 2, unpriced: 0, unresolved: 0 }, usage };
  mkdirSync(logs);
  writeFileSync(join(logs, "cost-1.json"), JSON.stringify(record));
  return { env, paths: resolvePaths(env) };
}

test("assembleInsights runs in a process without pi, over a small deployment, and its sections render", async () => {
  const { env, paths } = deployment();
  const nowMs = Date.now();
  let envReads = 0;
  const payload = await assembleInsights(paths, "7d", { pricing: PRICING, nowMs, envFn: () => (envReads++, env) });
  assert.deepEqual(Object.keys(payload).sort(), ["capacity", "costByTrigger", "costsUnreachable", "fold", "graph", "projects", "sizing", "window"]);
  assert.equal(payload.window, "7d");
  assert.equal(payload.costsUnreachable, null);
  assert.equal(payload.fold.provenance.runsTotal, 1, "the one run record was folded");
  assert.equal(payload.fold.provenance.piAiPin, "1.2.3", "through the facade it was handed");
  assert.deepEqual(payload.projects, [{ id: "site", name: "Site" }]);
  assert.deepEqual(payload.fold.plans.map((x) => x.id), ["kimi"], "the declared plan was scored");
  assert.equal(payload.allocation, undefined, "no allocation slice: there is no envelope");
  assert.equal(payload.budget, undefined, "no budget slice: there are no token windows");
  assert.ok(envReads >= 1, "the deployment's environment came from envFn, not this process's");
  // The console's whole insights body still builds from it, and carries every section as the renderers draw it.
  const tips = [];
  const nf = html.normFold(payload.fold);
  const scene = buildGraphScene(payload.graph, { now: nowMs });
  const { minted, html: spendHtml } = html.topologySpend(scene, html.normSpendMap(payload.costByTrigger));
  const names = html.normProjectNames(payload.projects);
  const label = html.insightsWindowLabel(payload.window);
  const page = String(insightsBody(payload, nowMs));
  assert.ok(page.includes('id="graph"'));
  const zhPage = String(insightsBody(payload, nowMs, { locale: "zh" }));
  assert.match(zhPage, /累计/);
  assert.match(zhPage, /每日费用/);
  assert.match(zhPage, /令牌图例|已计量：pi 的计量器读取完整/);
  assert.match(zhPage, /连线/);
  assert.doesNotMatch(zhPage, /no project to size|peak memory against size|no graph model supplied/);
  const zh = (message) => uiText(message, "zh");
  const zhSizing = html.sizingSectionHtml(html.normSizing(payload.sizing), [], nowMs, zh);
  assert.doesNotMatch(zhSizing, /no project to size|peak memory against size/);
  const zhTopology = html.topologySectionHtml(scene, spendHtml, zh);
  assert.match(zhTopology, /链深度/);
  assert.match(zhTopology, /已计量：pi 的计量器读取完整/);
  assert.match(bannersHtml({ ok: false, meta: { triggersMissing: true, triggersInvalid: null } }, zh), /未提供图模型/);
  assert.doesNotMatch(zhPage, /cumulative window spend|no spend recorded/);
  const sections = {
    kpis: html.kpisHtml(nf),
    sizing: html.sizingSectionHtml(html.normSizing(payload.sizing), tips, scene.nowMs),
    capacity: html.capacitySectionHtml(html.normCapacity(payload.capacity), tips, scene.nowMs, label),
    plans: html.planCardsHtml(nf.plans),
    daily: html.dailyChartHtml(nf.daily, tips) + html.cumulativeHtml(nf.daily, tips),
    flows: String(html.flowLinesHtml(nf, tips)),
    breakdown: html.breakdownHtml(nf, minted, tips, names),
    topology: html.topologySectionHtml(scene, spendHtml),
    footer: html.footerHtml(nf, label),
    banners: html.costBannersHtml(payload, nf, null, null),
  };
  for (const [name, out] of Object.entries(sections)) {
    assert.equal(typeof out, "string", name);
    assert.ok(page.includes(out.trim().split("\n")[0]), `${name}: the page carries the same markup`);
  }
  assert.ok(sections.breakdown.includes("tidy"), "the breakdown names the run's flow");
});

/** What the console's CSP (no inline style, no inline script) refuses, in markup. */
const INLINE = /\sstyle\s*=\s*["'`$]|<style\b|<script\b|\son[a-z]+\s*=\s*["'`$]/i;

test("the exported section renderers emit no inline style, script or handler (the console's CSP)", () => {
  // By source, over everything the renderers can emit: both modules minus the stylesheet and the label fitter (which the
  // console serves as its stylesheet and inside its one script).
  const cut = (src, start, end) => {
    const i = src.indexOf(start);
    assert.ok(i >= 0, start);
    const j = src.indexOf(end, i + start.length);
    assert.ok(j >= 0, end);
    return src.slice(0, i) + src.slice(j + end.length);
  };
  let ih = readFileSync(new URL("../src/insights-html.mjs", import.meta.url), "utf8");
  ih = cut(ih, "export const INSIGHTS_CSS = `", "\n`;");
  ih = ih.replace(/^\s*(\/\/|\*|\/\*\*).*$/gm, ""); // comments name what is refused
  let gh = readFileSync(new URL("../src/graph-html.mjs", import.meta.url), "utf8");
  gh = cut(gh, "export const FIT_JS = `", "\n`;");
  gh = gh.replace(/^\s*(\/\/|\*|\/\*\*).*$/gm, "");
  assert.doesNotMatch(ih, INLINE);
  assert.doesNotMatch(gh, INLINE);
  // And the topology pane's scale cap, the one inline style the page had, is an attribute the CSP allows.
  assert.match(ih, /<svg id="graph" class="canvas" width="\$\{/);
});

// ---- moved from the retired /dispatch insights command (the insights move to the console) ----
// What that command's suite held about the PAGE (its budget, split and capacity sections, the full-paths opt-in, both
// windows) is held here on the console's own renderer over `assembleInsights`; what it held about writing a file and
// opening a browser left with the file.


/** The console's insights body for a payload, as a string (the spend screen's `p-insights` panel draws exactly this). */
const pageOf = (payload, now, opts) => String(insightsBody(payload, now, opts));

const cmdFixtureDir = tempDir("admin-insights-cmd-fixture-");
const cmdLogsDir = tempDir("admin-insights-cmd-logs-");
const cmdTriggersPath = join(cmdFixtureDir, "triggers.json");
writeFileSync(cmdTriggersPath, JSON.stringify({ triggers: [{ on: { type: "cron", id: "n", pattern: "0 3 * * *" }, run: { kind: "local", folder: join(cmdFixtureDir, "absent"), flow: "tidy", task: "t" } }] }));

/** A deployment's paths whose every Valkey read degrades synchronously (an unparseable URL). */
function cannedPaths() {
  return {
    triggersPath: cmdTriggersPath,
    logsDir: cmdLogsDir,
    subscriptionsPath: join(cmdFixtureDir, "subscriptions.json"), // absent: degrades to no plans
    valkeyUrl: "not-a-url",
    chainDepthMax: 1,
    chainMaxPerJob: 2,
  };
}

/** `assembleInsights` then the console's renderer, at one instant, as the spend screen does for one request. */
async function assembledPage(paths, window, { fullPaths = false, now = 1770000000000 } = {}) {
  const payload = await assembleInsights(paths, window, { pricing: PRICING, fullPaths, nowMs: now, envFn: () => ({}) });
  return pageOf(payload, now, { fullPaths });
}

test("full paths are the explicit opt-in that puts run.folder paths into the page (an operator's ?paths=full)", async () => {
  const probe = join(cmdFixtureDir, "absent");
  assert.ok(!(await assembledPage(cannedPaths(), "30d")).includes(probe), "the default page carries no absolute host path");
  assert.ok((await assembledPage(cannedPaths(), "30d", { fullPaths: true })).includes(probe), "the opted-in page names the configured folder by its full path");
});

test("the page carries both halves: the topology svg and the spend section, windows both stated", async () => {
  const page = await assembledPage(cannedPaths(), "7d");
  assert.ok(page.includes('id="graph"'), "the topology pane is in the page");
  assert.ok(page.includes("spend window: last 7d"), "the requested spend window is stated");
  assert.ok(page.includes("topology: fixed 30d record window"), "the fixed topology window is stated beside it");
});

// ---- the capacity section's assembler (issue #599, phase 4) ----

const { computeCapacity } = await import("@edgehero/pi-dispatch/capacity");
const { TRUNCATED_NOTE, capacityText } = await import("@edgehero/pi-dispatch/capacity-cli");

const CNOW = Date.parse("2026-10-08T12:00:00.000Z");
const CH = 60 * 60 * 1000;
function capReport() {
  const cap = { slots: 4, memMiB: 16384, cpuCenti: 800, cpus: 8 };
  const rec = (jobId, host, project, from, to, extra = {}) => ({ jobId, host, project, startedAt: new Date(CNOW - from * CH).toISOString(), endedAt: new Date(CNOW - to * CH).toISOString(), queuedAt: new Date(CNOW - from * CH - 40_000).toISOString(), capacity: cap, size: { memMiB: 4096, cpuCenti: 200, source: "env" }, resources: { cpuUsec: 3_600_000_000 }, ...extra });
  const records = [rec("a", "mini1", "web", 30, 28), rec("b", "mini1", "api", 29, 27), rec("c", "mini1", "web", 5, 4, { attempt: 2 }), rec("d", "mini2", "docs", 3, 1), { ...rec("e", "mini1", "web", 2, 2), capacity: null }];
  const live = [{ name: "mini1", routes: "true", concurrency: "4", staleMs: 1000, jobs: "[]" }, { name: "mini2", routes: "true", concurrency: "2", staleMs: 1000, jobs: "[]" }, { name: "laptop", routes: "false", concurrency: "1", staleMs: 1000, jobs: "[]" }];
  const coverage = { source: "mirror", reason: null, localHost: "mini1", local: null, mirror: { fromMs: CNOW - 48 * CH, truncated: true, hosts: ["mini1", "mini2"] } };
  return computeCapacity({ records, live, windowStartMs: CNOW - 7 * 24 * CH, nowMs: CNOW, bucketMs: CH, coverage });
}

test("capacityViewOf: every headline number and caveat is the CLI's own text for the same report", () => {
  const report = capReport();
  const view = ia.capacityViewOf(report);
  const text = capacityText(report, { since: "7d" });
  assert.deepEqual(view.window, report.window);
  assert.equal(view.truncated, true);
  // The page draws the cut history as its own warning (`truncated`), where the CLI's line says it as a clause.
  assert.equal(`Coverage: ${[view.coverage[0], TRUNCATED_NOTE, ...view.coverage.slice(1)].join("; ")}.`, text.trim().split("\n").at(-2), "the coverage clauses are the CLI's, one by one");
  assert.deepEqual(view.hosts.map((h) => h.name), ["laptop", "mini1", "mini2"]);
  const laptop = view.hosts[0];
  assert.equal(laptop.facts, undefined, "a host whose history is not here has no numbers");
  assert.ok(text.includes(`no history here: ${laptop.notShared}`));
  for (const h of view.hosts.slice(1)) {
    const f = h.facts;
    const of = f.slots !== null ? ` of ${f.slots}` : "";
    assert.ok(text.includes(`  busy ${f.busy}, idle ${f.idle}${f.missing ? ` (${f.missing} of the window has no history)` : ""}\n`), h.name);
    assert.ok(text.includes(`  slots: avg ${f.avg}${of}, peak ${f.peak}${of}${f.full !== null ? `, full ${f.full} of the time` : ""}`), h.name);
    assert.ok(text.includes(`  promised: ${f.memory}, ${f.cpu}\n`), h.name);
    if (f.cpuUsed !== null) assert.ok(text.includes(`  CPU used: ${f.cpuUsed}\n`), h.name);
    assert.ok(text.includes(f.wait === null ? "  wait for a slot: no run recorded one" : `  wait for a slot: ${f.wait}\n`), h.name);
    if (f.projects.length > 0) assert.ok(text.includes(`  projects by run time: ${f.projects.join(", ")}\n`), h.name);
    for (const c of h.caveats.filter((c) => !c.startsWith("slots: "))) assert.ok(text.includes(`  ${c}\n`), `${h.name}: ${c}`);
    assert.ok(text.includes(`  ${h.notes}\n`), h.name);
    assert.deepEqual(h.buckets, report.hosts.find((r) => r.name === h.name).buckets, "the buckets as the report has them");
  }
  // the hand-checkable ones: mini1's two runs overlap for an hour, and its history starts 48h back, inside the window
  const mini1 = view.hosts[1];
  assert.equal(mini1.facts.peak, 2);
  assert.equal(mini1.facts.missing, "71.4%");
  assert.equal(mini1.truncated, true);
  assert.ok(mini1.caveats.includes("1 job refused before a slot"));
  assert.ok(mini1.caveats.some((c) => c.startsWith("1 retried run")));
});

test("assembleCapacityView: the page's window and instant reach the read, mtd from the start of the month", async () => {
  const seen = [];
  const readCapacityFn = async (args) => (seen.push(args), { report: capReport() });
  const paths = cannedPaths();
  const view = await ia.assembleCapacityView(paths, "mtd", CNOW, { readCapacityFn, env: {} });
  assert.equal(view.hosts.length, 3);
  const [a] = seen;
  assert.equal(a.url, "not-a-url");
  assert.equal(a.now(), CNOW, "the page's instant, not a clock of its own");
  assert.equal(a.span.sinceMs(CNOW), Date.parse("2026-10-01T00:00:00.000Z"), "mtd starts at the start of the month, as the spend does");
  assert.equal(a.span.bucketMs, 6 * CH);
  await ia.assembleCapacityView(paths, "7d", CNOW, { readCapacityFn, env: {} });
  assert.equal(seen[1].span.sinceMs(CNOW), CNOW - 7 * 24 * CH);
  assert.equal(seen[1].span.bucketMs, CH);
  await ia.assembleCapacityView(paths, "30d", CNOW, { readCapacityFn, env: {} });
  assert.equal(seen[2].span.sinceMs(CNOW), CNOW - 30 * 24 * CH);
  assert.equal(seen[2].span.bucketMs, 6 * CH);
  assert.deepEqual(ia.INSIGHTS_CAPACITY_BUCKET_MS, { "24h": CH, "7d": CH, "30d": 6 * CH, mtd: 6 * CH });
  // a read that fails says so; it is never a host with nothing to show
  assert.deepEqual(await ia.assembleCapacityView(paths, "7d", CNOW, { readCapacityFn: async () => ({ error: "PI_LOG_RETENTION_DAYS must be a non-negative integer" }), env: {} }), { unreachable: "PI_LOG_RETENTION_DAYS must be a non-negative integer" });
  assert.deepEqual(await ia.assembleCapacityView(paths, "7d", CNOW, { readCapacityFn: async () => { throw new Error("EACCES"); }, env: {} }), { unreachable: "the capacity report could not be read (EACCES)" });
});

test("the page carries the capacity section for its window, read with the page's own instant", async () => {
  const page = await assembledPage(cannedPaths(), "mtd", { now: CNOW });
  assert.ok(page.includes("<h2>capacity</h2>"));
  assert.ok(page.includes('month to date, from <time datetime="2026-10-01T00:00:00.000Z">2026-10-01 00:00 UTC</time> to <time datetime="2026-10-08T12:00:00.000Z">2026-10-08 12:00 UTC</time>'), "the window is the page's, ending at its instant");
  assert.ok(page.includes("Jobs only: a machine busy with other work reads as idle."));
});

test("assembleCapacityView: a report it cannot word degrades the section, and the month's first millisecond is no time yet", async () => {
  const paths = cannedPaths();
  for (const junk of [{ hosts: [null] }, { hosts: [{ name: "a", shared: true, coveredMs: 5 }] }, { hosts: [{ name: "a", shared: true, coveredMs: 5, capacity: {}, waits: { n: 0 }, projects: null }] }]) {
    const view = await ia.assembleCapacityView(paths, "7d", CNOW, { readCapacityFn: async () => ({ report: junk }), env: {} });
    assert.match(view.unreachable, /^the capacity report could not be read/, JSON.stringify(junk));
  }
  for (const coverage of [null, 7]) {
    const view = await ia.assembleCapacityView(paths, "7d", CNOW, { readCapacityFn: async () => ({ report: { ...capReport(), coverage } }), env: {} });
    assert.ok(Array.isArray(view.hosts) && Array.isArray(view.coverage), `a coverage of ${coverage} is worded as none`);
  }
  const first = Date.parse("2026-10-01T00:00:00.000Z");
  let asked = 0;
  const v = await ia.assembleCapacityView(paths, "mtd", first, { readCapacityFn: async () => (asked++, { report: capReport() }), env: {} });
  assert.deepEqual(v, { noTime: true, fromMs: first });
  assert.equal(asked, 0, "nothing to read");
});

test("capacityViewOf: a long list of hosts whose history is not here is summarised, and nothing after it is lost", () => {
  const report = capReport();
  report.coverage = { ...report.coverage, historyNotShared: Array.from({ length: 14 }, (_, i) => `h${String(i).padStart(2, "0")}-${"x".repeat(58)}`), withoutHost: 3, reason: "Valkey did not answer" };
  const view = ia.capacityViewOf(report);
  assert.equal(view.coverage[1], `14 hosts whose history is not here: ${report.coverage.historyNotShared.slice(0, ia.INSIGHTS_CAPACITY_NAMES_SHOWN).join(", ")} and 9 more`);
  assert.ok(view.coverage.includes("3 without a host, not counted"));
  assert.equal(view.coverage.at(-1), "Valkey did not answer");
});

test("console Capacity coverage preserves actual zero counts and unknowns without widening static export", () => {
  const report = capReport();
  const consoleView = ia.capacityViewOf(report, { consoleDetails: true });
  assert.equal(consoleView.hostCount, report.hosts.length);
  for (const key of ["used", "refusedBeforeSlot", "retried", "withoutSize", "live", "liveNotCounted", "running"]) assert.equal(consoleView.coverageCounts[key], report.coverage[key], key);
  assert.equal(consoleView.coverageCounts.source, report.coverage.source);
  const unknown = ia.capacityViewOf({ ...report, coverage: { ...report.coverage, used: undefined, retried: 0, withoutSize: -1, running: null } }, { consoleDetails: true });
  assert.equal(unknown.coverageCounts.used, null);
  assert.equal(unknown.coverageCounts.retried, 0);
  assert.equal(unknown.coverageCounts.withoutSize, null);
  assert.equal(unknown.coverageCounts.running, null);
  const shared = ia.capacityViewOf(report);
  assert.equal("coverageCounts" in shared, false);
  assert.equal("hostCount" in shared, false);
  assert.equal(shared.hosts.some((host) => "venues" in host), false);
});
