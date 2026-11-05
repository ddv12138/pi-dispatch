import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.mjs";
import { collectModelPolicies, modelsViewOf, readModelsView, modelsForAgent, readModelsHistory, canaryComparisonLines, MODELS_LIMITS } from "../src/models-view.mjs";
import { dayKey } from "@edgehero/pi-dispatch/budget";
import { modelTokenKeyPrefix } from "@edgehero/pi-dispatch/scoped-limits";

const NOW = Date.UTC(2026, 9, 31, 12);
const deployment = { provider: "p", model: "main", maxTokens: "2000000" };
const status = ref => ({ known: ref !== "p/missing", priced: !["p/unpriced", "p/missing", "radius/model"].includes(ref), reason: ref === "p/unpriced" ? "model-unpriced" : null, api: ref.startsWith("radius/") ? "pi-messages" : "openai-completions" });
const entry = (run = {}) => ({ on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "fix", model: "role:editor", ...run } });
const snapshot = { waiting: { rows: [] }, doctor: { hosts: [] }, settings: { overlay: {} } };
function view(options = {}) { return modelsViewOf({ now: NOW, deployment, status, snapshot, ...options }); }
const original = (jobId = "original", overrides = {}) => ({ jobId, modelRole: "editor", flow: "fix", provider: "p", model: "main", outcome: "completed", endedAt: new Date(NOW - 60000).toISOString(), turns: 2, tokens: { total: 100, metered: true }, ...overrides });
const candidate = (jobId = "canary", sourceJobId = "original", overrides = {}) => ({ jobId, flow: "fix", provider: "p", model: "candidate", outcome: "completed", endedAt: new Date(NOW - 30000).toISOString(), turns: 4, tokens: { total: 200, metered: true }, canary: { sourceJobId, role: "editor", candidate: "p/candidate" }, ...overrides });

test("role associations expand every reachable scope, preserve fallback order and separate trigger-owned lists", () => {
  const modelRoles = { default: { editor: "p/main" }, web: { editor: { model: "p/web", fallbackModels: ["p/unpriced", "p/backup"] } } };
  const projects = [{ id: "web", members: ["github:acme/web"] }, { id: "other", members: ["gitlab:acme/other"] }];
  const got = view({ entries: [entry(), entry({ kind: "gitlab", fallbackModels: ["p/own"] })], modelRoles, projects });
  assert.deepEqual(got.roles.map(row => [row.scope, row.triggers.map(trigger => [trigger.index, trigger.project])]), [["default", [[0, null], [1, null], [1, "other"]]], ["web", [[0, "web"]]]]);
  assert.deepEqual(got.roles[1].fallbackModels.map(row => [row.ref, row.skipped]), [["p/unpriced", true], ["p/backup", false]]);
  assert.equal(got.roles[0].fallbackGroups.find(group => group.fallbackModels[0] === "p/own").triggers[0].index, 1);
  assert.deepEqual(got.scopes, ["default", "web", "other"]);
});

test("literal triggers share expanded-role overflow validation and role clashes are actionable scoped banners", () => {
  const roles = Object.fromEntries(Array.from({ length: 16 }, (_, n) => [`r${n}`, `p/m${n}`]));
  const facts = collectModelPolicies({ entries: [entry({ model: "literal" })], modelRoles: { default: roles }, deployment });
  assert.equal(facts.runs.length, 0);
  assert.equal(facts.checks[0].sourceIndex, 0);
  assert.equal(facts.checks[0].reason, "model-roles-invalid");
  const missing = view({ entries: [entry()] });
  assert.equal(missing.banners[0].reason, "model-role-unknown");
  assert.equal(modelsForAgent(missing).banners[0].reason, "model-role-unknown");
  const conflict = view({ entries: [entry({ provider: "other" })], modelRoles: { default: { editor: "p/main" } } });
  assert.equal(conflict.banners[0].reason, "model-role-provider-conflict");
  assert.equal(modelsForAgent(conflict).banners[0].reason, "model-role-provider-conflict");
  const fallbacks = view({ entries: [entry({ fallbackModels: ["p/own"] })], modelRoles: { default: { editor: { model: "p/main", fallbackModels: ["p/backup"] } } } });
  assert.equal(fallbacks.banners[0].reason, "model-roles-invalid");
  assert.equal(modelsForAgent(fallbacks).banners[0].reason, "model-roles-invalid");
});

