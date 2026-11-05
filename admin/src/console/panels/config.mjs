/**
 * The configuration screen's panels, split out of `../panels.mjs` (issue #737), which re-exports what this module
 * exports. The rules every panel keeps (one pure, deterministic renderer per region, every value through `html`, the
 * role and run-text rule, the action controls and the PATHS rule) are stated once, in `../panels.mjs`'s header.
 */
import { triggerBundleOf } from "../../read-model.mjs";
import { VENUE_LABEL } from "../../words.mjs";
import { html as escapedHtml } from "../html.mjs";
// Keep indented source readable without emitting whitespace-only lines when an optional fragment is absent.
const html = (strings, ...values) => escapedHtml(strings.map(s => s.replace(/[ \t]*\n[ \t]*/g, "\n")), ...values);
import { DOCTOR_FILE_CHECKS, doctorQuote } from "../../doctor-view.mjs";
import { cell, ageText, shownPath, runLink, canAct } from "./common.mjs";
import {
  actForm,
  field,
  area,
  editor,
  table,
  facts,
  fromSnapshot,
  rowDelete,
} from "./config-ui.mjs";
import * as ui from "../kit.mjs";
import { uiText } from "../locale.mjs";
import { KNOWN_KEYS } from "@edgehero/pi-dispatch/runtime-settings";

// ---- configuration ---------------------------------------------------------------------------------------------------

/**
 * Why a file does not load, as one sentence: the newest published doctor check about that file where one was published
 * (issue #712, `doctorQuote`), naming the host and its age, else the pointer to run doctor. Never the parser's own
 * message, which names this host's path; a published label had its paths cut before it left the host that wrote it.
 */
function doctorReason(s, what, locale = "en") {
  const id = DOCTOR_FILE_CHECKS[what];
  const q = id ? doctorQuote(s, id) : null;
  if (!q) return locale === "zh" ? `${uiText(what, locale)}无法加载；请运行 pi-dispatch doctor 查看原因。` : `The ${what} does not load; run pi-dispatch doctor for the reason.`;
  const where = q.own
    ? `on this host (${q.host}, ${ageText(q.ageMs)} ago)`
    : `on ${q.host} (its own copy of the file, ${ageText(q.ageMs)} ago)`;
  if (locale !== "zh") return `The ${what} does not load. pi-dispatch doctor ${where} says: ${q.label}${q.fix ? `. Fix: ${q.fix}` : ""}`;
  const location = q.own ? `此主机（${q.host}，${ageText(q.ageMs)}前）` : `${q.host}（该主机自己的文件副本，${ageText(q.ageMs)}前）`;
  // The quoted label and fix are host-published diagnostic values, not this page's fixed copy. Keep them verbatim so
  // operators can match the worker's report exactly; paths are already redacted by doctorQuote at the source.
  return `${uiText(what, locale)}无法加载。pi-dispatch doctor 在${location}报告：${q.label}${q.fix ? `。修复方法：${q.fix}` : ""}`;
}

/** A file view's trouble as one sentence (no parser message: it names the host's path), or null when it loaded. */
export function fileTrouble(v, what, s = null, locale = "en") {
  const subject = uiText(what, locale);
  if (!v) return locale === "zh" ? `无法读取${subject}。` : `The ${what} could not be read.`;
  if (v.unset) return locale === "zh" ? `未配置${subject}。` : `No ${what} is configured.`;
  if (v.missing) return locale === "zh" ? `${subject}不存在。` : `The ${what} does not exist.`;
  if (v.invalid) return doctorReason(s, what, locale);
  // This field is a dynamic host diagnostic. Preserve its exact wording for operator troubleshooting.
  if (v.unreadable) return locale === "zh" ? `无法读取${subject}（${String(v.unreadable)}）。` : `The ${what} cannot be read (${String(v.unreadable)}).`;
  return null;
}

