import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  parsePageQuery,
  pageQueryString,
  PAGES,
  loadPageData,
  renderPage,
} from "../src/console/pages.mjs";
import {
  responsiveInsightsSvg,
  SPEND_PANELS,
  SPEND_VIEWS,
  flowsMap,
  flowsSelected,
  spendToday,
  spendOver,
  spendTabs,
} from "../src/console/panels/spend.mjs";
import {
  SPEND_CARD_CSS_HASHES,
  SPEND_DESIGN_CSS,
  SPEND_CSS,
  SPEND_PAINT_TOKENS,
  SPEND_EXTRA_PAINTS,
} from "../src/console/spend-css.mjs";
import {
  assembleInsightsView,
  spendSummaryOf,
  spendChartsOf,
} from "../src/insights-assembly.mjs";
import { PAGE_CSS, pageCss } from "../src/console/page-css.mjs";
import { SPEND_DRAW, spendFixture } from "./helpers/spend-goldens.mjs";
import { assertClean } from "./helpers/console-pages-harness.mjs";

const NOW = Date.parse("2026-10-29T12:00:00Z");
const graph = {
  caps: { windowDays: 30 },
  meta: {},
  folders: [
    {
      key: "folder:/private/repo",
      path: "/private/repo",
      label: "repo",
      kind: "local",
      head: "a".repeat(40),
      triggerIds: ["trigger:3"],
      skillIds: ["skill:fix"],
    },
  ],
  nodes: [
    {
      id: "trigger:3",
      kind: "trigger",
      index: 3,
      onType: "cron",
      cronId: "weekly",
      pattern: "0 0 * * *",
      label: "Weekly",
      folderKey: "folder:/private/repo",
      flow: "fix",
      runs: 2,
      lastOutcome: "completed",
      disarmed: { at: "2026-10-29T10:00:00Z", jobId: "run-one" },
    },
    {
      id: "skill:fix",
      kind: "skill",
      name: "fix",
      label: "fix",
      folderKey: "folder:/private/repo",
      aiTrigger: true,
    },
  ],
  edges: [{ from: "trigger:3", to: "skill:fix", kind: "config" }],
  flags: [],
};
const allocation = {
  window: "week",
  totalTokens: 100_000_000,
  floors: { web: 10_000_000, _other: 0 },
  delegation: true,
  spend: { deployment: 20_000_000, projects: { web: 20_000_000 } },
  envelope: {
    window: "week",
    totalTokens: 100_000_000,
    floors: { web: 10_000_000, _other: 0 },
    defaultWeights: { web: 100, _other: 0 },
    delegation: {
      enabled: true,
      writers: ["operator-session"],
      maxStepPct: 25,
      minIntervalHours: 2,
      maxPlanDays: 7,
    },
  },
  state: {
    planId: "a".repeat(64),
    allocations: { web: 80_000_000, _other: 20_000_000 },
    weights: { web: 100, _other: 0 },
    reasons: { web: "Hostile <script>\u202e" },
    writer: "operator-session",
  },
  log: [
    {
      at: new Date(NOW).toISOString(),
      writer: "default",
      outcome: "applied",
      planId: null,
      weights: { web: 100 },
    },
  ],
};
const view = (over = {}) => ({
  page: "insights-flows",
  role: "operator",
  now: NOW,
  query: { range: "7d", project: "web" },
  data: { insights: { graph, allocation } },
  ...over,
});

test("four Spend pages are viewer reads, non-live and outside the legacy layer", () => {
  assert.equal(SPEND_VIEWS.length, 4);
  for (const [name, path] of SPEND_VIEWS) {
    assert.equal(PAGES[name].path, path);
    assert.equal(PAGES[name].auth, "viewer");
    assert.equal(PAGES[name].live, false);
    assert.ok(SPEND_PANELS[name].length >= 4);
  }
});

test("queries validate by view, bound select, accept old what-if and canonicalize round trips", () => {
  const cases = [
    ["insights", "range=7d&project=web&whatif=p%2Fm&runs=week"],
    ["insights", "whatif=p%2Fm&flow=fix"],
    ["insights-capacity", "range=24h"],
    ["insights-flows", "range=7d&select=3&view=list&paths=full"],
    ["insights-breakdown", "whatif=p%2Fm&flow=fix"],
  ];
  for (const [name, search] of cases) {
    const got = parsePageQuery(name, new URLSearchParams(search));
    assert.ok(got.query, `${name}: ${got.refusal}`);
    assert.deepEqual(
      parsePageQuery(
        name,
        new URLSearchParams(pageQueryString(name, got.query)),
      ),
      got,
    );
  }
  for (const [name, search] of [
    ["insights", "range=24h"],
    ["insights-capacity", "project=web"],
    ["insights-flows", "select=-1"],
    ["insights-flows", "select=1e9"],
    ["insights-flows", "view=other"],
    ["insights-breakdown", "whatif=p%2Fm"],
    ["insights", "runs=month"],
    ["insights", "project=../../private"],
  ])
    assert.ok(
      parsePageQuery(name, new URLSearchParams(search)).refusal,
      search,
    );
});

