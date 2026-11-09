import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { LAYOUT } from "../src/layout.mjs";

/**
 * The container's file layout is one closed table of paths (INT-CONTAINER-JOB-INPUTS). Issue #683's second layout for
 * venues that COPY their files, and the `PI_JOB_LAYOUT` variable that chose between the two, went when those venues
 * did, so the table now holds exactly the paths every runner has always used. These pin the table and that every
 * module reading a path follows it.
 */

test("the layout is exactly the paths every runner has always used", () => {
	assert.deepEqual(LAYOUT, { job: "/job", workspace: "/workspace", session: "/session", outbox: "/outbox", inbox: "/inbox", global: "/opt/pi-global" });
	// The session must never sit inside the worktree the agent commits from (parseSessionFile).
	assert.ok(!LAYOUT.session.startsWith(`${LAYOUT.workspace}/`));
});

test("every module that names a container path follows the layout table", () => {
	// A child process, because the paths are read once at import.
	const src = fileURLToPath(new URL("../src/", import.meta.url));
	const script = `
		const packages = await import(${JSON.stringify(`${src}packages.mjs`)});
		const inbox = await import(${JSON.stringify(`${src}inbox.mjs`)});
		const config = await import(${JSON.stringify(`${src}config.mjs`)});
		const loader = await import(${JSON.stringify(`${src}loader.mjs`)});
		const mcp = await import(${JSON.stringify(`${src}mcp.mjs`)});
		console.log(JSON.stringify({ skills: packages.PROTECTED_SKILL_ROOTS, outbox: loader.OUTBOX_MOUNT, inbox: inbox.INBOX_DIR, home: config.HOME_FORBIDDEN_ROOTS,
			loader: [loader.OUTBOX_MOUNT, loader.JOB_PI_DIR, loader.TRIGGER_SKILLS_DIR, loader.GLOBAL_PI_DIR, loader.WORKSPACE], mcp: mcp.JOB_MCP_PATH }));
	`;
	const read = () => JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { env: process.env, encoding: "utf8" }));
	assert.deepEqual(read(), {
		skills: ["/job/pi/skills", "/job/trigger-skills", "/opt/pi-global/skills"],
		outbox: "/outbox",
		inbox: "/inbox",
		home: ["/workspace", "/job", "/outbox", "/session"],
		loader: ["/outbox", "/job/pi", "/job/trigger-skills", "/opt/pi-global", "/workspace"],
		mcp: "/job/mcp.json",
	});
});

test("no runner source spells a container path as a literal outside layout.mjs", () => {
	// The bolt behind the probe above: a module the probe does not import (run-job.mjs needs pi and a container) could
	// slip back to "/job" and stay green. Code only, comments stripped, so the prose that explains a path stays free.
	const root = fileURLToPath(new URL("../", import.meta.url));
	const files = ["run-job.mjs", ...readdirSync(join(root, "src")).filter((f) => f.endsWith(".mjs") && f !== "layout.mjs").map((f) => `src/${f}`)];
	const literal = /["'`](?:\/job|\/workspace|\/session|\/outbox|\/inbox|\/opt\/pi-global)(?:[/"'`$])/;
	const offenders = [];
	for (const file of files) {
		const code = readFileSync(join(root, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
		for (const [i, line] of code.split("\n").entries()) if (literal.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
	}
	assert.deepEqual(offenders, [], "read the path from LAYOUT (layout.mjs) instead");
});
