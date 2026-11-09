/**
 * Scoped limits (issue #242, INT-SCOPED-LIMITS-FILE-CONTRACT): per-scope concurrency and job size, where a scope
 * is what `scopeOf` already answers -- the folder for a local job, the repo for a forge one. One
 * `scoped-limits.json` of `{ scope, concurrent?, ... }` entries: `concurrent` defers the excess through the
 * delayed set (never a refusal -- a busy scope is transient state), and the size fields are consumed by
 * job-size.mjs and host-budget.mjs. The job-count windows (`day`, `week`, `month`), the token windows
 * (`dayTokens`, `weekTokens`, `monthTokens`) and the `model:<provider>/<model>` rows that existed only to carry
 * them were REMOVED; a row carrying one is refused with that removal named, never read as an unknown key.
 *
 * This module is pure and fs-injectable (mirrors pause-windows.mjs in every respect): `parseScopedLimits`
 * validates the file TEXT fail-loud, `loadScopedLimits` layers the one fs read on top, and the small
 * helpers below are what the processor gate and the budget wiring consume. It also owns the in-process
 * in-flight counter (`makeInFlight`) so the counter is unit-testable without a bullmq import, the same
 * reason job-id.mjs is queue-free.
 *
 * The file is a SIBLING of pause-windows.json, not part of the settings overlay, deliberately: the
 * deferral gate runs before the per-job overlay read, so gate-read config must come from a watched
 * mutable ref, and the overlay's KNOWN_KEYS are flat scalars whose only map-shaped precedent
 * (secretProfiles) is deliberately model-unreachable -- the opposite of what these limits need.
 *
 * `version` is REQUIRED and fail-loud-on-newer (subscriptions.mjs's rule, adopted here because this is a
 * MONEY file): unknown fields are silently dropped per the operator-file policy, so a v2 cap field an old
 * worker drops would be a silently WIDENED spend limit. Pause-windows shipping without a version is a
 * sunk decision, not a precedent to extend to enforcement config.
 *
 * Version 2 (issues #501 part 5, #502 part 6) was that case made real with dollar windows, which a later version
 * replaced with token windows (`dayTokens`, `weekTokens`, `monthTokens`) on a scope row and
 * `model:<provider>/<model>` rows carrying those alone. Those token windows and model rows are REMOVED with the
 * token budgets this build no longer has: a file carrying either is refused with that removal named. The dollar
 * fields are retired too: a file carrying `dayUsd`/`weekUsd`/`monthUsd` is refused with the upgrade named. The
 * job-count fields `day`/`week`/`month` are retired too, refused with the cap removal named.
 *
 * Issue #498 adds the forge-qualified scope (`github:acme/web`), which names one forge's repo where a bare
 * `acme/web` names that repo on every forge. A job matches its qualified row first, then its bare row, and a file
 * holding both for one repo is refused. EVERY key (the in-process slot and the fleet lease) is
 * built from the MATCHED ROW's scope, never from the job's, so a bare row keeps exactly the key it always had and
 * a qualified row counts on its own.
 *
 * Issue #499 part B adds the project row (`project:<id>`, the id from projects.json; version 2). It carries
 * `concurrent` and the size fields, and it caps every member of the project as one. Its keys are
 * built from the project ROW's scope like every other row's, so a project needs no keyspace of its own.
 *
 * Issue #596 (phase 1) adds version 3: a project row may carry its jobs' size (`memory`, `cpus`) and the host budget's
 * two knobs (`hostShare`, `minJobs`), see `SIZE_LIMIT_FIELDS`. This module only parses them; `job-size.mjs` resolves the
 * size at pickup, and the host budget (`host-budget.mjs`, phase 2) enforces `hostShare` and `minJobs`.
 *
 * Custom: scoped limits validated inline per triggers.mjs/pause-windows.mjs precedent; zod not in deps
 */

