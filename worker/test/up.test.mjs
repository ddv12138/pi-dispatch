import { test } from "node:test";
import assert from "node:assert/strict";
import * as realFs from "node:fs";
import { lstatSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.mjs";
import { defaultPrompt, runUp } from "../src/up.mjs";
import { jobImageFix, registryQualified } from "../src/image-ref.mjs";
import { runInit } from "../src/init.mjs";
import { readPackagedProxyConf } from "../src/egress-conf-copy.mjs";
import { addToken } from "../src/console-tokens.mjs";
import { VALKEY_HEALTH_SCRIPT, VALKEY_IMAGE, VALKEY_START_SCRIPT } from "../src/valkey-auth.mjs";

// A fake `spawn`, mirroring doctor.test.mjs: plan keys are command-line prefixes ("docker version",
// "docker image inspect", "docker pull", "docker tag", "docker ps", "docker volume", "docker run")
// mapped to a canned exit code, a `{code, output}` pair, or "enoent" for a launch failure. Every spawn
// is recorded into `calls` so tests can assert the EXACT argv of every host mutation.
// `defaults` answers first where it has a key (the harness's docker ownership answers, only for prefixes the plan has
// none of), read beside the plan rather than merged into a copy, so a test that edits its plan mid-run is still heard.
function fakeSpawn(plan, calls = [], defaults = {}) {
	return (cmd, args, opts) => {
		const line = [cmd, ...args].join(" ");
		const dkey = Object.keys(defaults).find((k) => line.startsWith(k));
		const key = dkey ?? Object.keys(plan).find((k) => line.startsWith(k));
		const outcome = dkey ? defaults[dkey] : plan[key];
		calls.push({ cmd, args, opts });
		const stream = () => ({
			handlers: {},
			on(ev, cb) {
				this.handlers[ev] = cb;
				return this;
			},
		});
		const handlers = {};
		const child = {
			stdout: stream(),
			stderr: stream(),
			kill() {},
			on(ev, cb) {
				handlers[ev] = cb;
				return this;
			},
		};
		queueMicrotask(() => {
			if (outcome === "enoent") {
				handlers.error?.(new Error(`spawn ${cmd} ENOENT`));
				return;
			}
			// A FUNCTION outcome answers per call (the owner check's exec that first says LOADING).
			const resolved = typeof outcome === "function" ? outcome(cmd, args) : outcome;
			const { code, output, stderr } = typeof resolved === "object" && resolved !== null ? resolved : { code: resolved, output: "" };
			if (output) child.stdout.handlers.data?.(output);
			if (stderr) child.stderr.handlers.data?.(stderr);
			handlers.close?.(code);
		});
		return child;
	};
}

// 64 hex chars, distinctive on purpose: the no-secret-in-output assertions grep for exactly this.
const SECRET = "cafef00d".repeat(8);
// Issue #468: the Valkey password `up` generates in these tests, as distinctive, for the same assertions.
const PASSWORD = "5eca1ed0".repeat(8);

// Everything injected, everything recorded. `files` seeds the in-memory fs (path → text); the fake
// init deliberately creates nothing, so a test that wants a .env after init seeds it up front.
function harness({ plan = {}, listening = true, answers = [], files = {}, doctorCode = 0, argv = [], env = { PI_PROVIDER: "anthropic" }, cwd = "/deploy", platform = "linux", logsDirPathFn, settingsFilePathFn, extra = {}, failWrites = {}, failUnlinks = {}, links = new Set(), packagedConf = "conf\n", includeFile = true } = {}) {
	// Issue #503: `init` scaffolds the model endpoints' include beside the allowlist, and this harness fakes init, so a
	// folder that holds the allowlist holds the include too unless a test says otherwise (`includeFile: false`).
	if (includeFile && `${cwd}/egress-allowlist.conf` in files && !(`${cwd}/model-endpoints.conf` in files)) files = { ...files, [`${cwd}/model-endpoints.conf`]: "# generated\n" };
	// PR #475's review, round 3: docker answers the ownership questions up asks before it acts on a Valkey container or
	// volume. Unless a test says otherwise: no pi-dispatch-valkey, and nothing mounts pi-dispatch-valkey-data.
	const dockerDefaults = {};
	const planned = (line) => Object.keys(plan).some((k) => line.startsWith(k) || k.startsWith(line));
	if (!planned("docker container inspect pi-dispatch-valkey")) dockerDefaults["docker container inspect pi-dispatch-valkey"] = { code: 1, stderr: "Error: No such container: pi-dispatch-valkey\n" };
	if (!planned("docker ps -a")) dockerDefaults["docker ps -a"] = { code: 0, output: "" };
	// The volume gap (PR #475's review): no pi-dispatch-valkey-data yet, unless a test plans its own inspect answer.
	if (!Object.keys(plan).some((k) => k.startsWith("docker volume inspect"))) dockerDefaults["docker volume inspect"] = { code: 1, stderr: "Error: no such volume\n" };
	// The owner check before an adopted volume's Valkey is published (round-cap re-review): no marker, unless a test says.
	if (!Object.keys(plan).some((k) => k.startsWith("docker exec"))) dockerDefaults["docker exec"] = { code: 0, output: "\n" };
	const calls = [];
	const promptCalls = [];
	const initCalls = [];
	const initOpts = [];
	const doctorCalls = [];
	const doctorOpts = [];
	const buf = [];
	const store = new Map(Object.entries(files));
	const deps = {
		env,
		spawn: fakeSpawn(plan, calls, dockerDefaults),
		out: (s) => buf.push(s),
		prompt: (q) => {
			promptCalls.push(q);
			return answers.shift() ?? "";
		},
		fs: {
			existsSync: (p) => store.has(p),
			readFileSync: (p) => {
				if (!store.has(p)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
				return store.get(p);
			},
			// Issue #464: a path in `failWrites` is one this account cannot write (the injected write failure).
			writeFileSync: (p, data) => {
				if (failWrites[p]) throw failWrites[p];
				store.set(p, data);
			},
			unlinkSync: (p) => {
				if (failUnlinks[p]) throw failUnlinks[p];
				store.delete(p);
			},
			renameSync: (from, to) => {
				store.set(to, store.get(from));
				store.delete(from);
			},
			statSync: () => ({ mode: 0o100600 }),
			chmodSync: () => {},
			// Issue #484: what the rules refresh asks, which follows no link. A path in `links` is a symlink; a path some
			// stored file sits under is a directory.
			lstatSync: (p) => {
				const kind = links.has(p) ? "link" : store.has(p) ? "file" : [...store.keys()].some((k) => k.startsWith(`${p}/`)) ? "dir" : null;
				if (!kind) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
				return { mode: 0o100644, isSymbolicLink: () => kind === "link", isDirectory: () => kind === "dir", isFile: () => kind === "file" };
			},
		},
		// Issue #484: the package's rules, which every fixture's "conf\n" matches unless a test says otherwise, so a test
		// about something else is never asked about a refresh.
		readPackagedConf: () => packagedConf,
		now: () => Date.UTC(2026, 8, 29, 10, 15, 0),
		probeTcp: async () => listening,
		cwd,
		platform,
		randomHex: () => SECRET,
		newPassword: () => PASSWORD,
		// Resolved defaults, pinned rather than read off this host: `logsDirPath` calls the real
		// `homedir()`, so without these the byte-exact `.env` assertions below would assert whose account
		// ran the suite (issue #357).
		// The real ones RESOLVE rather than default (`env.PI_LOGS_DIR || <account default>`), and these
		// mirror that shape exactly: a fake that ignored the environment would hide the one case where
		// `up` can persist a path it must never persist.
		logsDirPathFn: logsDirPathFn ?? ((e) => e.PI_LOGS_DIR || "/home/op/.pi-dispatch/logs"),
		settingsFilePathFn: settingsFilePathFn ?? ((e) => e.PI_SETTINGS_FILE || "/home/op/.pi-dispatch/settings.json"),
		runInitFn: (cwd, opts) => {
			initCalls.push(cwd);
			initOpts.push(opts);
			return 0;
		},
		runDoctorFn: (env, opts) => {
			doctorCalls.push(env);
			doctorOpts.push(opts);
			return doctorCode;
		},
		// Issue #708: no console tokens unless a test says so; the default reads the real deployment folder.
		consoleOperators: () => 0,
		...extra,
	};
	return { run: () => runUp(argv, deps), deps, calls, promptCalls, initCalls, initOpts, doctorCalls, doctorOpts, store, text: () => buf.join("") };
}

// pi-dispatch-valkey is this deployment's: up's label names the harness's folder (PR #475's review, round 3).
const green = { "docker version": 0, "docker image inspect": 0, "docker container inspect pi-dispatch-valkey": inspectRecord({ label: "/deploy" }) };

// The exact host mutations up may ever run — asserted array-for-array below, because "shown then run"
// only holds if what runs is literally what was shown.
const PULL = ["pull", "docker.io/ddv12138/pi-job:latest"];
const TAG = ["tag", "docker.io/ddv12138/pi-job:latest", "pi-job:latest"];
// Labelled with the deployment folder (the volume gap, PR #475's review): the harness's /deploy.
const VOLUME = ["volume", "create", "--label", "com.pi-dispatch.deployment=/deploy", "pi-dispatch-valkey-data"];
// Issue #468: the password as `-e VALKEY_PASSWORD` (its value in the spawn's environment, never here), and the start
// script and health check that hand it to Valkey on stdin and REDISCLI_AUTH (valkey-auth.mjs pins those two strings to
// the Quadlet unit and the compose file).
// Round 3 of PR #475's review: labelled with the deployment folder (the harness's /deploy, which has no real path here).
const VALKEY_RUN = [
	"run", "-d", "--name", "pi-dispatch-valkey", "--label", "com.pi-dispatch.deployment=/deploy", "--restart", "unless-stopped",
	"-p", "127.0.0.1:6379:6379", "-v", "pi-dispatch-valkey-data:/data", "-e", "VALKEY_PASSWORD",
	"--health-cmd", VALKEY_HEALTH_SCRIPT, "--health-interval", "10s", "--health-timeout", "3s", "--health-retries", "5",
	VALKEY_IMAGE, "sh", "-c", VALKEY_START_SCRIPT,
];

/**
 * One `docker container inspect` answer (PR #475's review, round 3): a container with up's label, compose's working
 * dir, or neither, publishing 6379 on `port`.
 */
function inspectRecord({ name = "pi-dispatch-valkey", label, workingDir, port = 6379, image } = {}) {
	const Labels = {};
	if (label) Labels["com.pi-dispatch.deployment"] = label;
	if (workingDir) Labels["com.docker.compose.project.working_dir"] = workingDir;
	// Issue #761: the image the container was created from, as `Config.Image` holds it, where a test gives one.
	return { code: 0, output: JSON.stringify([{ Name: `/${name}`, Config: { Labels, ...(image ? { Image: image } : {}) }, HostConfig: { PortBindings: { "6379/tcp": [{ HostIp: "127.0.0.1", HostPort: String(port) }] } } }]) };
}

test("up: everything already in place prompts for nothing and exits 0", async () => {
	const h = harness({ plan: green, listening: true });
	assert.equal(await h.run(), 0);
	assert.equal(h.promptCalls.length, 0, "nothing missing, nothing to consent to");
	assert.match(h.text(), /Job image present \(pi-job:latest\)/);
	assert.match(h.text(), /assuming your Valkey/);
	assert.match(h.text(), /up: summary/);
});

// Issue #761: a Valkey container an older `up` started keeps the floating valkey/valkey:8 until it is recreated, and up
// leaves a Valkey it finds on its image. The summary names it, and the way off it, from the inspect up already makes.
test("up: this deployment's pi-dispatch-valkey on the floating valkey/valkey:8 is named in the summary and left as it is (#761)", async () => {
	const shown = /\n {2}valkey image {10}the pi-dispatch-valkey container runs valkey\/valkey:8, the floating tag an older `pi-dispatch up` started it with, and keeps it until it is recreated; this release pins valkey\/valkey:8\.1\. `docker stop pi-dispatch-valkey && docker rm pi-dispatch-valkey && pi-dispatch up` in the deployment folder starts valkey\/valkey:8\.1 on the same pi-dispatch-valkey-data volume/;
	const running = (image) => harness({ plan: { ...green, "docker container inspect pi-dispatch-valkey": inspectRecord({ label: "/deploy", image }) }, listening: true });
	const old = running("valkey/valkey:8");
	assert.equal(await old.run(), 0, "a hint, never a failed up");
	assert.match(old.text(), shown);
	assert.ok(old.text().indexOf("valkey image") > old.text().indexOf("up: summary"), "in the summary");
	assert.ok(!old.calls.some((c) => ["stop", "rm", "run", "start"].includes(c.args[0])), "named, never acted on");
	// This release's image, an image of the operator's choosing, or none recorded: no row, and not one docker call more.
	for (const image of [VALKEY_IMAGE, "valkey/valkey:8.1-alpine", "docker.io/valkey/valkey:8.0", undefined]) {
		const t = running(image);
		assert.equal(await t.run(), 0);
		assert.doesNotMatch(t.text(), /valkey image/, String(image));
		assert.deepEqual(t.calls.map((c) => [c.cmd, ...c.args].join(" ")), old.calls.map((c) => [c.cmd, ...c.args].join(" ")), "the image comes off the ownership inspect");
	}
	// Stopped on the older image: the same row beside `docker start`, which would only start it on that image again.
	const stopped = harness({ plan: { "docker version": 0, "docker image inspect": 0, "docker container inspect pi-dispatch-valkey": inspectRecord({ label: "/deploy", image: "docker.io/valkey/valkey:8" }) }, listening: false, argv: ["--yes"] });
	assert.equal(await stopped.run(), 0);
	assert.match(stopped.text(), /pi-dispatch-valkey exists \(this deployment's\) and is not running/);
	assert.match(stopped.text(), /\n {2}valkey image {10}the pi-dispatch-valkey container runs docker\.io\/valkey\/valkey:8, /);
	assert.ok(!stopped.calls.some((c) => ["stop", "rm", "run", "start"].includes(c.args[0])));
	// Another deployment's container on the older image is not this deployment's to name: up refuses it, as before.
	const foreign = harness({ plan: { "docker version": 0, "docker image inspect": 0, "docker container inspect pi-dispatch-valkey": inspectRecord({ label: "/srv/a", port: 16495, image: "valkey/valkey:8" }) }, listening: false, argv: ["--yes"] });
	assert.equal(await foreign.run(), 1);
	assert.doesNotMatch(foreign.text(), /valkey image/);
});

// The container row's fix is `docker stop` and `docker rm` of pi-dispatch-valkey, so it is said only of a container up
// runs itself (`upValkeyContainerImage`, doctor's rule too). In a folder /dispatch setup handed to compose, compose runs
// the Valkey and recreates it from the compose file (whose own line doctor names); another deployment's is never touched.
test("up: a Valkey container up does not run itself, compose's in a handed-over folder or another deployment's, gets no valkey image row (#761)", async () => {
	const files = { "/deploy/.env": `VALKEY_URL=redis://127.0.0.1:16495\nVALKEY_PASSWORD=${PASSWORD}\n`, "/deploy/deploy/docker-compose.valkey.yml": "# override\n" };
	const composeValkey = inspectRecord({ name: "deploy-valkey-1", workingDir: "/deploy/deploy", port: 16495, image: "valkey/valkey:8" });
	const h = harness({ plan: { "docker version": 0, "docker image inspect": 0, "docker container inspect deploy-valkey-1": composeValkey }, listening: true, files });
	assert.equal(await h.run(), 0);
	assert.match(h.text(), /container deploy-valkey-1 already running/, "this deployment's, by compose's working dir, and left as it is");
	assert.doesNotMatch(h.text(), /valkey image/);
	assert.ok(!h.calls.some((c) => ["stop", "rm", "run", "start", "compose"].includes(c.args[0])), "nothing acted on");
	// Another deployment's pi-dispatch-valkey answering on this port, on the older image: up leaves it, and names no fix
	// that would stop and remove it.
	const foreign = harness({ plan: { ...green, "docker container inspect pi-dispatch-valkey": inspectRecord({ label: "/srv/a", image: "valkey/valkey:8" }) }, listening: true });
	assert.equal(await foreign.run(), 0);
	assert.match(foreign.text(), /pi-dispatch-valkey is not this deployment's Valkey \(the deployment in \/srv\/a\)/);
	assert.doesNotMatch(foreign.text(), /valkey image/);
});

test("up: declined prompts run NOTHING and the summary says skipped", async () => {
	const h = harness({
		plan: { "docker version": 0, "docker image inspect": 1 },
		listening: false,
		answers: ["", ""], // two prompts, both answered with Enter — the default is No
	});
	assert.equal(await h.run(), 0, "declining is not an error; doctor still ran and was green");
	assert.equal(h.promptCalls.length, 2, "one consent per docker action pair (image, valkey)");
	// The ONLY spawns are the three read-only probes — no pull, no tag, no volume, no run. The third is the
	// egress proxy, which the policy being ON by default makes up look for; it asks nothing here because
	// this deployment has no egress-allowlist.conf, and up declines that step itself rather than standing
	// up a proxy with no allowlist behind it.
	assert.deepEqual(h.calls.map((c) => c.args), [
		["version"],
		["image", "inspect", "pi-job:latest"],
		// Round 3 of PR #475's review: whose pi-dispatch-valkey is (none here) and who mounts its volume, both read-only.
		["container", "inspect", "pi-dispatch-valkey"],
		["ps", "-a", "--filter", "volume=pi-dispatch-valkey-data", "--format", "{{.Names}}"],
		// The volume gap (PR #475's review): whose pi-dispatch-valkey-data is (none yet), read-only.
		["volume", "inspect", "pi-dispatch-valkey-data"],
		["inspect", PROXY_INSPECT.slice("docker inspect ".length, -" pi-dispatch-egress-proxy".length), "pi-dispatch-egress-proxy"],
	]);
	assert.match(h.text(), /job image\s+skipped \(declined\)/);
	assert.match(h.text(), /valkey\s+skipped \(declined\)/);
	assert.match(h.text(), /egress-allowlist\.conf is not here/);
});

test("up: --yes runs both docker action pairs with exactly the argv that was shown", async () => {
	const h = harness({
		plan: { "docker version": 0, "docker image inspect": 1, "docker pull": 0, "docker tag": 0, "docker volume": 0, "docker run": 0 },
		listening: false,
		argv: ["--yes"],
	});
	assert.equal(await h.run(), 0);
	assert.equal(h.promptCalls.length, 0, "--yes waives every prompt");
	const argvs = h.calls.map((c) => c.args);
	assert.deepEqual(argvs.find((a) => a[0] === "pull"), PULL);
	assert.deepEqual(argvs.find((a) => a[0] === "tag"), TAG);
	assert.deepEqual(argvs.find((a) => a[0] === "volume" && a[1] === "create"), VOLUME);
	assert.deepEqual(argvs.find((a) => a[0] === "run"), VALKEY_RUN);
	assert.ok(argvs.findIndex((a) => a[0] === "pull") < argvs.findIndex((a) => a[0] === "tag"), "pull before tag");
	assert.ok(argvs.findIndex((a) => a[0] === "volume" && a[1] === "create") < argvs.findIndex((a) => a[0] === "run"), "volume before run");
	// --yes waives consent, never visibility: the commands are still printed before they run.
	assert.match(h.text(), /docker pull docker\.io\/ddv12138\/pi-job:latest/);
	assert.match(h.text(), /docker volume create --label com\.pi-dispatch\.deployment=\/deploy pi-dispatch-valkey-data/);
});

test("up: an image already present is never prompted for", async () => {
	const h = harness({ plan: { "docker version": 0, "docker image inspect": 0 }, listening: false, answers: [""] });
	await h.run();
	assert.equal(h.promptCalls.length, 1, "only the valkey consent remains");
	assert.match(h.promptCalls[0], /Proceed/);
	assert.equal(h.calls.map((c) => c.args).find((a) => a[0] === "pull"), undefined);
});

test("up: something listening on 6379 never prompts and never runs docker run", async () => {
	const h = harness({ plan: green, listening: true });
	await h.run();
	assert.equal(h.promptCalls.length, 0);
	const argvs = h.calls.map((c) => c.args);
	assert.equal(argvs.find((a) => a[0] === "run"), undefined);
	assert.equal(argvs.find((a) => a[0] === "volume"), undefined);
	assert.match(h.text(), /assuming your Valkey \(it is the pi-dispatch-valkey container\)/);
});

test("up: a foreign listener on 6379 is assumed but not claimed as ours", async () => {
	const h = harness({ plan: { ...green, "docker container inspect pi-dispatch-valkey": { code: 1, stderr: "Error: No such container: pi-dispatch-valkey\n" } }, listening: true });
	await h.run();
	assert.match(h.text(), /assuming your Valkey/);
	assert.doesNotMatch(h.text(), /it is the pi-dispatch-valkey container/);
	// Round 3 of PR #475's review: a pi-dispatch-valkey another deployment's up labelled is not ours by its name, and one
	// docker cannot describe is not ours either.
	for (const [answer, said] of [[inspectRecord({ label: "/srv/other" }), /pi-dispatch-valkey is not this deployment's Valkey \(the deployment in \/srv\/other\), so it is never stopped, removed or reused from here/], [{ code: 125, stderr: "Cannot connect to the Docker daemon\n" }, null]]) {
		const o = harness({ plan: { ...green, "docker container inspect pi-dispatch-valkey": answer }, listening: true });
		await o.run();
		assert.doesNotMatch(o.text(), /it is the pi-dispatch-valkey container/);
		if (said) assert.match(o.text(), said);
	}
});

test("up: init and doctor always run, even when every docker action was declined", async () => {
	const h = harness({ plan: { "docker version": 0, "docker image inspect": 1 }, listening: false, answers: ["n", "n"] });
	await h.run();
	assert.deepEqual(h.initCalls, ["/deploy"], "init ran, in the working directory");
	assert.equal(h.doctorCalls.length, 1, "doctor ran");
	// Issue #278: `up` runs plain doctor. `--live` starts containers, and `up`'s consent covers only the actions it
	// shows, so it must never pass the flag through.
	assert.equal(Object.hasOwn(h.doctorOpts[0] ?? {}, "live"), false, "up never asks doctor to run live probes");
	assert.match(h.text(), /never overwrites/, "the never-clobber contract is said out loud");
});

test("up: WEBHOOK_SECRET is generated into an empty .env and the value NEVER reaches output", async () => {
	const h = harness({ plan: green, files: { "/deploy/.env": "A=1\nWEBHOOK_SECRET=\n" } });
	await h.run();
	// The four path keys land beside it (issue #357), which four other files have promised for a year.
	// Issue #468: and the deployment's Valkey password, generated like the webhook secret, never printed either.
	assert.equal(
		h.store.get("/deploy/.env"),
		`A=1\nWEBHOOK_SECRET=${SECRET}\nPI_PAUSE_WINDOWS_FILE=/deploy/pause-windows.json\nPI_SCOPED_LIMITS_FILE=/deploy/scoped-limits.json\nPI_PROJECTS_FILE=/deploy/projects.json\nPI_LOGS_DIR=/home/op/.pi-dispatch/logs\nPI_SETTINGS_FILE=/home/op/.pi-dispatch/settings.json\nVALKEY_PASSWORD=${PASSWORD}\n`,
		"the key was filled, the five paths (projects since #499) and the password appended, other lines untouched",
	);
	assert.ok(!h.text().includes(SECRET), "the secret value must never be printed");
	assert.ok(!h.text().includes(PASSWORD), "the Valkey password must never be printed");
	assert.match(h.text(), /generated WEBHOOK_SECRET/);
	assert.match(h.text(), /generated VALKEY_PASSWORD into \.env/);
});

test("up: a key whose value is `\"\"` is named as EMPTY, not merely `already set` (#365)", async () => {
	// `KEY=""` is SET to the never-clobber rule -- an operator who wrote it meant something by it, and `up`
	// mutating a value they chose is the one thing this command must not do -- and EMPTY to every consumer
	// that reads the key at all. NOT unset, which is what this comment said and what doctor acted on until
	// issue #384: the shells and `EnvironmentFile=` both SET the variable to an empty string (measured in
	// sh, bash, dash and zsh, and on systemd 252), `config.mjs` keeps it through `??`, and the worker then
	// refuses to start on a path that is nothing. So `up` said "already set" three lines above a doctor
	// warning saying the feature is OFF, when the deployment was in fact DOWN.
	//
	// The literal loader keeps an empty value as an empty one, as the POSIX loaders do: the old cmd
	// grammar was the one exception, and it is gone with host-service deployment.
	//
	// NAMED ON `up`'S SIDE. A fourth doctor state was rejected: a state exists to carry a DECISION, and
	// this is a wording overlap between two correct sentences.
	const h = harness({ plan: green, files: { "/deploy/.env": `WEBHOOK_SECRET=x\nPI_PAUSE_WINDOWS_FILE=""\nPI_SCOPED_LIMITS_FILE=/deploy/scoped-limits.json\n` } });
	await h.run();
	assert.equal(h.store.get("/deploy/.env").includes('PI_PAUSE_WINDOWS_FILE=""'), true, "and the line itself is STILL untouched, which is the point of saying it rather than fixing it");
	const text = h.text();
	// THE CONSEQUENCE IS THE POINT, and the first version of this said the opposite. `config.mjs` reads this
	// key with `??`, so an empty string survives, and `start.mjs` calls `loadPauseWindows` unconditionally at
	// boot, which throws on a path that does not exist (measured: `pause-windows file does not exist: `). So
	// "every consumer reads as unset" was false and the worker does not ignore the feature: it refuses to
	// start. Two sentences that read as a contradiction had been replaced by two that agreed with each other
	// and disagreed with the worker.
	assert.match(text, /PI_PAUSE_WINDOWS_FILE[\s\S]*?its value is EMPTY[\s\S]*?REFUSES TO BOOT/, "the empty value is named with what it actually does");
	assert.doesNotMatch(text, /which every consumer reads as unset/, "the false reading is gone");
	// The key beside it, with a real value, keeps the plain sentence -- so the new wording is about the
	// value and not about every untouched key.
	assert.match(text, /PI_SCOPED_LIMITS_FILE[\s\S]*?already set — left untouched/, "a key with a real value reads as before");
	// And a `KEY=` with nothing after it is not this case at all: `setEnvKeyIfEmpty` FILLS that one, so it
	// is reported as written and never reaches the untouched branch.
	const filled = harness({ plan: green, files: { "/deploy/.env": "WEBHOOK_SECRET=x\nPI_PAUSE_WINDOWS_FILE=\n" } });
	await filled.run();
	assert.match(filled.text(), /PI_PAUSE_WINDOWS_FILE=\/deploy\/pause-windows\.json written into \.env/);
	assert.doesNotMatch(filled.text(), /PI_PAUSE_WINDOWS_FILE[^\n]*the line is there and its value is/);

	// THE CONSEQUENCE IS PER KEY, and only the two `config.mjs` reads with `??` refuse a boot. `PI_LOGS_DIR`
	// and `PI_SETTINGS_FILE` use `||` and fall back to the account default; `WEBHOOK_SECRET` reads as absent.
	// Saying "refuses to boot" for those three would be the same overstatement one key over.
	const secret = harness({ plan: green, files: { "/deploy/.env": `WEBHOOK_SECRET=""\nPI_PAUSE_WINDOWS_FILE=/deploy/pause-windows.json\nPI_SCOPED_LIMITS_FILE=/deploy/scoped-limits.json\nPI_LOGS_DIR=/home/op/.pi-dispatch/logs\nPI_SETTINGS_FILE=/home/op/.pi-dispatch/settings.json\n` } });
	await secret.run();
	const secretText = secret.text();
	assert.match(secretText, /⚠ WEBHOOK_SECRET has a line in \.env and its value is EMPTY — left untouched/, "a ⚠, because every other ✓ in that block means this is fine");
	assert.match(secretText, /WEBHOOK_SECRET[\s\S]*?its value is empty, which reads as unset/, "and the plain consequence, not the boot one");
	assert.doesNotMatch(secretText, /WEBHOOK_SECRET[^\n]*REFUSES TO BOOT/, "WEBHOOK_SECRET does not refuse a boot");
	assert.equal(secret.store.get("/deploy/.env").includes('WEBHOOK_SECRET=""'), true, "and it is still untouched");

	// The other direction of "both readings are asked": set for systemd, EMPTIED by a later export line. The
	// key is configured for `EnvironmentFile=` and unset for a sourcing shell, so calling it empty would be wrong
	// for the systemd operator. (The mirror of this is pinned above.)
	const halfEmpty = harness({ plan: green, files: { "/deploy/.env": "WEBHOOK_SECRET=x\nPI_PAUSE_WINDOWS_FILE=/systemd.json\nexport PI_PAUSE_WINDOWS_FILE=\n" } });
	await halfEmpty.run();
	assert.doesNotMatch(halfEmpty.text(), /PI_PAUSE_WINDOWS_FILE[^\n]*its value is/, "set for one consumer is not empty, whichever consumer it is");

	// BOTH READINGS ARE ASKED, and this is the case that needs the second one. A bare `PI_X=` with an
	// `export PI_X=/v.json` below it is empty for systemd's `EnvironmentFile=` and SET for a shell that
	// sources the file and takes the last assignment. Calling that "empty" would tell such an operator
	// their configured key is unset. `up` leaves it alone either way, because the export line is a value
	// the operator wrote.
	const halfSet = harness({ plan: green, files: { "/deploy/.env": "WEBHOOK_SECRET=x\nPI_PAUSE_WINDOWS_FILE=\nexport PI_PAUSE_WINDOWS_FILE=/v.json\n" } });
	await halfSet.run();
	assert.doesNotMatch(halfSet.text(), /PI_PAUSE_WINDOWS_FILE[^\n]*the line is there and its value is empty/, "set for one consumer is not empty");
	assert.equal(halfSet.store.get("/deploy/.env").includes("export PI_PAUSE_WINDOWS_FILE=/v.json"), true, "and never clobbered");
});



test("up: the two FILE keys get this folder and the two DURABLE ones get the account default (#357)", async () => {
	// The split is the sharpest edge in this change. `makeLogReaper` unlinks every `.log` and `.json` in
	// PI_LOGS_DIR past the window with no name shape and no ownership check, so a deployment folder there
	// would eat triggers.json and its siblings thirty days in, silently, and the worker would then run
	// nothing while reporting success. A pinned resolved default changes no behaviour and makes the value
	// explicit, which is what stops a worker under another `User=` and the panel resolving two directories.
	const h = harness({ plan: green, files: { "/deploy/.env": "" } });
	await h.run();
	const written = Object.fromEntries(
		h.store
			.get("/deploy/.env")
			.split("\n")
			.filter(Boolean)
			.map((l) => l.split("=")),
	);
	assert.equal(written.PI_PAUSE_WINDOWS_FILE, "/deploy/pause-windows.json");
	assert.equal(written.PI_SCOPED_LIMITS_FILE, "/deploy/scoped-limits.json");
	assert.equal(written.PI_LOGS_DIR, "/home/op/.pi-dispatch/logs");
	assert.equal(written.PI_SETTINGS_FILE, "/home/op/.pi-dispatch/settings.json");
	for (const key of Object.keys(written)) assert.notEqual(written[key], "/deploy", `${key} must never be the deployment folder itself`);
	assert.notEqual(written.PI_LOGS_DIR, "/deploy/logs", "nor the directory the service installer already owns");
});

test("up REFUSES to pin a durable path that resolves inside this folder, and says why (#357)", async () => {
	// `logsDirPath` RESOLVES rather than defaults: `env.PI_LOGS_DIR || <account default>`. Three shipped
	// files told operators for a year that `up` pins these to the deployment folder, so a shell that
	// already exports one there is exactly the case this change makes reachable -- and persisting it would
	// hand the log retention sweep a directory holding triggers.json, which it deletes a month later with
	// no name shape and no ownership check. The refusal lives here rather than in the resolver, because
	// the resolver is right for the worker: an exported path SHOULD be honoured at run time.
	const h = harness({ plan: green, files: { "/deploy/.env": "" }, env: { PI_PROVIDER: "anthropic", PI_LOGS_DIR: "/deploy", PI_SETTINGS_FILE: "/deploy/logs/settings.json" } });
	await h.run();
	const written = h.store.get("/deploy/.env");
	assert.doesNotMatch(written, /^PI_LOGS_DIR=/m, "the deployment folder itself is refused");
	assert.doesNotMatch(written, /^PI_SETTINGS_FILE=/m, "and so is anything under it");
	assert.match(h.text(), /PI_LOGS_DIR is \/deploy in this shell, which is inside this deployment folder/, "and it names where the value came from, or the operator looks in .env and finds nothing to change");
	assert.match(h.text(), /NOT written/);
	// The two FOLDER keys are unaffected: they are meant to be here, and nothing sweeps them.
	assert.match(written, /^PI_PAUSE_WINDOWS_FILE=\/deploy\/pause-windows\.json$/m);
});

test("up REFUSES a RELATIVE durable path, which is the same harm reached the short way (#357)", async () => {
	// `PI_LOGS_DIR=.` in the shell that runs `up` is persisted verbatim, and a relative value resolves
	// against the unit's `WorkingDirectory`, which is the deployment folder. The retention sweep then takes
	// `triggers.json` and its siblings a month later. All three deploy templates document this key as
	// absolute, and until this refusal nothing enforced it.
	for (const relative of [".", "./logs", "logs", "../pi-logs"]) {
		const h = harness({ plan: green, files: { "/deploy/.env": "" }, env: { PI_PROVIDER: "anthropic", PI_LOGS_DIR: relative } });
		await h.run();
		assert.doesNotMatch(h.store.get("/deploy/.env"), /^PI_LOGS_DIR=/m, relative);
		assert.match(h.text(), /is not an absolute path/, relative);
	}
});

test("up does NOT refuse a computed default that happens to sit under this folder (#357)", async () => {
	// A deployment folder that IS the service account's home is an ordinary layout, and the account default
	// is then `<home>/.pi-dispatch/logs`, which is "inside" it. Nothing is at risk there: that directory
	// holds run records only, `triggers.json` is a sibling of `.pi-dispatch` rather than inside it, and the
	// worker resolves that same path anyway. Refusing would reject the path already chosen and blame the
	// operator for a layout that is fine, so only a value THIS SHELL supplied is checked.
	const h = harness({ plan: green, files: { "/deploy/.env": "" }, env: { PI_PROVIDER: "anthropic" }, logsDirPathFn: () => "/deploy/.pi-dispatch/logs", settingsFilePathFn: () => "/deploy/.pi-dispatch/settings.json" });
	await h.run();
	assert.match(h.store.get("/deploy/.env"), /^PI_LOGS_DIR=\/deploy\/\.pi-dispatch\/logs$/m);
	assert.doesNotMatch(h.text(), /NOT written/);
});

test("up: the inside-the-folder compare folds case on Windows and does not on POSIX (#357)", async () => {
	// Windows is a supported deployment. Windows paths are case-insensitive and accept either
	// separator, so a byte compare misses `c:\\pi\\deploy\\logs` against `C:/pi/deploy` and writes exactly
	// the value this guard exists to refuse. POSIX is case-sensitive, where folding would refuse a
	// different directory that merely looks alike.
	const win = harness({ plan: green, files: { "C:/pi/deploy/.env": "" }, env: { PI_PROVIDER: "anthropic", PI_LOGS_DIR: "c:\\pi\\deploy\\logs" }, cwd: "C:/pi/deploy", platform: "win32" });
	await win.run();
	assert.doesNotMatch(win.store.get("C:/pi/deploy/.env"), /^PI_LOGS_DIR=/m, "the same folder in another spelling is still this folder");

	const posix = harness({ plan: green, files: { "/deploy/.env": "" }, env: { PI_PROVIDER: "anthropic", PI_LOGS_DIR: "/DEPLOY/logs" }, cwd: "/deploy", platform: "linux" });
	await posix.run();
	assert.match(posix.store.get("/deploy/.env"), /^PI_LOGS_DIR=\/DEPLOY\/logs$/m, "and a differently-cased path on POSIX is a different directory");

	// And the absolute check has to use the same platform, or a perfectly good drive-letter path reads as
	// relative and is refused with a message about a `WorkingDirectory` that has nothing to do with it.
	const otherDrive = harness({ plan: green, files: { "C:/pi/deploy/.env": "" }, env: { PI_PROVIDER: "anthropic", PI_LOGS_DIR: "D:/pi-history" }, cwd: "C:/pi/deploy", platform: "win32" });
	await otherDrive.run();
	assert.match(otherDrive.store.get("C:/pi/deploy/.env"), /^PI_LOGS_DIR=D:\/pi-history$/m, "another drive is absolute, and is not inside this folder");
	assert.doesNotMatch(otherDrive.text(), /not an absolute path/);
});

test("up writes Windows paths with forward slashes, which the literal loader reads bare (#357)", async () => {
	// A backslash is outside the bare set the writer and the reader share, so the writer would quote a path
	// carrying one, and the service would read the quotes as part of the path: four directories that do not
	// exist, behind four ✓. Forward slashes are accepted everywhere Node accepts a path on Windows, and
	// `config.mjs` already spells its own defaults that way.
	const h = harness({
		plan: green,
		files: { "C:/pi/deploy/.env": "" },
		env: { PI_PROVIDER: "anthropic" },
		// Forward slashes in `cwd` because `join` here is this host's, not win32's; what the win32 branch
		// has to convert is the RESOLVER output below, which is where a real Windows path comes from.
		cwd: "C:/pi/deploy",
		platform: "win32",
		logsDirPathFn: () => "C:\\Users\\op\\.pi-dispatch\\logs",
		settingsFilePathFn: () => "C:\\Users\\op\\.pi-dispatch\\settings.json",
	});
	await h.run();
	const written = h.store.get("C:/pi/deploy/.env") ?? "";
	assert.doesNotMatch(written, /'/, "no value is quoted, because the shared grammar writes a plain path bare");
	assert.doesNotMatch(written, /\\\\/, "and none carries a backslash, which the bare set excludes");
	assert.match(written, /^PI_LOGS_DIR=C:\/Users\/op\/\.pi-dispatch\/logs$/m);
});

test("up edits a symlinked .env through the link, with the REAL fs seam (#357)", async () => {
	// The one test here that uses no fs fake, because the defect it pins is a fake's shape rather than a
	// behaviour: `updateEnvFile` resolves the path with an OPTIONAL call, so a seam missing
	// `realpathSync` makes the resolution silently inert. It shipped that way, and the test that covered
	// it attached the method to its own fake. A deployment whose `.env` points at a shared env file is an
	// ordinary layout, and replacing the link orphans every later edit to the shared file.
	const dir = tempDir("pi-up-link-");
	const shared = join(dir, "shared.env");
	writeFileSync(shared, "WEBHOOK_SECRET=\n");
	symlinkSync(shared, join(dir, ".env"));
	const buf = [];
	await runUp(["--yes"], {
		env: { PI_PROVIDER: "anthropic" },
		cwd: dir,
		out: (s) => buf.push(s),
		spawn: fakeSpawn(green, []),
		prompt: async () => "n",
		probeTcp: async () => true,
		randomHex: () => SECRET,
		newPassword: () => PASSWORD,
		runInitFn: () => 0,
		runDoctorFn: () => 0,
	});
	assert.ok(lstatSync(join(dir, ".env")).isSymbolicLink(), "the link survives a real up");
	assert.match(readFileSync(shared, "utf8"), /^WEBHOOK_SECRET=/m, "and the shared file is what was edited");
});

test("up keeps a .env's group with the REAL fs seam, where this account is in that group (#522)", async (t) => {
	// The same shape of defect as the link above: `updateEnvFile` keeps the group with an OPTIONAL call, so a seam
	// missing `chownSync` (or `unlinkSync`, which removes a refused tmp) makes the repair silently inert. Driven with a
	// real file whose group is one this account is in and new files in its folder do NOT get.
	const dir = tempDir("pi-up-group-");
	writeFileSync(join(dir, "probe"), "");
	const folderGives = realFs.statSync(join(dir, "probe")).gid;
	const other = (process.getgroups?.() ?? []).find((g) => g !== folderGives);
	if (other === undefined) return t.skip("this account is in no group other than the one this folder gives new files");
	writeFileSync(join(dir, ".env"), "WEBHOOK_SECRET=\n");
	realFs.chownSync(join(dir, ".env"), -1, other);
	const buf = [];
	await runUp(["--yes"], {
		env: { PI_PROVIDER: "anthropic" },
		cwd: dir,
		out: (s) => buf.push(s),
		spawn: fakeSpawn(green, []),
		prompt: async () => "n",
		probeTcp: async () => true,
		randomHex: () => SECRET,
		newPassword: () => PASSWORD,
		runInitFn: () => 0,
		runDoctorFn: () => 0,
	});
	assert.match(readFileSync(join(dir, ".env"), "utf8"), /^WEBHOOK_SECRET=[0-9a-f]+$/m, buf.join(""));
	assert.equal(realFs.statSync(join(dir, ".env")).gid, other, "and the rewritten file still has its group");
});

test("up reports a .env it cannot write at all, rather than dying with a stack trace (#357)", async () => {
	// A read-only deployment directory, a full disk, or a `.env` this account does not own. The
	// WEBHOOK_SECRET write is the first one and used to be the unwrapped one.
	const h = harness({ plan: green, files: { "/deploy/.env": "" } });
	h.store.set("/deploy/.env", "");
	const original = h.deps.fs.writeFileSync;
	h.deps.fs.writeFileSync = () => {
		throw Object.assign(new Error("EACCES: permission denied, open '/deploy/.env.tmp'"), { code: "EACCES" });
	};
	assert.equal(await h.run(), 0, "a .env it cannot write is reported, not fatal");
	h.deps.fs.writeFileSync = original;
	assert.match(h.text(), /WEBHOOK_SECRET could not be written: EACCES/);
	assert.match(h.text(), /PI_LOGS_DIR could not be written: EACCES/);
});

test("up refuses a value this .env cannot represent, rather than writing one nothing reads back (#357)", async () => {
	// `renderEnvValue` throws on a single quote: the shells want it escaped as `'\\''` and systemd's parser
	// does not understand that, so no one rendering is read identically by both consumers.
	const h = harness({ plan: green, files: { "/it's/deploy/.env": "" }, env: { PI_PROVIDER: "anthropic" }, cwd: "/it's/deploy" });
	await h.run();
	assert.match(h.text(), /PI_PAUSE_WINDOWS_FILE could not be written: .*single quote/);
	assert.match(h.text(), /NOT written/);
	// The value's advice, where the value is what was refused: this folder's path, so moving the folder fixes it.
	assert.match(h.text(), /PI_PAUSE_WINDOWS_FILE +NOT written: cannot write this value into a \.env safely: it contains a single quote\. Set it by hand, or move the deployment somewhere without that character in its path\n/);
});

test("up: a DURABLE path it cannot write is told to pick a path, not to move the deployment (#522)", async () => {
	// PI_LOGS_DIR and PI_SETTINGS_FILE are the account default (or this shell's), never this folder, so moving the
	// deployment changes nothing about them.
	const h = harness({ plan: green, files: { "/deploy/.env": "" }, logsDirPathFn: () => "/home/o'brien/.pi-dispatch/logs" });
	await h.run();
	assert.match(h.text(), /PI_LOGS_DIR +NOT written: cannot write this value into a \.env safely: it contains a single quote\. Set it by hand, to a path without that character\n/);
	assert.match(h.store.get("/deploy/.env"), /^PI_PAUSE_WINDOWS_FILE=\/deploy\/pause-windows\.json$/m, "and the folder keys, whose paths are fine, are written");
});

test("up: a .env refused for its GROUP says the group's fix, never a value's advice (#522)", async () => {
	// The reported run: every write refused, and the four path rows ended "move the deployment somewhere without that
	// character in its path" about a path with no such character. A refusal about the FILE ends in its own fix.
	const own = process.getgid?.() ?? 0;
	const h = harness({ plan: green, files: { "/deploy/.env": "" } });
	h.deps.fs.statSync = (p) => ({ mode: 0o100600, uid: process.getuid?.() ?? 0, gid: p.endsWith(".tmp") ? own : own + 1 });
	h.deps.fs.chownSync = () => {
		throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
	};
	await h.run();
	const rows = h.text().split("\n").filter((l) => / NOT written: refusing to edit \/deploy\/\.env: its group is /.test(l));
	assert.deepEqual(rows.map((l) => l.trim().split(" ")[0]), ["WEBHOOK_SECRET", "PI_PAUSE_WINDOWS_FILE", "PI_SCOPED_LIMITS_FILE", "PI_PROJECTS_FILE", "PI_LOGS_DIR", "PI_SETTINGS_FILE", "VALKEY_PASSWORD"]);
	for (const row of rows) {
		assert.match(row, /run `chgrp \S+ \/deploy\/\.env` and run this again; otherwise edit the file by hand\. Nothing was written(\. The Valkey up starts then has no password)?$/, row);
		assert.doesNotMatch(row, /that character/, row);
	}
	assert.equal(h.store.has("/deploy/.env.tmp"), false, "no tmp is left behind by a refusal");
});

test("up: a sibling folder with the same prefix is not 'inside' this one (#357)", async () => {
	// `/deploy-archive` starts with `/deploy` and is a different directory. A prefix compare would refuse
	// a perfectly good path and send the operator looking for a problem that is not there.
	const h = harness({ plan: green, files: { "/deploy/.env": "" }, env: { PI_PROVIDER: "anthropic", PI_LOGS_DIR: "/deploy-archive/logs" } });
	await h.run();
	assert.match(h.store.get("/deploy/.env"), /^PI_LOGS_DIR=\/deploy-archive\/logs$/m);
});

test("up: the doctor layer never overrides a value THIS SHELL sets (#357)", async () => {
	// `wrote` holds keys that were empty in the FILE, which is a different question from whether the
	// environment sets them. An operator exporting a limits file while the key is still commented in
	// `.env` would otherwise have up's doctor read back the file up chose, not the one their worker loads.
	const h = harness({
		plan: green,
		files: { "/deploy/.env": "" },
		env: { PI_PROVIDER: "anthropic", PI_SCOPED_LIMITS_FILE: "/etc/pi/limits.json", PI_PAUSE_WINDOWS_FILE: "   " },
	});
	await h.run();
	assert.equal(h.doctorCalls[0].PI_SCOPED_LIMITS_FILE, "/etc/pi/limits.json", "the exported value is what this shell's worker would load");
	// THE PIN THAT FLIPPED (issue #384). It used to read "a blank export is not a value, so the layer fills
	// it", and that sentence was the defect: three exported spaces are exactly what this shell's worker gets,
	// it keeps them through `??`, and `start.mjs` throws on them before the first job. Filling the key handed
	// doctor a deployment the operator is not running, so `up` exited 0 on a worker that cannot start. What
	// this shell sets is what doctor judges, and doctor says the value is blank.
	assert.equal(h.doctorCalls[0].PI_PAUSE_WINDOWS_FILE, "   ", "a blank export is what the worker would load, so it is what doctor is given");
	assert.match(h.store.get("/deploy/.env"), /^PI_SCOPED_LIMITS_FILE=\/deploy\/scoped-limits\.json$/m, "and the FILE still gets this folder, which is what the service will read");
});

test("up hands its OWN doctor call what it just wrote, or it warns about what it just fixed (#357)", async () => {
	// Nothing in this project loads `.env` into an environment (docs/secrets.md), so the lines above
	// configure the SERVICE and not this process. Unlayered, `up` would write both file paths and then warn
	// three lines later that they are unset, which is the defect issue #357 reported from the other end.
	const h = harness({ plan: green, files: { "/deploy/.env": "" }, env: { PI_PROVIDER: "anthropic" } });
	await h.run();
	assert.equal(h.doctorCalls.length, 1);
	assert.equal(h.doctorCalls[0].PI_PAUSE_WINDOWS_FILE, "/deploy/pause-windows.json");
	assert.equal(h.doctorCalls[0].PI_SCOPED_LIMITS_FILE, "/deploy/scoped-limits.json");
	assert.equal(h.doctorCalls[0].PI_PROJECTS_FILE, "/deploy/projects.json", "the projects key too (#499)");
	assert.equal(h.doctorCalls[0].PI_LOGS_DIR, "/home/op/.pi-dispatch/logs");
	assert.equal(h.doctorCalls[0].PI_PROVIDER, "anthropic", "and the layer adds, it does not replace the environment");
});

test("up leaves every one of the five alone when the operator already set it (#357, #499)", async () => {
	const mine = ["PI_PAUSE_WINDOWS_FILE=/elsewhere/windows.json", "PI_SCOPED_LIMITS_FILE=/elsewhere/limits.json", "PI_PROJECTS_FILE=/elsewhere/projects.json", "PI_LOGS_DIR=/var/log/pi", "PI_SETTINGS_FILE=/etc/pi/settings.json"].join("\n");
	const h = harness({ plan: green, files: { "/deploy/.env": `${mine}\nWEBHOOK_SECRET=x\nVALKEY_PASSWORD=${PASSWORD}\n` } });
	await h.run();
	assert.equal(h.store.get("/deploy/.env"), `${mine}\nWEBHOOK_SECRET=x\nVALKEY_PASSWORD=${PASSWORD}\n`, "five keys, five chances to clobber, none taken (and the password, #468)");
	// And the layer must not put back what the operator overrode: `wrote` holds only keys that were empty.
	assert.equal(h.doctorCalls[0].PI_LOGS_DIR, undefined, "an operator value stays the environment's business");
	for (const key of ["PI_PAUSE_WINDOWS_FILE", "PI_SCOPED_LIMITS_FILE", "PI_PROJECTS_FILE", "PI_LOGS_DIR", "PI_SETTINGS_FILE"]) {
		assert.match(h.text(), new RegExp(`${key}\\s+already set`), `${key} says it was left alone`);
	}
	assert.doesNotMatch(h.text(), /written into \.env/, "and nothing claims a write that did not happen");
});

test("up: an operator's existing WEBHOOK_SECRET is never touched", async () => {
	const h = harness({ plan: green, files: { "/deploy/.env": "WEBHOOK_SECRET=operator-chose-this\n" } });
	await h.run();
	assert.match(h.store.get("/deploy/.env"), /^WEBHOOK_SECRET=operator-chose-this\n/, "the operator's line is the first line still, byte for byte");
	assert.match(h.text(), /already set/);
	assert.ok(!h.text().includes("operator-chose-this"), "existing values are secrets too");
});

test("up: no .env after init means the secret step is skipped, not invented", async () => {
	const h = harness({ plan: green, files: {} });
	assert.equal(await h.run(), 0);
	assert.equal(h.store.has("/deploy/.env"), false, "up never creates a .env behind init's back");
	assert.match(h.text(), /no \.env here/);
});

test("up: a down docker daemon returns 1 before any prompt, init, or doctor", async () => {
	const h = harness({ plan: { "docker version": 1 }, listening: false });
	assert.equal(await h.run(), 1);
	assert.equal(h.promptCalls.length, 0, "no consent is collected for actions that cannot run");
	assert.equal(h.initCalls.length, 0);
	assert.equal(h.doctorCalls.length, 0);
	assert.match(h.text(), /start Docker/, "a down daemon is distinguished from a missing binary");
});

test("up: a missing docker binary reads as 'install', not 'start', and also returns 1", async () => {
	const h = harness({ plan: { "docker version": "enoent" } });
	assert.equal(await h.run(), 1);
	assert.match(h.text(), /install Docker/);
});

test("up: doctor's nonzero exit code propagates as up's own", async () => {
	const h = harness({ plan: green, doctorCode: 1 });
	assert.equal(await h.run(), 1);
});

test("up: a failed accepted pull is reported, skips the tag, and still reaches doctor (converge-style)", async () => {
	const h = harness({
		plan: { "docker version": 0, "docker image inspect": 1, "docker pull": 1 },
		listening: true,
		argv: ["--yes"],
	});
	assert.equal(await h.run(), 0, "a failed step does not fail up; doctor's verdict is the exit code");
	assert.equal(h.calls.map((c) => c.args).find((a) => a[0] === "tag"), undefined, "no tag of an image that never arrived");
	assert.equal(h.doctorCalls.length, 1);
	assert.match(h.text(), /pull FAILED/);
});

// Issue #523: up checks, and pulls, only the image the worker will run. PI_JOB_IMAGE resolves as the worker resolves it
// (`PI_JOB_IMAGE || "pi-job:latest"`), from this shell where it sets it and otherwise from the deployment's `.env`. A plan
// key for one image goes BEFORE `green`'s "docker image inspect": the fake answers with the first prefix that matches.
const PINNED = "ghcr.io/edgehero/pi-job:2.1.0";
// A `.env` this account cannot read: present, and its read throws EACCES.
const EACCES = Symbol("eacces");
function eaccesOn(h, path) {
	const read = h.deps.fs.readFileSync;
	h.deps.fs.readFileSync = (p, ...rest) => {
		if (p === path) throw Object.assign(new Error(`EACCES: permission denied, open '${p}'`), { code: "EACCES" });
		return read(p, ...rest);
	};
}
const imageCalls = (h) => h.calls.filter((c) => c.cmd === "docker" && (c.args[0] === "pull" || c.args[0] === "tag" || (c.args[0] === "image" && (c.args[1] === "inspect" || c.args[1] === "exists")))).map((c) => ["docker", ...c.args]);

test("up: a PI_JOB_IMAGE that is present is checked by its own name, and nothing is pulled or tagged (#523)", async () => {
	for (const [label, env, files, from] of [
		["the shell", { PI_PROVIDER: "anthropic", PI_JOB_IMAGE: PINNED }, {}, "this shell"],
		["the deployment .env", { PI_PROVIDER: "anthropic" }, { "/deploy/.env": `PI_JOB_IMAGE=${PINNED}\n` }, "/deploy/.env"],
	]) {
		const h = harness({ env, files, plan: { [`docker image inspect ${PINNED}`]: 0, "docker image inspect pi-job:latest": 1, ...green, "docker pull": 0, "docker tag": 0 }, listening: true, argv: ["--yes"] });
		assert.equal(await h.run(), 0, label);
		assert.deepEqual(imageCalls(h), [["docker", "image", "inspect", PINNED]], `${label}: only the worker's image is asked about`);
		assert.match(h.text(), new RegExp(`✓ Job image present \\(${PINNED.replace(/\./g, "\\.")}, PI_JOB_IMAGE from ${from.replace(/\./g, "\\.")}\\)`), label);
		assert.match(h.text(), /job image\s+already present \(ghcr\.io\/edgehero\/pi-job:2\.1\.0\)/, label);
		assert.doesNotMatch(h.text(), /pull docker\.io\/ddv12138\/pi-job:latest|tag docker\.io\/ddv12138|Job image present \(pi-job:latest\)/, `${label}: the default image is never checked or offered`);
	}
});

test("up: an absent PI_JOB_IMAGE is pulled by its own name, with no tag, after the command is shown (#523)", async () => {
	const custom = "registry.example/team/job:7";
	const h = harness({ env: { PI_PROVIDER: "anthropic", PI_JOB_IMAGE: custom }, plan: { [`docker image inspect ${custom}`]: 1, ...green, "docker pull": 0, "docker tag": 0 }, listening: true, argv: ["--yes"] });
	assert.equal(await h.run(), 0);
	assert.deepEqual(imageCalls(h), [["docker", "image", "inspect", custom], ["docker", "pull", custom]]);
	assert.match(h.text(), /The job image PI_JOB_IMAGE from this shell names \(registry\.example\/team\/job:7\) is not on this host\. up would run:\n {2}docker pull registry\.example\/team\/job:7\n/);
	assert.match(h.text(), /job image\s+pulled registry\.example\/team\/job:7\n/);
	// Declined: nothing runs, and the summary names the image that is missing.
	const no = harness({ env: { PI_PROVIDER: "anthropic", PI_JOB_IMAGE: custom }, plan: { [`docker image inspect ${custom}`]: 1, ...green }, listening: true, answers: [""] });
	await no.run();
	assert.deepEqual(imageCalls(no), [["docker", "image", "inspect", custom]]);
	assert.match(no.text(), /job image\s+skipped \(declined\): registry\.example\/team\/job:7 is not present/);
});

test("up: an absent SHORT PI_JOB_IMAGE is never pulled, under --yes too, and up says how to provide it (#523 review)", async () => {
	for (const short of ["pi-job:2.1.0", "my-job:dev", "team/job:7", "my.job:dev"]) {
		const h = harness({ env: { PI_PROVIDER: "anthropic", PI_JOB_IMAGE: short }, plan: { [`docker image inspect ${short}`]: 1, ...green, "docker pull": 0, "docker tag": 0 }, listening: true, argv: ["--yes"] });
		assert.equal(await h.run(), 0, short);
		assert.deepEqual(imageCalls(h), [["docker", "image", "inspect", short]], `${short}: checked, never pulled`);
		assert.match(h.text(), /and up does not pull it: .* names no registry host/, short);
		assert.ok(h.text().includes(`and up does not pull it: ${jobImageFix("docker", short)}\n`), `${short}: the one text doctor's fix line uses too`);
		assert.match(h.text(), /build it on this host, `docker tag` an image you have as .*, or set PI_JOB_IMAGE to a registry-qualified name/, short);
		assert.doesNotMatch(h.text(), /up would run:\n {2}docker pull/, short);
		assert.equal(h.doctorCalls.length, 1, `${short}: doctor still runs and judges the missing image`);
	}
});

test("up: an absent localhost/ name is a locally built one, never offered as a pull; localhost:<port>/ is a registry and is (#523 round 2)", async () => {
	{
		const local = "localhost/my-job:dev";
		const h = harness({
			env: { PI_PROVIDER: "anthropic", PI_JOB_IMAGE: local },
			plan: { [`docker image inspect ${local}`]: 1, ...green, "docker pull": 0 },
			listening: true,
			argv: ["--yes"],
		});
		assert.equal(await h.run(), 0);
		assert.deepEqual(imageCalls(h), [["docker", "image", "inspect", local]], "checked, never pulled");
		assert.ok(h.text().includes(`and up does not pull it: localhost/my-job:dev is a locally built name (localhost/ is no registry to pull from): build it on this host, or \`docker tag\` an image you have as localhost/my-job:dev\n`));
		assert.match(h.text(), /not pulled, since it is a locally built name/);
	}
	const port = "localhost:5000/team/job:7";
	const h = harness({ env: { PI_PROVIDER: "anthropic", PI_JOB_IMAGE: port }, plan: { [`docker image inspect ${port}`]: 1, ...green, "docker pull": 0 }, listening: true, argv: ["--yes"] });
	await h.run();
	assert.deepEqual(imageCalls(h), [["docker", "image", "inspect", port], ["docker", "pull", port]]);
});

test("registryQualified: the docker reference grammar's registry host (#523 review)", () => {
	for (const q of ["ghcr.io/edgehero/pi-job:2.1.0", "registry.example/team/job:7", "localhost:5000/job", "localhost/pi-job:dev", "host:5000/a/b@sha256:abc"]) assert.equal(registryQualified(q), true, q);
	for (const s of ["pi-job:2.1.0", "my.job:dev", "team/job:7", "edgehero/pi-job:latest", "ghcr.io", "local/job"]) assert.equal(registryQualified(s), false, s);
});

test("up: PI_JOB_IMAGE unset, empty or pi-job:latest is today's default: pi-job:latest checked, the published latest pulled and tagged (#523)", async () => {
	for (const [label, env, files] of [
		["unset", { PI_PROVIDER: "anthropic" }, {}],
		["empty in .env (the worker's ||)", { PI_PROVIDER: "anthropic" }, { "/deploy/.env": "PI_JOB_IMAGE=\n" }],
		["named as the default", { PI_PROVIDER: "anthropic", PI_JOB_IMAGE: "pi-job:latest" }, {}],
	]) {
		const h = harness({ env, files, plan: { ...green, "docker image inspect": 1, "docker pull": 0, "docker tag": 0 }, listening: true, argv: ["--yes"] });
		assert.equal(await h.run(), 0, label);
		assert.deepEqual(imageCalls(h), [["docker", "image", "inspect", "pi-job:latest"], ["docker", ...PULL], ["docker", ...TAG]], label);
	}
});

test("up: when it cannot tell which image the worker runs, it checks and pulls none, and says why (#523)", async () => {
	for (const [label, env, files, said, platform = "linux"] of [
		["shell and .env disagree", { PI_PROVIDER: "anthropic", PI_JOB_IMAGE: PINNED }, { "/deploy/.env": "PI_JOB_IMAGE=pi-job:latest\n" }, /PI_JOB_IMAGE is "ghcr\.io\/edgehero\/pi-job:2\.1\.0" in this shell and "pi-job:latest" in \/deploy\/\.env, so up cannot tell which job image the worker runs: it checks and pulls none/],
		["a value the worker refuses at boot", { PI_PROVIDER: "anthropic", PI_JOB_IMAGE: "--help" }, {}, /PI_JOB_IMAGE must not start with "-".*the worker refuses to boot on it, so up checks and pulls no job image/],
		["a .env line the loader reads differently", { PI_PROVIDER: "anthropic" }, { "/deploy/.env": "PI_JOB_IMAGE='x'y\n" }, /has a line in it that the service's loader may read differently from this reader, so up cannot tell which job image the worker runs/],
		// A file the service's loader reads differently somewhere that names the key: no value from it, said (hazardSkipped).
		// Off Linux, since on Linux the venue read refuses such a file before any image step (pinned below).
		["a .env holding a NUL (macOS)", { PI_PROVIDER: "anthropic" }, { "/deploy/.env": Buffer.from(`PI_JOB_IMAGE=${PINNED}\nA=\u0000\n`) }, /has a line in it that the service's loader may read differently/, "darwin"],
		["a .env with an open quote after it (macOS)", { PI_PROVIDER: "anthropic" }, { "/deploy/.env": `PI_JOB_IMAGE=${PINNED}\nA="x\n` }, /has a line in it that the service's loader may read differently/, "darwin"],
		// Round 2: the shell sets the key and the file names ANOTHER value after a hazard line. The resolver records nothing
		// for a key the shell sets, so this was credited to .env and the disagreement went unseen.
		["the shell sets it and .env names another after a hazard (macOS)", { PI_PROVIDER: "anthropic", PI_JOB_IMAGE: PINNED }, { "/deploy/.env": `A="x\nPI_JOB_IMAGE=registry.example/other:1\n` }, /has a line in it that the service's loader may read differently from this reader \(line 1\), so up cannot tell/, "darwin"],
		// Unreadable is not unset: the service may read a PI_JOB_IMAGE this account cannot.
		["an EACCES .env and no shell value", { PI_PROVIDER: "anthropic" }, { "/deploy/.env": EACCES }, /\/deploy\/\.env could not be read, so up cannot tell which job image the worker runs \(PI_JOB_IMAGE\): it checks and pulls none/],
	]) {
		const h = harness({ env, files, platform, plan: { ...green, "docker image inspect": 1, "docker pull": 0, "docker tag": 0 }, listening: true, argv: ["--yes"] });
		if (files["/deploy/.env"] === EACCES) eaccesOn(h, "/deploy/.env");
		assert.equal(await h.run(), 0, label);
		assert.deepEqual(imageCalls(h), [], `${label}: no image is asked about or pulled`);
		assert.match(h.text(), said, label);
		assert.match(h.text(), /job image\s+not checked: which image the worker runs is unknown/, label);
	}
	// On Linux such a file stops up before any image step, so nothing is pulled there either.
	for (const raw of [Buffer.from(`PI_JOB_IMAGE=${PINNED}\nA=\u0000\n`), Buffer.concat([Buffer.from(`PI_JOB_IMAGE=${PINNED}\nA=`), Buffer.from([0xff, 0x0a])])]) {
		const h = harness({ env: { PI_PROVIDER: "anthropic" }, files: { "/deploy/.env": raw }, plan: { ...green, "docker pull": 0 }, listening: true, argv: ["--yes"] });
		assert.equal(await h.run(), 1);
		assert.deepEqual(imageCalls(h), []);
	}
});

test("up: the shell and .env spelling the SAME image differently is not a disagreement (#523 review)", async () => {
	// "" is the worker's default (`||`), as pi-job:latest is: the default step runs, and nothing is refused.
	const h = harness({ env: { PI_PROVIDER: "anthropic", PI_JOB_IMAGE: "" }, files: { "/deploy/.env": "PI_JOB_IMAGE=pi-job:latest\n" }, plan: { ...green, "docker image inspect": 1, "docker pull": 0, "docker tag": 0 }, listening: true, argv: ["--yes"] });
	assert.equal(await h.run(), 0);
	assert.doesNotMatch(h.text(), /cannot tell which job image/);
	assert.deepEqual(imageCalls(h), [["docker", "image", "inspect", "pi-job:latest"], ["docker", ...PULL], ["docker", ...TAG]]);
});

test("up: a PI_JOB_IMAGE from this shell only says an installed service reads .env instead (#523 review)", async () => {
	const said = /⚠ PI_JOB_IMAGE comes from this shell only: a worker started from this shell runs ghcr\.io\/edgehero\/pi-job:2\.1\.0, but an installed service reads \/deploy\/\.env, not this shell \(init writes PI_JOB_IMAGE=pi-job:latest there\)/;
	for (const [label, files] of [["no .env", {}], [".env without the key", { "/deploy/.env": "A=1\n" }]]) {
		const h = harness({ env: { PI_PROVIDER: "anthropic", PI_JOB_IMAGE: PINNED }, files, plan: { [`docker image inspect ${PINNED}`]: 0, ...green }, listening: true });
		await h.run();
		assert.match(h.text(), said, label);
		assert.match(h.text(), /PI_JOB_IMAGE from this shell\)/, label);
	}
	// Both setting the same value, or only the file, or neither: no such line.
	for (const [label, env, files] of [["both", { PI_PROVIDER: "anthropic", PI_JOB_IMAGE: PINNED }, { "/deploy/.env": `PI_JOB_IMAGE=${PINNED}\n` }], ["file only", { PI_PROVIDER: "anthropic" }, { "/deploy/.env": `PI_JOB_IMAGE=${PINNED}\n` }], ["neither", { PI_PROVIDER: "anthropic" }, {}]]) {
		const h = harness({ env, files, plan: { [`docker image inspect ${PINNED}`]: 0, ...green }, listening: true });
		await h.run();
		assert.doesNotMatch(h.text(), /comes from this shell only/, label);
	}
});

test("jobImageFix: one text for up and doctor: the default pull and tag, a qualified pull, a short name never pulled (#523 review)", () => {
	assert.equal(jobImageFix("docker", "pi-job:latest"), "docker pull docker.io/ddv12138/pi-job:latest && docker tag docker.io/ddv12138/pi-job:latest pi-job:latest");
	assert.equal(jobImageFix("docker", "localhost/my-job:dev"), "localhost/my-job:dev is a locally built name (localhost/ is no registry to pull from): build it on this host, or `docker tag` an image you have as localhost/my-job:dev");
	assert.equal(jobImageFix("docker", "localhost:5000/job"), "docker pull localhost:5000/job");
});

test("defaultPrompt: non-TTY stdin declines immediately without readline (the event-loop-drain trap)", async () => {
	// Against an ended stream, rl.question()'s promise never settles and holds no handle, so a real
	// `up < /dev/null` would exit 0 mid-sequence, skipping init and doctor while looking like success.
	// The guard turns that into an explicit printed decline. Regression test for exactly that run.
	let printed = "";
	const answer = await defaultPrompt("Proceed? [y/N] ", { isTTY: false, output: { write: (s) => (printed += s) } });
	assert.equal(answer, "", "an empty answer is the No contract");
	assert.match(printed, /Proceed\? \[y\/N\] /, "the question still reaches the transcript");
	assert.match(printed, /defaulting to No/, "the default is stated, not silent");
});

// --- REQ-EGRESS-ALLOWLIST: up offers the proxy, and only to a deployment that armed the policy --------

const EGRESS_ENV = { PI_PROVIDER: "anthropic", PI_EGRESS: "1" };
// Issue #453: the shipped proxy's state is one inspect, status, image and mounts (`egress-proxy-state.mjs`). A container
// made by `up` or compose in THIS folder carries the pinned image and the two files below.
const PROXY_INSPECT = 'docker inspect --format={"status":{{json .State.Status}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}"none"{{end}},"image":{{json .Config.Image}},"entrypoint":{{json .Config.Entrypoint}},"cmd":{{json .Config.Cmd}},"mounts":{{json .Mounts}},"networks":{{json .NetworkSettings.Networks}}} pi-dispatch-egress-proxy';
const PINNED_SQUID = "ubuntu/squid@sha256:6a097f68bae708cedbabd6188d68c7e2e7a38cedd05a176e1cc0ba29e3bbe029";
// The pinned image's own entrypoint and command and its two anonymous volumes (its registry config, 2026-09-27).
const SQUID_ENTRYPOINT = ["entrypoint.sh"];
const SQUID_CMD = ["-f", "/etc/squid/squid.conf", "-NYC"];
const proxyState = (status, { image = PINNED_SQUID, conf = "/deploy/deploy/egress-proxy.conf", allowlist = "/deploy/egress-allowlist.conf", include = null, entrypoint = SQUID_ENTRYPOINT, cmd = SQUID_CMD, extra = [], networks = ["pi-dispatch-egress-out"], stderr } = {}) => ({
	code: 0,
	output: `${JSON.stringify({
		status,
		health: "none",
		image,
		entrypoint,
		cmd,
		mounts: [
			...(conf ? [{ Type: "bind", Source: conf, Destination: "/etc/squid/squid.conf" }] : []),
			...(allowlist ? [{ Type: "bind", Source: allowlist, Destination: "/etc/pi-dispatch/allowlist.conf" }] : []),
			...(include ? [{ Type: "bind", Source: include, Destination: "/etc/pi-dispatch/model-endpoints.conf" }] : []),
			{ Type: "volume", Source: "/var/lib/docker/volumes/a1/_data", Destination: "/var/log/squid" },
			{ Type: "volume", Source: "/var/lib/docker/volumes/b2/_data", Destination: "/var/spool/squid" },
			...extra,
		],
		networks: Object.fromEntries(networks.map((n) => [n, {}])),
	})}\n`,
	...(stderr ? { stderr } : {}),
});
const EGRESS_NET = ["network", "create", "pi-dispatch-egress-out"];
const EGRESS_RUN = [
	"run", "-d", "--name", "pi-dispatch-egress-proxy", "--restart", "unless-stopped",
	"--network", "pi-dispatch-egress-out",
	"-v", "./deploy/egress-proxy.conf:/etc/squid/squid.conf:ro,z",
	"-v", "./egress-allowlist.conf:/etc/pi-dispatch/allowlist.conf:ro,z",
	"-v", "./model-endpoints.conf:/etc/pi-dispatch/model-endpoints.conf:ro,z",
	"--add-host", "host.docker.internal:host-gateway",
	"ubuntu/squid@sha256:6a097f68bae708cedbabd6188d68c7e2e7a38cedd05a176e1cc0ba29e3bbe029",
];

test("up: a deployment that turned the policy OFF is never asked about a proxy", async () => {
	// PI_EGRESS=0 is the opt-out rather than the default now, and up still says nothing to a deployment
	// that took it: up never invents operator policy, the same doctrine that keeps it pulling this repo's
	// own image and no other.
	const h = harness({ env: { PI_PROVIDER: "anthropic", PI_EGRESS: "0" }, plan: green, listening: true });
	await h.run();
	assert.doesNotMatch(h.text(), /egress/i);
	assert.ok(!h.calls.some((c) => c.args.includes("pi-dispatch-egress-proxy")));
});

test("up: an armed policy with the proxy already up prompts for nothing", async () => {
	const h = harness({
		env: EGRESS_ENV,
		plan: { ...green, [PROXY_INSPECT]: proxyState("running") },
		listening: true,
	});
	assert.equal(await h.run(), 0);
	assert.match(h.text(), /✓ Egress proxy already present/);
	assert.equal(h.promptCalls.length, 0);
});

test("up: --yes starts the proxy with exactly the argv it showed", async () => {
	const h = harness({
		env: EGRESS_ENV,
		plan: { ...green, [PROXY_INSPECT]: 1, "docker network create": 0, "docker run -d --name pi-dispatch-egress-proxy": 0 },
		listening: true,
		files: { "/deploy/egress-allowlist.conf": "api.anthropic.com\n", "/deploy/deploy/egress-proxy.conf": "conf\n" },
		argv: ["--yes"],
	});
	await h.run();
	const ran = h.calls.filter((c) => c.args[0] === "network" || c.args[0] === "run").map((c) => c.args);
	assert.ok(ran.some((a) => JSON.stringify(a) === JSON.stringify(EGRESS_NET)), "the network argv is the one shown");
	assert.ok(ran.some((a) => JSON.stringify(a) === JSON.stringify(EGRESS_RUN)), "the proxy argv is the one shown");
	assert.match(h.text(), /started pi-dispatch-egress-proxy/);
});

test("up: an armed policy with NO allowlist file declines itself rather than starting a deny-everything proxy", async () => {
	// Starting a proxy whose allowlist file does not exist gets a DIRECTORY created by docker where a file
	// belonged, and a squid that fails confusingly. Naming the file is the fix; starting it is not.
	const h = harness({
		env: EGRESS_ENV,
		plan: { ...green, [PROXY_INSPECT]: 1 },
		listening: true,
		argv: ["--yes"],
	});
	await h.run();
	assert.match(h.text(), /egress-allowlist\.conf is not here/);
	assert.ok(!h.calls.some((c) => c.args.includes("pi-dispatch-egress-proxy") && c.args[0] === "run"), "nothing is started");
});

test("up: a declined proxy prompt runs nothing, and the summary says what that costs", async () => {
	const h = harness({
		env: EGRESS_ENV,
		plan: { ...green, [PROXY_INSPECT]: 1 },
		listening: true,
		files: { "/deploy/egress-allowlist.conf": "api.anthropic.com\n", "/deploy/deploy/egress-proxy.conf": "conf\n" },
		answers: ["n"],
	});
	await h.run();
	assert.ok(!h.calls.some((c) => c.args[0] === "run" && c.args.includes("pi-dispatch-egress-proxy")));
	assert.match(h.text(), /every job is refused pre-spend until the proxy is up/);
});


// Issue #453: the docker proxy is RUNNING only when `docker inspect` prints `running` on stdout. An exited container
// also exits 0, so the exit code alone called a stopped proxy present and offered nothing.
const EGRESS_START = ["start", "pi-dispatch-egress-proxy"];

test("up on docker: a stopped shipped proxy is started as it is, never recreated, with exactly the argv shown (#453)", async () => {
	const h = harness({
		env: EGRESS_ENV,
		plan: { ...green, [PROXY_INSPECT]: proxyState("exited"), "docker start pi-dispatch-egress-proxy": 0 },
		listening: true,
		files: { "/deploy/egress-allowlist.conf": "api.anthropic.com\n", "/deploy/deploy/egress-proxy.conf": "conf\n" },
		argv: ["--yes"],
	});
	assert.equal(await h.run(), 0);
	assert.doesNotMatch(h.text(), /Egress proxy already present/);
	assert.match(h.text(), /the allowlist proxy exists but is exited\. up would start that same container \(as deploy\/docker-compose\.yml --profile egress up -d does\):\n\s+docker start pi-dispatch-egress-proxy\n/);
	const mutations = h.calls.filter((c) => c.cmd === "docker" && ["start", "run", "network", "rm"].includes(c.args[0])).map((c) => c.args);
	assert.deepEqual(mutations, [EGRESS_START], "one start of the existing container: no rm, no run on a taken name, no network create");
	assert.match(h.text(), /egress\s+started the exited pi-dispatch-egress-proxy/);
});

test("up on docker: a stopped shipped proxy, declined or failing to start, is said, and nothing else runs (#453)", async () => {
	const declined = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: proxyState("exited") }, listening: true, files: { "/deploy/egress-allowlist.conf": "x\n", "/deploy/deploy/egress-proxy.conf": "conf\n" }, answers: ["n"] });
	assert.equal(await declined.run(), 0);
	assert.ok(!declined.calls.some((c) => ["start", "run", "network"].includes(c.args[0])), "declined runs nothing");
	assert.match(declined.text(), /skipped: start it later with `docker start pi-dispatch-egress-proxy`/);
	assert.match(declined.text(), /egress\s+skipped \(declined\): every job is refused pre-spend until the proxy is up/);
	const failing = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: proxyState("exited"), "docker start": 1 }, listening: true, files: { "/deploy/egress-allowlist.conf": "x\n", "/deploy/deploy/egress-proxy.conf": "conf\n" }, argv: ["--yes"] });
	assert.equal(await failing.run(), 0, "doctor is the judge of what remains");
	assert.match(failing.text(), /✗ could not start the egress proxy; `docker rm -f -v pi-dispatch-egress-proxy` and re-run `pi-dispatch up` recreates it/);
	assert.ok(!failing.calls.some((c) => c.args[0] === "run" || c.args[0] === "rm"), "never removes or recreates it by itself");
	// No allowlist here: declined before any offer, as for an absent proxy.
	const bare = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: proxyState("exited") }, listening: true, argv: ["--yes"] });
	await bare.run();
	assert.match(bare.text(), /egress-allowlist\.conf is not here/);
	assert.ok(!bare.calls.some((c) => c.args[0] === "start"));
});

test("up on docker: a running proxy is read off stdout alone, whatever docker prints on stderr (#453)", async () => {
	const h = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: proxyState("running", { stderr: "WARNING: something the CLI says\n" }) }, listening: true, files: { "/deploy/egress-allowlist.conf": "x\n", "/deploy/deploy/egress-proxy.conf": "conf\n" }, argv: ["--yes"] });
	assert.equal(await h.run(), 0);
	assert.match(h.text(), /✓ Egress proxy already present \(pi-dispatch-egress-proxy\)/);
	assert.ok(!h.calls.some((c) => ["start", "run", "network"].includes(c.args[0])));
});

