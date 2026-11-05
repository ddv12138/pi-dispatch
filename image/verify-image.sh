#!/usr/bin/env sh
# Verify a job image against INT-CONTAINER-RUNTIME-CONTRACT's conformance checklist.
#
#   ./image/verify-image.sh my-python:1.2.0
#
# Runs ON THE HOST THAT HOLDS THE IMAGE, which is the only place it can run: jobs launch with
# --pull=never, so the images pi-dispatch can actually run are exactly the ones you built or pulled onto
# the worker's own machine. A CI runner elsewhere has no access to those, which is why this is a script and
# not a workflow input -- the checks have to happen where the image is.
#
# These are the CORE assertions: what ANY image must satisfy to be nameable in a trigger's `run.image`
# (INT-TRIGGERS-FILE-CONTRACT). The pi-upgrade-check workflow calls this same script against the image this
# repo builds, and then adds RUNNER assertions on top -- those pin properties of the runner THIS repo ships
# (its exact refusal strings, a path under /app) and are deliberately not part of the portable checklist.
#
# Every check below covers a failure that is SILENT or LATE. That is the whole reason the list exists: an
# image missing its guardrails, or carrying a stale pi, does not crash -- it produces jobs that look fine.
#
# Exits 0 when every check passes, 1 on the first failure. See docs/job-image.md.

set -eu

IMAGE_REF="${1:-}"
if [ -z "$IMAGE_REF" ]; then
	echo "usage: $0 <image-ref>" >&2
	echo "  e.g. $0 my-python:1.2.0" >&2
	exit 2
fi

fail() {
	echo "FAIL: $1" >&2
	exit 1
}
ok() { echo "  ok   $1"; }

echo "Verifying $IMAGE_REF against the job-image conformance checklist (docs/job-image.md)"
echo

# The image must be present locally -- the same thing the worker's pre-spend preflight checks, and for the
# same reason: with --pull=never nothing is ever fetched at job time, so an image that is not here cannot
# run. Checking it first turns "some docker error" into one clear sentence.
docker image inspect --format='{{.Id}}' "$IMAGE_REF" >/dev/null 2>&1 \
	|| fail "$IMAGE_REF is not present on this host. Build or pull it first -- jobs run with --pull=never and the worker never fetches one."
ok "image is present on this host"

# --entrypoint is required throughout: ENTRYPOINT is the runner and ignores CMD, so `docker run img pi ...`
# would silently run the runner instead of pi and the assertion would test nothing.
docker run --rm --entrypoint pi "$IMAGE_REF" -p --help >/dev/null 2>&1 \
	|| fail "pi is not on PATH, or -p is no longer a flag. The image must carry the pinned pi (CONST-PI-VERSION-PINNED); a stale or absent pi makes jobs no-ops that still report success."
ok "pi is present and -p is still a flag"

# bash, because an operator inspecting a finished container (`--entrypoint bash`) lands in a shell
# they know, and TMOUT is what closes a forgotten interactive one. An image without bash fails
# tool children that assume a POSIX shell with more than /bin/sh's builtins at exit 127.
docker run --rm --entrypoint bash "$IMAGE_REF" -c 'exit 0' >/dev/null 2>&1 \
	|| fail "bash is not present. An operator inspecting a finished run with --entrypoint bash would fail at exit 127, and TMOUT (the idle logout of a forgotten shell) is a bash feature."
ok "bash is present (an operator can open a finished container's shell)"

# A staged pi-subagents package lives outside /app and cannot resolve pi by walking its own parents.
docker run --rm --network none --entrypoint node "$IMAGE_REF" -e 'const fs = require("node:fs"); const path = require("node:path"); const p = process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT; if (typeof p !== "string" || !path.isAbsolute(p) || JSON.parse(fs.readFileSync(`${p}/package.json`)).name !== "@earendil-works/pi-coding-agent") process.exit(1);' >/dev/null 2>&1 \
	|| fail "pi-subagents cannot locate the image's pi package."
ok "pi-subagents can locate the image's pi package"

# A Java or other derived image can otherwise silently inherit a runner built before overlay propagation existed.
docker run --rm --network none --entrypoint sh "$IMAGE_REF" -c 'grep -q installDefaultModelsPath /app/image/runner/run-job.mjs && grep -q installDefaultModelsPath /app/image/runner/src/child-preload.mjs && test -f /app/image/runner/src/model-runtime-defaults.mjs' >/dev/null 2>&1 \
	|| fail "the job image does not contain the subagent model-overlay propagation. Rebuild the base image and then the derived image."
ok "the runner carries subagent model-overlay propagation"

# python3 with a stdlib that can parse JSON, for the reason image/Dockerfile gives: `glab api … | python3 -c
# 'import json,sys…'` is the shape a model writes unprompted, and a missing interpreter reads to it as "my
# command is wrong" rather than "this tool is absent", so it retries variations instead of falling back to jq.
# The probe imports json rather than printing --version: a package that answers --version and cannot decode
# the CLI's output is the failure this check exists for, and it is exactly how a trimmed python3-minimal
# behaves. Offline, like everything here.
docker run --rm --entrypoint python3 "$IMAGE_REF" -c 'import json,sys; sys.stdout.write(json.dumps(json.loads(sys.argv[1]))+"\n")' '{"a": [1]}' 2>/dev/null \
	| grep -qxF '{"a": [1]}' \
	|| fail "python3 is not present, or its stdlib cannot parse JSON. A model parses a forge CLI's output with \`python3 -c 'import json…'\` unprompted, and without it every such tool call fails before the agent falls back to jq."
ok "python3 is present and its stdlib parses JSON (the one-liner a model writes for a forge CLI's output)"

# The forge CLIs the job envelopes instruct the agent to use. Each is only meaningful for jobs on its own
# forge, but a MISSING one fails the same silent way: the agent follows an envelope naming a command that
# is not there, reports what went wrong in prose, and exits 0.
#
# The forge => CLI mapping is spelled out here because the next block checks the image's own
# `dev.pi-dispatch.forges` label against it. That label is what the worker's pre-spend preflight trusts to
# refuse a job this image cannot serve, so it has to be checked against reality rather than believed.
forge_cli() {
	case "$1" in
		github) echo gh ;;
		gitlab) echo glab ;;
		forgejo) echo tea ;;
		azure) echo az ;;
		*) echo "" ;;
	esac
}

for cli in gh glab tea; do
	docker run --rm --entrypoint "$cli" "$IMAGE_REF" --version >/dev/null 2>&1 \
		|| fail "$cli is not on PATH. A ${cli}-driven job envelope cannot publish its work, and the failure looks like a completed run."
	ok "$cli is present"
done

# THE LABEL MUST NOT LIE. The worker refuses a job pre-spend when this list excludes its forge, and admits
# it when the list includes it -- so a label naming a forge whose CLI is absent converts a loud pre-spend
# refusal into a paid container that fails at step 3. Declaring nothing is allowed (it means "no claim",
# and the preflight then admits everything); declaring something false is not.
declared=$(docker image inspect --format '{{index .Config.Labels "dev.pi-dispatch.forges"}}' "$IMAGE_REF" 2>/dev/null)
if [ -z "$declared" ] || [ "$declared" = "<no value>" ]; then
	ok "no dev.pi-dispatch.forges label -- the image makes no claim, and the preflight admits every forge"
else
	for forge in $(echo "$declared" | tr ',' ' '); do
		cli=$(forge_cli "$forge")
		[ -n "$cli" ] || fail "dev.pi-dispatch.forges names an unknown forge '$forge'"
		docker run --rm --entrypoint "$cli" "$IMAGE_REF" --version >/dev/null 2>&1 \
			|| fail "the image declares it serves '$forge' but $cli is not on PATH -- the label would turn a pre-spend refusal into a paid container that fails at step 3"
	done
	ok "dev.pi-dispatch.forges ($declared) matches the CLIs actually installed"
fi