import { existsSync as fsExistsSync, readFileSync as fsReadFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { configError } from "./config.mjs";
import { hash16 } from "./fleet-lease.mjs";
import { parseScopeString, qualifiedScopeOf, scopeOf } from "./pause-windows.mjs";
import { PROJECT_ID_RE, isProjectId } from "./project-id.mjs";
import { formatCpus, formatMemory, parseCpus, parseMemory } from "./job-size.mjs";

/**
 * The highest schema version this build reads. A file declaring a higher one is refused loudly. The admin writes the
 * LOWEST version that expresses a file (`scopedLimitsVersionFor`), so a file with no project or qualified row stays 1.
 *
 * Version 2 (issues #501 part 5 and #502 part 6) added the dollar windows, which a later version replaced with the
 * token windows `dayTokens`, `weekTokens` and `monthTokens` and `model:<provider>/<model>` rows. Those token surfaces
 * are REMOVED with the token budgets: the version stays 4 because no field was added, and a file carrying a token
 * field or a model row is refused with the removal named in every version.
 *
 * A forge-qualified row (`github:acme/web`, issue #498) needs version 2 as well, for the same reason: every released
 * build reads `github:acme/web` as a plain repo string no job ever has, so a version 1 file holding one would be a
 * cap, a concurrency limit and a lease that one build enforces and another silently ignores. Version 2 makes every
 * older build refuse the file loudly instead.
 */
export const SCOPED_LIMITS_VERSION = 4;

/**
 * The four size fields of version 3 (issue #596), on a PROJECT row only, in display order:
 *   - `memory`: the project's jobs' memory (`"512m"`, `"4g"`; `job-size.mjs` `parseMemory`), stored in its one spelling;
 *   - `cpus`: their CPU weight (`0.5`, `2`; `parseCpus`), stored as a number;
 *   - `hostShare`: the most of a host's job budget the project's running jobs may hold together, as a whole PERCENTAGE
 *     from 1 to 100 (`50` is half). ENFORCED by each host's budget (`host-budget.mjs`): a job that would take the
 *     project past it waits, and a size above it is refused there for a job on that host's own queue
 *     (`job-size-exceeds-share`; on the shared queue it waits for a host whose share fits it);
 *   - `minJobs`: how many of the project's jobs a host should make room for before it admits other projects' jobs, a
 *     soft minimum. ENFORCED by the host budget's tier 1 holds (`host-budget.mjs` `rankHolds`).
 * A version 1 or 2 file that carries one is refused naming version 3, for the version 2 reason: a 3.1.0 worker drops
 * unknown fields, so the file would size its jobs on one build and not on another. Every released build refuses a
 * version 3 file as newer, but only when it LOADS the file, at boot: a worker already running when the file becomes
 * version 3 keeps its last good file on reload (`scoped_limits_reload_invalid`) and runs the project's jobs at the
 * default size until it is upgraded and restarted. So every worker is upgraded and restarted before a size is written.
 * A version 3 row also refuses a key it does not know, so a misspelled size field cannot drop out silently.
 */
export const SIZE_LIMIT_FIELDS = Object.freeze(["memory", "cpus", "hostShare", "minJobs"]);

/** The one remaining limit field a row may carry, in display order: concurrency. The job-count and token windows are gone. */
const LIMIT_FIELDS = ["concurrent"];
/** The retired job-count fields: refused on sight, naming the removal (never dropped as unknown keys). */
export const RETIRED_COUNT_FIELDS = Object.freeze(["day", "week", "month"]);

/** The retired token window fields: refused on sight, naming the token-budget removal (never dropped as unknown keys). */
export const RETIRED_TOKEN_FIELDS = Object.freeze(["dayTokens", "weekTokens", "monthTokens"]);
/** The dollar fields version 2 shipped, refused on sight with the upgrade named. */
export const RETIRED_DOLLAR_FIELDS = Object.freeze(["dayUsd", "weekUsd", "monthUsd"]);

/**
 * Every key a version 3+ row MAY carry, the retired fields included: a retired field's value is refused above, but
 * `null` is the normalizer's own "unset", so a file an older build wrote (whose rows carry `dayTokens: null`) still
 * re-parses instead of being refused as an unknown key. Only a key outside this set is unknown.
 */
const V4_ROW_KEYS = new Set(["scope", ...LIMIT_FIELDS, ...SIZE_LIMIT_FIELDS, ...RETIRED_TOKEN_FIELDS, ...RETIRED_COUNT_FIELDS, ...RETIRED_DOLLAR_FIELDS]);

/**
 * The scope prefix the removed per-model rows used (issue #502 part 6): `model:<provider>/<model>`. Reserved: a file
 * naming it is refused with the token-budget removal, rather than read as a folder called `model:...`.
 */
export const MODEL_SCOPE_PREFIX = "model:";

/** A scope that LOOKS like a model row (any case, `models`, spaces before the colon) but is not the exact prefix form. */
const MODEL_NEAR_MISS = /^models?\s*:/i;

/**
 * The scope prefix of a project row (issue #499 part B): `project:<id>`, the id from projects.json. A project row needs
 * version 2 in EVERY field, its job counts and `concurrent` included, for the forge-qualified row's reason: the last
 * released build (2.1.0) reads `project:shop` as a plain repo string no job has, so a version 1 file holding one would
 * be a cap and a concurrency limit that one build enforces and another silently drops. Version 2 makes that build
 * refuse the file as newer instead.
 */
export const PROJECT_SCOPE_PREFIX = "project:";
/** A scope that LOOKS like a project row (any case, `projects`, spaces before the colon). Only the exact form parses. */
const PROJECT_NEAR_MISS = /^projects?\s*:/i;

/** Is this row scope written as the removed per-model row? The parser refuses it; `limitFor` never matches one. */
export function isModelScope(scope) {
	return typeof scope === "string" && scope.startsWith(MODEL_SCOPE_PREFIX);
}

/** Is this row scope a project row? */
export function isProjectScope(scope) {
	return typeof scope === "string" && scope.startsWith(PROJECT_SCOPE_PREFIX);
}

/** The row scope of a project: `project:<id>`. Every key of a project row hashes this string. */
export function projectScope(id) {
	return `${PROJECT_SCOPE_PREFIX}${id}`;
}

/** A row that is never a job's own scope: a model row or a project row. `limitFor` and the scope advisories skip them. */
function isGroupScope(scope) {
	return isModelScope(scope) || isProjectScope(scope);
}

function isNonEmptyString(value) {
	return typeof value === "string" && value.trim() !== "";
}

/**
 * The canonical scope string for a job: the RESOLVED folder path for a local job, the repo for a forge
 * one. `scopeOf` alone is not enough for enforcement: nothing on the trigger path normalizes
 * `run.folder`, so `/srv/site`, `/srv/site/`, `/srv//site`, `/srv/x/../site` and a padded spelling are
 * five distinct strings naming ONE directory -- an exact-string mutex keyed on the raw value would run
 * them concurrently in one working tree, which is the exact race the mutex exists to close.
 * `path.resolve` (not `normalize`, which keeps trailing slashes and whitespace) collapses them all; a
 * relative folder resolves against the worker's cwd, the same base `prepareWorkspace`'s existence check
 * uses; Unicode is NFC-normalized on both the job and the row side (see below). Two residuals,
 * deliberate: symlinks are NOT resolved (realpath is an fs call on the hot path and can throw), and
 * neither is filesystem case-insensitivity (on a default macOS/APFS volume `/Srv/Site` and `/srv/site`
 * are one directory and two scopes) -- the pause matcher lives with both.
 *
 * The pause matcher itself keeps the RAW `scopeOf` value: resolving there would silently change which
 * jobs an operator's existing trailing-slash window matches. The two features share the folder-vs-repo
 * split (`scopeOf`, defined once) but not the normalization, and this comment is where that difference
 * is recorded.
 *
 * A useful side effect: a resolved local scope is always an absolute path, and a repo string never is,
 * so a folder named `a/b` and a repo named `a/b` can no longer collide in the counters or the mutex.
 */
export function canonicalScope(job) {
	const scope = scopeOf(job);
	if (!isNonEmptyString(scope)) return null;
	// NFC on both kinds: macOS's filesystem hands paths back NFD while an admin dialog types NFC, so
	// "wéb" can arrive as two byte sequences naming one thing -- without this, an NFD-spelled forge
	// scope silently escapes an NFC-spelled cap (the local side would at least keep the structural
	// mutex). ASCII is fixed under NFC, so no existing key changes.
	return job?.kind === "local" ? resolve(scope.trim().normalize("NFC")) : scope.normalize("NFC");
}

/**
 * Parse, validate, and normalize the scoped-limits file TEXT. Returns the normalized `limits` array
 * (every row rebuilt as an explicit `{ scope, concurrent }` literal in a version 1 file, plus `memory,
 * cpus, hostShare, minJobs` in a version 3 one, `null` for absent fields, unknown fields dropped in a version 1 or 2
 * file -- the operator-file policy -- and refused in a version 3+ one). The retired job-count, token-window and
 * dollar fields and the removed model rows are refused in every version. Throws `configError` (fail-loud) on any
 * malformed entry. `path` is for error messages only -- this function touches no filesystem.
 */
export function parseScopedLimits(text, path) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw configError(`scoped-limits file is not valid JSON: ${path} (${error.message})`);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw configError(`scoped-limits file must be an object with "version" and "limits": ${path}`);
	}
	const version = parsed.version;
	if (!Number.isInteger(version) || version < 1) {
		throw configError(`scoped-limits file must have "version": 1 to ${SCOPED_LIMITS_VERSION} (an integer >= 1): ${path}`);
	}
	if (version > SCOPED_LIMITS_VERSION) {
		throw configError(`scoped-limits file written by a newer pi-dispatch (version ${version}; this build understands ${SCOPED_LIMITS_VERSION}): ${path}`);
	}
	if (!Array.isArray(parsed.limits)) {
		throw configError(`scoped-limits file must have a "limits" array: ${path}`);
	}
	const rows = parsed.limits.map((row, index) => normalizeLimit(row, index, path, version));
	refuseMixedForms(rows, path);
	const seen = new Map();
	rows.forEach((row, index) => {
		const id = row.scope;
		if (seen.has(id)) {
			// Two rows for one scope is a precedence question with no right answer; the admin's
			// edit-in-place never produces one, so a duplicate is always a hand-edit mistake.
			throw configError(`scoped limit at index ${index}: duplicate scope ${JSON.stringify(row.scope)} (first at index ${seen.get(id)}): ${path}`);
		}
		seen.set(id, index);
	});
	return rows;
}

