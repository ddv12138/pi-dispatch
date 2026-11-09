/**
 * The pure spend fold (issues #53 and #501, DES-TOKEN-FOLD-BY-SCAN): where FACTS meet nothing else.
 *
 * The run records are immutable facts: what ran and what the meter counted, in tokens. Prices died
 * with the cost era (DES-TOKEN-RESERVE-AND-SETTLE): a token is not a dollar, the rate tables are
 * gone, and no view re-derives money the records no longer carry. What this module folds is TOKEN
 * MEASUREMENT -- how much context each run, model, flow, repo, project and trigger consumed, how
 * complete that measurement is, and where a plan's declared windows peaked.
 *
 * Pure by contract: no filesystem, no redis, no clock of its own (`nowMs` is an argument). The single
 * permitted worker coupling is budget's `dayKey`: the fold's daily buckets and the worker's spend
 * windows must agree on where a UTC day boundary falls, and sharing the one function is how the two
 * sides cannot drift.
 *
 * Every amount this module emits is a TYPED value `{ tokens, class, floor, coverage? }` -- never a
 * bare number. The class system makes a mislabeled estimate structurally impossible: a renderer
 * cannot print a token count without also holding what KIND of count it is, and the panel's
 * fmtAmount is the only renderer. Three classes only (the pricing classes died with pricing):
 *   - "metered": the run's own meter read complete (no completeness counter says otherwise);
 *   - "estimated": a floor -- some calls went unmeasured or uncounted, so the true total is higher
 *     (`floor: true`, rendered with the >= prefix);
 *   - "unknown": nothing was measured at all (a pre-meter record).
 */
import { dayKey } from "@edgehero/pi-dispatch/budget";
import { fromNewerRelease, readableRecords } from "./newer-release.mjs";

/** Every class a typed amount can carry. Three only: the pricing classes ("plan", "zero-rated",
 * "seeded") died with pricing itself -- there is no rate table to rate anything zero, no plan price
 * to amortize, and no unmeasured band to seed. */
export const COST_CLASSES = ["metered", "estimated", "unknown"];

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** The spend windows every costs surface offers, in `t`-cycle order. */
export const COSTS_WINDOWS = ["7d", "30d", "mtd"];

/**
 * A window's inclusive start: 7d/30d count back from now; mtd is the start of the current UTC month.
 * This lives HERE, beside the fold, because proration denominates on the requested window: the scan
 * cutoff and the fold's `sinceMs` must be the same instant, and two implementations of "where does
 * mtd start" (the drift this module's dayKey import already guards against at day grain) once let the
 * command and the view disagree by a whole month edge.
 */
export function costsSinceMs(windowKey, nowMs) {
  if (windowKey === "24h") return nowMs - DAY_MS;
  if (windowKey === "week") {
    const now = new Date(nowMs);
    const day = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    return day - ((now.getUTCDay() + 6) % 7) * DAY_MS;
  }
  if (windowKey === "7d") return nowMs - 7 * DAY_MS;
  if (windowKey === "30d") return nowMs - 30 * DAY_MS;
  const now = new Date(nowMs);
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
}

/** The ledger row fields that form a reprice quad -- the full cache split, exactly as recorded. */
const QUAD_KEYS = ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h"];

/** The worker's own UTC day bucket (budget.mjs `dayKey`) with the redis namespace stripped to a bare
 * `YYYY-MM-DD`. Deriving the date here instead would be the drift this import exists to prevent. */
function utcDay(ms) {
  return dayKey(new Date(ms), "day").slice("day:".length);
}

/** Construct a typed amount -- the only shape a token count leaves this module in. */
function typed(tokens, cls, { floor = false, coverage } = {}) {
  const value = { tokens, class: cls, floor };
  if (coverage !== undefined) value.coverage = coverage;
  return value;
}

/**
 * Match a model id against an operator glob: `*` is the only metacharacter (prefix, suffix, or middle),
 * everything else matches literally, case-insensitively -- ledger ids are lowercased by the host, but
 * the glob is operator-typed and should not fail on casing.
 */