test("loads pass role/project/view boundaries and windowed run-set what-if without flow", async () => {
  const calls = [];
  const deps = {
    now: () => NOW,
    insights: async (...args) => (calls.push(args), {}),
    whatIf: async (q) => (calls.push(q), {}),
    fleet: {},
  };
  await loadPageData(
    "insights",
    { range: "7d", project: "web", paths: "full", whatif: "p/m", runs: "week" },
    deps,
    { role: "viewer" },
  );
  assert.deepEqual(calls[0], [
    "7d",
    { view: "spend", fullPaths: false, project: "web", role: "viewer" },
  ]);
  assert.deepEqual(calls[1], {
    model: "p/m",
    flow: null,
    range: "7d",
    project: "web",
    runs: "week",
  });
});

test("tab links retain only destination-supported filters and keep 24h off spend routes", () => {
  const text = String(
    spendTabs(
      view({
        page: "insights-capacity",
        query: { range: "24h", project: "web", paths: "full" },
      }),
    ),
  );
  assert.match(
    text,
    /href="\/insights\?range=30d&amp;project=web&amp;paths=full"/,
  );
  assert.match(text, /href="\/insights\/capacity\?range=24h&amp;paths=full"/);
});

test("server-selected map is accessible, links spent run and script-free list has no hidden node data", () => {
  const v = view({ query: { range: "7d", project: "web", select: "3" } });
  const map = String(flowsMap(v));
  const selected = String(flowsSelected(v));
  assert.match(map, /tabindex="0" role="button"/);
  assert.match(map, /data-trigger-index="3" aria-pressed="true"/);
  assert.match(map, /data-graph-zoom="fit"/);
  assert.match(selected, /Trigger 4/);
  assert.match(selected, /\/run\?id=run-one/);
  assert.match(selected, /\/runs\?trigger=weekly/);
  const list = String(flowsMap({ ...v, query: { ...v.query, view: "list" } }));
  assert.match(list, /Flows list/);
  assert.match(list, /4\. cron Weekly/);
  assert.doesNotMatch(list, /id="graph-nodes"|id="graph"|script/);
});

test("all four pages render clean HTML from the real slice assembler, across roles", async () => {
  const pricing = {
    listPricedModels: () => [],
    piAiVersion: () => "test",
    getPricedModel: () => null,
    isZeroRated: () => false,
    reprice: () => ({ usd: 0 }),
  };
  const reads = {
    projects: () => ({ projects: [{ id: "web", name: "Web" }] }),
    costs: () => ({ fold: { provenance: { runsTotal: 0 } }, records: [] }),
    graph: () => graph,
    capacity: () => ({ noTime: true }),
    sizing: () => null,
    hosts: () => ({ hosts: [] }),
    scan: () => [],
    subscriptions: () => ({ subscriptions: [] }),
    settings: () => ({ overlay: {} }),
  };
  for (const [name] of SPEND_VIEWS)
    for (const role of ["operator", "viewer"]) {
      const insights = await assembleInsightsView({}, "7d", {
        view: name === "insights" ? "spend" : name.slice(9),
        role,
        nowMs: NOW,
        pricing,
        reads,
        envFn: () => ({}),
      });
      const result = await renderPage(name, {
        session: { role },
        query: { range: "7d" },
        data: { now: NOW, insights },
      });
      const text = String(result.html);
      assertClean(`${name}.${role}`, text);
      assert.doesNotMatch(text, /class="legacy"/);
      if (role === "viewer")
        assert.doesNotMatch(text, /Hostile|private\/repo|data-structured/);
    }
});

// Semantic paint roles survive removal of the compatibility adapter. Rendered colors are checked in the browser.
const EXPECTED_PAINT_ROLES = {
  canvas: "canvas",
  panel: "surface",
  border: "line",
  fg: "ink",
  dim: "ink-muted",
  accent: "focus",
  amber: "attention-ink",
  danger: "failed-ink",
  green: "ok-ink",
  chipStroke: "line-strong",
  bannerBg: "failed-tint",
  control: "surface-3",
};

// Semantic paint roles survive removal of the compatibility adapter. Rendered colors are checked in the browser.
const EXPECTED_EXTRA_ROLES = {
  "#333": ["ink", "ink"],
  "#d9d9d9": ["surface", "line-strong"],
  "#a6bbcf": ["surface-3", "ink-faint"],
  "#d8bfd8": ["surface-3", "line-strong"],
  "#e7e7ae": ["surface-3", "line-strong"],
  "#c0deed": ["surface-3", "line-strong"],
  "#c7e9c0": ["surface-3", "line-strong"],
  "#fdd0a2": ["surface-3", "line-strong"],
  "#E6E0F8": ["ink-faint", "ink-faint"],
  "#ff5f57": ["failed", "failed"],
  "#6e7681": ["idle", "ink-muted"],
  "#db6d28": ["attention", "attention"],
};

