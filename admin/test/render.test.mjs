import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderWhatIf } from "../src/render.mjs";

test("render.mjs has no path to raw .log content", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/render.mjs", import.meta.url)), "utf8");
  // A renderer has no I/O: no fs read and no call into the log tail. (A doc comment may name `.log`;
  // what matters is that no code path reads one.) The ban is on THIS module's own reads, not on its
  // import graph -- and that distinction is load-bearing rather than academic: render.mjs imports
  // panel.mjs (pure, asserted so by panel.test.mjs) and newer-release.mjs. What must stay absent is a
  // read written HERE, which is what this regex sees.
  assert.ok(
    !/readLogTail|readFileSync|\breadFile\b|require\(|import\s+.*node:fs/.test(src),
    "renderers must never read raw log content -- that surface belongs to the overlay viewer only",
  );
});

test("renderWhatIf shows the token estimate and the target's context profile; an unmeasured flow stays honest", () => {
  const est = renderWhatIf(
    { class: "estimated", tokens: 1_250_000, perRun: 125_000, coverage: 0.8, excluded: 2, contextWindow: 200_000, contextShare: 0.625 },
    { flow: "fix", target: "anthropic/claude-sonnet-4" },
  );
  assert.match(est, /What-if fix @ anthropic\/claude-sonnet-4:/);
  assert.match(est, /~1\.25M est\. total · ~125k est\. per run/);
  assert.match(est, /coverage 80% of observed runs ledgered · excluded 2 \(no ledger\)/);
  assert.match(est, /a median run fills 63% of the target model's context window/, "the profile comparison the what-if exists for");

  const noProfile = renderWhatIf(
    { class: "estimated", tokens: 100, perRun: 10, coverage: 1, excluded: 0 },
    { flow: "fix", target: "anthropic/claude-sonnet-4" },
  );
  assert.doesNotMatch(noProfile, /context window/, "a target with no declared window adds no profile line");

  const unknown = renderWhatIf(
    { class: "unknown", note: "unmeasured" },
    { flow: "new-flow", target: "anthropic/claude-sonnet-4" },
  );
  assert.match(unknown, /— \(unmeasured\)/, "the fold's own note rides through verbatim behind the honest em dash");
  assert.doesNotMatch(unknown, /\$|~\d/, "an unmeasured flow never reads like a measurement");
});
