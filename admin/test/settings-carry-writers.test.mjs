// Every writer of the settings overlay keeps what it does not know (issue #761): a key a later release added and a
// `secretBundles` block survive a write from each entry point that writes the file, byte for byte in their places. One
// test per writer family: `writeSettings` itself, and the console's setting and secret actions. The retired panel's
// writers (`/dispatch set|unset`, its settings dialog, `/dispatch secrets`) went with the panel (58ef2369); the
// model-callable `dispatch_set` rides the same `writeSettings` the first test pins.
// Each compares the file's whole text, so a reordered, dropped or rewritten key fails, not just a missing one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import * as nodeFs from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.mjs";
import { blankSettingsFile, overlayInvalidRefusal, readSettingsView, writeSettings } from "../src/read-model.mjs";
import * as RM from "../src/read-model.mjs";
import * as WP from "../src/write-plans.mjs";
import { ACTIONS } from "../src/console/actions.mjs";

// Every write below is audited into PI_LOGS_DIR's console-audit chain, so it lands in a directory of its own.
process.env.PI_LOGS_DIR = tempDir("settings-carry-logs-");

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const text = (value) => `${JSON.stringify(value, null, 2)}\n`;

/**
 * The file a newer release left: `futureCap`, a key this build does not know, between two it does, and a
 * `secretBundles` block (an operator-only table no tool can set). Built as text so the expectations below are text.
 * No retired dollar key (`maxCostUsd` and friends): this build refuses a file that holds one, so a carry test
 * seeded with it would pin the refusal, not the carry.
 */
const BUNDLES = { shop: { path: "/opt/pi/bundle-shop.sh", format: "dotenv" } };
const FILE = { model: "m1", futureCap: { perHost: 3 }, maxTurns: 30, secretBundles: BUNDLES };
/** The same file with `over` applied in the file's own order (a key set to undefined is gone, a new key goes last). */
function fileWith(over) {
  const out = {};
  for (const [k, v] of Object.entries(FILE)) if (!Object.hasOwn(over, k)) out[k] = v;
  else if (over[k] !== undefined) out[k] = over[k];
  for (const [k, v] of Object.entries(over)) if (!Object.hasOwn(FILE, k) && v !== undefined) out[k] = v;
  return text(out);
}

/** A deployment folder holding that file, with PI_SETTINGS_FILE pointed at it for the extension's own reads. */
function seeded() {
  const dir = tempDir("settings-carry-");
  const settingsFile = join(dir, "settings.json");
  writeFileSync(settingsFile, text(FILE));
  process.env.PI_SETTINGS_FILE = settingsFile;
  return { dir, settingsFile };
}

test("writeSettings keeps every overlay key it does not know (a key from a later release) and a secretBundles block (#761)", () => {
  const { settingsFile } = seeded();
  const res = writeSettings({ settingsFile, mutate: (o) => ({ ...o, maxTurns: 40 }) });
  // `mutate` and the result still see the known keys only: no caller can read or set a carried one.
  assert.deepEqual(res, { ok: true, overlay: { model: "m1", maxTurns: 40, secretBundles: BUNDLES } });
  assert.equal(readFileSync(settingsFile, "utf8"), fileWith({ maxTurns: 40 }));
  // An unset removes the key from its place and keeps the rest; a candidate's own unknown key is never carried.
  const unset = writeSettings({ settingsFile, mutate: (o) => { delete o.maxTurns; return { ...o, smuggled: "x" }; } });
  assert.equal(unset.ok, true);
  assert.equal(readFileSync(settingsFile, "utf8"), fileWith({ maxTurns: undefined }));
});

test("writeSettings refuses a file a newer pi-dispatch wrote, names the upgrade, and leaves it untouched (#761)", () => {
  const { settingsFile } = seeded();
  const newer = text({ version: 2, ...FILE });
  writeFileSync(settingsFile, newer);
  let mutated = 0;
  const res = writeSettings({ settingsFile, mutate: (o) => (mutated++, { ...o, maxTurns: 40 }) });
  assert.deepEqual(res, { invalid: "the settings file was written by a newer pi-dispatch (version 2; this build understands 1), so nothing was written and no key in it was lost. Upgrade this panel or console to the release that wrote it" });
  assert.equal(mutated, 0, "the newer file is never handed to mutate");
  assert.equal(readFileSync(settingsFile, "utf8"), newer);
  // The view carries `newer`, so the tool's pre-confirm refusal says the same; a broken file keeps the fix-it words.
  const view = readSettingsView({ settingsFile });
  assert.equal(view.newer, true);
  assert.equal(overlayInvalidRefusal(view.invalid, { newer: view.newer }), res.invalid);
  writeFileSync(settingsFile, text({ version: "2", ...FILE }));
  const broken = readSettingsView({ settingsFile });
  assert.equal(broken.newer, undefined);
  assert.match(writeSettings({ settingsFile, mutate: (o) => o }).invalid, /^the settings file is invalid \(settings file "version" must be an integer of 1 or more\), so nothing was written and no key in it was lost\. Fix the file/);
  assert.equal(blankSettingsFile(settingsFile), false);
});

