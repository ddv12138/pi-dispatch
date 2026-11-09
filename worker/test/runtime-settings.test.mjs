import assert from "node:assert/strict";
import { dirname } from "node:path";
import { test } from "node:test";
import { defaultSettingsFile } from "../src/config.mjs";
import { KNOWN_KEYS, effectiveSettings, readOverlay, resolveSettings, settingsFilePath, writeOverlay } from "../src/runtime-settings.mjs";

/**
 * A fake fs exposing only what the overlay module touches, with an ordered `ops` log so a test can
 * assert the write sequence (mkdir -> write tmp -> rename). Read side: `readFile` is the string
 * `readFileSync` returns; `readError` (a `{ code }`) makes it throw so the ENOENT-vs-other split is
 * testable. Write side: `mkdirThrows`/`writeThrows` exercise the never-throw posture, and
 * `renameErrors` is a list of `{ code }` thrown on successive `renameSync` calls -- `[{code:"EPERM"}]`
 * is the retry-once-then-succeed case, `[{code:"EPERM"},{code:"EPERM"}]` the retry-then-fail case.
 */
function makeFakeFs({ readFile = null, readError = null, mkdirThrows = false, writeThrows = false, renameErrors = [] } = {}) {
	const ops = [];
	let renameCall = 0;
	function fail(code, message) {
		const err = new Error(message ?? code);
		err.code = code;
		return err;
	}
	return {
		ops,
		readFileSync(path, enc) {
			ops.push({ op: "read", path, enc });
			if (readError) throw fail(readError.code, readError.message);
			return readFile;
		},
		mkdirSync(path, options) {
			ops.push({ op: "mkdir", path, options });
			if (mkdirThrows) throw fail("EACCES", "mkdir failed");
		},
		writeFileSync(path, data) {
			if (writeThrows) throw fail("ENOSPC", "write failed");
			ops.push({ op: "write", path, data });
		},
		renameSync(from, to) {
			ops.push({ op: "rename", from, to });
			const err = renameErrors[renameCall++];
			if (err) throw fail(err.code, err.message);
		},
	};
}

function readObj(obj, log = () => {}) {
	return readOverlay("/s/settings.json", { fs: makeFakeFs({ readFile: JSON.stringify(obj) }), log });
}

function readRaw(text, log = () => {}) {
	return readOverlay("/s/settings.json", { fs: makeFakeFs({ readFile: text }), log });
}

// ---- readOverlay: missing vs unreadable (the fail-closed distinction) ----

test("readOverlay: a missing file (ENOENT) is a normal empty overlay", () => {
	const res = readOverlay("/s/settings.json", { fs: makeFakeFs({ readError: { code: "ENOENT" } }) });
	assert.deepEqual(res, { overlay: {} });
});

test("readOverlay: an EACCES read error fails closed as invalid, distinct from ENOENT", () => {
	const enoent = readOverlay("/s/settings.json", { fs: makeFakeFs({ readError: { code: "ENOENT" } }) });
	const eacces = readOverlay("/s/settings.json", { fs: makeFakeFs({ readError: { code: "EACCES" } }) });
	assert.ok("overlay" in enoent && !("invalid" in enoent), "ENOENT -> empty overlay");
	assert.ok("invalid" in eacces && !("overlay" in eacces), "present-but-unreadable -> invalid, NOT an empty overlay");
});

// ---- readOverlay: parse / root shape ----

test("readOverlay: unparseable JSON is invalid", () => {
	const res = readRaw("{not valid json");
	assert.ok(res.invalid);
});

test("readOverlay: a non-object root (array, string, null) is invalid", () => {
	for (const text of ["[]", '"a string"', "null", "42"]) {
		assert.ok(readRaw(text).invalid, `root ${text} must be invalid`);
	}
});

// ---- readOverlay: each known key ----

test("readOverlay: valid known keys are accepted and returned as the overlay", () => {
	const obj = { model: "claude-x", provider: "anthropic", maxTurns: 12, concurrency: 5 };
	assert.deepEqual(readObj(obj), { overlay: obj });
});

