import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { CLIENT_ZH_TEXT, localeOf, uiText } from "../src/console/locale.mjs";
import { html, page } from "../src/console/html.mjs";
import { liveNoteHtml } from "../src/console/shell.mjs";
import { PAGES, renderPage } from "../src/console/pages.mjs";
import { modelRoleForm } from "../src/console/panels/models.mjs";
import { triggerAdd } from "../src/console/panels/trigger.mjs";
import { modelChoiceSentence, providerFailureSentence, providerFailureWords } from "../src/model-words.mjs";
import { doctorByText, doctorCountsText } from "../src/doctor-view.mjs";
import { bundleDeclaredText } from "../src/read-model.mjs";
import { parkedUnreadText } from "../src/console/panels/parked.mjs";

test("console locale cookie accepts only the two supported values", () => {
  assert.equal(localeOf("pd_locale=zh-CN"), "zh");
  assert.equal(localeOf("theme=dark; pd_locale=zh-CN"), "zh");
  assert.equal(localeOf("pd_locale=fr"), "en");
  assert.equal(localeOf("not_pd_locale=zh-CN"), "en");
  assert.equal(localeOf(undefined), "en");
});

test("console locale uses Chinese Accept-Language only when no preference cookie is present", () => {
  assert.equal(localeOf(undefined, "zh-CN,zh;q=0.9,en;q=0.8"), "zh");
  assert.equal(localeOf(undefined, "en-US,en;q=0.9,zh-CN;q=0.8"), "en");
  assert.equal(localeOf(undefined, "zh;q=0,en;q=1"), "en");
  assert.equal(localeOf("pd_locale=en", "zh-CN"), "en");
  assert.equal(localeOf("pd_locale=zh-CN", "en-US"), "zh");
});

test("shared console labels translate in Chinese and unknown page content stays intact", () => {
  assert.equal(uiText("Runs", "zh"), "运行记录");
  assert.equal(uiText("Runs", "en"), "Runs");
  assert.equal(uiText("A page specific sentence", "zh"), "A page specific sentence");
  assert.equal(uiText("You were signed out after 15 minutes without a request", "zh"), "你已因 15 分钟内没有请求而退出登录");
  assert.equal(uiText("You were signed out after 8 hours", "zh"), "你已因会话达到 8 小时上限而退出登录");
  assert.equal(uiText("One-time sign-in link", "zh"), "一次性登录链接");
});

test("every browser-generated fixed message is projected from the shared Chinese catalogue", () => {
  // 39 since the sandbox prune: the gateway attachment and browser-terminal copy and its 19 keys left with the venues.
  assert.ok(Object.keys(CLIENT_ZH_TEXT).length >= 39, "the browser message inventory is explicit and covered");
  for (const [source, translated] of Object.entries(CLIENT_ZH_TEXT)) {
    assert.equal(uiText(source, "zh"), translated, `${source}: browser and server share one translation`);
    assert.notEqual(translated, source, `${source}: fixed browser copy must not fall back to English`);
  }
});

test("the shared catalogue has no duplicate source keys that could silently overwrite a translation", () => {
  const source = readFileSync(new URL("../src/console/locale.mjs", import.meta.url), "utf8");
  const start = source.indexOf("const ZH = Object.freeze({") + "const ZH = Object.freeze({".length;
  const end = source.indexOf("\n});", start);
  const body = source.slice(start, end);
  const segments = [];
  let quote = null;
  let escaped = false;
  let segmentStart = 0;
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
    } else if (char === "\"" || char === "'" || char === "`") quote = char;
    else if (char === ",") { segments.push(body.slice(segmentStart, i)); segmentStart = i + 1; }
  }
  segments.push(body.slice(segmentStart));
  const keys = [];
  for (const segment of segments) {
    const entry = segment.trim();
    if (!entry || entry.startsWith("...")) continue;
    let inQuote = null;
    let slash = false;
    let colon = -1;
    for (let i = 0; i < entry.length; i += 1) {
      const char = entry[i];
      if (inQuote) {
        if (slash) slash = false;
        else if (char === "\\") slash = true;
        else if (char === inQuote) inQuote = null;
      } else if (char === "\"" || char === "'") inQuote = char;
      else if (char === ":") { colon = i; break; }
    }
    if (colon < 0) continue;
    const raw = entry.slice(0, colon).trim();
    const key = raw.startsWith("\"") ? JSON.parse(raw) : raw.startsWith("'") ? raw.slice(1, -1) : raw;
    keys.push(key);
  }
  const duplicates = keys.filter((key, index) => keys.indexOf(key) !== index);
  assert.deepEqual([...new Set(duplicates)], []);
});