test("Spend paint mapping is pinned to the renderer palette's existing semantic roles", () => {
  assert.deepEqual(SPEND_PAINT_TOKENS, EXPECTED_PAINT_ROLES);
  assert.deepEqual(SPEND_EXTRA_PAINTS, EXPECTED_EXTRA_ROLES);
});
test("viewer full-path requests redact folder caps and local repository labels on every view", async () => {
  const p = {
    graph,
    allocation,
    budget: {
      scoped: [
        { scope: "folder:/private/secret/repo", day: { used: 1, cap: 3 } },
      ],
      dollars: {
        windows: [
          {
            name: "folder:/private/secret/repo",
            ledger: "folder:/private/secret/repo",
            window: "day",
            counterMicros: 1,
            capMicros: 10,
          },
        ],
      },
    },
    fold: {
      byRepo: [
        {
          label: "/private/secret/repo",
          kind: "local",
          cost: { usd: 1, class: "metered" },
        },
      ],
    },
  };
  for (const [name] of SPEND_VIEWS) {
    const result = await renderPage(name, {
      session: { role: "viewer" },
      query: { range: "7d", paths: "full" },
      data: { now: NOW, insights: p },
    });
    assert.doesNotMatch(
      String(result.html),
      /private\/secret|private\/repo|Hostile/,
      name,
    );
  }
});