test("refused triggers retain their physical literal, allowed and fallback models without treating role aliases as physical", () => {
  const missing = view({ entries: [entry({ model: "role:missing", models: ["p/backup"], fallbackModels: ["p/backup"] })] });
  assert.deepEqual(missing.models.map(row => [row.ref, row.state]), [["p/backup", "policy-refused"]]);
  assert.equal(missing.banners[0].reason, "model-role-unknown");
  assert.equal(modelsForAgent(missing).models[0].state, "policy-refused");
  const roles = Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`r${index}`, `p/m${index}`]));
  const overflow = view({ entries: [entry({ model: "literal" })], modelRoles: { default: roles } });
  assert.equal(overflow.models.find(row => row.ref === "p/literal").state, "policy-refused");
  assert.equal(overflow.models.length, 17);
  assert.equal(overflow.models.some(row => row.ref.includes("role:")), false);
  const inherited = view({ entries: [entry({ model: "main" })], envList: ["p/main", "p/backup"] });
  assert.deepEqual(new Set(inherited.models.map(row => row.ref)), new Set(["p/main", "p/backup"]));
  const radius = view({ entries: [entry({ model: "role:missing", models: ["radius/model"], fallbackModels: ["radius/model"] })] });
  assert.deepEqual(radius.banners.map(row => row.kind), ["role-conflict"], "the cost-bound banner died with the cost era");
});

test("cooldowns expire under the caller clock, only failover skips them, and unknown routing stays unknown", () => {
  const roles = { default: { editor: { model: "p/main", fallbackModels: ["p/unpriced", "p/backup"] }, solo: "p/main" } };
  const cooling = [{ ref: "p/main", kind: "rate-limited", until: NOW + 1 }, { ref: "p/backup", kind: "overloaded", until: NOW }];
  const got = view({ modelRoles: roles, cooldowns: cooling });
  assert.equal(got.cooldowns.length, 1);
  assert.deepEqual(got.roles[0].next, { kind: "candidate", model: "p/backup", reason: "pickup-checks-remain" });
  assert.deepEqual(got.roles[1].next, { kind: "direct", model: "p/main", reason: null });
  assert.equal(view({ modelRoles: roles, cooldowns: null }).roles[0].next.kind, "unknown");
  assert.equal(view({ modelRoles: roles, cooldowns: [...cooling, { ref: "p/backup", kind: "overloaded", until: NOW + 1 }] }).roles[0].next.kind, "waiting");
});

test("a token cap no longer flags locally unboundable APIs: the Radius cost-bound banner died with the cost era", () => {
  for (const maxTokens of ["1000", "2000000"]) {
    const got = view({ deployment: { ...deployment, maxTokens }, modelRoles: { default: { editor: "radius/model" } } });
    assert.deepEqual(got.banners.map(row => row.kind), [], "no banner for a pi-messages model under a cap");
  }
  assert.equal(view({ deployment: { ...deployment, maxTokens: null }, modelRoles: { default: { editor: "radius/model" } } }).banners.length, 0);
});

test("model windows match refs case-insensitively while unknown counters never become zero", () => {
  const got = view({ entries: [entry({ model: "main" })], windows: [{ ledger: "model", name: "P/MAIN", window: "day", capTokens: 10, counterTokens: 10 }, { ledger: "model", name: "p/main", window: "week", capTokens: 20, counterTokens: null }] });
  assert.equal(got.models[0].state, "unknown", "an unread window prevents a claim that every admission observation is available");
  assert.deepEqual(got.models[0].windows.map(row => [row.spentTokens, row.unavailable]), [[10, false], [null, true]]);
  assert.equal(view({ entries: [entry({ model: "main" })], windows: [{ ledger: "model", name: "p/main", window: "day", capTokens: 10, counterTokens: 10 }] }).models[0].state, "window-full");
});

