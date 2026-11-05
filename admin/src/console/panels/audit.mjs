/**
 * The audit screen's panels (issue #737, the AuditScreen card), split out of `../panels.mjs` (issue #737), which
 * re-exports what this module exports. The rules every panel keeps (one pure, deterministic renderer per region, every
 * value through `html`, the role and run-text rule) are stated once, in `../panels.mjs`'s header.
 *
 * Four panels, in page order: the chain's state first (`p-audit-chain`, a banner that says how far the hash chain is
 * verified and, when a row is damaged, what to do), the filters (`p-audit-filter`, a plain GET form), the log itself
 * (`p-audit`), and what the log is (`p-audit-about`). Each reads `view.data.audit`, the view `audit-view.mjs`
 * `readAuditView` builds, and `view.query`, its `parseAuditQuery` result. Drawn in the Pulse kit's markup: the screen
 * left the legacy layer with this module.
 *
 * THE ROLE RULE. The audit log is an operator's page (the route refuses a viewer, and `renderPage`'s belt draws no
 * panel for one); each panel draws nothing for another role all the same, the log's panel the role's sentence, so a
 * view a caller mis-wires still carries no row.
 *
 * WHAT A ROW SAYS ABOUT ITSELF IS SHOWN AS ITS STATE ALLOWS. A verified row shows the outcome it was written with; a
 * damaged one, one after it, the one before a broken link and one written since the last check show their state in the
 * outcome column (the outcome as written moves to a note under the reason), since the chain does not vouch for what
 * such a row says.
 *
 * A ROW WITH A WORD THIS CONSOLE DOES NOT KNOW (issue #761): an action or outcome this console does not list, of the
 * shape the console writes, which the chain check links like any other row (a newer release writes such rows). It keeps
 * its state, and its outcome shows as the word written on the attention badge. Only a verified row (state `ok`) says,
 * in a note under its reason, which word this console does not know, and About counts them only on an intact chain: the
 * check vouches for nothing else a row says, so a row it does not vouch for is never labelled by its words. The
 * filter's lists stay this console's own, so such a row is found unfiltered and under who, role and the search.
 */
import { CONSOLE_AUDIT_ACTION_RE, CONSOLE_AUDIT_ACTIONS, CONSOLE_AUDIT_OUTCOME_RE, CONSOLE_AUDIT_OUTCOMES } from "@edgehero/pi-dispatch/console-audit";
import { AUDIT_ACTOR_ROLES, AUDIT_EXAMINE_MAX, AUDIT_OUTCOME_WORDS, AUDIT_Q_MAX, auditDriver, auditFiltered, auditQueryString, isAuditRow } from "../audit-view.mjs";
import { html } from "../html.mjs";
import * as ui from "../kit.mjs";
import { uiText } from "../locale.mjs";
import { msOf, timeHtml, tokensText } from "./common.mjs";

/** What a role that is not an operator reads in the log's panel (the belt; see the header). */
export const AUDIT_OPERATORS_ONLY = "The audit log is shown to operators only.";
const t = (message, view) => uiText(message, view?.locale);
const fmt = (pattern, values, locale = "en") => Object.entries(values).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, String(value)), uiText(pattern, locale));

/**
 * The command that walks the same chain on the host, named wherever the page cannot vouch for a row: in the code face,
 * each word a box of its own (`page-css.mjs` AUDIT_CSS), so a sentence wraps it only between its words.
 */
const VERIFY_CMD = html`<span class="code">${"pi-dispatch-console audit verify".split(" ").map((w, i) => html`${i === 0 ? null : " "}<span>${w}</span>`)}</span>`;

const GROUPED = new Intl.NumberFormat("en-US");

/** The audit page's path with a query (`auditQueryString`'s form), or the bare path for none. */
function auditHref(query, over = {}) {
  const s = auditQueryString(query, over);
  return s === "" ? "/audit" : `/audit?${s}`;
}

