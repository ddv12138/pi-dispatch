import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { MAVEN_SETTINGS_PATH, installMavenSettings, mavenSettingsFromEnv, renderMavenSettingsXml } from "../src/maven-settings.mjs";

const RUNNER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

function tempHome() {
	return mkdtempSync(join(tmpdir(), "pi-maven-settings-"));
}

// The settings the 253 deployment forwards (docs/253-deployment.md): the mirror is the maven-proxy by
// docker DNS name, the proxy is the squid beside it, and MAVEN_PROXY_NONPROXY is deliberately absent --
// the proxy itself must ride squid, there is no direct route to bypass.
const DEPLOYMENT_ENV = { MAVEN_MIRROR_URL: "http://pi-dispatch-maven-proxy", MAVEN_PROXY_HOST: "pi-dispatch-egress-proxy", MAVEN_PROXY_PORT: "3128" };

test("with neither trigger variable set, nothing is written and the home is not even created", () => {
	for (const env of [{}, { MAVEN_MIRROR_URL: "" }, { MAVEN_PROXY_HOST: "" }, { MAVEN_PROXY_PORT: "3128", MAVEN_PROXY_NONPROXY: "localhost" }]) {
		const home = tempHome();
		try {
			assert.equal(installMavenSettings({ env, home }), null, `wrote something for ${JSON.stringify(env)}`);
			assert.deepEqual(readdirSync(home), [], `touched the home for ${JSON.stringify(env)}`);
			assert.deepEqual(mavenSettingsFromEnv(env), null);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	}
});

test("the deployment's settings render the exact XML shape, mirror first then https/http proxies", () => {
	assert.equal(
		renderMavenSettingsXml({ mirrorUrl: "http://pi-dispatch-maven-proxy", proxyHost: "pi-dispatch-egress-proxy", proxyPort: "3128", nonProxyHosts: "" }),
		[
			'<settings xmlns="http://maven.apache.org/SETTINGS/1.0.0">',
			"  <mirrors><mirror>",
			"    <id>pi-dispatch-mirror</id><name>pi-dispatch mirror</name><mirrorOf>*</mirrorOf>",
			"    <url>http://pi-dispatch-maven-proxy</url>",
			"  </mirror></mirrors>",
			"  <proxies>",
			"  <proxy><id>pi-dispatch-https</id><active>true</active><protocol>https</protocol>",
			"    <host>pi-dispatch-egress-proxy</host><port>3128</port>",
			"    <nonProxyHosts></nonProxyHosts>",
			"  </proxy>",
			"  <proxy><id>pi-dispatch-http</id><active>true</active><protocol>http</protocol>",
			"    <host>pi-dispatch-egress-proxy</host><port>3128</port>",
			"    <nonProxyHosts></nonProxyHosts>",
			"  </proxy>",
			"  </proxies>",
			"</settings>",
			"",
		].join("\n"),
	);
});

test("each block appears only when its own variable is set, never the other's", () => {
	const mirrorOnly = renderMavenSettingsXml({ mirrorUrl: "https://maven.example.com/repository/public" });
	assert.match(mirrorOnly, /<mirrors><mirror>/);
	assert.doesNotMatch(mirrorOnly, /<proxies>/);
	const proxyOnly = renderMavenSettingsXml({ proxyHost: "172.17.0.1", proxyPort: "3128", nonProxyHosts: "localhost|127.0.0.1" });
	assert.match(proxyOnly, /<proxies>/);
	assert.match(proxyOnly, /<nonProxyHosts>localhost\|127\.0\.0\.1<\/nonProxyHosts>/);
	assert.doesNotMatch(proxyOnly, /<mirrors>/);
});

test("install writes 0644 ~/.m2/settings.xml under the given home and returns the path", () => {
	const home = tempHome();
	try {
		const installed = installMavenSettings({ env: DEPLOYMENT_ENV, home });
		assert.equal(installed.path, join(home, MAVEN_SETTINGS_PATH));
		const written = readFileSync(installed.path, "utf8");
		assert.equal(written, installed.xml, "the returned xml is what landed on disk");
		assert.equal(written.endsWith("</settings>\n"), true, "one trailing newline, like the template's last echo");
		if (process.platform !== "win32") assert.equal(statSync(installed.path).mode & 0o777, 0o644, "0644, like the template's chmod");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("HOME is honoured and .m2 is created when missing (mkdir -p semantics)", () => {
	const home = tempHome();
	try {
		const installed = installMavenSettings({ env: { ...DEPLOYMENT_ENV, HOME: home } });
		assert.equal(installed.path, join(home, MAVEN_SETTINGS_PATH));
		assert.ok(existsSync(installed.path));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("a port that is not a port number is a config error, not a broken file", () => {
	for (const port of ["abc", "0", "70000", "31.28", ""]) {
		// empty means UNSET, which takes the 3128 default -- the refusal is only for a set-but-bad value.
		const env = port === "" ? { ...DEPLOYMENT_ENV, MAVEN_PROXY_PORT: "" } : { MAVEN_PROXY_HOST: "p", MAVEN_PROXY_PORT: port };
		if (port === "") {
			assert.equal(mavenSettingsFromEnv(env).proxyPort, "3128", "empty falls back to the Dockerfile's 3128 default");
			continue;
		}
		assert.throws(() => mavenSettingsFromEnv(env), (error) => error.piDispatchExit === 2 && /MAVEN_PROXY_PORT/.test(error.message), `accepted ${JSON.stringify(port)}`);
	}
});

test("a mirror URL that is not an http(s) URL is a config error", () => {
	assert.throws(() => mavenSettingsFromEnv({ MAVEN_MIRROR_URL: "ftp://x/y" }), (error) => error.piDispatchExit === 2 && /http or https/.test(error.message));
	assert.throws(() => mavenSettingsFromEnv({ MAVEN_MIRROR_URL: "not a url" }), (error) => error.piDispatchExit === 2);
});

test("a home that cannot take the file fails loudly, naming the path (never a silent skip)", () => {
	// A REGULAR FILE in the home slot: recursive mkdir must stop at it with ENOTDIR for any uid, root
	// included, so the refusal is deterministic on every host the suite runs on.
	const home = tempHome();
	const fileHome = join(home, "not-a-dir");
	try {
		writeFileSync(fileHome, "a file, not a directory\n");
		assert.throws(() => installMavenSettings({ env: DEPLOYMENT_ENV, home: fileHome }), (error) => error.piDispatchExit === 2 && /cannot write Maven settings/.test(error.message));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("read-only home directory fails with the same config error (the operator-owned home case)", () => {
	if (process.getuid?.() === 0) return; // root laughs at 0500; the file-home case above covers the path
	const home = tempHome();
	chmodSync(home, 0o500);
	try {
		assert.throws(() => installMavenSettings({ env: DEPLOYMENT_ENV, home }), (error) => error.piDispatchExit === 2 && /cannot write Maven settings/.test(error.message));
	} finally {
		chmodSync(home, 0o700);
		rmSync(home, { recursive: true, force: true });
	}
});

test("run-job.mjs installs the settings after the offline/telemetry enforcement and before any spend", () => {
	const src = readFileSync(join(RUNNER_DIR, "run-job.mjs"), "utf8");
	const call = src.indexOf("\tconst mavenSettings = installMavenSettings();");
	assert.ok(call > 0, "run-job.mjs no longer calls installMavenSettings()");
	assert.ok(call > src.indexOf("enforceTelemetryOff(process.env);"), "called before the telemetry floor");
	assert.ok(call > src.indexOf("restoreEnvProxyDispatcher();"), "called before the env-proxy dispatcher restore");
	assert.ok(call < src.indexOf("createAgentSession("), "called after the session is created");
	assert.match(src, /log\("maven_settings_written"/, "the write is visible in the job log for the on-host verification to grep");
});

/**
 * THE DRIFT GUARD. The Dockerfile.java21 template is the spec the XML shape must match field for
 * field, and two renderers that agree only in prose WILL drift. So this test lifts the RUN block out
 * of the Dockerfile, runs it verbatim under bash against a temp file, and diffs the bytes against
 * renderMavenSettingsXml for the same inputs -- including the values the deployment forwards.
 */
const DOCKERFILE = readFileSync(join(RUNNER_DIR, "..", "Dockerfile.java21"), "utf8");
const RUN_START = DOCKERFILE.indexOf("RUN set -eu;");
const RUN_END = DOCKERFILE.indexOf("chmod 0644 /opt/maven/conf/settings.xml", RUN_START);
assert.ok(RUN_START > 0 && RUN_END > RUN_START, "Dockerfile.java21's settings-generation RUN block moved; find it again");

// Docker's own env for a build: every ARG provides its declared default, and an explicit --build-arg
// (publish.sh passes MAVEN_PROXY_PORT:-3128 the same way) overrides it. Without this, the raw shell
// sees an UNSET MAVEN_PROXY_PORT where the image build sees 3128 -- the divergence publish.sh papers
// over, and exactly the default the runtime renderer must keep.
const ARG_DEFAULTS = Object.fromEntries(
	[...DOCKERFILE.matchAll(/^ARG (MAVEN_[A-Z_]+)=(.*)$/gm)].map(([, name, value]) => [name, value]),
);

test("renderMavenSettingsXml is byte-identical to the Dockerfile.java21 template for the same inputs", async () => {
	const block = DOCKERFILE.slice(RUN_START, RUN_END + "chmod 0644 /opt/maven/conf/settings.xml".length).replace(/^RUN /, "");
	const cases = [
		{ name: "deployment values", env: DEPLOYMENT_ENV },
		{ name: "mirror only", env: { MAVEN_MIRROR_URL: "https://maven.example.com/repository/public" } },
		{ name: "proxy only, port defaulted", env: { MAVEN_PROXY_HOST: "172.17.0.1" } },
		{ name: "proxy with nonProxyHosts", env: { MAVEN_PROXY_HOST: "172.17.0.1", MAVEN_PROXY_PORT: "8080", MAVEN_PROXY_NONPROXY: "localhost|127.0.0.1" } },
		{ name: "neither set (bare shell)", env: {} },
	];
	for (const { name, env } of cases) {
		const out = join(tempHome(), "dockerfile-settings.xml");
		const script = block.replace(/\/opt\/maven\/conf\/settings\.xml/g, out);
		// What publish.sh passes explicitly, then the ARG defaults for anything left unset.
		const buildEnv = { PATH: process.env.PATH, ...ARG_DEFAULTS, ...env };
		await new Promise((resolve, reject) =>
			execFile("/bin/bash", ["-c", script], { env: buildEnv }, (error, stdout, stderr) =>
				error ? reject(new Error(`${name}: ${error.message}\n${stderr}`)) : resolve(),
			),
		);
		const shellBytes = readFileSync(out, "utf8");
		const inputs = mavenSettingsFromEnv(env) ?? { mirrorUrl: null, proxyHost: null, proxyPort: "", nonProxyHosts: "" };
		assert.equal(renderMavenSettingsXml(inputs), shellBytes, `${name}: drift between the module and the Dockerfile template`);
		rmSync(dirname(out), { recursive: true, force: true });
	}
});
