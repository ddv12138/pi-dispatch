/** Host pages report published facts; runtime cleanup remains an explicit command on that host. */
import { jobContainerName } from "@edgehero/pi-dispatch/container-names";
import { projectBudgetRow } from "@edgehero/pi-dispatch/host-budget";
import { hostQueueName } from "@edgehero/pi-dispatch/queue";
import { DOCTOR_SECTIONS } from "@edgehero/pi-dispatch/doctor-results";
import {
  doctorHostsOf,
  doctorStale,
  doctorProblems,
  doctorCountsText,
  doctorByText,
  DOCTOR_CHECKS_SHOWN,
} from "../../doctor-view.mjs";
import { html } from "../html.mjs";
import { uiText } from "../locale.mjs";
import * as ui from "../kit.mjs";
import {
  ageText,
  beatAgeOf,
  canAct,
  runLink as recordLink,
  timeHtml,
} from "./common.mjs";

const runLink = (id) => recordLink(id, { pulse: true });
const t = (view, message) => uiText(message, view.locale);

import {
  hostSkewText,
  HOST_NO_EXPIRY_TEXT,
  REGISTRY_UNREAD_TEXT,
  JOBS_UNREAD_TEXT,
} from "./overview.mjs";

const hostOf = (v) =>
  v.data?.host ??
  v.data?.snapshot?.hostBudgets?.find((h) => h.name === v.query?.name) ??
  null;
const jobsOf = (h) => (Array.isArray(h?.jobs) ? h.jobs : []);
const num = (n) =>
  n !== null && n !== undefined && n !== "" && Number.isFinite(Number(n))
    ? Number(n)
    : null;
const label = (v) => v.query?.name ?? "this host";
const command = (v, argv) =>
  v.role === "operator"
    ? ui.cmd(argv, { host: label(v) })
    : html`<p class="note">${t(v, "Run the cleanup on")} ${label(v)} ${t(v, "using its runtime, then the host budget gives the room back within 5 seconds once that runtime says the container is gone.")}</p>`;
const card = (title, fn) => (v) =>
  ui.card({
    title: t(v, title),
    sub:
      {
        "Jobs on the host":
          "running, orphaned and waiting; sizes from published facts",
        "Slots and budget": "what the host promised, from its registry row",
        "Registry row": "what the worker publishes about itself",
        "Last 7 days": "one-hour buckets; read on page load",
      }[title] ? t(v, {
        "Jobs on the host": "running, orphaned and waiting; sizes from published facts",
        "Slots and budget": "what the host promised, from its registry row",
        "Registry row": "what the worker publishes about itself",
        "Last 7 days": "one-hour buckets; read on page load",
      }[title]) : null,
    body: fn(hostOf(v), v),
  });
const digestOrphanObservation = (job, view) =>
  html`${t(view, "Orphaned hold observed")}${job.s ? html` ${t(view, "at")} ${timeHtml(job.s)}` : ` ${t(view, "at an unpublished time")}`}; ${t(view, "its origin is not known from the published digest")}`;
const gone = (view) => html`<p class="note">${t(view, "This host has no live registry row. Its last run records, queued jobs and retained doctor result can still be shown.")}</p>`;

/** A published id can be a digest; that never becomes a guessed container name. */
export function orphanCommand(job) {
  const id = job.id;
  const named =
    typeof id === "string" &&
    !id.startsWith("sha256:") &&
    /^[A-Za-z0-9._:-]{1,128}$/.test(id);
  if (named)
    return [
      "docker",
      "rm",
      "-f",
      id.startsWith("container:") ? id.slice(10) : jobContainerName(id),
    ];
  return ["docker", "ps", "-a", "--filter", "name=pi-job-"];
}