test("readOverlay: the retired job-start caps are refused by name, never dropped as unknown", () => {
	for (const key of ["dailyCap", "weeklyCap", "monthlyCap", "softHoldPct"]) {
		for (const value of [5, 0, 100, "80", null]) {
			const res = readObj({ [key]: value });
			assert.deepEqual(res, { invalid: `${key} was retired with the job-start caps; delete it from the settings file` }, `${key}=${JSON.stringify(value)}`);
		}
	}
});

// ---- the retired token keys (C2) ----

test("readOverlay: every token budget key is refused by name with the removal, never dropped as unknown", () => {
	for (const key of ["maxTokens", "dailyTokenCap", "weeklyTokenCap", "monthlyTokenCap"]) {
		for (const value of [2500, 0, "2500", null, true, [], {}]) {
			assert.deepEqual(
				readObj({ [key]: value }),
				{ invalid: `${key} was retired with the token budgets; delete it from the settings file` },
				`${key}=${JSON.stringify(value)}`,
			);
		}
	}
	// The whole overlay is refused, never partially applied.
	assert.ok(readObj({ maxTokens: 5, concurrency: 3 }).invalid);
});

test("readOverlay: a token or cap key near miss (env name, snake case, look-alikes) is refused by name, never dropped", () => {
	for (const [key, meant, removal] of [
		["PI_MAX_TOKENS", "maxTokens", "token budgets"], ["tokensTotal", "maxTokens", "token budgets"], ["TOTAL_TOKENS", "maxTokens", "token budgets"],
		["PI_DAILY_TOKEN_CAP", "dailyTokenCap", "token budgets"], ["pi.daily.token.cap", "dailyTokenCap", "token budgets"],
		["PI_WEEKLY_TOKEN_CAP", "weeklyTokenCap", "token budgets"], ["PI_MONTHLY_TOKEN_CAP", "monthlyTokenCap", "token budgets"],
		["PI_DAILY_CAP", "dailyCap", "job-start caps"], ["pi_daily_cap", "dailyCap", "job-start caps"], ["daily_cap", "dailyCap", "job-start caps"],
		["PI_WEEKLY_CAP", "weeklyCap", "job-start caps"], ["weekly_cap", "weeklyCap", "job-start caps"],
		["PI_MONTHLY_CAP", "monthlyCap", "job-start caps"], ["monthly_cap", "monthlyCap", "job-start caps"],
		["PI_SOFT_HOLD_PCT", "softHoldPct", "job-start caps"], ["soft_hold_pct", "softHoldPct", "job-start caps"],
	]) {
		const res = readObj({ [key]: 2 });
		assert.equal(res.invalid, `${key} is not a settings key: ${meant} was retired with the ${removal}; delete it from the settings file`, key);
	}
	// An unknown key that is not an exact shape match is still dropped and logged.
	const logged = [];
	assert.deepEqual(readObj({ maxTokensx: 1, concurrency: 3 }, (event, fields) => logged.push([event, fields])), { overlay: { concurrency: 3 } });
	assert.deepEqual(logged, [["settings_overlay_unknown_key", { key: "maxTokensx" }]]);
});

test("readOverlay: a duplicate key is refused, naming the key and never a value (#501)", () => {
	const res = readRaw('{"maxTurns":"1","maxTurns":"999"}');
	assert.match(res.invalid, /^settings file has a duplicate key "maxTurns"/);
	assert.equal(res.invalid.includes("999"), false);
	assert.match(readRaw('{"concurrency":1,"concurrency":2}').invalid, /duplicate key "concurrency"/);
	// A file writeOverlay wrote never has one: it serialises an object.
	const fs = makeFakeFs();
	writeOverlay("/s/settings.json", { maxTurns: 1, concurrency: 2 }, { fs });
	const written = fs.ops.find((o) => o.op === "write").data;
	assert.deepEqual(readRaw(written), { overlay: { maxTurns: 1, concurrency: 2 } });
});

test("writeOverlay: a retired token key is refused at the WRITE and nothing is touched", () => {
	for (const key of ["maxTokens", "dailyTokenCap", "weeklyTokenCap", "monthlyTokenCap"]) {
		const fs = makeFakeFs();
		assert.deepEqual(writeOverlay("/s/settings.json", { [key]: 2 }, { fs }), { invalid: `${key} was retired with the token budgets; delete it from the settings file` });
		assert.deepEqual(fs.ops, [], "nothing touched");
	}
});

