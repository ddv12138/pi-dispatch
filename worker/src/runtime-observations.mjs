/**
 * The runtime observations (issue #345): what THIS HOST's daemon is observed to do about a container's bounds and its
 * mounts, turned into the `daemonAppliesBounds` and `runtimeAddsNoMounts` answers `backends.mjs`'s `effectiveWord`
 * reads. No container runs and no second daemon call is made: the bounds come from the one `docker info` read the job
 * user is decided from (`job-user.mjs`), and the mounts from the daemon's own shape.
 *
 * THREE ANSWERS, NEVER TWO. `true` earns the declared word; `false` degrades it to `asserted`, and a floor asking for
 * `enforced` refuses; `null` is NOT ANSWERED (the daemon did not answer, or answered in a shape nothing reads), which a
 * floor turns into a retry rather than a refusal, the endpoint read's transient rule. No credit is ever given for a
 * missing or unreadable fact: the polarity every observation in `backends.mjs` keeps.
 *
 * The evidence strings are fixed text plus a file path or a daemon field NAME, never a value the daemon or a file
 * carries, so they can be logged and put in a refusal.
 */

import { DAEMON_APPLIES_BOUNDS, DOCKER_ENDPOINT_LOCAL, RUNTIME_ADDS_NO_MOUNTS } from "./backends.mjs";

/**
 * The override for Podman's default mount list. When it exists, Podman reads it instead of
 * `/usr/share/containers/mounts.conf`, and an EMPTY one mounts nothing (measured on rootful Podman 5.8.2: `/run/secrets`
 * disappears from `/proc/self/mountinfo`).
 */
export const PODMAN_MOUNTS_CONF = "/etc/containers/mounts.conf";

/**
 * The system containers.conf chain a rootful Podman reads (containers/common v0.67.0 `systemConfigs`): the vendor file,
 * the `/etc` file and every `*.conf` in `/etc/containers/containers.conf.d`. Measured for issue #448 (gate round 1 of PR
 * #473) with a drop-in in each candidate place, on rootful Podman 5.8.1 and 4.9.3, through the API service and the root
 * podman CLI alike: `/usr/share/containers/containers.conf.d` and both `containers.rootful.conf.d` directories were NOT
 * read, so they are not on the chain. Root's own conf, `--module` files and `CONTAINERS_CONF` are added by
 * `rootfulConfChain`. Not `default_mounts_file`: that is not a containers.conf key (`toml:"-"`), only a hidden flag.
 */
export const PODMAN_CONTAINERS_CONF_FILES = Object.freeze(["/usr/share/containers/containers.conf", "/etc/containers/containers.conf"]);
export const PODMAN_CONTAINERS_CONF_DIRS = Object.freeze(["/etc/containers/containers.conf.d"]);

/** FIPS mode adds the host's crypto policy mounts outside `mounts.conf` (container-libs pkg/subscriptions). */
export const FIPS_ENABLED_PATH = "/proc/sys/crypto/fips_enabled";

/**
 * A key that adds to every container what no argv names: `volumes`, `mounts`, `devices` (host device nodes) and
 * `hooks_dir` (OCI hooks, which can mount). Matched in ANY LETTER CASE (Podman's TOML decoding matches keys
 * case-insensitively: `Volumes` and `CONTAINERS.VOLUMES` both mount, measured on Podman 5.8.2), bare or quoted at the start
 * of a line, dotted (`containers.volumes = [...]`), or inside an inline table (`containers = { volumes = [...] }`), on any
 * line that is not a whole-line comment: a `#` inside a string earlier on the line is not a comment (measured, an
 * `env = ["X=#"]` before the key still mounts). Wider than Podman's own reading on purpose: a string value or a trailing
 * comment that merely contains `volumes =` also matches, which withholds credit rather than giving it.
 */
