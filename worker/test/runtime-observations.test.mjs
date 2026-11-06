import assert from "node:assert/strict";
import { test } from "node:test";
import { DAEMON_APPLIES_BOUNDS, DOCKER_ENDPOINT_LOCAL, RUNTIME_ADDS_NO_MOUNTS } from "../src/backends.mjs";
import {
	ESCAPED_KEY,
	FIPS_ENABLED_PATH,
	MOUNT_KEY,
	MOUNT_KEY_SAYS,
	PODMAN_HOOKS_DIRS,
	confFilesIn,
	confKeyFinding,
	fipsFinding,
	hooksFinding,
	observeBounds,
	observeHost,
	observeRuntimeMounts,
	PODMAN_CONTAINERS_CONF_DIRS,
	PODMAN_CONTAINERS_CONF_FILES,
	PODMAN_MOUNTS_CONF,
	TRANSIENT_READ_ERRORS,
	UNREAD_SPELLING,
	runtimeObservationKey,
} from "../src/runtime-observations.mjs";

const docker = (over = {}) => ({ answered: true, facts: { shape: "docker", podman: false, os: "Ubuntu 24.04", rootless: false, userns: false, bounds: { pids: true, memory: true }, serviceIsRemote: null, remoteSocketPath: null, ...over } });
const podman = (over = {}) => docker({ podman: true, bounds: null, ...over });
const enoent = (path) => Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });

/** A host filesystem of `{ path: string | { error } }` files and `{ dir: [entries] }` directories; everything else is absent. */
function hostFs(files = {}, dirs = {}) {
	const reads = [];
	const at = (path) => {
		const got = files[path];
		if (got === undefined) throw enoent(path);
		if (typeof got === "object") throw Object.assign(new Error(got.error), { code: got.error });
		return got;
	};
	return {
		reads,
		readFileSync: (path) => (reads.push(path), at(path)),
		statSync: (path) => ({ size: Buffer.byteLength(at(path)) }),
		readdirSync: (dir) => {
			if (dirs[dir] === undefined) throw enoent(dir);
			if (typeof dirs[dir] === "string") throw Object.assign(new Error(dirs[dir]), { code: dirs[dir] });
			return dirs[dir];
		},
	};
}

test("daemonAppliesBounds: credit only for a rootful, non-Podman daemon reporting both bounds; an unread daemon is unanswered (#345)", () => {
	assert.deepEqual(observeBounds(docker()), { value: true, evidence: "the daemon reports PidsLimit and MemoryLimit" });
	for (const [label, read, evidence] of [
		["rootless", docker({ rootless: true }), /rootless/],
		["Podman", podman(), /Podman, whose Docker API reports PidsLimit and MemoryLimit whether or not/],
		["Podman even when both booleans are true", podman({ bounds: { pids: true, memory: true } }), /Podman/],
		["no pids bound", docker({ bounds: { pids: false, memory: true } }), /reports PidsLimit false/],
		["neither bound", docker({ bounds: { pids: false, memory: false } }), /reports PidsLimit and MemoryLimit false/],
	]) {
		const got = observeBounds(read);
		assert.equal(got.value, false, label);
		assert.match(got.evidence, evidence, label);
	}
	for (const read of [{ answered: false, reason: "timeout", transient: true }, null, undefined, { answered: true, facts: null }]) {
		assert.equal(observeBounds(read).value, null, JSON.stringify(read));
	}
	// A clean docker info that parsed to no known shape is an ANSWER, as the job-user decision treats it: a floor refuses
	// it (exit 2) rather than restarting forever on it (exit 1).
	const unparseable = { answered: false, reason: "unparseable", transient: false };
	assert.deepEqual([observeBounds(unparseable).value, observeRuntimeMounts(unparseable, { fs: hostFs(), sameHost: true }).value], [false, false]);
	assert.match(observeBounds(unparseable).evidence, /answered in a shape nothing here reads \(unparseable\)/);
	const noDocker = { answered: false, reason: "docker-not-found", transient: true };
	assert.deepEqual([observeBounds(noDocker).value, observeRuntimeMounts(noDocker, { fs: hostFs(), sameHost: true }).value], [false, false], "no docker CLI at all is an answer, as the endpoint read treats it, never a restart loop");
	assert.match(observeBounds({ answered: false, reason: "daemon-unreachable" }).evidence, /\(daemon-unreachable\)/);
});

