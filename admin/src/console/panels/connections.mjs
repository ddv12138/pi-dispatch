/** The ConnectionsScreen card, from page-specific, already projected deployment facts (#751). */
import { RECEIVER_FORGES, RECEIVER_OUTCOMES, receiverForgeFacts } from "@edgehero/pi-dispatch/receiver-status";
import { html } from "../html.mjs";
import * as ui from "../kit.mjs";
import { uiText } from "../locale.mjs";
import { table } from "./config-ui.mjs";
import { ageText, timeHtml, utcText } from "./common.mjs";
import { docsHref } from "../../words.mjs";
import { hookRunsView } from "@edgehero/pi-dispatch/hook-runs";

const data = (view) => view.data?.connections ?? null;
const t = (message, view) => uiText(message, view?.locale);
const operator = (view) => view.role === "operator" && !view.readOnly;
const triggerLink = (i, locale = "en") => html`<a href="${`/config/trigger?index=${i}`}">${uiText("trigger", locale)} ${i + 1}</a>`;
const triggers = (rows, locale = "en") => rows.length ? html`${rows.map((i, n) => html`${n ? ", " : null}${triggerLink(i, locale)}`)}` : uiText("no trigger", locale);
const unknown = (view) => view.role === "agent" ? html`<p>${state(uiText("not published in this agent view", view.locale), "idle", "info")}</p>` : html`<p>${state(uiText("connection facts unavailable", view.locale), "attention", "info")} ${uiText("Reload to try again.", view.locale)}</p>`;
const card = (view, title, body, sub = null) => ui.card({ title: t(title, view), sub: sub === null ? null : t(sub, view), body: data(view) ? body({ ...data(view), locale: view.locale }) : unknown(view) });
const hostLink = (name) => html`<a href="${`/fleet/host?name=${encodeURIComponent(name)}`}">${name}</a>`;
const state = (word, tone = "idle", glyph = tone === "ok" ? "done" : tone === "failed" ? "failed" : tone === "attention" ? "attention" : "minus") => html`<span class="cn-state tone-${tone}">${ui.icon(glyph, { size: "sm" })}<span>${word}</span></span>`;
const cell = (first, second = null) => html`<span class="cn-cell"><span>${first}</span>${second === null ? null : html`<small>${second}</small>`}</span>`;
const docs = (path, label) => ui.outLink({ href: docsHref(path), label });
const detailTable = (label, heads, rows, empty, locale = "en") => ui.tbl({ label: uiText(label, locale), heads: heads.map((h) => uiText(h, locale)), rows, empty: uiText(empty, locale), stack: true });

function polling(poll, locale = "en") {
  const tr = (s) => uiText(s, locale);
  if (!poll) return state(tr("not offered"));
  if (poll.state === "off") return state(tr("off"));
  if (poll.state !== "on") return state(tr("unknown"), "attention", "info");
  return cell(html`${state(tr("on"), "ok")} · ${poll.seconds} s`, html`${poll.source === "app-installation" ? tr("App installation repositories") : "POLL_REPOS"}${poll.repos.length ? html` · ${poll.repos.join(", ")}` : null}`);
}

