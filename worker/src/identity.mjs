/**
 * Resolve the acting GitHub identity's numeric `id` -- the value that appears in webhook
 * `sender.id`. The receiver's bot-loop guard compares an incoming `sender.id` against this to
 * refuse events the harness itself authored (an unbounded paid recursion otherwise). If the id
 * cannot be resolved the guard cannot arm, so this fails CLOSED: any failure throws and the
 * process must not boot. WHICH failure it throws is what decides whether the process comes back
 * (issue #316): a determinate fault is tagged and stays stopped, a transient one is untagged and
 * is restarted.
 *
 * The `octokit` client is INJECTED, already authenticated by the caller with the operator's
 * `GITHUB_PAT`. This module never constructs Octokit -- keeping it a pure, testable leaf, per
 * the budget.mjs convention.
 */

import { configError } from "./config.mjs";
import { isDeterminateFetchFailure, isTransientStatus, octokitHeaderReader, transientError } from "./transient.mjs";

/**
 * Resolve the acting identity's numeric user id from `auth = { source, octokit }`. `source` is always
 * `"pat"` now -- the PAT belongs to a user, so `GET /user` yields that user's id.
 *
 * Returns an integer id. Throws `configError` on unknown/missing source, missing octokit, a determinate
 * octokit refusal, or a non-integer id.
 *
 * A TRANSIENT octokit rejection throws UNTAGGED instead (issue #316). The tag is not decoration here: it
 * is the difference between a service that comes back and one that does not. `receiver/src/cli.mjs` maps
 * a tagged throw to `EXIT_POLICY` (2), which `RestartPreventExitStatus=2` and nssm's `AppExit 2 Exit`
 * deliberately leave stopped; and on the worker, whose `cli.mjs` never sees this because `start.mjs`
 * catches it best-effort, the tag decides whether that forge stays credential-less for the lifetime of
 * the process, after which every job of that kind is publicly told the deployment is misconfigured. A
 * `GET /user` that timed out is none of those things.
 *
 * TWO THINGS THE STATUS ALONE CANNOT TELL YOU, both of which have to be answered before it is consulted.
 * `@octokit/request`'s fetch wrapper turns EVERY network rejection into `RequestError(message, 500)` and
 * keeps the original as `cause`, so a private CA or a redirect arrives wearing a transient status and the
 * determinate check has to run first. And an ABSENT status means the failure never reached the HTTP layer
 * at all, because octokit always sets one: it came from local code, and no amount of restarting fixes it.
 */
export async function resolveSelfId(auth) {
	const source = auth?.source;
	const octokit = auth?.octokit;

	if (source !== "pat") {
		throw configError(`resolveSelfId: unknown auth source: ${source}`);
	}
	if (!octokit) {
		throw configError("resolveSelfId: missing octokit client");
	}

	let id;
	try {
		const { data: user } = await octokit.request("GET /user");
		id = user.id;
	} catch (error) {
		// Order is load-bearing; see the docblock. Trust and redirect faults are wearing a 500, and a
		// status-less rejection never reached the network.
		const status = typeof error?.status === "number" ? error.status : undefined;
		if (!isDeterminateFetchFailure(error) && status !== undefined && isTransientStatus(status, octokitHeaderReader(error), error?.message)) {
			throw transientError(`resolveSelfId: could not reach GitHub to resolve self identity: ${error.message}`, error);
		}
		// The RequestError rides as `cause` (issue #530's review), so the failure line can name GitHub's request id.
		throw Object.assign(configError(`resolveSelfId: could not resolve self identity: ${error.message}`), { cause: error });
	}

	if (!Number.isInteger(id)) {
		throw configError(`resolveSelfId: resolved id is not an integer: ${JSON.stringify(id)}`);
	}
	return id;
}
