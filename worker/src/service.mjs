/**
 * `pi-dispatch service` — render and install the deploy/ daemon templates for THIS host (issue #80).
 *
 * Durable running used to mean hand-editing the per-OS examples in deploy/. This module reads those
 * SAME files from the package and substitutes a documented table of their known literals —
 * `/usr/bin/node` → `process.execPath`, `/opt/pi-dispatch` → the deployment folder — rather than
 * introducing a `{{placeholder}}` dialect. That keeps the deploy/ files byte-usable examples (and
 * deploy-lint keeps parsing exactly what ships); TEMPLATE_PINS below is the table's enforcement — the
 * test suite asserts every literal is still present in every template, so template drift breaks the
 * build loudly instead of breaking the render silently.
 *
 * Path doctrine (issue #96): this module used to derive a REPO_ROOT from its own location ("../..").
 * Right in a checkout; WRONG under `npm install`, where src/ lives at
 * node_modules/@edgehero/pi-dispatch/src and "../.." is the @edgehero SCOPE directory — every rendered
 * unit pointed at files that do not exist. Three anchors replace it, each correct in BOTH layouts:
 *   - deployDir     the deployment folder = the cwd `service` is invoked from. Owns everything
 *                   host-side: WorkingDirectory, EnvironmentFile (<deployDir>/.env) and the daemon
 *                   logs (<deployDir>/logs/, created at install time) — never the package dir, which
 *                   npm may replace wholesale on update.
 *   - cliPath       join(moduleDir, "cli.mjs"): cli.mjs sits beside this module in src/ in both
 *                   layouts, so the worker ExecStart needs no repo root at all.
 *   - receiverStart import.meta.resolve("@edgehero/pi-dispatch-receiver/start"): the receiver
 *                   package's own exported entry, wherever npm (or the workspace symlink) put it.
 *                   null when the package is not installed — receiver renders refuse loudly instead
 *                   of writing a unit that would crash-loop at boot.
 *   - consoleEntry  the admin package's bin, dist/console.mjs (issue #708, resolveConsoleEntry): the
 *                   same resolution, else the `pi-dispatch-console` a global install put on PATH. null
 *                   refuses the console renders, for the receiver's reason.
 *
 * Scope doctrine:
 *   - User-level by default, everywhere. macOS REFUSES root outright (a LaunchAgent is per-user, and a
 *     root agent could not see the login session's Docker Desktop anyway — the svc.sh precedent).
 *     Linux `--system` never executes a privileged write: it stages the render and PRINTS the exact
 *     sudo commands (the pm2-startup pattern), so root actions only ever happen in the operator's own
 *     shell.
 *   - ONE worker per docker daemon (DES-CONCURRENCY-3): install refuses a worker unit when one exists
 *     in the OTHER scope, because the worker's boot reaper kills every pi-job container it did not
 *     start — a second worker would reap the first's live jobs on every restart. Receivers are exempt
 *     from the cross-scope check (a second receiver is pointless, not destructive) but still refuse
 *     same-scope duplicates.
 *
 * `restart --drain` composes the README's manual ritual (pause → poll active → restart → resume) with
 * the same VALKEY_URL-only queue connection as cli.mjs's pause/resume: the drain must work even when
 * the rest of the config is broken.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { accessSync, constants as fsConstants, existsSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ENV_WRITER_FS } from "./env-file.mjs";
import { operatorCount, readTokensFile, tokensFilePath } from "./console-tokens.mjs";
import { resolveSetupWorkerEntry, setupCachePath } from "./setup-host-entry.mjs";
import { deploymentServiceEnv } from "./service-env.mjs";
import * as nodeFs from "node:fs";
import { describeRollBack, journalWrite, managerEnvRefusal, rollBackWrites, userBusRefusal } from "./stack.mjs";

/** This command's default fs seam: its own calls, and every call the `.env` writer makes (`ENV_WRITER_FS`, issue #522). */
export const SERVICE_FS = { existsSync, mkdirSync, ...ENV_WRITER_FS };

// src/ is where this module lives in BOTH layouts (worker/src in a checkout,
// node_modules/@edgehero/pi-dispatch/src under npm). Deploy templates resolve one level up from it
// (the init.mjs pattern): worker/deploy is SHIPPED in the npm tarball and kept byte-identical to the
// repo-root deploy/ (the documented source) by worker/test/publish.test.mjs — so `service` renders
// the same templates from a checkout and from an npm install, no matter where the CLI is invoked from.
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * The receiver's entry point comes from the receiver PACKAGE (its ./start export), wherever module
 * resolution finds it from here — the workspace symlink in a checkout, the sibling install under the
 * deployment folder's node_modules in production. Never a path guessed off this module: that guess is
 * exactly what issue #96 is about. null = not installed, and the receiver renders refuse on it.
 */
function resolveReceiverStart() {
	try {
		return fileURLToPath(import.meta.resolve("@edgehero/pi-dispatch-receiver/start"));
	} catch {
		return null;
	}
}

/** The admin package, whose bin is the console (`pi-dispatch-console` -> ./dist/console.mjs, in its published `files`). */
export const CONSOLE_PACKAGE = "@edgehero/pi-dispatch-admin";

/**
 * The console's entry point (issue #708): the admin package's dist/console.mjs as module resolution finds it from here,
 * else the real path of the `pi-dispatch-console` on this shell's PATH. null when neither exists.
 *
 * Two lookups because the admin package is NOT a dependency of this one: it is a pi extension an operator installs
 * with `pi install` or `npm i -g`. Resolution from here finds it when it sits in the same node_modules tree as this
 * worker (both global, or both in the deployment folder); the PATH lookup covers the rest. The package has no
 * `exports` map, so the subpath resolves as a plain file, and `import.meta.resolve` does not check that the file
 * exists (measured on node 23.5: a checkout without `node admin/build.mjs` resolves to a dist/ that is not there),
 * hence the existence check.
 *
 * The PATH hit is accepted only when its real path IS the package's file: it ends in dist/console.mjs and the
 * package.json two levels up names this package (round 1 review of #708). npm's bin is a symlink to exactly that file,
 * but pnpm and Volta put a SHIM on PATH (a shell script, or a binary that picks a version at run time), and a unit that
 * ran `node <shim>` would crash at every start. The real path, not the PATH name, because a service manager's PATH is
 * not this shell's and launchd's cannot see an nvm or Homebrew prefix at all. `findOnPath` reads only absolute POSIX
 * directories, so on Windows this lookup does not run and resolution is the only way (`refuseMissingConsole` says so).
 */
export function resolveConsoleEntry({ findBin, realpath, exists = existsSync, readFile = (p) => readFileSync(p, "utf8"), resolveModule = (specifier) => import.meta.resolve(specifier) }) {
	try {
		const resolved = fileURLToPath(resolveModule(`${CONSOLE_PACKAGE}/dist/console.mjs`));
		if (exists(resolved)) return resolved;
	} catch {}
	const found = findBin("pi-dispatch-console");
	if (!found) return null;
	try {
		const real = realpath(found);
		const dist = dirname(real);
		if (basename(real) !== "console.mjs" || basename(dist) !== "dist") return null;
		const pkg = JSON.parse(readFile(join(dirname(dist), "package.json")));
		return pkg?.name === CONSOLE_PACKAGE ? real : null;
	} catch {
		return null;
	}
}

/**
 * The console tokens file the SERVICE's console reads for the deployment in `deployDir` (issue #708): PI_CONSOLE_TOKENS_FILE
 * from the deployment `.env` (through the reader the console itself uses), else console-tokens.json there. Never this
 * shell's export: the unit inherits no shell, loads no EnvironmentFile and its wrapper sources no `.env`, so `serve`
 * finds only the file's value. One helper for `service install --console` and `up`'s next step, so the two cannot
 * name different files.
 */
export function consoleTokensPathFor(deployDir, platform) {
	const { env } = deploymentServiceEnv({ env: {}, dir: deployDir, keys: ["PI_CONSOLE_TOKENS_FILE"], platform, fs: nodeFs });
	return tokensFilePath(env, deployDir);
}

/**
 * How many operator tokens the console this unit starts would find (issue #708): `{ path, operators }` or
 * `{ path, refusal }`. The tokens file is where `serve --deployment <deployDir>` looks: PI_CONSOLE_TOKENS_FILE as the
 * SERVICE sees it (the deployment `.env`, through the reader the console itself uses), never this shell's export,
 * which the unit does not inherit. Read with the real filesystem on purpose: `readTokensFile` judges the file the way
 * `serve` does (owner-only, regular, no symlink), and a fake that answered differently would prove nothing.
 */
export function readConsoleOperators(deployDir, platform) {
	const path = consoleTokensPathFor(deployDir, platform);
	const read = readTokensFile({ path });
	return read.refusal ? { path, refusal: read.refusal } : { path, operators: operatorCount(read.file) };
}

/**
 * The whole substitution surface, template by template. The render replaces ONLY these literals (plus
 * the scope-dependent `User=` / `WantedBy=` rewrites called out below); the pin test in
 * worker/test/service.test.mjs asserts each one is still present in the real deploy/ file, so an edit
 * to a template that would break the render fails the build instead of shipping a broken `service`.
 */
