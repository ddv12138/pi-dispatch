/**
 * Resolve a GitLab delivery's ACTOR: who sent it, as the numeric user id every later stage reads, and what
 * access level that actor holds -- the enforcement half of `CONST-TRIGGER-AUTHOR-GATE` on the GitLab side.
 *
 * GitHub puts `author_association` in the payload, so its gate is decidable from the delivery alone.
 * GitLab puts nothing equivalent anywhere in a webhook body, so the level has to be ASKED FOR. That single
 * fact shapes everything here:
 *
 *   - It runs in the receiver, between verification and `filterGitLab`, and only its VERDICT and the
 *     resolved id are passed on. The gate stays pure, total and offline-testable; a fetch inside it would
 *     make the security-critical decision untestable without a server.
 *   - It runs AFTER verification, never before, so an unauthenticated flood cannot make this project issue
 *     API calls on an attacker's behalf.
 *   - It distinguishes "not a member" from "could not tell", and those are different answers. A 404 is
 *     determinate and yields `authorized: false`, which the gate refuses. Anything else -- a 5xx, a dead
 *     socket, a revoked token -- is INDETERMINATE, and the receiver answers 503 so GitLab redelivers.
 *     Collapsing indeterminate to "deny" would silently drop legitimate work during an outage, with a 204
 *     that reads exactly like a correctly-refused stranger.
 *
 * `members/all` and not `members`: the `all` variant includes membership inherited from a parent group,
 * which is how most real GitLab organisations grant access. The plain endpoint reports only direct members
 * and would refuse a maintainer who holds their role at the group level -- a denial that looks like a
 * policy decision and is really a wrong question.
 *
 * WHY THIS RESOLVES AN IDENTITY AND NOT ONLY A ROLE. GitLab 13.x and earlier build the `user` object of a
 * webhook body out of `name`, `username`, `avatar_url` and `email` -- there is NO `user.id`, which is the
 * field `filterGitLab` requires before it will look at anything else (measured on 13.2.10: an `Issue Hook`
 * body's `user` is exactly those four keys). Such an instance therefore armed the endpoint and then dropped
 * every delivery as `missing-sender-id`, forever, with nothing wrong in its configuration. So the id is
 * resolved HERE, from the one identity those bodies do carry (`user.username`, already in
 * `INT-GITLAB-PAYLOAD-SUBSET` for the lookup's benefit), and handed to the gate as a number.
 *
 * Three rules keep that fallback from becoming a second, weaker gate:
 *
 *   - The payload's own `user.id` WINS whenever it is present, so an instance that sends one pays no extra
 *     call and the fallback can never disagree with the field the gate was written against.
 *   - The username must match EXACTLY ONE account (`?username=` is a filter, and an instance old enough to
 *     omit `user.id` may also be old enough to ignore the filter and answer with the first page of users).
 *     Anything else -- no match, several matches, a 404, a non-array body -- is not a refusal of a real
 *     person but the ABSENCE of an identity, and absence is reported as no id at all: the gate's own first
 *     step then drops it as `missing-sender-id`, which is what it has always meant.
 *   - A failure of either call is INDETERMINATE, never "not a member", exactly as a failed members lookup
 *     always was: a legacy instance whose `/users` is slow is an outage to retry through, not a stranger.
 *
 * The username is never sent, logged or returned; every lookup is by numeric user id, and it is personal
 * data with no downstream reader (`no-pii-in-logs`).
 */

import { fetchFailureReason } from "@edgehero/pi-dispatch/gitlab-identity";

/** GitLab's API path prefix. `apiUrl` is the instance root, e.g. `https://gitlab.com`. */
const API_PREFIX = "/api/v4";

/**
 * GitLab's Developer role. At or above it, an actor can push to the project, which is the property
 * CONST-TRIGGER-AUTHOR-GATE actually requires -- "write access or above", by whatever mechanism the forge
 * offers.
 *
 * The threshold lives HERE, with the lookup that produces the number, rather than in the gate. The gate's
 * job is "is this actor authorised", and every forge answers that differently: GitLab with an integer role,
 * Forgejo with a string enum, GitHub with a payload field, Azure DevOps with a group membership. Only the
 * VERDICT is common, so only the verdict crosses into the filter.
 */
const DEVELOPER = 30;

/** The actor this delivery is from, as a number, or why that could not be established. */
const NOBODY = Object.freeze({ id: undefined, authorized: false });