test("runtimeAddsNoMounts: Docker earns it, and a Podman daemon is determinately refused, off the daemon read alone (#345)", () => {
	assert.deepEqual(observeRuntimeMounts(docker()), { value: true, evidence: "the daemon is not Podman, and Docker adds no mounts from a mounts.conf" }, "Docker adds no mounts.conf mounts, and no host file is read to say so");
	assert.deepEqual(observeRuntimeMounts(podman()), { value: false, evidence: "the daemon is Podman, which mounts what its mounts.conf lists and this build does not read" }, "a Podman daemon is refused with its word: the mounts.conf file-chain read (the override, the containers.conf keys, FIPS mode, the OCI hooks) left with the sandbox prune, and a refusal an operator can see replaces a measurement this build no longer runs");
	assert.equal(observeRuntimeMounts(docker({ rootless: true })).value, true, "the word judges the runtime, not the rootfulness");
	assert.equal(observeRuntimeMounts({ answered: false, reason: "timeout", transient: true }).value, null, "a daemon that did not answer is not answered here either");
});


test("the Podman files read are the documented ones, pinned literally (#345)", () => {
	assert.equal(PODMAN_MOUNTS_CONF, "/etc/containers/mounts.conf");
	assert.deepEqual([...PODMAN_CONTAINERS_CONF_FILES], ["/usr/share/containers/containers.conf", "/etc/containers/containers.conf"]);
	// Gate round 1 of PR #473: only /etc's drop-ins are read (containers/common v0.67.0, measured on 5.8.1 and 4.9.3).
	assert.deepEqual([...PODMAN_CONTAINERS_CONF_DIRS], ["/etc/containers/containers.conf.d"]);
	assert.equal(FIPS_ENABLED_PATH, "/proc/sys/crypto/fips_enabled");
});


test("observeHost gives every observation the table names, with evidence and the reason an unanswered one was not answered (#345)", () => {
	const local = { local: true, endpoint: "unix:///var/run/docker.sock" };
	const held = observeHost({ endpoint: local, daemon: docker() });
	assert.deepEqual(held.observations, { [DOCKER_ENDPOINT_LOCAL]: true, [DAEMON_APPLIES_BOUNDS]: true, [RUNTIME_ADDS_NO_MOUNTS]: true });
	assert.deepEqual(held.reasons, {});
	assert.deepEqual(Object.keys(held.evidence).sort(), [DAEMON_APPLIES_BOUNDS, RUNTIME_ADDS_NO_MOUNTS].sort());
	const down = observeHost({ endpoint: { local: null, transient: true, reason: "timeout" }, daemon: { answered: false, reason: "daemon-unreachable", transient: true } });
	assert.deepEqual(down.observations, { [DOCKER_ENDPOINT_LOCAL]: null, [DAEMON_APPLIES_BOUNDS]: null, [RUNTIME_ADDS_NO_MOUNTS]: null });
	assert.deepEqual(down.reasons, { [DOCKER_ENDPOINT_LOCAL]: "timeout", [DAEMON_APPLIES_BOUNDS]: "daemon-unreachable", [RUNTIME_ADDS_NO_MOUNTS]: "daemon-unreachable" });
	assert.equal(observeHost({ endpoint: { local: null, transient: false, reason: "unparseable" }, daemon: docker() }).observations[DOCKER_ENDPOINT_LOCAL], false, "a determinate endpoint failure is an answer");
	assert.equal(observeHost({ endpoint: { local: false }, daemon: docker() }).observations[DOCKER_ENDPOINT_LOCAL], false);
	const shim = observeHost({ endpoint: { local: null, transient: false }, daemon: { answered: true, facts: { shape: "podman", podman: true, rootless: false, bounds: null, serviceIsRemote: true, remoteSocketPath: "unix:///run/podman/podman.sock" } } });
	assert.deepEqual([shim.observations[DAEMON_APPLIES_BOUNDS], shim.observations[RUNTIME_ADDS_NO_MOUNTS]], [false, false], "a Podman daemon behind the docker shim, near or far, is refused by both words: the mounts word no longer reads the shim host's files, since the podman venue left");
	assert.equal(runtimeObservationKey(held), "true|true");
	assert.equal(runtimeObservationKey(down), "null|null");
});

