/**
 * The insights sections (issue #175): the trigger/flow topology's spend layer beside a cost-analytics half rendered as
 * hand-rolled inline SVG charts, drawn by the operator console's spend screen (`/insights`, issue #641). Until the
 * insights move to the console this module also built a self-contained offline page around these sections; the console
 * is now the one analytics surface, and the doctrines that page held are this module's: byte-deterministic (total
 * sorts, an injected `now`, no clock reads and no randomness), allowlist normalization (never a spread), and every
 * string escaped on its way into markup.
 *
 * Dependency posture: exactly two imports, both pure. graph-html.mjs is the scene/escaping/theme source of truth
 * (buildGraphScene lays out the topology; PAGE_THEME is the palette; `clip`, `clipColumns` and `drawnColumns` are the
 * one answer to how a string is cut and sized on these pages, issue #418; FIT_JS, which the console's script carries,
 * shortens at view time a drawn label the static estimate let run past its box, issue #422), and panel.mjs is THE amount
 * renderer -- fmtAmount/fmtTokens are the only functions allowed to turn a count into text, because the typed class
 * system is what keeps an estimate structurally distinguishable behind every figure on this page. costs.mjs is
 * deliberately NOT loaded: it reaches into the worker for its day bucketing, and one worker coupling would drag the
 * queue stack into a renderer. Its class list is duplicated below and pinned byte-for-byte by a parity test in
 * insights-html.test.mjs.
 *
 * The slice normalizers (`norm*`), the section renderers (`*SectionHtml`, `kpisHtml`, `planCardsHtml`, the daily
 * charts, `breakdownHtml`, `topologySectionHtml`) and the stylesheet are exported for the console (`console/panels.mjs`
 * composes them in `insightsBody`). A renderer takes its slice NORMALIZED, and pushes each tooltip's text onto the
 * `tips` array it is handed, the element carrying the index as `data-tip`. None of them emits a `style` attribute, a
 * `<style>` or `<script>` element, or an `on*` handler: the console's CSP refuses inline style and script, and its
 * `trustedRenderer` refuses them at the server.
 *
 * Chart encoding rule: "estimated" is drawn with fill-opacity plus a dashed outline, never an SVG hatch pattern -- a
 * pattern fill would need a paint-server reference, and the posture test bans that whole reference syntax as a
 * substring.
 */

import { clip, clipColumns, drawnColumns, escapeHtml, fmt, legendHtml, PAGE_THEME, SPEND_BADGE_DY } from "./graph-html.mjs";
import { escapeInterpreted, fmtAmount, fmtTokens } from "./panel.mjs";

// Must equal costs.mjs's COST_CLASSES; the parity test compares the two literals. Duplicated rather
// than re-exported because loading costs.mjs is exactly the worker coupling this module refuses.
// Three classes only: the pricing classes ("plan", "zero-rated", "seeded") died with pricing.
export const INSIGHTS_COST_CLASSES = Object.freeze(["metered", "estimated", "unknown"]);

// The verdict vocabulary buildPlans emits; anything else degrades to NO_BASELINE, which renders a
// sentence and never a number -- the safe direction for a malformed verdict to fail in.
const VERDICT_KINDS = Object.freeze(["SAVING", "LOSING", "WOULD_SAVE", "WOULD_LOSE", "NO_BASELINE"]);

// The fold pins its honesty buckets to the table's tail whatever the totals say (a bucket named
// "(unattributed)" sorting above real triggers would read as the biggest spender when it is really
// the biggest unknown); re-sorting here must preserve that or a permuted payload changes the story.
const TRIGGER_TAIL = Object.freeze(["chained", "manual", "unattributed"]);

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---- chart geometry (values, not CSS: the layout helpers are exported and tested as numbers) ----
const DAILY_W = 920;
const DAILY_H = 160;
const DAILY_ML = 46; // room for fmtTokens axis labels
const DAILY_MR = 10;
const DAILY_MT = 16; // room for the floor marker above a full-height bar
const DAILY_MB = 20; // room for the MM-DD tick labels
const DAILY_BAR_MAX = 26;
const LIST_W = 430;
const LIST_ROW_H = 22;
const LIST_LABEL_W = 150;
const LIST_VALUE_W = 110;
const LIST_TOP = 8; // rows per breakdown list before the "(+K more)" tail takes over
// The per-flow small multiples (issue #181): half the daily chart's width so two panels share a row,
// a short panel (two gridlines, not four -- four in 96px is noise), and the top-N cut before the
// aggregate tail line takes over. One panel per flow because series identity must be carried by
// TEXT (the panel title): the palette has one non-reserved data hue, and dashes already mean
// "estimated", so N overlaid lines could only be told apart by a channel this page refuses to load.
const FLOW_W = 452;
const FLOW_H = 96;
const FLOW_ML = 46;
const FLOW_MR = 8;
const FLOW_MT = 12;
const FLOW_MB = 16;
const LINES_TOP = 4;
// The cumulative mini-chart under the daily columns: its OWN plot with its OWN scale -- a running
// total dwarfs daily bars, and a second y-axis on one plot is the classic dual-axis lie.
const CUM_H = 84;
const CUM_LABEL_COL_W = 6; // px per column at the 9px end label, over-counted so the width is a bound
const BADGE_COL_W = 6; // px per column at the badge's 10px font, over-counted so the width is a bound
const GRAPH_MAX_SCALE = 1.35; // the topology's page pixels per scene unit, at most (a real deployment's page sits near 1.3)
const CUM_LABEL_GAP = 4; // the end label stops short of the last point's 2px dot
// Room above the plot for the end label over a last point at the very top (a total equal to the scale
// maximum): the 9px text needs 12px above its point, and a plot starting at 8 clamped it down onto the line.
const CUM_MT = 14;
function finOr(v, fallback) {
  return Number.isFinite(v) ? v : fallback;
}

function intOr(v, fallback) {
  return Number.isInteger(v) ? v : fallback;
}

function posInt(v) {
  return Number.isInteger(v) && v > 0 ? v : 0;
}

function strOr(v, fallback) {
  return typeof v === "string" && v !== "" ? v : fallback;
}

