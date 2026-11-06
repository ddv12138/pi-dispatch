#!/usr/bin/env node
/**
 * Render the console images from the shipped code over one canned deployment (`launch/fixture-deployment.mjs`).
 *
 *   node launch/render-images.mjs           docs/images/insights-view.png: the console's Spend page, drawn by the
 *                                           console's own page code (`insightsPage`) over a seeded fixture
 *
 *   node launch/render-images.mjs --console          docs/images/console/: the operator console images the READMEs show
 *                                                    (`launch/console-picks.mjs`)
 *   node launch/render-images.mjs --console --all    docs/images/console/all/: every golden, page and panel, at 1440 and
 *                                                    375, light and dark, as each is drawn (viewer, operator, signed out).
 *                                                    Not committed: about 2,000 images would weigh down every clone for good
 *   node launch/render-images.mjs --console --only <golden>   the same, for one golden, as `run-live.operator` or
 *                                                    `panels/confirm-done.operator`
 *
 *   --out <dir>   write there instead of docs/images (or docs/images/console with --console)
 *   --url <url>   use this Valkey instead of starting one; its database must be empty, and is emptied again at the end
 *
 * `--console` reads the committed goldens (`launch/console-render.mjs`), so it needs Chrome and no server at all.
 *
 * WHAT RUNS. Without `--console`: a temporary `valkey-server` (or `redis-server`, whichever is on PATH) on a free port
 * of 127.0.0.1, with no persistence and its files in a temporary directory, removed with everything else when the
 * script ends. The fixture writes the deployment's files there and seeds the server through the worker's own writers.
 * The Spend page is then drawn by the console's own page code (`loadPageData`, `renderPage` over the real
 * `assembleInsights` and pricing), written as one HTML file whose stylesheet and script are inlined, and shot in
 * headless Chrome at 1240 px and device scale 2, full page. So the seeded render needs the server and Chrome both;
 * `--console` reads the committed goldens (`launch/console-render.mjs`) and needs Chrome and no server at all.
 *
 * NO NETWORK, NO SPEND, NOTHING OF THIS MACHINE. The environment is emptied before any project module loads, so no forge
 * or provider key, no deployment pointer and no home directory of the operator is read; every child process (the
 * server, git, Chrome) gets an environment of its own; nothing is fetched (no npx, no registry, no CDN), and Chrome's
 * host resolver maps every name to nothing. Every id is synthetic.
 *
 * DETERMINISTIC. `Date` is frozen at the fixture's instant for every reader, and the time zone is UTC, so two runs
 * seed the same deployment. The PNG is Chrome's rendering and is not held to bytes.
 */
import { spawn } from "node:child_process";
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { frozenDateSource, openChrome as openChromePipe } from "./chrome-pipe.mjs";
import { findOnPath } from "./server-binary.mjs";
import { NOW, LOCAL_HOST, seedDeployment, writeDeployment } from "./fixture-deployment.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const MAC_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
/** The longest any one DevTools step (a call, or the page's load) may take before the run fails. */
const CDP_STEP_MS = 30_000;
/** The longest the first command to a `--url` Valkey may take before the run fails. */
const URL_CONNECT_MS = 3_000;

// ---- arguments and the machine's two binaries, read BEFORE the environment is emptied ------------------------------
const USAGE = `usage: node launch/render-images.mjs [--console [--all | --only <golden>]] [--out <dir>] [--url <redis://host:port/db>]
  the default render writes docs/images/insights-view.png, the console's Spend page drawn over a seeded
  fixture (needs a valkey-server or redis-server on PATH, or --url, and Google Chrome; set CHROME to its
  executable where it is not ${MAC_CHROME})
  --console  the operator console's images, from the committed goldens (needs Google Chrome, no server):
           the READMEs' picks into docs/images/console, or with --all every golden at 1440 and 375, light and
           dark, into docs/images/console/all, or with --only <golden> that one golden there
  --out    the directory to write to (default docs/images, docs/images/console with --console)
  --url    an existing, empty Valkey database to seed instead of starting valkey-server or redis-server
           from PATH; it is emptied again at the end`;