function forgeRow(f, locale = "en") {
  const tr = (s) => uiText(s, locale);
  if (f.enabled === false) return { cells: [html`<b>${f.name}</b>`, state(tr("not configured")), { html: html`<span class="muted">${tr("No activation setting")}${f.name === "github" ? tr(" or active GitHub trigger") : ""} ${tr("names it.")}</span>`, wide: true }, { html: html`<span class="muted">${tr("path")} <span class="code">${f.path}</span> ${tr("answers 404")}</span>`, wide: true }, { html: null, hidePhone: true }, { html: null, hidePhone: true }] };
  const auth = f.auth.split("; ");
  const enabled = f.enabled === null ? state(tr("configuration unknown"), "attention", "info") : state(html`${tr("armed by")} ${f.triggers.length ? html`${f.triggers.length === 1 ? tr("trigger") : tr("triggers")} ${f.triggers.map((index, n) => html`${n ? ", " : null}<a href="${`/config/trigger?index=${index}`}" aria-label="${`Trigger ${index + 1}`}">${index + 1}</a>`)}` : tr("settings")}`, "ok");
  const secret = f.secret.set === null ? state(tr("unknown"), "attention", "info") : f.secret.set ? state(tr("set"), "ok") : state(tr("not set"), "attention", "failed");
  return { cells: [html`<b>${f.name}</b>`, cell(enabled, f.triggers.length || !f.activationKeys.length ? null : html`<span class="code">${f.activationKeys.join(", ")}</span>`), { html: cell(auth[0], auth.length > 1 ? auth.slice(1).join("; ") : null), wide: true }, { html: cell(html`${tr(f.verification)}, <span class="code">${f.secret.key}</span> ${secret}`, html`${tr("path")} <span class="code">${f.path}</span> · ${tr("duplicates by")} <span class="code">${f.deliveryId.replace(/ GUID$/, "")}</span>`), wide: true }, { html: polling(f.polling, locale), wide: true }, { html: uiText(f.access, locale), wide: true }] };
}

function proxyState(host) {
  if (host.unreadable) return state(t("unavailable", host), "attention", "info");
  if (!host.proxy) return state(t("not published", host));
  if (host.proxy.level === "ok") return state(t("running", host), "ok");
  if (host.proxy.level === "fail") return state(t("missing", host), "failed");
  return state(t("check warning", host), "attention");
}

function slotPicture(used, slots) {
  if (!Number.isInteger(used) || !Number.isInteger(slots) || slots > 8) return null;
  const count = Math.min(slots, 8);
  return html`<svg class="cn-slots" viewBox="${`0 0 ${count * 12} 12`}" width="${count * 12}" height="12" aria-hidden="true">${Array.from({ length: count }, (_, i) => html`<circle class="${i < used ? "cn-slot-used" : "cn-slot-free"}" cx="${i * 12 + 6}" cy="6" r="4"/>`)}</svg>`;
}

function endpointSlots(endpoint, locale = "en") {
  const tr = (s) => uiText(s, locale);
  let fleet;
  if (endpoint.counting === "fleet" && Number.isInteger(endpoint.used) && endpoint.used >= 0) {
    fleet = html`<span>${tr("Fleet leases:")} ${slotPicture(endpoint.used, endpoint.slots)} ${endpoint.used}${Number.isInteger(endpoint.slots) ? html` ${tr("of")} ${endpoint.slots}` : ` ${tr("in use")}`}${endpoint.used > endpoint.slots && Number.isInteger(endpoint.slots) ? ` (${tr("leases exceed the current declaration")})` : ""}</span>`;
  } else if (endpoint.counting === "fleet") fleet = html`<span>${tr("Fleet leases:")} ${state(tr("unknown"), "attention", "info")}${Number.isInteger(endpoint.slots) ? html` · ${endpoint.slots} ${tr("declared here")}` : null}</span>`;
  else {
    const why = endpoint.counting === "per-machine" ? tr("per-machine endpoint, no fleet bound") : endpoint.counting === "worker-name-absent" ? tr("PI_WORKER_NAME not declared in .env, no fleet bound") : endpoint.counting === "host-only" ? tr("no fleet bound") : tr("fleet counting unavailable");
    fleet = html`<span>${tr("Fleet leases:")} ${state(["per-machine", "worker-name-absent", "host-only"].includes(endpoint.counting) ? tr("not counted") : tr("unknown"), ["per-machine", "worker-name-absent", "host-only"].includes(endpoint.counting) ? "idle" : "attention", ["per-machine", "worker-name-absent", "host-only"].includes(endpoint.counting) ? "minus" : "info")} · ${Number.isInteger(endpoint.slots) ? `${endpoint.slots} ${tr("declared")} · ` : ""}${why}</span>`;
  }
  return { html: html`<div class="cn-cell">${fleet}${Number.isInteger(endpoint.declaredSlots) ? html`<small>${tr("Declared here:")} ${endpoint.declaredSlots} ${tr("slots.")}</small>` : null}${(endpoint.hostCounts ?? []).length ? html`<ul class="cn-endpoint-hosts" aria-label="${`${endpoint.id} host slot counts`}">${endpoint.hostCounts.map((h) => html`<li data-host="${h.name}">${hostLink(h.name)}: ${slotPicture(h.used, h.slots)} <b>${h.used} of ${h.slots}</b>${h.used > h.slots ? ` (${tr("capacity lowered while slots are held")})` : null}<small>${h.fleet ? tr("shared fleet bound") : tr("host only, no fleet bound")}${h.ageMs === null ? ` · ${tr("beat age unknown")}` : html` · beat ${ageText(h.ageMs)} ${tr("ago")}`}</small></li>`)}</ul>` : html`<small>${tr("Host occupancy not reported.")}</small>`}</div>`, wide: true };
}

