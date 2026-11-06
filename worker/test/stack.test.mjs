/**

 * `worker/src/stack.mjs` — what outlived the Quadlet stack installer when the podman venue was removed: the Valkey
 * owner rule (issue #464), the hardened readers of the deployment `.env`'s keys (issues #430, #447, #477), the install
 * journal and its rollback (issue #468), and the user-manager environment refusals (issue #458). The module kept these
 * because `doctor`, `service`, `up`, `start` and the Valkey clients still read them; the tests here are the ones from
 * the former podman-stack.test.mjs that test those survivors, with the podman venue's own root-refusal and openshell
 * cases left with the venue that was removed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { STACK_KEYS, describeRollBack, judgeValkeyListeners, journalWrite, managerEnvRefusal, pinnedValkeyUrl, readStackKeys, readSubuidRanges, readValkeyKeys, resolveWorkerValkey, rollBackWrites, valkeyTarget } from "../src/stack.mjs";
import { SYSTEMD_259_ENV_BYTES, SYSTEMD_259_ENV_FILES } from "./helpers/systemd-env-259.mjs";
import { systemdEnvFile } from "./helpers/systemd-env-parse.mjs";

const DEPLOY_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "deploy");
const DEPLOY_AT = "/srv/pi-deploy";
const HOME = "/home/tester";
const TEST_PASSWORD = "0123456789abcdef".repeat(4);

// Issue #464 (the comment on it, and gate round 1): a Valkey VALKEY_URL reaches is this deployment's only when it is
// this account's, on every address the worker's client would dial.
test("valkeyTarget reads VALKEY_URL as the worker's client dials it: the host without brackets, the port, or not a redis URL", () => {
	assert.deepEqual(valkeyTarget(undefined), { host: "127.0.0.1", port: 6379 }, "unset is the worker's own default");
	assert.deepEqual(valkeyTarget(""), { host: "127.0.0.1", port: 6379 });
	assert.deepEqual(valkeyTarget("redis://127.0.0.1:6380"), { host: "127.0.0.1", port: 6380 });
	assert.deepEqual(valkeyTarget("redis://LocalHost"), { host: "localhost", port: 6379 });
	assert.deepEqual(valkeyTarget("redis://:pw@[::1]:6390/0"), { host: "::1", port: 6390 });
	assert.deepEqual(valkeyTarget("rediss://127.0.0.1:6381"), { host: "127.0.0.1", port: 6381 });
	assert.deepEqual(valkeyTarget("redis://valkey.lan:6379"), { host: "valkey.lan", port: 6379 });
	assert.match(valkeyTarget("http://127.0.0.1:6379").error, /scheme is http:/);
	assert.match(valkeyTarget("not a url").error, /not a URL/);
});

// A real login's environment by default: a user manager to talk to (round 2, E8).
// Issue #464: the host files the owner rule reads, as this harness's host has them. A LISTEN row on 127.0.0.1:6379
// (0x18EB) owned by `uid`, the column layout measured on Fedora 44 and Ubuntu 24.04; `null` for no row.
const TCP_HEAD = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
const tcpListen = (uid, port = 6379, addr = "0100007F") => `${TCP_HEAD}   3: ${addr}:${port.toString(16).toUpperCase().padStart(4, "0")} 00000000:0000 0A 00000000:00000000 00:00000000 00000000  ${uid}        0 1589654 1 00000000cd751f2b 100 0 0 10 0\n`;
const hostFiles = (listenerUid) => ({
	"/proc/net/tcp": listenerUid === null ? TCP_HEAD : tcpListen(listenerUid),
	"/proc/net/tcp6": TCP_HEAD,
	// This account's subordinate uids (a `--network host` container of it listens as one of them), and another's.
	"/etc/subuid": "op2:1235000000:65536\ntester:1234000000:65536\n",
	"/etc/passwd": "root:x:0:0:root:/root:/bin/bash\nvalkey:x:975:975::/var/lib/valkey:/sbin/nologin\ntester:x:1234:1234::/home/tester:/bin/bash\nop2:x:1235:1235::/home/op2:/bin/bash\n",
});
// How this harness's host resolves a name, as the worker's client would (every address, `localhost` ::1 first as on
// Fedora 44); anything else does not resolve.
const DNS = { localhost: [{ address: "::1", family: 6 }, { address: "127.0.0.1", family: 4 }], "queue.lan": [{ address: "10.0.0.5", family: 4 }] };
const fakeLookup = (dns = DNS) => async (host) => {
	if (!dns[host]) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
	return dns[host];
};

// The venue table holds `local` alone since the podman venue's removal; `resolveWorkerValkey` keeps the parameter
// for its callers' shape, and root's docker-proxy listener is accepted on every deployment.
const VENUES = { localUsed: true };
const NAMES = { 0: "root", 501: "rob", 975: "valkey", 1234: "tester", 1235: "op2", 70000: "ldapuser" };

// Gate round 2: the owner rule moved to where the connection is made, with the address pinned.
const row4 = (addr, port, uid) => `   3: ${addr}:${port.toString(16).toUpperCase().padStart(4, "0")} 00000000:0000 0A 00000000:00000000 00:00000000 00000000  ${uid}        0 1 1 0 100 0 0 10 0\n`;
const row6 = (addr, port, uid) => `   1: ${addr}:${port.toString(16).toUpperCase().padStart(4, "0")} 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  ${uid}        0 1 1 0 100 0 0 10 0\n`;
const judgeOn = (files, extra = {}) =>
	judgeValkeyListeners({ url: "redis://127.0.0.1:16483", probeTcp: async () => true, lookup: fakeLookup(), fs: { readFileSync: (p) => ({ "/proc/net/tcp": TCP_HEAD, "/proc/net/tcp6": TCP_HEAD, "/etc/subuid": "op2:1235000000:65536\ntester:1234000000:65536\n", ...files })[p] }, euid: 1234, user: "tester", ownerName: (u) => NAMES[u] ?? null, envPath: "/d/.env", ...extra });

test("judgeValkeyListeners: a name that resolves to this host's own interface address is judged, one that resolves elsewhere is another host, and one that does not resolve cannot be judged (#464)", async () => {
	const lan = `${TCP_HEAD}   3: 00000000:18EB 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1235        0 1 1 0 100 0 0 10 0\n`;
	const common = { probeTcp: async () => true, euid: 1234, user: "tester", fs: { readFileSync: (p) => ({ ...hostFiles(null), "/proc/net/tcp": lan })[p] }, ownerName: (u) => NAMES[u] ?? null };
	const here = await judgeValkeyListeners({ ...common, url: "redis://myhost:6379", lookup: fakeLookup({ myhost: [{ address: "192.168.5.15", family: 4 }] }), interfaces: () => ({ eth0: [{ address: "192.168.5.15", family: "IPv4" }] }) });
	assert.match(here.refusal.text, /^192\.168\.5\.15:6379 is held by op2 \(uid 1235\)/, "a 0.0.0.0 listener answers this host's own address too");
	const there = await judgeValkeyListeners({ ...common, url: "redis://queue.lan:6379", lookup: fakeLookup({ "queue.lan": [{ address: "10.0.0.5", family: 4 }] }), interfaces: () => ({ eth0: [{ address: "192.168.5.15", family: "IPv4" }] }) });
	assert.deepEqual(there, { remote: "queue.lan" });
	// Gate round 3, item 4: a name that does not resolve is not known to be another host; it is judged when it resolves.
	assert.deepEqual(await judgeValkeyListeners({ ...common, url: "redis://gone.lan:6379", lookup: fakeLookup({}) }), { unresolved: "gone.lan", why: "ENOTFOUND" });
	assert.deepEqual(await judgeValkeyListeners({ ...common, url: "redis://none.lan:6379", lookup: async () => [] }), { unresolved: "none.lan", why: "no address" });
});

test("judgeValkeyListeners: 0.0.0.0, :: and 127.0.0.0/8 URLs are this host's and judged at the address a connect reaches (#464, gate round 2 defect 1)", async () => {
	// Measured on Fedora 44: redis://0.0.0.0:16483 was "not this host", unjudged, and the client reached another
	// account's 127.0.0.1:16483.
	const theirs = { "/proc/net/tcp": `${TCP_HEAD}${row4("0100007F", 16483, 1235)}` };
	for (const url of ["redis://0.0.0.0:16483", "redis://0.1.2.3:16483", "redis://[::ffff:0.0.0.0]:16483"]) {
		const v = await judgeOn(theirs, { url });
		assert.match(v.refusal?.text ?? "", /^127\.0\.0\.1:16483 is held by op2 \(uid 1235\)/, url);
	}
	const v6 = await judgeOn({ "/proc/net/tcp6": `${TCP_HEAD}${row6("00000000000000000000000001000000", 16483, 1235)}` }, { url: "redis://[::]:16483" });
	assert.match(v6.refusal.text, /^\[::1\]:16483 is held by op2/);
	// 127.0.0.0/8 is loopback: 127.0.0.2 is judged here, never "another host" (gate round 2, test gap).
	const other127 = await judgeOn({ "/proc/net/tcp": `${TCP_HEAD}${row4("0200007F", 16483, 1235)}` }, { url: "redis://127.0.0.2:16483" });
	assert.match(other127.refusal.text, /^127\.0\.0\.2:16483 is held by op2/);
	const mine = await judgeOn({ "/proc/net/tcp": `${TCP_HEAD}${row4("0100007F", 16483, 1234)}` }, { url: "redis://0.0.0.0:16483" });
	assert.deepEqual([mine.chosen, mine.refusal], ["127.0.0.1", null], "pinned to what 0.0.0.0 reaches");
});

test("judgeValkeyListeners chooses this account's listener first and pins it; another account's on another address of the name is reported, never dialled (#464, gate round 2 defect 2)", async () => {
	// The localhost squat after install (measured on Fedora 44): this account's Quadlet Valkey on 127.0.0.1, another
	// account later publishing [::1] on the same port; localhost resolves ::1 first.
	const files = { "/proc/net/tcp": `${TCP_HEAD}${row4("0100007F", 16483, 1234)}`, "/proc/net/tcp6": `${TCP_HEAD}${row6("00000000000000000000000001000000", 16483, 1235)}` };
	const v = await judgeOn(files, { url: "redis://localhost:16483" });
	assert.equal(v.chosen, "127.0.0.1");
	assert.equal(v.refusal, null);
	assert.deepEqual(v.elsewhere, ["[::1]:16483 (held by op2 (uid 1235))"]);
	assert.deepEqual(v.answered.map((a) => [a.address, a.own]), [["::1", false], ["127.0.0.1", true]], "in the order the client tries them");
	// With nothing of this account's answering, the refusal names ONLY the addresses a foreign uid holds (gate round 2).
	const mixed = await judgeOn({ "/proc/net/tcp": `${TCP_HEAD}${row4("0100007F", 16483, 1235)}`, "/proc/net/tcp6": `${TCP_HEAD}${row6("00000000000000000000000001000000", 16483, 1236)}` }, { url: "redis://localhost:16483" });
	assert.match(mixed.refusal.text, /^\[::1\]:16483 and 127\.0\.0\.1:16483 are held by uid 1236 and op2 \(uid 1235\), not by/, "two addresses are held (gate round 3)");
	// An address no socket row explains beside one another account holds: only the foreign-held one is said to be held.
	const unknownAndForeign = await judgeOn({ "/proc/net/tcp": `${TCP_HEAD}${row4("0100007F", 16483, 1235)}` }, { url: "redis://localhost:16483" });
	assert.match(unknownAndForeign.refusal.text, /^127\.0\.0\.1:16483 is held by op2 \(uid 1235\), not by/, "::1 answered with no row: not named as op2's");
	const oneForeign = await judgeOn({ "/proc/net/tcp": `${TCP_HEAD}${row4("0100007F", 16483, 1235)}` }, { url: "redis://localhost:16483", probeTcp: async (h) => h === "127.0.0.1" });
	assert.match(oneForeign.refusal.text, /^127\.0\.0\.1:16483 is held by op2 \(uid 1235\), not by/, "::1 did not answer, so it is not named");
});

test("judgeValkeyListeners bounds the name lookup: a resolver that does not answer is a name that cannot be judged yet, never another host (#464, gate rounds 2 and 3)", async () => {
	const v = await judgeOn({}, { url: "redis://slow.lan:6379", lookup: () => new Promise(() => {}), lookupTimeoutMs: 20 });
	assert.deepEqual(v, { unresolved: "slow.lan", why: "ETIMEOUT" });
});

test("readSubuidRanges: getsubids(1) where it answers (SSSD ranges included), else /etc/subuid, and says which (#464, gate round 2)", async () => {
	const fs = { readFileSync: () => "tester:1234000000:65536\n" };
	assert.deepEqual(readSubuidRanges({ user: "tester", euid: 1234, fs, run: (cmd, args) => (cmd === "getsubids" && args[0] === "tester" ? "0: tester 5000000 100\n1: tester 7000000 10\n" : null) }), { ranges: [{ lo: 5000000, hi: 5000099 }, { lo: 7000000, hi: 7000009 }], source: "getsubids" });
	assert.deepEqual(readSubuidRanges({ user: "tester", euid: 1234, fs, run: () => null }), { ranges: [{ lo: 1234000000, hi: 1234065535 }], source: "/etc/subuid" });
	assert.deepEqual(readSubuidRanges({ user: "tester", euid: 1234, fs, run: () => "garbage\n" }).source, "/etc/subuid", "an answer with no range is not an answer");
	// The source is what the refusal says, and an SSSD range makes a --network host container's uid this account's.
	const v = await judgeOn({ "/proc/net/tcp": `${TCP_HEAD}${row4("0100007F", 16483, 5000042)}` }, { subuids: { ranges: [{ lo: 5000000, hi: 5000099 }], source: "getsubids" } });
	assert.deepEqual([v.chosen, v.heldBy], ["127.0.0.1", "this account's containers (a subordinate uid of it, from getsubids)"]);
	const refused = await judgeOn({ "/proc/net/tcp": `${TCP_HEAD}${row4("0100007F", 16483, 1235)}` }, { subuids: { ranges: [], source: "getsubids" } });
	assert.match(refused.refusal.text, /or its containers \(subordinate uids read from getsubids\)/);
});

test("pinnedValkeyUrl puts the judged literal in place of the host and keeps the name for TLS (#464, gate round 2)", () => {
	assert.deepEqual(pinnedValkeyUrl("redis://localhost:16483", "127.0.0.1"), { url: "redis://127.0.0.1:16483", servername: null });
	assert.deepEqual(pinnedValkeyUrl("redis://:pw@localhost:16483/2", "::1"), { url: "redis://:pw@[::1]:16483/2", servername: null });
	assert.deepEqual(pinnedValkeyUrl("rediss://valkey.lan:6380", "192.168.5.15"), { url: "rediss://192.168.5.15:6380", servername: "valkey.lan" });
	assert.deepEqual(pinnedValkeyUrl("rediss://127.0.0.1:6380", "127.0.0.1"), { url: "rediss://127.0.0.1:6380", servername: null }, "a literal has no name to check");
});

test("resolveWorkerValkey: the worker's boot judgement, pinned, refused as a configError, and PI_VALKEY_SHARED from .env only (#464, gate round 2)", async () => {
	const refuse = (m) => Object.assign(new Error(m), { piDispatchConfig: true });
	const files = (uid) => ({ "/proc/net/tcp": `${TCP_HEAD}${row4("0100007F", 16483, uid)}`, "/proc/net/tcp6": TCP_HEAD, "/etc/subuid": "" });
	const at = (uid, extra = {}) =>
		resolveWorkerValkey({ url: "redis://localhost:16483", venues: VENUES, platform: "linux", env: {}, envText: "", envPath: "/d/.env", probeTcp: async (h) => h === "127.0.0.1", lookup: fakeLookup(), fs: { readFileSync: (p) => files(uid)[p] }, euid: 1234, user: "tester", ownerName: (u) => NAMES[u] ?? null, interfaces: () => ({}), subuids: { ranges: [], source: "/etc/subuid" }, configError: refuse, waitMs: 0, sleep: async () => {}, ...extra });
	const mine = await at(1234);
	assert.deepEqual([mine.url, mine.servername, mine.pinned], ["redis://127.0.0.1:16483", null, { address: "127.0.0.1", port: 16483, heldBy: "this account" }]);
	await assert.rejects(at(1235), (err) => err.piDispatchConfig === true && /^the Valkey VALKEY_URL reaches is refused: 127\.0\.0\.1:16483 is held by op2 \(uid 1235\)/.test(err.message));
	// Shared on purpose: from .env, and only from .env.
	const shared = await at(1235, { envText: "PI_VALKEY_SHARED=1\n" });
	assert.equal(shared.url, "redis://127.0.0.1:16483");
	await assert.rejects(at(1235, { env: { PI_VALKEY_SHARED: "1" } }), (err) => err.piDispatchConfig === true, "an environment opt-in is not the file's");
	const noted = await at(1234, { env: { PI_VALKEY_SHARED: "1" } });
	assert.match(noted.notes[0], /^PI_VALKEY_SHARED is set in the worker's environment and not in \/d\/\.env: ignored/);
	// Gate round 3's rule, as the local-only backend table ships it: another account's listener is refused on EVERY
	// venue, and root's (docker-proxy) listener is the deployment's own docker Valkey, so it is accepted everywhere.
	const docker = { venues: { localUsed: true } };
	await assert.rejects(at(1235, docker), (err) => err.piDispatchConfig === true && /held by op2 \(uid 1235\)/.test(err.message), "another account's Valkey on the local venue");
	const proxy = await at(0, docker);
	assert.deepEqual([proxy.url, proxy.rootRefused, proxy.pinned?.heldBy], ["redis://127.0.0.1:16483", false, "root"], "docker-proxy on the local venue");
	// Not judged off Linux (no /proc), nor another host.
	for (const extra of [{ platform: "darwin" }, { url: "redis://queue.lan:6379", lookup: fakeLookup({ "queue.lan": [{ address: "10.0.0.5", family: 4 }] }) }]) {
		const same = await at(1235, extra);
		assert.equal(same.pinned, null, JSON.stringify(extra));
		assert.equal(same.url, extra.url ?? "redis://localhost:16483");
	}
	// Gate round 3, item 5: the .env's bytes go through the hardened reader; a hazard is named and the worker does not start.
	await assert.rejects(at(1234, { envText: Buffer.from("PI_VALKEY_SHARED=1\rVALKEY_URL=redis://x\n") }), (err) => err.piDispatchConfig === true && /^\/d\/\.env line 1 .*carriage return.*The worker reads PI_VALKEY_SHARED and VALKEY_URL from it, so it does not start$/s.test(err.message));
	await assert.rejects(at(1234, { envText: Buffer.from([0x50, 0x3d, 0xff, 0x0a]) }), (err) => err.piDispatchConfig === true && /UTF-8/.test(err.message));
	// A name that does not resolve: waited for, then a plain error (exit 1, restarted), never dialled unjudged.
	let dnsClock = 0;
	await assert.rejects(at(1234, { url: "redis://gone.lan:16483", waitMs: 1000, now: () => dnsClock, sleep: async (ms) => { dnsClock += ms; } }), (err) => !err.piDispatchConfig && /^VALKEY_URL's host gone\.lan did not resolve here \(ENOTFOUND\), so whose Valkey it reaches cannot be judged; the service manager retries/.test(err.message));
	// Nothing answering: waited for, then a plain error (exit 1, restarted), since no owner can be judged yet.
	let clock = 0;
	await assert.rejects(at(1234, { probeTcp: async () => false, waitMs: 2000, now: () => clock, sleep: async (ms) => { clock += ms; } }), (err) => !err.piDispatchConfig && /^nothing answers VALKEY_URL \(\[::1\]:16483, 127\.0\.0\.1:16483\)/.test(err.message));
	let answersAt = 1000;
	clock = 0;
	const late = await at(1234, { probeTcp: async (h) => h === "127.0.0.1" && clock >= answersAt, waitMs: 5000, now: () => clock, sleep: async (ms) => { clock += ms; } });
	assert.equal(late.url, "redis://127.0.0.1:16483", "a Valkey still starting is waited for");
	await assert.rejects(at(1234, { url: "http://x" }), (err) => err.piDispatchConfig === true);
});

test("readValkeyKeys reads VALKEY_URL and PI_VALKEY_SHARED as the loader does, and names what makes a line unreadable (#464)", () => {
	assert.deepEqual(readValkeyKeys("VALKEY_URL=redis://127.0.0.1:6380\nPI_VALKEY_SHARED=1\n"), { keys: { VALKEY_URL: "redis://127.0.0.1:6380", PI_VALKEY_SHARED: "1" } });
	assert.deepEqual(readValkeyKeys('VALKEY_URL="redis://[::1]:6379"\n'), { keys: { VALKEY_URL: "redis://[::1]:6379" } });
	assert.deepEqual(readValkeyKeys("# VALKEY_URL=redis://x\n"), { keys: {} });
	assert.match(readValkeyKeys("VALKEY_URL=redis://[::1]:6379\n", { path: "/d/.env" }).error, /^\/d\/\.env line 1 assigns VALKEY_URL .*\(an unquoted \[ or \]/);
});

// Gate round 3, item 5: `up` read the .env's VALKEY_URL and PI_VALKEY_SHARED from decoded text, past what systemd refuses.
test("deploymentValkeyEnv reads the .env as bytes through the hardened reader, and stops on what systemd refuses (#464, gate round 3)", async () => {
	const { deploymentValkeyEnv } = await import("../src/deployment-venue.mjs");
	const fsOf = (bytes) => ({ existsSync: () => true, readFileSync: (_p, enc) => (enc ? bytes.toString(enc) : bytes) });
	const bad = Buffer.concat([Buffer.from("VALKEY_URL=redis://127.0.0.1:6380\nPI_VALKEY_SHARED="), Buffer.from([0xff]), Buffer.from("1\n")]);
	const refused = deploymentValkeyEnv({ env: {}, fs: fsOf(bad), envPath: "/d/.env", platform: "linux" });
	assert.match(String(refused.error), /^\/d\/\.env line 2 has .*UTF-8.*\. up judges the Valkey the service will use, so it stops here$/s);
	const ok = deploymentValkeyEnv({ env: {}, fs: fsOf(Buffer.from("VALKEY_URL=redis://127.0.0.1:6380\n")), envPath: "/d/.env", platform: "linux" });
	assert.equal(ok.env.VALKEY_URL, "redis://127.0.0.1:6380");
});

test("rollBackWrites: the FIRST record of a path is what is put back, and describeRollBack says what remains", () => {
	const store = new Map([["/a", "old-a"]]);
	const fs = { writeFileSync: (p, d) => store.set(p, d), unlinkSync: (p) => { if (!store.delete(p)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); } };
	const journal = [{ path: "/a", existed: true, previous: "old-a" }, { path: "/b", existed: false, previous: null }, { path: "/a", existed: true, previous: "run-a" }];
	store.set("/a", "run-a2");
	store.set("/b", "run-b");
	const rolled = rollBackWrites(fs, journal);
	assert.deepEqual([store.get("/a"), store.has("/b")], ["old-a", false]);
	assert.deepEqual(rolled, { restored: ["/a"], removed: ["/b"], left: [] });
	assert.deepEqual(rollBackWrites(fs, [{ path: "/gone", existed: false, previous: null }]), { restored: [], removed: ["/gone"], left: [] }, "an absent new file counts as removed");
	assert.equal(describeRollBack({ restored: [], removed: [], left: [] }), "this run had written nothing; no file of this run remains");
});

// XDG_RUNTIME_DIR or XDG_CONFIG_HOME (a runner image's /etc/environment, read through environment.d) makes every unit
// fail ("XDG_RUNTIME_DIR directory ... is not owned by the current user") or not exist at all. Refused before a write.
test("managerEnvRefusal (#458): another account's XDG_RUNTIME_DIR or XDG_CONFIG_HOME in the manager refuses; its own or none passes", () => {
	const who = { home: HOME, euid: 1234, user: "tester" };
	const read = (text, code = 0) => managerEnvRefusal({ code, stdout: text }, who);
	assert.equal(read("HOME=/home/tester\nXDG_RUNTIME_DIR=/run/user/1234\nXDG_CONFIG_HOME=/home/tester/.config\n"), null);
	assert.equal(read("HOME=/home/tester\n"), null, "unset is the manager's own default");
	assert.equal(read("XDG_RUNTIME_DIR=/run/user/1234/\nXDG_CONFIG_HOME=/home/tester/.config/\n"), null, "a trailing slash is the same directory");
	assert.equal(read("XDG_RUNTIME_DIR=/run/user/1001\n", 1), null, "a manager that did not answer is left to the commands that follow");
	const runtime = read("XDG_RUNTIME_DIR=/run/user/1001\n");
	assert.match(runtime, /^tester's user manager runs with XDG_RUNTIME_DIR=\/run\/user\/1001, not \/run\/user\/1234: every podman command in a unit would fail \("XDG_RUNTIME_DIR directory \.\.\. is not owned by the current user", measured\)\. That environment is what every unit it starts inherits, so nothing is installed\./);
	assert.match(runtime, /~\/\.config\/environment\.d\/ \(for example a file zz-pi-dispatch\.conf with XDG_RUNTIME_DIR=\/run\/user\/1234 and XDG_CONFIG_HOME=\/home\/tester\/\.config\), restart the manager \(sudo systemctl restart user@1234\.service/);
	const config = read("XDG_CONFIG_HOME=/home/runner/.config\n");
	assert.match(config, /XDG_CONFIG_HOME=\/home\/runner\/\.config, not \/home\/tester\/\.config: the Quadlet generator would look for the units there, not in \/home\/tester\/\.config\/containers\/systemd/);
	assert.match(read("XDG_RUNTIME_DIR=/run/user/1001\nXDG_CONFIG_HOME=/home/runner/.config\n"), /XDG_RUNTIME_DIR=\/run\/user\/1001[^]*; and XDG_CONFIG_HOME=\/home\/runner\/\.config/);
});

// PR #463 round 3: systemd prints a value needing quotes as $'...' (measured on systemd 255: `$'/home/a b/.config'`,
// `$'it\\'s'`), and a symlinked home is the same directory under another spelling.
test("managerEnvRefusal (#458): a quoted value is unquoted before it is compared, and a symlinked home compares by realpath", () => {
	const spaced = { home: "/home/a b", euid: 1234, user: "a b" };
	assert.equal(managerEnvRefusal({ code: 0, stdout: "XDG_CONFIG_HOME=$'/home/a b/.config'\nXDG_RUNTIME_DIR=/run/user/1234\n" }, spaced), null, "its own, quoted");
	assert.match(managerEnvRefusal({ code: 0, stdout: "XDG_CONFIG_HOME=$'/home/other b/.config'\n" }, spaced), /XDG_CONFIG_HOME=\/home\/other b\/\.config, not \/home\/a b\/\.config/, "another's, unquoted in the message");
	const links = { "/home/me": "/data/home/me", "/home/me/.config": "/data/home/me/.config" };
	const realpath = (p) => links[p] ?? p;
	assert.equal(managerEnvRefusal({ code: 0, stdout: "XDG_CONFIG_HOME=/data/home/me/.config\n" }, { home: "/home/me", euid: 1, user: "me", realpath }), null, "the same directory through a symlinked home");
	assert.match(managerEnvRefusal({ code: 0, stdout: "XDG_CONFIG_HOME=/data/home/you/.config\n" }, { home: "/home/me", euid: 1, user: "me", realpath }), /not \/home\/me\/\.config/);
	const throwing = () => {
		throw new Error("ENOENT");
	};
	assert.match(managerEnvRefusal({ code: 0, stdout: "XDG_RUNTIME_DIR=/run/user/9\n" }, { home: "/home/me", euid: 1, user: "me", realpath: throwing }), /XDG_RUNTIME_DIR=\/run\/user\/9/, "an unresolvable path is compared as written");
});

test("E4/D1: only a key line INSIDE a still-open quoted value is in doubt; a multi-line value that closes is ordinary", () => {
	// A key swallowed by a value that opens with a quote and continues (systemd's env_file_6): refused, both lines named.
	assert.match(readStackKeys("NOTE='see\nPI_BACKENDS=podman\n'\n").error, /line 2 \(PI_BACKENDS\) lies inside the quoted value that opens on line 1 and closes on line 3/);
	// Never closed: every key after it is in doubt.
	assert.match(readStackKeys("NOTE='see\nPI_BACKENDS=podman\n").error, /opens on line 1 and never closes/);
	// An escaped `"` does not close a double-quoted value (the E4c mutant: `rest.includes('"')`).
	assert.match(readStackKeys('K="a\\"\nPI_BACKENDS=podman\n').error, /line 2 \(PI_BACKENDS\) lies inside/);
	assert.match(readStackKeys('K="a\\"\nPI_BACKENDS=podman\n').error, /GITHUB_APP_PRIVATE_KEY_PATH/);
	// D1 (measured on systemd 259): the documented multi-line GitHub App key, with the venue key before AND after it.
	const pem = 'GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nabc=\n-----END RSA PRIVATE KEY-----"\n';
	assert.deepEqual(readStackKeys(`PI_BACKENDS=podman\nPI_EGRESS=1\n${pem}GITHUB_APP_PRIVATE_KEY_PATH=\n`).keys, { PI_BACKENDS: "podman", PI_EGRESS: "1" });
	assert.deepEqual(readStackKeys(`${pem}PI_BACKENDS=podman\n`).keys, { PI_BACKENDS: "podman" });
	// A quote opened MID-value does not continue, and a closed one is ordinary.
	assert.deepEqual(readStackKeys("NOTE=a'b\nPI_BACKENDS=podman\n").keys, { PI_BACKENDS: "podman" });
	assert.deepEqual(readStackKeys("NOTE='a b'\nPI_BACKENDS=podman\n").keys, { PI_BACKENDS: "podman" });
});

test("#447: the venue reader never reads a venue key differently from systemd 259 or bash, over every measured file", () => {
	// THE ORACLE: each row is what a unit's EnvironmentFile= set, measured (and, for gate round 1's rows, what bash
	// sourced). The reader either refuses or agrees; before #447 it read `podman` where systemd set nothing in 28 rows and
	// nothing where systemd set `podman` in two, and gate round 1's adversary found seven more files it read wrongly.
	const rows = [...SYSTEMD_259_ENV_FILES, ...SYSTEMD_259_ENV_BYTES.map(([n, hex, ...rest]) => [n, Buffer.from(hex, "hex"), ...rest])];
	for (const [name, content, systemd, hazard, bash] of rows) {
		const read = readStackKeys(content);
		if (hazard !== null) {
			assert.ok(read.error, `${name}: refused`);
			assert.match(read.error, new RegExp(`^\\.env line ${hazard[0]} has `), `${name}: names the line`);
		} else if (systemd === null) {
			assert.ok(read.error, `${name}: systemd refused to load it, so the reader refuses`);
		} else if (!read.error) {
			// Refusing is always allowed; vouching for the wrong value never is.
			assert.deepEqual(read.keys, systemd, `${name}: the reader says what systemd set`);
		}
		if (bash) {
			const sh = readStackKeys(content, { loader: "shell" });
			if (!sh.error) assert.deepEqual(sh.keys, bash, `${name}: the shell reading says what bash set`);
		}
	}
	// The adversary's lies, each refused now.
	for (const name of ["g1-a01-u2028-dq", "g1-a02-midcr-dq", "g1-a03-u2029-sq-backends", "g1-a04-u2028-proxy", "g1-a32-export-u2028", "g1-a05-nul-comment", "g1-a06-nul-value", "g1-a07-badutf8-value", "g1-a08-badutf8-key"]) {
		const row = rows.find((r) => r[0] === name);
		assert.ok(readStackKeys(row[1]).error, `${name}: refused`);
	}
	for (const name of ["g1-a23-shell-twoassign", "g1-a24-shell-tokensq"]) assert.ok(readStackKeys(rows.find((r) => r[0] === name)[1], { loader: "shell" }).error, `${name}: the shell reading refuses`);
	// And it still READS the must-pass rows, rather than passing the oracle by refusing everything.
	for (const [name, text, systemd] of rows.filter((r) => r[0].startsWith("p-") || ["g1-b01-badutf8-comment", "g1-b02-badutf8-noeq", "g1-b06-fffd-valid", "g1-b09-badutf8-semicolon-comment"].includes(r[0]))) {
		assert.deepEqual(readStackKeys(text).keys, systemd, name);
	}
});

test("#447 gate round 1: a port of systemd's parser, pinned to every measured row, finds no file the reader reads wrongly", () => {
	// THE PORT IS AN ORACLE ONLY BECAUSE OF THIS FIRST LOOP: it must give what systemd 259 set on every measured row.
	const venue = (env) => Object.fromEntries(Object.entries(env).filter(([k]) => STACK_KEYS.includes(k)).sort());
	for (const [name, text, systemd] of SYSTEMD_259_ENV_FILES) assert.deepEqual(venue(systemdEnvFile(text).env), systemd, `the port agrees with systemd on ${name}`);
	// Then seeded random files from the tokens every shape is made of. The reader refuses or agrees; it never vouches for
	// a value the port does not set. Seeded so a failure is a file anyone can reproduce, not a flake.
	let seed = 447;
	const rnd = () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	const TOKENS = ["PI_BACKENDS=", "PI_EGRESS=", "PI_EGRESS_PROXY=", "K=", "FOO-BAR=", "export K=", "export PI_BACKENDS=", "# ", "; ", '"', "'", "\\", "\n", "\n", "\n", "\r\n", "\r", " ", "\t", "podman", "0", "x", "=", "\u2028", "$'", "#", "\\\n"];
	let read = 0;
	for (let i = 0; i < 20000; i++) {
		let text = "";
		for (let k = 2 + Math.floor(rnd() * 14); k > 0; k--) text += TOKENS[Math.floor(rnd() * TOKENS.length)];
		const r = readStackKeys(text);
		if (r.error) continue;
		read++;
		assert.deepEqual(r.keys, venue(systemdEnvFile(text).env), `the reader vouched for what systemd does not set: ${JSON.stringify(text)}`);
	}
	assert.ok(read > 10000, `the reader still reads most of them (${read} of 20000), rather than passing by refusing`);
	// The file this found: a `#` line that is the tail of a continuation, where a lone CR starts a real line. The first
	// hazard is the continuation, and the comment spelling still counts because the file has a lone CR.
	assert.match(readStackKeys("export K= #0#  \\\n# export PI_BACKENDS=PI_EGRESS=\rPI_EGRESS_PROXY= K=FOO-BAR=").error, /^\.env line 1 has a trailing backslash/);
});

test("#447 gate round 1: `.env.example` spells the venue keys in comments, which alone never refuses a file", () => {
	// `init` copies it, so gating on any spelling refused every docker deployment with an unrelated odd line in it.
	// Measured on systemd 259 with the shipped file plus each tail: neither sets a venue key.
	const example = readFileSync(join(DEPLOY_DIR, "..", ".env.example"), "utf8");
	assert.match(example, /^# PI_BACKENDS=$/m, "the premise: the shipped example spells the key in a comment");
	assert.deepEqual(readStackKeys(`${example}FOO-BAR="x\nOTHER=1\n"\n`), { keys: {} }, "a non-identifier key's value, and no key spelled outside comments");
	assert.deepEqual(readStackKeys(`${example}X=a Y=0\nunset Z\n`, { loader: "shell" }), { keys: {} }, "the shells' hazards, the same");
	// A lone CR ELSEWHERE does not make the comments count (gate round 2; measured: the shipped example plus `X=1<CR>Y=2`
	// sets no venue key). Only text after a lone CR on a comment's own line can be read as a key.
	assert.deepEqual(readStackKeys(`${example}X=1\rY=2\n`), { keys: {} });
	assert.match(readStackKeys(`${example}# note\rPI_BACKENDS=podman\n`).error, /has a carriage return/);
	// And a caller about to WRITE a key refuses on any hazard (the setup wizard).
	assert.match(readStackKeys(`${example}FOO-BAR="x\nOTHER=1\n"\n`, { assumeSpelled: true }).error, /not a variable name/);
	assert.match(readStackKeys("X=1\nunset Y\n", { loader: "shell", assumeSpelled: true }).error, /a venue key is about to be written into it/);
	assert.deepEqual(readStackKeys("X=1\n", { assumeSpelled: true }), { keys: {} }, "a clean file is still read");
});

test("#447 gate round 2: a venue value longer than systemd passes on is refused, naming the key and the line", () => {
	// Measured on systemd 259: a value of 131068 bytes and up fails the exec ("Argument list too long") and one of 2 MB
	// is dropped at load (key unset); 131000 still passes. The bound here is 4096, far from both and from any real value.
	const at = (n) => readStackKeys(`PI_EGRESS=0\nPI_EGRESS_PROXY=${"h".repeat(n)}\n`);
	assert.deepEqual(at(4096).keys, { PI_EGRESS: "0", PI_EGRESS_PROXY: "h".repeat(4096) });
	assert.match(at(4097).error, /^\.env line 2 assigns PI_EGRESS_PROXY a value of 4097 bytes, and a venue value longer than 4096 bytes is refused by pi-dispatch \(a venue key never needs that much; systemd itself passes up to about 128 KiB\)\. Shorten it to at most 4096 bytes$/);
	assert.match(readStackKeys(`PI_BACKENDS=${"podman,".repeat(700)}podman\n`).error, /line 1 assigns PI_BACKENDS a value of 4906 bytes/);
	assert.match(readStackKeys(`PI_BACKENDS='${"é".repeat(2049)}'\n`).error, /a value of 4098 bytes/, "bytes, not characters");
});

test("#447 gate round 2: the comment gate, per line: a lone CR elsewhere does not make comments count, a continuation does", () => {
	assert.deepEqual(readStackKeys("# PI_BACKENDS=podman\nX=1\rY=2\n"), { keys: {} }, "the CR is on another line");
	assert.match(readStackKeys("# note\rPI_BACKENDS=podman\n").error, /has a carriage return/, "text after a lone CR on the comment's own line is a line");
	// To a shell a `#` line reached by a continuation is joined text (b52, measured: bash sets PI_EGRESS=0).
	assert.ok(readStackKeys("X=a\\\n#;PI_EGRESS=0\n", { loader: "shell" }).error);
	// The cmd wrapper has no shell hazards, even for a caller about to write.
	assert.deepEqual(readStackKeys("X=1\nunset Y\n", { loader: "cmd", assumeSpelled: true }), { keys: {} });
	assert.deepEqual(readStackKeys('X=a"b\n', { loader: "cmd", assumeSpelled: true }), { keys: {} }, "nor the shell branch at all: this line is a cmd hazard, and not what the writer asks about");
});

test("#447 gate round 3: a file too large for systemd to start the service with is refused, naming the key or the total", () => {
	assert.match(readStackKeys(`PI_EGRESS=0\nX=${"h".repeat(200000)}\n`).error, /^\.env line 2 has more environment than the service can safely be started with: one KEY=value longer than 131071 bytes fails with "Argument list too long", and a total over 2031616 bytes .* \(X=\.\.\. is 200002 bytes\): shorten that value/);
	const many = Array.from({ length: 24 }, (_, i) => `K${i}=${"h".repeat(100000)}`).join("\n");
	assert.match(readStackKeys(`PI_EGRESS=0\n${many}\n`).error, /\(the file's assignments reach \d+ bytes by this line\)/);
	assert.deepEqual(readStackKeys(`PI_EGRESS=0\nX=${"h".repeat(131060)}\n`).keys, { PI_EGRESS: "0" }, "c02, measured to run");
	// c16, measured: a 4091-byte proxy value in two-byte characters, under the project's 4096-byte cap, which systemd passed.
	const c16 = `http://a/${"\u00e9".repeat(2041)}`;
	assert.equal(Buffer.byteLength(c16), 4091);
	assert.deepEqual(readStackKeys(`PI_EGRESS_PROXY='${c16}'\n`).keys, { PI_EGRESS_PROXY: c16 }, "single-quoted, as the measured file has it");
});

test("#447: each shape is refused with its line, what systemd does with it, and what to change", () => {
	const cases = [
		['K="a" "b\nPI_BACKENDS=podman\n"\n', 1, /a second quote right after a value's closing quote.*: remove the second quote, or close it on the same line$/],
		['NOTE="a\nb" "c\nPI_BACKENDS=podman\n"\n', 2, /a second quote right after/],
		['FOO-BAR="x\nPI_BACKENDS=podman\n"\n', 1, /under a key that is not a variable name.*: rename the key to a valid variable name, close the quote on the same line, or delete the line$/],
		["X=1\rPI_BACKENDS=podman\n", 1, /a carriage return \(CR\) that is not part of a CRLF line ending, which systemd reads as a line break.*: remove the CR, or save the file with LF \(or CRLF\) line endings$/],
		['NOTE="a\nb"\\\nPI_BACKENDS=podman\n', 2, /a trailing backslash that systemd reads as joining the next line.*: remove the trailing backslash, or move the value onto one line$/],
	];
	for (const [text, line, what] of cases) {
		const err = readStackKeys(text, { path: "/srv/pi/.env" }).error;
		assert.ok(err, JSON.stringify(text));
		assert.ok(err.startsWith(`/srv/pi/.env line ${line} has `), err);
		assert.match(err, what);
		assert.match(err, /which venue keys \(PI_BACKENDS, PI_EGRESS, PI_EGRESS_PROXY\) it sets is unknown/);
	}
	// The whole file: the hazard can sit BELOW the key, and a key after a lone CR is one no line scan finds.
	assert.match(readStackKeys('PI_BACKENDS=podman\nFOO-BAR="x\nPI_EGRESS=0\n"\n').error, /^\.env line 2 has /);
	assert.match(readStackKeys("X=1\rPI_EGRESS_PROXY=my-squid\n").error, /^\.env line 1 has a carriage return/);
});

test("#447: a file that never names a venue key outside a comment is not refused over a systemd hazard, and other loaders are unaffected", () => {
	// Sound, not lenient: systemd builds a key only from contiguous text on one line, and a `#` or `;` line is a comment
	// to it unless a lone CR splits it, so a file that spells no key outside comments assigns none under either reading
	// (gate round 1 corrected "never spells one anywhere", which refused every file `init` makes from .env.example). A
	// docker deployment with an odd line elsewhere keeps working.
	assert.deepEqual(readStackKeys('FOO-BAR="x\nOTHER=1\n"\n'), { keys: {} });
	assert.deepEqual(readStackKeys("X=1\rOTHER=2\n"), { keys: {} });
	// The shells split on LF and carry every quote, and the cmd wrapper reads one line at a time: this is systemd's.
	assert.deepEqual(readStackKeys("X=1\rPI_BACKENDS=podman\n", { loader: "shell" }), { keys: {} });
	assert.deepEqual(readStackKeys("PI_BACKENDS=podman\nX=1\rY=2\n", { loader: "cmd" }).keys, { PI_BACKENDS: "podman" });
});

test("nits/R7/R32: `;` comments, a key inside another key's value, and a leading blank read as systemd reads them", () => {
	assert.deepEqual(readStackKeys("; PI_BACKENDS=local\nPI_BACKENDS=podman\n").keys, { PI_BACKENDS: "podman" });
	assert.deepEqual(readStackKeys("PI_ENV_SETUP=/opt/PI_BACKENDS.sh\n").keys, {}, "a key name inside another value touches nothing");
	assert.deepEqual(readStackKeys("NOTE=see PI_BACKENDS\n").keys, {});
	assert.deepEqual(readStackKeys("  PI_BACKENDS=podman\n").keys, { PI_BACKENDS: "podman" }, "leading blanks are allowed, as systemd allows them");
});

test("journalWrite (#468): a file with a mode is narrowed BEFORE the new text goes in, and created with it", () => {
	const ops = [];
	const store = new Map([["/x/valkey.env", "VALKEY_PASSWORD=\n"]]);
	const fs = { existsSync: (p) => store.has(p), readFileSync: (p) => store.get(p), writeFileSync: (p, d, o) => (ops.push(["write", p, o?.mode]), store.set(p, d)), chmodSync: (p, m) => ops.push(["chmod", p, m]) };
	const journal = [];
	journalWrite(fs, journal, "/x/valkey.env", `VALKEY_PASSWORD=${TEST_PASSWORD}\n`, { mode: 0o600 });
	assert.deepEqual(ops, [["chmod", "/x/valkey.env", 0o600], ["write", "/x/valkey.env", 0o600], ["chmod", "/x/valkey.env", 0o600]]);
	assert.deepEqual(journal, [{ path: "/x/valkey.env", existed: true, previous: "VALKEY_PASSWORD=\n" }]);
	ops.length = 0;
	journalWrite(fs, null, "/x/new.env", "V=1\n", { mode: 0o600 });
	assert.deepEqual(ops, [["write", "/x/new.env", 0o600], ["chmod", "/x/new.env", 0o600]]);
	ops.length = 0;
	journalWrite(fs, null, "/x/unit", "u\n");
	assert.deepEqual(ops, [["write", "/x/unit", undefined]], "a file without a mode is written as before");
});
