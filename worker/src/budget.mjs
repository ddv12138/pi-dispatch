/**
 * The UTC budget window vocabulary: the day/week/month KEYS and TTLS every windowed counter uses.
 *
 * Job-count caps were removed, so this module no longer reserves or releases a slot: `reserveBudget`,
 * `releaseBudget`, `reserveLedgers` and `releaseLedgers` are gone with the global and scoped count windows.
 * What remains is the key vocabulary: `token-budget.mjs` composes `budget:tok:` with `dayKey`/`weekKey`/
 * `monthKey` and expires them on `DAY/WEEK/MONTH_TTL_SECONDS`. Doctor, model-failover and the admin read the
 * same keys. The key/TTL exports are kept byte-compatible for those readers; changing one would orphan live
 * counters and break the admin's display.
 */

/** UTC day key: `budget:YYYY-MM-DD`. */
export function dayKey(now = new Date(), prefix = "budget") {
	return `${prefix}:${now.toISOString().slice(0, 10)}`; // YYYY-MM-DD, UTC
}

/**
 * UTC week key, bucketed by the Monday of the run's week: `budget:w:YYYY-MM-DD` (that Monday's date).
 * Keying by an actual date sidesteps ISO week-number edge cases (week 53, year rollovers) while still
 * mapping every run in one Mon-Sun week to one key. The `w:` sub-namespace never collides with the day
 * key (`budget:YYYY-MM-DD`).
 */
export function weekKey(now = new Date(), prefix = "budget") {
	const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
	const sinceMonday = (d.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
	d.setUTCDate(d.getUTCDate() - sinceMonday);
	return `${prefix}:w:${d.toISOString().slice(0, 10)}`;
}

/** UTC month key: `budget:m:YYYY-MM`. The `m:` sub-namespace never collides with the day/week keys. */
export function monthKey(now = new Date(), prefix = "budget") {
	return `${prefix}:m:${now.toISOString().slice(0, 7)}`; // YYYY-MM, UTC
}

// Each window's TTL outlives its bucket with slack, so a stale counter is reclaimed shortly after the
// window rolls over. Set once, on first reservation only (reserved === 1), so a busy window cannot push
// its own expiry forward indefinitely. EXPORTED for the token windows (token-budget.mjs), so a token
// counter and any other counter for the same window live and expire on the same terms.
export const DAY_TTL_SECONDS = 2 * 24 * 60 * 60; // outlives the UTC day
export const WEEK_TTL_SECONDS = 9 * 24 * 60 * 60; // outlives the Mon-Sun week
export const MONTH_TTL_SECONDS = 40 * 24 * 60 * 60; // outlives the longest month