/** A place, `YYYY-MM:<line>`, as `[month, line]`, or null. */
function placeOf(pos) {
  const m = typeof pos === "string" ? /^(\d{4}-\d{2}):(\d{1,16})$/.exec(pos) : null;
  return m === null ? null : [m[1], Number(m[2])];
}

/**
 * The id of the table row at `pos`: `seq-<n>` for a row whose seq this page has not used yet, so a link to a row by its
 * number lands on it (`/audit?seq=41#seq-41`, the done banner's), and `line-<yyyy>-<mm>-<line>` for a damaged entry, a
 * row at the broken place and a repeated seq, so every id is once on the page whatever a tampered file holds, and a
 * damaged place's id is known from the verifier's place alone (the chain banner's Show link).
 */
function rowId(entry, pos, state, used) {
  if (isAuditRow(entry) && state !== "damaged" && !used.has(entry.seq)) {
    used.add(entry.seq);
    return `seq-${entry.seq}`;
  }
  const at = placeOf(pos);
  return at === null ? null : `line-${at[0]}-${at[1]}`;
}

/**
 * The outcome column's badge for a row in `state` (see the header and `AUDIT_OUTCOME_WORDS`). A verified row's outcome
 * is looked up only when the console writes it: a word this console does not know (issue #761) that happens to name a
 * state ("damaged") must not wear that state's badge, so it takes the attention badge with the word as written.
 */
function outcomeCell(entry, state, locale = "en") {
  const key = state === "ok" ? (CONSOLE_AUDIT_OUTCOMES.includes(entry.outcome) ? entry.outcome : null) : state;
  const w = typeof key === "string" && Object.hasOwn(AUDIT_OUTCOME_WORDS, key) ? AUDIT_OUTCOME_WORDS[key] : { status: "attention", icon: null, word: String(entry.outcome ?? "unknown") };
  return ui.badge(w.status, uiText(w.word, locale), { icon: w.icon });
}

/**
 * A missing value, drawn faint; on a damaged row's tint, muted instead: `ink-faint` is a hint colour held to 4.5:1 on the
 * surfaces only and reads 4.34:1 on `failed-tint` in the light theme, while `ink-muted` is a pinned pair on that tint
 * (`console-contrast.test.mjs`).
 */
const NONE = html`<span class="faint">-</span>`;
const NONE_ON_TINT = html`<span class="muted">-</span>`;

/**
 * The damaged place, as the page names it everywhere (the banner's title and sentence, About): the line the chain check
 * names, "line 8 of 2026-10.jsonl", the one `audit verify` prints. Never "row 8": the number a damaged line carries is
 * what the chain does not vouch for (a line that is no row carries none), and the first version, which said "row 8"
 * only when this page had read that line, named one place two ways, by its row on the page that held it and by its
 * line on every other.
 */
function damagedLabel(a, locale = "en") {
  const b = a?.chain?.broken;
  return b ? `${uiText("line", locale)} ${b.line} ${uiText("of", locale)} ${b.file}` : null;
}

/** A sentence's first letter in capitals ("row 7" leads one as "Row 7"). */
const lead = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** The note under a row's reason for a state the chain does not vouch for, with the outcome it was written with. */
function stateNote(entry, state, chain, locale = "en") {
  const written = typeof entry.outcome === "string" ? ` ${uiText("Written as", locale)} ${entry.outcome}.` : "";
  if (state === "unverified") return html`<span class="reason">${uiText("Not verified: it follows the damaged row.", locale)}${written}</span>`;
  // The row before a break whose line shows no prev that matches it: nothing vouches for it (audit-view.mjs header).
  if (state === "suspect") return html`<span class="reason">${uiText("Not verified: the link to the row after it does not hold.", locale)}${written}</span>`;
  if (state === "unchecked") {
    const why = uiText(chain?.state === "unreadable" ? "Not checked: the chain could not be checked." : "Written after the last check; the next one covers it.", locale);
    return html`<span class="reason">${why}${written}</span>`;
  }
  return null;
}

