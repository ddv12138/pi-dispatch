import { randomUUID } from "node:crypto";
import { modelListProblem } from "./model-ref.mjs";
import { optionalTokenCount } from "./budget-rule.mjs";
import { MODEL_ROLE_RE } from "./model-roles.mjs";
import { SKILL_NAME_RE } from "./flow-gate.mjs";
import { recordReadable } from "./run-history.mjs";

/** A canary pays for fresh isolated runs, never for a modification to the role map. */
export function canaryOptions({ role, model, flow, count = 3, capTokens: capTokensArg }) {
	if (typeof role !== "string" || !MODEL_ROLE_RE.test(role) || role === "inherit") throw new Error("--role must name a configured model role");
	if (modelListProblem([model]) !== null) throw new Error("--model must be provider/model");
	if (typeof flow !== "string" || !SKILL_NAME_RE.test(flow)) throw new Error("--flow must name a flow");
	if (!Number.isInteger(Number(count)) || Number(count) < 1 || Number(count) > 10) throw new Error("--count must be 1 to 10");
	// REQUIRED, like --cap-usd was: an unbounded canary would buy candidate runs with no ceiling at all.
	if (capTokensArg === undefined || capTokensArg === null || capTokensArg === "") throw new Error("--cap-tokens must be a whole number of tokens of 1 or more");
	const capTokens = optionalTokenCount(capTokensArg, "--cap-tokens");
	return { role, model, flow, count: Number(count), capTokens };
}

/**
 * The completed runs of `options.flow` under `options.role` a canary replays, newest first. A record a newer pi-dispatch
 * wrote is skipped (issue #761, `recordReadable`): only its core fields keep their meaning in every version, and the
 * role, the flow and the token total read here are not among them.
 */
export function selectCanarySources(records, options, { now, windowMs = 7 * 86400_000 }) {
	return records.filter((r) => r && recordReadable(r) && !r.canary && r.modelRole === options.role && r.flow === options.flow && r.outcome === "completed" && typeof r.jobId === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(r.jobId) && Number.isFinite(Date.parse(r.endedAt)) && Date.parse(r.endedAt) <= now && Date.parse(r.endedAt) >= now - windowMs)
		.sort((a, b) => Date.parse(b.endedAt) - Date.parse(a.endedAt) || a.jobId.localeCompare(b.jobId)).slice(0, options.count);
}

/**
 * Allocate the whole experiment before starting. Unreported spend never buys another replay: each
 * original gets at most its fixed share, even if a prior container died without a trustworthy meter.
 * Every source is checked first, so an expired last source cannot strand a paid partial experiment.
 */
export async function executeCanary(options, { records, now = Date.now, inspectSource, execute, deploymentCapTokens = null, id = () => `canary-${randomUUID()}` }) {
	const originals = selectCanarySources(records, options, { now: now() });
	if (originals.length === 0) throw new Error("no completed jobs of this flow in the last seven days; run the flow with sandbox retention enabled first");
	const sources = [];
	for (const original of originals) sources.push(await inspectSource(original));
	const share = Math.floor(options.capTokens / sources.length);
	const perJob = Math.min(share, optionalTokenCount(deploymentCapTokens, "maxTokens") ?? share);
	if (perJob < 1) throw new Error("the canary cap is too small to allocate one token per job");
	const rows = [];
	for (let i = 0; i < sources.length; i++) {
		const jobId = id();
		const result = await execute({ source: sources[i], original: originals[i], jobId, options, maxTokens: perJob });
		rows.push({ sourceJobId: originals[i].jobId, jobId, original: { model: `${originals[i].provider}/${originals[i].model}`, outcome: originals[i].outcome, tokens: originals[i].tokens?.total ?? null }, candidate: { model: options.model, outcome: result.outcome, reason: result.reason ?? null, tokens: result.tokens?.total ?? null }, capTokens: perJob });
	}
	return { role: options.role, flow: options.flow, model: options.model, capTokens: options.capTokens, allocatedTokens: perJob * rows.length, whatIf: `/insights?whatif=${encodeURIComponent(options.model)}&flow=${encodeURIComponent(options.flow)}`, rows };
}

export function canaryText(report) {
	return [`Canary ${report.role}: ${report.model}, cap ${report.capTokens} tokens`, "Original run | original tokens / outcome | candidate run | candidate tokens / outcome", ...report.rows.map((r) => `${r.sourceJobId} | ${r.original.tokens ?? "?"} / ${r.original.outcome} | ${r.jobId} | ${r.candidate.tokens ?? "?"} / ${r.candidate.outcome}${r.candidate.reason ? ` (${r.candidate.reason})` : ""}`), `What-if: ${report.whatIf}`, "The role map is unchanged. Workspaces are disposable; forge access is blocked.", ""].join("\n");
}