export const TEMPLATE_PINS = {
	"worker.service": [
		"ExecStart=/usr/bin/node worker/src/cli.mjs worker", // the WHOLE line → `<execPath> <cliPath> worker` (cli.mjs sits beside this module in src/ in both layouts)
		"WorkingDirectory=/opt/pi-dispatch", // /opt/pi-dispatch → the deployment folder (the cwd `service` runs from)
		"EnvironmentFile=/opt/pi-dispatch/.env", // → <deployDir>/.env — the operator's .env lives beside the units, never inside the package
		"\nUser=pi\n", // the DIRECTIVE line (the header comment also says User=pi mid-line, hence the \n anchors): stripped for --user scope; rewritten to the invoking user for --system
		"WantedBy=multi-user.target", // → default.target in user scope (multi-user.target never runs there)
		// Byte-for-byte survivors — semantics the render must not lose:
		"RestartPreventExitStatus=2", // EXIT_POLICY is never restarted (a retry loop is a bill)
		"StartLimitIntervalSec=60",
		"StartLimitBurst=5",
		"KillSignal=SIGTERM",
		"TimeoutStopSec=30",
	],
	"receiver.service": [
		"ExecStart=/usr/bin/node receiver/src/start.mjs", // the WHOLE line → `<execPath> <receiverStart>` (the receiver package's resolved ./start export)
		"WorkingDirectory=/opt/pi-dispatch",
		"EnvironmentFile=/opt/pi-dispatch/.env",
		"\nUser=pi\n",
		"WantedBy=multi-user.target",
		// Byte-for-byte survivors — semantics the render must not lose, matching worker.service's list
		// above. Added with #187: the receiver had none of the three, so any config it could not parse
		// produced an unbounded five-second restart loop, and `service install` rendering them away would
		// put that back on a deployment that had just been fixed.
		"RestartPreventExitStatus=2", // EXIT_POLICY is never restarted (the next start reads the same bad file)
		"StartLimitIntervalSec=60",
		"StartLimitBurst=5",
		"KillSignal=SIGTERM",
		"TimeoutStopSec=30",
	],
	// Issue #708: the console, the receiver's shape. Its ExecStart names the console package's entry and the deployment
	// (`serve --deployment`), so the folder is in the line twice and the WHOLE line is replaced, as for the other two.
	"console.service": [
		"ExecStart=/usr/bin/node /usr/lib/node_modules/@edgehero/pi-dispatch-admin/dist/console.mjs serve --deployment /opt/pi-dispatch", // the WHOLE line → `<execPath> <consoleEntry> serve --deployment <deployDir>`
		"WorkingDirectory=/opt/pi-dispatch",
		"\nUser=pi\n",
		"WantedBy=multi-user.target",
		"RestartPreventExitStatus=2", // serve's refusals (no operator token, the lock held, an unusable listen) exit 2, and the next start would refuse the same way
		"StartLimitIntervalSec=60",
		"StartLimitBurst=5",
		"KillSignal=SIGTERM",
		"TimeoutStopSec=30",
	],
	"com.pi-dispatch.worker.plist": [
		"<string>com.pi-dispatch.worker</string>", // → com.pi-dispatch.receiver for --receiver, com.pi-dispatch.console for --console
		"<string>/opt/pi-dispatch/deploy/worker-env-wrapper.sh</string>", // → the PACKAGE's wrapper copy, followed by the exec argv (<node> <script> …) the wrapper now runs verbatim
		"<key>WorkingDirectory</key>\n\t<string>/opt/pi-dispatch</string>", // → the deployment folder (load-bearing: the wrapper sources ./.env there); also the anchor for the PATH injection below
		"<string>/opt/pi-dispatch/logs/worker.out.log</string>", // → <deployDir>/logs/… (install creates the dir; launchd will not)
		"<string>/opt/pi-dispatch/logs/worker.err.log</string>",
		"<key>SuccessfulExit</key>", // the KeepAlive shape the wrapper's exit-2 conversion pairs with
		"<integer>30</integer>", // ExitTimeOut — room for the SIGTERM drain
	],
	// Windows is command-driven, not file-rendered: install SPAWNS nssmSequence() below instead of
	// copying the .cmd. These pins hold the worked example to the same values the sequence uses, so
	// the two cannot drift apart — especially the AppExit pair, which is the EXIT_POLICY never-retry.
	"nssm-install.cmd": [
		"pi-dispatch-worker",
		"C:\\pi-dispatch", // the REPO placeholder → the deployment folder (cwd)
		"deploy\\worker-env-wrapper.cmd", // the sequence points at the PACKAGE's wrapper copy and passes the exec argv behind it
		"AppStopMethodConsole 15000",
		"AppThrottle 5000",
		"AppExit Default Restart",
		"AppExit 2 Exit",
	],
	// The wrappers are COPIED, never substituted, so they have no substitution surface of their own.
	// They are pinned anyway for the same reason nssm-install.cmd is: the render EMITS the variable name
	// they read back (`--env-setup`, issue #209 — the plist's EnvironmentVariables dict on macOS, nssm's
	// AppEnvironmentExtra on Windows), and a rename on one side with silence on the other would produce
	// a unit that starts fine and ignores the operator's secrets manager.
	// Since issue #708 also PI_WRAPPER_NO_DOTENV, which the console's plist and nssm entry set and the wrappers test
	// before they load ./.env: the same rename hazard, and here a rename would hand the console every worker secret.
	"worker-env-wrapper.sh": ["PI_ENV_SETUP", "PI_WRAPPER_NO_DOTENV"],
	"worker-env-wrapper.cmd": ["PI_ENV_SETUP", "PI_WRAPPER_NO_DOTENV"],
};

/**
 * The env-setup seam (issue #209): an operator-typed path to their OWN script, sourced before the
 * worker starts, so a secrets manager can put the provider key and the forge token into the process
 * environment without anyone hand-editing a rendered unit. The renderer owns the `exec` that follows
 * it, which is the whole point — the hand-edit an operator naturally reaches for (`<manager> run -- …`)
 * reports the CHILD's exit 2 as 1, and exit 2 is the determinate policy refusal that
 * RestartPreventExitStatus=2, nssm's `AppExit 2 Exit` and the wrapper's exit-2 conversion all key on.
 *
 * A PATH and not a command, deliberately. systemd expands `$…`/`${…}` inside Exec lines whatever the
 * quoting, a plist is XML, and nssm's argv is neither, so an inline command would need three separate
 * escaping stories — and it is the shape docs/secrets.md already tells operators not to write.
 *
 * Absolute, and never resolved against anything: `.` in POSIX sh SEARCHES $PATH for an operand with no
 * slash in it, so a relative path here would be a different file depending on the service manager's
 * environment. Refuse rather than guess.
 *
 * The refused characters are per platform because the constraint is: on Linux the path lands inside a
 * systemd Exec word (which owns `$`, `"` and `\`), on macOS inside a plist <string> (XML), and on
 * Windows inside an nssm NAME=VALUE that cmd expands with `%`. Spaces are fine everywhere: every
 * composed form quotes.
 */
