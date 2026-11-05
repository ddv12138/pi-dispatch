import { withOperatorDiagnosis } from "./helpers/tool-diagnosis.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers/temp-dir.mjs";
import { renderTriggers } from "../src/render.mjs";

/**
 * Issue #501, part 7 (and #502's obligation from PR #536's review): the model-callable surfaces of the token caps.
 * `dispatch_costs` and `dispatch_limits` gain token window rows; the scoped-limit writers take the token fields behind
 * their confirm, judged by the worker's own parser before it; `dispatch_set`'s token keys are judged the same way;
 * and NEITHER trigger tool can set `run.maxTokens` or `run.models`, while an existing value rides through untouched.
 */
const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = piRequire("jiti");
const jiti = createJiti(import.meta.url);
const indexMod = await jiti.import(fileURLToPath(new URL("../src/index.ts", import.meta.url)));
indexMod.setToolReadDepsForTest({ held: async () => ({ heldTokens: 0, heldJobs: 0, unknownHosts: [] }) });
const { buildTriggerEntry } = indexMod;
// Issue #642: every write these drive is audited as the panel into PI_LOGS_DIR's console-audit chain, so the file's
// writes land in a directory of its own rather than the account's default logs directory.
process.env.PI_LOGS_DIR = tempDir("pd-642-panel-audit-");
const { validateToolArguments } = await import("@earendil-works/pi-ai");

function registeredTools() {
  const tools = [];
  const pi = new Proxy({}, { get: (_t, k) => (k === "registerTool" ? (t) => tools.push(t) : () => {}) });
  indexMod.default(pi);
  return tools;
}
const toolByName = (name) => withOperatorDiagnosis(registeredTools().find((t) => t.name === name));
function toolCtx({ hasUI = true, answer = true } = {}) {
  const shown = [];
  const ui = { confirm: async (title, message) => { shown.push({ title, message }); return answer; } };
  return { ctx: { hasUI, ui: hasUI ? ui : {} }, shown };
}
const textOf = (res) => JSON.parse(res.content[0].text);
const read = (path) => JSON.parse(readFileSync(path, "utf8"));

function tmpFile(name, value, envName) {
  const path = join(tempDir("pd-501-p7-"), name);
  if (value !== undefined) writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
  process.env[envName] = path;
  return path;
}

// --- no widening by tool -----------------------------------------------------------------------------------

const GUARDED = { triggers: [{ on: { type: "label", any: ["bug"] }, run: { kind: "github", flow: "fix", provider: "openai", model: "gpt-x", models: ["openai/gpt-x", "openai/gpt-y"], fallbackModels: ["openai/gpt-y"], maxTokens: 1500000 } }] };

// `mcp` (REQ-MCP-OPERATOR-SERVERS) rides the same guard: which outside systems a trigger's jobs reach is set by hand.
for (const field of ["maxTokens", "models", "mcp"]) {
  const value = field === "models" ? ["openai/gpt-x"] : field === "mcp" ? ["docs"] : "0.50";

  test(`dispatch_trigger_add refuses ${field} before any confirm, and writes nothing`, async () => {
    const path = tmpFile("triggers.json", { triggers: [] }, "PI_TRIGGERS_FILE");
    const { ctx, shown } = toolCtx({ answer: true });
    await assert.rejects(
      () => toolByName("dispatch_trigger_add").execute("id", { kind: "label", flow: "fix", labels: ["bug"], [field]: value }, undefined, undefined, ctx),
      new RegExp(`cannot set run\\.${field}`),
    );
    assert.equal(shown.length, 0, "the operator is never asked");
    assert.deepEqual(read(path), { triggers: [] });
  });

  test(`dispatch_trigger_edit refuses ${field} before any confirm, and the entry keeps its own`, async () => {
    const path = tmpFile("triggers.json", GUARDED, "PI_TRIGGERS_FILE");
    const before = readFileSync(path, "utf8");
    const { ctx, shown } = toolCtx({ answer: true });
    await assert.rejects(
      () => toolByName("dispatch_trigger_edit").execute("id", { index: 0, flow: "fix", [field]: field === "models" ? ["openai/gpt-z"] : "99" }, undefined, undefined, ctx),
      new RegExp(`cannot set run\\.${field}`),
    );
    assert.equal(shown.length, 0);
    assert.equal(readFileSync(path, "utf8"), before);
  });
}

