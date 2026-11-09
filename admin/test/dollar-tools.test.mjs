import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTriggerEntry } from "../src/write-plans.mjs";
import { readScopedBudget } from "../src/read-model.mjs";

// The admin extension is retired on this tree (the operator console is the only surface), so the model-callable
// token surfaces this file once tested through index.ts are gone; what survives is the pre-confirm half every
// writer shares (write-plans.mjs) and the read model. The same assertions the extension tests held now pin them:
// the add builder never carries the per-job token cap or the model list, whatever it is handed (the tools refuse
// both; the trigger tools' rules live in the worker's triggers-plan tests).
test("the add builder never carries maxTokens or models, whatever it is handed", () => {
  for (const kind of ["cron", "label", "comment", "pull_request", "issue"]) {
    const entry = buildTriggerEntry(kind, { flow: "fix", id: "n", pattern: "0 3 * * *", folder: "/srv/x", task: "t", labels: ["bug"], phrase: "@pi", action: ["opened"], maxTokens: 100000, models: ["a/b"] });
    assert.ok(!("maxTokens" in entry.run) && !("models" in entry.run), `${kind}: ${JSON.stringify(entry.run)}`);
  }
});

test("readScopedBudget swallows ioredis error events too", async () => {
  const events = [];
  const fake = { on: (ev) => events.push(ev), async get() { return "1"; }, disconnect() {} };
  const out = await readScopedBudget({ url: "redis://127.0.0.1:1", limits: [{ scope: "acme/web", dayTokens: 3 }], redisFn: () => fake });
  assert.deepEqual(out, { rows: [{ tokensUsed: { day: 1 } }] });
  assert.deepEqual(events, ["error"]);
});
