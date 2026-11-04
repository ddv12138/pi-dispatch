/** Pulse capacity cards use the report's checked geometry and facts, never a second capacity calculation. */
import { html } from "../html.mjs";
import * as ui from "../kit.mjs";
import { normCapacity, layoutCapacityChart, INSIGHTS_CAPACITY_JOBS_ONLY } from "../../insights-html.mjs";
import { timeHtml } from "./common.mjs";
import { uiText } from "../locale.mjs";

const payload = (v) => v.data?.insights?.capacity;
const t = (v, text) => uiText(text, v?.locale);
const note = (body) => html`<p class="sp-note note">${body}</p>`;
const card = (title, body, sub = null) => ui.card({ title, sub, body: html`<div class="card__body">${body}</div>` });
const valid = (n) => Number.isFinite(n) && n >= 0;
const percent = (n, view) => valid(n) ? `${Math.round(n) / 10}%` : t(view, "unknown");
const duration = (ms, view) => !valid(ms) ? t(view, "No run recorded one") : ms < 1000 ? `${Math.round(ms)}ms` : ms < 60_000 ? `${Math.round(ms / 100) / 10}s` : ms < 3_600_000 ? `${Math.round(ms / 6000) / 10}m` : `${Math.round(ms / 360_000) / 10}h`;
const number = (n) => Math.round(n * 100) / 100;
const headline = (amount, suffix = null) => ui.kpi(amount, suffix);

export function capacityBusy(v) {
  const c = payload(v), f = c?.fleet;
  return card(t(v, "Fleet busy"), html`${headline(percent(f?.busyPerMille, v), t(v, "of slot time"))}${note(html`${t(v, "Weighted by slots")}${c?.hostCount == null ? "" : `, ${c.hostCount} ${t(v, "hosts")}`}${c?.totalSlots == null ? "." : `, ${c.totalSlots} ${t(v, "current slots in all")}.`}`)}${f?.incomplete ? note(t(v, "Partial history: this is not a complete fleet total.")) : null}`);
}
export function capacityPeak(v) {
  const c = payload(v), f = c?.fleet;
  return card(t(v, "Fleet peak"), html`${headline(f?.peak ?? t(v, "unknown"), t(v, "jobs at once"))}${note(t(v, "Most jobs at once in one hour, all hosts added."))}${valid(c?.totalSlots) ? note(html`${c.totalSlots} ${t(v, "slots in the current fleet; past capacity may differ.")}`) : null}${timeHtml(f?.peakAtMs)}`);
}
export function capacityWait(v) {
  const w = payload(v)?.fleet?.waits;
  return card(t(v, "Wait for a slot"), html`${headline(duration(w?.p95Ms, v), valid(w?.p95Ms) ? "p95" : null)}${note(html`${t(v, "Median")} ${valid(w?.p50Ms) ? duration(w.p50Ms, v) : t(v, "unknown")}, ${t(v, "from eligible to holding a slot.")}`)}`);
}
export function capacityMemory(v) {
  const f = payload(v)?.fleet;
  return card(t(v, "Promised memory"), html`${headline(percent(f?.promisedMemPerMille, v), t(v, "at the busiest hour"))}${note(t(v, "Of every host's memory budget."))}${timeHtml(f?.busiestHourMs)}`);
}
export function capacityWindow(v) {
  const c = normCapacity(payload(v));
  return html`${c?.window ? note(html`${t(v, "From")} ${timeHtml(c.window.fromMs)} ${t(v, "to")} ${timeHtml(c.window.toMs)}. ${t(v, "Each bar is")} ${c.window.bucketMs / 3_600_000} ${t(v, c.window.bucketMs === 3_600_000 ? "hour" : "hours")}.`) : null}${ui.banner({ status: "attention", title: t(v, "Jobs only"), body: t(v, "A machine busy with other work reads as idle. These numbers count pi-dispatch jobs, not the machine.") })}`;
}