test("up on docker: a PI_EGRESS_PROXY container that exists but is stopped is reported, never started (#453)", async () => {
	const stopped = harness({ env: { PI_EGRESS_PROXY: "my-squid" }, plan: { ...green, "docker inspect": { code: 0, output: "exited\n" } }, listening: true, files: { "/deploy/egress-allowlist.conf": "x\n", "/deploy/deploy/egress-proxy.conf": "conf\n" }, argv: ["--yes"] });
	assert.equal(await stopped.run(), 0);
	assert.match(stopped.text(), /✗ PI_EGRESS_PROXY names my-squid, and that container exists but is not running \(exited\)\. up starts only the shipped pi-dispatch-egress-proxy, so start my-squid yourself\n/);
	assert.match(stopped.text(), /egress\s+my-squid \(PI_EGRESS_PROXY\) exists but is not running; every job is refused pre-spend until it runs/);
	assert.doesNotMatch(stopped.text(), /Egress proxy present/);
	assert.ok(!stopped.calls.some((c) => ["start", "run", "network"].includes(c.args[0])), "the operator's container is never started");
	const running = harness({ env: { PI_EGRESS_PROXY: "my-squid" }, plan: { ...green, "docker inspect": { code: 0, output: "running\n" } }, listening: true, files: { "/deploy/egress-allowlist.conf": "x\n", "/deploy/deploy/egress-proxy.conf": "conf\n" } });
	assert.equal(await running.run(), 0);
	assert.match(running.text(), /✓ Egress proxy present \(my-squid, named by PI_EGRESS_PROXY\)/);
});

