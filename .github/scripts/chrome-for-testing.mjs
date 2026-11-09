#!/usr/bin/env node
/**
 * Chrome for Testing, as this repository pins it: the url a platform's build is downloaded from and the check that a
 * downloaded zip is that build. The console browser checks (setup, models, answerer, connections) run against the
 * pinned browser, so CI still needs the pin checked and the zip verified even though the width check itself is gone.
 *
 *   node .github/scripts/chrome-for-testing.mjs --check-pin [--platform linux64|mac-arm64]
 *   node .github/scripts/chrome-for-testing.mjs --verify-zip <file> [--platform linux64|mac-arm64]
 *
 * The url is derived from the pin's version and the whole pin is checked first, so a hand edit that points elsewhere
 * stops before anything is downloaded; the zip's sha256 is checked before it is unzipped.
 */
import { createHash } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
/** The pin file; CONSOLE_WIDTH_PIN is kept for a test that needs another file, never set by CI. */
export const PIN_FILE = process.env.CONSOLE_WIDTH_PIN || join(REPO, ".github", "chrome-for-testing.json");

export const CFT_PLATFORMS = Object.freeze(["linux64", "mac-arm64"]);
/** The longest one navigation (the request, the page's load event) may take. */

/** Chrome for Testing's download url for `version` on `platform`: derived, so the pin file's copy is checked, not trusted. */
export function cftUrl(version, platform) {
	return `https://storage.googleapis.com/chrome-for-testing-public/${version}/${platform}/chrome-${platform}.zip`;
}

/** What is wrong with a pin file's contents, as sentences; empty when it can be used. */
export function pinProblems(pin) {
	const out = [];
	if (!pin || typeof pin !== "object") return ["the pin is not a JSON object"];
	if (typeof pin.version !== "string" || !/^\d+\.\d+\.\d+\.\d+$/.test(pin.version)) out.push(`version ${JSON.stringify(pin.version)} is not an exact Chrome version (four numbers)`);
	if (pin.channel !== "Stable") out.push(`channel ${JSON.stringify(pin.channel)} is not Stable`);
	if (typeof pin.released !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(pin.released)) out.push(`released ${JSON.stringify(pin.released)} is not a date (YYYY-MM-DD)`);
	const platforms = Object.keys(pin.downloads ?? {});
	if (platforms.join(",") !== CFT_PLATFORMS.join(",")) out.push(`downloads are ${JSON.stringify(platforms)}, not ${JSON.stringify(CFT_PLATFORMS)}`);
	for (const platform of CFT_PLATFORMS) {
		const d = pin.downloads?.[platform];
		if (!d) continue;
		if (out.length === 0 && d.url !== cftUrl(pin.version, platform)) out.push(`downloads.${platform}.url is not ${cftUrl(pin.version, platform)}`);
		if (typeof d.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(d.sha256)) out.push(`downloads.${platform}.sha256 is not 64 lowercase hex digits`);
	}
	return out;
}

/**
 * What `--check-pin` prints: `{ url }`, the download for `platform` derived from the pin's version once the whole pin
 * holds (`pinProblems`), or `{ error }`. The workflow downloads from this url, never from a field it read itself, so a
 * pin that names a build its version does not, or holds no usable hash, stops the step before anything is fetched.
 */
export function pinUrl(pin, platform) {
	if (!CFT_PLATFORMS.includes(platform)) return { error: `the pin has no ${platform} download (it pins ${CFT_PLATFORMS.join(", ")})` };
	const problems = pinProblems(pin);
	if (problems.length > 0) return { error: `.github/chrome-for-testing.json: ${problems.join("; ")}` };
	return { url: cftUrl(pin.version, platform) };
}

/** This machine's Chrome for Testing platform, or null where none is pinned. */
export function hostPlatform(platform = process.platform, arch = process.arch) {
	if (platform === "linux" && arch === "x64") return "linux64";
	if (platform === "darwin" && arch === "arm64") return "mac-arm64";
	return null;
}

