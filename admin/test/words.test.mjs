import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { capitalised, HELD_LABEL, NO_EXPLANATION, NO_REASON_FAILED, OUTCOME_KEYS, OUTCOME_KEY_WORDS, RECORD_REASON_RE, fieldNamed, OUTCOME_WORDS, OUTCOME_WORD_OF, REASON_WORDS, rowNumber, SHORT_MAX, SPEND_TITLE, STATUS_KINDS, UNNAMED_FIELD, VENUE_LABEL, outcomeKey, outcomeWord, reasonWords, recordReason, shortSentence } from "../src/words.mjs";
import { NESTED_REASONS, REASONS, explainReason } from "../../worker/src/reason-catalog.mjs";
import { RECOVERY_COMMENTS } from "../../worker/src/comment-tables.mjs";
import { RECORD_REASON_RE as LEAF_REASON_RE } from "../../worker/src/record-reason.mjs";
import { RUNNER_COMPLETED_REASONS } from "../../worker/src/run-history.mjs";
import { LIVE_OUTCOMES } from "../../worker/src/live-transcript.mjs";

// Issue #710, PR 2: the console reads one vocabulary from admin/src/words.mjs. Each table there is bolted to its
// source here (AGENTS.md, "derived or pinned") and the console is held to importing it. The retired `/dispatch`
// panel shared these tables too; it was removed with the panel (58ef2369).

/** The endings a cut may not have: a dangling word (a negation, a modal and an auxiliary among them), a comma, a pronoun after a conjunction. */
const DANGLING_END = /(?:\s(?:the|a|an|so|no|not|never|of|to|and|or|in|on|for|with|by|its|this|that|is|was|from|as|at|but|which|whose|than|be|if|when|their|any|every|each|into|after|before|because|while|until|nor|whether|are|were|has|have|had|could|can|does|would|will|may|must|should|did|do)|\s(?:so|and|but|or|while) it|[,;:])…$/i;

const SRC = (p) => readFileSync(fileURLToPath(new URL(`../src/${p}`, import.meta.url)), "utf8");

// ---- the bolts -------------------------------------------------------------------------------------------------------

test("OUTCOME_WORDS is keyed by exactly the record's outcome enum, as the live stream names it", () => {
  const keys = Object.keys(OUTCOME_WORDS).sort();
  assert.deepEqual(keys, ["completed", "failed", "policy"], "the record outcomes");
  assert.deepEqual(keys, LIVE_OUTCOMES.filter((o) => o !== "unknown").sort(), "live-transcript.mjs LIVE_OUTCOMES, less its own unknown");
  assert.deepEqual(Object.fromEntries(Object.entries(OUTCOME_WORDS).map(([k, v]) => [k, v.word])), { completed: "completed", policy: "refused", failed: "failed" });
});

test("REASON_WORDS: every key is a catalog reason, each qualifies one outcome, and the completed ones are exactly the runner's completed reasons", () => {
  for (const [token, q] of Object.entries(REASON_WORDS)) {
    assert.ok(Object.hasOwn(REASONS, token), `${token} is a reason the record can carry`);
    assert.ok(Object.hasOwn(OUTCOME_WORDS, q.outcome), `${token} qualifies a record outcome`);
  }
  // A completed run with a reason is never "completed": every reason the runner completes with has its own word, and
  // nothing else claims the completed outcome (run-history.mjs RUNNER_COMPLETED_REASONS, both ways).
  const completed = Object.entries(REASON_WORDS).filter(([, q]) => q.outcome === "completed").map(([t]) => t).sort();
  assert.deepEqual(completed, [...RUNNER_COMPLETED_REASONS].sort());
  assert.deepEqual(Object.fromEntries(Object.entries(REASON_WORDS).map(([k, v]) => [k, v.word])), {
    "awaiting-approval": "awaiting approval",
    "awaiting-input": "awaiting input",
    "operator-cancel": "cancelled", "agent-cancel": "cancelled",
    "recovery-cap": "failed",
    "recovery-checkpoint-absent": "failed",
    "recovery-unsafe-extensions": "failed",
  });
  // Whether the word says why (issue #737): "awaiting input" and "cancelled" do, so a row adds no sentence; "failed"
  // does not, so a recovery end keeps its reason's sentence.
  assert.deepEqual(Object.fromEntries(Object.entries(REASON_WORDS).map(([k, v]) => [k, v.says])), {
    "awaiting-approval": true,
    "awaiting-input": true,
    "operator-cancel": true, "agent-cancel": true,
    "recovery-cap": false,
    "recovery-checkpoint-absent": false,
    "recovery-unsafe-extensions": false,
  });
});

