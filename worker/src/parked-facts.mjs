/**
 * parked-facts.mjs -- the parked-run "being answered" fact rule.
 *
 * ONE RULE, SHARED. The console's read model (its parked inbox rows and its queued-recovery reader) and its answer
 * actions all ask the same question of a parked run: is an answer already on its way to it, or can it still be
 * answered? Each would otherwise grow its own table, and two of them drifting apart is how an operator gets an answer
 * form for a park whose answer another run already took, or an answer action that refuses what the inbox offered. So
 * the rule lives here, once (issue #647), and these are the three exports the console uses --
 * `QUEUED_STATES` (how a job that has not started reads), `pendingFactsOf` (what a pending-answer scan's every shape
 * means) and `parkedVerdictOf` (the verdict on a park no later record answered).
 *
 * The pieces those three run on (`RUN_ID_RE`, `CHAT_REFUSALS`, `isParkedRecord`, `judge`) live in this leaf with them.
 * `judge` is the refusal table whole; through `parkedVerdictOf` only its parked branch is reached, because the record
 * handed in is always the awaiting-input one, but the rest of the table stays.
 *
 * PURE and TOTAL: no I/O, no clock, no throw; the caller reads the queue and the parked fold, and hands the facts in.
 * Nothing here looks at free text: the fields read are the worker's own closed words.
 */

/**
 * BullMQ's words for a job that has not started (or is waiting to start again). `paused` is an older BullMQ's word for
 * a waiting job on a paused queue; it is kept so a mixed fleet still reads as queued. Exported so the readers that look
 * for a run's queued recovery job and for a park's pending answer judge "queued" by this one list.
 */
export const QUEUED_STATES = Object.freeze(["waiting", "delayed", "prioritized", "waiting-children", "paused"]);

/** A run id as the worker mints them (the console's `RUN_ID_RE`); anything else is no active job. */
const RUN_ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;

/**
 * The sentences a refusal says, by why. Private here: the console reaches them only through `parkedVerdictOf`, so no
 * surface imports them from this leaf.
 */
const CHAT_REFUSALS = Object.freeze({
	queued: "This run has not started yet (its job is queued), so there is nothing to chat with until it runs.",
	recoveryQueued: "This run goes on as a recovery job that is queued and has not started yet, so there is nothing to chat with until it runs.",
	answered: "This run asked a question and a later run on the same target took the answer; open that run's chat instead.",
	answering: "This run asked a question and a run on the same target is queued or running now, which takes the answer; open that run's chat instead.",
	parkedUnknown: "This run asked a question, but whether it still waits for an answer cannot be told right now (the run history or the queue could not be read); try again.",
	parkedTooMany: "This run asked a question, but the queue holds too many jobs to check whether an answer is already on its way; answer it on the forge, or wait until the queue is shorter.",
	endedNoRecord: "This run's job has ended but its record is not in this host's history or the fleet's run mirror, so there is no session to open.",
	unknown: "No run with that id is in this host's history, the fleet's run mirror or the queue.",
});

/** Whether a record says its run parked on a question (REQ-AWAIT-INPUT): the worker's own closed words. */
function isParkedRecord(record) {
	return record?.outcome === "completed" && record?.reason === "awaiting-input";
}

/**
 * The run's state and its verdict, from the facts the caller read:
 *
 * @param {object} facts
 * @param {string|null} facts.state - The BullMQ state of the job named (`job.getState()`), or null when the queue no
 *   longer holds it (removed on completion, or never this queue's).
 * @param {object|null} facts.record - The job's run record, or null when there is none yet (a record is written at a
 *   run's end) or none this host can read.
 * @param {string|null} facts.activeJobId - The run's ACTIVE job: the job itself when it is active, or the #645 recovery
 *   job its run goes on as (`continuesAs`); null when nothing of the run is running.
 * @param {string|null} facts.queuedJobId - The #645 recovery job the run goes on as when that job is QUEUED (waiting,
 *   delayed, prioritized), or null. Ignored when the run is active.
 * @param {{answered: boolean, pending?: boolean|null, pendingTooMany?: boolean}|null} facts.parked - For a parked record:
 *   whether a later run on its target took the answer (`readParkedRuns`'s rule) and whether a job on its target is
 *   queued or running now (`pending`, absent when not looked for, null when the scan could not tell, then
 *   `pendingTooMany` true when that was the queue's depth: `pendingFactsOf`), or null when either could not be read.
 * @returns {{state: string, mode: string|null, says: string|null}}
 */
