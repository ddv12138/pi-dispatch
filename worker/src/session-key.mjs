import { createHash } from "node:crypto";
import { issueBranch } from "./branch.mjs";
import { cronRunOf } from "./bullmq-internals.mjs";
import { isForgeKind } from "./forges.mjs";

/**
 * session-key.mjs -- which persisted transcript, if any, a job runs on.
 *
 * PURE and TOTAL, no I/O, no throw. That is the same discipline filter.mjs holds, and for the same
 * reason: the cross-repo and cross-PR safety of this whole feature lives in this one function, and a
 * security-critical decision that needs a network to test is a decision nobody re-tests.
 *
 * DERIVED, NEVER LOOKED UP (DES-SESSION-KEY-IS-DERIVED-NOT-INDEXED). There is no index mapping "PR #123"
 * to "the job that opened it" and there will not be one: an index is a query surface, and this project
 * deliberately has no database (INT-RUN-HISTORY-FILE-CONTRACT). The key is computed from what the job
 * already carries, so a mismatch is unrepresentable rather than merely unlikely.
 *
 * WHAT THE KEY ACTUALLY BINDS, stated honestly because the flattering version is wrong. The key binds the
 * forge's IMMUTABLE project identity, not the repository path that anyone with permission can recreate: a
 * GitLab job carries the numeric project id, an Azure job its project id string, and both are hash material
 * beside the repo and the ref. A project deleted and recreated under the same path gets a NEW id, so it
 * resolves a different key and COLD-STARTS -- the new project never inherits the deleted project's transcript.
 * That is the deliberate break, not a migration: this deployment's session and run data was cleared, so no old
 * key is read, re-derived or rewritten. A GitLab/Azure job with no usable project id resolves NO KEY at all;
 * it never falls back to the old repo-only key, because that fallback is exactly the resurrection.
 *
 * GitHub and Forgejo carry no repository id yet (their jobs name only `repo`), so their namespace is the EMPTY
 * STRING. Two repositories at the same path on those forges therefore still share a namespace; that residual
 * is stated rather than papered over, and adding a repository id later is another key break, not a migration.
 *
 * The issue-number and branch-name residual is separate and remains real: `pi/issue-<n>` is asked for by a
 * prompt and a hard rule, and a branch -- unlike a project id -- can be deleted and re-created by anyone who
 * can push. Within one project identity the key is a NAME, and its namespace is the base repository's
 * push-access population, one step wider than the population CONST-NO-CONTEXT-FILES-MANDATORY already trusts
 * (OQ-014). What bounds it is the two rules below.
 *
 * Rule one: the repository half is always the BASE repo. A fork's `full_name` is attacker-chosen and
 * must never select a directory. Rule two: a fork resolves NO KEY AT ALL -- returning null rather than
 * setting a flag a later stage has to remember to check. Without it, a stranger who forks, names a
 * branch `pi/issue-7` and gets a collaborator to act on the pull request would be handed issue 7's
 * transcript.
 *
 * The returned string is a HASH, not a path built from the branch. A ref is attacker-influenced free
 * text and validating it into a safe path segment is the losing half of that argument; hashing makes
 * traversal unreachable. It also keeps a directory listing PII-free by construction, the same property
 * `local:<basename>` gives the run record.
 */

/** Long enough that a collision is not a thing to reason about, short enough to read in a log line. */
const KEY_LENGTH = 32;

/**
 * What a key LOOKS like, derived from KEY_LENGTH rather than restated, because the session reaper (issue #645) uses it
 * to decide which names in PI_SESSIONS_DIR are keys at all: a hand copy of `32` that drifted from this would make the
 * reaper ignore every real key (they would all read as `not-a-key`) or judge names this module never mints.
 */
export const SESSION_KEY_PATTERN = new RegExp(`^[0-9a-f]{${KEY_LENGTH}}$`);
export const FORK_SESSION_KEY_PATTERN = new RegExp(`^([0-9a-f]{${KEY_LENGTH}})\\.([0-9a-f]{32})$`);

/**
 * The immutable forge namespace a job's key binds, and the one place the key learns it: the GitLab numeric
 * project id rendered as a decimal string, the Azure project id string, or the EMPTY STRING for GitHub and
 * Forgejo, whose jobs carry no repository id yet. A record pseudo-job (see `sessionKeyOfRecord`) passes
 * `namespaceId` instead, since a run record has no `projectId`; it is held to the same rules.
 *
 * ABSENCE IS FAIL-CLOSED, never a repo-only fallback: a GitLab/Azure job with a missing or invalid id returns
 * null, so the caller resolves no key and cold-starts. A project deleted and recreated under the same path has
 * a new id, and resuming the old transcript through the shared path is the bug this namespace exists to stop.
 *
 * Pure and total. `Number.isSafeInteger` is the GitLab gate (the receiver puts a number on the job); anything
 * else -- a numeric string included -- is not the id this function trusts.
 *
 * @param {object} job - A job, or a record pseudo-job carrying `namespaceId`.
 * @returns {string|null} The namespace segment, or null when this job has no usable forge identity.
 */
