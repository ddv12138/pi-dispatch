/** The four independently loaded Spend views (#749). Values stay escaped and every amount keeps its provenance. */
import { html, trustedRenderer as raw } from "../html.mjs";
import * as ui from "../kit.mjs";
import { uiText } from "../locale.mjs";
import * as capacityPulse from "./capacity-pulse.mjs";
import { fmtAmount, fmtTokens } from "../../panel.mjs";
import { buildGraphScene, bannersHtml } from "../../graph-html.mjs";
import {
  normFold,
  normCapacity,
  normSizing,
  normProjectNames,
  dailyChartHtml,
  cumulativeHtml,
  flowLinesHtml,
  planCardsHtml,
  capacitySectionHtml,
  sizingSectionHtml,
  topologySpend,
  normSpendMap,
  topologySectionHtml,
  footerHtml,
  insightsWindowLabel,
  INSIGHTS_CAPACITY_JOBS_ONLY,
} from "../../insights-html.mjs";
import {
  graphNodesHtml,
  insightsFullPaths,
  WHATIF_FLOW_RE,
} from "./insights.mjs";
import { OUTCOME_WORD_OF } from "../../words.mjs";
import { newerSkippedSentence } from "../../newer-release.mjs";
import { timeHtml, RUN_ID_RE, shownPath } from "./common.mjs";

export const SPEND_VIEWS = Object.freeze([
  ["insights", "/insights", "Spend"],
  ["insights-capacity", "/insights/capacity", "Capacity"],
  ["insights-breakdown", "/insights/breakdown", "Breakdown"],
  ["insights-flows", "/insights/flows", "Flows map"],
]);
const descriptions = [
  "Money, tokens and what the same work might cost.",
  "How much room the fleet has, and where jobs waited.",
  "The records behind the money, by trigger, repository and model.",
  "How triggers reach flows, and what ran.",
];
export const spendDescription = (name, locale = "en") =>
  uiText(descriptions[SPEND_VIEWS.findIndex(([n]) => n === name)] ?? descriptions[0], locale);
const t = (v, text) => uiText(text, v?.locale);
const spendWindowLabel = (range, locale = "en") =>
  range === "24h" ? uiText("last 24 hours", locale) : uiText(insightsWindowLabel(range), locale);
const payload = (v) => v.data?.insights ?? {};
const number = (v) => (Number.isFinite(v) && v >= 0 ? v : null);
const usd = (v, locale = "en") =>
  number(v) === null
    ? html`${ui.icon("minus")} ${uiText("unknown", locale)}`
    : v.toLocaleString("en-US");
const pct = (used, cap, locale = "en") =>
  number(used) !== null && number(cap) > 0
    ? `${Math.round((100 * used) / cap)}%`
    : uiText("unknown", locale);
const when = (value) =>
  timeHtml(typeof value === "string" ? Date.parse(value) : value);
const note = (text) => html`<p class="sp-note note">${text}</p>`;
const card = (title, body, end = null, sub = null, bodyClass = "") =>
  ui.card({
    title,
    sub,
    body: html`<div class="card__body ${bodyClass}">${body}</div>`,
    end,
  });
const empty = (title, text) => card(title, note(text));
const factsOne = (pairs) => ui.facts(pairs, { cols: 1 });
const unknownCount = (row) =>
  Number.isSafeInteger(row?.unpriced) && row.unpriced > 0 ? row.unpriced : 0;
const moneyMarks = (flags = {}) => {
  const { floor = false, estimated = false } = flags ?? {};
  return `${estimated === true ? "~" : ""}${floor === true ? "≥" : ""}`;
};
function markedMoney(amount, flags, locale = "en") {
  return number(amount) === null
    ? usd(null, locale)
    : html`${moneyMarks(flags)}${usd(amount, locale)}`;
}
function markedMoneyText(amount, flags, locale = "en") {
  // The chart's own labels: the compact ladder (fmtTokens), never a dollar remainder, so the
  // axis and the bar values stay inside the room the SVG layout reserves for them.
  return number(amount) === null
    ? uiText("unknown", locale)
    : `${moneyMarks(flags)}${fmtTokens(amount)}`;
}
function settledMoney(row, locale = "en") {
  const unknown = unknownCount(row);
  return html`${markedMoney(row?.settledTokens, { floor: row?.settledFloor, estimated: row?.settledEstimated })}${unknown ? html`; ${unknown} ${uiText(unknown === 1 ? "run has" : "runs have", locale)} ${uiText("unknown cost", locale)}` : null}`;
}
function settledMoneyText(row, locale = "en") {
  const unknown = unknownCount(row);
  return `${markedMoneyText(row?.settledTokens, { floor: row?.settledFloor, estimated: row?.settledEstimated })}${unknown ? `; ${unknown} ${uiText(unknown === 1 ? "run has" : "runs have", locale)} ${uiText("unknown cost", locale)}` : ""}`;
}

/** Legacy chart geometry is in pixels. A viewBox preserves it when the Pulse card changes width. */
export function responsiveInsightsSvg(markup) {
  return String(markup).replace(/<svg\b([^>]*)>/g, (tag, attributes) => {
    if (/\bviewBox=/.test(attributes)) return tag;
    const width = /\bwidth="(\d+(?:\.\d+)?)"/.exec(attributes)?.[1];
    const height = /\bheight="(\d+(?:\.\d+)?)"/.exec(attributes)?.[1];
    return width && height
      ? `<svg${attributes} viewBox="0 0 ${width} ${height}">`
      : tag;
  });
}
const responsiveLegacy = (markup) => raw(responsiveInsightsSvg(markup));