/**
 * Build the resolver. `token` is the same operator-supplied access token the worker uses; `fetchFn` is
 * injected so the whole module is testable offline.
 *
 * Returns `resolveActor(projectId, user)` -> `{ id, authorized }` | `{ indeterminate: string }`, where
 * `user` is the projection's `{ id, username }`. `id` is `undefined` only when the delivery named no actor
 * this deployment could find an id for; the gate refuses that before it asks anything else.
 *
 * That two-armed shape is the one every forge's resolver returns, and it is deliberately not a bare
 * boolean: `false` and "could not tell" are different answers with different HTTP responses, and a type
 * that cannot express the difference would collapse them at the first call site that forgot.
 */
export function makeResolveActor({ apiUrl, token, fetchFn = fetch }) {
	return async function resolveActor(projectId, user) {
		// The project first, and before any identity lookup: without one there is nothing to authorise
		// against, so the two calls below would be spent on an answer nobody can use.
		if (!Number.isInteger(projectId)) return NOBODY;
		const who = await actorIdOf(user);
		if (who.indeterminate) return who;
		if (!Number.isInteger(who.id)) return NOBODY;
		const level = await memberLevelOf(projectId, who.id);
		if (level.indeterminate) return level;
		return { id: who.id, authorized: level.authorized };
	};

	/** `{ id }` when the delivery names an actor, `{ id: undefined }` when it names none we can find, `{ indeterminate }` when the question could not be asked. */
	async function actorIdOf(user) {
		if (Number.isInteger(user?.id)) return { id: user.id };
		const username = typeof user?.username === "string" && user.username !== "" ? user.username : null;
		// Neither field set: the body named no actor at all. Determinate, and there is nothing to ask.
		if (username === null) return { id: undefined };
		const url = `${String(apiUrl).replace(/\/+$/, "")}${API_PREFIX}/users?username=${encodeURIComponent(username)}`;
		let res;
		try {
			res = await fetchFn(url, { headers: { "PRIVATE-TOKEN": token }, redirect: "error" });
		} catch (err) {
			return { indeterminate: `user lookup failed (${fetchFailureReason(err)})` };
		}
		if (!res.ok) {
			// NOT a refusal of the actor: a 404 here means this instance has no such endpoint (or the token
			// may not read it), which is a deployment problem to retry through, exactly as the members
			// lookup's non-404 failures are.
			return { indeterminate: `user lookup returned ${res.status}` };
		}
		let body;
		try {
			body = await res.json();
		} catch {
			return { indeterminate: "user lookup returned unparseable JSON" };
		}
		if (!Array.isArray(body)) return { indeterminate: "user lookup returned no array" };
		// EXACTLY ONE exact match. A filter that was ignored, a renamed account, a lookalike spelling: all
		// of them leave us unable to say who this is, and saying nothing is the only safe answer.
		const matches = body.filter((entry) => entry?.username === username);
		return matches.length === 1 && Number.isInteger(matches[0].id) ? { id: matches[0].id } : { id: undefined };
	}

	/** `{ authorized }` for a numeric actor, or `{ indeterminate }`. */
	async function memberLevelOf(projectId, userId) {
		const url = `${String(apiUrl).replace(/\/+$/, "")}${API_PREFIX}/projects/${projectId}/members/all/${userId}`;
		let res;
		try {
			res = await fetchFn(url, { headers: { "PRIVATE-TOKEN": token }, redirect: "error" });
		} catch (err) {
			return { indeterminate: fetchFailureReason(err) };
		}
		if (res.status === 404) {
			// GitLab's documented answer for "this user is not a member of this project", including via any
			// ancestor group. The one status this may read as a refusal rather than a failure.
			return { authorized: false };
		}
		if (!res.ok) {
			return { indeterminate: `members lookup returned ${res.status}` };
		}
		let body;
		try {
			body = await res.json();
		} catch {
			// A FIXED reason, never err.message: V8's JSON.parse errors quote the offending input,
			// so a failed res.json() here would carry response-body bytes into a log line -- the
			// no-pii-in-logs rule the github resolver states, applied to its elders (issue #231).
			return { indeterminate: "members lookup returned unparseable JSON" };
		}
		const level = body?.access_level;
		if (!Number.isInteger(level)) {
			// A 200 whose shape we do not recognise is not a refusal. Reporting `authorized: false` here would
			// turn an upstream schema change into a silent, permanent refusal of every trigger.
			return { indeterminate: "members lookup returned no integer access_level" };
		}
		return { authorized: level >= DEVELOPER };
	}
}
