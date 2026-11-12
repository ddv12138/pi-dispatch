/** Start-only proxy planning, reusing the shipped argv and Quadlet installer; never a browser `up` pass. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { deploymentServiceEnv } from "./service-env.mjs";
import { egressArmed, egressProxyName, DEFAULT_EGRESS_PROXY } from "./egress.mjs";
import { makeDockerEndpointResolver } from "./backend-local.mjs";
import { EGRESS_PROXY_IMAGE, PROXY_STATE_FORMAT, jobNetworksOf, parseProxyState, rulesIncludeEndpoints, shippedProxyDrift } from "./egress-proxy-state.mjs";
import { readPackagedProxyConf } from "./egress-conf-copy.mjs";
import { MODEL_ENDPOINTS_INCLUDE_NAME } from "./model-endpoints.mjs";

// deploy/docker-compose.yml's `egress` profile, reproduced as one docker run (REQ-EGRESS-ALLOWLIST):
// same digest-pinned image, same three mounts, same host entry, same explicit container name, same restart
// policy, on the same upstream network. Written out here for the same reason VALKEY_RUN_ARGS is -- an operator who runs
// `up` and one who runs compose must end up with the same component, and two ways of starting one thing
// is two places for it to drift.
//
// The per-job networks are NOT here: the worker creates one per job and attaches this container to it for
// the life of that run. This is only the proxy and its way out.
export const EGRESS_NETWORK_ARGS = ["network", "create", "pi-dispatch-egress-out"];
export const EGRESS_RUN_ARGS = [
	"run",
	"-d",
	"--name",
	"pi-dispatch-egress-proxy",
	"--restart",
	"unless-stopped",
	"--network",
	"pi-dispatch-egress-out",
	// `z` for the same measured reason as the compose file's mounts (issue #355): on an SELinux-enforcing host squid
	// cannot read an unlabelled config and crash-loops; `z` (shared, never `Z`) relabels the one file so any container
	// may read it, and is a no-op where SELinux is off.
	"-v",
	"./deploy/egress-proxy.conf:/etc/squid/squid.conf:ro,z",
	"-v",
	"./egress-allowlist.conf:/etc/pi-dispatch/allowlist.conf:ro,z",
	// Issue #503: the declared model endpoints' rules, which the rules `include`. `init` scaffolds the file, and squid
	// will not start without it. `egress render` rewrites it in place and prints the reload.
	"-v",
	`./${MODEL_ENDPOINTS_INCLUDE_NAME}:/etc/pi-dispatch/model-endpoints.conf:ro,z`,
	// How the proxy reaches a model server on this host (issue #503): on Docker Engine the name does not exist without
	// it, and host-gateway is the bridge gateway. Docker Desktop resolves the name already and host-gateway there is the
	// same host address, so it is on both, as in the compose file. The PROXY only: no job gets it.
	"--add-host",
	"host.docker.internal:host-gateway",
	EGRESS_PROXY_IMAGE,
];

const digest = (value) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
export function setupCommand(bin, args, { cwd, env, timeout = 15_000 } = {}) {
	return new Promise((done) => {
		try { execFile(bin, args, { cwd, env, timeout, maxBuffer: 256 * 1024, killSignal: "SIGKILL" }, (error, stdout, stderr) => done({ code: error ? typeof error.code === "number" ? error.code : null : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") })); }
		catch { done({ code: null, stdout: "", stderr: "" }); }
	});
}
const no = (refusal) => ({ refusal });

export async function planSetupEgress(ctx) {
	const { CLI_SERVICE_KEYS } = await import("./doctor.mjs");
	// The podman venue left with the sandbox prune, and its CONTAINERS_CONF/CONTAINER_* keys with it: the proxy is
	// planned against the docker CLI's own environment alone.
	const runtimeKeys = [...new Set(CLI_SERVICE_KEYS.docker)];
	const runtime = deploymentServiceEnv({ env: ctx.env, dir: ctx.dir, keys: runtimeKeys, fs: ctx.fs, uid: ctx.uid, platform: ctx.platform });
	if (runtime.untrusted || runtime.unreadable || runtime.unread?.length || runtime.hazardSkipped?.length || runtime.disagreements?.length) return no("unsafe-deployment");
	const runtimeEnv = runtime.env;
	const run = ctx.run ?? ((bin, args) => setupCommand(bin, args, { cwd: ctx.dir, env: runtimeEnv }));
	const read = deploymentServiceEnv({ env: {}, dir: ctx.dir, keys: ["PI_BACKENDS", "PI_EGRESS", "PI_EGRESS_PROXY"], fs: ctx.fs, uid: ctx.uid, platform: ctx.platform });
	if (read.untrusted || read.unreadable || read.unread?.length || read.hazardSkipped?.length) return no("unsafe-deployment");
	const env = read.env;
	if (!egressArmed(env)) return no("egress-off");
	if (egressProxyName(env) !== DEFAULT_EGRESS_PROXY) return no("unsafe-proxy");
	const files = {};
	try {
		for (const rel of ["deploy/egress-proxy.conf", "egress-allowlist.conf", "model-endpoints.conf"]) {
			const path = join(ctx.dir, rel);
			const st = ctx.fs.lstatSync(path);
			if (!st.isFile() || st.isSymbolicLink() || st.uid !== ctx.uid || (st.mode & 0o022)) return no("unsafe-proxy");
			files[rel] = String(ctx.fs.readFileSync(path, "utf8"));
		}
	} catch { return no("unsafe-proxy"); }
	if (files["deploy/egress-proxy.conf"] !== (ctx.readPackagedConf ?? readPackagedProxyConf)()) return no("proxy-refresh-required");
	const endpoint = await (ctx.resolveEndpoint ?? makeDockerEndpointResolver({ run: (args) => run("docker", args) }))();
	if (endpoint.local !== true) return no("remote-runtime");
	const daemon = await run("docker", ["info", "--format", "{{.ID}}"]);
	if (daemon.code !== 0 || !daemon.stdout.trim()) return no("unavailable");
	const current = await run("docker", ["inspect", PROXY_STATE_FORMAT, DEFAULT_EGRESS_PROXY]);
	const state = current.code === 0 ? parseProxyState(current.stdout) : null;
	if (current.code === 0 && !state) return no("unsafe-proxy");
	if (!state && !/No such (?:object|container)/i.test(current.stderr)) return no("unavailable");
	if (state) {
		const drift = shippedProxyDrift(state, { cwd: ctx.dir, realpath: ctx.fs.realpathSync, platform: ctx.platform, rulesInclude: rulesIncludeEndpoints(files["deploy/egress-proxy.conf"]) });
		if (drift.drift.length || drift.unknown || jobNetworksOf(state).length || !["running", "exited", "created", "stopped"].includes(state.status)) return no("unsafe-proxy");
	}
	const image = await run("docker", ["image", "inspect", EGRESS_PROXY_IMAGE]);
	if (image.code !== 0) return no("unavailable");
	const network = await run("docker", ["network", "inspect", "pi-dispatch-egress-out"]);
	if (network.code !== 0 && !/No such network/i.test(network.stderr)) return no("unavailable");
	return { effects: ["start-proxy"], inputs: { runtime: digest(Object.fromEntries(runtimeKeys.map((key) => [key, runtimeEnv[key] ?? null]))), files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, digest(v)])), state, daemon: daemon.stdout.trim(), network: network.code === 0 ? digest(network.stdout) : null }, egress: { bin: "docker", run, state, networkMissing: network.code !== 0, running: state?.status === "running" } };
}

export async function applySetupEgress(plan, ctx) {
	const e = plan.egress;
	if (e.running) return { state: "unchanged", reason: "already-running", effects: [] };
	if (e.networkMissing && (await e.run("docker", EGRESS_NETWORK_ARGS)).code !== 0) return { state: "unknown", reason: "process-failed" };
	const result = await e.run("docker", e.state ? ["start", DEFAULT_EGRESS_PROXY] : EGRESS_RUN_ARGS);
	if (result.code !== 0) return { state: "partial", reason: "process-failed", effects: plan.effects };
	const read = await e.run("docker", ["inspect", PROXY_STATE_FORMAT, DEFAULT_EGRESS_PROXY]);
	return parseProxyState(read.stdout)?.status === "running" ? { state: "applied", reason: "ready", effects: plan.effects } : { state: "unknown", reason: "readback-unavailable", effects: plan.effects };
}
