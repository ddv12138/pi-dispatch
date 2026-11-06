/**
 * Where a pi binary and its version are resolved on this host: `pi-dispatch updates look` reports this host's own pi
 * (`updates-look.mjs`'s `hostPiFacts`) and must find and read the same pi the operator runs.
 *
 * `resolvePiBinary` picks the binary (`--pi`, else `pi` on the operator's PATH, else the installed
 * `@earendil-works/pi-coding-agent`); `piVersionOf` reads it with `--version`. Every child here is given `childEnv`'s
 * environment: this process's, minus every `PI_CONSOLE_*` variable — the console's token and address are this
 * command's credentials, and anything pi runs or loads must never read them.
 */
import * as nodeFs from "node:fs";
import { spawnSync as nodeSpawnSync } from "node:child_process";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** What to run when no pi is found. */
const PI_INSTALL_HINT = "install pi (npm install -g @earendil-works/pi-coding-agent) or pass --pi <path>";

/**
 * The environment a child (`pi --version`) is given: this shell's, minus every `PI_CONSOLE_*` variable. The console
 * token and address are this command's credentials; anything pi runs or loads must never read them.
 */
function childEnv(env = process.env) {
	const kept = {};
	for (const [name, value] of Object.entries(env ?? {})) if (!/^PI_CONSOLE_/.test(name)) kept[name] = value;
	return kept;
}

/**
 * The pi binary to run: `--pi` (it must be an executable file), else `pi` on PATH, else the
 * `@earendil-works/pi-coding-agent` this package can resolve (its `bin.pi`), else `{refusal}` with the install hint.
 * Returns `{path, from}`.
 */
export function resolvePiBinary({ flag = null, env = process.env, fs = nodeFs, resolvePackage = defaultResolvePackage, platform = process.platform } = {}) {
	const executable = (p) => {
		try {
			const st = fs.statSync(p);
			if (!st.isFile()) return false;
			if (platform === "win32") return true;
			fs.accessSync(p, nodeFs.constants.X_OK);
			return true;
		} catch {
			return false;
		}
	};
	if (typeof flag === "string" && flag !== "") {
		const p = resolve(flag);
		return executable(p) ? { path: p, from: "--pi" } : { refusal: `--pi ${p} is not an executable file` };
	}
	const names = platform === "win32" ? ["pi.cmd", "pi.exe", "pi"] : ["pi"];
	// env-internal PATH: the operator's own command search path, to find the pi they run themselves.
	for (const dir of String(env.PATH ?? "").split(delimiter)) {
		if (dir === "" || !isAbsolute(dir)) continue;
		for (const name of names) if (executable(join(dir, name))) return { path: join(dir, name), from: "PATH" };
	}
	const installed = resolvePackage();
	if (installed && executable(installed)) return { path: installed, from: "the installed @earendil-works/pi-coding-agent" };
	return { refusal: `no pi to run: ${PI_INSTALL_HINT}` };
}

/** The installed pi-coding-agent's `bin.pi`, or null. pi exports no package.json, so its entry is walked up from. */
function defaultResolvePackage() {
	try {
		let dir = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
		for (let i = 0; i < 6; i += 1) {
			const pkg = join(dir, "package.json");
			if (nodeFs.existsSync(pkg)) {
				const json = JSON.parse(nodeFs.readFileSync(pkg, "utf8"));
				if (json?.name === "@earendil-works/pi-coding-agent" && typeof json?.bin?.pi === "string") return join(dir, json.bin.pi);
			}
			dir = dirname(dir);
		}
	} catch {
		// not installed beside this package
	}
	return null;
}

/** The host pi's version from `<pi> --version` (an exact x.y.z on its first line), or null. */
export function piVersionOf(piPath, { spawnSync = nodeSpawnSync, env = process.env } = {}) {
	try {
		const got = spawnSync(piPath, ["--version"], { encoding: "utf8", timeout: 15_000, env: childEnv(env), stdio: ["ignore", "pipe", "ignore"] });
		const first = String(got?.stdout ?? "").trim().split("\n")[0]?.trim() ?? "";
		return got?.status === 0 && VERSION_RE.test(first) ? first : null;
	} catch {
		return null;
	}
}
