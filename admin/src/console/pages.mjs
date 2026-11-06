import { SETUP_PANELS, SETUP_DESCRIPTION } from "./panels/setup.mjs";
import { setupFacts } from "../setup-view.mjs";
import { TRIGGER_RECIPES } from "../trigger-recipes.mjs";
import { subscriptionAuthForAgent } from "../subscription-auth-view.mjs";
import { connectionsSubscriptionAuth } from "./panels/subscription-auth.mjs";
import { connectionsProviderKeys } from "./panels/provider-keys.mjs";
import { MODELS_PANELS } from "./panels/models.mjs";
import { modelsForAgent } from "../models-view.mjs";
import { ZERO_TOUCH_PANELS, zeroTouchTabs, zeroTouchControls } from "./panels/zero-touch.mjs";
import { zeroTouchView } from "../zero-touch-view.mjs";
/**
 * The console's screens (issue #641, REQ-OPERATOR-CONSOLE-SCREENS): which screens exist, what each one's query may say,
 * what each one reads, and how each one is drawn from its panels.
 *
 * THREE STEPS, KEPT APART so the live stream and the page load cannot disagree:
 *
 *   1. `parsePageQuery(name, searchParams)` judges the query: every parameter named, bounded and charset-checked, and a
 *      value that fails is REFUSED, never trimmed into one that passes (`run-filter.mjs`'s rule, which the runs screen
 *      uses for its filters). A refusal names the parameter and its rule, never the value.
 *   2. `loadPageData(name, query, deps)` is the ONLY function here that reads. It calls the fleet reader's `snapshot()`
 *      at most once, and nothing else on a screen that needs only the snapshot. The live hub calls it once per tick for
 *      each distinct screen and data query (`dataQueryOf`: the overview's timeline query only regroups one read), and
 *      hands the result to every stream showing that screen.
 *   3. `renderPage(name, ctx)` and `pagePanels(name, ctx)` draw from that data and nothing else: pure, with `now` taken
 *      from the data, so the same data draws the same bytes. `renderPage` places each panel in
 *      `<section id="p-…" data-panel>`; `pagePanels` returns the same panels' inner HTML for the stream to swap in.
 *
 * THE ROLE RULE lives in the panels (`panels.mjs` header): the operator alone sees a failure reason and the audit log,
 * and (issue #642) the action controls, which a read-only console draws for nobody.
 * Data is read once for both roles, and the role decides only what is drawn, so a stream must be rendered per role.
 *
 * THE FRAME is shell.mjs's Pulse navigation and title bar. Pages compose panels in PAGE_LAYOUT;
 * every screen now uses the same kit (#750).
 */
import { triggerOn, triggerRuns, triggerRun, triggerEdit, triggerTrust, triggerKinds, triggerChange, triggerAdd, triggerKindHelp, triggerForgeWords, triggerRefusals, triggerTitle } from "./panels/trigger.mjs";
import { configNavigation, configFiles, configUnset, configDescription } from "./panels/config.mjs";
import { secretsView } from "../secrets-view.mjs";
import { secretsHeadline, secretsProblems, secretsProfiles, secretsBundles, secretsAdd, secretsHelp } from "./panels/secrets.mjs";
import { updatesDescription, updatesHosts, updatesHow, updatesJobs, updatesProblems, updatesRecent } from "./panels/updates.mjs";
import { connectionsDescription, connectionsProblems, connectionsForges, connectionsEgress, connectionsEndpoints, connectionsNotify, connectionsMcp, connectionsEnvironment, connectionsPackages } from "./panels/connections.mjs";
import { projectTitle, projectDescription, projectSpend, projectRuns, projectSize, projectMembers, projectSizing, projectRecent, projectAllocation, projectLimits, projectBundle, projectTriggers, projectDelete } from "./panels/project.mjs";
import { triggersNavigation, triggersViewer, triggersCount, triggersNext, triggersSpend, triggersFilters, triggersWeek, triggersSchedules, triggersGithub, triggersGitlab, triggersForgejo, triggersAzure, triggersUnknown, triggersCheck, triggerCheckPage, triggersDescription } from "./panels/triggers.mjs";
import { triggerListOf, TRIGGER_LIST_KINDS } from "../trigger-list.mjs";
import { loadWatchData, parseWatchQuery, watchPanel, watchBoardPanel } from "./watch.mjs";
import { readForkPoints } from "../run-fork.mjs";
import { readTriggerEditor, triggerDetailOf, TRANSCRIPT_ID_RE } from "../read-model.mjs";
import { ageText, beatAgeOf } from "./panels/common.mjs";
import { WORKER_NAME_RE } from "@edgehero/pi-dispatch/config";
import { RECOVERY_CAP } from "@edgehero/pi-dispatch/recovery-queue";
import { REPLICAS_MAX } from "@edgehero/pi-dispatch/triggers";
import { FORGES } from "@edgehero/pi-dispatch/forges";
import { PROJECT_ID_RE } from "@edgehero/pi-dispatch/projects";
import { RUN_FILTER_FIELDS, parseRunFilter } from "../run-filter.mjs";
import { html, page } from "./html.mjs";
import { seg } from "./kit.mjs";
import { uiText } from "./locale.mjs";
import { HEADLINE_ID, NAV_PARKED_ID, navParkedHtml, shellHtml } from "./shell.mjs";
import { TIMELINE_ROWS, TIMELINE_ZOOMS } from "./timeline.mjs";
import { auditAbout, auditChain, auditFilter } from "./panels/audit.mjs";
import { AUDIT_PARAMS, auditQueryString, parseAuditQuery, readAuditView } from "./audit-view.mjs";
import { SPEND_PANELS, SPEND_LAYOUTS, spendControls, spendTabs, spendDescription } from "./panels/spend.mjs";
import { errorPage, forbiddenContent } from "./error-pages.mjs";
import {
  auditLog,
  configMcp,
  configPackages,
  configPauseWindows,
  configProjects,
  configScopedLimits,
  configSecretBundles,
  configSecretProfiles,
  configSettings,
  configTriggers,
  fleetActive,
  fleetFailed,
  fleetHeld,
  fleetHosts,
  fleetDoctor,
  fleetVenues,
  fleetBar, fleetDelayed,
  hostState, hostJobs, hostBudget, hostCapacity, hostRow, hostDoctor,
  fleetQueues,
  fleetSchedulers,
  INSIGHTS_DEFAULT_RANGE,
  INSIGHTS_RANGES,
  insightsPanel,
  insightsRange,
  insightsWhatIf,
  WHATIF_FLOW_RE,
  overviewActive,
  overviewCaps,
  overviewHeadline,
  overviewHosts,
  overviewNeeds,
  overviewSetup,
  overviewSetupEmpty,
  overviewSpend,
  overviewTimeline,
  overviewWaiting,
  overviewWaitlists,
  parkedCheckRows,
  parkedQuestions,
  runChain, runHeadline, runRecord, runRest, runTranscriptState, runActionsPanel, runSecrets, runModels, runRecovery, runWhy, runHost, runViewer,
  runCostPanel,
  runInbox,
  runOutcome,
  runProgress,
  runResources,
  runSession,
  runSummary,
  runsFilters,
  runsSummary,
  runsTable,
  RUN_ID_RE,
  refusedBeforeStart,
} from "./panels.mjs";
import { runTranscriptSection } from "./transcript.mjs";
import { WHATIF_MODEL_RE } from "./whatif.mjs";
import { SPEND_TITLE, recordReason } from "../words.mjs";
import { RUN_RECORD_UNREAD, runAbsent, runPlaces } from "../read-model.mjs";
import { fromNewerRelease } from "../newer-release.mjs";
import { agentReadProjection } from "../agent-read.mjs";
import { runAnswerDraft } from "./panels/run.mjs";
import { overviewAgentWrites } from "./panels/agent-writes.mjs";

/**
 * The screens. `path` is the route, `auth` the least role that may open it, `live` whether the page opens the event
 * stream (a screen whose data changes while it is open), `title` the heading, `nav` the navigation label (none for
 * the run detail, which is reached from a run). Insights is not live: its assembly is the expensive read (cached 30 s
 * by the caller), and the range picker is its refresh; its what-if form is a GET of the same page. Configuration and
 * the audit log change by a person's hand. `icon` is the sprite icon (`pulse-icons.mjs`) its navigation pill carries
 * (issue #737); the run detail's is Runs', the screen it counts as.
 * The run detail is live since issue #644: a running job's progress panel moves, and a run that ends gets its record's
 * panels without a reload; since issue #646 its inbox panel moves too, a message's state from queued to delivered. Its
 * data is read at most once per `LIVE_DEFAULTS.pageMinMs.run` (live.mjs), since a run's load also reads its record and
 * searches for its children.
 */
export const PAGES = Object.freeze({
  setup: Object.freeze({ path: "/setup", auth: "viewer", live: true, title: "Set up pi-dispatch", nav: null, icon: "home" }),
  models: Object.freeze({ path: "/models", auth: "viewer", live: false, title: "Models", nav: "Models", icon: "spend" }),
  overview: Object.freeze({ path: "/", auth: "viewer", live: true, title: "Overview", nav: "Overview", icon: "home" }),
  runs: Object.freeze({ path: "/runs", auth: "viewer", live: true, title: "Runs", nav: "Runs", icon: "runs" }),
  "zero-touch": Object.freeze({ path: "/runs/zero-touch", auth: "viewer", live: false, title: "Zero touch", nav: null, icon: "flag" }),
  run: Object.freeze({ path: "/run", auth: "viewer", live: true, title: "Run", nav: null, icon: "runs" }),
  parked: Object.freeze({ path: "/parked", auth: "viewer", live: true, title: "Parked inbox", nav: "Parked", icon: "parked" }),
  "answer-rules": Object.freeze({ path: "/parked/rules", auth: "operator", live: false, title: "Answer rules", nav: null, icon: "parked" }),
  insights: Object.freeze({ path: "/insights", auth: "viewer", live: false, title: SPEND_TITLE, nav: SPEND_TITLE, icon: "spend" }),
  "insights-budget-split": Object.freeze({ path: "/insights/budget-split", auth: "viewer", live: false, title: SPEND_TITLE, nav: null, icon: "spend" }),
  "insights-capacity": Object.freeze({ path: "/insights/capacity", auth: "viewer", live: false, title: SPEND_TITLE, nav: null, icon: "spend" }),
  "insights-breakdown": Object.freeze({ path: "/insights/breakdown", auth: "viewer", live: false, title: SPEND_TITLE, nav: null, icon: "spend" }),
  "insights-flows": Object.freeze({ path: "/insights/flows", auth: "viewer", live: false, title: SPEND_TITLE, nav: null, icon: "spend" }),
  fleet: Object.freeze({ path: "/fleet", auth: "viewer", live: true, title: "Fleet", nav: "Fleet", icon: "fleet" }),
  host: Object.freeze({ path: "/fleet/host", auth: "viewer", live: true, title: "Host", nav: null, icon: "fleet" }),
  trigger: Object.freeze({ path: "/config/trigger", auth: "viewer", live: false, title: "Trigger", nav: null, icon: "config" }),
  triggers: Object.freeze({ path: "/triggers", auth: "viewer", live: false, title: "Triggers", nav: "Triggers", icon: "bolt" }),
  "trigger-check": Object.freeze({ path: "/triggers/check", auth: "viewer", live: false, title: "Check an event", nav: null, icon: "bolt" }),
  "trigger-add": Object.freeze({ path: "/config/trigger-add", auth: "operator", live: false, title: "Add a trigger", nav: null, icon: "config" }),
  config: Object.freeze({ path: "/config", auth: "viewer", live: false, title: "Configuration", nav: "Configuration", icon: "config" }),
  secrets: Object.freeze({ path: "/config/secrets", auth: "viewer", live: false, title: "Secrets", nav: null, icon: "config" }),
  connections: Object.freeze({ path: "/config/connections", auth: "viewer", live: false, title: "Connections", nav: null, icon: "config" }),
  updates: Object.freeze({ path: "/config/updates", auth: "viewer", live: false, title: "Updates", nav: null, icon: "config" }),
  project: Object.freeze({ path: "/config/project", auth: "viewer", live: false, title: "Project", nav: null, icon: "config" }),
  watch: Object.freeze({ path: "/watch", auth: "viewer", live: false, title: "Watch", nav: null, icon: "bolt" }),
  "watch-board": Object.freeze({ path: "/watch/board", auth: "viewer", live: false, title: "Watch board", nav: null, icon: "bolt" }),
  audit: Object.freeze({ path: "/audit", auth: "operator", live: false, title: "Audit log", nav: "Audit", icon: "audit" }),
});

