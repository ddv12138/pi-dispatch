---
name: ticket-merge
description: Auto-merge only ticket→spec MRs, one MR per job, serialized per spec. Never merges spec→master.
---

# 票 → spec 自动合并

只处理 **ticket → spec** 的 MR。spec → master 永远留给人工；不要合并、不要推送默认分支。

触发方式是 GitLab MR `open`，不是 `update`。本 flow 自己会推票分支、发评论、合并 MR；这些都会产生
`update`，但本部署没有 `update` 规则，所以不会自触发。不要新增标签，不要新增 trigger；只使用
`ready-for-agent`、`agent-vibing`、`needs-info`、`ready-for-human`。

`agent-vibing` 由 `ticket-run` 在领取时加上；本 flow 在合并成功或失败后负责移除它。

## 1. 读取事件并做第一层过滤

```bash
python3 - <<'PY'
import json
d=json.load(open('/job/event.json'))
a=d.get('object_attributes') or {}
print(json.dumps({k:a.get(k) for k in (
  'iid','action','state','source_branch','target_branch',
  'source_project_id','target_project_id','work_in_progress','sha')}, ensure_ascii=False))
PY
```

不满足下面任一条就**正常结束**（exit 0，不评论、不加标签）：

- `action == "open"` 且 `state == "opened"`；
- source 匹配 `^pi/issue-([0-9]+)$`，target 匹配 `^pi/issue-([0-9]+)$`；
- source != target；
- target 不是 `master`/`main`/默认分支；
- `source_project_id == target_project_id`（拒绝 fork MR；fork 可以伪造同名分支）；
- MR 不是 draft / `work_in_progress == false`。

如果事件里没有 project id，读 `/tmp/mr.json` 的 `source_project_id`/`target_project_id` 再比较；仍缺则正常结束。

从 target 取 `SPEC`，从 source 取 `TICKET`。读取 MR 和票：

```bash
glab api "projects/:id/merge_requests/$IID" > /tmp/mr.json
glab api "projects/:id/issues/$TICKET" > /tmp/ticket.json
glab api "projects/:id/issues/$SPEC" > /tmp/spec.json
```

读取的是**当前** MR，不是事件里的旧快照。先看 `state`：

- `merged`：这张 MR 已经被合并（可能是另一个 job、重试，或人工）。只做幂等收尾：票仍 `opened` 就关闭，
  移除残留的 `agent-vibing` 和 `ready-for-agent`；**不要重新合并、不要重新测试、不要执行第 4 节解锁**，
  正常结束。真正合并它的 job 已经负责解锁；如果那个 job 崩了，由人工重新加 `ready-for-agent`。
- `closed` 或其他非 `opened`：这张 MR 不再可合并。票仍 `opened` 就加 `ready-for-human`，移除
  `agent-vibing` 和 `ready-for-agent`；不要合并、不要解锁，正常结束。
- `opened`：继续。

```bash
MR_STATE=$(python3 -c 'import json;print(json.load(open("/tmp/mr.json")).get("state",""))')
case "$MR_STATE" in
  opened) ;;
  merged)
    issue_state=$(glab api "projects/:id/issues/$TICKET" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("state",""))')
    if [ "$issue_state" = "opened" ]; then
      glab api --method PUT "projects/:id/issues/$TICKET" --field state_event=close
    fi
    glab api --method PUT "projects/:id/issues/$TICKET" \
      --field remove_labels='agent-vibing,ready-for-agent'
    exit 0
    ;;
  closed|locked)
    issue_state=$(glab api "projects/:id/issues/$TICKET" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("state",""))')
    if [ "$issue_state" = "opened" ]; then
      glab api --method PUT "projects/:id/issues/$TICKET" --field add_labels='ready-for-human'
    fi
    glab api --method PUT "projects/:id/issues/$TICKET" \
      --field remove_labels='agent-vibing,ready-for-agent'
    exit 0
    ;;
  *)
    echo "unexpected MR state: $MR_STATE"
    exit 0
    ;;
esac
```

