/**
 * The UTC budget day-bucket vocabulary: the day KEY.
 *
 * Job-count caps were removed, so this module no longer reserves or releases a slot: `reserveBudget`,
 * `releaseBudget`, `reserveLedgers` and `releaseLedgers` are gone with the global and scoped count windows.
 * What remains is the day bucket: `dayKey` is the key the admin's spend fold buckets on (`admin/src/costs.mjs`
 * imports it), so changing it would orphan live counters and break the admin's display.
 */

/** UTC day key: `budget:YYYY-MM-DD`. */
export function dayKey(now = new Date(), prefix = "budget") {
	return `${prefix}:${now.toISOString().slice(0, 10)}`; // YYYY-MM-DD, UTC
}