test("retained canary comparisons deduplicate mirrored IDs, name unknown metrics and bind exact numbers", () => {
  const records = [candidate("canary-zero", "original", { tokens: { total: 0, metered: true }, turns: 0 }), candidate("canary-missing", "gone", { outcome: "error", tokens: null, turns: null }), original(), original("original", { tokens: { total: 999, metered: true } })];
  const got = view({ records, modelRoles: { default: { editor: "p/main" } } });
  const c = got.canaries[0];
  assert.equal(c.count, 2);
  assert.deepEqual(c.candidateStats, { runs: 2, completed: 1, meteredTokensPerRun: 0, averageTurns: 0, averageTokens: 0, knownMetered: 1, knownTurns: 1, knownTokens: 1 });
  assert.equal(c.sourceStats.runs, 1);
  assert.equal(c.sourceStats.meteredTokensPerRun, 100);
  assert.equal(c.partial, true);
  assert.equal(c.rows.find(row => row.sourceJobId === "gone").source, null);
  assert.match(canaryComparisonLines(c).join(" "), /Candidate: 1\/2 completed.*metered tokens per run 0 \(1 metered\)/);
  const changed = view({ records: [candidate("canary-zero", "original", { tokens: { total: 5, metered: true }, turns: 0 }), ...records.slice(1)] }).canaries[0];
  assert.notEqual(changed.digest, c.digest);
  assert.equal(changed.id, c.id);
});

test("canary exact metering excludes every floored run and keeps known-zero distinct from unmetered", () => {
  const floors = ["unresolved", "usageUnreported", "unmeteredChildren"];
  const records = floors.map((flag, index) => candidate(`floor-${index}`, "original", { tokens: { total: 200, metered: true, [flag]: 1 } }));
  records.push(candidate("fallback-meter", "original", { tokens: { total: 200, metered: false } }));
  records.push(candidate("legacy-unmetered", "original", { tokens: { total: 200 } }));
  records.push(candidate("pre-meter", "original", { tokens: null }));
  records.push(candidate("refused-before-spend", "original", { tokens: null, exitCode: null, budgetReserved: false }));
  records.push(candidate("dollar-era-flags-are-not-floors", "original", { tokens: { total: 200, metered: true, costUnreported: 1, costCapMicros: 1000000 } }));
  records.push(candidate("known-zero", "original", { tokens: { total: 0, metered: true } }));
  const sample = view({ records: [...records, original()] }).canaries[0];
  assert.equal(sample.count, floors.length + 6);
  assert.equal(sample.candidateStats.knownMetered, 2);
  assert.equal(sample.candidateStats.meteredTokensPerRun, 100);
  for (const row of sample.rows) assert.equal(row.candidate.meteredTokens, row.jobId === "known-zero" ? 0 : row.jobId === "dollar-era-flags-are-not-floors" ? 200 : null, row.jobId);
  assert.equal(sample.partial, true);
  assert.match(canaryComparisonLines(sample).join(" "), /metered tokens per run 100 \(2 metered\)/);
  const withoutExact = view({ records: [...records.filter(record => !["known-zero", "dollar-era-flags-are-not-floors"].includes(record.jobId)), original()] }).canaries[0];
  assert.equal(withoutExact.candidateStats.knownMetered, 0);
  assert.equal(withoutExact.candidateStats.meteredTokensPerRun, null);
  assert.match(canaryComparisonLines(withoutExact).join(" "), /metered tokens per run unknown \(0 metered\)/);
  const sourceFloor = view({ records: [candidate(), original("original", { tokens: { total: 100, metered: true, unresolved: 1 } })] }).canaries[0];
  assert.equal(sourceFloor.sourceStats.knownMetered, 0);
  assert.equal(sourceFloor.rows[0].source.meteredTokens, null);
  assert.equal(sourceFloor.partial, true);
});

test("canary grouping distinguishes flow and source metadata mismatches stay unavailable", () => {
  const got = view({ records: [candidate(), candidate("other-flow", "wrong", { flow: "review" }), original(), original("wrong")] });
  assert.equal(got.canaries.length, 2);
  assert.equal(got.canaries.find(c => c.flow === "review").sourceStats.runs, 0);
  const expired = view({ records: [candidate("old", "original", { endedAt: new Date(NOW - 31 * 86400000).toISOString() }), original()] });
  assert.equal(expired.canaries.length, 0);
});

