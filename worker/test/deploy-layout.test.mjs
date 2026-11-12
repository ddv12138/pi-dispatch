/**
 * The layout a Compose deployment assumes: ONE checkout, ONE deploy/ tree.
 *
 * The worker was published to npm until that stopped being how this project ships: a package had to carry its own
 * copies of deploy/ and .env.example under worker/, because `npm pack` ships only the worker directory. Publishing is
 * gone -- a deployment clones the repository and runs the images built from it, and deploy/worker.Dockerfile copies
 * the whole repo into /opt/pi-dispatch -- so worker/deploy and worker/.env.example were a second copy of files that
 * are always beside the code, and were deleted. The worker resolves the shipped rules and the .env example from the
 * repo root's deploy/ and .env.example (worker/src/egress-conf-copy.mjs, worker/src/init.mjs).
 *
 * Three families of assertion:
 *   - layout: the deleted mirrors stay gone, and the paths the code resolves actually exist and carry the files the
 *     compose deployment mounts (the flow skills are the one that fails silently when absent: a missing mount source
 *     is an empty directory, and a job naming the flow loads no SKILL.md and exits 0).
 *   - exports: every worker subpath the receiver and console import exists in the worker's exports map, because those
 *     imports resolve against the on-disk package.
 *   - drift: the pre-rename `@pi-dispatch/worker` specifier must never come back.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PACKAGED_EGRESS_PROXY_CONF, readPackagedProxyConf } from "../src/egress-conf-copy.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKER_DIR = join(REPO_ROOT, "worker");
const RECEIVER_DIR = join(REPO_ROOT, "receiver");

// ---------------------------------------------------------------------------------------------------
// layout: one deploy/ tree, one .env.example, both at the repo root
// ---------------------------------------------------------------------------------------------------

test("layout: the worker-local copies of deploy/ and .env.example do not come back", () => {
	// Both existed only for `npm pack`, which shipped the worker directory alone. A deployment is a clone (or the
	// images built from it), where the repo root's files are always present; a second copy only drifts, and did
	// (SKILL.md edited in one and not the other on 2026-11-12).
	assert.equal(existsSync(join(WORKER_DIR, "deploy")), false, "worker/deploy is gone -- edit deploy/ at the repo root; the worker resolves it there");
	assert.equal(existsSync(join(WORKER_DIR, ".env.example")), false, "worker/.env.example is gone -- edit .env.example at the repo root; init falls back to it");
});

test("layout: the shipped rules and the env example resolve to the repo root's files", () => {
	// PACKAGED_EGRESS_PROXY_CONF is `../../deploy/` from worker/src: the repo root in a checkout and, in the worker
	// image, /opt/pi-dispatch/deploy -- the Dockerfile copies the whole repo, so both are the same file.
	assert.equal(resolve(PACKAGED_EGRESS_PROXY_CONF), join(REPO_ROOT, "deploy", "egress-proxy.conf"), "doctor compares a deployment's rules with this file");
	assert.ok(readPackagedProxyConf().includes("include /etc/pi-dispatch/model-endpoints.conf"), "and it is the rules file itself, not an empty or placeholder copy");
	// init's fallback, for a folder with no .env.example of its own: `../../.env.example` from worker/src.
	const example = fileURLToPath(new URL("../../.env.example", import.meta.url));
	assert.equal(example, join(REPO_ROOT, ".env.example"));
	assert.match(readFileSync(example, "utf8"), /^# VALKEY_PASSWORD=$/m, "the example init copies, with the line it fills in");
});

test("layout: the compose file mounts the flow skills whole, and this tree holds them", () => {
	// The mount source is the ONE directory worker/src/init.mjs and the skills runtime agree on. A missing source is
	// created as an empty directory by Docker, so nothing errors; the job just gets no skill.
	const compose = readFileSync(join(REPO_ROOT, "deploy", "docker-compose.yml"), "utf8");
	assert.match(compose, /- "\.\/skills:\/opt\/pi-skills:ro"/, "deploy/docker-compose.yml mounts deploy/skills at the fixed container path");
	for (const flow of ["ticket-merge", "ticket-run"]) {
		const skill = join(REPO_ROOT, "deploy", "skills", flow, "SKILL.md");
		assert.ok(existsSync(skill), `${flow} ships its SKILL.md under deploy/skills, the mount's source`);
		assert.match(readFileSync(skill, "utf8"), /^---/m, `${flow}/SKILL.md opens with the front matter the runner reads`);
	}
});

// ---------------------------------------------------------------------------------------------------
// exports: the worker subpaths the console and receiver import must be spelled out
// ---------------------------------------------------------------------------------------------------

test("every worker subpath the receiver and console import EXISTS in the worker's exports map", () => {
	// The workspaces are symlinked, so in this repo a subpath import resolves against the on-disk worker
	// and a missing exports entry can never fail a test here: it fails on the first real deployment image
	// that imports the receiver or console, at module load. The map is hand-kept and the imports are
	// scattered, which is the shape the derived-or-pinned rule exists for. gateway/src left with the
	// sandbox prune.
	const exportsMap = JSON.parse(readFileSync(join(WORKER_DIR, "package.json"), "utf8")).exports;
	const importRe = /@edgehero\/pi-dispatch\/([A-Za-z0-9-]+)/g;
	const used = new Map(); // subpath -> first file seen importing it
	for (const dir of [join(RECEIVER_DIR, "src"), join(REPO_ROOT, "admin", "src")]) {
		// Recursive, so the scan keeps protecting the day either src/ grows a subdirectory.
		for (const name of readdirSync(dir, { recursive: true })) {
			if (!/\.(mjs|ts)$/.test(name)) continue;
			const src = readFileSync(join(dir, name), "utf8");
			for (const m of src.matchAll(importRe)) if (!used.has(m[1])) used.set(m[1], join(dir, name));
		}
	}
	assert.ok(used.size >= 5, `the scan must find the known imports (triggers, queue, connection, ...); it found ${used.size} -- an empty scan is a broken scan, not a clean bill`);
	for (const [sub, file] of used) {
		assert.ok(exportsMap[`./${sub}`], `${file} imports @edgehero/pi-dispatch/${sub} but the worker exports map has no "./${sub}" -- the deployed receiver or console throws at module load`);
	}
});

// ---------------------------------------------------------------------------------------------------
// drift: the pre-rename specifier must never come back
// ---------------------------------------------------------------------------------------------------

test("drift: the old @pi-dispatch/worker specifier appears nowhere in receiver/src or admin/src", () => {
	const offenders = [];
	for (const dir of [join(RECEIVER_DIR, "src"), join(REPO_ROOT, "admin", "src")]) {
		for (const rel of readdirSync(dir, { recursive: true })) {
			if (!/\.(mjs|ts)$/.test(rel)) continue;
			if (readFileSync(join(dir, rel), "utf8").includes("@pi-dispatch/worker")) offenders.push(join(dir, rel));
		}
	}
	assert.deepEqual(offenders, [], "imports (and comments) must use @edgehero/pi-dispatch — the old name resolves to nothing");
});
