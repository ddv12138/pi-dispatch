import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { encodeFrame, frameMac, keyFrame, STEER_FILE_MAX_BYTES, STEER_FRAME_DOMAIN, STEER_FRAME_MAX_BYTES, STEER_STDIN_BUDGET_BYTES, steerFileJson, steerFrame } from "../src/steer-framing.mjs";

// Issue #686: the stdin frame channel's worker half. The runner's decoder (image/runner/src/steer-frames.mjs), which
// this file once held to the encoder byte for byte, went with the venues that copied their files; the encoder stays
// because the inbox relay still writes frames down a stdin-steered attempt's pipe, so its constants and MAC are
// asserted on their own.

const KEY = "ab".repeat(32);
const RUN = "pi-job-s1";
const entry = (over = {}) => ({ id: "0123456789abcdef0123456789abcdef", mode: "steer", source: "cli", author: { kind: "operator", by: "cli" }, text: "look at the tests first", ...over });
const bodyOf = (over) => steerFileJson({ entry: entry(over) });

test("the constants on their own: the domain, the budget (the measured 4 MiB less 1 KiB) and the frame cap", () => {
	assert.equal(STEER_FRAME_DOMAIN, "pi-dispatch-inbox-frame");
	assert.equal(STEER_STDIN_BUDGET_BYTES, 4_194_304 - 1024, "under the measured limit, at the largest total the #686 lab saw pass");
	assert.ok(STEER_STDIN_BUDGET_BYTES < 4 * 1024 * 1024, "never at or above the 4 MiB the forwarding layer refuses past");
	assert.equal(STEER_FRAME_MAX_BYTES, STEER_FILE_MAX_BYTES + 256);
});

test("the frame: a 4-byte big-endian length, then that many bytes of UTF-8 JSON; frame 1 is the key", () => {
	const f = encodeFrame('{"a":"é"}');
	assert.equal(f.readUInt32BE(0), Buffer.byteLength('{"a":"é"}'));
	assert.equal(f.subarray(4).toString("utf8"), '{"a":"é"}');
	const k = keyFrame(KEY);
	assert.equal(k.subarray(4).toString(), `{"t":"key","key":"${KEY}"}`);
	assert.equal(k.length, 4 + 84);
	assert.equal(JSON.parse(k.subarray(4).toString()).key, KEY);
});

test("the MAC is HMAC-SHA256 under the exit key of the domain, the run id, the decimal seq and the body", () => {
	const body = bodyOf();
	const want = createHmac("sha256", KEY).update(`pi-dispatch-inbox-frame\0${RUN}\0${7}\0${body}`, "utf8").digest("hex");
	assert.equal(frameMac(KEY, RUN, 7, body), want);
	// Domain-separated from the ack and from a different seq or run.
	assert.notEqual(want, createHmac("sha256", KEY).update(`pi-dispatch-inbox-ack\0${RUN}\0${entry().id}`).digest("hex"));
	assert.notEqual(want, frameMac(KEY, RUN, 8, body));
	assert.notEqual(want, frameMac(KEY, "pi-job-s2", 7, body));
});

test("a steer frame's payload is the contract's envelope over steerFileJson's exact body", () => {
	const body = bodyOf({ text: 'quotes " and \\ and   and é and ``` fences' });
	const f = steerFrame({ exitKey: KEY, runId: RUN, seq: 2, body });
	const payload = JSON.parse(f.subarray(4).toString());
	assert.equal(f.readUInt32BE(0), f.subarray(4).length, "the length prefix counts the payload's bytes");
	assert.deepEqual(
		((v, id, mode, source, content) => JSON.stringify({ v, id, mode, source, content }))(payload.v, payload.id, payload.mode, payload.source, payload.content),
		body,
		"the body is the five fields, parsed back and re-spelled byte for byte",
	);
	assert.equal(Buffer.from(payload.mac, "hex").length, 32, "the mac is 32 bytes of hex");
	assert.equal(payload.mac, frameMac(KEY, RUN, 2, body), "the mac covers the body, under this frame's seq");
	assert.deepEqual(Object.keys(payload), ["t", "seq", "v", "id", "mode", "source", "content", "mac"], "the contract's key order");
});

test("steerFrame refuses what it cannot frame: a seq below 2, a body steerFileJson would not write, no key or run id", () => {
	const body = bodyOf();
	assert.equal(steerFrame({ exitKey: KEY, runId: RUN, seq: 1, body }), null, "1 is the key frame's");
	assert.equal(steerFrame({ exitKey: KEY, runId: RUN, seq: 2, body: '{"v":1, "id":"x"}' }), null, "not steerFileJson's bytes");
	assert.equal(steerFrame({ exitKey: "", runId: RUN, seq: 2, body }), null);
	assert.equal(steerFrame({ exitKey: KEY, runId: "", seq: 2, body }), null);
	assert.equal(steerFrame({ exitKey: KEY, runId: RUN, seq: 2, body: "nope" }), null);
});
