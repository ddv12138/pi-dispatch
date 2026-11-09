/**
 * The worker's fixed forge-comment sentences, one leaf module (issue #710, `INT-REASON-CATALOG`).
 *
 * WHY THEY LIVE HERE AND NOT BESIDE THEIR CALL SITES. Each table used to sit in the module that posts it (the processor,
 * the wiring in start.mjs, the pickup gate in index.mjs), and #710's reason catalog
 * (reason-catalog.mjs) is built FROM them, never from a copy, so it must import them. Importing those modules would pull
 * the whole job path into everything that explains a reason: the operator console and the `/dispatch` panel bundle the
 * catalog, and the processor alone drags in pi-ai's provider tables, index.mjs a BullMQ worker, start.mjs every forge
 * client. So the tables moved here, to a module that imports only reason constants from modules those surfaces already
 * load, and every module that posts one imports it from here and re-exports it under its old name, so no import changed.
 *
 * THE RULE FOR EVERY ENTRY, unchanged by the move: a FIXED sentence, path-free, naming no model, size, project, secret
 * name or anything a payload or a container wrote, because a forge comment's reader may be an issue author and a local
 * job's comment lands in a service log. A comment that must carry a runtime value (a wait profile, an image ref, a cap's
 * numbers) stays a template at its call site, and the catalog holds a general sentence for its reason instead.
 *
 * Moving a sentence here never changes its bytes: the comment tests compare what was posted against these exports, and
 * the catalog's own test holds each derived sentence identical (===) to the entry it came from.
 */

import { EXIT_OOM_KILLED } from "./run-history.mjs";

// ── The processor's (worker/src/processor.mjs re-exports every name) ────────────────────────────────────────────────────

// The post-spend terminal comments (issue #288). Every FREE refusal above the container already comments;
// these are the paths where money was spent and the run still ended without the agent's own status step,
// which used to tell the issue nothing (REQ-JOB-STATUS-COMMENTS' acceptance -- "exactly one completion or
// failure comment" -- held only below the spend line). Keyed by the reason token so a new abort
// classification adds a ROW here, never a re-plumb; sentences are FIXED and path-free, because for a
// local job the adapter logs the full text into a persistent service log (the "this folder" discipline
// at the token-budget refusal). The completed path stays silent on purpose: exit 0 is where the AGENT'S own
// status comment lives (the prompt contract instructs it, including for "I cannot fix this"), and exit 2
// by construction means the agent was cut off before that step.
// EXPORTED only so a test can hold every RUNNER_POLICY_REASONS member to a row here (issue #437 review).
export const MODEL_AGENTS_INVALID_COMMENT = "Refused: the base commit's agent definitions are invalid. Fix their frontmatter and retry. Not run.";

