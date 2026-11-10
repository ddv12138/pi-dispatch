/**
 * GitHub authentication for the worker and receiver: ONE fine-grained, repository-scoped PAT in
 * `GITHUB_PAT`, resolved once at construction into the same `{ mintToken, selfId, source }` shape the
 * processor consumes, so the processor never branches on a source.
 *
 * CONST-TOKEN-SCOPED-PER-JOB: the credential is the operator's own PAT -- the one scope and expiry their
 * GitHub settings give it -- and every job hands that same token to its container. The per-job SCOPING
 * claim is therefore the operator's, not this module's: the token should be fine-grained and limited to
 * the repositories this deployment serves (the INT-CONTAINER-RUNTIME-CONTRACT trade-off note).
 *
 * Money-hole invariant: `mintToken` NEVER returns "" / null. `env-allowlist.mjs` forwards the token
 * as `GITHUB_TOKEN` only when truthy (`if (githubToken)`), so an empty token becomes an ABSENT
 * variable -- a silent anonymous run that still spends provider money. The mint routes through
 * `requireToken`, which throws `configError` on an empty/whitespace token instead of handing it out.
 *
 * All side-effecting collaborators are INJECTED (Octokit, env, log), each defaulting to the real import
 * -- the budget.mjs / identity.mjs DI convention -- so the module is testable offline with no GitHub.
 */

import { Octokit as RealOctokit } from "@octokit/rest";
import { configError } from "./config.mjs";
import { resolveSelfId } from "./identity.mjs";
import { octokitLogOptions } from "./octokit-log.mjs";

/**
 * Build the auth surface for `cfg` (unused beyond the call-site convention: the credential is the
 * process environment's `GITHUB_PAT`).
 *
 * Returns `{ mintToken, selfId, source }`:
 *   - `mintToken(job)` -> a non-empty token string (rejects, never returns empty). It takes the whole
 *     job because that is the shape every forge's auth implements; this one reads no part of it.
 *   - `selfId` -> the token owner's integer user id (resolved once here, for the bot-loop guard).
 *   - `source` -> always `"pat"`, echoed so a boot line can name the credential without printing it.
 *
 * Fails CLOSED at construction: an empty/blank PAT or an unresolvable identity throws before returning,
 * so a misconfigured worker refuses to boot (and a job mints nothing) rather than running anonymously.
 */
export async function makeGitHubAuth(cfg, deps = {}) {
	void cfg; // kept as the first argument so every forge's factory has one call shape
	const {
		Octokit = RealOctokit,
		env = process.env,
		// Issue #530: the caller's `(event, fields)` logger, which a GitHub client's own warnings go through. The
		// client is built with `octokitLogOptions`, so it never prints Octokit's plain `GET /user - 401 ...` line
		// into a JSON stream.
		log,
	} = deps;
	const quiet = octokitLogOptions(log);

	const token = requireToken(env.GITHUB_PAT, "GITHUB_PAT");
	const octokit = new Octokit({ auth: token, ...quiet });
	const selfId = await resolveSelfId({ source: "pat", octokit });
	// Trimmed once above; the same non-empty value every job gets.
	const mintToken = async () => requireToken(token, "GITHUB_PAT");
	return { mintToken, selfId, source: "pat" };
}

/**
 * Enforce the money-hole invariant: return a trimmed non-empty token, or throw `configError`.
 * Handing back "" would let `env-allowlist.mjs` drop `GITHUB_TOKEN` entirely and run anonymously.
 */
function requireToken(raw, what) {
	const token = (raw ?? "").trim();
	if (!token) {
		throw configError(
			`${what}: empty token -- refusing to run (an absent GITHUB_TOKEN runs anonymously on paid infra; set GITHUB_PAT to a fine-grained, repository-scoped PAT)`,
		);
	}
	return token;
}
