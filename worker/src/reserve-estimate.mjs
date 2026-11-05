/**
 * What a job will hold when the worker reserves for it (issue #642): the figure the operator console shows before a
 * paid action (a re-run, an answer to a parked run) is confirmed. CONST-BUDGET-BEFORE-TOKENS is unchanged: the worker
 * still reserves at pickup, and this only SAYS beforehand what that reserve will be.
 *
 * The rule is the worker's, imported rather than restated, which is the whole point of this module:
 *   - the per-job token budget is `effectiveTokenCap(trigger's maxTokens, deployment's maxTokens)` (budget-rule.mjs),
 *     the smaller of the two, each counted only when set: exactly what `effectiveJobOf` (index.mjs) gives `runJob`;
 *   - a job that cannot spend reserves nothing: `zeroRatedFor` below is the processor's own test (its reserve step
 *     calls it), a cap of 0 or every callable model served by a declared endpoint and zero-rated (model-endpoints.mjs);
 *   - every job takes one job-count slot in each window that applies.
 *
 * The deployment's settings resolve as the worker's do, `overlay > env > default` per key (runtime-settings.mjs over
 * config.mjs), with an empty env value unset (`usdSetting`).
 */

import { effectiveTokenCap } from "./budget-rule.mjs";
import { splitModelEntry } from "./model-ref.mjs";
import { zeroRatedVerdict } from "./model-endpoints.mjs";
import { DEFAULT_MODEL, DEFAULT_PROVIDER, allowedModelsFrom } from "./config.mjs";

/**
 * The models a job may call (issue #501, #503 part 7), as `{ provider, id }` refs: its main model, and every entry of
 * its effective allowed-model list when it has one. A list entry that does not split is kept as `null`, which the
 * zero-rated check reads as "not zero-rated" (fail closed). Moved here from processor.mjs (issue #642), which imports
 * it, so the estimate and the reserve judge the same refs.
 */
export function callableModelRefs(job) {
	const refs = [{ provider: job.provider, id: job.model }];
	for (const entry of Array.isArray(job.models) ? job.models : []) {
		const ref = splitModelEntry(entry);
		refs.push(ref === null ? null : { provider: ref.provider, id: ref.model });
	}
	return refs;
}

/**
 * Can this EFFECTIVE job (provider, model, models and `maxTokens` resolved) use no tokens? `{ zeroRated: true }`
 * for a budget that is already 0 (nothing to reserve), else `zeroRatedVerdict` over its callable models and the
 * pickup's endpoint snapshot `{ models, endpoints }` (null: none, so never zero-rated). The processor's reserve step
 * and the console's estimate both call this, so the two cannot disagree on the rule.
 */
export function zeroRatedFor(job, { modelEndpoints = null, builtinModel = () => null } = {}) {
	if (job.maxTokens === 0) return { zeroRated: true };
	return zeroRatedVerdict({ models: modelEndpoints?.models ?? null, endpoints: modelEndpoints?.endpoints ?? [], refs: callableModelRefs(job), builtinModel });
}

/**
 * The reserve for `jobData` (the job's data as it will be queued), against the deployment's settings overlay and env:
 * `{ slots: 1, tokens, maxTokens, zeroRated }`, or `{ invalid }` when the deployment's own token setting is malformed
 * (the worker refuses every job then, `settings-overlay-invalid`).
 *
 *   - `maxTokens`: the per-job budget the runner's meter counts against, or null for none.
 *   - `tokens`: what the worker holds in each token window that applies (the deployment's, a scoped or model
 *     row's): 0 for a zero-rated job, else the budget; null when there is no budget (then no window can be set
 *     either, the token invariant). With no token window set the worker holds nothing, and the runner still stops
 *     the job at `maxTokens`.
 *   - `zeroRated`: whether the job can use no tokens at all.
 *
 * `modelEndpoints` (`{ models, endpoints }`, the worker's pickup snapshot) and `builtinModel` are the zero-rated
 * check's inputs; without them a job is judged not zero-rated, the fail-closed direction (the estimate then names the
 * larger figure, never a smaller one than the worker holds).
 */
export function estimateReserve(jobData, { overlay = {}, env = {}, modelEndpoints = null, builtinModel = () => null } = {}) {
	const data = jobData ?? {};
	const o = overlay ?? {};
	// The deployment's allowed-model list (PI_ALLOWED_MODELS, env only, never the overlay), the worker's `effectiveJobOf`
	// fallback when the job names none: with it, every listed model must be zero-rated too, since the job may switch to
	// any of them. An env list the worker would refuse at boot cannot be judged at all, and judging it as "no list" would
	// NARROW the refs to the main model alone (a smaller figure than a list could give), so it is judged not zero-rated:
	// the estimate then names the cap, never less than a worker could hold.
	let allowed = null;
	let allowedInvalid = false;
	try {
		allowed = allowedModelsFrom(env ?? {});
	} catch {
		allowedInvalid = true;
	}
	const models = data.models ?? allowed ?? null;
	let maxTokens;
	try {
		maxTokens = effectiveTokenCap(data.maxTokens, o.maxTokens ?? env?.PI_MAX_TOKENS ?? null);
	} catch (e) {
		return { invalid: e?.message ?? String(e) };
	}
	const job = {
		...data,
		provider: data.provider ?? o.provider ?? env?.PI_PROVIDER ?? DEFAULT_PROVIDER,
		model: data.model ?? o.model ?? env?.PI_MODEL ?? DEFAULT_MODEL,
		...(models !== null ? { models } : {}),
		maxTokens,
	};
	if (maxTokens === null) return { slots: 1, tokens: null, maxTokens: null, zeroRated: false };
	const zero = allowedInvalid && (data.models ?? null) === null ? { zeroRated: false } : zeroRatedFor(job, { modelEndpoints, builtinModel });
	return { slots: 1, tokens: zero.zeroRated ? 0 : maxTokens, maxTokens, zeroRated: zero.zeroRated === true };
}