function pathLabel(v, value) {
  if (insightsFullPaths(v) || typeof value !== "string") return value;
  const prefix = /^(folder:|local:)/.exec(value)?.[0] ?? "";
  return prefix + shownPath(value.slice(prefix.length));
}
const fold = (v) => normFold(payload(v).fold);
function link(v, path, over = {}) {
  const q = {
    range: v.query?.range ?? "30d",
    project: v.query?.project,
    paths: v.query?.paths,
    ...over,
  };
  if (path === "/insights/capacity") delete q.project;
  if (q.range === "24h" && path !== "/insights/capacity") q.range = "30d";
  const p = new URLSearchParams();
  for (const [k, value] of Object.entries(q))
    if (value !== null && value !== undefined && value !== "")
      p.set(k, String(value));
  return `${path}?${p}`;
}
export function spendTabs(v) {
  const icons = ["spend", "slot", "runs", "flows"];
  return html`<nav class="tabs sp-tabs spend-tabs" aria-label="${t(v, "Spend views")}">${SPEND_VIEWS.map(([name, path, label], index) => html`<a href="${link(v, path)}"${v.page === name ? html` aria-current="page"` : null}>${ui.icon(icons[index], { size: "sm" })}${t(v, label)}</a>`)}</nav>${note(`${t(v, "Spend window")}: ${spendWindowLabel(v.query?.range ?? "30d", v.locale)}. ${v.page === "insights-flows" ? `${t(v, "Map window")}: ${t(v, "the last 30 days of run records")}. ` : ""}${t(v, "Series are bounded by log retention and the 92-day scan cap.")}`)}${v.role !== "operator" && v.query?.paths === "full" ? note(t(v, "Full local paths are shown to operators only; folder labels show folder names.")) : null}`;
}

export function spendControls(v) {
  const path = SPEND_VIEWS.find(([n]) => n === v.page)?.[1] ?? "/insights";
  const ranges =
    v.page === "insights-capacity"
      ? [
          ["24h", "24 hours"],
          ["7d", "7 days"],
          ["30d", "30 days"],
        ]
      : [
          ["7d", "7 days"],
          ["30d", "30 days"],
          ["mtd", "Month to date"],
        ];
  const projects = Array.isArray(payload(v).projects)
    ? payload(v).projects
    : Object.entries(payload(v).projects ?? {}).map(([id, name]) => ({
        id,
        name,
      }));
  return html`<div class="spend-controls sp-controls">
    ${ui.seg(
      ranges.map(([range, label]) => ({
        label: t(v, label),
        href: link(v, path, { range }),
        on: (v.query?.range ?? "30d") === range,
      })),
      { label: t(v, "Spend window") },
    )}${
      v.page === "insights-capacity"
        ? null
        : html`<div class="spend-projects">
          ${ui.seg(
            [
              {
                label: t(v, "All projects"),
                href: link(v, path, { project: null }),
                on: !v.query?.project,
              },
              ...projects
                .filter((p) =>
                  /^[a-z0-9][a-z0-9-]{0,31}$/.test(p.id ?? p.key ?? ""),
                )
                .map((p) => ({
                  label: p.name ?? p.id ?? p.key,
                  href: link(v, path, { project: p.id ?? p.key }),
                  on: v.query?.project === (p.id ?? p.key),
                })),
            ],
            { label: t(v, "Projects") },
          )}
        </div>`
    }
  </div>`;
}
function kpi(title, amount, text) {
  return card(title, html`${ui.kpi(amount)}${note(text)}`);
}

export function spendToday(v) {
  const s = payload(v).spend?.today;
  return card(
    t(v, "Today"),
    html`${ui.kpi(
      markedMoney(s?.usedTokens, {
        floor: s?.usedFloor,
        estimated: s?.usedEstimated,
      }),
      t(v, "settled from run records"),
    )}${factsOne([
      [t(v, "Settled in today's records"), settledMoney(s, v?.locale)],
    ])}<details class="sp-provenance"><summary>${t(v, "Cost details")}</summary>${note(t(v, "The amount is the readable run records' own settled cost. There is no token counter and no held reserve."))}${unknownCount(s) || s?.settledFloor || s?.settledEstimated ? note(t(v, "Unknown costs are not counted as zero. ≥ marks a known minimum; ~ marks an estimate.")) : null}${v.query?.project ? note(t(v, "This project's own run records.")) : null}</details>`,
    null,
    null,
    "sp-kpi",
  );
}

export function spendAverage(v) {
  const s = payload(v).spend;
  return card(
    t(v, "Average per metered run"),
    html`${ui.kpi(usd(s?.average?.costTokens, v.locale), t(v, "last 24 hours"))}<p class="sp-kf">${s?.average?.runs ?? 0} ${t(v, s?.average?.runs === 1 ? "metered run" : "metered runs")}. ${t(v, "The largest run used")} <b>${usd(s?.average?.largestTokens, v.locale)}</b>.</p>`,
    null,
    null,
    "sp-kpi",
  );
}

