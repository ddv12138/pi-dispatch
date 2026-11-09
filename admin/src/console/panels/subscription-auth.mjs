import { html } from "../html.mjs";
import * as ui from "../kit.mjs";
import { SUBSCRIPTION_ADAPTERS, subscriptionAuthView } from "../../subscription-auth-view.mjs";
import { PROVIDER_AUTH_GUIDES } from "../../provider-help.mjs";
import { uiText } from "../locale.mjs";
const tr = (view, text) => uiText(text, view?.locale);

const STATES = Object.freeze({
  connected: ["ok", "Connected"], disconnected: ["idle", "Disconnected"],
  "reauth-required": ["attention", "Sign-in required"], "refresh-uncertain": ["attention", "Refresh outcome uncertain"],
  "other-host": ["idle", "Owned by another host"], "adapter-unavailable": ["attention", "Adapter unavailable"], unknown: ["idle", "Credential status unknown"],
});
const COMPATIBILITY = Object.freeze({
  verified: ["ok", "Pinned artifact verified; job checks remain"], disabled: ["attention", "Extension disabled"],
  unstaged: ["attention", "Extension not staged"], unpinned: ["attention", "Exact version not pinned"],
  conflicting: ["attention", "Conflicting provider overrides"], "version-mismatch": ["attention", "Adapter version mismatch"],
  unavailable: ["attention", "Adapter unavailable"], unknown: ["idle", "Compatibility not published"],
});
const utc = (value, view) => value === null ? tr(view, "Not published") : `${new Date(value).toISOString().replace("T", " ").slice(0, 19)} UTC`;
const code = value => html`<span class="code">${value}</span>`;
const facts = (rows, view) => html`<dl class="sa-facts">${rows.map(([label, value]) => html`<dt>${tr(view, label)}</dt><dd>${value}</dd>`)}</dl>`;
const selected = (value, view) => tr(view, value === true ? "selected" : value === false ? "not selected" : "selection unknown");
const owner = (row, view) => row.ownerHost ? html`<a href="${`/fleet/host?name=${encodeURIComponent(row.ownerHost)}`}">${row.ownerHost}</a>` : tr(view, "Owner not published");
const extra = (row, view) => tr(view, row.quota.extraUsage.enabled === true ? "Enabled" : row.quota.extraUsage.enabled === false ? "Disabled" : row.extraUsage === "enabled" ? "Enabled" : row.extraUsage === "disabled" ? "Disabled" : "Unknown");
const credit = (row, view) => row.extraUsageCreditTokens === null ? tr(view, "Not authorized for paid overage") : `${row.extraUsageCreditTokens} ${tr(view, "extra-usage tokens per job (conservative model-cost bound)")}`;
const allowed = view => view.role === "operator" && !view.readOnly;
const source = (view, page) => subscriptionAuthView(view.data?.[page]?.subscriptionAuth ?? view.data?.subscriptionAuth, { now: view.now ?? view.data?.now ?? 0 });
const title = (row, status, view) => html`<div class="sa-title"><h3>${code(row.id)}</h3>${ui.badge(status[0], tr(view, status[1]))}</div>`;

function commands(view, row, quotaOnly) {
  if (!allowed(view)) return null;
  const commands = quotaOnly ? ["usage", ...(row.quota.blockedUnknownReset && !row.quota.trialAvailable ? ["trial"] : [])] : ["login", "logout", "usage", ...(row.quota.blockedUnknownReset && !row.quota.trialAvailable ? ["trial"] : [])];
  return html`<div class="sa-commands"><p class="sa-note">${tr(view, "Run in a terminal on")} ${row.ownerHost ?? tr(view, "the owning host")}. ${tr(view, "Sign-in and refresh never run in this browser.")} ${row.quota.blockedUnknownReset ? row.quota.trialAvailable ? tr(view, "One quota trial is already authorized. It does not clear account exhaustion or start a job here.") : tr(view, "Trial authorizes one fresh, normally budgeted pickup check; it does not clear account exhaustion or start a job here.") : null}</p>${commands.map(command => html`<div><p class="sa-note">${tr(view, ({ login: "Sign in or reauthenticate", logout: "Disconnect this connection", usage: "Refresh quota observations", trial: "Authorize one quota trial" })[command])}</p>${ui.cmd(["pi-dispatch", "auth", command, row.id])}</div>`)}</div>`;
}

