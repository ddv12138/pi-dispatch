import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { tempDir } from "./helpers/temp-dir.mjs";
import { DISCARDING_MODELS_STORE, installDefaultModelsPath } from "../src/model-runtime.mjs";

test("independent runtimes resolve the overlay, preserving explicit paths and stores", async () => {
	const dir = tempDir("model-overlay-");
	const path = join(dir, "models.json");
	writeFileSync(path, JSON.stringify({ providers: { testoverlay: { baseUrl: "https://example.invalid", apiKey: "TEST_OVERLAY_KEY", api: "openai-completions", models: [{ id: "example", name: "Example", reasoning: false, input: ["text"], cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10000, maxTokens: 1000 }] } } }));
	const hook = installDefaultModelsPath(ModelRuntime, path);
	try {
		const overlay = await ModelRuntime.create({ modelsStore: DISCARDING_MODELS_STORE, allowModelNetwork: false });
		assert.ok(overlay.getModel("testoverlay", "example"));
		const explicitNone = await ModelRuntime.create({ modelsPath: null, modelsStore: DISCARDING_MODELS_STORE, allowModelNetwork: false });
		assert.equal(explicitNone.getModel("testoverlay", "example"), undefined);
	} finally { hook.uninstall(); }
});

test("default injection does not replace caller-selected stores", async () => {
	class Fake { static async create(options) { return options; } }
	const hook = installDefaultModelsPath(Fake, "/overlay/models.json");
	try {
		assert.equal((await Fake.create()).modelsStore, DISCARDING_MODELS_STORE);
		assert.equal((await Fake.create({ modelsStorePath: "/elsewhere" })).modelsStore, undefined);
		assert.equal((await Fake.create({ modelsPath: null })).modelsPath, null);
	} finally { hook.uninstall(); }
});
