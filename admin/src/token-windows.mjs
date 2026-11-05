/**
 * The token windows as the operator sees them (issue #501, DES-TOKEN-RESERVE-AND-SETTLE): one row per ACTIVE
 * window, the deployment's first, then each repo or folder row of `scoped-limits.json`, then each model row, in
 * file order. Pure: no filesystem, no Valkey, no clock of its own. The panel and the tools read the counters and
 * the records and hand them in; this module only lines them up.
 *
 * Two sources, and each number says which one it came from, because they answer different questions:
 *   - the COUNTER (`counterTokens`) is the window's Valkey key, the one the worker reserves against. It holds what
 *     settled runs were charged PLUS what running jobs still hold, so it is "reserved and held". It is fleet-wide
 *     and it is the truth the next job is admitted against. Read under the worker's own key functions (`dayKey`,
 *     `weekKey`, `monthKey` with the shared prefixes), so the two sides cannot disagree on which key is today's;
 *   - the RECORDS (`settledTokens`, the `basis` counts) are the run records this panel can read, whose run started
 *     in the window. They say how each run settled. They are not the counter's other half: a retried job keeps
 *     only its last attempt's record, retention can drop a record, and another host's records are here only on a
 *     shared `PI_LOGS_DIR`. So `held` is never derived as counter minus settled.
 *
 * Attribution from a record is honest about what a record can name. A repo row's runs are the forge records whose
 * target is that repo. A project row's are the records whose `project` is that id (issue #499 part C): the id the
 * worker resolved at pickup and wrote into the record, never the projects file as it is now, so a record from before
 * a member joined stays outside the window. A folder row's are not attributable (a record names a local folder by its basename only),
 * and neither are a model row's (a record keeps each model's cost, but not which model windows the job reserved
 * in: an unrestricted job holds a cap in every model row, a listed one only in its listed models'): those rows
 * carry the counter and `records: null` with the reason, never a guess.
 *
 * Only numbers, fixed tokens, and the operator's own scope and model names leave this module. No task text, no
 * target beyond the repo name the operator already wrote in their own limits file.
 */

import { dayKey, monthKey, weekKey } from "@edgehero/pi-dispatch/budget";
import { isAbsolute } from "node:path";
import { TOKEN_BASIS, TOKEN_KEY_PREFIX, MODEL_BASIS } from "@edgehero/pi-dispatch/token-budget";
import { TOKEN_ENV_NAMES as WORKER_TOKEN_ENV_NAMES, TOKEN_SETTING_KEYS, optionalTokenCount } from "@edgehero/pi-dispatch/budget-rule";
import { tokenKeyPrefixFor, isModelScope, isProjectScope, MODEL_SCOPE_PREFIX } from "@edgehero/pi-dispatch/scoped-limits";
import { recordInProject, recordInRepo } from "./costs.mjs";
import { fromNewerRelease, newerSkippedSentence } from "./newer-release.mjs";

const WINDOWS = [
  { window: "day", keyOf: dayKey, setting: "dailyTokenCap", field: "dayTokens" },
  { window: "week", keyOf: weekKey, setting: "weeklyTokenCap", field: "weekTokens" },
  { window: "month", keyOf: monthKey, setting: "monthlyTokenCap", field: "monthTokens" },
];

const DAY_MS = 24 * 60 * 60 * 1000;

/** Why a row's records are not shown, as fixed sentences. */
export const UNATTRIBUTED = Object.freeze({
  folder: "a run record names a local folder by its basename only",
  model: "a run record does not say which model windows the job reserved in",
});

/**
 * The deployment's token window caps in whole tokens, `{ day, week, month }` (each null when unset), from the
 * overlay and the env the admin can see, merged per key the worker's way: the overlay value wins, else a non-empty
 * env variable. A value that does not parse is null here and `invalid` names its key: the worker refuses it, and a
 * display that guessed a cap would be worse than one that says it could not read one.
 */
