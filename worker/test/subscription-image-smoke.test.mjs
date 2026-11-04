import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { subscriptionSmokeProblems } from "../../.github/scripts/subscription-auth-image.mjs";

const key = "ab".repeat(32);
const tokenExit = { event: "exit", code: 2, reason: "token_budget", tokens: { calls: 1, metered: true, modelRefused: 0 } };
const providerExit = { event: "exit", code: 1, reason: "error", tokens: { calls: 2, metered: true, modelRefused: 0 }, toolsStarted: false, replaySafe: true, providerFailure: { kind: "quota-exhausted", subscriptionProvider: "openai", subscriptionCode: "usage_limit_reached" } };
const signed = exit => {
	const body = JSON.stringify(exit);
	return `${body.slice(0, -1)},"auth":"${createHmac("sha256", key).update(body).digest("hex")}"}`;
};
const request = calls => ({ event: "subscription_smoke_fetch", calls, provider: "openai", authOk: true, urlOk: true, modelOk: true });
const retry = { event: "pi_auto_retry", attempt: 1, maxAttempts: 1 };
const check = (exit, { mode = "token", rows = [], status = exit.code, signatureKey = key } = {}) => subscriptionSmokeProblems({ output: [...rows.map(row => JSON.stringify(row)), signed(exit)].join("\n"), status, key: signatureKey, provider: "openai", mode });

test("image conformance accepts a signed settle-time token-cap stop, and rejects config, model and wire failures instead of treating any exit 2 as proof", () => {
	assert.deepEqual(check(tokenExit, { mode: "token", rows: [request(1)] }), []);
	for (const exit of [
		{ event: "exit", code: 2, reason: "config", message: "adapter unavailable" },
		{ ...tokenExit, reason: "model-not-allowed" },
		{ ...tokenExit, tokens: { calls: 2, metered: true, modelRefused: 0 } },
		{ ...tokenExit, tokens: { calls: 1, metered: false, modelRefused: 0 } },
	]) assert.ok(check(exit, { mode: "token" }).length > 0);
	assert.ok(check(tokenExit, { mode: "token", status: 0 }).length > 0);
	assert.ok(check(tokenExit, { mode: "token" }).length > 0, "no dispatch row: the cap was never reached through the wire");
	assert.ok(check(tokenExit, { mode: "token", signatureKey: "cd".repeat(32) }).length > 0, "plausible log text cannot replace authenticated evidence");
	assert.deepEqual(subscriptionSmokeProblems({ output: `${signed(tokenExit)}\n${signed(tokenExit)}`, status: 2, key, provider: "openai", mode: "token" }), ["expected one decisive exit line"]);
});

test("image conformance requires exact bounded retry, auth, endpoint, model and meter evidence for synthetic provider calls", () => {
	const rows = [request(1), retry, request(2)];
	assert.deepEqual(check(providerExit, { mode: "provider", rows }), []);
	for (const patch of [{ authOk: false }, { urlOk: false }, { modelOk: false }, { calls: 3 }, { provider: "anthropic" }]) {
		assert.ok(check(providerExit, { mode: "provider", rows: [request(1), retry, { ...request(2), ...patch }] }).length > 0);
	}
	for (const altered of [rows.slice(0, 2), [...rows, request(3)], [request(1), request(2)], [request(1), { ...retry, maxAttempts: 2 }, request(2)]]) assert.ok(check(providerExit, { mode: "provider", rows: altered }).length > 0);
	for (const patch of [
		{ providerFailure: { kind: "quota-exhausted" } },
		{ providerFailure: { kind: "quota-exhausted", subscriptionProvider: "anthropic", subscriptionCode: "usage_limit_reached" } },
		{ ...providerExit, tokens: { ...providerExit.tokens, calls: 1 } },
		{ ...providerExit, tokens: { ...providerExit.tokens, metered: false } },
		{ toolsStarted: true }, { replaySafe: false },
	]) assert.ok(check({ ...providerExit, ...patch }, { mode: "provider", rows }).length > 0);
});