# THE CAPABILITIES LABEL MUST NOT LIE EITHER, and this one guards a quieter failure than the forge check
# does. `replicas` (REQ-REPLICA-RUNS) tells the worker that this image's baked safety floor knows a replica
# commits to `pi/issue-<n>-r<i>`. An image whose HARD_RULES.md still hard-codes `pi/issue-<n>` would
# contradict the replica prompt from the SYSTEM side -- which the model treats as authoritative -- so both
# replicas would converge on one branch. Nothing errors: you pay for two runs and get one pull request.
#
# Its polarity is the opposite of `forges` above: declaring nothing means "no claim", and the worker then
# refuses replica jobs on this image rather than admitting them.
# The key-holder probe (issue #596's review, factored out for issue #730): runs the image's own entrypoint and
# supervisor with a stand-in runner, whose tool child finds every key holder by executable (VERIFY_HOLDER, the
# exec-only node unless given), pokes each one's inspector, then a plain node as the control. Extra docker run
# arguments (an -e) are passed through. Prints the probe line, or nothing.
# Issue #730 (review round 1, H1): every key holder must have RLIMIT_CORE 0/0, so a tool's `kill -ABRT` of it (not
# through Yama) cannot drop a core holding the exit key. Runs the image's own entrypoint and supervisor with a stand-in
# runner that prints its own and its parent's (the supervisor's) "Max core file size" from /proc/<pid>/limits. Extra
# docker run args (the -e that picks the node) pass through. Prints the probe line, or nothing.
core_limit_probe() {
	cdir=$(mktemp -d)
	cat >"$cdir/run-job.mjs" <<'CORE'
import { readFileSync } from "node:fs";
const lim = (pid) => { const l = readFileSync("/proc/" + pid + "/limits", "utf8").split("\n").find((x) => x.startsWith("Max core file size")); const m = /Max core file size\s+(\S+)\s+(\S+)/.exec(l); return m ? m[1] + " " + m[2] : "?"; };
console.log("core-limit runner=[" + lim("self") + "] supervisor=[" + lim(String(process.ppid)) + "]");
CORE
	chmod -R a+rX "$cdir"
	# --ulimit core=-1:-1 starts the container with an unlimited core limit, so only the image's own entrypoint can make
	# it 0 0 (review round 2, L3): a daemon default of 0 would otherwise pass a missing line.
	cout=$(docker run --rm --init --network none --cap-drop=ALL --security-opt no-new-privileges --ulimit core=-1:-1 "$@" \
		-v "$cdir/run-job.mjs:/app/image/runner/run-job.mjs:ro" "$IMAGE_REF" 2>&1) || true
	rm -rf "$cdir"
	echo "$cout" | grep '^core-limit ' | tail -1
}

holder_probe() {
	probe_dir=$(mktemp -d)
	cat >"$probe_dir/run-job.mjs" <<'PROBE'
import { spawn } from "node:child_process";
const tool = `
const { spawn } = require("node:child_process");
const { readdirSync, readFileSync } = require("node:fs");
const HOLDER = process.env.VERIFY_HOLDER || "/opt/pi-dispatch/runner-node";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const open = () => fetch("http://127.0.0.1:9229/json/list", { signal: AbortSignal.timeout(1000) }).then(() => true, () => false);
async function poke(pid) {
	try { process._debugProcess(pid); } catch { return "unsignalled"; }
	for (let i = 0; i < 20; i++) { await sleep(100); if (await open()) return "open"; }
	return "closed";
}
function argv0(pid) {
	try { return readFileSync("/proc/" + pid + "/cmdline", "latin1").split("\\0")[0]; } catch { return ""; }
}
(async () => {
	const holders = readdirSync("/proc").filter((p) => /^[0-9]+$/.test(p)).map(Number).filter((p) => p !== process.pid && argv0(p) === HOLDER).sort((a, b) => a - b);
	const states = [];
	for (const pid of holders) states.push(pid + ":" + await poke(pid));
	const control = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { stdio: "ignore" });
	await sleep(300);
	const c = await poke(control.pid);
	control.kill("SIGKILL");
	console.log("inspector-probe holders=" + (states.join(",") || "none") + " control=" + c);
})();
`;
// spawn, never spawnSync: a node whose main thread is blocked cannot start its inspector, so a stand-in waiting in
// spawnSync would read `closed` with or without the flag and prove nothing.
const child = spawn("node", ["-e", tool], { stdio: ["ignore", "inherit", "inherit"] });
const stop = setTimeout(() => child.kill("SIGKILL"), 30000);
child.on("exit", () => {
	clearTimeout(stop);
	process.exit(0);
});
PROBE
	chmod -R a+rX "$probe_dir"
	probe_out=$(docker run --rm --init --network none --cap-drop=ALL --security-opt no-new-privileges "$@" \
		-v "$probe_dir/run-job.mjs:/app/image/runner/run-job.mjs:ro" "$IMAGE_REF" 2>&1) || true
	rm -rf "$probe_dir"
	probe_line=$(echo "$probe_out" | grep '^inspector-probe ' | tail -1)
	echo "$probe_line"
}

any_uid=0
capabilities=$(docker image inspect --format '{{index .Config.Labels "dev.pi-dispatch.capabilities"}}' "$IMAGE_REF" 2>/dev/null)
if [ -z "$capabilities" ] || [ "$capabilities" = "<no value>" ]; then
	ok "no dev.pi-dispatch.capabilities label -- the image claims no optional feature, and the worker refuses replica jobs on it"
