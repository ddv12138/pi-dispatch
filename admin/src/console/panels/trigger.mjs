import { TRIGGER_RECIPES } from "../../trigger-recipes.mjs";
/** Trigger pages keep prompt text private and use the same add/edit contracts as the tools (#750). */
import { triggerWhoMayFire } from "../../trigger-policy.mjs";
import { outcomeWord, reasonWords, recordReason } from "../../words.mjs";
import { planTriggerAdd } from "../../write-plans.mjs";
import { triggerBundleOf } from "../../read-model.mjs";
import { reserveText } from "../actions.mjs";
import { PR_ACTIONS } from "@edgehero/pi-dispatch/triggers";
import { fileTrouble } from "./config.mjs";
import { html as escapedHtml } from "../html.mjs";
// Keep indented source readable without emitting whitespace-only lines when an optional fragment is absent.
const html = (strings, ...values) => escapedHtml(strings.map(s => s.replace(/[ \t]*\n[ \t]*/g, "\n")), ...values);
import * as ui from "../kit.mjs";
import { uiText } from "../locale.mjs";
import { canAct, shownPath, runLink, tokensHtml, timeHtml } from "./common.mjs";
import { actForm, field, area, table, facts } from "./config-ui.mjs";
const t = (message, v) => uiText(message, v?.locale);
const card = (v, title, body) => body === undefined
  ? ui.card({ title: v, body: title })
  : ui.card({ title: t(title, v), body });
const fieldL = (view, name, label, options = {}) => {
  const translatedOptions = options.options?.map((option) => {
    if (typeof option === "string") return { value: option, label: t(option, view) };
    return { ...option, label: t(option.label, view) };
  });
  return field(name, t(label, view), { ...options, ...(options.hint ? { hint: t(options.hint, view) } : {}), ...(translatedOptions ? { options: translatedOptions } : {}), locale: view.locale });
};
const areaL = (view, name, label, options = {}) => area(name, t(label, view), { ...options, ...(options.hint ? { hint: t(options.hint, view) } : {}), locale: view.locale });
const detail = (v) => v.data?.triggerDetail ?? {};
const trigger = (v) =>
  detail(v).trigger ?? v.data?.snapshot?.triggers?.triggers?.[v.query?.index];
const defaults = (v) =>
  v.data?.triggerEditor?.defaults ??
  v.data?.snapshot?.triggerEditor?.defaults ??
  {};
const opts = (v) =>
  v.data?.triggerEditor ?? v.data?.snapshot?.triggerEditor ?? {};
const show = (x) =>
  x === undefined || x === null
    ? "not set"
    : typeof x === "object"
      ? JSON.stringify(x)
      : String(x);
