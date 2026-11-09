/**
 * The models a job may call (issue #501, #503 part 7), as `{ provider, id }` refs.
 *
 * This module used to also answer "what will the worker reserve for this job" (issue #642). The token budgets and the
 * allocation are gone, so the estimate, its `maxTokens`/zero-rated rule and the budget-rule import are gone with them;
 * `callableModelRefs` stays because the processor reads it for its egress credential-host set.
 */

import { splitModelEntry } from "./model-ref.mjs";

/**
 * The models a job may call, as `{ provider, id }` refs: its main model, and every entry of its effective allowed-model
 * list when it has one. A list entry that does not split is kept as `null`, which a zero-rated check would read as "not
 * zero-rated" (fail closed). Moved here from processor.mjs (issue #642), which imports it.
 */
export function callableModelRefs(job) {
	const refs = [{ provider: job.provider, id: job.model }];
	for (const entry of Array.isArray(job.models) ? job.models : []) {
		const ref = splitModelEntry(entry);
		refs.push(ref === null ? null : { provider: ref.provider, id: ref.model });
	}
	return refs;
}