else
	for capability in $(echo "$capabilities" | tr ',' ' '); do
		case "$capability" in
			tokenBudget)
				docker run --rm --entrypoint grep "$IMAGE_REF" -q "PI_MAX_TOKENS" /opt/pi-dispatch/runner/usage-meter.mjs 2>/dev/null \
					|| fail "the image declares 'tokenBudget' but its baked runner never reads PI_MAX_TOKENS -- the settle-time budget would not exist"
				;;
			replicas)
				docker run --rm --entrypoint grep "$IMAGE_REF" -q "the branch your prompt names" /opt/pi-dispatch/HARD_RULES.md 2>/dev/null \
					|| fail "the image declares 'replicas' but its baked HARD_RULES.md still hard-codes a single branch name -- the system prompt would contradict the replica prompt and both replicas would push to one branch"
				;;
			commands)
				# The claim is about the RUNNER, so the evidence is the baked runner source: the reason string
				# only the command classification emits. A runner without it would run a PI_COMMAND job to
				# exit 1 no-terminal-message -- paid infra retries of a job that can never classify.
				docker run --rm --entrypoint grep "$IMAGE_REF" -q "command-completed" /app/image/runner/src/outcome.mjs 2>/dev/null \
					|| fail "the image declares 'commands' but its baked runner does not classify a headless command run -- a run.command job would be retried as infra forever"
				;;
			anyUid)
				# Issue #341. The claim is that a job run as an ARBITRARY non-root uid with HOME=/home/pi works: the id
				# took, the home is writable, and pi's agent dir and the tool caches can be created there. uid 4242 has
				# no passwd entry in any image, which is what a worker's own uid is inside one. The Chromium half of the
				# claim is checked with the render below.
				# EVERY directory under the home must be writable by that uid, not only the ones this script names: a derived
				# layer that creates ~/.cache or ~/.npm as 0755 pi leaves a dir `mkdir -p` happily "creates" and no tool can
				# write. Plus a real file write, so a home on a read-only layer cannot pass on permission bits alone.
				docker run --rm --init --cap-drop=ALL --security-opt no-new-privileges --user 4242:4242 -e HOME=/home/pi \
					--entrypoint sh "$IMAGE_REF" -c '[ "$(id -u):$(id -g)" = 4242:4242 ] || exit 1; mkdir -p "$HOME/.pi/agent" && : > "$HOME/.pi/agent/.anyuid-probe" || exit 1; d=$(find "$HOME" -xdev -type d ! -writable 2>/dev/null) && [ -z "$d" ]' >/dev/null 2>&1 \
					|| fail "the image declares 'anyUid' but /home/pi is not writable by an arbitrary uid -- a job run as the worker's own uid would lose auth.json and every tool cache"
				any_uid=1
				;;
			modelPolicy)
				# Issue #502. The claim is that a job under PI_ALLOWED_MODELS is stopped BEFORE a call to a model the list does
				# not name. Proved by running one: the default model, a list that names only another model, a fake key and no
				# network. The guard must refuse the very first call, so the runner exits 2 with reason model-not-allowed and
				# modelRefused 1, and nothing is dialled. A runner that ignored the variable would try the call and exit on the
				# network error instead; one that could not enforce the list would exit 2 with model-policy-unenforceable.
				# Both fail here.
				model_job=$(mktemp -d)
				echo "Reply with the single word ok." >"$model_job/prompt.md"
				chmod -R a+rX "$model_job"
				model_out=$(docker run --rm --network none --cap-drop=ALL --security-opt no-new-privileges -v "$model_job:/job:ro" \
					-e PI_PROVIDER=anthropic -e PI_MODEL=claude-sonnet-4-5-20250929 -e PI_MAX_TURNS=1 \
					-e ANTHROPIC_API_KEY=sk-ant-not-a-real-key -e PI_ALLOWED_MODELS=anthropic/claude-haiku-4-5-20251001 \
					"$IMAGE_REF" 2>&1) && model_code=0 || model_code=$?
				rm -rf "$model_job"
				model_exit=$(echo "$model_out" | grep '"event":"exit"' | tail -1)
				[ "$model_code" = 2 ] && echo "$model_exit" | grep -Eq '"reason":"model-not-allowed"[,}]' && echo "$model_exit" | grep -Eq '"modelRefused":1[,}]' \
					|| fail "the image declares 'modelPolicy' but a job whose PI_ALLOWED_MODELS lacks its model was not stopped before its first call (exit $model_code: $model_exit)"
				;;
			modelRoles)
				# Issue #717: execute the shipped role tool offline, including inherit and pre-spawn refusals.
				roles_job=$(mktemp -d)
				cat >"$roles_job/model-roles.json" <<'ROLES'
{"version":1,"roles":{"explorer":"test/small"},"parent":"test/parent","models":["test/parent","test/small"]}
ROLES
				cat >"$roles_job/agents.json" <<'AGENTS'
{"version":1,"agents":[{"name":"scout","description":"scout","model":"explorer","content":"find"},{"name":"inherited","description":"inherit","model":"inherit","content":"find"},{"name":"unknown-role","description":"unknown","model":"missing","content":"find"},{"name":"off-list","description":"off-list","model":"test/other","content":"find"}]}
AGENTS
				chmod -R a+rX "$roles_job"
				roles_out=$(docker run --rm --network none --cap-drop=ALL --security-opt no-new-privileges -v "$roles_job:/job:ro" \
					-e PI_MODEL_ROLES_FILE=/job/model-roles.json -e PI_AGENTS_FILE=/job/agents.json \
					--entrypoint node "$IMAGE_REF" /app/image/runner/test/fixtures/model-roles-smoke.mjs 2>&1) && roles_code=0 || roles_code=$?
				rm -rf "$roles_job"
				[ "$roles_code" = 0 ] && echo "$roles_out" | grep -q '^model role capability holds$' \
					|| fail "the image declares 'modelRoles' but its offline role tool proof failed (exit $roles_code: $roles_out)"
				;;
			subscriptionAuth)
				# Exercise the baked receipt verifier and final-shaped-payload ticket under no network.
				auth_job=$(mktemp -d)
				mkdir "$auth_job/community"
				printf '%s\n' '{"name":"@gotgenes/pi-anthropic-auth","version":"3.4.3"}' >"$auth_job/community/package.json"
				printf '%s\n' '{"version":1,"adapter":"@gotgenes/pi-anthropic-auth@3.4.3","adapterRevision":"fabricated","digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","sources":{}}' >"$auth_job/community/.dispatch-auth-adapter.json"
				chmod -R a+rX "$auth_job"
				auth_out=$(docker run --rm --network none --cap-drop=ALL --security-opt no-new-privileges -v "$auth_job:/job:ro" \
					--entrypoint node "$IMAGE_REF" /app/image/runner/test/fixtures/subscription-auth-smoke.mjs 2>&1) && auth_code=0 || auth_code=$?
				rm -rf "$auth_job"
				[ "$auth_code" = 0 ] && echo "$auth_out" | grep -q '^subscription auth capability holds$' \
					|| fail "the image declares 'subscriptionAuth' but receipt, lifetime or final-payload enforcement failed (exit $auth_code: $auth_out)"
				# A helper alone cannot prove that the ordinary loader, registry seal and credential path agree.
				node "$(dirname "$0")/../.github/scripts/subscription-auth-image.mjs" "$IMAGE_REF" \
					|| fail "the image declares 'subscriptionAuth' but a normal-entrypoint subscription binding failed its offline cost/throttle proof"
				;;
			modelFailover)
				# Issue #716. Run the actual SDK runner through its normal entrypoint, replacing only fetch with an
				# offline 429 fixture. A grep for a classifier cannot prove the signed fields reach the worker.
				failover_job=$(mktemp -d)
				echo "Reply with the single word ok." >"$failover_job/prompt.md"
				chmod -R a+rX "$failover_job"
				failover_key=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
				failover_out=$(printf '%s\n' "$failover_key" | docker run -i --rm --init --network none --cap-drop=ALL --security-opt no-new-privileges -v "$failover_job:/job:ro" \
					-e PI_PROVIDER=anthropic -e PI_MODEL=claude-sonnet-4-5-20250929 -e PI_MAX_TURNS=1 \
					-e ANTHROPIC_API_KEY=sk-ant-not-a-real-key -e PI_RETRY_MAX=1 -e PI_RETRY_BASE_MS=1 -e PI_EXIT_AUTH=stdin \
					-e PI_ALLOWED_MODELS=anthropic/claude-sonnet-4-5-20250929 \
					-e NODE_OPTIONS=--import=/app/image/runner/test/fixtures/provider-failure-fetch.mjs \
					"$IMAGE_REF" 2>&1) && failover_code=0 || failover_code=$?
				rm -rf "$failover_job"
				failover_exit=$(echo "$failover_out" | grep '"event":"exit"' | tail -1)
				[ "$failover_code" = 1 ] && echo "$failover_exit" | grep -q '"providerFailure":{"kind":"rate-limited","resetAt":[0-9]' \
					&& echo "$failover_exit" | grep -q '"toolsStarted":false' && echo "$failover_exit" | grep -q '"replaySafe":true' \
					|| fail "the image declares 'modelFailover' but an offline provider 429 did not emit rate-limit/reset/replay evidence (exit $failover_code: $failover_exit)"
				failover_mac=$(echo "$failover_exit" | sed -nE 's/.*,"auth":"([0-9a-f]{64})"\}$/\1/p')
				failover_body=$(echo "$failover_exit" | sed -E 's/,"auth":"[0-9a-f]{64}"\}$/}/')
				failover_want=$(printf '%s' "$failover_body" | openssl dgst -sha256 -hmac "$failover_key" | awk '{print $NF}')
				[ -n "$failover_mac" ] && [ "$failover_mac" = "$failover_want" ] \
					|| fail "the image declares 'modelFailover' but its provider failure evidence is not authenticated ($failover_exit)"
				;;
			mcp)
				# REQ-MCP-OPERATOR-SERVERS. The claim is that the runner reads /job/mcp.json, connects the stdio server it
				# names with only the environment it names, waits for it before the prompt, and closes it before it exits.
				# Proved by running one offline: a stub server in /job that answers the handshake and refuses it when the
				# provider's key reached it, and a fake key so the first call stops the job. The runner must log
				# mcp_servers_ready and then exit 2 with provider-auth-refused. A runner that ignored the file would exit
				# without the log line; one that leaked the key, or never connected, would exit mcp-unavailable or hang.
				mcp_job=$(mktemp -d)
				echo "Reply with the single word ok." >"$mcp_job/prompt.md"
				cat >"$mcp_job/stub.mjs" <<'STUB'
