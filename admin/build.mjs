/** Build the operator console for publishing. */
import { build } from "esbuild";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NODE_BUNDLE_OPTIONS, NODE_REQUIRE_PRELUDE } from "./bundle-options.mjs";

const here = dirname(fileURLToPath(import.meta.url));

// A build may reuse a dist directory from an older release. Do not ship its retired extension.
await rm(join(here, "dist/index.mjs"), { force: true });

// The operator console's command (issue #640), a second program from the same sources: `pi-dispatch-console`, the
// package's `bin`. Same bundling rule as the extension (worker internals inlined, the heavy deps external, so the
// published tarball still needs nothing it does not declare); the pi runtime stays external too, though the console
// never imports it, so a stray transitive import fails loudly at load rather than bundling pi. The banner is the
// shebang npm's bin shim needs; esbuild keeps it as the file's first line.
await build({
	...NODE_BUNDLE_OPTIONS,
	entryPoints: [join(here, "src/console/cli.mjs")],
	outfile: join(here, "dist/console.mjs"),
	banner: { js: `#!/usr/bin/env node\n// pi-dispatch operator console (bundled). Source: https://github.com/edgehero/pi-dispatch\n${NODE_REQUIRE_PRELUDE}` },
	logLevel: "info",
});

console.log("[built admin/dist/console.mjs]");