/**
 * The note under a verified row's reason for an action or outcome this console does not know (issue #761, the header):
 * a word of the console's shape that this console does not list, or null. Only for `state` ok: on any other row the
 * chain does not vouch for what the row says, so its words are never labelled as what a newer release writes. A word of
 * no such shape gets no note either (the chain check refuses it). The words are plain text in the sentence, as the
 * state note's "Written as" is.
 */
function unknownWordsNote(entry, state, locale = "en") {
  if (state !== "ok") return null;
  const unknown = (value, list, re) => typeof value === "string" && re.test(value) && !list.includes(value);
  const words = [
    unknown(entry.action, CONSOLE_AUDIT_ACTIONS, CONSOLE_AUDIT_ACTION_RE) ? `the action ${entry.action}` : null,
    unknown(entry.outcome, CONSOLE_AUDIT_OUTCOMES, CONSOLE_AUDIT_OUTCOME_RE) ? `the outcome ${entry.outcome}` : null,
  ].filter(Boolean);
  return words.length === 0 ? null : html`<span class="reason">${uiText("Not known to this console:", locale)} ${words.join(` ${uiText("and", locale)} `)} (${uiText("a newer release writes such rows", locale)}).</span>`;
}

/**
 * The reason column's cell: never narrower than `AUDIT_LAYOUT.reasonMin` (`page-css.mjs`), whatever the cells beside it
 * hold, so a damaged row's sentence reads as a few lines and not as a column of single words (16
 * lines at 1440 px without it).
 */
const reasonCell = (inner) => ({ wide: true, html: html`<span class="au-why">${inner}</span>` });

/**
 * What a row's `count` counts depends on its write kind: a bulk write's row is one of `count` rows, one per job the
 * write listed; a resume's is the jobs that were waiting to start when it was confirmed (`actions.mjs`
 * `resumeWaiting`). Read as bulk membership, a single resume read "one of 2 in a bulk write". `AUDIT_BULK_KINDS` is the
 * kinds of the actions with `bulk: true` and `AUDIT_WAITING_KINDS` the resumes', both held to the action table by the
 * test; a count on any other kind is said as it is stored.
 */
export const AUDIT_BULK_KINDS = Object.freeze(["held-cancel-all", "failed-retry-all", "failed-remove-all"]);
export const AUDIT_WAITING_KINDS = Object.freeze(["fleet-resume", "queue-resume"]);

/** A row's `count` in words, `alone` when no reason comes before it (see `AUDIT_BULK_KINDS`). */
function countText(kind, n, alone, locale = "en") {
  if (AUDIT_BULK_KINDS.includes(kind)) return alone ? `${uiText("one of", locale)} ${n} ${uiText("in a bulk write", locale)}` : `${uiText("one of", locale)} ${n}`;
  if (AUDIT_WAITING_KINDS.includes(kind)) return `${n} ${uiText(n === 1 ? "job was" : "jobs were", locale)} ${uiText("waiting", locale)}`;
  return `${uiText("count", locale)} ${n}`;
}

