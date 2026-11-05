import { withOperatorDiagnosis } from "./helpers/tool-diagnosis.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers/temp-dir.mjs";

// Issue #501, PR #542's review round 2: with a deployment POINTER and an empty `.env`, a budget change that leaves a
// window with no maxTokens in the overlay or that `.env` is WARNED and written, never refused, because the worker's
// cap may come from its service unit or --env-setup script, which the admin cannot see. The pointer is applied once
// per process, at the extension's factory, so this layout lives in its own file and is set before the first load.
const home = tempDir("admin-dollar-pointer-");
const deploymentDir = join(home, "deploy");
const { mkdirSync } = await import("node:fs");
mkdirSync(deploymentDir, { recursive: true });
writeFileSync(join(deploymentDir, ".env"), "");
const pointerFile = join(home, "pointer.json");
writeFileSync(pointerFile, JSON.stringify({ version: 1, deploymentDir, env: {} }));
process.env.PI_DISPATCH_DEPLOYMENT_FILE = pointerFile;
process.env.PI_CODING_AGENT_DIR = tempDir("admin-dollar-pointer-agent-");
process.env.PI_LOGS_DIR = tempDir("admin-dollar-pointer-logs-");
delete process.env.PI_MAX_TOKENS;
delete process.env.PI_DAILY_TOKEN_CAP;
const settingsFile = join(tempDir("admin-dollar-pointer-settings-"), "settings.json");
process.env.PI_SETTINGS_FILE = settingsFile;

const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = piRequire("jiti");
const jiti = createJiti(import.meta.url);
const indexMod = await jiti.import(fileURLToPath(new URL("../src/index.ts", import.meta.url)));

function load() {
  const tools = [];
  const commands = [];
  const pi = new Proxy({}, { get: (_t, k) => (k === "registerTool" ? (t) => tools.push(t) : k === "registerCommand" ? (n, d) => commands.push(d) : () => {}) });
  indexMod.default(pi);
  return { tool: (name) => withOperatorDiagnosis(tools.find((t) => t.name === name)), command: commands[0] };
}
const read = () => JSON.parse(readFileSync(settingsFile, "utf8"));
function consoleCtx() {
  const notes = [];
  return { ctx: { hasUI: true, ui: { notify: (m, t) => notes.push([m, t]), custom: async () => undefined } }, notes };
}
function toolCtx(answer) {
  const shown = [];
  return { ctx: { hasUI: true, ui: { confirm: async (title, message) => (shown.push({ title, message }), answer) } }, shown };
}

test("pointer + empty .env: dispatch_set dailyTokenCap with no cap anywhere is WARNED in the confirm and written only once approved", async () => {
  writeFileSync(settingsFile, "{}");
  const { tool } = load();
  const no = toolCtx(false);
  const outNo = JSON.parse((await tool("dispatch_set").execute("id", { key: "dailyTokenCap", value: "2000000" }, undefined, undefined, no.ctx)).content[0].text);
  assert.match(no.shown[0].message, /\n\nWarning: dailyTokenCap needs maxTokens/);
  assert.match(no.shown[0].message, /the settings overlay nor the deployment's \.env/, "names what it could see");
  assert.match(no.shown[0].message, /service unit or its --env-setup script, is not visible here/);
  assert.equal(outNo.applied, false);
  assert.deepEqual(read(), {}, "declined: nothing written");
  const yes = toolCtx(true);
  const outYes = JSON.parse((await tool("dispatch_set").execute("id", { key: "dailyTokenCap", value: "2000000" }, undefined, undefined, yes.ctx)).content[0].text);
  assert.equal(outYes.applied, true, "never refused on the merged invariant, pointer or not");
  assert.deepEqual(read(), { dailyTokenCap: 2000000 });
});

test("pointer + empty .env: dispatch_set unset maxTokens while a window stands is warned and, approved, written", async () => {
  writeFileSync(settingsFile, JSON.stringify({ maxTokens: 500000, dailyTokenCap: 2000000 }));
  const { tool } = load();
  const yes = toolCtx(true);
  const out = JSON.parse((await tool("dispatch_set").execute("id", { key: "maxTokens" }, undefined, undefined, yes.ctx)).content[0].text);
  assert.match(yes.shown[0].message, /\n\nWarning: dailyTokenCap needs maxTokens/);
  assert.equal(out.applied, true);
  assert.deepEqual(read(), { dailyTokenCap: 2000000 });
});

test("pointer + empty .env: console set dailyTokenCap and unset maxTokens write and warn, naming the deployment's .env", async () => {
  writeFileSync(settingsFile, "{}");
  const { command } = load();
  const set = consoleCtx();
  await command.handler("set dailyTokenCap 2000000", set.ctx);
  const setNote = set.notes.find(([m]) => /^set dailyTokenCap = 2000000/.test(m));
  assert.ok(setNote, JSON.stringify(set.notes));
  assert.equal(setNote[1], "warning");
  assert.match(setNote[0], /warning: dailyTokenCap needs maxTokens.*the deployment's \.env/);
  assert.deepEqual(read(), { dailyTokenCap: 2000000 });
  await command.handler("set maxTokens 500000", consoleCtx().ctx);
  const unset = consoleCtx();
  await command.handler("unset maxTokens", unset.ctx);
  const unsetNote = unset.notes.find(([m]) => /^unset maxTokens/.test(m));
  assert.equal(unsetNote[1], "warning");
  assert.match(unsetNote[0], /warning: dailyTokenCap needs maxTokens/);
  assert.deepEqual(read(), { dailyTokenCap: 2000000 });
});

test("pointer: a cap in the deployment's .env satisfies the merged check, so no warning", async () => {
  writeFileSync(join(deploymentDir, ".env"), "PI_MAX_TOKENS=500000\n");
  try {
    writeFileSync(settingsFile, "{}");
    const { tool } = load();
    const probe = toolCtx(false);
    await tool("dispatch_set").execute("id", { key: "dailyTokenCap", value: "2000000" }, undefined, undefined, probe.ctx);
    assert.doesNotMatch(probe.shown[0].message, /Warning/);
  } finally {
    writeFileSync(join(deploymentDir, ".env"), "");
  }
});