function tipsHtml(tips) {
  return html`<ol id="insights-tips" class="hidden-tips" hidden>
    ${tips.map((t) => html`<li>${t}</li>`)}
  </ol>`;
}
export function spendOver(v) {
  const p = payload(v);
  const days = p.spend?.daily;
  if (!Array.isArray(days))
    return empty(
      t(v, "Spend over time"),
      t(v, "Costs could not be read. The other Spend views still work."),
    );
  const max = Math.max(
    1,
    ...days.map((d) => number(d.settledTokens) ?? 0),
  );
  const n = Math.max(1, days.length);
  const plot = 170;
  const base = 192;
  const dense = n > 10;
  const chart = html`<div id="wrap" class="sp-plot"><div id="tip"></div><svg class="sp-chart" height="230" role="img" aria-label="${t(v, "Daily settled spend")}"><line class="sp-base" x1="0" x2="100%" y1="${base}" y2="${base}"></line>${days.map(
    (d, i) => {
      const settled = number(d.settledTokens);
      const x = ((i + 0.18) / n) * 100;
      const width = (0.64 / n) * 100;
      const center = ((i + 0.5) / n) * 100;
      const bar = ((settled ?? 0) / max) * plot;
      const anchor = i === 0 ? "start" : i === n - 1 ? "end" : "middle";
      const labelX = i === 0 ? 0 : i === n - 1 ? 100 : center;
      return html`<g data-tip="${i}"><title>${d.date}: ${settledMoneyText(d, v?.locale)} ${t(v, "settled")}</title>${settled === null ? html`<text class="sp-gap" x="${center}%" y="${base - 8}" text-anchor="middle">?</text>` : html`<rect class="${d.settledEstimated ? "sp-bar sp-bar--estimated" : "sp-bar"}" x="${x}%" y="${base - bar}" width="${width}%" height="${Math.max(0.3, bar)}" rx="7"></rect>`}${!dense ? html`<text class="sp-v" x="${labelX}%" y="${Math.max(13, base - bar - 8)}" text-anchor="${anchor}">${markedMoneyText(settled, { floor: d.settledFloor, estimated: d.settledEstimated }, v.locale)}</text>` : null}${!dense || i % Math.ceil(n / 7) === 0 || i === n - 1 ? html`<text class="${d.today ? "sp-d sp-d--now" : "sp-d"}" x="${labelX}%" y="224" text-anchor="${anchor}">${d.date.slice(5)}</text>` : null}</g>`;
    },
  )}</svg></div>${tipsHtml(days.map((d) => `${d.date}: ${settledMoneyText(d, v?.locale)} ${uiText("settled", v?.locale)}`))}<p class="keyrow"><span><i class="sp-k sp-k--bar"></i >${t(v, "Settled")}</span></p><details class="sp-provenance sp-daily-values"${days.some((d) => unknownCount(d) > 0 || d.settledFloor || d.settledEstimated || number(d.settledTokens) === null) ? html` open` : null}><summary>${t(v, "Daily values and coverage")}</summary>${ui.facts(
    days.map((d) => [d.date, settledMoney(d, v?.locale)]),
    { cols: 3 },
  )}</details>${note(t(v, "Every day shows record cost only. ≥ marks a known minimum; ~ marks an estimate; ? means the cost is unknown. Unknown costs are not zero."))}${newerNote(p.spend?.newerSkipped)}`;
  return card(t(v, "Spend over time"), chart, null, t(v, "per day"));
}

/**
 * The note for run records a newer pi-dispatch wrote, which no total here reads (issue #761): "N records from a newer
 * pi-dispatch not read", or nothing when there were none, so every other page is drawn as it always was.
 */
function newerNote(n) {
  const said = newerSkippedSentence(n);
  return said ? note(`${said}: the totals leave them out.`) : null;
}

function moneyCost(cost, locale = "en") {
  return !cost || cost.class === "unknown"
    ? html`${ui.icon("minus")} ${uiText("unknown", locale)}`
    : fmtAmount(cost);
}
function costRows(v, title, rows, label, meta = () => "") {
  if (!rows?.length) return empty(t(v, title), t(v, "No runs in this spend window."));
  const max = Math.max(1, ...rows.map((r) => number(r.cost?.tokens) ?? 0));
  return card(
    t(v, title),
    html`<div class="sp-hbars">${rows.map((r) => html`<div class="sp-hb"><span class="sp-hb__l"><b>${label(r)}</b>${meta(r) ? html`<small>${meta(r)}</small>` : null}</span><svg class="sp-hb__bar" height="12" aria-hidden="true"><rect class="sp-hb__bed" width="100%" height="12" rx="6"></rect><rect class="sp-hb__fill" width="${Math.min(100, (100 * (number(r.cost?.tokens) ?? 0)) / max)}%" height="12" rx="6"></rect></svg><b class="sp-hb__v">${moneyCost(r.cost, v.locale)}</b></div>`)}</div>${note(t(v, "Counts the runs in the selected spend window."))}`,
  );
}
export const spendByFlow = (v) =>
  costRows(v, "By flow", fold(v)?.byFlow, (r) => r.flow);
export const spendByModel = (v) =>
  costRows(
    v,
    "By model",
    fold(v)?.byModel,
    (r) => r.model,
    (r) => `${r.provider}; ${r.runs} ${t(v, r.runs === 1 ? "run" : "runs")}`,
  );
export const spendByProject = (v) =>
  costRows(v, "By project", fold(v)?.byProject, (r) => r.label ?? r.key);

export function spendSizes(v) {
  const s = payload(v).spend;
  const largest = number(s?.largestRangeTokens);
  const runs = Number.isSafeInteger(s?.meteredRangeRuns) ? s.meteredRangeRuns : 0;
  return card(
    t(v, "Job sizes"),
    html`${ui.kpi(usd(largest, v.locale), t(v, "the largest metered run"))}<p class="sp-kf">${runs} ${t(v, runs === 1 ? "metered run" : "metered runs")} ${t(v, "in this spend window; their recorded sizes run from zero to the largest.")}</p>${note(t(v, "Sizes are each metered run's recorded token total. There is no per-job budget, so no cap line is drawn."))}`,
    null,
    t(v, "cost per run"),
  );
}