test("the recovery ends the worker records as policy read failed: derived from the processor's returns and the comments it posts (issue #737)", () => {
  // Every recovery comment that opens "Failed:" belongs to a run that failed, whatever outcome the processor records
  // for it: the ones it records as `policy` are REASON_WORDS entries that say failed, the one it records as `failed`
  // needs none, and no other recovery token is one.
  const src = readFileSync(fileURLToPath(new URL("../../worker/src/processor.mjs", import.meta.url)), "utf8");
  const recorded = new Map();
  for (const m of src.matchAll(/outcome: "(completed|policy|failed)", reason: "(recover[a-z-]*)"/g)) {
    assert.ok(!recorded.has(m[2]) || recorded.get(m[2]) === m[1], `${m[2]} is recorded under one outcome`);
    recorded.set(m[2], m[1]);
  }
  const failedPolicy = [...recorded].filter(([t, o]) => o === "policy" && RECOVERY_COMMENTS[t]?.startsWith("Failed:")).map(([t]) => t).sort();
  assert.ok(failedPolicy.length >= 3, `the processor's policy recovery ends were found: ${failedPolicy.join(", ")}`);
  const asFailed = Object.entries(REASON_WORDS).filter(([, q]) => q.outcome === "policy" && q.word === OUTCOME_WORDS.failed.word).map(([t]) => t).sort();
  assert.deepEqual(asFailed, failedPolicy, "the policy reasons that read failed are exactly the recovery ends the processor records as policy");
  for (const t of asFailed) {
    const q = REASON_WORDS[t];
    assert.deepEqual([q.glyph, q.tone, q.status, q.says], [OUTCOME_WORDS.failed.glyph, OUTCOME_WORDS.failed.tone, OUTCOME_WORDS.failed.status, false], `${t} looks as a failure looks`);
    assert.equal(outcomeWord("policy", t).word, "failed");
    assert.equal(outcomeWord("failed", t).word, "failed", "under the failed outcome it is a failure as it is");
    assert.equal(outcomeWord("completed", t).word, "completed", "and under another outcome it borrows nothing");
  }
});

test("outcomeWord says whether the word says why: a qualified word that names its cause, never a plain outcome or an unknown one (issue #737)", () => {
  assert.deepEqual([outcomeWord("completed", "awaiting-input").says, outcomeWord("policy", "operator-cancel").says], [true, true]);
  assert.deepEqual([outcomeWord("policy", "recovery-cap").qualified, outcomeWord("policy", "recovery-cap").says], [true, false]);
  for (const [o, r] of [["completed", null], ["policy", "scope-cap"], ["failed", "container-lost"], ["policy", "awaiting-input"], ["vapour", "operator-cancel"], [null, null]]) {
    assert.equal(outcomeWord(o, r).says, false, `${o}/${r}`);
  }
});

test("the outcome keys: the five words a badge says, as query values, each with its word and status, and the record's raw values mapped onto them (issue #737)", () => {
  assert.deepEqual([...OUTCOME_KEYS], ["completed", "refused", "failed", "awaiting-input", "awaiting-approval", "cancelled"]);
  assert.ok(Object.isFrozen(OUTCOME_KEYS) && Object.isFrozen(OUTCOME_KEY_WORDS));
  // Every word a known record can be given has a key, and every key is a word one can be given: both ways.
  const words = [...new Set([...Object.values(OUTCOME_WORDS), ...Object.values(REASON_WORDS)].map((w) => w.word))].sort();
  assert.deepEqual(OUTCOME_KEYS.map((k) => OUTCOME_KEY_WORDS[k].word).sort(), words);
  assert.deepEqual(Object.fromEntries(OUTCOME_KEYS.map((k) => [k, [OUTCOME_KEY_WORDS[k].word, OUTCOME_KEY_WORDS[k].status]])), {
    completed: ["completed", "ok"],
    refused: ["refused", "refused"],
    failed: ["failed", "failed"],
    "awaiting-input": ["awaiting input", "parked"],
    "awaiting-approval": ["awaiting approval", "parked"],
    cancelled: ["cancelled", "cancelled"],
  });
  for (const k of OUTCOME_KEYS) assert.equal(k, OUTCOME_KEY_WORDS[k].word.replace(/ /g, "-"), "a key is its word as a query value");
  const cases = [
    ["completed", null, "completed"],
    ["completed", "awaiting-input", "awaiting-input"],
    ["policy", "scope-cap", "refused"],
    ["policy", null, "refused"],
    ["policy", "operator-cancel", "cancelled"],
    ["policy", "recovery-cap", "failed"],
    ["policy", "recovery-checkpoint-absent", "failed"],
    ["failed", "container-lost", "failed"],
    ["failed", "operator-cancel", "failed"],
    ["vapour", null, null],
    ["__proto__", null, null],
    [null, null, null],
  ];
  for (const [o, r, want] of cases) assert.equal(outcomeKey(o, r), want, `${o}/${r}`);
});

