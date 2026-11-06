import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  GLYPHS,
  ASCII,
  setGlyphs,
  clip,
  pad,
  box,
  sparkline,
  fmtTokens,
  fmtAmount,
  makeLineInput,
  LINE_INPUT_CURSOR,
  trimClusters,
} from "../src/panel.mjs";

test("panel.mjs is pure: no fs, no require, no node:fs import", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/panel.mjs", import.meta.url)), "utf8");
  assert.ok(
    !/readFileSync|\breadFile\b|require\(|import\s+.*node:fs|console\.|process\.env[.[]|@earendil-works/.test(src),
    "panel primitives must have no I/O, no console, no env, no pi API -- values in, strings out",
  );
});

test("box frames a title, sections, and footer within width", () => {
  const width = 30;
  const out = box({
    title: "STATUS",
    sections: [
      { title: "Queue", lines: ["waiting 2", "active 1"] },
      { lines: ["workers: 1"] },
    ],
    footer: "updated 00:00",
    width,
  });
  assert.ok(Array.isArray(out));
  const joined = out.join("\n");
  assert.match(joined, new RegExp(GLYPHS.tl));
  assert.match(joined, new RegExp(GLYPHS.br));
  assert.match(joined, new RegExp(GLYPHS.ml), "a section separator rule is present");
  assert.match(joined, /STATUS/);
  assert.match(joined, /Queue/);
  assert.match(joined, /waiting 2/);
  assert.match(joined, /workers: 1/);
  assert.match(joined, /updated 00:00/);
  for (const line of out) {
    assert.ok(line.length <= width, `line "${line}" (${line.length}) exceeds width ${width}`);
  }
});

test("box degrades on a tiny width without emitting over-width lines", () => {
  const out = box({ title: "way-too-long-title", sections: [{ lines: ["content"] }], footer: "f", width: 3 });
  assert.ok(out.length >= 2, "still produces a top and bottom border");
  const maxLen = Math.max(...out.map((l) => l.length));
  for (const line of out) {
    assert.equal(line.length, maxLen, "degraded frame stays rectangular, never ragged or over-width");
  }
});

test("clip truncates long input to width and ends with the ellipsis glyph", () => {
  const out = clip("abcdefghij", 5);
  assert.equal(out.length, 5);
  assert.ok(out.endsWith(GLYPHS.ellipsis));
});

test("clip leaves short input unchanged", () => {
  assert.equal(clip("abc", 10), "abc");
});

test("clip survives control characters and stays within width", () => {
  const evil = `a\x1b[31mb\x00c\x07d\x7f`;
  const out = clip(evil, 6);
  assert.ok(out.length <= 6, "width is respected after control chars are stripped");
  assert.doesNotMatch(out, /[\x00-\x1f\x7f-\x9f]/, "control characters are removed"); // eslint-disable-line no-control-regex
});

test("pad right-pads short input to exactly width", () => {
  const out = pad("hi", 6);
  assert.equal(out.length, 6);
  assert.equal(out, "hi    ");
});

test("pad clips long input to width", () => {
  const out = pad("abcdefghij", 4);
  assert.equal(out.length, 4);
  assert.ok(out.endsWith(GLYPHS.ellipsis));
});

test("GLYPHS and ASCII stay in key parity; ramp and gap are equal-length pairs", () => {
  assert.deepEqual(Object.keys(ASCII).sort(), Object.keys(GLYPHS).sort(), "every glyph key has an ASCII twin");
  assert.equal(ASCII.ramp.length, GLYPHS.ramp.length, "the quantization math must not shift between tables");
  assert.equal(ASCII.gap.length, GLYPHS.gap.length);
  assert.equal(GLYPHS.gap.length, 1, "sparkline cells are single columns");
});

test("setGlyphs(true) swaps box and clip to ASCII; setGlyphs(false) restores the default", () => {
  try {
    setGlyphs(true);
    const out = box({ title: "S", sections: [{ lines: ["x"] }], width: 20 });
    assert.match(out[0], /^\+-/, "ASCII corners");
    assert.doesNotMatch(out.join("\n"), new RegExp(GLYPHS.v), "no box-drawing glyph leaks through");
    const clipped = clip("abcdefghij", 5);
    assert.equal(clipped.length, 5, "the 3-char ASCII ellipsis still lands on exactly width");
    assert.ok(clipped.endsWith(ASCII.ellipsis));
  } finally {
    setGlyphs(false);
  }
});

test("sparkline repeats cells to fill width and never exceeds it", () => {
  assert.equal(sparkline([1, 2, 3, 4], 8).length, 8, "repeat factor 2 fills the width evenly");
  assert.equal(sparkline([1, 2, 3], 8).length, 6, "repeat factor floors -- at most width, never padded past the data");
  assert.equal(sparkline([1, 2, 3, 4, 5], 2).length, 2, "more values than columns still fits");
  const doubled = sparkline([1, 4], 4);
  assert.equal(doubled[0], doubled[1], "each cell repeats as a run");
  assert.equal(doubled[2], doubled[3]);
});

test("sparkline renders zero as the lowest ramp glyph and null as the gap glyph", () => {
  // A zero-cost day is a fact, an absent day is unknown -- the two must never look alike.
  const out = sparkline([0, 8, null, 0.1], 4, { max: 8 });
  assert.equal(out[0], GLYPHS.ramp[0], "exact zero takes the reserved baseline glyph");
  assert.equal(out[1], GLYPHS.ramp.at(-1), "the ceiling takes the full glyph");
  assert.equal(out[2], GLYPHS.gap, "null is a gap, not a bar");
  assert.notEqual(out[3], GLYPHS.ramp[0], "tiny-but-nonzero never collapses into the zero baseline");
  assert.notEqual(out[3], GLYPHS.gap);
});

test("sparkline opts.max pins a shared ceiling so bars are comparable across series", () => {
  assert.equal(sparkline([5], 1), GLYPHS.ramp.at(-1), "own max scales to full height");
  assert.equal(sparkline([5], 1, { max: 10 }), GLYPHS.ramp[4], "half the shared ceiling reads as half a bar, not full");
  assert.equal(sparkline([20], 1, { max: 10 }), GLYPHS.ramp.at(-1), "over the ceiling clamps to full");
});

test("sparkline downsamples by bucket max, never an average -- a spike must survive", () => {
  const out = sparkline([0, 9, 0, 0], 2);
  assert.equal(out.length, 2);
  assert.equal(out[0], GLYPHS.ramp.at(-1), "the 9 spike survives its bucket");
  assert.equal(out[1], GLYPHS.ramp[0], "the flat bucket stays at the zero baseline");
  const gaps = sparkline([null, null, 3, 3], 2);
  assert.equal(gaps[0], GLYPHS.gap, "an all-null bucket stays a gap");
  assert.equal(gaps[1], GLYPHS.ramp.at(-1));
});

test("sparkline renders 'no data' when nothing positive exists to scale against", () => {
  assert.equal(sparkline([], 10), "no data");
  assert.equal(sparkline([null, null], 10), "no data");
  assert.equal(sparkline([0, 0, 0], 10), "no data", "all-zero with no shared ceiling has no truthful scale");
  assert.equal(sparkline([], 4), clip("no data", 4), "the note clips like any other cell");
  assert.match(sparkline([0, 0], 10, { max: 5 }), new RegExp(`^${GLYPHS.ramp[0]}+$`), "an explicit ceiling makes flat zero a fact worth drawing");
});

test("sparkline swaps to the ASCII ramp under setGlyphs(true) with identical geometry", () => {
  const uni = sparkline([1, 2, null, 4], 8);
  try {
    setGlyphs(true);
    const asc = sparkline([1, 2, null, 4], 8);
    assert.equal(asc.length, uni.length, "the geometry is glyph-table independent");
    for (let i = 0; i < asc.length; i++) {
      const expected = uni[i] === GLYPHS.gap ? ASCII.gap : ASCII.ramp[GLYPHS.ramp.indexOf(uni[i])];
      assert.equal(asc[i], expected, `column ${i} keeps its ramp index across tables`);
    }
  } finally {
    setGlyphs(false);
  }
});

test("fmtTokens compacts any magnitude into at most 6 characters", () => {
  const table = [
    [0, "0"],
    [742, "742"],
    [9400, "9.4k"],
    [9_990, "9.9k"],
    [123_000, "123k"],
    [12_340_000, "12.34M"],
    [4_120_000_000, "4.12B"],
    [NaN, "-"],
    [Infinity, "-"],
    [-3, "-"],
  ];
  for (const [n, expected] of table) {
    assert.equal(fmtTokens(n), expected, `fmtTokens(${n})`);
    assert.ok(fmtTokens(n).length <= 6, `fmtTokens(${n}) stays within 6 chars`);
  }
});


test("fmtAmount renders each class with a distinct, non-overlapping shape", () => {
  assert.equal(fmtAmount({ tokens: 12_340_000, class: "metered" }), "12.34M");
  assert.equal(fmtAmount({ tokens: 12_340_000, class: "metered", floor: true }), "≥12.34M", "a floor is marked, not silently rounded");
  assert.equal(fmtAmount({ tokens: 4120, class: "estimated" }), "~4.1k est.");
  assert.equal(fmtAmount({ tokens: 4120, class: "estimated", floor: true }), "~≥4.1k est.", "the floor rule applies inside an estimate");
  assert.equal(fmtAmount({ class: "unknown" }), "—");
});

test("fmtAmount refuses to guess on nullish or malformed input", () => {
  assert.equal(fmtAmount(null), "—");
  assert.equal(fmtAmount(undefined), "—");
  assert.equal(fmtAmount(42), "—");
  assert.equal(fmtAmount({}), "—");
  assert.equal(fmtAmount({ tokens: 4120, class: "billed" }), "—", "an unrecognized class is never rendered as a count");
});

test("makeLineInput edits round-trip: insert, cursor moves, backspace, del, setValue", () => {
  const li = makeLineInput();
  for (const ch of "abc") li.insert(ch);
  assert.equal(li.value(), "abc");
  assert.equal(li.cursor(), 3);
  li.left();
  li.insert("X");
  assert.equal(li.value(), "abXc");
  assert.equal(li.cursor(), 3);
  li.backspace();
  assert.equal(li.value(), "abc");
  assert.equal(li.cursor(), 2);
  li.del();
  assert.equal(li.value(), "ab");
  li.home();
  assert.equal(li.cursor(), 0);
  li.left();
  assert.equal(li.cursor(), 0, "left clamps at the start");
  li.end();
  assert.equal(li.cursor(), 2);
  li.right();
  assert.equal(li.cursor(), 2, "right clamps at the end");
  li.backspace();
  assert.equal(li.value(), "a", "backspace at the end removes the last char");
  li.setValue("hello");
  assert.equal(li.value(), "hello");
  assert.equal(li.cursor(), 5, "setValue parks the cursor at the end");
});

test("makeLineInput substitutes control characters on the way in, typed or pasted", () => {
  // SUBSTITUTES, where it used to delete (issue #402). This box is the LIVE_TAIL search, the pane
  // substitutes the class, and deleting here produced a query matching neither what is drawn nor what is
  // stored. What has NOT changed is the invariant this test was written for: a sentinel can never enter
  // the value, because `render` adds them rather than the value holding them.
  const li = makeLineInput("a\x00b");
  assert.equal(li.value(), "a b", "the initial value is scrubbed too");
  li.insert("\x07");
  assert.equal(li.value(), "a b ", "a lone control char becomes a space");
  li.insert("cd\x1bef");
  assert.equal(li.value(), "a b cd ef", "a pasted string is scrubbed, then inserted whole");
  li.insert(LINE_INPUT_CURSOR[0] + "x" + LINE_INPUT_CURSOR[1]);
  assert.doesNotMatch(li.value(), /[\x01\x02]/, "the cursor sentinels are in the class and can never enter the value");
});

test("makeLineInput render is exactly width columns and windows around the cursor", () => {
  const li = makeLineInput("abcdefghij");
  assert.equal(li.render(6, { focused: false }), "fghij ", "cursor at the end -> the tail plus the cursor's pad cell");
  li.home();
  assert.equal(li.render(6, { focused: false }), "abcdef", "cursor at the start -> the head");
  for (let i = 0; i < 7; i++) li.right();
  assert.equal(li.render(6, { focused: false }), "cdefgh", "a mid-value cursor scrolls just far enough to stay visible");
  const short = makeLineInput("hi");
  assert.equal(short.render(6, { focused: false }), "hi    ", "short values right-pad to width");
});

test("makeLineInput marks the cursor cell with the sentinels only when focused; clip drops them", () => {
  const li = makeLineInput("abc");
  const [open, close] = LINE_INPUT_CURSOR;
  const focused = li.render(6);
  assert.equal(focused, "abc" + open + " " + close + "  ", "the cursor sits on the pad cell after the value");
  const unfocused = li.render(6, { focused: false });
  assert.ok(!unfocused.includes(open) && !unfocused.includes(close), "unfocused render carries no sentinel bytes");
  assert.equal(clip(focused, 6), unfocused, "clip strips the sentinels down to the exact plain render");
  const long = makeLineInput("abcdefghij");
  assert.equal(clip(long.render(6), 6).length, 6, "a windowed focused render is still exactly width after the strip");
});

test("trimClusters drops whitespace-only clusters at either end and never trims inside one (issue #422)", () => {
  const prepend = String.fromCharCode(0x0600);
  const acute = String.fromCharCode(0x0301);
  // A Prepend joins the space after it into its own cluster, so that space stays.
  assert.equal(trimClusters(`  until 1${prepend} `), `until 1${prepend} `);
  // A space carrying a combining mark is a cluster that draws something: kept, at either end.
  assert.equal(trimClusters(` ${acute}x `), ` ${acute}x`);
  assert.equal(trimClusters(`x ${acute}`), `x ${acute}`);
  // Plain whitespace clusters go, runs of them too, and the inside is untouched.
  assert.equal(trimClusters(" \t repeat  now \n "), "repeat  now");
  assert.equal(trimClusters("   "), "");
  assert.equal(trimClusters(""), "");
});