test("MOUNT_KEY finds a volumes or mounts key in every TOML spelling, and nothing in a comment or a longer key (#345)", () => {
	for (const text of ["volumes = []", '  "mounts" = []', "'volumes'=[]", "containers.volumes = []", "containers = { volumes = [] }", "[containers]\nmounts=[\"x\"]", 'annotations = ["volumes = x"]']) {
		assert.equal(MOUNT_KEY.test(text), true, JSON.stringify(text));
	}
	for (const text of ["# volumes = []", "  # mounts = []", "x_volumes = []", "devicevolumes = 1", "volumes_extra = 1", "[volumes]", "volumes"]) {
		assert.equal(MOUNT_KEY.test(text), false, JSON.stringify(text));
	}
	assert.equal(MOUNT_KEY.test('devices = ["/dev/fuse"]') && MOUNT_KEY.test("hooks_dir = []"), true);
	// Round 2, measured honoured by Podman 5.8.2: any letter case, and a `#` inside a string before the key.
	for (const text of ["[containers]\nVolumes = [\"/a:/b\"]", "CONTAINERS.VOLUMES = []", "[containers]\nDevices = [\"/dev/fuse\"]", 'containers = { env = ["X=#"], volumes = [] }', "containers={volumes=[]}", "Hooks_Dir = []"]) {
		assert.equal(MOUNT_KEY.test(text), true, JSON.stringify(text));
	}
	assert.equal(ESCAPED_KEY.test('containers = { env = ["X=#"], "volum\\u0065s" = [] }'), true, "an escaped key after a # inside a string");
	// The stock Fedora containers.conf comments every one of these keys out, so the documented override still earns credit.
	for (const text of ["#devices = []", "#mounts = []", "#volumes = []", "#hooks_dir = [", "#volumes = [\n#  \"/run/secrets:/run/secrets\",\n#]", "   #Volumes=[]"]) {
		assert.equal(MOUNT_KEY.test(text) || ESCAPED_KEY.test(text), false, JSON.stringify(text));
	}
	assert.equal(ESCAPED_KEY.test('"volum\\u0065s" = []'), true, "an escaped key is refused, not decoded");
	for (const text of ['label = "a\\b"', '# "x\\y" = 1', 'volumes = ["C:\\x"]']) assert.equal(ESCAPED_KEY.test(text), false, JSON.stringify(text));
	assert.deepEqual([...PODMAN_HOOKS_DIRS], ["/usr/share/containers/oci/hooks.d", "/etc/containers/oci/hooks.d"]);
});

