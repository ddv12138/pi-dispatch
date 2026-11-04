/** Reviewed suggestions only (#717). Data enters here; no routing or settings writes leave it. */

const REF = /^(?=.{1,256}$)[~@]?[A-Za-z0-9][A-Za-z0-9._:/@_-]*$/;
export function catalogDiff(before, after, providers) {
	const index = (rows) => {
		const out = new Map();
		for (const row of rows) {
			if (!row || typeof row.provider !== "string" || typeof row.id !== "string" || !REF.test(row.provider) || !REF.test(row.id) || !providers.includes(row.provider) || row.type !== "chat") continue;
			const key = `${row.provider}/${row.id}`;
			if (out.has(key)) throw new Error("ambiguous model catalog");
			out.set(key, row);
		}
		return out;
	};
	const old = index(before), next = index(after);
	const changed = [];
	for (const key of [...new Set([...old.keys(), ...next.keys()])].sort()) {
		const a = old.get(key), b = next.get(key);
		const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
		const rates = (row) => JSON.stringify(canonical(row?.cost ?? null));
		if (!a || !b || rates(a) !== rates(b)) changed.push({ ref: key, kind: !a ? "added" : !b ? "removed" : "repriced", before: a ?? null, after: b ?? null });
	}
	return changed;
}

/** A public-report reference price for ONE full-context call, from the catalog's own rate table (pi's models.json
 * keeps its prices; the worker's budgets are token-denominated and this figure enforces nothing). */
export function proposalCallPrice(model, outputTokens = 4096) {
	const rates = model?.cost ?? null;
	const context = Number.isFinite(model?.contextWindow) ? model.contextWindow : 0;
	const tokens = context + outputTokens;
	const input = rates?.input, cached = rates?.cacheRead ?? 0;
	const rate = Number.isFinite(input) ? Math.max(0, input) : null;
	const out = rates?.output;
	return rate === null || !Number.isFinite(out) ? null : (Math.max(0, tokens) * rate + Math.max(0, outputTokens) * Math.max(0, out) - Math.max(0, outputTokens) * Math.max(0, cached)) / 1;
}

export function renderCatalogProposal(changes, { providers, capsUsd, outputTokens = 4096 }) {
	const lines = ["## Model catalog proposals", "", `Public report scope: ${providers.join(", ")}. Reference caps: ${capsUsd.map((n) => `$${n}`).join(", ")}; these are public report inputs, not deployment caps.`, "", `Reference prices are one full-context call (the row's context window plus ${outputTokens} output tokens) at the catalog's own rates; actual job prompts, images and thinking change the count. Models remain unchanged until a reviewed edit.`, ""];
	if (!changes.length) lines.push("No added, removed or repriced chat models in this scope.");
	for (const change of changes) {
		const price = change.after ? proposalCallPrice(change.after, outputTokens) : null;
		const shown = price === null ? "no usable rate table" : `$${price.toFixed(6)}`;
		const beforePrice = change.before ? proposalCallPrice(change.before, outputTokens) : null;
		const previous = change.before ? `; previous reference price: ${beforePrice === null ? "no usable rate table" : `$${beforePrice.toFixed(6)}`}` : "";
		lines.push(`- ${change.kind}: \`${change.ref}\`; reference full-context call: ${change.after ? shown : "removed"}${previous}${price === null ? "" : `; ${capsUsd.map((cap) => `${price <= cap ? "fits" : "exceeds"} $${cap}`).join(", ")}`}.`);
	}
	return lines.join("\n");
}

/** Provider fields verified against their Models API references, 2026-10-29. No name-based sibling guesses. */
export function lifecycleModels(provider, response) {
	if (!Array.isArray(response?.data) || response.data.length > 1000) throw new Error("invalid lifecycle catalog");
	return response.data.map((row) => {
		if (!row || typeof row.id !== "string" || !REF.test(row.id)) throw new Error("invalid lifecycle model");
		const date = provider === "anthropic" ? row.retires_at : row.shutdown_date;
		if (date != null && (typeof date !== "string" || !Number.isFinite(Date.parse(date)))) throw new Error("invalid retirement date");
		if (provider === "anthropic" && !["active", "deprecated", "retired"].includes(row.lifecycle)) throw new Error("invalid lifecycle stage");
		return { id: row.id, retiresAt: date ?? null, deprecated: provider === "anthropic" ? row.lifecycle !== "active" : date != null, retired: provider === "anthropic" && row.lifecycle === "retired", line: typeof row.line === "string" ? row.line : null, createdAt: row.created_at ?? null };
	});
}

export function roleProposalChecks({ roles, catalogs = {}, replacements = {}, now, noticeDays = 90 }) {
	const checks = [];
	for (const [scope, mapping] of Object.entries(roles)) for (const [role, value] of Object.entries(mapping)) {
		const ref = typeof value === "string" ? value : value?.model;
		if (typeof ref !== "string") continue;
		const slash = ref.indexOf("/"), provider = ref.slice(0, slash), id = ref.slice(slash + 1);
		const rows = catalogs[provider] ?? [];
		const model = rows.find((m) => m.id === id);
		if (!model) continue;
		const retirement = model.retiresAt === null ? null : Date.parse(model.retiresAt);
		if (model.deprecated || retirement !== null && retirement - now <= noticeDays * 86400000) checks.push({ proposal: { kind: "retirement", scope, role, model: ref, ...(replacements[ref] ? { candidate: replacements[ref] } : {}) }, ok: false, warn: true, label: `Model role ${scope}/${role}: ${ref} is ${model.retired ? "retired" : "deprecated"}${model.retiresAt ? `; retirement ${model.retiresAt}` : ""}`, fix: replacements[ref] ? `review provider replacement ${replacements[ref]} with a capped canary, then edit modelRoles` : "review the provider's deprecation notice and run a capped canary before editing modelRoles" });
		const siblings = model.line ? rows.filter((m) => m.line === model.line && !m.deprecated && Number.isFinite(Date.parse(m.createdAt)) && Date.parse(m.createdAt) > Date.parse(model.createdAt)) : [];
		if (siblings.length) {
			const sibling = siblings.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0].id;
			checks.push({ proposal: { kind: "newer-sibling", scope, role, model: ref, candidate: `${provider}/${sibling}` }, ok: true, label: `Model role ${scope}/${role}: newer provider-declared sibling ${sibling}; review with a capped canary` });
		}
	}
	return checks;
}