export const hostState = (v) => {
  const h = hostOf(v);
  const unread = Boolean(v.data?.snapshot?.queue?.fleetDegraded);
  const skew = h ? hostSkewText(h) : null;
  const age = h ? beatAgeOf(h) : null;
  const late = age === null || age > 60000;
  if (
    h &&
    !late &&
    !h.noExpiry &&
    !h.jobsUnreadable &&
    !unread &&
    skew === null
  )
    return html``;
  const doctor = doctorHostsOf(v.data?.snapshot).find(
    (row) => row.name === label(v),
  );
  return ui.card({
    tint: "attention",
    body: html`<div class="hd-state"><span class="tile tone-attention">${ui.icon("beat")}</span><div class="hd-state__t"><h2>${!h ? t(v, "Host has gone") : late ? `${t(v, "Stale: no beat for")} ${age === null ? t(v, "an unknown time") : ageText(age)}` : t(v, "Host needs attention")}</h2>${unread ? html`<p>${t(v, REGISTRY_UNREAD_TEXT)}</p>` : null}${h ? html`${late ? html`<p>${t(v, "Heartbeat late:")} ${age === null ? t(v, "age not known") : ageText(age)} ${t(v, "(expected within 1m). The worker beats every 15s; routing stops after three missed beats. Jobs already in its own queue wait for it.")}${doctor && doctorStale(doctor) ? ` ${t(v, "Doctor on")} ${h.name} ${t(v, "is also")} ${ageText(doctor.ageMs)} ${t(v, "old.")}` : ""}</p>` : null}${h.noExpiry ? html`<p>${t(v, HOST_NO_EXPIRY_TEXT)}</p>` : null}${skew === null ? null : html`<p>${t(v, skew)}</p>`}${h.jobsUnreadable ? html`<p>${t(v, JOBS_UNREAD_TEXT)}</p>` : null}<p>${t(v, h.routes === false || h.routes === "false" ? "This host has no routing queue; it still takes shared jobs." : "This host takes its own routed jobs and shared jobs.")}</p>` : gone(v)}</div>${h && late && canAct(v) && h.routes !== false && h.routes !== "false" ? html`<div class="hd-state__a">${ui.actForm({ action: "queue-pause", hidden: [["queue", hostQueueName(h.name)]], label: `${t(v, "Pause")} ${hostQueueName(h.name)}`, kind: ["danger", "sm"] })}</div>` : null}</div>`,
  });
};

const sizeText = (size) =>
  size && Number.isFinite(size.memMiB) && Number.isFinite(size.cpuCenti)
    ? `${size.memMiB / 1024} GiB and ${size.cpuCenti / 100} cores`
    : "size not published";
