import assert from "node:assert/strict";
import { test } from "node:test";
import { SPEND_DRAW, SPEND_HOSTILE_REASON, SPEND_PANEL_STATES, spendFixture, drawSpend } from "./helpers/spend-goldens.mjs";
import { cardDocument, cardText } from "./helpers/card-structure.mjs";
import { assertClean } from "./helpers/console-pages-harness.mjs";
import { SPEND_PANELS } from "../src/console/panels/spend.mjs";

const rendered = Promise.all(Object.entries(SPEND_DRAW).map(async ([key, draw]) => [key, await draw()])).then(Object.fromEntries);
const expected = {
  "spend-no-dollar-window.viewer": ["settled from run records", "7,000"],
  "spend-partial-money.viewer": ["unknown cost", "≥"],
  "spend-unknown-money.viewer": ["unknown cost", "unknown"],
  "spend-model-triggers.viewer": ["plan-provider", "plan-model", "row 2"],
  "spend-whatif-runs.viewer": ["Token totals do not depend on the model", "would use about", "30,000"],
  "spend-whatif-flow.viewer": ["Per run", "Window estimate", "Context window"],
  "spend-populated.operator": ["Today"],
  "spend-populated.viewer": ["Full local paths are shown to operators only", "Metered and plan"],
  "spend-costs-unreadable.viewer": ["Costs could not be read. The other Spend views still work."],
  "spend-capacity.viewer": ["Fleet busy", "build3", "mini1", "mini2", "Jobs only: a machine busy with other work reads as idle"],
  "spend-capacity-no-time.viewer": ["No time in this window yet"],
  "spend-capacity-unreadable.viewer": ["Capacity not read", "The other Spend views still work."],
  "spend-capacity-truncated.viewer": ["Incomplete history", "Missing time is drawn as no data and is never counted as idle."],
  "spend-breakdown.viewer": ["Window spend", "Settled run records only", "Where these numbers come from"],
  "spend-breakdown-unreadable.viewer": ["Costs could not be read"],
  "spend-breakdown-empty.viewer": ["No runs in the spend window", "Try 30 days"],
  "spend-whatif-unknown.viewer": ["Unknown model", "acme/model-1"],
  "spend-flows-map.viewer": ["Flows map", "Fit", "What the map cannot see"],
  "spend-flows-list.viewer": ["Flows list", "Flows nothing reaches", "one-shot spent"],
  "spend-flows-selected.viewer": ["Selected trigger", "Runs in map window", "nightly"],
  "spend-flows-spent.viewer": ["Run that spent this one-shot", "review"],
  "spend-flows-invalid.viewer": ["triggers file is invalid", "Nothing is drawn until it loads"],
  "spend-flows-missing.viewer": ["Nothing is drawn until it loads"],
};

test("every Spend state has an explicit nonempty visible assertion and a real whole-page render", async () => {
  assert.deepEqual(Object.keys(expected), [...SPEND_PANEL_STATES]);
  const pages = await rendered;
  for (const [key, pieces] of Object.entries(expected)) {
    assert.ok(pieces.length > 0, key);
    const page = pages[key];
    assert.match(page, /^<!doctype html>\n/, key);
    assertClean(`panels/${key}`, page);
    const visible = cardText(page);
    for (const piece of pieces) assert.ok(visible.includes(piece), `${key}: visible ${JSON.stringify(piece)}`);
  }
});

test("flows list has no graph node payload and server selections render real details without executing script", async () => {
  const pages = await rendered;
  const list = pages["spend-flows-list.viewer"];
  assert.ok(list.includes("<table"));
  assert.ok(pages["spend-flows-map.viewer"].includes('aria-label="Zoom out"'));
  assert.ok(!list.includes('id="graph-nodes"') && !list.includes('id="graph"'));
  for (const [key, trigger] of [["spend-flows-selected.viewer", "0"], ["spend-flows-spent.viewer", "1"]]) {
    const page = pages[key];
    assert.ok(page.includes("data-selected-empty hidden"), key);
    assert.ok(page.includes("data-selected-details>"), key);
    assert.ok(page.includes(`data-trigger-index="${trigger}"`), key);
  }
  assert.ok(pages["spend-flows-spent.viewer"].includes("/run?id=gh-spent-one"));
  const models = cardDocument(pages["spend-model-triggers.viewer"]);
  const modelMarkup = models.within(models.byId.get("p-plan"));
  assert.ok(modelMarkup.includes("row 2"), "the by-model row names the trigger that ran it");
});

test("the fixture supplies nonzero folds, record spend and per-host capacity instead of empty placeholders", () => {
  const p = spendFixture();
  assert.equal(p.fold.provenance.runsTotal, 3);
  assert.ok(p.spend.today.settledTokens > 0 && p.spend.today.heldTokens === undefined, "record spend, no hold");
  assert.equal(p.capacity.hosts.length, 3);
  assert.ok(p.capacity.fleet.peak > 0);
  for (const [page, panels] of Object.entries(SPEND_PANELS)) assert.ok(panels.length >= 4, page);
});


test("all four Spend views enforce the local-path boundary even when a viewer asks for full paths", async () => {
  const secret = "/srv/private-operator/work/customer-site";
  for (const page of ["insights", "insights-capacity", "insights-breakdown", "insights-flows"]) {
    const payload = spendFixture();
    payload.fold.byRepo.push({ key: `local:${secret}`, label: `local:${secret}`, kind: "local", runs: 1, tokens: 100, amount: { tokens: 100, class: "metered", floor: false } });
    const folder = payload.graph.folders.find((f) => f.kind === "local");
    folder.path = secret;
    folder.label = "customer-site";
    for (const query of ["range=7d", "range=7d&paths=full"]) {
      const doc = await drawSpend(page, { role: "viewer", query, payload });
      assert.ok(!doc.includes("private-operator"), `${page} ${query}: no parent path in visible or hidden markup`);
      assertClean(`${page}/hostile-path`, doc);
      if (["insights-breakdown", "insights-flows"].includes(page)) assert.ok(doc.includes("customer-site"), `${page}: the folder is actually drawn by basename`);
    }
    if (["insights-breakdown", "insights-flows"].includes(page)) {
      const ordinary = await drawSpend(page, { role: "operator", query: "range=7d", payload });
      assert.ok(!ordinary.includes("private-operator"), `${page}: operators also opt in to full paths`);
      const full = await drawSpend(page, { role: "operator", query: "range=7d&paths=full", payload });
      assert.ok(full.includes(secret), `${page}: the operator opt-in really reveals the same folder`);
    }
  }
});


test("scheduled next fires are times", async () => {
  const pages = await rendered;
  const selected = cardDocument(pages["spend-flows-selected.viewer"]);
  const panel = selected.byId.get("p-flows-selected");
  assert.ok(selected.descendants(panel).some((node) => node.tag === "time"), "scheduled next fire is a real time element");
});


test("the by-model row keeps provider, model and the triggers that ran it together", async () => {
  const doc = cardDocument((await rendered)["spend-model-triggers.viewer"]);
  const panel = doc.byId.get("p-plan");
  assert.ok(panel);
  const row = doc.descendants(panel).find((node) => node.tag === "li" && cardText(doc.within(node)).includes("plan-model"));
  assert.ok(row, "the model has its own visible row");
  const text = cardText(doc.within(row));
  for (const identity of ["plan-model", "plan-provider", "row 2"]) assert.ok(text.includes(identity), identity);
});