import { createInterface } from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
createInterface({ input: process.stdin }).on("line", (line) => {
	const m = JSON.parse(line);
	if (m.id === undefined) return;
	if (m.method === "initialize") {
		if (process.env.ANTHROPIC_API_KEY || process.env.STUB_TOKEN !== "named") return send({ id: m.id, error: { code: -32603, message: "env" } });
		return send({ id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "stub", version: "1" } } });
	}
	if (m.method === "tools/list") return send({ id: m.id, result: { tools: [] } });
	send({ id: m.id, error: { code: -32601, message: "no" } });
});
STUB
				cat >"$mcp_job/mcp.json" <<'DOC'
{ "version": 1, "codemodeModels": false, "servers": { "stub": { "type": "stdio", "command": "node", "args": ["/job/stub.mjs"], "env": { "STUB_TOKEN": "${STUB_TOKEN}" }, "description": "Stub" } }, "refs": { "stub": ["STUB_TOKEN"] } }
DOC
				chmod -R a+rX "$mcp_job"
				mcp_started=$(date +%s)
				mcp_out=$(docker run --rm --network none --cap-drop=ALL --security-opt no-new-privileges -v "$mcp_job:/job:ro" \
					-e PI_PROVIDER=anthropic -e PI_MODEL=claude-sonnet-4-5-20250929 -e PI_MAX_TURNS=1 \
					-e ANTHROPIC_API_KEY=sk-ant-not-a-real-key -e PI_MAX_TOKENS=1 \
					-e PI_MCP_SERVERS=stub -e STUB_TOKEN=named \
					"$IMAGE_REF" 2>&1) && mcp_code=0 || mcp_code=$?
				mcp_took=$(($(date +%s) - mcp_started))
				rm -rf "$mcp_job"
				mcp_exit=$(echo "$mcp_out" | grep '"event":"exit"' | tail -1)
				[ "$mcp_code" = 2 ] && echo "$mcp_out" | grep -q '"event":"mcp_servers_ready"' && echo "$mcp_exit" | grep -q '"reason":"provider-auth-refused"' && [ "$mcp_took" -lt 60 ] \
					|| fail "the image declares 'mcp' but a job naming a stdio server in /job/mcp.json did not connect it and stop cleanly (exit $mcp_code in ${mcp_took}s: $mcp_exit)"
				;;
			forgeMcp)
				# DES-FORGE-MCP and CONST-MERGE-NEVER-AUTOMATIC. The claim is that the image carries the forge's own servers
				# behind the wrappers the worker's `forge` entries name, runnable by the job user without the network, with
				# the tools each wrapper withholds (the forges' dedicated merge and approval tools among them) out of reach.
				# That keeps the harness from handing a job a ready made merge tool; it is not a boundary (a quick action in a
				# note, the job's CLI), and the token's role and branch protection are. Proved by running each wrapper offline
				# with a dummy token, as a job would: it must answer an MCP initialize and a tools/list in which no withheld
				# name appears and no name matching /merge|approv/i appears outside the names below (tools named for a merge
				# request that are not its dedicated merge or approval tools; some write notes, which can carry a quick
				# action, which this does not claim to stop; a new such name in a later pin is read and added here, or
				# withheld), and a tools/call of each withheld name, and of a tool the server never listed, must be refused
				# as an unknown tool (an error from the call's empty arguments does not count: it means the server ran it).
				# github-mcp-server must also print its release version (not `dev`, which a build without the release stamp
				# prints).
				docker run --rm --network none --cap-drop=ALL --security-opt no-new-privileges --entrypoint sh "$IMAGE_REF" \
					-c '[ "$(id -u)" != 0 ] && [ -x /usr/local/bin/forge-mcp-github ] && [ -x /usr/local/bin/forge-mcp-gitlab ] && [ -x /usr/local/bin/github-mcp-server ]' >/dev/null 2>&1 \
					|| fail "the image declares 'forgeMcp' but /usr/local/bin/forge-mcp-github, forge-mcp-gitlab or github-mcp-server is missing or not executable by the job user"
				forge_gh=$(docker run --rm --network none --cap-drop=ALL --security-opt no-new-privileges --entrypoint /usr/local/bin/github-mcp-server "$IMAGE_REF" --version 2>&1) \
					&& echo "$forge_gh" | grep -Eqx 'Version: [0-9]+\.[0-9]+\.[0-9]+' \
					|| fail "the image declares 'forgeMcp' but github-mcp-server does not print a release version offline ($forge_gh)"
				forge_dir=$(mktemp -d)
				cat >"$forge_dir/probe.mjs" <<'PROBE'
