import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import {
	SCOPED_LIMITS_VERSION,
	RETIRED_COUNT_FIELDS,
	RETIRED_TOKEN_FIELDS,
	parseScopedLimits,
	loadScopedLimits,
	canonicalScope,
	limitFor,
	concurrencyFor,
	scopeKeyPrefix,
	makeInFlight,
	scopedLimitsVersionFor,
	rowScopeFor,
	projectRowFor,
	danglingProjectRows,
	checkProjectRows,
	isProjectScope,
	projectScope,
} from "../src/scoped-limits.mjs";
import { FORGE_KINDS } from "../src/forges.mjs";

// C2: every token window, every model row and the allocation envelope are gone. A row now carries `concurrent`
// (issue #242), the version 3 size fields (issue #596) and nothing else; an old row's token fields and a
// model row are REFUSED by name, never dropped.

const wrap = (limits, version = 1) => JSON.stringify({ version, limits });
const parse = (limits) => parseScopedLimits(wrap(limits), "sl.json");
const parse2 = (limits) => parseScopedLimits(wrap(limits, 2), "sl.json");
const v3 = (limits) => parseScopedLimits(wrap(limits, 3), "sl.json");
const v4 = (limits) => parseScopedLimits(wrap(limits, 4), "sl.json");
const localJob = (folder) => ({ kind: "local", folder });
const ghJob = (repo) => ({ kind: "github", repo });

// ── validator ───────────────────────────────────────────────────────────────────────────────────────────

test("parseScopedLimits normalizes a row and rejects a row that limits nothing", () => {
	assert.deepEqual(parse([{ scope: "acme/web", concurrent: 2 }]), [{ scope: "acme/web", concurrent: 2 }]);
	assert.throws(() => parse([{ scope: "acme/web", concurrent: null }]), /at least one of concurrent is required/);
	assert.throws(() => parse([{ scope: "acme/web" }]), /at least one of concurrent is required/);
});

test("parseScopedLimits drops unknown fields in versions 1 and 2 (operator-file policy)", () => {
	const [row] = parse([{ scope: "acme/web", concurrent: 2, note: "x" }]);
	assert.deepEqual(Object.keys(row).sort(), ["concurrent", "scope"]);
	const [v2] = parse2([{ scope: "project:p", concurrent: 1, cpu: 2 }]);
	assert.equal(v2.concurrent, 1);
});

test("parseScopedLimits round-trips its own output (null is absent, the subscriptions rule)", () => {
	const first = parse([{ scope: "acme/web", concurrent: 2 }, { scope: "/srv/site", concurrent: 1 }]);
	const again = parseScopedLimits(JSON.stringify({ version: 1, limits: first }), "sl.json");
	assert.deepEqual(again, first);
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
	assert.throws(() => parse([{ scope: "acme/web", concurrent: 2 ** 53 }]), /concurrent must be an integer >= 1/);
	assert.equal(parse([{ scope: "acme/web", concurrent: 1e3 }])[0].concurrent, 1000);
});

test("parseScopedLimits refuses a newer version loudly, naming both", () => {
	assert.throws(() => parseScopedLimits(wrap([], 5), "sl.json"), /written by a newer pi-dispatch \(version 5; this build understands 4\)/);
	assert.equal(SCOPED_LIMITS_VERSION, 4);
});

// ── the retired token budgets and model rows (C2) ──────────────────────────────────────────────────────

test("a row carrying dayTokens, weekTokens or monthTokens is REFUSED by name, in every version, and its null still re-parses", () => {
	for (const version of [1, 2, 3, 4]) {
		for (const field of RETIRED_TOKEN_FIELDS) {
			assert.throws(
				() => parseScopedLimits(wrap([{ scope: "acme/web", concurrent: 1, [field]: 2 }], version), "sl.json"),
				(e) => e.message === `scoped limit at index 0: ${field} was retired with the token budgets; remove it (only concurrent and size fields remain): sl.json`,
				`v${version} ${field}`,
			);
		}
	}
	// An old file wrote null for the unset windows; null is the normalizer's own unset, so it still parses.
	assert.deepEqual(v4([{ scope: "acme/web", concurrent: 1, dayTokens: null, weekTokens: null, monthTokens: null }]), [{ scope: "acme/web", concurrent: 1, memory: null, cpus: null, hostShare: null, minJobs: null }]);
	assert.deepEqual([...RETIRED_TOKEN_FIELDS], ["dayTokens", "weekTokens", "monthTokens"]);
});