/**
 * A bare row and a qualified row for one repo (`acme/web` beside `github:acme/web`) refuse the file, naming both
 * indexes (issue #498). Whatever fields either carries: one row applies to a job, and with both forms
 * present that rule would need a precedence ladder, which reads as one limit while the other silently stops counting.
 * Refusing is the simpler rule, and it is loud. Two qualified rows for one repo on two forges are fine.
 */
function refuseMixedForms(rows, path) {
	const bare = new Map();
	rows.forEach((row, index) => {
		if (!isGroupScope(row.scope) && parseScopeString(row.scope).type === "bare") bare.set(row.scope, index);
	});
	rows.forEach((row, index) => {
		if (isGroupScope(row.scope)) return;
		const parsed = parseScopeString(row.scope);
		if (parsed.type !== "qualified" || !bare.has(parsed.repo)) return;
		const other = bare.get(parsed.repo);
		throw configError(`scoped limit at index ${index}: ${JSON.stringify(row.scope)} and the bare ${JSON.stringify(parsed.repo)} at index ${other} name the same repo; keep one form (a bare row covers every forge, a qualified row one forge): ${path}`);
	});
}

/** A retired dollar field's refusal, naming the upgrade (fail loud, never a silent drop). */
function retiredDollarField(field, at, path) {
	throw configError(`${at}: ${field} was retired with the dollar windows: budgets are no longer denominated in dollars or tokens, so remove the field: ${path}`);
}

