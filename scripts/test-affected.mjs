#!/usr/bin/env node
// Pick the test files affected by the current working-tree changes, then run just those.
//
// Two ways a test can be affected, and an import graph alone misses the second:
// 1. it imports the changed file, directly or through the source graph, or
// 2. it reads or scans the changed file, or a tree that contains it, by a path
//    string. The guardrail tests do this on purpose: retention.test.mjs walks
//    "worker/src" line by line and never imports most of it.
// Over-selection is safe, under-selection ships a red build. Rule 2 stays
// path-precise though: "worker/src" appears inside 126 tests' longer
// cross-workspace paths, so only quoted strings that resolve to the changed
// file itself, or to an existing directory containing one, select a test.
// A deleted file is matched by basename, since it can no longer resolve.
//
// Usage:
//   node scripts/test-affected.mjs --list       print affected test files, run nothing
//   node scripts/test-affected.mjs              run the affected test files
//   node scripts/test-affected.mjs main         diff against a ref instead of HEAD
//   node scripts/test-affected.mjs main --list

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEST_DIRS = ["image/runner/test", "worker/test", "receiver/test", "admin/test", "gateway/test"];

const run = (cmd, args) => execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8" });

const argv = process.argv.slice(2);
const LIST = argv.includes("--list");
const base = argv.find((a) => !a.startsWith("--")) ?? "HEAD";

function changedFiles() {
	const out = run("git", ["diff", "--name-only", base, "--"]).split("\n").filter(Boolean);
	try {
		for (const line of run("git", ["ls-files", "--others", "--exclude-standard"]).split("\n")) {
			if (line) out.push(line);
		}
	} catch {}
	return [...new Set(out)].map((f) => resolve(ROOT, f)).filter((f) => statSync(f, { throwIfNoEntry: false })?.isFile());
}

function testFiles() {
	const out = [];
	for (const dir of TEST_DIRS) {
		const abs = join(ROOT, dir);
		let entries;
		try {
			entries = readdirSync(abs);
		} catch {
			continue;
		}
		for (const name of entries) if (name.endsWith(".test.mjs")) out.push(join(abs, name));
	}
	return out.sort();
}

// Relative static and dynamic imports of one .mjs file, resolved to absolute
// paths. Deliberately not a full ESM parser: the trees use one import shape,
// and a missed shape falls towards over-selection only via the path-string rule.
const importCache = new Map();
function importsOf(file) {
	let out = importCache.get(file);
	if (out) return out;
	out = [];
	const src = readFileSync(file, "utf8");
	const specs = [];
	for (const m of src.matchAll(/import\s+(?:[\w*{},\s$]+\s+from\s+)?["'](\.{1,2}\/[^"']+)["']/g)) specs.push(m[1]);
	for (const m of src.matchAll(/import\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g)) specs.push(m[1]);
	for (const spec of specs) {
		const resolved = resolve(dirname(file), spec);
		for (const candidate of [resolved, `${resolved}.mjs`, join(resolved, "index.mjs")]) {
			if (statSync(candidate, { throwIfNoEntry: false })?.isFile()) {
				out.push(candidate);
				break;
			}
		}
	}
	importCache.set(file, out);
	return out;
}

// Build the reverse graph once: edge dep -> importer, over every file reachable
// from any test. BFS from the changed files along reverse edges then yields
// exactly the importers that can observe a change, cycles included.
const importers = new Map();
const allTests = testFiles();
const queue = [...allTests];
const seenFiles = new Set(queue);
while (queue.length) {
	const file = queue.pop();
	for (const dep of importsOf(file)) {
		if (!importers.has(dep)) importers.set(dep, []);
		importers.get(dep).push(file);
		if (!seenFiles.has(dep)) {
			seenFiles.add(dep);
			queue.push(dep);
		}
	}
}

const changed = changedFiles();
if (changed.length === 0) {
	console.log("no changes to test");
	process.exit(0);
}

const affected = new Set();
const walk = [...changed];
const seenWalk = new Set(walk);
while (walk.length) {
	const file = walk.pop();
	if (file.endsWith(".test.mjs")) affected.add(file);
	for (const importer of importers.get(file) ?? []) {
		if (!seenWalk.has(importer)) {
			seenWalk.add(importer);
			walk.push(importer);
		}
	}
}

// Path-string rule, on top of the graph: a guardrail test can read a source
// file, or scan a whole source tree, by name, without importing any of it
// (retention.test.mjs walks "worker/src" line by line). Quoted strings are
// extracted and resolved against both the test's own directory and the repo
// root; a string that resolves to a file only selects tests when THAT file
// changed, and only a string that resolves to an existing directory selects
// the tree. Substring matching is what made the first cut pick 570 files:
// "worker/src" appears inside 126 tests' longer cross-workspace paths.
const QUOTED = /["'`]([^"'\`\n]{2,200})["'`]/g;
const changedSet = new Set(changed);
const deleted = changed.filter((f) => !statSync(f, { throwIfNoEntry: false }));
const changedUnder = (dir) => changed.some((f) => f.startsWith(dir + "/"));
for (const test of allTests) {
	if (affected.has(test)) continue;
	const text = readFileSync(test, "utf8");
	for (const m of text.matchAll(QUOTED)) {
		const s = m[1];
		if (!/[/]|\.\w+$/.test(s)) continue; // not path-shaped
		let hit = false;
		for (const baseDir of [dirname(test), ROOT]) {
			const resolved = resolve(baseDir, s);
			const st = statSync(resolved, { throwIfNoEntry: false });
			if (st?.isFile() && changedSet.has(resolved)) {
				hit = true;
				break;
			}
			// Tree scan: a real one names a tree inside the repo ("worker/src",
			// "../src", "docs"). The join fragments ("../", "../../", "a/..",
			// absolute fixture paths) resolve to directories too, and they sit
			// above changed files all day, so those shapes are refused.
			if (st?.isDirectory() && resolved.startsWith(ROOT + "/")) {
				const trimmed = s.replace(/\/+$/, "");
				if (trimmed && trimmed !== "." && trimmed !== ".." && !trimmed.endsWith("/..") && !trimmed.endsWith("/.")) {
					if (changedUnder(resolved)) {
						hit = true;
						break;
					}
				}
			}
		}
		if (hit || deleted.some((f) => text.includes(basename(f)))) {
			affected.add(test);
			break;
		}
	}
}

if (LIST) {
	for (const t of affected) console.log(relative(ROOT, t));
	console.error(`${affected.size} of ${allTests.length} test files affected by ${changed.length} changed files`);
	process.exit(0);
}

if (affected.size === 0) {
	console.log(`no test file imports or names the ${changed.length} changed files; run npm test before pushing`);
	process.exit(0);
}
console.error(`running ${affected.size}/${allTests.length} test files affected by ${changed.length} changed files`);

const child = spawnSync(process.execPath, ["--test", ...affected], { stdio: "inherit" });
process.exitCode = child.status ?? 1;