export const hostJobs = card("Jobs on the host", (h, v) => {
  const s = v.data?.snapshot ?? {};
  const active = (s.active ?? []).filter((j) => j.host === label(v));
  const waiting = (s.waiting?.rows ?? []).filter(
    (j) => j.host === label(v) || j.queue === hostQueueName(label(v)),
  );
  const rows = active.map((j) => [
    html`${j.project ? ui.ptag(j.project) : "No project recorded"} ${runLink(j.jobId)}`,
    sizeText(j.size),
    j.startedAt ? ageText(v.now - j.startedAt) : "unknown",
    ui.badge("running", "Running"),
    canAct(v)
      ? ui.actForm({
          action: "cancel-active",
          hidden: [["jobId", j.jobId]],
          label: "Cancel",
          kind: ["danger", "sm"],
        })
      : null,
  ]);
  for (const j of jobsOf(h).filter((j) => j.o))
    rows.push({
      mark: "attention",
      cells: [
        html`${j.p ? ui.ptag(j.p) : "No project recorded"} ${runLink(j.id)}`,
        sizeText({ memMiB: j.m, cpuCenti: j.c }),
        j.at ? ageText(Math.max(0, v.now - j.at)) : "not recorded",
        html`${ui.badge("attention", t(v, "Orphaned"))}<span class="reason">${String(j.id).startsWith("sha256:") ? html`${digestOrphanObservation(j, v)}; ${t(v, "it still holds")} ${sizeText({ memMiB: j.m, cpuCenti: j.c })}.` : String(j.id).startsWith("container:") ? html`${t(v, "Found left from before the worker started")}${j.s ? html` ${t(v, "at")} ${timeHtml(j.s)}` : `; ${t(v, "observation time was not published")}`}; ${t(v, "it still holds")} ${sizeText({ memMiB: j.m, cpuCenti: j.c })}.` : html`${t(v, "Cancelled")}${j.s ? html` ${t(v, "at")} ${timeHtml(j.s)}` : ""}; ${t(v, "its container's stop did not take, so it still holds")} ${sizeText({ memMiB: j.m, cpuCenti: j.c })}.`}</span>`,
        v.role === "operator"
          ? ui.btn({
              label: "Free the slot",
              href: `${`/fleet/host?${new URLSearchParams({ name: label(v) })}`}#p-hostbudget`,
              kind: ["danger", "sm"],
            })
          : null,
      ],
    });
  for (const j of waiting)
    rows.push([
      html`${j.project ? ui.ptag(j.project) : t(v, "No project recorded")} ${runLink(j.jobId)}`,
      sizeText(j.size ?? s.defaultSize),
      Number.isFinite(j.queuedAt)
        ? ageText(Math.max(0, v.now - j.queuedAt))
        : "not recorded",
      j.why === "host-budget"
        ? html`${ui.badge("idle", "Waits for the budget")}<span class="reason">Host budget (${j.budgetWhy ?? "dimension not recorded"}); asks again about every 9 seconds and keeps its place.</span>`
        : (j.why ?? "No reason was recorded"),
      canAct(v) &&
      j.attemptsMade === 0 &&
      j.stalled === 0 &&
      !j.recovery &&
      !j.schedulerNext
        ? ui.actForm({
            action: "cancel-queued",
            hidden: [
              ["jobId", j.jobId],
              ["queue", j.queue],
            ],
            label: "Cancel",
            kind: ["danger", "sm"],
          })
        : null,
    ]);
  return html`${ui.tbl({
    label: t(v, "Jobs on the host"),
    stack: true,
    heads: ["Project and job", "Size", "How long", "State", "Action"].map((label) => t(v, label)),
    rows,
    empty: t(v, "No running, orphaned or waiting job was read for this host."),
  })}${
    h?.jobsUnreadable
      ? html`<p>The host's running-job list is unreadable.</p>`
      : null
  }${
    h?.jobsMore
      ? html`<p>${h.jobsMore} more running jobs were not listed.</p>`
      : null
  }${
    !s.waiting || s.waiting.unreachable
      ? html`<p>Waiting jobs could not be read.</p>`
      : s.waiting.truncated
        ? html`<p>Not every waiting job was read.</p>`
        : null
  }`;
});

/** Hatched room belongs to an orphan, so it is neither free nor another running job's promise. */
const budgetMeter = (h, key, usedKey, title, divisor) => {
  const total = num(h[key]);
  const used = num(h[usedKey]);
  const complete =
    Array.isArray(h.jobs) && h.jobsMore === 0 && !h.jobsUnreadable;
  const held = complete
    ? jobsOf(h)
        .filter((j) => j.o)
        .reduce(
          (n, j) => n + Number(j[key === "budgetMemMiB" ? "m" : "c"] ?? 0),
          0,
        )
    : null;
  if (total === null || total <= 0 || used === null)
    return html`<p>${title}: ${h[key] === "off" ? "off (no budget)" : "budget not known yet or unreadable"}.</p>`;
  const solid = Math.max(
    0,
    Math.min(100, ((used - (held ?? 0)) / total) * 100),
  );
  const hatch =
    held === null
      ? 0
      : Math.max(0, Math.min(100 - solid, (held / total) * 100));
  const n = (value) => ui.svgNum(value, 0, 100);
  return html`<div class="hd-bud"><span class="hd-bud__l">${title}</span><svg class="hd-bud__bar" height="14" role="meter" aria-label="${title}: ${used / divisor} used of ${total / divisor}; ${held === null ? "orphan split not known" : `${held / divisor} held by orphans`}" aria-valuenow="${n(Math.min(100, (used / total) * 100))}" aria-valuemin="0" aria-valuemax="100"><rect class="hd-bed" width="100%" height="14" rx="7"/><rect class="hd-used" width="${n(solid)}%" height="14" rx="7"/>${held === null ? null : html`<rect class="hd-held" x="${n(solid)}%" width="${n(hatch)}%" height="14" fill="url(#hatch)"/><line class="hd-sep" x1="${n(solid)}%" x2="${n(solid)}%" y1="0" y2="14"/>`}</svg><span class="hd-bud__v"><b>${used / divisor}</b> of ${total / divisor} ${divisor === 1024 ? "GiB" : "cores"}</span></div><span class="sr">${held === null ? "The orphan budget split is not known because the job inventory is incomplete." : `${held / divisor} held by orphans; ${Math.max(0, total - used) / divisor} free.`}</span>`;
};
const budgetLegend = () =>
  html`<div class="hd-key"><span><i class="hd-k hd-k--used"></i>promised to running jobs</span><span><i class="hd-k hd-k--held"></i>held by an orphaned container</span><span><i class="hd-k"></i>free</span></div>`;

export function budgetOriginText(origin) {
  if (!origin) return "Not published by this worker";
  const figure = (n, scale) =>
    n === null || n === undefined ? "unknown" : Number(n) / scale;
  const dimension = (mode, total, reserve, scale, unit) =>
    mode === "off"
      ? `${unit} budget off`
      : mode === "auto"
        ? `${unit} auto: the machine's ${figure(total, scale)} less a ${figure(reserve, scale)} reserve`
        : mode === "value"
          ? `${unit} explicitly set`
          : `${unit} origin not published`;
  return `${dimension(origin.memMode, origin.memTotalMiB, origin.memReserveMiB, 1024, "GiB")}; ${dimension(origin.cpuMode, origin.cpuTotalCenti, origin.cpuReserveCenti, 100, "cores")}`;
}