/** The options, or `{ help }`, or `{ error }` (a sentence for the operator, never a stack). */
function parseArgs(argv) {
	const opts = { console: false, all: false, only: null, out: null, url: null };
	// A value is the next argument unless that is missing or is itself a flag, so `--out --url` is an error rather
	// than a directory named --url.
	const value = (i, flag) => {
		const v = argv[i + 1];
		if (v === undefined || v === "" || v.startsWith("--")) return { error: `${flag} takes a value` };
		return { v };
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--help" || a === "-h") return { help: true };
		if (a === "--console") opts.console = true;
		else if (a === "--all") opts.all = true;
		else if (a === "--out" || a === "--url" || a === "--only") {
			const got = value(i, a);
			if (got.error) return got;
			opts[a.slice(2)] = got.v;
			i++;
		} else return { error: `unexpected argument: ${a}` };
	}
	if (opts.url !== null && !/^rediss?:\/\/[^/\s]/.test(opts.url)) return { error: "--url takes a redis:// or rediss:// URL" };
	if ((opts.all || opts.only !== null) && !opts.console) return { error: "--all and --only go with --console" };
	if (opts.all && opts.only !== null) return { error: "--all and --only are two different lists; pick one" };
	if (opts.console && opts.url !== null) return { error: "--console takes no --url: it reads the committed goldens" };
	if (opts.out === null) opts.out = opts.console ? join(REPO, "docs", "images", "console", ...(opts.all || opts.only !== null ? ["all"] : [])) : join(REPO, "docs", "images");
	return opts;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
	console.log(USAGE);
	process.exit(0);
}
if (opts.error) {
	console.error(`render-images: ${opts.error}\n${USAGE}`);
	process.exit(2);
}
const serverBin = opts.url || opts.console ? null : findOnPath(["valkey-server", "redis-server"]);
if (!opts.url && !opts.console && !serverBin) {
	console.error("render-images: needs valkey-server or redis-server on PATH (brew install valkey, apt install valkey-server), or --url to an empty database");
	process.exit(2);
}// The output directory, made (or found) before anything starts, so a path that cannot be one is a refusal, not a stack.
try {
	mkdirSync(opts.out, { recursive: true });
	accessSync(opts.out, constants.W_OK);
} catch (err) {
	console.error(`render-images: --out ${opts.out} is not a directory this account can write (${err?.code ?? err?.message ?? err})`);
	process.exit(2);
}
const chrome = process.env.CHROME || MAC_CHROME;
const gitPath = process.env.PATH ?? "";
if (opts.console || opts.url === null) {
	try {
		accessSync(chrome, constants.X_OK);
	} catch {
		console.error(`render-images: needs Google Chrome (looked for ${chrome}; set CHROME to its executable)`);
		process.exit(2);
	}
}

// One temporary directory for the whole run: the deployment, the server's files, Chrome's profile and temp files.
const work = mkdtempSync(join(tmpdir(), "pi-dispatch-images-"));
/** The child processes still running (the server, Chrome), killed by `cleanup` whatever ends the run. */
const children = new Set();
/** The browser once the seeded render has opened it: `cleanup` removes the singleton directory Chrome leaves on macOS through it. */
let browserPipe = null;
let cleaned = false;
const cleanup = () => {
	if (cleaned) return;
	cleaned = true;
	for (const child of children) {
		try {
			child.kill("SIGKILL");
		} catch {
			// already gone
		}
	}
	browserPipe?.removeSingleton();
	rmSync(work, { recursive: true, force: true });
};
process.on("exit", cleanup);
// An interrupt leaves no server and no directory behind: 128 plus the signal's number, as a shell reports it.
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
	process.on(signal, () => {
		console.error(`render-images: ${signal}, stopping`);
		cleanup();
		process.exit(code);
	});
}
/** A failure the operator can act on (a missing binary, a database that is not usable): one line, exit 2. */
class Refusal extends Error {}