test("dedicated history pages beyond overview rows and hydrates only named missing sources using authoritative reader", async () => {
  const calls = [];
  const ordinary = Array.from({ length: 100 }, (_, n) => original(`ordinary-${n}`));
  const got = await readModelsHistory({ now: NOW, seed: ordinary.slice(0, 20), fleet: {
    runsPage: async params => { calls.push(params); return params.before === null ? { runs: ordinary, next: NOW - 60000, mirror: "ok" } : { runs: [candidate("old-canary", "missing-source", { endedAt: new Date(NOW - 90000).toISOString() })], next: null, mirror: "ok" }; },
    runById: async id => { calls.push(id); return { record: original(id, { endedAt: new Date(NOW - 120000).toISOString() }), source: "local" }; },
  } });
  assert.equal(got.records.length, 101);
  assert.deepEqual(calls.at(-1), "missing-source");
  const combined = view({ records: got.records, sourceRecords: got.sourceRecords });
  assert.equal(combined.canaries[0].sourceStats.runs, 1);
  assert.equal(got.sourcesUnknown, false);
});

test("history bounds page count and hydration and catches a non-progressing cursor", async () => {
  let pages = 0, sources = 0;
  const fleet = { runsPage: async ({ before }) => { pages++; return { runs: Array.from({ length: 100 }, (_, n) => candidate(`c-${pages}-${n}`, `o-${pages}-${n}`)), next: (before ?? NOW) - 1, mirror: "ok" }; }, runById: async id => { sources++; return { record: original(id) }; } };
  const got = await readModelsHistory({ now: NOW, fleet });
  assert.equal(pages, 10); assert.equal(got.records.length, 1000); assert.equal(sources, MODELS_LIMITS.canarySources); assert.equal(got.truncated, true); assert.equal(got.sourcesUnknown, true);
  let repeats = 0;
  const stuck = await readModelsHistory({ now: NOW, fleet: { runsPage: async () => { repeats++; return { runs: [], next: NOW - 1, mirror: "ok" }; } } });
  assert.equal(repeats, 2); assert.equal(stuck.partial, true);
});

function files(doc, limits = null) {
  const dir = tempDir("models-view-");
  const paths = { triggersPath: join(dir, "triggers.json"), settingsFile: join(dir, "settings.json"), scopedLimitsPath: join(dir, "limits.json") };
  fs.writeFileSync(paths.triggersPath, JSON.stringify(doc)); fs.writeFileSync(paths.settingsFile, "{}");
  if (limits) fs.writeFileSync(paths.scopedLimitsPath, JSON.stringify(limits));
  return paths;
}

test("reader touches only configured failover cooldown keys; a simple role performs no cooldown read", async () => {
  const doc = { triggers: [entry()], modelRoles: { default: { editor: { model: "p/main", fallbackModels: ["p/backup"] }, solo: "p/solo" } } };
  const paths = files(doc), asked = [];
  const got = await readModelsView({ paths, now: () => NOW, snapshot, reads: { status, records: () => [], cooldowns: async refs => { asked.push(...refs); return []; } } });
  assert.deepEqual(asked, ["p/main", "p/backup"]);
  assert.equal(got.roles.length, 2);
  assert.doesNotMatch(JSON.stringify(got), /triggers\.json|settings\.json/);
  const direct = files({ triggers: [entry()], modelRoles: { default: { editor: "p/main" } } });
  await readModelsView({ paths: direct, now: NOW, snapshot, reads: { status, records: () => [], cooldowns: () => assert.fail("non-failover job must not read a cooldown") } });
});

test("reader marks an incomplete MGET and a malformed overlay unknown, with no builtin routing fallback", async () => {
  const paths = files({ triggers: [entry({ model: "main" })] }, { version: 2, limits: [{ scope: "model:p/main", dayTokens: 1 }] });
  const got = await readModelsView({ paths, env: { PI_PROVIDER: "p", PI_MODEL: "main" }, now: NOW, snapshot, reads: { status, records: () => [], counters: async keys => { assert.deepEqual(keys, [dayKey(new Date(NOW), modelTokenKeyPrefix("p/main"))]); return []; } } });
  assert.equal(got.models[0].windows[0].spentTokens, null);
  assert.equal(got.models[0].windows[0].unavailable, true);
  assert.equal(got.models[0].state, "unknown");
  const unknown = await readModelsView({ paths, env: { PI_PROVIDER: "p", PI_MODEL: "main" }, now: NOW, snapshot, reads: { records: () => [], counters: async () => [null], overlay: async () => { throw new Error("secret catalog payload"); } } });
  assert.equal(unknown.models[0].known, null);
  assert.equal(unknown.models[0].priced, null);
  assert.equal(unknown.models[0].state, "unknown");
  assert.equal(modelsForAgent(unknown).models[0].reason, "catalog-unavailable");
  assert.doesNotMatch(JSON.stringify(unknown), /secret catalog payload/);
});