const EGRESS_RM = ["rm", "-f", "-v", "pi-dispatch-egress-proxy"];
const PROXY_FILES = { "/deploy/egress-allowlist.conf": "x\n", "/deploy/deploy/egress-proxy.conf": "conf\n" };
// Mutations only: the quiet `network inspect` before a create is a read (exec round 3).
const dockerMutations = (h) => h.calls.filter((c) => c.cmd === "docker" && ["start", "unpause", "run", "network", "rm"].includes(c.args[0]) && c.args[1] !== "inspect").map((c) => c.args);

test("up on docker: a shipped proxy from another squid or another folder is never started as it is, running or not, and is offered a recreate (#453 gate)", async () => {
	for (const [label, state, said] of [
		["stale digest, exited", proxyState("exited", { image: "ubuntu/squid@sha256:" + "0".repeat(64) }), /it was created from ubuntu\/squid@sha256:0{64}, not the pinned ubuntu\/squid@sha256:6a097f68/],
		["another folder's allowlist, exited", proxyState("exited", { allowlist: "/srv/other/egress-allowlist.conf" }), /its \/etc\/pi-dispatch\/allowlist\.conf is \/srv\/other\/egress-allowlist\.conf, not \/deploy\/egress-allowlist\.conf/],
		["another folder's squid.conf, RUNNING", proxyState("running", { conf: "/srv/other/deploy/egress-proxy.conf" }), /its \/etc\/squid\/squid\.conf is \/srv\/other\/deploy\/egress-proxy\.conf, not \/deploy\/deploy\/egress-proxy\.conf/],
		["no mounts at all, running", proxyState("running", { conf: null, allowlist: null }), /nothing is mounted at \/etc\/squid\/squid\.conf, where \/deploy\/deploy\/egress-proxy\.conf belongs/],
	]) {
		const yes = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: state, "docker rm": 0, "docker network create": 0, "docker run -d --name pi-dispatch-egress-proxy": 0 }, listening: true, files: PROXY_FILES, argv: ["--yes"] });
		assert.equal(await yes.run(), 0, label);
		assert.match(yes.text(), /✗ pi-dispatch-egress-proxy exists \((exited|running)\) but is not this deployment's proxy: /, label);
		assert.match(yes.text(), said, label);
		assert.doesNotMatch(yes.text(), /Egress proxy already present/, label);
		assert.deepEqual(dockerMutations(yes), [EGRESS_RM, EGRESS_NET, EGRESS_RUN], `${label}: removed and run from the shown argv, never started as it is`);
		assert.match(yes.text(), /egress\s+replaced the stale pi-dispatch-egress-proxy with the shipped one/, label);
		const no = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: state }, listening: true, files: PROXY_FILES, answers: ["n"] });
		await no.run();
		assert.deepEqual(dockerMutations(no), [], `${label}: declined runs nothing`);
		assert.match(no.text(), /egress\s+stale proxy left as it is \(declined\): its policy is not this deployment's/, label);
	}
	// A symlinked deployment folder is one folder: the realpath of both sides decides.
	const linked = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: proxyState("running", { conf: "/real/deploy/egress-proxy.conf", allowlist: "/real/egress-allowlist.conf" }) }, listening: true, files: PROXY_FILES, argv: ["--yes"] });
	linked.deps.fs.realpathSync = (p) => p.replace(/^\/deploy\//, "/real/");
	assert.equal(await linked.run(), 0);
	assert.match(linked.text(), /✓ Egress proxy already present/);
	// Stale, and this folder cannot recreate it: said, nothing run.
	const bare = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: proxyState("exited", { image: "squid:old" }) }, listening: true, files: { "/deploy/egress-allowlist.conf": "x\n" }, argv: ["--yes"] });
	await bare.run();
	assert.match(bare.text(), /✗ deploy\/egress-proxy\.conf is not here, so up cannot recreate it from this folder/);
	assert.deepEqual(dockerMutations(bare), []);
});

