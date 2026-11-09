/** Managed forks use current trigger policy and immutable run sources, never the target's moving canonical file. */
import { forkBranch, FORK_THINKING_LEVELS } from "@edgehero/pi-dispatch/fork-job";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { modelIdProblem, providerIdProblem, modelOnList } from "@edgehero/pi-dispatch/model-ref";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "@edgehero/pi-dispatch/config";
import { planRerun, enqueueRerun } from "./job-actions.mjs";

/**
 * A value's canonical JSON: object keys sorted at every level, `undefined` members left out. Local because the module
 * that carried it (`priorities.mjs`) went with the allocation it served (C2); the digest it feeds is compared only
 * between this module's preview and pickup, in one process.
 */
function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

const JOB_RE = /^[A-Za-z0-9._:-]{1,200}$/;
const ENTRY_RE = /^[A-Za-z0-9_-]{1,128}$/;
export { FORK_THINKING_LEVELS };

export async function readForkPoints({ jobId, env = {}, now = Date.now, store = null, entry, position, sourceDigest } = {}) {
  if (typeof jobId !== "string" || !JOB_RE.test(jobId)) return { refusal: "fork-source-invalid-run" };
  if (!store) {
    if (!env.PI_SESSIONS_DIR) return { refusal: "fork-source-store-unset" };
    const { createForkStore } = await import("@edgehero/pi-dispatch/fork-store");
    store = createForkStore({ dir: join(env.PI_SESSIONS_DIR, ".fork-sources"), now });
  }
  const got = await store[entry ? "readPoint" : "read"]({ runId: jobId, ...(entry ? { entryId: entry, position } : {}), ...(sourceDigest ? { sourceDigest } : {}) });
  if (!got.ok) return { refusal: got.refused ?? "fork-source-unavailable" };
  if (got.manifest.venue === "openshell") return { refusal: "openshell-fork-unsupported" };
  return got;
}

/** Preview and pickup validate separately: a ticket must not freeze privileges the trigger has since withdrawn. */
export async function planRunFork({ jobId, entry, position = "before", provider, model, thinking, message, forkId, sourceDigest, ...deps } = {}) {
  if (typeof entry !== "string" || !ENTRY_RE.test(entry)) return { refusal: "fork-entry-invalid" };
  if (position !== "before" && position !== "at") return { refusal: "fork-position-invalid" };
  if (provider != null && provider !== "" && providerIdProblem(provider)) return { refusal: "fork-provider-invalid" };
  if (model != null && model !== "" && modelIdProblem(model)) return { refusal: "fork-model-invalid" };
  if (thinking != null && thinking !== "" && !FORK_THINKING_LEVELS.includes(thinking)) return { refusal: "fork-thinking-invalid" };
  if (message != null && (typeof message !== "string" || Buffer.byteLength(message, "utf8") > 16_384 || message.includes("\0"))) return { refusal: "fork-message-invalid" };
  const source = await (deps.readSource ?? readForkPoints)({ jobId, entry, position, sourceDigest, env: deps.env, now: deps.now, store: deps.store });
  if (!source.ok) return source;
  const got = await (deps.planRerunFn ?? planRerun)({ ...deps, jobId });
  if (!got.plan) return got;
  const p = got.plan;
  if (p.kind !== "forge" || p.job?.target?.type !== "issue") return { refusal: "fork-target-unsupported" };
  if (p.job.replica !== undefined || p.job.replicas !== undefined) return { refusal: "fork-replicas-unsupported" };
  if (p.job.awaitInput === true) return { refusal: "fork-await-input-unsupported" };
  const id = forkId ?? (deps.random ?? randomBytes)(16).toString("hex");
  if (!/^[0-9a-f]{32}$/.test(id)) return { refusal: "fork-id-invalid" };
  // The paid preview names one model. Freeze it in both queue data and the confirmation request so a later
  // settings change cannot substitute another model between the preview, confirm and worker pickup.
  const effectiveProvider = provider || p.job.provider || deps.overlay?.provider || deps.env?.PI_PROVIDER || DEFAULT_PROVIDER;
  const effectiveModel = model || p.job.model || deps.overlay?.model || deps.env?.PI_MODEL || DEFAULT_MODEL;
  const job = { ...p.job, provider: effectiveProvider, model: effectiveModel, ...(thinking ? { thinkingLevel: thinking } : {}), fork: { id, fromJob: jobId, fromEntry: entry, position, sourceDigest: source.manifest.sourceDigest, rootKey: source.manifest.sessionKey, ...(message ? { message } : {}) } };
  const checkPolicy = deps.policyDigestFn ?? (await import("@edgehero/pi-dispatch/fork-policy")).forkPolicyDigest;
  const policy = await checkPolicy({ triggersPath: deps.triggersPath, job: { ...job, kind: p.forge }, fs: deps.fs });
  if (!policy.ok) return { refusal: policy.refused ?? "fork-policy-unavailable" };
  job.forkPolicy = policy.digest;
  const allowed = job.models ?? (deps.env?.PI_ALLOWED_MODELS ? deps.env.PI_ALLOWED_MODELS.split(",") : null);
  if (!modelOnList(allowed, effectiveProvider, effectiveModel)) return { refusal: "model-not-allowed" };
  const queue = source.manifest.hostQueue ?? p.queue;
  const request = { jobId, entry, position, provider: effectiveProvider, model: effectiveModel, ...(thinking ? { thinking } : {}), ...(message ? { message } : {}), forkId: id, sourceDigest: source.manifest.sourceDigest };
  return { plan: { ...p, queue, branch: forkBranch(job), job, request, sourceDigest: source.manifest.sourceDigest, policyDigest: policyDigest(job), runFields: { ...p.runFields, model: effectiveProvider && effectiveModel ? `${effectiveProvider}/${effectiveModel}` : effectiveModel } } };
}

function policyDigest(job) {
  const { fork, trigger, ...policy } = job;
  return createHash("sha256").update(canonicalJson({ ...policy, trigger: { ...trigger, deliveryId: null } })).digest("hex");
}

export async function enqueueRunFork(plan, deps = {}) {
  if (!plan?.request || !plan?.job?.fork) return { refusal: "not a fork plan" };
  const checked = await (deps.planForkFn ?? planRunFork)({ ...deps, ...plan.request });
  if (!checked.plan) return checked;
  if (checked.plan.policyDigest !== plan.policyDigest || checked.plan.queue !== plan.queue) return { refusal: "the trigger or fork destination changed since the preview; preview again" };
  return (deps.enqueueFn ?? enqueueRerun)(plan, deps);
}
