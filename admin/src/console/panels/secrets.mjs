/** SecretsScreen panels (#751), with source facts kept separate from browser-only resolver inputs. */
import { PROFILE_SOURCE_TEXT, PROFILE_ROOTS_TEXT, profileHostsText, bundleDeclaredText, bundleEndpointsText } from "../../read-model.mjs";
import { html } from "../html.mjs";
import * as ui from "../kit.mjs";
import { uiText } from "../locale.mjs";
import { canAct, runLink, timeHtml } from "./common.mjs";
import { actForm, field } from "./config-ui.mjs";

const viewOf = (ctx) => ctx.data?.secrets ?? null;
const cell = (body) => html`<span class="secret-cell">${body}</span>`;
const code = (v) => html`<span class="code">${v}</span>`;
const state = (text, failed = false, ok = false) => html`<span class="secret-state ${failed ? "tone-failed" : ok ? "tone-ok" : "tone-idle"}">${ui.icon(failed ? "failed" : ok ? "done" : "info", { size: "sm" })}<span>${text}</span></span>`;
const unread = (locale = "en") => html`<p class="muted">${uiText("The deployment could not be read. Reload to try again; secret declarations and their state are unknown.", locale)}</p>`;
function hostsText(row, view, locale) {
  if (locale !== "zh") return profileHostsText(row, view);
  if (view?.hostsUnreadable === true) return "提供服务的主机注册表无法读取";
  if (view?.hostsSeen === null) return "此处未读取主机注册表（控制台和面板中的配置会显示在线主机）";
  if (row.hosts.length > 0) return `由 ${row.hosts.join("、")} 提供服务${row.hostsUnknown > 0 ? `（另有 ${row.hostsUnknown} 台主机未发布能力信息）` : ""}`;
  if (view?.hostsSeen === 0) return "注册表中没有在线主机";
  return row.hostsUnknown > 0 ? `没有在线主机提供此配置（另有 ${row.hostsUnknown} 台主机未发布能力信息）` : "没有在线主机提供此配置";
}
function bundleDeclared(row, locale) {
  if (locale !== "zh") return bundleDeclaredText(row);
  const format = row.format ? `，${row.format}` : "";
  switch (row?.declared) {
    case "env": return `已在 PI_SECRET_BUNDLES${format} 中声明；doctor --secrets 会检查其是否可运行`;
    case "overlay":
      if (row.roots === "unresolved") return `已在设置覆盖项${format}中声明；此主机无法解析该解析器，因此只能由 worker 根据 PI_SECRET_RESOLVER_ROOTS 判断；doctor --secrets 会检查其是否可运行`;
      return row.rootsSeen === false ? `已在设置覆盖项${format}中声明；面板无法读取 PI_SECRET_RESOLVER_ROOTS；doctor --secrets 会检查其是否可运行` : `已在设置覆盖项${format}中声明，且位于 PI_SECRET_RESOLVER_ROOTS 声明的范围内；doctor --secrets 会检查其是否可运行`;
    case "overlay-outside-roots": return "已在设置覆盖项中声明，但超出 PI_SECRET_RESOLVER_ROOTS 范围，因此 worker 不会运行它，并会在产生费用前拒绝此项目的作业";
    case "ambiguous": return "PI_SECRET_BUNDLES 和覆盖项中均有声明：移除其中一个声明前，worker 会拒绝所有捆绑作业";
    case "env-malformed": return "PI_SECRET_BUNDLES 无法解析：worker 不会启动";
    case "unseen": return "覆盖项中没有此声明，且面板无法读取 PI_SECRET_BUNDLES；请在 worker 主机运行 doctor --secrets 查看是否已声明";
    default: return "覆盖项和 PI_SECRET_BUNDLES 中均未声明：此项目的作业会在产生费用前被拒绝";
  }
}
function bundleEndpoints(row, locale) {
  const list = Array.isArray(row?.endpoints) ? row.endpoints : [];
  return locale === "zh" ? list.map((e) => `${e.name}${e.host ? ` 位于 ${e.host}` : ""}`).join("、") : bundleEndpointsText(row);
}
function secretProblem(problem) {
  const match = /^(malformed|ambiguous-profile|ambiguous-bundle|empty-roots|missing-profile|outside-profile|outside-bundle|missing-bundle|unserved)-(.*)$/.exec(problem.key);
  const kind = match?.[1] ?? "";
  const name = match?.[2] ?? "";
  if (kind === "malformed") return { title: `${name} 无法解析`, sentence: "此声明无法解析时，worker 不会启动。", fix: `请更正部署的 .env 中的 ${name}，然后重启 worker。` };
  if (kind === "ambiguous-profile" || kind === "ambiguous-bundle") {
    const bundle = kind === "ambiguous-bundle";
    const env = bundle ? "PI_SECRET_BUNDLES" : "PI_SECRET_PROFILES";
    return { title: `已拒绝：${name} 被重复声明`, sentence: `该名称同时出现在 ${env} 和设置覆盖项中，因此在两个来源不再同时声明前，worker 会拒绝所有${bundle ? "捆绑" : "密钥"}作业。`, fix: "请从其中一个来源移除此名称。" };
  }
  if (kind === "empty-roots") return { title: "解析器根目录已设置但为空", sentence: "worker 会拒绝设置覆盖项声明的所有解析器。", fix: "请将 PI_SECRET_RESOLVER_ROOTS 设置为存放解析器的目录。" };
  if (kind === "missing-profile") return { title: `已拒绝：未声明配置 ${name}`, sentence: "触发器无法在容器启动前解析其密钥。", fix: "请在 .env 或设置覆盖项中声明其解析器。" };
  if (kind === "outside-profile") return { title: `已拒绝：${name} 超出解析器根目录`, sentence: "worker 会拒绝所有引用此解析器的作业。", fix: "请将解析器放入 PI_SECRET_RESOLVER_ROOTS 指定目录，或修正根目录设置。" };
  if (kind === "outside-bundle") return { title: `已拒绝：捆绑解析器 ${name} 超出根目录`, sentence: "worker 会拒绝此解析器处理的捆绑作业。", fix: "请将解析器放入 PI_SECRET_RESOLVER_ROOTS 指定目录，或修正根目录设置。" };
  if (kind === "missing-bundle") return { title: `已拒绝：捆绑项 ${name} 没有已声明的解析器`, sentence: "此项目的捆绑作业会在产生费用前被拒绝。", fix: `请声明捆绑解析器 ${problem.key.slice("missing-bundle-".length)}。` };
  if (kind === "unserved") return { title: `没有在线主机提供 ${name}`, sentence: "注册表中的在线主机均未发布此配置。", fix: "请检查 worker 的解析器声明及其已发布的能力信息。" };
  return { title: uiText(problem.title, "zh"), sentence: uiText(problem.sentence, "zh"), fix: uiText(problem.fix, "zh") };
}
function profileLastStatus(last, locale) {
  if (locale !== "zh") return last.outcome === "refused" ? `refused (${last.reason ?? "reason unknown"}${last.bundled ? "; profile or bundle" : ""})` : last.outcome === "resolved" ? "resolved" : "not reached, the run ended before a container";
  if (last.outcome === "refused") return `已拒绝（${last.reason ?? "原因未知"}${last.bundled ? "；密钥配置或捆绑项" : ""}）`;
  return last.outcome === "resolved" ? "已解析" : "未执行，运行在容器启动前已结束";
}
const triggerLinks = (list, more = 0, locale = "en") => list.length ? html`${list.map((i, n) => html`${n ? ", " : ""}<a class="link" href="${`/config/trigger?index=${i}`}">${i + 1}</a>`)}${more ? ` ${uiText("and", locale)} ${more} ${uiText("more", locale)}` : null}` : uiText("none", locale);
const remove = (kind, name, ctx, label = "Remove") => canAct(ctx) ? actForm(`secret-${kind}-remove`, { hidden: [["name", name]], label: html`${uiText(label, ctx.locale)}<span class="sr"> ${uiText(kind === "profile" ? "profile" : "bundle resolver", ctx.locale)} ${name}</span>`, danger: true, locale: ctx.locale }) : null;