test("the add builder never carries maxTokens or models, whatever it is handed", () => {
  for (const kind of ["cron", "label", "comment", "pull_request", "issue"]) {
    const entry = buildTriggerEntry(kind, { flow: "fix", id: "n", pattern: "0 3 * * *", folder: "/srv/x", task: "t", labels: ["bug"], phrase: "@pi", action: ["opened"], maxTokens: 100000, models: ["a/b"] });
    assert.ok(!("maxTokens" in entry.run) && !("models" in entry.run), `${kind}: ${JSON.stringify(entry.run)}`);
  }
});

test("an approved trigger edit carries the entry's models and maxTokens through unchanged", async () => {
  const path = tmpFile("triggers.json", GUARDED, "PI_TRIGGERS_FILE");
  const { ctx } = toolCtx({ answer: true });
  const out = textOf(await toolByName("dispatch_trigger_edit").execute("id", { index: 0, flow: "review", model: "gpt-y" }, undefined, undefined, ctx));
  assert.equal(out.applied, true);
  const run = read(path).triggers[0].run;
  assert.equal(run.flow, "review");
  assert.equal(run.model, "gpt-y");
  assert.deepEqual(run.models, ["openai/gpt-x", "openai/gpt-y"]);
  assert.deepEqual(run.fallbackModels, ["openai/gpt-y"]);
  assert.equal(run.maxTokens, 1_500_000);
});

test("dispatch_triggers and the plain trigger line show the models and the per-job cap (PR #536's obligation)", async () => {
  tmpFile("triggers.json", GUARDED, "PI_TRIGGERS_FILE");
  const [t] = textOf(await toolByName("dispatch_triggers").execute("id", {}, undefined, undefined, undefined));
  assert.deepEqual(t.models, ["openai/gpt-x", "openai/gpt-y"]);
  assert.deepEqual(t.fallbackModels, ["openai/gpt-y"]);
  assert.equal(t.maxTokens, "1500000");
  const text = renderTriggers({ schedulers: [], triggers: { triggers: [t] } });
  assert.match(text, /\[models openai\/gpt-x, openai\/gpt-y\]  \[max 1500000\]/);
  assert.match(text, /\[fallbacks openai\/gpt-y\]/);
  // A trigger that sets neither keeps exactly its keys and its line.
  tmpFile("triggers.json", { triggers: [{ on: { type: "label", any: ["bug"] }, run: { kind: "github", flow: "fix" } }] }, "PI_TRIGGERS_FILE");
  const [plain] = textOf(await toolByName("dispatch_triggers").execute("id", {}, undefined, undefined, undefined));
  assert.ok(!("models" in plain) && !("maxTokens" in plain));
});

// --- scoped-limit writers ------------------------------------------------------------------------------------

test("dispatch_limit_add writes a token window in canonical form, stamps version 2, and asks first", async () => {
  const path = tmpFile("scoped-limits.json", { version: 1, limits: [] }, "PI_SCOPED_LIMITS_FILE");
  const { ctx, shown } = toolCtx({ answer: true });
  const out = textOf(await toolByName("dispatch_limit_add").execute("id", { scope: "acme/web", day: 3, dayTokens: 2500000 }, undefined, undefined, ctx));
  assert.equal(out.applied, true);
  assert.match(shown[0].message, /"dayTokens":2500000/, "the confirm shows exactly what the file will hold");
  assert.deepEqual(read(path), { version: 2, limits: [{ scope: "acme/web", day: 3, dayTokens: 2500000 }] });
});

