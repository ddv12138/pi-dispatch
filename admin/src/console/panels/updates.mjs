/** The UpdatesScreen card, from the facts `updates-view.mjs` read (issue #796, `REQ-OPERATOR-CONSOLE-SCREENS` (g8)). A viewer sees versions and results; every button is an operator's. */
import { CANNOT_ADOPT_REASONS } from "@edgehero/pi-dispatch/updates";
import { html } from "../html.mjs";
import * as ui from "../kit.mjs";
import { uiText } from "../locale.mjs";
import { actForm } from "./config-ui.mjs";
import { ageText, timeHtml } from "./common.mjs";

const data = (view) => view.data?.updates ?? null;
const t = (message, view) => uiText(message, view?.locale);
const operator = (view) => view.role === "operator" && !view.readOnly;
const nowOf = (view) => (Number.isFinite(view.data?.now) ? view.data.now : Date.now());
/** The bump pull request, whichever version it is on. A search, because the page holds no pull request number and a stale one would open the wrong bump. */
export const BUMP_PULL_REQUESTS = "https://github.com/edgehero/pi-dispatch/pulls?q=is%3Apr+head%3Achore%2Fpi-bump";
const packageHref = (name, version) => `https://www.npmjs.com/package/${name}/v/${version}`;

const line = (tone, glyph, body) => html`<span class="cn-state tone-${tone}">${ui.icon(glyph, { size: "sm" })}<span>${body}</span></span>`;
const what = (name, kind) => html`<span class="up-what"><b class="code">${name}</b><span>${kind}</span></span>`;
const versions = (from, to) => (to && to !== from ? html`<span class="up-ver">${from}${ui.icon("chev-r", { size: "sm" })}${to}</span>` : html`<span class="up-ver">${from}</span>`);
const runLink = (jobId) => (jobId ? html`<a class="link code" href="${`/run?id=${encodeURIComponent(jobId)}`}">${jobId}</a>` : "its run");
const lineCell = (body) => ({ html: html`<div class="up-line">${body}</div>`, wide: true });
const actCell = (body) => ({ html: body === null ? null : html`<div class="up-act">${body}</div>`, wide: true });
const money = (usd) => (Number.isFinite(usd) ? `$${usd.toFixed(2)}` : null);

/** Why a host cannot adopt, for a person who can do something about it. One sentence for each closed word; a test holds this to the word list. */
export const CANNOT_ADOPT_WORDS = Object.freeze({
	"no-overlay": "this host has no overlay",
	"overlay-read-only": "its overlay is read-only here",
	"packages-file-unusable": "its pi-packages.json cannot be read or written",
	adapter: "this is a reviewed subscription adapter, whose identity depends on its exact tree",
	"not-staged-here": "this package is not staged there",
	"version-not-found": "the registry has no such version",
	"stage-refused": "the version failed staging's checks there",
});
if (Object.keys(CANNOT_ADOPT_WORDS).sort().join() !== [...CANNOT_ADOPT_REASONS].sort().join()) throw new Error("a cannot-adopt reason has no sentence");

/** The line for a row a look cannot speak for. It says which kind of not knowing this is, because each has a different next step, and a stale look's next step is on the page's one banner. */
const notKnownLine = (state, view) => {
  if (state === "not-looking") return line("idle", "minus", html`${t("Not looking.", view)} <span class="code">PI_UPDATES_LOOK=1</span> ${t("on a worker host turns on a daily look.", view)}`);
  if (state === "stale") return line("attention", "attention", t("Not known: the last look is too old to go by.", view));
  if (data(view)?.state === "unknown") return line("attention", "attention", t("Not known: Valkey did not answer.", view));
  return line("attention", "attention", t("Not known: the registry could not be read on the last look. It tries again on the next.", view));
};

/** What a canary would cost, in the row that offers it: a paid button says so where it is pressed. */
function canaryCost(view) {
	const triggers = data(view).triggers;
  if (triggers.length !== 1) return t("one paid job of the trigger you choose", view);
	const [only] = triggers;
  return `${t("one job of trigger", view)} ${only.index + 1}${only.capUsd !== null ? `, ${t("up to", view)} $${only.capUsd.toFixed(2)}` : `, ${t("up to its cap", view)}`}`;
}