test("real model token rows retain their scope and spent counter through reader and agent projection", async () => {
  const paths = files({ triggers: [entry({ model: "main" })] }, { version: 2, limits: [{ scope: "model:p/main", dayTokens: 200000 }] });
  const got = await readModelsView({ paths, env: { PI_PROVIDER: "p", PI_MODEL: "main" }, now: NOW, snapshot, reads: {
    status, records: () => [], counters: async keys => { assert.deepEqual(keys, [dayKey(new Date(NOW), modelTokenKeyPrefix("p/main"))]); return ["123456"]; },
  } });
  const expected = { scope: "model:p/main", window: "day", capTokens: 200000, spentTokens: 123456, unavailable: false };
  assert.deepEqual(got.models[0].windows, [expected]);
  assert.deepEqual(modelsForAgent(got).models[0].windows, [expected]);
  assert.equal(got.models[0].state, "available");
});

test("invalid snapshot settings and unknown policy never claim ready routing or availability", async () => {
  const paths = files({ triggers: [entry()], modelRoles: { default: { editor: "p/main" } } });
  const got = await readModelsView({ paths, now: NOW, snapshot: { ...snapshot, settings: { invalid: "PRIVATE_SETTINGS_DIAGNOSTIC" } }, reads: { status, records: () => [] } });
  assert.equal(got.state, "unreadable");
  assert.ok(got.banners.some(banner => banner.kind === "configuration-unavailable"));
  assert.deepEqual(got.roles[0].next, { kind: "unknown", model: null, reason: "model-policy-unavailable" });
  assert.equal(got.models[0].state, "unknown");
  assert.doesNotMatch(JSON.stringify(got), /PRIVATE_SETTINGS_DIAGNOSTIC/);
  assert.deepEqual(modelsForAgent(got).roles[0].next, got.roles[0].next);
  const unknownOverlay = view({ modelRoles: { default: { editor: "p/main" } }, overlayUnknown: true });
  assert.equal(unknownOverlay.roles[0].next.kind, "unknown", "even a job without failover needs readable model policy");
  const unknownCooldown = view({ modelRoles: { default: { editor: "p/main" } }, cooldowns: null });
  assert.equal(unknownCooldown.models[0].state, "unknown");
  assert.deepEqual(unknownCooldown.roles[0].next, { kind: "direct", model: "p/main", reason: null }, "a job without fallbacks never consults cooldowns");
});

test("model projection preserves structured parity and omits doctor prose, commands, paths and injected extras", () => {
  const got = view({ records: [candidate(), original()], modelRoles: { default: { editor: "p/main" } }, snapshot: { ...snapshot, doctor: { hosts: [{ name: "host", checks: [{ id: "models.1", level: "ok", label: "private model instruction", proposal: { kind: "newer-sibling", scope: "default", role: "editor", model: "p/main", candidate: "p/candidate" } }] }] } } });
  got.path = "/private/path"; got.command = "do private work"; got.canaries[0].rows[0].candidate.prompt = "private prompt";
  const projected = modelsForAgent(got), text = JSON.stringify(projected);
  assert.equal(projected.roles[0].model, got.roles[0].model);
  assert.deepEqual(projected.canaries[0].candidateStats, got.canaries[0].candidateStats);
  assert.equal(projected.proposals[0].candidate, "p/candidate");
  assert.doesNotMatch(text, /private model instruction|private\/path|do private|private prompt|whatIf|suggestedCapUsd/);
});