test("recordReason takes the record's token charset alone, the worker leaf's own, and NO_REASON_FAILED names no token (issue #737)", () => {
  assert.equal(RECORD_REASON_RE, LEAF_REASON_RE, "words.mjs re-exports the leaf's charset, never a copy");
  for (const ok of ["scope-cap", "container-infra-exit", "worker-error", "a", "9", "x".repeat(64)]) assert.equal(recordReason({ reason: ok }), ok);
  for (const bad of ["infra failure, container exit 1", "unknown container exit 42", "GET /repos/acme/web failed", "Scope-cap", "-x", "x".repeat(65), "<img src=x>", "a\nb", "", null, 7, undefined]) {
    assert.equal(recordReason({ reason: bad }), null, JSON.stringify(bad));
  }
  assert.equal(recordReason(null), null);
  assert.equal(recordReason(undefined), null);
  assert.match(NO_REASON_FAILED, /^Failed: /, "a failure's verdict, which the short form drops");
  assert.equal(shortSentence(NO_REASON_FAILED), "No reason was recorded");
});

test("the tones: refused, awaiting input and cancelled warn, failed is an error, the console retains their explicit statuses", () => {
  const tone = (o, r) => outcomeWord(o, r).tone;
  assert.equal(tone("completed"), "success");
  assert.equal(tone("policy", "scope-cap"), "warning");
  assert.equal(tone("completed", "awaiting-input"), "warning");
  assert.equal(tone("policy", "operator-cancel"), "warning");
  assert.equal(tone("failed", "container-never-started"), "error");
  const tones = new Set([...Object.values(OUTCOME_WORDS), ...Object.values(REASON_WORDS)].map((w) => w.tone));
  assert.deepEqual([...tones].sort(), ["error", "success", "warning"]);
  for (const status of ["ok", "refused", "failed"]) assert.ok(STATUS_KINDS.includes(status));
});

test("outcomeWord reads the raw values: a qualifier only under its own outcome, and an unknown outcome has no word", () => {
  assert.equal(outcomeWord("policy", "awaiting-input").word, "refused", "a qualifier under another outcome keeps the outcome's word");
  assert.equal(outcomeWord("failed", "operator-cancel").word, "failed");
  for (const bad of ["vapour", "__proto__", "constructor", " completed", "\u0001completed", null, undefined, 1]) {
    const w = outcomeWord(bad, null);
    assert.deepEqual([w.known, w.word, w.glyph, w.tone], [false, null, "✘", "error"], String(bad));
  }
});

