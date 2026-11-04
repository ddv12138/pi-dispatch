/** ProjectDetail's pure Pulse panels (#751); reads and planner preflights live in project-view.mjs. */
import { html } from "../html.mjs";
import * as ui from "../kit.mjs";
import { formatCpus, parseMemory } from "@edgehero/pi-dispatch/job-size";
import { optionalTokenCount as parseTokenCount } from "@edgehero/pi-dispatch/budget-rule";
import { bundleDeclaredText } from "../../read-model.mjs";
import { OUTCOME_KEY_WORDS, reasonWords, shortSentence } from "../../words.mjs";
import { newerSkippedSentence } from "../../newer-release.mjs";
import { canAct, runLink, timeHtml, usdText, moneyHtml } from "./common.mjs";
import { actForm } from "./config-ui.mjs";
import { uiText } from "../locale.mjs";

const DAY = 86_400_000;
const data = (v) => v?.data?.projectView ?? null;
const ready = (v) => data(v)?.state === "ready";
const tr = (v, text) => uiText(text, v?.locale);
const card = (title, body, sub = null) => ui.card({ title, body, sub });
const note = (s) => html`<p class="muted proj-note">${s}</p>`;
const n = (value) => Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
const sizeText = (mib) => Number.isFinite(mib) ? mib % 1024 === 0 ? `${mib / 1024} GiB` : `${mib} MiB` : "unknown";
const money = (v) => usdText(v) === "-" ? "unknown" : moneyHtml(v);
const unknown = (v) => v === null || v === undefined ? "unknown" : v;
const at = (value) => typeof value === "number" ? value : Date.parse(value ?? "");
const linkRuns = (id) => `/runs?project=${encodeURIComponent(id)}`;
const issue = (v) => !data(v) || data(v)?.state === "unreadable" ? card(uiText("Project unavailable", v?.locale), note(uiText(data(v)?.problem ?? "The project could not be read. Reload to try again.", v?.locale))) : null;
const facts = (pairs) => ui.facts(pairs, { cols: 1 });
const gibText = (mib) => Number.isFinite(mib) ? `${(mib / 1024).toFixed(1)} GiB` : "unknown";
// The worker owns the evidence sentences. Convert only their memory-unit tokens, never a command or reason.
const memoryWords = (text) => typeof text === "string" ? text.replace(/\b(\d+(?:\.\d+)?)(g|m)\b/g, (_all, value, unit) => gibText(Number(value) * (unit === "g" ? 1024 : 1))) : text;
const runBadge = (r) => {
  const word = OUTCOME_KEY_WORDS[r.outcome];
  return ui.badge(r.outcome === "completed" ? "idle" : word?.status ?? "attention", word ? word.word.charAt(0).toUpperCase() + word.word.slice(1) : "Unknown", { icon: r.outcome === "completed" ? ui.STATUS.ok.icon : null });
};
const kindText = (t) => `${String(t.type ?? "unknown").replaceAll("_", " ")}${["github", "gitlab", "forgejo", "azure"].includes(t.forge) ? ` on ${t.forge}` : ""}`;

export const projectTitle = (view, locale = "en") => view?.project?.name || view?.id || uiText("Project", locale);
export const projectDescription = (view, locale = "en") => view?.state === "ready" ? `${view.members.length} ${uiText(view.members.length === 1 ? "member" : "members", locale)}; ${uiText("id", locale)} ${view.id} ${uiText("in", locale)} ${view.file}.` : uiText("Project configuration could not be read.", locale);

