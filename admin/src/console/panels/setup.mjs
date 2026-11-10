/** #774: the full first-run page. Shared panels hold roles and published facts, never a private result or credential. */
import { html } from "../html.mjs";
import * as ui from "../kit.mjs";
import { uiText } from "../locale.mjs";
import { actForm, field } from "./config-ui.mjs";
import { ageText } from "./common.mjs";
import { setupState, SETUP_STATES, SETUP_PROGRESS_STATES, SETUP_PROGRESS_STAGES, SETUP_REASON_TEXT } from "../../setup-view.mjs";
import { firstRunCommandHint } from "../../doctor-view.mjs";
import { TRIGGER_RECIPES } from "../../trigger-recipes.mjs";
import { setupProviderKeys } from "./provider-keys.mjs";

export const SETUP_DESCRIPTION = "Finish supported steps here. The terminal way remains available for every step.";
export const SETUP_FORGE_NOTICE = "Forge credentials are set in the deployment's .env. For GitHub, GITHUB_PAT is the only credential: one shared, repo-scoped token held by the operator.";
export const SETUP_PROVIDER_NOTICE = "A configured API key or managed subscription is judged by doctor. An ordinary pi OAuth login is not unattended service authentication.";
export const SETUP_START_NOTICE = "Starting a worker admits queued jobs and future matching events. Its preview names current manual jobs, armed schedules and reserve estimates. Stop or restart can interrupt work; it cannot undo spending.";
export const SETUP_BOOTSTRAP_COMMAND = Object.freeze(["pi-dispatch", "up", "--console"]);

