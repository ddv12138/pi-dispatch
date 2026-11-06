import assert from "node:assert/strict";
import { test } from "node:test";
import { buildContainerEnv } from "../src/env-allowlist.mjs";
import { NON_SECRET_ENV_KEYS, secretValuesOf } from "../src/redact-secrets.mjs";

const metadata = { requestId: "a".repeat(64), action: "deploy:staging", toolCallId: "call_1|fc_2", decision: "declined" };
const PRIVATE = "private person's explanation\nwith details";
const options = { provider: "anthropic", model: "m", maxTurns: 5, jobId: "job-649", hostEnv: { ANTHROPIC_API_KEY: "fake-provider-credential" }, approvalGates: ["deploy:staging"], approvalDecision: { ...metadata, text: PRIVATE, summary: "private summary" } };

test("approval container env carries identifiers only, leaving human text to the existing event file", () => {
	const env = buildContainerEnv(options);
	assert.equal(env.PI_APPROVAL_GATES, '["deploy:staging"]');
	assert.deepEqual(JSON.parse(env.PI_APPROVAL_DECISION), metadata);
	assert.equal(JSON.stringify(env).includes("private"), false);
	assert.equal(NON_SECRET_ENV_KEYS.has("PI_APPROVAL_GATES"), true);
	assert.equal(NON_SECRET_ENV_KEYS.has("PI_APPROVAL_DECISION"), true);
	assert.equal(secretValuesOf(env).includes(env.PI_APPROVAL_GATES), false);
	assert.equal(secretValuesOf(env).includes(env.PI_APPROVAL_DECISION), false);
});

// The OpenShell exec-argv transports (the copy and bind layouts) went with the sandbox prune; the docker transport's
// env is pinned by the test above: identifiers only, no human text.