test("up on docker: running means Status running: a paused proxy is unpaused, a crash-looping one is reported, and a missing egress-proxy.conf is never mounted (#453 gate)", async () => {
	const paused = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: proxyState("paused"), "docker unpause": 0 }, listening: true, files: PROXY_FILES, argv: ["--yes"] });
	assert.equal(await paused.run(), 0);
	assert.doesNotMatch(paused.text(), /Egress proxy already present/);
	assert.deepEqual(dockerMutations(paused), [["unpause", "pi-dispatch-egress-proxy"]]);
	assert.match(paused.text(), /egress\s+unpaused the paused pi-dispatch-egress-proxy/);
	const looping = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: proxyState("restarting") }, listening: true, files: PROXY_FILES, argv: ["--yes"] });
	assert.equal(await looping.run(), 0);
	assert.match(looping.text(), /✗ pi-dispatch-egress-proxy is restarting: its squid keeps exiting and its restart policy keeps bringing it back\. `docker logs pi-dispatch-egress-proxy` says why; meanwhile each job is retried once, then failed\n/);
	assert.deepEqual(dockerMutations(looping), []);
	// Absent proxy, allowlist here, the shipped squid.conf not: the runtime would create a directory there (gate 456).
	const noConf = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: 1 }, listening: true, files: { "/deploy/egress-allowlist.conf": "x\n" }, argv: ["--yes"] });
	await noConf.run();
	assert.match(noConf.text(), /✗ the egress policy is on but deploy\/egress-proxy\.conf is not here, so no proxy is started without it/);
	assert.deepEqual(dockerMutations(noConf), []);
});

test("up on docker: another entrypoint or command, or a bind the shipped proxy does not have, is stale; its anonymous volumes are not (#453 gate 2)", async () => {
	for (const [label, state, said] of [
		["a command pointing squid at another config (adversary Y7)", proxyState("running", { entrypoint: ["squid"], cmd: ["-N", "-f", "/tmp/open.conf"] }), /its entrypoint is \["squid"\], not the image's \["entrypoint\.sh"\]; its command is \["-N","-f","\/tmp\/open\.conf"\], not the image's \["-f","\/etc\/squid\/squid\.conf","-NYC"\]/],
		["an extra bind", proxyState("running", { extra: [{ Type: "bind", Source: "/deploy/open.conf", Destination: "/tmp/open.conf" }] }), /it has a bind at \/tmp\/open\.conf \(from \/deploy\/open\.conf\) that the shipped proxy does not/],
		["a volume somewhere else", proxyState("exited", { extra: [{ Type: "volume", Source: "/var/lib/docker/volumes/c3/_data", Destination: "/etc/squid/conf.d" }] }), /it has a volume at \/etc\/squid\/conf\.d/],
	]) {
		const h = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: state, "docker rm": 0, "docker network create": 0, "docker run -d --name pi-dispatch-egress-proxy": 0 }, listening: true, files: PROXY_FILES, argv: ["--yes"] });
		await h.run();
		assert.match(h.text(), said, label);
		assert.deepEqual(dockerMutations(h), [EGRESS_RM, EGRESS_NET, EGRESS_RUN], label);
	}
	// The shipped shape itself, with its two anonymous volumes, is current.
	const current = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: proxyState("running") }, listening: true, files: PROXY_FILES, argv: ["--yes"] });
	await current.run();
	assert.match(current.text(), /✓ Egress proxy already present/);
});

test("up on docker: bind sources that do not resolve on this host make the mounts UNKNOWN, never stale, and never a removal (#453 gate 2)", async () => {
	// The shape Docker Desktop is expected to report (its VM's own paths); not measured here, so never acted on.
	const desktop = { conf: "/host_mnt/Users/op/deploy/deploy/egress-proxy.conf", allowlist: "/host_mnt/Users/op/deploy/egress-allowlist.conf" };
	const noResolve = (p) => {
		if (p.startsWith("/host_mnt/")) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
		return p;
	};
	for (const status of ["running", "exited"]) {
		const h = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: proxyState(status, desktop), "docker start": 0 }, listening: true, files: PROXY_FILES, argv: ["--yes"] });
		h.deps.fs.realpathSync = noResolve;
		await h.run();
		assert.match(h.text(), /⚠ could not compare pi-dispatch-egress-proxy's mounts on this host: \/host_mnt\/Users\/op\/deploy\/deploy\/egress-proxy\.conf, \/host_mnt\/Users\/op\/deploy\/egress-allowlist\.conf are paths this host cannot resolve \(the runtime's own VM's, as Docker Desktop reports its sources\), so those mounts cannot be compared from here\. Everything else about it is still judged, and up replaces it while one of its own two mounts is unknown only when its image, entrypoint or command shows it stale\n/, status);
		assert.doesNotMatch(h.text(), /is not this deployment's proxy/, status);
		assert.ok(!dockerMutations(h).some((a) => a[0] === "rm" || a[0] === "run"), `${status}: never removed or recreated on an unknown`);
	}
	// Stale by image while an expected mount is unknown (PR #456's final check): the image drift alone proves it is not the
	// shipped proxy, so the replace is offered and `--yes` takes it, where it used to be refused on the mount and so never
	// replaced on Docker Desktop, whose every bind source is a VM path. The unknown mounts are still not called stale.
	for (const [label, drift] of [["image", { image: "squid:old" }], ["entrypoint", { entrypoint: ["squid"] }], ["command", { cmd: ["-N"] }]]) {
		const staleImage = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: proxyState("running", { ...desktop, ...drift }), "docker rm": 0, "docker network create": 0, "docker run -d --name pi-dispatch-egress-proxy": 0 }, listening: true, files: PROXY_FILES, argv: ["--yes"] });
		staleImage.deps.fs.realpathSync = noResolve;
		await staleImage.run();
		assert.match(staleImage.text(), /is not this deployment's proxy: it(s)? [^\n]*\n/, label);
		assert.doesNotMatch(staleImage.text(), /is not this deployment's proxy: [^\n]*(its \/etc\/|nothing is mounted at)/, `${label}: the unknown mounts are not called stale`);
		assert.doesNotMatch(staleImage.text(), /not replaced: one of its own mounts could not be compared/, label);
		assert.deepEqual(dockerMutations(staleImage), [EGRESS_RM, EGRESS_NET, EGRESS_RUN], `${label}: replaced`);
		if (label === "image") assert.match(staleImage.text(), /is not this deployment's proxy: it was created from squid:old, not the pinned ubuntu\/squid@sha256:6a097f68[0-9a-f]{56}\n/, "the image drift alone, the unknown mounts not called stale");
	}
	// One bind unknown, the other and an extra mount still judged (round-cap re-review): each on its own.
	const partial = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: proxyState("running", { conf: "/host_mnt/Users/op/deploy/deploy/egress-proxy.conf", allowlist: "/srv/other/egress-allowlist.conf", extra: [{ Type: "bind", Source: "/host_mnt/tmp/open.conf", Destination: "/tmp/open.conf" }] }) }, listening: true, files: PROXY_FILES, argv: ["--yes"] });
	partial.deps.fs.realpathSync = (p) => (p.startsWith("/host_mnt/") ? noResolve(p) : p);
	await partial.run();
	assert.match(partial.text(), /⚠ could not compare pi-dispatch-egress-proxy's mounts on this host: \/host_mnt\/Users\/op\/deploy\/deploy\/egress-proxy\.conf is a path this host cannot resolve/);
	assert.match(partial.text(), /is not this deployment's proxy: its \/etc\/pi-dispatch\/allowlist\.conf is \/srv\/other\/egress-allowlist\.conf, not \/deploy\/egress-allowlist\.conf; it has a bind at \/tmp\/open\.conf/);
	assert.deepEqual(dockerMutations(partial), [], "an expected mount is unknown, so nothing is removed");
});

test("up on docker: replacing a stale proxy that carries job networks says so and says to stop the worker first; an unreadable state is left alone (#453 gate 2)", async () => {
	const state = proxyState("running", { image: "squid:old", networks: ["pi-dispatch-egress-out", "pi-job-local-a1-net", "pi-sandbox-b2-net"] });
	const h = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: state }, listening: true, files: PROXY_FILES, answers: ["n"] });
	await h.run();
	assert.match(h.promptCalls.join("\n") + h.text(), /It is attached to pi-job-local-a1-net, pi-sandbox-b2-net: removing it cuts those jobs off from their egress mid-run, so stop the worker first \(and let running jobs finish\):/);
	// --yes does not cover it (gate round 3): the lines are printed, a person is asked, and without a yes nothing runs.
	const unattended = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: state, "docker rm": 0, "docker network create": 0, "docker run -d --name pi-dispatch-egress-proxy": 0 }, listening: true, files: PROXY_FILES, argv: ["--yes"] });
	await unattended.run();
	assert.match(unattended.text(), /--yes does not cover replacing a proxy that jobs are using: answer below, or stop the worker and re-run\n/);
	assert.equal(unattended.promptCalls.length, 1, "asked, even under --yes");
	assert.deepEqual(dockerMutations(unattended), [], "an unanswered prompt removes nothing");
	const answered = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: state, "docker rm": 0, "docker network create": 0, "docker run -d --name pi-dispatch-egress-proxy": 0 }, listening: true, files: PROXY_FILES, argv: ["--yes"], answers: ["y"] });
	await answered.run();
	assert.deepEqual(dockerMutations(answered), [EGRESS_RM, EGRESS_NET, EGRESS_RUN], "a person's yes does");
	// A STOPPED stale proxy carries no traffic, so --yes still covers replacing it.
	const stopped = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: proxyState("exited", { image: "squid:old", networks: ["pi-job-local-a1-net"] }), "docker rm": 0, "docker network create": 0, "docker run -d --name pi-dispatch-egress-proxy": 0 }, listening: true, files: PROXY_FILES, argv: ["--yes"] });
	await stopped.run();
	assert.deepEqual(dockerMutations(stopped), [EGRESS_RM, EGRESS_NET, EGRESS_RUN]);
	const quiet = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: proxyState("running", { image: "squid:old" }) }, listening: true, files: PROXY_FILES, answers: ["n"] });
	await quiet.run();
	assert.doesNotMatch(quiet.promptCalls.join("\n") + quiet.text(), /It is attached to/);
	// Exists, and its inspect answer reads as nothing: no start, no run on a taken name.
	const junk = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: { code: 0, output: "not json\n" } }, listening: true, files: PROXY_FILES, argv: ["--yes"] });
	await junk.run();
	assert.match(junk.text(), /✗ pi-dispatch-egress-proxy exists, but its state could not be read from `docker inspect`, so up leaves it as it is/);
	assert.deepEqual(dockerMutations(junk), []);
});

test("up's recreate creates the proxy's network only where it does not exist, so the daemon's 'already used' never prints (#453 exec round 3)", async () => {
	const plan = (exists) => ({ ...green, [PROXY_INSPECT]: proxyState("exited", { image: "squid:old" }), "docker network inspect pi-dispatch-egress-out": exists ? 0 : { code: 1, stderr: "Error: no such network\n" }, "docker rm": 0, "docker network create": 0, "docker run -d --name pi-dispatch-egress-proxy": 0 });
	const there = harness({ env: EGRESS_ENV, plan: plan(true), listening: true, files: PROXY_FILES, argv: ["--yes"] });
	await there.run();
	assert.deepEqual(dockerMutations(there), [EGRESS_RM, EGRESS_RUN], "no create for a network that exists");
	// `--yes` runs exactly the lines shown (PR #456's final check), so every shown line is a command, and the create is
	// shown only where it runs: the old `... create pi-dispatch-egress-out   (only if it does not exist yet)` ran nowhere.
	const shown = (h) => h.text().split("\n").filter((l) => l.startsWith("  docker "));
	assert.deepEqual(shown(there), ["  docker rm -f -v pi-dispatch-egress-proxy", `  docker ${EGRESS_RUN.join(" ")}`], "a network that exists: no create line");
	assert.doesNotMatch(there.text(), /only if it does not exist yet/);
	const absent = harness({ env: EGRESS_ENV, plan: plan(false), listening: true, files: PROXY_FILES, argv: ["--yes"] });
	await absent.run();
	assert.deepEqual(dockerMutations(absent), [EGRESS_RM, EGRESS_NET, EGRESS_RUN]);
	assert.deepEqual(shown(absent), ["  docker rm -f -v pi-dispatch-egress-proxy", "  docker network create pi-dispatch-egress-out", `  docker ${EGRESS_RUN.join(" ")}`], "a missing network: its create, as a runnable line");
	// The first start of an absent proxy follows the same rule, both ways.
	for (const exists of [true, false]) {
		const fresh = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: 1, "docker network inspect pi-dispatch-egress-out": exists ? 0 : { code: 1, stderr: "Error: no such network\n" }, "docker network create": 0, "docker run -d --name pi-dispatch-egress-proxy": 0 }, listening: true, files: PROXY_FILES, argv: ["--yes"] });
		await fresh.run();
		assert.deepEqual(dockerMutations(fresh), exists ? [EGRESS_RUN] : [EGRESS_NET, EGRESS_RUN], `network exists: ${exists}`);
		assert.deepEqual(shown(fresh), [...(exists ? [] : ["  docker network create pi-dispatch-egress-out"]), `  docker ${EGRESS_RUN.join(" ")}`], `network exists: ${exists}`);
	}
});

