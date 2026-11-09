import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import {
	SCOPED_LIMITS_VERSION,
	RETIRED_COUNT_FIELDS,
	parseScopedLimits,
	loadScopedLimits,
	canonicalScope,
	limitFor,
	concurrencyFor,
	scopeKeyPrefix,
	makeInFlight,
	tokenCapsFor,
	modelTokenRows,
	scopeTokenKeyPrefix,
	modelTokenKeyPrefix,
	tokenKeyPrefixFor,
	scopedLimitsVersionFor,
	rowScopeFor,
	projectRowFor,
	projectTokenCapsFor,
	danglingProjectRows,
	checkProjectRows,
	tokenRowsWithoutCap,
	isProjectScope,
	projectScope,
} from "../src/scoped-limits.mjs";
import { FORGE_KINDS } from "../src/forges.mjs";
import { createHash } from "node:crypto";

const wrap = (limits, version = 1) => JSON.stringify({ version, limits });
const parse = (limits) => parseScopedLimits(wrap(limits), "sl.json");
const parse2 = (limits) => parseScopedLimits(wrap(limits, 2), "sl.json");
const v3 = (limits) => parseScopedLimits(wrap(limits, 3), "sl.json");
const localJob = (folder) => ({ kind: "local", folder });
const ghJob = (repo) => ({ kind: "github", repo });

// ── validator ───────────────────────────────────────────────────────────────────────────────────────────

test("parseScopedLimits normalizes a row and rejects a row that limits nothing", () => {
	assert.deepEqual(parse([{ scope: "acme/web", concurrent: 2 }]), [{ scope: "acme/web", concurrent: 2 }]);
	// Null is the normalizer's own "unset", so it counts as absent; a row with only nulls limits nothing.
	assert.throws(() => parse([{ scope: "acme/web", concurrent: null }]), /at least one of concurrent is required/);
	assert.throws(() => parse([{ scope: "acme/web" }]), /at least one of concurrent is required/);
});

test("parseScopedLimits drops unknown fields (operator-file policy)", () => {
	const [row] = parse([{ scope: "acme/web", concurrent: 2, note: "x" }]);
	assert.deepEqual(Object.keys(row).sort(), ["concurrent", "scope"]);
});

test("parseScopedLimits round-trips its own output (null is absent, the subscriptions rule)", () => {
	// The admin's read-modify-write goes through this parser on both edges, so the normalizer's own
	// nulls must parse back clean or every partial edit refuses its own current state.
	const first = parse([{ scope: "acme/web", concurrent: 2 }, { scope: "/srv/site", concurrent: 1 }]);
	const again = parseScopedLimits(JSON.stringify({ version: 1, limits: first }), "sl.json");
	assert.deepEqual(again, first);
	// An explicit null in a hand-written file counts as absent, so an all-null row still refuses.
	assert.throws(() => parse([{ scope: "acme/web", concurrent: null }]), /is required/);
});

test("parseScopedLimits rejects malformed files fail-loud", () => {
	assert.throws(() => parseScopedLimits("{ not json", "sl.json"), /not valid JSON/);
	assert.throws(() => parseScopedLimits(JSON.stringify([]), "sl.json"), /must be an object with "version" and "limits"/);
	assert.throws(() => parseScopedLimits(JSON.stringify({ limits: [] }), "sl.json"), /must have "version": 1 to 4 \(an integer >= 1\)/);
	assert.throws(() => parseScopedLimits(JSON.stringify({ version: 0, limits: [] }), "sl.json"), /must have "version": 1/);
	assert.throws(() => parseScopedLimits(JSON.stringify({ version: "1", limits: [] }), "sl.json"), /must have "version": 1/);
	assert.throws(() => parseScopedLimits(JSON.stringify({ version: 1 }), "sl.json"), /must have a "limits" array/);
	assert.throws(() => parse(["nope"]), /must be an object/);
	assert.throws(() => parse([null]), /must be an object/);
	assert.throws(() => parse([{ concurrent: 1 }]), /scope must be a non-empty string/);
	assert.throws(() => parse([{ scope: "  ", concurrent: 1 }]), /scope must be a non-empty string/);
	assert.throws(() => parse([{ scope: "acme/web", concurrent: "2" }]), /concurrent must be an integer >= 1/);
	assert.throws(() => parse([{ scope: "acme/web", concurrent: 0 }]), /concurrent must be an integer >= 1/);
	// 2^53 passes Number.isInteger but cannot count; a bound indistinguishable from unlimited is refused.
	assert.throws(() => parse([{ scope: "acme/web", concurrent: 2 ** 53 }]), /concurrent must be an integer >= 1/);
	assert.equal(parse([{ scope: "acme/web", concurrent: 1e3 }])[0].concurrent, 1000);
});

test("parseScopedLimits refuses a newer version loudly, naming both", () => {
	assert.throws(
		() => parseScopedLimits(wrap([], 5), "sl.json"),
		/written by a newer pi-dispatch \(version 5; this build understands 4\)/,
	);
	assert.equal(SCOPED_LIMITS_VERSION, 4);
});

// ── the retired job-count fields (the job-start caps removal) ──────────────────────────────────────────

test("a row carrying day, week or month is REFUSED naming the field and the removed scoped caps, in every version", () => {
	for (const version of [1, 2, 3, 4]) {
		for (const field of ["day", "week", "month"]) {
			assert.throws(
				() => parseScopedLimits(wrap([{ scope: "acme/web", [field]: 2, concurrent: 1 }], version), "sl.json"),
				(e) => e.message.includes(`scoped limit at index 0: ${field} was retired with the job-count scoped caps`) && e.message.includes("remove it") && e.message.includes("sl.json"),
				`v${version} ${field}`,
			);
		}
	}
	// More than one is named together, and a model row or project row is refused the same way (never as an
	// unknown key, and never read as a valid row).
	assert.throws(() => parse2([{ scope: "acme/web", day: 1, week: 2 }]), /day, week were retired with the job-count scoped caps; remove them/);
	assert.throws(() => parse2([{ scope: "model:openai/gpt-x", day: 1, dayTokens: 2 }]), /day was retired with the job-count scoped caps/);
	assert.throws(() => v3([{ scope: "project:shop", month: 1, memory: "1g" }]), /month was retired with the job-count scoped caps/);
	// Null is absent (the normalizer's own unset), not a cap.
	assert.deepEqual(parse2([{ scope: "acme/web", concurrent: 1, day: null }]), [{ scope: "acme/web", concurrent: 1, dayTokens: null, weekTokens: null, monthTokens: null }]);
	assert.deepEqual([...RETIRED_COUNT_FIELDS], ["day", "week", "month"]);
});