function normalizeLimit(row, index, path, version = SCOPED_LIMITS_VERSION) {
	const at = `scoped limit at index ${index}`;
	if (row === null || typeof row !== "object" || Array.isArray(row)) {
		throw configError(`${at}: must be an object: ${path}`);
	}
	if (!isNonEmptyString(row.scope)) throw configError(`${at}: scope must be a non-empty string: ${path}`);
	// The job-count scoped caps were removed. An old row carrying one is REFUSED here, naming the field(s) and the
	// removal: a version 1 or 2 file drops unknown keys, so letting `day` fall through would silently UNCAP the scope
	// while the file still reads as capping it. Null is the normalizer's own "unset", so only a value is refused.
	const retired = RETIRED_COUNT_FIELDS.filter((field) => row[field] !== undefined && row[field] !== null);
	if (retired.length > 0) {
		throw configError(`${at}: ${retired.join(", ")} ${retired.length === 1 ? "was" : "were"} retired with the job-count scoped caps; remove ${retired.length === 1 ? "it" : "them"} (only concurrent and size fields remain): ${path}`);
	}
	// The token windows were removed with every token budget and allocation. A row still carrying one is REFUSED here,
	// naming the removal, for the job-count fields' reason: silently dropping it would leave a row that reads as capped
	// while nothing enforces it. Null is the normalizer's own "unset", so only a value is refused.
	const retiredTokens = RETIRED_TOKEN_FIELDS.filter((field) => row[field] !== undefined && row[field] !== null);
	if (retiredTokens.length > 0) {
		throw configError(`${at}: ${retiredTokens.join(", ")} ${retiredTokens.length === 1 ? "was" : "were"} retired with the token budgets; remove ${retiredTokens.length === 1 ? "it" : "them"} (only concurrent and size fields remain): ${path}`);
	}
	// Version 3 refuses a key it does not know (issue #596): a misspelled `Memory`, `cpu` or `mem` beside a field that
	// keeps the row valid was dropped, and the project's jobs ran at the default size while the file read as sized.
	// Versions 1 and 2 keep dropping unknown keys, so a file an older build wrote and reads still loads unchanged.
	if (version >= 3) {
		const unknown = Object.keys(row).filter((key) => !V4_ROW_KEYS.has(key));
		if (unknown.length > 0) throw configError(`${at}: unknown key${unknown.length === 1 ? "" : "s"} ${unknown.map((k) => JSON.stringify(k)).join(", ")} (a version 3+ row carries only scope, ${[...LIMIT_FIELDS, ...SIZE_LIMIT_FIELDS].join(", ")}; keys are case-sensitive): ${path}`);
	}
	// The dollar fields are retired fail-loud, in every version: an old file carried real caps, and reading it as
	// version 4 without them would silently WIDEN every limit it set.
	for (const field of RETIRED_DOLLAR_FIELDS) {
		if (row[field] !== undefined && row[field] !== null) retiredDollarField(field, at, path);
	}
	const trimmed = row.scope.trim().normalize("NFC"); // the same NFC canonicalScope applies job-side
	// The per-model rows existed only to carry token windows, so they went with them. Refused rather than read as a repo
	// string no job ever has (the removed cap would vanish silently).
	if (isModelScope(trimmed)) throw configError(`${at}: model rows were retired with the token budgets; remove this row (a limit row names a repo, a folder or project:<id>): ${path}`);
	// A NEAR MISS of the removed model prefix is refused too, never read as a repo or folder row (PR #549's review): a
	// mistyped `Model:openai/x`, `models:...` or `model :...` would otherwise parse as a repo scope no job ever has.
	if (MODEL_NEAR_MISS.test(trimmed)) throw configError(`${at}: model rows were retired with the token budgets; remove this row (a limit row names a repo, a folder or project:<id>): ${path}`);
	// Issue #499 part B: `project:<id>` is a project row. Exactly that form: a near miss (`Project:shop`, `projects:shop`,
	// `project :shop`) or a malformed id is refused, never read as a repo row no job has, for the model row's reason.
	if (PROJECT_NEAR_MISS.test(trimmed)) {
		const id = trimmed.startsWith(PROJECT_SCOPE_PREFIX) ? trimmed.slice(PROJECT_SCOPE_PREFIX.length) : null;
		if (id === null) throw configError(`${at}: a project row's scope is written exactly project:<id> (lowercase "project", no space before the colon): ${path}`);
		if (!isProjectId(id)) throw configError(`${at}: a project row's id must match ${PROJECT_ID_RE.source} (the id in projects.json): ${path}`);
	}
	if (trimmed === "*") {
		// "*" as ONE shared counter is redundant with the global caps, so the only useful reading is a
		// per-scope default -- the OPPOSITE of what "*" means one file over (pause-windows: one rule
		// matching all scopes). Refused rather than shipped divergent; a later version may adopt the
		// per-scope-default reading, with an exact row beating "*" (recorded in the contract).
		throw configError(`${at}: "*" is not supported -- add one row per scope (a per-scope default may adopt "*" later): ${path}`);
	}
	if (trimmed.includes("*")) {
		// No globs, enforced rather than described: an exact matcher makes "acme/*" a row that governs
		// nothing, and a silently inert money limit is the failure class this repo refuses outright.
		throw configError(`${at}: scopes match exactly; a scope containing "*" is refused (no globs): ${path}`);
	}
	// Issue #498: `<forge kind>:<repo>` names one forge's repo; an unknown `<word>:` prefix is refused naming the kinds.
	// A project row is not a scope string a job carries, so the scope grammar does not apply to it.
	let form = { type: "project" };
	if (!isProjectScope(trimmed)) {
		try {
			form = parseScopeString(trimmed);
		} catch (error) {
			throw configError(`${at}: ${error.message}: ${path}`);
		}
	}
	if (form.type === "project" && version < 2) throw configError(`${at}: a project row needs "version": 2 (this file says ${version}), so a build that predates project rows refuses the file rather than reading an inert repo string: ${path}`);
	if (form.type === "qualified" && version < 2) throw configError(`${at}: a forge-qualified scope needs "version": 2 (this file says ${version}), so a build that predates it refuses the file rather than reading an inert repo string: ${path}`);
	const norm = {
		// An absolute path is stored resolved so a `/srv/site/` row governs `/srv/site` jobs -- the same
		// collapse canonicalScope applies on the job side. isAbsolute is PLATFORM-NATIVE on purpose, so a
		// foreign-platform row (a windows drive path on a POSIX worker) stays verbatim and is inert here;
		// the doctor's unreferenced-scope advisory names it. Resolving it instead would "work" only by
		// both sides mangling into the same cwd-prefixed string -- a match by accident, not by contract.
		scope: isProjectScope(trimmed) ? trimmed : form.type === "qualified" ? `${form.kind}:${form.repo}` : isAbsolute(trimmed) ? resolve(trimmed) : trimmed,
		concurrent: null,
		// Version 3's size fields (issue #596), the same way: only in a version 3 file's rows, null unless a project row
		// sets them, so a version 1 or 2 file reads into exactly the literal it always did.
		...(version >= 3 ? sizeNulls() : {}),
	};
	let any = false;
	for (const field of LIMIT_FIELDS) {
		const value = row[field];
		// Absent-or-null (subscriptions.mjs's rule): null is the normalizer's OWN output for an unset
		// field, so the parser must accept it back or it cannot re-parse what it produced -- the admin's
		// read-modify-write goes through this parser on both edges.
		if (value === undefined || value === null) continue;
		// 0 is refused, not "never run": budget.mjs's caps treat every configured window as >= 1, and
		// "never run this scope" already has two honest spellings (delete the trigger; a pause window).
		// isSafeInteger, not isInteger: 1e21 passes isInteger and reads as a limit while being
		// indistinguishable from unlimited -- a bound that cannot count is not a bound.
		if (!Number.isSafeInteger(value) || value < 1) {
			throw configError(`${at}: ${field} must be an integer >= 1: ${path}`);
		}
		norm[field] = value;
		any = true;
	}
	// Issue #596: a project row may carry a size and nothing else, so the size fields count as limiting something.
	if (sizeFields(row, norm, { at, path, version, project: isProjectScope(trimmed) })) any = true;
	if (!any) {
		throw configError(`${at}: at least one of concurrent${version >= 3 && isProjectScope(trimmed) ? ", memory, cpus, hostShare, minJobs" : ""} is required (a row that limits nothing is a row an operator sets and then trusts): ${path}`);
	}
	return norm;
}

