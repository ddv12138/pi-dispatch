/** Five independently loaded Spend views (#749). Values stay escaped and every amount keeps its provenance. */
import { PLAN_REASON_TEXT } from "@edgehero/pi-dispatch/reason-catalog";
import { html, trustedRenderer as raw } from "../html.mjs";
import * as ui from "../kit.mjs";
import { uiText } from "../locale.mjs";
import { countStatus } from "./overview.mjs";
import * as capacityPulse from "./capacity-pulse.mjs";
import { fmtAmount, escapeInterpreted } from "../../panel.mjs";
import { buildGraphScene, bannersHtml } from "../../graph-html.mjs";
import {
  normFold,
  normAllocation,
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
import { canAct, timeHtml, RUN_ID_RE, shownPath } from "./common.mjs";

export const SPEND_VIEWS = Object.freeze([
  ["insights", "/insights", "Spend"],
  ["insights-budget-split", "/insights/budget-split", "Budget split"],
  ["insights-capacity", "/insights/capacity", "Capacity"],
  ["insights-breakdown", "/insights/breakdown", "Breakdown"],
  ["insights-flows", "/insights/flows", "Flows map"],
]);
const descriptions = [
  "Money, tokens and what the same work might cost.",
  "Weights only: it never changes a cap.",
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
const progress = (used, cap, label, status = "ok") =>
  number(used) !== null && number(cap) > 0
    ? ui.meter({ value: used, max: cap, label, status, height: 10 })
    : null;
const compactNumber = (n, locale = "en") =>
  number(n) === null
    ? uiText("unknown", locale)
    : n >= 1_000_000
      ? `${(n / 1_000_000).toFixed(2)}M`
      : n >= 10_000
        ? `${(n / 1000).toFixed(1)}k`
        : n.toLocaleString("en-US");
function statusBadge(status, word) {
  return ui.badge(status, word);
}
function allocationWeights(p) {
  const weights = p?.state?.weights;
  return weights && typeof weights === "object"
    ? Object.entries(weights).filter(([, value]) => number(value) !== null)
    : [];
}

const overAllocation = (row) => number(row.spent) !== null && number(row.allocation) !== null && row.spent > row.allocation;
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
  return number(amount) === null
    ? uiText("unknown", locale)
    : `${moneyMarks(flags)}$${(amount / 1e6).toFixed(2)}`;
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
  const icons = ["spend", "pie", "slot", "runs", "flows"];
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
    ${
      v.page === "insights-budget-split"
        ? null
        : ui.seg(
            ranges.map(([range, label]) => ({
              label: t(v, label),
              href: link(v, path, { range }),
              on: (v.query?.range ?? "30d") === range,
            })),
            { label: t(v, "Spend window") },
          )
    }${
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
function capLine(label, used, cap, money = true, soft = null, locale = "en", stateWord = null) {
  const state = stateWord ?? /: (Full|Soft hold|Open|unknown)$/.exec(label)?.[1];
  const status =
    state === "Full"
      ? "failed"
      : state === "Soft hold"
        ? "attention"
        : number(used) === null
          ? "idle"
          : "ok";
  return html`<div class="meterrow"><span class="meterrow__l">${label}</span>${number(used) !== null && number(cap) > 0 ? ui.meter({ value: used, max: cap, label, status, hold: soft, height: 10 }) : html`<svg class="pbar tone-idle" height="10" role="img" aria-label="${label}: ${uiText("usage unknown", locale)}"><rect class="pbar__bed" width="100%" height="10" rx="5"></rect>${number(soft) !== null ? html`<line class="pbar__hold" x1="${soft}%" x2="${soft}%" y1="-3" y2="13"></line>` : null}</svg>`}<span class="meterrow__v">${money ? usd(used) : compactNumber(used)} <span>/ ${money ? usd(cap) : compactNumber(cap)}</span></span></div>`;
}

export function spendWeek(v) {
  const s = payload(v).spend?.week;
  const left =
    number(s?.usedTokens) !== null && number(s?.capTokens) !== null
      ? Math.max(0, s.capTokens - s.usedTokens)
      : null;
  return card(
    t(v, "Spent this week"),
    html`${ui.kpi(usd(s?.usedTokens, v.locale), html`${t(v, "of")} ${usd(s?.capTokens, v.locale)}`)}${progress(s?.usedTokens, s?.capTokens, t(v, "This week's reserve and held against its weekly token cap"))}<p class="sp-kf">${t(v, "Mon to today.")} ${pct(s?.usedTokens, s?.capTokens, v.locale)} ${t(v, "of the weekly cap.")} ${usd(left, v.locale)} ${t(v, "left.")}</p>${v.query?.project ? note(s?.projectFallback ? t(v, "Deployment weekly cap: this project has no separate weekly token window.") : `${t(v, "Project")} ${v.query.project}${t(v, "'s weekly token window.")}`) : null}`,
    null,
    null,
    "sp-kpi",
  );
}

export function spendToday(v) {
  const s = payload(v).spend?.today;
  const capped = s?.counterConfigured === true || number(s?.capTokens) > 0;
  const uncapped =
    s?.counterConfigured === false || s?.usedSource === "records";
  const chargedDiffers =
    s?.ledgerTokens !== undefined &&
    (s.ledgerTokens !== s.settledTokens ||
      s.settledFloor === true ||
      s.settledEstimated === true ||
      unknownCount(s) > 0);
  return card(
    t(v, "Today"),
    html`${ui.kpi(
      markedMoney(s?.usedTokens, {
        floor: s?.usedFloor,
        estimated: s?.usedEstimated,
      }),
      capped
          ? html`${t(v, "of")} ${usd(s?.capTokens, v.locale)}`
        : uncapped
          ? t(v, "No daily token cap is configured")
          : t(v, "The daily token cap could not be read"),
    )}${progress(s?.usedTokens, s?.capTokens, t(v, "Today's reserve and held against its daily token cap"))}${factsOne(
      [
        [t(v, "Settled in today's records"), settledMoney(s, v?.locale)],
        [
          `${t(v, "Held for")} ${s?.heldJobs ?? t(v, "unknown")} ${t(v, s?.heldJobs === 1 ? "running job" : "running jobs")}`,
          usd(s?.heldTokens, v.locale),
        ],
        ...(chargedDiffers
          ? [[t(v, "Recorded window settlements"), usd(s.ledgerTokens, v.locale)]]
          : []),
        ...(capped
          ? [
              [
                t(v, "Counter beyond recorded window charges and holds"),
                usd(s?.unattributedTokens, v.locale),
              ],
            ]
          : []),
      ],
    )}${s?.unknownHosts?.length ? note(`${t(v, "Holds not published by:")} ${s.unknownHosts.join(", ")}. ${t(v, "Those jobs are not counted as zero.")}`) : null}<details class="sp-provenance"><summary>${t(v, "Cost and counter details")}</summary>${chargedDiffers ? note(t(v, "Readable record cost includes work outside dollar windows or cost that is not fully known. Recorded window settlements is the recorded window charge, not the cost of all readable work.")) : null}${note(
      capped
        ? t(v, "The counter remainder is not explained by readable window charges and published holds. It can include records this host cannot read, such as another host's on an unshared PI_LOGS_DIR. Held money is reported by running jobs, never inferred from the counter.")
        : uncapped
          ? t(v, "The amount above is readable record cost plus published running-job holds, not a dollar-window counter. Held money is reported by running jobs, never inferred from another total.")
          : t(v, "The dollar-window configuration could not be read. Unknown amounts are not zero."),
    )}${s?.usedSource === "unknown-counter" ? note(t(v, "The configured dollar counter could not be read. Its amount stays unknown; readable records do not replace it.")) : null}${unknownCount(s) || s?.settledFloor || s?.settledEstimated ? note(t(v, "Unknown costs are not counted as zero. ≥ marks a known minimum; ~ marks an estimate.")) : null}${
      s?.reconciliationMismatch
        ? note(
            t(v, "Counter reconciliation mismatch: readable window charges and running-job holds exceed the counter. Refresh or check shared history; no held money is inferred."),
          )
        : null
    }${
      v.query?.project
        ? note(
            typeof s?.basis === "string" && s.basis.startsWith("project:")
              ? t(v, "This project's own token windows.")
              : t(v, "Deployment token windows: this project has no separate token window."),
          )
        : null
    }</details>`,
    capped && number(s?.usedTokens) !== null
      ? statusBadge("ok", pct(s.usedTokens, s.capTokens, v.locale))
      : null,
    null,
    "sp-kpi",
  );
}

export function spendTokens(v) {
  const s = payload(v).spend?.tokens;
  return card(
    t(v, "Tokens today"),
    html`${ui.kpi(compactNumber(s?.used, v.locale), html`${t(v, "of")} ${compactNumber(s?.cap, v.locale)}`)}${progress(s?.used, s?.cap, t(v, "Tokens today against the daily token cap"))}<p class="sp-kf">${number(s?.used) === null ? t(v, "unknown") : s.used.toLocaleString("en-US")} ${t(v, "tokens")}, ${pct(s?.used, s?.cap, v.locale)} ${t(v, "of the daily token cap. No soft hold.")}</p>`,
    null,
    null,
    "sp-kpi",
  );
}

export function spendAverage(v) {
  const s = payload(v).spend;
  return card(
    t(v, "Average per metered run"),
    html`${ui.kpi(usd(s?.average?.costTokens, v.locale), t(v, "last 24 hours"))}${progress(s?.average?.costTokens, s?.jobCapTokens, t(v, "Average cost per metered run against the job cap"))}<p class="sp-kf">${s?.average?.runs ?? 0} ${t(v, s?.average?.runs === 1 ? "metered run" : "metered runs")}. ${t(v, "The job cap is")} <b>${usd(s?.jobCapTokens, v.locale)}</b>; ${t(v, "the largest run used")} <b>${usd(s?.average?.largestTokens, v.locale)}</b>.</p>`,
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
  const cap = number(p.spend?.today?.capTokens);
  const max = Math.max(
    1,
    cap ?? 0,
    ...days.map(
      (d) =>
        (number(d.settledTokens) ?? 0) +
        (d.today ? (number(d.heldTokens) ?? 0) : 0),
    ),
  );
  const n = Math.max(1, days.length);
  const plot = 170;
  const base = 192;
  const dense = n > 10;
  const valueOf = (d) =>
    number(d.settledTokens) === null ||
    (d.today && number(d.heldTokens) === null)
      ? null
      : d.settledTokens + (d.today ? d.heldTokens : 0);
  const chart = html`<div id="wrap" class="sp-plot"><div id="tip"></div><svg class="sp-chart" height="230" role="img" aria-label="${t(v, "Daily settled spend with today's running-job holds")}">${cap !== null ? html`<line class="sp-cap" x1="0" x2="100%" y1="${base - (cap / max) * plot}" y2="${base - (cap / max) * plot}"></line><text class="sp-ll sp-ll--cap" x="100%" y="${Math.max(12, base - (cap / max) * plot - 7)}" text-anchor="end">${t(v, "daily cap")} ${markedMoneyText(cap)}</text>` : null}<line class="sp-base" x1="0" x2="100%" y1="${base}" y2="${base}"></line>${days.map(
    (d, i) => {
      const settled = number(d.settledTokens);
      const held = d.today ? number(d.heldTokens) : 0;
      const x = ((i + 0.18) / n) * 100;
      const width = (0.64 / n) * 100;
      const center = ((i + 0.5) / n) * 100;
      const bar = ((settled ?? 0) / max) * plot;
      const top = ((held ?? 0) / max) * plot;
      const anchor = i === 0 ? "start" : i === n - 1 ? "end" : "middle";
      const labelX = i === 0 ? 0 : i === n - 1 ? 100 : center;
      return html`<g data-tip="${i}"><title>${d.date}: ${settledMoneyText(d, v?.locale)} ${t(v, "settled")}${d.today ? `; ${markedMoneyText(held)} ${t(v, "held")}` : ""}</title>${settled === null ? html`<text class="sp-gap" x="${center}%" y="${base - 8}" text-anchor="middle">?</text>` : html`<rect class="${d.settledEstimated ? "sp-bar sp-bar--estimated" : "sp-bar"}" x="${x}%" y="${base - bar}" width="${width}%" height="${Math.max(0.3, bar)}" rx="7"></rect>`}${top > 0 ? html`<rect class="sp-held" x="${x}%" y="${base - bar - top}" width="${width}%" height="${top}" rx="7"></rect>` : null}${!dense ? html`<text class="sp-v" x="${labelX}%" y="${Math.max(13, base - bar - top - 8)}" text-anchor="${anchor}">${markedMoneyText(valueOf(d), { floor: d.settledFloor, estimated: d.settledEstimated })}</text>` : null}${!dense || i % Math.ceil(n / 7) === 0 || i === n - 1 ? html`<text class="${d.today ? "sp-d sp-d--now" : "sp-d"}" x="${labelX}%" y="224" text-anchor="${anchor}">${d.date.slice(5)}</text>` : null}</g>`;
    },
  )}</svg></div>${tipsHtml(days.map((d) => `${d.date}: ${settledMoneyText(d, v?.locale)} ${uiText("settled", v?.locale)}${d.today ? `; ${markedMoneyText(d.heldTokens)} ${uiText("held", v?.locale)}` : ""}`))}<p class="keyrow"><span><i class="sp-k sp-k--bar"></i >${t(v, "Settled")}</span><span><i class="sp-k sp-k--held"></i>${t(v, "Held for running jobs, released when they settle")}</span></p><details class="sp-provenance sp-daily-values"${days.some((d) => unknownCount(d) > 0 || d.settledFloor || d.settledEstimated || number(d.settledTokens) === null) ? html` open` : null}><summary>${t(v, "Daily values and coverage")}</summary>${ui.facts(
    days.map((d) => [
      d.date,
      html`${settledMoney(d, v?.locale)}${d.today ? html` ${t(v, "settled;")} ${usd(d.heldTokens)} ${t(v, "held")}` : ""}`,
    ]),
    { cols: 3 },
  )}</details>${note(t(v, "Past days show record cost only. ≥ marks a known minimum; ~ marks an estimate; ? means the cost is unknown. Unknown costs are not zero."))}${newerNote(p.spend?.newerSkipped)}`;
  return card(t(v, "Spend over time"), chart, null, t(v, "per day, against the daily cap"));
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
  const max = Math.max(0.001, ...rows.map((r) => number(r.cost?.usd) ?? 0));
  return card(
    t(v, title),
    html`<div class="sp-hbars">${rows.map((r) => html`<div class="sp-hb"><span class="sp-hb__l"><b>${label(r)}</b>${meta(r) ? html`<small>${meta(r)}</small>` : null}</span><svg class="sp-hb__bar" height="12" aria-hidden="true"><rect class="sp-hb__bed" width="100%" height="12" rx="6"></rect><rect class="sp-hb__fill" width="${Math.min(100, (100 * (number(r.cost?.usd) ?? 0)) / max)}%" height="12" rx="6"></rect></svg><b class="sp-hb__v">${moneyCost(r.cost, v.locale)}</b></div>`)}</div>${note(t(v, "Counts the runs in the selected spend window."))}`,
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
    (r) =>
      `${r.provider}; ${r.runs} ${t(v, r.runs === 1 ? "run" : "runs")}${r.cost?.class === "plan" ? ` ${t(v, "on plan:")}${r.cost.planId ?? t(v, "unknown")}` : ""}`,
  );
export const spendByProject = (v) =>
  costRows(v, "By project", fold(v)?.byProject, (r) => r.label ?? r.key);

export function spendSizes(v) {
  const s = payload(v).spend;
  const cap = number(s?.jobCapTokens);
  const bins = s?.histogram ?? [];
  const max = Math.max(1, ...bins.map((b) => b.runs));
  const n = Math.max(1, bins.length);
  return card(
    t(v, "Job sizes"),
    html`${
      cap > 0
        ? html`<svg class="sp-hist" height="180" role="img" aria-label="${t(v, "Cost per metered run, equal bins to the job cap")}"><line class="sp-base" x1="0" x2="100%" y1="142" y2="142"></line>${bins.map(
            (b, i) => {
              const h = (b.runs / max) * 105;
              return html`<g><title>${markedMoneyText(b.fromTokens, null, v.locale)} ${t(v, "to")} ${markedMoneyText(b.toTokens, null, v.locale)}: ${b.runs} ${t(v, b.runs === 1 ? "metered run" : "metered runs")}</title><rect class="sp-hbin" x="${((i + 0.12) / n) * 97}%" y="${142 - h}" width="${(0.76 / n) * 97}%" height="${h}" rx="4"></rect><text class="sp-v" x="${((i + 0.5) / n) * 97}%" y="${134 - h}" text-anchor="middle">${b.runs}</text></g>`;
            },
          )}<line class="sp-capline" x1="99%" x2="99%" y1="22" y2="142"></line><text class="sp-ll" x="98%" y="15" text-anchor="end">${t(v, "job cap")}</text>${[0, 1, 2, 3, 4].map((i) => html`<text class="sp-d" x="${i * 24.5}%" y="166" text-anchor="${i === 0 ? "start" : i === 4 ? "end" : "middle"}">${markedMoneyText((cap * i) / 4, null, v.locale)}</text>`)}</svg>${note(`${t(v, "Axis from zero to")} $${(cap / 1e6).toFixed(2)}; ${t(v, "equal bins; metered runs:")} ${s?.meteredRangeRuns ?? 0}.`)}`
        : note(t(v, "The per-job token budget could not be read."))
    }${note(t(v, "While a token window is set, every job reserves its per-job budget before it starts."))}<p class="sp-note">${t(v, "The largest run used")} <b>${usd(s?.largestRangeTokens, v.locale)}</b>; ${t(v, "a lower maxTokens would hold less headroom while jobs run.")}</p>${s?.overJobCapRuns ? note(`${s.overJobCapRuns} ${t(v, s.overJobCapRuns === 1 ? "historical run exceeded today's job cap and is included in the final bin." : "historical runs exceeded today's job cap and are included in the final bin.")}`) : null}`,
    v.role === "operator"
      ? ui.btn({
          label: t(v, "Change the job cap"),
          href: "/config#p-settings",
          icon: "config",
          kind: "sm",
        })
      : null,
    t(v, "cost per run"),
  );
}

function countWord(used, cap, hold = null) {
  if (number(used) === null || number(cap) === null) return "unknown";
  return { failed: "Full", attention: "Soft hold", ok: "Open" }[
    countStatus(used, cap, hold)
  ];
}
export function spendCaps(v) {
  const p = payload(v);
  const b = p.budget;
  if (!b)
    return empty(
      t(v, "Caps"),
      t(v, "The settings or counters could not be read. No cap usage can be claimed."),
    );
  const dollar = b.windows ?? {};
  const windows = Array.isArray(dollar.windows) ? dollar.windows : [];
  return card(
    t(v, "Caps"),
    html`<div class="sp-caps">${
      b.unreachable ||
      b.settingsInvalid ||
      dollar.settingsInvalid ||
      dollar.countersUnreachable ||
      dollar.invalid?.length ||
      dollar.limits?.invalid ||
      b.scopedInvalid
        ? note(
            t(v, "The settings file or counters could not be read; amounts marked unknown are not zero."),
          )
        : null
    }${["day", "week", "month"].map((key) =>
      b[key]?.cap
        ? capLine(
          `${t(v, "Jobs this")} ${t(v, key)}: ${t(v, countWord(b[key].reserved ?? b[key].spent ?? b[key].used, b[key].cap, b.softHoldPct))}`,
            b[key].reserved ?? b[key].spent ?? b[key].used,
            b[key].cap,
            false,
            b.softHoldPct,
            v.locale,
            countWord(b[key].reserved ?? b[key].spent ?? b[key].used, b[key].cap, b.softHoldPct),
          )
        : null,
    )}${
      b.tokens?.cap
        ? capLine(
            `${t(v, "Tokens today")}: ${t(v, number(b.tokens.spent) === null ? "unknown" : b.tokens.spent >= b.tokens.cap ? "Full" : "Open")}`,
            b.tokens.spent,
            b.tokens.cap,
            false,
            null,
            v.locale,
            number(b.tokens.spent) === null ? "unknown" : b.tokens.spent >= b.tokens.cap ? "Full" : "Open",
          )
        : null
    }${windows.map((d) =>
      capLine(
        `${pathLabel(v, d.name ?? d.ledger ?? "Deployment dollars")} ${t(v, d.window)} (${t(v, "spent and held")}): ${t(v, number(d.counterTokens) === null ? "unknown" : d.full ? "Full" : "Open")}`,
        d.counterTokens,
        d.capTokens,
        true,
        null,
        v.locale,
        number(d.counterTokens) === null ? "unknown" : d.full ? "Full" : "Open",
      ),
    )}${(b.scoped ?? []).map((r) =>
      ["day", "week", "month"].map((key) =>
        r[key]?.cap
          ? capLine(
              `${pathLabel(v, r.scope)} ${t(v, "jobs")} ${t(v, key)}: ${t(v, countWord(r[key].used, r[key].cap))}`,
              r[key].used,
              r[key].cap,
              false,
              null,
              v.locale,
              countWord(r[key].used, r[key].cap),
            )
          : null,
      ),
    )}</div><p class="keyrow sp-cap-key"><span><i class="k tone-ok"></i>${t(v, "Open")}</span><span><i class="k tone-attention"></i>${t(v, "From the job soft hold new starts are refused; nothing is spent.")}</span><span><i class="k tone-failed"></i>${t(v, "Full")}: ${t(v, "another job at its per-job cap would not fit.")}</span></p>${note(t(v, "The soft-hold tick applies to global job windows only. Scoped job windows, tokens and dollars have hard caps."))}`,
    v.role === "operator"
      ? ui.btn({
          label: t(v, "Edit caps"),
          href: "/config#p-settings",
          icon: "config",
          kind: "sm",
        })
      : null,
    t(v, "job soft-hold ticks only"),
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
    const r = result.runSet;
    const target = number(r.usd) === null ? null : r.usd * 1e6;
    const actual = number(r.originalUsd) === null ? null : r.originalUsd * 1e6;
    const scale = Math.max(1, target ?? 0, actual ?? 0);
    answer = html`<p class="sp-wi__s">${t(v, "The same runs on")} ${r.runs ?? 0} <b>${q.whatif}</b> ${t(v, "would use about")} <b>${usd(target, v.locale)}</b> ${t(v, "instead of")} <b>${usd(actual, v.locale)}</b>.</p><div class="sp-wi"><span class="sp-wi__l">${t(v, "Recorded tokens")}<small>${t(v, "the same ledgered runs")}</small></span>${progress(actual, scale, t(v, "What these ledgered runs used"), "idle")}<b>${usd(actual, v.locale)}</b><span class="sp-wi__l">${q.whatif}<small>${t(v, "estimate")}</small></span>${progress(target, scale, t(v, "The same runs' token profile on the selected model"))}<b>${t(v, "about")} ${usd(target, v.locale)}</b></div>${note(`${r.excluded ?? 0} ${t(v, "runs had no ledger and were excluded.")} ${r.planId ? `${t(v, "Plan")} ${r.planId}; ${t(v, "this run's recorded token total.")}` : ""}`)}${newerNote(r.newerSkipped)}`;
  } else if (result?.result) {
    const r = result.result;
    answer = html`${ui.facts([
      [
        t(v, "Per run"),
        r.class === "seeded"
          ? html`${usd(r.low * 1e6)} to ${usd(r.high * 1e6)} (seeded)`
          : usd(r.perRun * 1e6),
      ],
      [t(v, "Runs in this window"), r.windowRuns ?? 0],
      [
        t(v, "Window estimate"),
        r.class === "seeded"
          ? t(v, "Seeded range, no ledgered run yet")
          : usd(r.usd * 1e6),
      ],
      [
        t(v, "Ledger coverage"),
        typeof r.coverage === "number"
          ? `${Math.round(r.coverage * 100)}%`
          : "unknown",
      ],
      [t(v, "Runs excluded"), r.excluded ?? 0],
      [t(v, "Ledger writer (pi-ai)"), r.ratesVersion ?? "unknown"],
    ])}${note(
      t(v, "Per-run estimate, multiplied by the flow's runs in this spend window. Seeded ranges narrow after a ledgered run."),
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
        t(v, "An estimate from token counts and list prices. Outcomes may differ: a cheaper model can take more turns or fail more often."),
      )}`,
  );
}
export const spendWhatif = (v) => whatif(v, false);
export const breakdownWhatif = (v) => whatif(v, true);
export function spendPlans(v) {
  const f = normFold(payload(v).recent24h);
  return card(
    t(v, "Metered and plan"),
    html`${f ? html`<ul class="sp-mp">${f.byModel.map((r) => html`<li><span class="sp-mp__k">${t(v, r.cost?.class === "plan" ? "plan" : "metered")}</span><span class="sp-mp__t"><b>${r.model}</b><small>${r.provider}; ${r.runs} ${t(v, "runs in 24 hours,")} ${r.tokens.toLocaleString("en-US")} ${t(v, "tokens")}${payload(v).triggersByModel?.[`${r.provider}/${r.model}`]?.length ? ` (${payload(v).triggersByModel[`${r.provider}/${r.model}`].join(", ")})` : ""}. ${r.cost?.class === "plan" ? `${t(v, "Counted in plan:")}${r.cost.planId ?? t(v, "unknown")}, ${t(v, "not per run.")}` : ""}</small></span><b class="sp-mp__v">${moneyCost(r.cost, v.locale)}</b></li>`)}</ul>` : note(t(v, "No runs could be read for the last 24 hours."))}${note(t(v, "Plan runs are counted in the plan's own windows, not per run. Their recorded tokens are the fact; there is no API price to compare."))}`,
    null,
    t(v, "last 24 hours"),
  );
}

function envelopeForm(p) {
  const source = p?.envelope;
  if (!source) return null;
  return {
    ...source,
    ...source.delegation,
    totalTokens: source.totalTokens ?? source.totalTokens / 1e6,
    floorsTokens:
      source.floorsTokens ??
      Object.fromEntries(
        Object.entries(source.floors ?? {}).map(([id, n]) => [id, n / 1e6]),
      ),
  };
}
function allocation(v) {
  return normAllocation(payload(v).allocation);
}
export function spendSplit(v) {
  const p = payload(v).allocation;
  const a = allocation(v);
  const weights = allocationWeights(p);
  const total = weights.reduce((n, [, weight]) => n + weight, 0);
  let x = 0;
  const shares = new Map(
    weights.map(([id, weight]) => [
      id,
      total > 0 ? (weight / total) * 100 : null,
    ]),
  );
  return card(
    t(v, "Budget split"),
    html`${
      a?.kind === "live"
        ? html`${
            total > 0
              ? html`<svg class="sp-split" height="34" role="img" aria-label="${t(v, "Allocation weight shares")}">${weights.map(
                  ([id, weight], i) => {
                    const width = (weight / total) * 100;
                    const at = x;
                    x += width;
                    return html`<g><title>${id}: ${Math.round(width)}% share</title><rect class="${i % 2 ? "sp-seg sp-seg--1" : "sp-seg sp-seg--0"}" x="${at}%" y="0" width="${width}%" height="34" rx="10"></rect>${width >= 15 ? html`<text class="sp-seg__t" x="${at}%" dx="10" y="22">${id} ${Math.round(width)}%</text>` : null}</g>`;
                  },
                )}</svg>`
              : note(
                  weights.length
                    ? t(v, "All published weights are zero; there are no proportional shares.")
                    : t(v, "The split's weights were not published; shares are unknown."),
                )
          }${note(`${t(v, "Weights only: it never changes a cap. Written by")} ${p?.state?.triggerId ?? a.state?.writer ?? t(v, "not known")}, ${t(v, "writer")} ${a.state?.writer ?? t(v, "unknown")}, ${t(v, "on")} ${p?.state?.model ?? t(v, "a model not recorded")}.`)}${when(a.state?.appliedAt)}<div class="sp-rows">${a.rows.filter((r) => !v.query?.project || v.query.project === r.id).map((r) => { const share = shares.get(r.id); const label = share == null ? weights.length && total === 0 ? t(v, "no proportional") : t(v, "unknown") : `${Math.round(share)}% ${t(v, "share")}`; return capLine(`${r.id}, ${label}`, r.spent, r.allocation, true, null, v.locale); })}</div>`
        : note(t(v, "No budget split is available."))
    }<a class="btn btn--sm" href="${link(v, "/insights/budget-split")}">${t(v, "Open Budget split")}</a>`,
    null,
    a?.window ?? null,
  );
}

export function splitEnvelopeKpi(v) {
  const a = allocation(v);
  return kpi(
    t(v, "Envelope"),
    usd(a?.totalTokens),
    `${a?.window ?? t(v, "unknown window")}. ${t(v, "Delegation")} ${a?.delegation ? t(v, "on") : t(v, "off")}. ${t(v, "Writers:")} ${(payload(v).allocation?.envelope?.delegation?.writers ?? []).join(", ") || t(v, "none")}.`,
  );
}
export function splitAllocatedKpi(v) {
  const a = allocation(v);
  return kpi(
    t(v, "Allocated"),
    usd(a?.rows?.reduce((sum, r) => sum + (r.allocation ?? 0), 0)),
    `${a?.rows?.length ?? 0} ${t(v, "projects")}; ${t(v, "Unallocated")} ${a?.state?.unallocated === undefined ? t(v, "unknown") : `$${(a.state.unallocated / 1e6).toFixed(2)}`}. ${t(v, "Floor total")} $${((a?.rows ?? []).reduce((sum, row) => sum + (row.floor ?? 0), 0) / 1e6).toFixed(2)}; ${t(v, "floors come first.")}`,
  );
}
export function splitSpentKpi(v) {
  const a = allocation(v);
  return card(
    t(v, "Spent this envelope window"),
    html`${ui.kpi(usd(a?.deploymentSpent), html`${t(v, "of")} ${usd(a?.totalTokens)}`)}${progress(a?.deploymentSpent, a?.totalTokens, t(v, "Spent and held against the allocation envelope"))}<p class="sx-k">${a?.rows?.filter(overAllocation).length ?? 0} ${t(v, "projects over allocation. Includes held money.")}</p>`,
  );
}
export function splitPlanKpi(v) {
  const a = allocation(v);
  const until = Date.parse(payload(v).allocation?.state?.validUntil ?? "");
  const hours =
    Number.isFinite(until) && Number.isFinite(v.now)
      ? Math.max(0, Math.ceil((until - v.now) / 3_600_000))
      : null;
  const duration =
    hours === null
      ? t(v, "unknown")
      : hours >= 48
      ? `${Math.ceil(hours / 24)} ${t(v, "days")}`
        : `${hours} ${t(v, "hours")}`;
  return card(
    t(v, "Plan in force"),
    html`${ui.kpi(a?.state ? duration : t(v, "No split yet"), a?.state ? t(v, "left") : null)}<p class="sx-k">${t(v, "Applied")} ${when(a?.state?.appliedAt)} ${t(v, "by")} <span class="code">${payload(v).allocation?.state?.triggerId ?? a?.state?.writer ?? "unknown"}</span>, ${t(v, "until")} ${when(a?.state?.validUntil)}.</p>${hours === null ? note(t(v, "No plan expiry recorded.")) : null}`,
    a?.state
      ? statusBadge(
          hours === 0 ? "attention" : "ok",
          hours === 0 ? t(v, "Expired") : t(v, "Applied"),
        )
      : null,
  );
}

export function splitRows(v) {
  const a = allocation(v);
  const p = payload(v).allocation;
  if (a?.kind !== "live")
    return empty(
      t(v, "Budget split"),
      t(v, "No split can be drawn until the envelope and queue can be read."),
    );
  const hosts = p.hosts ?? payload(v).hosts ?? [];
  return card(
    t(v, "Budget split"),
    html`<p class="al-env">${ui.icon("pie")}<span><b>${usd(a.totalTokens)} per ${a.window ?? t(v, "unknown window")}</b>, ${t(v, "delegation")} ${a.delegation ? t(v, "on") : t(v, "off")}</span><span class="al-env__h">${t(v, "Unallocated")} <b>${usd(a.state?.unallocated)}</b>; ${t(v, "deployment spent")} <b>${usd(a.deploymentSpent)}</b></span></p>${ui.facts(
      [
        [t(v, "Plan"), html`<span class="code">${a.state?.planId ?? t(v, "none")}</span>`],
        [
          t(v, "Written by"),
          html`<span class="code">${a.state?.writer ?? t(v, "unknown")}</span>${p.state?.triggerId ? html`, ${t(v, "the")} ${p.state.triggerId} ${t(v, "run")}` : null}`,
        ],
        [t(v, "Applied"), when(a.state?.appliedAt)],
        [t(v, "Valid until"), when(a.state?.validUntil)],
        [
          t(v, "Step"),
          a.state?.clamped
            ? t(v, "Clamped by the envelope's step")
            : t(v, "No step clamp recorded"),
        ],
        [
          t(v, "Envelope"),
          hosts.length &&
          p.digest &&
          hosts.every((h) => h.fpEnvelope === p.digest)
            ? statusBadge("ok", t(v, "All hosts agree"))
            : statusBadge("attention", t(v, "Not confirmed")),
        ],
      ],
    )}${hosts.some((h) => h.fpEnvelope !== p.digest || !h.fpEnvelope) ? note(hosts.map((h) => `${h.name}: ${!h.fpEnvelope ? t(v, "Envelope digest not published") : h.fpEnvelope !== p.digest ? t(v, "Different envelope") : t(v, "Same envelope")}`).join("; ")) : null}
      <ul class="al-rows">
        ${a.rows
          .filter((r) => !v.query?.project || r.id === v.query.project)
          .map((r) => {
            const max = Math.max(
              1,
              ...a.rows.map((x) =>
                Math.max(x.allocation ?? 0, x.spent ?? 0, x.floor ?? 0),
              ),
            );
            const scale = (x) => (100 * (number(x) ?? 0)) / max;
            return html`<li class="al-row">
              <span class="al-row__l"
                >${r.id}<small
                  >${t(v, "weight")} ${p.state?.weights?.[r.id] ?? t(v, "unknown")}</small
                ></span
              ><svg
                class="al-bar"
                height="22"
                role="img"
                aria-label="${r.id}: ${t(v, "spent")} ${
                  r.spent === null ? t(v, "unknown") : r.spent / 1e6
                } USD; ${t(v, "allocation")} ${
                  r.allocation === null ? t(v, "unknown") : r.allocation / 1e6
                } USD; ${t(v, "floor")} ${(r.floor ?? 0) / 1e6} USD"
              >
                <rect
                  class="al-bar__track"
                  x="0"
                  y="3"
                  width="100%"
                  height="16"
                  rx="8"
                ></rect>
                <rect
                  class="al-bar__alloc"
                  x="0"
                  y="3"
                  width="${scale(r.allocation)}%"
                  height="16"
                  rx="8"
                ></rect>
                <rect
                  class="${
                    overAllocation(r)
                      ? "al-bar__spent al-bar__spent--over"
                      : "al-bar__spent"
                  }"
                  x="0"
                  y="3"
                  width="${scale(r.spent)}%"
                  height="16"
                  rx="8"
                ></rect>
                <line
                  class="al-bar__floor"
                  x1="${scale(r.floor)}%"
                  x2="${scale(r.floor)}%"
                  y1="0"
                  y2="22"
                ></line></svg
              ><span class="al-row__v"
                ><span>${usd(r.spent, v.locale)} ${t(v, "spent of")} ${usd(r.allocation, v.locale)}</span
                ><small
                  >${t(v, "Floor")} ${usd(r.floor, v.locale)}
                  ${
                    overAllocation(r)
                      ? html`${ui.icon("failed")} ${t(v, "over")}`
                      : null
                  }</small
                ></span
              >
            </li>`;
          })}
      </ul>
      <p class="keyrow"><span><i class="al-k al-k--alloc"></i>${t(v, "Allocation")}</span><span><i class="al-k al-k--spent"></i>${t(v, "Spend, held included")}</span><span><i class="al-k al-k--floor"></i>${t(v, "Floor")}</span><span><i class="al-k al-k--over"></i>${t(v, "Over the allocation")}</span></p>
      ${note(
        t(v, "A project may use up to the smaller of its allocation and its own scoped limit. allocation-cap means the split refused it; token-cap means the operator's own limit refused it."),
      )}`,
    canAct(v)
      ? ui.btn({
          label: t(v, "Set priorities"),
          href: "#p-priorities",
          icon: "edit",
          kind: "primary",
        })
      : null,
    "this envelope window, every host",
  );
}
export function splitHistory(v) {
  const p = payload(v).allocation;
  const rows = p?.log ?? [];
  return card(
    t(v, "History"),
    rows.length
      ? html`<div class="tbl-wrap">
          <table class="tbl">
            <thead>
              <tr>
                <th>${t(v, "Row")}</th>
                <th>${t(v, "When (UTC)")}</th>
                <th>${t(v, "Writer")}</th>
                <th>${t(v, "Outcome")}</th><th>${t(v, "Reason")}</th>
                <th>${t(v, "Plan")}</th>
                ${
                  new Set(rows.map((r) => r.host).filter(Boolean)).size > 1
                    ? html`<th>${t(v, "Host")}</th>`
                    : null
                }${canAct(v) ? html`<th>${t(v, "Action")}</th>` : null}
              </tr>
            </thead>
            <tbody>
              ${rows.slice(0, 20).map((r, i) => {
                const applied = rows.findIndex(
                  (other) =>
                    other.planId &&
                    other.planId === r.planId &&
                    ["applied", "reverted", "rebased"].includes(other.outcome),
                );
                const neutralCurrent =
                  p.state &&
                  p.state.planId == null &&
                  p.state.appliedAt != null &&
                  r.at === p.state.appliedAt &&
                  r.writer === p.state.writer &&
                  r.weights &&
                  !["duplicate", "refused"].includes(r.outcome);
                const currentPlanRow = p.state?.planId
                  ? rows.findIndex(
                      (other) =>
                        other.planId === p.state.planId &&
                        ["applied", "reverted", "rebased"].includes(
                          other.outcome,
                        ) &&
                        (p.state.appliedAt == null ||
                          (other.at === p.state.appliedAt &&
                            other.writer === p.state.writer)),
                    )
                  : -1;
                const current = neutralCurrent || currentPlanRow === i;
                // Expiry keeps the old plan id but writes neutral weights; equal ids alone cannot identify a duplicate.
                const historyFact = current
                  ? t(v, "In force")
                  : r.outcome === "duplicate"
                    ? applied >= 0
                      ? `${t(v, "Same as row")} ${applied + 1}`
                      : t(v, "Duplicate plan; its applied row is outside the newest 20 rows")
                    : !r.weights
                      ? t(v, "No split to go back to")
                      : null;
                return html`<tr>
                  <td>${i + 1}</td>
                  <td>${when(r.at)}</td>
                  <td>${r.writer}</td>
                  <td>
                    ${statusBadge(r.outcome === "applied" ? "ok" : r.outcome === "refused" ? "refused" : "idle", r.outcome ?? "unknown")}
                  </td><td>${r.reason ?? "none"}${
                    r.reason
                      ? html`:
                        ${
                          PLAN_REASON_TEXT[r.reason]?.sentence ? t(v, PLAN_REASON_TEXT[r.reason].sentence) :
                          t(v, "A newer worker recorded this reason; check its version and plan rules.")
                        }`
                      : null
                  }
                  </td>
                  <td>
                    ${neutralCurrent ? t(v, "Today's neutral split") : (r.planId ?? (r.weights ? t(v, "Today's neutral split") : null))}
                    ${historyFact === t(v, "In force") ? statusBadge("ok", historyFact) : historyFact ? note(historyFact) : null}
                  </td>
                  ${
                    new Set(rows.map((x) => x.host).filter(Boolean)).size > 1
                      ? html`<td>${r.host ?? "unknown"}</td>`
                      : null
                  }${
                    canAct(v)
                      ? html`<td>
                        ${
                          historyFact
                            ? null
                            : html`<form data-action="allocation-revert">
                                  <input
                                    type="hidden"
                                    name="index"
                                    data-type="int"
                                    value="${i}"
                                  /><button class="btn btn--sm" type="submit">
                                    ${t(v, "Revert row")} ${i + 1}
                                  </button>
                                </form>`
                        }
                      </td>`
                      : null
                  }
                </tr>`;
              })}
            </tbody>
          </table>
        </div>`
      : note(
          t(v, "No allocation history has been read. The newest 20 rows from every host are shown when available (the log keeps 500)."),
        ),
  );
}
export function splitPriorities(v) {
  if (!canAct(v)) return html``;
  const p = payload(v).allocation;
  const env = envelopeForm(p);
  if (!env)
    return empty(
      t(v, "Set priorities"),
      t(v, "Read a valid envelope before setting priorities."),
    );
  const ids = Object.keys(env.floorsTokens ?? {});
  const weights = p.state?.weights ?? env.defaultWeights ?? {};
  const total = Math.max(
    1,
    Object.values(weights).reduce((sum, value) => sum + value, 0),
  );
  return card(
    t(v, "Set priorities"),
    html`<form data-action="priorities-set" data-structured="priorities"><div class="pr-grid">${ids.map((id) => html`<label class="pr-row"><span class="ptag">${id}</span><span class="sr">${t(v, "Weight for")} ${id}</span><input class="input pr-in" type="number" name="weight:${id}" min="0" max="1000" step="1" required value="${weights[id] ?? 0}"><output class="pr-share" data-weight-share="${id}" >${t(v, "about")} ${Math.round(((weights[id] ?? 0) / total) * 100)}%</output></label>`)}</div><div class="formrow pr-foot"><label class="field" >${t(v, "Days this plan holds")}<input class="input pr-in" type="number" name="validDays" data-type="int" min="1" max="${env.maxPlanDays ?? 7}" value="${env.maxPlanDays ?? 7}" required><small class="field__hint">${t(v, "At most")} ${env.maxPlanDays ?? 7}, ${t(v, "the envelope's limit.")}</small></label><button class="btn btn--primary" type="submit">${t(v, "Preview the plan")}</button></div></form>${note(t(v, "Writer operator-session. Weights are whole numbers from 0 to 1000. Floors come first, the rest is split by weight, and a change moves each share by at most the envelope's step."))}`,
    null,
    "a plan of weights, previewed first",
  );
}

export function splitEnvelope(v) {
  const p = payload(v).allocation;
  const e = envelopeForm(p);
  if (!e)
    return empty(
      t(v, "Envelope"),
      t(v, "The envelope is missing or could not be read. Check PI_ENVELOPE_FILE."),
    );
  return card(
    t(v, "Envelope"),
    html`${ui.facts(
      [
        [t(v, "Window"), t(v, e.window)],
        [t(v, "Total"), `$${e.totalTokens ?? t(v, "unknown")}`],
        [[t(v, "Delegation"), e.enabled ? t(v, "On") : t(v, "Off")]],
        [t(v, "Writers"), (e.writers ?? []).join(", ")],
        [t(v, "Step"), `${e.maxStepPct}%`],
        [t(v, "Minimum interval"), `${e.minIntervalHours} ${t(v, "hours")}`],
        [t(v, "Longest plan"), `${e.maxPlanDays} ${t(v, "days")}`],
        [
          t(v, "Floors"),
          Object.entries(e.floorsTokens ?? {})
            .map(([id, n]) => `${id}: $${n}`)
            .join(", "),
        ],
        [
          t(v, "Default weights"),
          Object.entries(e.defaultWeights ?? {})
            .map(([id, n]) => `${id}: ${n}`)
            .join(", "),
        ],
        [t(v, "File"), pathLabel(v, p.file ?? p.path ?? "PI_ENVELOPE_FILE")],
        ...(p.hosts ?? payload(v).hosts ?? []).map((h) => [
          `${t(v, "Envelope digest")}, ${h.name}`,
          h.fpEnvelope ?? "not published",
        ]),
      ],
      { cols: 1 },
    )}${
      canAct(v)
        ? html`<details>
          <summary>${t(v, "Edit envelope")}</summary>
          <form
            id="envelope-form" data-action="envelope-set"
            data-structured="envelope"
            class="spend-fields"
          >
            <label
               >${t(v, "Window")}<select name="window">
                ${["day", "week", "month"].map(
                  (w) =>
                    html`<option
                      value="${w}"
                      ${e.window === w ? html` selected` : null}
                    >
                      ${t(v, w)}
                    </option>`,
                )}
              </select></label
            ><label
               >${t(v, "Total USD")}<input
                type="number"
                name="totalTokens"
                min="0"
                step="0.000001"
                required
                value="${e.totalTokens}" /></label
            >${Object.entries(e.floorsTokens ?? {}).map(
              ([id, amount]) =>
                html`<label
                      >${id} ${t(v, "floor USD")}<input
                      type="number"
                      name="floor:${id}"
                      min="0"
                      step="0.000001"
                      value="${amount}"
                      required /></label
                  ><label
                    >${id} ${t(v, "default weight")}<input
                      type="number"
                      name="weight:${id}"
                      min="0"
                      max="1000"
                      step="1"
                      value="${e.defaultWeights?.[id] ?? 0}"
                      required
                  /></label>`,
            )}<label
              ><input
                type="checkbox"
                name="enabled"
                ${e.enabled ? html` checked` : null}
              />${t(v, "Delegation enabled")}</label
            ><label
               >${t(v, "Writers")}<input
                name="writers"
                data-type="list"
                value="${(e.writers ?? []).join(", ")}" /></label
            >${[
              ["maxStepPct", "Maximum step percent"],
              ["minIntervalHours", "Minimum interval hours"],
              ["maxPlanDays", "Longest plan days"],
            ].map(
              ([key, label]) =>
                html`<label
                  >${t(v, label)}<input
                    type="number"
                    name="${key}"
                    data-type="int"
                    min="0"
                    value="${e[key]}"
                    required
                /></label>`,
            )}<button class="btn btn--primary" type="submit">
              ${t(v, "Preview envelope")}
            </button>
          </form>
        </details>`
        : null
    }`,
    canAct(v)
      ? ui.btn({
          label: t(v, "Edit envelope"),
          href: "#envelope-form",
          icon: "config",
          kind: "sm",
        })
      : null,
  );
}
export function splitReasons(v) {
  if (v.role !== "operator") return html``;
  const reasons = payload(v).allocation?.state?.reasons;
  return card(
    t(v, "Why the plan says so"),
    reasons && Object.keys(reasons).length
      ? html`${note(t(v, "Written by the portfolio job."))}<ul class="rs-l">${Object.entries(reasons).map(([id, text]) => html`<li><span class="ptag">${id}</span><q>${escapeInterpreted(String(text))}</q></li>`)}</ul>`
      : note(t(v, "No project reasons were recorded for this plan.")),
    null,
    "operators only",
  );
}
export function splitCounts(v) {
  const a = allocation(v);
  const refusals = [
    "allocation-cap",
    "envelope-mismatch",
    "portfolio-no-envelope",
    "portfolio-snapshot-oversize",
  ];
  const rows = (items) =>
    html`<ul class="cn-l">${items.map(([name, value]) => html`<li><span class="code">${name}</span><b>${value}</b></li>`)}</ul>`;
  return card(
    t(v, "Refusals and plans"),
    html`${note(t(v, "Counted in this host's run records over the envelope's window."))}${a?.refusals === null || a?.refusals === undefined ? note(t(v, "Refusals and plans were not counted: the run records could not be read.")) : html`<p class="cn-h">${ui.icon("refused", { size: "sm" })}${t(v, "Refusals in runs on this host")}</p>${rows(refusals.map((name) => [name, a.refusals[name] ?? 0]))}<p class="cn-h">${ui.icon("done", { size: "sm" })}${t(v, "Plans collected in runs on this host")}</p>${rows(["applied", "duplicate", "refused"].map((name) => [name, a.plans?.[name] ?? 0]))}${!a.plans || Object.keys(a.plans).length === 0 ? note(t(v, "No plans collected in this envelope window.")) : null}`}`,
    null,
    "from run records",
  );
}
export function splitStates(v) {
  const a = allocation(v);
  const state =
    a?.kind === "unset"
      ? [
          "idle",
          "No envelope",
          "No envelope: set an envelope before splitting a budget. PI_ENVELOPE_FILE is unset, so delegation is off.",
        ]
      : a?.kind === "problem"
        ? [
            "failed",
            "The envelope does not load",
            "The envelope does not load. Check its fields in Configuration.",
          ]
        : a?.kind === "unreachable"
          ? [
              "failed",
              "The split could not be read",
              "The queue is not answering. The last split cannot be read. Nothing was changed.",
            ]
          : a?.stateProblem
            ? [
                "attention",
                "Written by a newer pi-dispatch",
                `Split not usable: ${a.stateProblem}. Upgrade this console if the split is newer.`,
              ]
            : a?.mismatch
              ? [
                  "failed",
                  "The split was made for another envelope",
                  "Another envelope is in force: hosts need the same envelope. Governed jobs refuse as envelope-mismatch.",
                ]
              : a?.outsideEdit
                ? [
                    "attention",
                    "The envelope changed outside the console",
                    "The split was edited outside the plan writer. A host with another envelope refuses governed jobs as envelope-mismatch.",
                  ]
                : !a?.state
                  ? [
                      "idle",
                      "No split applied yet",
                      "No split yet: the next pickup can write the neutral split.",
                    ]
                  : null;
  return card(
    t(v, "Other states"),
    state
      ? ui.banner({
          status: state[0],
          title: t(v, state[1]),
          body: t(v, state[2]),
          sm: true,
        })
      : ui.collapsed({
          icon: "done",
          title: t(v, "Envelope and split read"),
          body: t(v, "No exceptional split state was reported."),
        }),
    null,
    t(v, "what this view says instead"),
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
    0.001,
    ...top.flatMap((r) => r.days.map((d) => number(d.cost?.usd) ?? 0)),
  );
  const rest = series
    .slice(4)
    .reduce(
      (total, r) =>
        total + r.days.reduce((n, d) => n + (number(d.cost?.usd) ?? 0), 0),
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
                    (n, d) => n + (number(d.cost?.usd) ?? 0) * 1e6,
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
                const h = ((number(d.cost?.usd) ?? 0) / max) * 24;
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
        `${t(v, "Top four flows share a $0 to $")}${max.toFixed(2)}${t(v, " daily scale. The rest add up to $")}${rest.toFixed(2)}.`,
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
    t(v, "How money is shown"),
    note(
      t(v, "Metered: pi-ai list prices. Estimated (~): partial evidence. Plan: plan:<id>, with API equivalent shown separately. Zero-rated: no charge. Unknown: not priceable. Floor (≥): at least this much. Seeded: a wide range until a ledgered run exists."),
    ),
  );
export function breakdownProvenance(v) {
  const f = fold(v);
  return card(
    t(v, "Where these numbers come from"),
    html`${note(
      t(v, "Metered means pi-ai prices, not invoices. Money held for running jobs is not in run records yet; the Spend view shows it."),
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
    ["week", spendWeek],
    ["today", spendToday],
    ["tokens", spendTokens],
    ["avg", spendAverage],
    ["over", spendOver],
    ["byflow", spendByFlow],
    ["bymodel", spendByModel],
    ["byproject", spendByProject],
    ["sizes", spendSizes],
    ["caps", spendCaps],
    ["whatif", spendWhatif],
    ["plan", spendPlans],
    ["split", spendSplit],
  ]),
  "insights-budget-split": panels([
    ["env-kpi", splitEnvelopeKpi],
    ["alloc-kpi", splitAllocatedKpi],
    ["spent-kpi", splitSpentKpi],
    ["plan-kpi", splitPlanKpi],
    ["split", splitRows],
    ["split-history", splitHistory],
    ["priorities", splitPriorities],
    ["envelope", splitEnvelope],
    ["plan-reasons", splitReasons],
    ["split-counts", splitCounts],
    ["split-states", splitStates],
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
    { cls: "cards-4", items: ["p-week", "p-today", "p-tokens", "p-avg"] },
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
            "p-split",
          ],
        },
        { cls: "stack spend-side", items: ["p-caps", "p-whatif", "p-plan"] },
      ],
    },
  ],
  "insights-budget-split": layout(
    ["env-kpi", "alloc-kpi", "spent-kpi", "plan-kpi"],
    ["split", "split-history", "priorities"],
    ["envelope", "plan-reasons", "split-counts", "split-states"],
  ),
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