export function projectSpend(v) {
  if (!ready(v)) return issue(v);
  const s = data(v).spend;
  const splitKnown = Number.isFinite(s.settledTokens) && Number.isFinite(s.heldTokens);
  const totalKnown = Number.isFinite(s.usedTokens);
  const headline = splitKnown ? s.settledTokens : totalKnown ? s.usedTokens : s.settledTokens;
  const pct = totalKnown && s.shareTokens > 0 ? (s.usedTokens / s.shareTokens) * 100 : null;
  return card(`${uiText("Spend this", v.locale)} ${uiText(s.window, v.locale)}`, html`<div class="proj-kv"><b>${s.floor ? uiText("at least", v.locale) + " " : ""}${money(headline)}</b><span>${splitKnown ? html`+ ${money(s.heldTokens)} ${uiText("held", v.locale)}` : totalKnown ? uiText("spent and held", v.locale) : uiText("spent; held amount unknown", v.locale)}${s.envelope ? html`, ${uiText("of a", v.locale)} ${money(s.shareTokens)} ${uiText("share", v.locale)}` : `; ${uiText("no envelope, so no share", v.locale)}`}</span></div>${pct === null ? null : html`${ui.meter({ value: s.usedTokens, max: s.shareTokens, label: uiText("Spent and held against the project's allocation share", v.locale) })}<p class="proj-meter-label">${money(s.usedTokens)} / ${money(s.shareTokens)}</p>`}${!splitKnown && totalKnown ? note(uiText("The split between spent and held is unknown.", v.locale)) : null}${s.heldIncomplete && !totalKnown ? note(html`${uiText("Held money is incomplete;", v.locale)} ${money(s.heldKnownTokens)} ${uiText("is known from the hosts that reported it.", v.locale)}`) : null}${s.problem ? note(s.problem) : null}`);
}

export function projectRuns(v) {
  if (!ready(v)) return null;
  const p = data(v); const r = p.runs24h;
  const counts = Object.entries(r.counts).filter(([, count]) => count > 0).map(([key, count]) => `${count} ${OUTCOME_KEY_WORDS[key]?.word ?? key}`);
  const worst = r.worst;
  const word = OUTCOME_KEY_WORDS[worst?.outcome];
  const reason = reasonWords(worst?.reason);
  // Some catalog entries first explain the setting, then name its failing prerequisite. Keep that cause in a KPI.
  const cause = reason.known ? reason.sentence.match(/, and (.+?), so /)?.[1] : null;
  const brief = cause ? shortSentence(cause) : reason.short;
  const short = reason.known ? brief.charAt(0).toLowerCase() + brief.slice(1) : "no reason is published";
  return card(uiText("Runs, last 24 hours", v.locale), html`<div class="proj-kv"><b>${r.total}</b><span>${counts.length ? counts.join(", ") : uiText("no retained runs", v.locale)}; ${unknown(r.inLine)} ${uiText("in line", v.locale)}${r.inLineIncomplete ? ` (${uiText("at least", v.locale)})` : ""}</span></div>${worst && worst.outcome !== "completed" ? html`<p class="proj-state tone-${ui.STATUS[word?.status ?? "attention"].tone}">${ui.icon(ui.STATUS[word?.status ?? "attention"].icon, { size: "sm" })}<span>${runLink(worst.jobId, { pulse: true })} ${uiText(word?.word ?? "ended", v.locale)}${worst.host ? html` ${uiText("on", v.locale)} ${worst.host}` : null}: ${short}${short.endsWith("…") ? "" : "."}</span></p>` : null}${p.historyIncomplete ? note(uiText("Run counts are a bounded view; the retained history or a fleet mirror could not be read completely.", v.locale)) : null}${newerSkippedSentence(p.newerSkipped) ? note(`${newerSkippedSentence(p.newerSkipped)}: ${uiText("counts and spend leave them out.", v.locale)}`) : null}`);
}

export function projectSize(v) {
  if (!ready(v)) return null;
  const p = data(v); const s = p.size;
  return card(uiText("Job size", v.locale), s ? html`<div class="proj-kv"><b>${sizeText(s.memMiB)}</b><span>${uiText("and", v.locale)} ${Number.isFinite(s.cpuCenti) ? formatCpus(s.cpuCenti) : uiText("unknown", v.locale)} CPUs ${uiText("per job", v.locale)}</span></div>${note(s.memorySource === s.cpuSource ? `${uiText("From", v.locale)} ${uiText(s.memorySource === "project row" ? "the project row" : s.memorySource, v.locale)}.` : `${uiText("Memory from", v.locale)} ${s.memorySource}; CPUs ${uiText("from", v.locale)} ${s.cpuSource}.`)}${p.sizing?.memory?.reason === "oversized" ? html`<p class="proj-state tone-attention">${ui.icon("attention", { size: "sm" })}<span>${uiText("Larger than its runs use:", v.locale)} ${memoryWords(p.sizing.words?.memory)}. ${uiText("A smaller size is suggested.", v.locale)}</span></p>` : null}` : note(uiText("The job size is unknown because its settings could not be read.", v.locale)));
}