export function connectionsDescription(locale = "en") {
  return uiText("Where jobs come from, what they may reach, and who hears about failures. Names and hosts only.", locale);
}

function problemText(text, locale) {
  if (locale !== "zh") return text;
  const refused = /^Refused on (.+): its egress proxy is not running$/.exec(text);
  if (refused) return `拒绝在 ${refused[1]} 上运行：该主机的出口代理未运行`;
  const forge = /^Forge connection failing on (.+)$/.exec(text);
  if (forge) return `${forge[1]} 上的代码托管连接失败`;
  const endpoints = /^(.+) reads its own model-endpoints file, and it does not load$/.exec(text);
  if (endpoints) return `${endpoints[1]} 使用自己的 model-endpoints 文件，但该文件无法加载`;
  const exact = {
    "The host's doctor says its egress proxy is unavailable.": "主机的 doctor 检查报告出口代理不可用。",
    "Run pi-dispatch up on that host.": "请在该主机运行 pi-dispatch up。",
    "The host's forge check failed.": "主机的代码托管平台检查失败。",
    "Check the forge credentials with doctor on that host.": "请在该主机运行 doctor 检查代码托管凭据。",
    "The host's endpoints file does not load.": "主机的端点文件无法加载。",
    "Correct model-endpoints.json on that host, then render its egress rules.": "请在该主机修正 model-endpoints.json，然后重新生成出口规则。",
    "Set WEBHOOK_SECRET for the receiver, then restart it.": "请为 receiver 设置 WEBHOOK_SECRET，然后重启 receiver。",
  };
  return exact[text] ?? text;
}

export function connectionsProblems(view) {
  const v = data(view);
  if (!v && view.role === "agent") return ui.banner({ status: "idle", icon: "info", title: uiText("Limited Connections view", view.locale), body: uiText("This agent view publishes typed subscription facts. Other deployment details are not published in this view.", view.locale) });
  if (!v) return ui.banner({ status: "attention", title: uiText("Connection facts unavailable", view.locale), body: uiText("The console could not read this page's sources. Reload to try again.", view.locale) });
  const hit = v.problems[0];
  return html`${hit ? ui.banner({ status: "refused", title: problemText(hit.title, view.locale), body: html`${problemText(hit.text, view.locale)} ${problemText(hit.fix, view.locale)}`, actions: hit.host || hit.run ? html`${hit.host ? ui.btn({ href: `/fleet/host?name=${encodeURIComponent(hit.host)}`, label: `Open ${hit.host}` }) : null}${hit.run ? ui.btn({ href: `/run?id=${encodeURIComponent(hit.run)}`, label: `Open ${hit.run}` }) : null}` : null }) : null}${v.environmentUnknown ? ui.banner({ status: "attention", title: uiText("Deployment metadata could not be read completely", view.locale), body: uiText("Some settings are unknown. Check the deployment's .env and its permissions; no values from an unreadable declaration are shown.", view.locale) }) : null}${v.snapshotUnreadable ? ui.banner({ status: "attention", title: uiText("Fleet facts unavailable", view.locale), body: uiText("The console could not read the host registry, doctor records or trigger facts. File sections remain readable.", view.locale) }) : null}`;
}

