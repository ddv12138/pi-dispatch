/**
 * The two credential guards the overlay and the package validator share.
 *
 * They lived in import-pi.mjs until `pi-dispatch import-pi` was removed; the overlay it populated stays, so the
 * checks it used stay too, in a module that names what they are for rather than the command that happened to
 * own them. `doctor` reports a models.json literal secret, and `packages.mjs` refuses a staged package whose
 * name looks like the dispatch admin (a recursion vector: it can enqueue paid jobs from inside a job).
 */

/** The admin extension -- never loaded from a packaged/staged copy. */
export const ADMIN_RE = /pi-dispatch|dispatch-admin/i;

/** A config value that defers to the environment/a command rather than embedding a literal secret. */
export function isIndirection(v) {
	return typeof v === "string" && (v.startsWith("$") || v.startsWith("!"));
}

/**
 * Find a literal secret in a parsed models.json. Returns a human-readable location, or null if clean.
 * A provider `apiKey`, or an auth-ish header, that is a plain string (not `$ENV` / `!cmd`) is a literal.
 */
export function findLiteralSecret(models) {
	const providers = models?.providers;
	if (!providers || typeof providers !== "object") return null;
	for (const [name, cfg] of Object.entries(providers)) {
		if (typeof cfg?.apiKey === "string" && !isIndirection(cfg.apiKey)) return `providers.${name}.apiKey`;
		const headers = cfg?.headers;
		if (headers && typeof headers === "object") {
			for (const [h, val] of Object.entries(headers)) {
				if (/auth|api[-_]?key|token|secret|bearer/i.test(h) && typeof val === "string" && !isIndirection(val)) {
					return `providers.${name}.headers.${h}`;
				}
			}
		}
	}
	return null;
}
