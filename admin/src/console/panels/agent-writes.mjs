import { html } from "../html.mjs";
import * as ui from "../kit.mjs";
import { uiText } from "../locale.mjs";

const t = (view, text) => uiText(text, view?.locale);

export const AGENT_WRITES_UNAVAILABLE = "Agent writes today could not be verified from this console host's audit log. This is not a zero.";
export function overviewAgentWrites(view) {
  if (view.role !== "operator") return html``;
  const data = view.data?.agentWrites;
  if (!data) return html``;
  const exact = Number.isSafeInteger(data.count) && data.count >= 0 && !data.unavailable;
  return ui.card({ title: t(view, "Agent writes today"), sub: `${data.host ?? t(view, "This console host")}, ${t(view, "UTC today; local audit only")}`, body: html`${exact ? ui.kpi(`${data.partial ? t(view, "at least") + " " : ""}${data.count}`, t(view, "confirmed applied writes")) : html`<p>${t(view, AGENT_WRITES_UNAVAILABLE)}</p>`}${data.partial && exact ? html`<p class="card__sub">${t(view, "The read is partial or some audited intentions have no applied receipt. No wider total is inferred.")}</p>` : null}<a class="link" href="${"/audit?role=agent&action=write-applied"}">${t(view, "Open this host's agent audit history")}</a><p class="card__sub">${t(view, "The history link also includes earlier days. Every inverse still follows its current permission and confirmation rules.")}</p>` });
}