function chart(host, c, tips, now, v = {}) {
  const lay = layoutCapacityChart(host, { ...c.window, nowMs: now, width: 1000, height: 144 });
  const x = (value) => `${number(value / lay.width * 100)}%`;
  const bottom = lay.plot.y + lay.plot.h;
  const when = (ms) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const tip = (text) => tips.push(text) - 1;
  const labels = [];
  const span = c.window.toMs - c.window.fromMs;
  const step = span <= 86_400_000 ? 4 * 3_600_000 : Math.ceil(span / 86_400_000 / 7) * 86_400_000;
  for (let at = Math.ceil(c.window.fromMs / step) * step; at < c.window.toMs; at += step) {
    const date = new Date(at);
    labels.push({ x: lay.plot.x + (at - c.window.fromMs) / (c.window.toMs - c.window.fromMs) * lay.plot.w, text: span <= 86_400_000 ? `${String(date.getUTCHours()).padStart(2, "0")}:00` : date.toISOString().slice(5, 10) });
  }
  return html`<svg class="cp-chart" width="100%" height="144" role="img" aria-label="${t(v, "jobs at once on")} ${host.name}">
    ${labels.map((l) => html`<line class="cp-grid" x1="${x(l.x)}" x2="${x(l.x)}" y1="${lay.plot.y}" y2="${bottom}"></line>`)}
    ${lay.gaps.map((gap) => {
      const lines = [];
      for (let start = gap.x - lay.plot.h; start < gap.x + gap.w; start += 8) {
        const lo = Math.max(0, gap.x - start), hi = Math.min(lay.plot.h, gap.x + gap.w - start);
        if (hi > lo) lines.push(html`<line class="cp-hatch" x1="${x(start + lo)}" x2="${x(start + hi)}" y1="${bottom - lo}" y2="${bottom - hi}"></line>`);
      }
      return html`<g class="cp-gap" data-tip="${tip(`${when(gap.fromMs)} ${t(v, "to")} ${when(gap.toMs)}: ${t(v, "no data, neither busy nor idle")}${host.truncated ? `; ${t(v, "history truncated")}` : ""}`)}"><rect class="cp-nd-bg" x="${x(gap.x)}" y="${lay.plot.y}" width="${x(gap.w)}" height="${lay.plot.h}"></rect>${lines}</g>`;
    })}
    ${lay.bars.map((bar) => html`<g data-tip="${tip(`${when(bar.bucket.fromMs)}: ${t(v, "average")} ${(bar.bucket.avgMilli ?? 0) / 1000} ${t(v, bar.bucket.avgMilli === 1000 ? "job" : "jobs")}, ${t(v, "peak")} ${bar.bucket.peak}${bar.partial ? `; ${t(v, "part has no data")}` : ""}`)}"><rect x="${x(bar.x)}" y="${lay.plot.y}" width="${x(bar.w)}" height="${lay.plot.h}" fill="transparent"></rect>${bar.h > 0 ? html`<rect class="cp-bar" x="${x(bar.x)}" y="${number(bar.y)}" width="${x(Math.max(0.5, bar.w - 0.5))}" height="${number(bar.h)}"></rect>` : null}${bar.peakY !== null ? html`<line class="cp-peak-line" x1="${x(bar.x)}" x2="${x(bar.x + bar.w)}" y1="${number(bar.peakY)}" y2="${number(bar.peakY)}"></line>` : null}</g>`)}
    ${lay.limit ? html`<line class="cp-slots" x1="${x(lay.plot.x)}" x2="${x(lay.plot.x + lay.plot.w)}" y1="${number(lay.limit.y)}" y2="${number(lay.limit.y)}"></line><text class="cp-ll" x="${x(lay.plot.x)}" y="${Math.max(9, lay.limit.y - 4)}">${lay.limit.label}</text>` : null}
    <line class="cp-base" x1="${x(lay.plot.x)}" x2="${x(lay.plot.x + lay.plot.w)}" y1="${bottom}" y2="${bottom}"></line>
    <line class="cp-now" x1="${x(lay.plot.x + lay.plot.w)}" x2="${x(lay.plot.x + lay.plot.w)}" y1="${lay.plot.y}" y2="${bottom}"></line>
    <text class="cp-ll cp-ll--now" x="${x(lay.plot.x + lay.plot.w)}" y="9" text-anchor="end">${t(v, "now")}</text>
    ${labels.map((l) => html`<text class="cp-d" x="${x(l.x)}" y="${lay.height - 2}" text-anchor="middle">${l.text}</text>`)}
  </svg>`;
}

