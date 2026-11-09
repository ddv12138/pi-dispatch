/**
 * The shared text bits: a read-model value in, a display string out. No I/O, no clock, no process.env -- every
 * input is a value the caller already fetched, so these are testable with plain fixtures.
 *
 * This is what survives of the retired `/dispatch` extension's renderer: the scoped-limit size sentence the write
 * planners use (`sizeBits`) and the spend panel's what-if answer (`renderWhatIf`). The dashboard-only renderers died
 * with the panel (58ef2369); the allocation block and its satellites went with the allocation and token budgets
 * (C2).
 *
 * PII discipline (no-pii-in-logs): a function here only ever sees PII-free record fields and token counts.
 * Raw `.log` bytes are untrusted, PII-bearing container output and NEVER reach this module (asserted by
 * render.test.mjs).
 */

// Pure-to-pure: panel.mjs is the admin's other no-I/O text module (asserted so by panel.test.mjs), and
// fmtAmount is THE single renderer of typed cost values, so the what-if below routes every token figure
// through it rather than grow a second token formatter here. `scrubControls` is the one substitution a
// printed string goes through (via `cell` below).
import { fmtAmount, scrubControls } from "./panel.mjs";
import { newerSkippedSentence } from "./newer-release.mjs";

/**
 * One cell of a record: a nullish field renders as "-" so a stable record shape reads cleanly, and a
 * control byte becomes a space (THE SCRUB LIVES HERE rather than at the call sites, issue #367: deleting
 * instead of substituting would make the cells clip differently). C1 is in the class as well as C0 and
 * DEL, because U+009B is a CSI introducer that needs no ESC in front of it.
 */
function cell(value) {
  if (value === null || value === undefined) return "-";
  return scrubControls(value);
}

/**
 * A scoped-limits row's size, as display bits (issue #596): `memory 4g`, `2 CPUs`, `hostShare 50%` and `minJobs 2`,
 * set fields only. Shared by the insights assembler and the write planners, so every surface says a size the
 * same way. Phase 1 marked the last two "not enforced yet"; each worker's host budget enforces them since phase 2.
 */
export function sizeBits(l) {
  const bits = [];
  if (typeof l?.memory === "string") bits.push(`memory ${l.memory}`);
  if (typeof l?.cpus === "number") bits.push(`${l.cpus} CPU${l.cpus === 1 ? "" : "s"}`);
  if (Number.isInteger(l?.hostShare)) bits.push(`hostShare ${l.hostShare}%`);
  if (Number.isInteger(l?.minJobs)) bits.push(`minJobs ${l.minJobs}`);
  return bits;
}

/**
 * Render one `whatIfFlow` estimate (costs.mjs) as a compact block for the console's spend panel. The measured path
 * shows the estimate through `fmtAmount` with its coverage/excluded honesty, plus the target model's profile
 * comparison (whatIfFlow's `contextShare`: how much of one context window a median run occupies, omitted when the
 * target declares none); the zero-knowledge path shows the unmeasured note through `fmtAmount`'s honest em dash --
 * so an unmeasured flow can never read like a measurement.
 */
export function renderWhatIf(result, { flow, target } = {}) {
  const head = `What-if ${flow} @ ${target}:`;
  if (!result || typeof result !== "object") return `${head}\n  no estimate`;
  // Issue #761: one more line only when records from a newer pi-dispatch were left out, so every other answer reads as before.
  const newer = newerSkippedSentence(result.newerSkipped);
  const tail = newer ? [`  ${newer}`] : [];
  if (result.class !== "estimated") {
    return [head, `  ${fmtAmount(result)}${result.note ? ` (${result.note})` : ""}`, ...tail].join("\n");
  }
  const pct = Math.round((result.coverage ?? 0) * 100);
  const share = typeof result.contextShare === "number" ? `  a median run fills ${Math.round(result.contextShare * 100)}% of the target model's context window` : null;
  return [
    head,
    `  estimate ${fmtAmount({ tokens: result.tokens, class: "estimated" })} total · ${fmtAmount({ tokens: result.perRun, class: "estimated" })} per run`,
    `  coverage ${pct}% of observed runs ledgered · excluded ${result.excluded} (no ledger)`,
    ...(share ? [share] : []),
    ...tail,
  ].join("\n");
}