// THE ENVIRONMENT, EMPTIED. What the project's modules read from it from here on is the fixture's deployment alone.
for (const k of Object.keys(process.env)) delete process.env[k];
Object.assign(process.env, { TZ: "UTC", HOME: join(work, "home"), PI_CODING_AGENT_DIR: join(work, "agent") });
mkdirSync(process.env.HOME, { recursive: true });
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });

// THE CLOCK, FROZEN, before any project module loads: every reader of `Date` sees the fixture's instant.
const RealDate = Date;
class FrozenDate extends RealDate {
	constructor(...a) {
		if (a.length === 0) super(NOW);
		else super(...a);
	}
	static now() {
		return NOW;
	}
}
globalThis.Date = FrozenDate;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- the server ----------------------------------------------------------------------------------------------------
async function freePort() {
	const srv = createServer();
	await new Promise((resolve, reject) => srv.once("error", reject).listen(0, "127.0.0.1", resolve));
	const { port } = srv.address();
	await new Promise((resolve) => srv.close(resolve));
	return port;
}

function ping(port) {
	return new Promise((resolve) => {
		const sock = connect({ host: "127.0.0.1", port }, () => sock.write("PING\r\n"));
		sock.setTimeout(500, () => (sock.destroy(), resolve(false)));
		sock.once("error", () => resolve(false));
		sock.once("data", (d) => (sock.destroy(), resolve(String(d).startsWith("+PONG"))));
	});
}

async function startServer(bin) {
	const dir = join(work, "server");
	mkdirSync(dir);
	const port = await freePort();
	const child = spawn(bin, ["--port", String(port), "--bind", "127.0.0.1", "--save", "", "--appendonly", "no", "--dir", dir], { env: {}, stdio: ["ignore", "ignore", "pipe"] });
	children.add(child);
	child.once("exit", () => children.delete(child));
	let stderr = "";
	child.stderr.on("data", (d) => (stderr += d));
	const exited = new Promise((resolve) => child.once("exit", resolve));
	for (let i = 0; i < 200; i++) {
		if (child.exitCode !== null) throw new Error(`${bin} exited (${child.exitCode}): ${stderr.trim()}`);
		if (await ping(port)) {
			return {
				url: `redis://127.0.0.1:${port}`,
				async stop() {
					child.kill("SIGTERM");
					await Promise.race([exited, sleep(5000)]);
				},
			};
		}
		await sleep(50);
	}
	child.kill("SIGKILL");
	throw new Error(`${bin} did not answer on 127.0.0.1:${port}`);
}

// ---- Chrome, over its DevTools pipe ------------------------------------------------------------------------------
/**
 * A headless Chrome over its DevTools pipe (`launch/chrome-pipe.mjs`, shared with the console's width check), with its
 * profile and temp files in this run's directory, killed by `cleanup` with the other children.
 */