export function projectMembers(v) {
  if (!ready(v)) return null;
  const p = data(v);
  return card(uiText("Members", v.locale), html`<ul class="rows proj-members">${p.members.map((m) => html`<li class="rowpill">${ui.icon(m.local ? "folder" : "git", { size: "sm" })}<b class="code">${m.label}</b><span>${uiText(m.local ? "folder" : "repository", v.locale)}</span><span class="end">${unknown(m.count)} ${uiText("runs this week", v.locale)}${m.last ? html` · ${uiText("last", v.locale)} ${runLink(m.last.jobId, { pulse: true })} ${timeHtml(m.last.at)}` : m.caveat ? html` · ${m.caveat}` : ` · ${uiText("no run in view", v.locale)}`}</span></li>`)}</ul>${note(`${uiText("Runs of these members record project", v.locale)} ${p.id} ${uiText("when a worker picks them up; a record keeps the project it was written with.", v.locale)}`)}${p.editRefusal ? html`<p class="proj-refusal">${ui.icon("attention", { size: "sm" })}<span>${p.editRefusal}</span></p>` : canAct(v) ? actForm("project-edit", { hidden: [["id", p.id]], fields: html`<div class="field"><label for="proj-members-input">${uiText("Members", v.locale)}</label>${ui.textarea({ id: "proj-members-input", name: "members", value: p.memberInput, rows: 3, maxlength: 16384, describedBy: "proj-members-hint" })}<p class="field__err" data-field-error="members" hidden></p></div><p class="proj-edit-hint" id="proj-members-hint">${uiText("One repository with its forge, or absolute folder per line. Blank keeps the current members.", v.locale)}</p>`, label: uiText("Preview the edit", v.locale), locale: v.locale }) : null}`, `${p.members.length} ${uiText("members", v.locale)}`);
}

/** Geometry is exported so tests can verify actual plotted values and changing run sizes, beyond a golden's bytes. */
export function layoutProjectSizingChart(series, { now, currentMiB, suggestedMiB = null } = {}) {
  const width = 560; const height = 190;
  const plot = { left: 68, right: 546, top: 15, bottom: 153 };
  const start = now - 30 * DAY;
  const valid = (Array.isArray(series) ? series : []).filter((p) => Number.isFinite(p?.at) && p.at >= start && p.at <= now && Number.isFinite(p.peakMiB) && p.peakMiB >= 0 && Number.isFinite(p.sizeMiB) && p.sizeMiB > 0).slice(-50).sort((a, b) => a.at - b.at);
  const maximum = Math.max(1024, currentMiB ?? 0, suggestedMiB ?? 0, ...valid.flatMap((p) => [p.peakMiB, p.sizeMiB]));
  const step = Math.max(256, 2 ** Math.ceil(Math.log2(maximum / 4)));
  const topMiB = Math.ceil(maximum / step) * step;
  const x = (t) => plot.left + ((t - start) / (30 * DAY)) * (plot.right - plot.left);
  const y = (m) => plot.bottom - (m / topMiB) * (plot.bottom - plot.top);
  const points = valid.map((p) => ({ ...p, x: x(p.at), y: y(p.peakMiB), sizeY: y(p.sizeMiB) }));
  const segments = [];
  let left = plot.left; let given = valid[0]?.sizeMiB ?? currentMiB;
  for (const p of points) {
    if (Number.isFinite(given)) segments.push({ x1: left, x2: p.x, y1: y(given), y2: y(given), mib: given });
    if (Number.isFinite(given) && given !== p.sizeMiB) segments.push({ x1: p.x, x2: p.x, y1: y(given), y2: p.sizeY, mib: p.sizeMiB });
    left = p.x; given = p.sizeMiB;
  }
  if (Number.isFinite(given)) segments.push({ x1: left, x2: plot.right, y1: y(given), y2: y(given), mib: given });
  if (Number.isFinite(currentMiB) && currentMiB !== given) segments.push({ x1: plot.right, x2: plot.right, y1: y(given), y2: y(currentMiB), mib: currentMiB });
  return { width, height, plot, topMiB, points, segments, suggestedY: Number.isFinite(suggestedMiB) && suggestedMiB > 0 ? y(suggestedMiB) : null, ticks: [0, 1, 2, 3, 4].map((i) => ({ value: (topMiB * i) / 4, y: y((topMiB * i) / 4) })), dates: [0, 10, 20, 30].map((days) => ({ x: x(start + days * DAY), label: new Date(start + days * DAY).toISOString().slice(5, 10), anchor: days === 0 ? "start" : days === 30 ? "end" : "middle" })) };
}