export function secretsHeadline(ctx) {
  const v = viewOf(ctx);
  const categories = [
    ["malformed-", "declaration that does not parse", "declarations that do not parse"],
    ["ambiguous-profile-", "profile declared twice", "profiles declared twice"],
    ["ambiguous-bundle-", "bundle resolver declared twice", "bundle resolvers declared twice"],
    ["empty-roots", "empty resolver roots list", "empty resolver roots lists"],
    ["outside-profile-", "profile outside the resolver roots", "profiles outside the resolver roots"],
    ["outside-bundle-", "bundle resolver outside the roots", "bundle resolvers outside the roots"],
    ["missing-profile-", "undeclared profile", "undeclared profiles"],
    ["missing-bundle-", "bundle without a declared resolver", "bundles without a declared resolver"],
    ["unserved-", "profile no live host serves", "profiles no live host serves"],
  ];
  const summary = categories.map(([prefix, one, many]) => { const count = (v?.problems ?? []).filter((p) => p.key.startsWith(prefix)).length; return count ? `${count} ${uiText(count === 1 ? one : many, ctx.locale)}` : null; }).filter(Boolean).join(", ");
  return html`${uiText("Names and states only.", ctx.locale)} ${!v?.available ? uiText("Declarations and their state could not be read.", ctx.locale) : v.problems.length ? `${v.problems.length} ${uiText(v.problems.length === 1 ? "problem" : "problems", ctx.locale)}: ${summary}.` : uiText("No problem found in the facts this console can read.", ctx.locale)}`;
}

