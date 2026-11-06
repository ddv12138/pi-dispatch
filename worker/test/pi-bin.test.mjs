import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { piVersionOf, resolvePiBinary } from "../src/pi-bin.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

// The two cases here cover `piVersionOf` and `resolvePiBinary` in pi-bin.mjs (the updates command's look still needs
// them). These cases only need a bin folder and a fake pi, so the fixture is trimmed to that.

/**
 * A bin folder with a fake pi that answers `--version` with `version` (pass null's garbage for a pi that answers
 * wrongly) and logs which PI_CONSOLE_* and KEEP_* variables it can see, so the env filter is judged by what the child
 * actually received rather than by what the code intends. Returns `{root, bin, pi}`.
 */
function fakePi({ version = "1.2.0" } = {}) {
	const root = tempDir("pi-bin-");
	const bin = join(root, "bin");
	mkdirSync(bin);
	const pi = join(bin, "pi");
	writeFileSync(pi, `#!/bin/sh\nif [ "$1" = "--version" ]; then env | grep '^PI_CONSOLE_' > "${root}/console-env.log"; env | grep '^KEEP_' > "${root}/kept-env.log"; echo "${version}"; exit 0; fi\nexit 1\n`);
	chmodSync(pi, 0o755);
	return { root, bin, pi };
}

test("the pi binary: --pi, else PATH, else the installed package, else an install hint; its version from --version", () => {
	const w = fakePi();
	assert.deepEqual(resolvePiBinary({ flag: w.pi, env: {} }), { path: w.pi, from: "--pi" });
	const plainFile = join(w.root, "not-exec");
	writeFileSync(plainFile, "");
	assert.match(resolvePiBinary({ flag: plainFile, env: {} }).refusal, /is not an executable file/);
	assert.deepEqual(resolvePiBinary({ env: { PATH: `relative:${w.bin}` }, resolvePackage: () => null }), { path: w.pi, from: "PATH" }, "a relative PATH entry is skipped, an absolute one is used");
	assert.deepEqual(resolvePiBinary({ env: { PATH: "" }, resolvePackage: () => w.pi }), { path: w.pi, from: "the installed @earendil-works/pi-coding-agent" });
	assert.match(resolvePiBinary({ env: { PATH: "" }, resolvePackage: () => null }).refusal, /no pi to run: install pi \(npm install -g @earendil-works\/pi-coding-agent\) or pass --pi/);
	assert.equal(piVersionOf(w.pi), "1.2.0");
	assert.equal(piVersionOf(fakePi({ version: "garbage" }).pi), null, "a first line that is not x.y.z is no version");
	assert.equal(piVersionOf(join(w.root, "missing")), null);
});

test("no PI_CONSOLE_* variable reaches pi --version, and the rest of the environment does", () => {
	// The direct `childEnv` unit assertion is not possible (childEnv is private in pi-bin.mjs), so both directions of
	// the filter are read off what the child received: no console credential, and an unrelated variable still through.
	const w = fakePi();
	const env = { ...process.env, PI_CONSOLE_TOKEN: "pdc_secret", PI_CONSOLE_URL: "127.0.0.1:1", KEEP_ME: "yes" };
	assert.equal(piVersionOf(w.pi, { env }), "1.2.0");
	assert.equal(readFileSync(join(w.root, "console-env.log"), "utf8"), "", "the console's credentials never reach pi");
	assert.equal(readFileSync(join(w.root, "kept-env.log"), "utf8"), "KEEP_ME=yes\n", "everything else does");
});
