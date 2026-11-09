import assert from "node:assert/strict";
import { test } from "node:test";
import { issueBranch } from "../src/branch.mjs";
import { keyParts, SESSION_KEY_PATTERN, sessionKeyFor, sessionKeyOfRecord } from "../src/session-key.mjs";
import { FORGE_KINDS } from "../src/forges.mjs";

const ghIssue = { kind: "github", repo: "o/r", target: { type: "issue", number: 7 } };
const ghPr = { kind: "github", repo: "o/r", target: { type: "pull_request", number: 8 } };
const glIssue = { kind: "gitlab", repo: "o/r", projectId: 42, target: { type: "issue", number: 7 } };
const azIssue = { kind: "azure", repo: "o/r", projectId: "azure-project", target: { type: "issue", number: 7 } };
/** A forge job carrying the identity that forge actually puts on it. */
const forgeIssue = (kind) => (kind === "gitlab" ? glIssue : kind === "azure" ? azIssue : { kind, repo: "o/r", target: { type: "issue", number: 7 } });
const namespaceOf = (kind) => (kind === "gitlab" ? "42" : kind === "azure" ? "azure-project" : "");
const sameRepo = { headRef: "pi/issue-7", headRepo: "o/r" };

test("an issue job keys on the branch its own envelope names, so the issue and its PR converge", () => {
	// This convergence IS the feature: issue #7's job opens PR #8 on pi/issue-7, and a later job on PR #8
	// resolves the same key because the head ref is that branch. Keying on the NUMBER would give 7 and 8
	// and never join -- the mistake a reviewer will propose.
	assert.deepEqual(keyParts(ghIssue), ["github", "o/r", "", "pi/issue-7"]);
	assert.equal(sessionKeyFor(ghPr, sameRepo), sessionKeyFor(ghIssue));
});

test("a fork pull request resolves NO KEY -- the one hole with a stranger on the other side", () => {
	// A stranger forks, names a branch pi/issue-7, and gets a collaborator to act on the PR. Without this
	// gate they are handed issue 7's transcript: tool output, file contents, the model's own reasoning.
	assert.equal(sessionKeyFor(ghPr, { headRef: "pi/issue-7", headRepo: "stranger/r" }), null);
	assert.equal(keyParts(ghPr, { headRef: "pi/issue-7", headRepo: "stranger/r" }), null);
	// Absence of a key, never a flag: there is no later stage that could forget to check it.
	for (const headRepo of [undefined, null, "", 7, {}, "o/r2", "O/R"]) {
		assert.equal(sessionKeyFor(ghPr, { headRef: "pi/issue-7", headRepo }), null, `headRepo ${JSON.stringify(headRepo)} must not resolve against base o/r`);
	}
});

test("an unresolved head ref is a cold start, not a guess", () => {
	for (const headRef of [undefined, null, "", 7]) {
		assert.equal(sessionKeyFor(ghPr, { headRef, headRepo: "o/r" }), null, `headRef ${JSON.stringify(headRef)} must not resolve`);
	}
	assert.equal(sessionKeyFor(ghPr), null, "no resolution at all means no key");
});

test("the key separates repo from ref, so two repos and two branches are four transcripts", () => {
	const keys = new Set([
		sessionKeyFor({ ...ghIssue, repo: "o/r" }),
		sessionKeyFor({ ...ghIssue, repo: "o/r2" }),
		sessionKeyFor({ ...ghIssue, target: { type: "issue", number: 8 } }),
		sessionKeyFor({ ...ghIssue, repo: "o/r2", target: { type: "issue", number: 8 } }),
	]);
	assert.equal(keys.size, 4, "a container that could name another repo's or another PR's transcript is a cross-tenant leak");
});

test("the delimiter stops a repo/ref boundary shift from colliding two distinct keys", () => {
	// ("ab", "c") and ("a", "bc") must not hash alike -- job-id.mjs's NUL reasoning, same failure.
	const a = sessionKeyFor({ kind: "github", repo: "o/rx", target: { type: "pull_request" } }, { headRef: "y", headRepo: "o/rx" });
	const b = sessionKeyFor({ kind: "github", repo: "o/r", target: { type: "pull_request" } }, { headRef: "xy", headRepo: "o/r" });
	assert.notEqual(a, b);
});

