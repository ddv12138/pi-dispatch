import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { configError } from "./outcome.mjs";

/**
 * Runtime Maven settings, rendered into the job user's `~/.m2/settings.xml` at job preparation.
 *
 * THROUGH 4.3.6, the Java job image baked its Maven mirror and proxy into
 * `/opt/maven/conf/settings.xml` at BUILD time (image/Dockerfile.java21's MAVEN_* build args, filled
 * by ./image/publish.sh from the publishing shell's environment). That is why a deployment needed a
 * private `-m2seed` image variant for every network change: the settings are a fact about the NETWORK
 * a job runs in, and baking froze one network into the image bytes.
 *
 * FROM 4.3.7, the standard image ships an empty-shell global settings.xml and THIS module is the only
 * source: the worker forwards `MAVEN_MIRROR_URL` / `MAVEN_PROXY_HOST` / `MAVEN_PROXY_PORT` into the
 * container through the operator's PI_FORWARD_ENV (worker/src/env-allowlist.mjs, forwarded by exact
 * name, empty values skipped), and the runner renders the same XML the Dockerfile template used to
 * generate, into `~/.m2/settings.xml`, which Maven reads over the (now inert) global file. The XML
 * SHAPE IS THE DOCKERFILE TEMPLATE, field for field -- mirror block iff MAVEN_MIRROR_URL is set,
 * `<proxies>` with an https and an http entry iff MAVEN_PROXY_HOST is set, nonProxyHosts verbatim
 * from MAVEN_PROXY_NONPROXY (default empty) -- and maven-settings.test.mjs executes the Dockerfile's
 * own shell block and diffs the bytes, so the two can drift only by breaking that test.
 *
 * Maven's own `<proxies>` block is NOT optional on a proxied network: Java ignores HTTPS_PROXY, and a
 * Maven job on an `--internal` network reaches nothing without it (Dockerfile.java21's comment has the
 * measured failure). The 253 deployment's chain is job --(http:80)--> pi-dispatch-maven-proxy
 * --(CONNECT 443)--> squid --> maven.aliyun.com, with MAVEN_MIRROR_URL=http://pi-dispatch-maven-proxy
 * and no MAVEN_PROXY_NONPROXY (the proxy itself must ride squid; there is no direct route to bypass).
 *
 * WHY A FILE AND NOT MAVEN_OPTS/-D: settings.xml is the one place Maven takes a mirror AND both proxy
 * protocol entries, and it is exactly where an operator's own ~/.m2/settings.xml would sit, so a
 * hand-run container (docs' verification flows) sees the same behaviour as a dispatched job.
 *
 * CONDITIONING IS THE CONTRACT: with neither trigger variable set, this module writes NOTHING and
 * returns null -- a non-Java job (and a Java job on a deployment that never armed the feature) keeps
 * byte-identical behaviour, and no file appears in $HOME. Every failure is a configError (exit 2,
 * not retried): a bad port or an unwritable home must refuse the job BEFORE spend, not fail Maven
 * mid-build after the container is paid for.
 */

/** The path under the job user's home the settings file is rendered to. */
export const MAVEN_SETTINGS_PATH = ".m2/settings.xml";

/**
 * Escape the five XML built-in entities in an interpolated value. The Dockerfile template does not
 * escape, so for every value it accepted correctly this is byte-invisible; the difference is that a
 * value carrying a raw `&` (which would make Maven's XML parser throw mid-build) is rendered correctly
 * here instead of producing a broken file.
 */