const gateText = triggerWhoMayFire;
export function triggerTitle(v) {
  const found = trigger(v);
  return found
    ? `${found.type} ${found.phrase ?? found.id ?? found.action?.join(", ") ?? ""} → ${found.flow ?? found.command ?? uiText("deployment default", v.locale)}${found.forge ? ` · ${found.forge}` : ""} · ${uiText("row", v.locale)} ${v.query.index + 1}`
    : t("Trigger unavailable", v);
}
export function triggerOn(v) {
  const triggerRow = trigger(v);
  if (!triggerRow)
    return card(v,
      "What starts it",
      html`<p>
        ${fileTrouble(v.data?.snapshot?.triggers, "triggers file", v.data?.snapshot, v.locale) ?? t("This row does not exist. Return to Configuration.", v)}
      </p>`,
    );
  return card(v,
    "What starts it",
    html`${facts([
      ["Kind", triggerRow.type],
      ["Phrase or schedule", triggerRow.phrase ?? triggerRow.pattern ?? show(triggerRow.action)],
      ["Forge", triggerRow.forge ?? "local"],
      [uiText("Repository", v.locale), triggerRow.repository ?? uiText("any allowed repository", v.locale)],
      [
        uiText("Who may fire it", v.locale),
        gateText(triggerRow),
      ],
    ])}${triggerRow.type === "comment" ? html`<p>${uiText("Write", v.locale)} <code>${`${triggerRow.phrase} <flow>`}</code> ${uiText("to choose another flow named by a trigger in this file. Otherwise this trigger's default flow runs.", v.locale)}</p>` : null}`,
  );
}
export function triggerRuns(v) {
  const d = detail(v);
  const rows = d.lastRuns ?? [];
  return card(v,
    "Runs it started",
    html`<p>
        <b
          >${d.historyIncomplete ? `${t("at least", v)} ` : ""}${d.count24h ??
          "unknown"}</b
        >
        ${t("runs in the last 24 hours ·", v)} ${tokensHtml(d.cost24hTokens)} ${t("settled", v)}
        spend${d.costIncomplete
          ? ` (${t("metered portion only; some runs have no cost", v)})`
          : ""}.
      </p>
      ${table(
        t("Last five trigger runs", v),
        ["Run", "Project", "Outcome", "Reason"].map(x => t(x, v)),
        rows.map(
          (r) =>
            html`<tr>
              <td>${runLink(r.jobId)}</td>
              <td>${r.project ?? r.target ?? "-"}</td>
              <td>${outcomeWord(r.outcome, recordReason(r)).word ?? r.outcome ?? "-"}</td>
              <td>${recordReason(r) ? reasonWords(recordReason(r)).sentence ?? t("No explanation is available for this run reason.", v) : t("No reason was recorded.", v)}</td>
            </tr>`,
        ),
        uiText("No runs were found in the available history.", v.locale),
      )}
      <p>
        ${uiText("Jobs in line now:", v.locale)}
        ${(d.queued ?? []).map((j) => runLink(j.jobId ?? j.id))}${d.queued
          ?.length
          ? null
          : d.queued == null ? uiText("unavailable; the queue could not be read", v.locale) : uiText("none in view", v.locale)}.
      </p>`,
  );
}
export const EDIT_FIELDS = Object.freeze([
  "flow",
  "backend",
  "provider",
  "model",
  "maxTurns",
  "progress",
  "statusComment",
  "steer",
  "recover",
]);
export const HAND_FIELDS = Object.freeze([
  "maxTokens",
  "models",
  "mcp",
  "secrets",
  "secretBundle",
  "resume",
  "awaitInput",
  "image",
  "waitFor",
  "replicas",
  "packages",
  "skillsDir",
  "instructions",
  "task",
  "kind",
  "folder",
  "repository",
  "command",
  "portfolio",
  "github",
  "fallbackModels",
  "secretsProfile",
  "gates",
  "gateTimeout",
  "gateBudgetRaiseTokens",
  "excludeTools",
]);
export function triggerRun(v) {
  const t = trigger(v);
  if (!t) return html``;
  const def = defaults(v);
  const backend = t.backend ?? def.backend ?? "local";
  const bundle = triggerBundleOf(t, v.data?.snapshot?.secretBundles);
  const bundleNames = (v.data?.snapshot?.secretBundles?.bundles ?? []).map(b=>`${b.project ?? "project"}: ${b.id}`).join(", ");
  return card(v,
    "What it runs",
    html`<h3>${uiText("Edit here", v.locale)}</h3>
      ${facts(
        EDIT_FIELDS.filter(
          (k) => t.type !== "cron" || !["statusComment", "recover"].includes(k),
        ).map((k) => [
          `run.${k}`,
          `${["folder", "skillsDir"].includes(k) ? show(shownPath(t[k])) : show(k === "kind" ? t.forge ?? "local" : t[k])}; ${uiText("deployment default:", v.locale)} ${show(def[k])}`,
        ]),
      )}
      <h3>${uiText("By hand", v.locale)}</h3>
      ${facts(
        HAND_FIELDS.map((k) => [
          `run.${k}`,
          `${["instructions", "task"].includes(k) ? uiText(t[k] ? "set (operator only)" : "not set", v.locale) : ["folder", "skillsDir"].includes(k) ? show(shownPath(t[k])) : show(k === "kind" ? t.forge ?? "local" : t[k])}; ${uiText("deployment default:", v.locale)} ${show(def[k])}`,
        ]),
      )}
      <p>${uiText(t.type === "cron" ? "The schedule's owning host runs a cron trigger's local folder; the registry alone does not prove which host has that folder." : "Hosts missing its required secret or wait profile are excluded where their capability list is published.", v.locale)}</p>
      <p>
        ${ui.icon("shield")}
        <span class="code">${backend}</span
        >${t.backend ? ` (${uiText("trigger override", v.locale)})` : ` (${uiText("deployment default", v.locale)})`}.
      </p>
      <p>
        ${t.once
          ? uiText("A one-shot never races.", v.locale)
          : `${t.replicas ?? 1} ${uiText("independent runs race each event, on separate branches and, for development flows, separate pull requests.", v.locale)}`}
        ${uiText("Secret profile:", v.locale)} ${t.secretsProfile ?? uiText("none", v.locale)}. ${uiText("Bundle:", v.locale)}
        ${t.secretBundle === false
          ? uiText("opted out", v.locale)
          : (bundle?.id ?? (bundleNames ? `${uiText("By event project:", v.locale)} ${bundleNames}` : uiText("no declared project bundle", v.locale)))}.
      </p>`,
  );
}
export function editFields(v, t = {}, group = null) {
  return html`${EDIT_FIELDS.filter(
    (k) => (t.type !== "cron" || !["statusComment", "recover"].includes(k)) && (group === null || (group === "options" ? ["progress","statusComment","steer","recover"].includes(k) : !["progress","statusComment","steer","recover"].includes(k))),
  ).map((k) =>
    field(k, k === "backend" ? "Backend (run.backend)" : ({ progress: "Report phases (run.progress)", statusComment: "Status comment (run.statusComment)", steer: "Take messages (run.steer)", recover: "Recover (run.recover)" }[k] ?? `run.${k}`), {
      value: t[k] ?? "",
      required: k === "flow",
      type:
        k === "maxTurns"
          ? "int"
          : ["progress", "statusComment", "steer", "recover"].includes(k)
            ? "json"
            : null,
      options: ["progress", "statusComment", "steer", "recover"].includes(k)
        ? [
            {
              value: "",
              label: t.type ? `${uiText("Keep current", v.locale)} (${show(t[k])})` : `${uiText("Deployment default", v.locale)} (${show(defaults(v)[k])})`,
            },
            "true",
            "false",
          ]
        : k === "backend"
          ? [
              {
                value: "",
                label: t.type ? `${uiText("Keep current", v.locale)} (${t.backend ?? uiText("deployment default", v.locale)})` : `${uiText("Deployment default", v.locale)} (${defaults(v).backend ?? "local"})`,
              },
              ...(opts(v).backends ?? []).map((b) =>
                typeof b === "string" ? b : { value: b.name, label: `${b.name}: live transcript ${b.serves?.liveTranscript ?? "no"}, steering ${b.serves?.steering ?? "no"}, recovery ${b.serves?.recovery ?? "no"}` },
              ),
            ]
          : null,
      hint: k === "flow" ? uiText("Required: name the skill to run; its location is explained below.", v.locale) : `${uiText(t.type ? "Blank keeps the current value" : "Blank uses", v.locale)} ${show(t.type ? t[k] : defaults(v)[k])}${t.type ? `; ${uiText("deployment default:", v.locale)} ${show(defaults(v)[k])}` : ""} ${uiText(({ progress: "Needs progress publishing and a capable image.", statusComment: "Needs forge access; unavailable for cron.", steer: "Needs a venue and image that support steering.", recover: "Needs recovery support, a safe workspace and a replayable event; unavailable for cron." }[k] ?? ""), v.locale)}`,
      locale: v.locale,
    }),
  )}`;
}
export function triggerEdit(v) {
  const t = trigger(v);
  return !t || !canAct(v)
    ? html``
    : card(v,
        "Edit",
        actForm("trigger-edit", {
          hidden: [["index", v.query.index, "int"]],
          fields: editFields(v, t),
          label: `${uiText("Preview edit of row", v.locale)} ${v.query.index + 1}`, locale: v.locale,
        }),
      );
}
export function triggerTrust(v) {
  const t = trigger(v);
  if (!t) return null;
  return card(v,
    "Trust model",
    html`<p>
        ${gateText(t)} ${uiText("Each forge delivery is checked against its configured authentication, bot-loop guard, sender permissions and duplicate protection, then applicable quiet hours, image, repository protection and spend caps. Cron starts from the deployment schedule instead of a webhook. A comment may select another flow; only one comment trigger per forge may be declared.", v.locale)}
      </p>
      <p>
        ${uiText("Keeping a session continues its retained conversation on the same issue. Nothing merges by itself.", v.locale)}
      </p>
      ${t.instructions
        ? v.role === "operator"
          ? html`<h3>Instructions</h3>
              <blockquote>
                <pre>
${v.data?.snapshot?.triggerInstructions?.[v.query.index] ??
                  "Instructions could not be read. Reload to try again."}</pre
                >
              </blockquote>`
    : html`<p>${uiText("This trigger has instructions. Their text is available to an operator only.", v.locale)}</p>`
        : html`<p>${uiText("No instructions are set.", v.locale)}</p>`}${t.task &&
      v.role === "operator"
        ? html`<h3>Task</h3>
            <pre>
${v.data?.snapshot?.triggerTasks?.[v.query.index] ??
              "Task could not be read."}</pre
            >`
        : null}`,
  );
}
export function triggerKinds(v) {
  const t = trigger(v);
  if (!t) return null;
  const d = detail(v);
  return card(v,
    "Other kinds",
    html`${t.type === "cron"
      ? html`<p>
            ${uiText("Next fire:", v.locale)} ${timeHtml(d.cron?.next ?? t.next)}. ${uiText("Health:", v.locale)}
            ${d.cron?.next == null ? uiText("not known (schedule not published)", v.locale) : d.cron.overdueMs > 0 ? uiText("overdue", v.locale) : uiText("on time", v.locale)}; ${uiText("stalls", v.locale)}
            ${t.stalls ?? d.cron?.stalls ?? uiText("not known", v.locale)} ${uiText("of", v.locale)} ${d.cron?.stallLimit ?? uiText("not published", v.locale)}.
          </p>
          ${canAct(v)
            ? v.data?.triggerFireCheck?.refusal
              ? html`<p>${v.data.triggerFireCheck.refusal}</p>`
              : v.data?.triggerFireCheck?.plan
                ? html`<p>
                      ${v.data.triggerFireCheck.plan.summary ? uiText(v.data.triggerFireCheck.plan.summary, v.locale) : uiText("Fire this schedule once.", v.locale)}
                      ${uiText("Paid:", v.locale)} ${reserveText(v.data.triggerFireCheck.plan.reserve)}
                    </p>
                    ${actForm("trigger-fire", {
                      hidden: [["index", v.query.index, "int"]],
                      label: uiText("Fire now", v.locale), locale: v.locale,
                    })}`
                : html`<p>${uiText("Fire now cannot be checked here.", v.locale)}</p>`
            : null}`
      : html`<p>
          ${t.once
            ? t.disarmed
              ? `Spent by ${t.disarmed.jobId ?? "a run"}; clear on.disarmed by hand to re-arm it.`
              : uiText("One-shot armed.", v.locale)
            : uiText("This trigger is not a schedule or a one-shot.", v.locale)}
        </p>`}`,
  );
}
export function triggerChange(v) {
  const t = trigger(v);
  return card(v,
    "Before you change it",
    html`<p>${uiText("A job already in line is refused if this trigger has gained a field the job lacks. Adding or deleting a row renumbers the rows after it.", v.locale)}</p>
      <p>
        ${!t || detail(v).skewed == null
          ? (detail(v).skewReason ??
            uiText("Jobs that would be refused cannot be checked here.", v.locale))
          : `${detail(v).skewIncomplete ? `${uiText("At least", v.locale)} ` : ""}${detail(v).skewed?.length ?? 0} ${uiText("jobs in view would be refused now.", v.locale)}${detail(v).skewIncomplete ? ` ${uiText("The queue check was incomplete.", v.locale)}` : ""}`}
      </p>
      <p>${fileTrouble(v.data?.snapshot?.triggers, "triggers file", v.data?.snapshot, v.locale) ?? uiText("The triggers file loads.", v.locale)}</p>
      ${(detail(v).skewed ?? []).map(job => html`<p>${runLink(job.jobId)}: ${job.field ?? job.conditions ?? "trigger changed"}</p>`)}
      ${t && canAct(v)
        ? actForm("trigger-delete", {
            hidden: [["index", v.query.index, "int"]],
            label: `${uiText("Delete row", v.locale)} ${v.query.index + 1}`, locale: v.locale,
          })
        : null}`,
  );
}
export function triggerAdd(v) {
  if (v.readOnly)
    return card(v,
      "Add a trigger",
      html`<p>${uiText("Forms are off on this read-only console.", v.locale)}</p>`,
    );
  const recipe = TRIGGER_RECIPES[v.query?.recipe] ?? null;
  const prefill = recipe?.fields ?? {};
  const forges = opts(v).forges ?? [];
  const missingForge = Boolean(prefill.forge && !forges.includes(prefill.forge));
  const kinds = ["cron", "label", "comment", "pull_request", "issue"];
  const starts = html`${fieldL(v, "kind", "Kind", {
    options: kinds,
    value: prefill.kind ?? "label",
  })}${kinds.map(
    (kind) =>
      html`<fieldset data-trigger-kind="${kind}">
        <legend>${uiText(kind === "pull_request" ? "Pull request" : kind === "issue" ? "Issue" : kind === "cron" ? "Cron" : kind === "label" ? "Label" : "Comment", v.locale)}</legend>
        ${kind === "cron"
          ? html`${fieldL(v, "id", "Scheduler id", { value: prefill.id ?? "" })}${fieldL(v,
              "pattern",
              "Cron pattern (5 or 6 fields)", { value: prefill.pattern ?? "" },
            )}${fieldL(v, "folder", "Local repository folder", { required: prefill.kind === "cron", hint: prefill.kind === "cron" ? "Choose the existing local repository folder. No sample path is saved for you." : null })}${areaL(v,
              "task",
              "Task", { required: prefill.kind === "cron", hint: null },
            )}`
          : html`${fieldL(v, "forge", "Forge", {
              options: missingForge ? [{ value: "", label: uiText("Choose a configured forge", v.locale) }, ...forges] : forges, value: missingForge ? "" : prefill.forge ?? "", required: true, hint: opts(v).forges?.length ? "Only forges with configured webhooks are offered." : "No webhook is configured. Configure a forge connection or choose cron.",
            })}${["label", "comment"].includes(kind)
              ? fieldL(v, "repository", "Repository (optional)")
              : null}${kind === "comment"
              ? fieldL(v, "phrase", "Comment phrase", { value: prefill.phrase ?? "" })
              : null}${["label", "pull_request"].includes(kind)
              ? fieldL(v, "labels", "Labels (required for labeled)", {
                  type: "list", value: prefill.labels ?? "",
                })
              : null}${["pull_request", "issue"].includes(kind)
              ? html`${fieldL(v, "action", "Actions (forge words)", {
                  type: "list",
                  options: kind === "issue" ? ["closed"] : [...PR_ACTIONS.github],
                  hint: "Submitted reviews fire on every verdict unless reviewState narrows them.",
                })}${kind === "pull_request"
                  ? fieldL(v, "reviewState", "Review states", { type: "list" })
                  : null}${fieldL(v, "number", "Issue or pull request number", {
                  type: "int",
                })}${fieldL(v, "once", "One-shot", {
                  type: "json",
                  options: ["false", "true"],
                })}`
              : null}`}
      </fieldset>`,
  )}`;
  return card(v,
    "Add a trigger",
    html`${recipe ? html`<p class="su-small">${uiText("Recipe:", v.locale)} <b>${recipe.title}</b>. ${uiText("Change any field before the preview.", v.locale)}${missingForge ? ` ${uiText("This recipe needs a GitHub webhook; configure Connections or choose a different configured forge.", v.locale)}` : null}${prefill.kind === "cron" ? ` ${uiText("Add the existing folder; the schedule is 02:00 in the deployment’s configured timezone (UTC by default).", v.locale)}` : null}</p>` : null}<p>${uiText("Preview the added lines, then confirm with a person's single-use five-minute ticket.", v.locale)}</p>
      ${actForm("trigger-add", {
        structured: "trigger",
        fields: html`<h3>${uiText("1.", v.locale)} ${uiText("What starts it", v.locale)}</h3>
          ${starts}
          <h3>${uiText("2.", v.locale)} ${uiText("What it runs", v.locale)}</h3>
          ${editFields(v, { flow: prefill.flow ?? "" }, "run")}
          <p>
            ${uiText("The flow's skill must live in the repository's .pi/skills or .agents/skills, or an available deployment skill tier. Suggestions:", v.locale)}
            ${(opts(v).flows ?? [])
              .map((f) => (typeof f === "string" ? f : `${f.name} (${f.tier})`))
              .join(", ") || uiText("none found", v.locale)}.
          </p>
          <h3>${uiText("3.", v.locale)} ${uiText("Run options", v.locale)}</h3><div class="config-options">${editFields(v, {}, "options")}</div>
          <p>${uiText("run.progress reports phases; run.statusComment needs forge access; run.steer needs steering support; run.recover needs recovery support. Cron cannot set statusComment or recover to true.", v.locale)}</p>
          <h3>${uiText("4.", v.locale)} ${uiText("Set by hand", v.locale)}</h3>
          <p>${uiText("The console never sets the job cap, allowed models, MCP servers, session, image, secrets, waits or replicas; new adds opt out of project secret bundles (run.secretBundle: false). Change the bundle opt-out and these other fields by hand in the triggers file.", v.locale)}</p>`,
          label: uiText("Preview the add", v.locale), locale: v.locale,
      })}
      <details>
        <summary>${uiText("Or paste the add tool's fields as JSON", v.locale)}</summary>
        ${actForm("trigger-add", {
          fields: areaL(v, "trigger", "Add tool fields (JSON)", {
            type: "json",
            required: true,
          }),
          label: uiText("Preview the JSON add", v.locale), locale: v.locale,
        })}
      </details>`,
  );
}
export function triggerKindHelp(v = {}) { return card(v,
    "The five kinds",
    html`<p>
      ${uiText("Cron runs a task in a local repository on a schedule. Label starts on an issue label, never a pull request. Comment matches a phrase, with one per forge. Pull request matches forge actions and reviews. Issue matches closing; a one-shot also names its number.", v.locale)}
    </p>`,
  );
}