function whatif(v, perFlow) {
  const d = v.data ?? {};
  const q = v.query ?? {};
  const p = payload(v);
  const models = p.modelChoices ?? d.pricedModels ?? [];
  const result = d.whatIf;
  const path = perFlow ? "/insights/breakdown" : "/insights";
  const rows = p.fold?.byFlow ?? [];
  let answer = null;
  if (result?.unknown)
    answer = html`${note(t(v, "Unknown model. There is nothing to compare a profile against."))}
      <ul>
        ${(result.near ?? []).map(
          (m) =>
            html`<li>
              <a
                href="${link(v, path, {
                  whatif: m,
                  ...(perFlow ? { flow: q.flow } : { runs: q.runs ?? "24h" }),
                })}"
                >${m}</a
              >
            </li>`,
        )}
      </ul>`;
  else if (result?.unreachable)
    answer = note(
      t(v, "The run records could not be read, so there is nothing to estimate from."),
    );
  else if (result?.runSet) {
    // whatIfRuns' answer is the runs' own recorded token total (usage counts do not change with the
    // model), so the old target-versus-recorded dollar pair has one honest number and no bars.
    const r = result.runSet;
    answer = html`<p class="sp-wi__s">${t(v, "Token totals do not depend on the model: the same runs on")} <b>${q.whatif}</b> ${t(v, "would use about")} <b>${usd(r.tokens, v.locale)}</b> ${t(v, "tokens")}.</p>${ui.facts([
      [
        t(v, "Ledger coverage"),
        typeof r.coverage === "number"
          ? `${Math.round(r.coverage * 100)}%`
          : "unknown",
      ],
      [t(v, "Runs excluded"), r.excluded ?? 0],
    ])}${note(`${r.excluded ?? 0} ${t(v, "runs had no ledger and were excluded.")}`)}${newerNote(r.newerSkipped)}`;
  } else if (result?.result) {
    const r = result.result;
    answer = html`${ui.facts([
      [t(v, "Per run"), fmtAmount({ tokens: r.perRun, class: r.class, floor: false })],
      [t(v, "Window estimate"), fmtAmount({ tokens: r.tokens, class: r.class, floor: false })],
      [
        t(v, "Ledger coverage"),
        typeof r.coverage === "number"
          ? `${Math.round(r.coverage * 100)}%`
          : "unknown",
      ],
      [t(v, "Runs excluded"), r.excluded ?? 0],
      ...(typeof r.contextShare === "number"
        ? [[t(v, "Context window"), `${Math.round(r.contextShare * 100)}%`]]
        : []),
    ])}${note(
      t(v, "Per-run estimate, multiplied by the flow's runs in this spend window."),
    )}${newerNote(r.newerSkipped)}`;
  }
  return card(
    t(v, perFlow ? "What if, per flow" : "What if"),
    html`<form class="sp-wiform spend-whatif" method="get" action="${path}">
        <input
          type="hidden"
          name="range"
          value="${q.range ?? "30d"}"
        />${
          q.project
            ? html`<input type="hidden" name="project" value="${q.project}" />`
            : null
        }${
          q.paths
            ? html`<input type="hidden" name="paths" value="${q.paths}" />`
            : null
        }<label
           >${t(v, "Model")}<input
            name="whatif"
            list="spend-models"
            required
            maxlength="193"
            value="${q.whatif ?? ""}"
            placeholder="provider/model" /></label
        >${
          perFlow
            ? html`<label
                 >${t(v, "Flow")}<input
                  name="flow"
                  list="spend-flows"
                  required
                  maxlength="64"
                  value="${q.flow ?? ""}" /></label
              ><datalist id="spend-flows">
                ${rows
                  .filter((r) => WHATIF_FLOW_RE.test(r.flow ?? ""))
                  .map((r) => html`<option value="${r.flow}"></option>`)}
              </datalist>`
            : html`<label
               >${t(v, "Which runs")}<select name="runs">
                <option
                  value="24h"
                  ${q.runs !== "week" ? html` selected` : null}
                >
                  Last 24 hours
                </option>
                <option
                  value="week"
                  ${q.runs === "week" ? html` selected` : null}
                >
                  This week
                </option>
              </select></label
            >`
        }<datalist id="spend-models">
          ${models.map(
            (m) =>
              html`<option value="${typeof m === "string" ? m : m.id}">
                ${typeof m === "string" ? m : m.label}
              </option>`,
          )}</datalist
        ><button class="btn btn--primary" type="submit" >${t(v, "Estimate")}</button>
      </form>
      ${answer}${note(
        t(v, "An estimate from recorded token counts. Outcomes may differ: a different model can take more turns or fail more often."),
      )}`,
  );
}
export const spendWhatif = (v) => whatif(v, false);
export const breakdownWhatif = (v) => whatif(v, true);
export function spendPlans(v) {
  const f = normFold(payload(v).recent24h);
  return card(
    t(v, "Metered and plan"),
    html`${f ? html`<ul class="sp-mp">${f.byModel.map((r) => html`<li><span class="sp-mp__k">${t(v, r.amount?.class === "estimated" ? "estimated" : "metered")}</span><span class="sp-mp__t"><b>${r.model}</b><small>${r.provider}; ${r.runs} ${t(v, "runs in 24 hours,")} ${r.tokens.toLocaleString("en-US")} ${t(v, "tokens")}${payload(v).triggersByModel?.[`${r.provider}/${r.model}`]?.length ? ` (${payload(v).triggersByModel[`${r.provider}/${r.model}`].join(", ")})` : ""}.</small></span><b class="sp-mp__v">${moneyCost(r.amount, v.locale)}</b></li>`)}</ul>` : note(t(v, "No runs could be read for the last 24 hours."))}${note(t(v, "Plan runs are counted in the plan's own windows, not per run. Their recorded tokens are the fact; there is no API price to compare."))}`,
    null,
    t(v, "last 24 hours"),
  );
}