/** The four version 3 size fields, all null: what a version 3 row carries when it sets none. */
function sizeNulls() {
	return { memory: null, cpus: null, hostShare: null, minJobs: null };
}

/**
 * Read a row's size fields into `norm` (issue #596), refusing loudly, and say whether it set any. Only a project row
 * may carry them: a size is what one project's jobs need, and a repo or folder row is not where a job's project is
 * decided. `minJobs` needs a size on the same row (a minimum of jobs of an unstated size reserves nothing anyone can
 * judge) and may not exceed the row's own `concurrent` (a minimum the project can never reach). `hostShare` against
 * `minJobs` times the size is judged where a host's budget is known (doctor warns, `hostBudgetChecks`), because a
 * percentage of a host is an amount only on a host.
 */
function sizeFields(row, norm, { at, path, version, project }) {
	const present = SIZE_LIMIT_FIELDS.filter((f) => row[f] !== undefined && row[f] !== null);
	if (present.length === 0) return false;
	if (!project) throw configError(`${at}: ${present.join(", ")} belong on a project row (project:<id>), because a job's size is its project's: ${path}`);
	if (version < 3) throw configError(`${at}: ${present.join(", ")} needs "version": 3 (this file says ${version}), so a build that predates job sizes refuses the file rather than running the project's jobs at the default size: ${path}`);
	const sized = (field, parse, store) => {
		if (row[field] === undefined || row[field] === null) return;
		try {
			norm[field] = store(parse(row[field]));
		} catch (error) {
			throw configError(`${at}: ${field}: ${error.message}: ${path}`);
		}
	};
	sized("memory", parseMemory, formatMemory);
	sized("cpus", parseCpus, (centi) => Number(formatCpus(centi)));
	if (row.hostShare !== undefined && row.hostShare !== null) {
		if (!Number.isSafeInteger(row.hostShare) || row.hostShare < 1 || row.hostShare > 100) throw configError(`${at}: hostShare is a whole percentage of the host's job budget, from 1 to 100 (got ${JSON.stringify(row.hostShare)}): ${path}`);
		norm.hostShare = row.hostShare;
	}
	if (row.minJobs !== undefined && row.minJobs !== null) {
		if (!Number.isSafeInteger(row.minJobs) || row.minJobs < 1) throw configError(`${at}: minJobs must be an integer >= 1: ${path}`);
		if (norm.memory === null && norm.cpus === null) throw configError(`${at}: minJobs needs memory or cpus on the same row, so the room it asks a host to keep has a size: ${path}`);
		if (norm.concurrent !== null && row.minJobs > norm.concurrent) throw configError(`${at}: minJobs ${row.minJobs} is above this row's concurrent ${norm.concurrent}, a minimum the project can never reach: ${path}`);
		norm.minJobs = row.minJobs;
	}
	return true;
}

