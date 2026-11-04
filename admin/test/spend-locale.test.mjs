import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { SPEND_ZH } from "../src/console/locale-spend.mjs";

test("Spend fixed copy has Chinese translations while retaining the HEAD machine label", () => {
  assert.ok(Object.keys(SPEND_ZH).length >= 130);
  for (const [source, translated] of Object.entries(SPEND_ZH)) {
    assert.ok(translated.trim(), `${source}: translation is present`);
    if (source === "HEAD") {
      assert.equal(translated, "HEAD", "the repository ref label is a machine value");
    } else {
      assert.match(translated, /[\u3400-\u9fff]/, `${source}: fixed copy is translated`);
      assert.notEqual(translated, source, `${source}: fixed copy does not fall back to English`);
    }
  }
});

test("Spend translation map does not silently overwrite a source key", () => {
  const source = readFileSync(new URL("../src/console/locale-spend.mjs", import.meta.url), "utf8");
  const keys = [...source.matchAll(/(?:^|[,\n])\s*"((?:[^"\\]|\\.)*)"\s*:/g)].map((match) => JSON.parse(`"${match[1]}"`));
  const duplicates = keys.filter((key, index) => keys.indexOf(key) !== index);
  assert.deepEqual(duplicates, []);
});