export const capacityBusy = capacityPulse.capacityBusy;
export const capacityPeak = capacityPulse.capacityPeak;
export const capacityWait = capacityPulse.capacityWait;
export const capacityMemory = capacityPulse.capacityMemory;
export const capacityWindow = capacityPulse.capacityWindow;
export const capacityKey = capacityPulse.capacityKey;
export const capacityCoverage = capacityPulse.capacityCoverage;
export const capacityStates = capacityPulse.capacityStates;
export function capacityHosts(v) {
  const tips = [];
  const charts = capacityPulse.capacityHosts(v, tips);
  return html`<div class="stack">${charts}<p class="muted">${t(v, "Job sizes and their suggestions are on each")} <a class="link" href="/config#cf-projects">${t(v, "project page")}</a>.</p>${tipsHtml(tips)}</div>`;
}
export function breakdownSpend(v) {
  const f = fold(v);
  return kpi(
    t(v, "Window spend"),
    moneyCost(f?.provenance?.total, v.locale),
    t(v, "Settled run records only. A floor (≥) means a run could not be fully priced."),
  );
}
export function breakdownRuns(v) {
  const p = fold(v)?.provenance;
  return kpi(
    t(v, "Runs"),
    p?.runsTotal ?? t(v, "unknown"),
    `${Math.max(0, (p?.runsTotal ?? 0) - (p?.runsUnledgered ?? 0) - (p?.runsUnmetered ?? 0))} ${t(v, "fully ledgered: their cost can be re-priced.")}`,
  );
}
export function breakdownPlans(v) {
  const plans = fold(v)?.plans ?? [];
  return kpi(
    t(v, "Plans declared"),
    plans.length,
    `${plans.filter((p) => p.hypothetical).length} ${t(v, "hypothetical. Compare each with its API baseline.")}`,
  );
}
export function breakdownTop(v) {
  const f = fold(v);
  const top = f?.byFlow?.[0];
  return kpi(
    t(v, "Top flow"),
    top?.flow ?? t(v, "No flow"),
    `${top ? fmtAmount(top.cost) : t(v, "No cost")}; ${pct(top?.cost?.usd, f?.provenance?.total?.usd)} ${t(v, "of the window; next")} ${f?.byFlow?.[1]?.flow ?? t(v, "none")}.`,
  );
}
export function breakdownDaily(v) {
  const f = fold(v);
  const tips = [];
  return card(
    t(v, "Daily spend"),
    f
      ? html`<div id="wrap">
            <div id="tip"></div>
            ${responsiveLegacy(dailyChartHtml(f.daily, tips, (message) => t(v, message)))}${responsiveLegacy(
              cumulativeHtml(f.daily, tips, (message) => t(v, message)),
            )}
          </div>
          ${tipsHtml(tips)}`
      : note(t(v, "Costs could not be read.")),
  );
}
export function breakdownFlow(v) {
  const f = fold(v);
  const series = f?.dailyByFlow;
  if (!series?.length)
    return empty(t(v, "Daily spend by flow"), t(v, "No runs in this spend window."));
  const top = series.slice(0, 4);
  const max = Math.max(
    1,
    ...top.flatMap((r) => r.days.map((d) => number(d.cost?.tokens) ?? 0)),
  );
  const rest = series
    .slice(4)
    .reduce(
      (total, r) =>
        total + r.days.reduce((n, d) => n + (number(d.cost?.tokens) ?? 0), 0),
      0,
    );
  return card(
    t(v, "Daily spend by flow"),
    html`<div class="sp-hbars">
        ${top.map((r) => {
          const width = 100 / Math.max(1, r.days.length);
          return html`<div class="sx-flow">
            <div class="row">
              <b class="mono">${r.flow}</b
              ><span
                >${usd(
                  r.days.reduce(
                    (n, d) => n + (number(d.cost?.tokens) ?? 0),
                    0,
                  ),
                )}</span
              >
            </div>
            <svg
              class="sp-chart spend-chart"
              viewBox="0 0 100 28"
              role="img"
              aria-label="${r.flow}, daily spend on the shared scale"
            >
              ${r.days.map((d, i) => {
                const h = ((number(d.cost?.tokens) ?? 0) / max) * 24;
                return html`<g
                  ><title>${d.day}: ${moneyCost(d.cost, v.locale)}</title
                  ><rect
                    class="sp-hbin"
                    x="${i * width + width * 0.15}"
                    y="${26 - h}"
                    width="${width * 0.7}"
                    height="${Math.max(0.12, h)}"
                  ></rect
                ></g>`;
              })}
            </svg>
          </div>`;
        })}
      </div>
      ${note(
        `${t(v, "Top four flows share a 0 to ")}${fmtTokens(max)}${t(v, " daily scale. The rest add up to ")}${fmtTokens(rest)}${t(v, " tokens.")}`,
      )}`,
  );
}