export function projectSizingChart(p) {
  const s = p.sizing;
  const geometry = layoutProjectSizingChart(s?.series, { now: p.now, currentMiB: p.size?.memMiB, suggestedMiB: s?.memory?.suggested });
  const g = geometry;
  const givenSizes = [...new Set(g.segments.map((segment) => segment.mib))];
  return html`<p class="proj-chart-unit">GiB</p><svg class="proj-chart" viewBox="0 0 ${g.width} ${g.height}" role="img" aria-label="${tr(p, "Peak memory of each run against its given size and the suggestion, last 30 days")}"><title>${tr(p, "Memory in GiB, over the 30 days ending")} ${new Date(p.now).toISOString().slice(0, 10)}</title>${g.ticks.map((t) => html`<line class="proj-grid" x1="${g.plot.left}" x2="${g.plot.right}" y1="${n(t.y)}" y2="${n(t.y)}"></line><text class="proj-axis" x="60" y="${n(t.y)}" text-anchor="end" dominant-baseline="middle">${n(t.value / 1024)}</text>`)}${g.segments.map((s) => html`<line class="proj-given" x1="${n(s.x1)}" x2="${n(s.x2)}" y1="${n(s.y1)}" y2="${n(s.y2)}"><title>${tr(p, "Size given")} ${sizeText(s.mib)}</title></line>`)}${g.suggestedY === null ? null : html`<line class="proj-suggested" x1="${g.plot.left}" x2="${g.plot.right}" y1="${n(g.suggestedY)}" y2="${n(g.suggestedY)}"><title>${tr(p, "Suggested memory")} ${sizeText(s.memory.suggested)}</title></line>`}${g.points.map((pt) => html`<circle class="${pt.oom ? "proj-peak proj-peak--oom" : "proj-peak"}" cx="${n(pt.x)}" cy="${n(pt.y)}" r="${pt.oom ? 5 : 4}"><title>${new Date(pt.at).toISOString()}: ${tr(p, "peak")} ${sizeText(pt.peakMiB)}, ${tr(p, "given")} ${sizeText(pt.sizeMiB)}${pt.oom ? `, ${tr(p, "out-of-memory kill")}` : ""}</title></circle>`)}${g.dates.map((d) => html`<text class="proj-axis" x="${n(d.x)}" y="175" text-anchor="${d.anchor}">${d.label}</text>`)}</svg><div class="keyrow proj-key"><span><i class="proj-key-peak"></i>${tr(p, "peak of one run")}</span><span><i class="proj-key-given"></i>${tr(p, "size given (solid)")}: ${givenSizes.length === 1 ? sizeText(givenSizes[0]) : givenSizes.length > 1 ? tr(p, "changes per run") : tr(p, "unknown")}</span>${g.suggestedY === null ? null : html`<span><i class="proj-key-suggested"></i>${tr(p, "suggestion (dashed)")}: ${sizeText(s.memory.suggested)}</span>`}<span><i class="proj-key-oom"></i>${tr(p, "out-of-memory kill (red)")}</span></div>${g.points.length ? null : note(tr(p, "No measured memory peaks in this window."))}`;
}

export function projectSizing(v) {
  if (!ready(v)) return null;
  const p = data(v); const s = p.sizing;
  const dim = (label, d, words) => html`<p class="proj-verdict"><b>${label}: ${d?.suggested ? `suggest ${label === "Memory" ? gibText(d.suggested) : formatCpus(d.suggested) + " CPUs"}` : d?.reason === "not-enough-runs" ? "not enough runs" : d?.reason ?? "unknown"}.</b> ${(label === "Memory" ? memoryWords(words) : words) ?? "No suggestion could be read."}</p>`;
  const action = s?.action;
  return card(tr(v, "Job size"), html`${projectSizingChart(p)}${s ? html`${dim(tr(v, "Memory"), s.memory, s.words?.memory)}${dim(tr(v, "CPUs"), s.cpu, s.words?.cpu)}${[memoryWords(s.words?.memoryHeld), s.words?.memoryFact, s.words?.cpuFact, memoryWords(s.words?.refusal)].filter(Boolean).map(note)}` : note(tr(v, "No size suggestion could be read."))}${p.sizingUnreadable ? note(tr(v, "The measurements or scoped limits could not be read completely.")) : null}${note(tr(v, "Measured inside the jobs, so advisory."))}${s?.call && canAct(v) ? html`<p class="proj-sub">${tr(v, "The exact call")}</p><div class="cmd"><code>${s.call}</code><button class="btn btn--sm" type="button" data-copy hidden>${tr(v, "Copy")}</button></div>${action ? note(action.row === null ? `${tr(v, "Adds a scoped-limits row for project:")}${p.id}.` : `${tr(v, "Applies to scoped-limits row")}${action.row}, project:${p.id}.`) : null}${canAct(v) && action ? actForm(action.action, { hidden: [...(action.index === undefined ? [] : [["index", action.index, "int"]]), ["limit", JSON.stringify(action.limit), "json"]], label: tr(v, "Preview this size"), locale: v.locale }) : null}` : null}`, tr(v, "peak memory per run, last 30 days"));
}

