import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { tempDir } from "./helpers/temp-dir.mjs";

let packageRoot;
let piRoot;
try {
	packageRoot = dirname(fileURLToPath(import.meta.resolve("pi-subagents")));
	piRoot = dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
} catch {}
const required = process.env.PI_DISPATCH_REQUIRE_LOADER_TESTS === "1";
if (required && (!packageRoot || !piRoot)) throw new Error("pi-subagents and pinned pi are required for the real subagent integration test");
const skip = packageRoot && piRoot ? false : "install the test dependencies to exercise the real subagent factory";

test("pi-subagents 0.73.1 SDK child reads the job overlay and is metered", { skip }, () => {
	assert.equal(JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version, "0.73.1");
	const root = tempDir("pi-subagents-real-");
	const ledger = join(root, "ledger");
	mkdirSync(ledger);
	chmodSync(ledger, 0o700);
	const models = join(root, "models.json");
	const provider = join(root, "provider.ts");
	const preload = join(root, "preload.mjs");
	const script = join(root, "child.mjs");
	writeFileSync(models, JSON.stringify({ providers: { fake: { apiKey: "fake", baseUrl: "http://127.0.0.1:1", api: "openai-completions", models: [{ id: "m1", name: "m1", reasoning: false, input: ["text"], cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 }] } } }));
	// The extension supplies only the in-memory stream. Its model must come from the overlay.
	writeFileSync(provider, `import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
export default function(pi) { pi.registerProvider("fake", {api:"openai-completions",streamSimple(model) {const stream=createAssistantMessageEventStream();queueMicrotask(()=>stream.push({type:"done",reason:"stop",message:{role:"assistant",content:[{type:"text",text:"ok"}],api:model.api,provider:model.provider,model:model.id,usage:{input:500,output:277,cacheRead:0,cacheWrite:0,totalTokens:777,cost:{input:0.0005,output:0.000277,cacheRead:0,cacheWrite:0,total:0.000777}},stopReason:"stop",timestamp:Date.now()}}));return stream;}}); }
`);
	const preloadUrl = new URL("../src/child-preload.mjs", import.meta.url).href;
	// The injection is a test seam for the fixed container path. The production hook still installs the meter.
	writeFileSync(preload, `const ledger=process.env.PI_DISPATCH_CHILD_LEDGER; delete process.env.PI_DISPATCH_CHILD_LEDGER; const {preload}=await import(${JSON.stringify(preloadUrl)}); process.env.PI_DISPATCH_CHILD_LEDGER=ledger; await preload({globalModelsPath:${JSON.stringify(models)}});\n`);
	const factoryUrl = pathToFileURL(join(packageRoot, "src/runs/shared/child-session.js")).href;
	writeFileSync(script, `import {createDefaultChildSessionFactory} from ${JSON.stringify(factoryUrl)};
const f=createDefaultChildSessionFactory();
try { const s=await f.create({cwd:${JSON.stringify(root)},model:"fake/m1",ambientExtensions:false,noSkills:true,noContextFiles:true,extensionPaths:[${JSON.stringify(provider)}],hooks:[],storage:{kind:"memory"}}); await s.prompt("hello"); console.log(JSON.stringify({model:s.modelId,answer:s.messages.at(-1)?.content?.[0]?.text,stop:s.messages.at(-1)?.stopReason})); await s.dispose(); } finally { await f.dispose(); }
`);
	const env = { PATH: process.env.PATH, HOME: root, TMPDIR: root, PI_CODING_AGENT_DIR: join(root, "agent"), PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT: piRoot, PI_OFFLINE: "1" };
	const run = (extra) => spawnSync(process.execPath, [script], { cwd: root, env: { ...env, ...extra }, encoding: "utf8", timeout: 30000 });
	const control = run({});
	assert.notEqual(control.status, 0);
	assert.match(control.stderr, /Model "fake\/m1" not found/);
	const result = run({ NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`, PI_DISPATCH_CHILD_LEDGER: ledger, PI_ALLOWED_MODELS: "fake/m1" });
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout.trim()), { model: "fake/m1", answer: "ok", stop: "stop" });
	const files = readdirSync(ledger).filter((name) => name.endsWith(".json"));
	assert.equal(files.length, 1);
	const record = JSON.parse(readFileSync(join(ledger, files[0]), "utf8"));
	assert.equal(record.metered, true);
	assert.equal(record.totals.calls, 1);
	assert.equal(record.totals.total, 777);
});