test("dispatch_limit_add takes a model row with token fields only", async () => {
  const path = tmpFile("scoped-limits.json", undefined, "PI_SCOPED_LIMITS_FILE");
  const { ctx } = toolCtx({ answer: true });
  textOf(await toolByName("dispatch_limit_add").execute("id", { scope: "model:openai/gpt-x", monthTokens: 25_000_000 }, undefined, undefined, ctx));
  assert.deepEqual(read(path), { version: 2, limits: [{ scope: "model:openai/gpt-x", monthTokens: 25000000 }] });
});

test("the limit writers keep the LOWEST version: a count-only file stays version 1, and drops back to it", async () => {
  const path = tmpFile("scoped-limits.json", { version: 2, limits: [{ scope: "acme/web", day: 3 }, { scope: "acme/api", dayTokens: 5_000_000 }] }, "PI_SCOPED_LIMITS_FILE");
  const { ctx } = toolCtx({ answer: true });
  await toolByName("dispatch_limit_edit").execute("id", { index: 0, day: 4 }, undefined, undefined, ctx);
  assert.equal(read(path).version, 2, "a token row still needs version 2");
  await toolByName("dispatch_limit_delete").execute("id", { index: 1 }, undefined, undefined, ctx);
  assert.deepEqual(read(path), { version: 1, limits: [{ scope: "acme/web", day: 4 }] }, "the last token row gone, the file is version 1 again");
  await toolByName("dispatch_limit_add").execute("id", { scope: "acme/ops", concurrent: 1 }, undefined, undefined, ctx);
  assert.equal(read(path).version, 1, "a count-only add writes version 1, readable by an older worker");
});

for (const [field, bad] of [["dayTokens", "1e3"], ["weekTokens", "0"], ["monthTokens", "0.5"], ["dayTokens", "2,50"]]) {
  test(`a malformed ${field} (${JSON.stringify(bad)}) is refused before the confirm, by both limit writers`, async () => {
    const initial = { version: 2, limits: [{ scope: "acme/web", dayTokens: 5_000_000 }] };
    const path = tmpFile("scoped-limits.json", initial, "PI_SCOPED_LIMITS_FILE");
    const { ctx, shown } = toolCtx({ answer: true });
    await assert.rejects(() => toolByName("dispatch_limit_add").execute("id", { scope: "acme/api", [field]: bad }, undefined, undefined, ctx), new RegExp(`${field} must be a whole number of tokens of 1 or more`));
    await assert.rejects(() => toolByName("dispatch_limit_edit").execute("id", { index: 0, [field]: bad }, undefined, undefined, ctx), new RegExp(`${field} must be a whole number of tokens of 1 or more`));
    assert.equal(shown.length, 0, "never asked to approve a value the write would refuse");
    assert.deepEqual(read(path), initial);
  });
}

test("a token field the model sends as a JSON number reaches the tool as a string through pi's own validator, and is judged by its value", async () => {
  // pi's validateToolArguments runs Value.Convert first, so no tool schema can keep a number out (PR #550's review).
  // What is pinned instead: the converted value goes through parseTokenCount before the confirm, like a typed one.
  const path = tmpFile("scoped-limits.json", { version: 1, limits: [] }, "PI_SCOPED_LIMITS_FILE");
  const tool = toolByName("dispatch_limit_add");
  // A FRACTIONAL token count is refused before the confirm: pi's validator stringifies it, and the
  // parser's whole-number rule refuses it -- there is no such thing as half a token.
  const args = validateToolArguments(tool, { name: tool.name, arguments: { scope: "acme/api", dayTokens: 2_000_000.5 } });
  assert.equal(args.dayTokens, "2000000.5", "the validator converted it");
  const no = toolCtx({ answer: true });
  await assert.rejects(() => tool.execute("id", args, undefined, undefined, no.ctx), /dayTokens must be a whole number of tokens of 1 or more/);
  assert.equal(no.shown.length, 0, "a fraction is refused before the confirm");
  // A whole number sent as a JSON number rides as its string and is written as the number.
  const whole = validateToolArguments(tool, { name: tool.name, arguments: { scope: "acme/ops", dayTokens: 2_000_000 } });
  assert.equal(whole.dayTokens, "2000000", "the validator converted it");
  const ok = toolCtx({ answer: true });
  await tool.execute("id", whole, undefined, undefined, ok.ctx);
  assert.deepEqual(read(path).limits, [{ scope: "acme/ops", dayTokens: 2000000 }]);
});