test("the same branch on the two forges is two transcripts, not one", () => {
	assert.notEqual(sessionKeyFor(ghIssue), sessionKeyFor(glIssue));
	assert.notEqual(sessionKeyFor(ghIssue), sessionKeyFor(azIssue));
});

test("the immutable forge project id is in BOTH the issue and the request key", () => {
	// Deleting and recreating a GitLab project under the same path issues a new numeric id. It must not resume
	// the deleted project's transcript, so the id is hash material for the issue AND the pull/merge request.
	const gl42 = { ...glIssue, projectId: 42 };
	const gl43 = { ...glIssue, projectId: 43 };
	assert.notEqual(sessionKeyFor(gl42), sessionKeyFor(gl43), "same repo, branch and issue number; a different project is a different session");
	assert.equal(sessionKeyFor(gl42), sessionKeyFor({ ...gl42 }), "the same project id resolves the same key");
	assert.deepEqual(keyParts(gl42), ["gitlab", "o/r", "42", "pi/issue-7"]);
	const headRef = "pi/issue-7";
	assert.notEqual(sessionKeyFor({ ...gl42, target: { type: "pull_request", number: 8 } }, { headRef, headRepo: "o/r" }), sessionKeyFor({ ...gl43, target: { type: "pull_request", number: 8 } }, { headRef, headRepo: "o/r" }), "a request key carries the namespace too");
	// Azure's string id does the same, whether it rides `projectId` or the org/project/repository triple.
	const azA = { ...azIssue, projectId: "a-project" };
	const azB = { ...azIssue, projectId: "b-project" };
	assert.notEqual(sessionKeyFor(azA), sessionKeyFor(azB));
	assert.deepEqual(keyParts(azA), ["azure", "o/r", "a-project", "pi/issue-7"]);
	assert.equal(sessionKeyFor({ ...azIssue, projectId: undefined, azure: { projectId: "from-triple" } }), sessionKeyFor({ ...azIssue, projectId: "from-triple" }));
});

test("a GitLab/Azure job with no usable project id resolves NO KEY -- never the old repo-only key", () => {
	// Fail closed: a project deleted and recreated under the same path must cold-start, not resume through `repo`.
	const invalid = {
		// GitLab's id is a NUMBER on the job; a decimal string is not the value the receiver carries, so it fails closed.
		gitlab: [undefined, null, "", "42", 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, {}, []],
		// Azure's id is a non-empty STRING, so "42" is a perfectly good identity and only emptiness/non-strings fail.
		azure: [undefined, null, "", 0, -1, 1.5, {}, []],
	};
	for (const kind of ["gitlab", "azure"]) {
		for (const projectId of invalid[kind]) {
			const job = { ...forgeIssue(kind), projectId };
			assert.equal(sessionKeyFor(job), null, `${kind} projectId ${JSON.stringify(projectId)} must not resolve`);
			assert.equal(keyParts(job), null, `${kind} projectId ${JSON.stringify(projectId)} has no key material`);
		}
	}
	assert.equal(sessionKeyFor({ kind: "azure", repo: "o/r", projectId: "", azure: { projectId: "" }, target: { type: "issue", number: 7 } }), null);
	// A valid Azure triple is still an identity when `projectId` is absent.
	assert.match(sessionKeyFor({ kind: "azure", repo: "o/r", azure: { projectId: "p" }, target: { type: "issue", number: 7 } }), SESSION_KEY_PATTERN);
});

test("GitHub and Forgejo keep the empty namespace and still resolve a key", () => {
	for (const kind of ["github", "forgejo"]) {
		const job = { kind, repo: "o/r", target: { type: "issue", number: 7 } };
		assert.deepEqual(keyParts(job), [kind, "o/r", "", "pi/issue-7"]);
		assert.match(sessionKeyFor(job), SESSION_KEY_PATTERN);
	}
});