import { spawn } from "node:child_process";
const [command, withheldList, allowedList] = process.argv.slice(2);
const withheld = withheldList.split(",");
const allowed = new Set(allowedList.split(",").filter(Boolean));
const child = spawn(command, [], { stdio: ["pipe", "pipe", "ignore"], env: { PATH: process.env.PATH, HOME: "/tmp", GITHUB_PERSONAL_ACCESS_TOKEN: "ghp-not-a-real-token", GITHUB_TOOLSETS: "default", GITHUB_LOCKDOWN_MODE: "1", GITHUB_EXCLUDE_TOOLS: "", GITLAB_PERSONAL_ACCESS_TOKEN: "glpat-not-a-real-token", GITLAB_API_URL: "https://gitlab.invalid/api/v4", GITLAB_DISABLE_VERSION_CHECK: "true", GITLAB_TOOL_POLICY_HIDDEN: "" } });
const send = (m) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
const done = (problem) => { console.log(problem ?? "ok"); child.kill(); process.exit(problem ? 1 : 0); };
setTimeout(() => done("no answer within 60 seconds"), 60_000);
const calls = [...withheld, "execute_graphql", "never_listed_tool"];
const answers = new Map();
let buffer = "";
child.stdout.on("data", (chunk) => {
	buffer += chunk;
	let at;
	while ((at = buffer.indexOf("\n")) >= 0) {
		const message = JSON.parse(buffer.slice(0, at));
		buffer = buffer.slice(at + 1);
		if (message.id === 1) { send({ method: "notifications/initialized" }); send({ id: 2, method: "tools/list" }); }
		if (message.id === 2) {
			const names = message.result.tools.map((tool) => tool.name);
			const seen = names.filter((name) => withheld.includes(name) || (/merge|approv/i.test(name) && !allowed.has(name)));
			if (seen.length > 0) return done(`it lists ${seen.join(", ")}`);
			calls.forEach((name, i) => send({ id: 10 + i, method: "tools/call", params: { name, arguments: {} } }));
		}
		if (message.id >= 10) {
			answers.set(message.id, message);
			// Refused as unknown, not failed: a server that runs the call fails it too, on its empty arguments.
			if (!/unknown tool/i.test(message.error?.message ?? "")) return done(`a call of ${calls[message.id - 10]} was not refused as unknown`);
			if (answers.size === calls.length) return done();
		}
	}
});
send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "verify", version: "1" } } });
PROBE
				chmod -R a+rX "$forge_dir"
				forge_out=$(docker run --rm --network none --cap-drop=ALL --security-opt no-new-privileges -v "$forge_dir:/probe:ro" --entrypoint /usr/local/bin/node "$IMAGE_REF" \
					/probe/probe.mjs /usr/local/bin/forge-mcp-github merge_pull_request,pull_request_review_write,assign_copilot_to_issue,request_copilot_review "" 2>&1) && forge_gh_code=0 || forge_gh_code=$?
				forge_gh_out=$forge_out
				forge_out=$(docker run --rm --network none --cap-drop=ALL --security-opt no-new-privileges -v "$forge_dir:/probe:ro" --entrypoint /usr/local/bin/node "$IMAGE_REF" \
					/probe/probe.mjs /usr/local/bin/forge-mcp-gitlab merge_merge_request,approve_merge_request,unapprove_merge_request,approve_deployment,discover_tools,execute_graphql \
					get_merge_request_approval_state,get_merge_request_conflicts,list_merge_request_pipelines,create_merge_request,get_merge_request,get_merge_request_diffs,list_merge_request_changed_files,list_merge_request_diffs,get_merge_request_file_diff,list_merge_request_versions,get_merge_request_version,update_merge_request,create_merge_request_thread,resolve_merge_request_thread,get_merge_request_discussion,delete_merge_request_discussion_note,update_merge_request_discussion_note,create_merge_request_discussion_note,create_merge_request_note,delete_merge_request_note,get_merge_request_note,get_merge_request_notes,update_merge_request_note,list_merge_request_emoji_reactions,list_merge_request_note_emoji_reactions,create_merge_request_emoji_reaction,delete_merge_request_emoji_reaction,create_merge_request_note_emoji_reaction,delete_merge_request_note_emoji_reaction,list_merge_requests,list_group_merge_requests 2>&1) && forge_gl_code=0 || forge_gl_code=$?
				rm -rf "$forge_dir"
				[ "$forge_gh_code" = 0 ] || fail "the image declares 'forgeMcp' but forge-mcp-github does not withhold its merge and approval tools offline ($forge_gh_out)"
				[ "$forge_gl_code" = 0 ] || fail "the image declares 'forgeMcp' but forge-mcp-gitlab does not withhold its merge and approval tools offline ($forge_out)"
				;;
			exitAuth)
				# Issue #545. Two claims, both checked by running them. First, the runner signs its exit line with the key the
				# worker writes to its stdin: the same offline job shape as the other proofs (a fake key stops it at the
				# first call), handed a
				# key the way run-container.mjs hands one (-i, PI_EXIT_AUTH=stdin), must end on a line whose HMAC-SHA256 under
				# that key is right. Second, the runner runs under the exec-only node, so a child of it (a job's tool) cannot
				# read its /proc entries, where the key lives in memory: a plain node runner's were readable on Docker Desktop.
				auth_job=$(mktemp -d)
				echo "Reply with the single word ok." >"$auth_job/prompt.md"
				chmod -R a+rX "$auth_job"
				auth_key=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
				auth_out=$(printf '%s\n' "$auth_key" | docker run -i --rm --init --network none --cap-drop=ALL --security-opt no-new-privileges -v "$auth_job:/job:ro" \
					-e PI_PROVIDER=anthropic -e PI_MODEL=claude-sonnet-4-5-20250929 -e PI_MAX_TURNS=1 \
					-e ANTHROPIC_API_KEY=sk-ant-not-a-real-key -e PI_MAX_TOKENS=1 -e PI_EXIT_AUTH=stdin \
					"$IMAGE_REF" 2>&1) || true
				rm -rf "$auth_job"
				auth_exit=$(echo "$auth_out" | grep '"event":"exit"' | tail -1)
				auth_mac=$(echo "$auth_exit" | sed -nE 's/.*,"auth":"([0-9a-f]{64})"\}$/\1/p')
				auth_body=$(echo "$auth_exit" | sed -E 's/,"auth":"[0-9a-f]{64}"\}$/}/')
				auth_want=$(printf '%s' "$auth_body" | openssl dgst -sha256 -hmac "$auth_key" | awk '{print $NF}')
				[ -n "$auth_mac" ] && [ "$auth_mac" = "$auth_want" ] \
					|| fail "the image declares 'exitAuth' but a job handed a key on stdin did not end on an exit line signed with it ($auth_exit)"
				docker run --rm --init --cap-drop=ALL --security-opt no-new-privileges --entrypoint grep "$IMAGE_REF" -q '^"") node=/opt/pi-dispatch/runner-node ;;$' /entrypoint.sh 2>/dev/null \
					|| fail "the image declares 'exitAuth' but its entrypoint does not run the runner under /opt/pi-dispatch/runner-node by default"
				docker run --rm --init --cap-drop=ALL --security-opt no-new-privileges --entrypoint /opt/pi-dispatch/runner-node "$IMAGE_REF" \
					-e 'const r = require("node:child_process").spawnSync("sh", ["-c", "cat /proc/$PPID/environ"], { stdio: "ignore" }); process.exit(r.status === 0 ? 1 : 0)' >/dev/null 2>&1 \
					|| fail "the image declares 'exitAuth' but a child of /opt/pi-dispatch/runner-node can read its /proc entries -- the job's tools could read the exit line's key out of the runner"
				# Issue #596's review found a second way in, open since #545: a tool (same uid) sends SIGUSR1, or calls
				# process._debugProcess(pid), and a node process holding the key opens its inspector on 127.0.0.1:9229 (the
				# loopback exists under --network none), where a heap snapshot carries the key. The exec-only node does not
				# close that. So every key holder must start with --disable-sigusr1: the supervisor (the entrypoint's node) and
				# the runner (started by the supervisor). Proved by running the image's own entrypoint and supervisor with a
				# stand-in runner script mounted over run-job.mjs: it runs under whatever node flags the supervisor gives the
				# real one, and starts a tool child (plain node) that finds every key holder BY ITS EXECUTABLE, every process
				# whose /proc/<pid>/cmdline names /opt/pi-dispatch/runner-node as argv[0] (cmdline stays readable for a
				# process that is not dumpable), pokes each, then pokes a plain node of its own as the control, which must
				# OPEN (else the probe proves nothing on this host). By executable, never by name or by parent (review round
				# 2): the first probe took the stand-in's parent as the supervisor only when its argv held "supervise", so an
				# entrypoint that ran a renamed copy, or a runner started through a shell that did not exec (its parent then a sh),
				# read `absent` and passed with the supervisor's inspector open. At least TWO holders must answer (the
				# supervisor and the runner), every one `closed`. The tool runs on plain node, so it is never one of them. Once
				# one process opens, the port stays taken and every later poke reads `open` too: any `open` fails, and the
				# FIRST names it.
				probe_line=$(holder_probe)
				echo "$probe_line" | grep -Eq '^inspector-probe holders=[0-9]+:closed(,[0-9]+:closed)+ control=open$' \
					|| fail "the image declares 'exitAuth' but a tool's SIGUSR1 opens the Node inspector of a process holding the exit line's key, fewer than two key holders run under /opt/pi-dispatch/runner-node, or the probe could not run (${probe_line:-no probe line}): run the supervisor and the runner under /opt/pi-dispatch/runner-node, both with --disable-sigusr1"
				# Issue #730 (review round 1, H1): the key holders must not be core-dumpable on the default path either, so
				# one entrypoint keeps the one guarantee everywhere.
				def_core=$(core_limit_probe)
				[ "$def_core" = "core-limit runner=[0 0] supervisor=[0 0]" ] \
					|| fail "the image declares 'exitAuth' but a key holder can be core-dumped: its RLIMIT_CORE is not 0/0 (${def_core:-no probe line}); set ulimit -c 0 in the entrypoint"
				;;
			excludeTools)
				# Same evidence style as 'commands': the baked runner config must actually read the variable.
				# A runner that does not would run a "read-only" trigger's job with every tool it says to
				# remove and record a clean exit -- a permission quietly not enforced.
				docker run --rm --entrypoint grep "$IMAGE_REF" -q "PI_EXCLUDE_TOOLS" /app/image/runner/src/config.mjs 2>/dev/null \
					|| fail "the image declares 'excludeTools' but its baked runner never reads PI_EXCLUDE_TOOLS -- a read-only trigger would run with every tool the file says to remove"
				;;
			awaitInput)
				# Same evidence style as 'excludeTools': the baked runner must read the variable and carry the tool.
				# A runner that does not would never offer the job the tool a parked run ends on.
				docker run --rm --entrypoint grep "$IMAGE_REF" -q "PI_AWAIT_INPUT" /app/image/runner/src/config.mjs 2>/dev/null \
					&& docker run --rm --entrypoint grep "$IMAGE_REF" -q "await_human_input" /app/image/runner/src/await-input.mjs 2>/dev/null \
					|| fail "the image declares 'awaitInput' but its baked runner never reads PI_AWAIT_INPUT or carries the await_human_input tool"
				;;
			approvalGates)
				docker run --rm --entrypoint grep "$IMAGE_REF" -q "PI_APPROVAL_GATES" /app/image/runner/src/request-approval.mjs 2>/dev/null \
					&& docker run --rm --entrypoint grep "$IMAGE_REF" -q "appendContextEdit" /app/image/runner/src/request-approval.mjs 2>/dev/null \
					&& docker run --rm --entrypoint grep "$IMAGE_REF" -q "applyApprovalDecision" /app/image/runner/run-job.mjs 2>/dev/null \
					|| fail "the image declares approvalGates but lacks its tool or decision replay"
				;;
			reportProgress)
				# Same evidence style as 'awaitInput': the baked runner must read the variable and carry the tool.
				docker run --rm --entrypoint grep "$IMAGE_REF" -q "PI_REPORT_PROGRESS" /app/image/runner/src/config.mjs 2>/dev/null \
					&& docker run --rm --entrypoint grep "$IMAGE_REF" -q "report_progress" /app/image/runner/src/report-progress.mjs 2>/dev/null \
					|| fail "the image declares 'reportProgress' but its baked runner never reads PI_REPORT_PROGRESS or carries the report_progress tool"
				;;
			recover)
				# Same evidence style as 'reportProgress': the baked runner must read both variables and carry the module
				# that answers the interrupted calls. A runner that does not would resume a crashed run into pi's
				# "No result provided" and let the model repeat a push or a comment that may already have happened.
				docker run --rm --entrypoint grep "$IMAGE_REF" -q "PI_RECOVERING" /app/image/runner/src/config.mjs 2>/dev/null \
					&& docker run --rm --entrypoint grep "$IMAGE_REF" -q "toolExecution = \"sequential\"" /app/image/runner/run-job.mjs 2>/dev/null \
					&& docker run --rm --entrypoint grep "$IMAGE_REF" -q "recoverSession" /app/image/runner/src/recover.mjs 2>/dev/null \
					|| fail "the image declares 'recover' but its baked runner never reads PI_RECOVERING, never runs its tools one at a time, or carries no recovery module"
				;;
			fork)
				# Execute the baked module against a real pinned SessionManager, on an offline container with no key.
				# This proves a branch is persisted at the worker-observed filename and the source remains unchanged.
				docker run --rm --network none --cap-drop=ALL --security-opt no-new-privileges -w /app --entrypoint node "$IMAGE_REF" --input-type=module -e '
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { openForkSessionManager, assertThinkingLevel } from "/app/image/runner/src/fork.mjs";
import { parseForkEnv } from "/app/image/runner/src/config.mjs";
const cwd = "/tmp/fork-contract";
mkdirSync(cwd);
const file = `${cwd}/current.jsonl`;
writeFileSync(file, "");
const manager = SessionManager.open(file, cwd, cwd);
const first = manager.appendMessage({ role: "user", content: "keep", timestamp: 1 });
const second = manager.appendMessage({ role: "user", content: "discard", timestamp: 2 });
const source = `${cwd}/source.jsonl`;
copyFileSync(file, source);
const original = readFileSync(source, "utf8");
const cfg = parseForkEnv({ PI_SESSION_FILE: file, PI_FORK_ENTRY: second, PI_FORK_POSITION: "before", PI_THINKING_LEVEL: "off" });
const fork = openForkSessionManager({ sessionFile: file, cwd, fork: cfg.fork });
assert.equal(fork.sessionManager.getSessionFile(), file);
assert.equal(fork.sessionManager.getEntry(second), undefined);
assert.equal(fork.sessionManager.getEntry(first).message.content, "keep");
assert.equal(SessionManager.open(file, cwd, cwd).buildSessionContext().messages.length, 1);
assert.equal(readFileSync(source, "utf8"), original);
assertThinkingLevel({ reasoning: false }, "off");
assert.throws(() => assertThinkingLevel({ reasoning: false }, "high"));
' >/dev/null 2>&1 || fail "the image declares fork but its baked runner cannot isolate and persist a selected transcript branch"
				;;
			steer)
				# Same evidence style as 'recover': the baked runner must read the variable and carry the inbox module.
				docker run --rm --entrypoint grep "$IMAGE_REF" -q "PI_STEER" /app/image/runner/src/config.mjs 2>/dev/null \
					&& docker run --rm --entrypoint grep "$IMAGE_REF" -q "pi-dispatch-inbox" /app/image/runner/src/inbox.mjs 2>/dev/null \
					|| fail "the image declares 'steer' but its baked runner never reads PI_STEER or carries the inbox module"
				# And the mount the worker gives it: /inbox read-only, so the agent cannot plant a message in its own inbox or
				# withdraw one. The /job:ro check's shape below: an every-uid fixture, a control write without :ro that must
				# succeed (else EACCES would pass the check having tested nothing), a read through :ro, then the refused write.
				inbox_dir=$(mktemp -d)
				echo '{}' >"$inbox_dir/000001-00000000000000000000000000000001.json"
				chmod 0777 "$inbox_dir"
				chmod 0666 "$inbox_dir/000001-00000000000000000000000000000001.json"
				docker run --rm --cap-drop=ALL -v "$inbox_dir:/inbox" --entrypoint sh "$IMAGE_REF" -c 'echo control > /inbox/control' 2>/dev/null \
					|| { rm -rf "$inbox_dir"; fail "the control write to a writable /inbox failed, so the :ro check would prove nothing -- check that this host can bind-mount $inbox_dir"; }
				docker run --rm --cap-drop=ALL -v "$inbox_dir:/inbox:ro" --entrypoint sh "$IMAGE_REF" -c 'ls /inbox/000001-00000000000000000000000000000001.json' >/dev/null 2>&1 \
					|| { rm -rf "$inbox_dir"; fail "/inbox:ro could not even be listed, so the write refusal would prove nothing"; }
				# Judged on the host, by what changed in the directory, not by the shell's exit status.
				docker run --rm --cap-drop=ALL -v "$inbox_dir:/inbox:ro" --entrypoint sh "$IMAGE_REF" \
					-c 'echo planted > /inbox/000002-00000000000000000000000000000002.json; rm -f /inbox/000001-00000000000000000000000000000001.json' >/dev/null 2>&1 || true
				if [ -e "$inbox_dir/000002-00000000000000000000000000000002.json" ] || [ ! -e "$inbox_dir/000001-00000000000000000000000000000001.json" ]; then
					rm -rf "$inbox_dir"
					fail "/inbox is writable from inside. The agent could plant or withdraw a message in its own inbox."
				fi
				rm -rf "$inbox_dir"
				;;
			answerDraft)
				# Invalid profile input must refuse before extension discovery or a provider request.
				ad_dir=$(mktemp -d)
				mkdir -p "$ad_dir/job" "$ad_dir/ws/.pi/extensions"
				printf '' >"$ad_dir/job/prompt.md"
				printf '{"version":1,"source":{"questionCommentId":"https://attacker.invalid/"}}' >"$ad_dir/job/answer-draft.json"
				echo 'console.log("ANSWER-DRAFT-EXTENSION-EXECUTED"); export default function () {}' >"$ad_dir/ws/.pi/extensions/index.js"
				chmod -R a+rX "$ad_dir"
				ad_out=$(docker run --rm --init --network none --cap-drop=ALL --security-opt no-new-privileges \
					-v "$ad_dir/job:/job:ro" -v "$ad_dir/ws:/workspace:ro" --workdir /workspace \
					-e PI_PROVIDER=anthropic -e PI_MODEL=claude-sonnet-4-5-20250929 -e PI_MAX_TURNS=1 \
					-e ANTHROPIC_API_KEY=sk-ant-not-a-real-key -e PI_MAX_TOKENS=1 "$IMAGE_REF" 2>&1) && ad_code=0 || ad_code=$?
				rm -rf "$ad_dir"
				[ "$ad_code" = 2 ] && echo "$ad_out" | grep -q '"reason":"answer-draft-refused"' \
					&& ! echo "$ad_out" | grep -q 'ANSWER-DRAFT-EXTENSION-EXECUTED' \
					|| fail "the image declares answerDraft but invalid inputs did not refuse before executable discovery"
				;;
			packageCanary)
				# Issue #796. The claim is that the runner says whether a canary's candidate really loaded, since a failed load only logs and the job carries on. Proved
				# through the real runner with fixture packages at a cap of 0 and no network, so nothing can spend: one that loads, one that throws at import, one that
				# holds nothing, and a job that is not a canary, which must say nothing at all.
				pc_dir=$(mktemp -d)
				mkdir -p "$pc_dir/job/canary/good--1.0.0--aaaaaaaa" "$pc_dir/job/canary/bad--1.0.0--bbbbbbbb" "$pc_dir/job/canary/empty--1.0.0--cccccccc"
				echo "Reply with the single word ok." >"$pc_dir/job/prompt.md"
				echo '{"name":"good","version":"1.0.0","pi":{"extensions":["index.js"]}}' >"$pc_dir/job/canary/good--1.0.0--aaaaaaaa/package.json"
				echo 'export default function () {}' >"$pc_dir/job/canary/good--1.0.0--aaaaaaaa/index.js"
				echo '{"name":"bad","version":"1.0.0","pi":{"extensions":["index.js"]}}' >"$pc_dir/job/canary/bad--1.0.0--bbbbbbbb/package.json"
				echo 'throw new Error("this candidate does not load");' >"$pc_dir/job/canary/bad--1.0.0--bbbbbbbb/index.js"
				echo '{"name":"empty","version":"1.0.0","pi":{"extensions":[]}}' >"$pc_dir/job/canary/empty--1.0.0--cccccccc/package.json"
				chmod -R a+rX "$pc_dir"
				pc_run() {
					docker run --rm --network none --cap-drop=ALL --security-opt no-new-privileges -v "$pc_dir/job:/job:ro" \
						-e PI_PROVIDER=anthropic -e PI_MODEL=claude-sonnet-4-5-20250929 -e PI_MAX_TURNS=1 \
						-e ANTHROPIC_API_KEY=sk-ant-not-a-real-key -e PI_MAX_TOKENS=1 "$@" "$IMAGE_REF" 2>&1 | grep '"event":"exit"' | tail -1
				}
				pc_as() { pc_run -e "PI_PACKAGES=/job/canary/$1" -e "PI_PACKAGE_CANARY=/job/canary/$1"; }
				pc_good=$(pc_as good--1.0.0--aaaaaaaa)
				pc_bad=$(pc_as bad--1.0.0--bbbbbbbb)
				pc_empty=$(pc_as empty--1.0.0--cccccccc)
				pc_plain=$(pc_run -e "PI_PACKAGES=/job/canary/good--1.0.0--aaaaaaaa")
				rm -rf "$pc_dir"
				echo "$pc_good" | grep -q '"canaryLoad":"loaded"' \
					|| fail "the image declares packageCanary but a candidate that loads was not reported as loaded: $pc_good"
				echo "$pc_bad" | grep -q '"canaryLoad":"failed"' \
					|| fail "the image declares packageCanary but a candidate that throws at import was not reported as failed: $pc_bad"
				echo "$pc_empty" | grep -q '"canaryLoad":"failed"' \
					|| fail "the image declares packageCanary but a candidate that contributed nothing was not reported as failed: $pc_empty"
				[ -n "$pc_plain" ] && ! echo "$pc_plain" | grep -q canaryLoad \
					|| fail "the image reports a canary on a job that is not one: $pc_plain"
				;;
			questionGrouping)
				# The dedicated classifier mode must be handled before any executable discovery.
				# A token cap, a fake key and no network make this a real runner proof that cannot spend provider tokens.
				qg_dir=$(mktemp -d)
				mkdir -p "$qg_dir/job" "$qg_dir/ws/.pi/extensions" "$qg_dir/outbox"
				printf '' >"$qg_dir/job/prompt.md"
				cat >"$qg_dir/job/question-grouping.json" <<'QUESTIONGROUP'
{"version":1,"model":{"provider":"openrouter","id":"typesafe/jev-1.13"},"source":"Which test command should I use?","candidates":[],"confidence":0.9}
QUESTIONGROUP
				echo 'console.log("QUESTION-GROUP-EXTENSION-EXECUTED"); export default function () { throw new Error("must not load"); }' >"$qg_dir/ws/.pi/extensions/index.js"
				chmod -R a+rX "$qg_dir/job" "$qg_dir/ws"
				chmod a+rwx "$qg_dir" "$qg_dir/outbox"
				qg_key=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
				qg_out=$(printf '%s\n' "$qg_key" | docker run -i --rm --init --network none --cap-drop=ALL --security-opt no-new-privileges \
					-v "$qg_dir/job:/job:ro" -v "$qg_dir/ws:/workspace:ro" -v "$qg_dir/outbox:/outbox" --workdir /workspace \
					-e PI_PROVIDER=anthropic -e PI_MODEL=claude-sonnet-4-5-20250929 -e PI_MAX_TURNS=1 \
					-e ANTHROPIC_API_KEY=sk-ant-not-a-real-key -e OPENROUTER_API_KEY=not-a-real-key -e PI_MAX_TOKENS=1 -e PI_EXIT_AUTH=stdin \
					"$IMAGE_REF" 2>&1) && qg_code=0 || qg_code=$?
				qg_exit=$(echo "$qg_out" | grep '"event":"exit"' | tail -1)
				qg_mac=$(echo "$qg_exit" | sed -nE 's/.*,"auth":"([0-9a-f]{64})"\}$/\1/p')
				qg_body=$(echo "$qg_exit" | sed -E 's/,"auth":"[0-9a-f]{64}"\}$/}/')
				qg_want=$(printf '%s' "$qg_body" | openssl dgst -sha256 -hmac "$qg_key" | awk '{print $NF}')
				qg_written=no
				[ ! -f "$qg_dir/outbox/question-group.json" ] || qg_written=yes
				rm -rf "$qg_dir"
				[ "$qg_code" = 2 ] && [ -n "$qg_mac" ] && [ "$qg_mac" = "$qg_want" ] \
					&& echo "$qg_exit" | grep -q '"reason":"provider-auth-refused"' \
					&& echo "$qg_exit" | grep -Eq '"toolsStarted":0[,}]' \
					&& ! echo "$qg_out" | grep -q 'QUESTION-GROUP-EXTENSION-EXECUTED' \
					&& [ "$qg_written" = no ] \
					|| fail "the image declares questionGrouping but its signed classifier probe loaded an extension, called a tool or emitted a group"
				;;
			watch)
				# Watch evidence has no human author: executable resources must never run, even at import.
				# The token cap, the fake key and --network none make both probes deterministic and provider-free.
				watch_dir=$(mktemp -d)
				mkdir -p "$watch_dir/job" "$watch_dir/ws/.pi/extensions" "$watch_dir/outbox"
				echo 'Investigate the finding using read-only tools.' >"$watch_dir/job/prompt.md"
				echo '{"version":1,"mode":"investigate"}' >"$watch_dir/job/watch.json"
				echo 'console.log("WATCH-EXTENSION-EXECUTED"); export default function () {}' >"$watch_dir/ws/.pi/extensions/index.js"
				chmod -R a+rX "$watch_dir/job" "$watch_dir/ws"
				chmod a+rwx "$watch_dir" "$watch_dir/outbox"
				watch_out=$(docker run --rm --init --network none --cap-drop=ALL --security-opt no-new-privileges \
					-v "$watch_dir/job:/job:ro" -v "$watch_dir/ws:/workspace:ro" -v "$watch_dir/outbox:/outbox" --workdir /workspace \
					-e PI_PROVIDER=anthropic -e PI_MODEL=claude-sonnet-4-5-20250929 -e PI_MAX_TURNS=1 \
					-e ANTHROPIC_API_KEY=sk-ant-not-a-real-key -e PI_MAX_TOKENS=1 -e PI_EXCLUDE_TOOLS=bash,edit,write,powershell \
					"$IMAGE_REF" 2>&1) && watch_code=0 || watch_code=$?
				watch_exit=$(echo "$watch_out" | grep '"event":"exit"' | tail -1)
				watch_active=$(echo "$watch_out" | grep '"event":"tools_excluded"' | tail -1)
				if [ "$watch_code" != 2 ] || ! echo "$watch_exit" | grep -q '"reason":"provider-auth-refused"' || echo "$watch_out" | grep -q 'WATCH-EXTENSION-EXECUTED' || ! echo "$watch_active" | grep -q '"active":\["read","grep","find","ls","board_write"\]'; then
					rm -rf "$watch_dir"
					fail "the image declares watch but executable discovery or its read-only tool registry failed the provider-free probe"
				fi
				cat >"$watch_dir/job/watch-decision.json" <<'WATCHDECIDE'
{"version":1,"model":{"provider":"openrouter","id":"typesafe/jev-1.13"},"state":{"count":37},"questions":{"act":{"type":"choice","criteria":{"ignore":"noise","file_issue":"a person should decide"}}}}
WATCHDECIDE
				chmod a+r "$watch_dir/job/watch-decision.json"
				watch_key=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
				watch_gate=$(printf '%s\n' "$watch_key" | docker run -i --rm --init --network none --cap-drop=ALL --security-opt no-new-privileges \
					-v "$watch_dir/job:/job:ro" -v "$watch_dir/ws:/workspace:ro" -v "$watch_dir/outbox:/outbox" --workdir /workspace \
					-e PI_PROVIDER=anthropic -e PI_MODEL=claude-sonnet-4-5-20250929 -e PI_MAX_TURNS=1 \
					-e ANTHROPIC_API_KEY=sk-ant-not-a-real-key -e OPENROUTER_API_KEY=not-a-real-key -e PI_MAX_TOKENS=1 -e PI_EXIT_AUTH=stdin \
					"$IMAGE_REF" 2>&1) && watch_gate_code=0 || watch_gate_code=$?
				watch_gate_exit=$(echo "$watch_gate" | grep '"event":"exit"' | tail -1)
				watch_mac=$(echo "$watch_gate_exit" | sed -nE 's/.*,"auth":"([0-9a-f]{64})"\}$/\1/p')
				watch_body=$(echo "$watch_gate_exit" | sed -E 's/,"auth":"[0-9a-f]{64}"\}$/}/')
				watch_want=$(printf '%s' "$watch_body" | openssl dgst -sha256 -hmac "$watch_key" | awk '{print $NF}')
				watch_decision=$(cat "$watch_dir/outbox/decision.json" 2>/dev/null || true)
				rm -rf "$watch_dir"
				[ "$watch_gate_code" = 2 ] && [ -n "$watch_mac" ] && [ "$watch_mac" = "$watch_want" ] && echo "$watch_gate_exit" | grep -q '"reason":"provider-auth-refused"' && [ -z "$watch_decision" ] \
					|| fail "the image declares watch but its deterministic classifier ran a model call the fake key could not answer, or wrote a decision it did not decide"
				;;
			*) fail "dev.pi-dispatch.capabilities names an unknown capability '$capability'" ;;
		esac
	done
	ok "dev.pi-dispatch.capabilities ($capabilities) matches what the image actually bakes"