/**
 * Load and validate the scoped-limits file named by `config.scopedLimitsFile`. Returns `[]` when the file
 * is unset (no scoped caps or concurrency -- a valid deployment; the folder mutex holds regardless, it is
 * code, not configuration). `readFileSync`/`existsSync` are injectable for tests.
 */
export function loadScopedLimits(config, { readFileSync = fsReadFileSync, existsSync = fsExistsSync } = {}) {
	const path = config.scopedLimitsFile;
	if (path === null || path === undefined) return [];
	if (!existsSync(path)) throw configError(`scoped-limits file does not exist: ${path}`);
	return parseScopedLimits(readFileSync(path, "utf8"), path);
}

/**
 * The row that applies to this job, or null. Exact string equality only -- the pause matcher's semantics minus
 * its "*" (refused above). A forge job matches the row equal to its `qualifiedScopeOf` first (`github:acme/web`),
 * then the row equal to its canonical bare repo (`acme/web`); a local job matches its resolved folder. With
 * duplicates refused and a bare row beside a qualified row for one repo refused too, at most one of the two can
 * exist, so the order is not a precedence ladder: it only says where to look.
 */
export function limitFor(limits, job) {
	if (!Array.isArray(limits)) return null;
	// A model row is never a job's scope (the parser refuses one). Nor is a project row: it
	// applies through the job's project (`projectRowFor`), never because a scope string happens to equal it.
	const find = (scope) => (isNonEmptyString(scope) ? limits.find((l) => l.scope === scope && !isGroupScope(l.scope)) ?? null : null);
	if (job?.kind !== "local") {
		const qualified = find(qualifiedScopeOf(job));
		if (qualified !== null) return qualified;
	}
	return find(canonicalScope(job));
}