test("up makes the proxy's network at RUN time when it was removed while the question waited, and says so (PR #466 gate round 1)", async () => {
	// Measured: the network present at the question and removed during the prompt made `docker run --network` fail
	// "network not found". The consent lines stay runnable (no create line for a network that existed), and the create
	// that runs anyway is said, with its command.
	for (const stale of [false, true]) {
		const plan = { ...green, [PROXY_INSPECT]: stale ? proxyState("exited", { image: "squid:old" }) : 1, "docker network inspect pi-dispatch-egress-out": 0, "docker rm": 0, "docker network create": 0, "docker run -d --name pi-dispatch-egress-proxy": 0 };
		const h = harness({ env: EGRESS_ENV, plan, listening: true, files: PROXY_FILES });
		h.deps.prompt = (q) => {
			h.promptCalls.push(q);
			if (/replace it|not running/.test(q + h.text())) plan["docker network inspect pi-dispatch-egress-out"] = { code: 1, stderr: "Error: no such network\n" };
			return "y";
		};
		await h.run();
		const shown = h.text().split("\n").filter((l) => l.startsWith("  docker "));
		assert.ok(!shown.includes("  docker network create pi-dispatch-egress-out"), `stale ${stale}: not shown, since it existed at the question`);
		assert.match(h.text(), /pi-dispatch-egress-out was removed while the question waited, and the proxy's run needs it: `docker network create pi-dispatch-egress-out`\n/, `stale ${stale}`);
		assert.deepEqual(dockerMutations(h), [...(stale ? [EGRESS_RM] : []), EGRESS_NET, EGRESS_RUN], `stale ${stale}: made before the run`);
	}
	// Present at the run too: nothing is created and nothing is said.
	const kept = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: 1, "docker network inspect pi-dispatch-egress-out": 0, "docker run -d --name pi-dispatch-egress-proxy": 0 }, listening: true, files: PROXY_FILES, argv: ["--yes"] });
	await kept.run();
	assert.deepEqual(dockerMutations(kept), [EGRESS_RUN]);
	assert.doesNotMatch(kept.text(), /was removed while the question waited/);
});

// The deployment file's PI_JOB_IMAGE is a hand-written copy of a value this repo derives: the job image the deployment
// runs. Nothing held it, and it sat on 4.3.1 through a release that moved everything else, which is how a deployment
// keeps running last release's image without a single red check: the compose file names an image that exists, so no
// pull fails. Both copies, since a deployment may be run from either.
//
// The line is also .env-OVERRIDABLE (`${PI_JOB_IMAGE:-<default>}`, compose interpolation reads `--env-file .env`): the
// concrete tag is the fallback only, a value in the deployment's .env wins, and the fallback is never `latest` -- a
// deployment that pins no version would silently run whatever the registry moved last.
test("deploy/docker-compose.yml's PI_JOB_IMAGE is a concrete, .env-overridable job image on the default's own repository", () => {
	// The repository half comes from the one place that names the default's upstream (`jobImageFix`), so a later move
	// to another registry fails here as well as in the literals above.
	assert.equal(jobImageFix("docker", "pi-job:latest").split(" ")[2], "docker.io/ddv12138/pi-job:latest");
	const line = "      PI_JOB_IMAGE: ${PI_JOB_IMAGE:-docker.io/ddv12138/pi-job:4.3.3}";
	for (const path of ["../../deploy/docker-compose.yml", "../deploy/docker-compose.yml"]) {
		const compose = readFileSync(new URL(path, import.meta.url), "utf8");
		assert.ok(compose.split("\n").includes(line), `${path}: the concrete default, overridable from .env`);
		assert.ok(!/PI_JOB_IMAGE:.*:latest/.test(compose), `${path}: never latest`);
	}
});

test("up's proxy image is the compose file's, one pinned digest (#453 gate)", () => {
	const compose = readFileSync(new URL("../../deploy/docker-compose.yml", import.meta.url), "utf8");
	assert.match(compose, new RegExp(`^\\s*image: ${PINNED_SQUID.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\s*$`, "m"));
	// The Quadlet unit that pinned the same digest beside compose went with the venues that installed it.
	assert.equal(EGRESS_RUN.at(-1), PINNED_SQUID);
});