test("a cron job keys on its scheduler id -- operator-authored, chosen by nobody untrusted", () => {
	const cron = { kind: "local", folder: "/srv/app", flow: "maintain", trigger: { id: "nightly", pattern: "0 3 * * *" } };
	assert.deepEqual(keyParts(cron), ["local", "", "nightly"]);
	assert.notEqual(sessionKeyFor(cron), sessionKeyFor({ ...cron, trigger: { id: "weekly" } }));
	// The folder is deliberately NOT in the key: the scheduler id already identifies the entry uniquely,
	// and a host path in the key would put the OS account name into a directory name on Windows.
	assert.equal(sessionKeyFor(cron), sessionKeyFor({ ...cron, folder: "/somewhere/else" }));
});

test("a job with no trigger entry that could have armed run.resume resolves null", () => {
	// A CLI `pi-dispatch run` and a chained /outbox child both arrive as kind:"local" with no trigger.
	assert.equal(sessionKeyFor({ kind: "local", folder: "/srv/app", flow: "fix", task: "do it" }), null);
	assert.equal(sessionKeyFor({ kind: "local", flow: "fix", parentJobId: "gh-abc", chainDepth: 1 }), null);
	assert.equal(sessionKeyFor({ kind: "local", trigger: { pattern: "0 3 * * *" } }), null, "a trigger without an id is not an identity");
});

test("the function is total: no input throws, because a throw here would fail a job over a cache miss", () => {
	for (const job of [undefined, null, {}, { kind: "github" }, { kind: "github", repo: "o/r" }, { kind: "nonsense", repo: "o/r" }, { kind: "github", repo: 7, target: { type: "issue", number: 1 } }, { kind: "github", repo: "o/r", target: { type: "issue", number: "not-a-number" } }, { kind: "github", repo: "o/r", target: { type: "issue", number: 0 } }, { kind: "gitlab", repo: "o/r", target: { type: "issue", number: 7 } }, { kind: "gitlab", repo: "o/r", projectId: "42", target: { type: "issue", number: 7 } }, { kind: "azure", repo: "o/r", azure: {}, target: { type: "issue", number: 7 } }]) {
		assert.doesNotThrow(() => sessionKeyFor(job), `sessionKeyFor(${JSON.stringify(job)}) must not throw`);
		assert.equal(sessionKeyFor(job), null, `sessionKeyFor(${JSON.stringify(job)}) must be a cold start`);
	}
});

test("the key is a hash, so an attacker-chosen ref never becomes a host path segment", () => {
	const hostile = sessionKeyFor({ kind: "github", repo: "o/r", target: { type: "pull_request" } }, { headRef: "../../../../etc/passwd", headRepo: "o/r" });
	assert.match(hostile, /^[0-9a-f]{32}$/, "validating a ref into a safe path segment is the losing half of the argument; hashing makes traversal unreachable");
	assert.equal(hostile.includes(".."), false);
	// And the listing carries no repo or branch name -- PII-free by construction, as `local:<basename>` is.
	assert.equal(hostile.includes("o/r"), false);
});

test("the branch half comes from branch.mjs, so the key and the envelope cannot drift", () => {
	assert.deepEqual(keyParts(ghIssue), ["github", "o/r", "", issueBranch(7)]);
});

test("every forge the table knows resolves a session key -- none of them cold-starts forever", () => {
	// keyParts enumerated `github || gitlab`. A forge missing from that list did not throw: it fell to the
	// final `return null`, so every job on it resolved no key and cold-started on every run -- which looks
	// exactly like a deployment that simply never armed run.resume. Keyed on isForgeKind now, and looped
	// over the table so a forge added later fails HERE rather than resuming nothing in silence.
	for (const kind of FORGE_KINDS) {
		assert.deepEqual(
			keyParts(forgeIssue(kind)),
			[kind, "o/r", namespaceOf(kind), issueBranch(7)],
			`${kind}: an issue-triggered job must key on the branch its own envelope names`,
		);
	}
});