test("a model:<provider>/<model> row is REFUSED as retired, never read as an inert repo row, in every version", () => {
	for (const version of [1, 2, 3, 4]) {
		for (const scope of ["model:openai/gpt-x", "Model:openai/gpt-x", "models:openai/gpt-x", "model :openai/gpt-x"]) {
			assert.throws(
				() => parseScopedLimits(wrap([{ scope, concurrent: 1 }], version), "sl.json"),
				(e) => e.message === `scoped limit at index 0: model rows were retired with the token budgets; remove this row (a limit row names a repo, a folder or project:<id>): sl.json`,
				`v${version} ${scope}`,
			);
		}
	}
	// A repo whose name merely starts with the word is not a model row.
	assert.equal(parse([{ scope: "modelsco/web", concurrent: 1 }])[0].scope, "modelsco/web");
});

// ── the retired job-count fields ───────────────────────────────────────────────────────────────────────

test("a row carrying day, week or month is REFUSED naming the field and the removed scoped caps, in every version", () => {
	for (const version of [1, 2, 3, 4]) {
		for (const field of RETIRED_COUNT_FIELDS) {
			assert.throws(
				() => parseScopedLimits(wrap([{ scope: "acme/web", [field]: 2, concurrent: 1 }], version), "sl.json"),
				(e) => e.message.includes(`scoped limit at index 0: ${field} was retired with the job-count scoped caps`) && e.message.includes("remove it") && e.message.includes("sl.json"),
				`v${version} ${field}`,
			);
		}
	}
	assert.throws(() => parse2([{ scope: "acme/web", day: 1, week: 2, concurrent: 1 }]), /day, week were retired with the job-count scoped caps; remove them/);
	assert.deepEqual([...RETIRED_COUNT_FIELDS], ["day", "week", "month"]);
});

// ── version 3: job sizes on project rows (issue #596) ──────────────────────────────────────────────────

test("v3: a project row may carry memory, cpus, hostShare and minJobs, normalized to one spelling each", () => {
	const [row] = v3([{ scope: "project:heavy", memory: "16384m", cpus: "1.50", hostShare: 50, minJobs: 2 }]);
	assert.deepEqual(row, { scope: "project:heavy", concurrent: null, memory: "16g", cpus: 1.5, hostShare: 50, minJobs: 2 });
	assert.deepEqual(v3([{ scope: "project:light", memory: "1g" }])[0].memory, "1g");
	assert.deepEqual(v3([{ scope: "project:light", cpus: 0.25 }])[0].cpus, 0.25);
	assert.equal(v3([{ scope: "project:light", hostShare: 10 }])[0].hostShare, 10);
	const again = parseScopedLimits(JSON.stringify({ version: 3, limits: v3([{ scope: "project:p", memory: "1536m", cpus: 0.29, concurrent: 3, minJobs: 3 }]) }), "sl.json");
	assert.deepEqual(again, v3([{ scope: "project:p", memory: "1536m", cpus: 0.29, concurrent: 3, minJobs: 3 }]));
	assert.deepEqual([again[0].memory, again[0].cpus], ["1536m", 0.29]);
	for (const r of v3([{ scope: "acme/web", concurrent: 1 }, { scope: "project:p", concurrent: 1 }])) assert.deepEqual([r.memory, r.cpus, r.hostShare, r.minJobs], [null, null, null, null], r.scope);
	// A version 1 or 2 row reads into exactly the literal it always did: no size keys at all.
	assert.equal("memory" in parse([{ scope: "acme/web", concurrent: 1 }])[0], false);
	assert.equal("memory" in parse2([{ scope: "acme/web", concurrent: 1 }])[0], false);
});