fi
if [ "$any_uid" != 1 ]; then
	# Said out loud for the same reason as the playwright skip below: a check that silently does not apply reads
	# like one that passed.
	echo "  note no 'anyUid' capability -- on a daemon that enforces bind-mount ownership (native Linux Docker), a"
	echo "       job on this image can only run as the image's own user (issue #341)."
fi

# --cap-drop=ALL is CONST-ISOLATION-CONTAINER-PER-JOB's enforcement surface. Read the effective capability
# set directly rather than install libcap just to ask.
caps=$(docker run --rm --cap-drop=ALL --security-opt no-new-privileges \
	--entrypoint sh "$IMAGE_REF" -c 'grep ^CapEff /proc/self/status' | awk '{print $2}')
[ "$caps" = "0000000000000000" ] || fail "container retains capabilities under --cap-drop=ALL: $caps"
ok "no capabilities under --cap-drop=ALL (CapEff=$caps)"

uid=$(docker run --rm --entrypoint id "$IMAGE_REF" -u)
[ "$uid" != "0" ] || fail "the image runs as root. Jobs must run non-root."
ok "runs as a non-root user (uid $uid)"

# /job:ro is what makes CONST-ISSUE-TEXT-IS-DATA enforceable by filesystem permission rather than by asking
# nicely, so assert the kernel enforces it rather than trusting the flag.
#
# The fixture is opened to every uid first, and a control write WITHOUT :ro must succeed. Without both, a host
# whose uid is not the image's (native Linux, issue #341) refuses the write with EACCES before :ro is ever
# consulted, and the check passes having tested nothing.
fixture=$(mktemp -d)
mkdir -p "$fixture/pi"
echo "x" >"$fixture/pi/APPEND_SYSTEM.md"
chmod 0777 "$fixture" "$fixture/pi"
chmod 0666 "$fixture/pi/APPEND_SYSTEM.md"
if ! docker run --rm --cap-drop=ALL -v "$fixture:/job" --entrypoint sh "$IMAGE_REF" \
	-c 'echo control >> /job/pi/APPEND_SYSTEM.md' 2>/dev/null; then
	rm -rf "$fixture"
	fail "the control write to a writable /job failed, so the :ro check below would prove nothing -- check that this host can bind-mount $fixture"