/** One table row of the log (`kit.tbl`'s `{ cells, mark, id }`). */
function rowOf({ entry, pos, state }, chain, used, locale = "en") {
  const id = rowId(entry, pos, state, used);
  if (!isAuditRow(entry)) {
    const file = typeof entry?.file === "string" ? entry.file : uiText("an audit file", locale);
    const line = Number.isSafeInteger(entry?.line) ? entry.line : 0;
    const reason = typeof entry?.reason === "string" && entry.reason !== "" ? entry.reason : null;
    const what = line > 0
      ? html`<b>${fmt("Not an audit row: line {line} of {file}.", { line, file }, locale)}</b> ${uiText("Changed, or written by something else.", locale)}`
      : html`<b>${fmt("Not an audit row: the file {file} could not be read", { file }, locale)}${reason ? ` (${reason})` : ""}.</b> ${uiText("Its rows are not shown.", locale)}`;
    const at = line > 0 ? html`<span class="code au-tgt">${file}:${line}</span>` : html`<span class="code au-tgt">${file}</span>`;
    return { id, mark: "failed", cells: [NONE_ON_TINT, NONE_ON_TINT, NONE_ON_TINT, NONE_ON_TINT, { wide: true, html: at }, outcomeCell(entry, "damaged", locale), reasonCell(html`<span class="au-dmg">${what}</span>`)] };
  }
  const none = state === "damaged" ? NONE_ON_TINT : NONE;
  const actor = entry.actor && typeof entry.actor === "object" ? entry.actor : null;
  const driver = auditDriver(entry);
  const who = actor ? html`<span class="au-who">${actor.name ?? "-"}<small>${uiText(actor.role ?? "-", locale)}</small>${driver ? html`<small>${uiText("driver:", locale)} ${driver.name}</small>` : null}</span>` : none;
  // The cells beside the reason are bounded (`page-css.mjs` `AUDIT_LAYOUT`): a long name, write kind or target wraps
  // inside its own width instead of taking the reason's.
  const action = html`<span class="code">${entry.action ?? "-"}</span>${typeof entry.kind === "string" ? html`<span class="reason au-kind">${entry.kind}</span>` : null}`;
  const target = typeof entry.target === "string" && entry.target !== "" ? html`<span class="code au-tgt">${entry.target}</span>` : none;
  const said = [typeof entry.reason === "string" && entry.reason !== "" ? uiText(entry.reason, locale) : null, Number.isSafeInteger(entry.reserve) ? `${uiText("reserve", locale)} ${tokensText(entry.reserve)}` : null].filter(Boolean).join(", ");
  // The count after the reason in brackets, or alone as its own words (a bracket with nothing before it read as a stray
  // aside).
  const count = Number.isSafeInteger(entry.count) ? (said === "" ? countText(entry.kind, entry.count, true, locale) : ` (${countText(entry.kind, entry.count, false, locale)})`) : "";
  // The faint dash stands for a cell with nothing in it: a row whose state note fills the cell has no dash before it.
  const note = stateNote(entry, state, chain, locale);
  const unknownNote = unknownWordsNote(entry, state, locale);
  const reasonText = said === "" && count === "" ? (note === null && unknownNote === null ? none : null) : html`${said}${count}`;
  const reason = state === "damaged"
    ? html`<span class="au-dmg"><b>${uiText("The chain check says:", locale)}</b> ${chain?.broken?.reason ?? uiText("this row's link to the one before it does not hold", locale)}.</span>`
    : html`${reasonText}${note}${unknownNote}`;
  return {
    id,
    mark: state === "damaged" ? "failed" : null,
    cells: [html`<b>${entry.seq}</b>`, { when: true, html: html`<span class="au-at">${timeHtml(msOf(entry.at))}</span>` }, who, action, { wide: true, html: target }, outcomeCell(entry, state, locale), reasonCell(reason)],
  };
}

/** `k` rows, grouped ("2,000 rows", "1 row"). */
const rowsText = (k, locale = "en") => `${GROUPED.format(k)} ${uiText(k === 1 ? "row" : "rows", locale)}`;

/**
 * Why a seq page read the log from its newest row rather than at the place the chain check counted for its row: one
 * clause for each way the check could not place it (`view.seek.by`, audit-view.mjs; an unplaced row's by the chain's
 * state, since that is what left it uncounted), or null when the row was read at its place. The same clause says how a
 * row was found and why one was not, so the page never reports a walk without its reason.
 */