const parts = (sentence, locale = "en") => (sentence ?? []).map(part => typeof part === "string" ? uiText(part, locale) : part?.code ? html`<span class="code">${part.code}</span>` : part?.b ? html`<b>${part.b}</b>` : Number.isFinite(part?.age) ? ageText(part.age) : "");
const stateOf = view => setupState(view.data?.snapshot ?? null, { role: view.role, deployment: view.data?.deployment, facts: view.data?.setup, now: view.now ?? 0 });
const allowed = (view, state, action) => view.role === "operator" && !view.readOnly && state.facts.actions.includes(action);
function action(view, state, name, label) {
  return allowed(view, state, name) ? actForm(name, { label: uiText(label, view.locale) }) : null;
}
function terminal(view, step) {
  if (view.role !== "operator") return null;
  const commands = [...(step.commands ?? [])];
  if (step.id === "provider" && commands.length === 0) commands.push(["pi-dispatch", "doctor"]);
  if (!commands.length) return null;
  return html`<details class="su-term"><summary>${ui.icon("terminal", { size: "sm" })}${uiText("In a terminal instead", view.locale)}</summary>${commands.map(argv => html`${ui.cmd(argv)}${firstRunCommandHint(argv) ? html`<p class="su-small">${parts(firstRunCommandHint(argv), view.locale)}</p>` : null}`)}</details>`;
}
function recipes(view) {
  if (view.role !== "operator" || view.readOnly) return html`<p class="su-small">${uiText("An operator can add a first trigger in the trigger editor.", view.locale)}</p>`;
  return html`<div class="su-rec">${Object.entries(TRIGGER_RECIPES).map(([id, recipe]) => html`<a class="su-r" href="${`/config/trigger-add?recipe=${id}`}">${ui.tile("idle", { icon: recipe.icon, sm: true })}<b>${uiText(recipe.title, view.locale)}</b><span>${uiText(recipe.description, view.locale)}</span></a>`)}</div><p class="su-small"><a class="link" href="/config/trigger-add">${uiText("Start from scratch", view.locale)}</a> ${uiText("in the trigger editor. Preview the exact added lines before saving.", view.locale)}</p>`;
}
function serviceActions(view, state, service) {
  return html`<div class="su-act">${["install", "start", "stop", "restart"].map(verb => action(view, state, `setup-${service}-${verb}`, verb === "install" ? `Preview installing and starting the ${service}` : `Preview ${verb === "start" ? "starting" : verb === "stop" ? "stopping" : "restarting"} the ${service}`))}</div>`;
}
function stepBody(view, state, step) {
  if (step.id === "worker") return html`<p class="su-small">${uiText(SETUP_START_NOTICE, view.locale)}</p>${step.state === "starting" ? action(view, state, "setup-worker-stop", "Preview stopping the worker") : serviceActions(view, state, "worker")}`;
  if (step.id === "egress") return html`<p class="su-small">${state.facts.allowlistCount === null ? uiText("The allowlist count is not published.", view.locale) : `${state.facts.allowlistCount} ${uiText("hosts in this deployment's allowlist.", view.locale)}`} ${uiText("Unsafe or shared proxy changes require the terminal.", view.locale)}</p><div class="su-act">${action(view, state, "setup-egress-start", "Preview starting the egress proxy")}<a class="btn btn--ghost" href="/config/connections#p-egress">${uiText("Review the allowlist", view.locale)}</a></div>`;
  if (step.id === "provider") return html`<p class="su-small">${uiText(SETUP_PROVIDER_NOTICE, view.locale)}</p>${setupProviderKeys(view)}<a class="link" href="/config/connections#p-subscription-auth">${uiText("Review subscription authentication", view.locale)}</a>`;
  if (step.id === "trigger") return recipes(view);
  if (step.id === "forge") return html`<p class="su-small">${uiText(SETUP_FORGE_NOTICE, view.locale)}</p><a class="link" href="/config/connections">${uiText("Review Connections", view.locale)}</a>${view.role === "operator" ? html`<details class="su-term"><summary>${uiText("Receiver service", view.locale)}</summary>${serviceActions(view, state, "receiver")}${ui.cmd(["pi-dispatch", "service", "install", "--receiver"])}</details>` : null}`;
  return null;
}
function stepHtml(view, state, step, index) {
  const word = SETUP_STATES[step.state];
  const progress = step.progress;
  return html`<li class="su-step">${ui.tile(word.status, { icon: step.state === "starting" ? "running" : step.state === "ready" ? "done" : step.id === "forge" ? "git" : step.id === "provider" ? "key" : "attention" })}<div class="su-step__b"><p class="su-step__t"><span class="su-n">${index + 1}</span>${uiText(step.title, view.locale)}${ui.chip(uiText(word.word, view.locale), { status: word.status })}</p><p class="su-step__s">${parts(step.sentence, view.locale)}</p>${progress ? html`<p class="su-small" role="status">${uiText(SETUP_PROGRESS_STATES[progress.state][1], view.locale)}${progress.stage ? `: ${uiText(SETUP_PROGRESS_STAGES[progress.stage], view.locale)}` : null}${progress.reason ? ` ${uiText(SETUP_REASON_TEXT[progress.reason], view.locale)}` : null}</p>` : null}${stepBody(view, state, step)}${terminal(view, step)}</div></li>`;
}
export function setupMain(view) {
  const state = stateOf(view), starting = state.steps.filter(step => step.state === "starting").length;
  const width = (100 - 0.8 * (state.total - 1)) / state.total;
  const bar = html`<svg class="su-bar" height="10" role="img" aria-label="${state.steps.map(step => `${uiText(step.title, view.locale)}: ${uiText(SETUP_STATES[step.state].word, view.locale)}`).join(", ")}">${state.steps.map((step, i) => html`<rect class="${`su-seg tone-${SETUP_STATES[step.state].status}${["to-do", "optional"].includes(step.state) ? " su-seg--todo" : ""}`}" x="${(i * (width + 0.8)).toFixed(2)}%" y="0" width="${width.toFixed(2)}%" height="10" rx="5"/>`)}</svg>`;
  const otherProgress = state.facts.progress.filter(item => item.step === "doctor" || state.steps.some(step => step.id === item.step && step.state === "ready"));
  const operationNotes = otherProgress.length ? html`<ol class="su-prog2" aria-label="${uiText("Setup operation results", view.locale)}" aria-live="polite">${otherProgress.map(item => html`<li>${ui.icon(item.state === "starting" ? "hourglass" : item.state === "applied" ? "done" : "attention", { size: "sm" })}<span>${uiText(item.step === "doctor" ? "Doctor" : "Host operation", view.locale)}: ${uiText(SETUP_PROGRESS_STATES[item.state][1], view.locale)}. ${item.stage ? uiText(SETUP_PROGRESS_STAGES[item.stage], view.locale) : null}${item.reason ? ` ${uiText(SETUP_REASON_TEXT[item.reason], view.locale)}` : null}</span></li>`)}</ol>` : null;
  return ui.card({ title: uiText("Getting ready", view.locale), sub: state.doctor ? `${uiText("from doctor on", view.locale)} ${state.doctor.host}, ${ageText(state.doctor.ageMs)} ${uiText("ago", view.locale)}` : uiText("waiting for a published doctor result", view.locale), body: html`<div class="su-prog"><p><b class="su-big">${state.ready}</b> ${uiText("of", view.locale)} ${state.total} ${uiText("ready", view.locale)}${starting ? ` · ${starting} ${uiText("starting", view.locale)}` : null}</p>${bar}<p class="muted">${uiText("This page updates from published facts. Starting a process alone never makes a step Ready.", view.locale)}</p></div>${view.role === "operator" && !view.readOnly && !state.facts.enabled ? ui.banner({ status: "attention", title: uiText("Use the terminal on the deployment host", view.locale), body: uiText(state.facts.reason, view.locale), sm: true }) : null}${view.readOnly ? html`<p class="su-small">${uiText("This console is read-only. Use the terminal alternatives to change the deployment.", view.locale)}</p>` : null}<ol class="su-steps">${state.steps.map((step, index) => step.state === "ready" ? null : stepHtml(view, state, step, index))}</ol>${operationNotes}<div class="su-act">${action(view, state, "setup-doctor", "Preview running doctor")}</div>` });
}
export function setupReady(view) {
  const state = stateOf(view);
  return ui.card({ title: uiText("Ready", view.locale), sub: `${state.ready} ${uiText("of", view.locale)} ${state.total}`, body: html`<ul class="su-done">${state.steps.filter(step => step.state === "ready").map(step => html`<li>${ui.tile("ok", { icon: "done", sm: true })}<b>${uiText(step.title, view.locale)}</b><span>${parts(step.sentence, view.locale)}</span>${step.id === "worker" && view.role === "operator" && !view.readOnly && state.facts.actions.some(name => name.startsWith("setup-worker-")) ? html`<details class="su-term"><summary>${uiText("Manage this service", view.locale)}</summary>${serviceActions(view, state, step.id)}</details>` : null}</li>`)}</ul>${allowed(view, state, "setup-viewer-add") ? html`<details class="su-term"><summary class="btn">${ui.icon("plus", { size: "sm" })}${uiText("Add a viewer", view.locale)}</summary><p class="su-small">${uiText("A one-use link, good for 60 seconds, grants a viewer session. The other person needs a route or their own tunnel to this console.", view.locale)}</p><div data-setup-private="viewer">${actForm("setup-viewer-add", { label: uiText("Preview adding a viewer", view.locale), fields: field("name", uiText("Viewer name", view.locale), { required: true, max: 32 }) })}</div></details>` : null}` });
}
export function setupStart(view) {
  return ui.card({ title: uiText("The one command", view.locale), body: html`<p class="muted su-p">${uiText("Use the durable installation from the Quickstart, then bootstrap the console on the deployment host.", view.locale)}</p>${view.role === "operator" ? html`${ui.cmd(SETUP_BOOTSTRAP_COMMAND)}` : html`<p class="muted su-p">${uiText("An operator runs the host bootstrap. You can watch its progress here.", view.locale)}</p>`}<p class="su-small"><a class="link" href="/config/connections#p-provider-keys">${uiText("Manage provider API keys", view.locale)}</a>, ${uiText("also after setup is ready.", view.locale)}</p><p class="su-small"><a class="link" href="/">${uiText("Open the Overview", view.locale)}</a></p>` });
}
export const SETUP_PANELS = Object.freeze([["p-setup", setupMain], ["p-setup-ready", setupReady], ["p-setup-start", setupStart]]);