test("the file helpers the podman venue shares read files by the rootful observation's rule (#354)", () => {
	// Exported so the rootless observation cannot drift from this one's reading: a drop-in directory is listed sorted and
	// `.conf` only, a directory that exists and cannot be listed withholds credit, a missing file is simply not read.
	const fs = hostFs({ "/a.conf": "x = 1\n", "/d/10-b.conf": '[containers]\nvolumes = ["/srv:/srv"]\n', "/d/05-a.conf": "" }, { "/d": ["10-b.conf", "readme", "05-a.conf"], "/locked": "EACCES" });
	assert.deepEqual(confFilesIn(fs, { files: ["/a.conf"], dirs: ["/missing", "/d"] }), { files: ["/a.conf", "/d/05-a.conf", "/d/10-b.conf"] });
	assert.deepEqual(confFilesIn(fs, { files: [], dirs: ["/locked"] }), { finding: { value: false, evidence: "/locked could not be read (EACCES)" } });
	assert.deepEqual(confKeyFinding(fs, ["/nope.conf", "/a.conf", "/d/05-a.conf", "/d/10-b.conf"], { key: MOUNT_KEY, says: MOUNT_KEY_SAYS }), { value: false, evidence: `/d/10-b.conf ${MOUNT_KEY_SAYS}` });
	assert.equal(confKeyFinding(fs, ["/a.conf"], { key: MOUNT_KEY, says: MOUNT_KEY_SAYS }), null);
	// Issue #428: EIO is a moment, not the file, so it is NOT ANSWERED (`null`, retried); EACCES is the file's own
	// permissions and stays a withheld credit (`false`), the precedent.
	assert.deepEqual(confKeyFinding(hostFs({ "/e.conf": { error: "EIO" } }), ["/e.conf"], { key: MOUNT_KEY, says: MOUNT_KEY_SAYS }), { value: null, evidence: "/e.conf could not be read (EIO)", reason: "file-unread" });
	assert.deepEqual(confKeyFinding(hostFs({ "/e.conf": { error: "EACCES" } }), ["/e.conf"], { key: MOUNT_KEY, says: MOUNT_KEY_SAYS }), { value: false, evidence: "/e.conf could not be read (EACCES)" });
	assert.equal(fipsFinding(hostFs()), null, "no FIPS file is FIPS off");
	assert.equal(fipsFinding(hostFs({ [FIPS_ENABLED_PATH]: "0\n" })), null);
	assert.equal(fipsFinding(hostFs({ [FIPS_ENABLED_PATH]: "1\n" })).value, false);
	assert.equal(fipsFinding(hostFs({ [FIPS_ENABLED_PATH]: { error: "EACCES" } })).value, false);
	assert.equal(hooksFinding(hostFs({}, { [PODMAN_HOOKS_DIRS[0]]: ["README"] })), null);
	assert.match(hooksFinding(hostFs({}, { [PODMAN_HOOKS_DIRS[1]]: ["x.json"] })).evidence, /holds an OCI hook/);
});

