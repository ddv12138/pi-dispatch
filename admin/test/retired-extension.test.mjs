import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);

test("the admin package ships the console without registering a pi extension or skill", () => {
  const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
  assert.equal(pkg.pi?.extensions, undefined);
  assert.equal(pkg.pi?.skills, undefined);
  assert.equal(pkg.bin["pi-dispatch-console"], "./dist/console.mjs");
  assert.equal(existsSync(new URL("src/index.ts", root)), false);
  assert.equal(existsSync(new URL("../.pi/extensions/dispatch.ts", root)), false);
  assert.equal(existsSync(new URL("skills/operate-pi-dispatch", root)), false);
});