export const MOUNT_KEY = /^(?!\s*#).*?(?:^|[\s.{,"'])["']?(?:volumes|mounts|devices|hooks_dir)["']?\s*=/im;

/**
 * A quoted TOML key holding a backslash escape (`"volum\u0065s" = ...`), which TOML reads as the unescaped name and
 * `MOUNT_KEY` cannot see through, on any line that is not a whole-line comment. Refused outright rather than decoded: no
 * containers.conf needs one.
 */
export const ESCAPED_KEY = /^(?!\s*#).*?["'][^"'\n]*\\[^"'\n]*["']\s*=/m;

/**
 * A file this check cannot read the way Podman's TOML decoder does, on any line, comment or not (issue #428): a non-ASCII
 * character or a multi-line string opener. Each was measured bypassing the key patterns while Podman honoured the key:
 * Go's case folding matches `"pa\u017fta_options"` (a LONG S) to `pasta_options` where a JS `/i` does not; a `"""` or
 * `'''` string whose content has a line starting `#` reads here as a comment and there as a string, so a key after it
 * on the same TOML line is hidden; and U+2028 or U+2029 inside a string is a line break to a JS regex and not to TOML.
 * Refused outright rather than decoded, as `ESCAPED_KEY` is: a stock containers.conf is plain ASCII with no multi-line
 * string (Fedora 44's, and containers/common v0.57.4's, which Ubuntu 24.04 packages), so the rule costs nothing real.
 */
export const UNREAD_SPELLING = /[^\x00-\x7f]|"""|'''/;

/**
 * The first line (1-based, split on `\n` only, as TOML counts lines) holding an `UNREAD_SPELLING`, as `{ line, kind }`
 * with `kind` `"non-ascii"` or `"multi-line"` (a line holding both is named for its non-ASCII character), or `null`.
 * So a refusal can say WHERE, and which of the two, rather than send an operator through the whole file.
 */
export function unreadSpelling(text) {
	const lines = String(text).split("\n");
	for (let i = 0; i < lines.length; i++) {
		if (/[^\x00-\x7f]/.test(lines[i])) return { line: i + 1, kind: "non-ascii" };
		if (/"""|'''/.test(lines[i])) return { line: i + 1, kind: "multi-line" };
	}
	return null;
}

/**
 * The read errors that say nothing about the file, only about this moment (issue #428): out of descriptors or memory,
 * an I/O error, a busy or stale mount, an interrupted or timed-out call. A conf file or drop-in directory that fails
 * with one of these is NOT ANSWERED (`null`, so a floor retries and the podman venue's refusal retries) rather than
 * withheld (`false`, refused): refusing it turned a full descriptor table into a dropped job. Every other code
 * (`EACCES`, `EPERM`, `ENOTDIR`, `ELOOP`, `EISDIR`, an unknown one) stays determinate, the precedent, because a retry
 * reads the same permissions; listed this way round so an errno nobody thought of fails closed, not into a retry loop.
 */
export const TRANSIENT_READ_ERRORS = new Set(["EMFILE", "ENFILE", "EIO", "EAGAIN", "EWOULDBLOCK", "EBUSY", "ENOMEM", "EINTR", "ETIMEDOUT", "ESTALE"]);

/**
 * A host file or directory an observation could not read, as a finding: `null` for a transient code, carrying
 * `reason: "file-unread"` so the retry names a file rather than a daemon, else `false`. The ONE rule for every file an
 * observation reads (round 2 of the #428 review: the conf chain had it and its sibling reads, mounts.conf, the hooks
 * directories and the FIPS file, still turned EMFILE into a floor refusal that dropped the job).
 */
export function unreadFileFinding(path, code) {
	return TRANSIENT_READ_ERRORS.has(code) ? { value: null, evidence: `${path} could not be read (${code})`, reason: "file-unread" } : { value: false, evidence: `${path} could not be read (${code})` };
}

/** OCI hook directories Podman runs every `*.json` hook from (container-libs pkg/config); a hook can mount into a container. */
export const PODMAN_HOOKS_DIRS = Object.freeze(["/usr/share/containers/oci/hooks.d", "/etc/containers/oci/hooks.d"]);

/** What a containers.conf matching `MOUNT_KEY` is said to do, the evidence `observeRuntimeMounts` has always given. */
export const MOUNT_KEY_SAYS = "sets a volumes, mounts, devices or hooks_dir key, which Podman applies to every container";

/**
 * One host file's text, as `{ text }`, or `{ missing, error }` when it could not be read. Exported (issue #354) so the
 * rootless podman venue's observations read files by the one rule the rootful ones do.
 */
export function readHostFile(fs, path) {
	try {
		return { text: fs.readFileSync(path, "utf8") };
	} catch (error) {
		return { missing: error?.code === "ENOENT", error: error?.code ?? "error" };
	}
}

/**
 * FIPS mode as a finding: `{ value: false, evidence }` when it is on or its file cannot be read, `null` when it is off or
 * the kernel has no such file. FIPS mode mounts the host's crypto policy into every Podman container, rootful or not.
 */
export function fipsFinding(fs) {
	const fips = readHostFile(fs, FIPS_ENABLED_PATH);
	if (!fips.missing && fips.text === undefined) return unreadFileFinding(FIPS_ENABLED_PATH, fips.error);
	if (String(fips.text ?? "").trim() === "1") return { value: false, evidence: "FIPS mode is on, and Podman then mounts the host's crypto policy into every container" };
	return null;
}

/**
 * Whether `path` is a directory (following a symlink, as Podman's own walk does), so a directory named `x.conf` in a
 * drop-in directory is skipped the way Podman skips it (gate round 2 of PR #473: it was refused with EISDIR). A stat that
 * fails, or a fake without `isDirectory`, reads as a file, whose own read then says what it is.
 */
export function isDirectoryAt(fs, path) {
	try {
		return fs.statSync(path)?.isDirectory?.() === true;
	} catch {
		return false;
	}
}

/**
 * The containers.conf files Podman would read from `files` and every `*.conf` in `dirs` (sorted per directory, missing
 * directories skipped), as `{ files }`, or `{ finding }` when a directory exists and cannot be listed: a drop-in nobody
 * could see must withhold credit, not read as none.
 */
export function confFilesIn(fs, { files = [], dirs = [] }) {
	const out = [...files];
	for (const dir of dirs) {
		let entries;
		try {
			entries = fs.readdirSync(dir);
		} catch (error) {
			if (error?.code === "ENOENT") continue;
			return { finding: unreadFileFinding(dir, error?.code ?? "error") };
		}
		for (const entry of [...entries].sort()) if (String(entry).endsWith(".conf") && !isDirectoryAt(fs, `${dir}/${entry}`)) out.push(`${dir}/${entry}`);
	}
	return { files: out };
}

/**
 * The first of `files` that sets a key `key` matches (`says` completes the sentence naming it), or holds an escaped key,
 * a non-ASCII character or a multi-line string this check cannot decode (`UNREAD_SPELLING`), or exists and cannot be
 * read, as `{ value: false, evidence }` (`value: null` for a transient read error); `null` when none does. A
 * missing file is simply not read, which is how Podman treats it too. `says` may be a function of the match (issue #428),
 * for a key set whose members each do something different, so the sentence names the one that was found.
 */
export function confKeyFinding(fs, files, { key, says }) {
	for (const file of files) {
		const got = readHostFile(fs, file);
		if (got.missing) continue;
		if (got.text === undefined) return unreadFileFinding(file, got.error);
		const match = key.exec(got.text);
		if (match) return { value: false, evidence: `${file} ${typeof says === "function" ? says(match) : says}` };
		if (ESCAPED_KEY.test(got.text)) return { value: false, evidence: `${file} has an escaped key, which this check does not decode`, spelling: "escaped" };
		const unread = unreadSpelling(got.text);
		if (unread) return { value: false, evidence: `${file} line ${unread.line} has ${unread.kind === "non-ascii" ? "a non-ASCII character" : "a multi-line string (\"\"\" or ''')"}, which this check does not decode`, spelling: unread.kind };
	}
	return null;
}