test("dispatch_limit_edit replaces a sent token field, carries the others, and shows both sides", async () => {
  const path = tmpFile("scoped-limits.json", { version: 2, limits: [{ scope: "acme/web", day: 3, dayTokens: 5_000_000, monthTokens: 60_000_000 }] }, "PI_SCOPED_LIMITS_FILE");
  const { ctx, shown } = toolCtx({ answer: true });
  textOf(await toolByName("dispatch_limit_edit").execute("id", { index: 0, dayTokens: 4250000, weekTokens: 20_000_000 }, undefined, undefined, ctx));
  assert.deepEqual(read(path).limits[0], { scope: "acme/web", day: 3, dayTokens: 4250000, weekTokens: 20000000, monthTokens: 60000000 });
  assert.match(shown[0].message, /"dayTokens":5000000.*\nto .*"dayTokens":4250000/s);
});

test("dispatch_limits gives each row its typed limits and, for a token row, its windows with the counter", async () => {
  tmpFile("scoped-limits.json", { version: 2, limits: [{ scope: "acme/web", day: 3, dayTokens: 5_000_000 }, { scope: "model:openai/gpt-x", weekTokens: 25_000_000 }, { scope: "acme/ops", concurrent: 1 }] }, "PI_SCOPED_LIMITS_FILE");
  process.env.VALKEY_URL = "not-a-url"; // degrade synchronously
  try {
    const rows = textOf(await toolByName("dispatch_limits").execute("id", {}, undefined, undefined, undefined));
    assert.equal(rows[0].day, 3);
    assert.equal(rows[0].dayTokens, 5_000_000);
    assert.equal(rows[0].summary, undefined, "generated display prose stays outside the model read contract");
    assert.deepEqual(rows[0].windows, [{ window: "day", capTokens: 5_000_000, counterTokens: null }], "null on an unreachable queue, never an invented 0");
    assert.deepEqual(rows[1].windows, [{ window: "week", capTokens: 25_000_000, counterTokens: null }]);
    assert.deepEqual(rows[2], { index: 2, scope: "acme/ops", day: null, week: null, month: null, concurrent: 1, dayTokens: null, weekTokens: null, monthTokens: null, used: null }, "a row with no token window reads exactly as before");
  } finally {
    delete process.env.VALKEY_URL;
  }
});

// --- dispatch_set's token keys --------------------------------------------------------------------------------

test("dispatch_set takes each of the four token keys behind its confirm, written as the number typed", async () => {
  const saved = process.env.PI_MAX_TOKENS;
  try {
    process.env.PI_MAX_TOKENS = "2000000";
    for (const key of ["maxTokens", "dailyTokenCap", "weeklyTokenCap", "monthlyTokenCap"]) {
      const settingsFile = tmpFile("settings.json", {}, "PI_SETTINGS_FILE");
      const declined = toolCtx({ answer: false });
      assert.equal(textOf(await toolByName("dispatch_set").execute("id", { key, value: "2500000" }, undefined, undefined, declined.ctx)).applied, false);
      assert.equal(declined.shown.length, 1, `${key}: asked`);
      assert.deepEqual(read(settingsFile), {}, `${key}: a decline writes nothing`);
      const approved = toolCtx({ answer: true });
      await toolByName("dispatch_set").execute("id", { key, value: "2500000" }, undefined, undefined, approved.ctx);
      assert.deepEqual(read(settingsFile), { [key]: 2500000 }, `${key}: coerced to the number the overlay stores`);
    }
  } finally {
    if (saved === undefined) delete process.env.PI_MAX_TOKENS;
    else process.env.PI_MAX_TOKENS = saved;
  }
});