/** A trigger's selector, in the triggers file's own words. */
function triggerOn(t) {
  const list = (name, v) =>
    Array.isArray(v) && v.length > 0 ? `${name} ${v.join(", ")}` : null;
  switch (t.type) {
    case "watch":
      return `watch ${cell(t.id)} from ${cell(t.source)}`;
    case "cron":
      return [`cron ${cell(t.id)}`, t.pattern].filter(Boolean).join(" ");
    case "label":
      return [
        "label",
        list("any", t.any),
        list("all", t.all),
        list("none", t.none),
      ]
        .filter(Boolean)
        .join("; ");
    case "comment":
      return `comment ${JSON.stringify(t.phrase ?? "")}`;
    case "pull_request":
      return [
        "pull request",
        list("action", t.action),
        list("any", t.any),
        t.number ? `#${t.number}` : null,
        t.once ? "once" : null,
        t.disarmed ? "spent" : null,
      ]
        .filter(Boolean)
        .join("; ");
    case "issue":
      return [
        "issue",
        list("action", t.action),
        t.number ? `#${t.number}` : null,
        t.once ? "once" : null,
        t.disarmed ? "spent" : null,
      ]
        .filter(Boolean)
        .join("; ");
    default:
      return cell(t.type);
  }
}

/** A trigger's project secret bundle (issue #704) in words: the bundle a cron trigger's jobs hold, or its opt-out. */
function triggerBundleNote(t, bundles) {
  const at = triggerBundleOf(t, bundles);
  if (at === null) return null;
  return at.optedOut
    ? `opted out of ${at.id !== null ? `bundle ${at.id}` : "every project's bundle"}`
    : `bundle ${at.id}`;
}

/** What a trigger's jobs carry beyond the flow: each a short word or count, never a value. */
function triggerNotes(t, bundles = null) {
  return [
    t.resume ? "keeps a session" : null,
    t.replicas ? `${t.replicas} replicas` : null,
    t.secrets > 0
      ? `${t.secrets} secrets${t.secretsProfile ? ` (profile ${t.secretsProfile})` : ""}`
      : null,
    triggerBundleNote(t, bundles),
    Array.isArray(t.mcp) ? `mcp ${t.mcp.join(", ")}` : null,
    t.packages === false ? null : "staged packages",
    t.instructions ? "has instructions" : null,
    t.skillsDir ? `skills ${shownPath(t.skillsDir)}` : null,
    t.image ? `image ${t.image}` : null,
    t.backend ? `venue ${t.backend}` : null,
    t.maxTokens ? `job cap $${t.maxTokens}` : null,
    Array.isArray(t.fallbackModels) && t.fallbackModels.length > 0
      ? `fallbacks ${t.fallbackModels.join(", ")}`
      : null,
    t.portfolio ? "writes the budget split" : null,
  ]
    .filter(Boolean)
    .join("; ");
}

/** Human row numbers match the row buttons; machine indexes remain zero-based. */
const triggerAt = (i) => `row ${i + 1}`;

/** The triggers editor: a JSON entry to add (the add tool's fields), the edit tool's fields, and a delete by row. */
function triggersEditor(view) {
  return canAct(view)
    ? ui.btn({
        label: "Add a trigger",
        href: ui.pageHref(view.pages, "trigger-add") ?? "/config/trigger-add",
        kind: "primary",
      })
    : null;
}