/** Each screen's panels, in page order: `[id, renderer]`. An id is `p-<panel>`, unique within its screen. */
const PAGE_PANELS = Object.freeze({
  setup: SETUP_PANELS,
  models: MODELS_PANELS,
  "zero-touch": ZERO_TOUCH_PANELS,
  secrets: [["p-secret-problems", secretsProblems], ["p-secret-profiles", secretsProfiles], ["p-secret-bundles", secretsBundles], ["p-secret-add", secretsAdd], ["p-secret-help", secretsHelp]],
  updates: [["p-up-problems", updatesProblems], ["p-up-jobs", updatesJobs], ["p-up-hosts", updatesHosts], ["p-up-how", updatesHow], ["p-up-recent", updatesRecent]],
  connections: [["p-connection-problems", connectionsProblems], ["p-provider-keys", connectionsProviderKeys], ["p-forges", connectionsForges], ["p-egress", connectionsEgress], ["p-endpoints", connectionsEndpoints], ["p-subscription-auth", connectionsSubscriptionAuth], ["p-notify", connectionsNotify], ["p-mcp", connectionsMcp], ["p-env", connectionsEnvironment], ["p-packages", connectionsPackages]],
  project: [["p-proj-spend", projectSpend], ["p-proj-runs", projectRuns], ["p-proj-size", projectSize], ["p-proj-members", projectMembers], ["p-proj-sizing", projectSizing], ["p-proj-recent", projectRecent], ["p-proj-alloc", projectAllocation], ["p-proj-limits", projectLimits], ["p-proj-bundle", projectBundle], ["p-proj-triggers", projectTriggers], ["p-proj-delete", projectDelete]],
  triggers: [["p-tr-tabs", triggersNavigation], ["p-tr-viewer", triggersViewer], ["p-tr-count", triggersCount], ["p-tr-next", triggersNext], ["p-tr-spend", triggersSpend], ["p-tr-filters", triggersFilters], ["p-tr-week", triggersWeek], ["p-tr-schedule", triggersSchedules], ["p-tr-github", triggersGithub], ["p-tr-gitlab", triggersGitlab], ["p-tr-forgejo", triggersForgejo], ["p-tr-azure", triggersAzure], ["p-tr-unknown", triggersUnknown], ["p-tr-check", triggersCheck]],
  "trigger-check": [["p-tr-check", triggerCheckPage]],
  // Issue #737: the first run's checklist (empty once the deployment runs), then what needs a person first, what waits,
  // what runs and what it costs, the timeline and the caps, then the waitlists and the hosts. Every one of the eleven is
  // on the page in both states (`panels/overview.mjs`'s header), so the stream moves a first run to the overview by
  // swapping panels; on a phone, where the layout is one column, Needs you comes first once the checklist is gone.
  overview: [["p-setup", overviewSetup], ["p-setup-empty", overviewSetupEmpty], ["p-needs", overviewNeeds], ["p-waiting", overviewWaiting], ["p-active", overviewActive], ["p-spend", overviewSpend], ["p-agent-writes", overviewAgentWrites], ["p-timeline", overviewTimeline], ["p-caps", overviewCaps], ["p-waitlists", overviewWaitlists], ["p-hosts", overviewHosts]],
  runs: [["p-filters", runsFilters], ["p-summary", runsSummary], ["p-runs", runsTable]],
  run: [["p-viewer", runViewer], ["p-outcome", runOutcome], ["p-progress", runProgress], ["p-recovery", runRecovery], ["p-transcript", runTranscriptState], ["p-record", runRecord], ["p-rest", runRest], ["p-answer-draft", runAnswerDraft], ["p-inbox", runInbox], ["p-run", runSummary], ["p-secrets", runSecrets], ["p-actions", runActionsPanel], ["p-why", runWhy], ["p-host", runHost], ["p-cost", runCostPanel], ["p-models", runModels], ["p-resources", runResources], ["p-session", runSession], ["p-chain", runChain]],
  parked: [["p-questions", parkedQuestions]],
  "answer-rules": [["p-questions", parkedQuestions]],
  ...SPEND_PANELS,
  fleet: [["p-fleetbar", fleetBar], ["p-queues", fleetQueues], ["p-active", fleetActive], ["p-held", fleetHeld], ["p-failed", fleetFailed], ["p-delayed", fleetDelayed], ["p-schedules", fleetSchedulers], ["p-hosts", fleetHosts], ["p-doctor", fleetDoctor], ["p-venues", fleetVenues]],
  host: [["p-hoststate", hostState], ["p-hostjobs", hostJobs], ["p-hostbudget", hostBudget], ["p-hostcap", hostCapacity], ["p-hostrow", hostRow], ["p-hostdoctor", hostDoctor]],
  config: [["cf-navigation", configNavigation], ["cf-settings", configSettings], ["cf-triggers", configTriggers], ["cf-pause-windows", configPauseWindows], ["cf-scoped-limits", configScopedLimits], ["cf-projects", configProjects], ["cf-files", configFiles], ["cf-unset", configUnset], ["cf-mcp-servers", configMcp], ["cf-packages", configPackages], ["cf-secret-profiles", configSecretProfiles], ["cf-secret-bundles", configSecretBundles]],
  trigger: [["p-trigger-on", triggerOn], ["p-trigger-runs", triggerRuns], ["p-trigger-run", triggerRun], ["p-trigger-edit", triggerEdit], ["p-trigger-trust", triggerTrust], ["p-trigger-kinds", triggerKinds], ["p-trigger-change", triggerChange]],
  "trigger-add": [["p-trigger-add", triggerAdd], ["p-kinds", triggerKindHelp], ["p-forge-words", triggerForgeWords], ["p-refusals", triggerRefusals]],
  watch: [["p-watch", watchPanel]],
  "watch-board": [["p-watch-board", watchBoardPanel]],
  audit: [["p-audit-chain", auditChain], ["p-audit-filter", auditFilter], ["p-audit", auditLog], ["p-audit-about", auditAbout]],
});

/**
 * Each screen's line under its title (issue #737), a renderer like a panel's: the shell draws it as its headline panel
 * (`shell.mjs` `HEADLINE_ID`), and the stream swaps it like any panel, since what it says changes while the page is
 * open ("All clear. 4 jobs running, nothing needs you."). A screen with none draws no line.
 */
function hostHeadline(view) {
  const host = view.data?.host ?? view.data?.snapshot?.hostBudgets?.find((h) => h.name === view.query?.name);
  if (!host) return html`No live registry row for ${view.query?.name ?? "this host"}.`;
  const venues = host.backends?.blessed ?? [];
  const jobs = host.jobs;
  const readable = Array.isArray(jobs) && !host.jobsUnreadable;
  const moreKnown = Number.isSafeInteger(host.jobsMore) && host.jobsMore >= 0;
  const used = readable && moreKnown ? jobs.length + host.jobsMore : null;
  const occupied = used !== null ? `${used} of ${host.concurrency ?? "unknown"} slots taken` : readable && jobs.length > 0 ? `at least ${jobs.length} occupied ${jobs.length === 1 ? "slot" : "slots"} listed; total not known` : "occupied slots not known";
  const beat = beatAgeOf(host);
  return html`${venues.length ? venues.map((name) => `${name}${host.backends.default === name ? " (default)" : ""}`).join(", ") : "Venues not published"} · worker ${host.version ?? "not published"} · ${occupied} · last beat ${beat === null ? "not known" : `${ageText(beat)} ago`}`;
}

const PAGE_HEADLINES = Object.freeze({ overview: overviewHeadline, run: runHeadline, host: hostHeadline, secrets: secretsHeadline });

/**
 * How a screen's panels are laid out (issue #737), for a screen whose cards stand in a grid rather than one under
 * another: a list of wrappers, each `{ cls, items, slotAfter }`, an item a panel id or a wrapper inside it. `cls` is the
 * bundle's layout class (`cols`, two columns, the second the side column; `stack`, a column of cards; `cards-4`, four
 * cards in a row). `slotAfter` marks a wrapper that is a GRID of cards: the script puts the confirm slot after the
 * wrapper rather than after the card whose form opened it, since a slot inside the grid would take one of its cells
 * (`data-slot-after`, `script.mjs` `slotAnchor`). A `stack` is no such grid: there the slot stays under its card.
 *
 * A screen without a layout draws its panels one under another in `PAGE_PANELS`' order. A layout names every panel of
 * its screen exactly once (checked as this module loads), so no panel is drawn twice or lost.
 */