function walkWhy(a, s, locale = "en") {
  const by = a.seek?.by;
  if (by === "newer") return Number.isSafeInteger(a.chain?.through) ? fmt("the last chain check counted rows up to row {through}", { through: a.chain.through }, locale) : fmt("the last chain check did not count row {seq}", { seq: s }, locale);
  if (by === "misplaced") return fmt("row {seq} is not where the chain check counted it (the files changed since it ran)", { seq: s }, locale);
  if (by !== "unplaced") return null;
  if (a.chain?.state === "broken") return fmt("the chain check stops at the damaged row, so it cannot count to row {seq}", { seq: s }, locale);
  if (a.chain?.state === "unreadable") return fmt("the chain could not be checked, so row {seq} cannot be found by its number", { seq: s }, locale);
  return fmt("the chain check gave no place for row {seq}", { seq: s }, locale);
}

/**
 * What a seq page says about its row (`view.seek`, audit-view.mjs): found, and how when it took a walk; not written yet;
 * reaped; or, after a walk, why the walk ran and where it got to. Said once: in the foot over rows, in the empty state
 * over none.
 */
function seqSentence(a, s, locale = "en") {
  const k = a.seek ?? {};
  const why = walkWhy(a, s, locale);
  if (a.found) return why === null ? fmt("The page that holds row {seq}.", { seq: s }, locale) : fmt("The page that holds row {seq}, found by reading from the newest row: {why}.", { seq: s, why }, locale);
  if (Number.isSafeInteger(k.newest) && s > k.newest) return fmt("Row {seq} does not exist yet: the newest row is {newest}.", { seq: s, newest: k.newest }, locale);
  if (Number.isSafeInteger(k.first) && s < k.first) return fmt("The log starts at row {first}: row {seq} was reaped by retention, or removed.", { first: k.first, seq: s }, locale);
  const said = why === null ? "" : `${lead(why)}. `;
  if (a.stopped) return fmt("{lead}Row {seq} is not among the newest {rows}; Older lists the rows below them.", { lead: said, seq: s, rows: rowsText(a.examined, locale) }, locale);
  // A walk run because the files changed since the check stops at the first row below the chunk, and a changed file can
  // hold that row out of its order, so such a walk cannot say the row is gone.
  return k.by === "misplaced" ? fmt("{lead}Reading from the newest row did not find it either.", { lead: said }, locale) : fmt("{lead}The log holds no row {seq} now.", { lead: said, seq: s }, locale);
}

/**
 * The table's foot line over rows: what the page shows, and where a search or a seq stopped. A filtered page counts its
 * matches apart from the damaged entries it shows whatever the filters say (audit-view.mjs header).
 */
function footText(a, query, locale = "en") {
  if (Number.isSafeInteger(query?.seq)) return seqSentence(a, query.seq, locale);
  if (auditFiltered(query)) {
    const damaged = a.rows.filter((r) => r.state === "damaged").length;
    const n = a.rows.length - damaged;
    const from = query.before ? ` ${uiText("from here", locale)}` : "";
    const found = fmt("{matches} among the {examined} searched{from}.", { matches: n === 0 ? uiText("No row matches", locale) : `${rowsText(n, locale)} ${uiText(n === 1 ? "matches" : "match", locale)}`, examined: rowsText(a.examined, locale), from }, locale);
    const shown = damaged === 0 ? "" : damaged === 1 ? ` ${uiText("The damaged one is shown whatever the filters say.", locale)}` : ` ${fmt("The {count} damaged ones are shown whatever the filters say.", { count: damaged }, locale)}`;
    return `${found}${shown}${a.stopped ? ` ${fmt("The search stops at {max} rows; Older searches on from there.", { max: GROUPED.format(AUDIT_EXAMINE_MAX) }, locale)}` : ""}`;
  }
  const n = a.rows.length;
  const seqs = a.rows.map((r) => r.entry).filter(isAuditRow).map((e) => e.seq);
  return seqs.length > 1 ? fmt("Showing {rows}, row {first} down to row {last}", { rows: rowsText(n, locale), first: seqs[0], last: seqs[seqs.length - 1] }, locale) : fmt("Showing {rows}", { rows: rowsText(n, locale) }, locale);
}