function receiverWarnings(v) {
  const tr = (s) => uiText(s, v.locale);
  const read = v.receiver;
  const hosts = (read?.hosts ?? []).filter((h) => !h.unreadable);
  const banners = [];
  if (read?.complete === true) {
    for (const forge of v.forges.filter((f) => f.enabled === true)) {
      if (!hosts.some((h) => h.forges.includes(forge.name))) banners.push(ui.banner({ status: "attention", title: `No live receiver reported for ${forge.name}`, body: tr("The forge is armed. Check the receiver service on its host; an absent observation does not prove the service stopped."), sm: true }));
    }
    for (const forge of RECEIVER_FORGES) {
      const counts = Object.fromEntries(RECEIVER_OUTCOMES.map((word) => [word, hosts.reduce((sum, h) => sum + receiverForgeFacts(h, forge, v.now).counts[word], 0)]));
      if (counts.unauthorized > 0 && RECEIVER_OUTCOMES.every((word) => word === "unauthorized" || counts[word] === 0)) banners.push(ui.banner({ status: "attention", title: `${forge}: ${tr("only unauthorized deliveries in 24 UTC hours")}`, body: tr("Check the webhook secret on both sides."), sm: true }));
    }
  }
  for (const forge of RECEIVER_FORGES) if (hosts.some((h) => receiverForgeFacts(h, forge, v.now).counts["not-configured"] > 0)) banners.push(ui.banner({ status: "attention", title: `${forge}: ${tr("deliveries reached an unconfigured route")}`, body: tr("Check that the receiver serves this forge and that its webhook URL names the right route."), sm: true }));
  return banners;
}

function receiverDeliveries(host, forge, now) {
  const facts = receiverForgeFacts(host, forge, now);
  const rows = RECEIVER_OUTCOMES.map((word) => [html`<span class="code">${word}</span>`, facts.counts[word]]);
  const end = Math.floor(now / 3_600_000) * 3_600_000;
  const byWord = Object.fromEntries(RECEIVER_OUTCOMES.map((word) => [word, new Map(host.deliveries[forge][word].hours)]));
  const hours = Array.from({ length: 24 }, (_, i) => {
    const at = end - (23 - i) * 3_600_000;
    const unobserved = at + 3_600_000 <= host.startedAt;
    const coverage = unobserved ? t("before receiver started", host) : at < host.startedAt ? `${t("since", host)} ${utcText(host.startedAt)}` : t("observed", host);
    return [utcText(at), coverage, ...RECEIVER_OUTCOMES.map((word) => unobserved ? t("not observed", host) : byWord[word].get(at) ?? 0)];
  });
  return html`<h3>${forge}${host.forges.includes(forge) ? null : html` <span class="muted">(${t("not served", host)})</span>`}</h3>${ui.facts([[t("Last taken", host), facts.lastTaken === null ? t("none recorded", host) : timeHtml(facts.lastTaken)], [t("Last refused", host), facts.lastRefused === null ? t("none recorded", host) : timeHtml(facts.lastRefused)]], { cols: 2 })}<details class="cn-receiver-detail"><summary>${forge}: ${t("outcomes in 24 UTC hours", host)}</summary>${detailTable(`${host.name} ${forge} ${t("delivery outcomes", host)}`, ["Outcome", "Count"], rows, "", host.locale)}
  <details><summary>${t("Counts per UTC hour", host)}</summary><p class="muted">${t("Scroll horizontally to compare outcomes. Hours before this receiver started are not observed.", host)}</p><div class="cn-receiver-hours-scroll" role="region" aria-label="${`${host.name} ${forge} ${t("delivery hours, scroll horizontally", host)}`}" tabindex="0">${ui.tbl({ label: `${host.name} ${forge} ${t("delivery counts per UTC hour", host)}`, heads: [t("UTC hour", host), t("Coverage", host), ...RECEIVER_OUTCOMES], rows: hours })}</div></details></details>`;
}

