/** Same-origin console half only; no terminal library, runtime client, cross-origin fetch or window messaging. */
export const GATEWAY_CONSOLE_SCRIPT = String.raw`
(function () {
  "use strict";
  var root = document.querySelector("[data-sandbox-gateway-mode]");
  if (!root) return;
  var isChinese = document.documentElement && document.documentElement.lang === "zh-CN";
  var ZH = {
    "The launch state could not be read. Restart from Sandboxes.": "无法读取启动状态。请返回沙箱页面重新开始。",
    "Use your own terminal on this screen. No browser attachment was authorized.": "请在此屏幕使用自己的终端。浏览器终端连接未获授权。",
    "This console request is not supported. Restart from Sandboxes.": "此控制台请求不受支持。请返回沙箱页面重新开始。",
    "The original sign-in or gateway could not be checked. Restart from Sandboxes.": "无法验证原始登录状态或网关。请返回沙箱页面重新开始。",
    "The console did not answer in time. No connection is retried; restart from Sandboxes.": "控制台未能及时响应。不会自动重试，请返回沙箱页面重新开始。",
    "This opening could not be authorized. Restart from Sandboxes.": "此终端连接未获授权。请返回沙箱页面重新开始。",
    "The gateway address changed. Restart from Sandboxes.": "网关地址已更改。请返回沙箱页面重新开始。",
    "This launch address is not usable. Restart from Sandboxes.": "此启动地址不可用。请返回沙箱页面重新开始。",
    "This return address is not usable. Restart from Sandboxes.": "此返回地址不可用。请返回沙箱页面重新开始。",
    "This host is not usable. Restart from Sandboxes.": "此主机不可用。请返回沙箱页面重新开始。",
    "Browser terminals need an operator on a writable console. Use the native terminal route.": "浏览器终端需要可写控制台中的操作员权限。请改用本机终端。",
    "Open this terminal? Nothing has been authorized yet.": "要打开此终端吗？目前尚未进行授权。",
    "This opening has no original-tab proof. Restart from Sandboxes.": "此连接缺少原始标签页凭证。请返回沙箱页面重新开始。",
    "This opening expired or belongs to another tab. Restart from Sandboxes.": "此连接已过期或属于其他标签页。请返回沙箱页面重新开始。",
    "Gateway enrollment changed. Restart from Sandboxes.": "网关注册信息已更改。请返回沙箱页面重新开始。",
    "Verify and watch": "验证并查看", "Verify and open terminal": "验证并打开终端",
    "Enter this sign-in's current operator token. The one-use attachment grant lasts 60 seconds.": "请输入当前登录使用的操作员令牌。一次性连接授权有效期为 60 秒。",
    "Verifying this sign-in and sandbox. Nothing opens until the check succeeds.": "正在验证此登录状态和沙箱。验证成功前不会打开任何内容。"
  };
  function uiText(text) { return isChinese && typeof text === "string" ? ZH[text] || text : text; }
  var mode = root.getAttribute("data-sandbox-gateway-mode"), person = null;
  // These controls belong to this one section, not the global frame whose IDs the kit reserves.
  var status = root.querySelector("#gateway-status"), form = root.querySelector("#gateway-step-up");
  var token = root.querySelector("#gateway-token"), submit = root.querySelector("#gateway-authorize");
  var params = new URLSearchParams(location.search), intent = params.get("intent");
  var key = intent ? "sandbox-gateway:" + intent : null;
  function refusal(text) { var error = new Error(text); error.public = true; return error; }
  function safeError(error) { return error && error.public ? error.message : "The launch state could not be read. Restart from Sandboxes."; }
  function say(text) { status.textContent = uiText(text); }
  function wide() { return window.innerWidth > 760; }
  function forget() { if (key) { try { sessionStorage.removeItem(key); } catch (_) {} } }
  function blocked(text) { form.hidden = true; token.value = ""; token.disabled = true; submit.disabled = true; say(text); }
  function phone() { root.querySelector("#gateway-phone").hidden = false; blocked("Use your own terminal on this screen. No browser attachment was authorized."); }
  async function request(path, options) {
    if (!["/api/whoami", "/api/sandbox-gateway/launch", "/api/sandbox-gateway/context", "/api/sandbox-gateway/authorize"].includes(path)) throw refusal("This console request is not supported. Restart from Sandboxes.");
    var controller = new AbortController(), timer = setTimeout(function () { controller.abort(); }, 10000);
    try {
      var response = await fetch(path, Object.assign({ credentials: "same-origin", cache: "no-store", signal: controller.signal }, options));
      var data = await response.json();
      if (!response.ok) throw refusal(data.error || "The original sign-in or gateway could not be checked. Restart from Sandboxes.");
      return data;
    } catch (error) {
      if (controller.signal.aborted) throw refusal("The console did not answer in time. No connection is retried; restart from Sandboxes.");
      throw error;
    } finally { clearTimeout(timer); }
  }
  async function post(path, body) {
    var data = await request("/api/sandbox-gateway/" + path, { method: "POST", headers: { "content-type": "application/json", "x-console-as": person.name + "." + person.role }, body: JSON.stringify(body) });
    if (!data.ok) throw refusal(data.error || "This opening could not be authorized. Restart from Sandboxes.");
    return data;
  }
  function navigate(value, expectedOrigin, fragment) {
    var next = new URL(value);
    if (next.origin !== expectedOrigin || next.username || next.password || (!fragment && next.hash)) throw refusal("The gateway address changed. Restart from Sandboxes.");
    location.replace(next.href);
  }
  async function start() {
    // Same-origin fetch receives a Strict cookie withheld on the cross-site landing GET. Normal login would replace it.
    var allowed = mode === "launch" ? ["host", "id", "kind"] : mode === "authorize" ? ["intent"] : mode === "select" ? ["host"] : ["run"];
    if ([...params.keys()].some(function (name) { return !allowed.includes(name) || params.getAll(name).length !== 1; })) throw refusal("This launch address is not usable. Restart from Sandboxes.");
    if (mode === "return" && params.has("run") && !/^[A-Za-z0-9._:-]{1,200}$/.test(params.get("run"))) throw refusal("This return address is not usable. Restart from Sandboxes.");
    if (["select", "launch"].includes(mode) && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(params.get("host") || "")) throw refusal("This host is not usable. Restart from Sandboxes.");
    if (mode === "launch" && (params.has("kind") && !["drive", "watch"].includes(params.get("kind")) || !/^[A-Za-z0-9._:-]{1,200}$/.test(params.get("id") || ""))) throw refusal("This launch address is not usable. Restart from Sandboxes.");
    person = await request("/api/whoami", {});
    if (mode === "return") { location.replace(params.has("run") ? "/run?" + new URLSearchParams({ id: params.get("run") }) : "/runs/sandboxes"); return; }
    if (person.role !== "operator" || person.readOnly) throw refusal("Browser terminals need an operator on a writable console. Use the native terminal route.");
    if (!wide()) { phone(); return; }
    if (mode === "select") { location.replace("/runs/sandboxes?" + new URLSearchParams({ gatewaySelect: "1", host: params.get("host") })); return; }
    // Check storage BEFORE creating authority; private browsing/storage refusal must leave a truthful fallback.
    sessionStorage.setItem("sandbox-gateway-check", "1"); sessionStorage.removeItem("sandbox-gateway-check");
    if (mode === "launch") {
      // Our own buttons arrive same-origin and go straight on. Anything else (a link on another site, a bookmark) must not
      // spend this sign-in's launch slots or write audit rows without a person asking for it.
      if (root.getAttribute("data-sandbox-gateway-gesture") === "1") {
        say("Open this terminal? Nothing has been authorized yet.");
        await new Promise(function (resolve) {
          var ask = root.querySelector("#gateway-gesture"), go = root.querySelector("#gateway-continue");
          ask.hidden = false; go.focus();
          go.addEventListener("click", function () { ask.hidden = true; resolve(); }, { once: true });
        });
        if (!wide()) { phone(); return; }
      }
      var data = await post("launch", { host: params.get("host"), id: params.get("id"), width: window.innerWidth, ...(params.has("kind") ? { kind: params.get("kind") } : {}) });
      intent = data.intentId; key = "sandbox-gateway:" + intent;
      sessionStorage.setItem(key, JSON.stringify({ proof: data.tabProof, at: Date.now(), gateway: new URL(data.launchUrl).origin }));
      navigate(data.launchUrl, new URL(data.launchUrl).origin, true);
      return;
    }
    if (!intent || !/^[A-Za-z0-9_-]{43}$/.test(intent)) throw refusal("This opening has no original-tab proof. Restart from Sandboxes.");
    var saved = JSON.parse(sessionStorage.getItem(key) || "null");
    if (!saved || !["at,gateway,proof", "at,gateway,proof,receipt"].includes(Object.keys(saved).sort().join()) || !/^[A-Za-z0-9_-]{43}$/.test(saved.proof) || !Number.isSafeInteger(saved.at) || typeof saved.gateway !== "string" || new URL(saved.gateway).origin !== saved.gateway || !/^https?:/.test(saved.gateway) || Date.now() - saved.at >= 300000 || Date.now() < saved.at) { forget(); throw refusal("This opening expired or belongs to another tab. Restart from Sandboxes."); }
    // The gateway hands this to the browser that bound the intent. Kept with the proof so a reload still works, and
    // scrubbed from the address so it is not left where it could be copied.
    var arrived = /^#receipt=([A-Za-z0-9_-]{43})$/.exec(location.hash || "");
    if (arrived) { saved.receipt = arrived[1]; sessionStorage.setItem(key, JSON.stringify(saved)); history.replaceState(null, "", location.pathname + location.search); }
    if (!/^[A-Za-z0-9_-]{43}$/.test(saved.receipt || "")) { forget(); throw refusal("This opening has no original-tab proof. Restart from Sandboxes."); }
    var context = await post("context", { intentId: intent, tabProof: saved.proof, receipt: saved.receipt });
    if (context.gatewayOrigin !== saved.gateway) { forget(); throw refusal("Gateway enrollment changed. Restart from Sandboxes."); }
    root.querySelector("#gateway-target").textContent = context.id + (isChinese ? "，主机：" : " on ") + context.host;
    root.querySelector("#gateway-person").textContent = isChinese
      ? "以 " + context.by + " 身份验证" + (context.kind === "watch" ? "，只读查看 " + context.driverName + " 的终端，通过 " : "，然后通过 ") + context.gatewayOrigin + "。"
      : "Verify as " + context.by + (context.kind === "watch" ? " to watch " + context.driverName + "’s shell, read only, through " : " before attaching through ") + context.gatewayOrigin + ".";
    submit.textContent = uiText(context.kind === "watch" ? "Verify and watch" : "Verify and open terminal");
    root.querySelector("#gateway-details").hidden = false;
    form.hidden = false; token.disabled = false; submit.disabled = false;
    say("Enter this sign-in's current operator token. The one-use attachment grant lasts 60 seconds.");
    token.focus();
    form.addEventListener("submit", async function (event) {
      event.preventDefault();
      if (!wide()) { phone(); return; }
      submit.disabled = true;
      say("Verifying this sign-in and sandbox. Nothing opens until the check succeeds.");
      var value = token.value; token.value = "";
      try {
        var result = await post("authorize", { intentId: intent, tabProof: saved.proof, receipt: saved.receipt, token: value, width: window.innerWidth });
        value = ""; forget(); saved.proof = "";
        navigate(result.returnUrl, saved.gateway, false);
      } catch (error) { value = ""; say(safeError(error)); submit.disabled = false; token.focus(); }
    });
  }
  window.addEventListener("resize", function () { if (!wide() && mode !== "return") phone(); });
  start().catch(function (error) { blocked(safeError(error)); });
})();
`;