/**
 * The log's empty state: none written, none matching, a seq page without its row, or a page past the end. It carries
 * the page's one sentence (the foot then has none), and it never says nothing older exists while Older leads somewhere.
 */
function emptyOf(a, query, locale = "en") {
  if (auditFiltered(query)) {
    const body = a.stopped
      ? fmt("None of the {rows} searched {place} matches; Older searches on from there.", { rows: rowsText(a.examined, locale), place: uiText(query.before ? "from here" : "from the newest", locale) }, locale)
      : uiText(query.before ? "No row from here to the oldest matches these filters." : "No row in the log matches these filters.", locale);
    return ui.empty({ status: "idle", icon: "search", title: uiText("No row matches", locale), body });
  }
  if (Number.isSafeInteger(query?.seq)) {
    const s = query.seq;
    const k = a.seek ?? {};
    const title = fmt(Number.isSafeInteger(k.newest) && s > k.newest ? "No row {seq} yet" : Number.isSafeInteger(k.first) && s < k.first ? "No row {seq} now" : a.stopped ? "Row {seq} was not reached" : k.by === "misplaced" ? "Row {seq} was not found" : "No row {seq}", { seq: s }, locale);
    return ui.empty({ status: "idle", icon: "audit", title, body: seqSentence(a, s, locale) });
  }
  // A plain page below a cursor with no rows read none there, so there is no Older (`next` is null) and the sentence holds.
  if (query?.before) return ui.empty({ status: "idle", icon: "audit", title: uiText("No rows here", locale), body: uiText("Nothing older is in the log. Newest goes back to the top.", locale) });
  return ui.empty({ status: "idle", icon: "audit", title: uiText("The audit log is empty", locale), body: uiText("Every write, sign-in and refusal the console makes is written here.", locale) });
}

/**
 * Newest and Older, as the kit's pager draws them (Newest quiet, Older the plain button) while each leads somewhere; a
 * control that leads nowhere is drawn quiet whichever it is, so two disabled controls look alike rather than one of them
 * looking like the live one.
 */
function auditPager(newer, older, locale = "en") {
  const one = (label, href, kind) => ui.btn({ kind: href === null ? ["sm", "ghost"] : kind, label: uiText(label, locale), href: href ?? "", disabled: href === null });
  return html`<span class="pager">${one("Newest", newer, ["sm", "ghost"])}${one("Older", older, "sm")}</span>`;
}

/**
 * The log: newest first, 50 a page, each row by its place in the chain (see the header), a damaged row tinted with the
 * check's sentence beside it, and the pager (Newest goes back to the top with the same filters, Older continues below
 * the page or where a search stopped).
 */
export function auditLog(view) {
  if (view.role !== "operator") return html`<p class="muted">${t(AUDIT_OPERATORS_ONLY, view)}</p>`;
  const a = view.data?.audit;
  const q = view.query ?? {};
  const head = { title: t("Audit log", view), sub: t("newest first; every write, sign-in and refusal", view), flush: true };
  if (!a || typeof a.unreadable === "string") {
    const body = a ? `${lead(a.unreadable)}. ${t("The next load tries again.", view)}` : t("The console's log has the reason. The next load tries again.", view);
    return ui.card({ ...head, body: html`<div class="au-empty">${ui.empty({ status: "attention", icon: "audit", title: t("The audit log could not be read", view), body })}</div>` });
  }
  const used = new Set();
  const rows = a.rows.map((r) => rowOf(r, a.chain, used, view.locale));
  const table = rows.length === 0
    ? html`<div class="au-empty">${emptyOf(a, q, view.locale)}</div>`
    : ui.tbl({ caption: t("Audit log", view), heads: [{ label: "Seq", num: true }, ...["At", "Who", "Action", "Target", "Outcome", "Reason"].map((label) => t(label, view))], rows, stack: true });
  const paged = (typeof q.before === "string" && q.before !== "") || Number.isSafeInteger(q.seq);
  const pager = auditPager(paged ? auditHref(q, { before: null, seq: null }) : null, typeof a.next === "string" ? auditHref(q, { before: a.next, seq: null }) : null, view.locale);
  return ui.card({ ...head, body: html`${table}${ui.tblFoot(rows.length === 0 ? "" : footText(a, q, view.locale), pager)}` });
}

