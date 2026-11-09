import { test } from "node:test";
import assert from "node:assert/strict";
import { cardDocument } from "./helpers/card-structure.mjs";
import { drawSpend, spendFixture } from "./helpers/spend-goldens.mjs";
import { spendTabs, spendControls, capacityHosts, capacityKey, capacityCoverage, spendToday } from "../src/console/panels/spend.mjs";

// Read the rendered controls, rather than accepting a panel heading as evidence
// that the design's navigation and scoping controls exist.
test("all four Spend tabs are real links with exactly one current destination", () => {
  const paths = ["/insights", "/insights/capacity", "/insights/breakdown", "/insights/flows"];
  const pages = ["insights", "insights-capacity", "insights-breakdown", "insights-flows"];
  for (let i = 0; i < pages.length; i++) {
    const text = String(spendTabs({ page: pages[i], query: { range: "7d", project: "web" } }));
    const links = [...text.matchAll(/<a href="([^"]+)"([^>]*)>([\s\S]*?)<\/a>/g)];
    assert.equal(links.length, 4);
    assert.deepEqual(links.map((m) => m[1].split("?")[0]), paths);
    assert.deepEqual(links.filter((m) => m[2].includes('aria-current="page"')).map((m) => m[1].split("?")[0]), [paths[i]]);
  }
});

test("Spend controls render actual range and project links, while Capacity keeps its own scope", () => {
  const view = (page) => ({ page, query: { range: "7d", project: "web" }, data: { insights: { projects: [{ id: "web", name: "Web" }, { id: "ops", name: "Operations" }] } } });
  const spend = String(spendControls(view("insights")));
  for (const range of ["7d", "30d", "mtd"]) assert.match(spend, new RegExp(`href="/insights\\?range=${range}&amp;project=web"`));
  assert.match(spend, /href="\/insights\?range=7d&amp;project=ops"/);
  assert.match(spend, /href="\/insights\?range=7d">All projects/);
  const capacity = String(spendControls(view("insights-capacity")));
  assert.match(capacity, /range=24h/);
  assert.doesNotMatch(capacity, /project=|aria-label="Projects"/);
});

const viewOf = (payload, role = "viewer", query = {}) => ({ role, query, now: payload.nowMs, data: { insights: payload } });

test("Capacity fixed labels render in Chinese while Today keeps its record-only words", () => {
  const p = spendFixture();
  const view = { ...viewOf(p), locale: "zh" };
  const today = String(spendToday(view));
  assert.match(today, /<h2>今天<\/h2>/);
  assert.match(today, /今日记录中的已结算金额/);
  assert.doesNotMatch(today, /No daily token cap|of cap|held for/);
  const capacity = String(capacityHosts(view));
  assert.match(capacity, /项目页面/);
  assert.doesNotMatch(capacity, /Job sizes and their suggestions|Venues unknown|slot count unknown/);
});

test("Capacity hosts render venues, three state shares, a chart and distinct operational fact groups", () => {
  const p = spendFixture();
  p.capacity.hosts[0].venues = ["docker", "podman", "<script>bad-venue</script>"];
  const text = String(capacityHosts(viewOf(p)));
  assert.match(text, /docker/);
  assert.match(text, /podman/);
  assert.doesNotMatch(text, /bad-venue/);
  assert.match(text, /class="cp-trio"/);
  assert.match(text, /class="cp-chart/);
  assert.match(text, /class="cp-facts"/);
  for (const label of ["busy", "idle", "no data", "Jobs at once", "Full", "Promised", "CPU used", "Wait for a slot", "Projects by run time"]) assert.ok(text.includes(label), label);
  // The chart has different visual primitives for average, peak and configured slots.
  assert.match(text, /class="cp-bar"/);
  assert.match(text, /class="cp-peak-line"/);
  assert.match(text, /class="cp-slots"/);
  const bars = [...text.matchAll(/<rect class="cp-bar"[^>]*height="([0-9.]+)"/g)];
  assert.ok(bars.length > 0 && bars.every((bar) => Number(bar[1]) > 0));
  p.capacity.hosts[0].buckets[0].coveredMs = 0;
  p.capacity.hosts[0].truncated = true;
  const truncated = String(capacityHosts(viewOf(p)));
  assert.match(truncated, /class="cp-gap"/);
  assert.match(truncated, /class="cp-hatch"/);
  assert.match(truncated, /History truncated/);
});

test("Capacity chart key explains the five distinct chart marks", () => {
  const text = String(capacityKey());
  for (const label of ["average", "most", "slots", "no data", "idle"]) assert.ok(text.toLowerCase().includes(label), label);
  assert.match(text, /cp-key/);
});

test("Capacity coverage shows each actual count and preserves unknown instead of inventing zero", () => {
  const p = spendFixture();
  p.capacity.coverageCounts = { used: 37, refusedBeforeSlot: 11, retried: 5, withoutSize: 3, running: 2, liveNotCounted: null };
  const text = String(capacityCoverage(viewOf(p)));
  for (const [label, value] of [["Runs counted", "37"], ["Refused before a slot", "11"], ["Retried", "5"], ["Without a size", "3"], ["Running now", "2"], ["Live runs not counted", "unknown"]]) {
    assert.match(text, new RegExp(`<dt>${label}</dt><dd>${value}</dd>`));
  }
});

test("Capacity tooltips reference one escaped list across all host charts", () => {
  const p = spendFixture();
  p.capacity.hosts[0].buckets[0].coveredMs = 0;
  const text = String(capacityHosts(viewOf(p)));
  const hidden = text.match(/<ol id="insights-tips"[^>]* hidden>([\s\S]*?)<\/ol>/);
  assert.ok(hidden, "script-free hidden tooltip list");
  const entries = [...hidden[1].matchAll(/<li>([\s\S]*?)<\/li>/g)];
  const refs = [...text.matchAll(/data-tip="(\d+)"/g)].map((m) => Number(m[1]));
  assert.ok(refs.length > 20, "all host buckets contribute tooltips");
  assert.deepEqual([...new Set(refs)].sort((a, b) => a - b), entries.map((_, i) => i));
  assert.ok(entries.some((e) => e[1].includes("no data, neither busy nor idle")));
  assert.ok(entries.some((e) => e[1].includes("average") && e[1].includes("peak")));
  assert.doesNotMatch(hidden[1], /<(?:script|svg|img)\b/);
});


test("Spend renders its three cost cards together and separates main charts from the contextual column", async () => {
  const doc = cardDocument(await drawSpend());
  const costs = doc.nodes.find((n) => n.classes.includes("spend-costs"));
  assert.ok(costs?.classes.includes("cards-3"));
  for (const id of ["p-byflow", "p-bymodel", "p-byproject"]) assert.ok(doc.byId.get(id)?.ancestors.includes(costs), id);
  const main = doc.nodes.find((n) => n.classes.includes("spend-main"));
  const side = doc.nodes.find((n) => n.classes.includes("spend-side"));
  for (const id of ["p-over", "p-sizes"]) assert.ok(doc.byId.get(id)?.ancestors.includes(main), id);
  for (const id of ["p-whatif", "p-plan"]) assert.ok(doc.byId.get(id)?.ancestors.includes(side), id);
});