// ── version 3: job sizes on project rows (issue #596) ──────────────────────────────────────────────────

test("v3: a project row may carry memory, cpus, hostShare and minJobs, normalized to one spelling each, and a size alone is a valid row", () => {
	const [row] = v3([{ scope: "project:heavy", memory: "16384m", cpus: "1.50", hostShare: 50, minJobs: 2 }]);
	assert.deepEqual(row, { scope: "project:heavy", concurrent: null, dayTokens: null, weekTokens: null, monthTokens: null, memory: "16g", cpus: 1.5, hostShare: 50, minJobs: 2 });
	// The widened "limits nothing" rule: a row with only a size limits something (its jobs' size).
	assert.deepEqual(v3([{ scope: "project:light", memory: "1g" }])[0].memory, "1g");
	assert.deepEqual(v3([{ scope: "project:light", cpus: 0.25 }])[0].cpus, 0.25);
	assert.deepEqual(v3([{ scope: "project:light", hostShare: 10 }])[0].hostShare, 10);
	// Round-trips through the parser: the admin's read-modify-write goes through it on both edges.
	const again = parseScopedLimits(JSON.stringify({ version: 3, limits: v3([{ scope: "project:p", memory: "1536m", cpus: 0.29, concurrent: 3, minJobs: 3 }]) }), "sl.json");
	assert.deepEqual(again, v3([{ scope: "project:p", memory: "1536m", cpus: 0.29, concurrent: 3, minJobs: 3 }]));
	assert.deepEqual([again[0].memory, again[0].cpus], ["1536m", 0.29]);
	// Every row of a version 3 file carries the four keys, null unless set, so the shape is one per version.
	const rows = v3([{ scope: "acme/web", concurrent: 1 }, { scope: "model:openai/gpt-x", dayTokens: 1 }]);
	for (const r of rows) assert.deepEqual([r.memory, r.cpus, r.hostShare, r.minJobs], [null, null, null, null], r.scope);
	// A version 1 or 2 row reads into exactly the literal it always did: no size keys at all.
	assert.equal("memory" in parse([{ scope: "acme/web", concurrent: 1 }])[0], false);
	assert.equal("memory" in parseScopedLimits(wrap([{ scope: "acme/web", dayTokens: 1 }], 2), "sl.json")[0], false);
});

test("v3: a size field in a version 1 or 2 file is refused naming version 3, and off a project row in any version", () => {
	for (const version of [1, 2]) {
		for (const field of [{ memory: "1g" }, { cpus: 1 }, { hostShare: 50 }, { minJobs: 1, memory: "1g" }]) {
			assert.throws(() => parseScopedLimits(wrap([{ scope: "project:p", concurrent: 1, ...field }], version), "sl.json"), version === 1 ? /needs "version": (2|3)/ : /needs "version": 3 \(this file says 2\)/, `${version} ${JSON.stringify(field)}`);
		}
	}
	assert.throws(() => parseScopedLimits(wrap([{ scope: "project:p", memory: "1g" }], 2), "sl.json"), /memory needs "version": 3 \(this file says 2\), so a build that predates job sizes refuses the file/);
	for (const scope of ["acme/web", "github:acme/web", "/srv/site"]) {
		assert.throws(() => v3([{ scope, memory: "1g" }]), /memory belong on a project row \(project:<id>\)/, scope);
		assert.throws(() => v3([{ scope, cpus: 2 }]), /cpus belong on a project row/, scope);
	}
	assert.throws(() => v3([{ scope: "model:openai/gpt-x", dayTokens: 1, memory: "1g" }]), /a model row carries dayTokens, weekTokens and monthTokens only \(memory is refused\)/);
	assert.throws(() => v3([{ scope: "project:p" }]), /at least one of concurrent, dayTokens, weekTokens, monthTokens, memory, cpus, hostShare, minJobs is required/);
	assert.throws(() => v3([{ scope: "project:p", memory: null, cpus: null }]), /is required/, "explicit nulls are absent");
});