test("machine model reasons retain the shared failover verdicts and reject arbitrary or misplaced diagnostic text", () => {
  const overlay = { providers: { custom: { api: "openai-completions", baseUrl: "https://models.example/v1", compat: { maxTokensField: "max_tokens" }, models: [
    { id: "missing-fallback", cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, compat: { allowedFallbackModels: ["secondary"] } },
    { id: "unpriced", api: "pi-messages", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
  ] } } };
  const got = modelsViewOf({ now: NOW, overlay, deployment, snapshot, entries: [], modelRoles: { default: { unknown: "custom/unknown", missing: "custom/missing-fallback", unpriced: "custom/unpriced" } } });
  assert.deepEqual(modelsForAgent(got).models.map(row => row.reason), ["model-unknown", "model-not-allowed", "model-unpriced"]);
  const privateText = "PRIVATE_MODEL_DIAGNOSTIC";
  got.models.push({ ref: "p/main", provider: "p", state: "unknown", reason: privateText, label: privateText, windows: [] });
  got.banners = [
    { kind: "role-conflict", reason: privateText, label: privateText, fix: privateText, projectUnknown: privateText },
    { kind: "role-conflict", reason: "cost-cap" },
    { kind: "constructor", reason: "model-role-unknown" },
    { kind: "radius-cost-cap", reason: "cost-cap" },
    { kind: "configuration-unavailable", reason: "model-roles-invalid" },
    { kind: "catalog-unavailable", reason: "model-unknown" },
    { kind: "cooldowns-unavailable", reason: "model-cooldown" },
  ];
  const projected = modelsForAgent(got);
  assert.equal(projected.models.at(-1).reason, null);
  assert.deepEqual(projected.banners.map(row => [row.kind, row.reason]), [["role-conflict", null], ["role-conflict", null], ["unknown", null], ["unknown", null], ["configuration-unavailable", "model-roles-invalid"], ["catalog-unavailable", "model-unknown"], ["cooldowns-unavailable", "model-cooldown"]]);
  assert.equal(projected.banners[0].projectUnknown, false);
  assert.ok(!JSON.stringify(projected).includes(privateText));
});

test("a console cannot infer a remote local folder's project from an unresolved path spelling", () => {
  const projects = [{ id: "web", members: ["/srv/web"] }, { id: "api", members: ["/srv/api"] }, { id: "forge", members: ["github:acme/forge"] }];
  const got = view({ entries: [entry({ kind: "local", folder: "/console-alias", model: "role:editor" })], modelRoles: { default: { editor: "p/main" }, web: { editor: "p/web" }, api: { editor: "p/api" } }, projects, resolveFolder: () => { throw new Error("remote folder"); } });
  assert.deepEqual(got.roles.flatMap(role => role.triggers.map(trigger => [trigger.project, trigger.projectUnknown])), [[null, true], ["api", true], ["web", true]]);
  const projected = modelsForAgent(got);
  assert.deepEqual(projected.roles.flatMap(role => role.triggers.map(trigger => [trigger.project, trigger.projectUnknown])), [[null, true], ["api", true], ["web", true]]);
  assert.ok(projected.roles.flatMap(role => role.fallbackGroups.flatMap(group => group.triggers)).every(trigger => trigger.projectUnknown === true));
  assert.match(got.coverage.notes.join(" "), /local folder could not be resolved.*possible project scopes/);
  const resolved = view({ entries: [entry({ kind: "local", folder: "/console-alias", model: "role:editor" })], modelRoles: { default: { editor: "p/main" }, web: { editor: "p/web" } }, projects, resolveFolder: () => "/srv/web" });
  assert.deepEqual(resolved.roles.flatMap(role => role.triggers.map(trigger => trigger.project)), ["web"]);
  assert.equal(modelsForAgent(resolved).roles[1].triggers[0].projectUnknown, false);
  const conflict = view({ entries: [entry({ kind: "local", folder: "/console-alias", provider: "p", model: "role:editor" })], modelRoles: { default: { editor: "p/main" }, web: { editor: "other/web" } }, projects, resolveFolder: () => { throw new Error("remote folder"); } });
  assert.deepEqual(modelsForAgent(conflict).banners.map(banner => [banner.reason, banner.project, banner.projectUnknown]), [["model-role-provider-conflict", "web", true]]);
  const trigger = got.roles[0].triggers[0];
  trigger.projectUnknown = "PRIVATE_TRUTHY_DIAGNOSTIC";
  assert.equal(modelsForAgent(got).roles[0].triggers[0].projectUnknown, false);
  assert.ok(!JSON.stringify(modelsForAgent(got)).includes("PRIVATE_TRUTHY_DIAGNOSTIC"));
});
