import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BACKEND_NAMES, BACKENDS, DEFAULT_BACKEND, SERVES, SERVES_WORDS, servesOf } from "../src/backends.mjs";
import { makeLocalBackend } from "../src/backend-local.mjs";
import { recoverVenueProblem } from "../src/triggers.mjs";

/**
 * Issue #712: each venue's `serves` block is a hand-written table that RESTATES derivable sources, so it is held to them
 * here (AGENTS.md, "derived or pinned, never trusted"): the bundle's `binds`, and the copy mode's pre-spend recovery
 * refusal. The console and the panel word these facts from the table, so a venue whose bundle changed and whose table did
 * not would put a wrong sentence on both.
 *
 * The sandbox prune removed the podman and openshell venues and their bundles; `local` is the only entry, and the halves
 * of this file that read a venue bundle's `transcript`/`observationPreflight` went with them. What stays pins the closed
 * vocabulary and the one live bundle against its row.
 */

const localParts = () => ({ runContainer: async () => ({}), imagePreflight: async () => ({}), egressPreflight: async () => ({}), stopContainer: async () => {}, reap: async () => ({ reaped: true }) });

test("every venue declares every serves entry, in the closed words, and the block is frozen (#712)", () => {
	for (const name of BACKEND_NAMES) {
		assert.deepEqual(Object.keys(BACKENDS[name].serves).sort(), [...SERVES].sort(), name);
		for (const key of SERVES) assert.ok(SERVES_WORDS.includes(BACKENDS[name].serves[key]), `${name}.${key}`);
		assert.equal(Object.isFrozen(BACKENDS[name].serves), true, name);
		assert.equal(servesOf(name), BACKENDS[name].serves, name);
	}
	assert.equal(servesOf("toString"), null);
	assert.equal(servesOf(undefined), null);
});

test("serves.liveTranscript and serves.steering follow the local bundle's binds (#712)", () => {
	const bundle = makeLocalBackend(localParts());
	assert.equal(bundle.binds, true, "the local adapter binds the /inbox mount");
	// local's runContainer is passed in, so there is no `made` options object: a host file the tail reads, hence "yes".
	assert.equal(BACKENDS.local.serves.liveTranscript, "yes", "local.liveTranscript");
	assert.equal(BACKENDS.local.serves.steering, "yes", "local.steering");
	assert.equal(DEFAULT_BACKEND, "local", "the only venue the table holds");
});

test("serves.recovery follows the venue's preflight refusing a job FOR arming run.recover (#712)", async () => {
	const bundle = makeLocalBackend(localParts());
	// A venue with no per-job preflight has nothing that could refuse recovery there.
	// A venue with no per-job preflight has nothing that could refuse recovery there: local is such a venue, so its
	// word is "yes" and the loader refuses no pairing for it.
	assert.equal(typeof bundle.observationPreflight, "undefined", "local's bundle has no per-job preflight");
	assert.equal(BACKENDS.local.serves.recovery, "yes", "local.recovery");
	assert.equal(recoverVenueProblem("local"), null, "the loader refuses no local recovery pairing");
});

test("docs/backends.md's serves table holds every venue the table has, row for row (#712)", () => {
	const doc = readFileSync(new URL("../../docs/backends.md", import.meta.url), "utf8");
	const at = doc.indexOf("| Venue | Live transcript | Steering | Recovery | Sandbox shell |");
	assert.ok(at !== -1, "the table is there");
	const rows = doc
		.slice(at)
		.split("\n")
		.slice(2)
		.filter((l, i, all) => l.startsWith("|") && all.slice(0, i).every((p) => p.startsWith("|")))
		.map((l) => l.split("|").slice(1, -1).map((c) => c.trim().replace(/`/g, "")));
	// docs/ still carries the sandbox venues' rows and the Sandbox shell column until its own rewrite lands; what this
	// pins one way is that every venue the code holds is IN the doc with its words. Extra doc rows pass here and are a
	// finding for that rewrite, not for the table.
	for (const name of BACKEND_NAMES) {
		const row = rows.find((r) => r[0] === name);
		assert.ok(row, `${name} has a row`);
		assert.deepEqual(row.slice(1, 1 + SERVES.length), SERVES.map((key) => BACKENDS[name].serves[key]), `${name} row words`);
	}
});