test("the console's status (issue #737): completed ok, refused refused, failed failed, awaiting input parked, cancelled cancelled, and an unknown outcome failed", () => {
  assert.deepEqual(STATUS_KINDS, ["running", "parked", "failed", "refused", "attention", "ok", "idle", "cancelled"]);
  assert.ok(Object.isFrozen(STATUS_KINDS));
  assert.deepEqual(Object.fromEntries(Object.entries(OUTCOME_WORDS).map(([k, v]) => [k, v.status])), { completed: "ok", policy: "refused", failed: "failed" });
  assert.deepEqual(Object.fromEntries(Object.entries(REASON_WORDS).map(([k, v]) => [k, v.status])), { "awaiting-approval": "parked", "awaiting-input": "parked", "operator-cancel": "cancelled", "agent-cancel": "cancelled", "recovery-cap": "failed", "recovery-checkpoint-absent": "failed", "recovery-unsafe-extensions": "failed" });
  // outcomeWord hands the status on, and a qualifier changes it only under its own outcome, as it does the word.
  const status = (o, r) => outcomeWord(o, r).status;
  assert.equal(status("completed"), "ok");
  assert.equal(status("completed", "awaiting-input"), "parked");
  assert.equal(status("policy", "scope-cap"), "refused");
  assert.equal(status("policy", "operator-cancel"), "cancelled");
  assert.equal(status("policy", "agent-cancel"), "cancelled");
  assert.equal(status("completed", "agent-cancel"), "ok", "an agent-cancel reason cannot relabel another outcome");
  assert.equal(status("policy", "awaiting-input"), "refused", "a qualifier under another outcome keeps the outcome's status");
  assert.equal(status("failed", "operator-cancel"), "failed");
  assert.equal(status("policy", "recovery-cap"), "failed", "a recovery end is a failure (issue #737)");
  for (const bad of ["vapour", "__proto__", null, undefined]) assert.equal(status(bad), "failed", String(bad));
  // Every status a word carries is a kind the console draws.
  for (const w of [...Object.values(OUTCOME_WORDS), ...Object.values(REASON_WORDS), outcomeWord("vapour")]) assert.ok(STATUS_KINDS.includes(w.status), w.status);
});

test("the titles: Venue, Spend and Held", () => {
  assert.deepEqual([VENUE_LABEL, SPEND_TITLE, HELD_LABEL], ["Venue", "Spend", "Held"]);
});

// Issue #737: a row is called by the number a person counts it by; the index stays the machine's.
test("rowNumber says a 0-based index as the 1-based number a person reads, and never a number it is not", () => {
  assert.deepEqual([0, 1, 9, 41].map(rowNumber), ["1", "2", "10", "42"]);
  assert.equal(rowNumber(Number.MAX_SAFE_INTEGER - 1), String(Number.MAX_SAFE_INTEGER));
  for (const bad of [-1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "0", "3", null, undefined, true, [], {}]) assert.equal(rowNumber(bad), "?", String(bad));
});

// Issue #737: a refusal names a field only when its name is a plain identifier, and never echoes a value.
test("fieldNamed names a plain identifier of at most 40 characters and nothing else", () => {
  for (const ok of ["colour", "maxTurns", "a", "A_b9", "x".repeat(40)]) assert.equal(fieldNamed(ok), ok);
  for (const bad of ["", "x".repeat(41), "9lives", "_proto", "__proto__", "a b", "a-b", "a.b", "naïve", "ｍodel", "a\u202eb", "<b>", 7, null, undefined]) assert.equal(fieldNamed(bad), UNNAMED_FIELD, JSON.stringify(bad));
  assert.equal(UNNAMED_FIELD, "a field it was sent");
});

// ---- the short sentence ------------------------------------------------------------------------------------------------

test("shortSentence's rule: the verdict dropped, the first sentence, no backticks, capitalised, and cut at a word with an ellipsis", () => {
  assert.equal(shortSentence("Refused: the cap was reached, so no container was started. Not run."), "The cap was reached, so no container was started");
  assert.equal(shortSentence("Not run: the job gave up waiting."), "The job gave up waiting");
  assert.equal(shortSentence("Failed, continuing: this attempt was lost."), "This attempt was lost");
  assert.equal(shortSentence("Failed before it started: the proxy did not pass."), "The proxy did not pass");
  assert.equal(shortSentence("The run asked a question. Its work is saved."), "The run asked a question", "no verdict: kept as it is");
  assert.equal(shortSentence("The list of MCP servers could not be used: the overlay."), "The list of MCP servers could not be used: the overlay", "a colon after five words is not a verdict");
  // The verdict's bound exactly: four words go, five and six stay (a looser bound would eat a clause of the sentence).
  assert.equal(shortSentence("Refused by the worker: the cap was reached."), "The cap was reached");
  assert.equal(shortSentence("Refused by the worker today: the cap was reached."), "Refused by the worker today: the cap was reached", "a five-word colon clause is not a verdict");
  assert.equal(shortSentence("Refused by the worker host today: the cap was reached."), "Refused by the worker host today: the cap was reached", "a six-word colon clause is not a verdict");
  assert.equal(shortSentence("Refused: the repository's `.pi/` holds too much."), "The repository's .pi/ holds too much", "a dot inside a path is not a full stop");
  const long = `Refused: ${"word ".repeat(30)}end.`;
  const cut = shortSentence(long);
  assert.ok(cut.length <= SHORT_MAX && cut.endsWith("…") && !cut.endsWith(" …"), cut);
  assert.equal(shortSentence("Refused: a, b, " + "x".repeat(SHORT_MAX)), "A, b…", "a trailing comma before the cut goes");
  assert.equal(shortSentence(null), "");
});

