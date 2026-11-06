import assert from "node:assert/strict";
import { test } from "node:test";
import { QUEUED_STATES, parkedVerdictOf, pendingFactsOf } from "../src/parked-facts.mjs";

// The cases here cover the three exports the console keeps (parked-facts.mjs).

// CHAT_REFUSALS is private in the leaf, so the one refusal sentence these cases need is pinned here instead of
// imported; if the source sentence changes, this copy must change with it.
const parkedTooMany = "This run asked a question, but the queue holds too many jobs to check whether an answer is already on its way; answer it on the forge, or wait until the queue is shorter.";

test("QUEUED_STATES are BullMQ's not-started words, frozen so every reader judges queued by this one list", () => {
	// The leaf pins the list itself, the same shape cancel-state.test.mjs pins its own QUEUED_STATES list by.
	assert.deepEqual(QUEUED_STATES, ["waiting", "delayed", "prioritized", "waiting-children", "paused"]);
	assert.ok(Object.isFrozen(QUEUED_STATES));
});

test("pendingFactsOf maps every scan shape the console's readPendingAnswer can produce (review round 2)", () => {
	assert.deepEqual(pendingFactsOf({ jobId: "gh-9" }), { pending: true, pendingTooMany: false, pendingJobId: "gh-9" });
	assert.deepEqual(pendingFactsOf({ jobId: null }), { pending: false, pendingTooMany: false, pendingJobId: null });
	assert.deepEqual(pendingFactsOf({ unknown: true, tooMany: true }), { pending: null, pendingTooMany: true, pendingJobId: null });
	for (const scan of [{ unknown: true }, { unknown: true, tooMany: false }, { unreachable: true }, { tooMany: true }, { jobId: "bad id\n" }, {}, null, undefined]) {
		assert.deepEqual(pendingFactsOf(scan), { pending: null, pendingTooMany: false, pendingJobId: null }, JSON.stringify(scan));
	}
});

test("parkedVerdictOf: no pending answer is a reply, and a queue too deep to check fails loudly with its own sentence", () => {
	assert.deepEqual(parkedVerdictOf({ jobId: null }), { mode: "reply", says: null, answeringJobId: null });
	assert.deepEqual(parkedVerdictOf({ unknown: true, tooMany: true }), { mode: null, says: parkedTooMany, answeringJobId: null });
	assert.match(parkedTooMany, /too many jobs to check whether an answer is already on its way; answer it on the forge/);
	assert.doesNotMatch(parkedTooMany, /try again|history/, "never the unreadable history's sentence");
});
