// The console's bundle stays free of the model provider SDKs (issue #710, review round 1).
//
// This bundles the console's entry exactly as admin/build.mjs does, in memory, and reads the metafile's per-input
// output bytes, so an import that esbuild's tree-shaking drops is not counted and one that lands in the file is,
// whatever its size.
import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The provider SDKs and pi-ai's API implementations: what the console has no use for. pi-ai's `api/lazy.js` is not
 * one: it is the few hundred bytes of loader stubs the model catalog (providers/all.js, on main too) reaches, which
 * import an implementation only when a stream is asked for.
 */
const HEAVY = [/node_modules\/openai\//, /node_modules\/@anthropic-ai\/sdk\//, /node_modules\/@google\/genai\//, /node_modules\/google-auth-library\//, /node_modules\/@earendil-works\/pi-ai\/dist\/api\/(?!lazy\.js$)/];

/** The inputs of `entry`'s bundle that put bytes in the output, as admin/build.mjs bundles it. */
async function bundledInputs(entry) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "node22",
    external: ["@earendil-works/pi-coding-agent", "bullmq", "ioredis"],
    metafile: true,
    logLevel: "silent",
  });
  const [output] = Object.values(result.metafile.outputs);
  return Object.entries(output.inputs).filter(([, v]) => v.bytesInOutput > 0).map(([k]) => k);
}

test("the console bundle carries no model provider SDK", async () => {
  const inputs = await bundledInputs(join(here, "../src/console/cli.mjs"));
  assert.deepEqual(inputs.filter((k) => HEAVY.some((re) => re.test(k))), []);
});

test("the record-reason leaf imports nothing: the console and the panel take the record's reason rule without the worker", async () => {
  const inputs = await bundledInputs(join(here, "../../worker/src/record-reason.mjs"));
  assert.deepEqual(inputs.map((k) => k.split("/").pop()), ["record-reason.mjs"]);
  assert.ok((await bundledInputs(join(here, "../src/console/cli.mjs"))).some((k) => k.endsWith("record-reason.mjs")), "the console bundles it");
});