// Issue #503: up's run argv and the compose service start one proxy, so they mount the same three files and give it the
// same host entry. Read off both copies of the compose file; up's argv is the golden above.
test("up's proxy mounts and host entry are the compose service's, the model endpoints' include and host-gateway among them (#503)", () => {
	for (const path of ["../../deploy/docker-compose.yml", "../deploy/docker-compose.yml"]) {
		const compose = readFileSync(new URL(path, import.meta.url), "utf8");
		const service = compose.slice(compose.indexOf("  egress-proxy:"), compose.indexOf("\nnetworks:"));
		const composeMounts = [...service.matchAll(/^\s+- \S+:(\/etc\/\S+:ro,z)$/gm)].map((m) => m[1]);
		const upMounts = EGRESS_RUN.filter((a, i) => EGRESS_RUN[i - 1] === "-v").map((v) => v.slice(v.indexOf(":") + 1));
		assert.deepEqual(upMounts, composeMounts, path);
		assert.ok(upMounts.includes("/etc/pi-dispatch/model-endpoints.conf:ro,z"), path);
		assert.match(service, /^ {4}extra_hosts:\n {6}- "host\.docker\.internal:host-gateway"$/m, `${path}: the proxy's host entry`);
		assert.deepEqual(EGRESS_RUN.filter((a, i) => EGRESS_RUN[i - 1] === "--add-host"), ["host.docker.internal:host-gateway"]);
		// The PROXY only: no other service is given the host.
		assert.equal(compose.split("\n").filter((l) => !/^\s*#/.test(l) && l.includes("host-gateway")).length, 1, `${path}: one host entry, the proxy's`);
	}
});

// Issue #480: `mkdir x && cd x && npx @edgehero/pi-dispatch up`, driven through up's seams with the REAL init on a real
// empty folder (the harness's fake init creates nothing, which is how this hole went unseen), and the policy on by default.
test("up in an empty folder reaches the egress proxy start with no missing-file line, and prints no Next ladder of init's (#480)", async () => {
	const dir = tempDir("pi-up-480-");
	const h = harness({
		plan: { "docker version": 0, "docker image inspect": 0, [PROXY_INSPECT]: 1, "docker network create": 0, "docker run -d --name pi-dispatch-egress-proxy": 0 },
		listening: true,
		argv: ["--yes"],
		cwd: dir,
		// The real package's rules too (issue #484), which init just copied: the fresh copy is identical, so nothing asks.
		extra: { fs: realFs, runInitFn: runInit, readPackagedConf: readPackagedProxyConf },
	});
	await h.run();
	const text = h.text();
	assert.ok(realFs.existsSync(join(dir, "deploy", "egress-proxy.conf")), "init scaffolded the proxy's rules");
	assert.doesNotMatch(text, /differs from the package's copy|egress rules/, "a copy identical to the package's is silent (#484)");
	assert.doesNotMatch(text, /is not here/, text);
	assert.deepEqual(dockerMutations(h).filter((a) => a[0] === "run" && a.includes("pi-dispatch-egress-proxy")), [EGRESS_RUN], "the proxy is started from the shown argv");
	assert.match(text, /started pi-dispatch-egress-proxy/);
	// init's created lines stay; its ladder does not. The one "Next:" is up's own closing text, after the summary.
	assert.match(text, /^created deploy\/egress-proxy\.conf /m);
	assert.equal(text.split("Next:").length - 1, 1, text);
	assert.ok(text.indexOf("Next:") > text.indexOf("up: summary"), "the only Next: is up's own");
	assert.doesNotMatch(text, /1\. docker pull|\/dispatch setup walks these steps/);
});

test("up's declined Valkey and proxy name a compose line only where the folder holds the compose file (#480)", async () => {
	const bare = harness({ env: EGRESS_ENV, plan: { "docker version": 0, "docker image inspect": 0, [PROXY_INSPECT]: 1 }, listening: false, answers: ["", ""], files: { "/deploy/.env": `VALKEY_PASSWORD=${PASSWORD}\n`, ...PROXY_FILES } });
	await bare.run();
	assert.equal((bare.text().match(/skipped: start it later by running `pi-dispatch up` again and accepting\n/g) ?? []).length, 2, bare.text());
	assert.doesNotMatch(bare.text(), /skipped: start it later with `docker compose/);
	const clone = harness({ env: EGRESS_ENV, plan: { "docker version": 0, "docker image inspect": 0, [PROXY_INSPECT]: 1 }, listening: false, answers: ["", ""], files: { "/deploy/.env": `VALKEY_PASSWORD=${PASSWORD}\n`, ...PROXY_FILES, "/deploy/deploy/docker-compose.yml": "services: {}\n" } });
	await clone.run();
	assert.match(clone.text(), /skipped: start it later with `docker compose --env-file \.env -f deploy\/docker-compose\.yml up -d`/);
	assert.match(clone.text(), /skipped: start it later with `docker compose --env-file \.env -f deploy\/docker-compose\.yml --profile egress up -d`/);
});

test("up's failed Valkey start and its open-Valkey hint name compose only where the folder holds the compose file (PR #488 review)", async () => {
	const env = `VALKEY_PASSWORD=${PASSWORD}\n`;
	for (const withCompose of [false, true]) {
		const files = { "/deploy/.env": env, ...(withCompose ? { "/deploy/deploy/docker-compose.yml": "services: {}\n" } : {}) };
		const failed = harness({ plan: { "docker version": 0, "docker image inspect": 0, "docker volume create": 0, "docker run -d --name pi-dispatch-valkey": 1 }, listening: false, argv: ["--yes"], files: { ...files } });
		await failed.run();
		if (withCompose) assert.match(failed.text(), /valkey\s+container start FAILED; `docker compose --env-file \.env -f deploy\/docker-compose\.yml up -d` is the fallback/);
		else assert.match(failed.text(), /valkey\s+container start FAILED; re-run `pi-dispatch up`\n/, failed.text());
		const open = harness({ plan: { "docker version": 0, "docker image inspect": 0 }, listening: true, files: { ...files }, extra: { probeValkeyAuth: async () => "ok" } });
		await open.run();
		assert.match(open.text(), /⚠ the Valkey on 6379 answers without a password, and it is not a container up started, so up leaves it: restart it with VALKEY_PASSWORD from \.env/);
		assert.equal(/\(compose: `docker compose/.test(open.text()), withCompose, `compose named only with the file: ${withCompose}`);
	}
});

// Issue #480, PR #488's review: no operator-facing string names a compose COMMAND that reads no .env. Every mention of
// `docker compose` (or `docker-compose`) outside a comment is either a command carrying --env-file on the same line, or
// one of the prose sentences named here by their text. A new mention of either kind fails until it is one or the other.
// Commands built at run time go through `composeArgs`, whose own test below pins --env-file.
const COMPOSE_PROSE = [
	["../src/valkey-auth.mjs", "# Written by /dispatch setup (the docker compose answer)"],
];
/** "ok" (a compose command carrying --env-file), "bad" (one without it), "prose" (a mention that is no command), or null. */
function composeMention(line) {
	const text = line.replace(/docker-compose(\.valkey)?\.ya?ml/g, "");
	if (!/docker[ -]compose\b/.test(text)) return null;
	if (/docker[ -]compose\s+(-|(up|down|stop|start|restart|run|pull|ps|logs|exec|rm|build|config|create|kill|pause|unpause)\b)/.test(text)) return /--env-file/.test(text) ? "ok" : "bad";
	return "prose";
}

test("the compose scan's own judgement: flags in any order, docker-compose, prose (PR #488's review)", () => {
	for (const [line, want] of [
		["`docker compose -f deploy/docker-compose.yml --env-file .env up -d`", "ok"],
		["docker compose --env-file .env -f deploy/docker-compose.yml --profile egress up -d", "ok"],
		["`docker compose --profile egress up -d`", "bad"],
		["docker compose -p x --profile receiver -f deploy/docker-compose.yml up -d", "bad"],
		["docker-compose up -d", "bad"],
		["(docker compose up)", "bad"],
		["the receiver container needs docker compose, and", "prose"],
		["same semantics as deploy/docker-compose.yml --profile egress", null],
	]) assert.equal(composeMention(line), want, line);
});

test("no source line names a docker compose command without --env-file; the prose mentions are the named ones (#480)", () => {
	const commands = [];
	const prose = [];
	for (const dir of ["../src", "../../receiver/src", "../../admin/src"]) {
		const root = new URL(`${dir}/`, import.meta.url);
		for (const name of realFs.readdirSync(root, { recursive: true })) {
			if (!/\.(mjs|js|ts)$/.test(name)) continue;
			let inBlock = false;
			realFs.readFileSync(new URL(name, root), "utf8").split("\n").forEach((line, i) => {
				// Comments only: a `*` line counts as one inside a /* block alone, never inside a template literal.
				const t = line.trim();
				if (inBlock) {
					if (t.includes("*/")) inBlock = false;
					return;
				}
				if (t.startsWith("/*")) {
					if (!t.includes("*/")) inBlock = true;
					return;
				}
				if (t.startsWith("//")) return;
				const kind = composeMention(line);
				const where = `${dir}/${name}:${i + 1}`;
				if (kind === "bad") commands.push(where);
				else if (kind === "prose" && !COMPOSE_PROSE.some(([file, needle]) => where.startsWith(`${file}:`) && line.includes(needle))) prose.push(`${where}: ${t.slice(0, 120)}`);
			});
		}
	}
	assert.deepEqual(commands, [], "a compose command without --env-file");
	assert.deepEqual(prose, [], "a prose mention of compose not named in COMPOSE_PROSE: make it a command with --env-file, or name it");
});

test("composeArgs always carries --env-file .env, with or without the folder's project and override (#480)", async () => {
	const { composeArgs } = await import("../src/valkey-auth.mjs");
	for (const opts of [undefined, {}, { project: "x" }, { override: true }, { project: "x", override: true }]) {
		const args = composeArgs(opts);
		assert.equal(args[0], "compose");
		assert.deepEqual(args.slice(args.indexOf("--env-file"), args.indexOf("--env-file") + 2), ["--env-file", ".env"], JSON.stringify(opts));
	}
});


test("up goes on past an init that refuses or throws: a FILE named deploy, and a folder init cannot write (PR #488's review)", async () => {
	const dir = tempDir("pi-up-488-");
	realFs.writeFileSync(join(dir, "deploy"), "not a folder\n");
	const real = harness({ plan: { "docker version": 0, "docker image inspect": 0, [PROXY_INSPECT]: 1 }, listening: true, argv: ["--yes"], cwd: dir, extra: { fs: realFs, runInitFn: runInit } });
	await real.run();
	assert.match(real.text(), /^refused deploy\/egress-proxy\.conf deploy\/ here is not a directory/m);
	assert.match(real.text(), /^created triggers\.json /m, "init listed what it did");
	assert.match(real.text(), /init\s+ran, and REFUSED a file \(said above\)/);
	assert.equal(real.doctorCalls.length, 1, "doctor still ran");
	const thrown = harness({ plan: green, listening: true, extra: { runInitFn: () => { throw Object.assign(new Error("EACCES: permission denied, open '/deploy/triggers.json'"), { code: "EACCES" }); } } });
	assert.equal(await thrown.run(), 0);
	assert.match(thrown.text(), /✗ init could not finish: EACCES: permission denied/);
	assert.match(thrown.text(), /init\s+FAILED \(said above\); the steps below still ran/);
	assert.equal(thrown.doctorCalls.length, 1, "doctor still ran");
});

test("up never starts the proxy on a directory where deploy/egress-proxy.conf belongs (PR #488's review)", async () => {
	const dir = tempDir("pi-up-488-dir-");
	realFs.mkdirSync(join(dir, "deploy", "egress-proxy.conf"), { recursive: true });
	realFs.writeFileSync(join(dir, "egress-allowlist.conf"), "api.anthropic.com\n");
	const h = harness({ plan: { "docker version": 0, "docker image inspect": 0, [PROXY_INSPECT]: 1, "docker network create": 0, "docker run -d --name pi-dispatch-egress-proxy": 0 }, listening: true, argv: ["--yes"], cwd: dir, extra: { fs: realFs, runInitFn: () => 0 } });
	await h.run();
	assert.match(h.text(), /✗ the egress policy is on but deploy\/egress-proxy\.conf here is a directory, not a file, so no proxy is started without it/);
	assert.match(h.text(), /egress\s+skipped: deploy\/egress-proxy\.conf in this folder is a directory; run/);
	assert.ok(!h.calls.some((c) => c.args[0] === "run" && c.args.includes("pi-dispatch-egress-proxy")), "nothing started");
});

test("up tells init to print no next steps of its own (#480)", async () => {
	const h = harness({ plan: green, listening: true });
	await h.run();
	assert.deepEqual(h.initOpts.map((o) => o.steps), [false]);
});

test("up hands init the venues it decided, so init's next steps match the pass (#453)", async () => {
	const docker = harness({ plan: green, listening: true });
	await docker.run();
	assert.deepEqual(docker.initOpts.map((o) => o.venues), [{ localUsed: true }]);
});

test("up on docker: PI_EGRESS_PROXY is the name up looks for, and it never starts the shipped proxy in its place", async () => {
	const h = harness({
		env: { PI_EGRESS_PROXY: "my-squid" },
		plan: { ...green, "docker inspect": 1 },
		listening: true,
		files: { "/deploy/egress-allowlist.conf": "x\n", "/deploy/deploy/egress-proxy.conf": "conf\n" },
	});
	assert.equal(await h.run(), 0);
	assert.ok(h.calls.some((c) => c.args.join(" ") === "inspect --format={{.State.Status}} my-squid"));
	assert.ok(!h.calls.some((c) => c.args[0] === "run" || c.args[0] === "network"), "nothing started");
	assert.match(h.text(), /PI_EGRESS_PROXY names my-squid, and docker has no container of that name/);
});

test("E5: a shell and a .env that disagree on a venue key stop up before anything runs, naming both and which to change", async () => {
	const h = harness({ env: { PI_BACKENDS: "local" }, plan: green, listening: true, files: { "/deploy/.env": "PI_BACKENDS=podman\n" } });
	assert.equal(await h.run(), 1);
	assert.match(h.text(), /PI_BACKENDS is "local" in this shell and "podman" in \/deploy\/\.env\. up would drive the shell's venue while the service runs the file's/);
	assert.match(h.text(), /change \/deploy\/\.env \(what the service reads\), or unset the key in this shell/);
	assert.equal(h.calls.length, 0);
	assert.equal(h.initCalls.length, 0);
	// Agreement, or a key only one side sets, is no conflict: the shell's value is then simply the file's.
	const same = harness({ env: { PI_BACKENDS: "local" }, plan: green, listening: true, files: { "/deploy/.env": "PI_BACKENDS=local\n" } });
	assert.equal(await same.run(), 0);
});

test("D2/D6: a .env line the loaders read differently stops up before anything runs", async () => {
	const h = harness({ env: {}, plan: green, files: { "/deploy/.env": "PI_BACKENDS =podman\n" } });
	assert.equal(await h.run(), 1);
	assert.match(h.text(), /cannot tell which venue this deployment runs/);
	assert.equal(h.calls.length, 0);
	assert.equal(h.initCalls.length, 0);
});

test("#447 gate round 1: a .env systemd will not LOAD (a NUL, invalid UTF-8 in a value) stops up on Linux before anything runs", async () => {
	for (const [bytes, what] of [
		[Buffer.concat([Buffer.from("PI_EGRESS=0\n# a"), Buffer.from([0]), Buffer.from("b\nPI_BACKENDS=podman\n")]), /line 2 has a NUL byte, and systemd refuses to load a file with one anywhere in it, so the service does not start: remove the NUL byte/],
		[Buffer.concat([Buffer.from("K=caf"), Buffer.from([0xe9]), Buffer.from("\n")]), /line 1 has bytes in a key or value that are not valid UTF-8, or a Unicode noncharacter.*: re-save the file as UTF-8, or remove those bytes/],
	]) {
		const h = harness({ env: {}, plan: green, files: { "/deploy/.env": bytes } });
		assert.equal(await h.run(), 1);
		assert.match(h.text(), what);
		assert.deepEqual(h.calls, [], "nothing ran");
		assert.equal(h.initCalls.length, 0, "not even init");
		assert.ok(h.store.get("/deploy/.env").equals(bytes), "the file is byte-identical");
	}
});

test("#447 gate round 2: up's own .env writes are read back first: a key that would land inside an open quote is not written", async () => {
	// Appending WEBHOOK_SECRET after `X="abc` puts it inside X's value (measured on systemd 259 for PI_BACKENDS, w02), so
	// the service would have no secret while up reported one generated. It is refused, said, and the file is unchanged.
	const before = 'A=1\nX="abc\n';
	const h = harness({ plan: green, listening: true, files: { "/deploy/.env": before } });
	await h.run();
	assert.match(h.text(), /✗ WEBHOOK_SECRET could not be written: refusing to edit \/deploy\/\.env: after the edit, systemd's EnvironmentFile= would find no WEBHOOK_SECRET\. Nothing was written/);
	assert.doesNotMatch(h.text(), /generated WEBHOOK_SECRET into \.env/);
	assert.equal(h.store.get("/deploy/.env"), before, "unchanged");
});

test("#447 gate round 4: up names a WEBHOOK_SECRET only a shell reads, instead of calling it already set", async () => {
	const h = harness({ plan: green, listening: true, files: { "/deploy/.env": "export WEBHOOK_SECRET=abc\n" } });
	await h.run();
	assert.match(h.text(), /✗ WEBHOOK_SECRET could not be written: refusing to edit \/deploy\/\.env: WEBHOOK_SECRET is set only for a shell \(line 1: export WEBHOOK_SECRET=\.\.\.\); systemd's EnvironmentFile= ignores that line/);
	assert.doesNotMatch(h.text(), /WEBHOOK_SECRET already set in \.env/);
	assert.doesNotMatch(h.text(), /abc/, "the secret is never shown");
});

test("nit: an unreadable .env is said, not silently replaced by the shell's venue", async () => {
	const h = harness({ env: {}, plan: green, listening: true, files: { "/deploy/.env": "x" } });
	h.deps.fs.readFileSync = (p) => {
		if (p === "/deploy/.env") throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
		throw new Error(`ENOENT: ${p}`);
	};
	await h.run();
	assert.match(h.text(), /\/deploy\/\.env could not be read \(EACCES: permission denied\), so the venue keys \(PI_BACKENDS, PI_EGRESS, PI_EGRESS_PROXY\) come from this shell alone/);
});

test("R25: the docker path never asks the passwd database, so an account with no entry and no USER still runs up", async () => {
	const h = harness({ env: {}, plan: green, listening: true, extra: { userInfoFn: () => { throw new Error("ENOENT: no such user"); } } });
	assert.equal(await h.run(), 0);
});

test("D4 (round 3): shell and .env are compared as the worker reads them, and shown in quotes", async () => {
	for (const shell of [" local", "local,local", "local "]) {
		const h = harness({ env: { PI_BACKENDS: shell, PI_EGRESS: "0" }, plan: green, listening: true, files: { "/deploy/.env": "PI_BACKENDS=local\nPI_EGRESS=0\n" } });
		assert.equal(await h.run(), 0, JSON.stringify(shell));
		assert.doesNotMatch(h.text(), /in this shell and/);
	}
	// PI_EGRESS "" and "1" are both ON; PI_EGRESS_PROXY "" is the default name, like the file's explicit default.
	const egress = harness({ env: { PI_EGRESS: "", PI_EGRESS_PROXY: "" }, plan: green, listening: true, files: { "/deploy/.env": "PI_EGRESS=1\nPI_EGRESS_PROXY=pi-dispatch-egress-proxy\n" } });
	assert.equal(await egress.run(), 0);
	assert.doesNotMatch(egress.text(), /in this shell and/);
	// A proxy name is NOT trimmed by anything that reads it, so a stray space is a different proxy and a disagreement.
	for (const shell of [" ", "pi-dispatch-egress-proxy "]) {
		const spaced = harness({ env: { PI_EGRESS_PROXY: shell }, plan: green, files: { "/deploy/.env": "PI_EGRESS_PROXY=pi-dispatch-egress-proxy\n" } });
		assert.equal(await spaced.run(), 1, JSON.stringify(shell));
		assert.match(spaced.text(), /PI_EGRESS_PROXY is "[^"]*" in this shell and "pi-dispatch-egress-proxy" in \/deploy\/\.env/);
	}
	// A real disagreement, with an empty shell value made visible.
	const empty = harness({ env: { PI_BACKENDS: "" }, plan: green, files: { "/deploy/.env": "PI_BACKENDS=podman\n" } });
	assert.equal(await empty.run(), 1);
	assert.match(empty.text(), /PI_BACKENDS is "" in this shell and "podman" in \/deploy\/\.env/);
});

test("up on docker (#468): a .env without a password gets one first, and docker's Valkey starts with it in the CLI's environment, never its argv", async () => {
	const h = harness({ plan: { "docker version": 0, "docker image inspect": 0, "docker volume": 0, "docker run": 0 }, listening: false, argv: ["--yes"], files: { "/deploy/.env": "A=1\n" }, env: { PI_PROVIDER: "anthropic", VALKEY_PASSWORD: "a-shell-value-that-is-not-the-deployments" } });
	assert.equal(await h.run(), 0);
	assert.match(h.store.get("/deploy/.env"), new RegExp(`^VALKEY_PASSWORD=${PASSWORD}$`, "m"));
	const run = h.calls.find((c) => c.cmd === "docker" && c.args[0] === "run");
	assert.deepEqual(run.args, VALKEY_RUN);
	assert.ok(!run.args.some((a) => a.includes(PASSWORD)), "on no argv");
	assert.equal(run.opts.env.VALKEY_PASSWORD, PASSWORD, "the deployment's, in the docker CLI's environment (`-e VALKEY_PASSWORD` names it)");
	assert.ok(!h.text().includes(PASSWORD));
	assert.match(h.text(), /✓ started Valkey \(container pi-dispatch-valkey, AOF on, bound to 127\.0\.0\.1, with VALKEY_PASSWORD from \.env\)/);
	// The password is decided before Valkey starts: the .env write comes first.
	assert.ok(h.text().indexOf("generated VALKEY_PASSWORD") < h.text().indexOf("started Valkey"));
	// A deployment that set its own: kept, and that one is what Valkey gets.
	const mine = harness({ plan: { "docker version": 0, "docker image inspect": 0, "docker volume": 0, "docker run": 0 }, listening: false, argv: ["--yes"], files: { "/deploy/.env": `VALKEY_PASSWORD=${SECRET}\n` } });
	await mine.run();
	assert.equal(mine.store.get("/deploy/.env").match(/VALKEY_PASSWORD=/g).length, 1);
	assert.equal(mine.calls.find((c) => c.args[0] === "run").opts.env.VALKEY_PASSWORD, SECRET);
	// A shared Valkey or an operator's own: nothing generated, and the Valkey up would start gets none from a shell.
	const shared = harness({ plan: { "docker version": 0, "docker image inspect": 0, "docker volume": 0, "docker run": 0 }, listening: false, argv: ["--yes"], files: { "/deploy/.env": "PI_VALKEY_SHARED=1\n" }, env: { VALKEY_PASSWORD: "x".repeat(20) } });
	await shared.run();
	assert.doesNotMatch(shared.store.get("/deploy/.env"), /VALKEY_PASSWORD/);
	assert.equal(shared.calls.find((c) => c.args[0] === "run").opts.env.VALKEY_PASSWORD, undefined);
	assert.match(shared.text(), /⚠ PI_VALKEY_SHARED=1 in \/deploy\/\.env: no VALKEY_PASSWORD is generated/);
});

test("up on docker (#468): our pi-dispatch-valkey answering without a password is offered a restart with it (stop, rm, run; the volume kept), and a declined or a foreign one is said", async () => {
	const files = { "/deploy/.env": `VALKEY_PASSWORD=${SECRET}\n` };
	const plan = { ...green, "docker stop": 0, "docker rm": 0, "docker run": 0 };
	const h = harness({ plan, listening: true, argv: ["--yes"], files, extra: { probeValkeyAuth: async () => "ok" } });
	assert.equal(await h.run(), 0);
	const acts = h.calls.filter((c) => c.cmd === "docker" && ["stop", "rm", "run"].includes(c.args[0]));
	assert.deepEqual(acts.map((c) => c.args), [["stop", "pi-dispatch-valkey"], ["rm", "pi-dispatch-valkey"], VALKEY_RUN], "stopped (SIGTERM: Valkey writes its AOF out), removed, run again; never rm -f, never the volume");
	assert.equal(acts[2].opts.env.VALKEY_PASSWORD, SECRET);
	assert.match(h.text(), /pi-dispatch-valkey answers without a password, and VALKEY_PASSWORD is set in \.env\. up would restart it with the password \(stopped first, so Valkey writes its AOF out; the pi-dispatch-valkey-data volume, and the queue in it, is kept\)\. A job running right now is interrupted, and the worker and the receiver get NOAUTH until they are restarted: pause first if a job runs \(pi-dispatch pause, wait for active jobs, then pi-dispatch resume after the restart\):/, "the consent says what the restart costs before it is given");
	assert.match(h.text(), /✓ restarted Valkey with VALKEY_PASSWORD \(container pi-dispatch-valkey, same volume\)\. Restart the worker and the receiver now/);
	assert.ok(!h.text().includes(SECRET));
	// Declined: nothing runs, and the summary says what that leaves.
	const no = harness({ plan, listening: true, answers: [""], files, extra: { probeValkeyAuth: async () => "ok" } });
	await no.run();
	assert.ok(!no.calls.some((c) => ["stop", "rm", "run"].includes(c.args[0])));
	assert.match(no.text(), /pi-dispatch-valkey runs WITHOUT a password \(declined the restart with it\)/);
	// Not ours (compose's, or a package's): never touched, the compose recreate named.
	// A folder holding the compose file, so the hint names compose (PR #488's review: only there).
	const foreign = harness({ plan: { ...plan, "docker container inspect pi-dispatch-valkey": { code: 1, stderr: "Error: No such container: pi-dispatch-valkey\n" } }, listening: true, argv: ["--yes"], files: { ...files, "/deploy/deploy/docker-compose.yml": "services: {}\n" }, extra: { probeValkeyAuth: async () => "ok" } });
	await foreign.run();
	assert.ok(!foreign.calls.some((c) => ["stop", "rm", "run"].includes(c.args[0])));
	assert.match(foreign.text(), /⚠ the Valkey on 6379 answers without a password, and it is not a container up started, so up leaves it: restart it with VALKEY_PASSWORD from \.env \(compose: `docker compose --env-file \.env -f deploy\/docker-compose\.yml up -d`/);
	// Round 3 of PR #475's review: a pi-dispatch-valkey is ours by up's label naming this folder, or, unlabelled, by
	// publishing this deployment's VALKEY_URL port; another deployment's (its label, or an unlabelled one on another port)
	// is never stopped, removed or run again, whatever its name.
	for (const [answer, ours] of [[inspectRecord({}), true], [inspectRecord({ label: "/srv/other" }), false], [inspectRecord({ port: 16496 }), false], [inspectRecord({ label: "/deploy/../srv/other" }), false]]) {
		const t = harness({ plan: { ...plan, "docker container inspect pi-dispatch-valkey": answer }, listening: true, argv: ["--yes"], files, extra: { probeValkeyAuth: async () => "ok" } });
		await t.run();
		assert.equal(t.calls.some((c) => ["stop", "rm", "run"].includes(c.args[0])), ours, JSON.stringify(answer));
		if (!ours) assert.match(t.text(), /pi-dispatch-valkey is not this deployment's Valkey \(.*\), so it is never stopped, removed or reused from here/);
	}
	// Ours, but another deployment's Valkey mounts pi-dispatch-valkey-data: no restart (two valkey-servers on one AOF,
	// measured), the container and the ways out named, and `up` fails.
	const shared = harness({ plan: { ...plan, "docker ps -a": { code: 0, output: "pi-dispatch-valkey\nother-valkey-1\n" }, "docker container inspect other-valkey-1": inspectRecord({ name: "other-valkey-1", workingDir: "/srv/other/deploy", port: 16496 }) }, listening: true, argv: ["--yes"], files, extra: { probeValkeyAuth: async () => "ok" } });
	assert.equal(await shared.run(), 1);
	assert.ok(!shared.calls.some((c) => ["stop", "rm", "run"].includes(c.args[0])));
	assert.match(shared.text(), /✗ pi-dispatch-valkey-data is mounted by other-valkey-1 \(the compose project in \/srv\/other\/deploy\), which is not this deployment's Valkey: a second Valkey on the same AOF would corrupt both queues, so none is started\. Stop that deployment's Valkey first if this folder should own the volume, or give this deployment a Valkey of its own/);
	assert.match(shared.text(), /up: the Valkey container or volume named above is not this deployment's/);
	assert.doesNotMatch(shared.text(), /skipped \(declined|skipped: start it later|declined the restart|skipped: until it restarts/, "a refusal, not a decline");
	// The same refusal where compose recreates this folder's Valkey (a handed-over folder).
	const hfiles = { ...files, "/deploy/deploy/docker-compose.valkey.yml": "# override\n" };
	const hshared = harness({ plan: { ...plan, "docker compose": 0, "docker container inspect deploy-valkey-1": inspectRecord({ name: "deploy-valkey-1", workingDir: "/deploy/deploy" }), "docker ps -a": { code: 0, output: "deploy-valkey-1\nother-valkey-1\n" }, "docker container inspect other-valkey-1": inspectRecord({ name: "other-valkey-1", workingDir: "/srv/other/deploy", port: 16496 }) }, listening: true, argv: ["--yes"], files: hfiles, extra: { probeValkeyAuth: async () => "ok" } });
	assert.equal(await hshared.run(), 1);
	assert.ok(!hshared.calls.some((c) => ["compose", "stop", "rm", "run"].includes(c.args[0])));
	assert.match(hshared.text(), /✗ pi-dispatch-valkey-data is mounted by other-valkey-1/);
	assert.doesNotMatch(hshared.text(), /skipped \(declined|skipped: start it later|declined the restart|skipped: until it restarts/);
	// Already protected (NOAUTH to a client with none): nothing offered.
	const fine = harness({ plan, listening: true, argv: ["--yes"], files, extra: { probeValkeyAuth: async () => "noauth" } });
	await fine.run();
	assert.ok(!fine.calls.some((c) => ["stop", "rm", "run"].includes(c.args[0])));
	assert.match(fine.text(), /valkey\s+container pi-dispatch-valkey already running/);
});

test("up on docker: VALKEY_URL's port is the one probed and published; another host adds none; an IPv6 literal is refused", async () => {
	const probed = [];
	const h = harness({ plan: { "docker version": 0, "docker image inspect": 0, "docker volume": 0, "docker run": 0 }, listening: false, argv: ["--yes"], files: { "/deploy/.env": `VALKEY_URL=redis://127.0.0.1:16470\nVALKEY_PASSWORD=${PASSWORD}\n` }, extra: { probeTcp: async (host, port) => (probed.push(`${host}:${port}`), false) } });
	assert.equal(await h.run(), 0);
	assert.ok(probed.includes("127.0.0.1:16470") && !probed.includes("127.0.0.1:6379"), probed.join(" "));
	const run = h.calls.find((c) => c.cmd === "docker" && c.args[0] === "run");
	assert.equal(run.args[run.args.indexOf("-p") + 1], "127.0.0.1:16470:6379", "published on VALKEY_URL's port (the container still listens on 6379)");
	assert.match(h.text(), /Nothing is listening on 127\.0\.0\.1:16470\. up would start Valkey/);
	// This shell's VALKEY_URL counts where the file sets none, as for the service's other keys.
	const shell = harness({ plan: { "docker version": 0, "docker image inspect": 0, "docker volume": 0, "docker run": 0 }, listening: false, argv: ["--yes"], files: { "/deploy/.env": `VALKEY_PASSWORD=${PASSWORD}\n` }, env: { VALKEY_URL: "redis://localhost:16471" } });
	await shell.run();
	const r2 = shell.calls.find((c) => c.args[0] === "run");
	assert.equal(r2.args[r2.args.indexOf("-p") + 1], "127.0.0.1:16471:6379");
	// A listener on that port is taken as the Valkey, named by its port.
	const taken = harness({ plan: green, listening: true, files: { "/deploy/.env": `VALKEY_URL=redis://127.0.0.1:16472\nVALKEY_PASSWORD=${PASSWORD}\n` } });
	await taken.run();
	assert.match(taken.text(), /✓ something is listening on 16472, assuming your Valkey/);
	// Another host: nothing started, nothing probed, said.
	const remote = harness({ plan: { "docker version": 0, "docker image inspect": 0 }, listening: false, argv: ["--yes"], files: { "/deploy/.env": "VALKEY_URL=redis://queue.lan:6379\n" } });
	assert.equal(await remote.run(), 0);
	assert.ok(!remote.calls.some((c) => ["run", "volume"].includes(c.args[0])));
	assert.match(remote.text(), /✓ VALKEY_URL names queue\.lan, not this host, so no Valkey is added here/);
	// An [::1] URL cannot reach a Valkey published on 127.0.0.1: refused with the fix, and up fails.
	const v6 = harness({ plan: { "docker version": 0, "docker image inspect": 0 }, listening: false, argv: ["--yes"], files: { "/deploy/.env": 'VALKEY_URL="redis://[::1]:6380"\n' } });
	assert.equal(await v6.run(), 1);
	assert.match(v6.text(), /✗ VALKEY_URL's host is ::1, and the Valkey up starts is published on 127\.0\.0\.1 only, so the worker would not reach it\. Write VALKEY_URL=redis:\/\/127\.0\.0\.1:6380/);
	assert.ok(!v6.calls.some((c) => ["run", "volume"].includes(c.args[0])));
	// A shell and a .env that disagree: the service runs the file's, so up adds nothing and says so.
	const conflict = harness({ plan: { "docker version": 0, "docker image inspect": 0 }, listening: false, argv: ["--yes"], files: { "/deploy/.env": "VALKEY_URL=redis://127.0.0.1:16473\n" }, env: { VALKEY_URL: "redis://127.0.0.1:16474" } });
	assert.equal(await conflict.run(), 1);
	assert.match(conflict.text(), /✗ VALKEY_URL is "redis:\/\/127\.0\.0\.1:16474" in this shell and "redis:\/\/127\.0\.0\.1:16473" in \/deploy\/\.env/);
});

// PR #475's review, round 2: in a folder the setup wizard handed to compose (deploy/docker-compose.valkey.yml), `up`
// used to `docker run` pi-dispatch-valkey beside compose's, and the wizard's next compose run failed to bind (measured).
// It now starts compose's valkey with the folder's project and the override, on VALKEY_URL's port, and says a failure.
// PR #475's review, round 3 (measured on Fedora: a second deployment's `up` ran pi-dispatch-valkey on the volume another
// deployment's compose Valkey mounted, and both appended to one AOF): the plain start asks who mounts the volume first.
test("up on docker never starts a Valkey on pi-dispatch-valkey-data beside another deployment's, and never replaces a pi-dispatch-valkey that is not its own (#475 round 3)", async () => {
	const files = { "/deploy/.env": `VALKEY_URL=redis://127.0.0.1:16496\nVALKEY_PASSWORD=${PASSWORD}\n` };
	const base = { "docker version": 0, "docker image inspect": 0, "docker volume": 0, "docker run": 0, "docker start": 0 };
	// Another deployment's compose valkey on the volume: refused, named, nothing created or run, `up` fails.
	const other = inspectRecord({ name: "a-valkey-1", workingDir: "/srv/a/deploy", port: 16495 });
	const h = harness({ plan: { ...base, "docker ps -a": { code: 0, output: "a-valkey-1\n" }, "docker container inspect a-valkey-1": other }, listening: false, argv: ["--yes"], files });
	assert.equal(await h.run(), 1);
	assert.ok(!h.calls.some((c) => ["volume", "run", "stop", "rm", "start"].includes(c.args[0])), "nothing created, run, stopped or removed");
	assert.match(h.text(), /✗ pi-dispatch-valkey-data is mounted by a-valkey-1 \(the compose project in \/srv\/a\/deploy\), which is not this deployment's Valkey: a second Valkey on the same AOF would corrupt both queues, so none is started\. Stop that deployment's Valkey first if this folder should own the volume, or give this deployment a Valkey of its own \(compose in this folder without deploy\/docker-compose\.valkey\.yml keeps its own volume\)/);
	assert.match(h.text(), /up: the Valkey container or volume named above is not this deployment's \(or not attributed to it\), and up never stops, removes, reuses or starts beside one/);
	// docker not answering who mounts it is a refusal too.
	const dark = harness({ plan: { ...base, "docker ps -a": 1 }, listening: false, argv: ["--yes"], files });
	assert.equal(await dark.run(), 1);
	assert.ok(!dark.calls.some((c) => ["volume", "run"].includes(c.args[0])));
	assert.match(dark.text(), /whether another Valkey mounts pi-dispatch-valkey-data could not be read \(docker ps -a --filter volume=pi-dispatch-valkey-data exited 1\)/);
	// This deployment's own stopped container on the volume is not a reason to refuse; it is started as it is, never replaced.
	const mine = inspectRecord({ label: "/deploy", port: 16496 });
	const stopped = harness({ plan: { ...base, "docker ps -a": { code: 0, output: "pi-dispatch-valkey\n" }, "docker container inspect pi-dispatch-valkey": mine }, listening: false, argv: ["--yes"], files });
	assert.equal(await stopped.run(), 0);
	assert.ok(!stopped.calls.some((c) => ["volume", "run", "rm"].includes(c.args[0])));
	assert.match(stopped.text(), /pi-dispatch-valkey is this deployment's and is not listening on 16496: `docker start pi-dispatch-valkey` starts it as it is/);
	// Another deployment's pi-dispatch-valkey (its label, or unlabelled on another port), or one docker cannot describe:
	// never replaced, and `up` fails, since a second container of that name cannot be started.
	for (const answer of [inspectRecord({ label: "/srv/a", port: 16495 }), inspectRecord({ port: 16495 }), { code: 125, stderr: "Cannot connect to the Docker daemon\n" }]) {
		const t = harness({ plan: { ...base, "docker container inspect pi-dispatch-valkey": answer }, listening: false, argv: ["--yes"], files });
		assert.equal(await t.run(), 1, JSON.stringify(answer));
		assert.ok(!t.calls.some((c) => ["volume", "run", "stop", "rm", "start"].includes(c.args[0])));
		assert.match(t.text(), /a second container of that name cannot be started beside it/);
	}
});

// PR #475's review, the volume gap (measured on Fedora: A's compose Valkey taken down left nothing on
// pi-dispatch-valkey-data, and B's `up` started on A's queue). The volume carries its creator's label; another folder's
// is never used; an unlabelled one only after a question --yes does not answer; and every start checks the queue's own
// pi-dispatch:owner marker, recording it where it is missing.
const volumeRecord = (label, createdAt = "2026-09-01T10:00:00Z") => ({ code: 0, output: JSON.stringify([{ Name: "pi-dispatch-valkey-data", CreatedAt: createdAt, Labels: label ? { "com.pi-dispatch.deployment": label } : {} }]) });
test("up on docker uses pi-dispatch-valkey-data only when it is this folder's: another's label refuses, an unlabelled one is asked about even under --yes, and the owner marker is checked on every start (#475 volume gap)", async () => {
	const files = { "/deploy/.env": `VALKEY_URL=redis://127.0.0.1:16496\nVALKEY_PASSWORD=${PASSWORD}\n` };
	const base = { "docker version": 0, "docker image inspect": 0, "docker volume create": 0, "docker run": 0, "docker stop": 0, "docker rm": 0 };
	// The owner check's own container (round-cap re-review) is not one of these acts: its test is below.
	const acts = (h) => h.calls.filter((c) => c.cmd === "docker" && !c.args.includes("pi-dispatch-valkey-ownercheck") && (["run", "stop", "rm"].includes(c.args[0]) || (c.args[0] === "volume" && c.args[1] === "create"))).map((c) => c.args[0] === "volume" ? "create" : c.args[0]);
	// The gap: the volume is A's (its label), nothing mounts it: refused, nothing created or run, up fails.
	const theirs = harness({ plan: { ...base, "docker volume inspect": volumeRecord("/srv/a") }, listening: false, argv: ["--yes"], files });
	assert.equal(await theirs.run(), 1);
	assert.deepEqual(acts(theirs), []);
	assert.match(theirs.text(), /✗ pi-dispatch-valkey-data belongs to the deployment in \/srv\/a \(its label\), so this deployment never uses it: give this deployment a Valkey of its own .*, or run this from \/srv\/a/);
	// Labelled for this folder: used as it is (no create), and the marker recorded.
	const claims = [];
	const mine = harness({ plan: { ...base, "docker volume inspect": volumeRecord("/deploy") }, listening: false, argv: ["--yes"], files, extra: { claimValkeyOwner: async (url, folder) => (claims.push([url, folder]), { owner: folder, claimed: true }) } });
	assert.equal(await mine.run(), 0);
	assert.deepEqual(acts(mine), ["run"]);
	assert.deepEqual(claims, [["redis://127.0.0.1:16496", "/deploy"]], "the marker, on VALKEY_URL's port, for this folder");
	assert.match(mine.text(), /✓ recorded pi-dispatch:owner=\/deploy in its queue/);
	// Unlabelled: asked even under --yes, the risk named; no answer (a script's --yes) refuses.
	const unl = { ...base, "docker volume inspect": volumeRecord(null) };
	const no = harness({ plan: unl, listening: false, argv: ["--yes"], files });
	assert.equal(await no.run(), 1);
	assert.deepEqual(acts(no), []);
	assert.equal(no.promptCalls.length, 1, "--yes did not answer it");
	assert.match(no.promptCalls[0], /pi-dispatch-valkey-data exists without an owner label: this volume holds a queue pi-dispatch cannot attribute to a folder\. .*Adopt it for \/deploy\? \(asked even under --yes\) \[y\/N\]  \(or pass --adopt-volume\)$/);
	assert.match(no.text(), /✗ pi-dispatch-valkey-data has no owner label and was not adopted/);
	// Adopted: no create (it exists), run, and the ownership recorded in the queue.
	const adoptClaims = [];
	const yes = harness({ plan: unl, listening: false, argv: ["--yes"], answers: ["y"], files, extra: { claimValkeyOwner: async (url, folder) => (adoptClaims.push(folder), { owner: folder, claimed: true }) } });
	assert.equal(await yes.run(), 0);
	assert.deepEqual(acts(yes), ["run"]);
	assert.deepEqual(adoptClaims, ["/deploy"]);
	assert.match(yes.text(), /up would start Valkey \(same semantics as deploy\/docker-compose\.yml\) on the adopted pi-dispatch-valkey-data/);
	// A queue whose marker names another folder: what this pass started is stopped and removed at once, and up fails.
	const marked = harness({ plan: unl, listening: false, argv: ["--yes"], answers: ["y"], files, extra: { claimValkeyOwner: async () => ({ owner: "/srv/a", claimed: false }) } });
	assert.equal(await marked.run(), 1);
	assert.deepEqual(acts(marked), ["run", "stop", "rm"]);
	assert.match(marked.text(), /✗ the queue on pi-dispatch-valkey-data is the deployment's in \/srv\/a \(pi-dispatch:owner inside it\), not this one's: the Valkey this pass started on it was stopped again at once/);
	assert.doesNotMatch(marked.text(), /✓ started Valkey/);
	// A marker that cannot be read: up fails, saying so.
	const dark = harness({ plan: { ...base }, listening: false, argv: ["--yes"], files, extra: { claimValkeyOwner: async () => ({ error: "Connection is closed." }) } });
	assert.equal(await dark.run(), 1);
	assert.match(dark.text(), /✗ Valkey was started, but its pi-dispatch:owner could not be recorded or read \(Connection is closed\.\)/);
	assert.match(dark.text(), /up: the Valkey up started could not be asked whose queue it holds/);
	// docker not answering whose the volume is: refused.
	const blind = harness({ plan: { ...base, "docker volume inspect": { code: 125, stderr: "Cannot connect\n" } }, listening: false, argv: ["--yes"], files });
	assert.equal(await blind.run(), 1);
	assert.deepEqual(acts(blind), []);
	assert.match(blind.text(), /whose pi-dispatch-valkey-data is could not be read/);
});

test("up's other starts on the volume keep the rule: compose's valkey in a handed-over folder asks about an unlabelled volume, the upgrade restart of this deployment's own container does not, and both check the marker (#475 volume gap)", async () => {
	const files = { "/deploy/.env": `VALKEY_URL=redis://127.0.0.1:16495\nVALKEY_PASSWORD=${PASSWORD}\n`, "/deploy/deploy/docker-compose.valkey.yml": "# override\n" };
	const composeUp = (h) => h.calls.filter((c) => c.args[0] === "compose").map((c) => c.args.slice(-2).join(" "));
	const unl = { "docker version": 0, "docker image inspect": 0, "docker compose": 0, "docker run": 0, "docker stop": 0, "docker rm": 0, "docker volume inspect": volumeRecord(null) };
	const no = harness({ plan: unl, listening: false, argv: ["--yes"], files });
	assert.equal(await no.run(), 1);
	assert.deepEqual(composeUp(no), [], "not adopted: compose's valkey not started");
	const yes = harness({ plan: unl, listening: false, argv: ["--yes"], answers: ["y"], files, extra: { claimValkeyOwner: async () => ({ owner: "/srv/a", claimed: false }) } });
	assert.equal(await yes.run(), 1);
	assert.deepEqual(composeUp(yes), ["-d valkey", "stop valkey"], "started, then its marker named another folder: stopped at once");
	const theirs = harness({ plan: { ...unl, "docker volume inspect": volumeRecord("/srv/a") }, listening: false, argv: ["--yes"], files });
	assert.equal(await theirs.run(), 1);
	assert.deepEqual(composeUp(theirs), []);
	// The upgrade restart: this deployment's own pi-dispatch-valkey serves the unlabelled volume now, which attributes it;
	// no question, and the marker is checked after the restart.
	const rfiles = { "/deploy/.env": `VALKEY_PASSWORD=${SECRET}\n` };
	const claims = [];
	const restart = harness({ plan: { ...green, "docker stop": 0, "docker rm": 0, "docker run": 0, "docker volume inspect": volumeRecord(null) }, listening: true, argv: ["--yes"], files: rfiles, extra: { probeValkeyAuth: async () => "ok", claimValkeyOwner: async (url, folder) => (claims.push(folder), { owner: folder, claimed: true }) } });
	assert.equal(await restart.run(), 0);
	assert.equal(restart.promptCalls.length, 0);
	assert.deepEqual(claims, ["/deploy"]);
	const rtheirs = harness({ plan: { ...green, "docker stop": 0, "docker rm": 0, "docker run": 0, "docker volume inspect": volumeRecord("/srv/a") }, listening: true, argv: ["--yes"], files: rfiles, extra: { probeValkeyAuth: async () => "ok" } });
	assert.equal(await rtheirs.run(), 1);
	assert.ok(!rtheirs.calls.some((c) => ["stop", "rm", "run"].includes(c.args[0])), "another folder's volume: no restart");
});

// PR #475's review, round 3: PI_VALKEY_PORT lived only in the env up and the wizard hand compose, so the docs' plain
// compose command in the folder published on 6379 while the worker dialled VALKEY_URL's port (measured).
test("up on docker writes PI_VALKEY_PORT into .env when VALKEY_URL's port is not 6379, never over a different value (#475 round 3)", async () => {
	const plan = { "docker version": 0, "docker image inspect": 0, "docker volume": 0, "docker run": 0 };
	const h = harness({ plan, listening: false, argv: ["--yes"], files: { "/deploy/.env": `VALKEY_URL=redis://127.0.0.1:16470\nVALKEY_PASSWORD=${PASSWORD}\n` } });
	assert.equal(await h.run(), 0);
	assert.match(h.store.get("/deploy/.env"), /^PI_VALKEY_PORT=16470$/m);
	assert.match(h.text(), /✓ wrote PI_VALKEY_PORT=16470 into \.env \(VALKEY_URL's port\)/);
	// A different value is named and left.
	const differ = harness({ plan, listening: false, argv: ["--yes"], files: { "/deploy/.env": `VALKEY_URL=redis://127.0.0.1:16470\nVALKEY_PASSWORD=${PASSWORD}\nPI_VALKEY_PORT=16000\n` } });
	await differ.run();
	assert.match(differ.store.get("/deploy/.env"), /^PI_VALKEY_PORT=16000$/m);
	assert.doesNotMatch(differ.store.get("/deploy/.env"), /PI_VALKEY_PORT=16470/);
	assert.match(differ.text(), /⚠ PI_VALKEY_PORT is 16000 in \/deploy\/\.env, and VALKEY_URL's port is 16470: compose publishes its Valkey on 16000, where the worker does not dial/);
	// 6379, or another host: nothing written.
	for (const url of ["redis://127.0.0.1:6379", "redis://valkey.internal:16470"]) {
		const t = harness({ plan, listening: false, argv: ["--yes"], files: { "/deploy/.env": `VALKEY_URL=${url}\nVALKEY_PASSWORD=${PASSWORD}\n` } });
		await t.run();
		assert.doesNotMatch(t.store.get("/deploy/.env"), /PI_VALKEY_PORT/, url);
	}
});

test("up on docker in a handed-over folder starts compose's valkey (-p, the override, PI_VALKEY_PORT) and reports a failure", async () => {
	const files = { "/deploy/.env": `VALKEY_URL=redis://127.0.0.1:16495\nVALKEY_PASSWORD=${PASSWORD}\n`, "/deploy/deploy/docker-compose.valkey.yml": "# override\n" };
	const composeUp = ["compose", "-p", "deploy", "--env-file", ".env", "-f", "deploy/docker-compose.yml", "-f", "deploy/docker-compose.valkey.yml", "up", "-d", "valkey"];
	const h = harness({ plan: { "docker version": 0, "docker image inspect": 0, "docker compose": 0 }, listening: false, argv: ["--yes"], files });
	assert.equal(await h.run(), 0);
	const run = h.calls.find((c) => c.cmd === "docker" && c.args[0] === "compose");
	assert.deepEqual(run.args, composeUp, "compose's valkey, the folder's project, the override");
	assert.equal(run.opts.env.PI_VALKEY_PORT, "16495", "on VALKEY_URL's port");
	assert.equal(run.opts.env.VALKEY_PASSWORD, PASSWORD);
	assert.ok(!h.calls.some((c) => c.args[0] === "run" || (c.args[0] === "volume" && c.args[1] === "create")), "never a docker run of its own beside it");
	assert.match(h.text(), /PI_VALKEY_PORT=16495 docker compose -p deploy --env-file \.env -f deploy\/docker-compose\.yml -f deploy\/docker-compose\.valkey\.yml up -d valkey/);
	assert.match(h.text(), /✓ started compose's valkey \(project deploy, the pi-dispatch-valkey-data volume, 127\.0\.0\.1:16495\)/);
	// A failure (the bind that measured round 2 swallowed) is said, and up exits non-zero on it.
	const bad = harness({ plan: { "docker version": 0, "docker image inspect": 0, "docker compose": 1 }, listening: false, argv: ["--yes"], files });
	assert.equal(await bad.run(), 1);
	assert.match(bad.text(), /✗ compose could not start its valkey \(exit 1\): its own output above says why \(another container on 127\.0\.0\.1:16495 is the usual one/);
	assert.match(bad.text(), /up: compose could not start this folder's Valkey \(above\); free the port it names, then re-run `pi-dispatch up`\./);
	// Running and answering without a password: compose recreates it (never stop/rm/run).
	// Ours by compose's own working-dir label: this folder's deploy/ (round 3 of PR #475's review).
	const open = harness({ plan: { "docker version": 0, "docker image inspect": 0, "docker container inspect deploy-valkey-1": inspectRecord({ name: "deploy-valkey-1", workingDir: "/deploy/deploy", port: 16495 }), "docker compose": 0 }, listening: true, argv: ["--yes"], files, extra: { probeValkeyAuth: async () => "ok" } });
	await open.run();
	const acts = open.calls.filter((c) => c.cmd === "docker" && ["compose", "stop", "rm", "run"].includes(c.args[0]));
	assert.deepEqual(acts.map((c) => c.args), [["compose", "-p", "deploy", "--env-file", ".env", "-f", "deploy/docker-compose.yml", "-f", "deploy/docker-compose.valkey.yml", "up", "-d", "--force-recreate", "valkey"]]);
	// Round 3 of PR #475's review: compose's valkey here mounts pi-dispatch-valkey-data, so another deployment's container
	// on that volume (stopped or not) refuses the start, named, and `up` fails; nothing is run.
	const mounted = harness({ plan: { "docker version": 0, "docker image inspect": 0, "docker compose": 0, "docker ps -a": { code: 0, output: "pi-dispatch-valkey\n" }, "docker container inspect pi-dispatch-valkey": inspectRecord({ label: "/srv/b", port: 16496 }) }, listening: false, argv: ["--yes"], files });
	assert.equal(await mounted.run(), 1);
	assert.ok(!mounted.calls.some((c) => ["compose", "run", "stop", "rm"].includes(c.args[0])));
	assert.match(mounted.text(), /✗ pi-dispatch-valkey-data is mounted by pi-dispatch-valkey \(the deployment in \/srv\/b\), which is not this deployment's Valkey/);
	// A refusal is not a decline: nothing was asked (measured on Fedora, where it first read "skipped (declined)").
	assert.doesNotMatch(mounted.text(), /skipped \(declined|skipped: start it later|declined the restart|skipped: until it restarts/);
	// A folder without the override: every compose hint names the -p a wizard folder needs.
	const plain = harness({ plan: { "docker version": 0, "docker image inspect": 0 }, listening: false, answers: [""], files: { "/deploy/.env": `VALKEY_PASSWORD=${PASSWORD}\n`, "/deploy/deploy/docker-compose.yml": "services: {}\n" } });
	await plain.run();
	assert.match(plain.text(), /skipped: start it later with `docker compose --env-file \.env -f deploy\/docker-compose\.yml up -d` \(in a folder \/dispatch setup laid out, with -p deploy after `compose`\)/);
});

// PR #475's round-cap re-review, two closes. (1) A wrong `y` ran this deployment's Valkey on another's data, published,
// for about a second before the marker was read: the marker is now read FIRST, by a Valkey with no network and no port,
// through `docker exec`. (2) An adopted legacy volume stayed unlabelled, so every later `up` asked again and `--yes`
// refused: the adoption is recorded in the folder by the volume's CreatedAt, and that very volume is then this
// deployment's without asking.
test("up adopting an unlabelled volume reads its owner marker with an unpublished Valkey BEFORE any Valkey on it is published (#475 round-cap re-review)", async () => {
	const files = { "/deploy/.env": `VALKEY_URL=redis://127.0.0.1:16496\nVALKEY_PASSWORD=${PASSWORD}\n` };
	const base = { "docker version": 0, "docker image inspect": 0, "docker run": 0, "docker stop": 0, "docker rm": 0, "docker volume inspect": volumeRecord(null) };
	const publishes = (c) => c.cmd === "docker" && c.args[0] === "run" && c.args.includes("-p");
	const ok = harness({ plan: base, listening: false, argv: ["--yes"], answers: ["y"], files });
	assert.equal(await ok.run(), 0);
	const seq = ok.calls.filter((c) => c.cmd === "docker" && ["run", "exec", "stop", "rm"].includes(c.args[0])).map((c) => (publishes(c) ? "run published" : c.args[0] === "run" ? "run check" : `${c.args[0]} ${c.args[1]}`));
	assert.deepEqual(seq, ["run check", "exec pi-dispatch-valkey-ownercheck", "stop pi-dispatch-valkey-ownercheck", "rm pi-dispatch-valkey-ownercheck", "run published"], "the marker read, the check gone, THEN the published one");
	const check = ok.calls.find((c) => c.args[0] === "run" && c.args.includes("pi-dispatch-valkey-ownercheck"));
	assert.ok(check.args.includes("--network") && check.args[check.args.indexOf("--network") + 1] === "none" && !check.args.includes("-p"), "no network, no published port");
	assert.ok(!check.args.join(" ").includes(PASSWORD) && !check.args.includes("VALKEY_PASSWORD"), "and no password: nothing outside it can reach it");
	assert.deepEqual(ok.calls.find((c) => c.args[0] === "exec").args, ["exec", "pi-dispatch-valkey-ownercheck", "valkey-cli", "GET", "pi-dispatch:owner"]);
	// Another folder's marker: refused, and no Valkey on that data was ever published.
	const theirs = harness({ plan: { ...base, "docker exec": { code: 0, output: "/srv/a\n" } }, listening: false, argv: ["--yes"], answers: ["y"], files });
	assert.equal(await theirs.run(), 1);
	assert.ok(!theirs.calls.some(publishes), "never published");
	assert.deepEqual(theirs.calls.filter((c) => ["stop", "rm"].includes(c.args[0])).map((c) => c.args.join(" ")), ["stop pi-dispatch-valkey-ownercheck", "rm pi-dispatch-valkey-ownercheck"], "the check stopped and removed");
	assert.match(theirs.text(), /✗ the queue on pi-dispatch-valkey-data is the deployment's in \/srv\/a \(pi-dispatch:owner inside it\), not this one's: read by a Valkey with no network, so no Valkey was published on it/);
	assert.ok(!theirs.store.has("/deploy/.pi-dispatch-valkey-volume.json"), "nothing recorded");
	// Still loading: asked again after a wait, then answered.
	let n = 0;
	const slept = [];
	const loading = harness({ plan: { ...base, "docker exec": () => (n++ === 0 ? { code: 1, output: "(error) LOADING Valkey is loading the dataset in memory\n" } : { code: 0, output: "/deploy\n" }) }, listening: false, argv: ["--yes"], answers: ["y"], files, extra: { sleep: async (ms) => slept.push(ms) } });
	assert.equal(await loading.run(), 0);
	assert.deepEqual(slept, [500]);
	// docker not answering the exec: refused, never published.
	const dark = harness({ plan: { ...base, "docker exec": { code: 125, stderr: "Error: no such container\n" } }, listening: false, argv: ["--yes"], answers: ["y"], files });
	assert.equal(await dark.run(), 1);
	assert.ok(!dark.calls.some(publishes));
	assert.match(dark.text(), /whose queue pi-dispatch-valkey-data holds could not be read before starting/);
});

test("up records an adopted volume by its CreatedAt, and that very volume is this deployment's without asking; a different one is asked about again (#475 round-cap re-review)", async () => {
	const files = { "/deploy/.env": `VALKEY_URL=redis://127.0.0.1:16496\nVALKEY_PASSWORD=${PASSWORD}\n` };
	const base = { "docker version": 0, "docker image inspect": 0, "docker run": 0, "docker stop": 0, "docker rm": 0, "docker volume inspect": volumeRecord(null, "2026-09-01T10:00:00Z") };
	const first = harness({ plan: base, listening: false, argv: ["--yes"], answers: ["y"], files });
	assert.equal(await first.run(), 0);
	assert.equal(first.store.get("/deploy/.pi-dispatch-valkey-volume.json"), '{"name":"pi-dispatch-valkey-data","createdAt":"2026-09-01T10:00:00Z"}\n');
	// Later, with --yes and nobody to answer: the recorded volume is used, no question, no owner check.
	const later = harness({ plan: base, listening: false, argv: ["--yes"], files: { ...files, "/deploy/.pi-dispatch-valkey-volume.json": first.store.get("/deploy/.pi-dispatch-valkey-volume.json") } });
	assert.equal(await later.run(), 0);
	assert.equal(later.promptCalls.length, 0);
	assert.ok(!later.calls.some((c) => c.args.includes("pi-dispatch-valkey-ownercheck")));
	assert.ok(later.calls.some((c) => c.args[0] === "run" && c.args.includes("-p")));
	// The volume made again (another CreatedAt): asked again, and --yes alone refuses; the record is never rewritten.
	const again = harness({ plan: { ...base, "docker volume inspect": volumeRecord(null, "2026-09-20T08:00:00Z") }, listening: false, argv: ["--yes"], files: { ...files, "/deploy/.pi-dispatch-valkey-volume.json": first.store.get("/deploy/.pi-dispatch-valkey-volume.json") } });
	assert.equal(await again.run(), 1);
	assert.equal(again.promptCalls.length, 1);
	const yes = harness({ plan: { ...base, "docker volume inspect": volumeRecord(null, "2026-09-20T08:00:00Z") }, listening: false, argv: ["--yes"], answers: ["y"], files: { ...files, "/deploy/.pi-dispatch-valkey-volume.json": first.store.get("/deploy/.pi-dispatch-valkey-volume.json") } });
	assert.equal(await yes.run(), 0);
	assert.match(yes.store.get("/deploy/.pi-dispatch-valkey-volume.json"), /2026-09-01T10:00:00Z/, "never over a different record");
	assert.match(yes.text(), /names another pi-dispatch-valkey-data and is left as it is: this adoption is not recorded/);
	// A labelled volume is never recorded (its label says it).
	const labelled = harness({ plan: { ...base, "docker volume inspect": volumeRecord("/deploy") }, listening: false, argv: ["--yes"], files });
	await labelled.run();
	assert.ok(!labelled.store.has("/deploy/.pi-dispatch-valkey-volume.json"));
});

// Issue #484: the folder's deploy/egress-proxy.conf against the installed package's copy. The harness's fixtures hold
// "conf\n" and its package copy is "conf\n", so every other test is silent; these hand in a package copy that differs.
const CONF = "/deploy/deploy/egress-proxy.conf";
const NEW_RULES = "http_port 3128\nacl allowed dstdomain -n \"/etc/pi-dispatch/allowlist.conf\"\n";
const BACKUP = `${CONF}.bak-20260929T101500Z`;
const RESTART = ["restart", "pi-dispatch-egress-proxy"];
const restarts = (h) => h.calls.filter((c) => c.cmd === "docker" && c.args[0] === "restart").map((c) => c.args);

test("up offers to refresh a deploy/egress-proxy.conf that differs from the package's, and a declined offer changes nothing (#484)", async () => {
	const h = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: proxyState("running") }, listening: true, files: PROXY_FILES, argv: ["--yes"], answers: ["n"], packagedConf: NEW_RULES });
	assert.equal(await h.run(), 0);
	const text = h.text();
	// Shown: which file, a summary of how it differs, the diff that shows the rest, and the two steps a yes takes.
	assert.match(text, /⚠ deploy\/egress-proxy\.conf differs from the package's copy[^:]*: 1 line of it not in the package's copy, 2 lines of the package's not in it\. An upgrade does not rewrite it/);
	assert.match(text, /`diff deploy\/egress-proxy\.conf \S+egress-proxy\.conf` shows which/);
	assert.match(text, /up would replace it with the package's copy[^:]*, keeping yours beside it \(or pass --refresh-proxy-rules\):\n\s+cp deploy\/egress-proxy\.conf deploy\/egress-proxy\.conf\.bak-<timestamp>\n\s+write \S+ content beside deploy\/egress-proxy\.conf, then rename it over deploy\/egress-proxy\.conf\n/);
	// Asked of a person even under --yes: the file may hold the operator's own edit.
	assert.match(text, /--yes does not cover replacing a file that may hold your own edits: answer below\n/);
	assert.equal(h.promptCalls.length, 1, "the one question is the refresh; --yes answered the rest");
	// Declined: the file is byte for byte what it was, nothing else was written beside it, the proxy is left running.
	assert.equal(h.store.get(CONF), "conf\n");
	assert.deepEqual([...h.store.keys()].filter((k) => k.startsWith(`${CONF}.`) || k.includes(".egress-proxy.conf.tmp-")), []);
	assert.deepEqual(restarts(h), []);
	assert.match(text, /skipped: deploy\/egress-proxy\.conf is left as it is; `pi-dispatch up` offers this again/);
	assert.match(text, /egress rules\s+deploy\/egress-proxy\.conf differs from the package's copy[^,]*, left as it is \(declined\)/);
	assert.match(text, /✓ Egress proxy already present/);
});

test("up's accepted refresh replaces the copy through a temp file, keeps the old one, and restarts a running proxy (#484)", async () => {
	const h = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: proxyState("running"), "docker restart": 0 }, listening: true, files: PROXY_FILES, argv: ["--yes"], answers: ["y"], packagedConf: NEW_RULES });
	const renames = [];
	const rename = h.deps.fs.renameSync;
	h.deps.fs.renameSync = (from, to) => {
		renames.push([from, to]);
		rename(from, to);
	};
	assert.equal(await h.run(), 0);
	const text = h.text();
	assert.equal(h.store.get(CONF), NEW_RULES, "the package's rules, byte for byte");
	assert.equal(h.store.get(BACKUP), "conf\n", "the old copy kept, named by the injected clock");
	// Atomic: written beside it in the same directory under a temp name, then renamed over it; no temp file left.
	assert.equal(renames.length, 1, JSON.stringify(renames));
	assert.match(renames[0][0], /^\/deploy\/deploy\/\.egress-proxy\.conf\.tmp-[0-9a-f]+$/);
	assert.equal(renames[0][1], CONF);
	assert.deepEqual([...h.store.keys()].filter((k) => k.includes(".tmp-")), []);
	assert.match(text, /✓ replaced deploy\/egress-proxy\.conf with the package's copy[^;]*; yours is kept as deploy\/egress-proxy\.conf\.bak-20260929T101500Z\. squid reads it only at start/);
	// The running proxy still holds the old file, so it is restarted, shown and (no job network on it) accepted by --yes.
	assert.match(text, /up would restart it \(or pass --restart-proxy\) so squid reads the refreshed deploy\/egress-proxy\.conf:\n\s+docker restart pi-dispatch-egress-proxy\n--yes: accepted\n/);
	assert.deepEqual(restarts(h), [RESTART]);
	assert.deepEqual(dockerMutations(h), [], "restarted, never removed or recreated");
	assert.match(text, /egress rules\s+deploy\/egress-proxy\.conf replaced with the package's copy/);
	assert.match(text, /egress\s+restarted pi-dispatch-egress-proxy on the refreshed rules/);
});

test("up never restarts, under --yes, a proxy jobs are using after a refresh, and a declined restart says the old rules still run (#484)", async () => {
	const busy = proxyState("running", { networks: ["pi-dispatch-egress-out", "pi-job-abc-net"] });
	const h = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: busy }, listening: true, files: PROXY_FILES, argv: ["--yes"], answers: ["y", "n"], packagedConf: NEW_RULES });
	assert.equal(await h.run(), 0);
	const text = h.text();
	assert.equal(h.store.get(CONF), NEW_RULES);
	assert.match(text, /--yes does not cover restarting a proxy that jobs are using/);
	assert.match(text, /It is attached to pi-job-abc-net: those jobs lose their egress while it restarts/);
	assert.equal(h.promptCalls.length, 2, "the refresh, then the restart");
	assert.deepEqual(restarts(h), []);
	assert.match(text, /skipped: it runs the old rules until `docker restart pi-dispatch-egress-proxy`/);
});

test("up refuses to refresh a deploy/egress-proxy.conf that is a symlink, or one under a symlinked deploy/, and writes nothing (#484)", async () => {
	for (const link of [CONF, "/deploy/deploy"]) {
		const h = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: proxyState("running"), "docker restart": 0 }, listening: true, files: PROXY_FILES, argv: ["--yes"], answers: ["y"], packagedConf: NEW_RULES, links: new Set([link]) });
		assert.equal(await h.run(), 0);
		const text = h.text();
		assert.match(text, link === CONF ? /✗ not replaced: \/deploy\/deploy\/egress-proxy\.conf is a symlink/ : /✗ not replaced: \/deploy\/deploy is a symlink/, text);
		assert.equal(h.store.get(CONF), "conf\n");
		assert.deepEqual([...h.store.keys()].filter((k) => k.startsWith(`${CONF}.`) || k.includes(".tmp-")), [], "no backup, no temp file");
		assert.deepEqual(restarts(h), [], "nothing was refreshed, so nothing is restarted");
		assert.match(text, /egress rules\s+NOT replaced:/);
	}
});

test("up says nothing about the rules for an identical copy, a custom PI_EGRESS_PROXY or an unarmed policy (#484)", async () => {
	const same = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: proxyState("running") }, listening: true, files: PROXY_FILES, argv: ["--yes"] });
	await same.run();
	assert.doesNotMatch(same.text(), /differs from the package's copy|egress rules/);
	assert.equal(same.promptCalls.length, 0);
	for (const env of [{ PI_PROVIDER: "anthropic", PI_EGRESS_PROXY: "my-squid" }, { PI_PROVIDER: "anthropic", PI_EGRESS: "0" }]) {
		const h = harness({ env, plan: { ...green, "docker inspect": { code: 0, output: "running\n" } }, listening: true, files: PROXY_FILES, argv: ["--yes"], packagedConf: NEW_RULES });
		await h.run();
		assert.doesNotMatch(h.text(), /differs from the package's copy|egress rules/, JSON.stringify(env));
		assert.equal(h.store.get(CONF), "conf\n");
	}
});

test("up refreshes the rules before a stopped proxy is started, so the start reads the new file (#484)", async () => {
	const h = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: proxyState("exited"), "docker start pi-dispatch-egress-proxy": 0 }, listening: true, files: PROXY_FILES, argv: ["--yes"], answers: ["y"], packagedConf: NEW_RULES });
	const order = [];
	const write = h.deps.fs.renameSync;
	h.deps.fs.renameSync = (from, to) => {
		order.push("rename");
		write(from, to);
	};
	const spawn = h.deps.spawn;
	h.deps.spawn = (cmd, args, opts) => {
		if (cmd === "docker" && args[0] === "start") order.push("start");
		return spawn(cmd, args, opts);
	};
	assert.equal(await h.run(), 0);
	assert.deepEqual(order, ["rename", "start"]);
	assert.deepEqual(restarts(h), [], "a start reads the file; no restart on top");
});

test("a refreshed copy under a PAUSED proxy is unpaused and then restarted, never only unpaused on the old rules (PR #491's review)", async () => {
	const paused = proxyState("paused");
	const h = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: paused, "docker unpause": 0, "docker restart": 0 }, listening: true, files: PROXY_FILES, argv: ["--yes"], answers: ["y"], packagedConf: NEW_RULES });
	assert.equal(await h.run(), 0);
	const text = h.text();
	assert.equal(h.store.get(CONF), NEW_RULES);
	assert.match(text, /a proxy already running or paused is offered a restart below/);
	assert.match(text, /up would unpause and then restart it \(or pass --restart-proxy\) so squid reads the refreshed deploy\/egress-proxy\.conf:\n\s+docker unpause pi-dispatch-egress-proxy\n\s+docker restart pi-dispatch-egress-proxy\n--yes: accepted\n/);
	const acted = h.calls.filter((c) => c.cmd === "docker" && ["unpause", "restart", "start", "rm", "run"].includes(c.args[0])).map((c) => c.args[0]);
	assert.deepEqual(acted, ["unpause", "restart"]);
	assert.match(text, /egress\s+unpaused and restarted pi-dispatch-egress-proxy on the refreshed rules/);
	// Jobs attached: --yes does not answer, and a declined restart leaves it paused on the old rules, said.
	const busy = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: proxyState("paused", { networks: ["pi-dispatch-egress-out", "pi-job-abc-net"] }) }, listening: true, files: PROXY_FILES, argv: ["--yes"], answers: ["y", "n"], packagedConf: NEW_RULES });
	await busy.run();
	assert.match(busy.text(), /--yes does not cover restarting a proxy that jobs are using/);
	assert.ok(!busy.calls.some((c) => c.cmd === "docker" && ["unpause", "restart"].includes(c.args[0])), "nothing run on a no");
	assert.match(busy.text(), /skipped: it stays paused, and holds the old rules until `docker unpause pi-dispatch-egress-proxy && docker restart pi-dispatch-egress-proxy`/);
	// Not refreshed (identical): a paused proxy is unpaused as before, no restart.
	const plain = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: paused, "docker unpause": 0 }, listening: true, files: PROXY_FILES, argv: ["--yes"] });
	await plain.run();
	assert.deepEqual(plain.calls.filter((c) => c.cmd === "docker" && ["unpause", "restart"].includes(c.args[0])).map((c) => c.args[0]), ["unpause"]);
});

test("up's offer names a copy that differs only in its line endings as that (PR #491's review)", async () => {
	const h = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: proxyState("running") }, listening: true, files: { ...PROXY_FILES, [CONF]: "conf\r\n" }, argv: ["--yes"], answers: ["n"] });
	await h.run();
	assert.match(h.text(), /⚠ deploy\/egress-proxy\.conf differs from the package's copy[^:]*: only in its line endings, CRLF here and LF in the package's\. /);
});