export function capacityHosts(v, tips = []) {
  const raw = payload(v), c = normCapacity(raw);
  if (!c || c.unreachable) return card(t(v, "Capacity not read"), ui.banner({ status: "failed", title: t(v, "Capacity not read"), body: c?.unreachable ?? t(v, "The report could not be read; the other Spend views still work.") }));
  if (c.noTime) return card(t(v, "Capacity"), ui.banner({ status: "idle", title: t(v, "No time in this window yet"), body: html`${t(v, "This window starts at")} ${timeHtml(c.fromMs)}.` }));
  return html`<div class="stack">${c.hosts.length ? c.hosts.map((host) => {
    const original = raw.hosts?.find((h) => h.name === host.name);
    const venues = Array.isArray(original?.venues) ? original.venues.filter((s) => typeof s === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(s)).slice(0, 16) : [];
    const f = host.facts;
    const detail = html`<span class="cp-host-meta">${venues.length ? ui.chip(venues.join(", ")) : t(v, "Venues unknown")} · ${host.slots === null ? t(v, "slot count unknown") : `${host.slots} ${t(v, "slots")}`}</span>`;
    return html`<article class="card" id="p-cap-${host.name}"><div class="card__head"><h2 class="card__title">${host.name}</h2>${detail}</div><div class="card__body">
      ${f ? html`<div class="cp-trio"><span><b>${f.busy}</b> ${t(v, "busy")}</span><span><b>${f.idle}</b> ${t(v, "idle")}</span><span class="cp-trio__0"><b>${f.missing ?? "0%"}</b> ${t(v, "no data")}</span></div>` : note(host.notShared ?? t(v, "No history here."))}
      ${f?.missing ? note(t(v, "Busy and idle are shares of covered time; no data is a share of the whole window.")) : null}
      ${chart(host, c, tips, v.now, v)}
      ${f ? html`<div class="cp-facts">${ui.facts([[t(v, "Jobs at once"), `${t(v, "average")} ${f.avg}, ${t(v, "peak")} ${f.peak}${f.slots === null ? "" : ` ${t(v, "of")} ${f.slots}`}`], [t(v, "Promised"), [f.memory, f.cpu].filter(Boolean).join(", ") || t(v, "unknown")], [t(v, "Wait for a slot"), f.wait ?? t(v, "No run recorded one")]], { cols: 1 })}${ui.facts([[t(v, "Full"), f.full === null ? t(v, "unknown") : `${f.full} ${t(v, "of the time")}`], [t(v, "CPU used"), f.cpuUsed ?? t(v, "unknown")], [t(v, "Projects by run time"), f.projects.length ? f.projects.join(", ") : t(v, "No project recorded")]], { cols: 1 })}</div>` : null}
      ${host.truncated ? ui.banner({ status: "attention", title: t(v, "History truncated"), body: html`${t(v, "History starts at")} ${timeHtml(host.fromMs)}. ${t(v, "Earlier time is drawn as no data, never as idle.")}`, sm: true }) : null}
      ${(host.caveats ?? []).map((text) => html`<p class="sp-note cp-caveat">${text}</p>`)}${host.notes ? note(host.notes) : null}
    </div></article>`;
  }) : note(c.noRun === "no host ran a job in this window" ? t(v, c.noRun) : c.noRun)}${c.notDrawn && (c.notDrawn.numbers + c.notDrawn.empty + c.notDrawn["not-shared"] > 0) ? note(`${t(v, "Hosts not drawn past 20:")} ${(raw.hosts ?? []).filter((h) => !c.hosts.some((x) => x.name === h.name) && /^[A-Za-z0-9._-]{1,64}$/.test(h.name)).map((h) => h.name).join(", ")}.`) : null}${c.notDrawn?.unnamed ? note(`${c.notDrawn.unnamed} ${t(v, "hosts not drawn: not a worker name.")}`) : null}${c.notDrawn?.repeated ? note(`${c.notDrawn.repeated} ${t(v, "repeated host names not drawn.")}`) : null}</div>`;
}