票必须是 `opened`；正文必须有 spec 归属，且 `<spec>` 等于 target 的编号。两种写法都认：
`Parent: #<spec>` / `Spec: #<spec>`，或 `## Parent` 小节里的第一个 `#n`。读取 spec issue，spec 必须
是 `opened`，否则正常结束。`Blocked by` 同样两种都认：正文里的 `Blocked by: #<n>, ...`，或
`## Blocked by` 小节里的 `#n` 列表（`None` / `无` 表示无阻塞）。任一 blocker 仍为 `opened`，就不合并。
缺 spec 归属、行为契约（`## 行为契约` 或 `## What to build`）或验收标准时，评论原因并加 `needs-info`，
移除 `ready-for-agent` 和 `agent-vibing`，正常结束；这是数据问题，不是合并失败。

`merge_status == "cannot_be_merged"`：评论冲突，加 `ready-for-human`，移除 `ready-for-agent` 和
`agent-vibing`，正常结束。
`unchecked` 可以继续，让 GitLab 在 merge 时做最终检查；失败再走失败路径。

## 2. 取得 per-spec 锁

同一 spec 的合并必须串行；票实现 job 仍然并行。锁是一个真实分支 `pi/spec-lock-<spec>`，不是自定义
`refs/spec-locks/*`（GitLab 可能拒绝 `refs/heads` 之外的 push）。

```bash
SPEC_BR="pi/issue-$SPEC"
LOCK_BR="pi/spec-lock-$SPEC"
git fetch origin --prune
git config user.name  >/dev/null 2>&1 || git config user.name  "pi-dispatch"
git config user.email >/dev/null 2>&1 || git config user.email "pi-dispatch@localhost"

release_lock() {
  # Delete only the lock this job owns. If another job replaced it (stale takeover),
  # this lease fails and the new holder keeps the lock.
  git push --force-with-lease="refs/heads/$LOCK_BR:$LOCK_SHA" origin \
    ":refs/heads/$LOCK_BR" >/dev/null 2>&1 || true
}
```

取锁：创建**唯一**锁 commit，用 compare-and-swap push；如果两个 job 生成相同的 commit SHA，第二次 push
会是 no-op，两个都会误以为拿到锁。因此 message 里必须带唯一 nonce：

```bash
NONCE="${PI_JOB_ID:-$$}-$(date +%s%N)-$RANDOM"
LOCK_SHA=$(GIT_COMMITTER_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  git commit-tree "$(git rev-parse "origin/$SPEC_BR^{tree}")" \
    -p "$(git rev-parse "origin/$SPEC_BR")" \
    -m "spec lock $SPEC $NONCE")
git push --force-with-lease="refs/heads/$LOCK_BR:" origin \
  "$LOCK_SHA:refs/heads/$LOCK_BR"
```

- 成功：确认 `LOCK_SHA` 已赋值后 `trap release_lock EXIT`，开始处理这一个 event MR。
- 失败且原因是锁已存在：fetch 锁分支，读取它的 commit 时间。
  - 超过 10 分钟：用 lease 删除旧锁（`OLD` 是刚读到的锁 SHA，不能用无 lease 的删除，否则可能删掉
    另一个 job 刚拿到的新锁）：
    `git push --force-with-lease="refs/heads/$LOCK_BR:$OLD" origin ":refs/heads/$LOCK_BR"`，
    然后重试取锁。
  - 未超过：等待 15 秒再试，最多约 20 分钟（6 并发下同一 spec 的 merge job 会排队，给排队留余量）。
    超时则评论 event MR
    “Another merger is active for this spec; leaving this MR for a human.”，加 `ready-for-human`，
    移除 `ready-for-agent` 和 `agent-vibing`，正常结束（exit 0）。不要强推。
    （没有 drain 后，不能再指望“下一张 MR open”来兜底；超时必须把票交给人工。）
- `origin/$SPEC_BR` 不存在（目标 MR 已被删或 spec 分支被删）：正常结束。

锁只保护合并；不要在 `ticket-run` 里取锁。

## 3. 只处理 event MR