function cmpStr(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The typed-cost allowlist: usd finite-or-0, class from the known list else "unknown", floor only on
 * an exact true, coverage clamped into 0..1 or null, planId clipped or null. Nullish input stays null
 * so fmtAmount renders the em dash -- inventing a zero here would be the exact mislabeling the class
 * system exists to prevent.
 */
function normAmount(v) {
  if (v === null || v === undefined || typeof v !== "object") return null;
  const tokens = Number.isSafeInteger(v.tokens) && v.tokens >= 0 ? v.tokens : null;
  const cls = ["metered", "estimated", "unknown"].includes(v.class) ? v.class : "unknown";
  return { tokens: tokens ?? 0, class: cls, floor: v.floor === true, ...(v.coverage === undefined ? {} : { coverage: v.coverage }) };
}

function unknownCost() {
  return { tokens: 0, class: "unknown", floor: false, coverage: null };
}

/** `limit` verbatim shapes only: null (vendor undisclosed, first-class), a finite number, or a
 * finite [low, high] pair. Anything else collapses to null, the honest "we do not know" shape. */
function normLimit(v) {
  if (Number.isFinite(v)) return v;
  if (Array.isArray(v) && v.length === 2 && Number.isFinite(v[0]) && Number.isFinite(v[1])) return [v[0], v[1]];
  return null;
}


/** Daily entries: the day string must be a bare UTC date or the entry is dropped whole -- a day
 * label is an axis coordinate here, and a non-date coordinate has nowhere truthful to draw. */
function normDailyEntries(daily) {
  const out = [];
  for (const d of Array.isArray(daily) ? daily : []) {
    if (d === null || typeof d !== "object" || typeof d.day !== "string" || !DAY_RE.test(d.day)) continue;
    out.push({ day: d.day, amount: normAmount(d.amount) ?? { tokens: 0, class: "metered", floor: false }, runs: posInt(d.runs) });
  }
  // Total sort (day, then the tie fields) so a permuted payload cannot move a byte of the chart.
  out.sort((a, b) => cmpStr(a.day, b.day) || a.runs - b.runs || a.amount.tokens - b.amount.tokens);
  return out;
}

/**
 * The fold allowlist, mirroring normalizeModel's approach: explicit fields, clipped strings, and a
 * total re-sort of every array with the fold's OWN comparators -- "top 8 by the fold's order" must
 * survive a shuffled payload, so the order is re-derived here rather than trusted.
 */
export function normFold(fold) {
  if (fold === null || fold === undefined || typeof fold !== "object") return null;
  const win = fold.window !== null && typeof fold.window === "object" ? fold.window : {};
  const window = {
    fromMs: finOr(win.fromMs, null),
    toMs: finOr(win.toMs, null),
    days: posInt(win.days),
    firstRunMs: finOr(win.firstRunMs, null),
  };

  const byFlow = [];
  for (const r of Array.isArray(fold.byFlow) ? fold.byFlow : []) {
    if (r === null || typeof r !== "object") continue;
    byFlow.push({
      flow: clip(strOr(r.flow, "(no flow)"), 60),
      flowKey: typeof r.flowKey === "string" ? clip(r.flowKey, 60) : null,
      runs: posInt(r.runs),
      tokens: posInt(r.tokens),
      amount: normAmount(r.amount) ?? { tokens: 0, class: "metered", floor: false },
    });
  }
  byFlow.sort((a, b) => b.amount.tokens - a.amount.tokens || cmpStr(a.flow, b.flow));

  const byModel = [];
  for (const r of Array.isArray(fold.byModel) ? fold.byModel : []) {
    if (r === null || typeof r !== "object") continue;
    byModel.push({
      provider: clip(strOr(r.provider, "?"), 40),
      model: clip(strOr(r.model, "?"), 40),
      runs: posInt(r.runs),
      tokens: posInt(r.tokens),
      amount: normAmount(r.amount) ?? { tokens: 0, class: "metered", floor: false },
    });
  }
  byModel.sort((a, b) => b.amount.tokens - a.amount.tokens || cmpStr(a.provider, b.provider) || cmpStr(a.model, b.model));

  // null stays null: "not computed" and "nothing attributed" are different sentences, and the
  // breakdown panel says which one it is.
  let byTrigger = null;
  if (Array.isArray(fold.byTrigger)) {
    byTrigger = [];
    for (const r of fold.byTrigger) {
      if (r === null || typeof r !== "object") continue;
      const o = r.outcomes !== null && r.outcomes !== undefined && typeof r.outcomes === "object" ? r.outcomes : {};
      byTrigger.push({
        key: clip(strOr(r.key, "?"), 40),
        index: intOr(r.index, null),
        type: typeof r.type === "string" ? clip(r.type, 20) : null,
        label: clip(strOr(r.label, "(trigger)"), 60),
        runs: posInt(r.runs),
        tokens: posInt(r.tokens),
        amount: normAmount(r.amount) ?? { tokens: 0, class: "metered", floor: false },
        outcomes: { completed: posInt(o.completed), policy: posInt(o.policy), failed: posInt(o.failed) },
        failedAmount: normAmount(r.failedAmount),
      });
    }
    byTrigger.sort((a, b) => {
      const ta = TRIGGER_TAIL.indexOf(a.key);
      const tb = TRIGGER_TAIL.indexOf(b.key);
      if (ta !== -1 || tb !== -1) return ta === -1 ? -1 : tb === -1 ? 1 : ta - tb;
      return b.amount.tokens - a.amount.tokens || cmpStr(a.label, b.label) || cmpStr(a.key, b.key);
    });
  }

  const byRepo = [];
  for (const r of Array.isArray(fold.byRepo) ? fold.byRepo : []) {
    if (r === null || typeof r !== "object") continue;
    byRepo.push({
      key: typeof r.key === "string" ? clip(r.key, 60) : null,
      label: clip(strOr(r.label, "(no target)"), 60),
      kind: typeof r.kind === "string" ? clip(r.kind, 20) : null,
      runs: posInt(r.runs),
      tokens: posInt(r.tokens),
      amount: normAmount(r.amount) ?? { tokens: posInt(r.tokens) ?? 0, class: "unknown" },
    });
  }
  byRepo.sort((a, b) => b.amount.tokens - a.amount.tokens || cmpStr(a.label, b.label) || cmpStr(a.key ?? "", b.key ?? ""));

  // Issue #499 part C: by the project id each record carries. null (no section) for a fold that predates the arm, so
  // its absence never reads as "nothing spent in any project". A key that is not an id is the "(no project)" bucket.
  let byProject = null;
  if (Array.isArray(fold.byProject)) {
    // Keyed in a Map, and a key that is not an id JOINS the one "(no project)" row (PR #569's review): two bars with one
    // label would read as two buckets. Merged costs keep their class only when both agree; else "estimated".
    const rows = new Map();
    for (const r of fold.byProject) {
      if (r === null || typeof r !== "object") continue;
      const key = typeof r.key === "string" && PROJECT_ID.test(r.key) ? r.key : null;
      const row = { key, label: key ?? "(no project)", runs: posInt(r.runs), tokens: posInt(r.tokens), amount: normAmount(r.amount) ?? { tokens: 0, class: "metered", floor: false } };
      const had = rows.get(key);
      if (!had) {
        rows.set(key, row);
        continue;
      }
      const cls = had.amount.class === row.amount.class ? had.amount.class : "estimated";
      had.runs += row.runs;
      had.tokens += row.tokens;
      had.amount = { tokens: had.amount.tokens + row.amount.tokens, class: cls, floor: had.amount.floor === true || row.amount.floor === true };
    }
    byProject = [...rows.values()];
    byProject.sort((a, b) => b.amount.tokens - a.amount.tokens || cmpStr(a.label, b.label));
  }

  const plans = [];
  for (const r of Array.isArray(fold.plans) ? fold.plans : []) {
    if (r === null || typeof r !== "object") continue;
    plans.push({
      id: clip(strOr(r.id, "?"), 40),
      vendor: clip(strOr(r.vendor, "?"), 60),
      hypothetical: r.hypothetical === true,
      attributedRuns: posInt(r.attributedRuns),
      attributedTokens: posInt(r.attributedTokens),
      anyFloor: r.anyFloor === true,
      windows: (Array.isArray(r.windows) ? r.windows : [])
        .flatMap((w) => (w !== null && typeof w === "object"
          ? [{
              per: clip(strOr(w.per, "?"), 10),
              rolling: w.rolling === true,
              unit: clip(strOr(w.unit, "units"), 20),
              limit: normLimit(w.limit),
              peakRuns: posInt(w.peakRuns),
              peakTokens: posInt(w.peakTokens),
            }]
          : []))
        .sort((a, b) => cmpStr(a.per, b.per) || (a.rolling ? 1 : 0) - (b.rolling ? 1 : 0) || cmpStr(a.unit, b.unit)),
    });
  }
  // Owned plans first (a bill that exists outranks a thought experiment), id order within each band.
  plans.sort((a, b) => (a.hypothetical ? 1 : 0) - (b.hypothetical ? 1 : 0) || cmpStr(a.id, b.id));

  const prov = fold.provenance !== null && fold.provenance !== undefined && typeof fold.provenance === "object" ? fold.provenance : {};
  const provenance = {
    total: normAmount(prov.amount),
    runsTotal: posInt(prov.runsTotal),
    runsUnmetered: posInt(prov.runsUnmetered),
    runsUnledgered: posInt(prov.runsUnledgered),
    runsLedgerTruncated: posInt(prov.runsLedgerTruncated),
    ratesDrifted: posInt(prov.ratesDrifted),
    piAiPin: typeof prov.piAiPin === "string" ? clip(prov.piAiPin, 20) : null,
  };

  return {
    window,
    daily: normDailyEntries(fold.daily),
    // null when the fold predates the series (absence, never an empty grid that looks exhaustive).
    dailyByFlow: Array.isArray(fold.dailyByFlow) ? normFlowSeries(fold.dailyByFlow) : null,
    byFlow,
    byModel,
    byTrigger,
    byRepo,
    byProject,
    plans,
    provenance,
    // Issue #761: how many records from a newer pi-dispatch the fold left out, only when there were any.
    ...(Number.isSafeInteger(fold.newerSkipped) && fold.newerSkipped > 0 ? { newerSkipped: fold.newerSkipped } : {}),
  };
}

/**
 * The project id rule (worker/src/project-id.mjs), restated: this module loads nothing from the worker. Exported for
 * its bolt: `insights-html.test.mjs` holds it equal to the worker's `PROJECT_ID_RE`.
 */
export const INSIGHTS_PROJECT_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const PROJECT_ID = INSIGHTS_PROJECT_ID_RE;

/**
 * The projects' display names, `id -> name` (issue #499 part C), from the payload's `projects` list. A name is the
 * operator's free text, and `projects.json` admits a bidi override or an invisible character in it, so it is ESCAPED
 * here (`escapeInterpreted`: each such character becomes visible `\u{...}` text) and clipped; the renderer then
 * HTML-escapes it and ISOLATES it in a `<bdi>`, so even a right-to-left name cannot reorder the id or the text beside
 * it. Total: junk in, an empty map out.
 */
export function normProjectNames(v) {
  const names = new Map();
  for (const p of Array.isArray(v) ? v : []) {
    if (p === null || typeof p !== "object" || typeof p.id !== "string" || !PROJECT_ID.test(p.id)) continue;
    if (typeof p.name !== "string" || p.name.trim() === "") continue;
    names.set(p.id, clip(escapeInterpreted(p.name), 60));
  }
  return names;
}

/** The names under the by-project list: each id beside its name, the name escaped and isolated. Empty when none. */
function projectNamesHtml(rows, names) {
  const parts = [];
  for (const r of rows) {
    if (r.key === null || !names.has(r.key)) continue;
    parts.push(`<span class="pid">${escapeHtml(r.key)}</span> <bdi>${escapeHtml(names.get(r.key))}</bdi>`);
  }
  return parts.length === 0 ? "" : `<div class="dim small">${parts.join(" · ")}</div>`;
}

/** The per-flow daily series rows, allowlisted like every fold arm: label clipped, machine key kept
 * beside it, days through the same normDailyEntries the global series uses (day-regex drop, total
 * sort), rows re-sorted by window total so "top N flows" survives a permuted payload byte-identically. */
function normFlowSeries(v) {
  const rows = [];
  for (const r of Array.isArray(v) ? v : []) {
    if (r === null || typeof r !== "object") continue;
    rows.push({
      flow: clip(strOr(r.flow, "(no flow)"), 60),
      flowKey: typeof r.flowKey === "string" ? clip(r.flowKey, 60) : null,
      days: normDailyEntries(r.days),
    });
  }
  rows.sort((a, b) => {
    const sum = (x) => x.days.reduce((s, d) => s + d.amount.tokens, 0);
    return sum(b) - sum(a) || cmpStr(a.flow, b.flow);
  });
  return rows;
}

/** costByTrigger: keys are the graph's own trigger ids -- server-side join vocabulary only, they
 * never reach the page (the badge is text at a chip's coordinates, joined via the scene layout). */
export function normSpendMap(v) {
  if (v === null || v === undefined || typeof v !== "object" || Array.isArray(v)) return null;
  const out = new Map();
  for (const key of Object.keys(v)) {
    if (!key.startsWith("trigger:")) continue;
    const e = v[key];
    if (e === null || e === undefined || typeof e !== "object") continue;
    const amount = normAmount(e.amount);
    if (amount === null) continue;
    out.set(key, { amount, runs: posInt(e.runs) });
  }
  return out;
}

// 1/2/5 ladder for the y gridlines: the axis must land on amounts fmtTokens renders cleanly, and a
// step derived raw off the maximum draws labels like $0.7750 that read as false precision.
function niceStep(raw) {
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const r = raw / mag;
  const base = r <= 1 ? 1 : r <= 2 ? 2 : r <= 5 ? 5 : 10;
  return base * mag;
}

/**
 * Pure geometry for the daily column chart, exported so the invariants (bars inside the plot,
 * monotone x, gap days present, all-zero windows safe) are testable as numbers instead of parsed
 * back out of SVG. Gap days arrive as zero-run entries and KEEP their slot: skipping them would
 * compress history, which for spend is a lie of omission. Bars scale against the top gridline
 * (4 x the nice step), never the raw maximum, so the tallest bar still sits under the axis frame.
 */
export function layoutDailyChart(daily, { width, height } = {}) {
  const w = Number.isFinite(width) && width > 100 ? width : DAILY_W;
  const h = Number.isFinite(height) && height > 60 ? height : DAILY_H;
  const entries = normDailyEntries(daily);
  const plot = { x: DAILY_ML, y: DAILY_MT, w: w - DAILY_ML - DAILY_MR, h: h - DAILY_MT - DAILY_MB };
  const maxTokens = entries.reduce((m, e) => Math.max(m, e.amount.tokens), 0);
  const step = niceStep(maxTokens / 4);
  const scaleMax = step * 4;
  const yTicks = [];
  if (scaleMax > 0) {
    for (let k = 1; k <= 4; k += 1) {
      yTicks.push({ y: plot.y + plot.h - (k / 4) * plot.h, label: fmtTokens(step * k) });
    }
  }
  const n = entries.length;
  const slot = n > 0 ? plot.w / n : plot.w;
  const barW = Math.max(1, Math.min(DAILY_BAR_MAX, slot * 0.7));
  const bars = entries.map((e, i) => {
    const cx = plot.x + i * slot + slot / 2;
    let bh;
    let cls;
    if (e.runs === 0) {
      // The zero-run baseline tick: a day that ran nothing is a fact with a place on the axis,
      // drawn as a 1px sliver so it can never be mistaken for spend.
      bh = 1;
      cls = "zero";
    } else {
      bh = scaleMax > 0 ? Math.max(1, (Math.max(0, e.amount.tokens) / scaleMax) * plot.h) : 1;
      cls = e.amount.class;
    }
    return {
      x: cx - barW / 2,
      y: plot.y + plot.h - bh,
      w: barW,
      h: bh,
      cls,
      floor: e.amount.floor === true && e.runs > 0,
      runs: e.runs,
      day: e.day,
      tokens: e.amount.tokens,
    };
  });
  const every = n > 0 ? Math.ceil(n / 8) : 1;
  const xLabels = [];
  for (let i = 0; i < n; i += every) {
    xLabels.push({ x: plot.x + i * slot + slot / 2, label: entries[i].day.slice(5) });
  }
  return { bars, yTicks, xLabels, width: w, height: h, plot };
}

/**
 * Pure geometry for one horizontal bar list. The class encoding is the row's whole honesty story:
 * metered draws a solid bar, estimated a translucent dashed one, unknown nothing but the em dash.
 * `nodeId` rides through only when it is already a minted ordinal, so an original (path-bearing) id
 * can never reach a DOM attribute.
 */
export function layoutBarList(rows, { width } = {}) {
  const w = Number.isFinite(width) && width > 200 ? width : LIST_W;
  const span = w - LIST_LABEL_W - LIST_VALUE_W;
  const items = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    if (r !== null && r !== undefined && typeof r === "object") items.push(r);
  }
  // One scale per section, api-equivalents included: two bars in one list at two scales would make
  // every visual comparison between rows meaningless.
  let max = 0;
  for (const r of items) {
    const a = normAmount(r.amount);
    if (a !== null && a.tokens > max) max = a.tokens;
  }
  return items.map((r, i) => {
    const a = normAmount(r.amount);
    const cls = a === null ? "unknown" : a.class;
    const label = clip(strOr(r.label, "(unnamed)"), 60);
    const runs = posInt(r.runs);
    const barW = cls === "unknown" ? null : max > 0 ? Math.max(1, (Math.max(0, a.tokens) / max) * span) : 1;
    const failed = posInt(r.failed);
    const failedAmount = normAmount(r.failedAmount);
    const tip = `${label} · ${fmtAmount(a)} · ${fmt(runs)} runs${failed > 0 ? ` · ${fmt(failed)} failed (${fmtAmount(failedAmount)})` : ""}`;
    return {
      y: i * LIST_ROW_H,
      barW,
      chipText: null,
      // COLUMNS, cut between clusters (issue #418): the label column is a fixed 150px, and a cut by
      // code units let twenty CJK characters run into the bars beside them.
      labelText: clipColumns(label, 20),
      valueText: fmtAmount(a),
      cls,
      nodeId: typeof r.nodeId === "string" && /^n\d+$/.test(r.nodeId) ? r.nodeId : null,
      tip,
      apiW: null,
      apiText: null,
    };
  });
}

/**
 * Pure geometry for the per-flow small multiples (issue #181). ONE scale across every panel -- the
 * shared-scale rule that makes multiples comparable -- with the same band-center x math as the daily
 * columns, so a flow panel and the global chart place the same day at the same relative position.
 * A segment is dashed when EITHER endpoint day is non-metered: the line touching an estimated day
 * wears the estimate (a zero-run gap day folds to metered $0, so quiet days stay solid at the
 * baseline -- a $0 day is a measured fact here). Exported so the invariants are testable as numbers.
 */
export function layoutFlowLines(dailyByFlow, { width, height, top } = {}) {
  const w = Number.isFinite(width) && width > 100 ? width : FLOW_W;
  const h = Number.isFinite(height) && height > 40 ? height : FLOW_H;
  const rows = normFlowSeries(dailyByFlow);
  const take = Number.isInteger(top) && top > 0 ? top : LINES_TOP;
  const chosen = rows.slice(0, take);
  const rest = rows.slice(take);
  const plot = { x: FLOW_ML, y: FLOW_MT, w: w - FLOW_ML - FLOW_MR, h: h - FLOW_MT - FLOW_MB };
  let maxTokens = 0;
  for (const r of chosen) for (const d of r.days) maxTokens = Math.max(maxTokens, d.amount.tokens);
  const step = niceStep(maxTokens / 4);
  const scaleMax = step * 4;
  const panels = chosen.map((r) => {
    const n = r.days.length;
    const slot = n > 0 ? plot.w / n : plot.w;
    const points = r.days.map((d, i) => ({
      x: plot.x + i * slot + slot / 2,
      y: plot.y + plot.h - (scaleMax > 0 ? (Math.max(0, d.amount.tokens) / scaleMax) * plot.h : 0),
      day: d.day,
      tokens: d.amount.tokens,
      runs: d.runs,
      cls: d.amount.class,
      floor: d.amount.floor === true && d.runs > 0,
    }));
    const segments = [];
    for (let i = 1; i < points.length; i += 1) {
      segments.push({
        x1: points[i - 1].x,
        y1: points[i - 1].y,
        x2: points[i].x,
        y2: points[i].y,
        dashed: points[i - 1].cls !== "metered" || points[i].cls !== "metered",
      });
    }
    const yTicks = scaleMax > 0 ? [2, 4].map((k) => ({ y: plot.y + plot.h - (k / 4) * plot.h, label: fmtTokens(step * k) })) : [];
    const every = n > 0 ? Math.ceil(n / 4) : 1;
    const xLabels = [];
    for (let i = 0; i < n; i += every) {
      xLabels.push({ x: plot.x + i * slot + slot / 2, label: r.days[i].day.slice(5) });
    }
    return { flow: r.flow, flowKey: r.flowKey, plot, points, segments, yTicks, xLabels };
  });
  const restAgg =
    rest.length > 0
      ? {
          tokens: rest.reduce((s, r) => s + r.days.reduce((a, d) => a + d.amount.tokens, 0), 0),
          class: "estimated",
          floor: rest.some((r) => r.days.some((d) => d.amount.floor === true)),
        }
      : null;
  return { panels, restCount: rest.length, restAgg, scaleMax, width: w, height: h };
}

/**
 * Pure geometry for the cumulative window-spend line. Its OWN plot with its OWN nice scale under the
 * daily columns -- never a second axis on the columns plot. A prefix sum is demoted PERMANENTLY by
 * its first non-metered day (once an estimate enters a running total it never leaves), so the line
 * is dashed from that day onward and the end label is the running TYPED total -- which converges, by
 * construction, to the provenance total the KPI tile shows.
 */