const CPU_RESERVE_TEXT = {
  held: "Every job runs under pidispatch.slice, whose quota is the CPU budget.",
  "no-parent":
    "The runtime has no parent cgroup in which the worker can hold the CPU reserve.",
  unmanaged: "This venue does not manage a shared CPU reserve for its jobs.",
  "budget-unknown":
    "The CPU budget is not known yet, so its reserve cannot be checked.",
  unreadable: "The runtime's CPU reserve could not be read.",
  unset: "No CPU quota is set on the parent slice, so the reserve is not held.",
  differs:
    "The parent slice's CPU quota differs from this worker's CPU budget.",
};
const cpuReserveText = (rows) =>
  !Array.isArray(rows)
    ? "Not published"
    : rows.length === 0
      ? "No CPU reserve was published for a venue."
      : html`${rows.map((r) => html`<p><span class="code">${r.venue}</span>: <b>${r.status}</b>. ${CPU_RESERVE_TEXT[r.status] ?? "This console has no explanation for this reserve state."}${r.wantCenti !== null && r.wantCenti !== undefined ? ` Wanted ${r.wantCenti / 100} cores.` : ""}${r.quotaCenti !== null && r.quotaCenti !== undefined ? ` Observed quota ${r.quotaCenti / 100} cores.` : ""}</p>`)}`;
const seedText = (value) =>
  value === "listed"
    ? "Listed: the worker counted the job containers left from before it started."
    : typeof value === "string" && value.startsWith("unlisted:")
      ? `Not listed on ${value.slice(9)}: this host admits no new job on those venues until their old containers can be counted.`
      : "The old-container listing was not published.";

export const hostBudget = card("Slots and budget", (h, v) => {
  if (!h) return gone(v);
  const orphans = jobsOf(h).filter((j) => j.o).length;
  const running = jobsOf(h).length - orphans;
  const slots = num(h.concurrency);
  const projects = [
    ...new Set(
      [
        ...jobsOf(h).map((j) => j.p),
        ...(v.data?.snapshot?.waiting?.rows ?? [])
          .filter((j) => j.host === h.name)
          .map((j) => j.project),
      ].filter(Boolean),
    ),
  ];
  const rules = projects.map((id) => ({
    id,
    ...projectBudgetRow(v.data?.snapshot?.scopedLimits?.limits ?? [], id),
  }));
  const jobsKnown =
    !h.jobsUnreadable &&
    Array.isArray(h.jobs) &&
    h.jobsMore === 0 &&
    slots !== null &&
    slots > 0 &&
    beatAgeOf(h) !== null &&
    beatAgeOf(h) <= 60000;
  const readable = !h.jobsUnreadable && Array.isArray(h.jobs);
  const complete = readable && h.jobsMore === 0;
  const occupied = complete
    ? `${jobsKnown ? "" : "Last published: "}${running + orphans} of ${slots ?? "unknown"} slots taken: ${running} running, ${orphans} held by orphaned containers.`
    : readable && running + orphans > 0
      ? `At least ${running + orphans} occupied ${running + orphans === 1 ? "slot is" : "slots are"} listed: ${running} running, ${orphans} held by orphaned containers. The whole occupied count is not known.`
      : "The occupied slot count is not known: the job inventory was not read whole.";
  return html`<div class="hd-slots hd-sls">${
    jobsKnown
      ? ui.slots({
          run: running,
          hold: orphans,
          free: Math.max(0, slots - running - orphans),
        })
      : html`<p> Free slots are not known: this host is late or its running-job list was not read whole. </p>`
  } <p> ${occupied} PI_CONCURRENCY ${slots ?? "unknown"}. </p></div> ${budgetMeter(
    h,
    "budgetMemMiB",
    "usedMemMiB",
    "Memory",
    1024,
  )}${budgetMeter(
    h,
    "budgetCpuCenti",
    "usedCpuCenti",
    "CPU",
    100,
  )}${budgetLegend()}${ui.facts(
    [
      ["Budget origin", budgetOriginText(h.budgetFrom)],
      [
        "Waiting for it",
        html`<b>${h.waiters ?? "not published"}</b> jobs. ${(v.data?.snapshot?.waiting?.rows ?? []).filter((job) => job.host === h.name && job.why === "host-budget").map((job) => html`<p>${runLink(job.jobId)}${job.project ? html` ${ui.ptag(job.project)}` : null}, ${sizeText(job.size ?? v.data?.snapshot?.defaultSize)}; ${job.budgetWhy ?? "dimension not recorded"}.</p>`)}`,
      ],
      [
        "Room for oldest waiter",
        `${h.heldMemMiB ?? "unknown"} MiB and ${h.heldCpuCenti === undefined || h.heldCpuCenti === null ? "unknown" : Number(h.heldCpuCenti) / 100} cores`,
      ],
      ["CPU reserve", cpuReserveText(h.cpuReserve)],
      ["Old containers", seedText(h.budgetSeed)],
    ],
    { cols: 1 },
  )} <p class="note"> A host admits no job on a venue whose old containers it could not list. Project hostShare and minJobs rules still apply. ${rules.map((r) => `${r.id}: hostShare ${r.hostShare === null ? "unlimited" : `${r.hostShare}%`}, minJobs ${r.minJobs}`).join("; ") || "No project rules apply to the jobs read on this host."} </p>`;
});