/**
 * The chain's state, first on the page (the AuditScreen card): how far the chain is verified, and when a row is damaged
 * what that means, what to do, and a link to the page that opens at it (`?before=` the place under it, so the damaged
 * row leads that page, and its row id as the fragment). When the line at the break shows no prev that matches the row
 * before it, that row is named too: only such a prev vouches for a row (audit-view.mjs header), so the verified range
 * ends before it and the banner says why.
 */
export function auditChain(view) {
  if (view.role !== "operator") return html``;
  const a = view.data?.audit;
  const c = a?.chain;
  if (!a || !c) return ui.banner({ status: "attention", icon: "chain", title: t("The chain could not be checked", view), body: html`${t("The audit log could not be read, so no row is verified here.", view)} ${VERIFY_CMD} ${t("walks it on the host.", view)}` });
  if (c.state === "unreadable") {
    const why = t(c.why === "directory" ? "The audit directory could not be read, so no row is verified." : "The check did not run, so no row is verified here.", view);
    return ui.banner({ status: "attention", icon: "chain", title: t("The chain could not be checked", view), body: html`${why} ${VERIFY_CMD} ${t("walks the same chain on the host.", view)}` });
  }
  if (c.state === "broken") {
    const label = damagedLabel(a, view.locale);
    const verified = c.through === null ? t("No row could be verified", view) : fmt("Chain verified through row {seq}", { seq: c.through }, view.locale);
    const at = placeOf(c.broken.pos);
    const href = at === null ? null : `/audit?${new URLSearchParams({ before: `${at[0]}:${Math.max(at[1], 1) + 1}` })}#line-${at[0]}-${at[1]}`;
    const before = c.suspect ? ` ${fmt("Neither can row {seq}, the row before it: the link between the two does not hold, so the chain cannot tell whether row {seq} changed.", { seq: c.suspect.seq }, view.locale)}` : "";
    const body = html`${c.broken.reason ? html`${t("The check says:", view)} ${c.broken.reason}. ` : null}${lead(label)} ${t("and every row after it cannot be trusted.", view)}${before} ${t("Keep the file as it is and compare it with your last backup;", view)} ${VERIFY_CMD} ${t("names the same line.", view)}`;
    const show = href === null ? null : ui.btn({ kind: ["sm", "primary"], label: t("Show the damaged line", view), href });
    return ui.banner({ status: "failed", icon: "chain", title: `${verified}. ${lead(label ?? "")} ${t("is damaged.", view)}`, body, actions: show });
  }
  if (c.through === null) {
    if ((a.rows ?? []).length === 0) return ui.banner({ status: "ok", icon: "chain", title: t("The audit log is empty", view), body: t("The chain starts with the first row the console writes.", view) });
    return ui.banner({ status: "idle", icon: "chain", title: t("No row is verified yet", view), body: t("Every row was written after the last check; the next one covers them.", view) });
  }
  const span = c.startsAt !== null && c.from !== null ? fmt("Chain verified from row {from} through row {through}", { from: c.from, through: c.through }, view.locale) : fmt("Chain verified through row {through}", { through: c.through }, view.locale);
  const reaped = c.startsAt !== null ? ` ${t("The log starts there: older rows were reaped by retention, or removed, and the two look alike.", view)}` : "";
  const fresh = (a.rows ?? []).some((r) => r.state === "unchecked") ? ` ${t("Rows written since the check say unchecked until the next one.", view)}` : "";
  return ui.banner({ status: "ok", icon: "chain", title: span, body: `${t("Every row's hash follows the row before it.", view)}${reaped}${fresh}` });
}

