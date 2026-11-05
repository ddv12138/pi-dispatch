import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("the Java image defaults to the locally built base at this release's exact tag", () => {
	const version = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")).version;
	const dockerfile = readFileSync(new URL("../../Dockerfile.java21", import.meta.url), "utf8");
	assert.match(dockerfile, new RegExp(`^ARG BASE=pi-job:${version.replaceAll(".", "\\.")}$`, "m"));
	assert.match(dockerfile, /RUN test "\$PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT"/);
	assert.match(dockerfile, /grep -q installDefaultModelsPath \/app\/image\/runner\/run-job\.mjs/);
	assert.match(dockerfile, /grep -q installDefaultModelsPath \/app\/image\/runner\/src\/child-preload\.mjs/);
});

test("the standard image names its installed pi package for staged subagents", () => {
	const dockerfile = readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");
	assert.match(dockerfile, /^ENV PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT=\/app\/node_modules\/@earendil-works\/pi-coding-agent$/m);
});
