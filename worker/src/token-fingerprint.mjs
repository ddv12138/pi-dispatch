/**
 * The fingerprint of a host's token caps (issue #501, part 6), published on its host registry row as `fpTok`.
 *
 * WHY THE FLEET NEEDS IT. The token counters are shared keys (`budget:tok:*`), as the job-count windows are, but
 * each host reads its CAPS from its own env, its own settings overlay and its own scoped-limits file. Two hosts
 * on one Valkey can therefore judge one counter against two different caps, and the host with the larger cap
 * admits a job the other would refuse. Nothing on the paid path can see that, so `doctor` compares the hosts'
 * fingerprints and warns when they differ, the way it treats the image digest and the timezone.
 *
 * WHAT IT COVERS, which is exactly what decides a token admission on a host:
 *   - the three token window settings (`dailyTokenCap`, `weeklyTokenCap`, `monthlyTokenCap`) plus the per-job
 *     `maxTokens`: the overlay over env, as a job resolves them.
 *     When the overlay is invalid, or the merged values break the token rule, it hashes the env values; such a host
 *     refuses every job (`settings-overlay-invalid`), and env is what it will run under once the file is fixed or
 *     removed (`start.mjs`, the fallback its slot count and its scoped-limits warning take);
 *   - every scoped-limits row that carries a token window: the COUNTER it reserves in and its three caps;
 *   - the model rows a job with no list of its own reserves in (PR #551's review): `PI_ALLOWED_MODELS` decides
 *     them (`modelTokenRows`), so two hosts with equal caps and different env lists admit differently. Their
 *     counter prefixes, sorted. With no env list that is every model row; listed as the counters themselves, so
 *     two hosts that reserve in the same counters agree whatever their lists say about models with no row.
 *
 * NUMBERS AND HASHES ONLY, the registry's content rule (`INT-HOST-REGISTRY-CONTRACT`). An amount is hashed as its integer
 * token count and never appears in clear. A row is named by its token key prefix (`budget:tok:s:<hash16>` or `budget:tok:mdl:<hash16>`,
 * `tokenKeyPrefixFor`), never by its scope string: a folder scope is a host path and a repo scope a repository
 * name, and neither may reach a Valkey value even inside a digest's input. The prefix is also the right identity
 * for the comparison, because it is the counter two hosts share: two rows that spell one scope differently but
 * reserve in one counter are one row here.
 *
 * Pure apart from the hash, and it never throws: an amount that does not parse (a value the worker refuses at
 * boot or per job) hashes as the word `invalid`, so a host still publishes a fingerprint and a peer still sees
 * that it differs.
 */

import { fingerprint } from "./fingerprint.mjs";
import { TOKEN_LIMIT_FIELDS, tokenKeyPrefixFor, modelTokenRows } from "./scoped-limits.mjs";

/** An amount as the integer token count, `null` when unset, or `"invalid"`: never the value as written. */
function amount(value, field) {
	if (value === null || value === undefined) return null;
	// The worker's own readers hand env values AS WRITTEN (strings) beside overlay numbers, and both mean the
	// same whole count: a numeric string of digits is the number. Anything else is a value the worker refuses,
	// and the fingerprint records it as a different fingerprint ("invalid") rather than guessing.
	const n = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
	return Number.isSafeInteger(n) && n >= 0 ? n : "invalid";
}

/**
 * What the fingerprint hashes, exported so a test can read it: `{ settings, rows, untargeted }`, where `settings` maps
 * each token key to its integer count or null, `rows` lists every token-carrying row as `{ counter, dayTokens, weekTokens,
 * monthTokens }`, sorted by counter, and `untargeted` is the sorted counter prefixes of the model rows a job with no list
 * of its own reserves in under `envList` (the parsed `PI_ALLOWED_MODELS`, or null). Row order in the file is not a
 * cap, so two hosts listing the same rows in a different order agree.
 */
export function tokenFingerprintInput(settings, limits, envList = null) {
	const caps = {};
	for (const key of ["dailyTokenCap", "weeklyTokenCap", "monthlyTokenCap", "maxTokens"]) caps[key] = amount(settings?.[key]);
	const rows = [];
	for (const row of Array.isArray(limits) ? limits : []) {
		if (!TOKEN_LIMIT_FIELDS.some((field) => row?.[field] !== null && row?.[field] !== undefined)) continue;
		const windows = {};
		for (const field of TOKEN_LIMIT_FIELDS) windows[field] = amount(row[field], field);
		rows.push({ counter: tokenKeyPrefixFor(row), ...windows });
	}
	rows.sort((a, b) => (a.counter < b.counter ? -1 : a.counter > b.counter ? 1 : 0));
	let untargeted;
	try {
		untargeted = modelTokenRows(Array.isArray(limits) ? limits : [], Array.isArray(envList) ? envList : null).map((row) => row.keyPrefix).sort();
	} catch {
		untargeted = "invalid"; // a row whose amount does not parse: the rows above already say so
	}
	return { settings: caps, rows, untargeted };
}

/** The 16-hex fingerprint `fpTok` (`fingerprint.mjs`) of a host's token settings, scoped-limits rows and env list. */
export function tokenFingerprint(settings, limits, envList = null) {
	return fingerprint(tokenFingerprintInput(settings, limits, envList));
}

/**
 * The fingerprint of a host with no token setting and no token row. A peer that publishes no `fpTok` (it
 * predates this field) is worth a warning only when token caps are in use somewhere on the fleet, and this is
 * how a reader tells.
 */
export const EMPTY_TOKEN_FINGERPRINT = tokenFingerprint({}, []);