export function connectionsForges(view) {
  return card(view, "Forges", (v) => {
    const read = v.receiver;
    const hosts = read?.hosts ?? [];
    return html`${receiverWarnings(v)}<div class="cn-receivers">${hosts.map((host) => host.unreadable ? html`<p>${hostLink(host.name)}: ${state(t("receiver observation unreadable", v), "attention", "info")}</p>` : html`<section aria-label="${`Receiver on ${host.name}`}"><h3>${t("Receiver on", v)} ${hostLink(host.name)}</h3><p>${t("Port", v)} ${host.port} · ${t(host.bind === "all" ? "all interfaces" : host.bind === "loopback" ? "loopback" : "specific address", v)} · ${t("beat", v)} ${ageText(host.ageMs)} ${t("ago", v)} · ${t("version", v)} ${host.version}. ${t("Observed", v)} ${timeHtml(host.at)}. ${t("Receiver started", v)} ${timeHtml(host.startedAt)}; ${t("counts since then within 24 UTC hours.", v)}</p>${RECEIVER_FORGES.filter((forge) => {
      const facts = receiverForgeFacts(host, forge, v.now);
      // Last-event times outlive the count window, including for a route this process never served.
      return host.forges.includes(forge) || facts.lastTaken !== null || facts.lastRefused !== null || Object.values(facts.counts).some((n) => n > 0);
    }).map((forge) => receiverDeliveries({ ...host, locale: v.locale }, forge, v.now))}</section>`)}</div>${read?.complete !== true ? html`<p>${state(t("Receiver observations could not be read completely", v), "attention", "info")}. ${t("Counts and receiver absence are unknown.", v)}${read?.more ? html` ${read.moreUnknown ? t("At least", v) + " " : null}${read.more} ${t("more hosts were not read.", v)}` : read?.moreUnknown ? ` ${t("Other indexed hosts may not have been read.", v)}` : null}</p>` : hosts.length === 0 ? html`<p>${t("No live receiver reported.", v)}</p>` : null}<p class="muted">${t("Configured receiver port:", v)} ${read?.unknown ? t("unknown", v) : read?.port ?? t("unknown", v)}; ${t("live ports are shown above.", v)}</p><div class="cn-forge-config">${detailTable("Forge connections", ["Forge", "State", "Auth", "Webhook", "Polling", "Who may fire"], v.forges.map((f) => forgeRow(f, v.locale)), "No forge facts available.", v.locale)}</div><p class="cn-note">${ui.icon("info", { size: "sm" })}<span>${t("Counts cover the current UTC hour and the preceding 23. Last-event times are retained separately. Taken means queued, deduplicated, held or steered; filter drops are separate. Refused includes malformed requests, authentication, configuration, lookup, enqueue and internal errors. The forge's delivery history remains available for individual deliveries.", v)}</span></p>`;
  }, "where jobs come from");
}

export function connectionsEgress(view) {
  return card(view, "Egress", (v) => html`${ui.facts([[t("Posture", v), v.egress.on === null ? state(v.egress.problem ? t(v.egress.problem, v) : t("unknown", v), "attention", "info") : v.egress.on ? state(t("on: local and podman jobs reach out only through the host proxy", v), "ok") : state(t("off: jobs reach what their host reaches (PI_EGRESS=0)", v))]], { cols: 1 })}<p class="cn-doc">${docs("docs/egress.md", t("Egress rules and OpenShell policy", v))}</p><h3>${t("Allowlist", v)} <span class="code">egress-allowlist.conf</span></h3>${v.egress.allowlist === null ? html`<p>${state(t("allowlist unavailable", v), "attention", "info")}</p>` : v.egress.allowlist.length ? html`<p class="cn-hosts">${v.egress.allowlist.map((h) => html`<span class="code">${h}</span>`)}${v.egress.more ? html`<span class="muted">${t("and", v)} ${v.egress.more} ${t("more", v)}</span>` : null}</p>` : html`<p class="muted">${t("No host is listed.", v)}</p>`}${detailTable("Egress per host", ["Host", "Proxy", "Checked"], v.egress.hosts.map((h) => [hostLink(h.name), proxyState(h), { html: html`${h.at === null ? state(t("not published", v)) : timeHtml(h.at)}${h.ageMs === null ? null : html`<br>${ageText(h.ageMs)} ${t("ago", v)}`}${h.stale ? html`<br>${state(t("stale", v), "attention")}` : null}`, wide: true }]), t("No host doctor results are available.", v), v.locale)}<p class="cn-note">${ui.icon("info", { size: "sm" })}<span>${t("No proxy check can mean egress off, OpenShell-only or an older doctor; a check is evidence from that time.", v)}</span></p>`, "what jobs may reach");
}

