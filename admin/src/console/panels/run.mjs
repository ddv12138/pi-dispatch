import { answererRun } from "./answerer.mjs";
import { modelRolesTelemetryOf } from "@edgehero/pi-dispatch/run-history";
import { modelChoiceSentence, providerFailureSentence } from "../../model-words.mjs";
/**
 * The run page's panels (the outcome banner, progress, inbox and the record's panels), split out of
 * `../panels.mjs` (issue #737), which re-exports what this module exports. The rules every panel keeps (one pure,
 * deterministic renderer per region, every value through `html`, the role and run-text rule, the action controls and
 * the PATHS rule) are stated once, in `../panels.mjs`'s header.
 */
import { providerFailureOf } from "@edgehero/pi-dispatch/model-failover-protocol";
import { refusedBeforeSpend } from "../../costs.mjs";
import { FORK_THINKING_LEVELS } from "../../run-fork.mjs";
import { forkArchiveFact } from "@edgehero/pi-dispatch/fork-job";
import { modelIdProblem } from "@edgehero/pi-dispatch/model-ref";
import { UNATTRIBUTED_BACKEND, declarationOf } from "@edgehero/pi-dispatch/backends";
import { SESSION_NOT_SAVED } from "@edgehero/pi-dispatch/record-reason";
import { BUNDLE_SKIPPED_TEXT, LIVE_SKIPPED_TEXT, STEER_SKIPPED_TEXT, VENUE_MAY_NOT_STREAM, liveAbsentCause, progressAbsentText, recordSkips, bundleCountsText, bundleReceivedText, checkpointsText, isProgressSnapshot, progressStaleFor, recordBundle, recordRecovery, recoveredText, recordSecretsProfile, RUN_RECORD_UNREAD, RUN_FILE_UNREADABLE, RUN_MIRROR_UNREAD, RUN_PLACES, runPlaces, runPlacesText, transcriptAbsentText, forgeLinkOf } from "../../read-model.mjs";
import { CHAIN_MAX_PER_JOB_DEFAULT } from "@edgehero/pi-dispatch/config";
import { RECOVERY_CAP, RECOVERY_TTL_MS, RECOVERY_MAX_WAIT_MS } from "@edgehero/pi-dispatch/recovery-queue";
import { recordedEarlier } from "@edgehero/pi-dispatch/run-history";
import { beatAgeOf, doctorHostsOf, doctorProblems, doctorCountsText } from "../../doctor-view.mjs";
import { PROPERTY_LABEL, DECLARATION_TEXT } from "../../read-model.mjs";
import { recordedProgress } from "@edgehero/pi-dispatch/run-history";
import { coresText } from "@edgehero/pi-dispatch/size-suggest";
import { NO_EXPLANATION, VENUE_LABEL, capitalised, outcomeWord, recordReason } from "../../words.mjs";
import { explainReason } from "@edgehero/pi-dispatch/reason-catalog";
import { QUEUED_STATES } from "@edgehero/pi-dispatch/parked-facts";
import { rerunRefusalOf } from "../../job-actions.mjs";
import { fromNewerRelease, NEWER_RECORD_SENTENCE } from "../../newer-release.mjs";
import { isForgeKind } from "@edgehero/pi-dispatch/forges";
import { isSchedulerJobId } from "@edgehero/pi-dispatch/bullmq-internals";
import { html } from "../html.mjs";
import * as ui from "../kit.mjs";
import { uiText } from "../locale.mjs";
import { STEER_MAX_MESSAGES, STEER_TOTAL_MAX_BYTES } from "@edgehero/pi-dispatch/steer-inbox";
import { SEC, MIN, cell, ageText, timeHtml, msOf, tokensText, count, RUN_ID_RE, runLink, targetLink, canAct, actForm, area, table, runCost, costText, staleText, outcomeText, bannerCut, parkedAnswerForm } from "./common.mjs";

const titled = (title, body, locale = "en") => ui.card({ title: uiText(title, locale), body });
const t = (message, view) => uiText(message, view?.locale);
const facts = (pairs, locale = "en") => ui.facts(pairs.filter(([, value]) => value !== null && value !== undefined).map(([label, value]) => [typeof label === "string" ? uiText(label, locale) : label, value]));
/** Facts whose values are sentences, which three narrow columns would split mid-word. */
const factsOne = (pairs, locale = "en") => ui.facts(pairs.filter(([, value]) => value !== null && value !== undefined).map(([label, value]) => [typeof label === "string" ? uiText(label, locale) : label, value]), { cols: 1 });
const localizedTable = (caption, heads, rows, empty, locale = "en") => table(uiText(caption, locale), heads.map((head) => typeof head === "string" ? uiText(head, locale) : head), rows, uiText(empty, locale));
const recordOf = (view) => view.data?.run?.record ?? null;
/**
 * The run card's label for the record's `kind`: "Forge" where it names a forge (its value then says which), "Kind" for
 * anything else (`local`, or a kind a newer release added), so a local run is never labelled with a forge.
 */
const kindLabel = (kind) => (isForgeKind(kind) ? "Forge" : "Kind");
const hiddenRecord = (view) => !recordOf(view) || refusedBeforeStart(recordOf(view));

// ---- run detail ------------------------------------------------------------------------------------------------------

/**
 * Whether the page's run is RUNNING with no record yet (a record is written at its end): its live transcript exists, a
 * live progress snapshot has not ended, or the queue says the job is active.
 */
function runningWithoutRecord(view) {
  if (view.data?.run?.record) return false;
  return (view.data?.transcript?.exists === true && view.data.transcript.ended !== true) || (isProgressSnapshot(view.data?.progress) && !view.data.progress.ended) || view.data?.queueState?.jobState === "active";
}

/**
 * Whether the record is a run REFUSED BEFORE IT STARTED (issue #710): a policy outcome (never retried,
 * CONST-RETRY-INFRA-ONLY, so no later attempt of the same id can start) whose record says no spend at all, the cost
 * fold's own `refusedBeforeSpend` (no tokens, no exit code). Such a run made no container and
 * no workspace, so its page draws no Progress and no transcript section.
 */
export function refusedBeforeStart(record) {
  return record !== null && typeof record === "object" && record.outcome === "policy" && refusedBeforeSpend(record);
}

/**
 * The record panels of the run page. With no record they draw NOTHING (issue #710): the empty section is hidden by the
 * stylesheet's `section[data-panel]:empty`, and the outcome banner (`runOutcome`) says once why there is no record,
 * where every panel used to say it again.
 */
function withRun(title, render) {
  return (view) => {
    const got = view.data?.run;
    if (!got?.record) return html``;
    if (refusedBeforeStart(got.record)) return html``;
    return titled(title, render(got.record, view, got.source), view.locale);
  };
}

// ---- the outcome banner (issue #710) ---------------------------------------------------------------------------------

/**
 * A nested reason's sentence (issue #710): the catalog's table for the record field (`session.reason`,
 * `recoverSkipped`, `plan.reason`), its fixed text with the Markdown backticks dropped (a facts value is plain text), or
 * "no explanation yet" for a token the catalog does not know. The token itself is printed beside it by the caller.
 */
