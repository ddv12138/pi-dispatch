/** Configuration controls share the Pulse kit, including errors associated with each control. */
import { html as escapedHtml } from "../html.mjs";
// Keep indented source readable without emitting whitespace-only lines when an optional fragment is absent.
const html = (strings, ...values) => escapedHtml(strings.map(s => s.replace(/[ \t]*\n[ \t]*/g, "\n")), ...values);
import * as ui from "../kit.mjs";
import { uiText } from "../locale.mjs";
export function field(
  name,
  label,
  {
    type = null,
    input = "text",
    required = false,
    placeholder = null,
    max = 512,
    value = "",
    options = null,
    hint = null,
    id = null,
    locale = "en",
  } = {},
) {
  const fid = id ?? `cfg-${name}`;
  return html`<div class="field">
    <label
      >${uiText(label, locale)}${options
        ? html`<select
            class="select"
            name="${name}"
            ${required ? html` required` : null}
            ${type ? html` data-type="${type}"` : null}
          >
            ${options.map((o) => {
              const v = typeof o === "string" ? o : o.value;
              return html`<option
                value="${v}"
                ${String(value) === String(v) ? html` selected` : null}
              >
                ${typeof o === "string" ? o : uiText(o.label, locale)}
              </option>`;
            })}
          </select>`
        : html`<input
            class="input"
            name="${name}"
            type="${input}"
            value="${value}"
            ${type ? html` data-type="${type}"` : null}${required
              ? html` required`
              : null}${placeholder ? html` placeholder="${uiText(placeholder, locale)}"` : null}
            maxlength="${max}"
            autocomplete="off"
            spellcheck="false"
          />`}</label
    >${hint ? html`<p class="field__hint">${uiText(hint, locale)}</p>` : null}
    <p class="field__err" data-field-error="${name}" hidden></p>
  </div>`;
}
export function area(
  name,
  label,
  {
    type = null,
    rows = 4,
    required = false,
    placeholder = null,
    max = 16384,
    value = "",
    locale = "en",
  } = {},
) {
  return html`<div class="field">
    <label
      >${uiText(label, locale)}<textarea
        class="textarea"
        name="${name}"
        rows="${rows}"
        ${type ? html` data-type="${type}"` : null}${required
          ? html` required`
          : null}${placeholder ? html` placeholder="${uiText(placeholder, locale)}"` : null}
        maxlength="${max}"
      >
${value}</textarea
      >
    </label>
    <p class="field__err" data-field-error="${name}" hidden></p>
  </div>`;
}
export function actForm(
  action,
  { hidden = [], fields = null, label, structured = null, danger = false, icon = null, locale = "en" } = {},
) {
  return html`<form
    class="act config-form stack"
    data-action="${action}"
    ${structured ? html` data-structured="${structured}"` : null}
    autocomplete="off"
  >
    <fieldset data-config-controls disabled>
    ${hidden.map(
      ([k, v, t]) =>
        html`<input
          type="hidden"
          name="${k}"
          value="${String(v)}"
          ${t ? html` data-type="${t}"` : null}
        />`,
    )}${fields}${ui.btn({
      type: "submit",
      label: typeof label === "string" ? uiText(label, locale) : label,
      ...(icon ? { icon } : {}),
      kind: danger || action.endsWith("delete") ? ["danger", "sm"] : action === "trigger-fire" || action === "package-canary" ? ["paid", "sm"] : action === "package-undo" ? ["sm"] : ["primary", "sm"],
    })}
    </fieldset>
    <noscript><p class="muted">${uiText("Enable JavaScript to preview and confirm a change. Reading and navigation work without it.", locale)}</p></noscript>
    <p class="field__err" data-form-error hidden role="alert"></p>
  </form>`;
}
export const editor = (summary, forms) =>
  html`<details class="config-editor">
    <summary>${summary}</summary>
    <div class="stack">${forms}</div>
  </details>`;
export const table = (label, heads, rows, empty, locale = "en") =>
  rows.length
    ? html`<div class="tbl-wrap">
        <table class="tbl" aria-label="${uiText(label, locale)}">
          <thead>
            <tr>
              ${heads.map(
                (h) =>
                  html`<th scope="col">
                    ${typeof h === "string" ? uiText(h, locale) : uiText(h.num, locale)}
                  </th>`,
              )}
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </div>`
    : html`<p class="muted">${uiText(empty, locale)}</p>`;
export const facts = (pairs) => ui.facts(pairs);
export const fromSnapshot = (title, render) => (view) =>
  ui.card({
    title: uiText(title, view.locale),
    body: view.data?.snapshot
      ? render(view.data.snapshot, view)
      : html`<p class="muted">
          ${uiText("The deployment's Valkey could not be read. Reload to try again.", view.locale)}
        </p>`,
  });
export const rowDelete = (action, index, locale = "en") =>
  actForm(action, {
    hidden: [["index", index, "int"]],
    label: `${uiText("Delete row", locale)} ${index + 1}`,
    locale,
  });