const PAGE_LAYOUT = Object.freeze({
  setup: [{ cls: "cols setup-layout", items: ["p-setup", { cls: "stack", items: ["p-setup-ready", "p-setup-start"] }] }],
  models: [{ cls: "stack", items: ["p-model-problems"] }, { cls: "cols models-layout", items: [{ cls: "stack", items: ["p-roles"] }, { cls: "stack", items: ["p-cooldowns", "p-models"] }] }, { cls: "stack", items: ["p-subscription-quota", "p-proposals"] }],
  "zero-touch": [{ cls: "cards-4 zt-kpis", items: ["p-zt-rate", "p-zt-streak", "p-zt-wait", "p-zt-handled"] }, { cls: "cols zt-layout", items: [{ cls: "stack zt-main", items: ["p-zt-projects", "p-zt-questions"] }, { cls: "stack zt-side", items: ["p-zt-causes", "p-zt-fixes"] }] }],
  updates: [{ cls: "stack", items: ["p-up-problems"] }, { cls: "cols updates-layout", items: [{ cls: "stack", items: ["p-up-jobs", "p-up-hosts"] }, { cls: "stack", items: ["p-up-how", "p-up-recent"] }] }],
  connections: [{ cls: "stack", items: ["p-connection-problems"] }, { cls: "cols connections-layout", items: [{ cls: "stack", items: ["p-provider-keys", "p-forges", "p-egress", "p-endpoints", "p-subscription-auth"] }, { cls: "stack", items: ["p-notify", "p-mcp", "p-env", "p-packages"] }] }],
  project: [{ cls: "cards-3 project-kpis", items: ["p-proj-spend", "p-proj-runs", "p-proj-size"] }, { cls: "cols project-layout", items: [{ cls: "stack", items: ["p-proj-members", "p-proj-sizing", "p-proj-recent"] }, { cls: "stack", items: ["p-proj-alloc", "p-proj-limits", "p-proj-bundle", "p-proj-triggers", "p-proj-delete"] }] }],
  triggers: [{ cls: "stack", items: ["p-tr-tabs", "p-tr-viewer"] }, { cls: "cards-3 triggers-kpis", items: ["p-tr-count", "p-tr-next", "p-tr-spend"] }, { cls: "cols triggers-layout", items: [{ cls: "stack triggers-rules", items: ["p-tr-filters", "p-tr-week", "p-tr-schedule", "p-tr-github", "p-tr-gitlab", "p-tr-forgejo", "p-tr-azure", "p-tr-unknown"] }, { cls: "stack triggers-check-side", items: ["p-tr-check"] }] }],
  ...SPEND_LAYOUTS,
  config: [{ cls: "stack", items: ["cf-navigation"] }, { cls: "cols cols--wide-side config-layout", items: [{ cls: "stack", items: ["cf-settings", "cf-triggers", "cf-pause-windows", "cf-scoped-limits", "cf-projects", "cf-files"] }, { cls: "stack", items: ["cf-unset", "cf-mcp-servers", "cf-packages", "cf-secret-profiles", "cf-secret-bundles"] }] }],
  trigger: [{ cls: "cols config-layout", items: [{ cls: "stack", items: ["p-trigger-on", "p-trigger-runs", "p-trigger-run", "p-trigger-edit"] }, { cls: "stack", items: ["p-trigger-trust", "p-trigger-kinds", "p-trigger-change"] }] }],
  "trigger-add": [{ cls: "cols cols--wide-side config-layout", items: [{ cls: "stack", items: ["p-trigger-add"] }, { cls: "stack", items: ["p-kinds", "p-forge-words", "p-refusals"] }] }],
  fleet: [{ cls: "stack", items: ["p-fleetbar", "p-active"] }, { cls: "cols cols--wide-side", items: [{ cls: "stack", items: ["p-queues", "p-held", "p-failed", "p-delayed", "p-schedules"] }, { cls: "stack", items: ["p-hosts", "p-doctor"] }] }, { cls: "stack", items: ["p-venues"] }],
  host: [{ cls: "stack", items: ["p-hoststate"] }, { cls: "cols cols--wide-side", items: [{ cls: "stack", items: ["p-hostjobs", "p-hostbudget", "p-hostcap"] }, { cls: "stack", items: ["p-hostrow", "p-hostdoctor"] }] }],
  run: [{ cls: "stack", items: ["p-viewer"] }, { cls: "cols", items: [{ cls: "stack run-main", items: ["p-outcome", "p-run", "p-progress", "p-recovery", "p-transcript", "p-record", "p-rest", "p-secrets", "p-actions", "p-why", "p-host"] }, { cls: "stack run-side", items: ["p-answer-draft", "p-inbox", "p-cost", "p-models", "p-resources", "p-session", "p-chain"] }] }],
  overview: Object.freeze([
    Object.freeze({ cls: "cols", items: Object.freeze(["p-setup", Object.freeze({ cls: "stack", items: Object.freeze(["p-setup-empty"]) })]) }),
    Object.freeze({ cls: "cards-4", slotAfter: true, items: Object.freeze(["p-needs", "p-waiting", "p-active", "p-spend"]) }),
    Object.freeze({ cls: "cols", items: Object.freeze([Object.freeze({ cls: "stack", items: Object.freeze(["p-agent-writes", "p-timeline", "p-caps"]) }), Object.freeze({ cls: "stack", items: Object.freeze(["p-waitlists", "p-hosts"]) })]) }),
  ]),
});

/** The panel ids a layout places, in the order it draws them. */
const layoutIds = (items) => items.flatMap((it) => (typeof it === "string" ? [it] : layoutIds(it.items)));

function zeroTouchLayout(role) {
  if (role === "operator") return PAGE_LAYOUT["zero-touch"];
  return [PAGE_LAYOUT["zero-touch"][0], { cls: "cols zt-layout", items: [{ cls: "stack zt-main", items: ["p-zt-projects", "p-zt-questions", "p-zt-fixes"] }, { cls: "stack zt-side", items: ["p-zt-causes"] }] }];
}
for (const [name, layout] of Object.entries(PAGE_LAYOUT)) {
  const placed = layoutIds(layout);
  const own = PAGE_PANELS[name].map(([id]) => id);
  if (placed.length !== own.length || own.some((id) => !placed.includes(id))) throw new Error(`pages: the ${name} layout places ${placed.join(", ")}, not its panels ${own.join(", ")}`);
}

/**
 * The panel ids of a screen, in page order (for the stream's tests and the hub), then on a live screen the shell's
 * panels (issue #737): the Parked count, which sits in the navigation above them, and the headline, under the title,
 * listed last (`SHELL_PANEL_IDS`' order) so a screen's first panel is still its first.
 */
export function panelIds(name) {
  const ids = (PAGE_PANELS[name] ?? []).map(([id]) => id);
  if (PAGES[name]?.live !== true) return ids;
  return Object.hasOwn(PAGE_HEADLINES, name) ? [...ids, NAV_PARKED_ID, HEADLINE_ID] : [...ids, NAV_PARKED_ID];
}

// ---- the query -------------------------------------------------------------------------------------------------------

/** The parameters each screen takes; any other refuses the request. */
const PAGE_PARAMS = Object.freeze({
  setup: [],
  overview: ["rows", "zoom", "project"],
  runs: [...RUN_FILTER_FIELDS, "before", "touched", "days", "scope"],
  "zero-touch": ["days", "project", "scope"],
  run: ["id"],
  models: [],
  parked: [],
  "answer-rules": [],
  insights: ["range", "project", "whatif", "flow", "runs", "paths"],
  "insights-budget-split": ["range", "project", "paths"],
  "insights-capacity": ["range", "paths"],
  "insights-breakdown": ["range", "project", "whatif", "flow", "paths"],
  "insights-flows": ["range", "project", "view", "paths", "select"],
  fleet: [],
  host: ["name"],
  config: [],
  secrets: [],
  connections: [],
  updates: [],
  project: ["id"],
  trigger: ["index"],
  triggers: ["kind"],
  "trigger-check": [],
  "trigger-add": ["recipe"],
  watch: ["rule"],
  "watch-board": ["rule", "finding"],
  audit: [...AUDIT_PARAMS],
});

/** The most parameters, and the longest value, a query may carry before anything looks at what they say. */
export const QUERY_LIMITS = Object.freeze({ params: 16, valueLength: 256 });

/** A runs cursor: millis, a whole number (`readRunsPage`'s `before`). */
const RUNS_BEFORE_RE = /^\d{1,16}$/;

/** `searchParams` as a URLSearchParams, or null for something that is not a query. */
function asParams(searchParams) {
  if (searchParams instanceof URLSearchParams) return searchParams;
  if (searchParams === null || searchParams === undefined) return new URLSearchParams();
  if (typeof searchParams === "string") return new URLSearchParams(searchParams);
  if (typeof searchParams === "object") {
    const out = new URLSearchParams();
    for (const [k, v] of Object.entries(searchParams)) {
      if (typeof v !== "string") return null;
      out.append(k, v);
    }
    return out;
  }
  return null;
}

/**
 * Judge a screen's query: `{ query }` (frozen) or `{ refusal }` (a sentence naming the parameter and its rule).
 *
 *   - runs: the filter (`parseRunFilter`) and `before` (a cursor in millis); `{ filter, before }`.
 *   - run: `id`, required, in the read model's run-id charset; `{ id }`.
 *   - insights: `range`, one of 7d, 30d, mtd, default 30d; `whatif` (`<provider>/<model>`, `WHATIF_MODEL_RE`) and `flow`
 *     (the skill-name charset), together or not at all; `paths`, only `full`; `{ range, whatif, flow, paths }`, each
 *     absent one null. `paths=full` is ACCEPTED from anyone, and honoured for an operator alone (`insightsFullPaths`).
 *   - overview (issue #737): the timeline's grouping, `rows`, one of `TIMELINE_ROWS`; its window, `zoom`, a key of
 *     `TIMELINE_ZOOMS`; and its project filter, `project`, a project id (`PROJECT_ID_RE`); `{ rows, zoom, project }`,
 *     each absent one null (the timeline's default). Closed values, so the timeline is never handed one it refuses.
 *   - audit: `before` (an audit position, `YYYY-MM:<line>`, `readConsoleAudit`'s cursor), `who`, `action`, `outcome`,
 *     `q` and `seq` (not with `before`), each judged by `audit-view.mjs` `parseAuditQuery`; `{ before, who, action,
 *     outcome, q, seq }`, each absent one null.
 *   - every other screen: no parameter at all; `{}`.
 *
 * Bounded first: at most `QUERY_LIMITS.params` parameters, each value at most `QUERY_LIMITS.valueLength` characters,
 * and a parameter the screen does not take refuses, as does one given twice.
 */
