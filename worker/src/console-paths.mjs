/**
 * Where the operator console and its tokens live, for the commands that only need to LOOK (`up`, `doctor`).
 *
 * Host-service installation is gone (deployment is Linux containers, docker compose only), so this module keeps the
 * path resolution the surviving commands share: the admin package's entry, the deployment's console tokens file, the
 * operator count in it, and a PATH lookup. Nothing here renders or installs anything.
 */
import { accessSync, constants as fsConstants, existsSync, readFileSync, statSync } from "node:fs";
import { basename, delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { operatorCount, readTokensFile, tokensFilePath } from "./console-tokens.mjs";
import { deploymentServiceEnv } from "./service-env.mjs";
import * as nodeFs from "node:fs";

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
 * but pnpm and Volta put a SHIM on PATH (a shell script, or a binary that picks a version at run time), and a command
 * that ran `node <shim>` would crash at every start. The real path, not the PATH name. `findOnPath` reads only absolute
 * POSIX directories, so on Windows this lookup does not run and resolution is the only way.
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
 * The console tokens file the console of the deployment in `deployDir` reads (issue #708): PI_CONSOLE_TOKENS_FILE
 * from the deployment `.env` (through the reader the console itself uses), else console-tokens.json there. Never this
 * shell's export: `up` and doctor describe the deployment's console, not the one this shell happens to point at.
 */
export function consoleTokensPathFor(deployDir, platform) {
	const { env } = deploymentServiceEnv({ env: {}, dir: deployDir, keys: ["PI_CONSOLE_TOKENS_FILE"], platform, fs: nodeFs });
	return tokensFilePath(env, deployDir);
}

/**
 * How many operator tokens the console of the deployment in `deployDir` would find (issue #708): `{ path, operators }`
 * or `{ path, refusal }`. The tokens file is where `serve --deployment <deployDir>` looks: PI_CONSOLE_TOKENS_FILE as
 * the DEPLOYMENT sees it (its `.env`, through the reader the console itself uses), never this shell's export.
 * Read with the real filesystem on purpose: `readTokensFile` judges the file the way `serve` does (owner-only,
 * regular, no symlink), and a fake that answered differently would prove nothing.
 */
export function readConsoleOperators(deployDir, platform) {
	const path = consoleTokensPathFor(deployDir, platform);
	const read = readTokensFile({ path });
	return read.refusal ? { path, refusal: read.refusal } : { path, operators: operatorCount(read.file) };
}

/**
 * The first executable regular file named `name` on `path` (a PATH value), or null. Only absolute POSIX directories
 * are read, so a Windows PATH is not searched: the caller's own resolution is the only lookup there.
 */
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