export const TERMINAL_COMMENTS = {
	"question-group-refused": "Stopped: the reviewed grouping model or private input could not be used. Check Zero touch status. Not retried.",
	"question-group-unanswered": "Stopped: the classifier returned no confident grouping. Check Zero touch status. Not retried.",
	"model-roles-invalid": "Stopped: the job image could not read its reviewed model roles and agent definitions. Rebuild the image and check its job inputs. Not retried.",
	"model-roles-shadowed": "Stopped: another extension registered the reserved subagent tool, so reviewed model role resolution cannot be guaranteed. Remove the conflicting extension. Not retried.",
	"worker-abort": "Stopped: the worker ended this run before it finished (the 30-minute job limit, or a worker shutdown). Partial work may exist. Not retried.",
	"operator-cancel": "Stopped: the operator cancelled this run. Partial work may exist. Not retried.",
	"agent-cancel": "Stopped by a delegated agent. Partial work may exist. Not retried.",
	"answer-draft-refused": "Stopped: the restricted draft job refused its configuration or inputs. No answer was sent. Not retried.",
	"runner-policy": "Stopped: the run ended inside the container before finishing (a turn or token budget, or an in-container configuration refusal). Partial work may exist. Not retried.",
	// Issue #437. Names the cause but never the provider's own message, which may echo a key fragment. "Or
	// access" because a 403 is as often a key that works but may not use this model or route as a bad key.
	"provider-auth-refused": "Stopped: the AI provider refused this worker's credentials or access (an authentication or permission error). The operator needs to check the provider key and what it is allowed to use. Not retried.",
	// Issues #501, #502. The two stops name the policy, never the amount or the model: both are operator
	// configuration, and the comment's reader may be an issue author who can act on neither.
	"model-not-allowed": "Stopped: the run tried to call an AI model this trigger does not allow, or to change an AI request in a way it does not allow, so the call was not made. Partial work may exist. Not retried.",
	"model-policy-unenforceable": "Stopped: this run is limited to certain AI models, and the job image could not enforce that before each AI call, so nothing was sent to the AI provider. The operator needs to update the job image. Not retried.",
	// The runner's refusals of the job's MCP servers, each before the prompt. Never the server's name, its host or a
	// variable: the exit line carries the name and the cause in its message, which the worker never parses (it reaches
	// the worker's log as the container's output). Each says what the operator can check; the issue's author can act on
	// none of it.
	"mcp-unavailable": "Stopped: an MCP server this trigger names could not be used (it did not start, failed its handshake or refused the connection, an authentication error among them), so the run ended before the agent started. The operator needs to check that server and the job image. Not retried.",
	"mcp-config-invalid": "Stopped: the list of MCP servers the worker wrote for this job is not one the job image accepts, so the run ended before the agent started. The operator needs to run a worker and a job image of the same release. Not retried.",
	"mcp-config-mismatch": "Stopped: the MCP servers the worker wrote for this job are not the ones it named for it, so the run ended before the agent started. The operator needs to run a worker and a job image of the same release. Not retried.",
	"mcp-secret-missing": "Stopped: a credential an MCP server this trigger names needs was not set inside the job, so the run ended before the agent started. The operator needs to check the secrets this trigger passes. Not retried.",
	"mcp-command-missing": "Stopped: the job image does not have the program an MCP server this trigger names runs, so the run ended before the agent started. The operator needs to install that server in the job image or the overlay. Not retried.",
	"mcp-shadowed": "Stopped: another extension in this job registers a tool or command that only the job's MCP servers may, so the run ended before the agent started. The operator needs to remove that extension or this trigger's MCP servers. Not retried.",
	// Issue #625. The runner's two refusals of a job armed with run.awaitInput, each before the prompt.
	"await-input-shadowed": "Stopped: another extension in this job registers the tool a run uses to stop and wait for an answer, so the run ended before the agent started. The operator needs to remove that extension or this trigger's run.awaitInput. Not retried.",
	"await-input-without-session": "Stopped: this run may stop to wait for an answer but had nowhere to keep its work, so it ended before the agent started. The operator needs to run a worker and a job image of the same release. Not retried.",
	// Issue #644. The runner's refusal of a job armed with run.progress, before the prompt.
	"report-progress-shadowed": "Stopped: another extension in this job registers the tool a run uses to report its progress, so the run ended before the agent started. The operator needs to remove that extension or this trigger's run.progress. Not retried.",
	// Issue #646. The runner's two refusals of a job armed with run.steer, each before the prompt. Both are a worker and
	// image mismatch (the worker arms steering only with the inbox mount and an exit key), so both name that fix.
	"steer-inbox-missing": "Stopped: this run may receive messages while it works but could not read where they arrive, so it ended before the agent started. The operator needs to run a worker and a job image of the same release. Not retried.",
	"steer-no-exit-key": "Stopped: this run may receive messages while it works but had no key to confirm their delivery with, so it ended before the agent started. The operator needs to run a worker and a job image of the same release. Not retried.",
	// Issue #596. Never the size or the project: both are operator configuration, and the reader may be an issue author
	// who can act on neither. The worker log and the run record carry them.
	[EXIT_OOM_KILLED]: "Stopped: the job's container ran out of memory and was stopped. Partial work may exist. Not retried, because the same size would stop the same way. The operator can raise this job's memory size.",
};