test("every link from every Spend fixture reaches a page whose query parser accepts it", async () => {
  const paths = new Map(
    Object.entries(PAGES).map(([name, page]) => [page.path, name]),
  );
  let checked = 0;
  for (const [shot, draw] of Object.entries(SPEND_DRAW)) {
    const output = await draw();
    const text = String(output.html ?? output);
    for (const match of text.matchAll(/<a\b[^>]*href="([^"#]+)"/g)) {
      const href = match[1].replaceAll("&amp;", "&");
      if (!href.startsWith("/")) continue;
      const url = new URL(href, "http://console.invalid");
      const name = paths.get(url.pathname);
      assert.ok(name, `${shot}: ${href} is a console page`);
      const got = parsePageQuery(name, url.searchParams);
      checked++;
      assert.equal(got.refusal, undefined, `${shot}: ${href}: ${got.refusal}`);
    }
  }
  assert.ok(checked > 100, `${checked} links were actually inspected`);
});
test("a cron id beyond the runs filter bound falls back to its stable trigger index", () => {
  const p = {
    graph: {
      ...graph,
      nodes: graph.nodes.map((n) =>
        n.kind === "trigger" ? { ...n, cronId: "a".repeat(176) } : n,
      ),
    },
  };
  const text = String(
    flowsSelected(
      view({ query: { range: "7d", select: "3" }, data: { insights: p } }),
    ),
  );
  assert.match(text, /href="\/runs\?trigger=3"/);
});

test("legacy chart viewBoxes preserve complete geometry when a card shrinks", () => {
  assert.equal(
    responsiveInsightsSvg(
      '<svg width="960" height="180" role="img"><g></g></svg>',
    ),
    '<svg width="960" height="180" role="img" viewBox="0 0 960 180"><g></g></svg>',
  );
  const ready = '<svg width="960" height="180" viewBox="0 0 100 40"></svg>';
  assert.equal(responsiveInsightsSvg(ready), ready);
});

test("sidebar and KPI facts keep one label/value pair per row at desktop widths", async () => {
  const fixture = spendFixture();
  for (const [name, ids] of [
    ["insights", ["today", "avg", "sizes"]],
    ["insights-flows", ["flows-selected"]],
  ]) {
    const out = await renderPage(name, {
      session: { role: "operator" },
      query: { range: "7d", select: "0" },
      data: { now: NOW, insights: fixture },
    });
    for (const id of ids) {
      const section = new RegExp(
        `<section id="p-${id}" data-panel>([\\s\\S]*?)</section>`,
      ).exec(String(out.html))?.[1];
      assert.ok(section, `${name}: ${id} exists`);
      for (const match of section.matchAll(/<dl class="([^"]*)"/g))
        assert.ok(
          match[1].split(" ").includes("facts--1"),
          `${id}: a desktop facts grid has only one label/value pair per row`,
        );
    }
  }
});
test("cron rearm stays a wire and is never described as a target skill or observed skill chain", () => {
  const p = {
    graph: {
      ...graph,
      edges: [
        ...graph.edges,
        {
          from: "trigger:3",
          to: "trigger:3",
          kind: "cron-rearm",
          label: "0 0 * * *",
        },
      ],
    },
  };
  const v = view({
    query: { range: "7d", select: "3", view: "list" },
    data: { insights: p },
  });
  const list = String(flowsMap(v));
  assert.match(list, /fix\s+skill/);
  assert.doesNotMatch(list, /skill,\s*trigger/);
  const details = String(flowsSelected(v));
  assert.doesNotMatch(details, /cron-rearm/);
});

const recordMoneyFixture = (records, budget = {}) => ({
  spend: {
    ...spendSummaryOf({ records, hosts: [], budget, nowMs: NOW }),
    ...spendChartsOf({
      records,
      sinceMs: NOW - 86_400_000,
      nowMs: NOW,
      jobCapTokens: 10_000_000,
      heldTokens: 0,
    }),
  },
});
const moneyRecord = (id, over = {}) => ({
  jobId: id,
  endedAt: new Date(NOW - 1000).toISOString(),
  outcome: "completed",
  tokensWindows: { basis: "unreserved", settledTokens: 0 },
  ...over,
});
const paidMoneyRecord = () =>
  moneyRecord("paid", {
    tokens: { total: 7, metered: true },
    usage: {
      models: [{ provider: "paid", model: "model", input: 4, output: 3 }],
    },
  });
const unknownMoneyRecord = () => moneyRecord("unknown");
const moneyView = (p) =>
  view({ page: "insights", query: { range: "7d" }, data: { insights: p } });
const settledCell = (out) =>
  /<dt>Settled in today(?:'|&#39;)s records<\/dt>\s*<dd>([\s\S]*?)<\/dd>/.exec(
    out,
  )?.[1];
const dateCell = (out) =>
  /<dt>2026-10-29<\/dt>\s*<dd>([\s\S]*?)<\/dd>/.exec(out)?.[1];

test("paid work without token windows shows its real record cost, not its unreserved zero charge", () => {
  const p = recordMoneyFixture([paidMoneyRecord()]);
  assert.equal(p.spend.today.usedTokens, 7);
  assert.equal(p.spend.today.ledgerTokens, 0);
  const today = String(spendToday(moneyView(p)));
  assert.match(today, /settled from run records/);
  assert.match(settledCell(today), /^7$/);
  assert.match(today, /own settled cost/);
  assert.match(today, /There is no token counter and no held reserve/);
  const chart = String(spendOver(moneyView(p)));
  assert.match(dateCell(chart), /^7$/);
  assert.match(chart, /2026-10-29: 7 settled/);
});

test("partly unknown record costs show a visible floor and unknown count in Today, daily values and escaped tips", () => {
  const p = recordMoneyFixture([paidMoneyRecord(), unknownMoneyRecord()]);
  assert.equal(p.spend.today.settledFloor, true);
  assert.equal(p.spend.today.unpriced, 1);
  const today = String(spendToday(moneyView(p)));
  assert.match(settledCell(today), /≥7/);
  assert.match(settledCell(today), /1 run has unknown cost/);
  const chart = String(spendOver(moneyView(p)));
  assert.match(dateCell(chart), /≥7; 1 run has unknown cost/);
  assert.match(
    chart,
    /<li>2026-10-29: ~≥7; 1 run has unknown cost settled/,
  );
});

test("all-unknown record cost stays unknown instead of an exact zero or a zero-value settled bar", () => {
  const p = recordMoneyFixture([unknownMoneyRecord()]);
  assert.equal(p.spend.today.settledTokens, null);
  const today = String(spendToday(moneyView(p)));
  assert.match(settledCell(today), /unknown; 1 run has unknown cost/);
  assert.doesNotMatch(settledCell(today), /0/);
  const chart = String(spendOver(moneyView(p)));
  assert.match(dateCell(chart), /unknown; 1 run has unknown cost/);
  assert.doesNotMatch(dateCell(chart), /0 settled/);
  assert.match(
    chart,
    /<li>2026-10-29: unknown; 1 run has unknown cost settled/,
  );
  assert.match(chart, /class="sp-gap"[^>]*>\?<\/text>/);
});

test("estimated floors and real window charges retain separate labels and actual counter reconciliation", () => {
  const partial = moneyRecord("partial", {
    tokens: { total: 7, metered: false },
    usage: null,
  });
  const p = recordMoneyFixture([partial]);
  const today = String(spendToday(moneyView(p)));
  assert.match(settledCell(today), /~≥7/);
  assert.ok(!today.includes("Counter") && !today.includes("unattributed"), "no token counter is reconciled: there is none");
  const chart = String(spendOver(moneyView(p)));
  assert.match(dateCell(chart), /~≥7/);
  assert.match(chart, /sp-bar--estimated/);
  assert.match(chart, /<li>2026-10-29: ~≥7 settled/);
});
