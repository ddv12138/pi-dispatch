import test from "node:test";
import assert from "node:assert/strict";
import { localeOf, uiText } from "../src/console/locale.mjs";
import { html, page } from "../src/console/html.mjs";
import { liveNoteHtml } from "../src/console/shell.mjs";

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