fi
docker run --rm --cap-drop=ALL -v "$fixture:/job:ro" --entrypoint sh "$IMAGE_REF" -c 'cat /job/pi/APPEND_SYSTEM.md' >/dev/null 2>&1 \
	|| { rm -rf "$fixture"; fail "/job:ro could not even be read, so the write refusal below would prove nothing"; }
if docker run --rm --cap-drop=ALL -v "$fixture:/job:ro" --entrypoint sh "$IMAGE_REF" \
	-c 'echo pwned > /job/pi/APPEND_SYSTEM.md' 2>/dev/null; then
	rm -rf "$fixture"
	fail "/job is writable from inside. The agent can rewrite its own instructions."
fi
rm -rf "$fixture"
ok "/job:ro is enforced by the kernel (a writable control mount accepted the same write)"

# pi lazily creates ~/.pi/agent and writes auth.json on the FIRST credential operation. It swallows a failure to
# do so, so a root-owned dir does not stop the job: playwright, npm or gh fail later instead, on a path nothing in
# a Dockerfile hints at, and the runner logs agent_dir_not_writable (issue #341).
docker run --rm --entrypoint sh "$IMAGE_REF" -c 'touch "$HOME/.pi/agent/auth.json" && rm "$HOME/.pi/agent/auth.json"' >/dev/null 2>&1 \
	|| fail "\$HOME/.pi/agent is not writable by the runtime user. pi skips auth.json silently and the tools fail later."