export function namespaceIdFor(job) {
	const kind = job?.kind;
	if (!isForgeKind(kind)) return null;
	const emptyIsValid = kind === "github" || kind === "forgejo";
	if (job?.namespaceId !== undefined) {
		const given = job.namespaceId;
		// A record may spell a missing namespace as null. For GitHub/Forgejo that is the empty namespace, which is
		// valid there; for GitLab/Azure it is absence, and absence is a cold start.
		if (given === null) return emptyIsValid ? "" : null;
		if (typeof given !== "string") return null;
		if (given !== "") return given;
		return emptyIsValid ? "" : null;
	}
	if (kind === "gitlab") {
		const id = job?.projectId;
		return Number.isSafeInteger(id) && id > 0 ? String(id) : null;
	}
	if (kind === "azure") {
		// `job.projectId` is Azure's string id; `job.azure.projectId` is the same fact when the job carries the
		// org/project/repository triple instead. Either non-empty string is an identity.
		const direct = job?.projectId;
		if (typeof direct === "string" && direct !== "") return direct;
		const nested = job?.azure?.projectId;
		return typeof nested === "string" && nested !== "" ? nested : null;
	}
	// GitHub/Forgejo only: no repository id is carried, so the namespace is empty until one is.
	return "";
}

/**
 * @param {object} job - The job data (`kind`, `repo`, `target`, `trigger`).
 * @param {object} [resolved] - `{ headRef, headRepo }` for a pull/merge-request target, from the FORGE
 *   API rather than the webhook payload. Absent or incomplete means no key, which is a cold start.
 * @returns {string|null} A hex key, or `null` when this job has no durable identity to resume against.
 */
export function sessionKeyFor(job, resolved = {}) {
	const parts = keyParts(job, resolved);
	if (parts === null) return null;
	const forkRef = job?.target?.type === "pull_request" ? /^pi\/issue-([1-9][0-9]*)-fork-([0-9a-f]{32})$/.exec(resolved.headRef ?? "") : null;
	if (forkRef) {
		// Replace only the REF half: the kind, repo and the immutable forge namespace must stay, or a fork on a
		// recreated project would reconstruct the old project's root key. Parts are [kind, repo, namespace, ref].
		const root = hashParts([...parts.slice(0, -1), issueBranch(forkRef[1])]);
		return `${root}.${forkRef[2]}`;
	}
	const key = hashParts(parts);
	if (job?.fork !== undefined) {
		if (!job.fork || job.fork.rootKey !== key || typeof job.fork.id !== "string" || !/^[0-9a-f]{32}$/.test(job.fork.id)) return null;
		return `${key}.${job.fork.id}`;
	}
	return key;
}

function hashParts(parts) {
	// NUL-delimited so ("a", "bc") and ("ab", "c") cannot collide -- the same reasoning job-id.mjs uses.
	return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, KEY_LENGTH);
}

/**
 * The key's material, before hashing. Exported for tests and for the operator-facing `doctor` line: the
 * hash is deliberately unreadable, so the one place that can explain a directory is the function that
 * built it.
 */