test("two forges never share a key for the same repo and number", () => {
	const keys = FORGE_KINDS.map((kind) => sessionKeyFor(forgeIssue(kind)));
	assert.equal(new Set(keys).size, keys.length, "the forge is in the key material, so one forge's transcript can never be handed to another's job");
});

test("a kind that is neither a forge nor local resolves no key, which is the safe direction", () => {
	for (const kind of ["chained", "", undefined, null]) {
		assert.equal(keyParts({ kind, repo: "o/r", target: { type: "issue", number: 7 } }), null, `kind ${JSON.stringify(kind)} has no trigger entry that could have armed run.resume`);
	}
});

// --- replica runs: a LOCK, not a feature (REQ-REPLICA-RUNS) ---

test("a replica-carrying job keys IDENTICALLY to an unreplicated one -- and that is only safe because triggers.mjs refuses replicas+resume", () => {
	// This test exists to fail loudly if that refusal is ever relaxed. `keyParts` calls `issueBranch` with
	// ONE argument, so replica 1 and replica 2 of issue #7 resolve the SAME key: one transcript, N writers,
	// fighting the store's one-writer lock. Today that is unreachable -- a replica job can never carry
	// `resume: true`, so no replica ever reads or writes a session at all.
	//
	// If you are here because this assertion broke: you did not break the session key. You removed the
	// refusal in worker/src/triggers.mjs (validateReplicas) that made the key's blindness harmless, and the
	// replica index now has to reach keyParts as well.
	const r1 = { ...ghIssue, replica: 1, replicas: 2 };
	const r2 = { ...ghIssue, replica: 2, replicas: 2 };
	assert.deepEqual(keyParts(r1), ["github", "o/r", "", "pi/issue-7"]);
	assert.equal(sessionKeyFor(r1), sessionKeyFor(r2));
	assert.equal(sessionKeyFor(r1), sessionKeyFor(ghIssue));
	// The branch the two jobs are actually told to push to, by contrast, differs -- which is the whole
	// point, and the exact reason the key above must never be read by one of them.
	assert.notEqual(issueBranch(7, 1), issueBranch(7, 2));
});

test("the replica/session LOCK holds on EVERY forge, not just github (#187)", () => {
	// keyParts gates on isForgeKind, so widening run.replicas past github widened this blindness with it.
	// Same reading as the github lock above: if this breaks, the triggers.mjs refusal went, and the replica
	// index now has to reach keyParts on all four forges rather than one.
	for (const kind of ["gitlab", "forgejo", "azure"]) {
		const base = forgeIssue(kind);
		const r1 = { ...base, replica: 1, replicas: 2 };
		const r2 = { ...base, replica: 2, replicas: 2 };
		assert.deepEqual(keyParts(r1), [kind, "o/r", namespaceOf(kind), "pi/issue-7"], `${kind} keys on the UNSUFFIXED branch`);
		assert.equal(sessionKeyFor(r1), sessionKeyFor(r2), `${kind}: both replicas resolve one key`);
		assert.equal(sessionKeyFor(r1), sessionKeyFor(base), `${kind}: and the same key an unreplicated run resolves`);
	}
});

// --- a run RECORD's key (issue #647): the admin's chain counter and `pi-dispatch chat` share this one rule ---

