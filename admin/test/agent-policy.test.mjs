import assert from "node:assert/strict";
import { test } from "node:test";
import { ACTIONS } from "../src/console/actions.mjs";
import { ACTION_AGENT_POLICIES, actionAgentPolicy, authorizeTransition, evaluateAgentAction } from "../src/action-policy.mjs";
import { agentReadProjection } from "../src/agent-read.mjs";
import { paidStartEnvironment } from "../src/agent-starts.mjs";

const agent = { role: "agent", name: "controller" };
const mode = (action, transition) => evaluateAgentAction(action, transition).mode;
test("every action has an explicit policy with a reason and non-person actions have a tool", () => {
  for (const action of ACTIONS) {
    assert.ok(Object.hasOwn(ACTION_AGENT_POLICIES, action.name), action.name);
    assert.deepEqual(action.agent, actionAgentPolicy(action.name));
    assert.ok(action.agent.reason.length > 15);
    if (action.agent.mode !== "person") assert.ok(action.agent.tools.length, action.name);
  }
  assert.throws(() => actionAgentPolicy("new-action-without-review"), /no explicit/);
});

test("only actual explicit decreases of the surviving settings authorize a setting write", () => {
  for (const [key, old, next] of [["concurrency", 3, 2], ["maxTurns", 30, 20]]) {
    const transition = { before: { [key]: old, provider: "fixed" }, after: { [key]: next, provider: "fixed" } };
    assert.equal(mode("setting-set", transition), "unattended", key);
    assert.equal(mode("setting-set", { before: transition.after, after: transition.before }), "confirm", `${key} raise`);
    assert.equal(mode("setting-set", { before: {}, after: { [key]: next } }), "confirm", `${key} inherited`);
    assert.equal(mode("setting-set", { before: transition.before, after: {} }), "confirm", `${key} unset`);
    assert.equal(mode("setting-set", { ...transition, after: { ...transition.after, provider: "changed" } }), "confirm", `${key} mixed`);
  }
  for (const value of [null, NaN, Infinity, "10", {}, -1]) assert.equal(mode("setting-set", { before: { maxTurns: value }, after: { maxTurns: 1 } }), "confirm");
  // A count is a whole number: a value that is not one cannot prove a decrease, so the operator confirms.
  assert.equal(mode("setting-set", { before: { maxTurns: 30 }, after: { maxTurns: "20" } }), "confirm", "a string cannot prove a decrease");
  for (const value of [NaN, Infinity, 0.5, "20", null, -1]) assert.equal(mode("setting-set", { before: { maxTurns: 30 }, after: { maxTurns: value } }), "confirm", String(value));
  // The retired token caps are no writer's business: a delete is not a decrease, every direction confirms.
  for (const key of ["maxTokens", "dailyTokenCap", "weeklyTokenCap", "monthlyTokenCap"]) {
    for (const [a, b] of [[{ [key]: 200 }, { [key]: 100 }], [{ [key]: 200 }, {}], [{}, { [key]: 100 }]]) assert.equal(mode("setting-set", { before: a, after: b }), "confirm", key);
  }
});

test("scoped edits preserve scope, size, minima and every unedited row", () => {
  const before = { version: 3, limits: [{ scope: "project:alpha", concurrent: 3, hostShare: 50, memory: "2g", minJobs: 1 }, { scope: "project:beta", concurrent: 2 }] };
  const edited = { ...before, limits: [{ ...before.limits[0], concurrent: 2, hostShare: 40 }, before.limits[1]] };
  assert.equal(mode("limit-edit", { before, after: edited, plan: { index: 0 } }), "unattended");
  // A retired token limit is not a decrease this policy can authorize.
  assert.equal(mode("limit-edit", { before: { version: 2, limits: [{ scope: "acme/web", dayTokens: 2_000_000 }] }, after: { version: 2, limits: [{ scope: "acme/web", dayTokens: 1_999_999 }] }, plan: { index: 0 } }), "confirm");
  for (const change of [{ scope: "project:other" }, { memory: "4g" }, { minJobs: 2 }, { day: 1 }, { week: 5 }, { dayTokens: 1 }]) {
    const after = { ...edited, limits: [{ ...edited.limits[0], ...change }, edited.limits[1]] };
    assert.equal(mode("limit-edit", { before, after, plan: { index: 0 } }), "confirm");
  }
  assert.equal(mode("limit-edit", { before, after: { ...edited, limits: [edited.limits[0], { ...edited.limits[1], concurrent: 1 }] }, plan: { index: 0 } }), "confirm");
  const base = { version: 3, limits: [] };
  assert.equal(mode("limit-add", { before: base, after: { ...base, limits: [{ scope: "project:alpha", concurrent: 1 }] } }), "unattended");
  for (const extra of [{ minJobs: 1 }, { memory: "2g" }, { cpus: "1" }, { unknown: true }, { dayTokens: 1 }]) assert.equal(mode("limit-add", { before: base, after: { ...base, limits: [{ scope: "project:alpha", concurrent: 1, ...extra }] } }), "confirm");
});