export function connectionsEndpoints(view) {
  return card(view, "Model endpoints", (v) => html`<p class="muted"><span class="code">model-endpoints.json</span>; ${t("fleet leases first, then each host's own slots and last beat.", v)}</p>${v.endpoints === null ? html`<p>${state(t("endpoints unavailable", v), "attention", "info")} ${t("Correct", v)} model-endpoints.json, ${t("then render the deployment's egress rules.", v)}</p>` : html`<div class="cn-endpoint-scroll" tabindex="0" role="region" aria-label="${t("Model endpoint slots and host occupancy", v)}">${detailTable("Model endpoint slots", ["Endpoint", "Host and port", "Key", "Slots in use"], v.endpoints.map((ep) => [{ html: ep.id, id: true }, { html: ep.host === null ? html`<span class="muted">not declared here</span>` : html`<span class="code">${ep.host}:<span class="cn-endpoint-port">${ep.port}</span></span>`, wide: true }, ep.keyless === null ? t("not declared here", v) : ep.keyless ? t("keyless", v) : t("provider key required", v), endpointSlots(ep, v.locale)]), t("No model endpoint is declared.", v), v.locale)}</div>`}${(v.endpoints ?? []).filter((ep) => ep.conflict || ep.mixedScope).map((ep) => ui.banner({ status: "attention", title: `${ep.id}: ${t(ep.conflict ? "hosts declare different slot bounds" : "hosts declare different counting scopes", v)}`, body: ep.conflict ? t("One server, one id: hosts sharing an endpoint id must declare the same slots. Correct model-endpoints.json on those hosts.", v) : t("This id has both a shared fleet bound and host-only declarations. Check that each host uses this id for the intended server.", v), sm: true }))}${v.endpointStatus?.state !== "reported" ? html`<p>${state(t("Host occupancy unknown", v), "attention", "info")} ${t("The host publications could not be read.", v)}</p>` : null}${(v.endpointStatus?.hosts ?? []).filter((h) => h.state !== "reported").map((h) => html`<p>${hostLink(h.name)}: ${state(h.state === "unsupported" ? t("newer occupancy format", v) : h.state === "unreadable" ? t("host occupancy unreadable", v) : t("host occupancy not reported", v), h.state === "not-reported" ? "idle" : "attention", "info")}.</p>`)}${v.endpointStatus?.partial || v.endpointsMore ? html`<p class="muted">${t("Host occupancy is partial.", v)}${v.endpointStatus?.more ? html` ${v.endpointStatus.partial ? `${t("At least", v)} ` : ""}${v.endpointStatus.more} other ${v.endpointStatus.more === 1 ? t("host is", v) : t("hosts are", v)} not listed.` : null}${v.endpointsMore ? html` ${v.endpointStatus?.partial ? `${t("At least", v)} ` : ""}${v.endpointsMore} ${t("other endpoints are not listed.", v)}` : null}${(v.endpointStatus?.hosts ?? []).filter((h) => h.endpointsMore > 0).map((h) => html` ${hostLink(h.name)} ${t("publishes", v)} ${h.endpointsMore} ${t("other endpoints.", v)}`)}</p>` : null}${v.egress.hosts.filter((h) => h.endpoints).map((h) => ui.banner({ status: "attention", title: `${h.name} ${t("reads its own copy of the endpoints file, and it does not load", v)}`, body: html`${t(h.endpoints.label, v)} ${h.endpoints.fix ? html`${t("Fix:", v)} ${h.endpoints.fix}` : null} ${h.ageMs === null ? null : html`${t("Checked", v)} ${ageText(h.ageMs)} ${t("ago.", v)}`}`, actions: ui.btn({ href: `/fleet/host?name=${encodeURIComponent(h.name)}`, label: `${t("Open", v)} ${h.name}` }), sm: true }))}<p class="cn-note"><a class="link" href="#p-provider-keys">${t("Manage provider API keys", v)}</a> ${t("separately from endpoint declarations.", v)}</p>`);
}

