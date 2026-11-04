/**
 * The token invariant (the token-denominated successor of money.mjs's dollar rule; DES-TOKEN-RESERVE-AND-SETTLE).
 *
 * PURE and import-free, on model-ref.mjs's rule: `triggers.mjs` (which the receiver loads and the admin
 * bundle inlines) and `runtime-settings.mjs` (which the admin imports) both validate with it, and neither may
 * drag config.mjs's fs and os in with it.
 *
 * Every amount is a whole number of tokens. The retired dollar knobs (`maxCostUsd`, `dailyCostUsd`,
 * `weeklyCostUsd`, `monthlyCostUsd`, and every spelling an operator might paste for them) are refused here with
 * the upgrade named: a silently dropped cap would be a silently WIDENED budget, the failure class this repo
 * refuses outright.
 */

/** The token keys a deployment can set, in the order the settings list them. */
export const TOKEN_SETTING_KEYS = Object.freeze(["maxTokens", "dailyTokenCap", "weeklyTokenCap", "monthlyTokenCap"]);
/** Each token window key's environment variable: one table for config.mjs, doctor and the console. */
export const TOKEN_ENV_NAMES = Object.freeze({ dailyTokenCap: "PI_DAILY_TOKEN_CAP", weeklyTokenCap: "PI_WEEKLY_TOKEN_CAP", monthlyTokenCap: "PI_MONTHLY_TOKEN_CAP" });
/** The three token WINDOWS, each of which needs a per-job budget to reserve (`checkTokenInvariant`). */
export const TOKEN_WINDOW_KEYS = Object.freeze(["dailyTokenCap", "weeklyTokenCap", "monthlyTokenCap"]);

// config.mjs's `configError` shape, built here so this module stays import-free (model-ref.mjs does the same).
function configError(message) {
	return Object.assign(new Error(message), { piDispatchConfig: true });
}

/**
 * The retired dollar keys and their env spellings, mapped to the message the refusal carries. A settings file,
 * a triggers file or an env that carries any of them is REFUSED with a named reason, never silently ignored:
 * these were real caps, and dropping them would silently widen every budget they set.
 */
export const RETIRED_DOLLAR_KEYS = Object.freeze(["maxCostUsd", "dailyCostUsd", "weeklyCostUsd", "monthlyCostUsd"]);
export const RETIRED_DOLLAR_ENV_NAMES = Object.freeze({ maxCostUsd: "PI_MAX_COST_USD", dailyCostUsd: "PI_DAILY_COST_USD", weeklyCostUsd: "PI_WEEKLY_COST_USD", monthlyCostUsd: "PI_MONTHLY_COST_USD" });

/** One refusal sentence for a retired dollar key, used by every fail-loud door (config, overlay, triggers). */
export function retiredDollarMessage(key) {
	const replacement = key === "maxCostUsd" ? "maxTokens" : `${key.replace("CostUsd", "TokenCap")}`;
	return `${key} was retired with the dollar windows: budgets are token-denominated now, so set ${replacement} instead (docs/upgrading.md)`;
}

/**
 * The cross-key rule (DES-TOKEN-RESERVE-AND-SETTLE): a token window without a per-job token budget is invalid,
 * because a window reserves each job's budget before the container starts, and without a budget there is no
 * amount to reserve.
 *
 * It runs on MERGED values, never per key: an env `PI_MAX_TOKENS` with an overlay `weeklyTokenCap` is valid,
 * and a per-key check of the overlay alone would refuse it. `settings` holds the keys as they were set
 * (any value but `null`/`undefined` counts as set). Returns `null`, or `{ invalid }` naming the first window
 * that lacks a budget.
 */
export function checkTokenInvariant(settings) {
	const set = (key) => settings?.[key] !== null && settings?.[key] !== undefined;
	if (set("maxTokens")) return null;
	const window = TOKEN_WINDOW_KEYS.find(set);
	return window === undefined ? null : { invalid: `${window} needs maxTokens: a token window reserves each job's per-job token budget before it starts, so it cannot be set without one` };
}

/**
 * The per-job token budget a job runs under, or `null` for none: the SMALLER of the trigger's `run.maxTokens`
 * and the deployment's `maxTokens`, each counted only when set.
 *
 * A trigger can only NARROW. Where both are set the smaller wins, so a trigger can never lift a job above the
 * deployment's budget (and a value above the env budget refuses the worker's load of the file too,
 * `loadSchedules`). Where only the trigger sets one, it applies: a deployment that set no budget asked for none,
 * and a trigger that asks for one is still a narrowing.
 *
 * The deployment value is validated before it gets here (config.mjs at boot, `validateOverlay` per job). The
 * trigger value is validated by the loader in both services, so a malformed one reaches this only from a
 * hand-built queue entry. That one does not throw (this runs at pickup, where a throw is a retry) and does not
 * fall back to the deployment budget either, which would quietly drop a budget that was asked for: it reads as
 * 0, the budget that refuses every call at the meter's first settle, and the run stops with `token_budget`.
 * `onMalformed(key)` is called when that happens, so the worker logs it rather than leaving a 0 unexplained.
 */
export function effectiveTokenCap(triggerValue, deploymentValue, onMalformed = () => {}) {
	let trigger;
	try {
		trigger = optionalTokenCount(triggerValue, "run.maxTokens");
	} catch {
		// Fail closed, and say so: `onMalformed` is told the KEY (never the value), so the caller can log it.
		trigger = 0;
		onMalformed("maxTokens");
	}
	const deployment = optionalTokenCount(deploymentValue, "maxTokens");
	if (trigger === null) return deployment;
	if (deployment === null) return trigger;
	return Math.min(trigger, deployment);
}

/** A token count: a safe integer of 1 or more, or a throw naming the key. Null/undefined reads as unset. */
export function optionalTokenCount(value, key) {
	if (value === null || value === undefined || value === "") return null;
	const n = typeof value === "number" ? value : Number(String(value).trim());
	if (!Number.isSafeInteger(n) || n < 1) {
		throw configError(`${key} must be a whole number of tokens of 1 or more`);
	}
	return n;
}

/**
 * The first parsed trigger whose `run.maxTokens` is above the deployment's `maxTokens`, as its index in
 * `triggers`, or -1. A trigger may only narrow the per-job budget, so a value above it can only be a
 * mistake: the job would run under the deployment's budget anyway, while the file reads as allowing more. Pure,
 * so `triggers.mjs` stays env-free and the worker's trigger load and doctor ask the same question. An unset
 * deployment budget has nothing to be above.
 */
export function triggerCapAboveDeployment(triggers, deploymentValue) {
	const deployment = optionalTokenCount(deploymentValue, "maxTokens");
	if (deployment === null) return -1;
	return triggers.findIndex((t) => t?.run?.maxTokens !== undefined && t.run.maxTokens !== null && optionalTokenCount(t.run.maxTokens, "run.maxTokens") > deployment);
}