test("flag-only edits do not carry a hidden flow, model, turn, scope or rule change", () => {
  const before = { triggers: [{ on: { type: "comment", phrase: "please" }, run: { flow: "review", recover: true, steer: true, maxTurns: 40 } }], answerRules: [{ id: "manual" }] };
  const after = { ...before, triggers: [{ ...before.triggers[0], run: { ...before.triggers[0].run, recover: false, steer: false } }] };
  assert.equal(mode("trigger-edit", { before, after, plan: { index: 0 } }), "unattended");
  for (const changed of [{ flow: "other" }, { model: "new" }, { maxTurns: 20 }, { progress: false }]) {
    assert.equal(mode("trigger-edit", { before, after: { ...after, triggers: [{ ...after.triggers[0], run: { ...after.triggers[0].run, ...changed } }] }, plan: { index: 0 } }), "confirm");
  }
  assert.equal(mode("trigger-edit", { before, after: { ...after, answerRules: [] }, plan: { index: 0 } }), "confirm");
});

test("agent API and headless tools share refusal semantics; persona cannot grant authority", () => {
  for (const action of ["fleet-resume", "retry-failed", "trigger-add", "parked-answer", "standing-answer-add", "answer-draft-drop", "sandbox-prepare", "model-role-edit"]) {
    for (const surface of ["api", "tool"]) assert.equal(authorizeTransition({ actor: agent, action, surface, granted: true, transition: { persona: { approved: true }, safe: true } }).ok, false, action);
  }
  assert.equal(authorizeTransition({ actor: agent, action: "fleet-pause", surface: "tool" }).ok, false);
  assert.equal(authorizeTransition({ actor: agent, action: "fleet-pause", surface: "tool", granted: true }).ok, true);
  assert.equal(authorizeTransition({ actor: { role: "viewer" }, action: "fleet-pause" }).ok, false);
  assert.equal(authorizeTransition({ actor: { role: "operator" }, action: "fleet-resume", surface: "tool", interactive: true }).ok, true);
  assert.equal(authorizeTransition({ actor: { role: "operator" }, action: "parked-answer", surface: "tool", interactive: true }).ok, false);
  assert.equal(authorizeTransition({ actor: agent, action: "setting-set", transition: { before: { dailyCap: 3 }, after: { dailyCap: 4 } } }).ok, false, "Undo of lowering is a raise");
});

test("agent reads rebuild counts and identifiers while unknown prose and private context are withheld", () => {
  const privateText = "PRIVATE_CONTEXT_CANARY_42";
  const projected = agentReadProjection({ run: { jobId: "gh-1", turns: 2, reason: "model-unknown", note: privateText, task: privateText, futureProse: privateText }, bundle: { id: "shared", variables: [privateText], placeholderNames: [privateText] }, privateDraft: { draft: privateText }, answerRules: [{ id: privateText }], progress: { note: privateText } });
  assert.deepEqual(projected, { run: { jobId: "gh-1", turns: 2, reason: "model-unknown" }, bundle: { id: "shared", variablesCount: 1, placeholderNamesCount: 1 } });
  assert.ok(!JSON.stringify(projected).includes(privateText));
});

test("paid grants are process-owned and both must be explicit", () => {
  const deployment = { PI_DISPATCH_RUN_ROOTS: "/allowed", PI_DISPATCH_RUN_PER_HOUR: "9" };
  assert.ok(paidStartEnvironment(deployment, {}).refusal);
  assert.ok(paidStartEnvironment(deployment, { PI_DISPATCH_RUN_ROOTS: "/allowed" }).refusal);
  assert.ok(paidStartEnvironment(deployment, { PI_DISPATCH_RUN_ROOTS: "/allowed", PI_DISPATCH_RUN_PER_HOUR: "Infinity" }).refusal);
  assert.equal(paidStartEnvironment(deployment, { PI_DISPATCH_RUN_ROOTS: "/process", PI_DISPATCH_RUN_PER_HOUR: "2" }).env.PI_DISPATCH_RUN_ROOTS, "/process");
});