/** Capacity uses the same seven-day fold as Spend; only geometry is drawn here. */
export const hostCapacity = card("Last 7 days", (_h, v) => {
  const cap = v.data?.hostCapacity;
  const host = cap?.hosts?.[0];
  const facts = host?.facts;
  const windowMs = Number(cap?.window?.toMs) - Number(cap?.window?.fromMs);
  const buckets = Array.isArray(host?.buckets) ? host.buckets : [];
  const validChart =
    host &&
    Number.isFinite(windowMs) &&
    windowMs > 0 &&
    Number(cap.window.bucketMs) > 0 &&
    buckets.length > 0;
  const percent = (ms) =>
    `${Math.round(Math.max(0, Math.min(1, ms / windowMs)) * 100)}%`;
  const covered = buckets.reduce(
    (total, b) => total + Math.max(0, Number(b.coveredMs) || 0),
    0,
  );
  const busy = buckets.reduce(
    (total, b) => total + Math.max(0, Number(b.busyMs) || 0),
    0,
  );
  const wait95 = /p95\s+([^,(]+)/.exec(facts?.wait ?? "")?.[1]?.trim();
  const wait50 = /p50\s+([^,(]+)/.exec(facts?.wait ?? "")?.[1]?.trim();
  const kpis = facts
    ? html`<div class="hd-kpis">${[
        [validChart ? percent(busy) : facts.busy, "busy in the full window"],
        [
          validChart ? percent(Math.max(0, covered - busy)) : facts.idle,
          "idle in the full window",
        ],
        [
          validChart
            ? percent(Math.max(0, windowMs - covered))
            : (facts.missing ?? "not known"),
          "no history",
        ],
        [
          facts.avg,
          `of ${facts.slots ?? "unknown"} slots on average, peak ${facts.peak}; where history is known`,
        ],
        [facts.full ?? "not known", "of the covered time full"],
        [
          wait95 ?? "not recorded",
          `wait for a slot, p95${wait50 ? ` (p50 ${wait50})` : ""}`,
        ],
      ].map(
        ([value, title]) =>
          html`<div><b>${value}</b><span>${t(v, title)}</span></div>`,
      )}</div>`
    : html`<p>${t(v, host?.notShared ?? (host?.empty ? "No capacity history here for this host." : "The host's capacity history could not be read."))}</p>`;
  let graph = null;
  if (validChart) {
    const max = Math.max(
      1,
      Number(host.slots) || 0,
      ...buckets.map((b) => Number(b.peak) || 0),
    );
    const x = (at) =>
      32 +
      Math.max(0, Math.min(600, ((at - cap.window.fromMs) / windowMs) * 600));
    const y = (count) => 122 - Math.max(0, Math.min(98, (count / max) * 98));
    const n = (value) => ui.svgNum(value, 0, 640);
    const dates = Array.from(
      { length: 7 },
      (_, day) => cap.window.fromMs + ((day + 0.5) * windowMs) / 7,
    );
    graph = html`<svg class="hd-chart" viewBox="0 0 640 158" role="img" aria-label="${label(v)} ${t(v, "over the last seven days: jobs at once on average, peak ticks, slot ceiling and no-history time")}"><defs><pattern id="host-cap-nodata" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect class="hd-nd-bg" width="6" height="6"/><rect class="hd-nd-ln" width="2" height="6"/></pattern></defs><rect x="32" y="24" width="600" height="98" fill="url(#host-cap-nodata)"/>${[0, max / 2, max].map((level) => html`<line class="hd-axis" x1="32" x2="632" y1="${n(y(level))}" y2="${n(y(level))}"/><text class="hd-tick" x="26" y="${n(y(level) + 4)}" text-anchor="end">${Number(level.toFixed(1))}</text>`)}${buckets.map(
      (b) => {
        const duration = Math.max(
          0,
          Math.min(cap.window.bucketMs, cap.window.toMs - b.fromMs),
        );
        const known = Math.max(0, Math.min(duration, Number(b.coveredMs) || 0));
        const knownStart = b.fromMs + duration - known;
        const left = x(knownStart);
        const width = Math.max(0, x(b.fromMs + duration) - left);
        if (known === 0)
          return html`<g><title>${timeText(b.fromMs)}: ${t(v, "no history, neither busy nor idle")}</title></g>`;
        const average = Math.max(0, (Number(b.avgMilli) || 0) / 1000);
        return html`<g><title>${timeText(b.fromMs)}: ${t(v, "average")} ${average}, ${t(v, "peak")} ${b.peak ?? t(v, "unknown")}; ${t(v, "coverage begins")} ${timeText(knownStart)}</title><rect x="${n(left)}" y="24" width="${n(width)}" height="98" fill="var(--surface)"/><rect class="hd-bar" x="${n(left + 0.25)}" y="${n(y(average))}" width="${n(Math.max(0, width - 0.5))}" height="${n(122 - y(average))}" rx="1"/>${Number(b.peak) > 0 ? html`<line class="hd-peak" x1="${n(left)}" x2="${n(left + width)}" y1="${n(y(Number(b.peak)))}" y2="${n(y(Number(b.peak)))}"/>` : null}</g>`;
      },
    )}${host.slots !== null && host.slots !== undefined ? html`<line class="hd-slotline" x1="32" x2="632" y1="${n(y(Number(host.slots)))}" y2="${n(y(Number(host.slots)))}"/><text class="hd-tick" x="632" y="${n(Math.max(12, y(Number(host.slots)) - 6))}" text-anchor="end">${host.slots} ${t(v, "slots")}</text>` : null}<line class="hd-axis" x1="32" x2="632" y1="122" y2="122"/>${dates.map((at) => html`<text class="hd-tick" x="${n(x(at))}" y="143" text-anchor="middle">${new Date(at).toISOString().slice(5, 10)}</text>`)}</svg><div class="hd-key"><span><i class="hd-k hd-k--bar"></i>${t(v, "jobs at once, on average")}</span><span><i class="hd-k hd-k--peak"></i>${t(v, "the most at once")}</span><span><i class="hd-k hd-k--slot"></i>${t(v, "slots")}</span><span><i class="hd-k hd-k--nd"></i>${t(v, "no history: neither busy nor idle")}</span></div>`;
  }
  return html`${kpis}${graph}${
    facts
      ? ui.facts(
          [
            [
              t(v, "Promised"),
              `${facts.memory ?? t(v, "memory not recorded")}; ${facts.cpu ?? t(v, "CPU not recorded")}`,
            ],
            [t(v, "CPU used"), facts.cpuUsed ?? t(v, "not recorded")],
            [t(v, "By run time"), facts.projects?.join(", ") || t(v, "none recorded")],
          ],
          { cols: 1 },
        )
      : null
  }<ul class="mini-list hd-cav"><li class="tone-attention">${ui.icon("attention", { size: "sm" })}<span>${t(v, "Jobs only: a machine busy with other work reads as idle. This seven-day report is read on page load, never on a live tick.")}</span></li>${cap?.truncated || host?.truncated ? html`<li>${ui.icon("info", { size: "sm" })}<span>${t(v, "Capacity history was truncated; earlier time is no history.")}</span></li>` : null}${(cap?.coverage ?? []).map((line) => html`<li>${ui.icon("info", { size: "sm" })}<span>${t(v, line)}</span></li>`)}${(host?.caveats ?? []).map((line) => html`<li>${ui.icon("info", { size: "sm" })}<span>${t(v, line)}</span></li>`)}</ul>${host?.notes ? html`<p class="note">${host.notes}</p>` : null}${v.role === "operator" ? ui.cmd(["pi-dispatch", "capacity", "--host", label(v), "--since", "7d"]) : null}`;
});
const timeText = (ms) =>
  Number.isFinite(ms) && ms >= 0 && ms <= 253402300799999
    ? new Date(ms).toISOString().slice(0, 16)
    : "unknown";

export const hostRow = card("Registry row", (h, v) =>
  h
    ? html`${ui.facts(
        [
          [
            "Worker",
            html`<b>${h.version ?? "not published"}</b>${h.startedAt ? html`, started ${timeHtml(Number(h.startedAt))}` : null}<span class="note">pid ${h.pid ?? "not published"}</span>`,
          ],
          [
            "Job image",
            html`<span class="code hd-image">${h.image ?? "not published"}</span>`,
          ],
          [
            "Image digest",
            html`<span class="code" title="${h.imageDigest ?? "not published"}">${typeof h.imageDigest === "string" && h.imageDigest.length > 32 ? `${h.imageDigest.slice(0, 19)}…${h.imageDigest.slice(-8)}` : (h.imageDigest ?? "not published")}</span>. ${!h.imageDigest || (v.data?.snapshot?.hostBudgets ?? []).some((peer) => !peer.imageDigest) ? "Image digest comparison is not known until every live host publishes one." : (v.data?.snapshot?.hostBudgets ?? []).every((peer) => peer.imageDigest === h.imageDigest) ? "Every live host has the same image digest." : "Live hosts have different image digests."}`,
          ],
          ["pi version", h.piVersion],
          [
            "Time zone",
            html`${h.tz ?? h.timezone ?? "not published"}${
              h.tz || h.timezone
                ? (v.data?.snapshot?.hostBudgets ?? []).every(
                    (peer) =>
                      (peer.tz ?? peer.timezone) === (h.tz ?? h.timezone),
                  )
                  ? ". Every live host has the same time zone."
                  : ". Live hosts have different time zones."
                : ""
            }`,
          ],
          [
            "Queues",
            h.routes === false || h.routes === "false"
              ? "pi-jobs (shared queue only)"
              : `pi-jobs, ${hostQueueName(h.name)}`,
          ],
          [
            "Venues and floor",
            h.backends
              ? `${h.backends.blessed.join(", ")} (default ${h.backends.default}); floor: ${
                  Object.entries(h.backends.floor ?? {})
                    .map(([key, word]) => `${key}=${word}`)
                    .join(", ") || "none"
                }`
              : "not published",
          ],
          [
            "Profiles",
            html`${Array.isArray(h.caps) && h.caps.length ? h.caps.map((cap) => html`<span>${cap.startsWith("s:") ? "secret" : cap.startsWith("w:") ? "wait" : "profile"} <span class="code">${cap.slice(2)}</span></span>`) : "No profiles published"}<span class="note">Jobs that need these profiles are routed to this host.</span>`,
          ],
          [
            "Matches the fleet",
            html`<div class="hd-fp">${["fpCron", "fpProjects"].every((key) => h[key] && (v.data?.snapshot?.hostBudgets ?? []).every((peer) => peer[key] === h[key])) ? ui.chip("all published fingerprints match", { status: "ok", icon: "done" }) : ui.chip("compare fingerprints", { status: "attention", icon: "attention" })}<span class="muted">triggers, projects</span></div><details><summary>Fingerprints</summary>${[
              ["triggers", "fpCron"],
              ["projects", "fpProjects"],
            ].map(
              ([title, key]) =>
                html`<p>${title}: <span class="code">${h[key] ?? "not published"}</span>${h[key] ? ((v.data?.snapshot?.hostBudgets ?? []).some((peer) => !peer[key]) ? " (comparison not known until every live host publishes it)" : (v.data?.snapshot?.hostBudgets ?? []).every((peer) => peer[key] === h[key]) ? " (matches every live host)" : " (differs across live hosts)") : ""}</p>`,
            )}</details>`,
          ],
        ],
        { cols: 1 },
      )} <p> Last beat ${ageText(beatAgeOf(h))} ago. Every 15s. The row expires after 90s without one. </p> ${
        h.noExpiry
          ? html`<p class="warn"> This row has no expiry and may outlive its host. </p>`
          : null
      }`
    : html`${gone(v)}${
        v.data?.hostHistory?.records?.length
          ? html`<p> Last seen ${(() => {
              const record = v.data.hostHistory.records[0];
              const at = Date.parse(record.endedAt ?? record.startedAt ?? "");
              return Number.isFinite(at)
                ? timeHtml(at)
                : "at an unrecorded time";
            })()} in ${v.data.hostHistory.records.length} retained run records. </p>`
          : html`<p>No retained run record names this host.</p>`
      }`,
);

export const hostDoctor = (v) => {
  const s = v.data?.snapshot ?? {};
  const d = doctorHostsOf(s).find((row) => row.name === label(v));
  const checks = Array.isArray(d?.checks) ? d.checks : [];
  const sections =
    d && !d.unreadable
      ? html`<p class="sect-h">${t(v, "Sections")} <span class="faint">· ${DOCTOR_SECTIONS.filter((section) => checks.some((c) => c.id?.startsWith(`${section}.`))).length} ${t(v, "ran")}</span></p><ul class="hd-secs">${DOCTOR_SECTIONS.map(
          (section) => {
            const found = checks.filter((c) => c.id?.startsWith(`${section}.`));
            const fails = found.filter((c) => c.level === "fail").length;
            const warns = found.filter((c) => c.level === "warn").length;
            const state = fails
              ? "failing"
              : warns
                ? "warning"
                : found.length
                  ? "passing"
                  : "not run on this host";
            return html`<li class="hd-sec${fails ? " tone-failed" : warns ? " tone-attention" : found.length ? "" : " hd-sec--off"}" aria-label="${section}: ${t(v, state)}">${ui.icon(fails ? "failed" : warns ? "attention" : found.length ? "done" : "minus", { size: "sm" })}${section}${fails || warns ? html`<b>${[fails ? `${fails} ${t(v, "failing")}` : null, warns ? `${warns} ${t(v, "warning")}` : null].filter(Boolean).join(", ")}</b>` : null}</li>`;
          },
        )}</ul><p class="hd-seckey"><span>${ui.icon("done", { size: "sm" })}${t(v, "every check passed")}</span><span>${ui.icon("failed", { size: "sm" })}${t(v, "a check fails or warns")}</span><span>${ui.icon("minus", { size: "sm" })}${t(v, "not run on this host")}</span></p>`
      : null;
  const problems = d ? doctorProblems(d) : [];
  const hidden =
    Math.max(0, problems.length - DOCTOR_CHECKS_SHOWN) + Number(d?.more ?? 0);
  const state = !d
    ? html`<p>${t(v, "No doctor result published by this host. Run doctor on this host to publish its result.")}</p>`
    : d.unreadable
      ? html`<p>${t(v, "Its published result cannot be read (a worker of another version may have written it).")}</p>`
      : html`<p class="hd-docline tinted ${d.counts?.fail ? "tone-failed" : d.counts?.warn ? "tone-attention" : "tone-ok"}">${ui.icon(d.counts?.fail ? "failed" : d.counts?.warn ? "attention" : "done", { size: "sm" })}<span>${t(v, "Doctor ran")} ${ageText(d.ageMs)} ${t(v, "ago")}${d.version ? ` (${t(v, "version")} ${d.version})` : ""}, ${t(v, doctorByText(d))}: ${t(v, doctorCountsText(d))}</span></p>${doctorStale(d) ? ui.banner({ status: "attention", icon: "clock", sm: true, title: `${t(v, "Stale: older than two of this host's doctor runs")} (${t(v, "every")} ${d.every}h)`, body: `${t(v, "So it may no longer describe the host. Run doctor on")} ${label(v)} ${t(v, "to publish a fresh result.")}` }) : null}${d.workerRun && !d.by?.worker ? html`<p>${t(v, "It replaced the worker's own run")}${d.workerRun.uid !== undefined ? ` (uid ${d.workerRun.uid})` : ""}${t(v, ", so it shows another account's view of the host.")}</p>` : null}`;
  const problemsHtml =
    d && !d.unreadable
      ? html`<p class="sect-h">${t(v, "Failing first, then warnings")}</p>${problems.length ? html`<ul class="fl-chks">${problems.slice(0, DOCTOR_CHECKS_SHOWN).map((c) => html`<li class="fl-chk"><span class="badge tone-${c.level === "fail" ? "failed" : "attention"}">${ui.icon(c.level === "fail" ? "failed" : "attention", { size: "sm" })}${t(v, c.level === "fail" ? "Failing" : "Warning")}</span><span class="code">${c.id}</span><span class="fl-chk__said">${c.label}</span><span class="fl-chk__fix"><b>${t(v, "Fix:")}</b> ${c.fix}</span></li>`)}</ul>` : html`<p>${t(v, "Every check passed.")}</p>`}${hidden ? html`<p>${hidden} ${t(v, "more not shown here; doctor on this host prints them all.")}</p>` : null}`
      : null;
  return ui.card({
    title: t(v, "Doctor"),
    sub: t(v, "visible to viewers; paths and secrets redacted at the source"),
    body: html`${state}${sections}${problemsHtml}${v.role === "operator" ? ui.cmd(["pi-dispatch", "doctor"], { host: label(v) }) : html`<p>${t(v, "Run doctor on this host to inspect its checks.")}</p>`}`,
  });
};