test("v3: each size field refuses a value its rule refuses, naming the field and the rule", () => {
	assert.throws(() => v3([{ scope: "project:p", memory: "256m" }]), /memory: a memory size must be at least 512m/);
	assert.throws(() => v3([{ scope: "project:p", memory: "4GB" }]), /memory: a memory size is a whole number of megabytes or gigabytes/);
	assert.throws(() => v3([{ scope: "project:p", memory: 4096 }]), /memory: a memory size is a whole number/);
	assert.throws(() => v3([{ scope: "project:p", cpus: 0.1 }]), /cpus: a CPU size must be at least 0.25/);
	assert.throws(() => v3([{ scope: "project:p", cpus: "1.234" }]), /cpus: a CPU size is a number above 0 with at most two decimals/);
	for (const bad of [0, 101, 50.5, "50", -1, 0.5]) assert.throws(() => v3([{ scope: "project:p", hostShare: bad }]), /hostShare is a whole percentage of the host's job budget, from 1 to 100/, String(bad));
	assert.equal(v3([{ scope: "project:p", hostShare: 100 }])[0].hostShare, 100);
	assert.equal(v3([{ scope: "project:p", hostShare: 1 }])[0].hostShare, 1);
	for (const bad of [0, -1, 1.5, "2", 2 ** 53]) assert.throws(() => v3([{ scope: "project:p", memory: "1g", minJobs: bad }]), /minJobs must be an integer >= 1/, String(bad));
});

test("v3: minJobs needs a size on its row, and may not exceed the row's own concurrent", () => {
	assert.throws(() => v3([{ scope: "project:p", minJobs: 1 }]), /minJobs needs memory or cpus on the same row/);
	assert.throws(() => v3([{ scope: "project:p", hostShare: 50, minJobs: 1 }]), /minJobs needs memory or cpus on the same row/, "a share is not a size");
	assert.equal(v3([{ scope: "project:p", cpus: 1, minJobs: 2 }])[0].minJobs, 2);
	assert.equal(v3([{ scope: "project:p", memory: "1g", concurrent: 2, minJobs: 2 }])[0].minJobs, 2);
	assert.throws(() => v3([{ scope: "project:p", memory: "1g", concurrent: 2, minJobs: 3 }]), /minJobs 3 is above this row's concurrent 2, a minimum the project can never reach/);
});

test("v3: scopedLimitsVersionFor writes 3 only when a row uses a size field", () => {
	assert.equal(scopedLimitsVersionFor([{ scope: "project:p", concurrent: 1 }]), 2);
	assert.equal(scopedLimitsVersionFor([{ scope: "project:p", concurrent: 1, memory: null, cpus: null, hostShare: null, minJobs: null }]), 2, "null size fields are no size");
	for (const field of [{ memory: "1g" }, { cpus: 2 }, { hostShare: 10 }, { minJobs: 1 }]) assert.equal(scopedLimitsVersionFor([{ scope: "a/b", concurrent: 1 }, { scope: "project:p", ...field }]), 3, JSON.stringify(field));
	assert.equal(scopedLimitsVersionFor([{ scope: "a/b", concurrent: 1 }]), 1);
});

test('parseScopedLimits refuses "*" with the per-scope-default reversal note', () => {
	assert.throws(() => parse([{ scope: "*", concurrent: 1 }]), /"\*" is not supported -- add one row per scope/);
	assert.throws(() => parse([{ scope: "  *  ", concurrent: 1 }]), /"\*" is not supported/);
});

test("parseScopedLimits refuses any scope containing * (an exact matcher makes globs silently inert)", () => {
	assert.throws(() => parse([{ scope: "acme/*", concurrent: 1 }]), /scopes match exactly; a scope containing "\*" is refused/);
	assert.throws(() => parse([{ scope: "*/web", concurrent: 1 }]), /scopes match exactly/);
	assert.throws(() => parse([{ scope: "/srv/*", concurrent: 1 }]), /scopes match exactly/);
});

test("parseScopedLimits trims a padded row scope and drops unknown TOP-LEVEL keys", () => {
	const rows = parseScopedLimits(JSON.stringify({ version: 1, limits: [{ scope: "  acme/web  ", concurrent: 1 }], future: true }), "sl.json");
	assert.equal(rows[0].scope, "acme/web");
	assert.equal(rows.length, 1);
});

test("parseScopedLimits refuses duplicate scopes, including across path spellings", () => {
	assert.throws(() => parse([{ scope: "acme/web", concurrent: 1 }, { scope: "acme/web", concurrent: 2 }]), /duplicate scope "acme\/web" \(first at index 0\)/);
	// Both spellings resolve to /srv/site, so the duplicate check must see one scope, not two.
	assert.throws(() => parse([{ scope: "/srv/site", concurrent: 1 }, { scope: "/srv/site/", concurrent: 2 }]), /duplicate scope "\/srv\/site"/);
});

test("parseScopedLimits stores absolute row scopes resolved; relative rows stay as written", () => {
	const rows = parse([
		{ scope: "/srv/site/", concurrent: 1 },
		{ scope: "/srv/x/../other", concurrent: 1 },
		{ scope: "./site", concurrent: 1 },
	]);
	assert.equal(rows[0].scope, "/srv/site");
	assert.equal(rows[1].scope, "/srv/other");
	// A relative row is inert config (the job side always resolves); kept as written. The doctor
	// advisory that flags it lands later in this issue -- until then the contract says: absolute paths.
	assert.equal(rows[2].scope, "./site");
});

test("Unicode scopes NFC-normalize on both sides, so NFD and NFC spellings share one row and one key", () => {
	const nfc = "acme/wéb"; // é as one codepoint
	const nfd = "acme/wéb"; // e + combining acute
	assert.notEqual(nfc, nfd); // distinct strings, one name
	const limits = parse([{ scope: nfd, concurrent: 1 }]);
	assert.equal(limits[0].scope, nfc);
	assert.equal(canonicalScope(ghJob(nfd)), canonicalScope(ghJob(nfc)));
	assert.equal(concurrencyFor(ghJob(nfd), limits), 1);
	assert.equal(canonicalScope(localJob(`/srv/${nfd}`)), canonicalScope(localJob(`/srv/${nfc}`)));
	assert.equal(scopeKeyPrefix(canonicalScope(ghJob(nfd))), scopeKeyPrefix(canonicalScope(ghJob(nfc))));
});

// ── loader ──────────────────────────────────────────────────────────────────────────────────────────────

test("loadScopedLimits returns [] when the file is unset (no scoped limits; the mutex holds regardless)", () => {
	assert.deepEqual(loadScopedLimits({ scopedLimitsFile: null }), []);
	assert.deepEqual(loadScopedLimits({}), []);
});

test("the committed scoped-limits.example.json parses through the real loader (subscriptions' pin)", () => {
	const limits = loadScopedLimits({ scopedLimitsFile: new URL("../../scoped-limits.example.json", import.meta.url).pathname });
	assert.equal(limits.length, 2);
	assert.equal(limits[0].scope, "acme/web");
	assert.equal(limits[1].scope, "/srv/site");
});

test("loadScopedLimits throws when the configured file is missing, else parses it", () => {
	const cfg = { scopedLimitsFile: "/x/sl.json" };
	assert.throws(() => loadScopedLimits(cfg, { existsSync: () => false, readFileSync: () => "" }), /does not exist/);
	const limits = loadScopedLimits(cfg, { existsSync: () => true, readFileSync: () => wrap([{ scope: "acme/web", concurrent: 3 }]) });
	assert.equal(limits.length, 1);
	assert.equal(limits[0].concurrent, 3);
});

// ── canonicalScope ──────────────────────────────────────────────────────────────────────────────────────

test("canonicalScope collapses every spelling of one directory onto one key", () => {
	const variants = ["/srv/site", "/srv/site/", "/srv//site", "/srv/x/../site", "  /srv/site  ", "/srv/site/.", "/srv/site//"];
	const keys = new Set(variants.map((folder) => canonicalScope(localJob(folder))));
	assert.deepEqual([...keys], ["/srv/site"]);
});

test("canonicalScope resolves a relative folder against the cwd (stated, not accidental)", () => {
	assert.equal(canonicalScope(localJob("site")), resolve("site"));
});

test("canonicalScope passes a forge repo through untouched, so folder a/b and repo a/b cannot collide", () => {
	assert.equal(canonicalScope(ghJob("acme/web")), "acme/web");
	assert.equal(canonicalScope(ghJob("a/b")), "a/b");
	assert.notEqual(canonicalScope(localJob("a/b")), "a/b"); // resolved to an absolute path
});

test("canonicalScope returns null when the job has no scope", () => {
	assert.equal(canonicalScope({ kind: "local" }), null);
	assert.equal(canonicalScope({ kind: "github" }), null);
	assert.equal(canonicalScope(undefined), null);
});

// ── limitFor / concurrencyFor ───────────────────────────────────────────────────────────────────────────

test("limitFor is exact-match only", () => {
	const limits = parse([{ scope: "acme/web", concurrent: 10 }]);
	assert.equal(limitFor(limits, ghJob("acme/web")).concurrent, 10);
	assert.equal(limitFor(limits, ghJob("acme/other")), null);
	assert.equal(limitFor(limits, ghJob("acme")), null);
	assert.equal(limitFor([], ghJob("acme/web")), null);
	assert.equal(limitFor(limits, null), null);
	assert.equal(limitFor(limits, { kind: "github" }), null);
});

test("canonicalScope leaves a forge scope's padding alone (passthrough means passthrough)", () => {
	assert.equal(canonicalScope(ghJob(" acme/web ")), " acme/web ");
});

test("concurrencyFor: the folder mutex is the structural 1 and config cannot raise it", () => {
	assert.equal(concurrencyFor(localJob("/srv/site"), []), 1);
	assert.equal(concurrencyFor(localJob("/srv/site"), parse([{ scope: "/srv/site", concurrent: 5 }])), 1);
	assert.equal(concurrencyFor(ghJob("acme/web"), []), Infinity);
	assert.equal(concurrencyFor(ghJob("acme/web"), parse([{ scope: "acme/web", concurrent: 2 }])), 2);
	assert.equal(concurrencyFor({ kind: "github" }, []), Infinity); // scopeless: no gate
});

// ── scopeKeyPrefix ──────────────────────────────────────────────────────────────────────────────────────

test("scopeKeyPrefix is budget:s: plus 16 hex, pinned literally so the key shape cannot drift", () => {
	// Literal vectors, never derived in the test: a changed hash or slice silently remaps every
	// deployment's legacy counters to fresh keys.
	assert.equal(scopeKeyPrefix("acme/web"), "budget:s:86f279ce9c29f106");
	assert.equal(scopeKeyPrefix("/srv/site"), "budget:s:3cd3201de5fe686c");
	assert.match(scopeKeyPrefix("anything at all"), /^budget:s:[0-9a-f]{16}$/);
});

test("scopeKeyPrefix keeps colon/slash rearrangements distinct (the reason it hashes)", () => {
	assert.equal(scopeKeyPrefix("a:b/c"), "budget:s:fb7456513927a447");
	assert.equal(scopeKeyPrefix("a/b:c"), "budget:s:3b07f80ca173745a");
	assert.notEqual(scopeKeyPrefix("a:b/c"), scopeKeyPrefix("a/b:c"));
	assert.notEqual(scopeKeyPrefix("a b/c"), scopeKeyPrefix("a/b c"));
});

// ── makeInFlight ────────────────────────────────────────────────────────────────────────────────────────

test("makeInFlight admits under the limit and refuses at it, without counting the refusal", () => {
	const m = makeInFlight();
	assert.equal(m.tryAcquire("s", 2), true);
	assert.equal(m.tryAcquire("s", 2), true);
	assert.equal(m.tryAcquire("s", 2), false);
	assert.equal(m.count("s"), 2); // the refused attempt did not increment
	m.release("s");
	assert.equal(m.tryAcquire("s", 2), true);
});

test("makeInFlight releases exactly ONE slot per release (a delete-all regression over-admits)", () => {
	const m = makeInFlight();
	assert.equal(m.tryAcquire("s", 3), true);
	assert.equal(m.tryAcquire("s", 3), true);
	assert.equal(m.tryAcquire("s", 3), true);
	m.release("s");
	assert.equal(m.count("s"), 2); // one release frees one slot, never the whole scope
	assert.equal(m.tryAcquire("s", 3), true);
	assert.equal(m.tryAcquire("s", 3), false);
});

test("makeInFlight release clamps at zero and deletes the key", () => {
	const m = makeInFlight();
	m.release("s"); // release with no acquire: no-op, never a throw
	assert.equal(m.count("s"), 0);
	assert.equal(m.tryAcquire("s", 1), true);
	m.release("s");
	m.release("s"); // double release must not open a second slot
	assert.equal(m.tryAcquire("s", 1), true);
	assert.equal(m.tryAcquire("s", 1), false);
});

test("makeInFlight: Infinity always admits and scopes are independent", () => {
	const m = makeInFlight();
	for (let i = 0; i < 20; i++) assert.equal(m.tryAcquire("a", Infinity), true);
	assert.equal(m.tryAcquire("b", 1), true);
	assert.equal(m.tryAcquire("b", 1), false);
	assert.equal(m.count("a"), 20);
	assert.equal(m.count("b"), 1);
});

// ── version 2: token windows on repo and folder rows (#501 part 5) and model rows (#502 part 6) ─────────────────

const sha16 = (v) => createHash("sha256").update(v).digest("hex").slice(0, 16);

test("v2: a repo row carries dayTokens/weekTokens/monthTokens as whole token counts beside its concurrent; the literal has five keys", () => {
	const [row] = parse2([{ scope: "acme/web", concurrent: 3, dayTokens: 2_500, weekTokens: 10_000, monthTokens: 1 }]);
	assert.deepEqual(row, { scope: "acme/web", concurrent: 3, dayTokens: 2_500, weekTokens: 10_000, monthTokens: 1 });
	// A token-only row is a row: it limits something.
	assert.equal(parse2([{ scope: "acme/web", weekTokens: 1_000 }])[0].weekTokens, 1_000);
	// Whole numbers only: a float, a 0 and a string are all refused, naming the field.
	assert.throws(() => parse2([{ scope: "acme/web", dayTokens: 1.5 }]), /index 0: dayTokens must be an integer >= 1/);
	assert.throws(() => parse2([{ scope: "acme/web", dayTokens: 0 }]), /dayTokens must be an integer >= 1/);
	assert.throws(() => parse2([{ scope: "acme/web", monthTokens: 0 }]), /monthTokens must be an integer >= 1/);
	assert.throws(() => parse2([{ scope: "acme/web" }]), /at least one of concurrent, dayTokens, weekTokens, monthTokens is required/);
	// The parser accepts its own output back (the admin's read-modify-write).
	const again = parse2(parse2([{ scope: "acme/web", dayTokens: 2500 }]));
	assert.equal(again[0].dayTokens, 2_500);
});

test("v1 stays v1: read unchanged (the two-key literal), and a v1 file using token fields or a model row is REFUSED naming version 2", () => {
	assert.deepEqual(parse([{ scope: "acme/web", concurrent: 3 }]), [{ scope: "acme/web", concurrent: 3 }]);
	assert.throws(() => parse([{ scope: "acme/web", concurrent: 3, dayTokens: 5 }]), /index 0: dayTokens needs "version": 2 \(this file says 1\)/);
	assert.throws(() => parse([{ scope: "acme/web", monthTokens: 5 }]), /monthTokens needs "version": 2/);
	assert.throws(() => parse([{ scope: "model:openai/gpt-x", dayTokens: 5 }]), /a "model:" row needs "version": 2 \(this file says 1\)/);
	// A null token field is absent, in v1 as in v2 (the subscriptions rule).
	assert.equal(parse([{ scope: "acme/web", concurrent: 3, dayTokens: null }])[0].concurrent, 3);
});

test("v2 model rows: model:<provider>/<model> with token fields only; counts and concurrency refused; ids checked; duplicates by case refused", () => {
	const [m] = parse2([{ scope: " model:OpenAI/gpt-X ", monthTokens: 40 }]);
	assert.deepEqual(m, { scope: "model:OpenAI/gpt-X", concurrent: null, dayTokens: null, weekTokens: null, monthTokens: 40 });
	for (const field of ["concurrent", "memory"]) {
		assert.throws(() => parse2([{ scope: "model:openai/gpt-x", dayTokens: 1, [field]: 1 }]), new RegExp(`carries dayTokens, weekTokens and monthTokens only \\(${field} is refused\\)`));
	}
	assert.throws(() => parse2([{ scope: "model:openai/gpt-x" }]), /a model row needs at least one of dayTokens, weekTokens, monthTokens/);
	assert.throws(() => parse2([{ scope: "model:gpt-x", dayTokens: 1 }]), /model:<provider>\/<model>/);
	assert.throws(() => parse2([{ scope: "model:open ai/x", dayTokens: 1 }]), /model:<provider>\/<model>/);
	assert.throws(() => parse2([{ scope: "model:other/other", dayTokens: 1 }]), /fold row/);
	// A model id may carry a slash (openrouter vendor/model): split at the FIRST slash, as the allowed list does.
	assert.equal(parse2([{ scope: "model:openrouter/anthropic/claude-x", dayTokens: 1 }])[0].scope, "model:openrouter/anthropic/claude-x");
	assert.throws(() => parse2([{ scope: "model:openai/gpt-x", dayTokens: 1 }, { scope: "model:OpenAI/GPT-x", weekTokens: 1 }]), /duplicate scope/);
});

test("model rows are never a job's scope: limitFor and concurrencyFor ignore them", () => {
	const limits = parse2([{ scope: "model:openai/gpt-x", dayTokens: 1 }]);
	assert.equal(limitFor(limits, ghJob("model:openai/gpt-x")), null);
	assert.equal(concurrencyFor(ghJob("model:openai/gpt-x"), limits), Infinity);
});

test("tokenCapsFor: the scope row's token windows in integer tokens under budget:tok:s:<hash16 of the canonical scope>", () => {
	const limits = parse2([
		{ scope: "acme/web", dayTokens: 2500, monthTokens: 100 },
		{ scope: "/srv/site/", weekTokens: 1250 },
		{ scope: "acme/count", concurrent: 3 },
	]);
	assert.deepEqual(tokenCapsFor(ghJob("acme/web"), limits), { scope: "acme/web", keyPrefix: `budget:tok:s:${sha16("acme/web")}`, caps: { day: 2_500, week: null, month: 100 } });
	const local = tokenCapsFor(localJob("/srv//site"), limits);
	assert.deepEqual(local.caps, { day: null, week: 1_250, month: null });
	assert.equal(local.keyPrefix, `budget:tok:s:${sha16(resolve("/srv/site"))}`, "the same canonical scope the concurrency slot hashes");
	assert.equal(local.keyPrefix.slice("budget:tok:s:".length), scopeKeyPrefix(resolve("/srv/site")).slice("budget:s:".length), "the SAME hash as the concurrency key");
	assert.equal(tokenCapsFor(ghJob("acme/count"), limits), null, "a concurrency-only row has no token window");
	assert.equal(tokenCapsFor(ghJob("acme/other"), limits), null);
});

test("modelTokenRows: a list reserves in its listed rows (ignoring case); NO list reserves in EVERY row; key = hash16 of the LOWERCASED ref", () => {
	const limits = parse2([
		{ scope: "acme/web", dayTokens: 1 },
		{ scope: "model:OpenAI/GPT-x", dayTokens: 1 },
		{ scope: "model:ollama/qwen3:0.6b", weekTokens: 50 },
	]);
	const gpt = { ref: "openai/gpt-x", keyPrefix: `budget:tok:mdl:${sha16("openai/gpt-x")}`, caps: { day: 1, week: null, month: null } };
	const qwen = { ref: "ollama/qwen3:0.6b", keyPrefix: `budget:tok:mdl:${sha16("ollama/qwen3:0.6b")}`, caps: { day: null, week: 50, month: null } };
	assert.deepEqual(modelTokenRows(limits, ["openai/gpt-x"]), [gpt]);
	assert.deepEqual(modelTokenRows(limits, ["ollama/qwen3:0.6b", "anthropic/claude-x"]), [qwen]);
	assert.deepEqual(modelTokenRows(limits, null), [gpt, qwen], "unrestricted: every model row (fail closed)");
	assert.deepEqual(modelTokenRows(limits, undefined), [gpt, qwen]);
	assert.deepEqual(modelTokenRows([], null), []);
	// One model is one counter whatever case it is spelled in, and the ledger's lowercased ids meet it.
	assert.equal(modelTokenKeyPrefix("OpenAI/GPT-x"), modelTokenKeyPrefix("openai/gpt-x"));
	assert.equal(modelTokenKeyPrefix("OpenAI/GPT-x"), `budget:tok:mdl:${sha16("openai/gpt-x")}`);
	assert.equal(tokenKeyPrefixFor(limits[1]), gpt.keyPrefix);
	assert.equal(tokenKeyPrefixFor(limits[0]), scopeTokenKeyPrefix("acme/web"));
	assert.ok(!gpt.keyPrefix.startsWith("budget:tok:p:") && !scopeTokenKeyPrefix("x").startsWith("budget:tok:p:"), "no key under the withdrawn budget:tok:p: prefix (issue #499 part B)");
});

test("scopedLimitsVersionFor: 1 unless a row carries a token field or is a model row", () => {
	assert.equal(scopedLimitsVersionFor([]), 1);
	assert.equal(scopedLimitsVersionFor([{ scope: "a/b", concurrent: 1, dayTokens: null }]), 1);
	assert.equal(scopedLimitsVersionFor([{ scope: "a/b", concurrent: 1 }, { scope: "c/d", weekTokens: 1 }]), 2);
	assert.equal(scopedLimitsVersionFor([{ scope: "model:a/b", dayTokens: 1 }]), 2);
});

test("a NEAR MISS of a model or project row is refused, never read as an inert repo row (PR #549's review, issue #499 part B)", () => {
	for (const scope of ["Model:openai/gpt-x", "MODEL:openai/gpt-x", "models:openai/gpt-x", "model :openai/gpt-x", "Models  :x/y"]) {
		assert.throws(() => parse2([{ scope, dayTokens: 1 }]), /written exactly model:<provider>\/<model>/, scope);
		assert.throws(() => parse([{ scope, concurrent: 1 }]), /written exactly model:<provider>\/<model>/, `${scope} (v1)`);
	}
	for (const scope of ["Project:abc", "PROJECT:abc", "projects:abc", "project :abc", "Projects  :abc"]) {
		assert.throws(() => parse2([{ scope, dayTokens: 1 }]), /written exactly project:<id>/, scope);
		assert.throws(() => parse([{ scope, concurrent: 1 }]), /written exactly project:<id>/, `${scope} (v1)`);
	}
	// The exact prefix with an id the projects file could never hold.
	for (const scope of ["project:", "project:Shop", "project:a:b", "project:a/b", "project: shop", `project:${"a".repeat(33)}`, "project:-shop"]) {
		assert.throws(() => parse([{ scope, concurrent: 1 }]), /a project row's id must match/, scope);
	}
	// Not near misses: a repo or folder whose name merely starts with the word.
	assert.equal(parse([{ scope: "modelsco/web", concurrent: 1 }])[0].scope, "modelsco/web");
	assert.equal(parse([{ scope: "projectx/web", concurrent: 1 }])[0].scope, "projectx/web");
});

test("a case-colliding duplicate model row names the FIRST row's index (PR #549's review)", () => {
	assert.throws(() => parse2([{ scope: "acme/web", dayTokens: 1 }, { scope: "model:openai/gpt-x", dayTokens: 1 }, { scope: "model:OpenAI/gpt-x", weekTokens: 1 }]), /\(first at index 1\)/);
});

// ── forge-qualified scopes (issue #498) ─────────────────────────────────────────────────────────────────

const fjJob = (repo) => ({ kind: "forgejo", repo });

test("a qualified row parses for every forge kind (derived from FORGE_KINDS) and stores <kind>:<repo>", () => {
	const limits = parse2(FORGE_KINDS.map((kind) => ({ scope: ` ${kind}:acme/web `, concurrent: 1 })));
	assert.deepEqual(limits.map((l) => l.scope), FORGE_KINDS.map((kind) => `${kind}:acme/web`));
	// Two forges' qualified rows for one repo are two rows, not a duplicate.
	assert.equal(limits.length, FORGE_KINDS.length);
});

test("an unknown forge prefix is refused naming the known kinds; a drive letter keeps today's handling", () => {
	assert.throws(() => parse2([{ scope: "gitub:acme/web", concurrent: 1 }]), (e) => /index 0/.test(e.message) && /unknown prefix "gitub:"/.test(e.message) && FORGE_KINDS.every((k) => e.message.includes(k)));
	assert.throws(() => parse2([{ scope: "GitHub:acme/web", concurrent: 1 }]), /unknown prefix "GitHub:"/);
	assert.throws(() => parse2([{ scope: "github:", concurrent: 1 }]), /names a forge and no repo/);
	// A one-letter drive prefix is a folder, stored verbatim on a POSIX worker exactly as before.
	assert.equal(parse([{ scope: "C:\\srv\\site", concurrent: 1 }])[0].scope, "C:\\srv\\site");
});

test("a bare row and a qualified row for one repo refuse the file, naming both indexes (count rows)", () => {
	assert.throws(() => parse2([{ scope: "acme/web", concurrent: 5 }, { scope: "github:acme/web", concurrent: 1 }]), (e) => /index 1/.test(e.message) && /at index 0/.test(e.message) && /same repo/.test(e.message));
	// Order does not matter: the qualified row first is refused the same way.
	assert.throws(() => parse2([{ scope: "forgejo:acme/web", concurrent: 2 }, { scope: "acme/web", concurrent: 9 }]), (e) => /index 0/.test(e.message) && /at index 1/.test(e.message));
	// Two forges' qualified rows, or a bare row for ANOTHER repo, are fine.
	assert.equal(parse2([{ scope: "github:acme/web", concurrent: 1 }, { scope: "forgejo:acme/web", concurrent: 1 }, { scope: "acme/api", concurrent: 1 }]).length, 3);
});

test("a bare row and a qualified row for one repo refuse the file when both carry token windows only", () => {
	assert.throws(() => parse2([{ scope: "acme/web", dayTokens: 5 }, { scope: "gitlab:acme/web", monthTokens: 50 }]), (e) => /index 1/.test(e.message) && /at index 0/.test(e.message) && /same repo/.test(e.message));
});

test("limitFor matches the qualified row first, then the bare row; the other forge falls through", () => {
	const qualified = parse2([{ scope: "github:acme/web", concurrent: 3 }]);
	assert.equal(limitFor(qualified, ghJob("acme/web")).scope, "github:acme/web");
	assert.equal(limitFor(qualified, fjJob("acme/web")), null);
	const bare = parse([{ scope: "acme/web", concurrent: 3 }]);
	assert.equal(limitFor(bare, ghJob("acme/web")).scope, "acme/web");
	assert.equal(limitFor(bare, fjJob("acme/web")).scope, "acme/web");
	// A job with no kind matches only the bare row.
	assert.equal(limitFor(qualified, { repo: "acme/web" }), null);
	assert.equal(limitFor(bare, { repo: "acme/web" }).scope, "acme/web");
});

test("every key comes from the MATCHED ROW: tokenCapsFor and rowScopeFor return the row's scope", () => {
	const limits = parse2([{ scope: "forgejo:acme/web", dayTokens: 2 }, { scope: "acme/api", concurrent: 1, weekTokens: 3 }]);
	assert.equal(tokenCapsFor(fjJob("acme/web"), limits).keyPrefix, scopeTokenKeyPrefix("forgejo:acme/web"));
	assert.equal(tokenCapsFor(ghJob("acme/api"), limits).keyPrefix, scopeTokenKeyPrefix("acme/api"));
	assert.equal(rowScopeFor(fjJob("acme/web"), limits), "forgejo:acme/web");
	assert.equal(rowScopeFor(ghJob("acme/api"), limits), "acme/api");
	assert.equal(rowScopeFor(fjJob("acme/api"), limits), "acme/api", "a bare row is one key for every forge");
	// No row: the job's canonical scope, so the folder mutex keeps its key.
	assert.equal(rowScopeFor(ghJob("acme/other"), limits), "acme/other");
	assert.equal(rowScopeFor(localJob("/srv//site/"), limits), "/srv/site");
	assert.equal(concurrencyFor(ghJob("acme/api"), limits), 1);
	assert.equal(concurrencyFor(fjJob("acme/api"), limits), 1);
});

test("the migration pin: a bare row keeps the exact key it had before qualified scopes (literal, not recomputed)", () => {
	// Written out by hand on purpose: `printf %s acme/web | shasum -a 256 | cut -c1-16`. Any change to how a key is
	// derived (a prefix in the hash, a qualified scope for a bare row) moves every live counter and fails here first.
	assert.equal(scopeKeyPrefix("acme/web"), "budget:s:86f279ce9c29f106");
	assert.equal(scopeTokenKeyPrefix("acme/web"), "budget:tok:s:86f279ce9c29f106");
	const limits = parse([{ scope: "acme/web", concurrent: 5 }]);
	for (const job of [ghJob("acme/web"), fjJob("acme/web")]) assert.equal(scopeTokenKeyPrefix(rowScopeFor(job, limits)), "budget:tok:s:86f279ce9c29f106");
	assert.equal(scopeTokenKeyPrefix(rowScopeFor(ghJob("acme/web"), parse2([{ scope: "github:acme/web", concurrent: 5 }]))), "budget:tok:s:ae5b3b31a94b074d");
});

test("a forge-qualified row needs version 2, and the admin's version stamp says 2 for one (released builds refuse, never ignore)", () => {
	// Every released build reads `github:acme/web` as a plain repo string no job has: in a version 1 file it would be a
	// lease one build enforces and another silently drops. Version 2 makes the older build refuse instead.
	assert.throws(() => parse([{ scope: "github:acme/web", concurrent: 1 }]), (e) => /index 0/.test(e.message) && /needs "version": 2/.test(e.message));
	assert.equal(scopedLimitsVersionFor([{ scope: "github:acme/web", concurrent: 1 }]), 2);
	assert.equal(scopedLimitsVersionFor([{ scope: " forgejo:acme/web ", concurrent: 1 }]), 2, "as the admin builds it, untrimmed");
	assert.equal(scopedLimitsVersionFor([{ scope: "acme/web", concurrent: 1 }, { scope: "/srv/site", concurrent: 1 }]), 1, "bare and folder rows stay version 1");
	assert.equal(scopedLimitsVersionFor([{ scope: "gitub:acme/web", concurrent: 1 }]), 1, "a refused scope is the parser's to name, not the stamp's");
});

test("a qualified row must have a forge repo's shape: each refused shape is named, the good ones parse", () => {
	const refused = [
		"github:/acme/web", // leading slash
		"github:acme/web/", // trailing slash
		"github:acme//web", // empty segment
		"github:acme /web", // whitespace at a segment's end
		"github:acme/ web", // whitespace at a segment's start
		"github:acme/web\tx", // control character
		"github:acme/web\u0000", // NUL
		"github:acme/web#12", // a pasted run target
		"github:github:acme/web", // a second prefix
		"github:acme", // one segment: no forge repo has no "/"
	];
	for (const scope of refused) assert.throws(() => parse2([{ scope, concurrent: 1 }]), (e) => /index 0/.test(e.message) && /is not a forge repo/.test(e.message), scope);
	for (const scope of ["github:acme/web", "gitlab:group/sub/proj", "azure:proj/repo", "forgejo:a.b-c/d_e"]) assert.equal(parse2([{ scope, concurrent: 1 }])[0].scope, scope);
	// Azure DevOps project and repository names may hold spaces, and the receiver copies them verbatim: inside a
	// segment, whitespace is allowed for every forge (the simplest rule), and such a row caps that Azure job.
	const azure = parse2([{ scope: "azure:Fabrikam Fiber/Web App", concurrent: 1 }]);
	assert.equal(azure[0].scope, "azure:Fabrikam Fiber/Web App");
	assert.equal(limitFor(azure, { kind: "azure", repo: "Fabrikam Fiber/Web App" }).scope, "azure:Fabrikam Fiber/Web App");
});

// ── project rows (issue #499 part B) ─────────────────────────────────────────────────────────────────────

test("a project:<id> row parses in version 2 only, in every field, and stamps version 2 (issue #499 part B)", () => {
	const v2 = parse2([{ scope: " project:shop ", concurrent: 1, dayTokens: 2, weekTokens: 5 }]);
	assert.deepEqual(v2, [{ scope: "project:shop", concurrent: 1, dayTokens: 2, weekTokens: 5, monthTokens: null }]);
	assert.equal(isProjectScope(v2[0].scope), true);
	assert.equal(scopedLimitsVersionFor(v2), 2, "a count-only project row needs version 2 too");
	assert.equal(scopedLimitsVersionFor([{ scope: " project:shop ", concurrent: 1 }]), 2, "as the admin builds it, untrimmed");
	// The released 2.1.0 reads `project:shop` as an inert repo row, so a version 1 file holding one is refused here and
	// a version 2 file is refused there as newer.
	for (const row of [{ scope: "project:shop", concurrent: 2 }, { scope: "project:shop", concurrent: 1 }, { scope: "project:shop", dayTokens: 5 }]) {
		assert.throws(() => parse([row]), (e) => /index 0/.test(e.message) && /a project row needs "version": 2/.test(e.message), JSON.stringify(row));
	}
	const tokens = parse2([{ scope: "project:shop", dayTokens: 5, monthTokens: 40 }]);
	assert.deepEqual(tokens, [{ scope: "project:shop", concurrent: null, dayTokens: 5, weekTokens: null, monthTokens: 40 }]);
	assert.throws(() => parse2([{ scope: "project:shop", concurrent: 1 }, { scope: "project:shop", concurrent: 1 }]), /duplicate scope "project:shop"/);
	assert.throws(() => parse2([{ scope: "project:shop" }]), /at least one of concurrent/);
	assert.equal(projectScope("shop"), "project:shop");
});

test("a project row is never a job's own scope: limitFor and rowScopeFor ignore it, and it sits beside a bare row", () => {
	const limits = parse2([{ scope: "acme/web", concurrent: 1 }, { scope: "project:shop", concurrent: 2 }]);
	// A forge never puts `:` in a repo name, so no real job has this repo; even a hand-built one never matches the row.
	assert.equal(limitFor(limits, ghJob("project:shop")), null);
	assert.equal(rowScopeFor(ghJob("project:shop"), limits), "project:shop", "no row matched: the job's own canonical scope, as before");
	assert.equal(concurrencyFor(ghJob("project:shop"), parse2([{ scope: "project:shop", concurrent: 1 }])), Infinity);
});

test("projectRowFor: the project row by id, keyed by its own scope; no row or a malformed id is null", () => {
	const limits = parse2([{ scope: "project:shop", concurrent: 2 }, { scope: "acme/web", concurrent: 1 }]);
	assert.equal(projectRowFor(limits, "shop").scope, "project:shop");
	assert.equal(projectRowFor(limits, "Not An Id"), null);
	assert.equal(projectRowFor(limits, null), null);
});

test("projectTokenCapsFor: the project row's token windows under scopeTokenKeyPrefix(project:<id>), never budget:tok:p:", () => {
	const limits = parse2([{ scope: "project:shop", concurrent: 2, weekTokens: 12500 }]);
	const caps = projectTokenCapsFor(limits, "shop");
	assert.deepEqual(caps, { scope: "project:shop", keyPrefix: scopeTokenKeyPrefix("project:shop"), caps: { day: null, week: 12_500, month: null } });
	assert.equal(caps.keyPrefix, `budget:tok:s:${createHash("sha256").update("project:shop").digest("hex").slice(0, 16)}`);
	assert.equal(tokenKeyPrefixFor(limits[0]), caps.keyPrefix, "the admin reads the counters under the same prefix");
	assert.equal(projectTokenCapsFor(limits, null), null);
	assert.equal(projectTokenCapsFor(parse2([{ scope: "project:shop", concurrent: 1 }]), "shop"), null, "no token field, no token ledger");
	assert.deepEqual(tokenRowsWithoutCap(limits, null), [{ index: 0, kind: "project" }]);
});

test("a project row whose id is not a project is named by index and id (danglingProjectRows / checkProjectRows)", () => {
	const limits = parse2([{ scope: "acme/web", concurrent: 1 }, { scope: "project:shop", concurrent: 2 }, { scope: "project:gone", concurrent: 1 }]);
	const projects = [{ id: "shop", name: "Private Name", members: ["github:acme/web"] }];
	assert.deepEqual(danglingProjectRows(limits, projects), [{ index: 2, id: "gone" }]);
	assert.deepEqual(danglingProjectRows(limits, []), [{ index: 1, id: "shop" }, { index: 2, id: "gone" }], "no projects file: every project row dangles");
	assert.throws(
		() => checkProjectRows(limits, projects, "sl.json"),
		(e) => e.piDispatchConfig === true && /index 2 \("project:gone"\)/.test(e.message) && !/index 1/.test(e.message) && !/Private Name/.test(e.message),
	);
	assert.doesNotThrow(() => checkProjectRows(limits, [...projects, { id: "gone", members: ["/srv/x"] }], "sl.json"));
	assert.doesNotThrow(() => checkProjectRows([], [], "sl.json"));
});

test("v3: a row refuses a key it does not define, so a misspelled size cannot drop out beside a valid field; v1 and v2 still drop one (issue #596)", () => {
	for (const typo of ["Memory", "cpu", "mem", "CPUs", "host_share", "minjobs", "comment"]) {
		assert.throws(() => v3([{ scope: "project:shop", memory: "1g", [typo]: "8g" }]), (e) => e.message.includes(`unknown key ${JSON.stringify(typo)}`) && /keys are case-sensitive/.test(e.message), typo);
	}
	assert.throws(() => v3([{ scope: "acme/web", concurrent: 1, Memory: "8g", cpu: 2 }]), /unknown keys "Memory", "cpu"/, "on any row, both named");
	assert.throws(() => v3([{ scope: "model:openai/gpt-x", dayTokens: 1, dayusd: "2" }]), /unknown key "dayusd"/, "a model row too");
	// The retired job-count fields are named as retired, not as unknown, even in v3.
	assert.throws(() => v3([{ scope: "acme/web", concurrent: 1, day: 1 }]), /day was retired with the job-count scoped caps/);
	// Every key the file defines is accepted.
	assert.equal(v3([{ scope: "project:shop", concurrent: 2, dayTokens: 1, weekTokens: 2, monthTokens: 3, memory: "1g", cpus: 1, hostShare: 50, minJobs: 1 }]).length, 1);
	// Versions 1 and 2 keep the operator-file policy: an unknown key is dropped, so a file an older build reads still loads.
	assert.deepEqual(parse([{ scope: "acme/web", concurrent: 1, Memory: "8g", comment: "x" }]), [{ scope: "acme/web", concurrent: 1 }]);
	assert.equal(parseScopedLimits(wrap([{ scope: "project:shop", concurrent: 1, cpu: 2 }], 2), "sl.json")[0].concurrent, 1);
});
