import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tempDir } from "./helpers/temp-dir.mjs";
import { adaptSubagentsAliases, prepareSubagentsCompat, subagentsSourceDigest } from "../src/subagents-compat.mjs";

const fixture = new URL("./fixtures/pi-subagents-0.73.1/runner-aliases.js", import.meta.url);

test("reviewed alias adaptation resolves the exact pi pin and preserves other hosts", async () => {
	const source = fs.readFileSync(fixture, "utf8");
	const dir = tempDir("subagents-compat-");
	const file = join(dir, "aliases.mjs");
	fs.writeFileSync(file, adaptSubagentsAliases(source));
	const { resolveHostPeerAliases } = await import(pathToFileURL(file).href);
	const piRoot = dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
	const manifest = JSON.parse(fs.readFileSync(join(piRoot, "package.json"), "utf8"));
	assert.equal(manifest.version, "1.5.0", "verify pi-subagents compatibility against the new pi pin before updating this assertion");
	assert.deepEqual(resolveHostPeerAliases(piRoot).missing, []);
	const fake = join(dir, "pi");
	fs.mkdirSync(join(fake, "node_modules"), { recursive: true });
	fs.symlinkSync(join(dirname(dirname(piRoot)), "@earendil-works"), join(fake, "node_modules/@earendil-works"));
	fs.symlinkSync(join(dirname(dirname(piRoot)), "typebox"), join(fake, "node_modules/typebox"));
	fs.writeFileSync(join(fake, "index.js"), "");
	for (const version of ["1.2.0", "1.5.0", "1.6.0"]) {
		fs.writeFileSync(join(fake, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version, main: "index.js" }));
		const missing = resolveHostPeerAliases(fake).missing;
		if (version === "1.6.0") {
			assert.ok(missing.includes("@earendil-works/pi-agent-core/node"));
			assert.ok(missing.includes("@earendil-works/chord"));
		} else assert.deepEqual(missing, []);
	}
	assert.throws(() => adaptSubagentsAliases(source + "\n"), /reviewed version/);
});

test("altered and symlinked package trees are refused before mutation", () => {
	const dir = tempDir("subagents-tree-");
	fs.mkdirSync(join(dir, "src/runs/background"), { recursive: true });
	const path = join(dir, "src/runs/background/runner-aliases.js");
	const source = fs.readFileSync(fixture, "utf8");
	fs.writeFileSync(path, source);
	assert.throws(() => prepareSubagentsCompat({ root: dir, fs }), /does not match/);
	assert.equal(fs.readFileSync(path, "utf8"), source);
	fs.symlinkSync(path, join(dir, "unexpected"));
	assert.throws(() => subagentsSourceDigest(dir, fs), /unsafe-source/);
});

test("the source digest tracks paths, types and bytes but ignores the separately installed dependency tree", () => {
	const dir = tempDir("subagents-digest-");
	fs.mkdirSync(join(dir, "folder"));
	fs.writeFileSync(join(dir, "folder/file"), "original");
	const original = subagentsSourceDigest(dir, fs);
	fs.mkdirSync(join(dir, "node_modules"));
	fs.writeFileSync(join(dir, "node_modules/dependency"), "not part of the source pin");
	assert.equal(subagentsSourceDigest(dir, fs), original);
	fs.writeFileSync(join(dir, "folder/file"), "changed");
	assert.notEqual(subagentsSourceDigest(dir, fs), original);
	fs.writeFileSync(join(dir, "folder/file"), "original");
	fs.mkdirSync(join(dir, "empty"));
	assert.notEqual(subagentsSourceDigest(dir, fs), original);
});
