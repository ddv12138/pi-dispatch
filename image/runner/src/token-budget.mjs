/**
 * Fallback SESSION TOKEN METER -- metering only, no per-job token budget.
 *
 * pi (0.80.7 and the 0.99.1 pin) emits per-turn token usage on subscribe() as `event.message.usage` -- a required
 * `Usage` on the assistant AgentMessage. This attaches a synchronous listener that ACCUMULATES that usage across
 * turns, so a job's token and cost totals land in run history. It never aborts, never stops a call and has no
 * cap: the per-job token budget is gone from the runner.
 *
 * The listener is SYNCHRONOUS for the same reason it always was: `_emit` is an unawaited
 * `for (const l of listeners) l(event)`, so an async listener is fire-and-forget and the next turn could start
 * before the accumulator ran, losing a turn's usage.
 *
 * WHAT IT CANNOT SEE (issue #509): calls pi makes OUTSIDE a turn never reach turn_end. At the 0.99.1 pin those
 * are compaction and branch summaries (the session's streamFn, called directly, and paid), their retries
 * (summarization_retry_*, also paid), cache-warming re-sends (off in a job, jobSettings), and any subagent
 * session. The process-wide meter at ModelRuntime.prototype counts all of them; a job on this fallback
 * under-reports by exactly those, and the exit line's `metered: false` says so.
 *
 * Usage is accumulated on turn_end ONLY. Each turn is a distinct billed API call, so summing the
 * per-turn usage yields the job's total billed tokens and cost. `agent_end` carries `messages[]`,
 * a terminal snapshot of those same messages -- accumulating it too would double-count.
 *
 * SCOPE as of issue #58: this is the FALLBACK meter. It subscribes to ONE session's bus, which is per
 * AgentSession instance, so it cannot see a subagent session an extension spawns -- the process-wide meter in
 * src/usage-meter.mjs is the primary. run-job.mjs attaches this ONLY when that meter could not install
 * (`usageMeter.ok === false`), so exactly one accumulator is ever live and the two can never both count the
 * same tokens. Do not attach it alongside the meter "for safety": the totals would double.
 */
export function attachSessionMeter(session) {
	const state = { input: 0, output: 0, total: 0 };

	const unsubscribe = session.subscribe((event) => {
		if (event.type !== "turn_end") return;
		const message = event.message;
		if (message?.role !== "assistant" || !message.usage) return;
		const usage = message.usage;

		state.input += usage.input ?? 0;
		state.output += usage.output ?? 0;
		// totalTokens is the BILLED total (input + output + cache read/write), so state.total >= input +
		// output -- deliberately, not a bug. Token metering uses billed tokens; do not "fix" this to
		// input+output. Usage carries no money here: token metering is the only accounting
		// (DES-TOKEN-RESERVE-AND-SETTLE).
		state.total += usage.totalTokens ?? 0;
	});

	return { state, unsubscribe };
}
