import { test } from "node:test";
import assert from "node:assert/strict";
import { findLiteralSecret } from "../src/secret-scan.mjs";

// The guard `doctor` uses on a models.json: a literal credential in a provider entry would land in the
// global overlay and then in every job container, so it is named by location and never printed.

test("findLiteralSecret reports a literal providers.<name>.apiKey", () => {
	assert.equal(findLiteralSecret({ providers: { custom: { name: "Custom", apiKey: "sk-live-literal" } } }), "providers.custom.apiKey");
});

test("findLiteralSecret reports a literal auth-ish header", () => {
	assert.equal(findLiteralSecret({ providers: { p: { headers: { Authorization: "Bearer sk-x" } } } }), "providers.p.headers.Authorization");
	assert.equal(findLiteralSecret({ providers: { p: { headers: { "X-Api-Key": "sk-x" } } } }), "providers.p.headers.X-Api-Key");
	assert.equal(findLiteralSecret({ providers: { p: { headers: { "Content-Type": "application/json" } } } }), null, "a non-secret header is fine");
});

test("findLiteralSecret passes a $VAR or !cmd indirection", () => {
	assert.equal(findLiteralSecret({ providers: { p: { apiKey: "$MY_KEY" } } }), null, "$ENV reference is not a literal");
	assert.equal(findLiteralSecret({ providers: { p: { apiKey: "!op read x" } } }), null, "!command is not a literal");
	assert.equal(findLiteralSecret({ providers: { p: { headers: { Authorization: "$AUTH" } } } }), null, "an auth header may be an $ENV reference");
	assert.equal(findLiteralSecret({ providers: { p: { headers: { Authorization: "!gh auth token" } } } }), null, "an auth header may be a !command");
});

test("findLiteralSecret is null for a clean, empty or absent provider map", () => {
	assert.equal(findLiteralSecret({ providers: {} }), null);
	assert.equal(findLiteralSecret({ providers: { p: { name: "Custom", headers: { "Content-Type": "application/json" } } } }), null);
	assert.equal(findLiteralSecret({}), null, "no providers at all");
	assert.equal(findLiteralSecret({ providers: null }), null);
	assert.equal(findLiteralSecret(null), null);
});