export function parsePageQuery(name, searchParams) {
  if (typeof name !== "string" || !Object.hasOwn(PAGES, name)) return { refusal: "there is no such page on this console" };
  const params = asParams(searchParams);
  if (params === null) return { refusal: "the query is not readable" };
  if (["config", "trigger", "trigger-add", "secrets", "connections", "updates", "project"].includes(name) && params.has("becauseRun")) {
    const source = params.get("becauseRun");
    if (params.getAll("becauseRun").length !== 1 || !/^[A-Za-z0-9._:-]{1,200}$/.test(source ?? "")) return { refusal: "becauseRun must be one retained run id" };
    const rest = new URLSearchParams(params); rest.delete("becauseRun");
    const parsed = parsePageQuery(name, rest);
    return parsed.refusal ? parsed : { query: Object.freeze({ ...parsed.query, becauseRun: source }) };
  }
  const allowed = PAGE_PARAMS[name];
  let n = 0;
  for (const [key, value] of params) {
    n += 1;
    if (n > QUERY_LIMITS.params) return { refusal: `a query carries at most ${QUERY_LIMITS.params} parameters` };
    // The key is checked against the screen's own list before it is named, so a refusal never echoes a stranger's key.
    if (!allowed.includes(key)) return { refusal: allowed.length === 0 ? `the ${name} page takes no query parameters` : `the ${name} page takes only ${allowed.join(", ")}` };
    if (value.length > QUERY_LIMITS.valueLength) return { refusal: `${key} is longer than ${QUERY_LIMITS.valueLength} characters` };
  }
  for (const key of allowed) if (params.getAll(key).length > 1) return { refusal: `${key} is given more than once` };
  const one = (key) => {
    const v = params.get(key);
    return v === null || v === "" ? null : v;
  };
  switch (name) {
    case "triggers": {
      const kind = one("kind") ?? "all";
      if (!TRIGGER_LIST_KINDS.includes(kind)) return { refusal: `kind must be one of ${TRIGGER_LIST_KINDS.join(", ")}` };
      return { query: Object.freeze({ kind }) };
    }
    case "trigger": {
      const index = one("index");
      if (index === null || !/^(?:0|[1-9]\d{0,5})$/.test(index)) return { refusal: "index must be a triggers-file index" };
      return { query: Object.freeze({ index: Number(index) }) };
    }
    case "host": {
      const value = one("name");
      if (value === null) return { refusal: `the ${name} page needs ?name=` };
      if (!WORKER_NAME_RE.test(value)) return { refusal: "name must be a worker name (letters, digits, '.', '_', '-', at most 64 characters)" };
      return { query: Object.freeze({ name: value }) };
    }
    case "watch":
    case "watch-board": return parseWatchQuery(params, { board: name === "watch-board" });
    case "zero-touch": {
      const days = one("days") ?? "30";
      if (!["7", "30", "90"].includes(days)) return { refusal: "days must be one of 7, 30, 90" };
      const project = one("project");
      if (project !== null && project !== "~" && !PROJECT_ID_RE.test(project)) return { refusal: "project must be a project id or ~ for no project" };
      const scope = one("scope");
      if (scope !== null && !/^[a-f0-9]{64}$/.test(scope)) return { refusal: "scope must be an opaque scope id" };
      return { query: Object.freeze({ days: Number(days), project, scope }) };
    }
    case "runs": {
      const touched = one("touched");
      if (touched !== null && touched !== "1") return { refusal: "touched must be 1 or left out" };
      const missingProject = touched === "1" && one("project") === "~";
      const runParams = missingProject ? new URLSearchParams(params) : params;
      if (missingProject) runParams.delete("project");
      const f = parseRunFilter(runParams);
      if (f.refusal) return { refusal: f.refusal };
      const days = one("days") ?? "30";
      const scope = one("scope");
      if (!["7", "30", "90"].includes(days)) return { refusal: "days must be one of 7, 30, 90" };
      if (scope !== null && !/^[a-f0-9]{64}$/.test(scope)) return { refusal: "scope must be an opaque scope id" };
      if (touched === null && (one("days") !== null || scope !== null)) return { refusal: "days and scope require touched=1 on Runs" };
      const raw = one("before");
      let before = null;
      if (raw !== null) {
        if (!RUNS_BEFORE_RE.test(raw) || !Number.isSafeInteger(Number(raw))) return { refusal: "before must be a whole number of milliseconds" };
        before = Number(raw);
      }
      return { query: Object.freeze({ filter: touched ? Object.freeze({ ...f.filter, ...(missingProject ? { project: "~" } : {}), touched, days, ...(scope ? { scope } : {}) }) : f.filter, before }) };
    }
    case "project": {
      const id = one("id");
      if (id === null) return { refusal: "the project page needs ?id= with a project id" };
      if (!PROJECT_ID_RE.test(id)) return { refusal: "id must be a project id (lowercase letters, digits and '-', at most 32 characters)" };
      return { query: Object.freeze({ id }) };
    }
    case "run": {
      const id = one("id");
      if (id === null) return { refusal: "the run page needs ?id= with a run's job id" };
      if (!RUN_ID_RE.test(id)) return { refusal: "id must be a run id (letters, digits and . _ : -, at most 200 characters)" };
      return { query: Object.freeze({ id }) };
    }
    case "insights-budget-split":
    case "insights-capacity":
    case "insights-breakdown":
    case "insights-flows":
    case "insights": {
      const range = one("range") ?? INSIGHTS_DEFAULT_RANGE;
      const ranges = name === "insights-capacity" ? ["24h", ...INSIGHTS_RANGES] : INSIGHTS_RANGES;
      if (!ranges.includes(range)) return { refusal: `range must be one of ${ranges.join(", ")}` };
      const whatif = one("whatif");
      const flow = one("flow");
      if (name === "insights-breakdown" && (whatif === null) !== (flow === null)) return { refusal: "whatif and flow go together: give both or neither" };
      if (flow !== null && whatif === null) return { refusal: "flow must be given with whatif and a model" };
      if (whatif !== null && !WHATIF_MODEL_RE.test(whatif)) return { refusal: "whatif must be a provider/model id" };
      if (flow !== null && !WHATIF_FLOW_RE.test(flow)) return { refusal: "flow must be a flow name (lowercase letters, digits, '_' and '-', at most 64 characters)" };
      const paths = one("paths");
      if (paths !== null && paths !== "full") return { refusal: "paths must be full (or left out for folder names)" };
      const project = one("project");
      if (project !== null && !PROJECT_ID_RE.test(project)) return { refusal: "project must be a project id (lowercase letters, digits and '-', at most 32 characters)" };
      const runs = one("runs");
      if (runs !== null && !["24h", "week"].includes(runs)) return { refusal: "runs must be 24h or week" };
      const mode = one("view");
      if (mode !== null && !["map", "list"].includes(mode)) return { refusal: "view must be map or list" };
      const select = one("select");
      if (select !== null && !/^(?:0|[1-9]\d{0,5})$/.test(select)) return { refusal: "select must be a triggers-file index" };
      const query = { range, paths };
      for (const [key, value] of Object.entries({ project, whatif, flow, runs, view: mode, select })) if (allowed.includes(key)) query[key] = value;
      return { query: Object.freeze(query) };
    }

    case "overview": {
      // Issue #737: the timeline's three, each a closed value. The refusal names the parameter and what it takes, never
      // what was sent.
      const rows = one("rows");
      if (rows !== null && !TIMELINE_ROWS.includes(rows)) return { refusal: `rows must be one of ${TIMELINE_ROWS.join(", ")}` };
      const zoom = one("zoom");
      if (zoom !== null && !Object.hasOwn(TIMELINE_ZOOMS, zoom)) return { refusal: `zoom must be one of ${Object.keys(TIMELINE_ZOOMS).join(", ")}` };
      const project = one("project");
      if (project !== null && !PROJECT_ID_RE.test(project)) return { refusal: "project must be a project id (lowercase letters, digits and '-', at most 32 characters)" };
      return { query: Object.freeze({ rows, zoom, project }) };
    }
    case "trigger-add": {
      const recipe = one("recipe");
      if (params.has("recipe") && (recipe === null || !Object.hasOwn(TRIGGER_RECIPES, recipe))) return { refusal: `recipe must be one of ${Object.keys(TRIGGER_RECIPES).join(", ")}` };
      return { query: Object.freeze(recipe === null ? {} : { recipe }) };
    }
    case "audit":
      // Issue #737: the audit page's own parser (audit-view.mjs) judges every parameter, the cursor exactly as
      // `readConsoleAudit` takes it, so a refused cursor or filter never reaches a read.
      return parseAuditQuery(params);
    default:
      return { query: Object.freeze({}) };
  }
}

/**
 * A parsed query as the canonical query string (no leading `?`): what a live page carries in `data-query` for the
 * script to reopen its stream with, and what the stream's `page=` request passes back through `parsePageQuery`.
 */
export function pageQueryString(name, query) {
  const p = new URLSearchParams();
  const q = query ?? {};
  if (name === "zero-touch") {
    p.set("days", String(q.days ?? 30));
    if (q.project) p.set("project", q.project);
    if (q.scope) p.set("scope", q.scope);
  }
  if (name === "trigger-add" && q.recipe) p.set("recipe", q.recipe);
  if (name === "trigger" && Number.isSafeInteger(q.index)) p.set("index", String(q.index));
  if (name === "triggers" && q.kind && q.kind !== "all") p.set("kind", q.kind);
  if (name === "watch" || name === "watch-board") {
    for (const k of ["rule", "finding"]) if (q[k]) p.set(k, q[k]);
  } else if (name === "runs") {
    for (const k of [...RUN_FILTER_FIELDS, "touched", "days", "scope"]) if (q.filter?.[k] !== undefined) p.set(k, q.filter[k]);
    if (q.before !== null && q.before !== undefined) p.set("before", String(q.before));
  } else if (name === "host" && q.name) p.set("name", q.name);
  else if ((name === "run" || name === "project") && q.id) p.set("id", q.id);
  else if (name.startsWith("insights")) {
    for (const k of PAGE_PARAMS[name]) if (typeof q[k] === "string" && q[k] !== "") p.set(k, q[k]);
  }
  else if (name === "audit") return auditQueryString(q);
  else if (name === "overview") {
    for (const k of ["rows", "zoom", "project"]) if (typeof q[k] === "string" && q[k] !== "") p.set(k, q[k]);
  }
  return p.toString();
}

/**
 * The query screen `name`'s DATA is read with (issue #737), for the live hub, which reads each screen once per tick
 * for each distinct data query (`live.mjs` `dataQueryOf`) and draws each stream with its own whole query. The
 * overview's query only chooses how the same snapshot is drawn (the timeline's grouping, window and project), so its
 * data query is `{}`: one read per tick however many groupings are open, where its whole query would read the snapshot
 * once for each. Every other screen reads what its query names, so its data query is its query.
 */
export function dataQueryOf(name, query) {
  return name === "overview" ? Object.freeze({}) : query;
}

// ---- where a sign-in lands ------------------------------------------------------------------------------------------

/** The longest return path accepted: a page path and a query within `QUERY_LIMITS`, with room to spare. */
export const RETURN_PATH_MAX = 1024;

/**
 * The page a one-time sign-in link returns to (issue #708: `login/code#<code>&next=/runs`), or null for anything that
 * is not one of THIS console's own pages. The `next` value arrives from a link anyone could have written, so it is an
 * open redirect unless it is held to the console's own pages: a string of at most `RETURN_PATH_MAX` characters,
 * starting with exactly one `/` (`//evil` is a scheme-relative URL to another host), no backslash (a browser reads
 * `/\evil` as `//evil`), no control byte, no fragment, that parses to this origin, whose path is a `PAGES` path, and
 * whose query passes that page's own `parsePageQuery`. `/login` and `/login/code` are not pages, so a link cannot loop
 * back into sign-in. Returns the path and query as given (`/run?id=a.b`), since the page parser accepted them.
 */
