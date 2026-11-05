import assert from "node:assert/strict";
import { test } from "node:test";
import * as names from "../src/container-names.mjs";
import * as local from "../src/backend-local.mjs";

// Operator guidance must name precisely what the runtime created, without loading its implementations in production.
test("the local adapter re-exports the shared naming functions rather than carrying parallel copies (#748)", () => {
	assert.equal(local.jobContainerName, names.jobContainerName);
	assert.equal(local.JOB_NAME_PREFIX, names.JOB_NAME_PREFIX);
});

test("queue ids are sanitized before deriving their bounded container name (#748)", () => {
	assert.equal(names.jobContainerName("repeat:nightly:1790361600000"), "pi-job-repeat_nightly_1790361600000");
	assert.equal(names.jobContainerName("manual:nightly:1790361600000"), "pi-job-manual_nightly_1790361600000");
	for (const id of ["gh-job", "repeat:nightly:1790361600000", "manual:nightly:1790361600000", "hostile/quote'\\\n", "x".repeat(1024)]) {
		const container = names.jobContainerName(id);
		assert.match(container, /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
	}
});