ok "the agent dir is writable by the runtime user"

# An agent that can rewrite its own safety floor has none, and an absent floor raises no error at all.
docker run --rm --entrypoint grep "$IMAGE_REF" -q "pi-dispatch-guardrails-v1" /opt/pi-dispatch/HARD_RULES.md 2>/dev/null \
	|| fail "the guardrails sentinel is missing from /opt/pi-dispatch/HARD_RULES.md -- the runner reads its safety floor from there."
ok "guardrails are baked where the runner reads them"

# The two gated personas (issue #505): the loader composes each only when its mount or file is there, and reads it from
# here. A missing file is no error, just a prompt without the protocol, so the image check is what notices.
docker run --rm --entrypoint grep "$IMAGE_REF" -q "pi-dispatch-outbox-v1" /opt/pi-dispatch/OUTBOX_PROTOCOL.md 2>/dev/null \
	|| fail "the outbox sentinel is missing from /opt/pi-dispatch/OUTBOX_PROTOCOL.md -- a local job would run without the outbox protocol."
docker run --rm --entrypoint grep "$IMAGE_REF" -q "pi-dispatch-portfolio-v1" /opt/pi-dispatch/PORTFOLIO_PROTOCOL.md 2>/dev/null \
	|| fail "the portfolio sentinel is missing from /opt/pi-dispatch/PORTFOLIO_PROTOCOL.md -- a portfolio job would run without the plan protocol."
ok "the outbox and portfolio protocols are baked where the runner reads them"

# Root-owned and NOT writable by the runtime user, or the floor is advisory.
if docker run --rm --entrypoint sh "$IMAGE_REF" -c 'echo x >> /opt/pi-dispatch/HARD_RULES.md' 2>/dev/null; then
	fail "the runtime user can WRITE /opt/pi-dispatch/HARD_RULES.md. A safety floor the agent can edit is not a floor."
fi
ok "guardrails are not writable by the runtime user"

# The frontend half. Both are only meaningful for flows that do visual work, but neither failure announces
# itself: a fontless Chromium renders tofu, and screenshots look plausible while containing no legible text.
if docker run --rm --entrypoint sh "$IMAGE_REF" -c 'command -v playwright-cli' >/dev/null 2>&1; then
	# $@ are extra `docker run` flags: none for the image's own user, a uid and HOME for the anyUid claim.
	render_check() {
		docker run --rm --init --cap-drop=ALL --security-opt no-new-privileges --shm-size=1g "$@" \
			-e PAGE='<html><body style="background:#f00"><h1 style="color:#fff">RENDER-CHECK-MARKER</h1></body></html>' \
			--entrypoint sh "$IMAGE_REF" -c \
			'node -e "require(\"http\").createServer((_,r)=>{r.writeHead(200,{\"content-type\":\"text/html\"});r.end(process.env.PAGE)}).listen(8099)" & sleep 1;
			 playwright-cli open http://localhost:8099 >/dev/null 2>&1;
			 playwright-cli snapshot 2>&1 | grep -q RENDER-CHECK-MARKER || exit 1;
			 playwright-cli screenshot --filename /tmp/s.png >/dev/null 2>&1;
			 test -s /tmp/s.png' >/dev/null 2>&1
	}
	render_check \
		|| fail "Chromium did not render a real page. Check PLAYWRIGHT_BROWSERS_PATH (set at BOTH build and run), PLAYWRIGHT_MCP_BROWSER, PLAYWRIGHT_MCP_SANDBOX, and fonts."
	ok "Chromium renders a real page as non-root"
	if [ "$any_uid" = 1 ]; then
		# Measured (issue #341): the image before that change rendered as pi and failed under --user 4242:4242,
		# with or without HOME.
		render_check --user 4242:4242 -e HOME=/home/pi \
			|| fail "the image declares 'anyUid' but Chromium does not render as an arbitrary uid with HOME=/home/pi"
		ok "Chromium renders a real page as an arbitrary non-root uid (anyUid)"
	fi

	n=$(docker run --rm --entrypoint sh "$IMAGE_REF" -c 'fc-list | wc -l')
	[ "$n" -gt 0 ] || fail "no fonts installed. Chromium renders tofu boxes: screenshots look plausible and contain no legible text."
	ok "fonts are installed ($n)"
else
	# Not a failure: an image for a non-visual flow has no reason to carry Chromium. Said out loud, because
	# a silently skipped check reads exactly like a passing one.
	echo "  skip playwright-cli is not in this image -- the Chromium and font checks do not apply."
	echo "       Flows that build or screenshot a frontend will NOT work in it (REQ-FRONTEND-VISUAL-VERIFY)."
fi

echo
echo "PASS: $IMAGE_REF satisfies the CORE conformance checklist."
echo
echo "What this did NOT check, and nothing in this project can: that the pi version inside matches the pin,"
echo "that the entrypoint honours the exit-code protocol on every path, or that the loader flags carry the"
echo "posture you expect. Those are yours (docs/job-image.md, OQ-012)."