test("dispatch_set refuses a malformed token value BEFORE the confirm, naming the key and never the value", async () => {
  const settingsFile = tmpFile("settings.json", { maxTokens: 2 }, "PI_SETTINGS_FILE");
  for (const bad of ["1e3", "0", "-1", "2.5", "0x10", "abc"]) {
    const { ctx, shown } = toolCtx({ answer: true });
    await assert.rejects(
      () => toolByName("dispatch_set").execute("id", { key: "dailyTokenCap", value: bad }, undefined, undefined, ctx),
      // The value is never echoed (a value typed into the wrong field could be anything); "0" and "-1" are too short to
      // tell apart from the message's own "1000000".
      (err) => /dailyTokenCap must be a whole number of tokens of 1 or more/.test(err.message) && (bad.length < 3 || !err.message.includes(bad)),
    );
    assert.equal(shown.length, 0, `${bad}: never asked`);
  }
  assert.deepEqual(read(settingsFile), { maxTokens: 2 });
});

// --- dispatch_costs ----------------------------------------------------------------------------------------------

test("dispatch_costs carries the token windows and the per-run settlements beside the fold", async () => {
  const logsDir = tempDir("pd-501-p7-logs-");
  process.env.PI_LOGS_DIR = logsDir;
  const now = Date.now();
  const at = (ms) => new Date(ms).toISOString();
  const rec = (jobId, over) => ({ jobId, kind: "github", target: "acme/web#1", flow: "fix", startedAt: at(now - 60_000), endedAt: at(now - 30_000), outcome: "completed", tokens: { total: 1, metered: true }, usage: null, ...over });
  writeFileSync(join(logsDir, "a.json"), JSON.stringify(rec("a", { tokensWindows: { reservedTokens: 2_000_000, settledTokens: 400_000, basis: "metered", modelBasis: null } })));
  writeFileSync(join(logsDir, "b.json"), JSON.stringify(rec("b", { tokensWindows: null })));
  tmpFile("settings.json", { maxTokens: 2, dailyTokenCap: 10_000_000 }, "PI_SETTINGS_FILE");
  tmpFile("scoped-limits.json", { version: 2, limits: [{ scope: "acme/web", dayTokens: 5_000_000 }] }, "PI_SCOPED_LIMITS_FILE");
  tmpFile("subscriptions.json", undefined, "PI_SUBSCRIPTIONS_FILE");
  tmpFile("triggers.json", { triggers: [] }, "PI_TRIGGERS_FILE");
  process.env.VALKEY_URL = "not-a-url";
  try {
    const out = textOf(await toolByName("dispatch_costs").execute("id", {}, undefined, undefined, undefined));
    assert.ok(out.fold, "the fold is still there");
    assert.deepEqual(out.windows.rows.map((w) => [w.ledger, w.name, w.window, w.capTokens, w.counterTokens, w.records?.settledTokens]), [
      ["deployment", null, "day", 10_000_000, null, 400_000],
      ["scope", "acme/web", "day", 5_000_000, null, 400_000],
    ]);
    assert.ok(out.windows.countersUnreachable, "an unreadable counter is said, not zeroed");
    assert.deepEqual(out.windows.runs.map((r) => [r.jobId, r.tokensWindows.basis, r.tokensWindows.settledTokens]), [["a", "metered", 400_000]], "only runs that carry a settlement");
    assert.equal(out.windows.more, 0);
  } finally {
    delete process.env.VALKEY_URL;
  }
});