export function layoutCumulative(daily, { width, height } = {}) {
  const w = Number.isFinite(width) && width > 100 ? width : DAILY_W;
  const h = Number.isFinite(height) && height > 40 ? height : CUM_H;
  const entries = normDailyEntries(daily);
  const plot = { x: DAILY_ML, y: CUM_MT, w: w - DAILY_ML - DAILY_MR, h: h - CUM_MT - DAILY_MB };
  let running = 0;
  let demoted = false;
  let floor = false;
  const raw = entries.map((e) => {
    running += Math.max(0, e.amount.tokens);
    if (e.runs > 0 && e.amount.class !== "metered") demoted = true;
    if (e.amount.floor === true) floor = true;
    return { day: e.day, total: running, demoted, floor, runs: e.runs };
  });
  const step = niceStep(running / 2);
  const scaleMax = step * 2;
  const n = raw.length;
  const slot = n > 0 ? plot.w / n : plot.w;
  const points = raw.map((r, i) => ({
    x: plot.x + i * slot + slot / 2,
    y: plot.y + plot.h - (scaleMax > 0 ? (r.total / scaleMax) * plot.h : 0),
    day: r.day,
    total: r.total,
    demoted: r.demoted,
    floor: r.floor,
  }));
  const segments = [];
  for (let i = 1; i < points.length; i += 1) {
    segments.push({ x1: points[i - 1].x, y1: points[i - 1].y, x2: points[i].x, y2: points[i].y, dashed: points[i].demoted });
  }
  const yTicks = scaleMax > 0 ? [1, 2].map((k) => ({ y: plot.y + plot.h - (k / 2) * plot.h, label: fmtTokens(step * k) })) : [];
  const endTotal = n > 0 ? { tokens: points[n - 1].total, class: points[n - 1].demoted ? "estimated" : "metered", floor } : null;
  // The end label ENDS at the last point and sits above it. It used to start just right of that point,
  // which is the right edge of the plot on any window with a run on its last day, so the label ran past
  // the svg and was cut (issue #483). Above-left is always free: a running total never falls, so every
  // earlier point is at or below the last one. When the series is too short for that (one early day), the
  // label starts at the point instead, and stays inside the chart either way.
  let endLabel = null;
  if (n > 0) {
    const text = fmtAmount(endTotal);
    const last = points[n - 1];
    const tw = drawnColumns(text) * CUM_LABEL_COL_W;
    const fitsLeft = last.x - CUM_LABEL_GAP - tw >= 0;
    // Off the gridlines too: a label straddling one moves up above it (the probe measured it across the $10
    // and $20 lines on most windows). Up is always free, for the reason above, and the plot's top margin
    // leaves room above the top gridline.
    let y = last.y - 5;
    for (const t of [...yTicks].sort((a, b) => b.y - a.y)) if (y - 9 < t.y + 0.5 && y + 2 > t.y - 0.5) y = t.y - 3;
    endLabel = {
      text,
      x: fitsLeft ? last.x - CUM_LABEL_GAP : Math.min(last.x + CUM_LABEL_GAP, w - tw),
      anchor: fitsLeft ? "end" : "start",
      y,
      width: tw,
    };
  }
  return { points, segments, yTicks, endTotal, endLabel, scaleMax, width: w, height: h, plot };
}

// ---- HTML emission (server-side strings; the page script only ever assigns them as text) ----

export function dailyChartHtml(daily, tips, translate = (message) => message) {
  if (daily.length === 0) return '<div class="dim">no runs in the spend window</div>';
  const lay = layoutDailyChart(daily, { width: DAILY_W, height: DAILY_H });
  const costByDay = new Map(daily.map((d) => [d.day, d.amount]));
  const p = lay.plot;
  const parts = [`<svg width="${fmt(DAILY_W)}" height="${fmt(DAILY_H)}" role="img" aria-label="${escapeHtml(translate("daily spend"))}">`];
  parts.push(`<line x1="${fmt(p.x)}" y1="${fmt(p.y)}" x2="${fmt(p.x)}" y2="${fmt(p.y + p.h)}" stroke="${PAGE_THEME.border}"/>`);
  parts.push(`<line x1="${fmt(p.x)}" y1="${fmt(p.y + p.h)}" x2="${fmt(p.x + p.w)}" y2="${fmt(p.y + p.h)}" stroke="${PAGE_THEME.border}"/>`);
  for (const t of lay.yTicks) {
    parts.push(`<line x1="${fmt(p.x)}" y1="${fmt(t.y)}" x2="${fmt(p.x + p.w)}" y2="${fmt(t.y)}" stroke="${PAGE_THEME.border}" stroke-width="0.5"/>`);
    parts.push(`<text x="${fmt(p.x - 6)}" y="${fmt(t.y + 3)}" text-anchor="end" font-size="9" fill="${PAGE_THEME.dim}">${escapeHtml(t.label)}</text>`);
  }
  for (const b of lay.bars) {
    const idx = tips.push(`${b.day} · ${fmtAmount(costByDay.get(b.day) ?? null)} · ${fmt(b.runs)} ${translate("runs")}`) - 1;
    if (b.cls === "zero") {
      parts.push(`<rect data-tip="${fmt(idx)}" x="${fmt(b.x)}" y="${fmt(b.y)}" width="${fmt(b.w)}" height="${fmt(b.h)}" fill="${PAGE_THEME.dim}"/>`);
    } else if (b.cls === "metered") {
      parts.push(`<rect data-tip="${fmt(idx)}" x="${fmt(b.x)}" y="${fmt(b.y)}" width="${fmt(b.w)}" height="${fmt(b.h)}" rx="2" fill="${PAGE_THEME.accent}"/>`);
    } else {
      parts.push(`<rect data-tip="${fmt(idx)}" x="${fmt(b.x)}" y="${fmt(b.y)}" width="${fmt(b.w)}" height="${fmt(b.h)}" rx="2" fill="${PAGE_THEME.accent}" fill-opacity=".45" stroke="${PAGE_THEME.accent}" stroke-dasharray="4,3"/>`);
    }
    if (b.floor && b.cls !== "zero") {
      parts.push(`<text x="${fmt(b.x + b.w / 2)}" y="${fmt(b.y - 3)}" text-anchor="middle" font-size="9" fill="${PAGE_THEME.amber}">≥</text>`);
    }
  }
  for (const xl of lay.xLabels) {
    parts.push(`<text x="${fmt(xl.x)}" y="${fmt(p.y + p.h + 14)}" text-anchor="middle" font-size="9" fill="${PAGE_THEME.dim}">${escapeHtml(xl.label)}</text>`);
  }
  if (lay.yTicks.length === 0) {
    parts.push(`<text x="${fmt(p.x + p.w / 2)}" y="${fmt(p.y + p.h / 2)}" text-anchor="middle" font-size="11" fill="${PAGE_THEME.dim}">${escapeHtml(translate("no spend recorded"))}</text>`);
  }
  parts.push("</svg>");
  return parts.join("");
}

/** Group consecutive same-dash segments into <path> runs -- one element per run, `d` built from
 * fmt output alone so the well-formedness path grammar holds by construction. */
function segmentPaths(points, segments, stroke) {
  if (points.length === 0) return "";
  if (points.length === 1) {
    return `<circle cx="${fmt(points[0].x)}" cy="${fmt(points[0].y)}" r="2" fill="${stroke}"/>`;
  }
  const parts = [];
  let i = 0;
  while (i < segments.length) {
    const dashed = segments[i].dashed;
    let d = `M ${fmt(segments[i].x1)} ${fmt(segments[i].y1)}`;
    while (i < segments.length && segments[i].dashed === dashed) {
      d += ` L ${fmt(segments[i].x2)} ${fmt(segments[i].y2)}`;
      i += 1;
    }
    parts.push(`<path d="${d}" fill="none" stroke="${stroke}" stroke-width="1.5"${dashed ? ' stroke-dasharray="4,3"' : ""}/>`);
  }
  return parts.join("");
}

/** The chart frame every line panel shares: spine, baseline, gridlines with fmtTokens labels. */
function axisFrame(plot, yTicks) {
  const parts = [];
  parts.push(`<line x1="${fmt(plot.x)}" y1="${fmt(plot.y)}" x2="${fmt(plot.x)}" y2="${fmt(plot.y + plot.h)}" stroke="${PAGE_THEME.border}"/>`);
  parts.push(`<line x1="${fmt(plot.x)}" y1="${fmt(plot.y + plot.h)}" x2="${fmt(plot.x + plot.w)}" y2="${fmt(plot.y + plot.h)}" stroke="${PAGE_THEME.border}"/>`);
  for (const t of yTicks) {
    parts.push(`<line x1="${fmt(plot.x)}" y1="${fmt(t.y)}" x2="${fmt(plot.x + plot.w)}" y2="${fmt(t.y)}" stroke="${PAGE_THEME.border}" stroke-width="0.5"/>`);
    parts.push(`<text x="${fmt(plot.x - 6)}" y="${fmt(t.y + 3)}" text-anchor="end" font-size="9" fill="${PAGE_THEME.dim}">${escapeHtml(t.label)}</text>`);
  }
  return parts.join("");
}

export function cumulativeHtml(daily, tips, translate = (message) => message) {
  const lay = layoutCumulative(daily, {});
  if (lay.points.length === 0) return "";
  const parts = [`<svg width="${fmt(lay.width)}" height="${fmt(lay.height)}" role="img" aria-label="${escapeHtml(translate("cumulative window spend"))}">`];
  parts.push(axisFrame(lay.plot, lay.yTicks));
  if (lay.scaleMax === 0) {
    parts.push(`<text x="${fmt(lay.plot.x + lay.plot.w / 2)}" y="${fmt(lay.plot.y + lay.plot.h / 2)}" text-anchor="middle" font-size="11" fill="${PAGE_THEME.dim}">${escapeHtml(translate("no spend recorded"))}</text>`);
  } else {
    parts.push(segmentPaths(lay.points, lay.segments, PAGE_THEME.accent));
    for (const pt of lay.points) {
      const idx = tips.push(`${pt.day} · ${translate("cumulative")} ${fmtAmount({ tokens: pt.total, class: pt.demoted ? "estimated" : "metered", floor: pt.floor })}`) - 1;
      parts.push(`<circle data-tip="${fmt(idx)}" cx="${fmt(pt.x)}" cy="${fmt(pt.y)}" r="2" fill="${PAGE_THEME.accent}"${pt.demoted ? ' fill-opacity=".45" stroke="' + PAGE_THEME.accent + '"' : ""}/>`);
    }
    // Direct end-of-line label: the running typed total, which converges to the KPI's provenance total.
    const el = lay.endLabel;
    parts.push(`<text x="${fmt(el.x)}" y="${fmt(el.y)}"${el.anchor === "end" ? ' text-anchor="end"' : ""} font-size="9" fill="${PAGE_THEME.dim}">${escapeHtml(el.text)}</text>`);
  }
  parts.push("</svg>");
  return `<div class="dim small">${escapeHtml(translate("cumulative"))}</div>${parts.join("")}`;
}

export function flowLinesHtml(nf, tips, translate = (message) => message) {
  if (nf.dailyByFlow === null) return null; // absence: the fold predates the series, so no section at all
  const lay = layoutFlowLines(nf.dailyByFlow, {});
  if (lay.panels.length === 0) return `<div class="dim">${escapeHtml(translate("no runs in the spend window"))}</div>`;
  const totalsByFlow = new Map(nf.byFlow.map((r) => [r.flow, r.amount]));
  const panels = lay.panels.map((panel) => {
    const parts = [`<div class="bl"><h3>${escapeHtml(panel.flow)} <span class="dim">${escapeHtml(fmtAmount(totalsByFlow.get(panel.flow) ?? null))}</span></h3>`];
    parts.push(`<svg width="${fmt(lay.width)}" height="${fmt(lay.height)}" role="img" aria-label="${escapeHtml(translate("daily spend"))} · ${escapeHtml(panel.flow)}">`);
    parts.push(axisFrame(panel.plot, panel.yTicks));
    if (lay.scaleMax === 0) {
      parts.push(`<text x="${fmt(panel.plot.x + panel.plot.w / 2)}" y="${fmt(panel.plot.y + panel.plot.h / 2)}" text-anchor="middle" font-size="11" fill="${PAGE_THEME.dim}">${escapeHtml(translate("no spend recorded"))}</text>`);
    } else {
      parts.push(segmentPaths(panel.points, panel.segments, PAGE_THEME.accent));
      for (const pt of panel.points) {
        const idx = tips.push(`${pt.day} · ${panel.flow} · ${fmtAmount({ tokens: pt.tokens, class: pt.cls, floor: pt.floor })} · ${fmt(pt.runs)} ${translate("runs")}`) - 1;
        const estim = pt.runs > 0 && pt.cls !== "metered";
        parts.push(`<circle data-tip="${fmt(idx)}" cx="${fmt(pt.x)}" cy="${fmt(pt.y)}" r="2" fill="${PAGE_THEME.accent}"${estim ? ' fill-opacity=".45" stroke="' + PAGE_THEME.accent + '"' : ""}/>`);
        if (pt.floor) {
          parts.push(`<text x="${fmt(pt.x)}" y="${fmt(pt.y - 5)}" text-anchor="middle" font-size="9" fill="${PAGE_THEME.amber}">≥</text>`);
        }
      }
      for (const xl of panel.xLabels) {
        parts.push(`<text x="${fmt(xl.x)}" y="${fmt(panel.plot.y + panel.plot.h + 12)}" text-anchor="middle" font-size="8" fill="${PAGE_THEME.dim}">${escapeHtml(xl.label)}</text>`);
      }
    }
    parts.push("</svg></div>");
    return parts.join("");
  });
  let tail = "";
  if (lay.restCount > 0) {
    tail = `<div class="dim small">(+${fmt(lay.restCount)} ${escapeHtml(translate("more flows"))} · ${escapeHtml(fmtAmount(lay.restAgg))})</div>`;
  }
  return `<div id="flows">${panels.join("")}</div>${tail}`;
}

