import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/**
 * The REAL baked persona files (issue #505). `loader.test.mjs` composes fixtures for most of its cases, so nothing there
 * would notice a protocol file that lost its sentinel, a Dockerfile that stopped copying it, or an image check that
 * stopped looking. These read the files the image is built from. No pi needed, so they run everywhere.
 */
const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

const PERSONAS = [
	{ file: "OUTBOX_PROTOCOL.md", marker: "OUTBOX-SENTINEL", sentinel: "pi-dispatch-outbox-v1" },
];

for (const { file, marker, sentinel } of PERSONAS) {
	test(`guardrails/${file} carries its sentinel and is copied into the image where the loader reads it`, () => {
		const text = read(`../../../guardrails/${file}`);
		assert.ok(text.includes(`<!-- ${marker}: ${sentinel} -->`), `${file} lost its sentinel`);
		const dockerfile = read("../../Dockerfile");
		assert.ok(dockerfile.includes(`COPY guardrails/${file} /opt/pi-dispatch/${file}`), `the Dockerfile does not copy ${file}`);
	});
}

test("the loader reads the outbox protocol from the path the Dockerfile copies it to", () => {
	const loader = read("../src/loader.mjs");
	assert.match(loader, /export const OUTBOX_PROTOCOL_PATH = "\/opt\/pi-dispatch\/OUTBOX_PROTOCOL\.md";/);
	assert.match(loader, /\[guardrails, outboxProtocol, globalPersona, projectPersona\]/, "the order is the contract");
});