test("dispatch_costs says beside the per-run settlements how many records a newer pi-dispatch wrote, which the list leaves out (#761)", async () => {
  const logsDir = tempDir("pd-761-costs-logs-");
  process.env.PI_LOGS_DIR = logsDir;
  const now = Date.now();
  const at = (ms) => new Date(ms).toISOString();
  const rec = (jobId, over) => ({ jobId, kind: "github", target: "acme/web#1", flow: "fix", startedAt: at(now - 60_000), endedAt: at(now - 30_000), outcome: "completed", tokens: { total: 1, metered: true }, usage: null, tokensWindows: { reservedTokens: 2_000_000, settledTokens: 400_000, basis: "metered", modelBasis: null }, ...over });
  writeFileSync(join(logsDir, "a.json"), JSON.stringify(rec("a")));
  writeFileSync(join(logsDir, "n.json"), JSON.stringify(rec("n", { tokensWindows: { reservedTokens: 9_000_000, settledTokens: 7_500_000, basis: "metered", modelBasis: null }, v: 3 })));
  tmpFile("settings.json", { maxTokens: 2 }, "PI_SETTINGS_FILE");
  tmpFile("scoped-limits.json", undefined, "PI_SCOPED_LIMITS_FILE");
  tmpFile("subscriptions.json", undefined, "PI_SUBSCRIPTIONS_FILE");
  tmpFile("triggers.json", { triggers: [] }, "PI_TRIGGERS_FILE");
  process.env.VALKEY_URL = "not-a-url";
  try {
    const out = textOf(await toolByName("dispatch_costs").execute("id", {}, undefined, undefined, undefined));
    assert.deepEqual(out.windows.runs.map((r) => [r.jobId, r.tokensWindows.settledTokens]), [["a", 400_000]], "the newer run's settlement is not listed");
    assert.equal(out.windows.newerSkipped, 1, "and the list says one was left out");
    assert.equal(out.fold.newerSkipped, 1, "as the fold does");
    // A record's project is core, so `project=x` counts only x's newer records; its flow and target are not, so the
    // flow and repo filters leave the count as it is (here, a flow none of the records has).
    writeFileSync(join(logsDir, "x1.json"), JSON.stringify(rec("x1", { project: "x", v: 2 })));
    writeFileSync(join(logsDir, "x2.json"), JSON.stringify(rec("x2", { project: "x", flow: "triage", v: 3 })));
    writeFileSync(join(logsDir, "y1.json"), JSON.stringify(rec("y1", { project: "y", v: 3 })));
    writeFileSync(join(logsDir, "xa.json"), JSON.stringify(rec("xa", { project: "x" })));
    // One that ends after now is past the window the fold reads, as a released one would be, so it is not counted either.
    writeFileSync(join(logsDir, "xf.json"), JSON.stringify(rec("xf", { project: "x", v: 2, startedAt: at(now + 3_600_000), endedAt: at(now + 3_660_000) })));
    const costs = async (params) => textOf(await toolByName("dispatch_costs").execute("id", params, undefined, undefined, undefined));
    // This build reads v2, so the newer set is the one v3 record per project; the fold's own count matches.
    for (const [params, count] of [[{ project: "x" }, 1], [{ project: "y" }, 1], [{}, 3], [{ project: "x", flow: "absent" }, 1], [{ repo: "acme/none" }, 3]]) {
      const out = await costs(params);
      assert.equal(out.windows.newerSkipped, count, JSON.stringify(params));
      assert.equal(out.fold.newerSkipped, count, `${JSON.stringify(params)}: the fold's count is the same one`);
    }
    assert.deepEqual((await costs({ project: "x" })).windows.runs.map((r) => r.jobId), ["x1", "xa"], "the project's own released runs are listed, the newer one is not");
    const none = await costs({ project: "z" });
    assert.equal(Object.hasOwn(none.windows, "newerSkipped") || Object.hasOwn(none.fold, "newerSkipped"), false, "a project with no newer record has no count");
    for (const name of ["x1", "x2", "y1", "xa", "xf"]) writeFileSync(join(logsDir, `${name}.json`), JSON.stringify(rec(name)));
    // None left out: no count at all, so every other answer is as it was.
    writeFileSync(join(logsDir, "n.json"), JSON.stringify(rec("n")));
    assert.equal(Object.hasOwn(textOf(await toolByName("dispatch_costs").execute("id", {}, undefined, undefined, undefined)).windows, "newerSkipped"), false);
  } finally {
    delete process.env.VALKEY_URL;
  }
});