function canaryForm(row, view, label = "Run a canary") {
	const triggers = data(view).triggers;
  if (triggers.length === 0) return html`<p class="muted">${t("No cron trigger that loads staged packages can run a canary here.", view)}</p>`;
	const hidden = [["name", row.name], ["version", row.newest]];
	const choose = triggers.length === 1
		? null
    : html`<label class="field">${t("Run as", view)}<select class="select" name="index" data-type="int">${triggers.map((t) => html`<option value="${String(t.index)}">${uiText("trigger", view.locale)} ${t.index + 1}${t.id ? ` (${t.id})` : ""}</option>`)}</select></label>`;
  return actForm("package-canary", { hidden: triggers.length === 1 ? [...hidden, ["index", triggers[0].index, "int"]] : hidden, fields: choose, label: t(label, view), icon: "rerun", locale: view.locale });
}

function standingsList(row, view) {
	const shown = row.standings.filter((s) => !["adopted", "undone", "no-change"].includes(s.state));
	if (shown.length === 0) return null;
	const sentence = (s) => (s.state === "cannot-adopt" ? `${s.host} ${t("cannot", view)} ${t(row.desired.op === "undo" ? "go back" : "adopt", view)}: ${t(CANNOT_ADOPT_WORDS[s.reason] ?? "no reason was recorded", view)}` : s.state === "overdue" ? `${s.host} ${t("has not answered in a day. It catches up when it returns", view)}` : `${s.host} ${t("is pending", view)}`);
	return html`<ul class="up-hosts">${shown.map((s) => html`<li>${sentence(s)}.</li>`)}</ul>`;
}

const npmLink = (row) => (row.newest ? html`<span class="up-see">${ui.outLink({ href: packageHref(row.name, row.newest), label: `See ${row.newest} on npm` })}</span>` : null);

function packageCells(row, view) {
	const may = operator(view);
	const done = row.standings.filter((s) => ["adopted", "undone", "no-change"].includes(s.state)).length;
	const canary = row.canary;
	const adoptedBefore = row.desired?.op === "adopt" ? html`<p class="muted">${row.desired.version} ${t("adopted by", view)} ${row.desired.by}.</p>` : null;
	const facts = row.facts?.excerpt ? html`<details class="up-excerpt"><summary>${t("What changed, from its changelog", view)}</summary>${row.facts.excerpt}</details>` : null;
	const adopt = may && !row.adapter && row.newest ? actForm("package-adopt", { hidden: [["name", row.name], ["version", row.newest]], label: t("Adopt", view), icon: "done", locale: view.locale }) : null;
	const undoToo = (action) => (may && row.desired?.op === "adopt" ? html`${action}${undoForm(row)}` : action);
	const canaryRun = (label) => (may && !row.adapter && row.newest ? canaryForm(row, view, label) : null);
	const spent = canary && money(canary.costUsd) ? `, ${money(canary.costUsd)}` : "";
	switch (row.state) {
		case "current": return [versions(row.version), line("ok", "done", t("The newest version.", view)), null];
		case "newer": return [versions(row.version, row.newest), row.adapter ? html`<span class="muted">${t("A reviewed subscription adapter. It moves with a pi-dispatch release.", view)}</span>` : html`${adoptedBefore}<span class="muted">${t("Not tried yet. A canary runs", view)} ${canaryCost(view)}${t(", with this version for that job only.", view)} ${npmLink(row)}</span>`, undoToo(canaryRun("Run a canary"))];
		case "canary-completed": return [versions(row.version, row.newest), html`${adoptedBefore}<p>${line("ok", "done", html`${t("Canary completed, read the run:", view)} ${runLink(canary.jobId)}${spent}.`)}</p>${facts}`, undoToo(adopt)];
		case "canary-failed": return [versions(row.version, row.newest), html`${adoptedBefore}<p>${line("failed", "failed", html`${t(canary.why === "did-not-load" ? "Canary failed: this version did not load." : "Canary failed: the run did not complete.", view)} ${t("Read the run:", view)} ${runLink(canary.jobId)}${spent}.`)}</p>${npmLink(row)}`, undoToo(canaryRun("Run another canary"))];
		case "adopting": return [versions(row.desired.from ?? row.version, row.desired.version), html`<p>${line("idle", "rerun", html`${t("Adopting", view)} ${row.desired.version}: ${done} ${t("of", view)} ${row.standings.length} ${t("hosts so far.", view)}`)}</p>${standingsList(row, view)}`, may ? undoForm(row, view) : null];
		case "adopted": return [versions(row.desired.version), html`<p>${line("ok", "done", html`${t("Adopted by", view)} ${row.desired.by} ${t("on every host.", view)}`)}</p>${row.differs ? html`<p>${line("attention", "attention", html`${t("A host's tree is not the tree the canary ran: its dependencies resolved differently. Read the run:", view)} ${runLink(canary?.jobId)}.`)}</p>` : null}`, may ? undoForm(row, view) : null];
		case "partial": return [versions(row.desired.from ?? row.version, row.desired.version), html`<p>${line("attention", "attention", html`${t(row.desired.op === "undo" ? "Back on" : "On", view)} ${row.desired.version} ${t("on", view)} ${done} ${t("of", view)} ${row.standings.length} ${t("hosts.", view)}`)}</p>${standingsList(row, view)}`, may && row.desired.op === "adopt" ? undoForm(row, view) : null];
		case "undoing": return [versions(row.desired.from ?? row.version, row.desired.version), html`<p>${line("idle", "rerun", html`${t("Going back to", view)} ${row.desired.version}: ${done} ${t("of", view)} ${row.standings.length} ${t("hosts so far.", view)}`)}</p>${standingsList(row, view)}`, null];
		default: return [versions(row.version, row.newest), notKnownLine(row.state, view), null];
	}
}

