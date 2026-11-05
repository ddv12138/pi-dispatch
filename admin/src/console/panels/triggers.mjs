/** Read-only rule discovery and hypothetical matching, using the published Triggers cards (#750). */
import {
  CHECK_EVENTS,
  CHECK_ACTORS,
  CHECK_PR_AUTHORS,
  CHECK_REVIEW_BODIES,
  CHECK_REVIEW_STATES,
  CHECK_PR_ACTIONS,
  CHECK_LIMITS,
} from "../../trigger-check.mjs";
import { TRIGGER_LIST_KINDS } from "../../trigger-list.mjs";
import { triggerWhoMayFire } from "../../trigger-policy.mjs";
import { fmtAmount } from "../../panel.mjs";
import { outcomeWord, recordReason, reasonWords } from "../../words.mjs";
import { html as escapedHtml } from "../html.mjs";
import * as ui from "../kit.mjs";
import { uiText } from "../locale.mjs";
import { timeHtml, ageText, shownPath, runLink } from "./common.mjs";
const html = (strings, ...values) =>
  escapedHtml(
    strings.map((s) => s.replace(/[ \t]*\n[ \t]*/g, "\n")),
    ...values,
  );
const DAY = 86_400_000;
const KIND = Object.freeze({
  cron: ["clock", "Schedule"],
  label: ["tag", "Label"],
  comment: ["comment", "Comment"],
  pull_request: ["pr", "Pull request"],
  issue: ["issue", "Issue closed"],
});
const CHIP = Object.freeze({
  "costs-more": ["attention", "spend", "Costs more"],
  reaches: ["attention", "globe", "Reaches"],
  writes: ["attention", "edit", "Writes"],
  asks: ["parked", "parked", "Asks"],
  narrows: ["running", "fit", "Narrows"],
  spent: ["idle", "done", "Spent"],
});
const GROUP = Object.freeze({
  schedule: "On a schedule",
  github: "From GitHub",
  gitlab: "From GitLab",
  forgejo: "From Forgejo",
  azure: "From Azure DevOps",
  unknown: "Other rules",
});
const FILTER = Object.freeze({
  all: "All",
  schedule: "Schedules",
  label: "Labels",
  comment: "Comments",
  pull_request: "Pull requests",
  issue: "Issues",
});
const card = (title, body, options = {}) =>
  ui.card({ title, body, ...options });
const modelOf = (v) => v.data?.triggerList ?? null;
const ruleHref = (v, index) =>
  ui.pageHref(v.pages, "trigger", { index }) ??
  `/config/trigger?index=${index}`;
const rowsOf = (v) => {
  const rows = modelOf(v)?.rows ?? [];
  const kind = v.query?.kind ?? "all";
  return kind === "all"
    ? rows
    : rows.filter(
        (r) => r.trigger.type === (kind === "schedule" ? "cron" : kind),
      );
};
const countText = (number, incomplete = false) =>
  number == null || (number === 0 && incomplete)
    ? "unknown"
    : `${incomplete ? "at least " : ""}${number}`;
const costText = (stats) =>
  stats?.weekCost && !(stats.incomplete && stats.weekRuns === 0)
    ? `${fmtAmount(stats.weekCost)}${stats.incomplete || stats.costIncomplete ? " (retained or partially metered history)" : ""}`
    : "unknown spend";
const atOf = (r) => Date.parse(r?.endedAt ?? r?.startedAt ?? "");
const shortList = (values) =>
  Array.isArray(values) && values.length ? values.join(", ") : "none";

