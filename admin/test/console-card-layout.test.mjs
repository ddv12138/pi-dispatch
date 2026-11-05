import assert from "node:assert/strict";
import { test } from "node:test";
import { FLEET_DRAW } from "./helpers/fleet-goldens.mjs";
import { cardDocument } from "./helpers/card-structure.mjs";

// Read production-rendered HTML, not PAGE_LAYOUT source. A panel can exist and still be in the wrong column.
const column = (node) => node.ancestors.findLast((parent) => parent.classes.includes("cols"));
const stackIn = (node, cols) => node.ancestors.find((parent) => parent.ancestors.at(-1) === cols);
const panel = (doc, id) => { const node = doc.byId.get(id); assert.ok(node, `${id} rendered`); return node; };

test("Fleet keeps the active table full width around its wide sidebar layout", async () => {
  const doc = cardDocument(await FLEET_DRAW["fleet-running.operator"]());
  const bar = panel(doc, "p-fleetbar");
  const active = panel(doc, "p-active");
  assert.equal(column(bar), undefined);
  assert.equal(column(active), undefined, "running jobs need the full-width table from FleetScreen");
  const queues = panel(doc, "p-queues");
  const cols = column(queues);
  assert.ok(cols?.classes.includes("cols--wide-side"), "the card uses its wide sidebar proportions");
  assert.ok(bar.start < active.start && active.end < cols.start);
  const main = stackIn(queues, cols);
  for (const id of ["p-held", "p-failed", "p-delayed", "p-schedules"]) assert.equal(stackIn(panel(doc, id), cols), main, `${id} belongs beside hosts, not below the whole page`);
  const side = stackIn(panel(doc, "p-hosts"), cols);
  assert.notEqual(side, main);
  assert.equal(stackIn(panel(doc, "p-doctor"), cols), side);
});

test("Host state leads the wide jobs/budget/history column and the registry/doctor sidebar", async () => {
  const doc = cardDocument(await FLEET_DRAW["host-stale.operator"]());
  const state = panel(doc, "p-hoststate");
  const jobs = panel(doc, "p-hostjobs");
  const cols = column(jobs);
  assert.ok(cols?.classes.includes("cols--wide-side"));
  assert.equal(column(state), undefined);
  assert.ok(state.end < cols.start);
  const main = stackIn(jobs, cols);
  for (const id of ["p-hostbudget", "p-hostcap"]) assert.equal(stackIn(panel(doc, id), cols), main);
  const side = stackIn(panel(doc, "p-hostrow"), cols);
  assert.notEqual(side, main);
  assert.equal(stackIn(panel(doc, "p-hostdoctor"), cols), side);
});

test("the same card layouts retain their facts and fixes for viewers without mutation or command controls", async () => {
  for (const key of ["fleet-running.viewer", "host-fresh.viewer"]) {
    const doc = cardDocument(await FLEET_DRAW[key]());
    assert.equal(doc.nodes.some((node) => Object.hasOwn(node.attrs, "data-action")), false, `${key}: no mutation form`);
    assert.equal(doc.nodes.some((node) => Object.hasOwn(node.attrs, "data-copy")), false, `${key}: no operator command copy control`);
    assert.ok(doc.byId.has(key.startsWith("fleet") ? "p-active" : "p-hostdoctor"), `${key}: facts remain visible`);
  }
});

test("a read-only operator gets no mutation form on the fleet page", async () => {
  const readOnly = cardDocument(await FLEET_DRAW["fleet-read-only.operator"]());
  assert.equal(readOnly.nodes.some((node) => Object.hasOwn(node.attrs, "data-action")), false);
});