function undoForm(row, view) {
	return actForm("package-undo", { hidden: [["name", row.name]], label: `${t("Undo", view)} ${row.desired.version}`, locale: view?.locale });
}

const PI_CELLS = Object.freeze({
	current: (_pi, view) => line("ok", "done", t("The newest version.", view)),
	"checks-passing": (pi, view) => line("ok", "done", html`${t("pi-dispatch's checks pass on", view)} ${pi.newest}. ${t("It arrives in a pi-dispatch release.", view)}`),
	"checks-failing": (pi, view) => line("failed", "failed", html`${t("Checks fail. Jobs stay on", view)} ${pi.pinned} ${t("until pi-dispatch's bump is green and released.", view)}`),
	"checks-pending": (_pi, view) => line("attention", "attention", t("pi-dispatch's checks are still running on it.", view)),
	"checks-unknown": (_pi, view) => line("attention", "attention", t("Whether pi-dispatch's checks hold is unknown.", view)),
});
/** Every pi state has a sentence: the three shared ones come from `notKnownLine`. */
export const PI_STATES_DRAWN = Object.freeze([...Object.keys(PI_CELLS), "not-looking", "stale", "unknown"]);

function piCells(pi, view) {
	const open = pi.state.startsWith("checks-") ? ui.outLink({ href: BUMP_PULL_REQUESTS, label: t("Bump pull request", view), btn: ["sm"] }) : null;
	return { cells: [what("pi", t("in every job, pinned by pi-dispatch", view)), versions(pi.pinned ?? t("unknown", view), pi.state === "current" ? null : pi.newest), lineCell(PI_CELLS[pi.state]?.(pi, view) ?? notKnownLine(pi.state, view)), actCell(open)] };
}

export function updatesDescription(locale = "en") {
  return uiText("pi and the extensions jobs run, and what is newer. Nothing changes until an operator adopts it.", locale);
}

const unreadable = (view) => html`<p>${line("attention", "attention", t("These facts could not be read.", view))}</p>`;

/** One sentence for why a package is not the same everywhere, naming the host and what to do: the state is on the package's row, not the host's. */
function stuckBody(p, view) {
	const refused = p.standings.find((s) => s.state === "cannot-adopt");
	if (refused) return `${refused.host} ${t("cannot", view)} ${t(p.desired.op === "undo" ? "go back" : "adopt", view)}: ${t(CANNOT_ADOPT_WORDS[refused.reason] ?? "no reason was recorded", view)}. ${t("Fix that there", view)}${p.desired.op === "adopt" ? t(", or undo it", view) : ""}. ${t("A host that has not moved keeps the version it had.", view)}`;
	const late = p.standings.find((s) => s.state === "overdue");
	return `${late?.host ?? t("A host", view)} ${t("has not answered in a day. It catches up when it returns, and keeps the version it had until then.", view)}`;
}