export function secretsProblems(ctx) {
  const v = viewOf(ctx);
  if (!v?.available) return ui.banner({ status: "attention", title: uiText("Secret declarations are unknown", ctx.locale), body: unread(ctx.locale), block: true });
  const p = v.problems[0];
  if (!p) return html``;
  const problem = ctx.locale === "zh" ? secretProblem(p) : p;
  return ui.banner({ status: "failed", title: uiText(problem.title, ctx.locale), body: `${uiText(problem.sentence, ctx.locale)} ${uiText(problem.fix, ctx.locale)}`, actions: p.action ? remove(p.action.action === "secret-profile-remove" ? "profile" : "bundle", p.action.name, ctx, "Remove from the overlay") : null });
}

export function secretsProfiles(ctx) {
  const v = viewOf(ctx);
  if (!v?.available) return ui.card({ title: uiText("Secret profiles", ctx.locale), body: unread(ctx.locale) });
  const rows = v.profiles.map((p) => ({ mark: p.refused ? "failed" : null, cells: [
    { html: code(p.name), id: true },
    { html: cell(html`${state(uiText(PROFILE_SOURCE_TEXT[p.source] ?? "Source unknown", ctx.locale), p.source === "ambiguous")}${p.refused && !["ambiguous", "undeclared"].includes(p.source) && !["outside", "empty"].includes(p.roots) ? html`<small>${uiText("Every secrets job is refused while a declaration does not parse or a name is declared twice.", ctx.locale)}</small>` : null}`), wide: true },
    { html: state(uiText(p.roots === null ? p.source === "undeclared" ? "no declared resolver in view" : "not bounded (an env resolver)" : PROFILE_ROOTS_TEXT[p.roots] ?? "Roots judgement unknown", ctx.locale), ["outside", "empty"].includes(p.roots), p.roots === "inside"), wide: true },
    triggerLinks(p.triggers, p.triggersMore, ctx.locale),
    cell(html`${p.projects.map((id, n) => html`${n ? ", " : ""}<a class="link" href="${`/config/project?id=${encodeURIComponent(id)}`}">${id}</a>`)}${p.projectsMore ? ` ${uiText("and", ctx.locale)} ${p.projectsMore} ${uiText("more", ctx.locale)}` : null}${p.anyRepo ? html`<small>${uiText("any (a webhook trigger)", ctx.locale)}</small>` : p.projects.length ? null : uiText("none in view", ctx.locale)}`),
    { html: cell(html`${p.last ? html`${state(profileLastStatus(p.last, ctx.locale), p.last.outcome === "refused", p.last.outcome === "resolved")}<small>${runLink(p.last.jobId, { pulse: true })} · ${timeHtml(Date.parse(p.last.at ?? ""))}</small>` : html`<span class="muted">${uiText("no run in view", ctx.locale)}</span>`}${p.refused ? p.cron.map((c) => html`<small class="secret-refusal">${uiText("Trigger", ctx.locale)} ${c.index + 1}${c.id ? ` (${c.id})` : ""}: ${c.at === null ? uiText("next fire unknown", ctx.locale) : html`${uiText("next", ctx.locale)} ${timeHtml(c.at)}`}; ${uiText("its run will be refused.", ctx.locale)}</small>`) : null}`), wide: true },
    { html: cell(hostsText(p, v.profileState, ctx.locale)), wide: true },
    { html: p.inOverlay ? remove("profile", p.name, ctx) : html`<span class="faint">${uiText(p.source === "env" ? "in the .env" : p.source === "undeclared" ? "no declaration in view" : "source unknown", ctx.locale)}</span>`, act: true },
  ] }));
  const table = ui.tbl({ caption: uiText("Secret profiles", ctx.locale), heads: ["Profile", "Source", "Resolver roots", "Triggers", "Projects", "Last resolve", "Served by", { label: uiText("Actions", ctx.locale), l: null }].map((h) => typeof h === "string" ? uiText(h, ctx.locale) : h), rows, stack: true, empty: uiText("No secret profiles are declared or named by the triggers in view.", ctx.locale) });
  return ui.card({ title: uiText("Secret profiles", ctx.locale), sub: `${rows.length} ${uiText("in view · names only", ctx.locale)}`, end: uiText("Resolver paths and references stay in their source files", ctx.locale), flush: true, body: html`${!v.settingsKnown ? html`<p class="secret-note">${uiText("The settings overlay could not be read; its profile declarations are unknown.", ctx.locale)}</p>` : null}${v.profileState.envSeen === false ? html`<p class="secret-note">${uiText("PI_SECRET_PROFILES is not visible here; the worker's environment declarations are unknown.", ctx.locale)}</p>` : null}${!v.triggersKnown ? html`<p class="secret-note">${uiText("The triggers file could not be read; profile usage is unknown.", ctx.locale)}</p>` : null}${table}` });
}

