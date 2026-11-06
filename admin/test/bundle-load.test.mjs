import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, fork } from "node:child_process";
import { readFileSync, symlinkSync } from "node:fs";
import { once } from "node:events";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { NODE_BUNDLE_OPTIONS, NODE_REQUIRE_PRELUDE } from "../bundle-options.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

// The retirement of the /dispatch extension (issue #640's console, 58ef2369) left the console CLI the package's one
// published ESM entry point; the sandbox monitor beside it is the next test's subject.
test("the published ESM entry point loads in plain Node without jiti's CommonJS require", async () => {
  const dir = tempDir("dispatch-esm-bundle-");
  symlinkSync(fileURLToPath(new URL("../../node_modules", import.meta.url)), join(dir, "node_modules"), "junction");
  for (const [entry, exported] of [["console/cli.mjs", "runCli"]]) {
    const outfile = join(dir, entry.replaceAll("/", "-").replace(/\.(ts|mjs)$/, ".mjs"));
    await build({ ...NODE_BUNDLE_OPTIONS, entryPoints: [fileURLToPath(new URL(`../src/${entry}`, import.meta.url))], outfile, banner: { js: NODE_REQUIRE_PRELUDE }, logLevel: "silent" });
    const program = `import assert from "node:assert/strict"; assert.equal(typeof require, "undefined"); const mod = await import(${JSON.stringify(pathToFileURL(outfile).href)}); assert.equal(typeof mod[${JSON.stringify(exported)}], "function"); console.log("loaded");`;
    assert.equal(execFileSync(process.execPath, ["--input-type=module", "--eval", program], { encoding: "utf8", timeout: 30_000 }).trim(), "loaded");
  }
});