test("every literal server-side uiText call has a Chinese catalogue entry", () => {
  const root = new URL("../src/console/", import.meta.url);
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (path.endsWith(".mjs") && !path.endsWith("/locale.mjs")) files.push(path);
    }
  };
  walk(root.pathname);
  files.push(new URL("../src/insights-html.mjs", import.meta.url).pathname, new URL("../src/graph-html.mjs", import.meta.url).pathname);
  const missing = [];
  // HEAD is a Git reference; numeric section markers are language-neutral ordered-list markers.
  const machineCopy = new Set(["HEAD", "1.", "2.", "3.", "4."]);
  const literal = /\buiText\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)\s*,|\btr\(\s*(?:view|v)\s*,\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|\bt\(\s*(?:view|v)\s*,\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|\bt\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)\s*,\s*(?:view|v)\s*\)/gs;
  for (const file of [...new Set(files)]) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(literal)) {
      const raw = match[1] ?? match[2] ?? match[3] ?? match[4];
      if (raw.startsWith("`") && raw.includes("${")) continue;
      const key = raw.startsWith('"')
        ? JSON.parse(raw)
        : raw.slice(1, -1).replace(/\\([\\'"`])/g, "$1");
      if (!machineCopy.has(key) && uiText(key, "zh") === key) {
        const line = source.slice(0, match.index).split("\n").length;
        missing.push(`${relative(new URL("../src/", import.meta.url).pathname, file)}:${line}: ${key}`);
      }
    }
  }
  assert.deepEqual(missing, [], "route fixed copy through uiText and add a Chinese message");
});

test("every registered console screen renders in Chinese with its localized page title", async () => {
  const panelTitles = {
    setup: "准备就绪", models: "模型角色", overview: "需要你", runs: "运行记录",
    "zero-touch": "人工介入率，", run: "实时转录", parked: "回答方式", "answer-rules": "回答规则",
    insights: "今天", "insights-capacity": "主机群忙碌度",
    "insights-breakdown": "窗口支出", "insights-flows": "流程映射", fleet: "主机与队列", host: "主机已离线",
    trigger: "触发条件", triggers: "设置", "trigger-check": "哪些规则会运行？",
    "trigger-add": "添加触发器", config: "设置覆盖项", secrets: "密钥配置", connections: "提供商 API 密钥",
    updates: "作业运行内容", project: "项目不可用", watch: "监控不可用", "watch-board": "面板不可用", audit: "审计日志",
  };
  assert.deepEqual(Object.keys(panelTitles).sort(), Object.keys(PAGES).sort(), "the representative body inventory follows PAGES exactly");
  for (const [name, meta] of Object.entries(PAGES)) {
    const result = await renderPage(name, {
      locale: "zh",
      session: { role: meta.auth === "operator" ? "operator" : "viewer" },
      query: {},
      readOnly: false,
      data: {},
    });
    assert.match(String(result.html), /<html lang="zh-CN"/i, `${name}: document locale`);
    assert.ok(String(result.html).includes(uiText(meta.title, "zh")), `${name}: localized page title`);
    const panels = [...String(result.html).matchAll(/<section[^>]*>([\s\S]*?)<\/section>/g)].map((match) => match[1]).join("");
    assert.ok(panels.includes(panelTitles[name]), `${name}: representative panel body copy`);
  }
});