拿到锁后，只处理触发本 job 的 MR `$IID`。**不要列出、也不要合并该 spec 下的其他 MR**：每张 MR 都有
自己的 `open` job，会各自排队；一个 job 替别人合并会让“自己的 job 晚到”时重复执行收尾和解锁。

拿到锁后先重新读取一次 MR，确认它仍是 `opened`：

```bash
glab api "projects/:id/merge_requests/$IID" > /tmp/mr.json
MR_STATE=$(python3 -c 'import json;print(json.load(open("/tmp/mr.json")).get("state",""))')
```

如果不是 `opened`，按第 1 节的非 open 收尾处理（`merged` 只关闭票、清标签；`closed` 交人工；
都**不合并、不测试、不解锁**），然后正常结束。释放锁由第 2 节的 trap 负责。

1. `git fetch origin --prune`；重新确认 `origin/$SPEC_BR` 和 `origin/$SRC_BR` 存在。若
   `git log --oneline "origin/$SPEC_BR..origin/$SRC_BR"` 为空，说明没有可合并的提交：评论说明，
   加 `ready-for-human`，移除 `ready-for-agent` 和 `agent-vibing`，正常结束（不要合并空 MR）。
2. `git checkout -B "$SRC_BR" "origin/$SRC_BR"`。
3. `git merge --no-edit "origin/$SPEC_BR"`；冲突则 `git merge --abort`，走第 9 步失败路径。
4. `mvn -q test`；失败则走第 9 步。
5. 再 fetch 一次；如果 spec tip 在测试期间变了，重新 merge + 测试（最多 1 次）。第二次仍然变化就失败，
   不要在一个又变了的 spec tip 上合并。
6. `TESTED=$(git rev-parse HEAD)`；`git push origin "$SRC_BR"`（fast-forward，不要 force）。
7. 合并：

```bash
glab mr merge "$IID" \
  --auto-merge=false --yes --remove-source-branch --sha "$TESTED"
```

`--auto-merge=false` 是关键：该镜像的 `glab` 1.110.0 默认 `--auto-merge=true`，会设置
“pipeline 成功后再合并”，而不是现在合并。`--sha` 保证 GitLab 只合并刚测试过的 commit。

8. 合并成功后，若票仍是 `opened`，关闭它；然后移除 `agent-vibing` 和残留的 `ready-for-agent`：

```bash
state=$(glab api "projects/:id/issues/$TICKET" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("state",""))')
if [ "$state" = "opened" ]; then
  glab api --method PUT "projects/:id/issues/$TICKET" --field state_event=close
fi
glab api --method PUT "projects/:id/issues/$TICKET" \
  --field remove_labels='agent-vibing,ready-for-agent'
```

   然后执行第 4 节，检查这张票解锁了哪些依赖票。**第 4 节只在本 job 真正合并了这张票后执行**；
   第 1 节/本节开头的非 open 收尾不要执行第 4 节，否则会二次触发依赖票。

9. 合并失败（GitLab 拒绝、冲突、pipeline 要求、权限）：不要重试死循环。评论失败的准确原因，加
   `ready-for-human`，移除 `ready-for-agent` 和 `agent-vibing`，保留 MR 打开，正常结束。
   缺票面信息用 `needs-info`，同样移除两者。

## 4. 解锁依赖票

每成功合并并关闭一张票后，立即检查 `Blocked by` 里包含这张票的 open issue。只有它的**全部**
blockers 都已关闭，才重新触发：

- 票仍是 `opened`；
- 票上有 `ready-for-agent`；
- 票上没有 `agent-vibing`（没有正在跑或等合并的 job）；
- 票上没有 `needs-info` / `ready-for-human`（人在处理中就先不动）。

重新触发必须**先移除再加回** `ready-for-agent`：一次 update 里同时 remove/add 同一个标签，GitLab
通常认为标签没有变化，不会发出新的 add 事件。两次调用才能让 `ticket-run` 重新入队。