/**
 * The filters (the AuditScreen card): a search over targets and reasons and a closed list each for who, action and
 * outcome, as a plain GET form to the page itself, so a filtered view is a link like any other and needs no script.
 * Who lists the names the rows read so far hold (and the one chosen); action and outcome the worker's closed lists.
 */
export function auditFilter(view) {
  if (view.role !== "operator") return html``;
  const q = view.query ?? {};
  const names = Array.isArray(view.data?.audit?.who) ? view.data.audit.who : [];
  const pick = (id, name, label, values, value) => { const shown = t(label, view); return html`<label class="sr" for="${id}">${shown}</label>${ui.select({ id, name, value: value ?? "", options: [{ value: "", label: `${shown}: ${t("all", view)}` }, ...values.map((v) => ({ value: v, label: `${shown}: ${v}` }))] })}`; };
  const reset = auditFiltered(q) || (typeof q.before === "string" && q.before !== "") || Number.isSafeInteger(q.seq) ? ui.btn({ kind: "ghost", label: t("Clear", view), href: "/audit" }) : null;
  return html`<form class="filterbar" method="get" action="/audit" role="search" aria-label="${t("Filter the audit log", view)}"><label class="search">${ui.icon("search")}<input type="search" name="q" value="${q.q ?? ""}" maxlength="${AUDIT_Q_MAX}" placeholder="${t("Search targets and reasons", view)}" aria-label="${t("Search targets and reasons", view)}" autocomplete="off" spellcheck="false"></label>${pick("au-who", "who", "Who", names, q.who)}${pick("au-role", "role", "Role", AUDIT_ACTOR_ROLES, q.role)}${pick("au-action", "action", "Action", CONSOLE_AUDIT_ACTIONS, q.action)}${pick("au-outcome", "outcome", "Outcome", CONSOLE_AUDIT_OUTCOMES, q.outcome)}${ui.btn({ label: t("Filter", view), type: "submit" })}${reset}</form>`;
}

/** What the log is (the AuditScreen card's side card): the verified range, the damage, the last check, who sees it. */
export function auditAbout(view) {
  if (view.role !== "operator") return html``;
  const a = view.data?.audit;
  const c = a?.chain ?? null;
  const ok = c !== null && c.state !== "unreadable";
  // A broken chain with nothing vouched for has no row to come "yet": the check stopped at the damage.
  const range = !ok ? t("not checked", view) : c.through === null ? (c.state === "broken" ? t("none", view) : t("none yet", view)) : c.from !== null && c.from !== c.through ? fmt("rows {from} to {through}", { from: c.from, through: c.through }, view.locale) : fmt("row {seq}", { seq: c.through }, view.locale);
  const label = damagedLabel(a, view.locale);
  const after = a?.rows?.some((r) => r.state === "unverified") ? "every row after the damaged one" : "any row after the damaged one (none on this page)";
  const pairs = [
    ["Verified", range],
    ["Damaged", label === null ? (ok ? "none" : "not checked") : html`<b class="tinted tone-failed">${label}</b>`],
    ["Not verified", label === null ? (ok ? "none" : "every row") : c.suspect ? `row ${c.suspect.seq} (its link to the damaged row does not hold) and ${after}` : after],
    // Issue #761: the rows an intact chain holds whose action or outcome this console does not know, only when there are
    // any (the check counts them only on an intact chain).
    ...(ok && c.unknown > 0 ? [["Not known to this console", `${rowsText(c.unknown)} (a newer release writes such rows)`]] : []),
    ...(Number.isFinite(c?.checkedAt) ? [[t("Checked at", view), timeHtml(c.checkedAt)]] : []),
    ["Each row keeps", "who, what, target, outcome, reason and a hash of the row before"],
    ["Who sees it", "operators only; viewers do not see this page"],
  ];
  return ui.card({ title: t("About this log", view), body: ui.facts(pairs.map(([k, value]) => [t(k, view), typeof value === "string" ? t(value, view) : value]), { cols: 1 }) });
}
