import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";

export const APPROVAL_ACTION_RE = /^[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)?$/;
export const APPROVAL_DECISIONS = Object.freeze(["approved", "declined", "question"]);
const UNSUPPORTED = new Set(["push", "push-default-branch", "pr-open", "open-pr", "merge", "approve"]);
const hash = (value) => createHash("sha256").update(value).digest("hex");

/** An action name declares policy; it cannot give a container a new forge permission. */
export function validateApprovalConfig(run) {
	const present = ["gates", "gateTimeout", "gateBudgetRaiseTokens"].some((key) => run[key] !== undefined);
	if (!present) return {};
	// The budget-raise gate and its token field went with the token budgets: refused BY NAME, never silently dropped,
	// because a trigger that still declares one must not read as enforcing a budget this build no longer has.
	if (run.gateBudgetRaiseTokens !== undefined) throw new TypeError("run.gateBudgetRaiseTokens was retired with the token budgets; remove it (an approval no longer raises a token budget)");
	if (Array.isArray(run.gates) && run.gates.includes("budget-raise")) throw new TypeError('the "budget-raise" gate was retired with the token budgets; remove it from run.gates');
	if (!Array.isArray(run.gates) || run.gates.length === 0 || run.gates.length > 32 || run.gates.some((gate) => typeof gate !== "string" || gate.length > 80 || !APPROVAL_ACTION_RE.test(gate) || UNSUPPORTED.has(gate)) || new Set(run.gates).size !== run.gates.length) throw new TypeError("run.gates must contain 1 to 32 distinct action tokens; push, PR opening and merge gates have no supported enforcement boundary");
	if (run.resume !== true || run.kind === "local" || run.command !== undefined || run.replicas !== undefined || run.recover === true) throw new TypeError("run.gates requires a resumable forge flow without replicas or recovery");
	if (run.awaitInput === false) throw new TypeError("run.gates cannot disable run.awaitInput");
	if (run.gateTimeout !== undefined && (!Number.isSafeInteger(run.gateTimeout) || run.gateTimeout < 1 || run.gateTimeout > 365)) throw new TypeError("run.gateTimeout must be an integer number of days from 1 to 365");
	return { gates: [...run.gates], ...(run.gateTimeout !== undefined ? { gateTimeout: run.gateTimeout } : {}) };
}

export function approvalConfigDigest(run) {
	return hash(JSON.stringify({ gates: run.gates, gateTimeout: run.gateTimeout ?? null }));
}

/**
 * Free live-file check: a queued decision cannot keep a declaration an operator removed. `{ ok, digest }`, a
 * `{ refused }` reason, or `{ newer: true }` when the file was written by a newer pi-dispatch (issue #761): the
 * loader's `parseTriggers` throws a configError marked `.newer` then, and the caller defers the job for an upgrade
 * rather than refuse a decision over a file this build cannot read. Read through the injected loader, not a second
 * version check here, so the rule stays the loader's one (and this leaf stays free of an import cycle with it).
 */
export function makeCheckApprovalPolicy({ triggersPath, parseTriggers, fs = nodeFs }) {
	return (job) => {
		try {
			const index = job?.trigger?.matched?.index;
			const entries = parseTriggers(fs.readFileSync(triggersPath, "utf8"), triggersPath);
			const entry = entries[index];
			if (!entry || entry.run.kind !== job.kind || entry.on.type !== job.trigger.matched.type || !entry.run.gates || entry.run.resume !== true || approvalConfigDigest(entry.run) !== approvalConfigDigest(job)) return { refused: "approval-policy-changed" };
			return { ok: true, digest: approvalConfigDigest(entry.run) };
		} catch (error) {
			if (error?.newer === true) return { newer: true };
			return { refused: "approval-policy-unavailable" };
		}
	};
}

export function approvalReply(text, { phrase } = {}) {
	let value = typeof text === "string" ? text.trim() : "";
	if (typeof phrase === "string" && phrase.length > 0 && value.startsWith(phrase) && (value.length === phrase.length || /\s/.test(value[phrase.length]))) value = value.slice(phrase.length).trimStart();
	if (/^\/approve\s*$/.test(value)) return { decision: "approved", text: "" };
	const declined = /^\/decline(?:\s+([\s\S]*))?$/.exec(value);
	// The private store bounds UTF-8 bytes and refuses oversized replies. Cutting here would accept a decision whose
	// explanation is not the one the person sent, and would hide the overflow from that validator.
	if (declined) return { decision: "declined", text: declined[1] ?? "" };
	return { decision: "question", text: value };
}

export function approvalActor(job) {
	if (job.console?.by) return { kind: job.console.by === "panel" ? "panel" : "operator", id: hash(job.console.by) };
	const id = job.trigger?.sender?.id;
	return typeof id === "number" && Number.isSafeInteger(id) && id > 0 || typeof id === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(id) ? { kind: "forge", id: hash(String(id)) } : null;
}

export function approvalRequestId(runId, toolCallId) { return hash(`${runId}\0${toolCallId}`); }

/** Public audit shape: text and display names have no path into a record. */
export function approvalAudit(request) {
	return {
		requestId: request.requestId,
		action: request.action,
		...(request.decision ? { decision: request.decision.decision, actorKind: request.decision.actor.kind, actorId: request.decision.actor.id, decidedAt: request.decision.at } : {}),
	};
}