test("resolveSettings: a retired token key in the overlay is invalid, and no cross-key token rule is left", () => {
	const config = { provider: "p", model: "m", maxTurns: 30, concurrency: 3 };
	// validateOverlay already refused the file; resolveSettings passes that refusal through, whole.
	assert.deepEqual(resolveSettings(config, { invalid: "maxTokens was retired with the token budgets; delete it from the settings file" }), { invalid: "maxTokens was retired with the token budgets; delete it from the settings file" });
});

// Issue #673: the overlay's model and provider are held to the trigger's id shape, at the write (every admin surface
// writes through writeOverlay) and at the read (a bad value already on disk makes the overlay invalid, the loud path).
test("model and provider outside the id shape are refused at the write and at the read, naming the shape, never the value; catalog ids pass, case kept (#673)", async () => {
	const { listPricedModels } = await import("../src/pricing.mjs");
	const priced = listPricedModels();
	const MODEL_SAYS = "model must be a model id of 1 to 64 characters: letters, digits and . _ - : / @, starting with a letter or digit (or ~ or @ then one)";
	const PROVIDER_SAYS = "provider must be a provider id of 1 to 64 characters: letters, digits, dot, dash and underscore, starting with a letter or digit";
	const cases = [
		...["", "Claude Sonnet", "a+b", "x".repeat(65), "a~b", 7].map((value) => ({ obj: { model: value }, says: MODEL_SAYS })),
		...["", "Open AI", "a+b", "x".repeat(65), "a~b", "a/b"].map((value) => ({ obj: { provider: value }, says: PROVIDER_SAYS })),
	];
	for (const { obj, says } of cases) {
		assert.deepEqual(readObj(obj), { invalid: says }, `read ${JSON.stringify(obj)}`);
		const fs = makeFakeFs();
		assert.deepEqual(writeOverlay("/s/settings.json", obj, { fs }), { invalid: says }, `write ${JSON.stringify(obj)}`);
		assert.equal(fs.ops.length, 0, "nothing is written");
	}
	const models = [...new Set(priced.map((m) => m.id))];
	assert.ok(models.some((id) => id !== id.toLowerCase()), "an uppercase catalog id is walked");
	for (const id of models) assert.deepEqual(readObj({ model: id }), { overlay: { model: id } }, `model ${id}`);
	for (const id of new Set(priced.map((m) => m.provider))) assert.deepEqual(readObj({ provider: id }), { overlay: { provider: id } }, `provider ${id}`);
});

// ---- readOverlay: unknown keys ----

test("readOverlay: an unknown key is dropped and logged, known keys still apply, file stays valid", () => {
	const events = [];
	const res = readObj({ model: "claude-x", frobnicate: "yes" }, (event, fields) => events.push({ event, fields }));
	assert.deepEqual(res, { overlay: { model: "claude-x" } }, "unknown key excluded, known key kept");
	const unknown = events.find((e) => e.event === "settings_overlay_unknown_key");
	assert.ok(unknown, "unknown key is logged");
	assert.equal(unknown.fields.key, "frobnicate");
});

// ---- readOverlay: never throws ----

test("readOverlay never throws across the nasty corpus", () => {
	const fakes = [
		makeFakeFs({ readError: { code: "ENOENT" } }),
		makeFakeFs({ readError: { code: "EACCES" } }),
		makeFakeFs({ readError: { code: "EISDIR" } }),
		makeFakeFs({ readError: { code: undefined } }),
		makeFakeFs({ readFile: "{not json" }),
		makeFakeFs({ readFile: "[]" }),
		makeFakeFs({ readFile: "null" }),
		makeFakeFs({ readFile: JSON.stringify({ maxTurns: -1 }) }),
		makeFakeFs({ readFile: JSON.stringify({ model: 5 }) }),
		makeFakeFs({ readFile: JSON.stringify({ concurrency: 50 }) }),
		makeFakeFs({ readFile: JSON.stringify({ unknown: 1 }) }),
	];
	for (const fs of fakes) {
		assert.doesNotThrow(() => readOverlay("/s/settings.json", { fs }));
	}
});