/**
 * The pattern that finds any of `keys` in a containers.conf, as `MOUNT_KEY` finds its own: any letter case, bare or
 * quoted, dotted or inside an inline table, never on a whole-line comment and never inside a longer key name. The one
 * capture group is the key, so a refusal names the key it found.
 */
export function widenKeyPattern(keys) {
	return new RegExp(`^(?!\\s*#).*?(?:^|[\\s.{,"'])["']?(${keys.join("|")})["']?\\s*=`, "im");
}

/**
 * CHAIN-AGNOSTIC (issue #448): the first of `files` that sets one of `keys`, as `{ value: false, key, evidence }` with
 * `says[key]` completing the sentence that names the file, or one this check cannot decode (an escaped key, a non-ASCII
 * character, a multi-line string) as `{ value: false, key: null, evidence, spelling }`, else `null`. A missing file is
 * not read, as Podman does not read it. A file that exists and cannot be read is `{ value, key: null, evidence }` by
 * `unreadFileFinding`'s rule (`null` for a transient code), UNLESS the caller passes an `unread` array: then a
 * determinate code is pushed there as `{ path, code }` and the scan goes on, which is how a caller whose chain includes
 * files it is not expected to read (root's own, for a worker that is not root) names them rather than refusing on them.
 * The rootless podman venue's check (`podmanConfWidening`) calls it with no `unread`, so its answers are what they were.
 * `pattern` replaces the one built from `keys` (the mounts observation passes `MOUNT_KEY`, whose `says` is one string),
 * and `strip` blanks what the caller accepts before the key is looked for (`stripStockBlocks`).
 */
