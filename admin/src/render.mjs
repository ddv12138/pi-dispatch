/**
 * The shared allocation and what-if text bits: a read-model record (or value) in, a display string out.
 * No I/O, no clock, no process.env -- every input is a value the caller already fetched, so these are
 * testable with plain fixtures.
 *
 * This is what survives of the retired `/dispatch` extension's renderer: the console's insights assembler and
 * the write planners (sizeBits, outsideEdit, splitTotalTokens), the spend panel's what-if answer (renderWhatIf),
 * and the allocation block whose words the insights page restates under a test (`renderAllocations` and its
 * satellites). The dashboard-only renderers died with the panel (58ef2369).
 *
 * PII discipline (no-pii-in-logs): a function here only ever sees PII-free record fields and token counts.
 * Raw `.log` bytes are untrusted, PII-bearing container output and NEVER reach this module (asserted by
 * render.test.mjs).
 */

// Pure-to-pure: panel.mjs is the admin's other no-I/O text module (asserted so by panel.test.mjs), and
// fmtAmount is THE single renderer of typed cost values, so the what-if below routes every token figure
// through it rather than grow a second token formatter here. `sliceColumns` measures a cut in display
// columns, `pad` lays the allocation table's columns out, and `scrubControls` is the one substitution a
// printed string goes through (via `cell` below).
import { clip, fmtAmount, pad, scrubControls, sliceColumns } from "./panel.mjs";
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
 * The cells of an `alloc:log` history row's instant (issue #507): `MM-DD HH:MM`, in UTC as written -- a split is
 * planned in days and the year is the one on the screen. A value that is not an ISO instant (a row another writer
 * set) is shown as its first 11 columns, never parsed.
 */
function allocAt(at) {
  const m = /^\d{4}-(\d{2}-\d{2})T(\d{2}:\d{2})/.exec(String(at ?? ""));
  return m ? `${m[1]} ${m[2]}` : sliceColumns(cell(at), 11);
}

/**
 * The outside-edit notice (issue #504 part C's banner, one rule since issue #507 for the insights page and the
 * console's spend panel): the NEWEST `envelope-changed-externally` row in `log` (newest first, as `alloc:log` is
 * read), when the envelope digest it reports is not the one the applied split was made for. Returned as its facts,
 * `{ digest, at, split }` (8-hex digests and an `MM-DD HH:MM` instant), or null.
 *
 * Historical on purpose: a host logs each digest once per process, so the log cannot say whether that host still runs
 * the edited file, nor see a hand restore; a later applied plan or a re-base to a third digest says nothing about the
 * host that refused either. The notice states what a host reported and when, and what follows for a host still on it.
 * Rejected: the earlier "newer than the last re-base or applied plan" rule, which cleared while that host still
 * refused and stayed after the edit was put back.
 */
export function outsideEdit(log, splitDigest) {
  if (typeof splitDigest !== "string" || splitDigest === "") return null;
  const row = (Array.isArray(log) ? log : []).find((r) => r?.outcome === "envelope-changed-externally");
  if (!row || typeof row.envelopeDigest !== "string" || row.envelopeDigest === splitDigest) return null;
  const hex8 = (d) => (/^[0-9a-f]{8}/.test(d) ? d.slice(0, 8) : "?");
  return { digest: hex8(row.envelopeDigest), at: allocAt(row.at), split: hex8(splitDigest) };
}

/**
 * The total an allocation view shows beside the split (issue #507): the applied split's OWN total, its allocations
 * plus its unallocated money, which the worker holds equal to the total of the envelope the split was made for. Not
 * this host's envelope file's: during an envelope mismatch that file may say $30.00 while every number beside it is
 * the applied $28.00 split, and the header, the headroom and the bars must agree with the numbers they sit beside.
 * The envelope's total when no split is applied, or when an amount of it is not a whole non-negative micro-dollar
 * count (that split does not decode as the worker's, and the view says so elsewhere).
 */
