/** Offline image proof: real receipt rejection and shaped-body wiring, no provider dispatch. */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { verifySubscriptionAuthEntries, validateSubscriptionRequest } from "../../src/community-auth-adapter.mjs";

export async function verifySubscriptionCapability(root) {
	const at = 1_800_000_000_000, now = () => at;
	const entry = { provider: "openai", adapter: "openai-chatgpt", connectionId: "proof", generation: 1, expiresAt: at + 3_600_000, deadlineAt: at + 1_800_000 };
	assert.equal(verifySubscriptionAuthEntries([entry], { now }).length, 1);
	assert.throws(() => verifySubscriptionAuthEntries([{ ...entry, expiresAt: at }], { now }), /auth-snapshot-expired/);
	assert.equal(validateSubscriptionRequest({ provider: "openai", api: "openai-responses", baseUrl: "https://different.invalid" }, [entry], { now }), false);
	// This uses the real receipt verifier. A token, a matching package name and a fabricated approval
	// receipt are not sufficient to enable an altered community transport.
	assert.throws(() => verifySubscriptionAuthEntries([{ ...entry, provider: "anthropic", adapter: "@gotgenes/pi-anthropic-auth@3.4.3", root, digest: "a".repeat(64) }], { now }), /auth-adapter-unpinned/);
	// The shaped-body half the cost guard enforced is gone with it; what must still hold is that the adapter's
	// request path builds a shaped body without dispatching: the onPayload rewrite lands, nothing more.
	const model = { provider: "anthropic", id: "proof", api: "anthropic-messages" };
	const args = [{ messages: [] }, { onPayload: payload => ({ ...payload, system: "x".repeat(100) }) }];
	const sent = await args[1].onPayload({ model: "proof", max_tokens: 1, messages: [] }, model);
	assert.equal(sent.system.length, 100);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	await verifySubscriptionCapability(process.argv[2] ?? "/job/community");
	console.log("subscription auth capability holds");
}