const partial = (data, view) => data.connections.length && data.partial ? ui.banner({ status: "attention", sm: true, title: tr(view, "Partial subscription observations"), body: tr(view, data.truncated ? "The display limit was reached. Additional connection records are not shown; missing observations are unknown." : "Some host observations are missing or incomplete. Published facts remain visible; missing observations are unknown.") }) : null;

function empty(view) {
  if (view.state === "ready" && !view.partial) return html`<p>${tr(view, "No subscription connection is configured.")}</p>`;
  return html`<p>${ui.badge("idle", tr(view, "Subscription status not published"))}</p><p class="sa-note">${tr(view, "No credential or quota inference can be made from missing host observations.")}</p>`;
}

export function subscriptionGuides(view) {
  return html`<div class="pk-help">${Object.entries(PROVIDER_AUTH_GUIDES).map(([provider, guide]) => html`<details class="pk-guide" data-subscription-help="${provider}"><summary>${guide.label}</summary><div class="pk-links">${guide.docsUrl ? ui.outLink({ href: guide.docsUrl, label: "Host connection guide", btn: "sm" }) : null}${ui.outLink({ href: guide.officialUrl, label: "Official provider guidance" })}</div><ol>${guide.steps.map(step => html`<li>${step}</li>`)}</ol><p class="pk-note pk-notice">${guide.notice}</p>${allowed(view) && guide.command ? html`<p class="pk-note pk-notice">Replace &lt;connection-id&gt; with the configured connection name before running on its owning host.</p>${ui.cmd(guide.command.split(" "))}` : null}</details>`)}</div>`;
}

export function connectionsSubscriptionAuth(view) {
  const data = source(view, "connections");
  return ui.card({ title: tr(view, "Subscription authentication"), sub: tr(view, "host-owned credentials, safe status only"), body: html`<p class="pk-intro">${tr(view, "Subscription credentials stay on the owning host. Use its supported sign-in flow, separately from API keys.")}</p>${subscriptionGuides(view)}${partial(data, view)}<div class="sa-accounts">${data.connections.map(row => {
    const metadata = row.adapter ? SUBSCRIPTION_ADAPTERS[row.adapter] : null;
    return html`<article class="sa-account">${title(row, STATES[row.state], view)}${facts([
      ["Provider", `${row.provider ?? "Unknown"}, ${selected(row.active, view)}`],
      ["Adapter", metadata ? html`${code(row.adapter)}${metadata.community ? " (community)" : " (pi-dispatch built-in)"}` : "Unsupported or unpublished adapter"],
      ["Owner host", owner(row, view)], ["Compatibility", ui.badge(...COMPATIBILITY[row.compatibility])],
      ["Access token expiry", html`${utc(row.expiresAt, view)}${row.expired ? " (access token expired; host refresh required)" : null}`],
      ["Last refresh", utc(row.lastRefreshAt, view)], ["Extra usage", extra(row, view)], ["Paid overage ceiling", credit(row, view)],
    ], view)}<p class="sa-note">${tr(view, "Credentials stay on the owning host. Connected describes the credential record, not a successful paid request.")} ${row.state === "refresh-uncertain" ? tr(view, "The refresh result could not be durably established. Sign in again on the owning host before retrying.") : row.state === "other-host" ? tr(view, "Only the owning host may refresh or sign in for this connection.") : row.state === "adapter-unavailable" ? tr(view, "Check the selected exact package, staged extension and provider override before signing in.") : null}</p>${commands(view, row, false)}</article>`;
  })}${data.connections.length ? null : empty(data)}</div>` });
}

function windowTitle(window, view) {
  return tr(view, `${window.window === "five-hour" ? "Five-hour" : window.window === "seven-day" ? "Seven-day" : "Other"} ${window.scope === "account" ? "account" : window.scope === "scoped" ? "scoped" : "quota"} window`);
}

function monitoringFocus(row, view) {
  if (row.quotaWindows === null) return tr(view, "Not published; all windows shown");
  if (row.quotaWindows.length === 0) return tr(view, "None selected");
  return tr(view, row.quotaWindows.length === 2 ? "Five-hour and seven-day account windows" : row.quotaWindows[0] === "five-hour" ? "Five-hour account window" : "Seven-day account window");
}