export function secretsBundles(ctx) {
  const v = viewOf(ctx);
  if (!v?.available) return ui.card({ title: uiText("Secret bundles", ctx.locale), body: unread(ctx.locale) });
  const resolvers = v.bundleResolvers.length ? html`<ul class="secret-resolvers">${v.bundleResolvers.map((r) => html`<li>${code(r.name)} <span class="muted">(${uiText(r.format ?? "format unknown", ctx.locale)}, ${uiText(r.source === "env" ? "PI_SECRET_BUNDLES" : r.source === "ambiguous" ? "both sources, ambiguous" : "settings overlay", ctx.locale)})</span>${r.roots ? html`<small>${uiText(PROFILE_ROOTS_TEXT[r.roots], ctx.locale)}</small>` : null}${r.inOverlay ? remove("bundle", r.name, ctx) : html`<span class="faint">${uiText("in the .env", ctx.locale)}</span>`}</li>`)}</ul>` : html`<p class="secret-note">${uiText("No bundle resolver is declared in the sources this console can read.", ctx.locale)}</p>`;
  const rows = v.bundles.map((b) => ({ mark: b.refused ? "failed" : b.projectKnown === false ? "attention" : null, cells: [
    { html: code(b.id), id: true },
    cell(html`${b.project ? html`<a class="link" href="${`/config/project?id=${encodeURIComponent(b.project)}`}">${b.project}</a>` : uiText("project unknown", ctx.locale)}${b.projectKnown === false ? html`<small>${uiText("not in projects.json", ctx.locale)}</small>` : b.projectKnown === null ? html`<small>${uiText("projects.json could not be read", ctx.locale)}</small>` : null}`),
    { html: cell(html`${code(b.profile ?? uiText("unknown", ctx.locale))}${state(uiText(b.roots === "unresolved" ? "declared in the settings overlay; its real path cannot be resolved on this host, so only the worker can judge the roots" : b.roots === "unseen" ? "declared in the settings overlay; the roots are not visible here" : bundleDeclared(b, ctx.locale), ctx.locale), b.refused, !b.refused && (b.declared === "env" || b.declared === "overlay" && b.roots === "inside"))}`), wide: true },
    b.forkReviews ? uiText("yes", ctx.locale) : uiText("no", ctx.locale),
    { html: bundleEndpoints(b, ctx.locale) || uiText("none", ctx.locale), wide: true },
    triggerLinks(b.optedOut, 0, ctx.locale),
    { html: cell(b.last ? html`<span class="secret-names">${b.last.variables.length ? b.last.variables.map(code) : uiText("no variables", ctx.locale)}</span><small>${runLink(b.last.jobId, { pulse: true })} · ${timeHtml(Date.parse(b.last.at ?? ""))}</small>` : html`<span class="muted">${uiText("no run in view", ctx.locale)}</span>`), wide: true },
  ] }));
  return ui.card({ title: uiText("Secret bundles", ctx.locale), sub: `${rows.length} ${uiText("bound in the triggers file", ctx.locale)}`, end: uiText("Variable names only, from the newest run", ctx.locale), flush: true, body: html`<p class="secret-note">${uiText("Bundle resolvers, from both declaration sources:", ctx.locale)}</p>${resolvers}${!v.triggersKnown ? html`<p class="secret-note">${uiText("The triggers file could not be read; bundle bindings are unknown.", ctx.locale)}</p>` : ui.tbl({ caption: uiText("Secret bundles", ctx.locale), heads: ["Bundle", "Project", "Resolver", "Fork reviews", "Endpoints", "Opted out", "Last received"].map((h) => uiText(h, ctx.locale)), rows, stack: true, empty: uiText("The triggers file binds no project secret bundle.", ctx.locale) })}<p class="secret-note">${uiText("Binding a bundle to a project stays an edit of secretBundles in the triggers file.", ctx.locale)}</p>` });
}

