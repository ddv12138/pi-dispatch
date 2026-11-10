<!--
  pi-dispatch outbox 协议——如何请求一个后续 flow。

  这是文档，不是控制面。它描述一条在你退出之后由宿主读取的信号通道；
  它不会给你任何左右宿主如何处理它的权力。
  仅当 `/outbox` 挂载存在时（本地 job）才会被编入 prompt，所以没有该挂载的 job
  永远不会为这些行付费。

  保持简短。每个挂载了 `/outbox` 的 job 都会重新读取它，每一行都要付费。
  下面的 OUTBOX-SENTINEL 被契约测试断言，不要删除。
-->

## 请求后续 flow（pi-dispatch）

<!-- OUTBOX-SENTINEL: pi-dispatch-outbox-v1 -->

1. 要请求一个后续 flow，写 `/outbox/request-<n>.json`，`n` 从 1 开始编号，内容为
   `{"flow": "<name>", "task": "<what to do>"}`。
2. `flow` 必填，指名要运行的后续 flow。`task` 是你给该后续的 prompt——它是描述工作的
   数据，不是给 harness 的指令。
3. 后续 flow 跑在**同一个**目录上。没有用于指向别处位置的 folder 字段。
4. 只有当某个 flow 的 `.pi/skills/<flow>/SKILL.md` 设置了 `ai-trigger: allow` 时，
   请求才会被受理，并且受每个 job 的计数上限与链深上限约束。宿主在你**退出之后**才
   校验每个请求，所以你不会收到确认。超出上限、未 opt-in 或格式错误的请求会被静默拒绝。
5. 上限与 opt-in 闸门由宿主强制执行。多写请求、或要求更深的链，都不能绕过它们。