export function triggerForgeWords(v = {}) { return card(v,
    "Pull request words per forge",
    facts(
      Object.entries(PR_ACTIONS).map(([forge, words]) => [
        forge,
        [...words].join(", "),
      ]),
    ),
  );
}

export function triggerRefusalExamples() {
  const shared = { paths: { triggersPath: "triggers.json" }, env: { PI_BACKENDS: "local" }, tool: "this form", surface: "console" };
  return [
    { field: "maxTurns", params: { kind: "label", flow: "triage", labels: ["pi"], maxTurns: 0 } },
    { field: "statusComment", params: { kind: "cron", id: "nightly", pattern: "0 3 * * *", folder: "repository", task: "Review", flow: "triage", statusComment: true } },
    { field: "backend", params: { kind: "label", flow: "triage", labels: ["pi"], backend: "openshell" } },
    { field: "maxTokens", params: { kind: "label", flow: "triage", labels: ["pi"], maxTokens: "1" } },
  ].map(({field,params}) => ({field, sentence: planTriggerAdd({ ...shared, params }).refusal}));
}
export function triggerRefusals(v = {}) {
  return card(v, "Refusals",html`<p>${uiText("Each field below shows the shared planner's own refusal.", v.locale)}</p>${triggerRefusalExamples().map(({field,sentence}) => html`<p><b>${uiText(field, v.locale)}</b>: ${uiText(sentence, v.locale)}${sentence?.includes("Nothing was changed") ? "." : ` ${uiText("Nothing was changed.", v.locale)}`}</p>`)}`);
}
