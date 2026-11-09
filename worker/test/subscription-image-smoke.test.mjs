import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { subscriptionSmokeProblems } from "../../.github/scripts/subscription-auth-image.mjs";

const key = "ab".repeat(32);
const providerExit = { event: "exit", code: 1, reason: "error", tokens: { calls: 2, metered: true, modelRefused: 0 }, toolsStarted: false, replaySafe: true, providerFailure: { kind: "quota-exhausted", subscriptionProvider: "openai", subscriptionCode: "usage_limit_reached" } };
const signed = exit => {
	const body = JSON.stringify(exit);
	return `${body.slice(0, -1)},"auth":"${createHmac("sha256", key).update(body).digest("hex")}"}`;
};
const request = calls => ({ event: "subscription_smoke_fetch", calls, provider: "openai", authOk: true, urlOk: true, modelOk: true });
const retry = { event: "pi_auto_retry", attempt: 1, maxAttempts: 1 };
const check = (exit, { mode = "provider", rows = [], status = exit.code, signatureKey = key } = {}) => subscriptionSmokeProblems({ output: [...rows.map(row => JSON.stringify(row)), signed(exit)].join("\n"), status, key: signatureKey, provider: "openai", mode });


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