// --- PR #550's review ----------------------------------------------------------------------------------------

for (const extra of [{ fallbackModels: ["a/b"] }, { fallback_models: ["a/b"] }, { run: { fallbackModels: null } }, { on: { fallbackModels: [] } }, { MaxCostUsd: "9" }, { max_cost_usd: "9" }, { maxcostusd: "9" }, { "maxTokens ": "9" }, { allowedModels: ["a/b"] }, { run: { maxTokens: 9 } }, { run: { models: ["a/b"] } }, { on: { maxTokens: 9 } }, { "m\u0430xCostUsd": "9" }]) {
  test(`a near miss of a tool-proof field is refused too, before any confirm: ${JSON.stringify(extra)}`, async () => {
    const path = tmpFile("triggers.json", GUARDED, "PI_TRIGGERS_FILE");
    const before = readFileSync(path, "utf8");
    for (const [name, args] of [["dispatch_trigger_add", { kind: "label", flow: "fix", labels: ["bug"] }], ["dispatch_trigger_edit", { index: 0, flow: "fix" }]]) {
      const { ctx, shown } = toolCtx({ answer: true });
      await assert.rejects(() => toolByName(name).execute("id", { ...args, ...extra }, undefined, undefined, ctx), /cannot set run\.(maxTokens|models|fallbackModels)/);
      assert.equal(shown.length, 0);
    }
    assert.equal(readFileSync(path, "utf8"), before);
  });
}

test("the near-miss refusal leaves the ordinary model fields alone", async () => {
  const path = tmpFile("triggers.json", { triggers: [] }, "PI_TRIGGERS_FILE");
  const { ctx } = toolCtx({ answer: true });
  await toolByName("dispatch_trigger_add").execute("id", { kind: "label", flow: "fix", labels: ["bug"], provider: "openai", model: "gpt-x", maxTurns: 4 }, undefined, undefined, ctx);
  assert.deepEqual(read(path).triggers[0].run, { kind: "github", flow: "fix", model: "gpt-x", provider: "openai", maxTurns: 4, secretBundle: false });
});

test("with no token setting, dispatch_costs still reports held tokens and dispatch_limits keeps count rows", async () => {
  const logsDir = tempDir("pd-501-p7-logs-");
  process.env.PI_LOGS_DIR = logsDir;
  const now = Date.now();
  writeFileSync(join(logsDir, "a.json"), JSON.stringify({ jobId: "a", kind: "github", target: "acme/web#1", flow: "fix", startedAt: new Date(now - 60_000).toISOString(), endedAt: new Date(now - 30_000).toISOString(), outcome: "completed", tokens: { total: 1, metered: true }, usage: null, tokensWindows: null }));
  tmpFile("settings.json", { maxTokens: 2 }, "PI_SETTINGS_FILE");
  tmpFile("scoped-limits.json", { version: 1, limits: [{ scope: "acme/web", day: 3 }] }, "PI_SCOPED_LIMITS_FILE");
  tmpFile("subscriptions.json", undefined, "PI_SUBSCRIPTIONS_FILE");
  tmpFile("triggers.json", { triggers: [] }, "PI_TRIGGERS_FILE");
  process.env.VALKEY_URL = "not-a-url";
  try {
    const costs = textOf(await toolByName("dispatch_costs").execute("id", {}, undefined, undefined, undefined));
    if (process.env.DEBUG_HELD) console.error("HELD:", JSON.stringify(costs.held));
    assert.deepEqual(Object.keys(costs), ["window", "fold", "windows", "held"]);
    assert.deepEqual(costs.windows.rows, []);
    assert.deepEqual(costs.windows.runs, []);
    assert.deepEqual(costs.held, { heldTokens: 0, heldJobs: 0, unknownHosts: [] });
    const rows = textOf(await toolByName("dispatch_limits").execute("id", {}, undefined, undefined, undefined));
    assert.deepEqual(rows, [{ index: 0, scope: "acme/web", day: 3, week: null, month: null, concurrent: null, used: null }], "no summary, no windows");
  } finally {
    delete process.env.VALKEY_URL;
  }
});

