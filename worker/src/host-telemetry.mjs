/** Host self-description only: no consumer may use these facts to admit or refuse a job (#748). */
import { BACKEND_NAMES } from "./backends.mjs";

const integer = (v) => Number.isSafeInteger(v) && v >= 0;
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const decoded = (raw) => {
	if (typeof raw !== "string") return raw;
	if (raw.length > 32 * 1024) return null;
	try { return JSON.parse(raw); } catch { return null; }
};
export const CPU_RESERVE_WORDS = Object.freeze(["held", "no-parent", "unmanaged", "budget-unknown", "unreadable", "unset", "differs"]);

export function parseBudgetFrom(raw) {
	const r = decoded(raw);
	if (!object(r)) return null;
	const out = {};
	for (const key of ["memMode", "cpuMode"]) {
		if (!["auto", "value", "off"].includes(r[key])) return null;
		out[key] = r[key];
	}
	for (const key of ["memTotalMiB", "memReserveMiB", "cpuTotalCenti", "cpuReserveCenti"]) {
		if (r[key] !== null && !integer(r[key])) return null;
		out[key] = r[key];
	}
	for (const key of ["memFloored", "cpuFloored"]) {
		if (typeof r[key] !== "boolean") return null;
		out[key] = r[key];
	}
	return out;
}

export function parseCpuReserve(raw) {
	const list = decoded(raw);
	if (!Array.isArray(list)) return null;
	const seen = new Set();
	return list.filter((r) => object(r) && BACKEND_NAMES.includes(r.venue) && CPU_RESERVE_WORDS.includes(r.status) && !seen.has(r.venue) && seen.add(r.venue)).map((r) => ({ venue: r.venue, status: r.status, wantCenti: integer(r.wantCenti) ? r.wantCenti : null, quotaCenti: integer(r.quotaCenti) ? r.quotaCenti : null }));
}