export function breakdownRows(v) {
  const f = fold(v);
  if (!f) return empty(t(v, "Breakdown"), t(v, "Costs could not be read."));
  return card(
    t(v, "Breakdown"),
    html`${note(t(v, "By flow and by project are on the Spend view."))}
      <h3>${t(v, "By trigger")}</h3>
      <div class="table-scroll">
        <table class="table">
          <thead>
            <tr>
              <th>${t(v, "Trigger")}</th>
              <th>${t(v, "Runs")}</th>
              <th>${t(v, "Failed")}</th>
              <th>${t(v, "Cost")}</th>
            </tr>
          </thead>
          <tbody>
            ${(f.byTrigger ?? []).map(
              (r) =>
                html`<tr>
                  <td>
                    ${
                      r.index !== null
                        ? html`<a
                          href="${link(v, "/insights/flows", {
                            select: r.index,
                          })}"
                          >${r.index + 1}. ${r.type} ${r.label}</a
                        >`
                        : r.label
                    }
                  </td>
                  <td>${r.runs}</td>
                  <td>${r.outcomes.failed}</td>
                  <td>${moneyCost(r.cost, v.locale)}</td>
                </tr>`,
            )}
          </tbody>
        </table>
      </div>
      <h3>${t(v, "By repository")}</h3>
      ${ui.facts(
        f.byRepo.map((r) => [
          pathLabel(v, r.label),
          html`${t(v, r.kind ?? "no forge")},
          ${
            (payload(v).repoProjects?.[r.key ?? "(no target)"] ?? [])
              .map((id) => id ?? t(v, "no project"))
              .join(", ") || t(v, "no project")
          },
          ${moneyCost(r.cost, v.locale)}`,
        ]),
      )}
      <h3>${t(v, "By model")}</h3>
      ${ui.facts(
        f.byModel.map((r) => [`${r.provider}/${r.model}`, moneyCost(r.cost, v.locale)]),
      )}${
        v.role === "operator"
          ? html`<a
            class="btn"
            href="${link(v, "/insights/breakdown", {
              paths: v.query?.paths === "full" ? null : "full",
            })}"
            >${t(v, v.query?.paths === "full" ? "Last folder" : "Full paths")}</a
          >`
          : null
      }`,
  );
}
export function breakdownSubscriptions(v) {
  const f = fold(v);
  return card(
    t(v, "Plans"),
    f?.plans?.length
      ? raw(planCardsHtml(f.plans, (message) => t(v, message)))
      : note(
          t(v, "Plans not scored: subscriptions.json is missing, invalid, or declares no plans."),
        ),
  );
}
export const breakdownLegend = (v) =>
  card(
    t(v, "How tokens are shown"),
    note(
      t(v, "Metered: the run's recorded usage totals. Estimated (~): partial evidence. Unknown: not readable. Floor (≥): at least this much."),
    ),
  );
