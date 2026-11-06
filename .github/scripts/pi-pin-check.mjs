/**
 * Every pi package this repository installs is the ONE release the runner pins (CONST-PI-VERSION-PINNED, issue #587).
 *
 * THE FAILURE THIS EXISTS FOR is new at pi 1.0.1. Up to pi 0.99.1 pi-coding-agent shipped an npm-shrinkwrap.json, so
 * its own pi-ai, pi-agent-core and the rest were locked by pi itself. 1.0.1 dropped the shrinkwrap, and
 * pi-coding-agent depends on its siblings by a RANGE (`^1.0.3`). A lockfile regenerated on another day can then
 * resolve a sibling to a newer release than the one every pinned assumption was checked against, with every pin in
 * every package.json still exact. So the root package.json carries an `overrides` block that pins each pi package to
 * the runner's pin, and this checks both halves:
 *   - the overrides name every pi package a workspace of this repository installs directly, each at the pin;
 *   - every pi package entry in package-lock.json (at any depth) is at the pin, which also holds the ones only pi's
 *     own tree installs (pi-coding-agent's pi-tui): they ride pi's own pin and need no override;
 *   - the places the pin is written by hand agree with it: the runner's pi-mcp and pi-agent-core, the worker's pi-ai,
 *     image/Dockerfile's PI_VERSION and the durable-install commands in README.md.
 *
 * `piPinProblems` is pure (the files are handed in) so its test pins the rule on constructed input as well as on this
 * repository's own files. Run as a script it reads the repository and exits 1 on any problem.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SCOPE = "@earendil-works/";
/** One documented command per file; the bump uses the same sites and version capture. */
export const PI_DOC_SITES = Object.freeze(["README.md"]);
export const PI_DOC_VERSION_RE = /@earendil-works\/pi-coding-agent@([^\s`]+)/;

/** The problems with these files' pi pins, as sentences; empty when every pin agrees. */
export function piPinProblems({ root, lock, runner, worker, dockerfile, documents }) {
	const problems = [];
	const pin = runner?.dependencies?.[`${SCOPE}pi-coding-agent`];
	if (typeof pin !== "string" || !/^\d+\.\d+\.\d+$/.test(pin)) return [`image/runner/package.json pins pi-coding-agent at ${JSON.stringify(pin)}, not an exact version`];
	const want = (where, value) => {
		if (value !== pin) problems.push(`${where} is ${JSON.stringify(value)}, not the pin ${pin}`);
	};
	// The runner builds its MCP transports from pi-mcp itself (src/mcp.mjs), and pi treats a StdioTransport instance
	// specially, so the two must be one copy at one version.
	want("image/runner/package.json's @earendil-works/pi-mcp", runner?.dependencies?.[`${SCOPE}pi-mcp`]);
	// The runner imports runToolCall from pi-agent-core itself (issue #645, src/recover.mjs), because pi-coding-agent does
	// not re-export it; the runner's copy must be the one pi-coding-agent loads, whose hooks and tools it is handed.
	want("image/runner/package.json's @earendil-works/pi-agent-core", runner?.dependencies?.[`${SCOPE}pi-agent-core`]);
	want("worker/package.json's @earendil-works/pi-ai", worker?.dependencies?.[`${SCOPE}pi-ai`]);
	want("image/Dockerfile's PI_VERSION", /^ARG PI_VERSION=(\S*)$/m.exec(dockerfile ?? "")?.[1]);
	for (const path of PI_DOC_SITES) {
		const copies = [...String(documents?.[path] ?? "").matchAll(new RegExp(PI_DOC_VERSION_RE.source, "g"))];
		if (copies.length !== 1) problems.push(`${path} holds ${copies.length} documented pi installation pins, want exactly one`);
		else want(`${path}'s documented pi installation pin`, copies[0][1]);
	}
	const overrides = root?.overrides ?? {};
	const locked = new Map();
	// The pi packages THIS repository installs directly, read off the root and the workspace entries. Only these need an
	// override; a pi package only pi's own tree installs (pi-coding-agent's pi-tui) rides pi's own pin, which the
	// lockfile check below holds at the pin all the same.
	const declared = new Set();
	for (const [path, entry] of Object.entries(lock?.packages ?? {})) {
		if (!path.includes("node_modules/")) {
			for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
				for (const name of Object.keys(entry?.[field] ?? {})) if (name.startsWith(SCOPE) && name.split("/").length === 2) declared.add(name);
			}
			continue;
		}
		const at = path.lastIndexOf(`node_modules/${SCOPE}`);
		if (at < 0) continue;
		const name = path.slice(at + "node_modules/".length);
		if (name.split("/").length !== 2) continue;
		locked.set(path, { name, version: entry?.version });
	}
	if (locked.size === 0) problems.push("package-lock.json holds no pi package at all");
	for (const [path, { name, version }] of locked) want(`package-lock.json's ${path}`, version);
	const named = new Set([...[...locked.values()].filter(({ name }) => declared.has(name)).map(({ name }) => name), ...Object.keys(overrides).filter((name) => name.startsWith(SCOPE))]);
	for (const name of named) want(`package.json's overrides["${name}"]`, overrides[name]);
	return problems;
}

/** This repository's files, as piPinProblems reads them. */
export function repositoryPins(repo) {
	const json = (path) => JSON.parse(readFileSync(new URL(path, repo), "utf8"));
	return {
		root: json("package.json"),
		lock: json("package-lock.json"),
		runner: json("image/runner/package.json"),
		worker: json("worker/package.json"),
		dockerfile: readFileSync(new URL("image/Dockerfile", repo), "utf8"),
		documents: Object.fromEntries(PI_DOC_SITES.map((path) => [path, readFileSync(new URL(path, repo), "utf8")])),
	};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const problems = piPinProblems(repositoryPins(new URL("../../", import.meta.url)));
	for (const problem of problems) console.error(`::error::${problem}`);
	if (problems.length > 0) process.exit(1);
	console.log("OK: every pi package, override and hand-written pin is the runner's pin");
}