test("representative Models and Trigger forms localize authored labels while preserving machine values", () => {
  const model = String(modelRoleForm({ scopes: [], roles: [] }, { locale: "zh" }));
  assert.match(model, />范围</);
  assert.match(model, />默认</);
  assert.match(model, /name="scope"/);
  assert.match(model, /value="default"/);

  const trigger = String(triggerAdd({ locale: "zh", role: "operator", readOnly: false, query: {}, data: { snapshot: { triggerEditor: {} } } }));
  assert.match(trigger, /添加触发器/);
  assert.match(trigger, />类型</);
  assert.match(trigger, /name="kind"/);
});


test("dynamic model policy sentences localize fixed wording and preserve runtime identifiers", () => {
  const failure = providerFailureSentence({ kind: "rate-limited" }, "zh");
  assert.equal(failure, "服务提供方对该模型实施了速率限制。");
  assert.equal(providerFailureWords("quota-exhausted", "zh"), "配额已耗尽");
  const choice = modelChoiceSentence({
    provider: "custom-provider", model: "model-x", modelRole: "review", modelWhy: "fallback-cooldown",
  }, "zh");
  assert.equal(choice, "本次运行使用备用模型 custom-provider/model-x（角色 review），原因：主模型仍在冷却期。");
  assert.equal(modelChoiceSentence({ provider: "custom-provider", model: "model-x", modelWhy: "primary" }), "This run used custom-provider/model-x as its primary model.");
});


test("held, doctor, and capacity copy localize fixed wording while retaining live values", () => {
  const held = `${uiText("A job starts when every condition is met. Checks spend nothing. A check profile gives up after", "zh")} 24 ${uiText("hours or", "zh")} 96 ${uiText("checks (wait-expired). A cancelled held job spent nothing while it waited. A check that cannot tell", "zh")} 5 ${uiText("times in a row ends the wait.", "zh")}`;
  assert.match(held, /24 小时或 96/);
  assert.match(held, /5 次无法判断/);

  const doctor = `${uiText(doctorByText({ by: { worker: false, uid: 1824 } }), "zh")}：${uiText(doctorCountsText({ counts: { fail: 2, warn: 3, ok: 41 } }), "zh")}`;
  assert.equal(doctor, "由操作员手动运行（uid 1824）：2 项失败，3 项警告，41 项通过");

  const capacity = `${uiText("jobs at once, on average", "zh")} 1.4；${uiText("the most at once", "zh")} 3；${uiText("slots", "zh")} 4`;
  assert.equal(capacity, "平均并发作业数 1.4；最高并发作业数 3；槽位 4");
});

test("project bundle and parked unread helpers translate fixed clauses and preserve runtime values", () => {
  const bundle = uiText(bundleDeclaredText({ declared: "overlay", rootsSeen: false, format: "json" }), "zh");
  assert.equal(bundle, "已在设置覆盖项，json中声明；面板无法读取 PI_SECRET_RESOLVER_ROOTS；doctor --secrets 会检查其是否可运行");
  const unread = uiText(parkedUnreadText("Valkey timeout 3"), "zh");
  assert.equal(unread, "无法读取待处理运行记录（Valkey timeout 3）；这不表示收件箱为空。");
});

test("HTML document language follows the closed locale", () => {
  const body = html`<main>content</main>`;
  assert.match(String(page({ title: "x", name: "x", body, locale: "zh" })), /<html lang="zh-CN"/);
  assert.match(String(page({ title: "x", name: "x", body, locale: "fr" })), /<html lang="en"/);
});

test("shared live notes render fixed Chinese copy and keep the interpolated stream cap", () => {
  const live = String(liveNoteHtml({ locale: "zh", maxStreams: 6, reload: "/runs" }));
  assert.match(live, /无法连接控制台，正在重试/);
  assert.match(live, /一个令牌最多可连接 6 个实时标签页/);
  assert.doesNotMatch(live, /One token may hold/);
});