export function projectRecent(v) {
  if (!ready(v)) return null;
  const p = data(v);
  const rows = p.recent.map((r) => [
    { html: runLink(r.jobId, { pulse: true }), id: true },
    { html: r.target ?? "unknown", wide: true, tgt: true },
    runBadge(r),
    { html: timeHtml(r.at), when: true },
    { html: html`${r.costFloor && r.tokens !== null ? "at least " : null}${money(r.tokens)}`, num: true },
  ]);
  return card(tr(v, "Recent runs"), html`${ui.tbl({ label: tr(v, "Recent runs of this project"), stack: true, heads: [{ label: tr(v, "Run"), l: "" }, { label: tr(v, "Target"), l: "" }, { label: tr(v, "Outcome"), l: "" }, tr(v, "Ended"), { label: tr(v, "Cost"), num: true }], rows, empty: tr(v, "No retained run recorded this project.") })}<p class="tbl-foot"><a class="link" href="${linkRuns(p.id)}">${tr(v, "All")} ${p.totalRuns} ${tr(v, "in Runs, filtered to")} ${p.id}</a></p>${note(tr(v, "The last five runs recorded with this project, within the retained view (30 days or this month, whichever reaches further)."))}`);
}

export function projectAllocation(v) {
  if (!ready(v)) return null;
  const a = data(v).allocation;
  return card(tr(v, "Allocation"), html`${a.unset ? note(tr(v, "No envelope is configured, so this project has no allocation share.")) : html`${facts([[tr(v, "Weight"), `${unknown(a.weight)} ${tr(v, "of")} ${unknown(a.totalWeight)}`], [tr(v, "Floor"), html`${money(a.floorTokens)} ${tr(v, a.window)}`], [tr(v, "Share"), html`${money(a.shareTokens)} ${tr(v, "of the")} ${money(a.totalTokens)} ${tr(v, a.window)} ${tr(v, "envelope")}`], [tr(v, "Split"), a.split ? html`<span class="code">${a.split.id ?? tr(v, "neutral")}</span> ${tr(v, "by")} ${a.split.writer ?? tr(v, "unknown")}, ${tr(v, "applied")} ${timeHtml(at(a.split.appliedAt))}, ${tr(v, "until")} ${a.split.validUntil ? timeHtml(at(a.split.validUntil)) : tr(v, "no expiry")}` : tr(v, "No split has been published.")], [tr(v, "Refused by the split"), `${a.refused} ${tr(v, "in this")} ${tr(v, a.window)}, ${tr(v, "among retained runs")}`]])}${a.problem ? note(a.problem) : null}`}<p><a class="link" href="/insights/budget-split">${tr(v, "Open the budget split")}</a></p>`);
}

