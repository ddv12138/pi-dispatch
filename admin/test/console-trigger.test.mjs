import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.mjs";
import { loadPageData, parsePageQuery, renderPage } from "../src/console/pages.mjs";
import { planPauseWindowEdit, planLimitEdit } from "../src/write-plans.mjs";
import { configPauseWindows, configScopedLimits } from "../src/console/panels/config.mjs";
import { triggerRuns, triggerKinds, triggerRun } from "../src/console/panels/trigger.mjs";
const NOW = Date.UTC(2026,9,30,12);
const snap = () => ({ readAt:NOW,triggers:{triggers:[{type:"comment",forge:"github",phrase:"@pi",flow:"fix",instructions:true,task:true}]},triggerInstructions:{0:'Private instructions <script>bad()</script>'},triggerTasks:{0:"Private task text"},runs:[],waiting:{rows:[]},settings:{overlay:{}} });
async function draw(role, readOnly=false) {
 const data=await loadPageData("trigger",{index:0},{fleet:{snapshot:async()=>snap()},now:()=>NOW,triggerEditor:()=>({defaults:{},backends:[],forges:[],flows:[]})},{role,readOnly});
 return String((await renderPage("trigger",{query:{index:0},session:{name:"ops",role},readOnly,data})).html);
}
test("trigger pages keep prompt text private, escape the operator's text, and enforce role/read-only actions",async()=>{
 const operator=await draw("operator"),viewer=await draw("viewer"),ro=await draw("operator",true);
 assert.match(operator,/Private instructions &lt;script&gt;/);assert.match(operator,/Private task text/);
 assert.doesNotMatch(viewer,/Private instructions|Private task text|data-action="trigger-(?:edit|delete|fire)"/);
 assert.doesNotMatch(ro,/data-action="trigger-(?:edit|delete|fire)"/);
 assert.match(operator,/data-action="trigger-edit"/);assert.match(operator,/name="index"\s+value="0"\s+data-type="int"/);assert.match(operator,/row 1/);
 for(const bad of ["","index=-1","index=01","index=1.5","index=9999999","index=0&index=1","index=0&task=private"])assert.ok(parsePageQuery("trigger",bad).refusal,bad);
 assert.deepEqual(parsePageQuery("trigger","index=2").query,{index:2});
 const add=await renderPage("trigger-add",{query:{},session:{name:"view",role:"viewer"},data:{now:NOW}});assert.equal(add.status,403);assert.doesNotMatch(String(add.html),/data-structured="trigger"/);
});
test("trigger add copy uses locale projection while keeping kind and forge values as machine values", async () => {
 const data = { now: NOW, triggerEditor: { defaults: {}, backends: [], forges: ["github"], flows: ["triage"] } };
 const result = await renderPage("trigger-add", { query: {}, session: { name: "ops", role: "operator" }, data, locale: "zh" });
 const doc = String(result.html);
 assert.match(doc, /添加触发器/);
 assert.match(doc, /github/);
 assert.match(doc, /value="label"/);
 assert.match(doc, /添加触发器/);
});
test("trigger run and scheduler copy localize fixed phrases while retaining live counts and state", () => {
 const runs = String(triggerRuns({ locale: "en", data: { triggerDetail: { count24h: 7, cost24hMicros: 1250000, costIncomplete: true, historyIncomplete: true, queued: [] } } }));
 assert.match(runs, /at least 7/); assert.match(runs, /1\.25/); assert.match(runs, /metered portion only/);
 const fire = String(triggerKinds({ locale: "en", query: { index: 0 }, role: "operator", data: { triggerDetail: { trigger: { type: "cron", id: "daily", pattern: "0 2 * * *" }, cron: {} }, triggerFireCheck: { plan: { summary: "Fire this schedule once.", reserve: { cents: 50 } } } } }));
 assert.match(fire, /Fire this schedule once/); assert.match(fire, /Fire now/);
});
test("trigger sandbox and cron health copy translate while preserving host, backend and retention values", () => {
 const run = String(triggerRun({ locale: "zh", role: "viewer", pages: [], data: { triggerDetail: { trigger: { type: "cron", id: "daily", folder: "/srv/project", replicas: 2 }, sandbox: { retentionHours: 36 } }, snapshot: { triggers: { triggers: [{ type: "cron", id: "daily", folder: "/srv/project" }] } } } }));
 assert.match(run, /36/); assert.match(run, /local/); assert.match(run, /run\.folder/);
 const cron = String(triggerKinds({ locale: "zh", query: { index: 0 }, role: "viewer", data: { triggerDetail: { trigger: { type: "cron", id: "daily", pattern: "0 2 * * *", next: NOW + 1000 }, cron: { next: NOW + 1000, overdueMs: 1, stalls: 2, stallLimit: 5 } } } }));
 assert.match(cron, /逾期/); assert.match(cron, /2/); assert.match(cron, /5/);
});
test("row editing preserves undisclosed absolute scope when another field changes",()=>{
 const dir=tempDir("trigger-row-preserve-"); const paths={pauseWindowsPath:join(dir,"windows.json"),scopedLimitsPath:join(dir,"limits.json"),projectsFile:join(dir,"projects.json")};
 const scope="/home/private/service";
 writeFileSync(paths.pauseWindowsPath,JSON.stringify({version:1,windows:[{scope,from:"22:00",to:"06:00",tz:"UTC"}]}));
 writeFileSync(paths.scopedLimitsPath,JSON.stringify({version:1,limits:[{scope,day:3}]}));
 const pause=planPauseWindowEdit({index:0,fields:{from:"23:00"},paths});assert.equal(pause.plan.entry.scope,scope);assert.equal(pause.plan.entry.from,"23:00");
 const limit=planLimitEdit({params:{index:0,day:4},paths,env:{}});assert.equal(limit.plan.entry.scope,scope);assert.equal(limit.plan.entry.day,4);
 const view={role:"operator",data:{snapshot:{pauseWindows:{windows:[{scope,from:"22:00",to:"06:00",tz:"UTC"}]},scopedLimits:{limits:[{scope,day:3}]}}}};
 for(const render of [configPauseWindows,configScopedLimits]){const markup=String(render(view));assert.doesNotMatch(markup,/\/home\/private/);assert.match(markup,/name="index"\s+value="0"/);assert.match(markup,/row 1/);}
});

