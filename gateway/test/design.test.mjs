import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { GATEWAY_CSS, GATEWAY_PAGE_CSS, GATEWAY_PAGE_CSS_SHA256, WORKBENCH_CSS, WORKBENCH_CSS_SHA256 } from "../src/style.mjs";
import { GATEWAY_CONSOLE_CSS, GATEWAY_CONSOLE_CSS_SHA256 } from "../../admin/src/console/gateway-css.mjs";
import { PAGE_CSS, pageCss } from "../../admin/src/console/page-css.mjs";
import { gatewayLanding } from "../../admin/src/console/gateway.mjs";
import { gatewayPage } from "../src/page.mjs";
import { GATEWAY_LIMITS } from "../src/terminal-protocol.mjs";
import { PAGES } from "../../admin/src/console/pages.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const root = new URL("../../", import.meta.url);
const source = (path) => readFileSync(new URL(path, root), "utf8");
const CARDS = ["SandboxTerminal", "SandboxGatewaySignIn", "SandboxGatewayStates", "SandboxWorkbench", "SandboxTerminalRun", "SandboxWatch"];
const ISSUES = { SandboxTerminalRun: 793, SandboxWatch: 792 };





test("generic arrival markup has only its expected own-origin resources and an enrolled console return", () => {
	const text = gatewayPage({ consoleOrigin: "https://console.example.test" });
	const refs = [...text.matchAll(/(?:href|src)="([^"]+)"/g)].map((match) => match[1]);
	assert.deepEqual(refs, ["/static/gateway.css", "/static/gateway.js", "#main", "https://console.example.test/sandbox/gateway/return", "https://console.example.test/sandbox/gateway/return"]);
	assert.equal((text.match(/id="(?:gateway-return|wb-return)"/g) ?? []).length, 2);
	assert.equal((text.match(/href="https:\/\/console\.example\.test\/sandbox\/gateway\/return"/g) ?? []).length, 2);
	assert.doesNotMatch(text, /data-session-key|connectionId|PRIVATE|data-sandbox-id/);
	assert.doesNotMatch(text, /terminal\.js|<iframe|<form|type="password"|sessionStorage|handoff|connectionId/);
});