export function projectLimits(v) {
  if (!ready(v)) return null;
  const p = data(v);
  const words = {
    memory: (value) => `${sizeText(parseMemory(value))} memory`,
    cpus: (value) => `${value} CPUs`,
    day: (value) => `${value} jobs a day`, week: (value) => `${value} jobs a week`, month: (value) => `${value} jobs a month`, concurrent: (value) => `${value} at once`,
    dayTokens: (value) => html`${money(parseTokenCount(value))} a day`, weekTokens: (value) => html`${money(parseTokenCount(value))} a week`, monthTokens: (value) => html`${money(parseTokenCount(value))} a month`,
    hostShare: (value) => `${value}% of each host's budget`, minJobs: (value) => `space for at least ${value} jobs on an admitting host`,
  };
  const rows = p.limits.map((l) => {
    const fields = Object.entries(words).filter(([key]) => l[key] !== null && l[key] !== undefined).map(([key, render]) => render(l[key]));
    return [`Row ${l.index + 1}`, html`<span class="code">${l.scope}</span>${fields.length ? html`: ${fields.map((value, index) => html`${index ? ", " : null}${value}`)}` : ": no caps or size fields set"}`];
  });
  return card(tr(v, "Limits"), html`${rows.length ? facts(rows) : note(tr(v, "No scoped-limits row names this project."))}${facts([[tr(v, "Jobs a day"), p.limits[0]?.day ?? tr(v, "not set")], [tr(v, "At once"), p.limits[0]?.concurrent ?? tr(v, "not set; a local folder still runs one job at a time")]])}${p.limitsUnreadable ? note(tr(v, "The scoped-limits file could not be read.")) : null}<p><a class="link" href="/config#cf-scoped-limits">${tr(v, "Open scoped limits")}</a></p>`);
}

export function projectBundle(v) {
  if (!ready(v)) return null;
  const p = data(v);
  const b = p.bundle;
  if (p.bundleKnown === false) return card(tr(v, "Secret bundle"), html`${note(tr(v, "The triggers file could not be loaded, so whether this project has a secret bundle is unknown. Run pi-dispatch doctor and correct the triggers file."))}<p><a class="link" href="/config/secrets">${tr(v, "Open secrets")}</a></p>`, tr(v, "names only"));
  return card(tr(v, "Secret bundle"), html`${b ? facts([[tr(v, "Bundle"), html`<span class="code">${b.id}</span> ${tr(v, "via")} <span class="code">${b.profile}</span> (${b.format ?? tr(v, "format unknown")})`], [tr(v, "Declared"), tr(v, bundleDeclaredText(b))], [tr(v, "Last received"), b.last ? html`${b.last.variables.length ? b.last.variables.join(", ") : tr(v, "no variables")}; ${runLink(b.last.jobId, { pulse: true })}${b.last.at ? html` ${tr(v, "at")} ${timeHtml(at(b.last.at))}` : null}` : tr(v, "no run in view")], [tr(v, "Opted out"), b.optedOut.length ? b.optedOut.map((i) => `${tr(v, "trigger")} ${i + 1}`).join(", ") : tr(v, "no trigger")], [tr(v, "Fork reviews"), b.forkReviews ? tr(v, "yes") : tr(v, "no")]]) : note(tr(v, "No secret bundle names this project."))}<p><a class="link" href="/config/secrets">${tr(v, "Open secrets")}</a></p>`, tr(v, "names only"));
}

export function projectTriggers(v) {
  if (!ready(v)) return null;
  const p = data(v);
  return card("Triggers that ran here", html`${p.triggers.length ? html`<ul class="rows proj-triggers">${p.triggers.map((t) => html`<li class="rowpill"><a class="link" href="${`/config/trigger?index=${t.index}`}">Trigger ${t.index + 1}</a><span class="proj-trigger-desc">${kindText(t)}${t.id ? html` ${t.id}` : null}${t.flow ? html` → ${t.flow}` : null}</span><span class="end">${t.count} runs</span></li>`)}</ul>` : note("No retained run here was attributed to a trigger in the last 24 hours.")}${note("Forge triggers fire on any member that sends events. A cron trigger runs here when its folder is a member.")}`, "last 24 hours");
}

export function projectDelete(v) {
  if (!ready(v) || v.role !== "operator") return null;
  const p = data(v);
  return card("Delete", p.deleteRefusal ? html`<p class="proj-refusal">${ui.icon("attention", { size: "sm" })}<span>${p.deleteRefusal}</span></p>${canAct(v) ? html`<button class="btn btn--danger btn--sm" type="button" disabled aria-disabled="true">Delete ${p.id}</button>` : null}` : canAct(v) ? html`${note("Removing the project stops future pickups recording this id. Records already written keep it. The preview checks its limits, bundles and envelope floors again.")}${actForm("project-delete", { hidden: [["id", p.id]], label: `Delete ${p.id}` })}` : note("This console is read-only. A writable operator console can preview a delete."));
}