/**
 * The scope every per-scope KEY of this job is built from (issue #498): the matched row's scope, or the job's
 * canonical scope when no row matches. The in-process slot and the fleet lease (`slot:s:<hash16>`) hash this one
 * string. Keyed by the ROW, never the job: a bare `acme/web`
 * row then keeps the exact key it had before qualified scopes existed (its counts carry over, and the admin,
 * which recomputes keys from rows, keeps reading them), and it stays ONE shared limit across forges as written.
 * The boot sweeper already hashes row scopes, so the gate and the sweeper are one rule.
 */
export function rowScopeFor(job, limits) {
	return limitFor(limits, job)?.scope ?? canonicalScope(job);
}

/**
 * The project row of this project id, or null (no id, or no row for it). A job's project is resolved ONCE at pickup
 * (`projectOf`, projects.mjs), and every project-row consumer below takes that id, never the job: the gate and the
 * record then agree for the attempt whatever an operator does to projects.json mid-run.
 */
export function projectRowFor(limits, projectId) {
	if (!Array.isArray(limits) || !isProjectId(projectId)) return null;
	const scope = projectScope(projectId);
	return limits.find((l) => l?.scope === scope) ?? null;
}

/**
 * The project rows whose id is not a project in `projects` (the parsed projects.json), as `[{ index, id }]` in file
 * order. Such a row caps nothing (no job can belong to a project that does not exist), so it is a refusal wherever the
 * two files meet: at boot, on a live reload of either file, and in the admin's write (issue #499 part B).
 */
export function danglingProjectRows(limits, projects) {
	const ids = new Set((Array.isArray(projects) ? projects : []).map((p) => p?.id));
	const out = [];
	(Array.isArray(limits) ? limits : []).forEach((row, index) => {
		if (!isProjectScope(row?.scope)) return;
		const id = row.scope.slice(PROJECT_SCOPE_PREFIX.length);
		if (!ids.has(id)) out.push({ index, id });
	});
	return out;
}

/**
 * Refuse a limits list that names a project `projects` does not have, naming each such row's index and id (ids are
 * charset-checked, never a path or a name) and BOTH files: the row lives in the scoped-limits file (`limitsPath`), the
 * missing id in the projects file (`projectsPath`, null when PI_PROJECTS_FILE is unset), so an operator reading a
 * refused projects.json edit looks for the index in the right file. Pure: the caller decides whether that is a boot
 * refusal or a kept last-good copy.
 */
export function checkProjectRows(limits, projects, limitsPath, projectsPath = null) {
	const dangling = danglingProjectRows(limits, projects);
	if (dangling.length === 0) return;
	const rows = dangling.map((d) => `index ${d.index} ("${PROJECT_SCOPE_PREFIX}${d.id}")`).join(", ");
	const where = projectsPath ? `the projects file ${projectsPath}` : "the projects file (PI_PROJECTS_FILE is unset, so there are no projects)";
	throw configError(`scoped-limits row(s) at ${rows} in ${limitsPath} name a project that is not in ${where}; add the project there first, or remove the row`);
}

/**
 * The lowest file version that expresses `rows` (normalized or as the admin builds them): 3 when any row carries a size
 * field (issue #596), else 2 when any row is a project row (issue #499 part B) or has a forge-qualified scope
 * (issue #498), else 1. The retired job-count fields (`day`/`week`/`month`) and the removed token windows and model
 * rows no longer count: they are refused by the parser in every version. The admin writes this, so a file with bare
 * and folder concurrency-only rows stays a version 1 file that an older worker still reads.
 */
export function scopedLimitsVersionFor(rows) {
	// Issue #596: a size field on any row needs version 3 (the parser refuses it off a project row, and says so).
	if ((rows ?? []).some((l) => SIZE_LIMIT_FIELDS.some((f) => l?.[f] !== null && l?.[f] !== undefined))) return 3;
	const v2 = (rows ?? []).some((l) => {
		const scope = typeof l?.scope === "string" ? l.scope.trim() : l?.scope;
		return isProjectScope(scope) || isQualifiedScope(scope);
	});
	return v2 ? 2 : 1;
}

