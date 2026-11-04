/** Generic landing pages survive cross-site Strict-cookie navigation without replacing the session (#754). */
import { html } from "./html.mjs";
import { frameHtml } from "./shell.mjs";
import * as ui from "./kit.mjs";
import { uiText } from "./locale.mjs";

export function gatewayLanding({ mode = "launch", theme = null, locale = "en", gesture = true } = {}) {
  const stepUp = mode === "authorize";
  const body = html`<section class="gw-stepup" data-sandbox-gateway-mode="${["launch", "authorize", "return", "select"].includes(mode) ? mode : "return"}" data-sandbox-gateway-gesture="${mode === "launch" && gesture ? "1" : "0"}">
${ui.card({ title: stepUp ? "Verify this terminal opening" : "Browser terminal", sub: "a separate gateway, attached to an already-open sandbox", body: html`
<p id="gateway-status" role="status" aria-live="polite">${uiText("Checking your original console sign-in.", locale)}</p>
<div id="gateway-details" hidden><h2 id="gateway-target">${uiText("Sandbox", locale)}</h2><p id="gateway-person"></p><p>${uiText("The gateway attaches to this existing shell. It cannot start a sandbox. Closing its tab disconnects and keeps the shell; End remains a separate confirmed action.", locale)}</p></div>
<form id="gateway-step-up" method="post" action="/api/sandbox-gateway/authorize" hidden autocomplete="off">
${ui.field({ label: uiText("Your current operator token", locale), id: "gateway-token", control: ui.input({ id: "gateway-token", type: "password", autocomplete: "off", spellcheck: false, disabled: true }), hint: uiText("Enter the token used for this sign-in. It stays on the console origin and is not saved.", locale) })}
${ui.btn({ id: "gateway-authorize", type: "submit", label: uiText("Verify and open terminal", locale), kind: "primary", disabled: true })}</form>
<div id="gateway-gesture" hidden><p>${uiText("This opening did not start from a console page. Continue only if you meant to open this terminal.", locale)}</p>${ui.btn({ id: "gateway-continue", type: "button", label: uiText("Continue", locale), kind: "primary" })}</div>
<p id="gateway-phone" hidden>${uiText("Browser terminals require a window wider than 760 pixels. On a phone, open Sandboxes and copy the command for your terminal.", locale)}</p>
<p><a class="link" href="/runs/sandboxes">${uiText("Return to Sandboxes", locale)}</a></p>
<noscript><p>${uiText("Browser terminals need JavaScript for the original-tab and browser checks. No terminal was authorized. Open Sandboxes to use Open in Terminal or copy the command.", locale)}</p></noscript>` })}</section>`;
  return frameHtml({ name: "sandbox-gateway", title: uiText(stepUp ? "Confirm browser access" : "Open a sandbox terminal", locale), theme, locale }, body);
}

export async function gatewayApi(ctx, method) {
  try {
    const broker = ctx.deps.gateway;
    if (!broker) return ctx.json(503, { error: "Browser terminals are not configured. Use Open in Terminal or copy the sandbox command." });
    if (method === "authorize" && !ctx.deps.limiter.take()) return ctx.json(429, { error: "Too many verification attempts. Wait a minute, then restart from Sandboxes." }, { "retry-after": "60" });
    const result = await broker[method]({ session: ctx.session, body: ctx.body, origin: ctx.req.headers.origin, theme: ctx.gatewayTheme ?? null, actor: ctx.actor() });
    return ctx.json(result.ok ? 200 : result.refused === "unavailable" || result.refused === "audit" ? 503 : result.refused === "token" ? 403 : 409, result);
  } finally {
    // Tokens never join a generic preview payload, a retry, a returned document or the broker's retained state.
    if (ctx.body && Object.hasOwn(ctx.body, "token")) ctx.body.token = "";
  }
}