export const configTriggers = fromSnapshot("Triggers", (s, view) => {
  const v = s.triggers;
  const trouble = fileTrouble(v, "triggers file", s, view.locale);
  if (trouble)
    return html`<p class="warn">${trouble}</p>
      ${triggersEditor(view)}`;
  const list = Array.isArray(v.triggers) ? v.triggers : [];
  return html`<p><a class="btn" href="/triggers">${uiText("Read trigger rules and check an event", view.locale)}</a></p>${list.some((t) => t.type === "watch")
    ? html`<p><a href="/watch">${uiText("Watch findings and boards", view.locale)}</a></p>`
    : null}${table(
    "Triggers",
    [{ num: "Row" }, "On", "Runs", "Model", "Notes", "Actions"],
    list.map((t, position) => {
      const i = t.index ?? position;
      const what = t.command ? `command ${t.command}` : `flow ${cell(t.flow)}`;
      const where =
        t.type === "cron"
          ? t.folder
            ? ` in ${shownPath(t.folder)}`
            : ""
          : t.forge
            ? ` on ${t.forge}`
            : "";
      const model =
        [t.provider, t.model].filter(Boolean).join(" / ") ||
        "deployment default";
      return html`<tr>
        <td class="num">${i + 1}</td>
        <td>
          <a href="${ui.pageHref(view.pages, "trigger", { index: i })}"
            >${triggerOn(t)}</a
          >
        </td>
        <td>${what}${where}</td>
        <td>${model}</td>
        <td>${triggerNotes(t, s.secretBundles) || "-"}</td>
        <td>
          <div class="acts">
            ${canAct(view)
              ? html`${ui.btn({
                  label: `${uiText("Edit row", view.locale)} ${i + 1}`,
                  href: `${ui.pageHref(view.pages, "trigger", { index: i })}#p-trigger-edit`,
                  kind: "sm",
                })}${rowDelete("trigger-delete", i, view.locale)}`
              : null}
          </div>
        </td>
      </tr>`;
    }),
    "The triggers file declares no trigger.",
    view.locale,
  )}${triggersEditor(view)}`;
});

/** Settings shown with their value; every other key the overlay sets is listed by name only. */
const SETTINGS_SHOWN = Object.freeze([
  "provider",
  "model",
  "maxTurns",
  "maxTokens",
  "concurrency",
  "dailyCap",
  "weeklyCap",
  "monthlyCap",
  "dailyTokenCap",
  "softHoldPct",
  "maxTokens",
  "dailyTokenCap",
  "weeklyTokenCap",
  "monthlyTokenCap",
]);

/** The settings editor: set a key to a value, or unset it back to its default (the `dispatch_set` tool's two shapes). */
function settingsEditor(view) {
  if (!canAct(view)) return null;
  return editor(
    uiText("Change a setting", view.locale),
    html`${actForm("setting-set", {
      fields: html`${field("key", "Key", { options: KNOWN_KEYS, locale: view.locale })}${field(
        "value",
        uiText("Value", view.locale),
        { required: true, locale: view.locale },
      )}`,
      label: uiText("Preview the change", view.locale), locale: view.locale,
    })}${actForm("setting-unset", {
      fields: field("key", "Key", { options: KNOWN_KEYS, locale: view.locale }),
      label: uiText("Preview the unset", view.locale), locale: view.locale,
    })}`,
  );
}

export const configSettings = fromSnapshot("Settings overlay", (s, view) => {
  const v = s.settings;
  if (!v || v.invalid)
    return html`<p class="warn">${doctorReason(s, "settings overlay")}</p>
      ${settingsEditor(view)}`;
  const overlay = v.overlay ?? {};
  const shown = KNOWN_KEYS;
  const others = Object.keys(overlay)
    .filter((k) => !SETTINGS_SHOWN.includes(k))
    .sort();
  return html`${shown.length === 0
      ? html`<p class="note">
        ${uiText("The overlay sets nothing; every setting is the deployment's environment or its default.", view.locale)}
      </p>`
    : facts(
        shown.map((k) => [
          k,
          overlay[k] === undefined ? "deployment default" : String(overlay[k]),
        ]),
      )}${others.length > 0
    ? html`<p class="note">${uiText("Also set:", view.locale)} ${others.join(", ")}</p>`
    : null}${settingsEditor(view)}`;
});

/** A pause window's fields, as the add and edit tools take them (an edit leaves a blank field as it was). */
function pauseFieldsHtml(required, w = {}, locale = "en") {
  return html`${field("scope", "Scope", {
    value:
      typeof w.scope === "string" && w.scope.startsWith("/")
        ? ""
        : (w.scope ?? ""),
    required,
            placeholder: w.scope
              ? `${uiText("Blank keeps", locale)} ${shownPath(w.scope)}`
              : uiText("owner/name, a folder, or *", locale),
    max: 4096, locale,
  })}${field("from", "From (HH:MM)", {
    value: w.from ?? "",
    required,
    max: 5, locale,
  })}${field("to", "To (HH:MM)", {
    value: w.to ?? "",
    required,
    max: 5, locale,
  })}${field("tz", "Zone (IANA, default UTC)", {
    value: w.tz ?? "",
    max: 64, locale,
  })}${field("days", "Days (mon..sun)", {
    value: w.days?.join(", ") ?? "",
    type: "list",
    max: 64, locale,
  })}${field("dateFrom", "From date (YYYY-MM-DD)", {
    value: w.dateFrom ?? "",
    max: 10, locale,
  })}${field("dateTo", "To date (YYYY-MM-DD)", {
    value: w.dateTo ?? "",
    max: 10, locale,
  })}`;
}

function pauseEditor(view) {
  if (!canAct(view)) return null;
  return editor(
    uiText("Change the pause windows", view.locale),
    html`${actForm("pause-window-add", {
      fields: pauseFieldsHtml(true, {}, view.locale),
      label: uiText("Preview the add", view.locale), locale: view.locale,
    })}`,
  );
}

export const configPauseWindows = fromSnapshot("Pause windows", (s, view) => {
  const v = s.pauseWindows;
  const trouble = fileTrouble(v, "pause-windows file", s, view.locale);
  if (trouble)
    return html`<p class="note">${trouble}</p>
      ${pauseEditor(view)}`;
  const list = Array.isArray(v.windows) ? v.windows : [];
  return html`${table(
    "Pause windows",
    ["Row", "Scope", "From", "To", "Zone", "Days", "Dates", "Actions"],
    list.map(
      (w, i) =>
        html`<tr>
          <td>${i + 1}</td>
          <td class="code">${shownPath(cell(w.scope))}</td>
          <td>${cell(w.from)}</td>
          <td>${cell(w.to)}</td>
          <td>${cell(w.tz)}</td>
          <td>
            ${Array.isArray(w.days) && w.days.length > 0
              ? w.days.join(", ")
              : "every day"}
          </td>
          <td>
            ${w.dateFrom || w.dateTo
              ? `${cell(w.dateFrom)} to ${cell(w.dateTo)}`
              : "-"}
          </td>
          <td>
            ${canAct(view)
              ? html`${editor(
                  `${uiText("Edit row", view.locale)} ${i + 1}`,
                  actForm("pause-window-edit", {
                    hidden: [["index", i, "int"]],
                    fields: pauseFieldsHtml(false, w, view.locale),
                    label: `${uiText("Preview edit of row", view.locale)} ${i + 1}`, locale: view.locale,
                  }),
                )}${rowDelete("pause-window-delete", i, view.locale)}`
              : null}
          </td>
        </tr>`,
    ),
    "No pause window is set.",
    view.locale,
  )}${pauseEditor(view)}`;
});

/** The scoped-limit fields a row may set, in the file's order, with how each reads. */
const LIMIT_FIELDS = Object.freeze([
  ["day", "jobs a day"],
  ["week", "jobs a week"],
  ["month", "jobs a month"],
  ["concurrent", "at once"],
  ["dayTokens", "a day"],
  ["weekTokens", "a week"],
  ["monthTokens", "a month"],
  ["memory", "memory"],
  ["cpus", "CPUs"],
  ["hostShare", "host share"],
  ["minJobs", "min jobs"],
]);

/** The scoped-limits editor: a row as the limit tools' fields (JSON), an edit of row N, a delete. */
function limitsEditor(view) {
  if (!canAct(view)) return null;
  const json = area("limit", "The row, as the limit tools' fields (JSON)", {
    type: "json",
    rows: 4,
    required: true,
    placeholder: '{"scope": "acme/web", "day": 10, "concurrent": 2}',
    locale: view.locale,
  });
  return editor(
    uiText("Change the scoped limits", view.locale),
    html`${actForm("limit-add", { fields: json, label: uiText("Preview the add", view.locale), locale: view.locale })}`,
  );
}

export const configScopedLimits = fromSnapshot("Scoped limits", (s, view) => {
  const v = s.scopedLimits;
  const trouble = fileTrouble(v, "scoped-limits file", s, view.locale);
  if (trouble)
    return html`<p class="note">${trouble}</p>
      ${limitsEditor(view)}`;
  const list = Array.isArray(v.limits) ? v.limits : [];
  return html`${table(
    "Scoped limits",
    ["Row", "Scope", "Limits", "Actions"],
    list.map(
      (l, i) =>
        html`<tr>
          <td>${i + 1}</td>
          <td class="code">${shownPath(cell(l.scope))}</td>
          <td>
            ${LIMIT_FIELDS.filter(([k]) => l[k] !== null && l[k] !== undefined)
              .map(
                ([k, words]) =>
                  `${k.endsWith("Usd") ? `$${l[k]}` : l[k]} ${uiText(words, view.locale)}`,
              )
              .join("; ") || "-"}
          </td>
          <td>
            ${canAct(view)
              ? html`${editor(
                  `${uiText("Edit row", view.locale)} ${i + 1}`,
                  actForm("limit-edit", {
                    hidden: [["index", i, "int"]],
                    fields: area(
                      "limit",
                      uiText("Fields to change (JSON; omitted fields keep their values)", view.locale),
                      {
                        type: "json",
                        locale: view.locale,
                        value: JSON.stringify(
                          {
                            ...l,
                            ...(typeof l.scope === "string" &&
                            l.scope.startsWith("/")
                              ? { scope: undefined }
                              : {}),
                          },
                          null,
                          2,
                        ),
                      },
                    ),
                    label: `${uiText("Preview edit of row", view.locale)} ${i + 1}`, locale: view.locale,
                  }),
                )}${rowDelete("limit-delete", i, view.locale)}`
              : null}
          </td>
        </tr>`,
    ),
    "No scoped limit is set.",
    view.locale,
  )}${limitsEditor(view)}`;
});

/** The projects, envelope, priorities and revert editors. */
function projectsEditor(view) {
  if (!canAct(view)) return null;
  const members = (required) =>
    area("members", "Members, one repository or folder per line", {
      rows: 3,
      required,
      max: 16384,
      locale: view.locale,
    });
  return editor(
    uiText("Change the projects", view.locale),
    html`${actForm("project-add", {
        fields: html`${field("id", uiText("Id", view.locale), { required: true, max: 64, locale: view.locale })}${field(
          "name",
          uiText("Name (optional)", view.locale),
          { locale: view.locale },
        )}${members(true)}`,
        label: uiText("Preview the add", view.locale), locale: view.locale,
      })}
      <p class="note">
        <a href="/insights/budget-split"
          >${uiText("Edit the envelope, priorities and allocation history in Budget split", view.locale)}
          </a
        >.
      </p>`,
  );
}

export const configProjects = fromSnapshot("Projects", (s, view) => {
  const v = s.projects;
  const trouble = fileTrouble(v, "projects file", s, view.locale);
  if (trouble)
    return html`<p class="note">${trouble}</p>
      ${projectsEditor(view)}`;
  const list = Array.isArray(v.projects) ? v.projects : [];
  return html`${table(
    "Projects",
    ["Row", "Project", "Name", "Members", "Actions"],
    list.map(
      (p, i) =>
        html`<tr>
          <td>${i + 1}</td>
          <td class="code"><a href="${`/config/project?id=${encodeURIComponent(p.id)}`}">${cell(p.id)}</a></td>
          <td>${cell(p.name)}</td>
          <td class="mono">
            ${Array.isArray(p.members) && p.members.length > 0
              ? p.members.map(shownPath).join(", ")
              : "-"}
          </td>
          <td>
            ${canAct(view)
              ? html`${editor(
                  `${uiText("Edit row", view.locale)} ${i + 1}`,
                  actForm("project-edit", {
                    hidden: [["id", p.id]],
                    fields: html`${field("name", "Name", {
                      value: p.name ?? "",
                      locale: view.locale,
                    })}${area(
                      "members",
                      "Members (blank keeps the current list)",
                      {
                        locale: view.locale,
                        value: p.members?.some((m) => m.startsWith("/"))
                          ? ""
                          : (p.members?.join("\n") ?? ""),
                      },
                    )}`,
                    label: `${uiText("Preview edit of row", view.locale)} ${i + 1}`, locale: view.locale,
                  }),
                )}${actForm("project-delete", {
                  hidden: [["id", p.id]],
                    label: `${uiText("Delete row", view.locale)} ${i + 1}`, locale: view.locale,
                })}`
              : null}
          </td>
        </tr>`,
    ),
    "The projects file declares no project.",
    view.locale,
  )}${facts([
    ["Allocation envelope", s.envelopeSet ? "set" : "not set"],
  ])}${projectsEditor(view)}`;
});

/** The detail pages own these panels and writes; Configuration keeps one useful line per source. */
export const configMcp = fromSnapshot("MCP servers", (s, v) => html`<p>${s.overlayMcp?.servers?.length ?? uiText("Unknown", v.locale)} ${uiText("overlay", v.locale)} ${uiText(s.overlayMcp?.servers?.length === 1 ? "server" : "servers", v.locale)}. <a class="link" href="/config/connections#p-mcp">${uiText("Open Connections", v.locale)}</a></p>`);
export const configPackages = fromSnapshot("Staged pi packages", (s, v) => html`<p>${s.stagedPackages?.packages?.length ?? uiText("Unknown", v.locale)} ${uiText("packages staged.", v.locale)} <a class="link" href="/config/connections#p-packages">${uiText("Open Connections", v.locale)}</a>. <a class="link" href="/config/updates">${uiText("See what is newer", v.locale)}</a></p>`);
export const configSecretProfiles = fromSnapshot("Secret profiles", (s, v) => html`<p>${s.secretProfiles?.profiles?.length ?? 0} ${uiText("profiles in view.", v.locale)} <a class="link" href="/config/secrets#p-secret-profiles">${uiText("Open Secrets", v.locale)}</a></p>`);
export const configSecretBundles = fromSnapshot("Secret bundles", (s, v) => html`<p>${s.secretBundles?.bundles?.length ?? 0} ${uiText("project bundles in view.", v.locale)} <a class="link" href="/config/secrets#p-secret-bundles">${uiText("Open Secrets", v.locale)}</a></p>`);

const shortFile = (path, fallback) => typeof path === "string" && path ? `…/${path.split(/[\\/]/).filter(Boolean).slice(-2).join("/")}` : fallback;
export function configDescription(v) {
  const s = v.data?.snapshot;
  const locations = v.data?.configLocations ?? {};
  const settings = locations.settings ?? (s?.settings?.path?.endsWith("/.pi-dispatch/settings.json") ? "~/.pi-dispatch/settings.json" : shortFile(s?.settings?.path, "settings overlay unavailable"));
  const outside = locations.settingsOutsideDeployment === true || settings === "~/.pi-dispatch/settings.json";
  return `${uiText("Settings", v.locale)}: ${settings}${outside ? ` (${uiText("outside the deployment folder", v.locale)})` : ""}. ${uiText("Triggers", v.locale)}: ${locations.triggers ?? shortFile(s?.triggers?.path, uiText("triggers file unavailable", v.locale))}.`;
}
export function configNavigation(v) {
  const s = v.data?.snapshot ?? {};
  const sections = [
    ["settings", uiText("Settings", v.locale), Object.keys(s.settings?.overlay ?? {}).length],
    ["triggers", uiText("Triggers", v.locale), s.triggers?.triggers?.length ?? 0],
    ["pause-windows", uiText("Pause windows", v.locale), s.pauseWindows?.windows?.length ?? 0],
    ["scoped-limits", uiText("Scoped limits", v.locale), s.scopedLimits?.limits?.length ?? 0],
    ["projects", uiText("Projects", v.locale), s.projects?.projects?.length ?? 0],
    ["files", uiText("Files", v.locale), 2],
    ["unset", uiText("Unset", v.locale), 0],
    ["mcp-servers", uiText("MCP servers", v.locale), s.overlayMcp?.servers?.length ?? 0],
  ];
  return html`<nav class="config-sections" aria-label="${uiText("Configuration sections", v.locale)}">
    ${sections.map(([id, label, count]) =>
      ui.fpill({ label, count, href: `#cf-${id}` }),
    )}<span class="config-divider" aria-hidden="true"></span>${ui.btn({
      label: uiText("Secrets", v.locale),
      href: ui.pageHref(v.pages, "secrets") ?? "/config",
      kind: "sm",
    })}${ui.btn({
      label: uiText("Connections", v.locale),
      href: ui.pageHref(v.pages, "connections") ?? "/config",
      kind: "sm",
    })}
  </nav>`;
}
export const configFiles = fromSnapshot(
  "Files",
  (s, v) => html`<p>${configDescription(v)}</p>`,
);
export const configUnset = fromSnapshot("Unset a setting", (s, v) =>
  canAct(v)
    ? actForm("setting-unset", {
        fields: field("key", uiText("Key", v.locale), { options: KNOWN_KEYS, locale: v.locale }),
        label: uiText("Preview the unset", v.locale),
      })
    : html`<p>${uiText("Unset keys fall back to the deployment defaults.", v.locale)}</p>`,
);