export function keyParts(job, resolved = {}) {
	const kind = job?.kind;

	// Keyed on "is this a forge job", never on a list of forge names. An enumeration that forgot one would
	// not throw: every job on that forge would resolve no key and cold-start forever, which looks exactly
	// like a deployment that never armed run.resume. `local` is handled below, on its own terms.
	if (isForgeKind(kind)) {
		const repo = job?.repo;
		if (typeof repo !== "string" || repo === "") return null;
		// The immutable project identity, validated before any ref: no namespace means no key, a cold start.
		const namespaceId = namespaceIdFor(job);
		if (namespaceId === null) return null;

		if (job?.target?.type === "pull_request") {
			const { headRef, headRepo } = resolved;
			if (typeof headRef !== "string" || headRef === "") return null;
			// THE FORK GATE. Absence of a key, never a boolean: there is no later stage that could forget
			// to check this, because there is nothing to check -- the job simply has no session.
			if (typeof headRepo !== "string" || headRepo !== repo) return null;
			return [kind, repo, namespaceId, headRef];
		}

		// An issue-triggered job's branch is the one its own envelope names, minted by the same function
		// (branch.mjs) so the two cannot drift. issueBranch throws on a non-positive-integer number; this
		// function is total, so that becomes "no key" rather than a failed job.
		//
		// ONE ARGUMENT, DELIBERATELY, and it must stay that way (REQ-REPLICA-RUNS). `issueBranch` takes an
		// optional replica index and a replica job's envelope names `pi/issue-<n>-r<i>`, so this call is
		// knowingly resolving a key for a branch that job was not told to push to. That is safe only because
		// `triggers.mjs` refuses `run.replicas` together with `run.resume`: a replica job never resumes, so
		// the key it would resolve is never read. Relax that refusal and every replica of one issue resolves
		// the SAME key -- one transcript, N writers, fighting the store's one-writer lock. If the refusal
		// ever goes, the replica index has to arrive here too. The coupling is stated in branch.mjs as well.
		try {
			return [kind, repo, namespaceId, issueBranch(job?.target?.number)];
		} catch {
			return null;
		}
	}

	if (kind === "local") {
		// A cron job's scheduler id is the strongest key here and the only one chosen by nobody untrusted:
		// it is operator-authored, [A-Za-z0-9._-]+, unique across the triggers file, and stable across
		// fires. A nightly job that remembers last night is the safest instance of this feature.
		const id = job?.trigger?.id;
		if (typeof id !== "string" || id === "") return null;
		return ["local", "", id];
	}

	// Everything else -- a CLI `pi-dispatch run`, a chained /outbox child -- has no trigger entry that
	// could have armed run.resume, so there is nothing to honour and no stable identity to key on. A job
	// kind that is neither a forge nor local lands here too, which is the safe direction: no session.
	return null;
}

/**
 * A RUN RECORD's session key, re-derived the way `sessionKeyFor` derives a job's (DES-SESSION-KEY-IS-DERIVED-NOT-INDEXED):
 * a forge ISSUE from kind + repo + its immutable `namespaceId` + its number, a cron run from its scheduler id. Null where
 * the record cannot say: a pull or merge request's key needs its head ref, which the record deliberately does not carry
 * (it is attacker-chosen text, and the record holds none, INT-RUN-HISTORY-FILE-CONTRACT).
 *
 * The record's `namespaceId` is the SAME segment `buildRecord` wrote from the job (the GitLab numeric project id as a
 * decimal string, the Azure project id string, empty on GitHub/Forgejo). A GitLab/Azure record with no namespace yields
 * null -- a cold start, never a fallback to the old repo-only key, which is exactly how a recreated project would
 * resurrect the deleted one's transcript. There is no dual-read and no migration: historical data was cleared.
 *
 * It lives HERE, beside `sessionKeyFor`, and not in the admin's read model where it started (issue #647): the admin's
 * parked-chain counter needs it, and two copies of a key rule are two places for a cross-issue transcript mix-up to
 * start. Still derived, never looked up: there is no index to consult.
 *
 * @param {object} record - A run record (`kind`, `target`, `jobId`, `triggerType`, `namespaceId`).
 * @returns {string|null} The 32-hex key, or null.
 */
export function sessionKeyOfRecord(record) {
	if (record?.fork !== undefined) {
		const root = sessionKeyOfRecord({ ...record, fork: undefined });
		return root && typeof record.fork?.id === "string" && /^[0-9a-f]{32}$/.test(record.fork.id) ? `${root}.${record.fork.id}` : null;
	}
	const kind = record?.kind;
	if (kind === "local") {
		// The scheduler id is the middle of a cron (`repeat:`) or manual-fire (`manual:`) job id; the trailing number is
		// the fire's own, which differs every time and must not split one schedule's sessions. Any id length: a record
		// is this deployment's own history, and every release before issue #761 took a cron id of any length.
		const run = cronRunOf(record?.jobId);
		return run ? sessionKeyFor({ kind: "local", trigger: { id: run.id } }) : null;
	}
	if (!isForgeKind(kind) || typeof record?.target !== "string") return null;
	// `!` (a GitLab merge request, an Azure pull request) never matches: a request's key needs the head ref.
	const m = /^(.+)#(\d+)$/.exec(record.target);
	if (!m) return null;
	// `#` is the issue separator on every forge; GitHub and Forgejo also spell a pull request with it, and only the
	// trigger type can say which (a `pull_request` trigger). A comment on a pull request stays ambiguous, so a key that
	// names no directory reads as unknown to its callers, never as a session.
	if (record.triggerType === "pull_request") return null;
	return sessionKeyFor({ kind, repo: m[1], namespaceId: record?.namespaceId, target: { type: "issue", number: Number(m[2]) } });
}