export function updatesProblems(view) {
	const v = data(view);
	if (!v) return ui.banner({ status: "attention", title: t("Update facts unavailable", view), body: t("The console could not read this page's sources. Reload to try again.", view) });
	const shown = [];
	if (v.state === "unknown") shown.push(ui.banner({ status: "attention", title: t("What is newer is not known", view), body: t("Valkey did not answer, so this page cannot say what the hosts last saw, and offers no canary. Reload to try again.", view) }));
	if (v.state === "stale") shown.push(ui.banner({ status: "attention", title: t("The last look is too old to go by", view), body: html`${t("No host has looked in", view)} ${ageText(nowOf(view) - v.at)}${t(", so what is newest may have moved, and this page offers no canary until one has. Check that a worker with", view)} <span class="code">PI_UPDATES_LOOK=1</span> ${t("is running.", view)}` }));
	if (v.stagedUnreadable) shown.push(ui.banner({ status: "attention", title: t("The staged extensions could not be read", view), body: t("This host's list of staged extensions cannot be read, so they are not shown here. Run pi-dispatch doctor on this host to see why.", view) }));
	// Only beside a row it could be wrong about: a package with a canary on record, or nothing newer, is not in doubt.
	if (v.recordsPartial && v.packages.some((p) => p.state === "newer")) shown.push(ui.banner({ status: "attention", title: t("Some recent runs could not be read", view), body: t("A canary that finished may read as not tried here, and cannot be adopted until its run can be read. Reload to try again, or run another canary.", view) }));
	if (v.desiredUnreadable && v.state !== "unknown") shown.push(ui.banner({ status: "attention", title: t("What people asked for could not be read", view), body: t("Valkey did not answer that read, so an Adopt in progress may not show here. Reload to try again.", view) }));
	if (v.pi.state === "checks-failing") shown.push(ui.banner({ status: "attention", title: html`pi ${v.pi.newest} ${t("is out, and pi-dispatch's checks on it fail", view)}`, body: html`${t("Jobs stay on pi", view)} ${v.pi.pinned}. ${t("The bump pull request lists what broke; it ships in a pi-dispatch release once it is green.", view)}`, actions: ui.outLink({ href: BUMP_PULL_REQUESTS, label: t("Open the bump pull request", view), btn: ["sm"] }) }));
	const stuck = v.packages.filter((p) => p.state === "partial" || p.standings.some((s) => s.state === "overdue"));
	for (const p of stuck) shown.push(ui.banner({ status: "attention", title: html`<span class="code">${p.name}</span> ${t("is not the same on every host", view)}`, body: stuckBody(p, view) }));
	return html`${shown}`;
}

export function updatesJobs(view) {
	const v = data(view);
	if (!v) return ui.card({ title: t("What jobs run", view), body: unreadable(view) });
	const rows = [piCells(v.pi, view)];
	for (const row of v.packages) {
		const [version, sentence, action] = packageCells(row, view);
		rows.push({ cells: [what(row.name, t(row.from === "host" ? "extension, staged from a pi setup" : "extension, staged", view)), version, lineCell(sentence), actCell(action)] });
	}
	const body = ui.tbl({ label: t("What jobs run, and what is available", view), heads: ["What", "Version", "Checks", { label: "" }].map((h) => typeof h === "string" ? t(h, view) : h), rows, stack: true });
	const foot = html`<p class="up-foot">${ui.icon("info", { size: "sm" })}<span>${t(v.state === "not-looking" ? "Not looking yet." : "Checked daily once enabled.", view)} ${t("Nothing here changes a job until someone adopts it.", view)}</span></p>`;
	return ui.card({ title: t("What jobs run", view), sub: t("pi and its extensions", view), flush: true, body: html`${body}${foot}` });
}

const HOST_CELLS = Object.freeze({
	same: (_h, view) => line("ok", "done", t("The version pi-dispatch is tested with.", view)),
	newer: (h, view) => line("attention", "attention", html`${t("Newer than pi-dispatch is tested with", view)} (${h.tested}).`),
	older: (h, view) => line("attention", "attention", html`${t("Older than pi-dispatch is tested with", view)} (${h.tested}).`),
	absent: (_h, view) => html`<span class="muted">${t("No pi on this host; jobs bring their own.", view)}</span>`,
	unknown: (_h, view) => line("attention", "attention", t("This host's pi could not be read.", view)),
});
export const HOST_STATES_DRAWN = Object.freeze(Object.keys(HOST_CELLS));

