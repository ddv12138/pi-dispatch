import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers/temp-dir.mjs";
import { modelRunRecord } from "../src/read-model.mjs";
import { stateOf } from "../src/console/live.mjs";
import { agentReadProjection } from "../src/agent-read.mjs";
import { NEWER_RECORD_MODEL_NOTE } from "../src/newer-release.mjs";
import { RECORD_CORE_FIELDS, sanitizeJobId } from "@edgehero/pi-dispatch/run-history";

/**
 * A run record's `reason` leaves the admin only as a token (issue #737): every reader that hands a record's reason out of
 * this process (the model-callable `dispatch_runs`, `/api/state`) goes through words.mjs `recordReason`, so
 * an older worker's free text (a forge's API path, an internal address, a bidi override) reaches no model, no script and
 * no terminal. A token is handed out as it is, and a record whose reason is a token or none is the record as it was.
 * The same projection lets through this build's own sentences beside a record a newer pi-dispatch wrote (issue #761),
 * the one `dispatch_runs` gives among them, and no other note.
 */
const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = piRequire("jiti");
const jiti = createJiti(import.meta.url);


const FREE = ["GET /repos/acme/secret failed", "connect ECONNREFUSED 10.0.0.7:6379", "host\u202eevil", "Not-A-Token", "x".repeat(65)];
const record = (jobId, reason) => ({ jobId, kind: "github", target: "acme/web#1", flow: "fix", outcome: "failed", reason, startedAt: "2026-10-20T10:00:00.000Z", endedAt: "2026-10-20T10:05:00.000Z" });
const leaks = (text) => FREE.filter((f) => text.includes(f) || text.includes(JSON.stringify(f).slice(1, -1)));

test("modelRunRecord hands a model a record's reason only when it is a token, and a record whose reason is one as it is", () => {
  for (const reason of FREE) {
    for (const list of [false, true]) {
      const out = modelRunRecord(record("gh-1", reason), { list });
      assert.equal(out.reason, null, `${JSON.stringify(reason)}${list ? " (a list)" : ""}`);
      assert.equal(out.jobId, "gh-1", "the rest of the record is its own");
    }
  }
  for (const reason of ["container-lost", null]) {
    const rec = record("gh-2", reason);
    assert.equal(modelRunRecord(rec), rec, `${reason}: the same object`);
  }
  const bare = { jobId: "gh-3", outcome: "completed" };
  assert.equal(modelRunRecord(bare), bare, "a record with no reason field is left without one");
});





test("the day's refusals handed out with /api/state carry reason tokens only", async () => {
  // The day's refusals, the one list of reasons the state document carries.
  const top = [...FREE.map((reason) => ({ reason, count: 2 })), { reason: "scope-cap", count: 1 }];
  for (const role of ["operator", "viewer"]) {
    const state = stateOf({ refusals24h: { count: 11, top } }, role, { now: 1 });
    assert.deepEqual(leaks(JSON.stringify(state)), [], `/api/state, ${role}`);
    assert.deepEqual(state.refusals24h, { count: 11, top: [{ reason: "scope-cap", count: 1 }] });
  }
});

test("modelRunRecord rebuilds failover facts for model reads and lists (#716)", async () => {
  const { MODEL_WHY, PROVIDER_FAILURE_KINDS } = await import("@edgehero/pi-dispatch/model-failover-protocol");
  for (const list of [false, true]) {
    for (const modelWhy of MODEL_WHY) for (const kind of PROVIDER_FAILURE_KINDS) {
      const out = modelRunRecord({ jobId: "gh-1", modelWhy, providerFailure: { kind, resetAt: 1234, message: "PRIVATE-PROVIDER-ERROR" } }, { list });
      assert.equal(out.modelWhy, modelWhy);
      assert.deepEqual(out.providerFailure, { kind, resetAt: 1234 });
      assert.equal(JSON.stringify(out).includes("PRIVATE-PROVIDER-ERROR"), false);
    }
    for (const providerFailure of ["PRIVATE-PROVIDER-ERROR", { kind: "PRIVATE-PROVIDER-ERROR" }, { kind: "rate-limited", resetAt: -1 }, { kind: "rate-limited", resetAt: "123" }]) {
      const out = modelRunRecord({ jobId: "gh-1", modelWhy: "PRIVATE-PROVIDER-ERROR", providerFailure }, { list });
      assert.equal(out.modelWhy, undefined);
      assert.equal(out.providerFailure, undefined);
      assert.equal(JSON.stringify(out).includes("PRIVATE-PROVIDER-ERROR"), false);
    }
  }
});