export function sha256Hex(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

/** Whether a download whose sha256 is `got` is the pin's build for `platform`: `{ ok, want, got, problem }`. */
export function zipVerdict({ got, platform, pin }) {
	const want = pin?.downloads?.[platform]?.sha256 ?? null;
	if (want === null) return { ok: false, want, got, problem: `the pin has no ${platform} download` };
	if (got !== want) return { ok: false, want, got, problem: `sha256 ${got} is not the pinned ${want} (Chrome for Testing ${pin.version} ${platform}): refusing to run an unverified browser` };
	return { ok: true, want, got, problem: null };
}

function readPin() {
	return JSON.parse(readFileSync(PIN_FILE, "utf8"));
}

async function verifyZipMain(opts) {
	const platform = opts.platform ?? hostPlatform();
	if (!platform) throw new Error(`this machine (${process.platform} ${process.arch}) has no pinned Chrome for Testing build; pass --platform`);
	const pin = readPin();
	const problems = pinProblems(pin);
	if (problems.length > 0) throw new Error(`.github/chrome-for-testing.json: ${problems.join("; ")}`);
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(opts.verifyZip)) hash.update(chunk);
	const v = zipVerdict({ got: hash.digest("hex"), platform, pin });
	if (!v.ok) throw new Error(`${opts.verifyZip}: ${v.problem}`);
	console.log(`OK: ${opts.verifyZip} is Chrome for Testing ${pin.version} ${platform} (sha256 ${v.got})`);
}

/** `--check-pin`: the url alone on stdout, so the workflow can download from it; everything else is a refusal. */
function checkPinMain(opts) {
	const platform = opts.platform ?? hostPlatform();
	if (!platform) throw new Error(`this machine (${process.platform} ${process.arch}) has no pinned Chrome for Testing build; pass --platform`);
	const got = pinUrl(readPin(), platform);
	if (got.error) throw new Error(got.error);
	console.log(got.url);
}

const USAGE = `usage: node .github/scripts/chrome-for-testing.mjs --check-pin [--platform ${CFT_PLATFORMS.join("|")}]
       node .github/scripts/chrome-for-testing.mjs --verify-zip <file> [--platform ${CFT_PLATFORMS.join("|")}]
  --check-pin   check .github/chrome-for-testing.json and print the platform's download url, derived from its version
  --verify-zip  check a downloaded Chrome for Testing zip against .github/chrome-for-testing.json's sha256
                (for both, the platform defaults to this machine's)`;

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const opts = { verifyZip: null, checkPin: false, platform: null };
	const argv = process.argv.slice(2);
	const value = (flag, i) => {
		const v = argv[i + 1];
		if (v === undefined || v === "" || v.startsWith("--")) throw new Error(`${flag} takes a value`);
		return v;
	};
	try {
		for (let i = 0; i < argv.length; i++) {
			const a = argv[i];
			if (a === "--help" || a === "-h") {
				console.log(USAGE);
				process.exit(0);
			} else if (a === "--check-pin") opts.checkPin = true;
			else if (a === "--verify-zip") {
				opts.verifyZip = value(a, i);
				i++;
			} else if (a === "--platform") {
				opts.platform = value(a, i);
				i++;
			} else throw new Error(`unexpected argument: ${a}`);
		}
		if (opts.checkPin && opts.verifyZip !== null) throw new Error("--check-pin and --verify-zip run alone");
		if (opts.verifyZip === null && !opts.checkPin) throw new Error("pass --check-pin or --verify-zip");
		if (opts.platform !== null && !CFT_PLATFORMS.includes(opts.platform)) throw new Error(`--platform is one of ${CFT_PLATFORMS.join(", ")}`);
		if (opts.verifyZip !== null) await verifyZipMain(opts);
		else checkPinMain(opts);
	} catch (err) {
		console.error(`::error::chrome-for-testing: ${err?.message ?? err}`);
		console.error(USAGE);
		process.exit(1);
	}
}