// --- issue #503: the model endpoints' include, the third file the shipped proxy mounts ----------------------------------

const INCLUDE_RULES = `${NEW_RULES}include /etc/pi-dispatch/model-endpoints.conf\n`;

test("up on docker: no model-endpoints.conf in the folder means no proxy is started, since squid would not start (#503)", async () => {
	const h = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: 1 }, listening: true, files: PROXY_FILES, includeFile: false, argv: ["--yes"] });
	assert.equal(await h.run(), 0);
	assert.match(h.text(), /✗ the egress policy is on but model-endpoints\.conf is not here, so no proxy is started without it/);
	assert.deepEqual(dockerMutations(h), [], "nothing created or started");
	const real = tempDir("pi-up-503-dir-");
	realFs.mkdirSync(join(real, "deploy"), { recursive: true });
	realFs.writeFileSync(join(real, "deploy", "egress-proxy.conf"), "conf\n");
	realFs.writeFileSync(join(real, "egress-allowlist.conf"), "api.anthropic.com\n");
	realFs.mkdirSync(join(real, "model-endpoints.conf"));
	const dir = harness({ plan: { "docker version": 0, "docker image inspect": 0, [PROXY_INSPECT]: 1, "docker network create": 0, "docker run -d --name pi-dispatch-egress-proxy": 0 }, listening: true, argv: ["--yes"], cwd: real, extra: { fs: realFs, runInitFn: () => 0 } });
	await dir.run();
	assert.match(dir.text(), /✗ the egress policy is on but model-endpoints\.conf here is a directory, not a file, so no proxy is started without it/);
	assert.ok(!dir.calls.some((c) => c.args[0] === "run" && c.args.includes("pi-dispatch-egress-proxy")), "nothing started");
});