function xmlEscape(value) {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

/**
 * The XML the Dockerfile.java21 template generates for these values, field for field, byte for byte
 * (including the trailing newline the template's last `echo` emits). `mirrorUrl`/`proxyHost` are
 * already-decided values: null omits that block entirely, exactly as the template's `if [ -n ... ]`.
 */
export function renderMavenSettingsXml({ mirrorUrl = null, proxyHost = null, proxyPort = "", nonProxyHosts = "" }) {
	const lines = ['<settings xmlns="http://maven.apache.org/SETTINGS/1.0.0">'];
	if (mirrorUrl !== null) {
		lines.push("  <mirrors><mirror>");
		lines.push("    <id>pi-dispatch-mirror</id><name>pi-dispatch mirror</name><mirrorOf>*</mirrorOf>");
		lines.push(`    <url>${xmlEscape(mirrorUrl)}</url>`);
		lines.push("  </mirror></mirrors>");
	}
	if (proxyHost !== null) {
		// The template's `for protocol in https http` -- https first, and the order is part of the shape.
		for (const protocol of ["https", "http"]) {
			if (protocol === "https") lines.push("  <proxies>");
			lines.push(`  <proxy><id>pi-dispatch-${protocol}</id><active>true</active><protocol>${protocol}</protocol>`);
			lines.push(`    <host>${xmlEscape(proxyHost)}</host><port>${xmlEscape(proxyPort)}</port>`);
			lines.push(`    <nonProxyHosts>${xmlEscape(nonProxyHosts)}</nonProxyHosts>`);
			lines.push("  </proxy>");
			if (protocol === "http") lines.push("  </proxies>");
		}
	}
	lines.push("</settings>");
	return `${lines.join("\n")}\n`;
}

/**
 * Read the decision out of a job's environment: null when neither trigger variable is set (nothing to
 * write, nothing to create), otherwise the validated render inputs. A set-but-useless value is a
 * configError here rather than a broken settings.xml at Maven's first resolve.
 */
export function mavenSettingsFromEnv(env = process.env) {
	const mirrorUrl = env.MAVEN_MIRROR_URL ?? "";
	const proxyHost = env.MAVEN_PROXY_HOST ?? "";
	if (mirrorUrl === "" && proxyHost === "") return null;
	if (mirrorUrl !== "") {
		let parsed;
		try {
			parsed = new URL(mirrorUrl);
		} catch {
			throw configError(`MAVEN_MIRROR_URL is not a URL: ${JSON.stringify(mirrorUrl)}`, "maven-settings");
		}
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			throw configError(`MAVEN_MIRROR_URL must be http or https, got ${JSON.stringify(parsed.protocol)}`, "maven-settings");
		}
	}
	let proxyPort = env.MAVEN_PROXY_PORT ?? "";
	if (proxyPort === "") proxyPort = "3128"; // the Dockerfile's ARG MAVEN_PROXY_PORT=3128 default
	else if (!/^\d+$/.test(proxyPort) || Number(proxyPort) < 1 || Number(proxyPort) > 65535) {
		throw configError(`MAVEN_PROXY_PORT must be a port number 1-65535, got ${JSON.stringify(env.MAVEN_PROXY_PORT)}`, "maven-settings");
	}
	return {
		mirrorUrl: mirrorUrl === "" ? null : mirrorUrl,
		proxyHost: proxyHost === "" ? null : proxyHost,
		proxyPort,
		// Verbatim, like the template's ${MAVEN_PROXY_NONPROXY:-}: the separator is Maven's own `|`.
		nonProxyHosts: env.MAVEN_PROXY_NONPROXY ?? "",
	};
}

/**
 * Render and install, called once at job preparation before any spend. Returns null (wrote nothing)
 * when the environment carries neither trigger variable -- the strictly-conditional contract every
 * non-Java job relies on -- or { path, xml } after the file is on disk. A home that cannot take the
 * file is a configError naming the path and the cause, never a silent skip: a Java job whose settings
 * did not land would otherwise resolve every artifact direct and die on the internal network AFTER
 * spend.
 */
export function installMavenSettings({ env = process.env, home } = {}) {
	const inputs = mavenSettingsFromEnv(env);
	if (inputs === null) return null;
	// env-internal HOME: the container user's own home (docker derives it from /etc/passwd for USER pi),
	// not an operator key -- it decides where ~/.m2/settings.xml lands, nothing else. homedir() is the
	// fallback for a hand-run container started without HOME.
	const resolvedHome = home ?? env.HOME ?? homedir();
	const path = join(resolvedHome, MAVEN_SETTINGS_PATH);
	const xml = renderMavenSettingsXml(inputs);
	try {
		// mkdir -p ~/.m2, then the file, 0644 like the template's chmod -- a credential-free settings
		// file has no reason to be secret, and group/other readability keeps operator debugging honest.
		mkdirSync(join(resolvedHome, ".m2"), { recursive: true });
		writeFileSync(path, xml, { mode: 0o644 });
	} catch (error) {
		throw configError(`cannot write Maven settings to ${path}: ${error?.message ?? error}`, "maven-settings");
	}
	return { path, xml };
}