export function returnPathOf(raw) {
  if (typeof raw !== "string" || raw === "" || raw.length > RETURN_PATH_MAX) return null;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\") || raw.includes("#") || /[\u0000-\u001f\u007f]/.test(raw)) return null;
  let url;
  try {
    url = new URL(raw, "http://console.invalid");
  } catch {
    return null;
  }
  if (url.origin !== "http://console.invalid") return null;
  const name = Object.keys(PAGES).find((k) => PAGES[k].path === url.pathname);
  if (name === undefined) return null;
  const parsed = parsePageQuery(name, url.searchParams);
  if (!parsed || parsed.refusal || !("query" in parsed)) return null;
  return `${url.pathname}${url.search}`;
}

// ---- reading ---------------------------------------------------------------------------------------------------------

/**
 * What each screen reads beside the clock. A screen that reads no snapshot reads `parkedCount` for the navigation's
 * Parked count (issue #737); one that reads the snapshot takes the count from it, so no screen reads both.
 *
 * `waiting` (issue #737) asks the same snapshot for the waiting jobs and why each waits (`snapshot({ waiting: true })`),
 * which only the overview draws. It is the page's to ask, not the reader's: one reader serves every screen and
 * `/api/state`, and a reader built to read them would make every other screen pay for a read it never draws.
 */
const PAGE_READS = Object.freeze({
  setup: ["snapshot", "setup"],
  models: ["snapshot", "waiting", "models"],
  "zero-touch": ["parkedCount"],
  overview: ["snapshot", "waiting"],
  runs: ["runsPage", "subscriptions", "runsWindow", "parkedCount"],
  run: ["run", "subscriptions", "transcriptMeta", "progress", "inbox", "jobState", "actions", "parkedCount"],
  parked: ["snapshot", "parkedChecks"],
  "answer-rules": ["snapshot", "parkedCount"],
  insights: ["insights", "parkedCount"],
  "insights-budget-split": ["insights", "parkedCount"],
  "insights-capacity": ["insights", "parkedCount"],
  "insights-breakdown": ["insights", "parkedCount"],
  "insights-flows": ["insights", "parkedCount"],
  fleet: ["snapshot", "waiting"],
  host: ["snapshot", "waiting", "hostCapacity"],
  config: ["snapshot"],
  secrets: ["snapshot", "secrets"],
  connections: ["snapshot", "connections", "setup"],
  updates: ["snapshot", "updates"],
  project: ["snapshot", "waiting", "project"],
  trigger: ["snapshot", "waiting"],
  triggers: ["snapshot", "waiting"],
  "trigger-check": ["parkedCount"],
  "trigger-add": ["snapshot"],
  watch: ["parkedCount"],
  "watch-board": ["parkedCount"],
  audit: ["audit", "parkedCount"],
});

/** The runs a screen shows per page, and how far the run detail looks for a run's children. */
export const RUNS_PER_PAGE = 50;
const CHILD_SEARCH = Object.freeze({ pageSize: 100, pages: 3 });
/** The audit rows per page. */
export const AUDIT_PER_PAGE = 50;

/**
 * The deployment env's forge instance variables alone (the ones `forgeLinkOf` reads): the page data never carries the
 * rest of the env, which holds tokens and keys, so nothing that serializes the data can leak them.
 */
function forgeEnvOf(env) {
  const names = new Set(["GITLAB_URL", "FORGEJO_URL", "AZURE_ORG_URL"]);
  for (const forge of Object.values(FORGES)) for (const n of forge?.hostVars ?? []) names.add(n);
  const out = {};
  for (const n of [...names].sort()) if (typeof env?.[n] === "string" && env[n] !== "") out[n] = env[n];
  return Object.freeze(out);
}

/** The subscriptions the cost classifier knows plans by: an array, from `deps.subscriptions()` when wired, else none. */
async function subscriptionsOf(deps) {
  if (typeof deps.subscriptions !== "function") return [];
  try {
    const got = await deps.subscriptions();
    if (Array.isArray(got)) return got;
    return Array.isArray(got?.subscriptions) ? got.subscriptions : [];
  } catch {
    return [];
  }
}

/**
 * The navigation's Parked count for a screen that reads no snapshot (issue #737): the fleet reader's `parkedCount`, a
 * whole number of unanswered parked runs, or null when the reader has none, it throws, or it answers anything else
 * (the shell then draws no count, never a 0).
 */