function judge({ state = null, record = null, activeJobId = null, queuedJobId = null, parked = null } = {}) {
	const active = (typeof activeJobId === "string" && RUN_ID_RE.test(activeJobId)) || state === "active";
	if (active) return { state: "active", mode: "live", says: null };
	if (typeof state === "string" && QUEUED_STATES.includes(state)) return { state: "queued", mode: null, says: CHAT_REFUSALS.queued };
	if (typeof queuedJobId === "string" && RUN_ID_RE.test(queuedJobId)) return { state: "queued", mode: null, says: CHAT_REFUSALS.recoveryQueued };
	const rec = record !== null && typeof record === "object" && !Array.isArray(record) ? record : null;
	if (rec === null) {
		// A job the queue holds as ended with no record is a record this host cannot read (another host's, with no mirror),
		// which is not the same sentence as a run nobody knows.
		const ended = state === "completed" || state === "failed";
		return { state: "unknown", mode: null, says: ended ? CHAT_REFUSALS.endedNoRecord : CHAT_REFUSALS.unknown };
	}
	if (isParkedRecord(rec)) {
		const answered = parked !== null && typeof parked === "object" ? parked.answered : null;
		if (answered === true) return { state: "answered", mode: null, says: CHAT_REFUSALS.answered };
		if (answered === false && parked.pending === true) return { state: "answered", mode: null, says: CHAT_REFUSALS.answering };
		if (answered === false && (parked.pending === false || parked.pending === undefined)) return { state: "parked", mode: "reply", says: null };
		// FAIL LOUDLY when the queue scan could not tell (`pendingTooMany`, review round 2). The scan gives up only on a
		// queue deeper than its budget, and on such a queue a queued answer can wait longer than the ten-minute semantic
		// window (`repo#n:flow`) that would otherwise swallow a second answer: the backstop that would make failing open
		// safe has lapsed exactly when this case arises. So the park is refused with a sentence that says why, and the
		// forge, whose reply goes through the receiver's own path, stays the way to answer it.
		if (answered === false && parked.pendingTooMany === true) return { state: "unknown", mode: null, says: CHAT_REFUSALS.parkedTooMany };
		return { state: "unknown", mode: null, says: CHAT_REFUSALS.parkedUnknown };
	}
	return { state: "finished", mode: "fork", says: null };
}

/**
 * A pending-answer scan's result (the console's `readPendingAnswer`: `{ jobId }` with an id or null, `{ unknown: true,
 * tooMany? }` or `{ unreachable: true }`) as the `parked` facts `parkedVerdictOf` judges: `{ pending, pendingTooMany,
 * pendingJobId }`. ONE mapping, so the parked inbox and the answer actions cannot disagree about what a scan that could
 * not tell means (review round 2: the inbox drew a form where the panel refused).
 */
export function pendingFactsOf(scan) {
	const id = typeof scan?.jobId === "string" && RUN_ID_RE.test(scan.jobId) ? scan.jobId : null;
	if (id !== null) return { pending: true, pendingTooMany: false, pendingJobId: id };
	if (scan !== null && typeof scan === "object" && Object.hasOwn(scan, "jobId") && scan.jobId === null) return { pending: false, pendingTooMany: false, pendingJobId: null };
	return { pending: null, pendingTooMany: scan?.tooMany === true && scan?.unknown === true, pendingJobId: null };
}

/**
 * The verdict on a park no later RECORD answered, from its pending-answer scan alone (`pendingFactsOf`, then this
 * module's table): `{ mode: "reply" | null, says, answeringJobId }`. The parked inbox asks this per row and the answer
 * actions ask it before queueing a reply, so the screens and the actions agree on exactly the same parks.
 */
export function parkedVerdictOf(scan) {
	const facts = pendingFactsOf(scan);
	const { mode, says } = judge({ record: { outcome: "completed", reason: "awaiting-input" }, parked: { answered: false, ...facts } });
	return { mode, says, answeringJobId: facts.pendingJobId };
}