// ---- effectiveSettings ----

// FOUR since C2 removed every token budget: the known keys are the four settings the overlay governs, and the key
// set is still exact. An empty overlay still returns the config verbatim.
test("effectiveSettings: overlay wins where set, config fills the rest, result has exactly four keys", () => {
	const config = { provider: "anthropic", model: "cfg-model", maxTurns: 30, concurrency: 3, valkeyUrl: "x", jobImage: "y" };
	const res = effectiveSettings(config, { model: "ovl-model", maxTurns: 12 });
	assert.equal(res.model, "ovl-model", "overlay wins");
	assert.equal(res.maxTurns, 12, "overlay wins");
	assert.equal(res.provider, "anthropic", "absent overlay key falls to config");
	assert.equal(res.concurrency, 3, "absent overlay key falls to config");
	assert.deepEqual(Object.keys(res).sort(), ["concurrency", "maxTurns", "model", "provider"]);
	assert.equal("maxTokens" in res, false, "C2: no token budget is resolved");
});

test("effectiveSettings: an empty overlay yields the config values verbatim for all four keys", () => {
	const config = { provider: "anthropic", model: "cfg-model", maxTurns: 30, concurrency: 3 };
	assert.deepEqual(effectiveSettings(config, {}), config);
});

// ---- writeOverlay ----

test("writeOverlay: happy path ensures the dir, writes a same-dir tmp, then renames over the target", () => {
	const fs = makeFakeFs();
	const res = writeOverlay("/s/settings.json", { model: "m", concurrency: 4 }, { fs });
	assert.deepEqual(res, { ok: true });

	const seq = fs.ops.map((o) => o.op);
	assert.deepEqual(seq, ["mkdir", "write", "rename"], "order is mkdir -> write -> rename");

	const mkdir = fs.ops.find((o) => o.op === "mkdir");
	assert.equal(mkdir.options.recursive, true, "mkdirSync is recursive");

	const write = fs.ops.find((o) => o.op === "write");
	// Issue #642: a tmp file of its own (pid and random), no longer the shared `<path>.tmp` two writers could collide on.
	assert.match(write.path, new RegExp(`^/s/settings\\.json\\.${process.pid}\\.[0-9a-f]{12}\\.tmp$`), "tmp is the target + pid + random + .tmp");
	assert.equal(dirname(write.path), dirname("/s/settings.json"), "tmp is a same-directory sibling");
	assert.equal(write.data, `${JSON.stringify({ model: "m", concurrency: 4 }, null, 2)}\n`, "2-space indent + trailing newline");

	const rename = fs.ops.find((o) => o.op === "rename");
	assert.equal(rename.from, write.path);
	assert.equal(rename.to, "/s/settings.json");
});

test("writeOverlay: an empty candidate is valid and writes {}", () => {
	const fs = makeFakeFs();
	const res = writeOverlay("/s/settings.json", {}, { fs });
	assert.deepEqual(res, { ok: true });
	assert.equal(fs.ops.find((o) => o.op === "write").data, "{}\n");
});

test("writeOverlay: EPERM on rename is retried once and then succeeds", () => {
	const fs = makeFakeFs({ renameErrors: [{ code: "EPERM" }] });
	const res = writeOverlay("/s/settings.json", { model: "m" }, { fs });
	assert.deepEqual(res, { ok: true });
	assert.equal(fs.ops.filter((o) => o.op === "rename").length, 2, "rename retried exactly once");
});

test("writeOverlay: EPERM twice returns invalid, not a throw", () => {
	const fs = makeFakeFs({ renameErrors: [{ code: "EPERM" }, { code: "EPERM" }] });
	let res;
	assert.doesNotThrow(() => {
		res = writeOverlay("/s/settings.json", { model: "m" }, { fs });
	});
	assert.ok(res.invalid, "second EPERM surfaces as invalid");
	assert.equal(fs.ops.filter((o) => o.op === "rename").length, 2, "one retry, then give up");
});