// Issue #428: three spellings Podman's TOML reads as a key and these patterns do not. Refused in the SHARED helper, so
// every conf key (MOUNT_KEY here, CGROUPS_KEY and WIDENING_KEY through the podman venue) withholds credit on them. Each
// fixture is built from escapes, never a literal non-ASCII byte in this file.
test("confKeyFinding withholds credit on a non-ASCII character or a multi-line string, which hide a key from the pattern (#428)", () => {
	const at = (text) => confKeyFinding(hostFs({ "/c.conf": text }), ["/c.conf"], { key: MOUNT_KEY, says: MOUNT_KEY_SAYS });
	for (const [label, text] of [
		// Go's EqualFold folds U+017F LONG S to `s`; a JS /i regex does not, so `volume\u017f` is invisible to MOUNT_KEY.
		["long s", '[containers]\n"volume\u017f" = ["/:/host"]\n'],
		// A basic multi-line string whose content has a line starting `#`: the pattern skips that "comment" line and the
		// key after it, while TOML reads one inline table.
		["basic multi-line", 'containers = { env = ["""\n# """], volumes = ["/:/host"] }\n'],
		["literal multi-line", "containers = { env = [\'\'\'\n#\'\'\'], volumes = [\"/:/host\"] }\n"],
		// U+2028 and U+2029 are line breaks to a JS regex and ordinary characters to TOML.
		["u2028", 'containers = { env = ["a\u2028# "], volumes = ["/:/host"] }\n'],
		["u2029", 'containers = { env = ["a\u2029# "], volumes = ["/:/host"] }\n'],
		["a byte-order mark", '\ufeff[containers]\n'],
	]) {
		const found = at(text);
		assert.equal(found?.value, false, label);
		assert.match(found.evidence, /^\/c\.conf line \d+ has (a non-ASCII character|a multi-line string \(""" or '''\)), which this check does not decode$/, label);
	}
	// Round 2: the evidence names the FIRST offending line and which of the two it is, so the operator is sent to it.
	assert.deepEqual(at('[containers]\nlog_driver = "journald"\ntz = "caf\u00e9"\n'), { value: false, evidence: "/c.conf line 3 has a non-ASCII character, which this check does not decode", spelling: "non-ascii" });
	assert.deepEqual(at('[containers]\nlabel = """\nx\n"""\n'), { value: false, evidence: `/c.conf line 2 has a multi-line string (""" or '''), which this check does not decode`, spelling: "multi-line" });
	// Every U+0080 to U+00FF character is non-ASCII too, not only the measured ones (a Latin-1 byte read as UTF-8).
	for (let code = 0x80; code <= 0xff; code++) {
		assert.equal(at(`# ${String.fromCharCode(code)}\n`)?.spelling, "non-ascii", `U+${code.toString(16).toUpperCase().padStart(4, "0")}`);
	}
	assert.equal(at("# \u007f\n"), null, "DEL is ASCII");
	// A line holding BOTH is named for its non-ASCII character, the rule `unreadSpelling` states.
	assert.equal(at(`label = """caf\u00e9\n"""\n`)?.spelling, "non-ascii");
	assert.match(at(`label = """caf\u00e9\n"""\n`).evidence, /line 1 has a non-ASCII character/);
	// A file that sets a real key AND has a non-ASCII comment is named for the KEY, which is the actionable fix.
	assert.deepEqual(at('# caf\u00e9\n[containers]\nvolumes = ["/:/host"]\n'), { value: false, evidence: `/c.conf ${MOUNT_KEY_SAYS}` });
	// A plain-ASCII file with a single-quoted string, a double-quoted one and a commented key still passes.
	assert.equal(at('[containers]\n# volumes = ["/:/host"]\nlog_driver = "journald"\ntz = \'local\'\n'), null);
	assert.ok(UNREAD_SPELLING.test("\u017f") && UNREAD_SPELLING.test('"""') && UNREAD_SPELLING.test("\'\'\'") && !UNREAD_SPELLING.test("~ \t\r\n"));
});

test("a conf read that fails for a moment is NOT ANSWERED (null), one that fails for a reason in the file withholds credit (#428)", () => {
	assert.deepEqual([...TRANSIENT_READ_ERRORS].sort(), ["EAGAIN", "EBUSY", "EINTR", "EIO", "EMFILE", "ENFILE", "ENOMEM", "ESTALE", "ETIMEDOUT", "EWOULDBLOCK"]);
	for (const code of TRANSIENT_READ_ERRORS) {
		assert.deepEqual(confKeyFinding(hostFs({ "/c.conf": { error: code } }), ["/c.conf"], { key: MOUNT_KEY, says: MOUNT_KEY_SAYS }), { value: null, evidence: `/c.conf could not be read (${code})`, reason: "file-unread" }, `file ${code}`);
		assert.deepEqual(confFilesIn(hostFs({}, { "/d": code }), { dirs: ["/d"] }), { finding: { value: null, evidence: `/d could not be read (${code})`, reason: "file-unread" } }, `dir ${code}`);
	}
	for (const code of ["EACCES", "EPERM", "ENOTDIR", "ELOOP", "EISDIR", "EXDEV_UNKNOWN"]) {
		assert.equal(confKeyFinding(hostFs({ "/c.conf": { error: code } }), ["/c.conf"], { key: MOUNT_KEY, says: MOUNT_KEY_SAYS }).value, false, `file ${code}`);
		assert.equal(confFilesIn(hostFs({}, { "/d": code }), { dirs: ["/d"] }).finding.value, false, `dir ${code}`);
	}
});

// Round 2 of the #428 review made the transient read rule the ONE rule for every file an observation read. Since the
// sandbox prune no OBSERVATION reads a host file: both daemon words come off the daemon read alone, so an unreadable
// file can no longer unanswer one. The rule itself is a helper's rule now, pinned in this file at confKeyFinding,
// confFilesIn, fipsFinding and hooksFinding (the reads the conf checks still make), and in unreadFileFinding.
test("no observation reads a host file, so a transient read error can no longer unanswer a runtime word (#428, residual)", () => {
	const endpoint = { local: true, endpoint: "unix:///run/podman/podman.sock" };
	for (const code of ["EMFILE", "EIO", "EACCES"]) {
		// The fixture holds unreadable files where the old observation read them; the empty `reads` below is the pin.
		const fs = hostFs({ [PODMAN_MOUNTS_CONF]: { error: code } }, { [PODMAN_HOOKS_DIRS[1]]: code });
		const host = observeHost({ endpoint, daemon: podman(), fs });
		assert.deepEqual(fs.reads, [], `no host file is read (${code}): both words come off the daemon read alone`);
		assert.deepEqual(host.observations, { [DOCKER_ENDPOINT_LOCAL]: true, [DAEMON_APPLIES_BOUNDS]: false, [RUNTIME_ADDS_NO_MOUNTS]: false }, `the podman words are answered, not unanswered (${code})`);
		assert.deepEqual(host.reasons, {}, `no retry reason, whatever the files say (${code})`);
	}
});

// --- issue #448: conf widening, the read rule the observations share ---------------------------------------------------

import { confWidening, widenKeyPattern } from "../src/runtime-observations.mjs";

/**
 * A host of `{ path: text | { error } }` files and `{ dir: entries | errno }` directories, each path's CHANGE time from
 * `ctimes` (a string there is a stat errno), 0 otherwise.
 */
function rootfulFs(files = {}, dirs = {}, ctimes = {}) {
	const reads = [];
	const fail = (code, p) => {
		throw Object.assign(new Error(`${code}: ${p}`), { code });
	};
	return {
		reads,
		readFileSync: (p) => {
			reads.push(p);
			const got = files[p];
			if (got === undefined) fail("ENOENT", p);
			if (typeof got === "object") fail(got.error, p);
			return got;
		},
		readdirSync: (p) => {
			reads.push(p);
			if (dirs[p] === undefined) fail("ENOENT", p);
			if (typeof dirs[p] === "string") fail(dirs[p], p);
			return dirs[p];
		},
		statSync: (p) => {
			reads.push(p);
			if (typeof ctimes[p] === "string") fail(ctimes[p], p);
			if (ctimes[p] === undefined) {
				if (files[p] !== undefined) return { size: 0, ctimeMs: 0, mtimeMs: 0, isDirectory: () => false };
				// A directory that cannot be LISTED still stats, as on a real host (stat needs only its parent's search bit).
				if (Array.isArray(dirs[p]) || typeof dirs[p] === "string") return { size: 0, ctimeMs: 0, mtimeMs: 0, isDirectory: () => true };
				fail("ENOENT", p);
			}
			// An mtime set back far (cp -p, touch -d) never counts: only the change time does.
			return { size: 0, ctimeMs: ctimes[p], mtimeMs: 0 };
		},
	};
}

test("confWidening: the first file setting a key, named; an unreadable file refused unless the caller may leave it unread (#448)", () => {
	const says = { env: "sets env, which X", annotations: "sets annotations, which Y" };
	const fs = rootfulFs({ "/a.conf": "[containers]\n#env = []\n", "/b.conf": "ANNOTATIONS = []\n", "/c.conf": "env = []\n", "/locked.conf": { error: "EACCES" }, "/root/x.conf": { error: "EACCES" }, "/busy.conf": { error: "EMFILE" } });
	assert.deepEqual(confWidening(fs, ["/nope.conf", "/a.conf", "/b.conf", "/c.conf"], { keys: ["annotations", "env"], says }), { value: false, key: "annotations", evidence: "/b.conf sets annotations, which Y" });
	assert.equal(confWidening(fs, ["/a.conf"], { keys: ["env"], says }), null);
	assert.deepEqual(confWidening(fs, ["/locked.conf", "/c.conf"], { keys: ["env"], says }), { value: false, evidence: "/locked.conf could not be read (EACCES)", key: null });
	const unread = [];
	const nameable = (p) => p.startsWith("/root/");
	assert.equal(confWidening(fs, ["/root/x.conf", "/c.conf"], { keys: ["env"], says, unread, nameable }).key, "env", "a nameable path is collected, and the scan goes on");
	assert.deepEqual(unread, [{ path: "/root/x.conf", code: "EACCES" }]);
	assert.deepEqual(confWidening(fs, ["/locked.conf", "/c.conf"], { keys: ["env"], says, unread: [], nameable }), { value: false, evidence: "/locked.conf could not be read (EACCES)", key: null }, "any other unreadable path refuses");
	assert.equal(confWidening(fs, ["/busy.conf"], { keys: ["env"], says, unread: [] }).value, null, "a transient code is never collected: it is retried");
	assert.equal(confWidening(rootfulFs({ "/e.conf": '"en\\u0076" = []\n' }), ["/e.conf"], { keys: ["env"], says }).spelling, "escaped");
	assert.equal(widenKeyPattern(["env"]).exec("env_host = true\n"), null, "never a longer key");
	assert.equal(widenKeyPattern(["env"]).exec("engine.env = []\n")?.[1], "env");
});