export function splitTotalTokens(state, envelopeTotalTokens) {
  if (!state || typeof state !== "object") return envelopeTotalTokens;
  const parts = [...Object.values(state.allocations ?? {}), state.unallocated ?? 0];
  if (!parts.every((n) => Number.isSafeInteger(n) && n >= 0)) return envelopeTotalTokens;
  const sum = parts.reduce((a, b) => a + b, 0);
  return Number.isSafeInteger(sum) ? sum : envelopeTotalTokens;
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

/**
 * The envelope's allocation as the block of text the insights page's numbers are pinned against (`insights-assembly.test.mjs`
 * drives this renderer and holds the page's restatement to it, word for word: the page loads neither this module nor the
 * read model, so this block is the one place the vocabulary lives). `/envelope` reads in, a display string out; NO reason
 * text: reasons are agent text (`REQ-DELEGATED-ALLOCATION`) and the page's channel never carries them.
 */
export function renderAllocations({ envelope = null, digest = null, problem = null, alloc = null, historyRows = 10 } = {}) {
  // `>= 0` as the counter's floor: a counter another writer set below 0 must not throw the whole view.
  const usd = (m) => (Number.isSafeInteger(m) && m >= 0 ? m.toLocaleString("en-US") : "-");
  if (!envelope) return `ALLOCATION\n${cell(problem ?? "no envelope")}`;
  const d = envelope.delegation ?? {};
  const rules = d.enabled ? `delegation on (${(d.writers ?? []).join(", ")}; step ${d.maxStepPct}%, interval ${d.minIntervalHours}h, plans up to ${d.maxPlanDays}d)` : "delegation off";
  // The split's own total beside the split (issue #507, `splitTotalTokens`), the envelope's when none is shown.
  const s = alloc && !alloc.unreachable ? alloc.state : null;
  const total = splitTotalTokens(s, envelope.totalTokens);
  const lines = [`ALLOCATION · ${envelope.window} · total ${usd(total)} · ${rules}`, `envelope ${cell(digest)}`];
  if (!alloc) return lines.join("\n");
  if (alloc.unreachable) return [...lines, `split unreadable (${cell(alloc.unreachable)})`].join("\n");
  if (alloc.stateProblem === "newer") lines.push("the applied split was written by a newer pi-dispatch: upgrade this console");
  else if (alloc.stateProblem === "unreadable") lines.push("the applied split does not decode; the next pickup replaces it with the neutral split");
  else if (!s) lines.push("no split applied yet: the first host to look writes the neutral split");
  if (s) {
    const plan = s.planId ? `plan ${cell(s.planId)}` : "neutral (no plan)";
    // The plan line word for word (issue #507), the instant through `allocAt` and the expiry as its date.
    lines.push(`${plan} · ${cell(s.writer)} · ${allocAt(s.appliedAt)}${s.validUntil ? ` · until ${sliceColumns(cell(s.validUntil), 10)}` : ""}`);
    if (s.clamped) lines.push("  clamped by the step");
    if (s.envelopeDigest !== digest) lines.push(`made for envelope ${cell(s.envelopeDigest)}, not this host's: governed jobs here refuse as envelope-mismatch${total !== envelope.totalTokens ? `.${fileTotalText(usd(envelope.totalTokens))}` : ""}`);
    // The outside-edit notice, by the same rule and in the same words (issue #507).
    const edit = outsideEdit(alloc.log, s.envelopeDigest);
    if (edit) lines.push(cell(outsideEditText(edit)));
  }
  // During a mismatch an entry only the split names is listed too, marked (`allocationRowIds`, issue #507).
  const rows = allocationRowIds(envelope.floors, s, !!s && s.envelopeDigest !== digest).map(({ id, splitOnly }) => [
    cell(id),
    `floor ${splitOnly ? "-" : usd(envelope.floors[id])}`,
    `weight ${s?.weights?.[id] ?? envelope.defaultWeights?.[id] ?? "-"}`,
    `allocation ${usd(s?.allocations?.[id])}`,
    `spent ${splitOnly ? "-" : usd(alloc.spend?.projects?.[id]?.tokens)}`,
    splitOnly ? SPLIT_ONLY_MARK : "",
  ]);
  const widths = rows.reduce((w, r) => r.map((c, i) => Math.max(w[i] ?? 0, c.length)), []);
  for (const r of rows) lines.push(`  ${r.map((c, i) => pad(c, widths[i])).join("  ").trimEnd()}`);
  // The headroom beside the split it is headroom of (issue #507): the deployment's spend against the split's total.
  if (s) lines.push(`  unallocated ${usd(s.unallocated)} · deployment reserved+held ${usd(alloc.spend?.deployment?.tokens)} of ${usd(total)}`);
  const history = Array.isArray(alloc.log) ? alloc.log.slice(0, historyRows) : [];
  if (history.length > 0) {
    lines.push("history (newest first):");
    const hosts = allocHostsShown(history);
    for (const h of history) {
      const why = h.reason ? ` ${cell(h.reason)}${h.field ? ` (${cell(h.field)}: ${cell(h.rule)})` : ""}` : "";
      lines.push(`  ${allocAt(h.at)}  ${hosts ? `${allocHost(h.host)}  ` : ""}${cell(h.writer)}  ${h.planId ? `${allocPlanId(h.planId)}  ` : ""}${cell(h.outcome)}${why}${h.clamped ? "  clamped" : ""}`);
    }
  }
  return lines.join("\n");
}

/**
 * What the mismatch line adds when this host's file holds another total than the split shown (issue #507): the file's
 * total, said once, so the shown totals cannot be read as the file's. Empty when the two agree. `tokensText` is the
 * file's total already in dollars, so each surface keeps its own formatting.
 */
export function fileTotalText(tokensText) {
  return ` This host's file says total ${tokensText}; the totals shown are the split's.`;
}

/**
 * The entries an allocation view lists (issue #507), as `[{ id, splitOnly }]`: this host's envelope file's entries in
 * its order, and, while the applied split was made for another envelope (`mismatch`), every entry the split allocates
 * that the file does not name, sorted, marked `splitOnly`. Without them an allocation the file dropped counted in the
 * split's total (`splitTotalTokens`) and was listed nowhere. The insights page restates the rule, held equal by a test.
 */
export function allocationRowIds(floors, state, mismatch) {
  const file = Object.keys(floors ?? {});
  const rows = file.map((id) => ({ id, splitOnly: false }));
  if (!mismatch || !state || typeof state !== "object") return rows;
  const extra = Object.keys(state.allocations ?? {}).filter((id) => !file.includes(id)).sort();
  return [...rows, ...extra.map((id) => ({ id, splitOnly: true }))];
}

/** The mark a split-only entry carries on every surface. */
export const SPLIT_ONLY_MARK = "not in this host's file";

/** The outside-edit notice in words, the same on every surface (the insights page's words are held to these by a test). */
export function outsideEditText(e) {
  return `a host reported envelope ${e.digest} at ${e.at}, not the one the split was made for (${e.split}); a host still on it refuses governed jobs as envelope-mismatch`;
}

/**
 * Whether the host column earns its place: only when the rows shown name more than one host. On one host it says the
 * same word on every row and costs a sixth of the line; on a fleet it is what tells two hosts' refusals apart.
 */
export function allocHostsShown(rows) {
  const hosts = new Set((Array.isArray(rows) ? rows : []).map((r) => (typeof r?.host === "string" ? r.host : "")));
  return hosts.size > 1;
}

/** A row's host, cut to 10 columns with the ellipsis (a host name is the operator's, and its tail is rarely the part that differs). */
export function allocHost(host) {
  return clip(cell(host ?? "-"), 10);
}

/**
 * A row's plan id as its first 8 hex digits, the git short-id idiom: 16 is the content hash, 8 still tells the rows of
 * one history apart, and the full id stays in the applied-plan record and the audit file.
 */
export function allocPlanId(id) {
  return sliceColumns(cell(id), 8);
}
