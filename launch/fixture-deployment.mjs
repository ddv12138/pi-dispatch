/**
 * The one canned deployment the console tests render over: config files, a month of
 * run records across three hosts, and a Valkey seeded with the registry rows, the run mirror, a held job and the
 * cron schedulers, all dated around one frozen instant (`NOW`).
 *
 * EVERY VALUE IS WRITTEN THROUGH THE PROJECT'S OWN CODE, never as a hand-made key or a hand-made record: the records
 * are `buildRecord`'s, written by `makeRecordWriter` and mirrored by `makeRunMirror`; the host rows are
 * `makeHostRegistry`'s beat, their running jobs `liveJobsFields`'; the held job is `makeWaitState().hold`; the
 * schedulers are BullMQ's own `upsertJobScheduler`. So an image cannot show a shape the shipped code would never write.
 *
 * SYNTHETIC BY CONSTRUCTION. Hosts `mini1`, `mini2` and `build3`; projects `web`, `api`, `billing` and `ops`; repos
 * under the placeholder owner `acme`; job ids from a seeded generator. No person, machine, account or address of the
 * maintainer's appears, and the only paths are under the temporary directory the caller passes (the panel and the
 * insights page print a local folder by its basename; the commands transcript's caller shows the directory as
 * `~/pi-work`).
 *
 * DETERMINISTIC. No `Math.random`, no wall clock (every instant derives from `NOW`; the caller freezes `Date` for the
 * code that reads it), and every list is built in a fixed order, so two runs seed the same bytes.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Thu 2026-10-08 15:39:08 UTC: the week window began Mon 10-05, the month on 10-01. */
export const NOW = Date.UTC(2026, 9, 8, 15, 39, 8);
const MIN = 60_000;
const H = 3_600_000;
const DAY = 86_400_000;
const M = 1_000_000;

/** build3's `PI_LOG_RETENTION_DAYS`: its own logs directory, and its trim of the shared run mirror. */
const BUILD3_RETENTION_DAYS = 7;

/** This host, the one whose panel the images show (`PI_WORKER_NAME`). */
export const LOCAL_HOST = "mini1";

/** What each host offers: the live slot count, its host budget (`off` for none) and its CPUs. */
const HOSTS = {
	mini1: { slots: 4, memMiB: 16384, cpuCenti: 800, cpus: 10 },
	mini2: { slots: 2, memMiB: "off", cpuCenti: "off", cpus: 8 },
	build3: { slots: 3, memMiB: 24576, cpuCenti: 1200, cpus: 16 },
};

/**
 * The queue's live state, which only a running fleet produces (a job in a processor, a worker connection, a job that
 * failed its last attempt): canned per queue, and consistent with the registry rows below (mini1 runs two jobs, mini2
 * one, build3 one, and nothing waits, since every host has a slot free; the three delayed are the two schedulers' next
 * fires and the job held on run.waitFor).
 */
export const QUEUE_STATE = {
	"pi-jobs": { counts: { waiting: 0, active: 0, paused: 0, delayed: 3, failed: 1 } },
	"pi-jobs@mini1": { counts: { waiting: 0, active: 2, paused: 0, delayed: 0, failed: 0 } },
	"pi-jobs@mini2": { counts: { waiting: 0, active: 1, paused: 0, delayed: 0, failed: 0 } },
	"pi-jobs@build3": { counts: { waiting: 0, active: 1, paused: 0, delayed: 0, failed: 0 } },
};
export const WORKERS = ["mini1", "mini2", "build3"];
export const FAILED = { id: "gh-5d10", attemptsMade: 3, failedReason: "clone failed: remote rejected the token (403)", finishedOn: NOW - 3 * H };

// ---- a seeded generator: the same sequence on every run ------------------------------------------------------------
function generator(seed) {
	let s = seed;
	const next = () => {
		s = (s + 0x6d2b79f5) | 0;
		let t = Math.imul(s ^ (s >>> 15), 1 | s);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	return { next, int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)), hex: (n) => Array.from({ length: n }, () => Math.floor(next() * 16).toString(16)).join("") };
}

// ---- files -------------------------------------------------------------------------------------------------------
const skill = (name, desc, body) => `---\nname: ${name}\ndescription: ${desc}\n---\n\n${body}\n`;

/**
 * Write the deployment's files under `dir` and return their paths. With `git`, the job folder is made a git
 * repository (the insights page's topology reads a local folder's flow gate from git); the panel never needs it.
 */