test("a run record's namespaceId re-derives exactly its job's key, and a GitLab record without one cold-starts", () => {
	for (const kind of FORGE_KINDS) {
		const job = forgeIssue(kind);
		const record = { kind, target: "o/r#7", triggerType: "issues", namespaceId: namespaceOf(kind) };
		assert.equal(sessionKeyOfRecord(record), sessionKeyFor(job), `${kind}: the record names the directory its job wrote`);
	}
	assert.equal(sessionKeyOfRecord({ kind: "gitlab", target: "o/r#7", triggerType: "issues", namespaceId: "43" }), sessionKeyFor({ ...glIssue, projectId: 43 }));
	// No dual-read and no fallback: a GitLab/Azure record whose job carried no usable id has no key at all.
	for (const kind of ["gitlab", "azure"]) {
		assert.equal(sessionKeyOfRecord({ kind, target: "o/r#7", triggerType: "issues" }), null, `${kind}: missing namespaceId is a cold start`);
		assert.equal(sessionKeyOfRecord({ kind, target: "o/r#7", triggerType: "issues", namespaceId: "" }), null, `${kind}: an empty namespace is not an identity`);
		assert.equal(sessionKeyOfRecord({ kind, target: "o/r#7", triggerType: "issues", namespaceId: null }), null, `${kind}: a null namespace is not an identity`);
	}
	// GitHub/Forgejo have no repository id yet, so empty is their valid namespace.
	for (const kind of ["github", "forgejo"]) {
		assert.equal(sessionKeyOfRecord({ kind, target: "o/r#7", triggerType: "issues", namespaceId: "" }), sessionKeyFor({ kind, repo: "o/r", target: { type: "issue", number: 7 } }));
		assert.equal(sessionKeyOfRecord({ kind, target: "o/r#7", triggerType: "issues" }), sessionKeyFor({ kind, repo: "o/r", target: { type: "issue", number: 7 } }));
	}
});

test("a record's key is the key its job resolved: a forge issue from its target, a cron run from its scheduler id", () => {
	for (const kind of FORGE_KINDS) {
		const key = sessionKeyOfRecord({ kind, target: "o/r#7", triggerType: "issues", namespaceId: namespaceOf(kind) });
		assert.match(key, SESSION_KEY_PATTERN, `${kind}: a 32-hex key`);
		assert.equal(key, sessionKeyFor(forgeIssue(kind)), `${kind}: the job's own key, so a record names the directory its job wrote`);
	}
	const cron = sessionKeyFor({ kind: "local", trigger: { id: "nightly.docs" } });
	assert.equal(sessionKeyOfRecord({ kind: "local", jobId: "repeat:nightly.docs:1760000000000" }), cron);
	assert.equal(sessionKeyOfRecord({ kind: "local", jobId: "manual:nightly.docs:3" }), cron, "a manual fire of a schedule shares the schedule's session");
	// Every release before issue #761 took a cron id of any length, so a record's id is read at any length.
	const long = "n".repeat(500);
	const longKey = sessionKeyFor({ kind: "local", trigger: { id: long } });
	assert.equal(sessionKeyOfRecord({ kind: "local", jobId: `repeat:${long}:1760000000000` }), longKey);
	assert.equal(sessionKeyOfRecord({ kind: "local", jobId: `manual:${long}:1759999980000` }), longKey);
});

test("a record that cannot name its key resolves none: a pull or merge request, a CLI run, a malformed target", () => {
	// A request's key needs its head ref, which the record deliberately does not carry; a `#` pull request on GitHub or
	// Forgejo is told apart only by its trigger type.
	assert.equal(sessionKeyOfRecord({ kind: "github", target: "o/r#8", triggerType: "pull_request" }), null);
	assert.equal(sessionKeyOfRecord({ kind: "forgejo", target: "o/r#8", triggerType: "pull_request" }), null);
	assert.equal(sessionKeyOfRecord({ kind: "gitlab", target: "g/p!8", triggerType: "merge_request" }), null);
	assert.equal(sessionKeyOfRecord({ kind: "azure", target: "p/r!8" }), null);
	for (const record of [
		null,
		undefined,
		{},
		{ kind: "local", jobId: "cli-1" },
		{ kind: "local", jobId: "repeat:x" },
		{ kind: "local" },
		{ kind: "chained", target: "o/r#7" },
		{ kind: "github" },
		{ kind: "github", target: 7 },
		{ kind: "github", target: "o/r#" },
		{ kind: "github", target: "o/r#x" },
		{ kind: "github", target: "o/r#0" },
	]) {
		assert.equal(sessionKeyOfRecord(record), null, `${JSON.stringify(record)} names no key`);
	}
});