export function deploymentTokenCaps(overlay, env) {
  const caps = { day: null, week: null, month: null };
  const invalid = [];
  const merged = (setting) => {
    const own = overlay?.[setting];
const TOKEN_ENV_NAMES = Object.freeze({ maxTokens: "PI_MAX_TOKENS", ...WORKER_TOKEN_ENV_NAMES });
    const fromEnv = env?.[TOKEN_ENV_NAMES[setting]];
    return own !== undefined && own !== null ? own : typeof fromEnv === "string" && fromEnv !== "" ? fromEnv : null;
  };
  for (const w of WINDOWS) {
    try {
      caps[w.window] = optionalTokenCount(merged(w.setting), w.setting);
    } catch {
      invalid.push(w.setting);
    }
  }
  // The per-job cap every job reserves (PR #550's review): what tells a window that still has room from one that
  // has room for no job. Null when unset or unreadable, and then the row is judged on its counter alone.
  let jobCapTokens = null;
  try {
    jobCapTokens = optionalTokenCount(merged("maxTokens"), "maxTokens");
  } catch {
    // Not named in `invalid`: that line is about the windows shown, and the worker refuses a malformed cap anyway.
  }
  return { caps, jobCapTokens, invalid };
}

/**
 * Every active token window, in display order: the deployment's (day, week, month), then each scoped-limits row
 * that carries a token field, each with its own windows in the same order. `{ ledger, name, index, window,
 * capTokens, keyPrefix, key }`: `ledger` is `deployment`, `scope` or `model`, `name` the row's scope or the model's
 * `provider/model` (null for the deployment), `index` the row's index in the limits file (null for the deployment).
 * `limits` are normalized rows (the shared parser's output), whose token fields are whole numbers.
 */
export function tokenWindowSpecs({ caps, limits, now = new Date() }) {
  const out = [];
  for (const w of WINDOWS) {
    const cap = caps?.[w.window];
    if (cap === null || cap === undefined) continue;
    out.push({ ledger: "deployment", name: null, index: null, window: w.window, capTokens: cap, keyPrefix: TOKEN_KEY_PREFIX, key: w.keyOf(now, TOKEN_KEY_PREFIX) });
  }
  (Array.isArray(limits) ? limits : []).forEach((row, index) => {
    if (!WINDOWS.some((w) => row?.[w.field] !== null && row?.[w.field] !== undefined)) return;
    const model = isModelScope(row.scope);
    const keyPrefix = tokenKeyPrefixFor(row);
    for (const w of WINDOWS) {
      let cap;
      try {
        cap = optionalTokenCount(row[w.field], w.field);
      } catch {
        continue; // the shared parser already refused such a file; a hand-built row is skipped, never guessed
      }
      if (cap === null) continue;
      out.push({
        ledger: model ? "model" : "scope",
        name: model ? row.scope.slice(MODEL_SCOPE_PREFIX.length) : row.scope,
        index,
        window: w.window,
        capTokens: cap,
        keyPrefix,
        key: w.keyOf(now, keyPrefix),
      });
    }
  });
  return out;
}

/**
 * The earliest instant any of `specs` covers: the start of the oldest active window (a month starts before the week
 * and day in it; a week can start in the month before). The records scan begins here. Null when there is no spec.
 */
export function tokenWindowsSinceMs(specs, now = new Date()) {
  if (!Array.isArray(specs) || specs.length === 0) return null;
  const day = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const starts = {
    day,
    week: day - ((new Date(day).getUTCDay() + 6) % 7) * DAY_MS,
    month: Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  };
  return Math.min(...specs.map((s) => starts[s.window] ?? day));
}