test("shortSentence backs a cut off past a dangling word and an open parenthesis, and drops an aside that opens too early (#710 round 1)", () => {
  const pad = "word ".repeat(12).trim(); // 59 characters, so the cut falls inside what follows
  // Past trailing stop-words, as often as they apply, and a comma before them.
  assert.equal(shortSentence(`Refused: ${pad} reached, so it was not made at all.`), `${pad.charAt(0).toUpperCase()}${pad.slice(1)} reached…`);
  assert.equal(shortSentence(`Refused: ${pad} reached the cap of a run for a day.`), `${pad.charAt(0).toUpperCase()}${pad.slice(1)} reached…`);
  // Past an unclosed parenthesis, and whatever dangles before it.
  assert.equal(shortSentence(`Refused: ${pad} reached (it ships none of them`), `${pad.charAt(0).toUpperCase()}${pad.slice(1)} reached…`);
  // A closed aside is dropped before the cut, wherever it opens (#710 round 2), and so is a relative clause between commas.
  assert.equal(shortSentence(`Refused: ${pad} reached (it ships none of them).`), `${pad.charAt(0).toUpperCase()}${pad.slice(1)} reached`);
  assert.equal(shortSentence(`Refused: the keeper, which the proxy needs for every job it runs, kept restarting while the job waited for it.`), "The keeper kept restarting while the job waited for it");
  // An object pronoun ends a phrase: it stays.
  assert.equal(shortSentence(REASONS["auth-credit-cap-required"].sentence), "The configured subscription connection cannot authorize this job");
  // The catalog's own cases.
  assert.equal(shortSentence(REASONS["job-image-forge-unsupported"].sentence), "The job image does not support this job's forge", "its aside dropped, it fits");
  // An aside that opens below the floor is dropped whole, and the sentence cut again.
  assert.equal(shortSentence(REASONS["model-unknown"].sentence), "This job names an AI model that this deployment does not know…");
  // Never below the floor: a sentence whose only back-off would leave a stub keeps its cut.
  assert.equal(shortSentence(`Refused: ${"x".repeat(20)} the ${"y".repeat(60)}.`), `X${"x".repeat(19)} the…`, "a back-off below the floor is not taken");
  const stub = shortSentence(`Refused: ab (${"x ".repeat(40)}`);
  assert.ok(stub.length <= SHORT_MAX && stub.endsWith("…"), stub);
});