function nestedText(field, token) {
  const said = explainReason(token, { field });
  return said.known ? said.sentence.replace(/`/g, "") : NO_EXPLANATION;
}

/** A catalog string with its Markdown code spans (`run.mcp`) as `<code>`, every part escaped by the template. */
function catalogText(text) {
  return String(text)
    .split("`")
    .map((part, i) => (i % 2 === 1 ? html`<code>${part}</code>` : part));
}

/** What the banner says of a record that names no reason, by its outcome word. */
const NO_REASON_TEXT = Object.freeze({
  completed: "The run finished, and its record names no reason to say more.",
  refused: "The run was refused, and its record names no reason.",
  failed: "The run failed, and its record names no reason. Its exit code and the worker log say more.",
});

/**
 * The `awaiting-input` next step where THIS page cannot take the answer: the catalog's line without its console path.
 * The catalog's own next step ends "or answer from the console's run page", which this page no longer offers (the
 * answer forms are the parked inbox's); whether a reply was already taken is the record's. Fixed text, as the
 * catalog's is, and the same for both roles.
 */
const AWAITING_INPUT_ELSEWHERE = "If no reply was taken yet, answer the question: reply on the issue or pull request (on a pull request, start the reply with this repository's pi-dispatch comment phrase), or answer the run from the console's Parked page.";

/** The banner for a run whose record could not be read (`readRunById`'s `unreadable`, what could not be read). */
export function runUnreadText(why, locale = "en") {
  if (locale === "zh") {
    const translated = why === RUN_FILE_UNREADABLE ? "此主机上的运行记录无法读取" : why === RUN_MIRROR_UNREAD ? "主机群运行镜像无法读取" : why === RUN_RECORD_UNREAD ? "运行记录无法读取" : uiText(capitalised(String(why)), locale);
    return `${translated}，因此此页面无法显示运行情况。请重新加载后重试。`;
  }
  return `${capitalised(String(why))}, so this page cannot say what the run did. Reload to try again.`;
}

/**
 * The banner for a run whose record both sides said they do not hold while no other place shows a run and some could
 * not be read (`runPlaces`' `unread`, in `RUN_PLACES`' words): the page names what it could not read rather than say
 * there is no run.
 */
export function runUntoldText(unread, locale = "en") {
  if (locale === "zh") {
    const place = { file: "此主机的运行记录", mirror: "主机群运行镜像", record: "运行记录", queues: "所有队列", transcript: "实时对话记录", progress: "运行进度" };
    const list = Array.isArray(unread) ? unread.map((item) => place[item] ?? item) : [];
    const phrase = list.length <= 1 ? (list[0] ?? "") : `${list.slice(0, -1).join("、")}和${list.at(-1)}`;
    return `此主机历史记录或主机群运行镜像中没有此运行的记录，但此页面无法读取${phrase}，因此无法确认运行是否存在。请重新加载后重试。`;
  }
  return `No record of this run is in this host's history or the fleet's run mirror, but this page could not read ${runPlacesText(unread)}, so it cannot say whether the run exists. Reload to try again.`;
}

/**
 * Why the page has no record, said ONCE (issue #710): not a run id, a running job (a record is written at its end), a
 * queued job, a record that could not be read (`runUnreadText`), a job the queue holds as ended whose record this host
 * cannot read, a run no place shows while some could not be read (`runUntoldText`, issue #737: the places, the queues
 * and the live transcript included, for both roles), or no such run. `{ cls, text }`.
 *
 * THE TONE IS THE JOB'S, DELIBERATELY, and none of these prints an outcome word (there is no outcome yet, or none this
 * page can read). A job that exists and has not ended (queued, running) is a grey `note`: nothing is wrong, the record
 * comes at its end. What the page cannot show is an amber `warn`: an id that is not one, a run no history or mirror
 * holds, a record or a place that could not be read, and an ended job whose record is not readable here. Never `bad`:
 * no run failed that this page knows of.
 */
function absentOutcome(view) {
  const got = view.data?.run;
  if (got?.invalid) return { cls: "warn", text: t("That is not a run id.", view) };
  if (runningWithoutRecord(view)) {
    // A snapshot the worker stopped rewriting (its heartbeat is 30 s) may be a run that will never write a record.
    const stale = isProgressSnapshot(view.data?.progress) ? progressStaleFor(view.data.progress, view.now) : null;
    return { cls: "note", text: view.locale === "zh" ? `此运行尚无记录：记录会在运行结束时写入。${stale !== null ? `进度已 ${t(staleText(stale), view)}。` : ""}` : `This run has no record yet: a run's record is written when it ends.${stale !== null ? ` Its progress has had ${staleText(stale)}.` : ""}` };
  }
  const state = view.data?.queueState?.jobState ?? null;
  if (typeof state === "string" && QUEUED_STATES.includes(state)) return { cls: "note", text: t("This job is queued and has not started yet: a run's record is written when it ends, and its live transcript attaches on this page once it runs.", view) };
  // A record neither side said it does not hold (`missing`) is one this page could not read, whatever it was handed.
  if (got?.missing !== true) return { cls: "warn", text: runUnreadText(typeof got?.unreadable === "string" ? got.unreadable : RUN_RECORD_UNREAD, view.locale) };
  if (state === "completed" || state === "failed") return { cls: "warn", text: t("This job has ended, but its record is not in this host's history or the fleet's run mirror (another host's run, with the mirror off?).", view) };
  const places = runPlaces({ run: got, lookup: view.data?.queueState, transcript: view.data?.transcript, progress: view.data?.progress });
  if (!places.shown && places.unread.length > 0) return { cls: "warn", text: runUntoldText(places.unread, view.locale) };
  if (typeof state === "string") return { cls: "warn", text: view.locale === "zh" ? `队列中此作业的状态尚未被此控制台识别（${state}）；此处无法读取运行记录。` : `The queue holds this job in a state this console does not name yet (${state}); its run record is not readable here.` };
  return { cls: "warn", text: t("No run with that id is in this host's history or the fleet's run mirror.", view) };
}

/**
 * The run page's first panel (issue #710, REQ-OPERATOR-CONSOLE-SCREENS (c)): what happened, why and what now. The
 * outcome in the console's words (words.mjs, the panel's too) in its tone, the reason's catalog sentence (the record's
 * `why` picks its variant where the catalog has one), its next step and a link to its heading in `docs/reasons.md`.
 *
 * THE SAME FOR BOTH ROLES, AND NO FREE TEXT (REQ-CONSOLE-SECURITY (l)): the outcome and reason are the record's closed
 * enums, which the run summary already shows a viewer; every sentence is the catalog's fixed text, escaped like any
 * value; a job's free-text `failedReason` never comes here. A token the catalog does not know (a newer worker's) is
 * printed once, cut to `BANNER_TOKEN_MAX`, with "no explanation yet"; an outcome word it does not know is cut the same.
 */
export function runOutcome(view) {
  const r = recordOf(view);
  if (!r) {
    const { text } = absentOutcome(view);
    return ui.banner({ status: "idle", title: text });
  }
  if (fromNewerRelease(r)) return newerOutcome(r, view.locale);
  const token = recordReason(r);
  const w = outcomeWord(r.outcome, token);
  const recovering = token === "recovery-enqueued" && [view.data?.queueState?.activeJobId, view.data?.queueState?.queuedJobId].some((id) => typeof id === "string" && id !== r.jobId);
  const word = view.locale === "zh" ? recovering ? "失败，正在继续" : refusedBeforeStart(r) ? w.word === "cancelled" ? "启动前已取消" : "启动前已拒绝" : t(capitalised(w.known ? w.word : bannerCut(r.outcome)), view) : recovering ? "Failed, continuing" : refusedBeforeStart(r) ? w.word === "cancelled" ? "Cancelled before it started" : "Refused before it started" : capitalised(w.known ? w.word : bannerCut(r.outcome));
  const started = msOf(r.startedAt), ended = msOf(r.endedAt);
  const where = view.locale === "zh" ? r.host ? `，主机：${r.host}` : "" : r.host ? ` on ${r.host}` : "";
  const duration = Number.isFinite(started) && Number.isFinite(ended) ? view.locale === "zh" ? `，耗时 ${ageText(ended - started)}${where}` : `: finished in ${ageText(ended - started)}${where}` : where;
  const said = token ? explainReason(token, { why: r.why }) : null;
  const reason = said?.known ? ui.withCode(t(said.sentence, view)) : token ? html`${bannerCut(token)}, ${t(NO_EXPLANATION, view)}.` : html`${t(NO_REASON_TEXT[w.word] ?? NO_REASON_TEXT.failed, view)}${w.word === "failed" ? t(view.role === "operator" ? " The Fleet page's failed list may say more." : " Failure reasons are shown to operators only.", view) : ""}`;
  const next = said?.known ? html`<p><strong>${t("What to do:", view)}</strong> ${ui.withCode(t(token === "awaiting-input" ? AWAITING_INPUT_ELSEWHERE : said.next, view))}</p>` : null;
  const href = forgeLinkOf(r, view.env);
  const recoveryId = view.data?.queueState?.activeJobId ?? view.data?.queueState?.queuedJobId;
  const recoveryActions = recovering ? html`${typeof recoveryId === "string" && RUN_ID_RE.test(recoveryId) ? ui.btn({ href: `/run?id=${encodeURIComponent(recoveryId)}`, label: t("Open recovery run", view), kind: "primary", icon: "running" }) : null}${view.data?.siblings?.map((s) => ui.btn({ href: `/run?id=${encodeURIComponent(s.jobId)}`, label: t("Open sibling replica", view), kind: "sm", icon: "runs" }))}` : null;
  const fixLink = r.outcome === "policy" && !["awaiting-input", "awaiting-approval"].includes(token) && /^[a-f0-9]{64}$/.test(r.touchScopeId ?? "") ? ui.btn({ href: `/config?becauseRun=${encodeURIComponent(r.jobId)}`, label: t("Fix configuration", view), kind: "sm", icon: "config" }) : null;
  const actions = view.role !== "operator" ? null : recovering ? recoveryActions : html`${refusedBeforeStart(r) ? ui.btn({ href: "/fleet", label: t("Open Fleet", view), kind: "primary", icon: "fleet" }) : href ? ui.outLink({ href, label: t("Open target on the forge", view), btn: "primary" }) : null}${rerunLine(r, view)}${fixLink}`;
  return ui.banner({ block: true, status: recovering ? "running" : w.status, title: `${word}${refusedBeforeStart(r) ? "" : duration}`, body: html`<p>${reason}</p>${next}${(view.data?.children?.length ?? 0) > 0 || r.chainRefused > 0 ? html`<p>${t("It queued", view)} ${view.data?.children?.length ?? 0} ${t("runs from /outbox", view)}${r.chainRefused > 0 ? `${view.locale === "zh" ? "，" : ", "}${t("and", view)} ${r.chainRefused} ${t("more requests were refused: a job may queue at most", view)} ${view.data?.chainMaxPerJob ?? CHAIN_MAX_PER_JOB_DEFAULT}` : ""}. ${view.data?.children?.map((child) => runLink(child.jobId))}</p>` : null}${refusedBeforeStart(r) ? html`<p>${t("Nothing was spent.", view)}</p>` : href ? html`<p>${t("Merges are never automatic: a person merges the pull request on the forge.", view)}</p>` : null}`, actions });
}

/**
 * The banner for a record a NEWER pi-dispatch wrote (issue #761): its outcome and times, which keep their meaning in
 * every release, and the one sentence that says why the page shows nothing else. No reason, no next step and no action:
 * each reads a field past the stable core, which this record reaches the page without.
 */
function newerOutcome(r, locale = "en") {
  const w = outcomeWord(r.outcome, null);
  const started = msOf(r.startedAt), ended = msOf(r.endedAt);
  const where = r.host ? locale === "zh" ? `，主机：${r.host}` : ` on ${r.host}` : "";
  const duration = Number.isFinite(started) && Number.isFinite(ended) ? locale === "zh" ? `，耗时 ${ageText(ended - started)}${where}` : `: finished in ${ageText(ended - started)}${where}` : where;
  return ui.banner({ block: true, status: w.status, title: `${uiText(capitalised(w.known ? w.word : bannerCut(r.outcome)), locale)}${duration}`, body: html`<p>${uiText(NEWER_RECORD_SENTENCE, locale)}.</p>` });
}

/** The "Run" card for a record a newer pi-dispatch wrote (issue #761): its stable core alone, each field by name. */
function newerSummary(r, source, locale = "en") {
  const started = msOf(r.startedAt), ended = msOf(r.endedAt);
  return titled("Run", facts([
    ["Job", html`<span class="mono">${cell(r.jobId)}</span>`],
    ["Outcome", outcomeText(r)],
    ["Attempt", cell(r.attempt)],
    [kindLabel(r.kind), cell(r.kind)],
    ["Project", cell(r.project)],
    ["Host", cell(r.host)],
    ["Started", timeHtml(started)],
    ["Ended", timeHtml(ended)],
    ["Took", Number.isFinite(started) && Number.isFinite(ended) ? ageText(ended - started) : "-"],
    ["Read from", uiText(source === "mirror" ? "the fleet's run mirror" : "this host's run history", locale)],
  ], locale), locale);
}

// ---- run progress (issue #644) ---------------------------------------------------------------------------------------

/** A step's duration: `1.2 s`, `40s`-style past a minute, or `-` when pi recorded none (the tool never ran). */
function stepDuration(ms) {
  if (!Number.isSafeInteger(ms) || ms < 0) return "-";
  return ms < MIN ? `${(ms / SEC).toFixed(1)} s` : ageText(ms);
}

/** The run record's `progress`, rebuilt by the worker's own rule (`recordedProgress`): integers and closed keys only. */
function recordProgressBody(r, locale = "en") {
  const p = recordedProgress(r?.progress);
  if (p === undefined) return null;
  const z = (v) => (Number.isSafeInteger(v) ? count(v) : "0");
  const tools = p.tools ? Object.entries(p.tools) : [];
  return html`${facts([
    ["Turns", z(p.turns)],
    ["Steps", z(p.steps)],
    ["Failed steps", z(p.failed)],
    ["Interrupted steps", z(p.interrupted)],
    // A sum, not wall time: steps the model ran in parallel overlap, so this can exceed the run's own duration.
    ["Sum of step durations", Number.isSafeInteger(p.toolMs) ? stepDuration(p.toolMs) : "-"],
    ["Longest step", Number.isSafeInteger(p.longestStepMs) ? stepDuration(p.longestStepMs) : "-"],
    ["Longest interrupted step", Number.isSafeInteger(p.longestInterruptedMs) ? stepDuration(p.longestInterruptedMs) : null],
    ["Phases declared", z(p.phasesDeclared)],
    ["Last phase", Number.isSafeInteger(p.lastPhaseIndex) ? `${p.lastPhaseIndex + 1} of ${count(p.phasesDeclared)}` : null],
  ], locale)}${tools.length > 0 ? localizedTable("Steps by tool", ["Tool", { num: "Steps" }], tools.map(([name, n]) => html`<tr><td class="mono">${name}</td><td class="num">${count(n)}</td></tr>`), "", locale) : null}`;
}

/**
 * The live snapshot's phase section. The integers (which phase of how many, done of total) are a list's own facts and
 * every role gets them; the NAMES, the bar and the note are the model's words and go to an operator alone, escaped by
 * the template (the worker already escaped the control class; this is the second belt). A `phase.index` past the list
 * (the worker's size cut) shows no name rather than a neighbour's.
 */
function phaseBody(g, operator, locale = "en") {
  const f = g.phase;
  if (!f && g.phases.length === 0) return ui.noProgress(uiText("The worker reports no phase progress.", locale));
  const total = f ? Math.max(g.phases.length, f.index + 1) : g.phases.length;
  return html`${f ? html`<p class="run-phase">${uiText("Phase", locale)} ${f.index + 1} ${uiText("of", locale)} ${count(total)}${f.done !== null ? `: ${count(f.done)}${f.total !== null ? ` ${uiText("of", locale)} ${count(f.total)}` : ""} ${uiText("done", locale)}` : ""}</p>` : null}${ui.phases({ names: Array.from({ length: total }, (_, i) => operator ? g.phases[i] ?? `${uiText("Phase", locale)} ${i + 1}` : `${uiText("Phase", locale)} ${i + 1}`), index: f?.index ?? 0, done: f?.done, total: f?.total })}${operator ? g.note !== null ? html`<p class="run-note">${ui.icon("runs", { size: "sm" })}<span>${uiText("Note from the run:", locale)} ${g.note}</span></p>` : null : html`<p class="card__sub">${uiText("Phase names and the run's note are shown to operators only.", locale)}</p>`}`;
}

/**
 * The live snapshot's counters and steps, for every role: integers, UTC times and charset-checked tool names. A STALE
 * snapshot (`progressStaleFor`: no write past the worker's heartbeat) leads with a warning, and its open steps read as
 * open at the last update, never as running now with an age the console's clock keeps growing.
 */
function liveProgressBody(g, view) {
  const now = view.now;
  const operator = view.role === "operator";
  const stale = progressStaleFor(g, now);
  const open = (r) => (stale === null ? `${uiText("running", view.locale)} ${Number.isFinite(now) && now >= r.since ? ageText(now - r.since) : "-"}` : `${uiText("open", view.locale)} ${g.updatedAt >= r.since ? ageText(g.updatedAt - r.since) : "-"} ${uiText("at the last update", view.locale)}`);
  const running = g.running.length === 0 ? html`<p class="note">${g.ended ? `${uiText("The run has ended", view.locale)} (${typeof g.outcome === "string" ? uiText(outcomeWord(recordOf(view)?.outcome ?? g.outcome, recordReason(recordOf(view))).word ?? recordOf(view)?.outcome ?? g.outcome, view.locale) : uiText("unknown", view.locale)}).` : uiText("No step is running.", view.locale)}</p>` : html`<ul class="plain">${g.running.map((r) => html`<li><span class="mono">${r.tool}</span> ${open(r)}</li>`)}</ul>`;
  const recent = [...g.recent].reverse().slice(0, 3);
  const max = view.data?.activeRun?.maxTurns;
  const stepRow = (r) => ui.rowPill({
    icon: r.status === "ok" ? "done" : "failed",
    status: r.status === "ok" ? "ok" : "failed",
    items: [html`<span class="code">${r.tool}</span>`, html`<span class="run-st tinted">${uiText(r.status, view.locale)}</span>`],
    end: html`<span>${stepDuration(r.durationMs)}</span><span class="run-at">${timeHtml(r.at)}</span>`,
  });
  // The rare rows stay facts: on most runs none of them draws, and the run's own numbers lead (the RunLive card).
  const rare = [
    ["Interrupted steps", g.interrupted > 0 ? count(g.interrupted) : null],
    ["Replayed calls", Number.isSafeInteger(g.replayed) ? count(g.replayed) : null],
    // The resume prior: what the session's earlier runs did before this run resumed it, not this job's retries.
    ["Earlier runs of this session", g.prior ? `${count(g.prior.turns)} turns, ${count(g.prior.steps)} steps before this run resumed the session` : null],
  ].filter(([, value]) => value !== null);
  return html`${stale !== null ? html`<p class="warn">${uiText("Stale:", view.locale)} ${staleText(stale)}${view.data?.activeRun?.host ? ` ${uiText("on", view.locale)} ${view.data.activeRun.host}` : ""}. <a href="/fleet">${uiText("Open Fleet", view.locale)}</a>.</p>` : null}<div class="run-prog"><div class="run-big"><p class="kpi"><b class="run-tc">${Number.isFinite(now) && now >= g.startedAt ? timecode(now - g.startedAt) : "-"}</b><span>${uiText("elapsed since", view.locale)} ${timeHtml(g.startedAt)}</span></p></div><dl class="run-stats"><div><dt>${uiText("Turn", view.locale)}</dt><dd><span><b>${count(g.turn)}</b>${Number.isSafeInteger(max) ? ` ${uiText("of", view.locale)} ${max}` : ""}</span></dd></div><div><dt>${uiText("Steps", view.locale)}</dt><dd><span><b>${count(g.steps)}</b>${g.failed > 0 ? `, ${count(g.failed)} ${uiText("failed", view.locale)}` : ""}</span></dd></div><div class="tone-running"><dt>${uiText("Running now", view.locale)}</dt><dd>${running}</dd></div></dl></div>${rare.length ? facts(rare, view.locale) : null}${phaseBody(g, operator, view.locale)}<h3 class="run-sub">${uiText("Recent steps", view.locale)}</h3>${recent.length ? html`<ul class="rows">${recent.map(stepRow)}</ul>` : html`<p class="note">${uiText("No step has finished yet.", view.locale)}</p>`}<p class="run-at">${uiText("Updated", view.locale)} ${timeHtml(g.updatedAt)}</p>`;
}

/**
 * Why a run on a venue that streams has no progress snapshot: the key cannot tell these apart, so the panel names all
 * three. Issue #712: the panel says `progressAbsentText(record)`, `TRANSCRIPT_ABSENT`'s rule (progress is read off the
 * live transcript), so a run on a venue that does not stream it is not blamed on the switch alone.
 */
export const PROGRESS_ABSENT = progressAbsentText({ backend: "local" });

function transcriptAbsent(record, locale = "en") {
  if (locale !== "zh") return transcriptAbsentText(record);
  const cause = liveAbsentCause(record);
  if (cause?.skipped) return `没有实时对话记录：${uiText(cause.skipped, locale)}。`;
  return cause?.venue ? "没有实时对话记录：未发布（PI_LIVE_TRANSCRIPTS=0）、已过期、尚未开始，或此运行环境不支持实时传输。" : "没有实时对话记录：未发布（PI_LIVE_TRANSCRIPTS=0）、已过期或尚未开始。";
}
function progressAbsent(record, locale = "en") {
  if (locale !== "zh") return progressAbsentText(record);
  const cause = liveAbsentCause(record);
  if (cause?.skipped) return `没有实时进度：进度从实时对话记录中读取，但${uiText(cause.skipped, locale)}。`;
  return cause?.venue ? "没有实时进度：未发布（PI_RUN_PROGRESS=0）、已过期、尚无步骤记录，或此运行环境不支持实时传输。" : "没有实时进度：未发布（PI_RUN_PROGRESS=0）、已过期或尚未记录步骤。";
}

/**
 * The run page's "Progress" panel (issue #644). A run with a record shows the record's `progress` (and, while the key
 * is still kept, an operator also gets the phase names it declared); a running job shows the live snapshot, counters
 * and recent steps for everyone, phase names, the done/total bar and the note for an operator alone. The page is live
 * (the hub re-renders this panel by digest), so a running job's counters move without a reload.
 *
 * An infra retry keeps the job id: attempt 1 writes its record and attempt 2 then rewrites the key. So the key is set
 * beside the record only when the two are the SAME attempt, judged by time: a key that started after the record ended
 * is a later attempt's, and the panel shows that live body (saying an earlier attempt ended, with the record's
 * outcome); the key's phase names join the record only when the key has ended and started inside the record's
 * attempt (no earlier than the record started, no later than it ended). A record whose start or end cannot be read
 * pairs with no key.
 *
 * Issue #662: the key is read by the job's RUN id (pages.mjs, `readRunProgress`), so a recovery's page pairs with its
 * own live key, and an attempt whose record says its run continues as a recovery (`data.progressContinues`) pairs with
 * nothing: it shows its own record's progress and links the recovery job.
 */
export function runProgress(view) {
  const title = "Progress";
  const record = view.data?.run?.record ?? null;
  const g = view.data?.progress ?? null;
  // Issue #710: a run refused before it started made no container, so it has no progress to show and the panel draws
  // nothing (its empty section is hidden); and with no record and no live snapshot, the outcome banner says why once.
  if (refusedBeforeStart(record)) return html``;
  // Issue #662: an attempt whose run went on as a #645 recovery (its record says `recovery-enqueued`). The key is the
  // RUN's, so it now holds the recovery's progress: pairing it here would show another job's live steps as this
  // attempt's. The attempt shows its own record's progress, and names the job that continues it (its own page reads the
  // key live). A BullMQ retry keeps the job id and keeps the pairing below.
  const cont = view.data?.progressContinues ?? null;
  if (record && cont) {
    const next = typeof cont.as === "string" && RUN_ID_RE.test(cont.as) ? cont.as : null;
    const line = html`<p class="note">${uiText("This run continues as", view.locale)} ${next !== null ? runLink(next) : uiText("a recovery job", view.locale)}.</p>`;
    const nextProgress = view.data?.recoveryProgress?.progress;
    return titled(title, html`${line}${recordProgressBody(record, view.locale) ?? html`<p class="note">${uiText("This attempt's record holds no progress.", view.locale)}</p>`}${isProgressSnapshot(nextProgress) ? html`<h3>${uiText("Recovery progress", view.locale)}</h3>${liveProgressBody(nextProgress, { ...view, data: { ...view.data, run: null, activeRun: view.data.recoveryLive } })}` : null}`, view.locale);
  }
  const live = isProgressSnapshot(g) ? g : null;
  const recordEnd = typeof record?.endedAt === "string" ? Date.parse(record.endedAt) : Number.NaN;
  if (record && live && Number.isFinite(recordEnd) && live.startedAt > recordEnd) {
    const outcome = typeof record.outcome === "string" && /^[a-z-]{1,40}$/.test(record.outcome) ? record.outcome : "unknown";
    return titled(title, html`<p class="note">${uiText("An earlier attempt of this run ended", view.locale)} (${uiText(outcome, view.locale)}); ${uiText("this is the attempt after it.", view.locale)}</p>${liveProgressBody(live, { ...view, data: { ...view.data, run: null } })}`, view.locale);
  }
  if (record) {
    const body = recordProgressBody(record, view.locale);
    // Both bounds: a key that started before this record's attempt did is an EARLIER attempt's (attempt 2 refused before
    // its container leaves attempt 1's ended key in place), and its phase names are not this record's. An unreadable
    // start pairs with nothing, as an unreadable end does.
    const recordStart = typeof record.startedAt === "string" ? Date.parse(record.startedAt) : Number.NaN;
    const same = live && live.ended && Number.isFinite(recordEnd) && Number.isFinite(recordStart) && live.startedAt >= recordStart && live.startedAt <= recordEnd;
    const names = same && view.role === "operator" && live.phases.length > 0 ? html`<h3>${uiText("Phases", view.locale)}</h3>${phaseBody(live, true, view.locale)}` : null;
    // Issue #712: a record that names its live skip says it; one on a venue that does not always stream adds that cause.
    if (body === null && names === null) {
      const cause = liveAbsentCause(record);
      const why = cause?.skipped ? `it had no live transcript to read it from: ${cause.skipped}` : cause?.venue ? `an older worker, PI_RUN_PROGRESS=0, ${VENUE_MAY_NOT_STREAM}` : "an older worker, or PI_RUN_PROGRESS=0";
      return titled(title, html`<p class="note">${uiText("This run's record holds no progress", view.locale)} (${uiText(why, view.locale)}).</p>`, view.locale);
    }
    return titled(title, html`${body ?? html`<p class="note">${uiText("This run's record holds no progress.", view.locale)}</p>`}${names}`, view.locale);
  }
  if (live) return ui.card({ title: uiText(title, view.locale), end: !live.ended && progressStaleFor(live, view.now) === null ? ui.chip(t("live", view), { status: "running", icon: "running" }) : null, body: liveProgressBody(live, view) });
  if (g?.unreachable) return titled(title, html`<p class="warn">${uiText("The run's progress could not be read (is Valkey reachable?).", view.locale)}</p>`, view.locale);
  if (g?.invalid) return titled(title, html`<p class="warn">${uiText("The run's progress key is not one this console reads (a newer or older worker?).", view.locale)}</p>`, view.locale);
  // No record and no snapshot: a queued job, or no run at all, which the banner names. A running job keeps the sentence.
  if (!runningWithoutRecord(view)) return html``;
  return titled(title, html`<p class="note">${progressAbsent(record, view.locale)}</p>`, view.locale);
}

// ---- run inbox (issue #646) ------------------------------------------------------------------------------------------

/** Why an active, steer-armed job's run takes no message: the open key cannot tell these apart, so all are named. */
export const INBOX_NOT_OPEN = "The run is not accepting messages: it has not started its loop yet, or it has finished.";

const MODE_WORD = Object.freeze({ steer: "steer", followUp: "follow-up" });
/** A message id as the inbox mints it (INT-STEER-INBOX-CONTRACT): only such an id gets a withdraw button. */
const MESSAGE_ID_RE = /^[0-9a-f]{32}$/;

/**
 * The run page's "Inbox" panel (issue #646, REQ-STEER-RUNNING-JOB): the messages sent into a steer-armed job, as
 * `readJobInbox` reads them, WITHOUT TEXT for every role (id, mode, source, state, time, size): the text is the
 * sender's words for one run, and a list is no place for them (the audit row keeps only their sha256 too). A job that
 * is not steer-armed, or not found, draws nothing at all (its empty section is hidden by the stylesheet's
 * `section[data-panel]:empty`), so every other run page reads as it did.
 *
 * The controls (`canAct`: an operator on a console that is not read-only): one form to steer and one to send a
 * follow-up, drawn only while the job is ACTIVE and its run takes messages (`open`), and a Withdraw button on each
 * message still `queued` (withdrawn for certain) or `written` (best effort; the preview says which). A viewer sees the
 * list and the run's status, never a control, which is the parked answer form's and the cancel button's rule. The page
 * is live, so a message's state moves from queued to written to delivered without a reload; a form being typed into is
 * not swapped (the script's `inUse`).
 */
export function runInbox(view) {
  const box = view.data?.inbox ?? null;
  if (box === null || typeof box !== "object" || box.invalid || box.found === false || (box.found === true && box.steer !== true)) return html``;
  const title = "Inbox";
  if (box.unreachable) return titled(title, html`<p class="warn">${t("The run's inbox could not be read (is Valkey reachable?).", view)}</p>`, view.locale);
  const jobId = view.query?.id;
  // Review F4: a job that is not active whose run goes on as a recovery job (`continuesAs`, same run, same inbox): the
  // forms stay, since the planner sends through the active job, and the panel names that job with a link.
  const next = typeof box.continuesAs === "string" && RUN_ID_RE.test(box.continuesAs) ? box.continuesAs : null;
  const running = box.state === "active" || next !== null;
  const takes = running && box.open === true;
  const status = takes
    ? t("The run takes messages. A steer reaches the agent after its current tool calls, before its next model call; a follow-up once the agent would otherwise stop. Either one spends from the run's existing reservation.", view)
    : running
      ? box.open === null
        ? t("Whether the run takes messages could not be read.", view)
        : t(INBOX_NOT_OPEN, view)
      : `${t("The job is", view)} ${cell(t(box.state, view))}${view.locale === "zh" ? "，" : ", "}${t("not running, so it takes no message; its inbox is kept for an hour after its run.", view)}`;
  const act = canAct(view) && typeof jobId === "string" && RUN_ID_RE.test(jobId);
  const withdraw = (e) => {
    if (!act) return null;
    if ((e.state !== "queued" && e.state !== "written") || typeof e.id !== "string" || !MESSAGE_ID_RE.test(e.id)) return null;
    return actForm("steer-withdraw", { hidden: [["jobId", jobId], ["id", e.id]], label: t("Withdraw", view) });
  };
  const entries = Array.isArray(box.entries) ? box.entries : null;
  const list =
    entries === null
      ? html`<p class="warn">${t("The messages could not be read this time; the next refresh tries again.", view)}</p>`
      : entries.length === 0
        ? html`<p class="note">${t("No message has been sent to this run.", view)}</p>`
        : html`<ul class="rows">${entries.map((e) => ui.rowPill({
            icon: e.state === "delivered" ? "done" : "clock",
            items: [html`<span class="run-inbox"><strong>${cell(t(MODE_WORD[e.mode], view))}</strong> <span class="muted">${cell(t(e.source, view))}, ${e.bytes === 1 ? `1 ${t("byte", view)}` : `${count(e.bytes)} ${t("bytes", view)}`}</span><br><span class="run-at">${Number.isSafeInteger(e.at) ? timeHtml(e.at) : "-"}</span> <span class="code">${cell(e.id)}</span></span>`],
            end: ui.chip(e.state, { icon: e.state === "delivered" ? "done" : e.state === "withdrawn" ? "cancel" : "clock" }),
            action: withdraw(e),
          }))}</ul>`;
  const forms = act && takes ? steerForms(jobId, view.locale) : null;
  const cont = next !== null ? html`<p class="note">${t("This job is", view)} ${cell(t(box.state, view))}${view.locale === "zh" ? "；" : "; "}${t("its run continues as", view)} ${runLink(next)}${view.locale === "zh" ? "，" : ", "}${t("and a message sent here goes to that job.", view)}</p>` : null;
  return titled(title, html`${cont}<p class="note">${status}</p>${entries ? ui.meter({ value: entries.length, max: STEER_MAX_MESSAGES, label: t("Messages", view) }) : null}${entries ? ui.meter({ value: entries.reduce((n, e) => n + (e.bytes ?? 0), 0), max: STEER_TOTAL_MAX_BYTES, label: t("Bytes", view) }) : null}${entries?.some((e) => e.state === "late") ? html`<p>${t("Late: the run ended before the message arrived, so the agent never saw it.", view)}</p>` : null}${list}${forms}<p class="note">${t("A message's text is never listed: the run reads it, and the audit log keeps its sha256.", view)}</p>`, view.locale);
}

/**
 * The two message forms of a steer-armed run that takes messages (issue #646): a steer and a follow-up, both the `steer`
 * action with a `mode`, drawn by the Inbox panel while the job is active and its run takes messages.
 */
function steerForms(jobId, locale = "en") {
  const text = (label) => area("text", uiText(label, locale), { rows: 3, required: true, max: 8192 });
  return html`<h3>${uiText("Send a message", locale)}</h3>${actForm("steer", { hidden: [["jobId", jobId], ["mode", "steer"]], fields: text("Steer: read after the agent's current tool calls"), label: uiText("Preview the steer", locale) })}${actForm("steer", { hidden: [["jobId", jobId], ["mode", "followUp"]], fields: text("Follow-up: read once the agent would otherwise stop"), label: uiText("Preview the follow-up", locale) })}`;
}

/** Codes the fork reader returns, in words a person can act on. Anything else it says is already a sentence. */
const FORK_REFUSAL_WORDS = Object.freeze({
  "fork-source-store-unset": "this host keeps no saved sessions (PI_SESSIONS_DIR is not set)",
  "fork-source-unavailable": "no saved session is available for this run",
});
const forkRefusalWords = (refusal) => FORK_REFUSAL_WORDS[refusal] ?? refusal;

/**
 * The re-run line: the form, or, where the planner would refuse on the record and the job's retained data alone, its
 * sentence instead. The refusal is `rerunRefusalOf`'s, the function `planRerun` asks first, so the page cannot offer
 * what the planner refuses on those, nor hide what it would plan: from the fleet's check (`data.rerunCheck`, which read
 * the retained data, cached 15 s), else from the record alone. The click still runs the whole planner (the triggers
 * file, git, a replica). Drawn only where actions can be taken (`canAct`).
 */
function rerunLine(r, view) {
  if (!canAct(view)) return null;
  const check = view.data?.rerunCheck ?? null;
  const refusal = typeof check?.refusal === "string" ? check.refusal : check?.ok === true ? null : rerunRefusalOf(r, view.now);
  if (refusal !== null) return html`${ui.btn({ label: t("Preview a re-run", view), kind: ["sm", "paid"], disabled: true })}<p class="card__sub">${t("Not offered for a re-run:", view)} ${t(refusal, view)}.</p>`;
  return ui.actForm({ action: "rerun", hidden: [["jobId", r.jobId]], label: t("Preview a re-run", view), kind: ["sm", "paid"], icon: "rerun" });
}

/**
 * The run summary's skip rows (issue #712): "Steering" (why a steer-armed run took no message, the record's
 * `steerSkipped`) and "Live transcript" (why it had none, `liveSkipped`), each the closed enum and its sentence; no row
 * for a record that carries neither, so every other run renders byte-identical.
 */
function skipRows(r, view) {
  const { liveSkipped, steerSkipped } = recordSkips(r);
  return [
    ["Steering", t(steerSkipped !== null ? `skipped: ${STEER_SKIPPED_TEXT[steerSkipped]}` : r.steered ? `armed: ${r.steered.delivered} delivered, ${r.steered.late} late, ${r.steered.withdrawn} withdrawn` : "not armed: its trigger sets no run.steer", view)],
    ["Live transcript", liveSkipped !== null ? t(`none: ${LIVE_SKIPPED_TEXT[liveSkipped]}`, view) : view?.data?.transcript?.exists ? t("streamed, kept 24 hours after the end", view) : transcriptAbsent(r, view?.locale)],
  ];
}

/**
 * The run summary's durable-run rows (issue #645): "Recovery of" (the base run, linked), "Recovery" (where it came from
 * and the runner's counts, or why an armed job ran without recovery) and "Checkpoints". Every value is `recordRecovery`'s
 * rebuild (integers, closed enums and a charset-checked id), so both roles see them; each row is null, and so not drawn,
 * when the record holds nothing for it, which keeps every record of a job that never armed `run.recover` byte-identical.
 */
function recoveryRows(r, locale = "en") {
  const rec = recordRecovery(r);
  if (rec === null) return [];
  const said = [rec.recovered ? uiText(recoveredText(rec.recovered), locale) : null, rec.recoverSkipped ? `${uiText("recovery skipped", locale)} (${rec.recoverSkipped}): ${uiText(nestedText("recoverSkipped", rec.recoverSkipped), locale)}` : null].filter(Boolean);
  return [
    ["Recovery of", rec.recoveryOf !== null ? runLink(rec.recoveryOf) : null],
    ["Recovery", said.length > 0 ? said.join("; ") : null],
    ["Checkpoints", rec.checkpoints ? checkpointsText(rec.checkpoints) : null],
  ];
}

/**
 * The run summary's secret-bundle rows (issue #704): "Secret bundle" (the variable NAMES the run received and the bundle
 * they came from, the names a trigger's own run.secrets shadowed, and on an openshell venue how many were placeholders),
 * or why the run went without its project's bundle. `recordBundle`'s rebuild (names held to the environment-name
 * charset, a closed enum), escaped by the renderer like every record string; no row for a record that carries neither
 * key, so every run outside a bundled project renders byte-identical.
 */
function bundleRows(r, locale = "en") {
  const got = recordBundle(r);
  if (got === null) return [];
  const b = got.bundle;
  const said = b ? [uiText(bundleReceivedText({ ...b, variables: b.variables.filter((name) => !b.shadowed.includes(name)) }), locale), b.shadowed.length > 0 ? `${uiText("shadowed by the trigger's own run.secrets:", locale)} ${b.shadowed.join(", ")}` : null, uiText(bundleCountsText(b) || "", locale) || null].filter(Boolean) : [];
  return [
    ["Secret bundle", said.length > 0 ? said.join("; ") : null],
    ["Bundle skipped", got.bundleSkipped !== null ? `${got.bundleSkipped}: ${uiText(BUNDLE_SKIPPED_TEXT[got.bundleSkipped], locale)}` : null],
  ];
}

/** Lineage is identifiers only. A damaged record never supplies link targets or arbitrary text. */
function forkRows(record) {
  const f = record.fork;
  if (!f || typeof f !== "object" || typeof f.id !== "string" || typeof f.fromJob !== "string" || typeof f.fromEntry !== "string" || !/^[0-9a-f]{32}$/.test(f.id ?? "") || !RUN_ID_RE.test(f.fromJob ?? "") || !/^[0-9a-f]{8}$/.test(f.fromEntry ?? "") || !["before", "at"].includes(f.position)) return [];
  return [["Forked from", runLink(f.fromJob)], ["Fork point", `${f.position} ${f.fromEntry}`], ["Fork model", typeof f.model === "string" && modelIdProblem(f.model) === null ? f.model : null]];
}

const recordSummary = withRun("Run", (r, view, source) => {
  const started = msOf(r.startedAt);
  const ended = msOf(r.endedAt);
  return html`${facts([
    ["Job", html`<span class="mono">${cell(r.jobId)}</span>`],
    ["Target", targetLink(r, view.env)],
    [kindLabel(r.kind), cell(r.kind)],
    ["Flow", cell(r.flow)],
    ["Outcome", t(outcomeText(r), view)],
    ["Reason", t(recordReason(r), view)],

    ["Exit code", cell(r.exitCode)],
    ["Attempt", cell(r.attempt)],
    ...recoveryRows(r, view.locale),
    ...forkRows(r),
    ["Host", cell(r.host)],
    [VENUE_LABEL, cell(r.backend)],
    ...skipRows(r, view),

    ["Project", cell(r.project)],

    ["Provider and model", [r.provider, r.model].filter(Boolean).join(" / ") || "-"],
    ["Model role", typeof r.modelRole === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(r.modelRole) ? r.modelRole : null],
    ["Agent refusals", modelRolesTelemetryOf(r.modelRoles)?.refusals.length || null],
    ["Model choice", t(modelChoiceSentence(r, view.locale), view)],
    ["Provider failure", t(providerFailureSentence(r.providerFailure, view.locale), view)],
    ["Provider reset", providerFailureOf(r.providerFailure)?.resetAt !== undefined ? timeHtml(r.providerFailure.resetAt) : null],
    ["Turns", `${cell(r.turns)}${Number.isSafeInteger(r.maxTurns) ? ` of ${r.maxTurns}` : ""}`],
    ["Trigger", r.triggerIndex !== null && r.triggerIndex !== undefined ? html`<a href="/config">row ${r.triggerIndex + 1}</a> (${cell(r.triggerType)})${view.data?.trigger ? `: ${[view.data.trigger.phrase, view.data.trigger.label, view.data.trigger.pattern].filter(Boolean).join(", ")} (as the triggers file says now)` : ""}` : "-"],
    ["MCP", view.data?.trigger ? `${view.data.trigger.mcp?.length ? view.data.trigger.mcp.join(", ") : t("none", view)} (${t("as the triggers file says now; the record does not say which connected", view)})` : null],
    ["Replica", Number.isInteger(r.replica) ? html`${r.replica} of ${cell(r.replicas)}${view.data?.siblings?.length ? html` · ${view.data.siblings.map((s) => html`${runLink(s.jobId)} ${ui.outcomeBadge(s.outcome, recordReason(s))} `)}` : null}` : null],
    ["Queued", Number.isFinite(msOf(r.queuedAt)) ? timeHtml(msOf(r.queuedAt)) : null],
    ["Wait for a slot", Number.isFinite(msOf(r.queuedAt)) && Number.isFinite(started) ? ageText(started - msOf(r.queuedAt)) : null],
    ["Stalled re-pick", r.stalledRepick ? t("This job was re-picked after its worker stopped reporting.", view) : null],
    ["Started", timeHtml(started)],
    ["Ended", timeHtml(ended)],
    ["Took", Number.isFinite(started) && Number.isFinite(ended) ? ageText(ended - started) : "-"],
    ["Read from", t(source === "mirror" ? "the fleet's run mirror" : "this host's run history", view)],
  ], view.locale)}`;
});

export const runCostPanel = withRun("Tokens", (r, view) => {
  const tokens = r.tokens ?? null;
  const amount = runCost(r);
  const attempts = view.data?.recoveryRuns ?? [];
  return html`${attempts.length > 1 ? html`<h3>${t("Each attempt", view)}</h3>${attempts.map((a) => html`<p>${runLink(a.jobId)}: ${costText(runCost(a))}.</p>`)}` : null}${facts([
    ["Tokens", t(costText(amount), view)],
    ["Measurement", amount ? `${t(amount.class, view)}${amount.floor ? ` (${t("a floor: the meter could not see all of it", view)})` : ""}` : t("not metered", view)],
    ["Input tokens", tokens ? count(tokens.input) : "-"],
    ["Output tokens", tokens ? count(tokens.output) : "-"],
    ["Total tokens", tokens ? count(tokens.total) : "-"],
    ["Model calls", tokens ? cell(tokens.calls) : "-"],
    ["Token split", tokens && (tokens.rootTotal != null || tokens.otherTotal != null || tokens.childTotal != null) ? `${count(tokens.rootTotal ?? 0)} this run, ${count(tokens.otherTotal ?? 0)} other sessions, ${count(tokens.childTotal ?? 0)} subprocesses` : null],
    ["Unmetered children", tokens?.unmeteredChildren],
    ["Usage unreported", tokens?.usageUnreported],
  ], view.locale)}`;
});

/** Bytes as MiB. */
const mib = (bytes) => (Number.isFinite(bytes) ? `${count(bytes / (1024 * 1024))} MiB` : "-");

export const runResources = withRun("Resources", (r, view) => {
  const x = r.resources ?? null;
  const size = r.size ?? null;
  return html`${x && size?.memMiB > 0 ? ui.meter({ value: x.memPeak, max: size.memMiB * 1024 * 1024, label: t("Peak memory against size given", view) }) : null}${facts([
    ["Size given", size ? `${count(size.memMiB)} MiB, ${Number.isSafeInteger(size.cpuCenti) && size.cpuCenti >= 0 ? coresText(size.cpuCenti) : "- cores"} (${cell(size.source)})` : "-"],
    ["Peak memory", x ? mib(x.memPeak) : "not reported"],
    ["Out-of-memory kills", x ? cell(x.oomKills) : null],
    ["CPU time", x && Number.isFinite(x.cpuUsec) ? `${(x.cpuUsec / 1e6).toFixed(1)} s` : null],
    ["Throttled", x && Number.isFinite(x.throttledUsec) ? `${(x.throttledUsec / 1e6).toFixed(1)} s` : null],
    ["Peak processes", x ? cell(x.pidsPeak) : null],
    ["Peak swap", x?.swapPeak != null ? mib(x.swapPeak) : null],
    ["Memory pressure", x ? `${(x.memSomeUsec ?? 0) / 1e6} s some, ${(x.memFullUsec ?? 0) / 1e6} s full` : null],
    ["Throttled periods", x?.throttledPeriods],
    ["Host offered at admission", r.capacity ? `${r.capacity.slots ?? "?"} slots, ${r.capacity.memMiB ?? "?"} MiB, ${r.capacity.cpuCenti === "off" ? "CPU budget off" : r.capacity.cpuCenti != null ? coresText(r.capacity.cpuCenti) : "CPU budget unknown"}; ${r.capacity.cpus ?? "?"} physical CPUs` : null],
  ], view.locale)}`;
});

/** A session object is kept unless its reason explicitly records a failed save; `absent` is a fresh start. */
function sessionSavedOf(record) {
  return record?.session !== null && typeof record?.session === "object" && !Array.isArray(record.session) && !SESSION_NOT_SAVED.includes(record.session.reason);
}

export const runSession = withRun("Session and plan", (r, view) => {
  const s = r.session ?? null;
  const p = r.plan ?? null;
  return facts([
    ["Session", s ? (s.resumed ? t("resumed", view) : `${t("fresh", view)}${typeof s.reason === "string" ? `: ${t(nestedText("session.reason", s.reason), view)}` : ""}`) : t("this trigger keeps no session", view)],
    ["Kept", sessionSavedOf(r) ? `${t("for the next run on", view)} ${r.target ?? t("this target", view)}` : null],
    ["Transcript", s && Number.isFinite(s.bytes) ? `${count(s.bytes / 1024)} KB ${t("in the session store", view)}` : null],
    ["Plan", p ? `${cell(t(p.outcome, view))}${p.clamped ? `, ${t("clamped", view)}` : ""}${typeof p.reason === "string" && p.reason !== "" ? `: ${t(nestedText("plan.reason", p.reason), view)}` : ""}` : t("none", view)],
    ["Plan id", p?.planId ? html`<span class="mono">${p.planId}</span>` : null],
  ], view.locale);
});

export const runChain = withRun("Chain", (r, view) => {
  const kids = Array.isArray(view.data?.children) ? view.data.children : [];
  if (!r.parentJobId && kids.length === 0 && !(r.chainRefused > 0)) return ui.collapsed({ icon: "chain", title: t("No parent or child runs", view), body: `${t("No child run among the", view)} ${count(view.data?.childrenSearched ?? 0)} ${t("newest runs.", view)}` });
  return html`${facts([
    ["Parent", r.parentJobId ? runLink(r.parentJobId) : t("none", view)],
    ["Depth", cell(r.chainDepth)],
    ["Refused chain requests", `${cell(r.chainRefused)}; a job may queue at most ${view.data?.chainMaxPerJob ?? CHAIN_MAX_PER_JOB_DEFAULT} (PI_CHAIN_MAX_PER_JOB)`],
  ], view.locale)}<h3>${t("Children", view)}</h3>${kids.length === 0 ? html`<p class="note">${t("No child run among the", view)} ${count(view.data?.childrenSearched ?? 0)} ${t("newest runs.", view)}</p>` : html`<ul class="plain">${kids.map((k) => html`<li>${runLink(k.jobId)} ${t(outcomeText(k), view)}</li>`)}</ul>`}`;
});

/** The elapsed run time, with fixed-width components so updates do not move the card. */
export function timecode(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map((n) => String(n).padStart(2, "0")).join(":");
}

/** The title's changing line also carries its status and the active run's destructive preview. */
export function runHeadline(view) {
  const r = recordOf(view), a = view.data?.activeRun;
  const state = view.data?.queueState;
  const recovering = r?.reason === "recovery-enqueued" && (state?.activeJobId || state?.queuedJobId);
  const active = state?.jobState === "active" || runningWithoutRecord(view);
  const badge = recovering ? ui.badge("running", t("Recovering", view)) : r ? ui.badge(outcomeWord(r.outcome, recordReason(r)).status, t(capitalised(outcomeWord(r.outcome, recordReason(r)).word), view)) : ui.badge(active ? "running" : "idle", t(active ? "Running" : QUEUED_STATES.includes(state?.jobState) ? "Queued" : "Unknown", view));
  const facts = r ?? a ?? {};
  const cancel = canAct(view) && state?.jobState === "active" && RUN_ID_RE.test(view.query?.id ?? "") ? ui.actForm({ action: "cancel-active", hidden: [["jobId", view.query.id]], label: t("Cancel run", view), kind: ["sm", "danger"], icon: "cancel" }) : null;
  return html`${badge} ${facts.project ? ui.ptag(facts.project) : null} ${facts.target ? targetLink(facts, view.env) : null} ${facts.flow ?? ""} ${facts.host ? `${t("on", view)} ${facts.host}` : ""} ${facts.endedAt ? timeHtml(msOf(facts.endedAt)) : facts.startedAt ? timeHtml(msOf(facts.startedAt)) : null}${cancel}`;
}

export function runSummary(view) {
  if (recordOf(view)) {
    if (fromNewerRelease(recordOf(view))) return newerSummary(recordOf(view), view.data?.run?.source, view.locale);
    if (refusedBeforeStart(recordOf(view))) return titled("Run", facts([["Job", recordOf(view).jobId], ["Target", targetLink(recordOf(view), view.env)], ["Project", recordOf(view).project], ["Host", recordOf(view).host], [VENUE_LABEL, recordOf(view).backend]], view.locale), view.locale);
    return recordSummary(view);
  }
  const a = view.data?.activeRun;
  if (!a) return html``;
  return titled("Run", facts([["Target", targetLink(a, view.env)], ["Project", a.project], ["Flow", a.flow], ["Host", a.host], [VENUE_LABEL, a.backend], ["Provider and model", [a.provider, a.model].filter(Boolean).join(" / ")], ["Queue", a.queue], ["Queued", timeHtml(msOf(a.queuedAt))], ["Started", timeHtml(msOf(a.startedAt))]], view.locale), view.locale);
}

export function runRecord(view) {
  return recordOf(view) || !runningWithoutRecord(view) ? html`` : ui.collapsed({ icon: "runs", title: t("Run record, tokens, resources, session and chain are written when the run ends.", view) });
}

export function runRest(view) {
  return refusedBeforeStart(recordOf(view)) ? ui.collapsed({ icon: "runs", title: t("Nothing ran, so there is no progress, transcript or spend.", view), body: t("Session fresh, no parent or child runs.", view) }) : html``;
}

export function runTranscriptState(view) {
  if (refusedBeforeStart(recordOf(view))) return html``;
  const meta = view.data?.transcript;
  const r = recordOf(view);
  const outcome = outcomeWord(r?.outcome ?? meta?.outcome, recordReason(r)).word ?? r?.outcome ?? meta?.outcome ?? "unknown";
  const state = view.locale === "zh" ? meta?.exists ? meta.ended ? `已结束（${t(outcome, view)}）；运行结束后保留 24 小时。` : `正在从 ${r?.host ?? view.data?.activeRun?.host ?? "worker"} 实时传输。` : meta?.unreachable ? "无法读取实时对话记录；下次刷新时重试。" : r ? transcriptAbsent(r, view.locale) : "正在等待运行的实时对话记录。运行开始后会在此显示。" : meta?.exists ? meta.ended ? `Ended (${outcome}); kept 24 hours after the end.` : `Streamed from ${r?.host ?? view.data?.activeRun?.host ?? "the worker"} as it happens.` : meta?.unreachable ? "The live transcript could not be read; the next update tries again." : r ? transcriptAbsent(r) : "Waiting for the run's live transcript. It attaches here when it starts.";
  return titled("Live transcript", html`<p data-transcript-status role="status" aria-live="polite">${state}</p>`, view.locale);
}

export function runActionsPanel(view) {
  const r = recordOf(view);
  if (!r || view.role !== "operator" || !RUN_ID_RE.test(r.jobId ?? "")) return html``;
  const continuing = r.reason === "recovery-enqueued" && [view.data?.queueState?.activeJobId, view.data?.queueState?.queuedJobId].some((id) => typeof id === "string" && id !== r.jobId);
  if (continuing) return html``;
  return titled("Actions", html`${rerunLine(r, view)}${forkLine(r, view)}${isSchedulerJobId(r.jobId) ? html`<p>${t("A cron run is fired again by hand from its trigger as the triggers file says now.", view)}</p>` : null}`, view.locale);
}

export function runSecrets(view) {
  const r = recordOf(view);
  if (!r || (!recordBundle(r) && !recordSecretsProfile(r))) return html``;
  const got = recordBundle(r), b = got?.bundle;
  const names = (b?.variables ?? []).filter((name) => !b.shadowed.includes(name));
  const chipTag = (name) => ui.chip(`${name}${Array.isArray(b.placeholderNames) ? `${view.locale === "zh" ? "（" : " ("}${b.placeholderNames.includes(name) ? t("placeholder", view) : t("value", view)}${view.locale === "zh" ? "）" : ")"}` : ""}`);
  return titled("Secrets", html`${facts([["Secrets profile", t(recordSecretsProfile(r), view)], ...bundleRows(r, view.locale)], view.locale)}${Array.isArray(names) && names.length ? html`<p>${names.map(chipTag)}</p>` : null}${b?.shadowed?.length ? html`<p>${t("The trigger's value won; the bundle's was not passed:", view)} ${b.shadowed.join(", ")}.</p>` : null}<p class="card__sub">${t("Names only: no secret value reaches a log, a record or this page.", view)}</p>`, view.locale);
}

export function runModels(view) {
  const r = recordOf(view), u = r?.usage;
  if (hiddenRecord(view) || !u) return html``;
  const models = Array.isArray(u.models) ? u.models : [];
  return titled("Model usage", html`${localizedTable("Model usage", ["Provider", "Model", "Calls", "Input", "Output", "Cost"], models.map((m) => html`<tr><td>${m.provider}</td><td>${m.model}</td><td>${count(m.calls)}</td><td>${count(m.input)}</td><td>${count(m.output)}</td><td>${tokensText(Number.isFinite(m.cost) ? Math.round(m.cost * 1e6) : null)}</td></tr>`), "No per-model usage was recorded.", view.locale)}${facts([["Cache reads", models.reduce((n, m) => n + (m.cacheRead ?? 0), 0)], ["Cache writes", models.reduce((n, m) => n + (m.cacheWrite ?? 0) + (m.cacheWrite1h ?? 0), 0)], ["Unpriced calls", r.tokens?.unpriced], ["No model resolved", r.tokens?.unresolved]], view.locale)}<p>${t("Priced by pi-ai", view)} ${u.piAi ?? "unknown"} ${t("at stream time.", view)}</p>`, view.locale);
}

/** Counts are positioned evenly: a record has no checkpoint timestamps, so the track invents none. */
function recoveryTrack(record, next, view) {
  const c = recordRecovery(record)?.checkpoints;
  const total = (c?.written ?? 0) + (c?.failed ?? 0) + (c?.skipped ?? 0);
  const visible = Math.min(total, 24);
  const marks = Array.from({ length: visible }, (_, i) => {
    const kind = i < (c?.written ?? 0) ? "written" : i < (c?.written ?? 0) + (c?.failed ?? 0) ? "failed" : "skipped";
    return html`<g class="run-cp run-cp--${kind}"><title>${uiText(kind, view.locale)} ${uiText("checkpoint", view.locale)} ${i + 1}; ${uiText("its time was not recorded", view.locale)}</title><circle cx="${40 + (visible <= 1 ? 0 : i * 270 / (visible - 1))}" cy="20" r="4"></circle></g>`;
  });
  return html`<div class="run-track"><svg viewBox="0 0 640 110" role="img" aria-label="${uiText("Attempt and recovery; checkpoint positions are evenly spaced, not timestamps", view.locale)}"><line class="run-track__line" x1="20" y1="70" x2="620" y2="70"></line><rect class="run-track__attempt" x="20" y="42" width="300" height="28" rx="14"></rect><text x="34" y="61">${uiText("Attempt", view.locale)} ${record.attempt ?? 1}: ${uiText(outcomeWord(record.outcome, recordReason(record)).word ?? record.outcome, view.locale)}</text>${marks}${next ? html`<line class="run-track__wait" x1="325" y1="56" x2="390" y2="56"></line><rect class="run-track__next" x="395" y="42" width="225" height="28" rx="14"></rect><text x="408" y="61">${uiText(view.data?.queueState?.activeJobId === next ? "Recovery running" : "Recovery queued", view.locale)}</text>` : null}</svg></div><p class="card__sub">${uiText("Checkpoint positions are evenly spaced; their times and kinds were not recorded.", view.locale)}${total > visible ? ` ${total - visible} ${uiText("more checkpoints are counted below.", view.locale)}` : ""}</p>`;
}

export function runRecovery(view) {
  const r = recordOf(view), rec = r ? recordRecovery(r) : null;
  if ((!rec && !view.data?.trigger?.recover && !String(r?.reason ?? "").startsWith("recovery-")) || refusedBeforeStart(r)) return html``;
  const next = view.data?.queueState?.activeJobId ?? view.data?.queueState?.queuedJobId;
  const continuation = typeof next === "string" && next !== r.jobId ? next : null;
  const recovered = rec?.recovered ?? [...(view.data?.recoveryRuns ?? [])].reverse().map((record) => recordRecovery(record)?.recovered).find(Boolean);
  const earlier = recordedEarlier(r.earlier) ?? [];
  const queuedAt = msOf(view.data?.recoveryLive?.queuedAt), startedAt = msOf(view.data?.recoveryLive?.startedAt);
  const recTitle = `${uiText("Recovery", view.locale)}${Number.isInteger(r.triggerIndex) ? `: run.recover ${uiText("is armed on trigger row", view.locale)} ${r.triggerIndex + 1}` : ""}`;
  return titled(recTitle, html`${continuation || rec?.checkpoints ? recoveryTrack(r, continuation, view) : null}${facts(recoveryRows(r, view.locale), view.locale)}${!rec && !continuation ? html`<p>${t("None needed: this run finished on its first attempt.", view)}</p>` : null}${continuation ? html`<p>${ui.badge(view.data.queueState.activeJobId === continuation ? "running" : "idle", t(view.data.queueState.activeJobId === continuation ? "Recovery running" : "Recovery queued", view))} ${runLink(continuation)}.</p>` : null}${recovered ? facts([["Restored from", `${recovered.from} ${t("checkpoint", view)} ${recovered.checkpointSeq ?? `(${t("sequence not recorded", view)})`}`], ["Recovery", `${recovered.n} ${t("of at most", view)} ${RECOVERY_CAP}`], ["Calls replayed", recovered.replayed], ["Calls interrupted (may or may not have happened)", recovered.interrupted], ["Calls not started", recovered.notStarted]], view.locale) : null}${recovered?.checkpointSeq ? html`<p>${t("The agent was told it restarts from checkpoint", view)} ${recovered.checkpointSeq}. ${t("Its workspace was restored, with .pi/, .agents/ and the root context files reset to the base commit. It checks before repeating anything with outside effects.", view)}</p>` : null}${Number.isFinite(queuedAt) ? html`<p>${t("Wait for a slot:", view)} ${ageText((Number.isFinite(startedAt) ? startedAt : view.now) - queuedAt)} ${t("on", view)} ${view.data.recoveryLive.host ?? r.host}.</p>` : null}${earlier.map((a) => html`<p>${t("Retried: an earlier attempt ran on", view)} ${a.host}, ${timeHtml(msOf(a.startedAt))} ${t("to", view)} ${timeHtml(msOf(a.endedAt))}.</p>`)}${r.stalledRepick ? html`<p>${t("Re-picked: its worker stopped answering and this pickup ran it again.", view)}</p>` : null}${view.role === "operator" ? html`<div data-recovery-tools></div>` : null}<p class="card__sub">${t("Recovery queued waits for the checkpoint's host:", view)} ${RECOVERY_TTL_MS / 3_600_000} ${t("hours, longer while that host is alive, at most", view)} ${RECOVERY_MAX_WAIT_MS / 86_400_000} ${t("days.", view)}</p>`, view.locale);
}

function hostFacts(view, name) {
  const s = view.data?.snapshot;
  return { host: (Array.isArray(s?.hostBudgets) ? s.hostBudgets : []).find((h) => h.name === name) ?? null,
    doctor: doctorHostsOf(s).filter((d) => d.name === name).sort((a, b) => (a.ageMs ?? Infinity) - (b.ageMs ?? Infinity))[0] ?? null };
}

export function runWhy(view) {
  const r = recordOf(view);
  if (!refusedBeforeStart(r)) return html``;
  const token = recordReason(r), n = view.data?.runsWindow?.byReason?.[token];
  const { host, doctor } = hostFacts(view, r.host);
  const floor = host?.backends?.floor;
  const properties = floor && typeof floor === "object" ? Object.entries(floor) : [];
  const said = token ? explainReason(token, { why: r.why }) : null;
  return titled("Why it was refused", html`${facts([["Rule", said?.known ? ui.withCode(t(said.sentence, view)) : t("No explanation is recorded for this rule yet.", view)], ["Venue floor (PI_BACKEND_FLOOR)", properties.length ? properties.map(([name, want]) => html`<span>${t(PROPERTY_LABEL[name] ?? name, view)}: ${want}; ${r.backend ?? UNATTRIBUTED_BACKEND} ${t("declares", view)} ${t(DECLARATION_TEXT[declarationOf(r.backend ?? UNATTRIBUTED_BACKEND, name)?.word] ?? "unknown", view)}. </span>`) : t("This host has not published a floor.", view)], ["Same reason in the last 24 hours", Number.isFinite(n) ? html`<a href="/runs?reason=${encodeURIComponent(token)}">${count(n)}</a>` : t("could not be read", view)], ["Newest doctor result", doctor && !doctor.unreadable ? `${doctorCountsText(doctor)}, ${ageText(doctor.ageMs)} ${t("ago", view)}` : t("not published or could not be read", view)]], view.locale)}${view.role === "operator" ? ui.cmd(["pi-dispatch", "doctor"], { host: `${t("Run it on", view)} ${r.host ?? t("the worker host", view)}; ${t("the console runs nothing on a host.", view)}` }) : html`<p>${t("Ask an operator to run the host's doctor checks.", view)}</p>`}`, view.locale);
}

export function runHost(view) {
  const r = recordOf(view);
  if (!refusedBeforeStart(r)) return html``;
  const { host, doctor } = hostFacts(view, r.host);
  const age = beatAgeOf(host), fail = doctorProblems(doctor).find((p) => p.level === "fail");
  const queues = Array.isArray(view.data?.snapshot?.queueCounts) ? view.data.snapshot.queueCounts : [];
  const queue = queues.find((q) => q.queue === host?.queue || q.queue === `pi-jobs@${r.host}`);
  return titled("The host", html`${facts([["Host", r.host], [VENUE_LABEL, r.backend ?? UNATTRIBUTED_BACKEND], ["Heartbeat", Number.isFinite(age) ? `${ageText(age)} ${t("ago", view)}` : t("could not be read", view)], ["Newest failing doctor check", fail ? fail.label : doctor && !doctor.unreadable ? t("none in its newest result", view) : t("could not be read", view)], ["Queue waiting", queue ? count(queue.counts?.waiting) : t("could not be read", view)], ["Queue running", queue ? count(queue.counts?.active) : t("could not be read", view)]], view.locale)}<a href="/fleet">${t("Open Fleet for this host's queues and doctor checks", view)}</a>`, view.locale);
}

export function runViewer(view) {
  return view.role !== "operator" ? ui.banner({ status: "idle", sm: true, icon: "shield", title: t("Signed in as a viewer", view), body: t("Transcripts, phase names, the run's note, failure reasons and every action are shown to operators only.", view) }) : html``;
}

/** Only exact retained points are selectable; ids carry no transcript text into the page. */
function forkLine(r, view) {
  if (!canAct(view)) return null;
  const points = view.data?.forkPoints;
  if (!points?.ok) return html`<p>${t("Fork unavailable:", view)} ${t((r.forkSource?.saved === false ? forkRefusalWords(forkArchiveFact(r.forkSource).reason) : forkRefusalWords(points?.refusal)) ?? forkRefusalWords("fork-source-unavailable"), view)}.</p>`;
  const entries = points.entries.filter((e) => e.positions?.length);
  if (!entries.length) return html`<p>${t("Fork unavailable:", view)} ${t("no exact workspace point is retained.", view)}</p>`;
  return html`<form class="act" id="run-fork" data-action="run-fork" autocomplete="off"><input type="hidden" name="jobId" value="${r.jobId}">
    <p><b>${t("Fork this run.", view)}</b> ${t("Continue from a retained point on a separate branch and pull request.", view)}</p>
    ${ui.field({ label: t("Fork point", view), id: "fork-point", control: ui.select({ id: "fork-point", name: "point", options: entries.flatMap((e) => e.positions.map((position) => ({ value: `${e.id}:${position}`, label: `${position} ${e.id} (${e.role ?? e.type})` }))) }) })}
    ${ui.field({ label: t("Provider (optional)", view), id: "fork-provider", control: ui.input({ id: "fork-provider", name: "provider" }) })}
    ${ui.field({ label: t("Model (optional)", view), id: "fork-model", control: ui.input({ id: "fork-model", name: "model" }) })}
    ${ui.field({ label: t("Thinking level (optional)", view), id: "fork-thinking", control: ui.select({ id: "fork-thinking", name: "thinking", options: ["", ...FORK_THINKING_LEVELS] }) })}
    ${ui.field({ label: t("Message (optional)", view), id: "fork-message", control: ui.input({ id: "fork-message", name: "message" }) })}
    ${ui.btn({ type: "submit", label: t("Preview a fork", view), kind: ["sm", "paid"], icon: "rerun" })}</form>`;
}

/** Private answer-rule text is mounted only on operator run pages. */
export const runAnswerDraft = answererRun;