// Issue #625: the one comment the COMPLETED path posts, on a run that ended awaiting-input. The agent posted its own
// question (the tool tells it to, before it ends); this says how the run continues. Fixed and path-free, the
// TERMINAL_COMMENTS rule, and it carries no model text: the question never crosses the exit line.
// On an issue any reply continues it (the receiver routes it on the marker); a pull request's reply keeps the phrase,
// since its session key needs a head branch that costs a token to read (parked.mjs).
export const PARKED_COMMENT = "This run stopped to wait for an answer to the question above. Reply here, and the next run continues from here.";
export const PARKED_COMMENT_PR = "This run stopped to wait for an answer to the question above. Reply in a comment that starts with this repository's pi-dispatch comment phrase, and the next run continues from here.";
export function parkedComment(target) {
	return target?.type === "pull_request" ? PARKED_COMMENT_PR : PARKED_COMMENT;
}
// Issue #638: the park's comment when a reply that arrived while the run was parking was taken as its answer (the
// held reply, held-settle.mjs), so the resumed run is already queued and "Reply here" would invite a second answer to
// a question that has one. One sentence for an issue and a pull request alike: it says how the run continues, never
// how to reply. Fixed words, no quote of the reply, no mention.
export const HELD_TAKEN_COMMENT = "The run had asked a question and took the reply above as the answer, so it continues from here.";

// Issue #502: the `model-unknown` refusal's comment. Names no model: the reader may be an issue author.
export const MODEL_UNKNOWN_COMMENT = "Refused: this job names an AI model that this deployment does not know (it is in neither pi's model catalog nor the overlay models.json), so no container was started and nothing was spent. Ask the operator to check the trigger's model settings. Not run.";

// The `model-unknown` refusal whose `why` is `overlay-*` (PR #558, the end-of-round check of #501 and #502): the deployment's overlay
// models.json is the problem, not the job's model, so the generic text above would send the author to the wrong
// place. Fixed text naming no path and no model; the operator finds which file and why in the worker log.
export const OVERLAY_REFUSED_COMMENT = "Refused before starting: the deployment's model settings file (models.json in the overlay) cannot be used for this job, so no container was started and nothing was spent. The operator needs to fix that file. Not run.";
/**
 * Which of the two a `model-unknown` refusal posts: the overlay's when its `why` names the overlay (`overlay-*`). One rule
 * for the processor and the reason catalog.
 */
export function modelUnknownComment(why) {
	return typeof why === "string" && why.startsWith("overlay-") ? OVERLAY_REFUSED_COMMENT : MODEL_UNKNOWN_COMMENT;
}

// Issue #341: the forge comments for a `job-user-unmappable` refusal, keyed by cause. Shorter than the operator
// texts in job-user.mjs on purpose: a comment's reader may be an issue author, who can act on none of it.
export const JOB_USER_COMMENTS = Object.freeze({
	default: "Refused: the worker host's container runtime cannot give this job a non-root user that can read and write its own files. Not run.",
	"runtime-unreadable": "Refused: the worker host's container runtime answered in a form the worker cannot read, so which user this job may run as is unknown. Not run.",
});

/**
 * The comments of the durable-run refusals. Fixed and path-free, the TERMINAL_COMMENTS rule: the reader may be an issue
 * author, and which file or which pi version is the operator's to read in the worker log.
 */
export const RECOVERY_COMMENTS = Object.freeze({
	"recover-store-unset": "Refused: this trigger set `run.recover`, but this worker has no checkpoint store (neither PI_CHECKPOINTS_DIR nor PI_SESSIONS_DIR is set), so a lost run could not be continued while the job would still report success. Set one of them, or drop `run.recover` from this trigger. Not run.",
	"recovery-unsafe-extensions": "Failed: this run was lost, and it is not continued from its checkpoint because the repository's `.pi/extensions/` could load code the agent wrote. Partial work may exist. Ask the operator to check the worker log.",
	"recovery-failed": "Failed: this run was lost, continued from its checkpoint, and the continuation was lost too, so it is not continued again. Partial work may exist. Ask the operator to check the worker log.",
	"recovery-cap": "Failed: this run was lost and continued from its checkpoint as many times as allowed, so it is not continued again. Partial work may exist. Ask the operator to check the worker log.",
	"recovery-checkpoint-absent": "Failed: this run was lost, and its checkpoint could not be used to continue it (absent, damaged, or taken on another host, pi version or venue). Partial work may exist. Ask the operator to check the worker log.",
});

