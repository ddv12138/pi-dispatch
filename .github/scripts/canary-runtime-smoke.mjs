// The real CLI, a real Valkey and a real job image. A weekly token window smaller than the canary's per-job
// token cap refuses the reservation BEFORE a container starts (DES-TOKEN-RESERVE-AND-SETTLE).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { builtinChatModels } from "../../worker/src/model-catalog.mjs";
import { makeRedisClient } from "../../worker/src/connection.mjs";
import { CANARY_LOCK_KEY } from "../../worker/src/canary-lock.mjs";
// The pinned Valkey, which the workflow pulls by the same constant first: `--pull=never` below finds only that image.
import { VALKEY_IMAGE } from "../../worker/src/valkey-auth.mjs";

const exec = promisify(execFile);
const image = process.argv[2];
assert.ok(image, "usage: node .github/scripts/canary-runtime-smoke.mjs <job-image>");
const root = mkdtempSync(join(tmpdir(), "pi-canary-runtime-"));
const valkey = `pi-dispatch-canary-valkey-${randomUUID().slice(0, 12)}`;
const docker = (args) => exec("docker", args, { timeout: 60_000, maxBuffer: 1024 * 1024 });
let redis;
try {
	// The replay source is curated by hand under the job history's own canary-sources/ (canary-runtime.mjs): one folder
	// per source job id, its manifest naming the workspace the flow replays from.
	const workspace = join(root, "original"), source = join(root, "jobs", "canary-sources", "original-run"), logs = join(root, "logs"), jobs = join(root, "jobs");
	mkdirSync(workspace); mkdirSync(source, { recursive: true }); mkdirSync(logs);
	const env = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
	const git = async (args) => (await exec("git", args, { env })).stdout.trim();
	await git(["init", "--template=", workspace]);
	mkdirSync(join(workspace, ".pi", "skills", "smoke"), { recursive: true });
	writeFileSync(join(workspace, ".pi", "skills", "smoke", "SKILL.md"), "---\nname: smoke\ndescription: Canary zero-spend fixture\n---\nRead the repository.\n");
	writeFileSync(join(workspace, "fixture"), "base\n");
	await git(["-C", workspace, "add", "."]);
	await git(["-C", workspace, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture"]);
	const baseSha = await git(["-C", workspace, "rev-parse", "HEAD"]);
	writeFileSync(join(workspace, "fixture"), "original edits must survive\n");
	const model = "claude-sonnet-4-5-20250929";
	assert.ok(builtinChatModels("anthropic").some((m) => m.id === model), "the same pinned model fixture as image/verify-image.sh exists");
	const candidate = `anthropic/${model}`;
	const instant = Date.now();
	const original = { jobId: "original-run", kind: "local", modelRole: "editor", flow: "smoke", provider: "anthropic", model, outcome: "completed", endedAt: new Date(instant - 1000).toISOString(), session: { resumed: false, reason: "disabled", bytes: null } };
	writeFileSync(join(logs, "original-run.json"), JSON.stringify(original));
	writeFileSync(join(source, "manifest.json"), JSON.stringify({ jobId: original.jobId, backend: "local", baseSha, workspace }));
	writeFileSync(join(source, "prompt.md"), "Run the smoke flow on this disposable fixture.\n");
	writeFileSync(join(source, "event.json"), "{\"source\":\"manual\"}");
	writeFileSync(join(source, "model-roles.json"), JSON.stringify({ version: 1, roles: { editor: candidate } }));
	writeFileSync(join(root, "triggers.json"), JSON.stringify({ triggers: [], modelRoles: { default: { editor: candidate } } }));
	await docker(["run", "--pull=never", "--rm", "-d", "--name", valkey, "-p", "127.0.0.1::6379", VALKEY_IMAGE]);
	const port = JSON.parse((await docker(["inspect", "--format", "{{json .NetworkSettings.Ports}}", valkey])).stdout)["6379/tcp"][0].HostPort;
	const url = `redis://127.0.0.1:${port}/0`;
	const cli = resolve("worker/src/cli.mjs");
	const commandEnv = { PATH: process.env.PATH, HOME: root, DOCKER_CONFIG: process.env.DOCKER_CONFIG ?? join(process.env.HOME, ".docker"), ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}), VALKEY_URL: url, PI_LOGS_DIR: logs, PI_JOBS_DIR: jobs, PI_TRIGGERS_FILE: join(root, "triggers.json"), PI_SETTINGS_FILE: join(root, "settings.json"), PI_JOB_IMAGE: image, PI_MAX_TOKENS: "2", PI_WEEKLY_TOKEN_CAP: "1", PI_AUTH_FROM_PI: "0", ANTHROPIC_API_KEY: "zero-spend-fixture-key", GITHUB_TOKEN: "must-not-reach-job" };
	let result;
	try { result = await exec(process.execPath, [cli, "canary", "--role", "editor", "--model", candidate, "--flow", "smoke", "--cap-tokens", "2", "--count", "1", "--json"], { cwd: root, env: commandEnv, timeout: 120_000, maxBuffer: 1024 * 1024 }); }
	catch (error) { assert.equal(error.code, 2, error.stderr); result = error; }
	const report = JSON.parse(result.stdout);
	assert.equal(report.rows[0].candidate.outcome, "policy");
	const record = JSON.parse(readFileSync(join(logs, `${report.rows[0].jobId}.json`), "utf8"));
	assert.equal(record.reason, "token-cap");
	assert.equal(record.tokens, null);
	assert.equal(record.tokensWindows.reservedTokens, 2);
	assert.equal(record.tokensWindows.settledTokens, 0);
	assert.equal(record.tokensWindows.basis, "refunded");
	assert.equal(record.canary.sourceJobId, original.jobId);
	assert.deepEqual(JSON.parse(readFileSync(join(logs, "original-run.json"), "utf8")), original);
	assert.equal(readFileSync(join(workspace, "fixture"), "utf8"), "original edits must survive\n");
	// The replay job's own directory is gone; the curated source stays, it is the operator's.
	assert.deepEqual(readdirSync(jobs), ["canary-sources"]);
	redis = makeRedisClient(url, { failFast: true, lazyConnect: true }); redis.on("error", () => {}); await redis.connect();
	assert.equal(await redis.get(CANARY_LOCK_KEY), null);
	assert.ok((await redis.keys("budget:tok:*")).length > 0, "deployment token ledgers were used");
	assert.equal((await redis.keys("budget:usd:*")).length, 0, "no dollar ledger is written any more");
	assert.equal((await docker(["ps", "-aq", "--filter", `name=^/${report.rows[0].jobId}$`])).stdout.trim(), "");
	assert.equal((await docker(["ps", "-aq", "--filter", "name=^/pi-dispatch-canary-.*-proxy$"])).stdout.trim(), "");
	process.stdout.write("OK: actual canary CLI restored a base, staged roles, reserved token ledgers, refused the reservation before any container, retained lineage and originals, and cleaned the lease and resources\n");
} finally {
	redis?.disconnect();
	await docker(["rm", "-f", valkey]).catch(() => {});
	rmSync(root, { recursive: true, force: true });
}