test("up on docker: a two-mount proxy is current under rules without the include, and stale under rules with it (#503)", async () => {
	const old = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: proxyState("running") }, listening: true, files: PROXY_FILES, argv: ["--yes"] });
	await old.run();
	assert.match(old.text(), /✓ Egress proxy already present/);
	const files = { ...PROXY_FILES, [CONF]: INCLUDE_RULES };
	const stale = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: proxyState("running") }, listening: true, files, argv: ["--yes"], packagedConf: INCLUDE_RULES });
	await stale.run();
	assert.match(stale.text(), /✗ pi-dispatch-egress-proxy exists \(running\) and is this deployment's proxy but out of date: nothing is mounted at \/etc\/pi-dispatch\/model-endpoints\.conf, where \/deploy\/model-endpoints\.conf belongs: this folder's rules include it, and squid will not start again without it/);
	assert.doesNotMatch(stale.text(), /not this deployment's proxy/);
	assert.deepEqual(dockerMutations(stale).at(-1), EGRESS_RUN, "replaced with the shipped three-mount proxy");
	const current = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: proxyState("running", { include: "/deploy/model-endpoints.conf" }) }, listening: true, files, argv: ["--yes"], packagedConf: INCLUDE_RULES });
	await current.run();
	assert.match(current.text(), /✓ Egress proxy already present/);
	assert.deepEqual(dockerMutations(current), []);
});

// Issue #503's governing rule, round-1 gate (A517-1): the folder's rules include model-endpoints.conf only together with
// a proxy that mounts it. The refresh and the replacement of a proxy without the third mount are one step, asked once;
// declined or blocked, nothing is written; a failed replace puts the old rules back.
const RUN_OK = { "docker network inspect pi-dispatch-egress-out": 0, "docker run -d --name pi-dispatch-egress-proxy": 0, "docker rm": 0 };

test("up on docker: refreshing to rules that include the file and replacing a two-mount proxy are ONE step, asked once, never a restart (#503)", async () => {
	const h = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: proxyState("running"), ...RUN_OK }, listening: true, files: PROXY_FILES, argv: ["--yes"], answers: ["y"], packagedConf: INCLUDE_RULES });
	assert.equal(await h.run(), 0);
	const text = h.text();
	assert.equal(h.promptCalls.length, 1, "one question for both");
	assert.match(text, /up would replace deploy\/egress-proxy\.conf with the package's copy[^\n]*and replace the proxy \(running\) with the shipped one in the same step/);
	assert.equal(h.store.get(CONF), INCLUDE_RULES);
	assert.deepEqual(restarts(h), [], "never restarted on a missing mount");
	assert.deepEqual(dockerMutations(h), [EGRESS_RM, EGRESS_RUN], "removed, then run with the third mount, once");
	assert.match(text, /✓ replaced deploy\/egress-proxy\.conf with the package's copy \([^)]*\) \(yours is kept as deploy\/egress-proxy\.conf\.bak-20260929T101500Z\) and the proxy with the shipped one/);
	// With the third mount already there, the refresh restarts it as before (#484), and is not coupled.
	const three = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: proxyState("running", { include: "/deploy/model-endpoints.conf" }), "docker restart": 0 }, listening: true, files: PROXY_FILES, argv: ["--yes"], answers: ["y"], packagedConf: INCLUDE_RULES });
	await three.run();
	assert.deepEqual(restarts(three), [RESTART]);
	assert.deepEqual(dockerMutations(three), []);
});

test("up on docker: a declined coupled refresh writes nothing and leaves the proxy; jobs attached are named and --yes does not answer (#503)", async () => {
	const busy = proxyState("running", { networks: ["pi-dispatch-egress-out", "pi-job-abc-net"] });
	const h = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: busy, ...RUN_OK }, listening: true, files: PROXY_FILES, argv: ["--yes"], answers: ["n"], packagedConf: INCLUDE_RULES });
	assert.equal(await h.run(), 0);
	assert.equal(h.promptCalls.length, 1);
	assert.match(h.text(), /It is attached to pi-job-abc-net: removing it cuts those jobs off/);
	assert.equal(h.store.get(CONF), "conf\n", "the rules are not written");
	assert.ok(![...h.store.keys()].some((k) => k.includes(".bak-")), "no backup either");
	assert.deepEqual(dockerMutations(h), []);
	assert.deepEqual(restarts(h), []);
	assert.match(h.text(), /skipped: deploy\/egress-proxy\.conf and the proxy are left as they are/);
});

test("up on docker: a coupled replace that fails puts the old rules back from the backup it wrote (#503)", async () => {
	const h = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: proxyState("exited"), "docker network inspect pi-dispatch-egress-out": 0, "docker rm": 0, "docker run -d --name pi-dispatch-egress-proxy": 1 }, listening: true, files: PROXY_FILES, argv: ["--yes"], answers: ["y"], packagedConf: INCLUDE_RULES });
	assert.equal(await h.run(), 0);
	assert.equal(h.store.get(CONF), "conf\n", "the old rules, exactly");
	assert.ok(!h.store.has(BACKUP), "the backup was moved back into place");
	assert.match(h.text(), /✗ could not start the shipped proxy; deploy\/egress-proxy\.conf is put back as it was \(from deploy\/egress-proxy\.conf\.bak-20260929T101500Z\)/);
	// The proxy step then runs on the old rules, as after a decline (round 2 of PR #517): whatever it starts reads them.
	assert.match(h.text(), /Continuing; doctor below will re-check it/);
});

test("up on docker: a coupled refresh that cannot replace the proxy here writes nothing and asks nothing (#503)", async () => {
	// No include file to mount: the shipped run could not start.
	const missing = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: proxyState("running"), ...RUN_OK }, listening: true, files: PROXY_FILES, includeFile: false, argv: ["--yes"], answers: ["y"], packagedConf: INCLUDE_RULES });
	await missing.run();
	assert.equal(missing.promptCalls.length, 0);
	assert.equal(missing.store.get(CONF), "conf\n");
	assert.match(missing.text(), /not replaced: the new rules include model-endpoints\.conf, which this proxy does not mount[^\n]*model-endpoints\.conf is not a file in this folder/);
	assert.deepEqual(dockerMutations(missing), []);
	// Mounts that cannot be compared here (Docker Desktop's VM paths): up never removes such a proxy on its mounts.
	const desktop = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: proxyState("running", { conf: "/host_mnt/deploy/deploy/egress-proxy.conf", allowlist: "/host_mnt/deploy/egress-allowlist.conf" }), ...RUN_OK }, listening: true, files: PROXY_FILES, argv: ["--yes"], answers: ["y"], packagedConf: INCLUDE_RULES });
	desktop.deps.fs.realpathSync = (p) => {
		if (p.startsWith("/host_mnt/")) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
		return p;
	};
	await desktop.run();
	assert.equal(desktop.promptCalls.length, 0);
	assert.equal(desktop.store.get(CONF), "conf\n");
	assert.match(desktop.text(), /up cannot replace the proxy here: its mounts could not be compared on this host/);
	assert.deepEqual(dockerMutations(desktop), []);
});

test("up on docker: endpoints declared under rules without the include are not drift; up names the rules refresh instead (#503)", async () => {
	const files = { ...PROXY_FILES, "/deploy/model-endpoints.json": JSON.stringify({ version: 1, endpoints: [{ id: "m", host: "host.docker.internal", port: 11434, slots: 1 }] }) };
	const h = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: proxyState("running") }, listening: true, files, argv: ["--yes"] });
	await h.run();
	assert.match(h.text(), /✓ Egress proxy already present/);
	assert.match(h.text(), /⚠ model endpoints are declared, but deploy\/egress-proxy\.conf predates #503 and does not include model-endpoints\.conf, so the endpoints stay unreachable until the rules are refreshed: `pi-dispatch up`, and accept the refresh/);
	assert.deepEqual(dockerMutations(h), [], "no replace: it would cut tunnels and fix nothing");
});

// Round 2 of PR #517: a coupled step that did not replace leaves the proxy step to do its usual work on the old rules.
test("up on docker: after a declined or blocked coupled refresh, a stopped proxy is still started and a paused one unpaused (#503)", async () => {
	for (const [status, verb] of [["exited", "start"], ["paused", "unpause"]]) {
		const declined = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: proxyState(status), [`docker ${verb}`]: 0, ...RUN_OK }, listening: true, files: PROXY_FILES, argv: ["--yes"], answers: ["n"], packagedConf: INCLUDE_RULES });
		await declined.run();
		assert.equal(declined.store.get(CONF), "conf\n", `${status}: the rules are not written`);
		assert.deepEqual(dockerMutations(declined), [[verb, "pi-dispatch-egress-proxy"]], `${status}: declined, then ${verb}ed as it is`);
		const blocked = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: proxyState(status), [`docker ${verb}`]: 0, ...RUN_OK }, listening: true, files: { ...PROXY_FILES, "/deploy/model-endpoints.json": JSON.stringify({ version: 1, endpoints: [{ id: "m", host: "host.docker.internal", port: 11434, slots: 1 }] }) }, includeFile: false, argv: ["--yes"], packagedConf: INCLUDE_RULES });
		await blocked.run();
		assert.match(blocked.text(), /To take the new rules, remove the proxy with `docker rm -f -v pi-dispatch-egress-proxy` \(fix a missing file first with `pi-dispatch init`\), then run `pi-dispatch up` again/);
		assert.equal(blocked.store.get(CONF), "conf\n");
		// The usual proxy step then runs: a missing include is said there too, and nothing is started on a missing file.
		assert.match(blocked.text(), /✗ the egress policy is on but model-endpoints\.conf is not here/);
	}
	// And the endpoints line, after a decline under a running proxy.
	const files = { ...PROXY_FILES, "/deploy/model-endpoints.json": JSON.stringify({ version: 1, endpoints: [{ id: "m", host: "host.docker.internal", port: 11434, slots: 1 }] }) };
	const named = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: proxyState("running"), ...RUN_OK }, listening: true, files, argv: ["--yes"], answers: ["n"], packagedConf: INCLUDE_RULES });
	await named.run();
	assert.match(named.text(), /⚠ model endpoints are declared, but deploy\/egress-proxy\.conf predates #503/);
	assert.match(named.text(), /model endpoints\s+unreachable: deploy\/egress-proxy\.conf predates #503/);
	assert.match(named.text(), /✓ Egress proxy already present/);
});

test("up's proxy removal takes its anonymous volumes with it (#503 review)", () => {
	assert.deepEqual(EGRESS_RM, ["rm", "-f", "-v", "pi-dispatch-egress-proxy"]);
});

test("up's closing Next: offers the console profile only where an operator token exists (#708)", async () => {
	const line = "  docker compose --env-file .env -f deploy/docker-compose.yml --profile console up -d\n      start the operator console container (open it with /dispatch console)\n";
	const without = harness({ plan: green, argv: ["--yes"] });
	await without.run();
	assert.ok(!without.text().includes("--profile console"), "no token, so serve would refuse: no line");
	const asked = [];
	const withToken = harness({ plan: green, argv: ["--yes"], extra: { consoleOperators: (dir) => (asked.push(dir), 1) } });
	await withToken.run();
	const text = withToken.text();
	assert.ok(text.includes(line), text);
	assert.ok(text.indexOf(line) > text.indexOf("Next:"), "among up's own next steps");
	assert.deepEqual(asked, ["/deploy"], "asked about this deployment's folder");
	const broken = harness({ plan: green, argv: ["--yes"], extra: { consoleOperators: () => { throw new Error("EACCES"); } } });
	await broken.run();
	assert.ok(!broken.text().includes("--profile console"), "a tokens read that fails offers nothing and stops nothing");
});

test("up's default console read: the deployment folder's tokens file, judged as serve judges it (#708)", { skip: process.platform === "win32" }, async () => {
	const dir = tempDir("pi-up-708-");
	const run = async (env = { PI_PROVIDER: "anthropic" }) => {
		// undefined puts runUp's own default back (a destructuring default applies to undefined).
		const h = harness({ plan: green, argv: ["--yes"], cwd: dir, env, extra: { consoleOperators: undefined } });
		await h.run();
		return h.text().includes("--profile console");
	};
	assert.equal(await run(), false, "no tokens file");
	addToken({ path: join(dir, "console-tokens.json"), name: "view", role: "viewer" });
	assert.equal(await run(), false, "a viewer alone cannot start the console");
	addToken({ path: join(dir, "console-tokens.json"), name: "rob", role: "operator" });
	assert.equal(await run(), true);
	// The file the CONSOLE (and its compose container) reads: this shell's export is not the deployment's.
	assert.equal(await run({ PI_PROVIDER: "anthropic", PI_CONSOLE_TOKENS_FILE: join(dir, "elsewhere.json") }), true, "this shell's PI_CONSOLE_TOKENS_FILE is not what the deployment reads");
	writeFileSync(join(dir, ".env"), "PI_CONSOLE_TOKENS_FILE=elsewhere.json\n", { mode: 0o600 });
	assert.equal(await run(), false, "the deployment .env's PI_CONSOLE_TOKENS_FILE names the file the console reads");
});

test("explicit setup grants adopt a volume and refresh/restart busy proxy without answering a terminal (#766)", async () => {
	const files = { ...PROXY_FILES, "/deploy/.env": `VALKEY_URL=redis://127.0.0.1:16496\nVALKEY_PASSWORD=${PASSWORD}\n` };
	const adoption = harness({ plan: { "docker version": 0, "docker image inspect": 0, "docker volume inspect": volumeRecord(null), "docker run": 0, "docker stop": 0, "docker rm": 0 }, listening: false, argv: ["--yes", "--adopt-volume"], files });
	assert.equal(await adoption.run(), 0);
	assert.equal(adoption.promptCalls.length, 0);
	assert.ok(adoption.calls.some((c) => c.args[0] === "run" && c.args.includes("-p")), "the actual Valkey starts after the ownership check");
	const foreign = harness({ plan: { "docker version": 0, "docker image inspect": 0, "docker volume inspect": volumeRecord("/other") }, listening: false, argv: ["--yes", "--adopt-volume"], files });
	assert.equal(await foreign.run(), 1);
	assert.ok(!foreign.calls.some((c) => c.args[0] === "run" && c.args.includes("-p")), "an explicit grant cannot override another deployment's owner");
	for (const [flags, restarted] of [[[], false], [["--refresh-proxy-rules"], false], [["--restart-proxy"], false], [["--refresh-proxy-rules", "--restart-proxy"], true]]) {
		const h = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: proxyState("running", { networks: ["pi-dispatch-egress-out", "pi-job-abc-net"] }), "docker restart": 0 }, files: PROXY_FILES, argv: ["--yes", ...flags], packagedConf: NEW_RULES });
		await h.run();
		assert.equal(restarts(h).length > 0, restarted, flags.join(" "));
		assert.equal(h.store.get(CONF) === NEW_RULES, flags.includes("--refresh-proxy-rules"));
		if (restarted) assert.equal(h.promptCalls.length, 0);
	}
});

test("up's attached-job coupled refresh needs both explicit proxy grants; either alone leaves the rules and proxy intact (#766)", async () => {
	const busy = proxyState("running", { networks: ["pi-dispatch-egress-out", "pi-job-abc-net"] });
	for (const flags of [["--refresh-proxy-rules"], ["--restart-proxy"], ["--refresh-proxy-rules", "--restart-proxy"]]) {
		const h = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: busy, ...RUN_OK }, listening: true, files: PROXY_FILES, argv: ["--yes", ...flags], answers: ["n"], packagedConf: INCLUDE_RULES });
		assert.equal(await h.run(), 0);
		const combined = flags.length === 2;
		assert.equal(h.promptCalls.length, combined ? 0 : 1, "one grant cannot answer the combined consent");
		assert.equal(h.store.get(CONF), combined ? INCLUDE_RULES : "conf\n");
		assert.deepEqual(dockerMutations(h), combined ? [EGRESS_RM, EGRESS_RUN] : []);
		assert.deepEqual(restarts(h), [], "a missing mount is replaced rather than restarted");
	}
});