/** Is this written scope forge-qualified? False for anything `parseScopeString` refuses: the parser names that. */
function isQualifiedScope(scope) {
	if (typeof scope !== "string" || scope === "") return false;
	try {
		return parseScopeString(scope).type === "qualified";
	} catch {
		return false;
	}
}

/**
 * The effective in-flight ceiling for this job's scope: `min(configured concurrent, structural)`, where
 * structural is 1 for a local job -- the folder mutex -- and unbounded otherwise. The mutex is
 * UNCONDITIONAL, in code, with no file configured and no off-switch: two agents in one bind-mounted
 * working tree is the race `run.replicas` is already refused on local jobs for, and a cron trigger
 * reaches it with no operator mistake at all (the scheduler mints the next occurrence at pickup and
 * promotes on time alone, so a slow run overlaps its own successor). A configured `concurrent` above 1
 * on a folder scope silently clamps to 1 rather than refusing at parse: scope strings are not reliably
 * typeable as folder-vs-repo (`"a/b"` is a legal relative folder and a legal repo), so a parse-time
 * classifier would misfire; min() cannot.
 *
 * No scope (a malformed payload) means no gate: Infinity, admit -- the job will fail its own validation
 * downstream, and holding a mutex slot under key `null` helps nobody.
 */
export function concurrencyFor(job, limits) {
	const scope = canonicalScope(job);
	if (scope === null) return Infinity;
	const structural = job?.kind === "local" ? 1 : Infinity;
	const configured = limitFor(limits, job)?.concurrent ?? Infinity;
	return Math.min(structural, configured);
}

/**
 * The redis key prefix the removed job-count windows used: `budget:s:<16 hex>`. Kept exported because the admin's
 * read-model still recomputes legacy count-window keys through it (`scopeKeyPrefix` is that one export and N
 * consumers). A hash (the localJobId idiom: sha256, first
 * 16 hex) rather than an escape: a scope legally contains `:` and `/` (folder paths, gitlab
 * group/subgroup/project), which would collide with budget.mjs's own `w:`/`m:`/`t:` sub-namespaces, and a
 * bijective escape grammar is a new thing to get wrong with unbounded key lengths. The one consumer that must map
 * keys BACK to scopes is the admin's counter display, and it knows the configured scopes -- it recomputes keys
 * through this same export, so unreadability in redis-cli is the accepted cost.
 */
export function scopeKeyPrefix(scope) {
	return `budget:s:${hash16(scope)}`;
}

/**
 * The rows the boot sweeper walks for this host's stale fleet claims (`makeScopeClaimSweeper`): every row as
 * `{ concurrent, hash }`, the hash of its ROW scope, the string the pickup gate leases under. A project row's
 * `concurrent` (issue #499 part B) is leased under `hash16("project:<id>")` and swept under the same hash; a row with no
 * `concurrent` carries a null count, which the sweeper skips.
 */
export function scopeClaimRows(limits) {
	return (Array.isArray(limits) ? limits : []).map((row) => ({ concurrent: row.concurrent, hash: hash16(row.scope) }));
}

/**
 * The per-process in-flight counter behind per-scope concurrency and the folder mutex. Process memory is
 * the CORRECT store, not a compromise: one worker per docker daemon is the shape DES-CONCURRENCY-3
 * assumes everywhere and `service install` enforces for installed units (`pi-dispatch start` holds no
 * lock, and two hand-run workers are already unsupported -- the second one's boot reaper kills the
 * first's live containers); the reaper removes every surviving `pi-job-*` container before the worker
 * starts draining, so a fresh, empty map is never wrong about a live container except when the reap
 * itself was skipped (`reaper_skipped`: docker missing/down at boot -- a state where no NEW container
 * can start either); and a Redis-held counter would survive a crash WRONGLY -- a claim for a container
 * the reaper just killed, demanding TTL/heartbeat machinery, a second source of truth about "what is
 * running" (the OQ-008 failure mode).
 *
 * `tryAcquire` is a synchronous check-and-increment: no await between the read and the take, so under
 * Node's single thread no interleaving exists at any concurrency. `release` never throws -- it runs in
 * the processor's finally, where a throw would mask the job's real error -- and clamps at zero.
 */
export function makeInFlight() {
	const counts = new Map();
	return {
		/** True and counted when under `limit`; false WITHOUT counting when at or over it. */
		tryAcquire(scope, limit) {
			const current = counts.get(scope) ?? 0;
			if (current >= limit) return false;
			counts.set(scope, current + 1);
			return true;
		},
		/** Decrement, deleting at zero; a release without a matching acquire is a no-op, never a throw. */
		release(scope) {
			const current = counts.get(scope) ?? 0;
			if (current <= 1) counts.delete(scope);
			else counts.set(scope, current - 1);
		},
		/** The current in-flight count for a scope (tests and future observability). */
		count(scope) {
			return counts.get(scope) ?? 0;
		},
	};
}