function outsideFocus(row, window) {
  return row.quotaWindows !== null && window.scope === "account" && ["five-hour", "seven-day"].includes(window.window) && !row.quotaWindows.includes(window.window);
}

function focusedWindows(row) {
  // A display preference cannot hide a known blocker. Scoped/other windows have no selectable policy token.
  return row.quota.windows.filter(window => window.state === "exhausted" || !outsideFocus(row, window));
}

function quotaState(quota) {
  if (quota.state === "exhausted") return ["attention", quota.fresh ? "Quota exhausted" : "Exhaustion retained"];
  return quota.fresh && quota.state === "available" ? ["ok", "Quota observed available"] : ["idle", "Quota unknown"];
}

export function modelsSubscriptionQuota(view) {
  const data = source(view, "models");
  return ui.card({ title: tr(view, "Subscription quota"), sub: tr(view, "account windows, separate from this console"), body: html`${partial(data, view)}<div class="sa-accounts">${data.connections.map(row => html`<article class="sa-account">${title(row, quotaState(row.quota), view)}${facts([
    ["Provider", row.provider ?? tr(view, "Unknown")], ["Owner host", owner(row, view)], ["Monitoring focus", monitoringFocus(row, view)],
    ["Observation", row.quota.observedAt === null ? tr(view, "Not published") : `${tr(view, row.quota.fresh ? "Fresh" : "Stale or freshness unknown")}, ${tr(view, "observed")} ${utc(row.quota.observedAt, view)}`],
    ["Pickup", row.quota.blockedUnknownReset ? row.quota.trialAvailable ? tr(view, "Exhausted; reset unknown. One trial is authorized; other pickup gates still apply.") : tr(view, "Exhausted; reset unknown. A fresh observation or explicit host trial is needed.") : row.quota.state === "exhausted" ? row.quota.until === null ? tr(view, "Exhausted; reset not published") : `${tr(view, "Waiting until")} ${utc(row.quota.until, view)}` : row.quota.fresh && row.quota.state === "available" ? tr(view, "Quota observation permits checking other pickup gates") : tr(view, "Quota availability is not known")],
    ["Extra usage", extra(row, view)], ["Paid overage ceiling", credit(row, view)],
  ], view)}<ul class="sa-windows">${focusedWindows(row).map(window => html`<li class="sa-window"><b>${windowTitle(window, view)}</b><span>${window.usedPercent === null ? tr(view, "Usage unknown") : `${window.usedPercent}% ${tr(view, "used")}`}. ${window.resetAt === null ? tr(view, "Reset unknown") : `${tr(view, "Resets")} ${utc(window.resetAt, view)}`}. ${tr(view, window.state === "exhausted" ? "Observed exhausted." : window.state === "unknown" ? "Window status unknown." : "Observed available.")}</span>${outsideFocus(row, window) ? html`<p class="sa-note">${tr(view, "Required exhaustion evidence outside the monitoring focus. This choice does not disable the cooldown.")}</p>` : null}</li>`)}</ul>${row.quota.extraUsage.usedCredits !== null && row.quota.extraUsage.monthlyLimit !== null ? html`<p class="sa-note">${tr(view, "Extra usage:")} ${row.quota.extraUsage.usedCredits} ${tr(view, "of")} ${row.quota.extraUsage.monthlyLimit} ${tr(view, "provider credit units")}${row.quota.extraUsage.currency ? ` (${row.quota.extraUsage.currency}, ${tr(view, "decimal scale")} ${row.quota.extraUsage.decimalPlaces ?? tr(view, "unknown")})` : ` (${tr(view, "currency unknown")})`}. ${tr(view, "This is separate from the deployment's token budget.")}</p>` : null}<p class="sa-note">${tr(view, "Known exhausted windows remain visible and still apply at pickup, even outside the monitoring focus. Quota is shared by jobs using this connection and application bucket. Unknown or stale observations are not remaining capacity; deployment token windows still apply. A fallback is checked separately at pickup.")}</p>${commands(view, row, true)}</article>`) }${data.connections.length ? null : empty(data)}</div>` });
}