async function parkedCountOf(deps) {
  if (typeof deps.fleet?.parkedCount !== "function") return null;
  try {
    const n = await deps.fleet.parkedCount();
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * A run's children: runs whose `parentJobId` is its id, among the newest `CHILD_SEARCH.pages` pages of runs (a child
 * starts after its parent, so the search stops at the first page older than the parent's start). `{ children,
 * searched }`, `searched` the number of runs examined, which the page states rather than claiming none exist.
 */
async function childrenOf(fleet, record) {
  const startMs = Date.parse(record.startedAt ?? record.endedAt ?? "");
  const children = [];
  let searched = 0;
  let before = null;
  for (let i = 0; i < CHILD_SEARCH.pages; i += 1) {
    let pageRead;
    try {
      pageRead = await fleet.runsPage({ before, limit: CHILD_SEARCH.pageSize });
    } catch {
      break;
    }
    if (!Array.isArray(pageRead?.runs)) break;
    searched += pageRead.runs.length;
    for (const r of pageRead.runs) if (r?.parentJobId === record.jobId) children.push({ jobId: r.jobId ?? null, outcome: r.outcome ?? null, reason: recordReason(r), startedAt: r.startedAt ?? null });
    if (pageRead.next === null || pageRead.next === undefined || (Number.isFinite(startMs) && pageRead.next <= startMs)) break;
    before = pageRead.next;
  }
  children.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)) || String(a.jobId).localeCompare(String(b.jobId)));
  return { children, searched };
}

/**
 * Whether a load's page can draw an answer form (issue #737, the Parked page's planner checks): a console that takes
 * changes (`readOnly` not true), seen by an operator or by a session the load does not name. A `who` without a role (a
 * caller that does not say) reads as one an operator may see, so the checks are read rather than silently left out.
 */
function formsDrawn(who) {
  if (who?.readOnly === true) return false;
  return who?.role === undefined || who?.role === null || who.role === "operator";
}

// The run page's and Parked page's planner checks, per fleet reader, then per run id: `{ at, recordKey, got }`.
const answerCheckCache = new WeakMap();
const rerunCheckCache = new WeakMap();

/** The identity a per-run cache entry is kept for: the record's id, end and target, so a new record reads afresh. */
const recordKeyOf = (record) => `${record?.jobId}\u0000${record?.endedAt}\u0000${record?.target}`;

/**
 * How long a page's live loop reuses a park's pending-answer check and the re-run check (a job read and the triggers
 * file) per run id (review round 2: both ran on every 2 s tick).
 */
export const PARK_CHECK_CACHE_MS = 15_000;

/**
 * `read()`, reused for `PARK_CHECK_CACHE_MS` while the record is the same one. EVERY answer is kept for the window, an
 * unreadable one as long as a good one (issue #737): one that was read again on every tick sent a Valkey that was
 * already failing a queue lookup per run per tick, and the Parked page has twenty runs. The live page says the check
 * could not be read until the window ends. A request retries an unreadable answer: the live load may have asked an
 * incomplete set of queues (#747).
 */
async function parkCheckCached(cache, fleet, id, record, now, read, { reuseUnreachable = true } = {}) {
  const at = typeof now === "function" ? now() : Date.now();
  const recordKey = recordKeyOf(record);
  let byId = cache.get(fleet);
  if (!byId) cache.set(fleet, (byId = new Map()));
  const hit = byId.get(id);
  if (hit && (reuseUnreachable || hit.got?.unreachable !== true) && hit.recordKey === recordKey && at >= hit.at && at - hit.at < PARK_CHECK_CACHE_MS) return hit.got;
  const got = await read();
  if (!hit && byId.size >= 256) byId.delete(byId.keys().next().value);
  byId.set(id, { at, recordKey, got });
  return got;
}

/** The run page's re-run check through the shared park-check cache, never throwing (an error reads as unreachable). */
async function actionCheckOf(cache, fleet, method, id, record, now, lookup = {}) {
  if (typeof fleet?.[method] !== "function") return null;
  const read = async () => {
    try {
      return await fleet[method](id, record, lookup);
    } catch {
      return { unreachable: true };
    }
  };
  return parkCheckCached(cache, fleet, id, record, now, read, { reuseUnreachable: lookup.live === true });
}

/**
 * The planner's own check on whether parked run `id` can take a console answer (`fleet.parkedAnswerCheck`: `{ refusal }`,
 * `{ ok: true }` or `{ unreachable: true }`), reused by the Parked page and the run page's live loop for
 * `PARK_CHECK_CACHE_MS` per run id while `record` is the same one (`now` the clock), an unreadable answer as long as a
 * good one. `lookup` is the load's question for the reader's by-id lookup (`{ live }` or `{ asked }`, `loadPageData`).
 * Null without the reader. The reader takes no record (`parkedAnswerCheck(jobId, lookup)`), unlike `rerunCheck`, so
 * this keeps its own call: a record passed in its `lookup` slot would read as a non-live question and scan the
 * keyspace once per check past the cache window instead of never.
 */
export async function parkedAnswerCheckOf(fleet, id, record, { now = Date.now, lookup = {} } = {}) {
  if (typeof fleet?.parkedAnswerCheck !== "function") return null;
  const read = async () => {
    try {
      return await fleet.parkedAnswerCheck(id, lookup);
    } catch {
      return { unreachable: true };
    }
  };
  return parkCheckCached(answerCheckCache, fleet, id, record, now, read, { reuseUnreachable: lookup.live === true });
}

/**
 * Whether run `id` (with `record`) can be offered a re-run (issue #710): `fleet.rerunCheck`, the planner's own cheap
 * refusals over the record and the job's retained data (`rerunRefusalOf`), reused by the run page's live loop for
 * `PARK_CHECK_CACHE_MS` per run id while `record` is the same one, as `parkedAnswerCheckOf` is (an unreadable answer
 * too), and asked with the load's `lookup` as it is. `{ refusal }`, `{ ok: true }`, `{ unreachable: true }`, or null
 * without the reader.
 */
export async function rerunCheckOf(fleet, id, record, { now = Date.now, lookup = {} } = {}) {
  return actionCheckOf(rerunCheckCache, fleet, "rerunCheck", id, record, now, lookup);
}

/**
 * Read what screen `name` shows for `query` (a `parsePageQuery` result's `query`). `deps`:
 *
 *   - `fleet`: a `createFleetReader` instance (`snapshot`, `runsPage`, `runById`, and `parkedCount` for the screens that
 *     read no snapshot). `snapshot()` is called at most once, asked for the waiting jobs only by a screen that draws
 *     them (`PAGE_READS`' `waiting`).
 *   - `insights(window, { fullPaths })`: the assembled insights payload for a window (the caller caches it: it is the
 *     expensive read). `fullPaths` is true only for an operator's `paths=full`.
 *   - `whatIf({ model, flow })` (optional): the what-if answer (`whatif.mjs`'s reader, cached and bounded by the caller).
 *   - `pricedModels()` (optional): the priced catalog's `provider/id` strings, for the what-if form's suggestions.
 *   - `audit({ limit, before })`: `readConsoleAudit` bound to the deployment's logs directory.
 *   - `subscriptions()` (optional): the subscriptions file's entries, for the cost class of a plan-covered run.
 *   - `env`: the deployment's env, of which only the forge instance variables are kept (`forgeEnvOf`).
 *   - `now`: the clock (a function or a number), read ONCE; every panel draws from this instant.
 *   - `deployment` (optional, issue #737): `{ folder }`, the deployment directory's last folder, kept as `data.deployment`.
 *
 * `who` is who will see the page (`{ role, readOnly, live }`, `readOnly` the console's own): the spend screen's
 * `paths=full` reads full paths for an operator's request alone, so a viewer's page data never holds them, and the
 * Parked page reads its planner checks only where a form can be drawn (`formsDrawn`). The server passes the request's
 * role; the live hub (`live.mjs`) passes `{ readOnly, live: true }`, with `role: "viewer"` for a load no operator's
 * stream shows, and never an operator's role, since one load serves every role watching it (insights, which reads full
 * paths, is not live).
 *
 * A KEYSPACE SCAN FOR AN ABSENCE IS A REQUEST'S, NEVER THE LIVE HUB'S (issue #737). The by-id lookups of one load (the
 * job's queue state, the re-run check, the parked answer checks: the run and Parked pages) ask one question: a request's
 * (`fleet.lookupQuestion`, read once here) costs at most one keyspace scan however many of them miss, and they run
 * together, so a load waits for that scan once; a live load's (`who.live`) costs none, and keeps what the request was
 * told of an absence (the reader's `lookUp`).
 *
 * Never throws for a read that fails: the field is null (or carries a sentence), and the panel says so.
 */
export async function loadPageData(name, query, deps = {}, who = {}) {
  if (!Object.hasOwn(PAGES, name)) throw new RangeError(`no such page: ${String(name)}`);
  const now = typeof deps.now === "function" ? deps.now() : Number.isFinite(deps.now) ? deps.now : Date.now();
  const q = query ?? {};
  // Issue #737: the deployment the console serves, by its folder's last part (`cli.mjs`'s `pageDeps.deployment`), for
  // the first run's checklist; null where the caller passes none.
  const data = { page: name, now, env: forgeEnvOf(deps.env), deployment: deps.deployment ?? null };
  if (name === "watch" || name === "watch-board") data.watch = await loadWatchData(deps.watch, q, { board: name === "watch-board", privateRead: who?.role === "operator" && who?.live !== true });
  const reads = PAGE_READS[name];
  if (["parked", "answer-rules", "run"].includes(name) && deps.answerer) {
    const operatorRead = who?.role === "operator" || who?.live === true && who?.role === undefined;
    try { data.answerer = await deps.answerer.read({ role: operatorRead ? "operator" : who?.role ?? "viewer", ...(name === "run" && operatorRead ? { runId: q.id } : {}) }); }
    catch { data.answerer = { state: "unavailable", partial: true, rows: [] }; }
  }
  if (name === "overview" && (who?.role === "operator" || who?.live === true && who?.role === undefined) && typeof deps.agentWrites === "function") {
    try { data.agentWrites = await deps.agentWrites(); } catch { data.agentWrites = { unavailable: true, partial: true }; }
  }
  if (name === "zero-touch") {
    try { data.zeroTouch = typeof deps.zeroTouch === "function" ? await deps.zeroTouch({ windowDays: q.days, project: q.project, scopeId: q.scope, role: who?.role }) : null; } catch { data.zeroTouch = null; }
    // Role projection happens before page data can be inspected or reused, not just while rendering a group panel.
    data.zeroTouch = zeroTouchView(data.zeroTouch, { role: who?.role, windowDays: q.days, nowMs: now });
  }
  if (["config", "trigger", "trigger-add", "triggers"].includes(name) && typeof deps.configLocations === "function") data.configLocations = deps.configLocations();
  // The by-id lookups' one question for this load (see above): the hub's, or this request's, read before any of them.
  const lookup = who?.live === true ? { live: true } : typeof deps.fleet?.lookupQuestion === "function" ? deps.fleet.lookupQuestion() : {};
  if (name === "run" && typeof deps.env?.PI_CHAIN_MAX_PER_JOB === "string" && /^\d{1,9}$/.test(deps.env.PI_CHAIN_MAX_PER_JOB)) data.chainMaxPerJob = Number(deps.env.PI_CHAIN_MAX_PER_JOB);
  if (reads.includes("snapshot")) {
    try {
      data.snapshot = await (reads.includes("waiting") ? deps.fleet.snapshot({ waiting: true }) : deps.fleet.snapshot());
    } catch {
      data.snapshot = null;
      // Issue #737: the page's primary read failed, so the hub may keep the last good panels and say `stale`.
      data.readFailed = true;
    }
  }
  if (reads.includes("setup")) {
    try { data.setup = setupFacts(typeof deps.setup === "function" ? await deps.setup({ role: who.role, snapshot: data.snapshot }) : null, { role: who.role ?? "operator" }); }
    catch { data.setup = setupFacts(null, { role: who.role }); }
  }
  if (reads.includes("models")) {
    try { data.models = typeof deps.modelsView === "function" ? await deps.modelsView(data.snapshot) : null; }
    catch { data.models = null; }
  }
  if (reads.includes("secrets")) {
    try { data.secrets = typeof deps.secretsView === "function" ? await deps.secretsView(data.snapshot) : secretsView({ snapshot: data.snapshot, env: deps.env ?? {} }); }
    catch { data.secrets = null; }
  }
  if (reads.includes("connections")) {
    try { data.connections = typeof deps.connections === "function" ? await deps.connections(data.snapshot) : null; }
    catch { data.connections = null; }
  }
  if (reads.includes("updates")) {
    try { data.updates = typeof deps.updates === "function" ? await deps.updates() : null; }
    catch { data.updates = null; }
  }
  if (reads.includes("project")) {
    try { data.projectView = typeof deps.projectView === "function" ? await deps.projectView(q.id, data.snapshot) : { id: q.id, state: "unreadable" }; }
    catch { data.projectView = { id: q.id, state: "unreadable" }; }
  }
  if (name === "triggers") {
    try { data.triggerList = typeof deps.triggerList === "function" ? await deps.triggerList(data.snapshot) : triggerListOf({ snapshot: data.snapshot, now }); }
    catch { data.triggerList = triggerListOf({ snapshot: null, now }); }
  }
  if (name === "trigger") {
    if (data.snapshot && typeof deps.fleet?.triggerSkew === "function") {
      try { data.snapshot = { ...data.snapshot, triggerSkew: { [q.index]: await deps.fleet.triggerSkew(q.index, data.snapshot.waiting) } }; } catch { /* An unreadable skew check remains unknown. */ }
    }
    data.triggerDetail = triggerDetailOf(data.snapshot, q.index, { now });
    if (formsDrawn(who)) {
      try { data.triggerFireCheck = typeof deps.triggerFireCheck === "function" ? await deps.triggerFireCheck(q.index) : { refusal: "Fire now is not available in this deployment." }; } catch { data.triggerFireCheck = { refusal: "The console could not check whether this schedule can fire here." }; }
    }
  }
  if (name === "trigger" || name === "trigger-add") {
    try { data.triggerEditor = typeof deps.triggerEditor === "function" ? await deps.triggerEditor() : readTriggerEditor({ paths: deps.paths ?? {}, env: deps.env ?? {} }); } catch { data.triggerEditor = {}; }
  }
  if (name === "fleet") {
    try {
      const plan = typeof deps.killSwitchPlan === "function" ? deps.killSwitchPlan({ paused: false }) : null;
      data.killSwitch = plan ? { disagreement: plan.disagreement ?? null, refused: plan.refused ?? null, resumeCommand: plan.resumeCommand ?? null, resumeArgv: Array.isArray(plan.resumeArgv) ? [...plan.resumeArgv] : null } : null;
    } catch { data.killSwitch = { refused: "The deployment's kill switch could not be read." }; }
  }
  if (name === "host") {
    data.host = data.snapshot?.hostBudgets?.find((host) => host.name === q.name) ?? null;
    try { const history = await deps.fleet.runsPage({ filter: { host: q.name }, limit: RUNS_PER_PAGE }); data.hostHistory = { ...history, records: history?.runs ?? [] }; } catch { data.hostHistory = null; }
    // Capacity is an expensive historical fold. A live replacement deliberately omits its panel, keeping the initial chart.
    if (who?.live !== true) {
      try { data.hostCapacity = typeof deps.hostCapacity === "function" ? await deps.hostCapacity(q.name) : null; } catch { data.hostCapacity = null; }
    } else data.live = true;
  }
  if (reads.includes("subscriptions")) data.subscriptions = await subscriptionsOf(deps);
  if (reads.includes("runsPage")) {
    try {
      data.runsPage = q.filter?.touched === "1" ? await deps.zeroTouchRuns({ before: q.before ?? null, limit: RUNS_PER_PAGE, filter: q.filter, windowDays: Number(q.filter.days), scopeId: q.filter.scope ?? null }) : await deps.fleet.runsPage({ before: q.before ?? null, limit: RUNS_PER_PAGE, filter: q.filter ?? null });
    } catch {
      data.runsPage = null;
      data.readFailed = true;
    }
  }
  if (reads.includes("runsWindow")) {
    try {
      data.runsWindow = (await deps.fleet.runsWindow?.()) ?? null;
    } catch {
      data.runsWindow = null;
    }
  }
  if (reads.includes("run")) {
    try {
      data.run = await deps.fleet.runById(q.id);
    } catch {
      data.run = { unreadable: RUN_RECORD_UNREAD };
      data.readFailed = true;
    }
    if (data.run?.record) Object.assign(data, await childrenOf(deps.fleet, data.run.record).then(({ children, searched }) => ({ children, childrenSearched: searched })));
  }
  if (reads.includes("transcriptMeta") && typeof deps.fleet?.transcriptMeta === "function") {
    // Issue #643: whether the run has a live transcript stream, without a byte of its text (the stream's text goes to an
    // operator's page entry events or `/api/transcript`, never a panel). Read for both roles, as all page data is; only an operator's page uses it.
    // Only a read's own answer (`exists` true or false) says whether a stream exists: anything else, an answer that is
    // not one included, is a stream that could not be read, never "none".
    try {
      const meta = await deps.fleet.transcriptMeta(q.id);
      const read = meta !== null && typeof meta === "object" && !meta.unreachable && !meta.invalid && typeof meta.exists === "boolean";
      data.transcript = read ? { exists: meta.exists, ended: meta.ended === true, outcome: typeof meta.outcome === "string" ? meta.outcome : null, length: Number.isSafeInteger(meta.length) ? meta.length : 0, lastId: typeof meta.lastId === "string" && TRANSCRIPT_ID_RE.test(meta.lastId) ? meta.lastId : null } : { unreachable: true, exists: false };
    } catch {
      data.transcript = { unreachable: true, exists: false };
    }
  }
  if (reads.includes("progress") && typeof deps.fleet?.progress === "function") {
    // Issue #644: the run's progress snapshot, WHOLE (its phase names and note included), read once for both roles as
    // all page data is; `runProgress` draws the model's words for an operator alone. Page data is never serialized to a
    // browser: only rendered panels leave this process.
    // Issue #662: by the job's RUN id, and with whether this attempt's run went on as a recovery (`progressOfRun`), so a
    // recovery's own page shows its live progress and the attempt it continues shows its own record's, not the
    // recovery's. A fleet without it (an older reader double) reads by the page's id, as before.
    try {
      if (typeof deps.fleet.progressOfRun === "function") {
        const got = await deps.fleet.progressOfRun(q.id, data.run?.record ?? null);
        data.progress = got?.progress ?? { unreachable: true };
        if (got?.continues === true) data.progressContinues = { as: typeof got.continuesAs === "string" && RUN_ID_RE.test(got.continuesAs) ? got.continuesAs : null };
      } else data.progress = await deps.fleet.progress(q.id);
    } catch {
      data.progress = { unreachable: true };
      // A continued attempt shows its own record whatever the read did: the record alone says its run went on.
      if (typeof deps.fleet.progressOfRun === "function" && data.run?.record?.reason === "recovery-enqueued") data.progressContinues = { as: null };
    }
  }
  if (name === "run" && !data.run?.record && typeof deps.fleet?.runLiveFacts === "function") {
    try { data.activeRun = await deps.fleet.runLiveFacts(q.id, lookup); } catch { data.activeRun = null; }
  }
  if (reads.includes("inbox") && typeof deps.fleet?.inbox === "function") {
    // Issue #646: a steer-armed job's inbox, WITHOUT TEXT (the reader's `readJobInbox`: ids, modes, sources, states,
    // times and byte counts), and whether its run takes messages now. Both roles get the list; `runInbox` draws the
    // message form and the withdraw buttons for an operator alone.
    try {
      data.inbox = await deps.fleet.inbox(q.id);
    } catch {
      data.inbox = { unreachable: true };
    }
  }
  // The job's queue state, and the actions' checks, run together (see above).
  const jobStateRead = async () => {
    // The job's queue state (the fleet's by-id lookup, issue #737), for the panels that name a run by its job: the
    // outcome banner's queued and recovering sentences, the headline's badge and cancel, the recovery panel's running or
    // queued recovery, the inbox's and `runPlaces`' queues place. Null without a job-state reader (an older fleet
    // double). `tellAbsent` (issue #737's rule, kept by every by-id lookup): only a run with no record asks the lookup
    // to tell an absence, since a record shows the run whatever the queue says.
    if (typeof deps.fleet?.jobStatus !== "function") {
      data.queueState = null;
      return;
    }
    try {
      const status = await deps.fleet.jobStatus(q.id, { ...lookup, tellAbsent: !data.run?.record });
      data.queueState = status && !status.unreachable && !status.invalid ? { found: status.found === true ? true : status.found === false ? false : null, jobState: typeof status.state === "string" ? status.state : null, activeJobId: typeof status.continuesAs === "string" ? status.continuesAs : null, queuedJobId: typeof status.queuedAs === "string" ? status.queuedAs : null } : { unreachable: true };
    } catch {
      data.queueState = { unreachable: true };
    }
  };
  const actionsRead = async () => {
    // Issue #710: whether the run's action can work, so the page offers it only then (REQ-OPERATOR-CONSOLE-ACTIONS):
    // the planner's cheap re-run refusals over the retained job's data (`rerunCheck`), reused for PARK_CHECK_CACHE_MS
    // per run id, so the live loop does not read it every tick. Read for both roles, as all page data is; only an
    // operator's page draws the actions.
    const record = data.run.record;
    const forkPoints = await readForkPoints({ jobId: q.id, env: deps.env ?? {}, now: () => now });
    data.forkPoints = forkPoints.ok ? { ok: true, entries: forkPoints.entries } : { refusal: forkPoints.refusal };
    data.rerunCheck = await rerunCheckOf(deps.fleet, q.id, record, { now: () => now, lookup });
  };
  await Promise.all([reads.includes("jobState") ? jobStateRead() : null, reads.includes("actions") && data.run?.record ? actionsRead() : null]);
  if (name === "run" && data.run?.record) {
    const record = data.run.record;
    // These lookups are bounded by the worker's own replica/recovery caps, never a history scan. A related record
    // remains PII-free; no retained queue payload is passed to a renderer.
    const siblings = [];
    if (Number.isInteger(record.replica) && Number.isInteger(record.replicas) && record.replicas <= REPLICAS_MAX && record.replicas >= 2) {
      const stem = String(record.recoveryOf ?? record.jobId ?? "").replace(/-r[1-3](?=\.r[1-2]$|$)/, "-r");
      for (let i = 1; i <= record.replicas; i += 1) {
        if (i === record.replica) continue;
        const id = stem.replace(/-r(?=\.r[1-2]$|$)/, `-r${i}`);
        if (id !== record.jobId && RUN_ID_RE.test(id)) siblings.push(id);
      }
    }
    const related = async (id) => { try { return (await deps.fleet.runById(id))?.record ?? null; } catch { return null; } };
    const base = typeof record.recoveryOf === "string" && RUN_ID_RE.test(record.recoveryOf) ? record.recoveryOf : q.id;
    const recoveryIds = record.checkpoints || record.recovered || record.recoverSkipped || String(record.reason ?? "").startsWith("recovery-")
      ? [base, ...Array.from({ length: RECOVERY_CAP }, (_, i) => `${base}.r${i + 1}`)].filter((id) => id !== q.id && RUN_ID_RE.test(id)) : [];
    const [siblingRecords, recoveryRecords, trigger, holds] = await Promise.all([
      Promise.all(siblings.map(related)), Promise.all(recoveryIds.map(related)),
      typeof deps.fleet.runTrigger === "function" ? Promise.resolve().then(() => deps.fleet.runTrigger(record.triggerIndex, record.triggerType)).catch(() => null) : null,
      recoveryIds.length && typeof deps.fleet.runHolds === "function" ? deps.fleet.runHolds(q.id, record).catch(() => null) : null,
    ]);
    data.siblings = siblingRecords.filter(Boolean);
    data.recoveryRuns = [record, ...recoveryRecords.filter(Boolean)].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
    data.trigger = trigger;
    data.runHolds = holds;
    const continuation = data.queueState?.activeJobId ?? data.queueState?.queuedJobId;
    if (continuation && continuation !== q.id && RUN_ID_RE.test(continuation)) {
      try { data.recoveryLive = await deps.fleet.runLiveFacts?.(continuation, lookup) ?? null; } catch { data.recoveryLive = null; }
      try { data.recoveryProgress = await deps.fleet.progressOfRun?.(continuation, recoveryRecords.find((r) => r?.jobId === continuation) ?? null) ?? null; } catch { data.recoveryProgress = null; }
    }
    if (refusedBeforeStart(record)) {
      try { data.snapshot = await deps.fleet.snapshot(); } catch { data.snapshot = null; }
      try { data.runsWindow = await deps.fleet.runsWindow?.() ?? null; } catch { data.runsWindow = null; }
    }
  }
  if (reads.includes("insights")) {
    const fullPaths = q.paths === "full" && who?.role === "operator";
    try {
      data.insights = await deps.insights(q.range ?? INSIGHTS_DEFAULT_RANGE, { fullPaths, project: q.project ?? null, role: who?.role ?? "viewer", view: name === "insights" ? "spend" : name.slice("insights-".length) });
    } catch {
      data.insights = null;
      data.insightsError = "The spend history could not be assembled. The console's log has the reason.";
    }
    try {
      const models = typeof deps.pricedModels === "function" ? deps.pricedModels() : [];
      data.pricedModels = Array.isArray(models) ? models : [];
    } catch {
      data.pricedModels = [];
    }
    if (typeof q.whatif === "string") {
      if (typeof deps.whatIf !== "function") data.whatIf = { model: q.whatif, flow: q.flow, unreachable: "the what-if reader is not wired" };
      else {
        try {
          data.whatIf = await deps.whatIf({ model: q.whatif, flow: q.flow ?? null, range: q.range, project: q.project ?? null, runs: q.runs ?? "24h" });
        } catch {
          data.whatIf = { model: q.whatif, flow: q.flow, unreachable: "the what-if estimate failed" };
        }
      }
    }
  }
  if (reads.includes("audit")) {
    try {
      data.audit = await readAuditView({ read: (a) => deps.audit({ ...a, positions: true }), verify: deps.auditVerify, query: q, perPage: AUDIT_PER_PAGE });
    } catch {
      data.audit = null;
    }
  }
  if (reads.includes("parkedChecks") && data.snapshot && formsDrawn(who)) {
    // Issue #737: whether each parked run that could take an answer can take one here, the planner's own check
    // (`parkedAnswerCheckOf`, reused per run for PARK_CHECK_CACHE_MS, an unreadable answer as long as a good one), for
    // the rows `parkedCheckRows` names. Not for a load no form is drawn from (a viewer's, a read-only console's): the
    // panel draws a form for an operator on a console that takes changes alone.
    const rows = parkedCheckRows(data.snapshot);
    const isoOf = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
    const got = await Promise.all(rows.map((p) => parkedAnswerCheckOf(deps.fleet, p.jobId, { jobId: p.jobId, endedAt: isoOf(p.parkedAt), target: p.target }, { now: () => now, lookup })));
    data.parkedChecks = Object.fromEntries(rows.map((p, i) => [p.jobId, got[i]]));
  }
  if (reads.includes("parkedCount")) data.parkedCount = await parkedCountOf(deps);
  return who?.role === "agent" ? { ...agentReadProjection(data), ...(name === "setup" ? { setup: setupFacts(data.setup, { role: "agent" }) } : {}), ...(name === "models" ? { models: modelsForAgent(data.models) } : {}), ...(name === "connections" ? { connections: null, subscriptionAuth: subscriptionAuthForAgent(data.connections?.subscriptionAuth) } : {}) } : data;
}

// ---- drawing ---------------------------------------------------------------------------------------------------------

/**
 * What a panel renderer is handed. `pages` is `PAGES` (issue #737), the table a panel links by name (`kit.mjs`
 * `pageHref`), handed down because a panel module cannot import this one, which imports it. The session is reduced to
 * its role: no panel is handed the token's name.
 */
function viewOf(name, ctx) {
  const data = ctx?.data ?? {};
  return { page: name, data, role: ctx?.session?.role ?? null, name: ctx?.session?.name ?? null, readOnly: Boolean(ctx?.readOnly), locale: ctx?.locale ?? "en", query: ctx?.query ?? {}, env: data.env ?? {}, now: data.now, pages: PAGES };
}

/** The viewer card's fixed visible panels. The other ids remain empty for live state swaps. */
export const RUN_VIEWER_PANELS = Object.freeze(["p-viewer", "p-outcome", "p-progress", "p-transcript", "p-inbox", "p-run"]);

/**
 * The run page's panels for a record a NEWER pi-dispatch wrote (issue #761), for both roles: the outcome banner and the
 * run's stable core, nothing else. Every other panel reads fields past that core (progress, the
 * money), whose meaning that release may have changed, and the record reaches this page cut to its core, so they would
 * say what the record does not ("no session", "not armed"). The other ids stay empty for live state swaps.
 */
export const RUN_NEWER_PANELS = Object.freeze(["p-viewer", "p-outcome", "p-run"]);

/** Each panel of screen `name` as `{ id, fragment }`, with the role split enforced before rendering. */
function panelFragments(name, ctx) {
  const view = viewOf(name, ctx);
  const newer = name === "run" && fromNewerRelease(ctx?.data?.run?.record);
  const hidden = (id) => name === "run" && ((view.role !== "operator" && !RUN_VIEWER_PANELS.includes(id)) || (newer && !RUN_NEWER_PANELS.includes(id)));
  return PAGE_PANELS[name].filter(([id]) => !(name === "host" && ctx?.data?.live === true && id === "p-hostcap")).map(([id, render]) => ({ id, fragment: hidden(id) ? html`` : render(view) }));
}

/**
 * The panels of screen `name`, `[{ id, html }]`: the inner HTML of each `<section id="<id>" data-panel>` that
 * `renderPage` draws, from the same renderers, for the live stream to swap in, and on a live screen last the shell's
 * spans: `<span id="p-nav-parked" data-panel>`, then the screen's headline `<span id="p-headline" data-panel>` where it
 * has one (`panelIds`' order). `ctx` is `renderPage`'s.
 */
export async function pagePanels(name, ctx) {
  if (!Object.hasOwn(PAGES, name)) throw new RangeError(`no such page: ${String(name)}`);
  const panels = panelFragments(name, ctx).map(({ id, fragment }) => ({ id, html: String(fragment ?? "") }));
  if (!PAGES[name].live) return panels;
  const headline = headlineOf(name, ctx);
  return [...panels, { id: NAV_PARKED_ID, html: String(navParkedHtml(ctx?.data)) }, ...(headline === null ? [] : [{ id: HEADLINE_ID, html: String(headline) }])];
}

/** Screen `name`'s headline (`PAGE_HEADLINES`), or null for a screen with none. */
function headlineOf(name, ctx) {
  return Object.hasOwn(PAGE_HEADLINES, name) ? PAGE_HEADLINES[name](viewOf(name, ctx)) : null;
}

/** A layout's markup (`PAGE_LAYOUT`): its wrappers in order, each panel's section where the layout names it. */
function layoutHtml(items, sections) {
  return html`${items.map((it) => (typeof it === "string" ? sections.get(it) : html`<div class="${it.cls}"${it.slotAfter ? html` data-slot-after` : null}>${layoutHtml(it.items, sections)}</div>`))}`;
}

/**
 * What each place a run is kept answered of a run page's id (issue #737), as `runPlaces` and `runAbsent` take them: the
 * history (this host's file and the fleet's run mirror), the queue lookup's whole answer
 * (the job, or its run's active or queued recovery, over every queue the kill switch flips), the live transcript and the
 * progress key. A load whose primary read failed (`readFailed`) and holds no record could not read one, whatever else
 * `run` says.
 */
function runPlacesOf(data) {
  const run = data?.readFailed === true && !data?.run?.record ? { unreadable: RUN_RECORD_UNREAD } : data?.run;
  return { run, lookup: data?.queueState, transcript: data?.transcript, progress: data?.progress };
}

/**
 * The whole page for screen `name`: `{ status, html }`. `ctx = { query, session: { name, role }, data, readOnly,
 * theme }`, `theme` the request's theme choice (`theme.mjs` `themeOf`). Status 200, but: for a run id no place shows a
 * run for, with every place read and saying it holds none (`runAbsent`), the run-not-found page, 404; for one no place
 * shows a run for while a place could not be read, the run page, 503, its outcome banner saying which could not be read;
 * and 403 for the audit log asked by a viewer (the route table refuses that first; this is the belt, and it draws no
 * panel). A run page some place shows a run for is 200, a queued job's included.
 */
export async function renderPage(name, ctx) {
  if (!Object.hasOwn(PAGES, name)) throw new RangeError(`no such page: ${String(name)}`);
  const meta = PAGES[name];
  const role = ctx?.session?.role ?? null;
  const live = meta.live ? name : null;
  const query = pageQueryString(name, ctx?.query);
  const theme = ctx?.theme ?? null;
  if (meta.auth === "operator" && role !== "operator") {
    const body = shellHtml(name, ctx, forbiddenContent(ctx?.locale), { title: uiText(meta.title, ctx?.locale) });
    return { status: 403, html: page({ title: `pi-dispatch console: ${uiText(meta.title, ctx?.locale)}`, name, body, theme, locale: ctx?.locale }) };
  }
  const places = name === "run" ? runPlacesOf(ctx?.data) : null;
  if (places !== null && runAbsent(places)) {
    return errorPage({ kind: "no-run", status: 404, session: ctx?.session ?? null, readOnly: Boolean(ctx?.readOnly), theme, locale: ctx?.locale, runId: typeof ctx?.query?.id === "string" ? ctx.query.id : null });
  }
  if (name === "project" && ctx?.data?.projectView?.state === "missing") {
    return errorPage({ kind: "no-project", status: 404, session: ctx?.session ?? null, readOnly: Boolean(ctx?.readOnly), theme, locale: ctx?.locale });
  }
  const panels = panelFragments(name, ctx);
  // The run detail's live transcript (issue #643) is a section of its own, never a panel: a panel is what the hub
  // renders and swaps, and the transcript's entries are appended by the browser from the operator's own stream.
  // Issue #710: none for a run that never had one to show: refused before it started, or no record of a run that is not
  // running (not a run id, queued, or unknown), which the outcome banner says once.
  // Issue #761: none for a record a newer pi-dispatch wrote either, whose page shows its stable core alone.
  const extra = name === "run" && !ctx?.data?.run?.invalid && !fromNewerRelease(ctx?.data?.run?.record) ? html`<div id="transcript" class="run-transcript">${runTranscriptSection(viewOf(name, ctx))}</div>` : null;
  const sections = new Map(panels.map(({ id, fragment }) => [id, html`<section id="${id}" data-panel>${fragment}</section>`]));
  if (name === "run" && extra !== null) sections.set("p-transcript", html`${sections.get("p-transcript")}${extra}`);
  const inner = Object.hasOwn(PAGE_LAYOUT, name) ? layoutHtml(name === "zero-touch" ? zeroTouchLayout(role) : PAGE_LAYOUT[name], sections) : html`${[...sections.values()]}`;
  const headline = headlineOf(name, ctx);
  const triggerListOptions = name === "triggers" ? { description: triggersDescription(viewOf(name, ctx)), end: role === "operator" && !ctx?.readOnly ? html`<a class="btn btn--primary" href="${PAGES["trigger-add"].path}">${uiText("Add a trigger", ctx?.locale)}</a>` : null } : name === "trigger-check" ? { description: "Describe a hypothetical event. Nothing is sent or spent.", end: html`<a class="btn" href="${PAGES.triggers.path}">${uiText("Back to Triggers", ctx?.locale)}</a>` } : null;
  const configOptions = name === "connections" ? { description: connectionsDescription(ctx?.locale) } : name === "updates" ? { description: updatesDescription(ctx?.locale) } : name === "project" ? { title: projectTitle(ctx?.data?.projectView, ctx?.locale), description: projectDescription(ctx?.data?.projectView, ctx?.locale), end: html`<a class="btn" href="${`/runs?project=${encodeURIComponent(ctx?.query?.id ?? "")}`}">${uiText("Open in Runs", ctx?.locale)}</a>` } : null;
  const titleOptions = configOptions ?? triggerListOptions ?? (name === "setup" ? { description: SETUP_DESCRIPTION } : name === "models" ? { description: "Which model each role runs, its fallbacks and cooldowns. Every role change is reviewed; this page starts no run." } : name === "config" ? { description: configDescription(viewOf(name, ctx)) } : name === "trigger" ? { title: triggerTitle(viewOf(name, ctx)), end: html`<a class="btn" href="${`/runs?trigger=${encodeURIComponent(String(ctx?.data?.triggerDetail?.trigger?.type === "cron" ? ctx.data.triggerDetail.trigger.id : ctx?.query?.index))}`}">${uiText("Open in Runs", ctx?.locale)}</a>` } : name === "fleet" ? { description: "Queues, hosts and their health. Every pause, cancel and removal previews first." } : {});
  const body = shellHtml(name, ctx, html`${["runs", "zero-touch"].includes(name) ? zeroTouchTabs(viewOf(name, ctx)) : name.startsWith("insights") ? spendTabs(viewOf(name, ctx)) : null}${ctx?.query?.becauseRun ? html`<p class="note">${uiText("Configuration fix started from", ctx?.locale)} <a href="${`/run?id=${encodeURIComponent(ctx.query.becauseRun)}`}">${ctx.query.becauseRun}</a>. ${uiText("Confirmed changes on this page will be linked to that refusal.", ctx?.locale)}</p>` : null}${inner}`, { ...titleOptions, ...(name === "zero-touch" ? { description: "How often a run needed a person, per project and repository. The goal is zero.", end: zeroTouchControls(viewOf(name, ctx)) } : {}), ...(name.startsWith("insights") ? { description: spendDescription(name, viewOf(name, ctx).locale), end: spendControls(viewOf(name, ctx)) } : {}), ...(headline === null ? {} : { headline }) });
  // A run no place shows while one could not be read is a run page that cannot say whether the run exists: 503.
  const status = name === "project" && ctx?.data?.projectView?.state !== "ready" || places !== null && !runPlaces(places).shown ? 503 : 200;
  return { status, html: page({ title: `pi-dispatch console: ${["host"].includes(name) ? ctx?.query?.name ?? uiText(meta.title, ctx?.locale) : uiText(meta.title, ctx?.locale)}`, name, body, live, query, theme, locale: ctx?.locale, becauseRun: ctx?.query?.becauseRun ?? null }) };
}