export function breakdownProvenance(v) {
  const f = fold(v);
  return card(
    t(v, "Where these numbers come from"),
    html`${note(
      t(v, "Metered means the run's recorded usage totals, not an invoice. Tokens held for running jobs are not in run records yet; the Spend view shows them."),
    )}${
      f
        ? raw(footerHtml(f, spendWindowLabel(v.query?.range, v.locale), (message) => t(v, message)))
        : note(t(v, "No record provenance could be read."))
    }`,
  );
}
export function breakdownStates(v) {
  const f = fold(v);
  return card(
    t(v, "Other states"),
    html`${note(
      !f
        ? t(v, "Costs could not be read.")
        : !f.provenance.runsTotal
          ? t(v, "No runs in the spend window.")
          : t(v, "The records in the selected spend window are shown."),
    )}${newerNote(f?.newerSkipped)}${
      !f?.provenance.runsTotal
        ? html`<a href="${link(v, "/insights/breakdown", { range: "30d" })}"
          >${t(v, "Try 30 days")}</a
        >`
        : null
    }`,
  );
}
function scene(v) {
  return buildGraphScene(payload(v).graph, {
    now: v.now,
    fullPaths: insightsFullPaths(v),
    outcomeWords: OUTCOME_WORD_OF,
  });
}
function selectedNode(v, sc) {
  const index = v.query?.select;
  return index !== null && index !== undefined
    ? sc.norm.nodes.find(
        (n) => n.kind === "trigger" && String(n.index) === String(index),
      )
    : null;
}
export function flowsMap(v) {
  const sc = scene(v);
  const q = v.query ?? {};
  const nodes = sc.norm.nodes;
  const triggers = nodes.filter((n) => n.kind === "trigger");
  if (sc.norm.meta.triggersMissing || sc.norm.meta.triggersInvalid)
    return card(
      t(v, "Flows"),
      html`${raw(bannersHtml(sc.norm, (message) => t(v, message)))}${note(
        t(v, "Configuration says where the triggers file should be. Nothing is drawn until it loads."),
      )}`,
    );
  const toggles = ui.seg(
    [
      ["map", "Map"],
      ["list", "List"],
    ].map(([view, label]) => ({
      label,
      href: link(v, "/insights/flows", { view, select: q.select }),
      on: (q.view ?? "map") === view,
    })),
    { label: t(v, "Flows view") },
  );
  if (q.view === "list")
    return card(
      t(v, "Flows list"),
      html`${toggles}
        <div class="table-scroll">
          <table class="table">
            <thead>
              <tr>
                <th>${t(v, "Trigger")}</th>
                <th>${t(v, "Flow and state")}</th>
                <th>${t(v, "Folder")}</th>
                <th>${t(v, "Runs and last outcome")}</th>
                <th>${t(v, "Spend")}</th>
                <th>${t(v, "Badges and chains")}</th>
              </tr>
            </thead>
            <tbody>
              ${triggers.map((n) => {
                const flows = sc.norm.edges
                  .filter((e) => e.from === n.id && e.kind === "config")
                  .map((e) => nodes.find((f) => f.id === e.to))
                  .filter(Boolean);
                const folder = sc.norm.folders?.find(
                  (f) => f.key === n.folderKey,
                );
                return html`<tr>
                  <td>
                    <a
                      href="${link(v, "/insights/flows", {
                        view: "list",
                        select: n.index,
                      })}"
                      >${n.index + 1}. ${n.onType} ${n.label}</a
                    >
                  </td>
                  <td>
                    ${n.flow ?? n.command ?? t(v, "No flow")}
                    ${flows.map((f) => f.kind).join(", ")}
                  </td>
                  <td>${folder?.label ?? t(v, "unverifiable from this host")}</td>
                  <td>${n.runs} ${t(v, n.runs === 1 ? "run" : "runs")}; ${n.lastOutcome ?? t(v, "no outcome")}</td>
                  <td>${moneyCost(n.cost, v.locale)}</td>
                  <td>
                    ${
                      n.once
                        ? t(v, "one-shot armed")
                        : n.disarmed
                          ? t(v, "one-shot spent")
                          : ""
                    }
                    ${sc.norm.flags
                      .filter((f) => f.nodeId === n.id)
                      .map((f) => f.flag)
                      .join(", ")}
                    ${flows.map((f) => f.label).join(", ")}
                  </td>
                </tr>`;
              })}
            </tbody>
          </table>
        </div>
        <h3>${t(v, "Flows nothing reaches")}</h3>
        ${note(
          nodes
            .filter(
              (n) =>
                n.kind !== "trigger" &&
                !sc.norm.edges.some((e) => e.to === n.id),
            )
            .map((n) => n.label)
            .join(", ") || "None",
        )}`,
    );
  const selected = selectedNode(v, sc);
  const { html: spendHtml } = topologySpend(
    sc,
    normSpendMap(payload(v).costByTrigger),
  );
  let body = topologySectionHtml(sc, spendHtml);
  // The scene owns minted ids. Public links use the triggers-file index, which remains meaningful across pages.
  for (const p of sc.layout.nodes) {
    const n = p.node;
    const attr = `id="${p.id}"`;
    body = body.replace(
      attr,
      `${attr} tabindex="0" role="button" aria-label="${String(
        n.label ?? "Flow",
      )
        .replaceAll("&", "&amp;")
        .replaceAll('"', "&quot;")
        .replaceAll("<", "&lt;")
        .replaceAll(
          ">",
          "&gt;",
        )}"${n.kind === "trigger" ? ` data-trigger-index="${n.index}"` : ""}${selected && n.id === selected.id ? ' aria-pressed="true"' : ' aria-pressed="false"'}`,
    );
    if (
      selected &&
      (n.id === selected.id ||
        sc.norm.edges.some((e) => e.from === selected.id && e.to === n.id))
    )
      body = body.replace(`class="gnode" ${attr}`, `class="gnode hi" ${attr}`);
  }
  const spentLinks = sc.layout.nodes
    .filter(
      (p) => p.node.disarmed?.jobId && RUN_ID_RE.test(p.node.disarmed.jobId),
    )
    .map((p) =>
      String(
        html`<a
          href="/run?${new URLSearchParams({ id: p.node.disarmed.jobId })}"
          aria-label="${t(v, "Run that spent trigger")} ${(p.node.index ?? 0) + 1}"
          ><text
            x="${p.x + p.w - 22}"
            y="${p.y - 5}"
            font-size="10"
            fill="var(--focus)"
            >Run</text
          ></a
        >`,
      ),
    )
    .join("");
  body = body.replace('<g id="spend">', `${spentLinks}<g id="spend">`);
  if (selected) body = body.replace('id="root"', 'id="root" class="dim"');
  return card(
    t(v, "Flows map"),
    html`${toggles}
      <div class="actions">
        <button
          type="button"
          class="btn btn--sm"
          data-graph-zoom="out"
          aria-label="${t(v, "Zoom out")}"
        >
          −</button
        ><button
          type="button"
          class="btn btn--sm"
          data-graph-zoom="in"
          aria-label="${t(v, "Zoom in")}"
        >
          +</button
        ><button type="button" class="btn btn--sm" data-graph-zoom="fit">
          ${t(v, "Fit")}
        </button>
      </div>
      ${raw(body)}${graphNodesHtml(sc)}`,
  );
}
function selectedDetails(v, sc, n) {
  const group = sc.norm.folders?.find((f) => f.key === n.folderKey);
  const flows = sc.norm.edges
    .filter((e) => e.from === n.id && e.kind === "config")
    .map((e) => sc.norm.nodes.find((x) => x.id === e.to))
    .filter(Boolean);
  return html`<h3>${t(v, "Trigger")} ${n.index + 1}</h3>
    ${factsOne([
      [t(v, "Kind and phrase"), `${n.onType}: ${n.label}`],
      [t(v, "Schedule"), n.pattern ?? t(v, "Event driven")],
      [t(v, "Flow"), n.flow ?? n.command ?? t(v, "none")],
      [t(v, "Skill state"), flows.map((f) => f.kind).join(", ") || t(v, "not found")],
      ["Folder", group?.label ?? t(v, "unverifiable from this host")],
      [t(v, "HEAD"), group?.head ?? t(v, "unknown")],
      [t(v, "Runs in map window"), n.runs],
      [t(v, "Last outcome"), html`${n.lastOutcome ?? "none"} ${when(n.lastEndedAt)}`],
      [
        t(v, "Next fire"),
        n.next === null || n.next === undefined
          ? t(v, "not scheduled")
          : when(n.next),
      ],
      [t(v, "Spend"), moneyCost(n.cost, v.locale)],
      [
        t(v, "Chainable"),
        flows.some((f) => f.aiTrigger)
          ? t(v, "Yes, ai-trigger: allow")
          : t(v, "Not declared"),
      ],
      [
        "Chains",
        sc.norm.edges
          .filter(
            (e) => flows.some((f) => f.id === e.from) && e.kind !== "config",
          )
          .map(
            (e) =>
              `${sc.norm.nodes.find((x) => x.id === e.to)?.label ?? t(v, "unknown flow")}: ${e.count ?? 0} observed (${e.kind})`,
          )
          .join(", ") || t(v, "none observed"),
      ],
      [
        t(v, "Loops in the skill"),
        flows
          .flatMap((f) => f.loops ?? [])
          .map((l) => l.hint)
          .join(", ") || t(v, "none detected"),
      ],
    ])}${
      n.disarmed?.jobId && RUN_ID_RE.test(n.disarmed.jobId)
        ? html`<a
          class="btn"
          href="/run?${new URLSearchParams({ id: n.disarmed.jobId })}"
           >${t(v, "Run that spent this one-shot")}</a
        >`
        : null
    }
    <div class="actions">
      <a class="btn" href="/config" >${t(v, "Open trigger")}</a
      ><a
        class="btn"
        href="/runs?${new URLSearchParams({
          trigger:
            n.cronId && n.cronId.length <= 128 ? n.cronId : String(n.index),
        })}"
         >${t(v, "Runs from it")}</a
      >
    </div>`;
}
export function flowsSelected(v) {
  const sc = scene(v);
  const selected = selectedNode(v, sc);
  return card(
    t(v, "Selected trigger"),
    html`<div data-selected-empty${selected ? html` hidden` : null}>
        ${note(t(v, "Choose a chip to see its schedule, flow, runs and chains."))}
      </div>
      <div data-selected-details${selected ? null : html` hidden`}>
        ${selected ? selectedDetails(v, sc, selected) : null}
      </div>
      ${sc.norm.nodes
        .filter((n) => n.kind === "trigger")
        .map(
          (n) =>
            html`<template data-trigger-details="${n.index}"
              >${selectedDetails(v, sc, n)}</template
            >`,
        )}`,
  );
}
export const flowsKey = (v) =>
  card(
    t(v, "Key"),
    note(
      t(v, "Solid flow: found at HEAD. Dashed grey: unverified. Dashed amber: not at HEAD. Dashed red: missing. Faded: orphan or spent one-shot. Wires: config, observed, potential mention, cron re-arm. Dot: unread, injected ai-trigger or PR spend-loop risk. Ring: chainable. Strong mention and invalid flow names are distinguished in their tooltips."),
    ),
  );
