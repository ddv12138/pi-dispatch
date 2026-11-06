import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { TOUCH_CAUSES, WAIT_END_REASONS, TOUCH_MAX_EVENTS, TOUCH_MAX_RETENTION_DAYS } from "../src/touch-state.mjs";
import { QUESTION_GROUP_LIMITS, QUESTION_GROUP_STATUSES } from "../src/question-groups.mjs";
import { validateQuestionGroupingInput } from "../../image/runner/src/question-grouping.mjs";

test("the isolated runner accepts the worker's maximum candidate vocabulary and refuses one more", () => {
	const candidates = Array.from({ length: QUESTION_GROUP_LIMITS.candidates }, (_, i) => ({ slot: `g${i}`, excerpt: `Question ${i}?` }));
	const input = { version: 1, model: { provider: "test", id: "classifier" }, source: "Which package manager?", candidates, confidence: 0.9 };
	assert.equal(validateQuestionGroupingInput(input).candidates.length, QUESTION_GROUP_LIMITS.candidates);
	assert.throws(() => validateQuestionGroupingInput({ ...input, candidates: [...candidates, { slot: `g${candidates.length}`, excerpt: "Too many" }] }));
	assert.throws(() => validateQuestionGroupingInput({ ...input, source: "x".repeat(QUESTION_GROUP_LIMITS.excerptBytes + 1) }));
});
