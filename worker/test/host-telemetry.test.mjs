import assert from "node:assert/strict";
import { test } from "node:test";
import { parseBudgetFrom, parseCpuReserve } from "../src/host-telemetry.mjs";
import { computeHostBudget } from "../src/host-budget.mjs";

// The retained-workspace inventory (makeSandboxTelemetry/parseSandboxes) went with the sandbox prune; what stays
// pinned is the budget and CPU-quota publication the Fleet page renders.

test("registry telemetry parsers reject malformed data without carrying arbitrary keys", () => {
	for (const raw of [undefined, "", "{", "x".repeat(40_000), {}]) {
		assert.equal(parseBudgetFrom(raw), null);
		assert.equal(parseCpuReserve(raw), null);
	}
	const detail = computeHostBudget({ memory: { mode: "auto" }, cpus: { mode: "auto" }, reserveMemory: { mode: "auto" }, reserveCpus: { mode: "auto" } }, { memTotalMiB: 32768, hostCpus: 8 }).detail;
	assert.deepEqual(parseBudgetFrom(JSON.stringify({ ...detail, path: "/private" })), detail);
	assert.equal(parseBudgetFrom({ ...detail, cpuReserveCenti: -1 }), null);
	assert.equal(parseBudgetFrom({ ...detail, memMode: "guess" }), null);
});

test("CPU quota publication preserves held, absent and wrong-quota states, never paths or runtime errors", () => {
	const statuses = ["held", "no-parent", "unmanaged", "budget-unknown", "unreadable", "unset", "differs"];
	for (const status of statuses) {
		assert.deepEqual(parseCpuReserve([{ venue: "local", status, wantCenti: 400, quotaCenti: 200, path: "/sys/private", reason: "secret" }]), [{ venue: "local", status, wantCenti: 400, quotaCenti: 200 }]);
	}
	assert.deepEqual(parseCpuReserve([{ venue: "local", status: "differs", wantCenti: null, quotaCenti: 200 }]), [{ venue: "local", status: "differs", wantCenti: null, quotaCenti: 200 }]);
	assert.deepEqual(parseCpuReserve([{ venue: "local", status: "invented" }, { venue: "unknown", status: "held" }]), []);
});
