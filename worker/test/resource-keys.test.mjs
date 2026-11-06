import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { RESOURCE_KEYS } from "../src/run-history.mjs";

// The `resources` block's keys (issue #596) are written out by hand in three places besides `RESOURCE_KEYS` (which
// run-history.test.mjs holds to the runner's own list): the exit line in `INT-RUNNER-EXIT-CODE-PROTOCOL`, the record
// shape in `INT-RUN-HISTORY-FILE-CONTRACT`, and the operator table in `docs/insights.md`. Each is DERIVED here from
// the code and required in the code's order, the session-reasons.test.mjs shape. What it reads, and nothing more: the
// `` `resources: { a, b }` `` span, the `"resources": { "a": <int> | null, ... } | null` block, and every `` `token` ``
// in the first cell of the table under a named heading. It cannot see a key named only in prose.
const DOC = fileURLToPath(new URL("../../docs/insights.md", import.meta.url));

test("docs/insights.md's resources table names exactly RESOURCE_KEYS, in order", () => {
	const doc = readFileSync(DOC, "utf8");
	const heading = "## What each run records about resources";
	const from = doc.indexOf(heading);
	assert.notEqual(from, -1, `the doc must still carry the heading ${JSON.stringify(heading)}`);
	const keys = [];
	let inTable = false;
	for (const line of doc.slice(from).split("\n").slice(1)) {
		if (line.startsWith("| `")) {
			inTable = true;
			const cell = line.slice(1, line.indexOf("|", 1));
			for (const m of cell.matchAll(/`([a-zA-Z]+)`/g)) keys.push(m[1]);
		} else if (inTable && !line.startsWith("|")) break;
	}
	assert.deepEqual(keys, [...RESOURCE_KEYS]);
});
