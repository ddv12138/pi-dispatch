import test from "node:test";
import assert from "node:assert/strict";
import { CONSOLE_SCRIPT } from "../src/console/script.mjs";
import { GATEWAY_CONSOLE_SCRIPT } from "../src/console/gateway-console-script.mjs";

test("the browser script translates its client-created shared and live status labels for Chinese pages", () => {
  assert.match(CONSOLE_SCRIPT, /document\.documentElement\.lang === "zh-CN"/);
  assert.match(CONSOLE_SCRIPT, /"Following": "跟随最新内容"/);
  assert.match(CONSOLE_SCRIPT, /"Sign-out not confirmed": "退出状态未确认"/);
  assert.match(CONSOLE_SCRIPT, /"Theme: dark": "主题：深色"/);
  assert.match(CONSOLE_SCRIPT, /uiText\(SIGN_IN_GAVE_UP\[kind\]\)/);
  assert.match(CONSOLE_SCRIPT, /uiText\(st\.word\)/);
  assert.match(CONSOLE_SCRIPT, /uiText\(follows \? "Following"/);
  assert.match(CONSOLE_SCRIPT, /outcome \+ uiText\("\)\."\)/, "the run outcome itself remains a stable value");
});

test("the browser-terminal client localizes its fixed state copy without changing identifiers", () => {
  assert.match(GATEWAY_CONSOLE_SCRIPT, /document\.documentElement\.lang === "zh-CN"/);
  assert.match(GATEWAY_CONSOLE_SCRIPT, /"Verifying this sign-in and sandbox\. Nothing opens until the check succeeds\.": "正在验证此登录状态和沙箱/);
  assert.match(GATEWAY_CONSOLE_SCRIPT, /context\.id \+ \(isChinese \? "，主机："/);
  assert.match(GATEWAY_CONSOLE_SCRIPT, /"intent"/);
});