test("every catalog reason has a short sentence that fits a row, is cut from its own sentence, and holds no backtick or control byte", () => {
  for (const [token, entry] of Object.entries(REASONS)) {
    const s = shortSentence(entry.sentence);
    assert.ok(s.length > 10 && s.length <= SHORT_MAX, `${token}: ${s}`);
    assert.ok(!/[`\u0000-\u001f\u007f-\u009f]/.test(s), token);
    assert.match(s, /^[A-Z]/, token);
    // Derived from its sentence, not written: a prefix of it, or of it with its asides left out (#710 round 2).
    const plain = entry.sentence.replace(/`/g, "").toLowerCase();
    const lean = plain.replace(/\s*\([^()]*\)/g, "").replace(/, which [^,()]*,/g, "");
    assert.ok([plain, lean].some((p) => p.includes(s.replace(/…$/, "").toLowerCase())), `${token}: derived from its sentence, not written`);
    // A cut never ends on a dangling word (a modal or an auxiliary included), a comma, or inside a parenthesis.
    if (s.endsWith("…")) assert.doesNotMatch(s, DANGLING_END, token);
    assert.equal((s.match(/\(/g) ?? []).length, (s.match(/\)/g) ?? []).length, `${token}: no open parenthesis`);
    assert.deepEqual(reasonWords(token), { known: true, token, short: s, sentence: entry.sentence, next: entry.next });
  }
  // `why` picks the catalog's variant, as explainReason does.
  assert.equal(reasonWords("model-unknown", "overlay-link").sentence, explainReason("model-unknown", { why: "overlay-link" }).sentence);
  for (const bad of ["brand-new", "__proto__", "", null]) assert.deepEqual(reasonWords(bad), { known: false, token: bad });
  assert.equal(NO_EXPLANATION, "no explanation yet");
});

test("every cut short form keeps what its cause did: at least 40 characters, over the whole catalog (#710 round 2)", () => {
  // Mechanical: the subject of a catalog sentence is never 40 characters, so a cut row this long carries words past it
  // (the four rows round 2 found ended on their subject at 32 to 65 characters, one with an aside, the others under 40).
  const all = [...Object.entries(REASONS).map(([k, e]) => [k, e.sentence]), ...Object.entries(NESTED_REASONS).flatMap(([n, t]) => Object.entries(t).map(([k, e]) => [`${n}:${k}`, e.sentence]))];
  for (const [reason, why] of [["model-unknown", "overlay-link"], ["model-not-allowed", "fallback-unlisted"]]) all.push([`${reason}/${why}`, explainReason(reason, { why }).sentence]);
  for (const [key, sentence] of all) {
    const s = shortSentence(sentence);
    if (!s.endsWith("…")) continue;
    assert.ok(Array.from(s).length >= 40, `${key}: ${s}`);
    assert.doesNotMatch(s, DANGLING_END, key);
  }
  // The podman venue reasons are gone from the catalog (the sandbox removal); the pins live on over reasons that cut.
  assert.equal(shortSentence(REASONS["job-image-package-canary-unsupported"].sentence), "The job image does not declare package canaries, so it could not report…");
  assert.equal(shortSentence(REASONS["secret-name-reserved"].sentence), "A secret this job would receive uses a name this deployment already…");
  assert.equal(shortSentence(REASONS["netns-keeper-crash-loop"].sentence), "This worker's rootless network keeper kept restarting while the job…");
  assert.equal(shortSentence(REASONS["watch-cap"].sentence), "The source, rule or active-fingerprint cap refused the finding…");
});

test("a cut never ends on a negation alone, and never splits a character (#710 round 2)", () => {
  const pad = "word ".repeat(11).trim(); // 54 characters
  // "could not" goes as a pair: dropping "not" alone would flip what the row says ("the image could…").
  assert.equal(shortSentence(`Refused: ${pad} the image could not enforce the limit.`), `${pad.charAt(0).toUpperCase()}${pad.slice(1)} the image…`);
  assert.equal(shortSentence(`Refused: ${pad} the run kept no record of it.`), `${pad.charAt(0).toUpperCase()}${pad.slice(1)} the run…`);
  assert.equal(shortSentence(`Refused: ${pad} the job had never run a step.`), `${pad.charAt(0).toUpperCase()}${pad.slice(1)} the job…`);
  // Where the pair would go below the floor, the negation stays with its verb: the row is cut, never inverted.
  // ("not" alone opens past the floor, the pair below it: the old rule left "The worker's images could…".)
  assert.equal(shortSentence(`Refused: the worker's images could not ${"x".repeat(60)}.`), "The worker's images could not…");
  // No space at all: cut by code points, so a pair of UTF-16 units is never split.
  const emoji = shortSentence(`Refused: ${"\u{1F600}".repeat(100)}.`);
  assert.ok(emoji.isWellFormed(), "no lone surrogate");
  assert.equal(emoji, `${"\u{1F600}".repeat(SHORT_MAX - 1)}…`);
  assert.equal(shortSentence(`Refused: ${"\u{1F600}".repeat(SHORT_MAX)}.`), "\u{1F600}".repeat(SHORT_MAX), "a row of exactly SHORT_MAX characters is not cut");
});

// ---- the console reads this module ---------------------------------------------------------------------------------------

test("the console imports words.mjs, and keeps no copy of a word of its own", () => {
  // Issue #737: the console's panels are one module per screen under console/panels/, which console/panels.mjs
  // re-exports. Every one is read, the barrel too, so a module added later is held to the same rule.
  const panelModules = readdirSync(fileURLToPath(new URL("../src/console/panels/", import.meta.url))).filter((f) => f.endsWith(".mjs")).sort();
  assert.ok(panelModules.includes("common.mjs") && panelModules.includes("insights.mjs"), "the panels' modules were found");
  const panels = [SRC("console/panels.mjs"), ...panelModules.map((f) => SRC(`console/panels/${f}`))].join("\n");
  const pages = SRC("console/pages.mjs");
  assert.match(panels, /^import \{[^}]*\boutcomeWord\b[^}]*\} from "\.\.\/\.\.\/words\.mjs";$/m);
  assert.match(pages, /^import \{[^}]*\bSPEND_TITLE\b[^}]*\} from "\.\.\/words\.mjs";$/m);
  // Round 2: every place a stream's end or a chip's last run is said (#710 round 2).
  assert.match(SRC("console/transcript.mjs"), /^import \{[^}]*\boutcomeWord\b[^}]*\} from "\.\.\/words\.mjs";$/m, "the live transcript's end");
  assert.match(SRC("console/live.mjs"), /^import \{[^}]*\boutcomeWord\b[^}]*\} from "\.\.\/words\.mjs";$/m, "the page stream resolves reason-aware words before the browser sees them");
  assert.match(panels, /^import \{[^}]*\bOUTCOME_WORD_OF\b[^}]*\} from "\.\.\/\.\.\/words\.mjs";$/m);
  assert.match(panels, /buildGraphScene\(p\.graph, \{[^}]*outcomeWords: OUTCOME_WORD_OF[^}]*\}\)/, "the topology, which loads no module, is handed the words");
  for (const [name, src] of [["panels.mjs", panels], ["pages.mjs", pages]]) {
    for (const copy of ['"✔ done"', '"Held on a wait"', '"Spend and insights"', 'title: "SPEND"', 'title: "HELD"', '"spend & limits"', 'head: ["held"', 'outcome === "policy" ? "⚠"', '"Venue"', 'kv("backend", show(r.backend))']) {
      assert.ok(!src.includes(copy), `${name} keeps its own ${copy}`);
    }
  }
});