export function writeDeployment(dir, { git = false } = {}) {
	const paths = {
		site: join(dir, "work", "site"),
		skills: join(dir, "pi-skills"),
		logs: join(dir, "logs"),
		settings: join(dir, "settings.json"),
		triggers: join(dir, "triggers.json"),
		pause: join(dir, "pause-windows.json"),
		limits: join(dir, "scoped-limits.json"),
		projects: join(dir, "projects.json"),
		subs: join(dir, "subscriptions.json"),
		overlay: join(dir, "pi-global"),
	};
	const files = (root, entries) => {
		for (const [rel, text] of Object.entries(entries)) {
			mkdirSync(join(root, rel, ".."), { recursive: true });
			writeFileSync(join(root, rel), text);
		}
	};
	mkdirSync(paths.logs, { recursive: true });
	files(paths.site, {
		".pi/skills/tidy/SKILL.md": skill("tidy", "Format, fix lint, and tighten types.", "Run the formatter and linter and fix what they report. Then build the report with build-report."),
		".pi/skills/build-report/SKILL.md": skill("build-report", "Build the weekly site report.", "Build the report and check how it renders."),
	});
	files(paths.skills, { "frontend-fix/SKILL.md": skill("frontend-fix", "Fix a frontend issue and screenshot it.", "Reproduce, fix, screenshot.") });
	if (git) gitInit(paths.site, dir);

	const json = (p, v) => writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`);
	json(paths.settings, { model: "claude-sonnet-5-5", provider: "anthropic", maxTurns: 30, concurrency: 4 });
	json(paths.projects, {
		version: 1,
		projects: [
			{ id: "web", members: ["github:acme/web"] },
			{ id: "api", members: ["github:acme/api"] },
			{ id: "billing", members: ["github:acme/billing", "gitlab:acme/billing-ui"] },
			{ id: "ops", members: [paths.site] },
		],
	});
	json(paths.limits, {
		version: 3,
		limits: [
			{ scope: "github:acme/web", concurrent: WEB_AT_ONCE },
			{ scope: "project:billing", memory: "8g", cpus: 4 },
			{ scope: "project:api", memory: "2g", cpus: 1 },
			{ scope: "project:ops", memory: "2g", cpus: 1 },
		],
	});
	// The overlay's one MCP server, which the triage trigger's jobs connect (`run.mcp`): its key is a reference the
	// deployment's PI_FORWARD_ENV fills in, never a value (worker/src/mcp-config.mjs).
	mkdirSync(paths.overlay, { recursive: true });
	json(join(paths.overlay, "mcp.json"), { mcpServers: { linear: { url: "https://mcp.example.com/linear", headers: { Authorization: "Bearer ${LINEAR_API_KEY}" }, description: "Look up and update the team's Linear issues", exposure: "codemode" } } });
	json(paths.subs, { version: 1, subscriptions: [{ id: "kimi", vendor: "Moonshot AI", provider: "kimi-coding", models: ["*"] }] });
	json(paths.pause, { windows: [{ scope: "github:acme/web", from: "22:00", to: "06:00", tz: "Europe/Amsterdam", days: ["mon", "tue", "wed", "thu", "fri"] }] });
	json(paths.triggers, {
		triggers: [
			{ on: { type: "cron", id: "nightly-tidy", pattern: "0 3 * * *" }, run: { kind: "local", folder: paths.site, flow: "tidy", packages: false, task: "run the nightly tidy", provider: "kimi-coding", model: "kimi-for-coding" } },
			{ on: { type: "label", any: ["pi:frontend"] }, run: { kind: "github", flow: "frontend-fix", packages: false, skillsDir: paths.skills, replicas: 2 } },
			// resume: the comment trigger is what continues a parked run (docs/sessions.md, "Parked jobs").
			{ on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "fix", packages: false, resume: true, instructions: "the tests run with pnpm here" } },
			{ on: { type: "pull_request", action: ["open", "update"] }, run: { kind: "gitlab", flow: "review", packages: false } },
			{ on: { type: "issue", action: ["closed"], number: 40, once: true }, run: { kind: "github", flow: "deploy", packages: false } },
			// Triage that may stop and ask (run.awaitInput needs run.resume), with the overlay's Linear server: PARKED's.
			{ on: { type: "label", any: ["pi:triage"] }, run: { kind: "github", flow: "triage", packages: false, resume: true, awaitInput: true, mcp: ["linear"] } },
		],
	});
	return paths;
}

/** A one-commit repository with a fixed author and date, through a git that reads no config of this machine. */
function gitInit(folder, dir) {
	const env = {
		PATH: process.env.PATH ?? "",
		HOME: dir,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: join(dir, "gitconfig-none"),
		GIT_AUTHOR_NAME: "ops",
		GIT_AUTHOR_EMAIL: "ops@example.invalid",
		GIT_COMMITTER_NAME: "ops",
		GIT_COMMITTER_EMAIL: "ops@example.invalid",
		GIT_AUTHOR_DATE: "2026-09-01T10:00:00Z",
		GIT_COMMITTER_DATE: "2026-09-01T10:00:00Z",
	};
	const git = (...a) => execFileSync("git", a, { cwd: folder, env, stdio: "ignore" });
	git("init", "-q", "-b", "main");
	git("add", "-A");
	git("commit", "-q", "-m", "init");
}

// ---- run records -------------------------------------------------------------------------------------------------
// Input, output and cache-read dollars per million tokens, as pi's catalog has them. Haiku 5.5 bills the whole request
// at its second tier once the input passes 100,000 tokens.
const RATES = { "claude-sonnet-5-5": [2, 10, 0.1], "claude-haiku-5-5": [0.1, 0.5, 0.01], "kimi-for-coding": [0.95, 4, 0.19] };
const TIERS = { "claude-haiku-5-5": { above: 100000, rates: [0.5, 2.5, 0.05] } };
/** Each project's size, as its scoped-limits row sets it (web has none, so the default). */
const SIZES = { small: { memMiB: 2048, cpuCenti: 100, source: "project" }, normal: { memMiB: 4096, cpuCenti: 200, source: "default" }, build: { memMiB: 8192, cpuCenti: 400, source: "project" } };
const iso = (ms) => new Date(ms).toISOString();

/** The scoped limit's `concurrent` for github:acme/web (`writeDeployment`): the scheduler below holds the records to it. */
const WEB_AT_ONCE = 6;

/**
 * The jobs of the month, as `{ host, queuedMs, mins, ... }` before any slot is assigned. Fixed shapes per day (the
 * nightly tidy, the replicas of a label, comment fixes, reviews, billing builds), denser in the last seven days, which
 * the HOSTS view and the capacity report read.
 */
function plannedJobs(g, taken) {
	const jobs = [];
	// A job id the month has not used yet: four hex digits collide within a few hundred jobs, and a collision would
	// make one record replace another.
	const uid = (prefix) => {
		for (;;) {
			const id = `${prefix}-${g.hex(4)}`;
			if (!taken.has(id)) return taken.add(id), id;
		}
	};
	const first = Date.UTC(2026, 8, 9);
	for (let d = first; d <= Date.UTC(2026, 9, 8); d += DAY) {
		const date = new Date(d).getUTCDate();
		const recent = d >= NOW - 7 * DAY;
		const tidyAt = d + 3 * H;
		const tidyId = `repeat:nightly-tidy:${tidyAt}`;
		jobs.push({ host: "mini1", id: tidyId, kind: "local", folder: "site", flow: "tidy", queuedMs: tidyAt, mins: g.int(6, 11), model: "kimi-for-coding", provider: "kimi-coding", project: "ops", turns: g.int(8, 13), size: SIZES.small });
		if (date % 4 === 1) jobs.push({ host: "mini1", id: uid("local"), kind: "local", folder: "site", flow: "build-report", queuedMs: tidyAt + 15 * MIN, mins: 4, project: "ops", turns: 9, size: SIZES.small, parent: tidyId });
		const fix = (host, repo, project, number, at, mins, size) => jobs.push({ host, id: uid("gh"), kind: "github", repo, number, flow: "fix", queuedMs: at, mins, project, turns: g.int(6, 14), triggerIndex: 2, triggerType: "comment", size });
		// Comment fixes on the api, through the working day: several a day in the last week, every third day before it.
		const apiFixes = recent ? g.int(3, 5) : date % 3 === 0 ? 1 : 0;
		for (let i = 0; i < apiFixes; i++) fix(i % 2 === 0 ? "mini2" : "mini1", "acme/api", "api", 80 + date * 5 + i, d + (8 + i * 2) * H + g.int(0, 90) * MIN, g.int(15, 45), SIZES.small);
		// Merge request reviews on billing-ui, on mini2.
		const reviews = recent ? g.int(2, 3) : date % 4 === 2 ? 1 : 0;
		for (let i = 0; i < reviews; i++) jobs.push({ host: "mini2", id: uid("gl"), kind: "gitlab", repo: "acme/billing-ui", number: 380 + date * 3 + i, mrType: "merge_request", flow: "review", queuedMs: d + (10 + i * 3) * H + g.int(0, 50) * MIN, mins: g.int(8, 20), project: "billing", turns: 5, scale: 0.7, triggerIndex: 3, triggerType: "pull_request", size: SIZES.build });
		// A label's two replicas, one per host, on the web; in the last week it lands in a burst of web fixes that fills
		// mini1's four slots, so later jobs of the burst wait for one.
		if (recent || date % 5 === 0) {
			const id = uid("gh");
			const n = 400 + date;
			for (const r of [1, 2]) {
				jobs.push({ host: r === 1 ? "mini1" : "mini2", id: `${id}-r${r}`, kind: "github", repo: "acme/web", number: n, flow: "frontend-fix", queuedMs: d + 13 * H + 20 * MIN, mins: g.int(30, 60), project: "web", turns: 10 + r * 2, scale: 1.3, replica: r, replicas: 2, triggerIndex: 1, triggerType: "label", size: SIZES.normal });
			}
		}
		if (recent) {
			for (let i = 0; i < 5; i++) fix("mini1", "acme/web", "web", 430 + date * 7 + i, d + 13 * H + (22 + i * 4) * MIN, g.int(30, 70), SIZES.normal);
			for (let i = 0; i < g.int(2, 3); i++) fix("mini1", "acme/web", "web", 600 + date * 7 + i, d + (8 + i * 3) * H + g.int(0, 60) * MIN, g.int(25, 60), SIZES.normal);
		}
		// Long billing builds on build3, overlapping: four to six a day in the last week, one every other day before it.
		const builds = recent ? g.int(4, 6) : date % 2 === 0 ? 1 : 0;
		for (let i = 0; i < builds; i++) jobs.push({ host: "build3", id: uid("gh"), kind: "github", repo: "acme/billing", number: 200 + date * 7 + i, flow: "fix", queuedMs: d + (6 + i * 2) * H + g.int(0, 45) * MIN, mins: g.int(70, 180), project: "billing", turns: g.int(14, 24), scale: 1.6, triggerIndex: 2, triggerType: "comment", size: SIZES.build });
	}
	return jobs;
}

const isWeb = (j) => j.repo === "acme/web";

/**
 * Whether `j` may hold `[t, end)` beside what is already `placed`, by the rules the worker admits by: its host's slot
 * count, its host budget's memory and CPU (an orphan's hold counts, its slot does not), and the scoped limit's
 * `concurrent` for github:acme/web across the fleet.
 */
function fits(placed, j, t, end) {
	const c = HOSTS[j.host];
	const over = placed.filter((p) => p.startMs < end && p.endMs > t);
	const points = [t, ...over.map((p) => p.startMs).filter((s) => s > t)];
	for (const at of points) {
		const now = over.filter((p) => p.startMs <= at && p.endMs > at);
		const here = now.filter((p) => p.host === j.host);
		if (here.filter((p) => p.slot !== false).length + 1 > c.slots) return false;
		if (c.memMiB !== "off" && here.reduce((s, p) => s + p.size.memMiB, 0) + j.size.memMiB > c.memMiB) return false;
		if (c.cpuCenti !== "off" && here.reduce((s, p) => s + p.size.cpuCenti, 0) + j.size.cpuCenti > c.cpuCenti) return false;
		if (isWeb(j) && now.filter((p) => isWeb(p) && p.slot !== false).length + 1 > WEB_AT_ONCE) return false;
	}
	return true;
}

/**
 * Give each planned job its slot: in queue order, the earliest moment from its queueing on that the admission rules
 * (`fits`) allow it, beside what is `placed` already (the runs now, the retry, the cancelled job and its orphaned
 * container). A job that finds no room waits, which is where the report's waits and its time at the slot limit come
 * from. A job that could not have ended by `NOW` is left out: the month as planned ends with the runs now.
 */
function scheduled(jobs, placed) {
	const out = [];
	const all = [...placed];
	for (const j of [...jobs].sort((a, b) => a.queuedMs - b.queuedMs || (a.id < b.id ? -1 : 1))) {
		const dur = j.mins * MIN;
		const from = j.queuedMs + 2_000;
		const candidates = [from, ...all.map((p) => p.endMs).filter((e) => e > from)].sort((a, b) => a - b);
		const start = candidates.find((t) => fits(all, j, t, t + dur));
		if (start === undefined || start + dur > NOW - MIN) continue;
		const run = { ...j, startMs: start, endMs: start + dur };
		all.push(run);
		out.push(run);
	}
	return out;
}

/** A BullMQ job as the processor holds it, for `buildRecord`: id, data, attempts, and when it was added. */
function bullJob(j) {
	const data = { kind: j.kind, flow: j.flow };
	if (j.kind === "local") data.folder = `/work/${j.folder}`;
	else {
		data.repo = j.repo;
		data.target = { type: j.mrType ?? "issue", number: j.number };
	}
	if (j.parent) Object.assign(data, { parentJobId: j.parent, chainDepth: 1 });
	if (j.replica) Object.assign(data, { replica: j.replica, replicas: j.replicas });
	if (j.triggerType) data.trigger = { matched: { index: j.triggerIndex, type: j.triggerType } };
	return { id: j.id, name: j.kind, data, attemptsMade: (j.attempt ?? 1) - 1, stalledCounter: 0, timestamp: j.queuedMs, opts: { delay: 0 } };
}

/** The triggers whose jobs keep a session (`run.resume`), by their index in `triggers.json`: the comment and the triage. */
const RESUME_TRIGGERS = new Set([2, 5]);

/**
 * A resumable run's `session` as the processor merges it (`mergeSession`): the first run on its issue finds no
 * transcript (`absent`) and, completed, promotes one of `bytes`. Null for a trigger without run.resume.
 */
function sessionOf(j, input, output) {
	return RESUME_TRIGGERS.has(j.triggerIndex) ? { resumed: false, reason: "absent", bytes: Math.round((input + output) * 3.4) } : null;
}

/** The runner's outcome for a completed run: tokens, the usage ledger, dollars and what the container used. */
function outcomeOf(g, j) {
	const model = j.model ?? "claude-sonnet-5-5";
	const provider = j.provider ?? "anthropic";
	const scale = j.scale ?? 1;
	const input = Math.round((30000 + g.next() * 90000) * scale);
	const output = Math.round((3000 + g.next() * 9000) * scale);
	const cacheRead = Math.round(input * 0.6);
	const tier = TIERS[model];
	const [ri, ro, rc] = tier && input > tier.above ? tier.rates : RATES[model];
	const cost = Math.round(input * ri + output * ro + cacheRead * rc) / 1e6;
	const total = input + output + cacheRead;
	const wallUsec = (j.endMs - j.startMs) * 1000;
	const tokens = { input, output, total, metered: true, rootTotal: total, otherTotal: 0, looseTotal: 0, sessions: 1, calls: j.turns, unresolved: 0, usageUnreported: 0, unmeteredChildren: 0, childTotal: 0, childProcesses: 0 };
	const usage = { v: 1, piAi: "0.99.1", truncated: 0, models: [{ provider, model, calls: j.turns, input, output, cacheRead, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, total, cost, unpriced: 0 }] };
	return {
		outcome: "completed",
		reason: null,
		exitCode: 0,
		turns: j.turns,
		tokens,
		usage,
		provider,
		model,
		session: sessionOf(j, input, output),
		budgetReserved: true,
		resources: {
			memPeak: Math.round(j.size.memMiB * (0.35 + g.next() * 0.4)) * 1024 * 1024,
			swapPeak: 0,
			oomKills: 0,
			memSomeUsec: 0,
			memFullUsec: 0,
			cpuUsec: Math.round(wallUsec * (j.size.cpuCenti / 100) * (0.2 + g.next() * 0.45)),
			throttledUsec: 0,
			throttled: 0,
			pidsPeak: g.int(40, 160),
		},
	};
}

/** The retry: attempt 1 lost its container to the runtime, attempt 2 finished it, both on mini1. */
const RETRY = { host: "mini1", id: "gh-7a31", kind: "github", repo: "acme/web", number: 452, flow: "fix", queuedMs: NOW - 2 * DAY - 10 * H, startMs: NOW - 2 * DAY - 10 * H + 4_000, endMs: NOW - 2 * DAY - 9 * H - 20 * MIN, project: "web", turns: 4, size: SIZES.normal, triggerIndex: 2, triggerType: "comment" };
const RETRY_2 = { ...RETRY, attempt: 2, startMs: NOW - 2 * DAY - 9 * H, endMs: NOW - 2 * DAY - 8 * H - 25 * MIN, turns: 9 };
/**
 * The job the operator cancelled on build3 whose container's stop did not take: its record ends at the stop
 * (`operator-cancel`), and its hold stays in build3's budget as an orphan under the same job id until the runtime
 * says the container is gone (host-budget.mjs `orphan`).
 */
const CANCELLED = { host: "build3", id: "gh-4a7e", kind: "github", repo: "acme/billing", number: 290, flow: "fix", queuedMs: NOW - 5 * H - 2 * MIN, startMs: NOW - 5 * H, endMs: NOW - 4 * H - 40 * MIN, project: "billing", turns: 6, scale: 1.6, size: SIZES.build, triggerIndex: 2, triggerType: "comment" };

/**
 * The parked run (REQ-AWAIT-INPUT): the triage trigger's job on an api issue asked its question through the tool and
 * ended, completed with reason `awaiting-input`, its transcript promoted for the reply to resume. The run-detail
 * image shows it.
 */
export const PARKED = { host: "mini1", id: "gh-2f6a", kind: "github", repo: "acme/api", number: 131, flow: "triage", queuedMs: NOW - 47 * MIN, startMs: NOW - 47 * MIN + 3_000, endMs: NOW - 26 * MIN, project: "api", turns: 11, size: SIZES.small, triggerIndex: 5, triggerType: "label" };

/**
 * What the processor returns for the cancelled job (processor.mjs, the aborted branch): the stop did not take, so
 * `boundAfterAbort` (index.mjs) answered for the container with `{ code: 137, aborted: true }` and no exit line, so no
 * turns, tokens, usage or resources are recorded.
 */
function cancelledOutcome() {
	const provider = "anthropic";
	const model = "claude-sonnet-5-5";
	// The trigger keeps sessions, so the host's read stands with no runner line beside it (`mergeSession`): nothing was
	// promoted, so no bytes.
	return { outcome: "policy", reason: "operator-cancel", exitCode: 137, turns: null, tokens: null, provider, model, session: { resumed: false, reason: "absent", bytes: null }, budgetReserved: true };
}

/** What is placed before the month is scheduled: the runs now, the retry's attempts, the cancelled job and its hold, the parked run. */
function placedFirst() {
	const live = Object.entries(RUNNING).flatMap(([host, list]) => list.map((e) => ({ host, id: e.id, repo: e.repo, startMs: e.at, endMs: NOW, size: { memMiB: e.memMiB, cpuCenti: e.cpuCenti } })));
	const orphanHold = { host: CANCELLED.host, id: CANCELLED.id, repo: CANCELLED.repo, startMs: CANCELLED.endMs, endMs: NOW, size: CANCELLED.size, slot: false };
	return [...live, RETRY, RETRY_2, CANCELLED, orphanHold, PARKED];
}

/**
 * Every run record of the month, through `buildRecord`: the scheduled runs, the retry (its second attempt's record,
 * carrying the first in `earlier` the way the processor carries it), the cancelled job and the parked run.
 */
export function buildRecords({ buildRecord, earlierFrom, venue = "local" }) {
	const g = generator(599);
	const taken = new Set(["gh-5d10", "gh-77c1", RETRY.id, CANCELLED.id, PARKED.id, ...Object.values(RUNNING).flat().map((e) => e.id)]);
	const runs = scheduled(plannedJobs(g, taken), placedFirst());
	const record = (j, result, { earlier = null } = {}) => buildRecord({ job: bullJob(j), result, startedAt: iso(j.startMs), endedAt: iso(j.endMs), host: j.host, defaultBackend: venue, project: j.project, size: j.size, capacity: HOSTS[j.host], earlier });
	const records = runs.map((j) => record(j, outcomeOf(g, j)));
	// An infrastructure exit promotes nothing, so its session is the cold read alone.
	const failed = record(RETRY, { ...outcomeOf(g, RETRY), outcome: "failed", reason: "container-lost", exitCode: null, session: { resumed: false, reason: "absent", bytes: null } });
	records.push(record(RETRY_2, outcomeOf(g, RETRY_2), { earlier: earlierFrom(failed) }));
	records.push(record(CANCELLED, cancelledOutcome()));
	// Last, so the generator's sequence for every run before it is what it was before the parked run existed.
	records.push(record(PARKED, { ...outcomeOf(g, PARKED), reason: "awaiting-input" }));
	return records;
}

// ---- the live fleet --------------------------------------------------------------------------------------------
/** The jobs each host runs at `NOW` (the in-flight map's entries), and the orphaned hold of build3's cancelled job. */
export const RUNNING = {
	mini1: [
		{ id: "gh-b3d7", project: "web", repo: "acme/web", memMiB: 4096, cpuCenti: 200, at: NOW - 12 * MIN },
		{ id: "gh-c41f", project: "api", memMiB: 2048, cpuCenti: 100, at: NOW - 41 * MIN },
	],
	mini2: [{ id: "local-9e20", project: "ops", memMiB: 2048, cpuCenti: 100, at: NOW - 6 * MIN }],
	build3: [{ id: "gh-e802", project: "billing", memMiB: 8192, cpuCenti: 400, at: NOW - 80 * MIN }],
};
const ORPHANS = { build3: [{ id: CANCELLED.id, project: CANCELLED.project, memMiB: CANCELLED.size.memMiB, cpuCenti: CANCELLED.size.cpuCenti, at: CANCELLED.startMs, orphan: true }] };

/**
 * What each host blesses (issue #712), as `start.mjs` publishes it through `hostBackendsField`: mini1 runs `local` alone,
 * mini2 `local` and OpenShell's copy venue on its own gateway, build3 rootless `podman` under a floor.
 */
const VENUES = {
	mini1: { backends: ["local"] },
	mini2: { backends: ["local", "openshell"], openshellEngine: "docker", gatewayWord: "local" },
	build3: { backends: ["podman"], backendFloor: { egress: "enforced" } },
};

/** Each host's registry fields, as `start.mjs` publishes them; build3's last beat is 150 s old (a stale row). */
export function hostRows({ liveJobsOf, liveJobsFields, version, hostBackendsField = null }) {
	return Object.entries(HOSTS).map(([name, c]) => {
		const running = RUNNING[name] ?? [];
		const orphans = ORPHANS[name] ?? [];
		const held = [...running, ...orphans];
		const sum = (k) => String(held.reduce((s, e) => s + e[k], 0));
		const budget = c.memMiB !== "off";
		const live = liveJobsFields(liveJobsOf({ running, budgetEntries: orphans }));
		return {
			name,
			beatAt: name === "build3" ? NOW - 150_000 : NOW - 4_000,
			fields: {
				version,
				concurrency: String(c.slots),
				routes: "true",
				caps: "",
				tz: "UTC",
				budgetMemMiB: String(c.memMiB),
				budgetCpuCenti: String(c.cpuCenti),
				usedMemMiB: budget ? sum("memMiB") : "",
				usedCpuCenti: budget ? sum("cpuCenti") : "",
				budgetRunning: budget ? String(running.length) : "",
				waiters: budget ? "0" : "",
				jobs: live.jobs,
				jobsMore: live.jobsMore,
				// A caller without the writer (one from before #712) publishes no `backends`, as an older worker would.
				...(hostBackendsField ? { backends: hostBackendsField(VENUES[name]) } : {}),
			},
		};
	});
}

/**
 * The doctor runs two hosts published (issue #712), as doctor's checks: mini1 an hour ago with one warning, build3 three
 * days ago (past two of its daily intervals, so stale) with a failure whose label names a path the record must cut.
 */
export function doctorRuns(version) {
	const ok = (n) => Array.from({ length: n }, (_, i) => ({ ok: true, label: `fine ${i}` }));
	const mini1 = [...ok(41), { ok: false, warn: true, label: "this host's worker admits NO job on the podman venue: it could not list the job containers left from before it started there", fix: "make the runtime answer for the worker's account (`podman ps -a`)" }];
	const build3 = [...ok(38), { ok: false, label: "Docker daemon unreachable at /var/run/docker.sock", fix: "start Docker, then re-run doctor" }, { ok: false, warn: true, label: "PI_CONCURRENCY=6 is above this host's slot budget", fix: "lower PI_CONCURRENCY or raise the budget" }];
	const ids = (checks, section) => checks.map((c, i) => (c.ok ? `node.${i + 1}` : `${section}.${i + 1}`));
	return [
		{ name: "mini1", record: { checks: mini1, ids: ids(mini1, "fleet"), at: NOW - 60 * MIN, version, every: 24, by: { uid: 1001, worker: true } } },
		{ name: "build3", record: { checks: build3, ids: ids(build3, "docker"), at: NOW - 3 * DAY, version, every: 24, by: { uid: 1001, worker: true } } },
	];
}

// ---- Valkey -------------------------------------------------------------------------------------------------------
/**
 * Seed the Valkey at `url` and write the run records under `paths.logs`. `mods` are the project's modules, imported
 * by the caller after it froze the clock and emptied the environment.
 */
/**
 * `venue` (issue #712): the venue the records name, `local` by default, so the README's panel images and the console's
 * golden pages show a normal local run (the sandbox command, the plain absent sentences). It was `"docker"`, which is no
 * venue the backend table holds, while that kept the images byte-stable; the Venues view regenerated them on purpose,
 * and a run list naming an unknown venue on every row would have drawn a venue column the README has no use for.
 */
export async function seedDeployment({ url, paths, mods, venue = "local" }) {
	const W = mods.W;
	const redis = W.connection.makeRedisClient(url);
	try {
		const records = buildRecords({ buildRecord: W.runHistory.buildRecord, earlierFrom: W.runHistory.earlierFrom, venue });
		records.sort((a, b) => Date.parse(a.endedAt) - Date.parse(b.endedAt) || (a.jobId < b.jobId ? -1 : 1));
		// mini1 and mini2 share one PI_LOGS_DIR (this one) and keep 30 days; build3 keeps its own logs directory for 7
		// days (BUILD3_RETENTION_DAYS), so its runs reach the others only through the run mirror every named worker
		// writes. Each writer trims the mirror by its own retention, and a trim that removes a run raises the fleet horizon
		// (`runs:horizon`) to its age cutoff, that write's time less the writer's window (run-mirror.mjs `TRIM_SCRIPT`).
		// So build3's history here starts at the cutoff of its last trim that removed a run, 7 days before that write,
		// which the insights page hatches as no data before it; mini1 and mini2 keep their month in the shared files.
		// Written as time wrote them: the two minis' runs first, then build3's.
		const write = W.runHistory.makeRecordWriter({ logsDir: paths.logs });
		// Each write trims as of the moment the record was written (its end), as a worker's mirror does, not as of the
		// render's instant.
		let writing = NOW;
		const mirrors = Object.fromEntries(Object.keys(HOSTS).map((h) => [h, W.runMirror.makeRunMirror({ redis, retentionDays: h === "build3" ? BUILD3_RETENTION_DAYS : 30, now: () => writing })]));
		for (const r of [...records.filter((x) => x.host !== "build3"), ...records.filter((x) => x.host === "build3")]) {
			if (r.host !== "build3") write(r);
			writing = Date.parse(r.endedAt);
			if (!(await mirrors[r.host].mirror(r, W.runHistory.sanitizeJobId(r.jobId)))) throw new Error(`the mirror refused ${r.jobId}`);
		}
		writing = NOW;

		// The registry: one beat per host through the worker's writer, at that host's own last-beat instant.
		for (const row of hostRows({ liveJobsOf: W.liveJobs.liveJobsOf, liveJobsFields: W.liveJobs.liveJobsFields, version: mods.version, hostBackendsField: W.backends?.hostBackendsField ?? null })) {
			const reg = W.hostRegistry.makeHostRegistry({ redis, name: row.name, now: () => row.beatAt });
			// One beat, and an interval that never fires during a render (it is unref'd, so it holds nothing open).
			await reg.start(row.fields, { intervalMs: 2 ** 31 - 1 });
		}

		// The job held on run.waitFor, as the wait gate writes it.
		const wait = W.waitState.makeWaitState({ redis, now: () => NOW - (2 * 3600 + 14 * 60) * 1000 });
		await wait.hold("gh-77c1", { dedupId: "github:acme/web#415", target: "acme/web#415", label: "after 2026-10-09T07:00Z + ci-green", untilMs: Date.UTC(2026, 9, 9, 7) });

		// Issue #712: the hosts' published doctor runs, through doctor's own record builder and writer, where the caller
		// handed that module (an older caller did not, and seeds none). mini2 has published nothing.
		if (W.doctorResults) {
			for (const run of doctorRuns(mods.version)) await W.doctorResults.publishDoctorRecord(redis, run.name, W.doctorResults.buildDoctorRecord(run.record));
		}

		// The cron schedulers, through BullMQ itself (their next fires are the queue's delayed jobs).
		const q = W.queue.makeQueue(W.connection.parseConnection(url));
		try {
			await q.upsertJobScheduler("nightly-tidy", { pattern: "0 3 * * *" }, { name: "nightly-tidy", data: {} });
		} finally {
			await q.close();
		}
		return { records };
	} finally {
		redis.disconnect();
	}
}
