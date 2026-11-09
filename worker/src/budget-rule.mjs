/**
 * The RETIRED dollar rule: the dollar keys an older deployment may still carry, and the one refusal sentence
 * every fail-loud door uses (config.mjs, runtime-settings.mjs, triggers.mjs).
 *
 * The dollar windows were retired in favour of token budgets, and the token budgets are gone too (C2): there is
 * no budget left to set. A dollar key an env, a settings file or a triggers file still carries is REFUSED with
 * this sentence rather than silently ignored, because a silently dropped cap is a silently widened budget, and
 * an operator who believes a bound is in force must not run without it.
 *
 * PURE and import-free, on model-ref.mjs's rule: `triggers.mjs` (which the receiver loads and the admin bundle
 * inlines) and `runtime-settings.mjs` (which the admin imports) both validate with it, and neither may drag
 * config.mjs's fs and os in with it.
 */

/**
 * The retired dollar keys and their env spellings. A settings file, a triggers file or an env that carries any
 * of them is REFUSED with a named reason, never silently ignored.
 */
export const RETIRED_DOLLAR_KEYS = Object.freeze(["maxCostUsd", "dailyCostUsd", "weeklyCostUsd", "monthlyCostUsd"]);
export const RETIRED_DOLLAR_ENV_NAMES = Object.freeze({ maxCostUsd: "PI_MAX_COST_USD", dailyCostUsd: "PI_DAILY_COST_USD", weeklyCostUsd: "PI_WEEKLY_COST_USD", monthlyCostUsd: "PI_MONTHLY_COST_USD" });

/** One refusal sentence for a retired dollar key, used by every fail-loud door (config, overlay, triggers). */
export function retiredDollarMessage(key) {
	return `${key} was retired with the dollar windows, and the token budgets that replaced them are gone too: delete ${key}, there is no budget left to set in its place`;
}
