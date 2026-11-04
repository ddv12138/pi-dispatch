import assert from "node:assert/strict";
import { test } from "node:test";
import { configNavigation, configSecretBundles } from "../src/console/panels/config.mjs";
import { actForm, field, table } from "../src/console/panels/config-ui.mjs";
import { PAGES } from "../src/console/pages.mjs";

test("configuration controls and navigation use the selected Chinese labels", () => {
  const input = String(field("key", "Key", { locale: "zh" }));
  const form = String(actForm("setting-set", { label: "Preview the change", locale: "zh" }));
  const nav = String(configNavigation({ locale: "zh", pages: PAGES, data: { snapshot: { settings: { overlay: {} }, triggers: { triggers: [] }, pauseWindows: { windows: [] }, scopedLimits: { limits: [] }, projects: { projects: [] }, overlayMcp: { servers: [] } } } }));
  assert.match(input, />键</);
  assert.match(form, />预览更改</);
  assert.match(nav, /配置|触发器|暂停时段|范围限制|项目|文件/);
});

test("settings tables translate their fixed label and empty state while preserving machine values", () => {
  const markup = String(table("Pause windows", ["Row", "Scope"], [], "No pause window is set.", "zh"));
  assert.match(markup, /未设置暂停时段/);
});

test("the configuration secret-bundle summary localizes its title and copy", () => {
  const markup = String(configSecretBundles({ locale: "zh", data: { snapshot: { secretBundles: { bundles: [] } } } }));
  assert.match(markup, /密钥捆绑/);
});
