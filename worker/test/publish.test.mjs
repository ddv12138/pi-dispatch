/**
 * The packaging contract that survives container-only deployment: the worker is no longer published to
 * npm, so this file asserts nothing about publishable manifests or `npm pack` tarballs.
 *
 * Three families of assertion:
 *   - sync: the package-local copies that make a deployment self-sufficient (worker/.env.example,
 *     worker/deploy/*) are byte-identical to their repo-root originals — the ROOT copies stay the
 *     documented, edited ones; the mirrors only ship.
 *   - exports: every worker subpath the receiver and console import exists in the worker's exports map,
 *     because those imports resolve against the on-disk package.
 *   - drift: the pre-rename `@pi-dispatch/worker` specifier must never come back.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKER_DIR = join(REPO_ROOT, "worker");
const RECEIVER_DIR = join(REPO_ROOT, "receiver");

// The entries worker/deploy must mirror and ship: the compose file every deployment is run from (a packaged
// deployment has no repo checkout to read deploy/docker-compose.yml from), the egress policy's RULES, the
// container images' build inputs, and the flow skills the compose service mounts. Nothing renders them;
// they ship because the compose file and the image builds name them.
const MIRRORED_DEPLOY = [
	// The shipped compose topology the docs point every deployment at.
	"docker-compose.yml",
	// The egress policy's RULES (REQ-EGRESS-ALLOWLIST). A deployment artifact, not operator config, and
	// the distinction this file's own comment asks to be decided: it ships unedited, the compose service
	// mounts it, and the operator's own list lives in the deployment folder where `init` scaffolds it.
	"egress-proxy.conf",
	// The Maven cache proxy's RULES (the 4.3.7 deployment, docs/253-deployment.md): same reasoning as
	// egress-proxy.conf -- ships unedited, the maven-proxy service mounts it, the operator's own state
	// (the hosted artifacts tree) lives in the deployment folder.
	"maven-proxy.conf",
	// The ticket flows' skills (4ac16f08): a DIRECTORY, mounted whole at /opt/pi-skills by the compose
	// service. A package that ships the compose file and not this tree mounts an empty directory, and a
	// job naming the flow then loads no SKILL.md and exits 0 without doing the work.
	"skills",
	// The worker and console images' build inputs (e9d67831): the compose file builds the worker from
	// the Dockerfile it sits beside, so a packaged deployment needs both exactly as a checkout has them.
	"worker.Dockerfile",
	"worker.Dockerfile.dockerignore",
].sort();

// Everything the ROOT deploy/ holds: the mirrored set above, plus the operator-facing example triggers files
// that stay behind (`triggers.json` is read by the receiver's tests and pointed at by the docs; the ticket
// flows' example is the reference for a deployment that runs them). Nothing else belongs here: a config file
// dropped in among these reads as a deployment artifact and is not one -- the worker resolves triggers.json,
// pause-windows.json and friends from the DEPLOYMENT folder or an explicit env path, never from this
// directory (issue #104, which is where deploy/pause-windows.json sat unread since the day it was added).
const ROOT_DEPLOY = [...MIRRORED_DEPLOY, "triggers.json", "triggers.ticket.example.json"].sort();

/** Every file under `dir`, as a `/`-joined path relative to it, sorted: a mirrored DIRECTORY compared as a tree. */
function filesUnder(dir, prefix = "") {
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
		if (entry.isDirectory()) out.push(...filesUnder(join(dir, entry.name), rel));
		else out.push(rel);
	}
	return out.sort();
}

// ---------------------------------------------------------------------------------------------------
// sync: the shipped mirrors track their repo-root originals byte for byte
// ---------------------------------------------------------------------------------------------------

test("sync: worker/.env.example is byte-identical to the root .env.example", () => {
	assert.equal(
		readFileSync(join(WORKER_DIR, ".env.example"), "utf8"),
		readFileSync(join(REPO_ROOT, ".env.example"), "utf8"),
		"the ROOT .env.example is the documented, edited copy — after changing it, re-copy it to worker/.env.example (the packaged copy init falls back to)",
	);
});