```bash
CLOSED="$TICKET" python3 - <<'PY'
import json, os, re, subprocess, sys

closed = os.environ.get("CLOSED", "")
if not closed.isdigit():
    sys.exit(0)

def api(path, *flags):
    out = subprocess.check_output(["glab", "api", *flags, path], text=True)
    return json.loads(out) if out.strip() else None

def put(iid, add=None, remove=None):
    args = ["--method", "PUT"]
    if add:
        args += ["--field", f"add_labels={add}"]
    if remove:
        args += ["--field", f"remove_labels={remove}"]
    return api(f"projects/:id/issues/{iid}", *args)

try:
    issues = api("projects/:id/issues?state=opened&per_page=100")
except Exception as error:
    print("unblock scan failed:", error)
    sys.exit(0)

if isinstance(issues, dict):
    issues = [issues]

for issue in issues:
    iid = issue.get("iid")
    description = issue.get("description") or ""
    section = re.search(r"(?ms)^##\s*Blocked by\s*$(.*?)(?=^##\s|\Z)", description)
    body = section.group(1) if section else ""
    if not body:
        m = re.search(r"(?mi)^Blocked by:\s*(.+)$", description)
        body = m.group(1) if m else ""
    if not body or re.match(r"(?i)^\s*(?:[-*]\s*)?(?:none|无|没有)", body.strip()):
        continue
    blockers = [int(n) for n in re.findall(r"#(\d+)", body)]
    if int(closed) not in blockers:
        continue
    labels = issue.get("labels") or []
    if issue.get("state") != "opened" or "agent-vibing" in labels:
        continue
    if "ready-for-agent" not in labels or "needs-info" in labels or "ready-for-human" in labels:
        continue

    still_blocked = False
    for number in blockers:
        try:
            blocker = api(f"projects/:id/issues/{number}")
        except Exception:
            still_blocked = True
            break
        if blocker.get("state") == "opened":
            still_blocked = True
            break
    if still_blocked:
        continue

    # Re-read immediately before changing labels; a job may have claimed it meanwhile.
    fresh = api(f"projects/:id/issues/{iid}")
    fresh_labels = fresh.get("labels") or []
    if "agent-vibing" in fresh_labels or "ready-for-agent" not in fresh_labels:
        continue

    put(iid, remove="ready-for-agent")
    for attempt in range(2):
        try:
            put(iid, add="ready-for-agent")
            print("retriggered", iid)
            break
        except Exception as error:
            if attempt == 1:
                print("retrigger add failed", iid, error)
PY
```

如果扫描或重新触发失败，只记录，不回滚已经完成的合并；下一次合并会再次扫描。

## 5. 失败与边界

- 测试失败/冲突/无法合并：`ready-for-human`，评论失败命令和相关输出，移除 `ready-for-agent` 和 `agent-vibing`，保留 MR，继续。
- 票面缺信息：`needs-info`，评论缺什么，移除 `ready-for-agent` 和 `agent-vibing`，不合并。
- 票已关闭、MR 已关闭/已合并、source 分支已删除：跳过，不评论、不加标签。
- 非票 MR、spec → master MR、fork MR：跳过；绝不 merge 到 master。
- 锁超时：评论 event MR，正常结束；不要删别人的锁，除非已超过 10 分钟。
- 如果 event MR 已被别的 merger 合并：正常结束，不重复关闭；若票仍 open 或依赖票未解锁，按第 4 节补一次。
- 不做 code review，不做 spec 最终合并；这些是人的工作。

## 6. 收尾

- 合并成功后先移除 `agent-vibing`，再执行第 4 节解锁依赖票。
- `trap release_lock EXIT` 必须在成功取锁后设置；正常/失败/超时都释放。
- 如果进程被 kill，锁会残留；下一个 job 在 10 分钟后可以清理。
- 所有评论用 `glab api --method POST .../notes --field body=@/tmp/note.md`；不要用已弃用的 `--message`。
- 不要用 `glab issue view`（GitLab 13.2 会 panic）；用 `glab api projects/:id/issues/<n>`。
- JSON 用 Python 3 解析，不依赖 `jq`；不要打印 token 或其他环境变量。