test("v3: a size field in a version 1 or 2 file is refused naming version 3, and off a project row in any version", () => {
	for (const version of [1, 2]) {
		for (const field of [{ memory: "1g" }, { cpus: 1 }, { hostShare: 50 }, { minJobs: 1, memory: "1g" }]) {
			assert.throws(() => parseScopedLimits(wrap([{ scope: "project:p", concurrent: 1, ...field }], version), "sl.json"), /needs "version": (2|3)/, `${version} ${JSON.stringify(field)}`);
		}
	}
	for (const scope of ["acme/web", "github:acme/web", "/srv/site"]) {
		assert.throws(() => v3([{ scope, memory: "1g" }]), /memory belong on a project row \(project:<id>\)/, scope);
		assert.throws(() => v3([{ scope, cpus: 2 }]), /cpus belong on a project row/, scope);
	}
	assert.throws(() => v3([{ scope: "project:p" }]), /at least one of concurrent, memory, cpus, hostShare, minJobs is required/);
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
	assert.throws(() => v3([{ scope: "project:p", memory: "1g", concurrent: 2, minJobs: 3 }]), /minJobs 3 is above this row's concurrent 2, a minimum the project can never reach/);
});

test("v3: scopedLimitsVersionFor writes 3 only when a row uses a size field", () => {
	assert.equal(scopedLimitsVersionFor([{ scope: "project:p", concurrent: 1 }]), 2);
	assert.equal(scopedLimitsVersionFor([{ scope: "project:p", concurrent: 1, memory: null, cpus: null, hostShare: null, minJobs: null }]), 2, "null size fields are no size");
	for (const field of [{ memory: "1g" }, { cpus: 2 }, { hostShare: 10 }, { minJobs: 1 }]) assert.equal(scopedLimitsVersionFor([{ scope: "a/b", concurrent: 1 }, { scope: "project:p", ...field }]), 3, JSON.stringify(field));
	assert.equal(scopedLimitsVersionFor([{ scope: "a/b", concurrent: 1 }]), 1);
});

test("v4 rows carry the four size keys as null (the current file shape), and a v4 row still parses its own output", () => {
	const [row] = v4([{ scope: "acme/web", concurrent: 2 }]);
	assert.deepEqual(row, { scope: "acme/web", concurrent: 2, memory: null, cpus: null, hostShare: null, minJobs: null });
	assert.deepEqual(parseScopedLimits(JSON.stringify({ version: 4, limits: [row] }), "sl.json"), [row]);
});

// ── scope grammar ──────────────────────────────────────────────────────────────────────────────────────

test('parseScopedLimits refuses "*" and any glob (an exact matcher makes one silently inert)', () => {
	assert.throws(() => parse([{ scope: "*", concurrent: 1 }]), /"\*" is not supported -- add one row per scope/);
	assert.throws(() => parse([{ scope: "  *  ", concurrent: 1 }]), /"\*" is not supported/);
	for (const scope of ["acme/*", "*/web", "/srv/*"]) assert.throws(() => parse([{ scope, concurrent: 1 }]), /scopes match exactly; a scope containing "\*" is refused/);
});

test("parseScopedLimits trims a padded row scope, drops unknown TOP-LEVEL keys, and refuses duplicate scopes", () => {
	const rows = parseScopedLimits(JSON.stringify({ version: 1, limits: [{ scope: "  acme/web  ", concurrent: 1 }], future: true }), "sl.json");
	assert.equal(rows[0].scope, "acme/web");
	assert.equal(rows.length, 1);
	assert.throws(() => parse([{ scope: "acme/web", concurrent: 1 }, { scope: "acme/web", concurrent: 2 }]), /duplicate scope "acme\/web" \(first at index 0\)/);
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
	assert.equal(rows[2].scope, "./site");
});

test("Unicode scopes NFC-normalize on both sides, so NFD and NFC spellings share one row and one key", () => {
	const nfc = "acme/wéb";
	const nfd = "acme/wéb";
	assert.notEqual(nfc, nfd);
	const limits = parse([{ scope: nfd, concurrent: 1 }]);
	assert.equal(limits[0].scope, nfc);
	assert.equal(canonicalScope(ghJob(nfd)), canonicalScope(ghJob(nfc)));
	assert.equal(concurrencyFor(ghJob(nfd), limits), 1);
	assert.equal(scopeKeyPrefix(canonicalScope(ghJob(nfd))), scopeKeyPrefix(canonicalScope(ghJob(nfc))));
});

test("a NEAR MISS of a project row is refused, never read as an inert repo row", () => {
	for (const scope of ["Project:abc", "PROJECT:abc", "projects:abc", "project :abc", "Projects  :abc"]) {
		assert.throws(() => parse([{ scope, concurrent: 1 }]), /written exactly project:<id>/, scope);
	}
	for (const scope of ["project:", "project:Shop", "project:a:b", "project:a/b", "project: shop", `project:${"a".repeat(33)}`, "project:-shop"]) {
		assert.throws(() => parse([{ scope, concurrent: 1 }]), /a project row's id must match/, scope);
	}
	assert.equal(parse([{ scope: "projectx/web", concurrent: 1 }])[0].scope, "projectx/web");
});

// ── loader ──────────────────────────────────────────────────────────────────────────────────────────────

test("loadScopedLimits returns [] when the file is unset", () => {
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
	assert.equal(limits[0].concurrent, 3);
});

// ── canonicalScope / limitFor / concurrencyFor ─────────────────────────────────────────────────────────

test("canonicalScope collapses every spelling of one directory onto one key", () => {
	const variants = ["/srv/site", "/srv/site/", "/srv//site", "/srv/x/../site", "  /srv/site  ", "/srv/site/.", "/srv/site//"];
	assert.deepEqual([...new Set(variants.map((folder) => canonicalScope(localJob(folder))))], ["/srv/site"]);
	assert.equal(canonicalScope(localJob("site")), resolve("site"));
	assert.equal(canonicalScope(ghJob("acme/web")), "acme/web");
	assert.equal(canonicalScope(ghJob(" acme/web ")), " acme/web ", "forge scopes are passthrough");
	assert.equal(canonicalScope({ kind: "local" }), null);
	assert.equal(canonicalScope(undefined), null);
});

test("limitFor is exact-match only", () => {
	const limits = parse([{ scope: "acme/web", concurrent: 10 }]);
	assert.equal(limitFor(limits, ghJob("acme/web")).concurrent, 10);
	assert.equal(limitFor(limits, ghJob("acme/other")), null);
	assert.equal(limitFor(limits, ghJob("acme")), null);
	assert.equal(limitFor([], ghJob("acme/web")), null);
	assert.equal(limitFor(limits, null), null);
});

test("concurrencyFor: the folder mutex is the structural 1 and config cannot raise it", () => {
	assert.equal(concurrencyFor(localJob("/srv/site"), []), 1);
	assert.equal(concurrencyFor(localJob("/srv/site"), parse([{ scope: "/srv/site", concurrent: 5 }])), 1);
	assert.equal(concurrencyFor(ghJob("acme/web"), []), Infinity);
	assert.equal(concurrencyFor(ghJob("acme/web"), parse([{ scope: "acme/web", concurrent: 2 }])), 2);
	assert.equal(concurrencyFor({ kind: "github" }, []), Infinity);
});

test("scopeKeyPrefix is budget:s: plus 16 hex, pinned literally so the key shape cannot drift", () => {
	assert.equal(scopeKeyPrefix("acme/web"), "budget:s:86f279ce9c29f106");
	assert.equal(scopeKeyPrefix("/srv/site"), "budget:s:3cd3201de5fe686c");
	assert.match(scopeKeyPrefix("anything at all"), /^budget:s:[0-9a-f]{16}$/);
	assert.notEqual(scopeKeyPrefix("a:b/c"), scopeKeyPrefix("a/b:c"));
});

// ── makeInFlight ────────────────────────────────────────────────────────────────────────────────────────

test("makeInFlight admits under the limit and refuses at it, without counting the refusal", () => {
	const m = makeInFlight();
	assert.equal(m.tryAcquire("s", 2), true);
	assert.equal(m.tryAcquire("s", 2), true);
	assert.equal(m.tryAcquire("s", 2), false);
	assert.equal(m.count("s"), 2);
	m.release("s");
	assert.equal(m.tryAcquire("s", 2), true);
});

test("makeInFlight releases exactly ONE slot per release, clamps at zero and treats Infinity as always-admit", () => {
	const m = makeInFlight();
	m.release("s");
	assert.equal(m.count("s"), 0);
	for (let i = 0; i < 20; i++) assert.equal(m.tryAcquire("a", Infinity), true);
	assert.equal(m.count("a"), 20);
	assert.equal(m.tryAcquire("b", 1), true);
	assert.equal(m.tryAcquire("b", 1), false);
});

// ── forge-qualified scopes (issue #498) ─────────────────────────────────────────────────────────────────

const fjJob = (repo) => ({ kind: "forgejo", repo });

test("a qualified row parses for every forge kind and stores <kind>:<repo>", () => {
	const limits = parse2(FORGE_KINDS.map((kind) => ({ scope: ` ${kind}:acme/web `, concurrent: 1 })));
	assert.deepEqual(limits.map((l) => l.scope), FORGE_KINDS.map((kind) => `${kind}:acme/web`));
	assert.equal(limits.length, FORGE_KINDS.length);
});

test("an unknown forge prefix is refused naming the known kinds; a drive letter keeps today's handling", () => {
	assert.throws(() => parse2([{ scope: "gitub:acme/web", concurrent: 1 }]), (e) => /index 0/.test(e.message) && /unknown prefix "gitub:"/.test(e.message) && FORGE_KINDS.every((k) => e.message.includes(k)));
	assert.throws(() => parse2([{ scope: "GitHub:acme/web", concurrent: 1 }]), /unknown prefix "GitHub:"/);
	assert.throws(() => parse2([{ scope: "github:", concurrent: 1 }]), /names a forge and no repo/);
	assert.equal(parse([{ scope: "C:\\srv\\site", concurrent: 1 }])[0].scope, "C:\\srv\\site");
});

test("a bare row and a qualified row for one repo refuse the file, naming both indexes", () => {
	assert.throws(() => parse2([{ scope: "acme/web", concurrent: 5 }, { scope: "github:acme/web", concurrent: 1 }]), (e) => /index 1/.test(e.message) && /at index 0/.test(e.message) && /same repo/.test(e.message));
	assert.throws(() => parse2([{ scope: "forgejo:acme/web", concurrent: 2 }, { scope: "acme/web", concurrent: 9 }]), (e) => /index 0/.test(e.message) && /at index 1/.test(e.message));
	assert.equal(parse2([{ scope: "github:acme/web", concurrent: 1 }, { scope: "forgejo:acme/web", concurrent: 1 }, { scope: "acme/api", concurrent: 1 }]).length, 3);
});

test("limitFor matches the qualified row first, then the bare row; the other forge falls through", () => {
	const qualified = parse2([{ scope: "github:acme/web", concurrent: 3 }]);
	assert.equal(limitFor(qualified, ghJob("acme/web")).scope, "github:acme/web");
	assert.equal(limitFor(qualified, fjJob("acme/web")), null);
	const bare = parse([{ scope: "acme/web", concurrent: 3 }]);
	assert.equal(limitFor(bare, ghJob("acme/web")).scope, "acme/web");
	assert.equal(limitFor(bare, fjJob("acme/web")).scope, "acme/web");
});

test("every key comes from the MATCHED ROW: rowScopeFor returns the row's scope", () => {
	const limits = parse2([{ scope: "forgejo:acme/web", concurrent: 2 }, { scope: "acme/api", concurrent: 1 }]);
	assert.equal(rowScopeFor(fjJob("acme/web"), limits), "forgejo:acme/web");
	assert.equal(rowScopeFor(ghJob("acme/api"), limits), "acme/api");
	assert.equal(rowScopeFor(fjJob("acme/api"), limits), "acme/api", "a bare row is one key for every forge");
	assert.equal(rowScopeFor(ghJob("acme/other"), limits), "acme/other");
	assert.equal(concurrencyFor(ghJob("acme/api"), limits), 1);
});

test("a qualified row needs version 2, and the admin's version stamp says 2 for one", () => {
	assert.throws(() => parse([{ scope: "github:acme/web", concurrent: 1 }]), (e) => /index 0/.test(e.message) && /needs "version": 2/.test(e.message));
	assert.equal(scopedLimitsVersionFor([{ scope: "github:acme/web", concurrent: 1 }]), 2);
	assert.equal(scopedLimitsVersionFor([{ scope: " forgejo:acme/web ", concurrent: 1 }]), 2);
	assert.equal(scopedLimitsVersionFor([{ scope: "acme/web", concurrent: 1 }, { scope: "/srv/site", concurrent: 1 }]), 1);
});

test("a qualified row must have a forge repo's shape: each refused shape is named, the good ones parse", () => {
	const refused = ["github:/acme/web", "github:acme/web/", "github:acme//web", "github:acme /web", "github:acme/ web", "github:acme/web\tx", "github:acme/web\u0000", "github:acme/web#12", "github:github:acme/web", "github:acme"];
	for (const scope of refused) assert.throws(() => parse2([{ scope, concurrent: 1 }]), (e) => /index 0/.test(e.message) && /is not a forge repo/.test(e.message), scope);
	for (const scope of ["github:acme/web", "gitlab:group/sub/proj", "azure:proj/repo", "forgejo:a.b-c/d_e"]) assert.equal(parse2([{ scope, concurrent: 1 }])[0].scope, scope);
});

// ── project rows (issue #499 part B) ─────────────────────────────────────────────────────────────────────

test("a project:<id> row parses in version 2 or higher and stamps version 2", () => {
	const v2 = parse2([{ scope: " project:shop ", concurrent: 1 }]);
	assert.deepEqual(v2, [{ scope: "project:shop", concurrent: 1 }]);
	assert.equal(isProjectScope(v2[0].scope), true);
	assert.equal(scopedLimitsVersionFor(v2), 2);
	assert.throws(() => parse([{ scope: "project:shop", concurrent: 2 }]), (e) => /index 0/.test(e.message) && /a project row needs "version": 2/.test(e.message));
	assert.throws(() => parse2([{ scope: "project:shop", concurrent: 1 }, { scope: "project:shop", concurrent: 1 }]), /duplicate scope "project:shop"/);
	assert.equal(projectScope("shop"), "project:shop");
});

test("a project row is never a job's own scope: limitFor and concurrencyFor ignore it", () => {
	const limits = parse2([{ scope: "acme/web", concurrent: 1 }, { scope: "project:shop", concurrent: 2 }]);
	assert.equal(limitFor(limits, ghJob("project:shop")), null);
	assert.equal(rowScopeFor(ghJob("project:shop"), limits), "project:shop");
	assert.equal(concurrencyFor(ghJob("project:shop"), parse2([{ scope: "project:shop", concurrent: 1 }])), Infinity);
});

test("projectRowFor: the project row by id; no row or a malformed id is null", () => {
	const limits = parse2([{ scope: "project:shop", concurrent: 2 }, { scope: "acme/web", concurrent: 1 }]);
	assert.equal(projectRowFor(limits, "shop").scope, "project:shop");
	assert.equal(projectRowFor(limits, "Not An Id"), null);
	assert.equal(projectRowFor(limits, null), null);
});

test("a project row whose id is not a project is named by index and id (danglingProjectRows / checkProjectRows)", () => {
	const limits = parse2([{ scope: "acme/web", concurrent: 1 }, { scope: "project:shop", concurrent: 2 }, { scope: "project:gone", concurrent: 1 }]);
	const projects = [{ id: "shop", name: "Private Name", members: ["github:acme/web"] }];
	assert.deepEqual(danglingProjectRows(limits, projects), [{ index: 2, id: "gone" }]);
	assert.deepEqual(danglingProjectRows(limits, []), [{ index: 1, id: "shop" }, { index: 2, id: "gone" }]);
	assert.throws(
		() => checkProjectRows(limits, projects, "sl.json"),
		(e) => e.piDispatchConfig === true && /index 2 \("project:gone"\)/.test(e.message) && !/index 1/.test(e.message) && !/Private Name/.test(e.message),
	);
	assert.doesNotThrow(() => checkProjectRows(limits, [...projects, { id: "gone", members: ["/srv/x"] }], "sl.json"));
});

test("v3: a row refuses an unknown key, so a misspelled size cannot drop out; v1 and v2 still drop one", () => {
	for (const typo of ["Memory", "cpu", "mem", "CPUs", "host_share", "minjobs", "comment"]) {
		assert.throws(() => v3([{ scope: "project:shop", memory: "1g", [typo]: "8g" }]), (e) => e.message.includes(`unknown key ${JSON.stringify(typo)}`) && /keys are case-sensitive/.test(e.message), typo);
	}
	assert.throws(() => v3([{ scope: "acme/web", concurrent: 1, Memory: "8g", cpu: 2 }]), /unknown keys "Memory", "cpu"/);
	assert.deepEqual(parse([{ scope: "acme/web", concurrent: 1, Memory: "8g", comment: "x" }]), [{ scope: "acme/web", concurrent: 1 }]);
});