test("configuration page rules are pasted byte for byte from the published design source", async()=>{
 const { CONFIG_CSS } = await import("../src/console/config-css.mjs");
 const source=readFileSync(new URL("../../design/tools/config_controls.py",import.meta.url),"utf8");
 assert.equal(CONFIG_CSS,/CONFIG_CONTROLS_CSS = """([^]*?)"""/.exec(source)?.[1]);
});
test("unread scheduler health and counters stay unknown and incomplete skew counts remain a lower bound",async()=>{
 const { triggerKinds, triggerChange } = await import("../src/console/panels/trigger.mjs");
 const trigger={type:"cron",index:0,id:"nightly",flow:"tidy",stalls:null};
 const view={query:{index:0},role:"viewer",data:{snapshot:{triggers:{triggers:[trigger]}},triggerDetail:{trigger,cron:{scheduler:null,next:null,overdueMs:null,stalls:null,stallLimit:3},skewed:[{jobId:"gh-1",field:"recover"}],skewIncomplete:true}}};
 const kinds=String(triggerKinds(view)),change=String(triggerChange(view));
 assert.match(kinds,/unknown|unavailable/);assert.doesNotMatch(kinds,/on time|stalls\s+0/);
 assert.match(change,/At least 1 jobs/);assert.match(change,/incomplete/);assert.match(change,/\/run\?id=gh-1/);assert.match(change,/recover/);
});
test("unloaded trigger files show the newest named doctor result and never fabricate empty queue or skew facts",async()=>{
 const { triggerGolden } = await import("./helpers/trigger-goldens.mjs");
 const page=String(await triggerGolden({invalid:true}));
 assert.match(page,/trigger 5: once needs number/);assert.match(page,/build3/);assert.match(page,/2m ago/);
 assert.doesNotMatch(page,/0 jobs in view would be refused|Jobs in line now:\s*none in view/);
 assert.match(page,/could not be read/);assert.match(page,/cannot be checked here/);
});
test("editor refusal examples are the shared planner's exact sentences and the refusal golden marks the actual field",async()=>{
 const { triggerRefusalExamples }=await import("../src/console/panels/trigger.mjs");
 const { TRIGGER_DRAW }=await import("./helpers/trigger-goldens.mjs");
 const examples=triggerRefusalExamples();assert.equal(examples.length,4);assert.ok(examples.every(e=>typeof e.sentence==="string"&&e.sentence.includes(e.field)));
 const page=String(await TRIGGER_DRAW["trigger-editor-refusals.operator"]());
 assert.match(page,/aria-invalid="true" aria-describedby="trigger-turns-error"/);assert.match(page,/id="trigger-turns-error"/);assert.ok(page.includes(examples.find(e=>e.field==="maxTurns").sentence));
});

test("comment detail explains the actual phrase-and-flow override syntax, escaped for either role", async () => {
  const { triggerOn } = await import("../src/console/panels/trigger.mjs");
  for (const role of ["operator", "viewer"]) {
    const trigger = { type: "comment", phrase: "@pi<safe>", flow: "fix", forge: "github" };
    const markup = String(triggerOn({ role, query: { index: 0 }, data: { triggerDetail: { trigger } } }));
    assert.match(markup, /<code>@pi&lt;safe&gt; &lt;flow&gt;<\/code>/);
    assert.match(markup, /another flow named by a trigger in this file/);
    assert.match(markup, /Otherwise this trigger&#39;s default flow runs|Otherwise this trigger's default flow runs/);
    assert.doesNotMatch(markup, /@pi<safe>/);
  }
});