export function triggersDescription(v) {
  return v.role === "viewer"
    ? uiText("What starts a job, in plain words. Rules from the triggers file.", v.locale)
    : `${uiText("What starts a job, in plain words. Rules in", v.locale)} ${v.data?.configLocations?.triggers ?? uiText("the triggers file", v.locale)}.`;
}
export function triggersNavigation(v) {
  const counts = modelOf(v)?.counts;
  return html`<nav class="tabs tr-tabs" aria-label="Triggers views">
    <a
      href="/triggers"
      aria-current="${v.page === "trigger-check" ? "false" : "page"}"
      >${ui.icon("runs", { size: "sm" })}${uiText("Rules", v.locale)}
      <span class="count">${counts?.all ?? "?"}</span></a
    ><a href="${ui.pageHref(v.pages, "watch") ?? "/watch"}"
      >${ui.icon("eye", { size: "sm" })}${uiText("Watch", v.locale)}
      <span class="count">${counts?.watch ?? "?"}</span></a
    ><span class="tr-tab-unavailable" aria-disabled="true"
      >${ui.icon("flows", { size: "sm" })}${uiText("Dispatchers", v.locale)}
      <span class="count">${uiText("proposed", v.locale)}</span></span
    >
  </nav>`;
}
export function triggersViewer(v) {
  return v.role === "viewer"
    ? html`<p class="collapsed tr-viewer">
        ${ui.icon("eye", { size: "sm" })}<b>${uiText("Viewer.", v.locale)}</b> ${uiText("You can read every rule and check a hypothetical event. Adding and changing rules is for operators.", v.locale)}
      </p>`
    : v.readOnly
      ? html`<p class="collapsed tr-viewer">
          ${ui.icon("shield", { size: "sm" })}${uiText("Changes are off. The event checker only reads and remains available.", v.locale)}
        </p>`
      : html``;
}
export function triggersCount(v) {
  const m = modelOf(v),
    c = m?.counts;
  return card(
    uiText("Set up", v.locale),
    html`${ui.kpi(c?.all ?? "?", "rules")}
      <p class="tr-kp">
        ${c?.schedule ?? "?"} ${uiText("on a schedule", v.locale)},
        ${c?.all == null || c?.schedule == null ? "?" : c.all - c.schedule} ${uiText("from forges", v.locale)}; ${c?.spent ?? "?"} ${uiText("spent one-shots", v.locale)}.
      </p>
      ${(m?.problems ?? []).map(
        (p) =>
          html`<p class="tr-problem">
            ${ui.icon("attention", { size: "sm" })}${p}
          </p>`,
      )}`,
  );
}
export function triggersNext(v) {
  const m = modelOf(v),
    n = m?.next;
  return card(
    uiText("Next to fire", v.locale),
    n
      ? html`${ui.kpi(ageText(n.at - m.now), `until ${n.id}`)}
          <p class="tr-kp">
            ${timeHtml(n.at)} ·
            <a href="${ruleHref(v, n.index)}">row ${n.index + 1}</a>
          </p>`
      : html`<p class="tr-empty">
          ${uiText("No next fire is published. Check the schedule's owning worker and its doctor result.", v.locale)}
        </p>`,
  );
}
export function triggersSpend(v) {
  const m = modelOf(v);
  return card(
    uiText("Recorded this UTC week", v.locale),
    html`${ui.kpi(
        m?.stats?.weekCost && !(m.stats.incomplete && m.stats.weekRuns === 0)
          ? fmtAmount(m.stats.weekCost)
          : "unknown",
        uiText("attributed to these rules", v.locale),
      )}
      <p class="tr-kp">
        ${countText(m?.stats?.weekRuns, m?.stats?.incomplete)} ${m?.stats?.weekRuns === 1 ? "run record" : "run records"} since
        ${m?.weekStart == null
          ? "the start of this UTC week"
          : timeHtml(m.weekStart)}.
        ${m?.stats?.incomplete || m?.stats?.costIncomplete
          ? "Coverage is retained or partially metered history. "
          : ""}Shared
        flows alone never attribute a run.
      </p>`,
  );
}
export function triggersFilters(v) {
  const c = modelOf(v)?.counts;
  return html`<nav class="tr-filters" aria-label="Show rules">
    ${TRIGGER_LIST_KINDS.map((kind) =>
      ui.fpill({
        label: uiText(FILTER[kind], v.locale),
        count: typeof c?.[kind] === "number" ? c[kind] : null,
        href: kind === "all" ? "/triggers" : `/triggers?kind=${kind}`,
        on: (v.query?.kind ?? "all") === kind,
      }),
    )}
  </nav>`;
}
function labelPredicate(t, locale = "en") {
  const clauses = [
    t.any?.length
      ? html`${uiText("any of", locale)} <span class="code">${shortList(t.any)}</span>`
      : null,
    t.all?.length
      ? html`${uiText("all of", locale)} <span class="code">${shortList(t.all)}</span>`
      : null,
    t.none?.length
      ? html`${uiText("none of", locale)} <span class="code">${shortList(t.none)}</span>`
      : null,
  ].filter(Boolean);
  return html`${clauses.map((clause, i) => html`${i ? uiText(" and ", locale) : ""}${clause}`)}`;
}
function whenOf(t, locale = "en") {
  if (t.type === "cron")
    return html`${uiText("Schedule", locale)}
      <span class="code">${t.pattern ?? "unknown pattern"}</span>`;
  if (t.type === "comment")
    return html`${uiText("A comment contains", locale)}
      <span class="code">${t.phrase ?? "an unavailable phrase"}</span>`;
  if (t.type === "label")
    return html`${uiText("An issue has labels matching", locale)} ${labelPredicate(t, locale)}`;
  return html`${uiText(t.type === "issue" ? "An issue" : "A pull request", locale)}${t.number
      ? html` <span class="code">#${t.number}</span>`
      : null}
    ${uiText("has action", locale)} <span class="code">${shortList(t.action)}</span>${t.reviewState
      ?.length
      ? html`, ${uiText("verdict", locale)} <span class="code">${shortList(t.reviewState)}</span>`
      : null}${t.any?.length || t.all?.length || t.none?.length
      ? html`, ${uiText("with labels on labeled deliveries matching", locale)} ${labelPredicate(t, locale)}`
      : null}`;
}
function goodToKnow(t, locale = "en") {
  if (t.disarmed)
    return uiText("This one-shot matches nothing now. Remove on.disarmed in the triggers file to arm it again; keeping the row preserves its history number.", locale);
  if (t.type === "comment")
    return uiText("A comment can select another declared flow. It still uses this comment rule's options and reviewed constraints.", locale);
  if (t.forge === "github" && t.type === "label")
    return uiText("GitHub matches the issue's whole label set. Re-labelling or reopening can start another paid run, including each configured replica.", locale);
  if (t.forge === "gitlab" && t.type === "pull_request")
    return uiText("On GitLab, changing labels counts as an update. A merge does not fire a close rule.", locale);
  if (t.forge === "azure" && t.type === "pull_request")
    return uiText("Azure pull request actions use created or updated. Pull request labels and close-only actions are not available.", locale);
  return null;
}
function ruleRow(v, r) {
  const t = r.trigger,
    [glyph, word] = KIND[t.type] ?? ["info", "Rule"],
    last = r.lastRun;
  const outcome = last ? outcomeWord(last.outcome, recordReason(last)) : null;
  const note = goodToKnow(t, v.locale),
    next = r.nextFire;
  const hostNames = r.nextFire?.hosts ?? [];
  return html`<li class="tr${t.disarmed ? " tr--spent" : ""}">
    <span class="tr-n" aria-label="Row ${r.index + 1}">${r.index + 1}</span>
    <div class="tr-when">
      <span class="tile tile--sm tr-kind">${ui.icon(glyph)}</span>
      <div>
        <p class="tr-k">${uiText(word, v.locale)}</p>
        <p class="tr-s"><a href="${ruleHref(v, r.index)}">${whenOf(t, v.locale)}</a></p>
        <p class="tr-sub">
          ${t.type === "cron"
            ? html`${uiText("In", v.locale)}
                <span class="code"
                  >${shownPath(t.folder) ?? "an unpublished folder"}</span
                >;
                ${hostNames.length
                  ? html`${uiText("on", v.locale)} ${hostNames.join(", ")}`
                  : uiText("owning host not published", v.locale)}${next?.zone
                  ? html`; ${uiText("schedule zone", v.locale)} ${next.zone}`
                  : null}`
            : html`${uiText(triggerWhoMayFire(t), v.locale)}
              ${t.repository
                ? html`${uiText("In", v.locale)} <span class="code">${t.repository}</span>.`
                : uiText("In repositories wired to this deployment.", v.locale)}`}
        </p>
      </div>
    </div>
    <span class="tr-arrow" aria-hidden="true">${ui.icon("chev-r")}</span>
    <div class="tr-then">
      <p class="tr-s">
        ${uiText("runs", v.locale)}
        <span class="tr-flow"
          >${ui.icon(t.command ? "terminal" : "skill", {
            size: "sm",
          })}${t.command ?? t.flow ?? "deployment entrypoint"}</span
        >
      </p>
      <p class="tr-sub">
        ${[t.provider, t.model].filter(Boolean).join(" / ") || uiText("deployment default model", v.locale)}
        · ${t.backend ?? uiText("each host's default", v.locale)} ${uiText("venue", v.locale)}
      </p>
      <p class="tr-chips">
        ${r.chips.map((c) => {
          const [status, icon, label] = CHIP[c.kind] ?? [
            null,
            "info",
            uiText("Option", v.locale),
          ];
          return ui.chip(`${uiText(label, v.locale)}: ${c.text}`, { status, icon });
        })}
      </p>
    </div>
    <div class="tr-status">
      ${last
        ? html`<p>
              ${ui.badge(
                outcome?.known ? outcome.status : "failed",
                uiText(outcome?.word ?? last.outcome ?? "unknown", v.locale),
              )}${timeHtml(atOf(last))}
            </p>
            <p class="tr-sub">
              ${runLink(last.jobId)}${last.project
                ? html` · ${ui.ptag(last.project)}`
                : null}
            </p>
            ${recordReason(last)
              ? html`<p class="tr-sub">
                  ${uiText(reasonWords(recordReason(last)).sentence ??
                  "No explanation is available for the recorded reason.", v.locale)}
                </p>`
              : null}`
        : html`<p class="tr-sub">
            ${r.stats.runs30d == null
              ? uiText("Last run unavailable", v.locale)
              : uiText("No run in retained history", v.locale)}
          </p>`}${next
        ? html`<p class="tr-next">
              ${uiText("Next", v.locale)}: ${next.at === null ? uiText("unknown", v.locale) : timeHtml(next.at)} ·
              ${uiText(next.health === "on-time" ? "on time" : next.health, v.locale)} · ${uiText("stalls", v.locale)}
              ${next.stalls ?? uiText("unknown", v.locale)} ${uiText("of", v.locale)} ${next.stallLimit}
            </p>
            ${next.problem
              ? html`<p class="tr-problem">${next.problem}</p>`
              : null}`
        : null}
      <p class="tr-sub">
        ${countText(r.stats.runs30d, r.stats.incomplete)} ${uiText("runs in 30 days", v.locale)} ·
        ${uiText(costText(r.stats), v.locale)} ${uiText("this UTC week", v.locale)}
      </p>
      ${r.unknown.map((p) => html`<p class="tr-problem">${p}</p>`)}
    </div>
    <a
      class="tr-open btn btn--sm btn--ghost"
      href="${ruleHref(v, r.index)}"
      aria-label="${uiText("Open row", v.locale)} ${r.index + 1}"
      >${ui.icon("chev-r", { size: "sm" })}</a
    >${note
      ? html`<p class="tr-note tr-note-desktop">
            ${ui.icon("info", { size: "sm" })}<span>${note}</span>
          </p>
          <details class="tr-note tr-note-phone">
            <summary>${ui.icon("info", { size: "sm" })}${uiText("Good to know", v.locale)}</summary>
            <p>${note}</p>
          </details>`
      : null}
  </li>`;
}
function groupPanel(v, key) {
  const rows = rowsOf(v).filter(
    (r) =>
      r.group === key || (key === "unknown" && !Object.hasOwn(GROUP, r.group)),
  );
  if (!rows.length) return html``;
  return card(
    uiText(GROUP[key], v.locale),
    html`<ol class="tr-list">
      ${rows.map((r) => ruleRow(v, r))}
    </ol>`,
    {
      flush: true,
      sub: `${rows.length} ${uiText(rows.length === 1 ? "rule" : "rules", v.locale)}`,
    },
  );
}
export function triggersSchedules(v) {
  return groupPanel(v, "schedule");
}
export function triggersGithub(v) {
  return groupPanel(v, "github");
}
export function triggersGitlab(v) {
  return groupPanel(v, "gitlab");
}
export function triggersForgejo(v) {
  return groupPanel(v, "forgejo");
}
export function triggersAzure(v) {
  return groupPanel(v, "azure");
}
export function triggersUnknown(v) {
  const rows = rowsOf(v);
  if (!modelOf(v))
    return card(
      uiText("Rules unavailable", v.locale),
      html`<p>
        ${uiText("The deployment's rule facts could not be read. Reload and check pi-dispatch doctor.", v.locale)}
      </p>`,
    );
  if (!rows.length)
    return card(
      uiText("Rules", v.locale),
      html`<p>
        ${modelOf(v).problems?.length
          ? uiText("No rule can be shown from the available file.", v.locale)
          : uiText("No rule matches this filter.", v.locale)}
      </p>`,
    );
  return groupPanel(v, "unknown");
}
function pct(at, w) {
  return Number.isFinite(at) && w.end > w.start
    ? Math.max(
        0,
        Math.min(100, ((at - w.start) / (w.end - w.start)) * 100),
      ).toFixed(3)
    : "0";
}
export function triggersWeek(v) {
  const m = modelOf(v),
    w = m?.week;
  if (!w)
    return card(
      uiText("When schedules fire", v.locale),
      html`<p>${uiText("Schedule and quiet-window projections are unavailable.", v.locale)}</p>`,
    );
  const lanes = [
    ...w.lanes.map((l) => ({
      kind: "schedule",
      name: `${l.index + 1} · ${l.id}`,
      sub: l.zone ?? "zone unknown",
      ...l,
    })),
    ...w.quiet.map((q) => ({
      kind: "quiet",
      name: `${uiText("Quiet", v.locale)}: ${shownPath(q.scope)}`,
      sub:
        q.affects === "forge"
          ? uiText("forge jobs only", v.locale)
          : q.affects === "local"
            ? uiText("local folder jobs, including schedules", v.locale)
            : uiText("all matching jobs, including schedules", v.locale),
      ...q,
    })),
  ];
  const height = Math.max(36, lanes.length * 36),
    future = m.rows
      .filter((r) => r.nextFire?.at != null && r.nextFire.at >= m.now)
      .sort((a, b) => a.nextFire.at - b.nextFire.at);
  return card(
    uiText("When schedules fire", v.locale),
    html`<div class="tr-week-desktop">
        <div class="wk-scroll">
          <div class="wk">
            <div class="wk-labels">
              ${lanes.map(
                (l) => html`<p><b>${l.name}</b><span>${l.sub}</span></p>`,
              )}
            </div>
            <div class="wk-track">
              <svg
                class="wk-svg"
                height="${height + 28}"
                role="img"
                aria-label="${`Seven-day UTC projection: ${w.lanes.length} schedules and ${w.quiet.length} quiet windows. Filled dots are recorded runs; outlined dots are future fires.`}"
              >
                ${lanes.map(
                  (l, i) =>
                    html`<rect
                        class="wk-band"
                        x="0"
                        y="${i * 36 + 5}"
                        width="100%"
                        height="26"
                        rx="13"
                      />${l.kind === "schedule"
                        ? l.occurrences.map(
                            (t) =>
                              html`<circle
                                class="${t.kind === "ran"
                                  ? "wk-ran"
                                  : "wk-next"}"
                                cx="${pct(t.at, w)}%"
                                cy="${i * 36 + 18}"
                                r="6"
                                ><title>
                  ${uiText(t.kind === "ran"
                                    ? "Recorded run"
                                    : "Projected fire", v.locale)}:
                                  ${new Date(t.at).toISOString()}${t.jobId
                                    ? `; ${t.jobId}`
                                    : ""}
                                </title></circle
                              >`,
                          )
                        : l.intervals.map(
                            (q) =>
                              html`<rect
                                class="wk-quiet"
                                x="${pct(q.start, w)}%"
                                y="${i * 36 + 8}"
                                width="${(
                                  Number(pct(q.end, w)) -
                                  Number(pct(q.start, w))
                                ).toFixed(3)}%"
                                height="20"
                                rx="8"
                                ><title>
                                  ${l.name}: ${new Date(q.start).toISOString()}
                                  to ${new Date(q.end).toISOString()}
                                </title></rect
                              >`,
                          )}`,
                )}${Array.from(
                  { length: 7 },
                  (_, d) =>
                    html`${d
                        ? html`<line
                            class="wk-day"
                            x1="${((d / 7) * 100).toFixed(3)}%"
                            x2="${((d / 7) * 100).toFixed(3)}%"
                            y1="0"
                            y2="${height}"
                          />`
                        : null}<text
                        class="wk-ax"
                        x="${(((d + 0.5) / 7) * 100).toFixed(3)}%"
                        y="${height + 20}"
                        text-anchor="middle"
                        >${new Date(w.start + d * DAY)
                          .toISOString()
                          .slice(5, 10)}</text
                      >`,
                )}
                <line
                  class="wk-now"
                  x1="${pct(m.now, w)}%"
                  x2="${pct(m.now, w)}%"
                  y1="0"
                  y2="${height}"
                />
                <text
                  class="wk-now-label"
                  x="${pct(m.now, w)}%"
                  y="-10"
                  text-anchor="middle"
                >
                  ${uiText("now", v.locale)}
                </text>
              </svg>
            </div>
          </div>
        </div>
        <p class="keyrow tr-week-key">
          <span><i class="wk-k wk-k--ran"></i>${uiText("recorded run", v.locale)}</span
          ><span><i class="wk-k wk-k--next"></i>${uiText("projected fire", v.locale)}</span
          ><span><i class="wk-k wk-k--quiet"></i>${uiText("quiet window", v.locale)}</span>
        </p>
      </div>
      <div class="tr-week-phone">
        <h3>${uiText("Next fires", v.locale)}</h3>
        <ul class="tr-next-fires">
          ${future.map(
            (r) =>
              html`<li>
                <b>${timeHtml(r.nextFire.at)}</b
                ><a href="${ruleHref(v, r.index)}"
                  >${r.trigger.id} · row ${r.index + 1}</a
                ><span
                  >${r.nextFire.health === "on-time"
                    ? uiText("on time", v.locale)
                    : uiText(r.nextFire.health, v.locale)}</span
                >
              </li>`,
          )}
        </ul>
        ${!future.length
          ? html`<p>${uiText("No next fire is published.", v.locale)}</p>`
          : null}${w.quiet.map(
          (q) =>
            html`<p>
              <b>Quiet: ${shownPath(q.scope)}</b> ${q.intervals[0]
                ? html`${timeHtml(q.intervals[0].start)} to
                  ${timeHtml(q.intervals[0].end)}`
                : "no interval in view"};
              ${q.affects === "forge"
                ? uiText("forge jobs only", v.locale)
                : q.affects === "local"
                  ? uiText("local folder jobs, including schedules", v.locale)
                  : uiText("all matching jobs, including schedules", v.locale)}.
            </p>`,
        )}
      </div>
      <p class="tr-sub">
        ${uiText(w.label, v.locale)}. ${uiText("Schedule times use their owning host's verified timezone and are plotted as UTC instants. Forge repository quiet windows do not hold cron; matching local-folder and global windows can hold it.", v.locale)}
      </p>
      ${lanes
        .filter((l) => l.problem || l.incomplete)
        .map(
          (l) =>
            html`<p class="tr-problem">
              ${l.name}:
              ${l.problem ??
              uiText("Only a bounded selection of retained runs and projected times is shown.", v.locale)}
            </p>`,
        )}${w.lanesCut
        ? html`<p class="tr-problem">
            ${w.lanesCut} ${uiText("schedule lanes are omitted.", v.locale)}
          </p>`
        : null}${w.quietCut
        ? html`<p class="tr-problem">
            ${w.quietCut} ${uiText("quiet windows are omitted.", v.locale)}
          </p>`
        : null}${w.quietUnknown
        ? html`<p class="tr-problem">
          ${uiText("Quiet windows could not be read; no absence of bands proves they are off.", v.locale)}
          </p>`
        : null}`,
    { sub: uiText("UTC instants, not an execution guarantee", v.locale) },
  );
}
function checkSelect(name, label, values, { forges = false, locale = "en" } = {}) {
  const options = forges
    ? Object.entries(values).flatMap(([forge, words]) =>
        words.map(
          (value) =>
            html`<option value="${value}" data-check-forge="${forge}">
              ${uiText(value, locale)}
            </option>`,
        ),
      )
    : values.map((value) => html`<option value="${value}">${uiText(value, locale)}</option>`);
  return html`<div class="field" data-check-field="${name}">
    <label
      >${uiText(label, locale)}<select class="select" name="${name}">
        ${options}
      </select></label
    >
  </div>`;
}
export function triggerCheckForm(locale = "en") {
  return html`<form data-trigger-check autocomplete="off">
    <fieldset data-trigger-check-fields disabled>
      <legend class="sr">${uiText("Describe a hypothetical forge event", locale)}</legend>
      <div class="tr-form">
        ${checkSelect("forge", "Forge", Object.keys(CHECK_EVENTS), { locale })}
        <div class="field" data-check-field="repository">
          <label
            >${uiText("Repository", locale)}<input
              class="input input--code"
              name="repository"
              maxlength="${CHECK_LIMITS.repository}"
              placeholder="owner/repository"
              required
              autocomplete="off"
              spellcheck="false"
          /></label>
        </div>
        ${checkSelect("event", "What happens", CHECK_EVENTS, { forges: true, locale })}${checkSelect("actor", "Who acts (assumed authority)", CHECK_ACTORS, { locale })}
        <div class="field" data-check-field="number">
          <label
            >${uiText("Issue or pull request number", locale)}<input
              class="input"
              type="number"
              name="number"
              min="1"
              max="2147483647"
              placeholder="1"
              autocomplete="off"
          /></label>
        </div>
        ${checkSelect("action", "Pull request action", CHECK_PR_ACTIONS, {
          forges: true, locale,
        })}${checkSelect(
          "prAuthor",
          "Pull request author's authority",
          CHECK_PR_AUTHORS,
          { locale },
        )}${checkSelect(
          "reviewState",
          "Review verdict",
          CHECK_REVIEW_STATES,
          { locale },
        )}${checkSelect("reviewBody", "Review body", CHECK_REVIEW_BODIES, { locale })}
        <div class="field tr-span" data-check-field="labels">
          <label
            >${uiText("Current labels, one per line", locale)}<textarea
              class="textarea"
              name="labels"
              rows="2"
              maxlength="${CHECK_LIMITS.labels * (CHECK_LIMITS.label + 1)}"
              spellcheck="false"
            ></textarea>
          </label>
        </div>
        <div class="field tr-span" data-check-field="previousLabels">
          <label
            >${uiText("Previous labels, one per line", locale)}<textarea
              class="textarea"
              name="previousLabels"
              rows="2"
              maxlength="${CHECK_LIMITS.labels * (CHECK_LIMITS.label + 1)}"
              spellcheck="false"
            ></textarea>
          </label>
        </div>
        <div class="field tr-span" data-check-field="comment">
          <label
            >${uiText("Comment", locale)}<textarea
              class="textarea"
              name="comment"
              rows="3"
              maxlength="${CHECK_LIMITS.comment}"
              spellcheck="false"
            ></textarea>
          </label>
        </div>
      </div>
      <p class="tr-sub">
        ${uiText("Authority is a hypothetical assumption. Comment text stays in this request; it is never placed in the address bar or audit log.", locale)}
      </p>
      <button class="btn btn--primary" type="submit">
        ${ui.icon("search", { size: "sm" })}${uiText("Check an event", locale)}
      </button>
    </fieldset>
    <noscript
      ><p class="tr-problem">
        ${uiText("Enable JavaScript to check an event. Rules, filters and navigation remain available; no event text can be submitted into the address bar.", locale)}
      </p></noscript
    >
    <div
      data-trigger-check-result
      role="region"
      aria-label="${uiText("Event check result", locale)}"
      aria-live="polite"
      tabindex="-1"
    >
      <p class="tr-sub">
        ${uiText("Describe an event to see hypothetical matching. Nothing will be sent to a forge, queued or spent.", locale)}
      </p>
    </div>
  </form>`;
}
export function triggersCheck(v) {
  return card(
    uiText("Which rule would run?", v.locale),
    html`<p class="tr-p">
        ${uiText("Describe an event and see which rule matches, and why the others do not. Nothing is sent to a forge or spent.", v.locale)}
      </p>
      <p class="tr-check-phone-link">
        ${ui.btn({
          label: uiText("Check an event", v.locale),
          href: ui.pageHref(v.pages, "trigger-check") ?? "/triggers/check",
          kind: "primary",
          icon: "search",
        })}
      </p>
      <div class="tr-check-embedded">${triggerCheckForm(v.locale)}</div>`,
    { sub: uiText("Hypothetical matching, not delivery authentication", v.locale) },
  );
}
export function triggerCheckPage(v = {}) {
  return card(uiText("Which rule would run?", v.locale), triggerCheckForm(v.locale), {
    sub: uiText("Read-only and available to viewers", v.locale),
  });
}
export function renderTriggerCheckResult(result, locale = "en") {
  if (result?.refusal)
    return html`<div class="tr-check-error" role="alert">
      <h3>
        ${ui.icon("refused", { size: "sm" })}${uiText("The event could not be checked", locale)}
      </h3>
      <p>${uiText(result.refusal.sentence ?? "The event description was refused.", locale)}</p>
      <p>${uiText("No delivery was sent or queued; nothing was spent.", locale)}</p>
    </div>`;
  if (!result || typeof result !== "object")
    return html`<div class="tr-check-error" role="alert">
      <p>
        ${uiText("The console could not read a matching result. Nothing was sent or queued.", locale)}
      </p>
    </div>`;
  const match = result.matched;
  return html`<div class="tr-result">
    <h3 class="tr-res__h">
      ${ui.icon(match ? "done" : "info", { size: "sm" })}${match
        ? html`${uiText("Rule", locale)} ${match.row ?? match.index + 1} ${uiText("would match", locale)}${match.flow
            ? html` ${uiText("with flow", locale)} <b>${match.flow}</b>`
            : match.command
              ? html` ${uiText("with command", locale)} <b>${match.command}</b>`
              : null}`
        : uiText("No rule would match this description", locale)}
    </h3>
    ${match
      ? html`<p>
          ${uiText("Route", locale)}:
          <span class="code">${match.route ?? uiText("hypothetical match", locale)}</span>. ${uiText("This is not a promise that a real delivery will start a paid job.", locale)}
        </p>`
      : null}
    <p class="tr-res__s">
      ${uiText(result.notice ?? "Hypothetical matching only. Nothing was authenticated, sent, queued or spent.", locale)}
    </p>
    <h4>${uiText("The rules", locale)}</h4>
    <ol class="tr-why">
      ${(result.rules ?? []).map(
        (r) =>
          html`<li>
            <span class="tr-n tr-n--sm">${r.row ?? r.index + 1}</span
            ><span
              ><b>${r.status ?? "unknown"}</b>:
              ${r.sentence ?? "No explanation was provided."}</span
            >
          </li>`,
      )}
    </ol>
    <h4>${uiText("Checks a real delivery must still pass", locale)}</h4>
    <ul class="tr-gates">
      ${(result.gates ?? []).map(
        (g) =>
          html`<li>
            ${ui.icon(g.state === "would-refuse" ? "refused" : "info", {
              size: "sm",
            })}<b>${g.id}</b><span>${g.state}: ${g.sentence}</span>
          </li>`,
      )}
    </ul>
    ${!result.gates?.length
      ? html`<p>
          ${uiText("Delivery authentication and current admission gates were not checked here.", locale)}
        </p>`
      : null}
  </div>`;
}
