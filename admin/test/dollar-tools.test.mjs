import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTriggerEntry } from "../src/write-plans.mjs";
import { readScopedBudget } from "../src/read-model.mjs";

test("the add builder never carries maxCostUsd or models, whatever it is handed", () => {
  for (const kind of ["cron", "label", "comment", "pull_request", "issue"]) {
    const entry = buildTriggerEntry(kind, { flow: "fix", id: "n", pattern: "0 3 * * *", folder: "/srv/x", task: "t", labels: ["bug"], phrase: "@pi", action: ["opened"], maxCostUsd: "0.10", models: ["a/b"] });
    assert.ok(!("maxCostUsd" in entry.run) && !("models" in entry.run), `${kind}: ${JSON.stringify(entry.run)}`);
  }
});

test("readScopedBudget swallows ioredis error events too", async () => {
  const events = [];
  const fake = { on: (ev) => events.push(ev), async get() { return "1"; }, disconnect() {} };
  const out = await readScopedBudget({ url: "redis://127.0.0.1:1", limits: [{ scope: "acme/web", day: 3 }], redisFn: () => fake });
  assert.deepEqual(out, { rows: [{ day: 1 }] });
  assert.deepEqual(events, ["error"]);
});