export function secretsAdd(ctx) {
  if (!canAct(ctx)) return html``;
  const v = viewOf(ctx);
  const hint = v?.roots.seen ? `${v.roots.count} ${uiText(v.roots.count === 1 ? "root" : "roots", ctx.locale)} ${uiText("on this host", ctx.locale)}${v.roots.empty ? `; ${uiText("set and empty, so overlay resolvers are refused", ctx.locale)}` : ""}` : uiText("roots are not visible on this host; only the worker can judge them", ctx.locale);
  return ui.card({ title: uiText("Declare a resolver", ctx.locale), sub: uiText("writes the settings overlay", ctx.locale), body: actForm("secret-profile-add", { structured: "resolver", label: uiText("Preview the profile", ctx.locale), locale: ctx.locale, fields: html`${field("kind", uiText("What to declare", ctx.locale), { options: [{ value: "profile", label: uiText("Profile", ctx.locale) }, { value: "bundle", label: uiText("Bundle resolver", ctx.locale) }], value: "profile", locale: ctx.locale })}${field("name", uiText("Name", ctx.locale), { required: true, max: 64, locale: ctx.locale })}${field("path", uiText("Resolver (absolute path)", ctx.locale), { required: true, max: 4096, hint: `${uiText("Must sit inside PI_SECRET_RESOLVER_ROOTS", ctx.locale)} (${hint}).`, locale: ctx.locale })}<div data-resolver-format hidden>${field("format", uiText("Output format", ctx.locale), { options: ["dotenv", "json"], locale: ctx.locale })}</div><p class="field__hint" data-resolver-frequency>${uiText("The worker runs this script as the account it runs as, once per reference before the container starts. Only declare a resolver you trust.", ctx.locale)}</p>` }) });
}

export const SECRET_HELP = Object.freeze([
  ["A trigger's profile", "run.secrets names at most 16 variables. Each reference is resolved before the container starts, through run.secretsProfile or default, once per reference."],
  ["A project's bundle", "secretBundles in the triggers file binds a project to a bundle resolver. It prints dotenv or json once per job start: at most 64 variables, 256 KiB of output and 64 KiB per value. A trigger's explicit run.secrets win on a clash; the run record names the variables received and shadowed."],
  ["When a run goes without its bundle", "A hand run, a chained run, an opted-out trigger (run.secretBundle: false), a pull request from a fork without forkReviews, or a pull request whose head could not be verified. The run's page says which."],
  ["The resolver behind both", "An executable at an absolute path, declared in PI_SECRET_PROFILES or PI_SECRET_BUNDLES in the .env, or secretProfiles or secretBundles in the settings overlay. It runs on the host as the worker's account. An overlay resolver must be inside PI_SECRET_RESOLVER_ROOTS. A name declared in both sources refuses every secrets or bundled job. The resolver's own credential never enters the job."],
  ["Where the variables sit", "On local and podman, the job can read every value. On OpenShell venues, a variable with an endpoint is a placeholder that the gateway swaps for its value only in a request to that host. A forge job also receives its forge token, each job its provider's credential when required, and whatever PI_FORWARD_ENV forwards. Connections names their sources."],
  ["Never shown here", "A reference, a secret value, or a resolver's or root's full path. Resolver previews show only each path's last folder. Names and states only."],
]);
export function secretsHelp(ctx = { locale: "en" }) {
  return ui.card({ title: uiText("What a run gets", ctx.locale), body: html`<dl class="secret-help">${SECRET_HELP.map(([title, text]) => html`<div><dt>${uiText(title, ctx.locale)}</dt><dd>${uiText(text, ctx.locale)}</dd></div>`)}</dl><p><a class="link" href="/config/connections">${uiText("Open Connections", ctx.locale)}</a> ${uiText("for forge credentials, provider keys and network egress.", ctx.locale)}</p>` });
}