export function connectionsNotify(view) {
  return card(view, "Notifications", (v) => {
    const history = hookRunsView(v.notify.history);
    const rows = history.hosts.map((host) => {
      const last = host.runs[0];
      const bad = last && (last.code !== null && last.code !== 0 || ["timeout", "unresolvable", "spawn", "argv-unusable"].includes(last.detail) || last.detail.startsWith("signal-"));
      return [{ html: hostLink(host.name), id: true }, { html: host.unreadable ? state(t("hook history unavailable", v), "attention", "info") : !last ? t("no hook run published", v) : html`${timeHtml(last.at)}<br>${last.jobId === null ? t("run id unavailable", v) : html`<a class="code" href="${`/run?id=${encodeURIComponent(last.jobId)}`}">${last.jobId}</a>`}<br>${state(`${last.detail}${last.code === null ? "" : ` (exit ${last.code})`}`, bad ? "attention" : "idle")}<br><span class="muted">${t("Run:", v)} ${last.outcome ?? t("unknown", v)} · ${last.reason}</span>`, wide: true }, { html: host.counts === null ? t("unknown", v) : Object.keys(host.counts).length ? Object.entries(host.counts).map(([detail, count], index) => html`${index ? html`<br>` : null}${detail}: ${count}`) : t("none", v), wide: true }];
    });
    return html`<ul class="cn-icon-list"><li>${ui.icon("comment")}<span><b>${t("Forge comments:", v)}</b> ${t("on", v)}${v.notify.triggers.length ? html`; ${triggers(v.notify.triggers, v.locale)} ${t(v.notify.triggers.length === 1 ? "also keeps" : "also keep", v)} ${t("a status comment up to date", v)}` : `; ${t("paid failures and requests for input", v)}`}.</span></li><li>${ui.icon("bell")}<span><b>${t("Failure hook:", v)}</b> ${v.notify.unknown ? state(t("configuration unknown", v), "attention", "info") : v.notify.hook ? html`<span class="code">PI_ON_FAILURE</span> → <span class="code">${v.notify.hook}</span>, ${t("once per paid failure.", v)}` : state(t("not set in the .env", v))} </span></li></ul>${history.partial ? html`<p class="cn-note">${state(t("Hook history is incomplete or unavailable", v), "attention", "info")}</p>` : null}<div class="cn-hook-scroll" tabindex="0" role="region" aria-label="${t("Failure hook history", v)}">${detailTable("Failure hook runs", ["Host", "Last hook run", "Retained runs by detail"], rows, history.partial ? t("hook history unavailable", v) : t("no hook run published", v), v.locale)}</div>${history.more ? html`<p class="muted">${history.moreUnknown ? `${t("At least", v)} ` : null}${history.more} ${t("more indexed hosts were not read.", v)}</p>` : null}<p class="cn-note">${ui.icon("info", { size: "sm" })}<span>${t("Up to 20 runs per host, kept until seven days after the last append. An exit code describes the hook, not notification delivery.", v)} ${docs("docs/notifications.md", t("Hook rules", v))}</span></p>`;
  });
}