export function capacityKey(v = {}) {
  return card(t(v, "How to read the chart"), html`<ul class="cp-key"><li><svg width="22" height="16" aria-hidden="true"><rect class="cp-bar" x="4" y="1" width="12" height="14" rx="2"></rect></svg><span><b>${t(v, "Bar")}</b> ${t(v, "average jobs at once in the bucket")}</span></li><li><svg width="22" height="16" aria-hidden="true"><line class="cp-peak-line" x1="2" x2="20" y1="8" y2="8"></line></svg><span><b>${t(v, "Tick")}</b> ${t(v, "most jobs at once in the bucket")}</span></li><li><svg width="22" height="16" aria-hidden="true"><line class="cp-slots" x1="2" x2="20" y1="8" y2="8"></line></svg><span><b>${t(v, "Dashed line")}</b> ${t(v, "the host's slots")}</span></li><li><svg width="22" height="16" aria-hidden="true"><rect class="cp-nd-bg" width="22" height="16"></rect><path class="cp-hatch" d="M0 8L8 0M0 16L16 0M8 16L22 2M16 16L22 10"></path></svg><span><b>${t(v, "Hatched")}</b> ${t(v, "no data: neither busy nor idle")}</span></li><li><svg width="22" height="16" aria-hidden="true"><line class="cp-base" x1="2" x2="20" y1="8" y2="8"></line></svg><span><b>${t(v, "Empty")}</b> ${t(v, "idle: no job held a slot")}</span></li></ul>`);
}
export function capacityCoverage(v) {
  const c = payload(v), counts = c?.coverageCounts;
  const fields = [["Runs counted", "used"], ["Refused before a slot", "refusedBeforeSlot"], ["Retried", "retried"], ["Without a size", "withoutSize"], ["Running now", "running"], ["Live runs not counted", "liveNotCounted"]];
  return card(t(v, "Coverage"), html`${counts ? ui.facts(fields.map(([label, key]) => [t(v, label), counts[key] ?? t(v, "unknown")]), { cols: 1 }) : note(t(v, "Coverage counts were not published by this report."))}${(Array.isArray(c?.coverage) ? c.coverage : []).map(note)}${note(t(v, INSIGHTS_CAPACITY_JOBS_ONLY))}`);
}
export function capacityStates(v) {
  const raw = payload(v), c = normCapacity(raw);
  const state = !c || c.unreachable ? { status: "failed", title: t(v, "Capacity not read"), body: t(v, "The report did not answer, so nothing is drawn. The other Spend views still work.") } : c.noTime ? { status: "idle", title: t(v, "No time in this window yet"), body: html`${t(v, "This window starts at")} ${timeHtml(c.fromMs)}.` } : raw?.fleet?.incomplete ? { status: "attention", title: t(v, "Incomplete history"), body: t(v, "Missing time is drawn as no data and is never counted as idle.") } : { status: "ok", title: t(v, "History read"), body: t(v, "History coverage is shown with each host. At most 20 hosts are drawn.") };
  return card(t(v, "Other states"), html`${ui.banner({ ...state, sm: true })}${raw?.venuesUnreadable ? ui.banner({ status: "attention", title: t(v, "Host venues not read"), body: t(v, "The registry did not answer; host venues and current fleet slots remain unknown."), sm: true }) : null}`);
}