test("sync: every worker/deploy file is byte-identical to its root deploy/ twin", () => {
	assert.deepEqual(
		readdirSync(join(WORKER_DIR, "deploy")).sort(),
		MIRRORED_DEPLOY,
		"worker/deploy must hold exactly the entries the compose file and the image builds need — nothing missing, no strays",
	);
	for (const name of MIRRORED_DEPLOY) {
		const root = join(REPO_ROOT, "deploy", name);
		const mirror = join(WORKER_DIR, "deploy", name);
		if (statSync(root).isDirectory()) {
			// A tree, not a file: the compose service mounts deploy/skills whole, so the package must carry it whole.
			const files = filesUnder(root);
			assert.deepEqual(filesUnder(mirror), files, `worker/deploy/${name} must hold exactly deploy/${name}'s files`);
			for (const rel of files) {
				assert.equal(
					readFileSync(join(mirror, rel), "utf8"),
					readFileSync(join(root, rel), "utf8"),
					`worker/deploy/${name}/${rel} drifted from deploy/${name}/${rel} — the ROOT deploy/ is the documented source; edit both (copy root over the mirror)`,
				);
			}
			continue;
		}
		assert.equal(
			readFileSync(mirror, "utf8"),
			readFileSync(root, "utf8"),
			`worker/deploy/${name} drifted from deploy/${name} — the ROOT deploy/ is the documented source; edit both (copy root over the mirror)`,
		);
	}
});

test("sync: the root deploy/ holds the mirrored files and the example triggers file, nothing else", () => {
	// The mirror test above enumerates worker/deploy and only INDEXES root deploy/ by name, so a stray
	// under deploy/ is invisible to it — which is how a dead pause-windows.json lived there unread. This
	// is the other direction: a new file here is either a deployment artifact that belongs in the mirror,
	// or operator config that belongs in the deployment folder. Adding it to this list is the moment to
	// decide which.
	assert.deepEqual(
		readdirSync(join(REPO_ROOT, "deploy")).sort(),
		ROOT_DEPLOY,
		"an unexpected file under deploy/ — mirror it into worker/deploy (and MIRRORED_DEPLOY) if it ships, or move it out if it is operator config that nothing here reads",
	);
});

// The worker image's ignore file REPLACES the root .dockerignore for that build (Docker reads the file named
// `<dockerfile>.dockerignore` beside the Dockerfile first), and compose builds it with the DEPLOYMENT folder as
// context. Excluding the exact name `.env` therefore left every backup an operator keeps beside it in the layer:
// measured on the 253 deployment, the image carried `.env.bak-<date>` files holding the GitLab
// token, the provider key and the Valkey password. The example is re-included because `worker/src/init.mjs` reads
// it from the package, so a containerized `init` keeps working.
test("the worker image's ignore file keeps credential backups out and the shipped example in", () => {
	for (const path of ["../../deploy/worker.Dockerfile.dockerignore", "../deploy/worker.Dockerfile.dockerignore"]) {
		const patterns = readFileSync(new URL(path, import.meta.url), "utf8")
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line !== "" && !line.startsWith("#"));
		const last = (pattern) => patterns.lastIndexOf(pattern);
		assert.ok(patterns.includes(".env") && patterns.includes("**/.env"), `${path}: the exact names stay excluded`);
		assert.ok(patterns.includes(".env.*") && patterns.includes("**/.env.*"), `${path}: a variant beside .env holds every credential, so the pattern has to cover it`);
		// Docker's last matching pattern wins, so the example must be re-included AFTER the variant pattern.
		assert.ok(last("!.env.example") > last(".env.*"), `${path}: !.env.example must follow .env.* or Docker's last match drops the example`);
		assert.ok(last("!**/.env.example") > last("**/.env.*"), `${path}: !**/.env.example must follow **/.env.*`);
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