function barListSvg(rows, aria, tips) {
  const laid = layoutBarList(rows, { width: LIST_W });
  const height = laid.length * LIST_ROW_H + 6;
  const parts = [`<svg width="${fmt(LIST_W)}" height="${fmt(height)}" role="img" aria-label="${escapeHtml(aria)}">`];
  for (const row of laid) {
    const idx = tips.push(row.tip) - 1;
    const link = row.nodeId !== null ? ` data-node="${row.nodeId}" class="rowlink"` : "";
    parts.push(`<g data-tip="${fmt(idx)}"${link}>`);
    const base = row.y + 14;
    const bx = LIST_LABEL_W;
    parts.push(`<text x="0" y="${fmt(base)}" font-size="11" fill="${PAGE_THEME.fg}">${escapeHtml(row.labelText)}</text>`);
    if (row.chipText !== null) {
      // The chip's rect is capped at the list's edge, so its TEXT is cut to what the capped rect holds
      // (issue #418): a long plan id ran past the rect and past the SVG itself. A text that FITS the
      // capped rect is left alone, so a chip that fitted before is byte-for-byte what it was; one that does
      // not is cut a column short of the cap, because the cut appends its ellipsis past its budget.
      const room = LIST_W - bx - 8;
      const fits = Math.floor((room - 12) / 6);
      const chipText = drawnColumns(row.chipText) <= fits ? row.chipText : clipColumns(row.chipText, fits - 1);
      const cw = Math.min(drawnColumns(chipText) * 6 + 12, room);
      parts.push(`<rect x="${fmt(bx)}" y="${fmt(row.y + 3)}" width="${fmt(cw)}" height="15" rx="7" fill="none" stroke="${PAGE_THEME.chipStroke}"/>`);
      parts.push(`<text x="${fmt(bx + 7)}" y="${fmt(base)}" font-size="10" fill="${PAGE_THEME.dim}">${escapeHtml(chipText)}</text>`);
    } else if (row.barW !== null) {
      if (row.cls === "metered") {
        parts.push(`<rect x="${fmt(bx)}" y="${fmt(row.y + 5)}" width="${fmt(row.barW)}" height="11" rx="2" fill="${PAGE_THEME.accent}"/>`);
      } else {
        parts.push(`<rect x="${fmt(bx)}" y="${fmt(row.y + 5)}" width="${fmt(row.barW)}" height="11" rx="2" fill="${PAGE_THEME.accent}" fill-opacity=".45" stroke="${PAGE_THEME.accent}" stroke-dasharray="4,3"/>`);
      }
      parts.push(`<text x="${fmt(bx + row.barW + 6)}" y="${fmt(base)}" font-size="10" fill="${PAGE_THEME.dim}">${escapeHtml(row.valueText)}</text>`);
    } else {
      parts.push(`<text x="${fmt(bx)}" y="${fmt(base)}" font-size="10" fill="${PAGE_THEME.dim}">${escapeHtml(row.valueText)}</text>`);
    }
    if (row.apiW !== null) {
      parts.push(`<rect x="${fmt(bx)}" y="${fmt(row.y + 18)}" width="${fmt(row.apiW)}" height="2" fill="none" stroke="${PAGE_THEME.dim}" stroke-dasharray="3,2"/>`);
      parts.push(`<text x="${fmt(bx + row.apiW + 6)}" y="${fmt(row.y + 21)}" font-size="8" fill="${PAGE_THEME.dim}">${escapeHtml(row.apiText)}</text>`);
    }
    parts.push("</g>");
  }
  parts.push("</svg>");
  return parts.join("");
}

function listSection(title, rows, aria, tips, extra = "", translate = (message) => message) {
  const head = rows.slice(0, LIST_TOP);
  const rest = rows.slice(LIST_TOP);
  let tail = "";
  if (rest.length > 0) {
    // The tail is an aggregate, and an aggregate over heterogeneous rows is at best an estimate --
    // hence the forced class. Totals never silently truncate: K rows fold into one stated line.
    const agg = {
      tokens: rest.reduce((s, r) => s + r.amount.tokens, 0),
      class: "estimated",
      floor: rest.some((r) => r.amount?.floor === true),
    };
    tail = `<div class="dim small">(+${fmt(rest.length)} ${escapeHtml(translate("more"))} · ${escapeHtml(fmtAmount(agg))})</div>`;
  }
  const body = head.length === 0 ? `<div class="dim small">${escapeHtml(translate("none in window"))}</div>` : barListSvg(head, aria, tips);
  return `<div class="bl"><h3>${escapeHtml(title)}</h3>${body}${tail}${extra}</div>`;
}

export function breakdownHtml(nf, minted, tips, names = new Map(), translate = (message) => message) {
  const secs = [];
  secs.push(listSection(translate("by flow"), nf.byFlow.map((r) => ({ label: r.flow, amount: r.amount, runs: r.runs })), translate("spend by flow"), tips, "", translate));
  if (nf.byTrigger === null) {
    // Absence, not an empty table: an empty list would read as "nothing spent", which is a claim
    // the caller explicitly did not compute.
    secs.push(`<div class="bl"><h3>${escapeHtml(translate("by trigger"))}</h3><div class="dim small">${escapeHtml(translate("not computed (no trigger join wired)"))}</div></div>`);
  } else {
    secs.push(listSection(
      translate("by trigger"),
      nf.byTrigger.map((r) => ({
        label: r.label,
        amount: r.amount,
        runs: r.runs,
        failed: r.outcomes.failed,
        failedAmount: r.failedAmount,
        nodeId: minted.get(r.key) ?? null,
      })),
      translate("spend by trigger"),
      tips,
      "",
      translate,
    ));
  }
  secs.push(listSection(translate("by model"), nf.byModel.map((r) => ({ label: `${r.provider}/${r.model}`, amount: r.amount, runs: r.runs })), translate("spend by model"), tips, "", translate));
  secs.push(listSection(translate("by repo"), nf.byRepo.map((r) => ({ label: r.label, amount: r.amount, runs: r.runs })), translate("spend by repo"), tips, "", translate));
  // Issue #499 part C: the bars carry the id (what a run record holds); the names, when any, sit under the list.
  if (nf.byProject !== null) {
    secs.push(listSection(translate("by project"), nf.byProject.map((r) => ({ label: r.label, amount: r.amount, runs: r.runs })), translate("spend by project"), tips, projectNamesHtml(nf.byProject.slice(0, LIST_TOP), names), translate));
  }
  return `<div id="grid">${secs.join("")}</div>`;
}

export function kpisHtml(nf, translate = (message) => message) {
  const p = nf.provenance;
  const ledgered = Math.max(0, p.runsTotal - p.runsUnmetered - p.runsUnledgered);
  const top = nf.byFlow.length > 0 ? nf.byFlow[0] : null;
  const tiles = [
    [fmtAmount(p.total), translate("window spend")],
    [fmt(p.runsTotal), translate("runs")],
    [`${fmt(ledgered)} ${translate("of")} ${fmt(p.runsTotal)}`, translate("runs fully ledgered")],
    [fmt(nf.plans.length), translate("plans declared")],
    [top !== null ? fmtAmount(top.cost) : "—", top !== null ? `${translate("top flow")} · ${top.flow}` : translate("top flow")],
  ];
  return `<div id="kpis">${tiles.map(([v, l]) => `<div class="kpi"><div class="v">${escapeHtml(v)}</div><div class="l">${escapeHtml(l)}</div></div>`).join("")}</div>`;
}

// FACTS ONLY, like the fold's peakWindow: a null limit renders as undisclosed and nothing here
// derives a remaining amount or a burn-down -- room "left" against a number the vendor never
// published would be an invented fact wearing the vendor's name.
function limitLine(w, translate) {
  if (w.limit === null) return translate("limit undisclosed by vendor");
  if (Array.isArray(w.limit)) return `${translate("limit")} ${fmt(w.limit[0])}–${fmt(w.limit[1])} ${w.unit}`;
  return `${translate("limit")} ${fmt(w.limit)} ${w.unit}`;
}

export function planCardsHtml(plans, translate = (message) => message) {
  const cards = plans.map((pl) => {
    const parts = [`<div class="plan${pl.hypothetical ? " hypo" : ""}">`];
    parts.push(`<div><span class="pid">${escapeHtml(pl.id)}</span> <span class="pv">${escapeHtml(pl.vendor)}</span>${pl.hypothetical ? ` (${escapeHtml(translate("hypothetical"))})` : ""}</div>`);
    // FACTS ONLY (DES-TOKEN-RESERVE-AND-SETTLE): prices died, so there is no verdict to draw -- which
    // runs the plan covered, their recorded tokens, and where the plan's declared windows peaked.
    parts.push(`<div class="small dim">${escapeHtml(translate("attributed"))} ${fmt(pl.attributedRuns)} ${escapeHtml(translate("runs"))} · ${fmt(pl.attributedTokens)} ${escapeHtml(translate("tok"))}${pl.anyFloor ? ` · ${escapeHtml(translate("at least"))}` : ""}</div>`);
    for (const w of pl.windows) {
      parts.push(`<div class="small dim">${escapeHtml(`${translate("peak")} ${w.per}${w.rolling ? ` ${translate("rolling")}` : ""}: ${fmt(w.peakRuns)} ${translate("runs")} · ${fmt(w.peakTokens)} ${translate("tok")} · ${limitLine(w, translate)}`)}</div>`);
    }
    parts.push("</div>");
    return parts.join("");
  });
  return `<div id="plans">${cards.join("")}</div>`;
}

// The tokens legend beside the reused graph legend. Three classes only (the pricing classes died with
// pricing): a bar's fill carries them, so no class without an encoding is listed.
export function dollarsLegendHtml(translate = (message) => message) {
  const sw = (inner) => `<svg width="20" height="12" aria-hidden="true">${inner}</svg>`;
  const rows = [];
  const row = (sample, text) => rows.push(`<div class="row">${sample}<span>${escapeHtml(text)}</span></div>`);
  rows.push(`<h2>${escapeHtml(translate("tokens"))}</h2>`);
  row(sw(`<rect x="1" y="2" width="18" height="8" rx="2" fill="${PAGE_THEME.accent}"/>`), translate("metered: pi's meter read complete"));
  row(sw(`<rect x="1" y="2" width="18" height="8" rx="2" fill="${PAGE_THEME.accent}" fill-opacity=".45" stroke="${PAGE_THEME.accent}" stroke-dasharray="4,3"/>`), translate("estimated (~): partly measured"));
  row(sw(`<text x="6" y="10" font-size="10" fill="${PAGE_THEME.dim}">—</text>`), translate("unknown: not measured, not guessed"));
  rows.push(`<div class="caps">${escapeHtml(translate("≥ marks a floor: the window holds tokens the meter could not fully count"))}</div>`);
  return `<div id="dollars">${rows.join("")}</div>`;
}