/** The public comments of the bundle refusals (issue #704). Fixed text: no bundle id, profile, variable or path. */
export const BUNDLE_COMMENTS = Object.freeze({
	"secret-bundle-trigger-changed": "Refused: this job's project has a secret bundle, and the trigger that queued this job is no longer in the triggers file as it was, so whether it opted out of the bundle is unknown. Re-run it from the current trigger. Not run.",
	"secret-bundle-resume": "Refused: this trigger sets `run.resume`, and the job's project has a secret bundle. A resumed job replays a transcript kept on host disk, and anything the agent echoed from the bundle would be prefilled into every later job on that key. Set `\"secretBundle\": false` on this trigger, or drop `run.resume`. Not run.",
	"secret-bundle-profile-unknown": "Refused: this job's project has a secret bundle, and the bundle resolver profile it names is not usable on this worker host. No profile of that name is declared, or its resolver is absent or not executable. Run `pi-dispatch doctor` on the worker to see which bundle profiles it has. Not run.",
	"secret-bundle-profile-ambiguous": "Refused: this job's project has a secret bundle, and the bundle resolver profile it names is declared twice on this worker host, once in the environment and once in the settings overlay. Neither wins, on purpose. Remove one of the two. Not run.",
	"secret-name-reserved": "Refused: this job's project has a secret bundle, and one of its variables uses a name this deployment already uses for the job's own credentials or configuration. Whichever value reached the container, one would be silently ignored. The worker's log names the variable (`refused_secret_bundle_name_reserved`); rename it in the secrets manager. Not run.",
});

/**
 * Issue #710: the processor's single-sentence pre-start refusals, keyed by the reason the record carries. These were
 * inline literals at their call sites; they moved into named tables so the reason catalog can read them, and each call
 * site posts the table's entry, so the comment is byte-identical to what it posted before.
 */
export const REFUSAL_COMMENTS = Object.freeze({
	"sessions-dir-unset": "Refused: this trigger set `run.resume` but PI_SESSIONS_DIR is unset, so there is nowhere to persist the transcript -- the job would run with no session and still report success. Set PI_SESSIONS_DIR to a private directory outside every repo, or drop `run.resume` from this trigger. Not run.",
	"skills-dir-missing": "Refused: this trigger set `run.skillsDir`, and that path is absent or is not a directory on the worker host. The job would have run without the skills the flow was written against. Not run.",
	"secret-profile-unknown": "Refused: this trigger set `run.secrets`, and the resolver profile it names is not usable on this worker host. No profile of that name is declared, or its resolver is absent or not executable. The job would have started with those variables unset, and an agent that gets a 401 writes a plausible report and exits 0. Run `pi-dispatch doctor` on the worker to see which profiles it has. Not run.",
	"secret-profile-ambiguous": "Refused: this trigger set `run.secrets`, and the resolver profile it names is declared twice on this worker host, once in the environment and once in the settings overlay. Neither wins, on purpose: the job would otherwise run against whichever one happened to be picked. Remove one of the two. Not run.",
	"unprotected-branch": "Refused: the default branch is not protected. See SECURITY.md.",
	"local-folder-project-changed": "Refused: this job's folder now leads into another project's folder, so no container was started and nothing was spent. Not run.",
	"config-refused": "Refused: this deployment is misconfigured, so the job could not be started. Ask the operator to run `pi-dispatch doctor`. Not run.",
});

/**
 * The two `model-not-allowed` refusals before starting: the main model off the job's list, or a listed model's fallback
 * off it (the record's `why` is then `fallback-unlisted`).
 */
export const MODEL_NOT_ALLOWED_COMMENTS = Object.freeze({
	main: "Refused: the AI model this job would run on is not on the list of models it is allowed to use, so no container was started and nothing was spent. Ask the operator to check the trigger's model settings. Not run.",
	"fallback-unlisted": "Refused: a model this job is allowed to use declares fallback models that are not on the job's list, so no container was started and nothing was spent. Ask the operator to list those models too, or remove that model. Not run.",
});