export function flowsHonesty(v) {
  const sc = scene(v);
  return card(
    t(v, "What the map cannot see"),
    html`${
      sc.norm.meta.triggersMissing || sc.norm.meta.triggersInvalid
        ? null
        : raw(bannersHtml(sc.norm, (message) => t(v, message)))
    }${note(
      `${t(v, "Unverifiable skills, unattributed runs, refused chains and scan caps remain incomplete evidence.")} ${sc.hiddenLabels} ${t(v, "wire labels moved into tooltips. Chain caps still apply.")}`,
    )}`,
  );
}
// Empty optional fragments must not leave indentation-only lines in the checked-in page fixtures.
const panels = (entries) =>
  entries.map(([id, fn]) => [
    `p-${id}`,
    (view) => raw(String(fn(view)).replace(/[ \t]+\n/g, "\n")),
  ]);
export const SPEND_PANELS = Object.freeze({
  insights: panels([
    ["today", spendToday],
    ["avg", spendAverage],
    ["over", spendOver],
    ["byflow", spendByFlow],
    ["bymodel", spendByModel],
    ["byproject", spendByProject],
    ["sizes", spendSizes],
    ["whatif", spendWhatif],
    ["plan", spendPlans],
  ]),
  "insights-capacity": panels([
    ["cap-busy", capacityBusy],
    ["cap-peak", capacityPeak],
    ["cap-wait", capacityWait],
    ["cap-mem", capacityMemory],
    ["cap-window", capacityWindow],
    ["cap-hosts", capacityHosts],
    ["cap-key", capacityKey],
    ["cap-coverage", capacityCoverage],
    ["cap-states", capacityStates],
  ]),
  "insights-breakdown": panels([
    ["bk-spend", breakdownSpend],
    ["bk-runs", breakdownRuns],
    ["bk-plans", breakdownPlans],
    ["bk-top", breakdownTop],
    ["daily", breakdownDaily],
    ["daily-flow", breakdownFlow],
    ["breakdown", breakdownRows],
    ["whatif-flow", breakdownWhatif],
    ["plans", breakdownSubscriptions],
    ["money-legend", breakdownLegend],
    ["provenance", breakdownProvenance],
    ["bk-states", breakdownStates],
  ]),
  "insights-flows": panels([
    ["flows", flowsMap],
    ["flows-key", flowsKey],
    ["flows-selected", flowsSelected],
    ["flows-honesty", flowsHonesty],
  ]),
});
const layout = (kpis, main, side) => [
  { cls: "cards-4", items: kpis.map((x) => `p-${x}`) },
  {
    cls: "cols",
    items: [
      { cls: "stack", items: main.map((x) => `p-${x}`) },
      { cls: "stack", items: side.map((x) => `p-${x}`) },
    ],
  },
];
export const SPEND_LAYOUTS = Object.freeze({
  insights: [
    { cls: "cards-2", items: ["p-today", "p-avg"] },
    {
      cls: "cols spend-grid",
      items: [
        {
          cls: "stack spend-main",
          items: [
            "p-over",
            {
              cls: "cards-3 spend-costs",
              items: ["p-byflow", "p-bymodel", "p-byproject"],
            },
            "p-sizes",
          ],
        },
        { cls: "stack spend-side", items: ["p-whatif", "p-plan"] },
      ],
    },
  ],
  "insights-capacity": [
    {
      cls: "cards-4",
      items: ["p-cap-busy", "p-cap-peak", "p-cap-wait", "p-cap-mem"],
    },
    { cls: "stack", items: ["p-cap-window"] },
    {
      cls: "cols",
      items: [
        { cls: "stack", items: ["p-cap-hosts"] },
        {
          cls: "stack",
          items: ["p-cap-key", "p-cap-coverage", "p-cap-states"],
        },
      ],
    },
  ],
  "insights-breakdown": layout(
    ["bk-spend", "bk-runs", "bk-plans", "bk-top"],
    ["daily", "daily-flow", "breakdown", "whatif-flow"],
    ["plans", "money-legend", "provenance", "bk-states"],
  ),
  "insights-flows": [
    {
      cls: "cols",
      items: [
        { cls: "stack", items: ["p-flows", "p-flows-key"] },
        { cls: "stack", items: ["p-flows-selected", "p-flows-honesty"] },
      ],
    },
  ],
});