test("writeSettings re-checks against its OWN read when no expect is given: a write landing in between refuses, a first write never refuses itself (#761)", () => {
  const { settingsFile } = seeded();
  // Another session writes the file after this call read it (inside `mutate`, which runs between the read and the
  // write): the carried keys would roll that write back, so it is a refusal, not a silent loss.
  const other = text({ ...FILE, maxTurns: 99 });
  const res = writeSettings({ settingsFile, mutate: (o) => { writeFileSync(settingsFile, other); return { ...o, maxTurns: 40 }; } });
  assert.match(res.invalid, /changed after this change was built from it \(another session wrote it\); nothing was written/);
  assert.equal(readFileSync(settingsFile, "utf8"), other);
  // A missing file is read as `null`, `fileSnapshot`'s encoding, so its first write goes through; a blank one too.
  const dir = tempDir("settings-carry-first-");
  const fresh = join(dir, "settings.json");
  assert.deepEqual(writeSettings({ settingsFile: fresh, mutate: (o) => ({ ...o, maxTurns: 5 }) }), { ok: true, overlay: { maxTurns: 5 } });
  assert.equal(readFileSync(fresh, "utf8"), text({ maxTurns: 5 }));
  writeFileSync(fresh, "﻿ \n");
  assert.deepEqual(writeSettings({ settingsFile: fresh, mutate: (o) => ({ ...o, maxTurns: 6 }) }), { ok: true, overlay: { maxTurns: 6 } });
  // A file created between a missing read and the rename is a write this call did not see: refused.
  const raced = join(tempDir("settings-carry-race-"), "settings.json");
  assert.match(writeSettings({ settingsFile: raced, mutate: (o) => { writeFileSync(raced, text({ dailyCap: 9 })); return { ...o, maxTurns: 5 }; } }).invalid, /changed after this change was built from it/);
  // The caller's own `expect` still wins over the default (the console passes its preview's).
  const { settingsFile: second } = seeded();
  assert.match(writeSettings({ settingsFile: second, expect: [{ path: second, text: "{}" }], mutate: (o) => o }).invalid, /changed after this change was built from it/);
});


/** One console file action, previewed and applied as the confirm applies it: the preview's own `expect` and run. */
async function consoleAct(name, body, paths) {
  const action = ACTIONS.find((a) => a.name === name);
  const ctx = { a: { rm: RM, plans: WP, paths, env: {} }, fs: nodeFs, config: { pauseWindowsPath: null, dir: null }, session: { role: "operator", name: "alice" }, deps: {} };
  const preview = await action.preview(body, ctx);
  assert.equal(preview.refusal, undefined, `${name}: ${preview.refusal}`);
  const applied = await action.apply(preview, ctx);
  return { preview, applied };
}

test("the console's setting and secret actions keep a later release's key and the secretBundles block, and each preview's after digest is the written file's (#761)", async () => {
  const { dir, settingsFile } = seeded();
  const paths = { settingsFile, triggersPath: join(dir, "triggers.json"), envelopeFile: null, projectsFile: null, scopedLimitsPath: null, logsDir: join(dir, "logs") };
  writeFileSync(paths.triggersPath, text({ triggers: [] }));
  const steps = [
    ["setting-set", { key: "maxTurns", value: "44" }, fileWith({ maxTurns: 44 })],
    ["setting-unset", { key: "maxTurns" }, fileWith({ maxTurns: undefined })],
    ["secret-profile-add", { name: "prod", path: "/opt/resolve-prod" }, fileWith({ maxTurns: undefined, secretProfiles: { prod: "/opt/resolve-prod" } })],
    ["secret-bundle-add", { name: "ops", path: "/opt/bundle-ops", format: "json" }, fileWith({ maxTurns: undefined, secretBundles: { ...BUNDLES, ops: { path: "/opt/bundle-ops", format: "json" } }, secretProfiles: { prod: "/opt/resolve-prod" } })],
    ["secret-profile-remove", { name: "prod" }, fileWith({ maxTurns: undefined, secretBundles: { ...BUNDLES, ops: { path: "/opt/bundle-ops", format: "json" } }, secretProfiles: {} })],
    ["secret-bundle-remove", { name: "ops" }, fileWith({ maxTurns: undefined, secretProfiles: {} })],
  ];
  for (const [name, body, want] of steps) {
    const { preview, applied } = await consoleAct(name, body, paths);
    assert.deepEqual(applied, { ok: true }, name);
    const after = readFileSync(settingsFile, "utf8");
    assert.equal(after, want, name);
    assert.equal(preview.afterDigest, sha256(after), `${name}: the preview's after digest is the digest of what was written`);
  }
  // A newer file is refused at the preview, in the upgrade's words.
  writeFileSync(settingsFile, text({ version: 2, ...FILE }));
  const refused = await ACTIONS.find((a) => a.name === "setting-set").preview({ key: "maxTurns", value: "45" }, { a: { rm: RM, plans: WP, paths, env: {} }, fs: nodeFs, config: {}, session: { role: "operator" }, deps: {} });
  assert.equal(refused.refusal, "rejected: the settings file was written by a newer pi-dispatch (version 2; this build understands 1), so nothing was written and no key in it was lost. Upgrade this panel or console to the release that wrote it");
});