export function connectionsMcp(view) {
  return card(view, "MCP servers", (v) => {
    const refs = [...new Set((v.mcp?.servers ?? []).flatMap((s) => s.refs ?? []))];
    return html`${v.mcp === null || v.mcp.unreadable ? html`<p>${state(t("overlay MCP file unavailable", v), "attention", "info")}</p>` : !(v.mcp.servers ?? []).length && !(v.mcp.refused ?? []).length ? html`<p class="muted">${t("No overlay MCP server is declared.", v)}</p>` : null}<ul class="rows cn-mcp">${(v.mcp?.servers ?? []).map((s) => ui.rowPill({ icon: "plug", items: [html`<b class="code">${s.name}</b>`, html`<span>${t(s.transport, v)} · <span class="code">${s.where}</span></span>`], end: html`<span class="muted">${t(s.exposure, v)}</span>${s.enabled ? state(t("on", v), "ok") : state(t("off", v))}` }))}${(v.mcp?.refused ?? []).map((name) => ui.rowPill({ icon: "failed", status: "failed", items: [html`<b class="code">${name}:</b>`, html`<span class="tinted">${t("refused,", v)} ${(v.mcp?.problems ?? []).find((p) => p.name === name)?.problem ?? t("the server declaration is not admitted by the worker", v)}.</span>`] }))}${ui.rowPill({ icon: "git", items: [html`<b class="code">forge</b>`, t("GitHub or GitLab, as the job token; merge and approval tools withheld. Version in the job image.", v)] })}</ul><p class="cn-note"><span>${refs.length ? html`${t("References", v)} <span class="code">${refs.join(", ")}</span>. ` : null}${t("Rewritten by", v)} <span class="code">pi-dispatch import-pi</span>; ${t("no form here.", v)}</span></p>`;
  });
}

export function connectionsEnvironment(view) {
  return card(view, "Deployment environment", (v) => {
    const important = new Set(["PI_MAX_COST_USD", "PI_CONCURRENCY", "PI_BACKENDS", "PI_WORKER_NAME", "VALKEY_URL"]);
    const first = v.environment.filter((e) => important.has(e.key) || e.disagrees || !/^(?:not set|unknown)/.test(e.value));
    const rest = v.environment.filter((e) => !first.includes(e));
    const rows = (entries) => entries.map((e) => html`<tr><th scope="row" class="code">${e.key}</th><td>${e.value}${e.disagrees ? html`<br>${state(t("this shell and the .env differ; the service reads the .env", v), "attention")}` : null}</td></tr>`);
    return html`${table("Deployment environment keys", ["Key", "Declaration"], rows(first), "No deployment metadata is available.", v.locale)}${rest.length ? html`<details class="cn-env-rest"><summary>${rest.length} ${t("other keys, not set or unknown", v)}</summary>${table("Other deployment environment keys", ["Key", "Declaration"], rows(rest), "", v.locale)}</details>` : null}<p class="muted">${t("Read from the deployment's .env. Use the Provider API keys card for its confirmed key changes; edit other declarations on the host and restart the service. Each worker may also receive settings from its service environment.", v)}</p>`;
  });
}

export function connectionsPackages(view) {
  return card(view, "Staged pi packages", (v) => html`${v.packages === null || v.packages.unreadable ? html`<p>${state(t("staged-package manifest unavailable", v), "attention", "info")}</p>` : html`${v.packages.stagedAt ? html`<p class="muted">Staged ${v.packages.stagedAt}.</p>` : null}${(v.packages.packages ?? []).length ? html`<ul class="cn-list">${v.packages.packages.map((p) => html`<li class="code">${p}</li>`)}</ul>` : html`<p class="muted">${t("No pi package is staged.", v)}</p>`}`}<p class="muted">${t("They load into every job except triggers that set", v)} <span class="code">"packages": false</span> (${v.packageOptOuts ?? "unknown count"}). ${t("The manifest records when, not who.", v)}</p>${operator(view) ? ui.cmd(["pi-dispatch", "import-pi", "--with-packages"]) : html`<p class="muted">${t("An operator can import and stage the pi packages on the host.", v)}</p>`}`);
}
