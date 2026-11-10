import assert from "node:assert/strict";
import { test } from "node:test";
import { makeGitHubAuth } from "../src/get-token.mjs";

/**
 * All collaborators are injected. Fakes are hand-rolled (no mocking library), matching the
 * budget/identity test convention.
 */

/** Fake @octokit/rest: `new Octokit(opts)` records its options; `request(route)` returns canned `{ data }`. */
function FakeOctokit(routes) {
	return class {
		constructor(options) {
			this.options = options;
			instances.push(options);
		}
		async request(route) {
			if (!(route in routes)) throw new Error(`unexpected route: ${route}`);
			const canned = routes[route];
			if (canned instanceof Error) throw canned;
			return { data: canned };
		}
	};
}

const instances = [];
const USER_ROUTES = { "GET /user": { id: 4242, login: "octo" } };

/** An Error tagged like an octokit RequestError. */
function httpError(status, extra = {}) {
	const e = new Error(`HTTP ${status}`);
	e.status = status;
	return Object.assign(e, extra);
}

// -- pat -----------------------------------------------------------------------------------------

test("pat happy: mintToken returns the non-empty token, selfId is the /user integer id", async () => {
	instances.length = 0;
	const auth = await makeGitHubAuth(
		{ pat: "ghp_realtoken" },
		{ Octokit: FakeOctokit(USER_ROUTES), env: { GITHUB_PAT: "ghp_realtoken" } },
	);
	assert.equal(auth.source, "pat");
	assert.equal(auth.selfId, 4242);
	assert.ok(Number.isInteger(auth.selfId));
	const token = await auth.mintToken("owner/repo");
	assert.equal(token, "ghp_realtoken");
	assert.ok(token.length > 0);
	assert.equal(instances[0].auth, "ghp_realtoken", "the client is authenticated with the PAT");
});

test("pat is trimmed once: whitespace around the env value never reaches GitHub", async () => {
	const auth = await makeGitHubAuth({}, { Octokit: FakeOctokit(USER_ROUTES), env: { GITHUB_PAT: "  ghp_padded\n" } });
	assert.equal(await auth.mintToken({ kind: "github", repo: "o/r" }), "ghp_padded");
});

test("pat empty env var is a config error (money hole: absent GITHUB_TOKEN runs anonymously)", async () => {
	await assert.rejects(
		() => makeGitHubAuth({}, { Octokit: FakeOctokit(USER_ROUTES), env: { GITHUB_PAT: "" } }),
		(e) => e.piDispatchConfig === true && /GITHUB_PAT/.test(e.message),
	);
});

test("pat absent is a config error, never an empty token", async () => {
	await assert.rejects(
		() => makeGitHubAuth({}, { Octokit: FakeOctokit(USER_ROUTES), env: {} }),
		(e) => e.piDispatchConfig === true && /GITHUB_PAT/.test(e.message),
	);
});

test("pat whitespace-only env var is a config error", async () => {
	await assert.rejects(
		() => makeGitHubAuth({}, { Octokit: FakeOctokit(USER_ROUTES), env: { GITHUB_PAT: "   \t\n" } }),
		(e) => e.piDispatchConfig === true,
	);
});

test("pat identity refusal: a 401 is a tagged config error, so the service stops", async () => {
	await assert.rejects(
		() => makeGitHubAuth({}, { Octokit: FakeOctokit({ "GET /user": httpError(401) }), env: { GITHUB_PAT: "ghp_bad" } }),
		(e) => e.piDispatchConfig === true && /could not resolve self identity/.test(e.message),
	);
});

test("pat identity: a transient refusal stays untagged, so a supervisor restarts the service", async () => {
	for (const [name, error] of [
		["500", httpError(500)],
		["429", httpError(429)],
		["primary rate limit (403 + x-ratelimit-remaining: 0)", httpError(403, { response: { headers: { "x-ratelimit-remaining": "0" } } })],
		["a network fault, which octokit reports as 500", Object.assign(httpError(500), { cause: Object.assign(new Error("getaddrinfo ENOTFOUND api.github.com"), { code: "ENOTFOUND" }) })],
	]) {
		await assert.rejects(
			() => makeGitHubAuth({}, { Octokit: FakeOctokit({ "GET /user": error }), env: { GITHUB_PAT: "ghp_x" } }),
			(e) => e.piDispatchConfig === undefined,
			`${name} must throw untagged, so entryExitCode gives 1 and the supervisor restarts`,
		);
	}
});

test("the caller's logger reaches the Octokit client", async () => {
	instances.length = 0;
	const events = [];
	await makeGitHubAuth(
		{},
		{ Octokit: FakeOctokit(USER_ROUTES), env: { GITHUB_PAT: "ghp_x" }, log: (event, fields) => events.push({ event, ...fields }) },
	);
	assert.equal(typeof instances[0].log?.warn, "function", "octokitLogOptions' `log` is passed");
	assert.equal(typeof instances[0].request?.log?.warn, "function", "and its `request` logger beside it (issue #530)");
});