test("the browser displays the run stream's reason-aware outcome without remapping it (#747)", async () => {
  const { CONSOLE_SCRIPT } = await import("../src/console/script.mjs");
  const { runConsoleScript } = await import("./helpers/script-dom.mjs");
  assert.deepEqual(OUTCOME_WORD_OF, Object.fromEntries(Object.entries(OUTCOME_WORDS).map(([k, v]) => [k, v.word])));
  assert.doesNotMatch(CONSOLE_SCRIPT, /var OUTCOME_WORD =/);
  for (const outcome of ["cancelled", "awaiting input", "failed", "completed", "future-state"]) {
    const d = runConsoleScript(CONSOLE_SCRIPT, '<html><body data-live="run" data-query="id=gh-1"><main id="main"><p data-transcript-status></p><div data-transcript data-job="gh-1"></div></main></body></html>');
    d.streams[0].emit("tdone", { outcome });
    assert.equal(d.document.querySelector("[data-transcript-status]").textContent, `ended (${outcome})`);
  }
});

test("capitalised: a sentence that opens with a word starts with a capital; one that opens with an id keeps the id as written", () => {
  assert.equal(capitalised("the fleet did not answer"), "The fleet did not answer");
  assert.equal(capitalised("nothing was changed"), "Nothing was changed");
  assert.equal(capitalised("rejected: maxTurns must be an integer"), "Rejected: maxTurns must be an integer");
  assert.equal(capitalised("done."), "Done.");
  for (const s of ["gh-2f6a parked on a pull request", "pi-jobs@build3 is already paused", "cron:nightly:17 is the next run", "gh_1 x", "e2e runs", ""]) assert.equal(capitalised(s), s, s);
});

test("capitalised keeps an id whose word is joined to the rest by @, as written", () => {
  assert.equal(capitalised("jobs@east is already paused"), "jobs@east is already paused");
});

test("capitalised keeps an id joined by a full stop with no space after it, as written", () => {
  assert.equal(capitalised("valkey.internal did not answer"), "valkey.internal did not answer");
  assert.equal(capitalised("done. Look again"), "Done. Look again");
});