export function confWidening(fs, files, { keys, pattern = widenKeyPattern(keys), says, unread = null, nameable = () => true, strip = null }) {
	for (const file of files) {
		const got = readHostFile(fs, file);
		if (got.missing) continue;
		if (got.text === undefined) {
			const finding = unreadFileFinding(file, got.error);
			// Collected only where the caller says a path may go unread (gate round 1 of PR #473: root's own config home, never
			// a `0600` drop-in in /etc, which the service applied while this named it and moved on).
			if (Array.isArray(unread) && finding.value === false && nameable(file)) {
				unread.push({ path: file, code: got.error });
				continue;
			}
			return { ...finding, key: null };
		}
		// `strip` (issue #448) blanks a block the caller accepts as it ships, line for line, before the key is looked for.
		const text = typeof strip === "function" ? strip(got.text) : got.text;
		const match = pattern.exec(text);
		if (match) {
			const key = match[1]?.toLowerCase() ?? null;
			return { value: false, key, evidence: `${file} ${typeof says === "string" ? says : says[key]}` };
		}
		if (Array.isArray(keys) && keys.includes("runtimes") && runtimesTableSet(text)) return { value: false, key: "runtimes", evidence: `${file} ${says.runtimes}` };
		if (ESCAPED_KEY.test(got.text)) return { value: false, key: null, evidence: `${file} has an escaped key, which this check does not decode`, spelling: "escaped" };
		const spelled = unreadSpelling(got.text);
		if (spelled) return { value: false, key: null, evidence: `${file} line ${spelled.line} has ${spelled.kind === "non-ascii" ? "a non-ASCII character" : "a multi-line string (\"\"\" or ''')"}, which this check does not decode`, spelling: spelled.kind };
	}
	return null;
}

/**
 * Whether a containers.conf sets a runtime in the `[engine.runtimes]` table (issue #448, gate round 1: a wrapper named
 * there ran for every job, rootful and rootless). A TABLE, so the key pattern cannot see it: a key assigned while that
 * table is open, a `[engine.runtimes.<x>]` subtable, or a dotted `runtimes.<x>` or `engine.runtimes.<x>` key. The header
 * alone is not a setting: the stock files of Fedora 44 and Ubuntu 24.04 carry `[engine.runtimes]` with every entry under
 * it commented out, and pass. Any letter case, quotes and spaces inside the header ignored.
 */