test("writeOverlay: an invalid candidate returns invalid and touches no file at all", () => {
	const fs = makeFakeFs();
	const res = writeOverlay("/s/settings.json", { maxTurns: 0 }, { fs });
	assert.ok(res.invalid);
	assert.ok(res.invalid.includes("maxTurns"));
	assert.equal(fs.ops.length, 0, "no mkdir, no write, no rename when the candidate is invalid");
});

test("writeOverlay: a same-key contract is enforced -- concurrency 11 is rejected before any write", () => {
	const fs = makeFakeFs();
	const res = writeOverlay("/s/settings.json", { concurrency: 11 }, { fs });
	assert.ok(res.invalid);
	assert.equal(fs.ops.length, 0);
});

test("writeOverlay: a non-EPERM rename error is not retried and returns invalid", () => {
	const fs = makeFakeFs({ renameErrors: [{ code: "EXDEV" }] });
	const res = writeOverlay("/s/settings.json", { model: "m" }, { fs });
	assert.ok(res.invalid);
	assert.equal(fs.ops.filter((o) => o.op === "rename").length, 1, "a non-EPERM failure is terminal");
});

test("writeOverlay never throws when mkdir or write fails", () => {
	assert.doesNotThrow(() => {
		const res = writeOverlay("/s/settings.json", { model: "m" }, { fs: makeFakeFs({ mkdirThrows: true }) });
		assert.ok(res.invalid);
	});
	assert.doesNotThrow(() => {
		const res = writeOverlay("/s/settings.json", { model: "m" }, { fs: makeFakeFs({ writeThrows: true }) });
		assert.ok(res.invalid);
	});
});

// ---- KNOWN_KEYS ----

test("KNOWN_KEYS is exported and lists exactly the four overlay keys (the token budgets, dollar keys and job-start caps retired)", () => {
	assert.deepEqual([...KNOWN_KEYS].sort(), ["concurrency", "maxTurns", "model", "provider"]);
});

// ---- settingsFilePath ----

test("settingsFilePath: PI_SETTINGS_FILE wins when set", () => {
	assert.equal(settingsFilePath({ PI_SETTINGS_FILE: "/abs/custom.json" }), "/abs/custom.json");
});

test("settingsFilePath: unset or empty falls back to the shared DURABLE default", () => {
	assert.equal(settingsFilePath({}), defaultSettingsFile());
	assert.equal(settingsFilePath({ PI_SETTINGS_FILE: "" }), defaultSettingsFile());
	assert.ok(settingsFilePath({}).endsWith(".pi-dispatch/settings.json"), "default sits under the durable state root (issue #290)");
	// The seam the worker never uses and doctor depends on: an injected home must reach the default.
	assert.equal(settingsFilePath({}, "/home/u"), "/home/u/.pi-dispatch/settings.json");
	assert.equal(settingsFilePath({ PI_SETTINGS_FILE: "/abs/x.json" }, "/home/u"), "/abs/x.json", "an explicit path still wins over any home");
});

test("writeOverlay into the per-account temp root (the no-home default) refuses a root another account owns, and writes nothing (#464)", () => {
	const writes = [];
	const tmp = process.env.TMPDIR?.trim() ? process.env.TMPDIR.trim().replace(/(?!^)\/+$/, "") : "/tmp";
	const root = `${tmp}/pi-dispatch-${process.geteuid()}`;
	const owner = (uid) => ({
		mkdirSync: () => {},
		lstatSync: () => ({ uid, isDirectory: () => true, isSymbolicLink: () => false, mode: 0o40700 }),
		statSync: () => ({ uid, isDirectory: () => true }),
		chmodSync: () => {},
		writeFileSync: (p) => writes.push(p),
		renameSync: (a, b) => writes.push(b),
	});
	const theirs = writeOverlay(`${root}/settings.json`, { model: "m" }, { fs: owner(process.geteuid() + 1) });
	assert.match(theirs.invalid, new RegExp(`^settings dir refused: ${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is owned by uid ${process.geteuid() + 1}, not by this account`));
	assert.deepEqual(writes, []);
	assert.deepEqual(writeOverlay(`${root}/settings.json`, { model: "m" }, { fs: owner(process.geteuid()) }), { ok: true });
	assert.ok(writes.includes(`${root}/settings.json`));
});