async function openChrome() {
	const pipe = await openChromePipe({ chrome, work, children, Refusal, stepMs: CDP_STEP_MS, env: { HOME: process.env.HOME } });
	browserPipe = pipe;
	return {
		/**
		 * Load `url` in a `width` px viewport at `scale`, with the page's clock fixed at `clockMs` when given, and write a
		 * PNG of `height` px, or of the whole page.
		 */
		async shoot({ url, out, width, height = 900, scale, fullPage = false, clockMs = null }) {
			const { sessionId, send: s, close } = await pipe.openTarget();
			await s("Page.enable");
			const metrics = (h) => s("Emulation.setDeviceMetricsOverride", { width, height: h, deviceScaleFactor: scale, mobile: false });
			await metrics(height);
			if (clockMs !== null) {
				// The page's "generated N ago" reads the BROWSER's clock: fixed one minute after the page was generated.
				await s("Page.addScriptToEvaluateOnNewDocument", { source: frozenDateSource(clockMs) });
			}
			const loaded = pipe.event((m) => m.method === "Page.loadEventFired" && m.sessionId === sessionId, "load event");
			await s("Page.navigate", { url });
			await loaded;
			await sleep(500); // fonts and the charts' first layout
			let h = height;
			if (fullPage) {
				const m = await s("Page.getLayoutMetrics");
				h = Math.ceil(m.cssContentSize.height);
				await metrics(h);
				await sleep(200);
			}
			const { data } = await s("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: h, scale: 1 } });
			writeFileSync(out, Buffer.from(data, "base64"));
			await close();
		},
		close: () => pipe.close(),
	};
}

/**
 * The operator console's spend screen (`/insights?range=30d`), as `pi-dispatch-console serve` renders it for an
 * operator: the console's own page code (`loadPageData`, `renderPage`) over the real `assembleInsights` and pricing.
 * The page links its stylesheet and script by URL (the console serves them; its CSP refuses inline ones); for a file
 * Chrome opens they are written in, the stylesheet in the head and the script at the end of the body, unchanged.
 */
async function insightsPage({ env, RM }) {
	const pages = await import("../admin/src/console/pages.mjs");
	const { assembleInsights } = await import("../admin/src/insights-assembly.mjs");
	const { CONSOLE_CSS } = await import("../admin/src/console/style.mjs");
	const { CONSOLE_SCRIPT } = await import("../admin/src/console/script.mjs");
	const { pricedModelIds } = await import("../admin/src/console/whatif.mjs");
	const pricing = await import("../worker/src/pricing.mjs");
	const paths = RM.resolvePaths(env);
	const parsed = pages.parsePageQuery("insights", "range=30d");
	const deps = { insights: (window, o) => assembleInsights(paths, window, { pricing, nowMs: NOW, envFn: () => env, ...(o?.fullPaths ? { fullPaths: true } : {}) }), pricedModels: () => pricedModelIds(pricing), env, now: () => NOW };
	const session = { name: "ops", role: "operator" };
	const data = await pages.loadPageData("insights", parsed.query, deps, session);
	const { html } = await pages.renderPage("insights", { query: parsed.query, session, data, readOnly: false });
	const link = '<link rel="stylesheet" href="/static/console.css">';
	const script = '<script src="/static/console.js" defer></script>';
	const page = String(html);
	if (!page.includes(link) || !page.includes(script) || !page.includes("</body>")) throw new Error("the console page no longer links its stylesheet and script as expected");
	return page.replace(link, `<style>${CONSOLE_CSS}</style>`).replace(script, "").replace("</body>", `<script>${CONSOLE_SCRIPT}</script>\n</body>`);
}

// ---- main ---------------------------------------------------------------------------------------------------------
/** `--console`: the goldens in a browser, no server and no fixture deployment (`launch/console-render.mjs`). */
async function mainConsole() {
	const { goldenKey, matrixOf, picksPlan, renderConsole } = await import("./console-render.mjs");
	const widthCheck = await import("../.github/scripts/console-width-check.mjs");
	const keys = [widthCheck.readGoldens(widthCheck.FIXTURES, ""), widthCheck.readGoldens(join(widthCheck.FIXTURES, "panels"), "panels/")].flatMap((read) => read.docs.map(goldenKey));
	if (opts.only !== null && !keys.includes(opts.only)) throw new Refusal(`--only ${opts.only}: no such golden (a page as run-live.operator, a panel as panels/confirm-done.operator)`);
	const shots = opts.all ? matrixOf(keys) : opts.only !== null ? matrixOf([opts.only]) : picksPlan();
	const written = await renderConsole({ chrome, shots, out: opts.out, work, children, Refusal, widthCheck, clockMs: NOW + 60_000, log: (line) => { if (opts.all) console.error(line); } });
	for (const file of written) console.log(file);
}

async function main() {
	if (opts.console) return mainConsole();
	const W = {
		connection: await import("../worker/src/connection.mjs"),
		queue: await import("../worker/src/queue.mjs"),
		runHistory: await import("../worker/src/run-history.mjs"),
		runMirror: await import("../worker/src/run-mirror.mjs"),
		hostRegistry: await import("../worker/src/host-registry.mjs"),
		liveJobs: await import("../worker/src/live-jobs.mjs"),
		backends: await import("../worker/src/backends.mjs"),
		budget: await import("../worker/src/budget.mjs"),
		scopedLimits: await import("../worker/src/scoped-limits.mjs"),
		allocation: await import("../worker/src/allocation.mjs"),
		waitState: await import("../worker/src/wait-state.mjs"),
		tokenBudget: await import("../worker/src/token-budget.mjs"),
		// Issue #712: the hosts' published doctor runs, which the fixture's hosts rows hold.
		doctorResults: await import("../worker/src/doctor-results.mjs"),
	};
	const RM = await import("../admin/src/read-model.mjs");
	const DW = await import("../admin/src/dollar-windows.mjs");
	const version = JSON.parse(readFileSync(join(REPO, "worker", "package.json"), "utf8")).version;

	const server = opts.url ? null : await startServer(serverBin);
	const url = opts.url ?? server.url;
	let admin;
	try {
		W.connection.parseConnection(url, { failFast: true });
		admin = W.connection.makeRedisClient(url);
	} catch (err) {
		throw new Refusal(`--url is not a usable Valkey URL (${err?.message ?? err})`);
	}
	admin.on?.("error", () => {});
	// Set once the database is known to have been empty, so a refused --url is never emptied.
	let seeded = false;
	try {
		// Bounded: this client queues a command while it cannot connect rather than failing it, so a dead --url would
		// otherwise wait forever.
		let timer;
		const size = await Promise.race([admin.dbsize(), new Promise((_, reject) => (timer = setTimeout(() => reject(new Refusal(`no answer from ${opts.url ? "--url" : "the server"} within ${URL_CONNECT_MS / 1000} s`)), URL_CONNECT_MS)))]).finally(() => clearTimeout(timer));
		if (size !== 0) throw new Refusal(`the database at --url holds ${size} keys: the fixture needs an empty one`);
		seeded = true;
		process.env.PATH = gitPath; // only git reads it (the fixture topology's two repositories), and only while they are made
		const deployment = join(work, "deployment");
		const paths = writeDeployment(deployment, { git: true });
		delete process.env.PATH;
		const env = {
			VALKEY_URL: url,
			PI_WORKER_NAME: LOCAL_HOST,
			PI_LOG_RETENTION_DAYS: "30",
			PI_LOGS_DIR: paths.logs,
			PI_SETTINGS_FILE: paths.settings,
			PI_TRIGGERS_FILE: paths.triggers,
			PI_PAUSE_WINDOWS_FILE: paths.pause,
			PI_SCOPED_LIMITS_FILE: paths.limits,
			PI_PROJECTS_FILE: paths.projects,
			PI_ENVELOPE_FILE: paths.envelope,
			PI_SUBSCRIPTIONS_FILE: paths.subs,
			PI_GLOBAL_PI_DIR: paths.overlay,
		};
		Object.assign(process.env, env);
		await seedDeployment({ url, paths, mods: { W, RM, DW, version } });

		const html = await insightsPage({ env, RM });
		const page = join(work, "insights-page.html");
		writeFileSync(page, html);
		const browser = await openChrome();
		try {
			await browser.shoot({ url: pathToFileURL(page).href, out: join(opts.out, "insights-view.png"), width: 1240, scale: 2, fullPage: true, clockMs: NOW + 60_000 });
		} finally {
			await browser.close();
		}
		console.log(join(opts.out, "insights-view.png"));
	} finally {
		if (opts.url && seeded) await admin.flushdb().catch(() => {});
		admin.disconnect();
		await server?.stop();
	}
}

try {
	await main();
	cleanup();
	process.exit(0);
} catch (err) {
	console.error(`render-images: ${err instanceof Refusal ? err.message : (err?.stack ?? err)}`);
	cleanup();
	process.exit(err instanceof Refusal ? 2 : 1);
}