const ENV_SETUP_REFUSALS = {
	linux: { re: /['"$%\\\x00-\x1f\x7f]/, why: "the path lands inside a single-quoted systemd Exec word, and systemd expands $VAR and %-specifiers there whatever the quoting" },
	darwin: { re: /[<>&"\x00-\x1f\x7f]/, why: "the launchd unit is a plist, and the path lands in an XML <string>" },
	win32: { re: /[%"\x00-\x1f\x7f]/, why: "cmd expands %VAR% when the wrapper runs the script" },
};

function resolveEnvSetup(ctx, raw) {
	const path = String(raw);
	const absolute = ctx.platform === "win32" ? /^([A-Za-z]:[\\/]|\\\\)/.test(path) : path.startsWith("/");
	if (!absolute) {
		return { error: `--env-setup needs an ABSOLUTE path, got: ${path}\nPOSIX \`.\` searches $PATH for an operand with no slash in it, and a service manager's environment is not your shell's, so a relative path here is a different file on every host.` };
	}
	const { re, why } = ENV_SETUP_REFUSALS[ctx.platform];
	const hit = re.exec(path);
	if (hit) {
		const shown = hit[0].charCodeAt(0) < 0x20 || hit[0].charCodeAt(0) === 0x7f ? `\\x${hit[0].charCodeAt(0).toString(16).padStart(2, "0")}` : hit[0];
		return { error: `--env-setup path contains ${JSON.stringify(shown)}, which cannot be rendered safely on ${ctx.platform}: ${why}. Move the script somewhere without it: ${path}` };
	}
	if (!ctx.fs.existsSync(path)) {
		return { error: `--env-setup script not found: ${path}\nRefusing rather than rendering: a unit pointing at a script that is not there installs cleanly and then fails at every boot.` };
	}
	return { path };
}

/**
 * The read side of the same seam (issue #216). `--env-setup` is a RENDER-TIME flag: once the unit is
 * written, the unit is the only record of the path, so a preflight that wants to check the script has
 * to read it back out of the file that actually boots. These patterns match exactly what
 * composeEnvSetupExec and renderPlist emit, and they live here beside ENV_SETUP_REFUSALS so the writer
 * and the reader cannot drift apart unnoticed — worker/test/service.test.mjs round-trips every render
 * through readUnitSeam, so changing one half without the other turns the suite red.
 *
 * The capture classes are exact rather than lazy because ENV_SETUP_REFUSALS already guarantees what
 * cannot be in the path: no `"` on any platform, so `[^"]*` ends where the renderer's quote does, and
 * no `<`/`>`/`&` on macOS, so a plist <string> can never hold an XML entity to decode.
 *
 * win32 is not a file at all — the value comes back from `nssm get <service> AppEnvironmentExtra`,
 * which some nssm builds write as UTF-16, hence the NUL strip in readUnitSeam.
 */
const ENV_SETUP_READERS = {
	linux: {
		setup: /^ExecStart=\/bin\/sh -c 'set -a; \. "([^"]*)" \|\| exit 1;/m,
		deployDir: /^WorkingDirectory=(.*)$/m,
	},
	darwin: {
		setup: /<key>PI_ENV_SETUP<\/key>\s*<string>([^<]*)<\/string>/,
		deployDir: /<key>WorkingDirectory<\/key>\s*<string>([^<]*)<\/string>/,
	},
	win32: {
		setup: /^PI_ENV_SETUP=(.*)$/m,
		// nssm holds the deployment folder in a SEPARATE property (AppDirectory), and there is only one
		// machine-scoped service per name to confuse it with — so the caller matches on nothing here
		// rather than spending a second `nssm get` to answer a question Windows cannot ask twice.
		deployDir: null,
	},
};

/**
 * `text` as XML character data: `&`, `<` and `>` only, `&` first. No string this render writes lands in an attribute,
 * so `'` and `"` need no entity, and leaving them literal keeps every plist that held one byte-identical to before
 * (final review of #708). `>` is escaped although character data allows it, so a path can never write `-->`.
 */
function xmlText(text) {
	return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The reverse, for what readUnitSeam reads back out of a plist: the three entities `xmlText` writes plus the two it does
 * not (a hand-edited plist may carry them). `&amp;` last, so `&amp;lt;` stays `&lt;`.
 */
function xmlUntext(text) {
	return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

/**
 * What an installed unit records: the configured `--env-setup` path and the deployment folder it
 * serves. Both null for a unit rendered without the flag, which is every unit that predates issue #209
 * and every default render since. Never throws: an unreadable, truncated or hand-rewritten unit simply
 * reads as "no seam configured", because a preflight guessing at a shape it does not recognise is
 * worse than one that says nothing.
 */
export function readUnitSeam(text, platform) {
	const readers = ENV_SETUP_READERS[platform];
	if (!readers || typeof text !== "string") return { setup: null, deployDir: null };
	const clean = text.replace(/\0/g, "");
	const grab = (re) => (re ? (re.exec(clean)?.[1] ?? null) : null);
	// Only a trailing CR is stripped, never surrounding whitespace: on the quoted and XML forms the
	// capture already ends exactly where the renderer's delimiter does, and a path is allowed to hold a
	// space anywhere in it. An empty value means the same as no value at all.
	const clip = (v) => (v === null ? null : v.replace(/\r$/, "") || null);
	// The folder as the renderer escaped it (round 1 review of #708): `%` doubled in a systemd unit (WorkingDirectory=
	// expands specifiers), XML entities in a plist. Undone here so a folder holding either still reads as itself.
	const folder = clip(grab(readers.deployDir));
	const deployDir = folder === null ? null : platform === "linux" ? folder.replace(/%%/g, "%") : platform === "darwin" ? xmlUntext(folder) : folder;
	const setup = clip(grab(readers.setup));
	return { setup: setup !== null && platform === "darwin" ? xmlUntext(setup) : setup, deployDir };
}

/**
 * The account a SYSTEM unit runs the worker as (`User=`), or `null` when it names none (issue #341). Only systemd has
 * one: a user-scope unit, a launchd agent and an nssm service run as whoever installed them. Separate from
 * `readUnitSeam` because it is not part of the render round trip (a `--system` render writes the invoking user, a
 * `--user` render strips the line). Read as systemd does: whitespace around `=` allowed, and the LAST assignment wins.
 */
export function readUnitUser(text, platform) {
	if (platform !== "linux" || typeof text !== "string") return null;
	const hits = [...text.replace(/\0/g, "").matchAll(/^[ \t]*User[ \t]*=[ \t]*(.*?)[ \t]*\r?$/gm)];
	const value = hits.at(-1)?.[1];
	return value ? value : null;
}

const SUBCOMMANDS = new Set(["render", "install", "uninstall", "status", "start", "stop", "restart"]);

const SERVICE_USAGE = `pi-dispatch service — run the worker (or --receiver, or --console) as an OS service, rendered for THIS host

  pi-dispatch service render                the unit(s) with this host's real node + repo paths
  pi-dispatch service install [--force]     write + enable the user-level unit
                                            (linux --system: prints the exact sudo commands, runs nothing)
  pi-dispatch service uninstall             stop, disable and remove the installed unit
  pi-dispatch service status                which unit exists in which scope, and whether it is active
  pi-dispatch service start|stop            thin launchctl / systemctl --user / nssm wrappers
  pi-dispatch service restart [--drain]     restart; --drain pauses the queue, waits for active jobs
                                            to finish, restarts, resumes  [--drain-timeout <s>, default 600]

  flags: --receiver          the webhook receiver instead of the worker
         --console           the operator console (pi-dispatch-console serve) instead of the worker;
                             install needs an operator token (pi-dispatch-console token add)
         --host-setup        render|install --console: grant bounded local setup, Linux/macOS user scope
         --user | --system   linux scope (default --user; --system never executes root commands)
         --force             replace an existing unit in the same scope
         --print             also print the rendered unit before installing
         --env-setup <path>  render|install: source YOUR script before the worker starts, so a secrets
                             manager fills the environment. Absolute path, env only (no exec, no paths):
                             the render owns the exec, so a policy refusal still exits 2. docs/secrets.md
`;

export async function runService(argv = [], deps = {}) {
	const {
		env = process.env,
		platform = process.platform,
		euid = typeof process.geteuid === "function" ? process.geteuid() : null,
		execPath = process.execPath,
		// The deployment folder: where the operator ran `service`, where .env lives, where logs/ goes.
		cwd = process.cwd(),
		// Injectable so tests can render as if from an npm install without installing anything.
		moduleDir = MODULE_DIR,
		resolveReceiver = resolveReceiverStart,
		// Issue #708: the console package's entry (see resolveConsoleEntry); a test injects a path or null.
		resolveConsole = null,
		// Issue #708: the operator tokens the console unit would start with (see readConsoleOperators).
		consoleOperators = readConsoleOperators,
		home = homedir(),
		// env-internal USER: whose account a rendered unit runs as, taken from the login already running
		// this command. An operator changes it by running the command as someone else, not by declaring it.
		user = env.USER || userInfo().username,
		tmp = tmpdir(),
		fs = SERVICE_FS,
		spawn = nodeSpawn,
		out = (s) => process.stdout.write(s),
		err = (s) => process.stderr.write(s),
		sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
		now = () => Date.now(),
		queue = null, // test seam; production builds one lazily in doRestart from VALKEY_URL
		// PR #463: how a path resolves through symlinks, for the manager-environment rule (a symlinked home).
		realpath = (p) => realpathSync(p),
		// Where this shell finds a CLI by name (its PATH, the first executable file): the console package's bin lookup
		// (`resolveConsoleEntry`, which falls back to PATH when import.meta.resolve cannot see the package).
		// env-internal PATH: this shell's own search path, read only to locate an already-installed binary here;
		// a service unit's own PATH is a different, declared thing.
		findBin = (name) => findOnPath(name, env.PATH),
	} = deps;

	let values, positionals;
	try {
		({ values, positionals } = parseArgs({
			args: argv,
			allowPositionals: true,
			options: {
				receiver: { type: "boolean", default: false },
				console: { type: "boolean", default: false },
				"host-setup": { type: "boolean", default: false },
				user: { type: "boolean", default: false },
				system: { type: "boolean", default: false },
				force: { type: "boolean", default: false },
				print: { type: "boolean", default: false },
				drain: { type: "boolean", default: false },
				"drain-timeout": { type: "string" },
				"env-setup": { type: "string" },
			},
		}));
	} catch (error) {
		return fail(err, error.message);
	}

	const cmd = positionals[0];
	if (!cmd || !SUBCOMMANDS.has(cmd)) {
		out(SERVICE_USAGE);
		return cmd ? 1 : 0; // bare `service` is a usage view, an unknown subcommand is an error
	}
	if (values.user && values.system) return fail(err, "--user and --system are mutually exclusive");
	// One component per invocation: every subcommand addresses exactly one unit, and guessing which of two was meant
	// would install, stop or remove the other one.
	if (values.receiver && values.console) return fail(err, "--receiver and --console are mutually exclusive: each names one service; run the command once for each");
	if (values["host-setup"] && (!values.console || !["render", "install"].includes(cmd) || values.system || !["linux", "darwin"].includes(platform))) return fail(err, "--host-setup is only for render/install --console in a Linux or macOS user service");
	if (platform === "darwin" && values.system) {
		// The Docker Desktop reason is the worker's; the console and the receiver start no container (round 1 review of #708).
		return fail(err, values.console || values.receiver ? "macOS is user-scope only here (a LaunchAgent, in your login session, where this command installs every unit). Drop --system." : "macOS is user-scope only (a LaunchAgent): Docker Desktop lives in the login session, so a system daemon would wait on a docker socket that only exists once you log in. Drop --system.");
	}
	// `--drain` pauses the QUEUE and waits for its jobs, which only the worker runs (round 1 review of #708): on the
	// receiver or the console it would pause every job for a restart that drains nothing.
	if (values.drain && (values.console || values.receiver)) return fail(err, "--drain applies to the worker alone (it pauses the queue and waits for its running jobs); restart the receiver or the console without it");
	if (platform === "win32" && (values.user || values.system)) {
		return fail(err, "Windows services via nssm are machine-scoped; --user/--system do not apply here");
	}
	if (!["darwin", "linux", "win32"].includes(platform)) return fail(err, `unsupported platform: ${platform}`);

	// The templates dir is module-relative like moduleDir itself: worker/deploy in a checkout,
	// <pkg>/deploy under npm — the SHIPPED copies, correct in both layouts (unlike the old repo root).
	const templatesDir = resolve(moduleDir, "..", "deploy");
	const ctx = {
		env,
		platform,
		euid,
		execPath,
		deployDir: cwd,
		cliPath: join(moduleDir, "cli.mjs"),
		templatesDir,
		wrapperSh: join(templatesDir, "worker-env-wrapper.sh"),
		wrapperCmd: join(templatesDir, "worker-env-wrapper.cmd"),
		// Resolved only when asked for: worker-only invocations must not care whether the receiver
		// package exists here at all.
		receiverStart: values.receiver ? resolveReceiver() : null,
		// Issue #708: the same rule for the console, resolved only for --console.
		consoleEntry: values.console ? (resolveConsole ?? (() => resolveConsoleEntry({ findBin, realpath })))() : null,
		consoleOperators,
		home,
		user,
		tmp,
		fs,
		spawn,
		out,
		err,
		sleep,
		now,
		queue,
		realpath,
		findBin,
		which: values.receiver ? "receiver" : values.console ? "console" : "worker",
		scope: platform === "linux" && values.system ? "system" : "user",
		force: values.force,
		// The terminal bootstrap reuses this exact planner for an existing granted console.
		// This dependency is internal; no environment variable or start flag grants authority.
		hostSetup: values["host-setup"] || (values.console && deps.setupConsoleGrant === true),
		setupExpected: deps.setupExpected,
		// The operator's env-setup script, or null for the shipped default. Null is load-bearing: with no
		// seam configured every render below is byte-identical to what it produced before issue #209.
		envSetup: null,
	};

	if (values["env-setup"] !== undefined) {
		// Only the two subcommands that COMPOSE a command line can honour it. Ignoring the flag on the
		// others would be the silent no-op this project refuses on principle: an operator who typed it on
		// `restart` would believe the seam was in place.
		if (cmd !== "render" && cmd !== "install") {
			return fail(err, `--env-setup applies to \`service render\` and \`service install\`, which compose the command the unit runs; \`service ${cmd}\` renders nothing. Re-render (or re-install --force) to change it.`);
		}
		const resolved = resolveEnvSetup(ctx, values["env-setup"]);
		if (resolved.error) return fail(err, resolved.error);
		ctx.envSetup = resolved.path;
	}
	if (ctx.hostSetup && (!(deps.setupEntry ?? resolveSetupWorkerEntry)().entry || setupCachePath(ctx.consoleEntry))) return fail(err, "--host-setup needs durable installed worker and console entries, never npm execution-cache paths");

	if (deps.setupPlan === true) return setupServicePlan(ctx, cmd);
	if (deps.setupExpected !== undefined) {
		const current = await setupServicePlan(ctx, cmd);
		if (JSON.stringify(current) !== JSON.stringify(deps.setupExpected)) return fail(err, "the setup service plan changed before dispatch; preview it again");
	}
	switch (cmd) {
		case "render":
			return doRender(ctx);
		case "install":
			// --print is implied for render and opt-in here: see what will be written, then write it.
			if (values.print) await doRender(ctx);
			return doInstall(ctx);
		case "uninstall":
			return doUninstall(ctx);
		case "status":
			return doStatus(ctx);
		case "start":
			return doStart(ctx);
		case "stop":
			return doStop(ctx);
		case "restart":
			return doRestart(ctx, values);
	}
}

/**
 * The services this command installs, by `ctx.which`. Each has ONE systemd template, and the launchd and nssm forms are
 * derived from the worker's (the receiver's precedent): the same KeepAlive/ExitTimeOut shape and the same AppExit pair,
 * which is what keeps every component's exit 2 a stop rather than a restart loop.
 *
 *   template      the deploy/ file renderLinuxUnit reads (a TEMPLATE_PINS key)
 *   templateExec  that template's ExecStart line, replaced WHOLE by execArgvFor's argv
 */
const COMPONENTS = Object.freeze(["worker", "receiver", "console"]);
const COMPONENT_TEMPLATES = Object.freeze({
	worker: { template: "worker.service", templateExec: "ExecStart=/usr/bin/node worker/src/cli.mjs worker" },
	receiver: { template: "receiver.service", templateExec: "ExecStart=/usr/bin/node receiver/src/start.mjs" },
	console: { template: "console.service", templateExec: "ExecStart=/usr/bin/node /usr/lib/node_modules/@edgehero/pi-dispatch-admin/dist/console.mjs serve --deployment /opt/pi-dispatch" },
});

/**
 * The command a unit runs, for every service manager: the systemd ExecStart, the argv the launchd wrapper execs and
 * nssm's AppParameters. One function because there were three copies of it, one per manager, and a component added
 * to two of them would install a unit on the third that runs the worker. Absolute node, absolute script: nothing here
 * depends on a PATH or a working directory. The console names its deployment itself (`serve --deployment`), so it
 * reads THIS deployment's `.env` and tokens even where the manager's working directory were not honoured.
 */
function execArgvFor(ctx) {
	if (ctx.which === "receiver") return [ctx.execPath, ctx.receiverStart];
	if (ctx.which === "console") return [ctx.execPath, ctx.consoleEntry, "serve", "--deployment", ctx.deployDir, ...(ctx.hostSetup ? ["--host-setup"] : [])];
	return [ctx.execPath, ctx.cliPath, "worker"];
}

/** The browser's planner uses the installer's own render, never a second unit template (#774). */
export async function planServiceSetup(argv, deps = {}) {
	return runService(argv, { ...deps, setupPlan: true, out: () => {}, err: () => {} });
}

async function setupServicePlan(ctx, operation) {
	const no = (reason) => ({ refusal: reason });
	if (!["linux", "darwin"].includes(ctx.platform) || ctx.scope !== "user" || (ctx.platform === "darwin" && ctx.euid === 0)) return no("unsupported");
	if (ctx.which === "receiver" && !ctx.receiverStart) return no("missing-receiver");
	if (ctx.which === "console" && !ctx.consoleEntry) return no("unsafe-entry");
	if (renderRefusal(ctx) !== null) return no("unsafe-deployment");
	const paths = unitPaths(ctx);
	if (ctx.which === "worker" && paths.otherScopeWorkerPaths.some((p) => ctx.fs.existsSync(p))) return no("foreign-service");
	const text = ctx.platform === "linux" ? renderLinuxUnit(ctx) : renderPlist(ctx);
	let before = null;
	if (ctx.fs.existsSync(paths.installPath)) {
		try {
			const st = ctx.fs.lstatSync?.(paths.installPath);
			if (st && (st.isSymbolicLink() || !st.isFile() || st.uid !== ctx.euid || (st.mode & 0o022))) return no("foreign-service");
			before = ctx.fs.readFileSync(paths.installPath, "utf8");
		} catch { return no("foreign-service"); }
		// A hand-edited unit can launch anything this account can launch; it is not a setup-owned service.
		if (before !== text) return no("foreign-service");
	}
	if (operation === "install" && before !== null) return no("service-exists");
	if (operation !== "install" && before === null) return no("missing-service");
	let active = false;
	let loaded = false;
	if (ctx.platform === "linux") {
		const manager = await runQuery(ctx, "systemctl", ["--user", "show-environment"]);
		if (manager.code !== 0 || managerEnvRefusal(manager, { home: ctx.home, euid: ctx.euid, user: ctx.user, realpath: ctx.realpath })) return no("manager-unavailable");
		const status = await runQuery(ctx, "systemctl", ["--user", "show", "--property=LoadState,ActiveState,FragmentPath,DropInPaths,WorkingDirectory,ExecStart", paths.name]);
		if (status.code !== 0) return no("manager-unavailable");
		const properties = Object.fromEntries(String(status.stdout).split("\n").map((line) => { const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)]; }));
		if (before !== null) {
			try {
				if (properties.LoadState !== "loaded" || !properties.FragmentPath || ctx.realpath(properties.FragmentPath) !== ctx.realpath(paths.installPath) || properties.DropInPaths !== "" || !properties.WorkingDirectory || ctx.realpath(properties.WorkingDirectory) !== ctx.realpath(ctx.deployDir)) return no("foreign-service");
				const argv = /(?:^|[ ;])argv\[\]=([^;]*);/.exec(properties.ExecStart ?? "")?.[1]?.trim();
				if (argv !== execArgvFor(ctx).join(" ")) return no("foreign-service");
			} catch { return no("foreign-service"); }
		} else if (properties.LoadState && properties.LoadState !== "not-found") return no("foreign-service");
		loaded = properties.LoadState === "loaded";
		active = /^ActiveState=active$/m.test(status.stdout);
	} else {
		const manager = await runQuery(ctx, "launchctl", ["print", `gui/${ctx.euid}`]);
		if (manager.code !== 0) return no("manager-unavailable");
		const status = await runQuery(ctx, "launchctl", ["print", `gui/${ctx.euid}/${paths.name}`]);
		loaded = status.code === 0;
		if (loaded) {
			try {
				const source = /^\s*path = (.+)$/m.exec(status.stdout)?.[1];
				const directory = /^\s*working directory = (.+)$/m.exec(status.stdout)?.[1];
				const argumentsText = /arguments = \{\s*\n([\s\S]*?)\n\s*\}/.exec(status.stdout)?.[1];
				const argv = argumentsText?.split("\n").map((line) => line.trim()).filter(Boolean);
				if (!before || !source || ctx.realpath(source) !== ctx.realpath(paths.installPath) || !directory || ctx.realpath(directory) !== ctx.realpath(ctx.deployDir) || JSON.stringify(argv) !== JSON.stringify(["/bin/sh", ctx.wrapperSh, ...execArgvFor(ctx)])) return no("foreign-service");
			} catch { return no("foreign-service"); }
		}
		active = status.code === 0 && /state = running/.test(status.stdout);
	}
	return { operation, which: ctx.which, path: paths.installPath, text, before, active, loaded, effects: [...(operation === "install" ? [`write-${ctx.which}-unit`] : []), `${operation === "install" ? "start" : operation}-${ctx.which}`] };
}

/**
 * Where each unit lives (or is looked for) per platform. `otherScopeWorkerPaths` exists only to
 * enforce DES-CONCURRENCY-3 at install time — those locations are READ, never written. On Linux the
 * system-scope check covers both our canonical name and `worker.service`, the name the README's
 * manual `sudo cp` instructions produce: a hand-installed worker is still a second worker.
 */
function unitPaths(ctx) {
	if (ctx.platform === "darwin") {
		const label = `com.pi-dispatch.${ctx.which}`;
		return {
			name: label,
			installPath: join(ctx.home, "Library", "LaunchAgents", `${label}.plist`),
			systemPath: join("/Library/LaunchDaemons", `${label}.plist`),
			otherScopeWorkerPaths: ["/Library/LaunchDaemons/com.pi-dispatch.worker.plist"],
		};
	}
	if (ctx.platform === "linux") {
		const unit = `pi-dispatch-${ctx.which}.service`;
		const userPath = join(ctx.home, ".config", "systemd", "user", unit);
		const systemPath = join("/etc/systemd/system", unit);
		return {
			name: unit,
			userPath,
			systemPath,
			installPath: ctx.scope === "system" ? systemPath : userPath,
			otherScopeWorkerPaths:
				ctx.scope === "system"
					? [join(ctx.home, ".config", "systemd", "user", "pi-dispatch-worker.service")]
					: ["/etc/systemd/system/pi-dispatch-worker.service", "/etc/systemd/system/worker.service"],
		};
	}
	// win32: the unit is an nssm-registered service, not a file this tool addresses. Same-scope
	// detection happens via `nssm status`, and there is no second scope to cross-check.
	return { name: `pi-dispatch-${ctx.which}` };
}

/**
 * Every unit FILE this tool could have installed on this host: every component (the worker, the receiver and, since
 * issue #708, the console), both scopes, plus the
 * `worker.service` name the README's manual `sudo cp` instructions produce (doStatus already counts
 * that one as a real worker unit, so a preflight reading units must too). Derived from unitPaths
 * rather than restated, so the two cannot disagree about where a unit lives.
 *
 * Empty on win32 by construction: there is no file to read there, only `nssm get`.
 */
export function installedUnitPaths(platform, home) {
	if (platform !== "linux" && platform !== "darwin") return [];
	const found = [];
	for (const which of COMPONENTS) {
		const paths = unitPaths({ platform, home, which, scope: "user" });
		found.push({ which, scope: "user", path: platform === "linux" ? paths.userPath : paths.installPath });
		found.push({ which, scope: "system", path: paths.systemPath });
		if (platform === "linux" && which === "worker") found.push({ which, scope: "system", path: "/etc/systemd/system/worker.service" });
	}
	return found;
}

/**
 * The console unit FILE installed for the deployment in `cwd` (issue #708), or null: one of `installedUnitPaths`'
 * console entries whose WorkingDirectory (`readUnitSeam`) is this folder. Shared by doctor and `up`, so the two agree
 * on whether a console service exists. Always null on win32, where the service is nssm's and is asked by name.
 */
export function installedConsoleUnitPath({ platform, home, cwd, fileExists = existsSync, readUnit = (path) => readFileSync(path, "utf8") }) {
	for (const { path, which } of installedUnitPaths(platform, home)) {
		if (which !== "console" || !fileExists(path)) continue;
		try {
			if (readUnitSeam(readUnit(path), platform).deployDir === cwd) return path;
		} catch {}
	}
	return null;
}

function readTemplate(ctx, name) {
	return ctx.fs.readFileSync(join(ctx.templatesDir, name), "utf8");
}

/**
 * The per-host path substitutions, applied to a TEMPLATE and never to anything a render composed.
 * /opt/pi-dispatch becomes the deployment folder (the cwd this render ran from): WorkingDirectory and
 * EnvironmentFile stay operator territory, never the package dir npm may wipe on update.
 *
 * The ordering matters and used to be wrong. A composed value is already absolute for THIS host, so
 * putting it through these rewrites a path the operator typed rather than a placeholder the template
 * shipped — and an `--env-setup /opt/pi-dispatch/setup-env.sh` on a deployment at /srv/pi-deploy became
 * `. "/srv/pi-deploy/setup-env.sh"`, a file resolveEnvSetup never checked, while the banner above it
 * still named the one that was typed. Substitute first, compose second, and anchor on the substituted
 * form.
 */
function subDeployDir(ctx, text) {
	// Function replacement, here and everywhere below a computed path is the REPLACEMENT: String.replace
	// and replaceAll both read `$&` and its relatives out of a replacement STRING, so a deployment folder
	// holding one would splice itself into the unit. A function replacement is taken literally.
	// `%` doubled (round 1 review of #708): WorkingDirectory= and EnvironmentFile= expand systemd specifiers, so a
	// folder named `a%hb` would run in `a<home>b`. readUnitSeam undoes it. Linux units only: the plist has its own
	// escaping (xmlText), and nssm takes the folder as an argv word.
	return text.replaceAll("/opt/pi-dispatch", () => ctx.deployDir.replace(/%/g, "%%"));
}

/**
 * subDeployDir plus the systemd unit's node: the shipped `/usr/bin/node` literal does not exist on an
 * nvm host. The PLIST deliberately gets only subDeployDir — its header comment SHOWS
 * `<string>/usr/bin/node</string>` as the argv an operator would append by hand, and that prose is
 * meant to keep reading as an example rather than silently becoming this host's node.
 */
function subUnitPaths(ctx, text) {
	return subDeployDir(ctx, text).replaceAll("/usr/bin/node", () => ctx.execPath);
}

/**
 * The receiver refusal, shared by render and install: a null receiverStart means the receiver package
 * is not resolvable from this worker install. Refusing beats rendering — a unit pointing at a
 * nonexistent start.mjs would install cleanly and then crash-loop at boot, which is exactly the failure
 * mode issue #96 shipped for every path.
 */
function refuseMissingReceiver(ctx) {
	return fail(
		ctx.err,
		"the receiver package is not installed here — run: npm install @edgehero/pi-dispatch-receiver (from the deployment folder)",
	);
}

/**
 * The console refusals (issue #708), shared by render and install as the receiver's is: the console package's entry
 * not found, so a unit would name a file that is not there.
 */
function refuseMissingConsole(ctx) {
	// Worded per platform (round 1 review of #708): `findOnPath` reads no Windows directory, so there it did not look.
	const looked =
		ctx.platform === "win32"
			? `${CONSOLE_PACKAGE}/dist/console.mjs does not resolve from this worker's install (on Windows that is the only place looked: the PATH lookup does not run there)`
			: `neither does ${CONSOLE_PACKAGE}/dist/console.mjs resolve from this worker's install, nor is a \`pi-dispatch-console\` on this shell's PATH that is that package's own file (a pnpm or Volta shim is not)`;
	return fail(
		ctx.err,
		`the operator console is not installed where this command can find it: ${looked}. Install it in the same place as this worker, so it resolves from here: npm install -g ${CONSOLE_PACKAGE} when the worker is installed globally, or npm install ${CONSOLE_PACKAGE} in the folder whose node_modules holds this worker (an admin package installed anywhere else is not found), then re-run`,
	);
}

/**
 * Paths a unit cannot carry (round 1 review of #708), refused before anything is rendered, on every component: a control
 * character in the deployment folder (it would end or corrupt the unit line, the XML or the nssm property), surrounding
 * whitespace on Linux (systemd strips it from WorkingDirectory=, so the unit would run in another folder), and on
 * Windows a command word holding a character cmd reads (the wrapper runs its argv as `%*`, where `"` cannot be
 * quoted and `&`, `|`, `<`, `>`, `^` and `%` outside quotes change the command). Everything else is quoted or escaped
 * per form: systemdWord, xmlText, nssm's argv. null when the render can go ahead.
 */
function renderRefusal(ctx) {
	const shown = (c) => (c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f ? `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}` : c);
	const control = /[\x00-\x1f\x7f]/.exec(ctx.deployDir);
	if (control) return fail(ctx.err, `the deployment folder ${JSON.stringify(ctx.deployDir)} holds ${JSON.stringify(shown(control[0]))}, a control character no service unit can carry; run this from a folder without one`);
	if (ctx.platform === "linux" && ctx.deployDir !== ctx.deployDir.trim()) return fail(ctx.err, `the deployment folder ${JSON.stringify(ctx.deployDir)} starts or ends with whitespace, which systemd strips from WorkingDirectory=, so the unit would run in another folder; rename it`);
	// NOT refused (final review of #708): a `--` in the folder, which the plist template also names inside XML comments.
	// plutil accepts it there, and `xmlText` escapes `>`, so a folder can never write the `-->` that would end one;
	// refusing it broke worker installs that had always worked in a folder like ~/my--deploy.
	if (ctx.platform === "win32") {
		for (const word of execArgvFor(ctx)) {
			const bad = /["%&|<>^\x00-\x1f\x7f]/.exec(word);
			if (bad) return fail(ctx.err, `${JSON.stringify(word)} holds ${JSON.stringify(shown(bad[0]))}, which the service's wrapper cannot pass to the command it runs (cmd reads it); move it to a path without one`);
		}
	}
	return null;
}

/**
 * Install only: a console unit started with no operator token in its tokens file would exit 2 on every start (`serve`
 * refuses, so nobody could change anything from it), and RestartPreventExitStatus=2 would then leave it stopped. An
 * install that "succeeds" into a service that never runs is the silent no-op this project refuses, so it is refused
 * here, with the fix. A tokens file that cannot be used at all (missing, too open, invalid) is refused the same way and
 * with its own sentence. `render` does not refuse: it writes nothing, and the unit it shows is right once a token exists.
 */
function refuseConsoleWithoutOperator(ctx) {
	let found;
	try {
		found = ctx.consoleOperators(ctx.deployDir, ctx.platform);
	} catch (err) {
		return fail(ctx.err, `the console's tokens file could not be read (${err?.message ?? err}), so the console would refuse to start; nothing was installed`);
	}
	if (found.refusal) return fail(ctx.err, `${found.refusal}. The console refuses to start without it, so nothing was installed`);
	if (found.operators === 0) {
		return fail(ctx.err, `${found.path} holds no operator token, so \`pi-dispatch-console serve\` would refuse to start (exit 2) and the unit would stay stopped. Add one first: pi-dispatch-console token add --name <you> --role operator --deployment ${ctx.deployDir}`);
	}
	return null;
}

/**
 * The systemd form of the env-setup seam. Three pieces, each load-bearing:
 *
 *   - `exec` keeps systemd watching the WORKER and not a shell in front of it, so an exit 2 arrives as
 *     an exit 2 and RestartPreventExitStatus=2 still sees a real policy refusal. This is the whole
 *     reason the renderer owns this line instead of leaving it to a hand-edit.
 *   - `|| exit 1` maps a failed setup (an expired token, an unreachable manager) onto the
 *     infrastructure code, so systemd retries it under Restart=on-failure inside the StartLimit bound,
 *     and it can never be mistaken for the determinate refusal that must stay stopped. A setup script
 *     that calls `exit 2` ITSELF still exits 2 — sourcing cannot intercept that — which is why
 *     docs/secrets.md tells operators not to.
 *   - `set -a` exports a bare KEY=value, exactly as EnvironmentFile= does, so the seam accepts both an
 *     `export`-style script and raw dotenv output. EnvironmentFile= is untouched and still read first;
 *     this runs after it, so the manager wins over a stale value left in the file.
 *
 * The whole sh script is ONE single-quoted systemd word, which is why resolveEnvSetup refuses a single
 * quote in the path (it would end the word) and a `$` (systemd expands those inside Exec lines whatever
 * the quoting). The inner double quotes are sh's, and they are what makes a path with spaces work.
 * Verified against systemd 252: `systemctl show -p ExecStart` reports argv[] as /bin/sh, -c, and the
 * whole script as one word, and a worker exiting 2 under it reports ExecMainStatus=2 with NRestarts=0.
 */
function composeEnvSetupExec(setup, argv) {
	// The argv inside the script, in sh's double quotes, as it always was, while every word is one that form carries
	// as itself. Otherwise (round 1 review of #708: a deployment folder in the console's argv may hold a space, a `'`,
	// a `$` or a `%`) the argv goes AFTER the script as its own systemd words (`systemdWord`), and the script runs
	// `exec "$@"` (written `$$@`: systemd turns `$$` into `$` whatever the quoting), so nothing typed into a path is
	// ever shell text. The prefix readUnitSeam reads is the same in both forms.
	if (argv.every((a) => !/['"$`\\%\x00-\x1f\x7f]/.test(a))) {
		const command = argv.map((a) => `"${a}"`).join(" ");
		return `/bin/sh -c 'set -a; . "${setup}" || exit 1; set +a; exec ${command}'`;
	}
	return `/bin/sh -c 'set -a; . "${setup}" || exit 1; set +a; exec "$$@"' sh ${argv.map(systemdWord).join(" ")}`;
}

/**
 * One word of a systemd Exec line (systemd.service(5), "Command lines"; systemd.unit(5), "Specifiers"): as it is when it
 * holds only characters systemd reads literally, else in double quotes with `\\` and `"` escaped, `%` written `%%` (a
 * specifier) and `$` written `$$` (variable expansion, which happens inside quotes too). Round 1 review of #708: the
 * console's argv carries the deployment folder, and an unquoted one split at a space and expanded `%h` and `$HOME`.
 * Every path a render held before is a bare word, so those units are byte-identical. A control character cannot be
 * written on one unit line at all; `renderRefusal` refuses it before anything is rendered.
 */
export function systemdWord(word) {
	if (/^[A-Za-z0-9_@+=:,./-]+$/.test(word)) return word;
	return `"${word.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`;
}

/**
 * Render worker.service / receiver.service for this host. Targeted substitution of the templates'
 * known literals (see TEMPLATE_PINS); everything else — RestartPreventExitStatus=2, the StartLimit
 * crash-loop bound, KillSignal, TimeoutStopSec — passes through byte-for-byte.
 */
function renderLinuxUnit(ctx) {
	const { template, templateExec: templateLine } = COMPONENT_TEMPLATES[ctx.which];
	// The ExecStart line is replaced WHOLE, not path-by-path: the template's script path is relative
	// to a repo-root WorkingDirectory that only a checkout has. The rendered unit points at absolute
	// entries that exist in both layouts — cliPath beside this module; the receiver package's ./start
	// export; the console package's dist/console.mjs — so ExecStart works no matter what WorkingDirectory is.
	const argv = execArgvFor(ctx);
	const execStart = `ExecStart=${ctx.envSetup ? composeEnvSetupExec(ctx.envSetup, argv) : argv.map(systemdWord).join(" ")}`;
	// The banner outranks the template's own "TEMPLATE/UNTESTED EXAMPLE — set the PLACEHOLDERs" header,
	// which renders through below (the no-markers design keeps templates byte-usable, so their prose
	// survives): a reader of the rendered unit should know the placeholders are already substituted.
	const seamNote = ctx.envSetup
		? `# ExecStart also runs \`--env-setup ${ctx.envSetup}\` first: sourced with \`set -a\` (a bare\n# KEY=value exports, exactly as EnvironmentFile= does, and it runs AFTER EnvironmentFile so a secrets\n# manager wins over a stale value in .env). A failed setup exits 1, never the exit 2 below, and \`exec\`\n# keeps systemd watching the worker itself. Re-render to change it; do not hand-edit this line.\n`
		: "";
	// Substituted first, then the composed line goes in — see subUnitPaths for why that order is
	// load-bearing. The anchor is the template's own ExecStart put through the same substitutions, which
	// is what it looks like by the time we search for it. Function replacements throughout: a deployment
	// path holding `$&` would otherwise be spliced by String.replace's own syntax.
	const substituted = subUnitPaths(ctx, readTemplate(ctx, template));
	let unit =
		`# rendered by \`pi-dispatch service\` — paths computed for this host from deploy/${template};\n# the template's PLACEHOLDER prose below is already substituted.\n${seamNote}` +
		substituted.replace(subUnitPaths(ctx, templateLine), () => execStart);
	if (ctx.scope === "user") {
		// A systemd --user unit always runs as the invoking user, and systemd REJECTS a User= line in
		// user scope ("Unknown lvalue"); the line must not survive the render. The replacement is a
		// comment so the rendered unit explains its own difference from the shipped template. Anchored
		// to the whole line (^…$) because the template's header comment ALSO says "User=pi" mid-line —
		// a bare replace would rewrite the prose and leave the directive standing.
		unit = unit.replace(
			/^User=pi$/m,
			"# User= stripped by `pi-dispatch service`: a --user unit always runs as the invoking user,\n# and systemd rejects User= in user scope.",
		);
		// multi-user.target exists only in the SYSTEM instance. A user unit enabled into it would
		// symlink into a .wants/ directory no user-instance boot ever walks — enabled but never
		// started. default.target is the user manager's boot target.
		unit = unit.replace("WantedBy=multi-user.target", "WantedBy=default.target");
	} else {
		unit = unit.replace(/^User=pi$/m, () => `User=${ctx.user}`);
	}
	return unit;
}

/**
 * Render the launchd plist for this host. For --receiver the worker plist is DERIVED, not a second
 * template: same KeepAlive/ExitTimeOut shape, label and log names swapped, and the shared wrapper given
 * the receiver's exec argv instead of the worker's. The wrapper's exit-2 conversion is LOAD-BEARING for
 * the receiver too, not the no-op an earlier version of this comment claimed: since
 * receiver/src/cli.mjs gained entryExitCode, a determinate receiver refusal exits EXIT_POLICY (2), and
 * the wrapper's conversion to a clean 0 is exactly what KeepAlive/SuccessfulExit=false reads as
 * "leave it stopped" -- launchd's only way to spell RestartPreventExitStatus=2.
 */
function renderPlist(ctx) {
	// Substituted before anything composed goes in (subDeployDir): the two anchors below are therefore
	// written in their post-substitution form, and PI_ENV_SETUP can no longer be rewritten into a path
	// the operator never typed. Only subDeployDir here — the template's /usr/bin/node is example prose.
	// Every string this render puts into the XML is escaped (`xmlText`, round 1 review of #708): a deployment folder
	// or a package path holding `&` or `<` produced a plist launchd refuses to load. No-op for every other path, so
	// those renders are byte-identical to before.
	let plist = readTemplate(ctx, "com.pi-dispatch.worker.plist").replaceAll("/opt/pi-dispatch", () => xmlText(ctx.deployDir));
	// One wrapper, two daemons: the exec argv IS the difference now. The wrapper sources ./.env in the
	// unit's WorkingDirectory and runs exactly these arguments — no `receiver` selector flag, no paths
	// guessed inside the wrapper (issue #96: the wrapper's self-relative guess broke under npm install).
	const execArgv = execArgvFor(ctx);
	if (ctx.which !== "worker") {
		// The console (issue #708) is derived exactly as the receiver is: `serve`'s refusals exit 2, which the wrapper
		// turns into the clean exit KeepAlive leaves stopped.
		plist = plist
			.replace("<string>com.pi-dispatch.worker</string>", () => `<string>com.pi-dispatch.${ctx.which}</string>`)
			.replaceAll("worker.out.log", () => `${ctx.which}.out.log`)
			.replaceAll("worker.err.log", () => `${ctx.which}.err.log`);
	}
	// The template's two-element ProgramArguments (sh + wrapper) becomes sh + the PACKAGE's wrapper +
	// the command: absolute node, absolute script. The wrapper path is module-relative (templatesDir),
	// so it exists in a checkout AND under node_modules — unlike the old repo-root guess.
	plist = plist.replace(
		`<string>${xmlText(ctx.deployDir)}/deploy/worker-env-wrapper.sh</string>`,
		() =>
			[
				`<string>${xmlText(ctx.wrapperSh)}</string>`,
				ctx.which === "console" ? "<!-- the command the wrapper execs in WorkingDirectory (it sources no .env for the console: PI_WRAPPER_NO_DOTENV below) - absolute paths, nothing guessed -->" : "<!-- the command the wrapper execs after sourcing ./.env in WorkingDirectory - absolute paths, nothing guessed -->",
				...execArgv.map((a) => `<string>${xmlText(a)}</string>`),
			].join("\n\t\t"),
	);
	// launchd's default PATH is /usr/bin:/bin — an nvm or Homebrew node is invisible to it. The exec
	// argv above pins THIS node absolutely, but the worker's own children (npx-style hooks, tooling
	// that spawns bare `node`) still resolve via PATH; prepending the render node's directory keeps
	// them on the SAME binary. PATH is configuration, not a secret: the template's deliberate
	// no-EnvironmentVariables stance is about credentials, which still live only in .env.
	// The dict is built as a list so the seam below can extend it without a second anchor. Everything
	// in it is a PATH; nothing in it is a credential, which is what keeps this file committable.
	const fixed = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
	const envEntries = ["\t\t<key>PATH</key>", `\t\t<string>${xmlText([dirname(ctx.execPath), ...fixed].join(":"))}</string>`];
	if (ctx.which === "console") {
		// Issue #708 (round 1 review): the console reads the deployment's .env itself (`serve --deployment`), only its own
		// keys and only from a file no other account can change, so the wrapper must not source the whole file into its
		// environment (every worker secret, each read as this "shell's" and so winning over the file). The wrapper tests
		// this before its load; PI_ENV_SETUP below still runs when configured.
		envEntries.push("\t\t<key>PI_WRAPPER_NO_DOTENV</key>", "\t\t<string>1</string>");
	}
	if (ctx.envSetup) {
		// launchd has no EnvironmentFile and no shell in front of ProgramArguments, so the seam is a
		// VARIABLE the wrapper reads rather than a composed command line: nothing here has to be quoted
		// for a shell, and ProgramArguments stays byte-identical to the default render. The wrapper
		// sources it AFTER ./.env, so a secrets manager wins over a stale key left in the file.
		envEntries.push(
			"\t\t<!-- `pi-dispatch service --env-setup`: worker-env-wrapper.sh sources this file after ./.env.\n\t\t     A path, not a credential. Re-render to change it. -->",
			"\t\t<key>PI_ENV_SETUP</key>",
			`\t\t<string>${xmlText(ctx.envSetup)}</string>`,
		);
	}
	const workingDir = `<key>WorkingDirectory</key>\n\t<string>${xmlText(ctx.deployDir)}</string>`;
	plist = plist.replace(
		workingDir,
		() =>
			`${workingDir}\n\n\t<!-- Injected by \`pi-dispatch service\`: launchd's default PATH cannot see an nvm/Homebrew node,\n\t     and child processes may call bare \`node\`. Not a secrets dict - credentials still live only\n\t     in .env (see the header comment). -->\n\t<key>EnvironmentVariables</key>\n\t<dict>\n` +
			`${envEntries.join("\n")}\n\t</dict>`,
	);
	return plist;
}

/**
 * The nssm command sequence — deploy/nssm-install.cmd's exact steps with computed paths: the service
 * Application is the PACKAGE's .cmd wrapper, its AppParameters are the exec argv (<node> <script> …)
 * the wrapper now runs verbatim, and AppDirectory is the deployment folder so the wrapper finds ./.env
 * there (the same WorkingDirectory contract as launchd). Values that carry semantics
 * (AppStopMethodConsole 15000, AppThrottle 5000, AppExit Default Restart, AppExit 2 Exit) mirror the
 * template byte-for-byte and are pinned. Backslashes on purpose where paths are BUILT here: this argv
 * reaches nssm on a real Windows host, where deployDir is already a Windows path (wrapperCmd and
 * cliPath come from win32 path.join and need no help).
 */
function nssmSequence(ctx) {
	const service = `pi-dispatch-${ctx.which}`;
	const logDir = `${ctx.deployDir}\\logs`;
	const execArgv = execArgvFor(ctx);
	return {
		service,
		commands: [
			["install", service, ctx.wrapperCmd, ...execArgv],
			["set", service, "AppDirectory", ctx.deployDir],
			// Same seam as the plist's EnvironmentVariables dict, for the same reason: nssm takes a
			// NAME=VALUE with no shell between it and the wrapper, so the path needs no quoting and
			// AppParameters stays byte-identical to the default render.
			// The console's PI_WRAPPER_NO_DOTENV (issue #708) travels the same way, in the same one property (nssm takes
			// several NAME=VALUE words there).
			...(ctx.envSetup || ctx.which === "console" ? [["set", service, "AppEnvironmentExtra", ...(ctx.envSetup ? [`PI_ENV_SETUP=${ctx.envSetup}`] : []), ...(ctx.which === "console" ? ["PI_WRAPPER_NO_DOTENV=1"] : [])]] : []),
			["set", service, "AppStdout", `${logDir}\\${ctx.which}.out.log`],
			["set", service, "AppStderr", `${logDir}\\${ctx.which}.err.log`],
			["set", service, "AppStopMethodConsole", "15000"],
			["set", service, "AppThrottle", "5000"],
			["set", service, "AppExit", "Default", "Restart"],
			["set", service, "AppExit", "2", "Exit"],
		],
	};
}

async function doRender(ctx) {
	if (ctx.which === "receiver" && !ctx.receiverStart) return refuseMissingReceiver(ctx);
	if (ctx.which === "console" && !ctx.consoleEntry) return refuseMissingConsole(ctx);
	const unrenderable = renderRefusal(ctx);
	if (unrenderable !== null) return unrenderable;
	const paths = unitPaths(ctx);
	if (ctx.platform === "darwin") {
		ctx.out(`# → ${paths.installPath}\n`);
		ctx.out(renderPlist(ctx));
		ctx.out(
			ctx.which === "console"
				? "\n# note: ProgramArguments runs the package's worker-env-wrapper.sh, which (PI_WRAPPER_NO_DOTENV=1) sources NO\n# .env for the console: `serve --deployment` reads the console's own keys from it. The wrapper converts serve's\n# refusal (exit 2) into a clean exit, so KeepAlive leaves it stopped instead of relaunching it.\n"
				: "\n# note: ProgramArguments runs the package's worker-env-wrapper.sh, which sources ./.env in the\n# WorkingDirectory above and then runs the argv that follows it — launchd has no EnvironmentFile.\n# The wrapper also converts a policy refusal (exit 2, EXIT_POLICY) into a clean exit, so KeepAlive\n# never relaunch-loops a refusal into a provider bill.\n",
		);
		if (ctx.envSetup) {
			ctx.out(
				`# note: --env-setup is delivered as PI_ENV_SETUP above. The wrapper sources ${ctx.envSetup} AFTER\n# ./.env, so your manager wins over a stale value in the file, and a missing or failing script exits 1\n# rather than the exit 2 that means a policy refusal. With it set, ./.env becomes optional.\n`,
			);
		}
		return 0;
	}
	if (ctx.platform === "linux") {
		ctx.out(`# → ${paths.installPath}\n`);
		ctx.out(renderLinuxUnit(ctx));
		return 0;
	}
	const { service, commands } = nssmSequence(ctx);
	ctx.out("The nssm sequence for this host (nssm.exe: https://nssm.cc, or `winget install nssm`):\n\n");
	for (const args of commands) ctx.out(`  nssm ${quoteArgs(args)}\n`);
	ctx.out(`  nssm start ${service}\n`);
	return 0;
}

async function doInstall(ctx) {
	if (ctx.which === "receiver" && !ctx.receiverStart) return refuseMissingReceiver(ctx);
	if (ctx.which === "console" && !ctx.consoleEntry) return refuseMissingConsole(ctx);
	const unrenderable = renderRefusal(ctx);
	if (unrenderable !== null) return unrenderable;
	if (ctx.which === "console") {
		const refused = refuseConsoleWithoutOperator(ctx);
		if (refused !== null) return refused;
	}
	const paths = unitPaths(ctx);

	// THE refusal, worker only: one worker per docker daemon (DES-CONCURRENCY-3). The worker's boot
	// reaper treats every running pi-job container as an orphan of its OWN previous life and kills it,
	// so a second worker — even in the other scope — would reap the first worker's live jobs on every
	// restart. Receivers are exempt: a second receiver is pointless, not destructive.
	if (ctx.which === "worker") {
		const other = paths.otherScopeWorkerPaths?.find((p) => ctx.fs.existsSync(p));
		if (other) {
			return fail(
				ctx.err,
				`a worker unit already exists in the other scope: ${other}\n` +
					"one worker per docker daemon (DES-CONCURRENCY-3): the worker's boot reaper kills every pi-job container it did not start, so a second worker would kill the first's live jobs. Remove that unit first.",
			);
		}
	}

	if (ctx.platform === "darwin" || ctx.platform === "win32") {
		return ctx.platform === "darwin" ? installDarwin(ctx, paths) : installWindows(ctx);
	}
	if (ctx.scope === "system") return installLinuxSystem(ctx, paths);
	return installLinuxUser(ctx, paths);
}

async function installDarwin(ctx, paths) {
	// Root refusal (the svc.sh darwin precedent): sudo would bootstrap into ROOT's gui domain and
	// write root's LaunchAgents — a unit the operator's own session neither sees nor controls, running
	// outside the login session that owns Docker Desktop.
	if (ctx.euid === 0) {
		return fail(
			ctx.err,
			"refusing to run as root on macOS: the unit belongs in YOUR ~/Library/LaunchAgents, bootstrapped into your gui domain — sudo would install it for root, outside the login session that owns Docker Desktop. Re-run without sudo.",
		);
	}
	const existed = ctx.fs.existsSync(paths.installPath);
	if (existed && !ctx.force) {
		return fail(ctx.err, `${paths.installPath} already exists — pass --force to replace and re-bootstrap it (same non-clobber contract as init)`);
	}
	if (existed) {
		// --force replaces a possibly-loaded unit: bootstrap refuses an already-loaded label, so boot
		// the old copy out first. "Not loaded" is a fine answer — the nonzero exit is ignored.
		await run(ctx, "launchctl", ["bootout", `gui/${ctx.euid}/${paths.name}`]);
	}
	// Issue #464: a write that fails is said, with what this run left, rather than thrown out of the command. The plist
	// is the one file this path writes, so a failure leaves none of ours (a failed write is put back like the Linux path's).
	const journal = [];
	try {
		ctx.fs.mkdirSync(dirname(paths.installPath), { recursive: true });
		// launchd creates the StandardOutPath FILES but not their parent directory: without this the job
		// spawns and dies with its error unwritable. Done at install, not render: render stays read-only.
		ctx.fs.mkdirSync(join(ctx.deployDir, "logs"), { recursive: true });
		journalWrite(ctx.fs, journal, paths.installPath, renderPlist(ctx));
	} catch (err) {
		return fail(ctx.err, `could not write ${paths.installPath} (${err?.message ?? err}), so nothing was installed: ${describeRollBack(rollBackWrites(ctx.fs, journal))}`);
	}
	const bootstrap = await run(ctx, "launchctl", ["bootstrap", `gui/${ctx.euid}`, paths.installPath]);
	if (bootstrap !== 0) {
		return fail(ctx.err, `launchctl bootstrap failed (exit ${bootstrap}) — the plist is written; retry by hand: launchctl bootstrap gui/${ctx.euid} ${paths.installPath}`);
	}
	const enable = await run(ctx, "launchctl", ["enable", `gui/${ctx.euid}/${paths.name}`]);
	if (enable !== 0) return fail(ctx.err, `launchctl enable gui/${ctx.euid}/${paths.name} failed (exit ${enable})`);
	ctx.out(`installed ${paths.name} → ${paths.installPath} (bootstrapped into gui/${ctx.euid}; RunAtLoad starts it now and on login)\n`);
	// The honest note: no pretending a LaunchAgent is a boot daemon. It is the right fit anyway.
	// The Docker Desktop reason is the worker's (issue #708): the console starts no container, and telling its operator
	// about a docker socket would explain a choice by a fact that does not apply to it.
	ctx.out(
		ctx.which === "console"
			? "note: a LaunchAgent is LOGIN-scoped — it runs while you are logged in, not from boot, which is when a browser on this Mac can reach it.\n"
			: "note: a LaunchAgent is LOGIN-scoped — it runs while you are logged in, not from boot. That is the honest fit here: Docker Desktop is itself login-scoped, so a boot-time daemon would only wait on a docker socket that appears at login anyway.\n",
	);
	return 0;
}

async function installLinuxUser(ctx, paths) {
	if (ctx.fs.existsSync(paths.installPath) && !ctx.force) {
		return fail(ctx.err, `${paths.installPath} already exists — pass --force to replace it (same non-clobber contract as init)`);
	}
	// Issue #464: a write that fails is said, with what this run left, rather than thrown out of the command. The unit
	// is the one file this path writes, journalled before it is written, so a failed write leaves none of ours.
	const journal = [];
	const writeUnit = () => {
		try {
			ctx.fs.mkdirSync(dirname(paths.installPath), { recursive: true });
			journalWrite(ctx.fs, journal, paths.installPath, renderLinuxUnit(ctx));
			return { ok: true };
		} catch (err) {
			return { ok: false, failed: `write ${paths.installPath}`, code: null, message: err?.message };
		}
	};
	const writtenList = () => [...new Set(journal.map((e) => e.path))].join(", ") || "none";
	const wrote = writeUnit();
	if (!wrote.ok) return fail(ctx.err, `${wrote.failed} failed (${wrote.message}), so nothing was installed: ${describeRollBack(rollBackWrites(ctx.fs, journal))}. Fix it, then re-run this install`);
	const reload = await run(ctx, "systemctl", ["--user", "daemon-reload"]);
	if (reload === null) return fail(ctx.err, `systemctl not found: is this a systemd host? The unit is written at ${paths.installPath} (files this run wrote, which remain: ${writtenList()})`);
	const enable = await run(ctx, "systemctl", ["--user", "enable", "--now", paths.name]);
	if (enable !== 0) {
		return fail(ctx.err, `systemctl --user enable --now ${paths.name} failed (exit ${enable}); the unit is written at ${paths.installPath}; \`systemctl --user status ${paths.name}\` has the details (files this run wrote, which remain: ${writtenList()})`);
	}
	ctx.out(`installed ${paths.name} → ${paths.installPath} (enabled and started in your user manager)\n`);
	// Without linger a user manager only runs while a session exists — fine on a desktop, a silent
	// no-worker-after-reboot on a headless box. Say so instead of letting the operator find out.
	ctx.out(`note: user units run while you have a session. For a headless host that must start at boot:  sudo loginctl enable-linger ${ctx.user}\n`);
	return 0;
}

async function installLinuxSystem(ctx, paths) {
	if (ctx.fs.existsSync(paths.installPath) && !ctx.force) {
		return fail(ctx.err, `${paths.installPath} already exists — pass --force to re-stage the render (the printed sudo commands would overwrite it)`);
	}
	// The pm2-startup pattern: this tool NEVER writes or spawns as root. The render is staged where
	// the operator can read it, and the exact commands are printed — their shell is the consent gate.
	const staged = join(ctx.tmp, paths.name);
	ctx.fs.writeFileSync(staged, renderLinuxUnit(ctx));
	ctx.out(`--system never runs root commands from this tool. The rendered unit is staged at:\n  ${staged}\n\nInspect it, then run:\n  sudo install -m 644 ${staged} ${paths.installPath}\n  sudo systemctl daemon-reload\n  sudo systemctl enable --now ${paths.name}\n`);
	return 0;
}

async function installWindows(ctx) {
	const { service, commands } = nssmSequence(ctx);
	// One probe answers two questions: is nssm on PATH (ENOENT → no), and does the service already
	// exist (exit 0 → yes). Task Scheduler is deliberately never offered — it stops tasks with a hard
	// kill, so the worker could never drain (see deploy/nssm-install.cmd's rationale).
	const status = await runCapture(ctx, "nssm", ["status", service]);
	if (status.code === null) {
		return fail(ctx.err, "nssm.exe not found on PATH — download it from https://nssm.cc (or `winget install nssm`) and re-run. Task Scheduler is not a substitute: it kills instead of stopping, so the worker could never drain.");
	}
	if (status.code === 0 && !ctx.force) {
		return fail(ctx.err, `service ${service} already exists (nssm status reports it) — pass --force to remove and re-install it`);
	}
	if (status.code === 0) {
		await run(ctx, "nssm", ["stop", service]); // may already be stopped; nonzero is fine
		const removed = await run(ctx, "nssm", ["remove", service, "confirm"]);
		if (removed !== 0) return fail(ctx.err, `nssm remove ${service} confirm failed (exit ${removed})`);
	}
	// nssm, like launchd, does not create the AppStdout/AppStderr directory. join(), not the
	// sequence's literal backslashes: this branch runs on the actual Windows host, where join is
	// win32-flavoured anyway.
	ctx.fs.mkdirSync(join(ctx.deployDir, "logs"), { recursive: true });
	for (const args of commands) {
		const code = await run(ctx, "nssm", args);
		if (code !== 0) return fail(ctx.err, `nssm ${args.join(" ")} failed (exit ${code})`);
	}
	// Mirrors the template's own last line: install registers, `nssm start` is the one visible step
	// left to the operator (the service auto-starts on the next boot either way).
	ctx.out(`installed service ${service}. Start it with:  nssm start ${service}\n`);
	return 0;
}

async function doUninstall(ctx) {
	const paths = unitPaths(ctx);
	if (ctx.platform === "win32") {
		const status = await runCapture(ctx, "nssm", ["status", paths.name]);
		if (status.code === null) return fail(ctx.err, "nssm.exe not found on PATH — it is also how uninstall talks to the service manager (https://nssm.cc)");
		if (status.code !== 0) return fail(ctx.err, `service ${paths.name} is not installed (\`nssm status ${paths.name}\` reports none)`);
		await run(ctx, "nssm", ["stop", paths.name]); // already-stopped is fine
		const removed = await run(ctx, "nssm", ["remove", paths.name, "confirm"]);
		if (removed !== 0) return fail(ctx.err, `nssm remove ${paths.name} confirm failed (exit ${removed})`);
		ctx.out(`uninstalled service ${paths.name}\n`);
		return 0;
	}
	const userPath = ctx.platform === "darwin" ? paths.installPath : paths.userPath;
	// No user manager to talk to (`sudo -iu`, round 3 D3, measured): every `systemctl --user` below would fail, and the
	// old code ignored the exits, printed success with exit 0, and left the worker running with a dangling
	// default.target.wants link. Refused before anything is touched, whenever this run would talk to it.
	if (ctx.platform === "linux" && ctx.fs.existsSync(userPath)) {
		const bus = userBusRefusal({ env: ctx.env, user: ctx.user, euid: ctx.euid });
		if (bus) return fail(ctx.err, bus.replace("so `systemctl --user` would fail after the files were written", "so `systemctl --user` could stop and disable nothing"));
	}
	if (!ctx.fs.existsSync(userPath)) {
		// Say where it looked — both scopes — and if the unit turns out to live in ROOT scope, print
		// the removal commands instead of touching them (the same never-root doctrine as install).
		if (ctx.fs.existsSync(paths.systemPath)) {
			const rootCmds =
				ctx.platform === "darwin"
					? `  sudo launchctl bootout system/${paths.name}\n  sudo rm ${paths.systemPath}`
					: `  sudo systemctl disable --now ${paths.name}\n  sudo rm ${paths.systemPath}\n  sudo systemctl daemon-reload`;
			return fail(ctx.err, `not installed in user scope (looked at ${userPath}); a SYSTEM-scope unit exists at ${paths.systemPath} — this tool never touches root scope. Remove it with:\n${rootCmds}`);
		}
		return fail(ctx.err, `${paths.name} is not installed — looked at ${userPath} (user scope) and ${paths.systemPath} (system scope)`);
	}
	if (ctx.platform === "darwin") {
		await run(ctx, "launchctl", ["bootout", `gui/${ctx.euid}/${paths.name}`]); // not-loaded is fine
		ctx.fs.unlinkSync(userPath);
		ctx.out(`uninstalled ${paths.name} (booted out of gui/${ctx.euid}, plist removed)\n`);
		return 0;
	}
	// A non-zero exit here is a unit that is still enabled or still running (round 3, D3): nothing is removed and nothing
	// is claimed. `disable --now` on an installed unit that is merely not enabled exits 0.
	const disabled = await run(ctx, "systemctl", ["--user", "disable", "--now", paths.name]);
	if (disabled !== 0) {
		return fail(ctx.err, `systemctl --user disable --now ${paths.name} failed (${disabled === null ? "systemctl not found" : `exit ${disabled}`}), so nothing was removed: the worker may still be running. \`systemctl --user status ${paths.name}\` has the details`);
	}
	ctx.fs.unlinkSync(userPath);
	const reload = await run(ctx, "systemctl", ["--user", "daemon-reload"]);
	if (reload !== 0) {
		return fail(ctx.err, `${paths.name} is disabled, stopped and its unit file removed, but systemctl --user daemon-reload failed (${reload === null ? "systemctl not found" : `exit ${reload}`}): run it yourself`);
	}
	ctx.out(`uninstalled ${paths.name} (disabled, stopped, unit removed)\n`);
	return 0;
}

/** Informational only — reports every scope it knows about and always exits 0. */
async function doStatus(ctx) {
	const paths = unitPaths(ctx);
	if (ctx.platform === "win32") {
		const status = await runCapture(ctx, "nssm", ["status", paths.name]);
		if (status.code === null) ctx.out(`${paths.name}: cannot query — nssm.exe not on PATH (https://nssm.cc)\n`);
		else if (status.code !== 0) ctx.out(`${paths.name}: not installed\n`);
		else ctx.out(`${paths.name}: ${status.output.trim()}\n`);
		if (status.code === 0) {
			const extra = await runCapture(ctx, "nssm", ["get", paths.name, "AppEnvironmentExtra"]);
			const setup = extra.code === 0 ? readUnitSeam(extra.output, "win32").setup : null;
			if (setup) ctx.out(`env-setup: ${setup} (named by ${paths.name}'s AppEnvironmentExtra)\n`);
		}
		return 0;
	}
	if (ctx.platform === "darwin") {
		if (ctx.fs.existsSync(paths.installPath)) {
			const print = await runCapture(ctx, "launchctl", ["print", `gui/${ctx.euid}/${paths.name}`]);
			ctx.out(`user scope: ${paths.installPath} — ${print.code === 0 ? "loaded" : "installed but NOT loaded (launchctl bootstrap it, or `pi-dispatch service start`)"}\n`);
		} else {
			ctx.out(`user scope: not installed (${paths.installPath})\n`);
		}
		ctx.out(ctx.fs.existsSync(paths.systemPath) ? `system scope: ${paths.systemPath} EXISTS — not managed by this tool\n` : "system scope: none\n");
		reportEnvSetup(ctx, [paths.installPath, paths.systemPath]);
		return 0;
	}
	if (ctx.fs.existsSync(paths.userPath)) {
		const active = await runCapture(ctx, "systemctl", ["--user", "is-active", paths.name]);
		ctx.out(`user scope: ${paths.userPath} — ${active.code === null ? "systemctl not found" : active.output.trim() || "unknown"}\n`);
	} else {
		ctx.out(`user scope: not installed (${paths.userPath})\n`);
	}
	const systemHits = [paths.systemPath, ...(ctx.which === "worker" ? ["/etc/systemd/system/worker.service"] : [])].filter((p) => ctx.fs.existsSync(p));
	ctx.out(systemHits.length ? `system scope: ${systemHits.join(", ")} EXISTS — not managed by this tool\n` : "system scope: none\n");
	reportEnvSetup(ctx, [paths.userPath, ...systemHits]);
	return 0;
}

/**
 * One informational line per unit that names an `--env-setup` script (issue #216). status REPORTS: it
 * says where the seam is configured, and nothing about whether the script is still there, still
 * private, or still uncommitted. Those are `doctor`'s — it is the preflight, it owns the warn tiers,
 * and it already has the git check-ignore seam. Prints nothing when no seam is configured, so the
 * output of every deployment that does not use one is byte-identical to before.
 */
function reportEnvSetup(ctx, paths) {
	for (const path of paths) {
		if (!ctx.fs.existsSync(path)) continue;
		let setup = null;
		try {
			setup = readUnitSeam(ctx.fs.readFileSync(path, "utf8"), ctx.platform).setup;
		} catch {
			// Unreadable — a system-scope unit this user may not read is the ordinary case. The scope line
			// above already reported that it exists; status never fails on what it could not look at.
		}
		if (setup) ctx.out(`env-setup: ${setup} (named by ${path})\n`);
	}
}

async function doStart(ctx) {
	return startStop(ctx, "start");
}

async function doStop(ctx) {
	return startStop(ctx, "stop");
}

/**
 * Thin per-OS start/stop. macOS stop is `launchctl kill SIGTERM`, NOT bootout: bootout unloads the
 * unit entirely, while kill delivers the same graceful SIGTERM systemd's stop does — the worker
 * drains, exits 0, and KeepAlive's SuccessfulExit=false leaves a clean exit stopped.
 */
async function startStop(ctx, verb) {
	const paths = unitPaths(ctx);
	if (ctx.platform === "linux" && ctx.scope === "system") {
		return fail(ctx.err, `--system is print-only (this tool never runs root commands). Run:\n  sudo systemctl ${verb} ${paths.name}`);
	}
	let code;
	if (ctx.platform === "darwin") {
		if (verb === "start" && ctx.setupExpected?.loaded === false) {
			const loaded = await run(ctx, "launchctl", ["bootstrap", `gui/${ctx.euid}`, paths.installPath]);
			if (loaded !== 0) return fail(ctx.err, "the previewed LaunchAgent could not be loaded");
		}
		code =
			verb === "start"
				? await run(ctx, "launchctl", ["kickstart", `gui/${ctx.euid}/${paths.name}`])
				: await run(ctx, "launchctl", ["kill", "SIGTERM", `gui/${ctx.euid}/${paths.name}`]);
	} else if (ctx.platform === "linux") {
		code = await run(ctx, "systemctl", ["--user", verb, paths.name]);
	} else {
		code = await run(ctx, "nssm", [verb, paths.name]);
	}
	if (code !== 0) return fail(ctx.err, `${verb} ${paths.name} failed (${code === null ? "service tool not found" : `exit ${code}`}) — is it installed? (pi-dispatch service status)`);
	ctx.out(`${verb === "start" ? "started" : "stopped"} ${paths.name}\n`);
	return 0;
}

async function doRestart(ctx, values) {
	if (!values.drain) {
		const stopped = await doStop(ctx);
		if (stopped !== 0) return stopped;
		return doStart(ctx);
	}

	const timeoutS = Number(values["drain-timeout"] ?? "600");
	if (!Number.isFinite(timeoutS) || timeoutS <= 0) {
		return fail(ctx.err, `--drain-timeout must be a positive number of seconds, got: ${values["drain-timeout"]}`);
	}
	let queue = ctx.queue;
	let url;
	if (!queue) {
		// VALKEY_URL only, exactly like cli.mjs's pause/resume: the drain must work even when the rest
		// of the config (forge auth …) is broken, and failFast keeps a down Valkey an error in seconds
		// instead of a hung restart. Lazy imports for the same reason cli.mjs uses them: `service`
		// subcommands that never touch the queue must not load bullmq/ioredis.
		// This shell's VALKEY_URL, else the deployment .env's (PR #475's review), as every CLI verb reads it.
		const { cliValkeyUrl, parseConnection } = await import("./connection.mjs");
		url = cliValkeyUrl(ctx.env, { cwd: ctx.deployDir, warn: (line) => ctx.err(line) });
		const { makeQueue } = await import("./queue.mjs");
		queue = makeQueue(parseConnection(url, { failFast: true }));
	}
	try {
		await queue.pause();
		ctx.out("paused — no new jobs will start; waiting for active jobs to finish\n");
		const deadline = ctx.now() + timeoutS * 1000;
		let { active = 0 } = await queue.getJobCounts("active");
		while (active > 0) {
			if (ctx.now() >= deadline) {
				// Deliberately NO resume and NO restart: a job is still running. Restarting would abort
				// it; resuming would feed new jobs toward a restart that is still owed. Paused is the
				// safe durable state (it survives the restart the operator will now do by hand).
				ctx.out(
					`drain timed out after ${timeoutS}s with ${active} job(s) still active — NOT restarting.\nThe queue STAYS PAUSED so the running job can finish undisturbed. Investigate (pi-dispatch status), then restart and \`pi-dispatch resume\` yourself.\n`,
				);
				return 1;
			}
			ctx.out(`  ${active} active — waiting\n`);
			await ctx.sleep(2000);
			({ active = 0 } = await queue.getJobCounts("active"));
		}
		// A HELD job is neither active nor waiting, so the loop above has just reported a drained queue with
		// however many jobs still parked on `run.waitFor` (issue #230). They are safe -- a hold spends
		// nothing, survives a restart and reserves no slot -- but the operator is upgrading, and those jobs
		// will wake against the new version. Said plainly rather than left to be discovered, which is what
		// this command would otherwise be doing: reporting a drained queue it cannot see all of.
		const delayed = await queue.getJobCounts("delayed").then((c) => Number(c?.delayed ?? 0), () => 0);
		if (delayed > 0) {
			ctx.out(`note: ${delayed} job(s) sit in the delayed set (cron next-occurrences, retry backoff, quiet hours, scope/host deferrals, or jobs held on run.waitFor). None is active, so none blocked this drain; they will wake against the new version.\n`);
		}
		const stopped = await doStop(ctx);
		if (stopped !== 0) {
			ctx.out("restart did not happen — the queue STAYS PAUSED; fix the service, then `pi-dispatch resume`.\n");
			return 1;
		}
		const started = await doStart(ctx);
		if (started !== 0) {
			ctx.out("the service did not come back — the queue STAYS PAUSED; fix the service, then `pi-dispatch resume`.\n");
			return 1;
		}
		await queue.resume();
		ctx.out("resumed — drained restart complete\n");
		return 0;
	} catch (error) {
		return fail(ctx.err, `could not reach Valkey: ${(await import("./valkey-auth.mjs")).valkeyDownHint(url)}\n  ${error.message}`);
	} finally {
		await queue.close().catch(() => {});
	}
}

/** The first executable regular file named `name` in a PATH string, or null (issue #707's lookup seam's default). */
export function findOnPath(name, path, { access = (p) => accessSync(p, fsConstants.X_OK), isFile = (p) => statSync(p).isFile() } = {}) {
	for (const dir of String(path ?? "").split(delimiter)) {
		if (dir === "" || !dir.startsWith("/")) continue;
		const candidate = join(dir, name);
		try {
			access(candidate);
			if (isFile(candidate)) return candidate;
		} catch {}
	}
	return null;
}

function fail(err, message) {
	err(`error: ${message}\n`);
	return 1;
}

/** Re-join an argv for display; quote what cmd.exe would split (spaces) or what is a path (backslashes). */
function quoteArgs(args) {
	return args.map((a) => (a.includes(" ") || a.includes("\\") ? `"${a}"` : a)).join(" ");
}

/** Exit code of a spawned command; null when it could not launch (not on PATH) — the up.mjs pattern. */
function run(ctx, cmd, args) {
	return new Promise((resolvePromise) => {
		let child;
		try {
			child = ctx.spawn(cmd, args, { stdio: "ignore" });
		} catch {
			resolvePromise(null);
			return;
		}
		child.on("error", () => resolvePromise(null));
		child.on("close", (code) => resolvePromise(code));
	});
}

/**
 * Like runCapture() with the two streams SEPARATE, for a query whose answer is stdout alone (round 2, E2): a tool that
 * prints warnings on stderr on ordinary accounts would, merged into the answer, corrupt whatever reads it.
 */
function runQuery(ctx, cmd, args) {
	return new Promise((resolvePromise) => {
		let child;
		try {
			child = ctx.spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
		} catch {
			resolvePromise({ code: null, stdout: "", stderr: "" });
			return;
		}
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (d) => (stdout += d));
		child.stderr?.on("data", (d) => (stderr += d));
		child.on("error", () => resolvePromise({ code: null, stdout, stderr }));
		child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
	});
}

/** Like run() but with stdout+stderr captured, for read-only lookups (nssm status, is-active …). */
function runCapture(ctx, cmd, args) {
	return new Promise((resolvePromise) => {
		let child;
		try {
			child = ctx.spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
		} catch {
			resolvePromise({ code: null, output: "" });
			return;
		}
		let output = "";
		child.stdout?.on("data", (d) => (output += d));
		child.stderr?.on("data", (d) => (output += d));
		child.on("error", () => resolvePromise({ code: null, output }));
		child.on("close", (code) => resolvePromise({ code, output }));
	});
}
