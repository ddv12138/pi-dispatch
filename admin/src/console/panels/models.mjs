import { modelsSubscriptionQuota } from "./subscription-auth.mjs";
/** Models is an operational read. Every write uses the person-only role action and the shared confirm pipeline. */
import { html } from "../html.mjs";
import * as ui from "../kit.mjs";
import { uiText } from "../locale.mjs";
import { modelChoiceSentence, providerFailureWords } from "../../model-words.mjs";

export const MODELS_WORDS = Object.freeze({
  unreadable: "Models could not be read. Reload after checking the triggers file and pi-dispatch doctor; missing data is not an empty deployment.",
  agents: "Repository agents may name roles, but their declarations are not readable here.",
  noScript: "Enable JavaScript to preview and confirm a change. Facts, links and Reload work without it.",
  next: "This order checks price and cooldown only. The worker still checks credentials, egress, dollar windows and endpoint room at pickup; a shown candidate may be unable to start.",
  possibleProject: "Possible project scope: this local folder could not be resolved here. The owning worker resolves its actual project at pickup.",
  lease: "Run this command on the host. Its deployment lease holds every other start. One flow, at most 10 runs.",
});
const array = (v) => Array.isArray(v) ? v : [];
const model = (view) => view?.data?.models ?? { state: "unreadable", roles: [], models: [], cooldowns: [], proposals: [], canaries: [], banners: [], waiting: [], recentFallbacks: [] };
const acts = (view) => view?.role === "operator" && !view?.readOnly;
const code = (text) => html`<span class="code md-ref">${text}</span>`;
const t = (text, view) => uiText(text, view?.locale);
const amount = (v) => Number.isFinite(v) ? new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(v) : "Not known";
const usd = (v) => Number.isFinite(v) ? `$${v.toFixed(2)}` : "Not known";
const micros = (v) => Number.isFinite(v) ? usd(v / 1e6) : "Not known";
const scopeWord = (s, view = {}) => s === "default" ? t("Default", view) : `${t("Project", view)} ${s}`;
const rowLink = (row, view = {}) => html`<a class="link" href="${`/config/trigger?index=${row.index}`}">${t("Row", view)} ${row.number ?? row.index + 1}</a>`;
const runLink = (id) => html`<a class="link code md-ref" href="${`/run?id=${encodeURIComponent(id)}`}">${id}</a>`;
function utc(v) { return Number.isFinite(v) && v >= 0 && v <= 8640000000000000 ? new Date(v).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC") : "Not known"; }
function empty(m, sentence, view = {}) { return html`<p class="md-foot">${t(m.state === "unreadable" ? "This source is unavailable. Reload to try again." : sentence, view)}</p>`; }
function fallbackRefs(role) { return array(role.fallbackModels).map((item) => typeof item === "string" ? item : item.ref); }
function field(id, name, label, value, hint = null, required = false) {
  return ui.field({ id, label, hint, control: html`${ui.input({ id, name, value, code: true, required, ...(hint ? { describedBy: `${id}-hint` } : {}) })}<p class="field__err" data-field-error="${name}" hidden role="alert"></p>` });
}
function hidden(name, value, type = null) { return html`<input type="hidden" name="${name}" value="${type === "json" ? JSON.stringify(value) : value}"${type ? html` data-type="${type}"` : null}>`; }
function scopeOptions(m, view = {}) { return [...new Set(["default", ...array(m.scopes), ...array(m.roles).map((r) => r.scope)])].map((s) => ({ value: s, label: scopeWord(s, view) })); }
/** One ordinary role form serves Edit, Add and Adopt. Adoption supplies identity and a server digest, never numbers. */
export function modelRoleForm(m, { role = null, canary = null, key = "new", locale = "en" } = {}) {
  const tr = (s) => t(s, { locale });
  const id = `md-${key}`;
  const scope = role?.scope;
  const roleName = canary?.role ?? role?.role ?? "";
  const candidate = canary?.candidate ?? role?.model ?? "";
  const identity = canary ? { role: canary.role, candidate: canary.candidate, flow: canary.flow, digest: canary.digest } : null;
  const scopes = canary && array(canary.scopes).length ? array(canary.scopes).map((s) => ({ value: s, label: tr(scopeWord(s, { locale })) })) : scopeOptions(m, { locale });
  return html`<form class="act md-form" data-action="model-role-edit" autocomplete="off"><fieldset data-config-controls disabled>${scope ? hidden("scope", scope) : ui.field({ id: `${id}-scope`, label: tr("Scope"), hint: tr(canary ? "Choose which scope adopts this candidate. A canary does not choose it for you." : "Default applies unless a project overrides this role."), control: ui.select({ id: `${id}-scope`, name: "scope", value: "", options: [{ value: "", label: tr("Choose a scope") }, ...scopes], required: true }) })}${role || canary ? html`${hidden("role", roleName)}<p class="md-fixed">${tr("Role")} ${code(roleName)}${scope ? html` ${tr("in")} ${tr(scopeWord(scope))}` : null}</p>` : field(`${id}-role`, "role", tr("Role"), "", tr("A free role name, at most 16 roles per scope."), true)}${field(`${id}-model`, "model", tr("Model"), candidate, tr("Use provider/model. The preview verifies the configured catalog."), true)}<div class="field"><label for="${`${id}-fallbacks`}">${tr("Fallbacks, in order")}</label><input class="input input--code" id="${`${id}-fallbacks`}" name="fallbackModels" data-type="list" value="${canary ? "" : fallbackRefs(role ?? {}).join(", ")}" aria-describedby="${`${id}-fallbacks-hint`}"><p class="field__hint" id="${`${id}-fallbacks-hint`}">${tr("Comma or space separated provider/model references. Blank means no role fallbacks.")}</p></div>${identity ? hidden("canary", identity, "json") : null}${ui.btn({ label: tr("Preview the change"), type: "submit", kind: "primary" })}</fieldset><noscript><p class="md-foot">${tr(MODELS_WORDS.noScript)}</p></noscript><p class="field__err" data-form-error hidden role="alert"></p></form>`;
}
function removal(role, view) { return html`<form class="act md-remove" data-action="model-role-edit"><fieldset data-config-controls disabled>${hidden("scope", role.scope)}${hidden("role", role.role)}${hidden("remove", true, "json")}${ui.btn({ label: `${t("Preview removing", view)} ${role.role}`, type: "submit", kind: ["sm", "ghost"] })}</fieldset><p class="field__err" data-form-error hidden role="alert"></p></form>`; }
function roleConflictSentence(b, view) {
  const words = { "model-role-unknown": "This trigger names a role that is undeclared in this scope. Declare it in the triggers-file role map or change the trigger before its next pickup.", "model-role-provider-conflict": "This trigger's provider conflicts with its role model. Align the trigger provider with the role model before its next pickup.", "model-roles-invalid": "This trigger's role-expanded model policy is invalid. Keep fallbacks on the role or the trigger, never both, and keep the expanded model list within 16 models." };
  return t(words[b.reason] ?? "Pickup refuses this trigger's model-role policy. Review the triggers-file role map, provider and fallback lists.", view);
}
export function modelsProblems(view) {
  const m = model(view);
  const notes = array(m.coverage?.notes);
  const titles = { "radius-cost-cap": "A capped Radius model cannot start", "role-conflict": "A trigger conflicts with its model role", "configuration-unavailable": "Model policy unavailable", "catalog-unavailable": "Model catalog unavailable", "cooldowns-unavailable": "Cooldowns unavailable" };
  const bodies = { "role-conflict": roleConflictSentence, "radius-cost-cap": "Radius cannot be bounded by a per-job dollar cap. Choose a provider with a locally bounded API for capped work.", "configuration-unavailable": "Check the reviewed triggers, projects and settings files; role routing is not known.", "catalog-unavailable": "Check the global pi model catalog overlay; price status is not known.", "cooldowns-unavailable": "Check Valkey and Reload; current cooldowns are not known." };
  return html`${m.state === "unreadable" ? ui.banner({ status: "attention", title: t("Models unavailable", view), body: t(MODELS_WORDS.unreadable, view) }) : null}${array(m.banners).map((b) => {
    const body = b.label ?? b.message ?? bodies[b.kind] ?? "Run pi-dispatch doctor on this host and review the model configuration.";
    return ui.banner({ status: "attention", title: t(b.title ?? titles[b.kind] ?? "Model configuration needs attention", view), body: html`${t(typeof body === "function" ? body(b, view) : body, view)}${b.fix ? html` ${t("Fix:", view)} ${b.fix}` : null}${b.projectUnknown ? html` ${t(MODELS_WORDS.possibleProject, view)}` : null}${array(b.triggers).length ? html` ${b.triggers.map((item) => rowLink(typeof item === "number" ? { index: item } : item, view))}` : Number.isInteger(b.index) ? html` ${rowLink({ index: b.index }, view)}` : null}` });
  })}${m.partial ? ui.banner({ status: "attention", sm: true, title: t("Partial model information", view), body: t(notes.length ? notes.join(" ") : "This view uses bounded retained observations. Missing history and pending pickup checks limit what is known.", view) }) : null}`;
}
export function modelsRoles(view) {
  const m = model(view);
  const rows = array(m.roles).map((r, index) => [
    html`<b>${r.role}</b><small class="md-scope">${scopeWord(r.scope, view)}</small>`,
    code(r.model),
    array(r.fallbackModels).length
      ? html`<ol class="md-fallbacks">${array(r.fallbackModels).map((f) => html`<li>${code(typeof f === "string" ? f : f.ref)}${typeof f !== "string" && (f.skipped || f.priced === false) ? html` ${ui.badge("attention", t("Skipped: unpriced", view))}` : null}</li>`)}</ol>`
      : html`<span class="muted">${t("None", view)}</span>`,
    html`<ul class="md-trigger-list">${array(r.triggers).map((trigger) => html`<li>${rowLink(trigger, view)}${trigger.flow ? html` · ${code(trigger.flow)}` : ` · ${t("no flow", view)}`}${trigger.project ? html` · ${trigger.project}` : null}${trigger.projectUnknown ? html`<small class="md-scope">${t(MODELS_WORDS.possibleProject, view)}</small>` : null}</li>`)}</ul>${array(r.triggers).length ? null : html`<span class="muted">${t("No trigger names this scoped role", view)}</span>`}`,
    acts(view) ? html`<a class="link" href="${`#md-editor-row-${index}`}" data-model-edit="${`md-editor-row-${index}`}">${t("Edit", view)}</a>` : null,
  ]);
  const heads = ["Role and scope", "Model", "Fallbacks, in order", "Triggers and flows", ...(acts(view) ? ["Actions"] : [])].map((label) => t(label, view));
  return ui.card({ title: t("Model roles", view), sub: t("default, then project overrides", view), flush: true, body: html`${ui.tbl({ caption: t("Model roles by scope", view), heads, rows: rows.map((r) => acts(view) ? r : r.slice(0, 4)), stack: true, empty: empty(m, "No model roles are configured.", view) })}${acts(view) ? array(m.roles).map((r, index) => html`<details class="md-editor md-role-editor" id="${`md-editor-row-${index}`}" ><summary class="link">${t("Edit", view)} ${scopeWord(r.scope, view)} / ${r.role}</summary>${modelRoleForm(m, { role: r, key: `row-${index}`, locale: view.locale })}${removal(r, view)}</details>`) : null}<p class="md-foot">${t(MODELS_WORDS.agents, view)} ${t("The map is", view)} ${code("modelRoles")} ${t("in the triggers file.", view)}</p>${acts(view) && m.state !== "unreadable" ? html`<details class="md-editor md-add"><summary class="link">${t("Add a role or project override", view)}</summary>${modelRoleForm(m, { locale: view.locale })}</details>` : null}` });
}
function forecast(next, primary, view) {
  const copy = next?.kind === "direct" ? html`${t("No fallback: its jobs start on", view)} ${code(next.model ?? primary)}.` : next?.kind === "candidate" ? html`${t("First candidate by price and cooldown:", view)} ${code(next.model)}.` : next?.kind === "waiting" ? t("No candidate has room now; its failover jobs wait.", view) : t("The next candidate is not known.", view);
  return html`${copy}${next?.reason === "cooldowns-unavailable" ? ` ${t("Cooldown data could not be read.", view)}` : next?.reason === "model-failover-no-candidate" ? ` ${t("No known, priced candidate was observed.", view)}` : null}`;
}
function groupLinks(group, view) {
  const unique = new Map();
  for (const item of array(group.triggers)) { const trigger = typeof item === "number" ? { index: item } : item; if (!unique.has(trigger.index)) unique.set(trigger.index, trigger); }
  return [...unique.values()].map((item, i) => html`${i ? ", " : null}${rowLink(item, view)}`);
}
export function modelsCooldowns(view) {
  const m = model(view);
  return ui.card({ title: t("Cooling down", view), sub: t("configured models only", view), body: html`${array(m.cooldowns).length ? html`<ul class="md-ms">${array(m.cooldowns).map((c) => html`<li class="md-cool">${ui.tile("attention", { icon: "clock", sm: true })}<div><b>${code(c.ref)}</b><p class="md-foot">${t(providerFailureWords(c.kind, view.locale), view)}. ${t("Cooling until", view)} <span class="tnum">${utc(c.until)}</span>.</p></div></li>`)}</ul>` : empty(m, "No configured failover model is cooling down.", view)}<ul class="md-next">${array(m.roles).map((r) => html`<li><b>${scopeWord(r.scope, view)} / ${r.role}</b>${array(r.fallbackGroups).length ? array(r.fallbackGroups).map((group) => html`<p>${groupLinks(group, view)}: ${forecast(group.next, r.model, view)}</p>`) : html`<p>${forecast(r.next, r.model, view)}</p>`}</li>`)}</ul>${array(m.roles).some((r) => (array(r.fallbackGroups).length ? r.fallbackGroups : [r]).some((group) => group.next?.kind !== "direct")) ? html`<p class="md-foot">${t(MODELS_WORDS.next, view)}</p>` : null}${array(m.waiting).length ? html`<p class="md-foot"><a class="link" href="/#p-waitlists">${array(m.waiting).length} ${t("jobs wait on model cooldown or model window", view)}</a>.</p><ul class="md-waiting">${array(m.waiting).map((w) => html`<li><a class="link code md-ref" href="/#p-waitlists">${w.jobId ?? w.id}</a> · ${t(w.why === "model-window" || w.reason === "model-window" ? "model dollar window" : "model cooldown", view)}</li>`)}</ul>` : empty(m, "No retained jobs are waiting on model cooldown or model window.", view)}${array(m.recentFallbacks).map((r) => html`<p class="md-note">${runLink(r.jobId)} ${r.sentence ?? modelChoiceSentence(r, view.locale)}</p>`)}` });
}
function modelStateBadge(row, view) {
  if (["cooldown", "cooling", "cooling-down"].includes(row.state)) return ui.badge("attention", t("Cooling down", view), { icon: "clock" });
  if (row.state === "policy-refused") return ui.badge("attention", t("Trigger policy refused", view), { icon: "refused" });
  if (row.state === "window-full") return ui.badge("attention", t("Dollar window full", view), { icon: "spend" });
  if (row.state === "unpriced") return ui.badge("attention", t("Unpriced", view));
  if (row.state === "unknown" || row.known !== true || row.priced === null) return ui.badge("idle", t("Not known", view), { icon: "info" });
  return ui.badge("ok", t("Configured", view));
}
export function modelsInUse(view) {
  const m = model(view);
  return ui.card({ title: t("Models in use", view), sub: t("unpriced fallbacks are skipped", view), body: html`${array(m.models).length ? html`<ul class="md-ms">${array(m.models).map((r) => html`<li class="md-m"><div class="md-m__t"><b>${code(r.ref)}</b><small>${r.provider} · ${t(r.known === false ? "Unknown model" : r.priced === true ? "Priced for failover" : r.priced === false ? "Unpriced: skipped as a fallback" : "Price status unavailable", view)}</small><ul class="md-windows">${array(r.windows).map((w) => html`<li>${w.scope} · ${w.window}: ${t(w.unavailable ? "Spend unavailable" : "Spend", view)}${w.unavailable ? "" : ` ${micros(w.spentMicros)} ${t("of", view)} ${micros(w.capMicros)}`}</li>`)}</ul>${array(r.windows).length ? null : html`<small>${t("No model-specific dollar windows are configured; other deployment and scope caps still apply.", view)}</small>`}</div>${modelStateBadge(r, view)}</li>`)}</ul>` : empty(m, "No role, fallback or trigger names a model.", view)}` });
}
function metricRows(c, view) {
  const candidate = c.candidateStats ?? {}, source = c.sourceStats ?? {};
  return [[t("Cost per run", view), usd(source.costPerRun), usd(candidate.costPerRun)], [t("Completed", view), `${source.completed ?? 0} ${t("of", view)} ${source.runs ?? 0}`, `${candidate.completed ?? 0} ${t("of", view)} ${candidate.runs ?? 0}`], [t("Turns, average", view), amount(source.averageTurns), amount(candidate.averageTurns)], [t("Tokens, average", view), amount(source.averageTokens), amount(candidate.averageTokens)]];
}
export function modelProposalSentence(p, locale = "en") {
  const templates = {
    retirement: ["Model {model} for {scope} / {role} is deprecated or retiring. Review a replacement before changing the role.", "{scope} / {role} 使用的模型 {model} 已弃用或即将停用。更改角色前请先检查替代模型。"],
    "newer-sibling": ["A newer sibling {candidate} is available for {scope} / {role}, currently {model}. Compare it with a capped canary.", "{scope} / {role} 当前使用 {model}，现有更新的同系列模型 {candidate}。请通过限额金丝雀运行进行比较。"],
    "cheaper-route": ["Declared route {candidate} may cost less than {model}. Compare the retained runs before changing a role.", "已声明的路由 {candidate} 可能比 {model} 成本更低。更改角色前请比较保留的运行记录。"],
    "catalog-checked": ["Doctor checked the {provider} catalog.", "Doctor 已检查 {provider} 模型目录。"],
    unavailable: ["Doctor could not inspect model proposals on this host. Run doctor there to inspect the source.", "Doctor 无法检查此主机上的模型建议。请在该主机运行 doctor 检查来源。"],
  };
  const [en, zh] = templates[p.kind] ?? ["Doctor published a model proposal; inspect its check on the host.", "Doctor 发布了一条模型建议；请在主机上检查其检查结果。"];
  const template = locale === "zh" ? zh : en;
  return template.replace(/\{(model|scope|role|candidate|provider)\}/g, (_, key) => String(p[key] ?? ""));
}
export function modelsProposals(view) {
  const m = model(view);
      return ui.card({ title: t("Proposals and canaries", view), sub: t("doctor checks per host, retained run comparisons", view), body: html`${array(m.proposals).length ? html`<ul class="md-proposals">${array(m.proposals).map((proposal) => html`<li><p><b>${proposal.host}</b> · ${t(proposal.stale ? "stale doctor result" : "doctor", view)}${proposal.at ? html` · ${utc(proposal.at)}` : null}</p><p>${proposal.label ?? modelProposalSentence(proposal, view.locale)}${proposal.fix ? html` ${t("Fix:", view)} ${proposal.fix}` : null}</p></li>`)}</ul>` : empty(m, "No model proposals were published by doctor.", view)}${array(m.canaries).map((canary, index) => html`<article class="md-prop"><h3>${code(canary.candidate)} ${t("for", view)} ${canary.role}</h3><p class="md-foot">${t("Flow", view)} ${code(canary.flow)}. ${t("Retained candidates and their source runs; completion is the recorded outcome, not a quality judgement.", view)}</p>${canary.partial ? ui.banner({ status: "attention", title: t("Partial canary comparison", view), sm: true, body: t("Some source records or complete meter evidence are missing. Incomplete or unmetered costs are excluded from exact cost averages. Unknown cost, turns or tokens are not zeroes; each average uses its own known values only.", view) }) : null}${ui.tbl({ caption: `${t("Canary for", view)} ${canary.role}, ${canary.flow}`, heads: ["Observed metric", "Source runs", "Candidate"].map((label) => t(label, view)), rows: metricRows(canary, view), stack: true })}<p class="md-foot">${t("Known cost:", view)} ${canary.sourceStats?.knownCosts ?? 0} ${t("source and", view)} ${canary.candidateStats?.knownCosts ?? 0} ${t("candidate runs.", view)} ${t("Known turns:", view)} ${canary.sourceStats?.knownTurns ?? 0} ${t("source and", view)} ${canary.candidateStats?.knownTurns ?? 0} ${t("candidate runs.", view)} ${t("Known tokens:", view)} ${canary.sourceStats?.knownTokens ?? 0} ${t("source and", view)} ${canary.candidateStats?.knownTokens ?? 0} ${t("candidate runs.", view)}</p><ul class="md-sources">${array(canary.rows).map((row) => html`<li>${t("Candidate", view)} ${runLink(row.jobId)}, ${t("source", view)} ${row.source ? runLink(row.sourceJobId) : html`${code(row.sourceJobId)} (${t("source unavailable", view)})`}</li>`)}</ul><p class="md-foot"><a class="link" href="${typeof canary.whatIf === "string" && canary.whatIf.startsWith("/insights") ? canary.whatIf : `/insights/breakdown?${new URLSearchParams({ whatif: canary.candidate, flow: canary.flow })}`}">${t("What if this model handled the flow?", view)}</a></p>${acts(view) ? html`<details class="md-editor md-adopt"><summary class="link">${t("Adopt for", view)} ${canary.role}</summary><p class="md-foot">${t("Choose the scope, then review the diff and this canary's numbers. Nothing runs now; recovery keeps its model.", view)}</p>${modelRoleForm(m, { canary, key: `canary-${index}`, locale: view.locale })}</details><h4 class="md-run-more">${t("Run more", view)}</h4>${ui.cmd(["pi-dispatch", "canary", "--role", canary.role, "--model", canary.candidate, "--flow", canary.flow, "--cap-usd", "<cap-usd>", "--count", "1"])}<p class="md-foot">${t("Replace <cap-usd> with the new experiment's total dollar cap before running. Canary supports first-party Anthropic or OpenAI on the local Docker venue.", view)} ${t(MODELS_WORDS.lease, view)}</p>` : null}</article>`) }${array(m.canaries).length ? null : empty(m, "No retained canary records are available.", view)}<p class="md-foot">${t("History covers at most", view)} ${m.coverage?.days ?? 30} ${t("days and", view)} ${m.coverage?.records ?? 0} ${t("retained records. Missing history is never evidence of a free or successful canary.", view)}</p>` });
}
export const MODELS_PANELS = Object.freeze([["p-model-problems", modelsProblems], ["p-roles", modelsRoles], ["p-cooldowns", modelsCooldowns], ["p-models", modelsInUse], ["p-subscription-quota", modelsSubscriptionQuota], ["p-proposals", modelsProposals]]);