/** A venue's own refusal that came with no sentence of its own (`venueRefused` without a comment). */
export const VENUE_REFUSED_COMMENT = "Refused: this job's venue cannot run it on this host right now. Not run.";
/** The same, for a venue's refusal of the project's secret bundle. */
export const VENUE_BUNDLE_REFUSED_COMMENT = "Refused: this job's venue cannot hold its project's secret bundle as declared. Not run.";

/**
 * The reason a job retried for the egress proxy's rootless network keeper carries (issue #458, PR #463 round 2): a
 * fixed token, as every run-record reason is, and the key the terminal comment is chosen by.
 */
export const NETNS_KEEPER_NOT_HOLDING = "netns-keeper-not-holding";
/** Issue #476: a job held on a young keeper that kept restarting, or stayed young past the hold's bound. */
export const NETNS_KEEPER_CRASH_LOOP = "netns-keeper-crash-loop";

// ── The wiring's terminal failures (worker/src/start.mjs; once locals of its wiring function) ───────────────────────────

// The infra-terminal sentence (issue #288). FIXED, never err.message: the message classes that reach
// a failedReason carry host paths and library words (the #310 record), and for a local job this text
// lands verbatim in the service log through the adapter's stdout fallthrough. The worker log already
// holds the truncated reason on the job_failed line beside it.
export const FAILED_COMMENT = "Failed: an error stopped this job and it will not be retried further. Ask the operator to check the worker log.";
// Issue #458 (PR #463 round 2): a job that never started because the podman venue's rootless network keeper did not
// hold says so, since the generic line sends an operator to a log that only says the job failed. Fixed text keyed by
// the fixed reason token, never the error's own words: a forge comment carries nothing a host read produced.
export const FAILED_COMMENT_BY_REASON = Object.freeze({
	// Neutral on the cause (PR #463 round 3): a keeper that is not running and a proxy that must restart after it both land here.
	[NETNS_KEEPER_NOT_HOLDING]: "Failed before it started: this worker's rootless Podman egress proxy did not pass its pre-start check (its rootless network keeper, pi-dispatch-netns-keeper), so the job was retried and never run. Nothing was spent. Ask the operator to run `pi-dispatch doctor` on the worker for the exact fix.",
	// Issue #476: a job held on a young keeper that kept restarting while it waited.
	[NETNS_KEEPER_CRASH_LOOP]: "Failed before it started: this worker's rootless network keeper (pi-dispatch-netns-keeper), which its Podman egress proxy needs, kept restarting while the job waited for it, so the job was retried and never run. Nothing was spent. Ask the operator to run `pi-dispatch doctor` on the worker and read the keeper's log (`journalctl --user -u pi-dispatch-netns-keeper.service`).",
});

// Issue #645: a recovery that waited past its deadline for the host holding its run's checkpoint, taken back off the
// queue by the host-lost sweep. Fixed text, like every failure sentence here. It says what happened and what is lost
// (the work since the run's start is on that host, not gone), and sends the operator to the host, the one fix.
export const RECOVERY_HOST_LOST_COMMENT = "Failed: this run stopped on a worker that has not come back, and its checkpoint lives on that worker, so it could not be continued and will not be retried further. Ask the operator to check that worker, then run the job again.";

// ── The pickup gate's (worker/src/index.mjs re-exports both names) ──────────────────────────────────────────────────────

/**
 * The forge comments for the two never-fits refusals (issue #596, phase 2). GENERIC on purpose: never the size, the
 * budget or the project, which are operator configuration an issue author can act on none of. The worker log, the run
 * record and doctor name both sizes. There is no fleet refusal (gate round 1 of phase 2): a job on the shared
 * queue waits for a host it fits on.
 */
export const SIZE_REFUSAL_COMMENTS = Object.freeze({
	"job-size-exceeds-host": "Refused: this job's size is larger than the worker host's job budget, so it could never start there. No container was started and nothing was spent. Ask the operator to lower this project's job size or raise the host budget. Not run.",
	"job-size-exceeds-share": "Refused: this job's size is larger than the share of the worker host's job budget its project may use, so it could never start there. No container was started and nothing was spent. Ask the operator to lower this project's job size or raise its host share. Not run.",
});

/** The comment for a job the operator cancelled before it started, where it would have been held or retried (gate of PR #479). */
export const CANCELLED_BEFORE_START_COMMENT = "Stopped: the operator cancelled this run before it started. Nothing was spent. Not retried.";

