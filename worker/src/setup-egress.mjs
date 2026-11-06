/** Start-only proxy planning, reusing the shipped argv and Quadlet installer; never a browser `up` pass. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deploymentServiceEnv } from "./service-env.mjs";
import { egressArmed, egressProxyName, DEFAULT_EGRESS_PROXY } from "./egress.mjs";
import { makeDockerEndpointResolver } from "./backend-local.mjs";
import { EGRESS_NETWORK_ARGS, EGRESS_RUN_ARGS } from "./up.mjs";
import { EGRESS_PROXY_IMAGE, PROXY_STATE_FORMAT, jobNetworksOf, parseProxyState, rulesIncludeEndpoints, shippedProxyDrift } from "./egress-proxy-state.mjs";
import { readPackagedProxyConf } from "./egress-conf-copy.mjs";

const digest = (value) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const templatesDir = fileURLToPath(new URL("../deploy/", import.meta.url));
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
