/**
 * Poller configuration (issue #81, polling producer). The polling producer shares almost everything
 * with the webhook receiver -- the triggers file, the GitHub auth block, the queue URL -- and differs
 * on exactly one requirement: WEBHOOK_SECRET.
 *
 * The receiver HARD-REQUIRES that secret because an inbound delivery is a forgeable paid-agent
 * trigger until the HMAC over the raw body proves otherwise (CONST-HMAC-OVER-RAW-BODY). The poller
 * has no inbound anything: it originates every request itself, over TLS, to api.github.com, carrying
 * the operator's own credential -- the authentication runs in the OTHER direction, so there is
 * nothing for a webhook secret to verify and demanding one would block exactly the deployment this
 * mode exists for (no public URL, no DNS, no tunnel).
 *
 * REUSE, NEVER RE-DERIVE: this loader does not fork `loadTriggers`/`loadGitHubAuth`. It calls the
 * receiver's own `loadReceiverConfig` -- the single place the trigger file is grouped for the filter
 * and the auth block is validated -- satisfying its WEBHOOK_SECRET precondition with an inert
 * placeholder when the env has none, and then DROPS the field from the returned object so nothing
 * downstream can ever read the placeholder and believe it is armed. A forked grouping loader would be
 * the classic drift: two parsers of one file, one of them quietly behind on the next rule field.
 *
 * Poller-specific env:
 *   - POLL_REPOS: comma-separated `owner/name` list -- the explicit answer to "which repos", and the
 *     poller's GitHub arm. Required: there is no App installation to list any more, so an empty set is a
 *     config error (a poller that watched nothing would look exactly like a poller that was working).
 *   - GITHUB_PAT: the fine-grained, repository-scoped PAT the poller polls with. Required alongside
 *     POLL_REPOS, because the poller resolves its own identity through the same credential.
 *   - POLL_INTERVAL_SECONDS: the cycle delay, default 60, floored at 30. The floor is a courtesy to
 *     GitHub's polling guidance (the API asks pollers to respect `X-Poll-Interval`, typically 60s);
 *     a typo'd `1` must not turn the harness into a hammer.
 *
 * Errors are tagged `piDispatchConfig` (shared `configError`), so the receiver bin's entryExitCode
 * maps them to EXIT_POLICY (2) and a supervisor never restart-loops a config that cannot parse.
 */

import { existsSync, readFileSync } from "node:fs";
import { configError, positiveInt } from "@edgehero/pi-dispatch/config";
import { loadReceiverConfig } from "./config.mjs";

// Never a real secret and never returned: it exists only to satisfy loadReceiverConfig's fail-loud
// precondition when the deployment is pure-polling and legitimately has no WEBHOOK_SECRET at all.
const PLACEHOLDER_SECRET = "poller-has-no-webhook-to-verify";

const POLL_INTERVAL_FLOOR_SECONDS = 30;
const POLL_INTERVAL_DEFAULT_SECONDS = 60;

/**
 * Parse the poller's config from `env`. Filesystem access is injected (`readFile`, `fileExists`) and
 * forwarded to the receiver loader, so the whole thing is hermetically testable.
 *
 * Returns `{ valkeyUrl, triggers, github, repos, intervalSeconds, identityRetryWindowMs }` -- and
 * deliberately nothing else.
 * `webhookSecret`, `port`, `bind` and the other-forge blocks are receiver-only concerns: the poller
 * binds no port and speaks only GitHub (the other forges' producers stay webhook-armed).
 * `repos` is always the explicit `POLL_REPOS` list: there is no installation to discover repositories
 * from, so an unset or empty list refuses at boot.
 */
export function loadPollerConfig(env = process.env, { readFile = readFileSync, fileExists = existsSync } = {}) {
	// A present WEBHOOK_SECRET is passed through untouched (a deployment may run serve AND poll from
	// one env file); only its ABSENCE is papered over, and only for the duration of this call.
	const base = loadReceiverConfig(
		env.WEBHOOK_SECRET ? env : { ...env, WEBHOOK_SECRET: PLACEHOLDER_SECRET },
		{ readFile, fileExists },
	);

	const repos = parsePollRepos(env.POLL_REPOS);
	if (repos === null) {
		// Fail-loud at boot: a poller with an empty repo set would cycle forever, log healthy summaries,
		// and trigger nothing -- indistinguishable from working until someone labels an issue and waits.
		// There is no App installation to fall back to, so the set must be explicit.
		throw configError("nothing to poll: set POLL_REPOS=owner/name[,owner/name...] -- a poller has no credential that can list repositories, so the set must be explicit");
	}
	if (!base.github.pat) {
		// The arm POLL_REPOS enables is a GitHub arm, so it needs the one GitHub credential. Naming it at
		// load is the difference between one clear line and a failed identity boot gate.
		throw configError("GITHUB_PAT is required to poll: a fine-grained, repository-scoped PAT is the only GitHub credential, and POLL_REPOS names the repositories it must reach");
	}

	return {
		valkeyUrl: base.valkeyUrl, // mirrors the receiver: producer and consumer share one queue
		triggers: base.triggers, // the SAME grouped rules the webhook filter reads -- one gate, two feeds
		github: base.github, // validated by the shared loadGitHubAuth, exactly as serve validates it
		allowSelf: base.allowSelf, // the poller reads the SAME gate (filter()), so it obeys the same switch
		repos,
		intervalSeconds: Math.max(POLL_INTERVAL_FLOOR_SECONDS, positiveInt(env, "POLL_INTERVAL_SECONDS", POLL_INTERVAL_DEFAULT_SECONDS)),
		// Passed THROUGH the receiver loader rather than re-parsed: one parse, one floor (issue #318).
		// The poller's boot identity gate is the same hard-fail gate serve has, so it retries under the
		// same window -- a pure-polling deployment loses deliveries to a stopped process just as surely.
		identityRetryWindowMs: base.identityRetryWindowMs,
	};
}

/**
 * `POLL_REPOS` -> `["owner/name", ...]`, `null` when unset/empty (falsy-is-unset, matching the
 * receiver's forge blocks). Set-but-garbled fails loud: a silently dropped entry is a repo the
 * operator believes is watched. Duplicates are collapsed so a repeated entry cannot double-poll
 * (and double-enqueue-attempt) one repo.
 */
function parsePollRepos(raw) {
	if (raw === undefined || raw.trim() === "") return null;
	const entries = [...new Set(raw.split(",").map((s) => s.trim()).filter((s) => s !== ""))];
	if (entries.length === 0) {
		throw configError(`POLL_REPOS is set but names no repositories: ${JSON.stringify(raw)}`);
	}
	for (const entry of entries) {
		if (!/^[^\s/]+\/[^\s/]+$/.test(entry)) {
			throw configError(`POLL_REPOS entries must be owner/name, got ${JSON.stringify(entry)}`);
		}
	}
	return entries;
}