// --- PR #550's review, round 2 -------------------------------------------------------------------------------

test("dispatch_costs names an unreadable token setting even when no window is left to show", async () => {
  tmpFile("settings.json", {}, "PI_SETTINGS_FILE");
  tmpFile("scoped-limits.json", undefined, "PI_SCOPED_LIMITS_FILE");
  tmpFile("subscriptions.json", undefined, "PI_SUBSCRIPTIONS_FILE");
  tmpFile("triggers.json", { triggers: [] }, "PI_TRIGGERS_FILE");
  process.env.PI_LOGS_DIR = tempDir("pd-501-p7-logs-");
  const saved = process.env.PI_DAILY_TOKEN_CAP;
  process.env.PI_DAILY_TOKEN_CAP = "abc";
  try {
    const out = textOf(await toolByName("dispatch_costs").execute("id", {}, undefined, undefined, undefined));
    assert.deepEqual(out.windows.invalid, ["dailyTokenCap"]);
    assert.deepEqual(out.windows.rows, []);
  } finally {
    if (saved === undefined) delete process.env.PI_DAILY_TOKEN_CAP;
    else process.env.PI_DAILY_TOKEN_CAP = saved;
  }
});

test("a token field with surrounding blanks is trimmed, judged, and written canonical", async () => {
  const path = tmpFile("scoped-limits.json", { version: 1, limits: [] }, "PI_SCOPED_LIMITS_FILE");
  const { ctx, shown } = toolCtx({ answer: true });
  await toolByName("dispatch_limit_add").execute("id", { scope: "acme/web", dayTokens: " 2500000 " }, undefined, undefined, ctx);
  assert.match(shown[0].message, /"dayTokens":2500000/);
  assert.deepEqual(read(path).limits, [{ scope: "acme/web", dayTokens: 2500000 }]);
});

test("readScopedBudget swallows ioredis' error events too", async () => {
  const { readScopedBudget } = await import("../src/read-model.mjs");
  const events = [];
  const fake = { on: (ev) => events.push(ev), async get() { return "1"; }, disconnect() {} };
  const out = await readScopedBudget({ url: "redis://127.0.0.1:1", limits: [{ scope: "acme/web", day: 3 }], redisFn: () => fake });
  assert.deepEqual(out, { rows: [{ day: 1 }] });
  assert.deepEqual(events, ["error"]);
});

test("dispatch_trigger_add refuses a near miss of run.mcp, nested or not, before any confirm (REQ-MCP-OPERATOR-SERVERS)", async () => {
  for (const extra of [{ mcpServers: ["docs"] }, { run: { MCP: ["docs"] } }, { on: { mcp: ["docs"] } }, { ["m\u0441p"]: ["docs"] }, { run: { ["\uff4d\uff43\uff50"]: ["docs"] } }, { mcp: ["docs"] }]) {
    const path = tmpFile("triggers.json", { triggers: [] }, "PI_TRIGGERS_FILE");
    const { ctx, shown } = toolCtx({ answer: true });
    await assert.rejects(() => toolByName("dispatch_trigger_add").execute("id", { kind: "label", flow: "fix", labels: ["bug"], ...extra }, undefined, undefined, ctx), /cannot set run\.mcp/, JSON.stringify(extra));
    assert.equal(shown.length, 0);
    assert.deepEqual(read(path), { triggers: [] });
  }
});