function hostSentence(h, view) {
	const notes = [];
	if (h.needles === "drift") notes.push(t("This pi has changed in a way this pi-dispatch has not been checked against, so copying its packages and settings may miss some. Use the version it is tested with, or a newer pi-dispatch.", view));
	if (h.extension === "drift") notes.push(t("This pi may not load the /dispatch extension. Use the version pi-dispatch is tested with.", view));
	if (h.stale) notes.push(html`${t("Its last look is", view)} ${ageText(nowOf(view) - h.at)} ${t("old.", view)}`);
	return html`<p>${HOST_CELLS[h.state]?.(h, view) ?? HOST_CELLS.unknown(h, view)}</p>${notes.map((n) => html`<p class="muted">${n}</p>`)}`;
}

export function updatesHosts(view) {
	const v = data(view);
	if (!v) return ui.card({ title: t("pi on each host", view), body: unreadable(view) });
	const rows = v.hosts.map((h) => ({ cells: [what(h.name, t("worker host", view)), h.version ? versions(h.version) : html`<span class="muted">${t(h.state === "absent" ? "none" : "unknown", view)}</span>`, lineCell(hostSentence(h, view))] }));
	const body = ui.tbl({ label: t("pi on each host", view), heads: ["Host", "pi", { label: "" }].map((h) => typeof h === "string" ? t(h, view) : h), rows, stack: true, empty: html`<p class="note up-note">${t(v.state === "not-looking" ? "No host has looked yet, so nothing is known about the pi on each host." : "No host's look could be read.", view)}</p>` });
	return ui.card({ title: t("pi on each host", view), sub: t("where /dispatch and the host files run", view), flush: true, body: html`${body}${v.moreHosts > 0 ? html`<p class="note up-note">${t("And", view)} ${String(v.moreHosts)} ${t("more hosts, past what this page reads.", view)}</p>` : null}<p class="up-foot">${ui.icon("info", { size: "sm" })}<span>${t("Your own pi is yours to update, for example with", view)} <span class="code">pi update --all</span>. ${t("pi-dispatch reads its version and whether its host files still hold.", view)}</span></p>` });
}

export function updatesHow(view) {
	const v = data(view);
	if (!v) return ui.card({ title: t("How it keeps up", view), body: unreadable(view) });
	const looks = t(v.state === "not-looking" ? "off, until PI_UPDATES_LOOK=1 is set" : v.state === "unknown" ? "unknown" : v.state === "stale" ? "late: the last look" : "daily", view) + (v.state === "stale" ? ` ${ageText(nowOf(view) - v.at)} ${t("ago", view)}` : "");
	const first = v.triggers[0];
	const runs = first ? `${t("trigger", view)} ${first.index + 1}${first.id ? `, ${first.id}` : ""}${first.capUsd !== null ? `, ${t("up to its", view)} $${first.capUsd.toFixed(2)} ${t("cap", view)}` : `, ${t("up to its cap", view)}`}${v.triggers.length > 1 ? `, ${t("or", view)} ${v.triggers.length - 1} ${t("more", view)}` : ""}` : t("no cron trigger can", view);
	return ui.card({ title: t("How it keeps up", view), body: ui.facts([[t("Looks for updates", view), t(looks, view)], [t("Last look", view), Number.isFinite(v.at) ? timeHtml(v.at) : t(v.state === "unknown" ? "unknown" : "never", view)], [t("A canary runs as", view), t(runs, view)], [t("Adopting", view), t("always a person, with a preview and Undo", view)]], { cols: 1 }) });
}

export function updatesRecent(view) {
	const v = data(view);
	if (!v) return ui.card({ title: t("Recently adopted", view), body: unreadable(view) });
	const said = (r) => (r.kind === "package-undo" ? `${t("went back to", view)} ${r.version}` : `${t("adopted", view)} ${r.version}`);
	const rows = v.recent.map((r) => ui.rowPill({ icon: r.kind === "package-undo" ? "rerun" : "done", items: [html`<span class="up-recent"><span><b class="code">${r.name}</b> ${said(r)}</span><small>${r.by ?? "unknown"}${r.at ? `, ${r.at.slice(0, 10)}` : ""}</small></span>`] }));
	return ui.card({ title: t("Recently adopted", view), body: rows.length ? html`<ul class="rows">${rows}</ul>` : html`<p class="note">${t("Nothing in the audit log's window.", view)}</p>` });
}