/** Is `value` a non-negative safe integer (a token count)? */
function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Does this record belong to this window? Its run's START falls in the window (the window key the worker would
 * have reserved under, recomputed from `startedAt` with the same key function), it carries a `tokensWindows` object, and
 * for a repo row its target is that repo: on that forge for a qualified row (`github:acme/web`, issue #498), on every
 * forge for a bare one. For a project row (`project:shop`) its `project` is that id, a local record included.
 */
function belongs(record, spec) {
  if (!record || typeof record !== "object" || !record.tokensWindows || typeof record.tokensWindows !== "object") return false;
  const at = Date.parse(record.startedAt ?? record.endedAt ?? "");
  if (!Number.isFinite(at)) return false;
  const keyOf = WINDOWS.find((w) => w.window === spec.window)?.keyOf;
  if (!keyOf || keyOf(new Date(at), spec.keyPrefix) !== spec.key) return false;
  if (spec.ledger === "scope" && isProjectScope(spec.name)) return recordInProject(record, spec.name.slice("project:".length));
  if (spec.ledger === "scope") {
    if (record.kind === "local") return false;
    return recordInRepo(record, String(spec.name));
  }
  return true;
}

/**
 * Whether a record from a NEWER pi-dispatch (issue #761) could belong to this window, judged on its stable core alone:
 * its start falls in the window, and for a project row its `project` is that id; a repo row's target is past the core,
 * so any forge run of the window could be the repo's. It is never folded: such a record is counted, so the row can say
 * its settled sum leaves it out.
 */
function newerMayBelong(record, spec) {
  const at = Date.parse(record.startedAt ?? record.endedAt ?? "");
  if (!Number.isFinite(at)) return false;
  const keyOf = WINDOWS.find((w) => w.window === spec.window)?.keyOf;
  if (!keyOf || keyOf(new Date(at), spec.keyPrefix) !== spec.key) return false;
  if (spec.ledger === "scope" && isProjectScope(spec.name)) return recordInProject(record, spec.name.slice("project:".length));
  if (spec.ledger === "scope") return record.kind !== "local";
  return true;
}

/**
 * The records' side of one window: `{ runs, settledTokens, basis: { metered, floor, refunded, unreserved } }`, or
 * null with the reason (`UNATTRIBUTED`) for a row a record cannot be matched to. `settledTokens` sums
 * `tokensWindows.settledTokens`; a malformed amount is skipped and counted in `malformed`, never read as 0.
 * `newerSkipped`, present only when there were any, counts the window's records from a newer pi-dispatch, which
 * are not read (issue #761). `boundExceeded` died with the guard: the settlement's basis says what the worker
 * knows, and there is no bound it was measured against.
 */
export function foldWindowRecords(records, spec) {
  if (spec.ledger === "model") return { records: null, unattributed: UNATTRIBUTED.model };
  if (spec.ledger === "scope" && typeof spec.name === "string" && isAbsolute(spec.name)) return { records: null, unattributed: UNATTRIBUTED.folder };
  const basis = Object.fromEntries(TOKEN_BASIS.map((b) => [b, 0]));
  let runs = 0;
  let settledTokens = 0;
  let malformed = 0;
  let newerSkipped = 0;
  for (const record of Array.isArray(records) ? records : []) {
    if (fromNewerRelease(record)) {
      if (newerMayBelong(record, spec)) newerSkipped++;
      continue;
    }
    if (!belongs(record, spec)) continue;
    runs++;
    const d = record.tokensWindows;
    if (isCount(d.settledTokens)) settledTokens += d.settledTokens;
    else malformed++;
    if (Object.hasOwn(basis, d.basis)) basis[d.basis]++;
  }
  return { records: { runs, settledTokens, basis, malformed, ...(newerSkipped > 0 ? { newerSkipped } : {}) } };
}

/**
 * One row per spec: `{ ledger, name, window, capTokens, counterTokens, records, unattributed? }`. `counters` maps a
 * spec's `key` to its counter value (a number, or null when that read failed), or is `{ unreachable }` for a queue
 * that could not be read: then every `counterTokens` is null, never an invented 0. An absent key is an honest 0 (a
 * window nothing has reserved in yet), the posture `readScopedBudget` takes.
 */
export function tokenWindowRows({ specs, counters, records, jobCapTokens = null }) {
  const unreachable = counters && typeof counters === "object" && "unreachable" in counters;
  return (Array.isArray(specs) ? specs : []).map((spec) => {
    let counterTokens = null;
    if (!unreachable && counters && typeof counters === "object") {
      const raw = counters[spec.key];
      counterTokens = raw === undefined ? 0 : raw === null ? null : Number(raw);
      if (counterTokens !== null && !Number.isFinite(counterTokens)) counterTokens = null;
    }
    const fold = foldWindowRecords(records, spec);
    // FULL when the next job at the deployment's per-job budget would not fit (PR #550's review): a reservation adds
    // the whole budget, so `counter + budget > window` already refuses every such job while the counter is still
    // below the window. A trigger with a smaller `run.maxTokens` may still fit; the row says "full", not "refusing all".
    const full = counterTokens !== null && (counterTokens >= spec.capTokens || (isCount(jobCapTokens) && counterTokens + jobCapTokens > spec.capTokens));
    return { ledger: spec.ledger, name: spec.name, index: spec.index, window: spec.window, capTokens: spec.capTokens, counterTokens, full, ...fold };
  });
}

/**
 * The per-run window settlements, newest first, for `dispatch_costs`: `{ jobId, startedAt, endedAt, flow, outcome,
 * tokensWindows }` for each record that carries a `tokensWindows` object. `tokensWindows` is rebuilt from its named
 * fields, so nothing else a hand-edited record holds rides along. At most `limit` rows; `more` counts the rest. A
 * record from a newer pi-dispatch is left out (issue #761: its `tokensWindows` may mean something else there) and
 * counted in `newerSkipped`, present only when there were any.
 */
export function runTokenWindows(records, { limit = 50 } = {}) {
  const rows = [];
  let newerSkipped = 0;
  for (const r of Array.isArray(records) ? records : []) {
    if (fromNewerRelease(r)) {
      newerSkipped++;
      continue;
    }
    const d = r?.tokensWindows;
    if (!d || typeof d !== "object") continue;
    rows.push({
      jobId: typeof r.jobId === "string" ? r.jobId : null,
      startedAt: typeof r.startedAt === "string" ? r.startedAt : null,
      endedAt: typeof r.endedAt === "string" ? r.endedAt : null,
      flow: typeof r.flow === "string" ? r.flow : null,
      outcome: typeof r.outcome === "string" ? r.outcome : null,
      tokensWindows: {
        reservedTokens: isCount(d.reservedTokens) ? d.reservedTokens : null,
        settledTokens: isCount(d.settledTokens) ? d.settledTokens : null,
        basis: TOKEN_BASIS.includes(d.basis) ? d.basis : null,
        modelBasis: MODEL_BASIS.includes(d.modelBasis) ? d.modelBasis : null,
      },
    });
  }
  rows.sort((a, b) => Date.parse(b.endedAt ?? b.startedAt ?? "") - Date.parse(a.endedAt ?? a.startedAt ?? "") || 0);
  return { runs: rows.slice(0, limit), more: Math.max(0, rows.length - limit), ...(newerSkipped > 0 ? { newerSkipped } : {}) };
}

/** A token count with thousands separators, or `-` for a value that is not a count. */
function tokensCell(tokens) {
  return isCount(tokens) ? tokens.toLocaleString("en-US") : "-";
}

/**
 * The token windows as plain text (the panel's narrow-terminal path), or null when there is none to show, so a
 * deployment without a token window renders exactly what it always did. The same facts as the framed rows.
 */
export function renderTokenWindows(windows) {
  if (!windows) return null;
  const out = [];
  if (windows.unreachable) out.push(`  token windows unreadable (${windows.unreachable})`);
  if (Array.isArray(windows.invalid) && windows.invalid.length > 0) out.push(`  not a whole number of tokens: ${windows.invalid.join(", ")}`);
  for (const r of Array.isArray(windows.rows) ? windows.rows : []) {
    const name = r.ledger === "deployment" ? "deployment" : r.ledger === "model" ? `model:${r.name}` : r.name;
    let tail = "records n/a";
    if (r.records) {
      const counts = TOKEN_BASIS.filter((k) => r.records.basis?.[k] > 0).map((k) => `${r.records.basis[k]} ${k}`);
      const newer = newerSkippedSentence(r.records.newerSkipped);
      tail = `settled ${tokensCell(r.records.settledTokens)} from ${r.records.runs} run${r.records.runs === 1 ? "" : "s"}${counts.length > 0 ? ` (${counts.join(", ")})` : ""}${newer ? ` (${newer})` : ""}`;
    }
    out.push(`  ${String(r.window).padEnd(6)}${name}  reserved+held ${tokensCell(r.counterTokens)} of ${tokensCell(r.capTokens)}${r.full ? " (full)" : ""}  ${tail}`);
  }
  return out.length > 0 ? out.join("\n") : null;
}