// Issue #649: all approval sentences are fixed; human summaries and reasons stay in the private session/store.
export const APPROVAL_COMMENTS = {
	"awaiting-approval": "Approval requested. Reply /approve, /decline followed by an optional reason, or ask a question. Only an authorized reply can continue the saved run.",
	"approval-config-invalid": "Stopped: the approval gate configuration is invalid. Check the trigger declarations and rebuild a matching worker and job image. Not retried.",
	"approval-without-session": "Stopped: approval gates need a persisted session. Check the session store and job image. Not retried.",
	"approval-shadowed": "Stopped: another extension registered the reserved approval tool. Remove the conflicting registration and run again. Not retried.",
	"approval-decision-invalid": "Stopped: the decision does not match the parked tool result. Check the retained session and request before starting another run. Not retried.",
	"approval-author-missing": "Refused: this approval reply has no authorized actor identifier. Reply through an authenticated operator surface or the forge. Not run.",
	"approval-expired": "Refused: this approval expired. Its durable decline is continued by the expiry job. Not run.",
	"approval-expiry-invalid": "Refused: the expiry job does not match a durable system decline. Check the approval store. Not run.",
	"approval-host-mismatch": "Refused: the saved approval session belongs to another worker host. Route the reply to that host. Not run.",
	"approval-job-id-missing": "Refused: the approval continuation has no queue identifier. Check the worker wiring. Not run.",
	"approval-park-invalid": "The approval request did not match a declared gate and saved session. No approval is armed. Check the runner and trigger declaration.",
	"approval-pending": "Refused: this run is waiting for an approval decision. Approve, decline, or ask a question before starting more work. Not run.",
	"approval-policy-changed": "Refused: the approval declaration changed. Start a new authorized run under the current trigger policy. Not run.",
	"approval-policy-unavailable": "Refused: the current approval declaration could not be read. Check the triggers file before trying again. Not run.",
	"approval-request-conflict": "The saved approval request conflicts with this conversation. No new approval is armed. Check the session and durable request.",
	"approval-request-stale": "Refused: this reply names an approval request that is no longer pending. Reload the current request before answering. Not run.",
	"approval-request-unbound": "Refused: this reply is not bound to the pending approval request. Reply again after the approval is published. Not run.",
	"approval-state-conflict": "Refused: the approval was already decided, consumed, or superseded. Check its recorded decision before starting another run. Not run.",
	"approval-state-unavailable": "The approval could not be saved durably. No approval is armed. Check the session store and Valkey before starting another run.",
	"approval-store-unavailable": "Refused: this worker has no durable approval store. Check the worker configuration. Not run.",
	"approval-finish-unavailable": "The approval continuation ended but its durable completion could not be saved. Check Valkey and the request before starting another run.",
	"approval-session-not-saved": "The approval conversation could not be saved. No approval is armed. Check the retained session before starting another run.",
	"approval-session-unavailable": "Refused: the approved session could not be resumed. No approval can be transferred to a new conversation. Check the retained session and its limits.",
	"job-image-approval-gates-unsupported": "Refused: the job image does not declare approval gates. Rebuild the job image with approval support. Not run.",
	"job-image-approval-auth-unsupported": "Refused: approval gates need an image with authenticated runner exits (exitAuth). Rebuild the job image. Not run."
};

for (const reason of ["approval-config-invalid", "approval-without-session", "approval-shadowed", "approval-decision-invalid"]) TERMINAL_COMMENTS[reason] = APPROVAL_COMMENTS[reason];

/**
 * A park the processor could not arm because the live triggers file was written by a newer pi-dispatch (issue #761): the
 * run is complete and paid for, and its record says `approval-policy-unavailable`. A string apart from
 * `APPROVAL_COMMENTS`, which is keyed by reason tokens: this is one more comment for an existing reason, never a reason
 * of its own, and the store comment that path posted before (`approval-state-unavailable`) sent the reader to Valkey.
 */
export const APPROVAL_PARK_NEWER_COMMENT = "No approval is armed: the triggers file was written by a newer pi-dispatch; upgrade this worker.";