export function runtimesTableSet(text) {
	let table = "";
	for (const raw of String(text).split("\n")) {
		const line = raw.trim();
		if (line === "" || line.startsWith("#")) continue;
		const header = /^\[\s*([^\[\]]+?)\s*\](?:\s*#.*)?$/.exec(line);
		if (header) {
			table = header[1].replace(/["'\s]/g, "").toLowerCase();
			if (table.startsWith("engine.runtimes.")) return true;
			continue;
		}
		if (/^\[\[/.test(line)) {
			table = "";
			continue;
		}
		const key = /^["']?([A-Za-z0-9_.-]+?)["']?\s*(?:\.\s*["']?[A-Za-z0-9_-]+["']?\s*)*=/.exec(line);
		if (!key) continue;
		const dotted = line.slice(0, line.indexOf("=")).replace(/["'\s]/g, "").toLowerCase();
		if (table === "engine.runtimes") return true;
		if (table === "engine" && dotted.startsWith("runtimes.")) return true;
		if (table === "" && dotted.startsWith("engine.runtimes.")) return true;
	}
	return false;
}

/** An installed OCI hook (any `*.json` in `PODMAN_HOOKS_DIRS`) as `{ value: false, evidence }`, else `null`. */
export function hooksFinding(fs, dirs = PODMAN_HOOKS_DIRS) {
	for (const dir of dirs) {
		let entries;
		try {
			entries = fs.readdirSync(dir);
		} catch (error) {
			if (error?.code === "ENOENT") continue;
			return unreadFileFinding(dir, error?.code ?? "error");
		}
		if ([...entries].some((entry) => String(entry).endsWith(".json"))) return { value: false, evidence: `${dir} holds an OCI hook, which can mount into every container` };
	}
	return null;
}

/**
 * A daemon read that gave no facts, as an observation: `null` (not answered, so a floor retries) for a transient
 * failure, and `false` (answered, so a floor refuses) for a determinate one: a clean `docker info` exit that parses to no
 * known shape (`unparseable`, which the job-user decision likewise treats as determinate), or no docker CLI at all.
 * `undefined` when there are facts to read.
 */
function notAnswered(daemon) {
	if (daemon?.answered && daemon.facts) return undefined;
	if (daemon && daemon.answered === false && daemon.transient === false) return { value: false, evidence: `the daemon answered in a shape nothing here reads (${daemon.reason ?? "unparseable"})` };
	// No docker CLI at all is not a daemon still starting: the endpoint read treats it as determinate, and so does this.
	if (daemon?.reason === "docker-not-found") return { value: false, evidence: "no docker CLI was found on PATH" };
	return { value: null, evidence: `the daemon's info was not read (${daemon?.reason ?? "not asked"})` };
}

/**
 * `daemonAppliesBounds` from a daemon read (`{ answered, facts }` or `{ answered: false, reason }`), as
 * `{ value, evidence }`.
 */
export function observeBounds(daemon) {
	const unread = notAnswered(daemon);
	if (unread) return unread;
	const { facts } = daemon;
	if (facts.rootless === true) return { value: false, evidence: "the daemon is rootless, where the bounds it reports need cgroup delegation it does not report" };
	if (facts.podman === true || !facts.bounds) return { value: false, evidence: "the daemon is Podman, whose Docker API reports PidsLimit and MemoryLimit whether or not a container's bounds apply" };
	const missing = [facts.bounds.pids !== true ? "PidsLimit" : null, facts.bounds.memory !== true ? "MemoryLimit" : null].filter(Boolean);
	if (missing.length > 0) return { value: false, evidence: `the daemon reports ${missing.join(" and ")} false` };
	return { value: true, evidence: "the daemon reports PidsLimit and MemoryLimit" };
}

/**
 * `runtimeAddsNoMounts` from a daemon read, as `{ value, evidence }`. Docker adds no mounts of its own to a job
 * container; a Podman daemon behind the docker CLI is not a runtime this build measures, so its word is `false` and
 * doctor names it, rather than a file-chain read this build no longer runs.
 */
export function observeRuntimeMounts(daemon) {
	const notRead = notAnswered(daemon);
	if (notRead) return notRead;
	if (daemon.facts.podman === true) return { value: false, evidence: "the daemon is Podman, which mounts what its mounts.conf lists and this build does not read" };
	return { value: true, evidence: "the daemon is not Podman, and Docker adds no mounts from a mounts.conf" };
}

/**
 * Every observation `backends.mjs` names, for one endpoint read and one daemon read, as `{ observations, evidence,
 * reasons }`: the map `effectiveWord` and `observationRefusals` take, what each answer rests on, and for an observation
 * that was not answered, the reason token of the read that did not answer. The endpoint's own answer is `null` only for
 * a TRANSIENT failure to ask, as the endpoint read's boot and per-job rule already treats it.
 */
export function observeHost({ endpoint, daemon }) {
	const bounds = observeBounds(daemon);
	const mounts = observeRuntimeMounts(daemon);
	const endpointAnswer = endpoint?.local === true ? true : endpoint?.local === null && endpoint?.transient ? null : false;
	return {
		observations: { [DOCKER_ENDPOINT_LOCAL]: endpointAnswer, [DAEMON_APPLIES_BOUNDS]: bounds.value, [RUNTIME_ADDS_NO_MOUNTS]: mounts.value },
		evidence: { [DAEMON_APPLIES_BOUNDS]: bounds.evidence, [RUNTIME_ADDS_NO_MOUNTS]: mounts.evidence },
		reasons: {
			...(endpointAnswer === null ? { [DOCKER_ENDPOINT_LOCAL]: endpoint?.reason ?? "unknown" } : {}),
			...(bounds.value === null ? { [DAEMON_APPLIES_BOUNDS]: daemon?.reason ?? "not-read" } : {}),
			...(mounts.value === null ? { [RUNTIME_ADDS_NO_MOUNTS]: mounts.reason ?? daemon?.reason ?? "not-read" } : {}),
		},
	};
}

/** The two runtime answers as one string, so a caller logs them only when they change. */
export function runtimeObservationKey(observed) {
	return `${observed.observations[DAEMON_APPLIES_BOUNDS]}|${observed.observations[RUNTIME_ADDS_NO_MOUNTS]}`;
}

