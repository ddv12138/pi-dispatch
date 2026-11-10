<!--
Launch copy for pi-dispatch. Drafts to copy-paste and post. Every claim here traces to the README /
SECURITY.md / the code — keep it that way when you edit. Be honest about maturity (1.0, solo-maintained,
self-host, read SECURITY.md); overclaiming burns a launch faster than underclaiming.

Repo: https://github.com/edgehero/pi-dispatch
Distribution: container only — clone the repo, copy `.env.example` to `.env`, and run Compose. There is no npm
package and no wrapper script. The BARE name `pi-dispatch` on npm is an unrelated squatted package: never link it;
always link the GitHub repo.
-->

# pi-dispatch — launch kit

## The one-liner

> Run the [pi](https://github.com/earendil-works/pi) coding agent as a service: on demand, on a cron, or on a
> label, comment or PR in GitHub, GitLab, Forgejo or Azure DevOps, in a container you control, with a durable
> queue and spend you can bound at your provider.

## The elevator pitch (3 sentences)

pi is a minimal coding agent with no queue, no concurrency control, no spend limit, and — by its own README —
no permission system. pi-dispatch is exactly that missing operational layer: every job runs in an ephemeral
`--cap-drop=ALL` non-root container (pi's missing permissions, enforced by Docker), spend is bounded
by a per-job turn cap, concurrency and the host's memory/CPU budget (with your provider's spend limit as the backstop), and the same job runs whether you trigger it from the
CLI, a cron schedule, or a label, `@pi` comment or PR event on GitHub, GitLab, Forgejo or Azure DevOps. You
bake your own toolchain into the image (it ships Playwright + Chromium, so a flow can build a frontend,
screenshot it, and iterate on the render), a live web console shows the queue, spend meters,
run history, and triggers, and one insights page prices it all: spend charts, subscription
verdicts against API rates, and the whole trigger/flow topology.

**The install line** (use this everywhere):

```bash
git clone https://github.com/ddv12138/pi-dispatch.git my-dispatch
cd my-dispatch
cp .env.example .env
C="docker compose --env-file .env -f deploy/docker-compose.yml"
$C --profile worker --profile console build
$C --profile worker --profile console up -d
docker exec deploy-worker-1 node /opt/pi-dispatch/admin/src/console/cli.mjs token add --name you --role operator
$C --profile console restart console
```

Fill in `.env` first: the provider key and a fine-grained, repo-scoped `GITHUB_PAT`. The token is made in the worker
container because the console refuses to serve without one; the last line restarts the console. Setup is a checkout and
Compose commands, not a package install. Forge events come from the receiver, its own profile; with no public address,
the receiver's `poll` mode needs none.

---

## Show HN

**Title** (≤ 80 chars):
`Show HN: pi-dispatch – run the pi coding agent as a self-hosted service`

**Body:**
```
pi (github.com/earendil-works/pi) is a minimal coding-agent CLI. It has no job queue, no
concurrency control, no spend limit, and — by its own README — no permission system. I kept
wanting to run it *unattended* — on a cron, on GitHub issues, on my own hardware — and every
one of those gaps is a reason you can't.

pi-dispatch is the operational layer that closes them, and nothing else:

- The container is the boundary. Every job runs in an ephemeral --cap-drop=ALL, non-root,
  no-new-privileges container; the agent's instructions are mounted read-only. That's pi's
  missing permission system, enforced by Docker.
- Spend is bounded: a per-job turn cap, a concurrency limit and the host's memory/CPU budget
  bind every job, and your provider's spend limit is the backstop. Token usage and cost are
  still metered per run.
- One job, many ways in: a cron trigger fired by hand from the worker container, a cron schedule, or a label,
  @pi comment or PR event on GitHub, GitLab, Forgejo or Azure DevOps. Same queue, same box, same bounds.
  Cron is the unattended one. A trigger can also dispatch an overlay workflow extension's slash command
  headlessly (run.command) — third-party multi-stage workflows with no glue code.
- Your image, your tools. Bake a project's toolchain into the Dockerfile; it ships Playwright +
  Chromium so a flow can build a frontend, screenshot it, and iterate on the rendered result.
- A live web console: queue state, day/week/month spend meters, run history
  with per-job token+cost accounting, editable triggers, per-repo "quiet hours" that defer runs
  between certain times, and one insights page: spend charts, subscription
  SAVING/LOSING verdicts against API rates, what-if re-pricing, and the whole trigger/flow
  topology drawn Node-RED style with the spend badged onto the triggers that earned it.

Setup is a checkout and a few Compose commands: clone, copy `.env.example` to `.env`, fill in the provider
key and `GITHUB_PAT`, then bring up the `worker` and `console` profiles. The console's Setup checklist
shows what is ready and what is not. The receiver, for forge events, is its own profile.

I've tried to be honest about the threat model rather than hand-wave it: the whole thing runs
untrusted, adversarial input through an unrestricted agent on purpose, so SECURITY.md states
plainly what is and isn't defended (short version: the trust model is the same as a GitHub
Action — whoever can merge to your default branch can instruct the agent).

It's MIT, solo-maintained, 1.0, self-hosted (needs a Linux host with Docker and Compose, plus a provider key).
Feedback very welcome, especially on the security model.

https://github.com/edgehero/pi-dispatch
```

*Posting tips: post Tue–Thu ~8–10am ET; reply to every comment for the first few hours; don't seed upvotes
(HN detects it). Lead the top comment with the honest threat-model paragraph — it's your credibility.*

---

## pi community (Discord / GitHub Discussions) + showcase submission

<!--
POSTING LOGISTICS, UNVERIFIED. The channels named in this section (a pi Discord, GitHub Discussions on
earendil-works/pi, a showcase directory at pi.dev) trace to nothing in this repository, unlike every
product claim below them. Confirm each channel exists, and that it welcomes a post like this, before using
any of it. The message body itself is traceable copy and can be reused as is.
-->

If those channels exist, they are the warmest, highest-intent audience: start there, before the cold channels.

**Discord / Discussions post:**
```
Built a thing on top of pi some of you might want: pi-dispatch — a harness to run pi as a
*service* (on-demand / cron / a label, comment or PR on GitHub, GitLab, Forgejo or Azure
DevOps) with the operational bits pi deliberately leaves out: a durable Valkey+BullMQ queue,
a container-per-job boundary (--cap-drop=ALL, non-root), and a bound on every job (turn cap,
concurrency, host memory/CPU) with your provider's spend limit as the backstop.

The admin side is a web console in the same container stack: queue, spend meters, run history,
editable triggers, per-repo quiet hours, and an audit log. Every write is previewed, confirmed and
recorded, with an Undo where there is a way back, and a viewer role stays read-only. Newest bits:
insights, one page with the spend charts, subscription SAVING/LOSING verdicts, what-if re-pricing,
and the whole trigger/flow topology — and run.command triggers that dispatch an overlay workflow
extension's slash command headlessly, no glue code.

Repo: https://github.com/edgehero/pi-dispatch — feedback and pokes at the security model welcome.
```

**pi.dev showcase:** there is no package to submit. Distribution is a checkout and Compose commands. If pi
maintains a showcase list (OpenClaw, etc.), open an issue/PR on earendil-works/pi proposing pi-dispatch as an
integration entry, linking the repository.

---

## Distribution

There is no package and no automatic release. The console and the worker run from the same `deploy-worker`
image, built by `deploy/worker.Dockerfile` from this checkout; the receiver gets its own image from
`receiver/Dockerfile`; the job image is built from `image/Dockerfile`. Nothing is published to npm, and no
tag or GitHub release is created for you: an update is a checkout at the version you want, then `build` and
`up` again for the affected profiles.

**The name is not negotiable.** Always link the GitHub repository. The bare `pi-dispatch` on npm is an
unrelated squatted package, and this project publishes nothing of its own there.

---

## X / Twitter thread

*(tag the pi / earendil accounts; attach a web console screenshot)*

```
1/ pi is a great minimal coding agent. But it has no queue, no spend limit, and no permission
system — so you can't really run it *unattended*.

pi-dispatch is the missing operational layer. Run pi as a service: on-demand, on a cron, or on a
label, comment or PR in GitHub, GitLab, Forgejo or Azure DevOps. 🧵

2/ The container is the boundary.
Every job → an ephemeral --cap-drop=ALL, non-root container, instructions mounted read-only.
That's pi's missing permission system, enforced by Docker.

3/ Spend is bounded, not a surprise bill.
A per-job turn cap, concurrency and the host's memory/CPU budget bound every job; your provider's
spend limit is the backstop. Token usage and cost are still metered per run.

4/ Your image, your tools.
Bake the toolchain into the Dockerfile — it ships Playwright + Chromium, so a flow can build a
frontend, screenshot it, and iterate on the render.

5/ A live web console: queue, day/week/month spend meters, run history w/
per-job token+cost, editable triggers, per-repo "quiet hours" — and one insights page: spend
charts, subscription verdicts vs API rates, what-if re-pricing, and the trigger/flow topology
drawn Node-RED style. [image]

6/ MIT, self-hosted, 1.0. Honest about the threat model (SECURITY.md). Built on @earendil pi.
https://github.com/edgehero/pi-dispatch
```

---

## Reddit (r/selfhosted, r/LocalLLaMA)

**Title:** `pi-dispatch: run a coding agent unattended on your own hardware, with bounded spend and container isolation`

**Body:**
```
I wanted to run a coding agent (pi) on a cron and on GitHub issues without (a) it running loose
with my shell's permissions or (b) waking up to a surprise API bill. pi-dispatch is the harness
that makes that safe-ish and boring:

- One ephemeral container per job (--cap-drop=ALL, non-root); the agent can't reach the host
  outside its declared mounts (/job read-only and /workspace always, plus /outbox on local
  jobs, /session when you arm resumable sessions, and a read-only global pi overlay if you
  configure one).
- Spend bounded by a per-job turn cap, concurrency and the host's memory/CPU budget, with your
  provider's spend limit as the backstop.
- Durable queue (Valkey + BullMQ) so a burst or a reboot doesn't drop jobs.
- Bring your own Docker image (Playwright/Chromium included for frontend work).
- A web console for queue/spend/runs/triggers, per-repo scheduled pause windows, and an
  insights page (spend charts, subscription verdicts, the trigger/flow topology).

Self-hosted, MIT, needs a Linux host with Docker and Compose plus a provider key. Threat model is written down
honestly in SECURITY.md (it's the GitHub-Actions trust model: whoever can merge can instruct it).

https://github.com/edgehero/pi-dispatch
```
*r/selfhosted dislikes anything that smells like an ad — keep it first-person, lead with the self-host angle,
and engage in comments.*

---

## Blog post outline (dev.to / personal blog)

Working title: **"Giving a coding agent an off-switch: containers, bounded spend, and quiet hours"**

1. **The gap.** pi (and most agent CLIs) assume a human is watching. No queue, no spend limit, no permission
   system. What breaks when you try to run one unattended.
2. **The container is the boundary.** Why `--cap-drop=ALL` + non-root + ephemeral is the honest answer to "no
   permission system," and why per-*job* (not per-session) isolation matters against mutually-untrusting issue
   authors. (Screenshot: the security section.)
3. **Bounds that bind before the bill.** The per-job turn cap (`PI_MAX_TURNS`), concurrency and the
   host's memory/CPU budget limit what one run can do, and your provider's spend limit is the backstop
   across runs. Token usage is metered per run, not capped.
4. **Quiet hours without dropping work.** The scoped pause-window design: defer a repo's runs with BullMQ's
   `moveToDelayed` *before* it takes a host slot, so a paused job costs nothing and auto-resumes — vs.
   dropping it (which loses a GitHub job that has no re-trigger). Timezone-correct via built-in `Intl`.
5. **An operator console that can act, safely.** Every write — pause the fleet, edit a trigger, change a
   limit — is previewed, confirmed and recorded in one audit log, with an Undo where there is a way back.
   Why a human-approved write beats no control at all, and the honest half: which actions cannot be undone.
   Named tokens per person and a read-only viewer role keep the blast radius small.
6. **One page that explains the bill.** The insights page: why the analytics moved from a self-contained file
   into the operator console (one surface, behind a token, still loading nothing from another origin), how every dollar keeps its class (metered vs estimated vs
   plan-covered — never a lying $0.00), and the trigger/flow topology as the map the spend hangs off.
   (Screenshot: the insights page.)
7. **What I got wrong / what's not defended.** Link SECURITY.md's honest list. Invite scrutiny.

---

## GitHub Release notes (TEMPLATE — written by hand)

<!--
TEMPLATE, NOT the current release. Re-cut it per release against that release's own changes, keeping the
shape (Worker / Console / Docs & safety / the maturity footer) and nothing else. Nothing generates release
notes or tags automatically, and no npm package is published: cut them by hand from the commits since the
last version. The version is the root `package.json` version.
-->

**Title:** `vX.Y.Z — <the main change, in a few words>`

```
The operational layer, filled in.

Worker and queue
- Durable Valkey + BullMQ queue, one container per job, admission checked before any spend.
- Cron, hand-fired and forge triggers from one reviewed triggers.json, read live.

Console
- A web console in its own Compose profile: queue, spend meters, run history with per-job token and
  cost, editable triggers, per-repo quiet hours, an audit log, and an insights page with spend charts,
  subscription verdicts against API rates and the trigger/flow topology.
- Named tokens per person, with operator, viewer and agent roles.

Docs & safety
- Expanded SECURITY.md threat model; the deployment docs kept in step.

Self-hosted, MIT. Linux with Docker and Compose, plus a provider API key. See the README quickstart.
```