export function matchesGlob(id, glob) {
  if (typeof id !== "string" || typeof glob !== "string") return false;
  const pattern = glob
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${pattern}$`, "i").test(id);
}

/**
 * One record's attribution rows -- the degradation ladder, newest shape first:
 *   1. ledgered (a `usage` block with rows): per-(provider,model) rows with the full cache split and a
 *      real reprice quad;
 *   2. pre-ledger (`tokens` but `usage` null -- also the fallback meter and mid-run deaths): ONE
 *      whole-run row from the HOST-effective record.provider/model. No cache split, so `quad` is null:
 *      a quad back-derived from flat totals would be a guess, and this fold does not guess;
 *   3. legacy (not even provider/model): one ("unknown","unknown") row -- attributed honestly to
 *      ignorance rather than to a plausible model;
 *   4. pre-#25 (`tokens` null): NO rows at all -- the run spent something and measured nothing.
 * The 1h cache-write tier is folded into `cacheWrite` for display fields (one column per concept), but
 * the quad keeps the full split -- reprice rates may distinguish the tiers.
 */
function attributionRows(record) {
  const usage = record.usage;
  if (usage && Array.isArray(usage.models) && usage.models.length > 0) {
    return usage.models.map((m) => {
      const quad = {};
      for (const key of QUAD_KEYS) quad[key] = m[key] ?? 0;
      return {
        provider: m.provider,
        model: m.model,
        calls: m.calls ?? 0,
        input: m.input ?? 0,
        output: m.output ?? 0,
        cacheRead: m.cacheRead ?? 0,
        cacheWrite: (m.cacheWrite ?? 0) + (m.cacheWrite1h ?? 0),
        total: m.total ?? 0,
        quad,
      };
    });
  }
  const tokens = record.tokens;
  if (!tokens) return [];
  return [
    {
      provider: record.provider ?? "unknown",
      model: record.model ?? "unknown",
      calls: tokens.calls ?? 0,
      input: tokens.input ?? 0,
      output: tokens.output ?? 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: tokens.total ?? 0,
      quad: null,
    },
  ];
}

/**
 * The exit-line counters that say this run's metered TOKEN total is short of what it consumed, so its
 * amount is a floor (REQ-COST-ANALYTICS (d), COMPLETENESS_COUNTERS). `unresolved`: calls the meter
 * could not finish counting. `usageUnreported`: calls on a priced model whose answer carried broken
 * usage, which pi records as nothing (the meter writes it on every line). `unmeteredChildren`: pi
 * child processes whose tokens the runner could not count.
 *
 * The rule, per key:
 *   - PRESENT and not a whole number at least 0, or PRESENT and above 0: a floor. The worker's
 *     settlement reads anything but 0 the same way.
 *   - ABSENT: not a floor. Absent means an image that never looked (a pre-#500-part-E record for
 *     `unmeteredChildren`, an older meter for the rest), and reading absence as a floor would put
 *     `>=` on all history. Such a record that did spawn a pi child shows as exact, a named residual
 *     (DES-USAGE-METER-VIA-API-PROVIDER-REGISTRY), not a hidden one.
 *
 * `costCapMicros` and the guard's trio (`costUnreported`, `longContext`, `costUnjudged`,
 * `costUnanswered`) are NOT here: the guard died with the cost era, and a record written before it
 * carries none of them. `boundExceeded` never was here either: it said a call cost more than its
 * pre-call bound, which was the worker's settlement concern; the metered tokens themselves were
 * always pi's full count.
 */
const COMPLETENESS_COUNTERS = Object.freeze(["unresolved", "usageUnreported", "unmeteredChildren"]);

/** Whether a run's exit-line counters make its token total a floor (COMPLETENESS_COUNTERS above). */
function floorCounted(tokens) {
  const short = (value) => !(Number.isSafeInteger(value) && value >= 0) || value > 0;
  return COMPLETENESS_COUNTERS.some((key) => tokens[key] !== undefined && short(tokens[key]));
}

/**
 * Whether a record is a refusal before any spend (issue #507): no tokens, no container exit, and the worker's own word
 * that no budget slot is held (`budgetReserved: false`). Most pre-spend refusals write exactly that. All three,
 * because each alone is also true of a run that spent: a pre-meter record (before issue #25) has no tokens, a
 * container killed before its exit line may have no exit code, and an old record has no `budgetReserved`. A record
 * that does not SAY `false` (null, or absent on an old record) keeps the floor below.
 *
 * `budgetReserved` is HISTORY now: token budgets, windows and allocation are gone (C2), so a new record never carries
 * it. The field stays readable because an old record's `false` is still the exact statement that it refused before any
 * spend -- the one place a settled total may honestly read 0 instead of a floor.
 *
 * Not every refusal before spend matches, and those stay floors, on purpose (a residual, DES-COST-FOLD-BY-SCAN): a
 * refusal that kept the budget slot it reserved (`budgetReserved: true`) does. A container the runtime
 * failed to start (`container-never-started` with an exit code, often 125) carries that code, so it stays a floor too. Telling those
 * apart would mean keying on the reason, a list every new gate would have to join; a fact the record states itself
 * would be the way to count them as 0.
 */
export function refusedBeforeSpend(record) {
  return (record.tokens === null || record.tokens === undefined) && (record.exitCode === null || record.exitCode === undefined) && record.budgetReserved === false;
}

/**
 * One run's contribution to every aggregate: its attribution rows (each carrying the run's class and
 * floor), its metered token total, the set of classes it carries, and whether its number is a floor.
 */
function runContribution(record) {
  const tokens = record.tokens ?? null;
  // A refusal before any spend (issue #507): an exact 0, never a floor, and CLASSLESS: it measured
  // nothing, so it takes no part in a bucket's class or coverage (combineContributions). Before this
  // it fell to the branch below and put a floor on every bucket it joined, so a lab of refusals read
  // ">= 0 est." and counted as unmetered runs (REQ-COST-ANALYTICS (d)).
  if (refusedBeforeSpend(record)) return { rows: [], tokens: 0, classes: [], floor: false, refused: true };
  // Pre-meter: the run consumed real tokens and recorded nothing. 0 of class "unknown", and a FLOOR
  // -- any total containing it understates by construction.
  if (!tokens) return { rows: [], tokens: 0, classes: ["unknown"], floor: true };
  // Floor rule: the fallback meter (metered:false) missed subagent and compaction tokens entirely,
  // and a completeness counter says which calls went uncounted. Either way this run's number is a
  // floor, and floors are sticky -- any aggregate containing one is a floor.
  const floor = tokens.metered === false || floorCounted(tokens);
  const cls = floor ? "estimated" : "metered";
  const rows = attributionRows(record).map((row) => ({ ...row, class: cls, floor }));
  const total = rows.reduce((sum, row) => sum + row.total, 0);
  return { rows, tokens: total, classes: [cls], floor };
}

/** Fold run contributions into one typed amount. Aggregation demotion: a sum stays "metered" only
 * when EVERY addend is metered; one "unknown" addend demotes the sum to "estimated", because the
 * number no longer says what the window consumed -- only what its measured part consumed -- and
 * `coverage` then reports what fraction of the bucket's runs contributed metered totals. An empty
 * bucket is vacuously metered: 0, fully measured. */
function combineContributions(contribs) {
  const tokens = contribs.reduce((sum, c) => sum + c.tokens, 0);
  const floor = contribs.some((c) => c.floor);
  // A refusal before any spend (issue #507) is classless: it is left out of every class test and of
  // the coverage denominator, so it neither demotes a bucket nor dilutes its coverage. A bucket of
  // refusals alone is then vacuously metered, an exact 0, like an empty bucket.
  const measured = contribs.filter((c) => c.refused !== true);
  const allMetered = measured.every((c) => c.classes.length === 1 && c.classes[0] === "metered");
  if (allMetered) return typed(tokens, "metered", { floor });
  const meteredRuns = measured.filter((c) => c.classes.includes("metered")).length;
  return typed(tokens, "estimated", { floor, coverage: measured.length > 0 ? meteredRuns / measured.length : 1 });
}

/** A record's bucketing instant: `endedAt`, or `startedAt` for a record that never ended; null when
 * neither parses -- such a record cannot be placed in any bucket and is dropped by the fold. */
function recordMs(record) {
  const at = Date.parse(record?.endedAt ?? record?.startedAt ?? "");
  return Number.isFinite(at) ? at : null;
}

/**
 * Fold scanned run records into the one
 * read-model the costs view renders. Everything below is derived per call and thrown away -- nothing
 * classified here is ever written anywhere.
 *
 * A record from a NEWER pi-dispatch is not folded (issue #761, `readableRecords`): its tokens, usage and dollars may
 * mean something else in that release, and a misread one is a wrong dollar on every aggregate. It is counted in
 * `newerSkipped`, present only when there were any, so the view can say its totals leave them out.
 */
export function foldCosts({ records, subscriptions, nowMs, piAiPin = null, sinceMs = null, triggerJoin = null }) {
  const subs = Array.isArray(subscriptions) ? subscriptions : [];
  const runs = [];
  const { records: readable, newerSkipped } = readableRecords(records);
  for (const record of readable) {
    if (!record || typeof record !== "object") continue;
    const at = recordMs(record);
    if (at === null) continue;
    runs.push({ record, at, contribution: runContribution(record) });
  }
  runs.sort((a, b) => a.at - b.at);

  // The window the caller ASKED about versus the window the records happen to span. Proration must
  // denominate on the requested window (`sinceMs`, the same instant the caller cut the scan at):
  // deriving days from the first observed run understates plan cost on any sparse window -- two runs
  // yesterday against a month-to-date question made every verdict read SAVING -- so that derivation
  // survives only for callers that fold an arbitrary record set with no window to ask about.
  const firstRunMs = runs.length > 0 ? runs[0].at : null;
  const requested = Number.isFinite(sinceMs);
  const fromMs = requested ? Math.min(sinceMs, nowMs) : (firstRunMs ?? nowMs);
  const toMs = nowMs;
  const days = requested || runs.length > 0 ? Math.max(1, Math.ceil((toMs - fromMs) / DAY_MS)) : 0;

  return {
    // `firstRunMs` rides along (null when nothing ran) so a renderer can pad or trim the daily series
    // against the requested edge without re-deriving what the fold already knows.
    window: { fromMs, toMs, days, firstRunMs },
    // Daily buckets still start at the first observed run, NOT the requested edge: the sparkline's
    // gap-day discipline covers interior quiet days, but a month of leading zeros on a young
    // deployment would compress the visible history into the last few cells.
    daily: buildDaily(runs, firstRunMs ?? fromMs, toMs),
    // The per-flow daily series shares daily's origin and span, so the flow multiples and the
    // global columns describe the same days (issue #181).
    dailyByFlow: buildDailyByFlow(runs, firstRunMs ?? fromMs, toMs),
    byFlow: buildByFlow(runs),
    byModel: buildByModel(runs),
    // null, not [], without a join: "not computed" and "nothing attributed" are different sentences,
    // and a caller that wired no triggers must not render an empty table that looks exhaustive.
    byTrigger: triggerJoin ? buildByTrigger(runs, triggerJoin) : null,
    byRepo: buildByRepo(runs),
    // Issue #499 part C: by the project the record carries, never by the projects file as it is now.
    byProject: buildByProject(runs),
    plans: buildPlans(runs, subs, days),
    provenance: buildProvenance(runs, piAiPin),
    ...(newerSkipped > 0 ? { newerSkipped } : {}),
  };
}

/** UTC daily buckets over each run's `endedAt`, ascending. Gap days are PRESENT as zero-run entries:
 * a sparkline over this array renders quiet days as quiet rather than silently compressing history. */
function buildDaily(runs, fromMs, toMs) {
  if (runs.length === 0) return [];
  const buckets = new Map();
  for (const r of runs) {
    const day = utcDay(r.at);
    if (!buckets.has(day)) buckets.set(day, []);
    buckets.get(day).push(r.contribution);
  }
  const daily = [];
  // The epoch is UTC-midnight-aligned, so flooring to DAY_MS lands the cursor on each day's boundary.
  for (let cursor = Math.floor(fromMs / DAY_MS) * DAY_MS; cursor <= toMs; cursor += DAY_MS) {
    const day = utcDay(cursor);
    const contribs = buckets.get(day) ?? [];
    daily.push({ day, amount: combineContributions(contribs), runs: contribs.length });
  }
  return daily;
}

/** One label rule for both flow folds: a null/empty flow reads "(no flow)" -- a display label, not
 * an id, so it can never collide with a real skill-charset flow name. Extracted so buildByFlow and
 * buildDailyByFlow cannot drift on what a flow is called. */
function flowLabelOf(record) {
  return typeof record.flow === "string" && record.flow !== "" ? record.flow : "(no flow)";
}

/**
 * Per-flow DAILY series (issue #181, the line charts): the same composite facts buildDaily and
 * buildByFlow fold separately, folded together -- Map<flow, Map<day, contribs>> over the one sorted
 * runs pass. Every flow is gap-padded over the SAME span (the shared cursor loop), because small
 * multiples are only comparable when they share an x-domain; a flow's quiet day is a zero-run entry
 * exactly as the global series keeps it. Rows sort by window total descending then label, the
 * byFlow comparator applied to the sum, so "top N flows" means the same flows in both tables.
 */
function buildDailyByFlow(runs, fromMs, toMs) {
  if (runs.length === 0) return [];
  const byFlow = new Map();
  for (const r of runs) {
    const flow = flowLabelOf(r.record);
    if (!byFlow.has(flow)) byFlow.set(flow, new Map());
    const days = byFlow.get(flow);
    const day = utcDay(r.at);
    if (!days.has(day)) days.set(day, []);
    days.get(day).push(r.contribution);
  }
  const rows = [];
  for (const [flow, buckets] of byFlow) {
    const days = [];
    for (let cursor = Math.floor(fromMs / DAY_MS) * DAY_MS; cursor <= toMs; cursor += DAY_MS) {
      const day = utcDay(cursor);
      const contribs = buckets.get(day) ?? [];
      days.push({ day, amount: combineContributions(contribs), runs: contribs.length });
    }
    rows.push({
      flow,
      // The machine key beside the display label -- the byFlow lesson (issue #175) held here too.
      flowKey: flow === "(no flow)" ? null : flow,
      days,
    });
  }
  return rows.sort((a, b) => {
    const sum = (row) => row.days.reduce((acc, d) => acc + d.amount.tokens, 0);
    return sum(b) - sum(a) || a.flow.localeCompare(b.flow);
  });
}

/** Per-flow rollup, sorted by metered total descending. The label rule is flowLabelOf's. */
function buildByFlow(runs) {
  const groups = new Map();
  for (const r of runs) {
    const flow = flowLabelOf(r.record);
    if (!groups.has(flow)) groups.set(flow, []);
    groups.get(flow).push(r);
  }
  const byFlow = [];
  for (const [flow, members] of groups) {
    byFlow.push({
      flow,
      // The machine key beside the display label: null for the no-flow bucket, the raw flow name
      // otherwise. The display label once leaked into the what-if filter, where `"(no flow)"` matches
      // no record and a fully ledgered bucket rendered the seeded band -- key and label never share a
      // field again (issue #175).
      flowKey: flow === "(no flow)" ? null : flow,
      runs: members.length,
      tokens: members.reduce((sum, m) => sum + (m.record.tokens?.total ?? 0), 0),
      amount: combineContributions(members.map((m) => m.contribution)),
    });
  }
  return byFlow.sort((a, b) => b.amount.tokens - a.amount.tokens || a.flow.localeCompare(b.flow));
}

// The honesty buckets a run lands in when no trigger claims it, pinned to the table's tail in this
// order however the dollars compare: a bucket named "(unattributed)" sorting above real triggers on
// cost would read as the biggest spender when it is really the biggest unknown.
const TRIGGER_TAIL = ["chained", "manual", "unattributed"];
const TRIGGER_TAIL_LABELS = { chained: "(chained runs)", manual: "(manual/local)", unattributed: "(unattributed)" };

/**
 * Per-trigger rollup over the attribution the read-model passed IN (`attributeRunsToTriggers` --
 * the index+type agreement doctrine and the raw cron jobId grammar live there and are not re-derived
 * by this fold). Every run lands somewhere: a joined run under its trigger's graph node id
 * (`trigger:<index>`), a forge run the join refused under "unattributed", a run with a parentJobId
 * under "chained" (not rolled up to the ancestor trigger: walking parent chains across the retention
 * boundary would attribute partially, and a partial rollup wearing a trigger's name is a lie), and
 * everything else under "manual". `key` is the machine key, `label` display-only -- the byFlow
 * lesson. The outcome split rides along because "what did failed runs consume" is a per-trigger
 * question: a trigger whose spend is mostly failures is a different problem than an expensive one.
 */
function buildByTrigger(runs, triggerJoin) {
  const byJobId = triggerJoin?.byJobId && typeof triggerJoin.byJobId === "object" ? triggerJoin.byJobId : {};
  const groups = new Map();
  for (const r of runs) {
    const record = r.record;
    const entry = typeof record.jobId === "string" ? byJobId[record.jobId] : undefined;
    let bucket;
    if (entry && entry.key !== "unattributed") {
      bucket = { key: entry.key, index: entry.index ?? null, type: entry.type ?? null, label: entry.label ?? entry.key };
    } else if (entry) {
      bucket = { key: "unattributed", index: null, type: null, label: TRIGGER_TAIL_LABELS.unattributed };
    } else if (typeof record.parentJobId === "string" && record.parentJobId !== "") {
      bucket = { key: "chained", index: null, type: null, label: TRIGGER_TAIL_LABELS.chained };
    } else {
      bucket = { key: "manual", index: null, type: null, label: TRIGGER_TAIL_LABELS.manual };
    }
    if (!groups.has(bucket.key)) groups.set(bucket.key, { ...bucket, members: [] });
    groups.get(bucket.key).members.push(r);
  }
  const rows = [];
  for (const g of groups.values()) {
    const outcomes = { completed: 0, policy: 0, failed: 0 };
    for (const m of g.members) {
      const o = m.record.outcome;
      if (o === "completed" || o === "policy" || o === "failed") outcomes[o] += 1;
    }
    const failedMembers = g.members.filter((m) => m.record.outcome === "failed");
    rows.push({
      key: g.key,
      index: g.index,
      type: g.type,
      label: g.label,
      runs: g.members.length,
      tokens: g.members.reduce((sum, m) => sum + (m.record.tokens?.total ?? 0), 0),
      amount: combineContributions(g.members.map((m) => m.contribution)),
      outcomes,
      failedAmount: failedMembers.length > 0 ? combineContributions(failedMembers.map((m) => m.contribution)) : null,
    });
  }
  return rows.sort((a, b) => {
    const tailA = TRIGGER_TAIL.indexOf(a.key);
    const tailB = TRIGGER_TAIL.indexOf(b.key);
    if (tailA !== -1 || tailB !== -1) return tailA === -1 ? -1 : tailB === -1 ? 1 : tailA - tailB;
    return b.amount.tokens - a.amount.tokens || a.label.localeCompare(b.label);
  });
}

/** A target's repo shape: the forge issue/MR tail stripped (`repo#12` -> `repo`, `proj!3` -> `proj`);
 * targets without a numeric tail (local:<basename>) ride through whole; null stays null. The one
 * grammar forgeRepoTargets (read-model) also strips by -- shared so the two can never disagree. */
export function repoOfTarget(target) {
  if (typeof target !== "string" || target === "") return null;
  const repo = target.replace(/[#!]\d+$/, "");
  return repo === "" ? null : repo;
}

/**
 * A record's by-repo key (issue #498): `<kind>:<repo>` for a forge record (`github:acme/web`), so one repo served by two
 * forges is two rows, and the target's repo shape otherwise (`local:site`); null when the record has no target. The
 * same spelling a qualified scoped-limits row or pause window uses. "Forge" is every kind but `local`, the rule
 * `scopeOf` uses: this module may import nothing from the worker but `dayKey`, and a kind list here could miss a forge.
 */
export function repoKeyOf(record) {
  const repo = repoOfTarget(record?.target);
  if (repo === null) return null;
  return isForgeRecordKind(record?.kind) ? `${record.kind}:${repo}` : repo;
}

/** Every record kind but `local` is a forge's (`repoKeyOf` says why this is not `isForgeKind`). */
function isForgeRecordKind(kind) {
  return typeof kind === "string" && kind !== "" && kind !== "local";
}

/**
 * Does this record belong to `repo` as an operator wrote it (issue #498)? A qualified `github:acme/web` selects that
 * forge's records only; a bare `acme/web` selects the repo on every forge (what it always selected), and any other
 * spelling (`local:site`) compares with the target's repo shape. NFC on both sides, the scoped limits' rule. A prefix
 * that names no forge a record carries (`gitub:`) selects nothing, which is what a filter for an unknown forge means.
 */
export function recordInRepo(record, repo) {
  if (typeof repo !== "string" || repo === "") return false;
  const want = repo.normalize("NFC");
  const have = repoOfTarget(record?.target);
  if (have === null) return false;
  const colon = want.indexOf(":");
  if (colon > 0 && isForgeRecordKind(want.slice(0, colon))) return record?.kind === want.slice(0, colon) && have.normalize("NFC") === want.slice(colon + 1);
  return have.normalize("NFC") === want;
}

/** Per-repo/target rollup. `key` null (with the "(no target)" display label) for records carrying no
 * target at all; a forge record keys and labels as `<kind>:<repo>` (`repoKeyOf`, issue #498), so its `kind` is
 * uniform; `kind` is still null for a key that saw mixed kinds. */
function buildByRepo(runs) {
  const groups = new Map();
  for (const r of runs) {
    const repo = repoKeyOf(r.record);
    const mapKey = repo ?? "\u0000none";
    if (!groups.has(mapKey)) groups.set(mapKey, { key: repo, label: repo ?? "(no target)", kinds: new Set(), members: [] });
    const g = groups.get(mapKey);
    if (typeof r.record.kind === "string") g.kinds.add(r.record.kind);
    g.members.push(r);
  }
  const rows = [];
  for (const g of groups.values()) {
    rows.push({
      key: g.key,
      label: g.label,
      kind: g.kinds.size === 1 ? [...g.kinds][0] : null,
      runs: g.members.length,
      tokens: g.members.reduce((sum, m) => sum + (m.record.tokens?.total ?? 0), 0),
      amount: combineContributions(g.members.map((m) => m.contribution)),
    });
  }
  return rows.sort((a, b) => b.amount.tokens - a.amount.tokens || a.label.localeCompare(b.label));
}

/**
 * The project id rule, restated because this module may import nothing from the worker but `dayKey` (the purity test
 * pins it). `worker/src/project-id.mjs` owns it, and `costs.test.mjs` holds the two equal.
 */
export const PROJECT_KEY_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * A record's by-project key (issue #499 part C): the `project` id it was written with, or null. Null for a record
 * written before projects existed, for a run outside every project, and for a value that is not an id (a hand-edited
 * record): those fold into "(no project)". The record's own field and nothing else, deliberately: membership changes,
 * and a fold that re-derived it from the current projects file would rewrite history (a local record names its folder
 * by basename only, so it could not be re-derived anyway).
 */
export function projectKeyOf(record) {
  const id = record?.project;
  return typeof id === "string" && PROJECT_KEY_RE.test(id) ? id : null;
}

/** Does this record belong to project `id`? An id selects the runs recorded under it; anything else selects none. */
export function recordInProject(record, id) {
  return typeof id === "string" && PROJECT_KEY_RE.test(id) && projectKeyOf(record) === id;
}

/**
 * Per-project rollup (issue #499 part C), keyed by `projectKeyOf`, with the same typed dollars as every bucket. `key`
 * null with the "(no project)" label for runs that carry no project. A MAP, not a plain object: `constructor` is a valid
 * project id, and an object literal already "has" that key through its prototype, so a run recorded under it would
 * be added to a function and vanish from the fold.
 */
function buildByProject(runs) {
  const groups = new Map();
  for (const r of runs) {
    const id = projectKeyOf(r.record);
    const mapKey = id ?? "\u0000none";
    if (!groups.has(mapKey)) groups.set(mapKey, { key: id, label: id ?? "(no project)", members: [] });
    groups.get(mapKey).members.push(r);
  }
  const rows = [];
  for (const g of groups.values()) {
    rows.push({
      key: g.key,
      label: g.label,
      runs: g.members.length,
      tokens: g.members.reduce((sum, m) => sum + (m.record.tokens?.total ?? 0), 0),
      amount: combineContributions(g.members.map((m) => m.contribution)),
    });
  }
  return rows.sort((a, b) => b.amount.tokens - a.amount.tokens || a.label.localeCompare(b.label));
}

/**
 * The per-trigger spend map for the topology surfaces, keyed by GRAPH NODE ID (`trigger:<index>` --
 * graph-model mints exactly this, so a badge lands on its node with no second join vocabulary).
 * Only real triggers appear: the chained/manual/unattributed honesty buckets have no node to badge
 * and live in byTrigger instead.
 */
export function foldTriggerCosts({ records, triggerJoin }) {
  const byJobId = triggerJoin?.byJobId && typeof triggerJoin.byJobId === "object" ? triggerJoin.byJobId : {};
  const groups = new Map();
  // A newer release's record is left out, as `foldCosts` leaves it out (issue #761); the map has no place to count it.
  for (const record of readableRecords(records).records) {
    if (!record || typeof record !== "object") continue;
    if (recordMs(record) === null) continue; // the fold's own bucketing rule: unplaceable records are dropped
    const entry = typeof record.jobId === "string" ? byJobId[record.jobId] : undefined;
    if (!entry || entry.key === "unattributed" || !entry.key.startsWith("trigger:")) continue;
    if (!groups.has(entry.key)) groups.set(entry.key, []);
    groups.get(entry.key).push(runContribution(record));
  }
  const out = {};
  for (const [key, contribs] of groups) {
    out[key] = { amount: combineContributions(contribs), runs: contribs.length };
  }
  return out;
}

/** Per-(provider,model) rollup from the attribution rows, sorted by total descending. A run appears in
 * a model's `runs` count once, however many of its calls landed there. */
function buildByModel(runs) {
  const groups = new Map();
  for (const r of runs) {
    for (const row of r.contribution.rows) {
      const key = `${row.provider}\u0000${row.model}`;
      if (!groups.has(key)) {
        groups.set(key, { provider: row.provider, model: row.model, runs: 0, calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 0, rows: [] });
      }
      const g = groups.get(key);
      g.runs += 1; // one ledger row per (provider,model) per record, so rows count runs
      g.calls += row.calls;
      g.input += row.input;
      g.output += row.output;
      g.cacheRead += row.cacheRead;
      g.cacheWrite += row.cacheWrite;
      g.tokens += row.total;
      g.rows.push(row);
    }
  }
  const byModel = [];
  for (const g of groups.values()) {
    byModel.push({
      provider: g.provider,
      model: g.model,
      runs: g.runs,
      calls: g.calls,
      input: g.input,
      output: g.output,
      cacheRead: g.cacheRead,
      cacheWrite: g.cacheWrite,
      tokens: g.tokens,
      amount: combineRowTokens(g.rows),
    });
  }
  return byModel.sort((a, b) => b.amount.tokens - a.amount.tokens || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
}

/** A model bucket's typed amount. Rows of one (provider,model) usually share a class, and a uniform
 * class is KEPT -- a fully floored model reads "estimated" at the model grain too, not demoted away.
 * Only a genuinely mixed bucket (the same model both complete and floored across runs) demotes to
 * "estimated" with run-grain coverage. */
function combineRowTokens(rows) {
  const tokens = rows.reduce((sum, row) => sum + row.total, 0);
  const floor = rows.some((row) => row.floor);
  const classes = [...new Set(rows.map((row) => row.class))];
  if (classes.length === 1) return typed(tokens, classes[0], { floor });
  const meteredRows = rows.filter((row) => row.class === "metered").length;
  return typed(tokens, "estimated", { floor, coverage: meteredRows / rows.length });
}

/** Attribute the window's runs to every declared plan. Prices died with the cost era, so there is
 * nothing to score a plan against: no proration, no api-equivalent reprice, no SAVING/LOSING verdict.
 * What remains are FACTS: which runs each plan covered, how many tokens they consumed, and where the
 * plan's declared windows peaked (peakWindow). A what-if plan still attributes the same rows an owned
 * one would -- the fold's what-if surfaces compare TOKEN PROFILES (whatIfFlow/whatIfRuns), not
 * dollars. */
function buildPlans(runs, subs, windowDays) {
  void windowDays;
  return subs.map((sub) => {
    const attributed = [];
    for (const r of runs) {
      // A refusal before any spend (issue #507) never ran on the plan, whatever provider and model it names.
      if (r.contribution.refused === true) continue;
      const covered = r.contribution.rows.filter((row) => row.provider === sub.provider && sub.models.some((glob) => matchesGlob(row.model, glob)));
      if (covered.length > 0) {
        attributed.push({ at: r.at, rows: covered, floor: r.contribution.floor });
        continue;
      }
      // A pre-meter record carries no rows at all, but the host-effective provider/model can still name
      // this plan: the run happened ON the plan even though it measured nothing. It counts against the
      // plan's windows, and it floors every derived number.
      if (r.contribution.rows.length === 0 && r.record.provider === sub.provider && typeof r.record.model === "string" && sub.models.some((glob) => matchesGlob(r.record.model, glob))) {
        attributed.push({ at: r.at, rows: [], floor: true });
      }
    }
    return {
      id: sub.id,
      vendor: sub.vendor,
      hypothetical: sub.hypothetical,
      attributedRuns: attributed.length,
      attributedTokens: attributed.reduce((sum, a) => sum + a.rows.reduce((s2, row) => s2 + row.total, 0), 0),
      anyFloor: attributed.some((a) => a.floor),
      windows: (sub.windows ?? []).map((w) => peakWindow(w, attributed)),
    };
  });
}

/**
 * The observed peak inside one declared plan window -- FACTS ONLY. `limit` rides through verbatim
 * (null = vendor undisclosed, first-class per the subscriptions schema) and nothing here computes
 * remaining/burn-down: the fold reports what happened, never how much room is "left" against a number
 * the vendor may not even have published.
 */
function peakWindow(w, attributed) {
  // A window may be scoped to a subset of the plan's models; a run whose covered rows all fall outside
  // the scope does not count. A row-less attributed run (pre-#25) cannot be scope-checked and counts
  // regardless -- the floor mentality: over-count the peak rather than hide a run.
  const events = [];
  for (const a of [...attributed].sort((x, y) => x.at - y.at)) {
    const scopedRows = w.scope === null || w.scope === undefined ? a.rows : a.rows.filter((row) => w.scope.some((glob) => matchesGlob(row.model, glob)));
    if (w.scope !== null && w.scope !== undefined && a.rows.length > 0 && scopedRows.length === 0) continue;
    events.push({ at: a.at, tokens: scopedRows.reduce((sum, row) => sum + row.total, 0) });
  }

  let peakRuns = 0;
  let peakTokens = 0;
  if (w.rolling) {
    // True sliding max: each event in turn is the window's right edge; shrink the left edge to the
    // span and take the running maximum. A rolling "month" uses the same 30-day proxy as proration.
    const span = w.per === "5h" ? 5 * HOUR_MS : w.per === "7d" ? 7 * DAY_MS : 30 * DAY_MS;
    let left = 0;
    let runsInWindow = 0;
    let tokensInWindow = 0;
    for (let right = 0; right < events.length; right++) {
      runsInWindow += 1;
      tokensInWindow += events[right].tokens;
      while (events[left].at <= events[right].at - span) {
        runsInWindow -= 1;
        tokensInWindow -= events[left].tokens;
        left += 1;
      }
      peakRuns = Math.max(peakRuns, runsInWindow);
      peakTokens = Math.max(peakTokens, tokensInWindow);
    }
  } else {
    // Calendar buckets: "month" folds on the UTC calendar month; every other size folds on the UTC
    // day -- a day-grain approximation (a non-rolling 5h vendor window publishes no anchor to do
    // better against, and a coarser bucket can only OVER-count a peak, never hide a breach).
    const buckets = new Map();
    for (const e of events) {
      const key = w.per === "month" ? utcDay(e.at).slice(0, 7) : utcDay(e.at);
      const b = buckets.get(key) ?? { runs: 0, tokens: 0 };
      b.runs += 1;
      b.tokens += e.tokens;
      buckets.set(key, b);
    }
    for (const b of buckets.values()) {
      peakRuns = Math.max(peakRuns, b.runs);
      peakTokens = Math.max(peakTokens, b.tokens);
    }
  }
  return { per: w.per, rolling: w.rolling, unit: w.unit, limit: w.limit, peakRuns, peakTokens };
}

/** The honesty ledger beside the numbers: how much of the window was actually measured, and whether
 * any of it was priced by a different pi-ai than the one this build pins. */
function buildProvenance(runs, piAiPin) {
  let runsUnmetered = 0;
  let runsUnledgered = 0;
  let runsLedgerTruncated = 0;
  let ratesDrifted = 0;
  for (const { record } of runs) {
    // A refusal before any spend (issue #507) is neither unmetered nor unledgered: it has nothing to meter, and its $0
    // is exact. It still counts in `runsTotal`, so the insights page's "fully ledgered" reads it as fully accounted.
    if (refusedBeforeSpend(record)) continue;
    if (!record.tokens) runsUnmetered += 1;
    // An empty ledger degrades exactly like an absent one -- the flat totals are all the reader has.
    else if (!(record.usage && Array.isArray(record.usage.models) && record.usage.models.length > 0)) runsUnledgered += 1;
    // The meter caps the ledger at 8 named rows and folds the rest into `other` (usage.truncated,
    // INT-RUN-HISTORY-FILE-CONTRACT). Such a run's per-model attribution is partly anonymous, and a
    // fold that states unmetered and unledgered runs but not this one would be selectively honest.
    if ((record.usage?.truncated ?? 0) > 0) runsLedgerTruncated += 1;
    const piAi = record.usage?.piAi ?? null;
    // Drift needs BOTH versions: an unknown pin cannot accuse a record of having been priced elsewhere.
    if (piAi !== null && piAiPin !== null && piAi !== piAiPin) ratesDrifted += 1;
  }
  return {
    total: combineContributions(runs.map((r) => r.contribution)),
    runsTotal: runs.length,
    runsUnmetered,
    runsUnledgered,
    runsLedgerTruncated,
    ratesDrifted,
    piAiPin,
  };
}

/**
 * "What token profile does this flow have per run on model X?" -- the median per-run token total over
 * the flow's ledgered runs (DES-TOKEN-FOLD-BY-SCAN). MEDIAN, not mean: one 10x outlier run must not
 * move the estimate. There is no price to multiply and no rate table to consult: the comparison is
 * between token PROFILES -- the observed median total and its input/output/cache split, against the
 * target model's context window (how much of it one run's median occupies). With no ledgered run to
 * measure from, the fold says "unknown" rather than emit a 0 that looks like an answer: no number was
 * measured, and inventing one is exactly what this fold refuses to do (the unmeasured $0.5-$5/job
 * band was a money-era artifact, OQ-002, and died with the band's unit).
 */
export function whatIfFlow({ records, flow, target }) {
  // A refusal before any spend (issue #507) is no run of the flow: it would be extrapolated at the flow's per-run
  // profile and counted as an unmeasured run in `excluded` and `coverage`. A newer release's record is not read at all
  // (issue #761): its `flow` and `usage` are past the stable core, so it is counted in `newerSkipped`, never as a member.
  const { records: readable, newerSkipped } = readableRecords(records);
  const skipped = newerSkipped > 0 ? { newerSkipped } : {};
  const members = readable.filter((r) => r && typeof r === "object" && (r.flow ?? null) === flow && !refusedBeforeSpend(r));
  const ledgered = members.filter((r) => r.usage && Array.isArray(r.usage.models) && r.usage.models.length > 0);
  if (ledgered.length === 0) return { class: "unknown", note: "unmeasured", runs: Math.max(1, members.length), ...skipped };
  const quads = ledgered.map((r) => sumQuads(r.usage.models));
  const median = medianQuad(quads);
  const perRun = median.total ?? 0;
  return {
    ...skipped,
    class: "estimated",
    // The per-run median times ALL observed runs of the flow -- the un-ledgered ones presumably
    // consumed tokens too; `coverage`/`excluded` say how much of that extrapolation is measured.
    tokens: perRun * members.length,
    perRun,
    medianQuad: median,
    // The profile comparison the what-if exists for: how much of the target model's context window one
    // median run occupies (null when the target declares none).
    contextWindow: typeof target?.contextWindow === "number" ? target.contextWindow : null,
    contextShare: typeof target?.contextWindow === "number" && target.contextWindow > 0 ? perRun / target.contextWindow : null,
    coverage: ledgered.length / members.length,
    excluded: members.length - ledgered.length,
  };
}

/** Componentwise sum of a run's ledger rows into one per-run quad (full cache split). */
function sumQuads(rows) {
  const quad = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, total: 0 };
  for (const row of rows) {
    for (const key of QUAD_KEYS) quad[key] += row[key] ?? 0;
    quad.total += row.total ?? 0;
  }
  return quad;
}

/** Componentwise median across per-run quads (even counts average the two middle values). */
function medianQuad(quads) {
  const quad = {};
  for (const key of [...QUAD_KEYS, "total"]) {
    const sorted = quads.map((q) => q[key]).sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    quad[key] = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return quad;
}

/**
 * The SAME ledgered runs' token totals, never a median multiplied by an unrelated scan's run count
 * (#749). There is no reprice: the fold reports what the runs consumed and how complete each ledger
 * is; a partial ledger is excluded and counted beside the answer.
 */
export function whatIfRuns({ records, target }) {
  void target;
  let tokens = 0;
  let runs = 0;
  let excluded = 0;
  // A newer release's record is not folded (issue #761): its usage rows may mean something else there.
  const { records: readable, newerSkipped } = readableRecords(records);
  for (const record of readable) {
    if (refusedBeforeSpend(record)) continue;
    const usage = record?.usage;
    const rows = usage?.models;
    if (!Array.isArray(rows) || rows.length === 0 || usage.truncated > 0 || rows.some((r) => QUAD_KEYS.some((key) => !Number.isSafeInteger(r?.[key] ?? 0) || (r[key] ?? 0) < 0))) {
      excluded++;
      continue;
    }
    const total = rows.reduce((sum, r) => sum + (Number.isFinite(r.total) && r.total >= 0 ? r.total : NaN), 0);
    if (!Number.isFinite(total) || total < 0) {
      excluded++;
      continue;
    }
    tokens += total;
    runs++;
  }
  return { class: "estimated", tokens, runs, excluded, coverage: runs + excluded > 0 ? runs / (runs + excluded) : 0, ...(newerSkipped > 0 ? { newerSkipped } : {}) };
}

/** A metered-only run's token total, using the same class rule as every spend chart; a floored run is
 * excluded (its number is not the whole truth). */
export function meteredRunTokens(record) {
  if (fromNewerRelease(record)) return null; // a newer release's record: its tokens are past the stable core (issue #761)
  if (record?.tokens?.metered !== true) return null;
  const contribution = runContribution(record);
  if (contribution.refused || contribution.floor || contribution.rows.length === 0 || !contribution.rows.every((r) => r.class === "metered")) return null;
  return Number.isSafeInteger(contribution.tokens) && contribution.tokens >= 0 ? contribution.tokens : null;
}