// ---- job sizes (issue #596, phase 3, DES-SIZE-SUGGESTIONS) ----
// The reasons the worker's `suggestSize` gives, restated (this module loads nothing from the worker) and pinned to
// worker/src/size-suggest.mjs's MEMORY_REASONS, CPU_REASONS, MEMORY_HELD, SIZE_FACTS and MEMORY_CAP_MISSING by
// size-suggest.test.mjs.
// Anything else is dropped, and a dimension without a known reason draws no suggestion: toward silence, never an
// invented one. A held raise or a fact outside its list is dropped the same way.
export const INSIGHTS_MEMORY_REASONS = Object.freeze(["oom-killed", "not-enough-runs", "oversized", "fits"]);
export const INSIGHTS_CPU_REASONS = Object.freeze(["not-enough-runs", "underused", "fits"]);
export const INSIGHTS_MEMORY_HELD = Object.freeze(["cap", "largest", "no-cap"]);
export const INSIGHTS_SIZE_FACTS = Object.freeze(["pressure", "ceiling"]);
export const INSIGHTS_CAP_MISSING = Object.freeze(["unread", "none-holds", "off"]);
// How every live host refuses a dimension of a withheld pair (the worker's `sizeRefusal`): above its budget, or above
// the project's hostShare of it. Anything else names no dimension.
const SIZING_REFUSAL_KINDS = Object.freeze(["host", "share"]);
// The two admin calls a suggestion may name, digits, ids and JSON punctuation only (`suggestionCall`).
const SIZING_CALL = /^dispatch_limit_(?:edit|add) \{[a-z0-9":,.{}:-]{1,160}\}$/;
const SIZING_POINTS_MAX = 50;
const SIZING_HOSTS_MAX = 20;
const SIZING_HOST_NAME = /^[A-Za-z0-9._-]{1,64}$/;
const SIZING_W = 452;
const SIZING_H = 120;
const SIZING_ML = 46;
const SIZING_MR = 8;
const SIZING_MT = 12;
const SIZING_MB = 16;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A memory size as the worker spells it (`formatMemory`): `<n>g` when whole gigabytes, else `<n>m`. Restated, and
 * held equal to the worker's over a range by insights-html.test.mjs.
 */
export function sizeMemText(memMiB) {
  return memMiB % 1024 === 0 ? `${memMiB / 1024}g` : `${memMiB}m`;
}
/** A CPU size as the worker spells it (`formatCpus`), from hundredths. Restated and held equal the same way. */
export function sizeCpuText(cpuCenti) {
  const whole = Math.floor(cpuCenti / 100);
  const fraction = String(cpuCenti % 100).padStart(2, "0").replace(/0+$/, "");
  return fraction === "" ? String(whole) : `${whole}.${fraction}`;
}

function sizeInt(v) {
  return Number.isSafeInteger(v) && v >= 0 ? v : null;
}

/** A registry budget field: an integer as text, `off`, or anything else unknown (null). */
function regField(v) {
  return v === "off" ? "off" : typeof v === "string" && /^[0-9]{1,15}$/.test(v) ? Number(v) : null;
}

/**
 * A row's budget field in the panel's states (dashboard.ts `budgetText`): a positive integer, `"off"`, `"unknown"`
 * for the "" a starting worker publishes, `"absent"` for a worker from before the field, `"unreadable"` for anything
 * a worker never writes. Kept apart because "not known yet" and "unreadable" are different facts.
 */
function regBudget(v) {
  if (v === undefined || v === null) return "absent";
  if (v === "off") return "off";
  if (v === "") return "unknown";
  return typeof v === "string" && /^[1-9][0-9]{0,14}$/.test(v) ? Number(v) : "unreadable";
}

function normSizingDim(v, reasons) {
  if (v === null || typeof v !== "object" || !reasons.includes(v.reason)) return null;
  const current = sizeInt(v.current);
  if (current === null || current === 0) return null;
  const suggested = sizeInt(v.suggested);
  const e = v.evidence !== null && typeof v.evidence === "object" ? v.evidence : {};
  const held = INSIGHTS_MEMORY_HELD.includes(v.held) ? v.held : null;
  const fact = INSIGHTS_SIZE_FACTS.includes(v.fact) ? v.fact : null;
  const wanted = sizeInt(v.wanted);
  const capMissing = INSIGHTS_CAP_MISSING.includes(v.capMissing) ? v.capMissing : null;
  const cap = sizeInt(v.cap);
  return { current, suggested: suggested === 0 ? null : suggested, reason: v.reason, held, fact, wanted: wanted === 0 ? null : wanted, capMissing, cap: cap === 0 ? null : cap, samples: sizeInt(e.samples) ?? 0, smaller: sizeInt(e.smaller) ?? 0, p95MiB: sizeInt(e.p95MiB), p95CoresCenti: sizeInt(e.p95CoresCenti), pressured: sizeInt(e.pressured) ?? 0, throttledPct: sizeInt(e.throttledPct) };
}

/**
 * The job-size slice, allowlisted: hosts (name, budget and use per dimension), and per project its memory and CPU
 * suggestion, the call that applies it, and its peak series (at most SIZING_POINTS_MAX points, each a finite instant,
 * a peak and a size in MiB). Null for a payload without the slice (no section), `{ unreachable }` for a read that failed.
 */
export function normSizing(v) {
  if (v === null || v === undefined || typeof v !== "object") return null;
  if (typeof v.unreachable === "string") return { unreachable: clip(escapeInterpreted(v.unreachable), 120) };
  const hostsIn = v.hosts !== null && typeof v.hosts === "object" ? v.hosts : {};
  const hosts = typeof hostsIn.unreachable === "string"
    ? { unreachable: clip(escapeInterpreted(hostsIn.unreachable), 120) }
    : {
        rows: (Array.isArray(hostsIn.rows) ? hostsIn.rows : [])
          .filter((h) => h !== null && typeof h === "object" && typeof h.name === "string" && SIZING_HOST_NAME.test(h.name))
          .slice(0, SIZING_HOSTS_MAX)
          .map((h) => ({ name: h.name, budgetMemMiB: regBudget(h.budgetMemMiB), budgetCpuCenti: regBudget(h.budgetCpuCenti), usedMemMiB: regField(h.usedMemMiB), usedCpuCenti: regField(h.usedCpuCenti) }))
          .sort((a, b) => cmpStr(a.name, b.name)),
      };
  const projects = [];
  const src = v.projects !== null && typeof v.projects === "object" && !Array.isArray(v.projects) ? v.projects : {};
  for (const id of Object.keys(src).sort(cmpStr)) {
    if (!PROJECT_ID.test(id)) continue;
    const p = src[id];
    if (p === null || typeof p !== "object") continue;
    const memory = normSizingDim(p.memory, INSIGHTS_MEMORY_REASONS);
    const cpu = normSizingDim(p.cpu, INSIGHTS_CPU_REASONS);
    if (memory === null || cpu === null) continue;
    const series = (Array.isArray(p.series) ? p.series : [])
      .filter((pt) => pt !== null && typeof pt === "object" && Number.isFinite(pt.at) && Math.abs(pt.at) <= 8.64e15 && sizeInt(pt.peakMiB) !== null && sizeInt(pt.sizeMiB) !== null && pt.sizeMiB > 0)
      .slice(-SIZING_POINTS_MAX)
      .map((pt) => ({ at: pt.at, peakMiB: Math.min(pt.peakMiB, pt.sizeMiB), sizeMiB: pt.sizeMiB, oom: pt.oom === true }));
    const call = typeof p.call === "string" && SIZING_CALL.test(p.call) ? p.call : null;
    const r = p.refusal !== null && typeof p.refusal === "object" ? p.refusal : null;
    const kind = (k) => (SIZING_REFUSAL_KINDS.includes(r?.[k]) ? r[k] : null);
    const refusal = r === null ? null : { memMiB: kind("memMiB"), cpuCenti: kind("cpuCenti") };
    projects.push({ id, memory, cpu, series, call, refusal });
  }
  const windowDays = Number.isInteger(v.windowDays) && v.windowDays > 0 && v.windowDays <= 366 ? v.windowDays : 30;
  return { hosts, projects, windowDays };
}

/**
 * Pure geometry for one project's peak-against-size chart, exported so its invariants (points inside the plot, x in
 * time order over the fixed window, the size line a step through each run's size and on to the current size at the
 * right edge) are testable as numbers. The y scale is a nice step over the largest peak or size, so the size line is
 * always inside the plot. The x axis is the window ending at `nowMs`, so an idle week is a visible gap, not compressed.
 */
export function layoutSizingChart(series, { nowMs, windowDays = 30, currentMiB, width, height } = {}) {
  const w = Number.isFinite(width) && width > 100 ? width : SIZING_W;
  const h = Number.isFinite(height) && height > 40 ? height : SIZING_H;
  const plot = { x: SIZING_ML, y: SIZING_MT, w: w - SIZING_ML - SIZING_MR, h: h - SIZING_MT - SIZING_MB };
  const end = Number.isFinite(nowMs) ? nowMs : 0;
  const start = end - windowDays * DAY_MS;
  const pts = (Array.isArray(series) ? series : []).filter((pt) => pt.at >= start && pt.at <= end);
  let max = Number.isSafeInteger(currentMiB) ? currentMiB : 0;
  for (const pt of pts) max = Math.max(max, pt.peakMiB, pt.sizeMiB);
  const step = niceStep(max / 4);
  const scaleMax = step * 4;
  const xOf = (at) => plot.x + ((at - start) / (end - start)) * plot.w;
  const yOf = (mib) => plot.y + plot.h - (scaleMax > 0 ? (Math.min(mib, scaleMax) / scaleMax) * plot.h : 0);
  const points = pts.map((pt) => ({ x: xOf(pt.at), y: yOf(pt.peakMiB), at: pt.at, peakMiB: pt.peakMiB, sizeMiB: pt.sizeMiB, oom: pt.oom }));
  // the size line: each run's size from its own instant on, then the current size to the right edge.
  const steps = [];
  let x = plot.x;
  let size = pts.length > 0 ? pts[0].sizeMiB : currentMiB;
  for (const pt of points) {
    steps.push({ x1: x, x2: pt.x, y: yOf(size) });
    x = pt.x;
    size = pt.sizeMiB;
  }
  steps.push({ x1: x, x2: x === plot.x + plot.w ? x : plot.x + plot.w, y: yOf(size) });
  if (Number.isSafeInteger(currentMiB) && currentMiB !== size) steps.push({ x1: plot.x + plot.w, x2: plot.x + plot.w, y: yOf(currentMiB), from: yOf(size) });
  const yTicks = scaleMax > 0 ? [2, 4].map((k) => ({ y: plot.y + plot.h - (k / 4) * plot.h, label: sizeMemText(step * k) })) : [];
  // The last label ends AT the plot's right edge rather than centring on it: the right margin (`SIZING_MR`) is far
  // narrower than half a date, so a centred last label was cut by the chart's own edge ("10-0" and a sliver).
  const xLabels = [0, 1, 2, 3].map((k) => ({ x: plot.x + (k / 3) * plot.w, label: utcDateStr(start + (k / 3) * (end - start)).slice(5), anchor: k === 3 ? "end" : "middle" }));
  return { plot, points, steps, yTicks, xLabels, scaleMax, width: w, height: h };
}

/** Cores in words, singular for exactly one (the worker's `coresText`, restated and held equal by the tests). */
export function sizeCoresText(cpuCenti) {
  return `${sizeCpuText(cpuCenti)} core${cpuCenti === 100 ? "" : "s"}`;
}

export const SIZING_NO_CAP_WORDS = Object.freeze({ unread: "no host budget read as a number", "none-holds": "no live host's budget holds this size", off: "every live host's budget is off" });

function sizingWhat(dim, unit, t) {
  if (dim.suggested !== null) return `${t("suggest")} ${unit(dim.suggested)} (${t(dim.reason)}${dim.held === "cap" ? `, ${t("the most a live host offers")}` : ""})`;
  if (dim.held === "largest") return `${t("stays")} (${t(dim.reason)}, ${t(dim.cap !== null && dim.current > dim.cap ? "already above the most a live host offers" : "already the largest size a live host offers")})`;
  // the three ways no cap is known, worded apart (the panel's words, held equal by a test); an unknown one reads as unread
  if (dim.held === "no-cap" && dim.wanted !== null) return `${t("wants")} ${unit(dim.wanted)} (${t(dim.reason)}, ${t(SIZING_NO_CAP_WORDS[dim.capMissing ?? "unread"])}: ${t("no call")})`;
  return dim.reason === "not-enough-runs" ? sizingNotEnoughText(dim, unit === sizeCpuText ? sizeCpusWords : unit, t) : t(dim.reason);
}

/**
 * The worker's "not enough runs" verdict (size-suggest.mjs `notEnoughRunsText`, restated and held equal by a test): the
 * runs counted at the current size, and the smaller ones the chart draws but the verdict does not count.
 */
/** CPUs with their unit, singular for exactly one (the worker's `cpusText`, restated). */
const sizeCpusWords = (centi) => `${sizeCpuText(centi)} CPU${centi === 100 ? "" : "s"}`;
export function sizingNotEnoughText(dim, unit, t = (message) => message) {
  return `${t("not enough runs at")} ${unit(dim.current)} (${dim.samples}${dim.smaller > 0 ? `; ${dim.smaller} ${t("at smaller sizes")}` : ""})`;
}

/** A withheld pair's refusal in words, naming each dimension every live host refuses (the worker's `refusalWords`, restated). */
function sizingRefusalText(r, m, c, t) {
  const where = (kind) => t(kind === "share" ? "its hostShare of every live host's budget" : "every live host's budget");
  const mem = m.suggested ?? m.current;
  const cpus = c.suggested ?? c.current;
  const parts = [];
  if (r.memMiB) parts.push(`${t(m.suggested !== null ? "memory" : "its memory")} ${sizeMemText(mem)} ${t("is above")} ${where(r.memMiB)}`);
  if (r.cpuCenti) parts.push(`${c.suggested !== null ? "" : `${t("its")} `}${sizeCpuText(cpus)} CPU${cpus === 100 ? ` ${t("is")}` : `s ${t("are")}`} ${t("above")} ${where(r.cpuCenti)}`);
  return parts.length > 0 ? parts.join(` ${t("and")} `) : `${t("memory")} ${sizeMemText(mem)} ${t("with")} ${sizeCpuText(cpus)} CPU${cpus === 100 ? "" : "s"} ${t("fits no live host's budget")}`;
}

/** The facts a suggestion carries, as information with no call, rebuilt here from the numbers alone. */
function sizingFacts(m, c, t) {
  const facts = [];
  if (m.fact === "pressure") facts.push(`${m.pressured} ${t("of")} ${m.samples} ${t("runs reached the memory limit while stalled for memory")}`);
  if (c.fact === "ceiling" && c.throttledPct !== null) facts.push(`${t("the median run was held back")} ${c.throttledPct}% ${t("of its time by its host's CPU ceiling, which a job's cpus do not change")}`);
  return facts;
}

export function sizingSectionHtml(ns, tips, nowMs, translate = (message) => message) {
  const t = translate;
  if (ns.unreachable) return `<div class="dim">${escapeHtml(t("job sizes not read:"))} ${escapeHtml(ns.unreachable)}</div>`;
  const parts = [];
  if (ns.hosts.unreachable) parts.push(`<div class="dim small">${escapeHtml(t("host budgets not read:"))} ${escapeHtml(ns.hosts.unreachable)}</div>`);
  else if (ns.hosts.rows.length === 0) parts.push(`<div class="dim small">${escapeHtml(t("no live host publishes a budget"))}</div>`);
  else {
    // Each dimension in the panel's HOSTS view states and words (dashboard.ts `budgetText`): what the jobs were promised
    // of a budget ("promised memory 6g of 16g"), "no memory budget" for one switched off, "memory budget not known yet"
    // while a starting worker has not read it, "memory budget unreadable" for a value no worker writes, "no memory
    // budget published" for a worker from before the field; one phrase when both dimensions agree.
    const dims = (h) => {
      const one = (label, budget, used, text) => {
        if (budget === "absent") return { kind: "absent", text: t(`no ${label} budget published`) };
        if (budget === "off") return { kind: "off", text: t(`no ${label} budget`) };
        if (budget === "unknown") return { kind: "unknown", text: t(`${label} budget not known yet`) };
        if (budget === "unreadable") return { kind: "unreadable", text: t(`${label} budget unreadable`) };
        return { kind: "set", text: `${t(label)} ${used === null || used === "off" ? "?" : text(used)} ${t("of")} ${text(budget)}` };
      };
      const both = [one("memory", h.budgetMemMiB, h.usedMemMiB, sizeMemText), one("CPU", h.budgetCpuCenti, h.usedCpuCenti, sizeCpuText)];
      if (both.every((d) => d.kind === "absent")) return t("no host budget published");
      if (both.every((d) => d.kind === "unknown")) return t("budget not known yet");
      if (both.every((d) => d.kind === "unreadable")) return t("budget unreadable");
      const set = both.filter((d) => d.kind === "set").map((d) => d.text);
      return [...(set.length > 0 ? [`${t("promised")} ${set.join(", ")}`] : []), ...both.filter((d) => d.kind !== "set").map((d) => d.text)].join(", ");
    };
    const rows = ns.hosts.rows.map((h) => `<div><span class="pid">${escapeHtml(h.name)}</span> ${escapeHtml(dims(h))}</div>`);
    parts.push(`<div class="small">${rows.join("")}</div>`);
  }
  if (ns.projects.length === 0) {
    parts.push(`<div class="dim">${escapeHtml(t("no project to size"))}</div>`);
    return parts.join("");
  }
  const sizingNote = `${t("peak memory of each run (the runs a suggestion reads: the last")} ${fmt(ns.windowDays)} ${t("days, at most 50) against its size; measured inside the jobs, so advisory; a suggestion applies only by its call, confirmed")}`;
  parts.push(`<div class="dim small">${escapeHtml(sizingNote)}</div>`);
  const panels = ns.projects.map((pr) => {
    const m = pr.memory;
    const c = pr.cpu;
    const head = `<h3><span class="pid">${escapeHtml(pr.id)}</span> <span class="dim">${escapeHtml(t("size"))} ${escapeHtml(sizeMemText(m.current))}, ${escapeHtml(sizeCpuText(c.current))} CPU${c.current === 100 ? "" : "s"} · p95 ${escapeHtml(m.p95MiB === null ? "-" : sizeMemText(m.p95MiB))}, ${escapeHtml(c.p95CoresCenti === null ? "-" : sizeCoresText(c.p95CoresCenti))}</span></h3>`;
    const verdict = `<div class="small">${escapeHtml(t("memory:"))} ${escapeHtml(sizingWhat(m, sizeMemText, t))} · ${escapeHtml(t("CPUs:"))} ${escapeHtml(sizingWhat(c, sizeCpuText, t))}</div>`;
    const call = pr.call === null ? "" : `<div class="small"><code>${escapeHtml(pr.call)}</code></div>`;
    const refused = pr.refusal === null ? "" : `<div class="small">${escapeHtml(t("no call: no live host admits it"))} (${escapeHtml(sizingRefusalText(pr.refusal, m, c, t))})</div>`;
    const facts = sizingFacts(m, c, t).map((f) => `<div class="dim small">${escapeHtml(f)}</div>`).join("");
    const lay = layoutSizingChart(pr.series, { nowMs, windowDays: ns.windowDays, currentMiB: m.current });
    const svg = [`<svg width="${fmt(lay.width)}" height="${fmt(lay.height)}" role="img" aria-label="${escapeHtml(t("peak memory against size"))} · ${escapeHtml(pr.id)}">`];
    svg.push(axisFrame(lay.plot, lay.yTicks));
    for (const st of lay.steps) {
      if (st.from !== undefined) svg.push(`<line x1="${fmt(st.x1)}" y1="${fmt(st.from)}" x2="${fmt(st.x2)}" y2="${fmt(st.y)}" stroke="${PAGE_THEME.dim}" stroke-width="1.5"/>`);
      else svg.push(`<line x1="${fmt(st.x1)}" y1="${fmt(st.y)}" x2="${fmt(st.x2)}" y2="${fmt(st.y)}" stroke="${PAGE_THEME.dim}" stroke-width="1.5"/>`);
    }
    for (const pt of lay.points) {
      const idx = tips.push(`${new Date(pt.at).toISOString().slice(0, 16).replace("T", " ")} UTC · ${t("peak")} ${sizeMemText(pt.peakMiB)} ${t("of")} ${sizeMemText(pt.sizeMiB)}${pt.oom ? ` · ${t("oom-killed")}` : ""}`) - 1;
      svg.push(`<circle data-tip="${fmt(idx)}" cx="${fmt(pt.x)}" cy="${fmt(pt.y)}" r="2.5" fill="${pt.oom ? PAGE_THEME.danger : PAGE_THEME.accent}"/>`);
    }
    if (lay.points.length === 0) svg.push(`<text x="${fmt(lay.plot.x + lay.plot.w / 2)}" y="${fmt(lay.plot.y + lay.plot.h / 2)}" text-anchor="middle" font-size="11" fill="${PAGE_THEME.dim}">${escapeHtml(t("no measured runs in the window"))}</text>`);
    for (const xl of lay.xLabels) svg.push(`<text x="${fmt(xl.x)}" y="${fmt(lay.plot.y + lay.plot.h + 12)}" text-anchor="${xl.anchor}" font-size="8" fill="${PAGE_THEME.dim}">${escapeHtml(xl.label)}</text>`);
    svg.push("</svg>");
    return `<div class="bl">${head}${verdict}${call}${refused}${facts}${svg.join("")}</div>`;
  });
  parts.push(`<div id="sizes">${panels.join("")}</div>`);
  return parts.join("");
}

// ---- capacity (issue #599, phase 4, REQ-CAPACITY-INSIGHTS, DES-CAPACITY-FROM-RECORDS) ----
// The assembler (index.ts `capacityViewOf`) hands this section the capacity report's buckets and every sentence and
// headline number already in the CLI's words; this module loads nothing from the worker, so what it restates is pinned
// by insights-html.test.mjs: the host-name rule (worker-name.mjs `WORKER_NAME_RE`), the per-mille words (capacity-cli
// `share`, `shareText`, `percentText`, `milliText`) and the fleet sentence below (the CLI's last line).
export const INSIGHTS_CAPACITY_HOST_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const INSIGHTS_CAPACITY_JOBS_ONLY = "Jobs only: a machine busy with other work reads as idle.";
const CAPACITY_HOSTS_MAX = 20;
// The page's windows give at most 31 x 4 = 124 buckets (index.ts `INSIGHTS_CAPACITY_BUCKET_MS`) or 7 x 24 = 168; one
// more for a window that does not end on a bucket edge. A window split finer than this, or into buckets that are not
// whole minutes, is not one the page reads.
const CAPACITY_BUCKETS_MAX = 200;
const CAPACITY_COVERAGE_MAX = 12; // coverage clauses, each its own line
const CAPACITY_PROJECTS_MAX = 6; // the report's top 5, then the rest summed as one
const CAPACITY_TEXT_MAX = 400;
const CAP_W = 920;
const CAP_H = 96;
const CAP_ML = 46;
const CAP_MR = 10;
const CAP_MT = 10;
const CAP_MB = 16;
const CAP_HATCH_STEP = 6;

/** Part of whole as a per-mille, rounded half up; 0 when there is no whole (capacity-cli `share`, restated). */
export function capShare(part, whole) {
  return whole > 0 ? Math.floor((part * 2000 + whole) / (whole * 2)) : 0;
}
/** A share of time as a percentage, `under 0.1%` and `over 99.9%` at the ends (capacity-cli `shareText`, restated). */
export function capShareText(part, whole) {
  const p = capShare(part, whole);
  if (p === 0 && part > 0 && whole > 0) return "under 0.1%";
  if (p === 1000 && part < whole) return "over 99.9%";
  return capPercentText(p);
}
/** Thousandths as a percentage, at most one decimal (capacity-cli `percentText`, restated). */
export function capPercentText(perMille) {
  return `${Math.floor(perMille / 10)}${perMille % 10 === 0 ? "" : `.${perMille % 10}`}%`;
}
/** Thousandths as a number with at most one decimal, rounded half up (capacity-cli `milliText`, restated). */
export function capMilliText(milli) {
  const tenths = Math.floor((milli + 50) / 100);
  return `${Math.floor(tenths / 10)}${tenths % 10 === 0 ? "" : `.${tenths % 10}`}`;
}

/** A sentence from the assembler: escaped where a terminal or a page would act on a character, and clipped. */
function capText(v, max = CAPACITY_TEXT_MAX) {
  return typeof v === "string" && v !== "" ? clip(escapeInterpreted(v), max) : null;
}

function capInt(v) {
  return Number.isSafeInteger(v) && v >= 0 ? v : null;
}

/** One bucket, or null when any of its numbers is not one the report can give (it is then drawn as no data). */
function normCapBucket(b, win) {
  if (b === null || typeof b !== "object") return null;
  const fromMs = Number.isSafeInteger(b.fromMs) ? b.fromMs : null;
  if (fromMs === null || fromMs < win.fromMs || fromMs >= win.toMs) return null;
  const len = Math.min(win.bucketMs, win.toMs - fromMs);
  const coveredMs = capInt(b.coveredMs);
  const busyMs = capInt(b.busyMs);
  const peak = capInt(b.peak);
  if (coveredMs === null || coveredMs > len || busyMs === null || busyMs > coveredMs || peak === null || peak > 100_000) return null;
  const fullMs = b.fullMs === null ? null : capInt(b.fullMs);
  if (b.fullMs !== null && (fullMs === null || fullMs > coveredMs)) return null;
  const avgMilli = b.avgMilli === null ? null : capInt(b.avgMilli);
  if (b.avgMilli !== null && avgMilli === null) return null;
  return { fromMs, coveredMs, busyMs, fullMs, peak, avgMilli: coveredMs > 0 ? Math.min(avgMilli ?? 0, peak * 1000) : null };
}

/** The headline words, each a string or null; the projects a list. Nothing else is read. */
function normCapFacts(f) {
  if (f === null || typeof f !== "object") return null;
  const busy = capText(f.busy, 12);
  const idle = capText(f.idle, 12);
  const avg = capText(f.avg, 16);
  if (busy === null || idle === null || avg === null) return null;
  return {
    busy,
    idle,
    missing: capText(f.missing, 12),
    avg,
    slots: Number.isSafeInteger(f.slots) && f.slots >= 1 ? f.slots : null,
    peak: capInt(f.peak) ?? 0,
    full: capText(f.full, 12),
    memory: capText(f.memory, 120),
    cpu: capText(f.cpu, 120),
    cpuUsed: capText(f.cpuUsed, 120),
    wait: capText(f.wait, 120),
    projects: (Array.isArray(f.projects) ? f.projects : []).slice(0, CAPACITY_PROJECTS_MAX).map((p) => capText(p, 80)).filter((p) => p !== null),
  };
}

/**
 * The capacity slice, allowlisted: the window (three integers), at most CAPACITY_HOSTS_MAX hosts by name (the worker
 * name rule; anything else dropped and counted), each with its buckets, its words, its caveats and its state (history
 * not shared, no history, or numbers), and the coverage sentence. Null for a payload without the slice (no section),
 * `{ unreachable }` for a read that failed or a window that is not one.
 */
export function normCapacity(v) {
  if (v === null || v === undefined || typeof v !== "object") return null;
  if (typeof v.unreachable === "string") return { unreachable: capText(v.unreachable, 240) ?? "unknown" };
  if (v.noTime === true) return { noTime: true, fromMs: Number.isSafeInteger(v.fromMs) && Math.abs(v.fromMs) <= 8.64e15 ? v.fromMs : null };
  const w = v.window !== null && typeof v.window === "object" ? v.window : {};
  const win = { fromMs: w.fromMs, toMs: w.toMs, bucketMs: w.bucketMs };
  if (![win.fromMs, win.toMs, win.bucketMs].every(Number.isSafeInteger) || win.fromMs >= win.toMs || Math.abs(win.fromMs) > 8.64e15 || Math.abs(win.toMs) > 8.64e15) return { unreachable: "the report's window is not readable" };
  // whole minutes, and few enough buckets to draw: a "0m" bucket, or ten thousand slivers, is not a chart
  if (win.bucketMs < 60_000 || win.bucketMs % 60_000 !== 0 || Math.ceil((win.toMs - win.fromMs) / win.bucketMs) > CAPACITY_BUCKETS_MAX) return { unreachable: "the report's buckets are not readable" };
  const all = Array.isArray(v.hosts) ? v.hosts : [];
  const valid = all.filter((h) => h !== null && typeof h === "object" && typeof h.name === "string" && INSIGHTS_CAPACITY_HOST_NAME.test(h.name));
  // A name the slice holds twice (a report never does) is drawn neither time: which one to believe cannot be told.
  const times = new Map();
  for (const h of valid) times.set(h.name, (times.get(h.name) ?? 0) + 1);
  const unique = valid.filter((h) => times.get(h.name) === 1);
  const normed = unique.map((h) => {
    const buckets = (Array.isArray(h.buckets) ? h.buckets : []).map((b) => normCapBucket(b, win)).filter((b) => b !== null).sort((a, b) => a.fromMs - b.fromMs);
    const kept = [];
    for (const b of buckets) if (kept.length < CAPACITY_BUCKETS_MAX && (kept.length === 0 || kept[kept.length - 1].fromMs !== b.fromMs)) kept.push(b);
    const base = {
      name: h.name,
      fromMs: Number.isSafeInteger(h.fromMs) ? h.fromMs : null,
      truncated: h.truncated === true,
      slots: Number.isSafeInteger(h.slots) && h.slots >= 1 && h.slots <= 100_000 ? h.slots : null,
      buckets: kept,
    };
    const notShared = capText(h.notShared);
    if (notShared !== null) return { ...base, state: "not-shared", notShared };
    const facts = normCapFacts(h.facts);
    if (h.empty === true || facts === null) return { ...base, state: "empty" };
    const caveats = (Array.isArray(h.caveats) ? h.caveats : []).slice(0, 12).map((c) => capText(c)).filter((c) => c !== null);
    return { ...base, state: "numbers", facts, caveats, notes: capText(h.notes, 600) };
  });
  // The hosts with numbers first, then those with none here, then those whose history is not here, each by name: the
  // cap must never hide the one host that ran something behind twenty that did not. What it leaves out is counted by kind.
  const rank = { numbers: 0, empty: 1, "not-shared": 2 };
  normed.sort((a, b) => rank[a.state] - rank[b.state] || cmpStr(a.name, b.name));
  const hosts = normed.slice(0, CAPACITY_HOSTS_MAX);
  const left = normed.slice(CAPACITY_HOSTS_MAX);
  const notDrawn = { numbers: 0, empty: 0, "not-shared": 0, unnamed: all.length - valid.length, repeated: [...times.values()].filter((n) => n > 1).length };
  for (const h of left) notDrawn[h.state]++;
  const coverage = (Array.isArray(v.coverage) ? v.coverage : [v.coverage]).slice(0, CAPACITY_COVERAGE_MAX).map((c) => capText(c)).filter((c) => c !== null);
  return { window: win, truncated: v.truncated === true, coverage, hosts, notDrawn, noRun: capText(v.noRun) ?? "no host ran a job in this window" };
}

/** A diagonal hatch over one rectangle as ONE path (a pattern fill would need a paint-server reference, banned here). */
function hatchPath(x, y, w, h) {
  const segs = [];
  for (let c = x - h; c < x + w; c += CAP_HATCH_STEP) {
    const lo = Math.max(0, x - c);
    const hi = Math.min(h, x + w - c);
    if (hi > lo) segs.push(`M${fmt(c + lo)} ${fmt(y + h - lo)}L${fmt(c + hi)} ${fmt(y + h - hi)}`);
  }
  return segs.join("");
}

/**
 * Pure geometry for one host's row of the capacity chart, exported so its invariants are testable as numbers: a fixed
 * time axis from the window's start to `nowMs` (so a quiet week is visible, never compressed), one bar per bucket over
 * the part of it the history covers (a bucket's covered part is its end, from the host's history start on), its height
 * the jobs running there at once on average, a tick at its peak, the host's slot count as a line; and NO DATA, every
 * stretch of the axis no bucket vouches for, as its own rectangles, each of a kind: `before` the host's history starts
 * (`host.fromMs`), `after` the report was read (`toMs`, when `nowMs` is later), and `dropped` (a bucket the page could
 * not read). No data is never a bar of zero: an idle stretch has no bar and no hatch, a stretch without data is hatched.
 * A bucket past `nowMs` (a report read after the page's instant) is cut at it, never drawn over earlier time. The x
 * labels sit at UTC midnights, every day or every few days so at most eight show.
 */
export function layoutCapacityChart(host, { fromMs, toMs, bucketMs, nowMs, width, height } = {}) {
  const w = Number.isFinite(width) && width > 100 ? width : CAP_W;
  const h = Number.isFinite(height) && height > 40 ? height : CAP_H;
  const plot = { x: CAP_ML, y: CAP_MT, w: w - CAP_ML - CAP_MR, h: h - CAP_MT - CAP_MB };
  const start = Number.isFinite(fromMs) ? fromMs : 0;
  const end = Number.isFinite(nowMs) && nowMs > start ? nowMs : Number.isFinite(toMs) && toMs > start ? toMs : start + 1;
  const readEnd = Number.isFinite(toMs) ? toMs : end;
  const step = Number.isFinite(bucketMs) && bucketMs > 0 ? bucketMs : end - start;
  const xOf = (t) => plot.x + ((Math.min(end, Math.max(start, t)) - start) / (end - start)) * plot.w;
  const buckets = Array.isArray(host?.buckets) ? host.buckets : [];
  const slots = Number.isSafeInteger(host?.slots) && host.slots >= 1 ? host.slots : null;
  const covStart = Number.isFinite(host?.fromMs) ? Math.max(start, host.fromMs) : start;
  const covered = [];
  const drawn = [];
  for (const b of buckets) {
    if (!(b.coveredMs > 0)) continue;
    // the bucket's covered part in its OWN time: its last `coveredMs`, up to the read; then cut to the axis
    const own = Math.min(b.fromMs + step, readEnd);
    const lo = Math.max(start, own - b.coveredMs);
    const hi = Math.min(own, end);
    if (!(hi > lo)) continue;
    covered.push([lo, hi]);
    drawn.push({ b, lo, hi, partial: hi - lo < Math.min(step, readEnd - b.fromMs) });
  }
  let top = Math.max(slots ?? 0, 1);
  for (const d of drawn) top = Math.max(top, d.b.peak, Math.ceil((d.b.avgMilli ?? 0) / 1000));
  const scaleMax = top;
  const yOf = (n) => plot.y + plot.h - (Math.min(n, scaleMax) / scaleMax) * plot.h;
  const bars = drawn.map(({ b, lo, hi, partial }) => {
    const x = xOf(lo);
    const y = yOf((b.avgMilli ?? 0) / 1000);
    return { x, w: xOf(hi) - x, y, h: plot.y + plot.h - y, peakY: b.peak > 0 ? yOf(b.peak) : null, bucket: b, partial };
  });
  covered.sort((a, b) => a[0] - b[0]);
  const holes = [];
  let at = start;
  for (const [lo, hi] of covered) {
    if (lo > at) holes.push([at, lo]);
    at = Math.max(at, hi);
  }
  if (at < end) holes.push([at, end]);
  // each hole cut at the history's start and at the read, so every piece is of one kind
  const gaps = [];
  for (const [lo, hi] of holes) {
    const cuts = [lo, ...[covStart, readEnd].filter((t) => t > lo && t < hi).sort((a, b) => a - b), hi];
    for (let k = 0; k + 1 < cuts.length; k++) {
      const [a, z] = [cuts[k], cuts[k + 1]];
      const kind = z <= covStart ? "before" : a >= readEnd ? "after" : "dropped";
      if (xOf(z) - xOf(a) > 0) gaps.push({ fromMs: a, toMs: z, kind, x: xOf(a), w: xOf(z) - xOf(a) });
    }
  }
  const limit = slots !== null ? { y: yOf(slots), label: `${slots} slot${slots === 1 ? "" : "s"}` } : null;
  const yTicks = slots === scaleMax ? [] : [{ y: yOf(scaleMax), label: String(scaleMax) }];
  // UTC midnights inside the axis, every `every` days (counted from the epoch, so a page reloaded later keeps its ticks)
  const days = (end - start) / DAY_MS;
  const every = [1, 2, 7, 14, 28].find((d) => days / d <= 8) ?? Math.ceil(days / 8);
  const xLabels = [];
  for (let t = Math.ceil(start / DAY_MS) * DAY_MS; t <= end && xLabels.length < 64; t += DAY_MS) {
    if (Math.round(t / DAY_MS) % every === 0) xLabels.push({ x: xOf(t), at: t, label: utcDateStr(t).slice(5) });
  }
  return { plot, bars, gaps, limit, yTicks, xLabels, scaleMax, width: w, height: h };
}

function capWhen(ms) {
  return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC` : "?";
}

/**
 * `capWhen` for page text (issue #710, review round 1): a `<time datetime>` the console's script shows in the reader's
 * zone, UTC text inside it. A chart tip keeps `capWhen`'s plain UTC text, which says "UTC": a tip is a string the page
 * script shows through `textContent`, and no `<time>` can live in it.
 */
function capWhenHtml(ms) {
  const text = capWhen(ms);
  return text === "?" ? text : `<time datetime="${new Date(ms).toISOString()}">${escapeHtml(text)}</time>`;
}

/** Why a stretch of a host's chart has no data, by its kind and the host's state. */
function capGapWhy(gap, host, translate) {
  if (gap.kind === "after") return translate("after the report was read");
  if (host.state === "not-shared") return host.notShared;
  if (host.state === "empty") return translate("no history here");
  if (gap.kind === "before") return `${translate("before this host's history starts")}${host.truncated ? ` (${translate("the run mirror holds nothing older: it started then, or its cap or a peer's shorter retention cut it")})` : ""}`;
  return translate("this bucket's numbers were not readable, so they are not drawn");
}

function capacityChartSvg(host, nc, tips, nowMs, translate) {
  const lay = layoutCapacityChart(host, { ...nc.window, nowMs });
  const svg = [`<svg width="${fmt(lay.width)}" height="${fmt(lay.height)}" role="img" aria-label="jobs at once on ${escapeHtml(host.name)}">`];
  svg.push(axisFrame(lay.plot, lay.yTicks));
  for (const g of lay.gaps) {
    const idx = tips.push(`${capWhen(g.fromMs)} ${translate("to")} ${capWhen(g.toMs)} · ${translate("no data")}: ${capGapWhy(g, host, translate)}`) - 1;
    svg.push(`<g class="nodata" data-tip="${fmt(idx)}"><rect x="${fmt(g.x)}" y="${fmt(lay.plot.y)}" width="${fmt(g.w)}" height="${fmt(lay.plot.h)}" fill="${PAGE_THEME.dim}" fill-opacity=".12"/><path d="${hatchPath(g.x, lay.plot.y, g.w, lay.plot.h)}" stroke="${PAGE_THEME.dim}" stroke-width=".6" fill="none"/></g>`);
  }
  const of = host.slots !== null ? ` ${translate("of")} ${host.slots}` : "";
  for (const bar of lay.bars) {
    const b = bar.bucket;
    const full = b.fullMs === null ? "" : `, ${translate("full")} ${capShareText(b.fullMs, b.coveredMs)}`;
    const idx = tips.push(`${capWhen(b.fromMs)} · ${translate("busy")} ${capShareText(b.busyMs, b.coveredMs)}, ${translate("avg")} ${capMilliText(b.avgMilli ?? 0)}${of}, ${translate("peak")} ${fmt(b.peak)}${full}${bar.partial ? ` (${translate("part of it has no data")})` : ""}`) - 1;
    // the whole bucket answers the tooltip, the bar only where it has height
    svg.push(`<g data-tip="${fmt(idx)}"><rect x="${fmt(bar.x)}" y="${fmt(lay.plot.y)}" width="${fmt(bar.w)}" height="${fmt(lay.plot.h)}" fill="${PAGE_THEME.canvas}" fill-opacity="0"/>`);
    if (bar.h > 0) svg.push(`<rect x="${fmt(bar.x)}" y="${fmt(bar.y)}" width="${fmt(Math.max(0.5, bar.w - 0.5))}" height="${fmt(bar.h)}" fill="${PAGE_THEME.accent}"/>`);
    if (bar.peakY !== null) svg.push(`<line x1="${fmt(bar.x)}" y1="${fmt(bar.peakY)}" x2="${fmt(bar.x + bar.w)}" y2="${fmt(bar.peakY)}" stroke="${PAGE_THEME.fg}" stroke-opacity=".5"/>`);
    svg.push("</g>");
  }
  if (lay.limit !== null) {
    svg.push(`<line x1="${fmt(lay.plot.x)}" y1="${fmt(lay.limit.y)}" x2="${fmt(lay.plot.x + lay.plot.w)}" y2="${fmt(lay.limit.y)}" stroke="${PAGE_THEME.amber}" stroke-dasharray="4,3"/>`);
    svg.push(`<text x="${fmt(lay.plot.x - 6)}" y="${fmt(lay.limit.y + 3)}" text-anchor="end" font-size="9" fill="${PAGE_THEME.amber}">${escapeHtml(lay.limit.label)}</text>`);
  }
  for (const xl of lay.xLabels) {
    svg.push(`<line x1="${fmt(xl.x)}" y1="${fmt(lay.plot.y + lay.plot.h)}" x2="${fmt(xl.x)}" y2="${fmt(lay.plot.y + lay.plot.h + 3)}" stroke="${PAGE_THEME.border}"/>`);
    svg.push(`<text x="${fmt(xl.x)}" y="${fmt(lay.plot.y + lay.plot.h + 12)}" text-anchor="middle" font-size="8" fill="${PAGE_THEME.dim}">${escapeHtml(xl.label)}</text>`);
  }
  svg.push("</svg>");
  return svg.join("");
}

export function capacitySectionHtml(nc, tips, nowMs, windowLabel, translate = (message) => message) {
  if (nc.unreachable) return `<div class="dim">${escapeHtml(translate("capacity not read"))}: ${escapeHtml(nc.unreachable)}</div><div class="dim small">${escapeHtml(translate(INSIGHTS_CAPACITY_JOBS_ONLY))}</div>`;
  if (nc.noTime) return `<div class="dim">${escapeHtml(translate("no time in this window yet"))}: ${escapeHtml(windowLabel)} ${escapeHtml(translate("starts at"))} ${capWhenHtml(nc.fromMs)}</div><div class="dim small">${escapeHtml(translate(INSIGHTS_CAPACITY_JOBS_ONLY))}</div>`;
  const hours = nc.window.bucketMs % 3_600_000 === 0 ? `${fmt(nc.window.bucketMs / 3_600_000)}h` : `${fmt(Math.round(nc.window.bucketMs / 60_000))}m`;
  const parts = [];
  parts.push(`<div class="small">${escapeHtml(windowLabel)}, ${escapeHtml(translate("from"))} ${capWhenHtml(nc.window.fromMs)} ${escapeHtml(translate("to"))} ${capWhenHtml(nc.window.toMs)}. ${escapeHtml(translate("Each bar is one"))} ${escapeHtml(hours)} ${escapeHtml(translate("bucket: how many jobs ran at once on average, with a tick at the most at once; the dashed line is the host's slot count. Hatched is no data, counted as neither busy nor idle; an idle stretch is empty."))}</div>`);
  parts.push(`<div class="dim small">${escapeHtml(translate(INSIGHTS_CAPACITY_JOBS_ONLY))}</div>`);
  if (nc.truncated) parts.push(`<div class="small cap-warn">${escapeHtml(translate("history truncated: the run mirror holds nothing older for at least one host, so its earlier time is drawn as no data, never as idle"))}</div>`);
  if (nc.hosts.length === 0) parts.push(`<div class="dim">${escapeHtml(nc.noRun)}</div>`);
  for (const host of nc.hosts) {
    const block = [];
    if (host.state === "not-shared") {
      block.push(`<h3><span class="pid">${escapeHtml(host.name)}</span> <span class="cap-warn">${escapeHtml(translate("history not here"))}</span></h3>`);
      block.push(`<div class="small">${escapeHtml(host.notShared)}</div>`);
      block.push(capacityChartSvg(host, nc, tips, nowMs, translate));
    } else if (host.state === "empty") {
      block.push(`<h3><span class="pid">${escapeHtml(host.name)}</span> <span class="dim">${escapeHtml(translate("no history here"))}</span></h3>`);
      block.push(capacityChartSvg(host, nc, tips, nowMs, translate));
    } else {
      const f = host.facts;
      const of = f.slots !== null ? ` ${translate("of")} ${f.slots}` : "";
      const head = [`${translate("busy")} ${f.busy}, ${translate("idle")} ${f.idle}${f.missing !== null ? ` (${f.missing} ${translate("of the window has no history")})` : ""}`, `${translate("avg")} ${f.avg}${of}, ${translate("peak")} ${fmt(f.peak)}${of}`];
      if (f.full !== null) head.push(`${translate("full")} ${f.full} ${translate("of the time")}`);
      block.push(`<h3><span class="pid">${escapeHtml(host.name)}</span> <span>${escapeHtml(head.join(" · "))}</span></h3>`);
      const used = [f.memory !== null && f.cpu !== null ? `${translate("promised")}: ${f.memory}, ${f.cpu}` : null, f.cpuUsed !== null ? `${translate("CPU used")}: ${f.cpuUsed}` : null, `${translate("wait for a slot")}: ${f.wait ?? translate("no run recorded one")}`].filter((x) => x !== null);
      block.push(`<div class="small">${escapeHtml(used.join(" · "))}</div>`);
      if (f.projects.length > 0) block.push(`<div class="small">${escapeHtml(translate("projects by run time"))}: ${escapeHtml(f.projects.join(", "))}</div>`);
      if (host.truncated) block.push(`<div class="small cap-warn">${escapeHtml(translate("history truncated: it starts at"))} ${capWhenHtml(host.fromMs)}</div>`);
      block.push(capacityChartSvg(host, nc, tips, nowMs, translate));
      for (const c of host.caveats) block.push(`<div class="small cap-warn">${escapeHtml(c)}</div>`);
      if (host.notes !== null) block.push(`<div class="dim small">${escapeHtml(host.notes)}</div>`);
    }
    parts.push(`<div class="bl cap">${block.join("")}</div>`);
  }
  const nd = nc.notDrawn;
  const kinds = [[nd.numbers, translate("with numbers")], [nd.empty, translate("with no history here")], [nd["not-shared"], translate("whose history is not here")]].filter(([n]) => n > 0).map(([n, what]) => `${fmt(n)} ${what}`);
  const capped = nd.numbers + nd.empty + nd["not-shared"];
  if (capped > 0) parts.push(`<div class="dim small">${fmt(capped)} ${escapeHtml(translate("more hosts not drawn past the first"))} ${fmt(CAPACITY_HOSTS_MAX)}: ${escapeHtml(kinds.join(", "))}</div>`);
  if (nd.unnamed > 0) parts.push(`<div class="dim small">${fmt(nd.unnamed)} ${escapeHtml(translate("hosts not drawn: not a worker name"))}</div>`);
  if (nd.repeated > 0) parts.push(`<div class="dim small">${fmt(nd.repeated)} ${escapeHtml(translate("host names given more than once, not drawn"))}</div>`);
  if (nc.coverage.length > 0) parts.push(`<div class="dim small">${escapeHtml(translate("Coverage:"))}</div>${nc.coverage.map((c) => `<div class="dim small">${escapeHtml(c)}</div>`).join("")}`);
  return `<div id="capacity">${parts.join("")}</div>`;
}

function utcDateStr(ms) {
  // toISOString throws outside the representable range, and a junk payload must not be able to
  // reach a throw through a date field.
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return "?";
  return new Date(ms).toISOString().slice(0, 10);
}

export function footerHtml(nf, windowLabel, translate = (message) => message) {
  const p = nf.provenance;
  const lines = [];
  lines.push(`${translate("~ marks estimates · metered = the meter read complete · pi-ai")} ${p.piAiPin ?? "—"}`);
  // The always-on pair states how much of the window was measured at all; the bracketed counters
  // appear only when nonzero because "pi-ai differs 0" reads as an accusation retracted.
  let counters = `${translate("unmetered")} ${fmt(p.runsUnmetered)} · ${translate("no ledger (totals only)")} ${fmt(p.runsUnledgered)}`;
  if (p.ratesDrifted > 0) counters += ` · ${translate("pi-ai differs")} ${fmt(p.ratesDrifted)}`;
  if (p.runsLedgerTruncated > 0) counters += ` · ${translate("ledgers truncated")} ${fmt(p.runsLedgerTruncated)}`;
  lines.push(counters);
  lines.push(`${translate("spend window")} ${utcDateStr(nf.window.fromMs)} – ${utcDateStr(nf.window.toMs)} UTC (${windowLabel})`);
  return `<div id="prov">${lines.map((l) => `<div>${escapeHtml(l)}</div>`).join("")}</div>`;
}

/** `nb`/`na` are retained argument positions (the callers still pass them); the budget and split banners are gone
 * with those sections (C2). */
export function costBannersHtml(p, nf, _nb, _na, translate = (message) => message) {
  const banners = [];
  if (typeof p.costsUnreachable === "string" && p.costsUnreachable !== "") banners.push(`${translate("costs unreachable:")} ${clip(p.costsUnreachable, 160)}`);
  if (nf !== null && nf.provenance.runsTotal === 0) banners.push(translate("no runs in the spend window"));
  // Only with the caller's explicit flag: an empty plans array alone also means "operator declared
  // nothing", and accusing a missing file on that evidence would be wrong half the time.
  if (nf !== null && nf.plans.length === 0 && p.subscriptionsInvalid) banners.push(translate("subscriptions file missing or invalid: plans not scored"));
  if (banners.length === 0) return "";
  return `<div id="cost-banners">${banners.map((b) => `<div class="banner">${escapeHtml(b)}</div>`).join("")}</div>`;
}

/** The words a payload's `window` reads as on the page, an em dash (the page's mark for none) for one it does not name. */
export function insightsWindowLabel(window) {
  return window === "7d" ? "last 7d" : window === "30d" ? "last 30d" : window === "mtd" ? "month to date" : "\u2014";
}

/**
 * The spend badges over the topology's trigger chips, and the server-side join table: original trigger id -> minted
 * ordinal. The originals stay in this scope; only the ordinal ever reaches a data attribute or the spend layer's
 * coordinates. `scene` is `buildGraphScene`'s, `spend` is `normSpendMap`'s (null for none). `{ minted, html }`: the map
 * `breakdownHtml` links its rows by, and the `<text>` badges for `topologySectionHtml`.
 */
export function topologySpend(scene, spend) {
  const minted = new Map();
  const spendParts = [];
  for (const pl of scene.layout.nodes) {
    const orig = pl.node.id;
    if (typeof orig !== "string" || !orig.startsWith("trigger:")) continue;
    minted.set(orig, pl.id);
    const entry = spend !== null && spend !== undefined ? spend.get(orig) : undefined;
    if (!entry) continue;
    const cls = entry.amount.class;
    const fill = cls === "estimated" ? PAGE_THEME.amber : PAGE_THEME.dim;
    // At the scene's own badge line: the scene routes a trigger's re-arm loop below that line, so a badge
    // drawn anywhere else could land on the loop again (issue #483).
    // The badge fits its chip (issue #492): a plan badge carries the plan's free-form id, and one long enough
    // ran past the chip onto the wires beside it. Cut with the ellipsis, the whole text in a tooltip.
    const text = fmtAmount(entry.amount);
    const cols = Math.max(2, Math.floor((pl.w - 20) / BADGE_COL_W));
    const shown = drawnColumns(text) <= cols ? text : clipColumns(text, cols - 1);
    const tip = shown !== text ? `<title>${escapeHtml(text)}</title>` : "";
    spendParts.push(`<text x="${fmt(pl.x + 16)}" y="${fmt(pl.y + SPEND_BADGE_DY)}" font-size="10" fill="${fill}">${escapeHtml(shown)}${tip}</text>`);
  }
  return { minted, html: spendParts.join("") };
}

/**
 * The topology section: the scene's pane with the spend badges (`topologySpend`'s html) over it, the tokens legend and
 * the scene's legend. Pan, zoom, the tooltip and label fitting are the console's script (`console/script.mjs`), which
 * reads the chips' data from the page's hidden `#graph-nodes` list.
 */
export function topologySectionHtml(scene, spendHtml, translate = (message) => message) {
  const windowDays = scene.norm.caps.windowDays ?? "?";
  const vb = scene.viewBox;
  const parts = [];
  parts.push(`<section><h2>${escapeHtml(translate("topology (fixed"))} ${escapeHtml(String(windowDays))}${escapeHtml(translate("d window)"))}</h2>`);
  parts.push(`<div class="dim small">${escapeHtml(translate("chip run counts use the topology window; spend badges use the spend window"))}</div>`);
  parts.push([
    '<div id="wrap">',
    // The pane takes the scene's own aspect ratio, the viewBox's (clamped by the stylesheet's max-height): a fixed
    // pane height letterboxes a wide flat topology into a mostly-empty band under "meet", and the
    // headless-screenshot pass caught exactly that. Height stays fluid; pan/zoom covers a tall scene.
    // At most GRAPH_MAX_SCALE page pixels per scene unit: a one-trigger scene filled the pane at several times the
    // scale of a real deployment's, its 14px chip labels drawn at 50px (issue #483, once the viewBox stopped
    // padding every scene with 80 units). Wider scenes fill the pane as before; a small one sits centred.
    // That cap is the `width` attribute, which the stylesheet's `max-width:100%` holds to the pane, and never a `style`
    // attribute: the operator console serves this section under a CSP that refuses inline style (issue #641).
    `<svg id="graph" class="canvas" width="${fmt(Math.max(1, vb.w) * GRAPH_MAX_SCALE)}" viewBox="${fmt(vb.x)} ${fmt(vb.y)} ${fmt(vb.w)} ${fmt(vb.h)}" role="img" aria-label="${escapeHtml(translate("pi-dispatch trigger and flow topology"))}" preserveAspectRatio="xMidYMid meet">`,
    `<g id="root">${scene.svgBody}</g>`,
    `<g id="spend">${spendHtml}</g>`,
    "</svg>",
    '<div id="tip"></div>',
    "</div>",
  ].join(""));
  parts.push(dollarsLegendHtml(translate));
  parts.push(legendHtml(scene.norm, scene.hiddenLabels, translate));
  parts.push("</section>");
  return parts.join("\n");
}

// ---- the stylesheet ----

/**
 * The sections' stylesheet: the class names and ids the renderers above emit. The console serves it, each colour
 * rewritten to a theme token (`console/style.mjs`); nothing else does since the static page was retired.
 */
export const INSIGHTS_CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{background:${PAGE_THEME.canvas};color:${PAGE_THEME.fg};font:14px/1.4 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
#windows{color:${PAGE_THEME.dim};font-size:11px;margin:0 0 8px}
section{margin:18px auto;max-width:960px}
h2{font-size:13px;color:${PAGE_THEME.fg};margin:0 0 8px}
h3{font-size:12px;color:${PAGE_THEME.dim};margin:0 0 4px}
.dim{color:${PAGE_THEME.dim}}
.small{font-size:11px}
#banners,#cost-banners{max-width:960px;margin:8px auto}
.banner{background:#2d1517;border:1px solid ${PAGE_THEME.danger};color:${PAGE_THEME.danger};border-radius:6px;padding:6px 10px;margin-bottom:6px;font-size:12px}
#kpis{display:flex;gap:10px;flex-wrap:wrap}
.kpi{background:${PAGE_THEME.panel};border:1px solid ${PAGE_THEME.border};border-radius:6px;padding:8px 14px;min-width:120px}
.kpi .v{font-size:16px}
.kpi .l{font-size:11px;color:${PAGE_THEME.dim}}
#plans{display:flex;gap:10px;flex-wrap:wrap}
.plan{background:${PAGE_THEME.panel};border:1px solid ${PAGE_THEME.border};border-radius:6px;padding:10px 12px;min-width:280px;font-size:12px}
.plan.hypo{border-style:dashed}
.pid{font-weight:600}
.pv{color:${PAGE_THEME.dim}}
.badge{font-weight:700;font-size:11px}
.badge.good{color:${PAGE_THEME.green}}
.badge.bad{color:${PAGE_THEME.amber}}
#grid,#flows,#sizes{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.bl{background:${PAGE_THEME.panel};border:1px solid ${PAGE_THEME.border};border-radius:6px;padding:8px 10px;overflow:hidden}
#capacity .bl{margin:8px 0;overflow-x:auto}
#capacity .small{margin:2px 0}
#capacity h3{color:${PAGE_THEME.fg}}
.cap-warn{color:${PAGE_THEME.amber}}
.rowlink{cursor:pointer}
#wrap{position:relative;border:1px solid ${PAGE_THEME.border};border-radius:6px}
svg.canvas{display:block;max-width:100%;height:auto;min-height:220px;max-height:75vh;margin:0 auto;cursor:grab;touch-action:none}
#tip{position:absolute;display:none;max-width:340px;background:${PAGE_THEME.panel};border:1px solid ${PAGE_THEME.border};border-radius:6px;padding:8px 10px;font-size:12px;color:${PAGE_THEME.fg};white-space:pre-line;pointer-events:none;z-index:4}
#legend,#dollars{background:${PAGE_THEME.panel};border:1px solid ${PAGE_THEME.border};border-radius:6px;padding:10px 12px;font-size:11px;color:${PAGE_THEME.dim};margin-top:10px;max-width:440px}
#legend h2,#dollars h2{font-size:11px;color:${PAGE_THEME.fg};margin:6px 0 4px}
#legend .row,#dollars .row{display:flex;align-items:center;gap:6px;margin:2px 0}
#legend .caps,#dollars .caps{margin-top:8px;color:${PAGE_THEME.fg}}
#legend .honesty{margin-top:4px;color:${PAGE_THEME.amber}}
#prov{max-width:960px;margin:16px auto;color:${PAGE_THEME.dim};font-size:11px}
.gnode{cursor:pointer}
.dim .gnode,.dim .gwire{opacity:.15}
.dim .hi{opacity:1}
`;
