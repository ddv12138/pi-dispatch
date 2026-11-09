import assert from "node:assert/strict";
import { test } from "node:test";
import { attachSessionMeter } from "../src/token-budget.mjs";

/**
 * A stand-in for AgentSession reproducing the property the meter depends on: `_emit` is a synchronous
 * unawaited loop. Mirrors turn-budget.test.mjs's fake so both are verified against the same session contract.
 */
function fakeSession() {
	const listeners = [];
	const session = {
		aborted: false,
		abortCalls: 0,
		subscribe(listener) {
			listeners.push(listener);
			return () => listeners.splice(listeners.indexOf(listener), 1);
		},
		async abort() {
			session.abortCalls += 1;
			session.aborted = true; // sync, before any await -- as pi does
			await Promise.resolve();
		},
		emit(event) {
			for (const l of listeners) l(event); // sync, unawaited -- as pi does
		},
	};
	return session;
}

/** A turn_end event carrying an assistant message with the given usage, as pi emits (0.80.7 and 0.99.1). */
function turnEnd(usage) {
	return { type: "turn_end", message: { role: "assistant", usage } };
}

const usage = ({ input = 0, output = 0, total = input + output }) => ({
	input,
	output,
	totalTokens: total,
});

test("accumulates usage across turns and never aborts (metering only, no cap)", () => {
	const session = fakeSession();
	const meter = attachSessionMeter(session);

	session.emit(turnEnd(usage({ input: 100, output: 20 })));
	session.emit(turnEnd(usage({ input: 200, output: 30 })));

	assert.equal(meter.state.input, 300);
	assert.equal(meter.state.output, 50);
	assert.equal(meter.state.total, 350);
	assert.equal(session.aborted, false);
	assert.equal(session.abortCalls, 0);
});

test("a large usage total never stops a job: there is no cap", () => {
	const session = fakeSession();
	const meter = attachSessionMeter(session);
	for (let i = 0; i < 10; i++) session.emit(turnEnd(usage({ input: 1_000_000_000, output: 1_000_000_000 })));
	assert.ok(meter.state.total > 1e10);
	assert.equal(session.aborted, false, "no token amount can abort the session");
	assert.equal(session.abortCalls, 0);
});

test("has no abort surface at all", () => {
	const meter = attachSessionMeter(fakeSession());
	assert.deepEqual(Object.keys(meter.state).sort(), ["input", "output", "total"]);
	assert.equal(typeof meter.unsubscribe, "function");
});

test("accumulates on turn_end only -- agent_end must not double-count", () => {
	const session = fakeSession();
	const meter = attachSessionMeter(session);
	const message = { role: "assistant", usage: usage({ input: 100, output: 50 }) };
	session.emit({ type: "turn_end", message });
	// agent_end carries the same messages[] as a terminal snapshot; accumulating it would double.
	session.emit({ type: "agent_end", messages: [message] });
	session.emit({ type: "message_update", message });
	assert.equal(meter.state.total, 150);
});

test("ignores turn_end without assistant usage", () => {
	const session = fakeSession();
	const meter = attachSessionMeter(session);
	session.emit({ type: "turn_end", message: { role: "tool", usage: usage({ input: 999 }) } });
	session.emit({ type: "turn_end", message: { role: "assistant" } }); // no usage
	session.emit({ type: "turn_end" }); // no message
	assert.equal(meter.state.total, 0);
	assert.equal(meter.state.input, 0);
});

test("unsubscribe stops accumulation", () => {
	const session = fakeSession();
	const meter = attachSessionMeter(session);
	session.emit(turnEnd(usage({ input: 10 })));
	meter.unsubscribe();
	session.emit(turnEnd(usage({ input: 10 })));
	assert.equal(meter.state.total, 10);
});
