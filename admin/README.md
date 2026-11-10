# pi-dispatch: hand software work to an AI coding agent, and decide how closely you watch it

[pi](https://github.com/earendil-works/pi) is an open source coding agent that you normally run in a terminal. pi-dispatch runs it for you
in the background: on a schedule, on your repo's issues and pull requests, or from the command line. Each job happens in a sealed box that is
thrown away afterwards, stops at the spending limit you set, and shows up live on one web page. You start in the loop, watching it work. You
move to near the loop, where it asks when it needs you, and to out of the loop, where you review what comes back. pi-dispatch never merges
anything, so what ships stays a person's decision. It runs on a provider key or a subscription you already have, falls back to other models you
list, and layers a global pi overlay you populate yourself. The [main README](https://github.com/edgehero/pi-dispatch#readme)
explains all of it.

> This directory holds the way to work with a deployment: the **web console** (`pi-dispatch-console`). It is not an
> npm package. The service itself is the worker and CLI in [`worker/`](../worker/README.md) and the webhook edge in
> [`receiver/`](../receiver/Dockerfile); the [main repo](https://github.com/edgehero/pi-dispatch) has the job image,
> the docs (Docker, Podman, egress, every forge) and SECURITY.md. The console runs from the same `deploy-worker`
> image as the worker, in the Compose `console` profile.

## How it works

Every trigger produces the same job, through the same path: one queue, one container, one set of bounds.

```
   CLI · cron · label / comment / PR on GitHub, GitLab, Forgejo or Azure DevOps
                │  enqueue
                ▼
        Valkey + BullMQ            durable queue: survives reboots, absorbs bursts
                │
                ▼
     admitted?                     if not: refused here, before any spend
     under the turn cap, concurrency,
     scoped limits and pause windows,
     and the host's memory/CPU budget?
                │  yes
                ▼
     one container per job         Docker or Podman, removed after the job: all
                                   capabilities dropped, no-new-privileges,
                                   memory/CPU/pids limits, /job mounted read-only
                │
                ▼
     pi + your .pi/skills          edits your code in place, opens a PR or MR, comments back
```

The container is the boundary, and it is pi's missing permission system. The worker builds the isolation
flags itself, so nothing an image contains can weaken them. The non root user comes from the **image** on
Docker Desktop (and for a worker running as uid 1001), and from the worker's own uid on a native Linux
daemon. That is why an image has to meet a checklist. What each
container runtime guarantees is declared by the venue, and
the `doctor --live` check reads it back from real containers.

**Where it runs.** On any Linux server or VM you control, or your own Mac or Windows machine with Docker
Desktop: the worker is a long running process beside a container runtime on the same host. Serverless
platforms, hosted sandbox services and a container daemon on another machine are not supported. pi-dispatch
itself needs no AI key; the provider key is for pi inside each job. The details are in the
[main README](https://github.com/edgehero/pi-dispatch#where-it-can-run).

Spend is checked before a container starts, so a runaway or a junk trigger costs a refusal, not a bill.
The job image ships Playwright and Chromium, so a flow can build a frontend, screenshot it and iterate.

**What the agent can see.** Two credentials go into each job as environment values, the provider key and
the forge token, and **the agent can read both**. The guardrails tell it never to print or send them, but
that is prompt text, not enforcement. Set a spend limit at your provider. On GitHub, one fine-grained,
repo-scoped PAT in `GITHUB_PAT` is shared by every job until you rotate it: there is no per-job token and
no App to configure. Network egress is denied by default and goes through an allowlist proxy, and the
allowed hosts are yours to list.

## Triggers: what starts a job

Every trigger is one `{ on, run }` entry in a single `triggers.json`. The worker reads it live for cron,
the receiver reads it live for forge webhooks, and the web console can edit it. **`on` is what fires it;
`run` is the skill it runs.**

| `on.type` | Fires on | What the agent gets as its task |
|---|---|---|
| `cron` | your schedule | the `task` written in the file |
| `label` | a label on an **issue** (or an Azure work item), never a pull request | the issue title and body |
| `comment` | a comment containing your phrase, such as `@pi` | the comment, plus the issue title and body |
| `pull_request` | a PR or MR event, including its close | the PR title and body |
| `issue` | an issue closing (`once: true` makes it a one-shot) | the issue title and body |

Four forges: GitHub, GitLab, Forgejo (and Gitea), Azure DevOps. **Who may fire a trigger is your forge's
decision, not this service's.** On GitHub the label *is* the approval, because only collaborators can add
one. GitLab, Forgejo and Azure check the actor's permission through their APIs. A close trigger checks the
person who **closed** the item (Azure has no close trigger yet, and refuses one at load). Each forge's
action words are checked when the file loads, so a word from the wrong forge is refused instead of never
matching.

**Flows and workflows.** `run.flow` names a skill committed to the target repo at
`.pi/skills/<flow>/SKILL.md`, read from the **default branch**. The repo owns the prompt, and merging it
is the repo's consent. A skill may call other skills, which is already a workflow. For typed multi-stage
workflows, put a pi extension such as `@juicesharp/rpiv-workflow` in the global overlay's `packages/`
or `extensions/` directory. It is pinned to an exact version and installed on your host, never at job
time because jobs run offline; it loads in every container, and a trigger can decline the packages.

`run.command` is the second entry point. A trigger may name a registered command that a staged extension
provides (`"command": "wf run nightly"`). The job's whole prompt is that line, handled by the extension
with no model turn in between. It picks which vetted command runs, never what code runs, and it is never
AI triggerable: job chaining refuses a request naming one.

Four things to know before you build on it:

- A trigger names a **flow or a command, never a workflow**. That entry point decides which stages run.
- A job is **not an interactive session**. The container hands pi one prompt and reads the exit line.
- One trigger is **one job, one concurrency slot and one turn cap**. Ten stages share the same
  `PI_MAX_TURNS`, and the run's tokens are metered as one. Running out ends the job as a policy refusal that is never retried.
- **State survives only on local jobs.** A cron or CLI job has your folder mounted read-write, so state
  persists. A forge job gets a fresh clone that is thrown away with the container.

## The operator console

The same container image also provides `pi-dispatch-console`, a separate process that serves a live web console for the
deployment on loopback or on a private unix socket, behind a named token per person. It shows the
whole fleet as it changes: an overview of what needs you, what waits and why, and the last hours as a timeline (on a
deployment that has not run yet, what stands before its first job), every run with filters, one search by
repository, target or job id, the last 24 hours counted by outcome and paging, a card for each run waiting for an
answer, spend and insights by range, queues, hosts and schedules, the configuration and its own audit
log, plus `/api/state` as JSON for scripts. It also has Models (roles, fallbacks and canary comparisons), Updates
(what jobs run and what is newer), Watch (findings from your alerts), Zero touch (how often runs needed a person) and
Setup (a live checklist for a new deployment).
It can act as well as show: cancel, retry, remove and re-run jobs, answer a parked run, pause the fleet or one queue
and edit the configuration, each previewed (with how to undo it), confirmed and recorded in one audit log, and after
each change the page names it, who made it and its audit row, with an Undo
where there is a way back. When `serve` starts it prints how to sign in (the commands that make a token or a one time
link, never a token), and the console command's `link --name <you> --port <n>` prints the link for an SSH tunnel's local
port. The sign-in page says why a session ended. Every running job's progress shows in its row on the fleet page
and on its run page, and its transcript, redacted, streams live
on its run page for operators. Nothing listens unless you start it.

- **Triggers, editable live.** Add, edit and delete triggers without a restart, on the Triggers page and a page per
  trigger. Drill-ins show what fires each one, what it runs and who may fire it. A one-shot shows armed or spent. A
  spent entry stays in the list, matches nothing, and is re-armed when you delete its `on.disarmed` mark from the
  file. Triggers that run third party code or a custom image carry a badge. Turning either on or off stays an
  edit to the reviewed `triggers.json`, which no form makes for you. The console's editor can turn on
  `progress` (the job gets a `report_progress` tool to name its phases) and `statusComment` (one forge comment
  the worker edits as the run goes, numbers only), and `recover` (a run the worker loses continues from its last
  checkpoint), behind your confirm.
- **MCP servers, read-only.** The Connections page shows each overlay MCP server as the overlay offers it now:
  where it runs, how its tools are reached, the variable names it is handed, and any server the worker refuses,
  with why. No form and no key changes them; they are whatever the overlay's `mcp.json` holds.
- **Insights, the one analytics page.** `/insights` shows plan verdicts against API rates, daily, cumulative and
  per flow spend charts, five breakdowns (by flow, trigger, model, repo and project), how busy each host was
  (jobs only), and the trigger and flow topology with spend on each trigger, plus a what if form that re-prices a
  flow on another model. A plan covered run never shows as $0.00, and an estimate is
  always marked as one.

- **Quiet hours.** Pause windows per folder or repo, timezone aware, edited on the Configuration page. A paused job
  waits, never drops, and costs nothing.
- **Scoped limits.** A ceiling on how many jobs of a repo, folder or project run at once, enforced by making
  them wait. Write a repo with its forge (`github:acme/web`) to limit it on that forge only. Local jobs also have a fixed guard with
  no switch: one job per folder at a time (it lives in the worker process, and one worker per container
  daemon is the supported shape), because two agents editing one working tree race each other with no
  gate and no undo.
- **Job sizes.** A project row can set the memory and CPUs of its jobs, and how much of a machine they may hold
  (`hostShare`) or keep room for (`minJobs`). The project page shows each project's measured size, the runs' peaks
  against it and a suggestion, with the exact call behind a **Preview this size** confirm; nothing applies a
  size by itself.
- **Projects.** The project page shows each project with its members and this month's spend, and links to its
  runs. Member edits, adds and deletes go through the console's preview and confirm.
- **Hosts.** The fleet page shows each worker host: how long ago it beat, its slots in use, what its budget has
  promised its jobs, and its running jobs with project, size and age, then how busy it was over the last 7 days (busy
  share, jobs at once, time full, the wait and the top projects). Time before a host's history starts is said and not counted,
  but a host that is new, or was down, inside history that is here reads as idle for that time. The CLI's `capacity`
  command prints the same report.
  It counts jobs only: a machine busy with other work reads as idle.

- **Held and failed jobs.** A trigger with `run.waitFor` holds its job in the queue, unstarted and
  unbilled, until a time passes or your check script exits 0. The fleet page shows a **held** section while
  anything waits (the target, the condition and how long), and a **failed** section for jobs the queue
  marked failed after their last attempt, each with its record's reason.

## More than one machine

The console reads the whole deployment, not one host. Its overview names the workers once they have
names, and a run's page names the machine that ran a job. The pause switch stops every queue, and the
schedules view spans hosts. On a single host none of that shows, because there is nothing to tell apart.
The fleet page's Hosts card shows each machine's slots, budget and running jobs now and how busy it was over the last 7
days; the CLI's `capacity` command, doctor and the insights page read the same capacity report, from
the run records (jobs only: a machine busy with other work reads as idle).

## Install

```bash
git clone https://github.com/ddv12138/pi-dispatch.git my-dispatch && cd my-dispatch
cp .env.example .env
C="docker compose --env-file .env -f deploy/docker-compose.yml"
$C --profile worker --profile console build
$C --profile worker --profile console up -d
docker exec deploy-worker-1 node /opt/pi-dispatch/admin/src/console/cli.mjs token add --name <name> --role operator
$C --profile console restart console
```

**This is the way to set up pi-dispatch.** Deployment is Linux Docker Compose; the `console` profile runs the
console beside the worker and Valkey. The console refuses to serve until `runtime/console-tokens.json` holds an operator
token, which is why the token comes from the worker container before the console restart. Once it answers, a one-use
`/setup` sign-in comes from the console container:

```bash
docker exec deploy-console-1 node /opt/pi-dispatch/admin/src/console/cli.mjs link --name <name>
```

The checklist uses actual heartbeat and doctor evidence,
keeps Starting distinct from Ready, and offers individually previewed and confirmed service actions, a create-only
provider key field and editable first-trigger recipes. First run explains the
explicit local host grant, read-only/viewer/agent views, key and invitation privacy, and terminal recovery.

Forge credentials are one `.env` edit: create a fine-grained, repo-scoped GitHub PAT (contents, issues and pull
requests read and write, plus metadata read) and put it in `GITHUB_PAT`. Every job shares that token until you
rotate it, so changing it means recreating the worker and receiver containers. For webhook deliveries, add a repository webhook
with `WEBHOOK_SECRET`; with no public URL, the receiver's `poll` mode watches `POLL_REPOS`. Nothing is written into
your repo, and no credential passes through a dialog. A deployment whose queue is only down keeps the unreachable
banner: setup appears when there is nothing, never over an outage.

**Already have a deployment?** The console finds it with `--deployment <dir>` if you pass it, else the folder a
deployment pointer (`pi-dispatch-deployment.json`) names, else the current folder. It reads its settings from that
deployment's `.env`; a value exported in your shell wins. The switches that grant a capability (`PI_BACKENDS`,
`PI_EGRESS`, `DOCKER_HOST`) are never read from a file.

Run console commands in the console container. The operator token is the one exception: the worker container creates it
before the console can serve. The worker and the console run the same `deploy-worker` image built from this checkout, so
they are always the same release: rebuild and recreate both together.

## Get the whole thing

### → **https://github.com/edgehero/pi-dispatch**

MIT, self hosted. Read [`SECURITY.md`](https://github.com/edgehero/pi-dispatch/blob/main/SECURITY.md)
before you rely on it: it states plainly what is and is not defended. Short version: the trust model is a
GitHub Action's. Whoever can merge to your default branch can instruct the agent.

## Configuration in the browser

The operator console includes a Pulse Configuration
page, a page per trigger and a structured editor for five trigger kinds. Edit and Delete work from each
row, with a diff, confirmation and Undo. Human row numbers count from 1.
The editor and its JSON fallback keep the `run.secretBundle: false` opt-out a new trigger carries.

The editor also takes `maxTurns` and the four run-option flags. **Fire now** fires a served cron trigger after
the same fresh folder, committed flow, clean tree and hourly checks, previewed and confirmed like every console
write. Viewers see trigger facts and runs without private prompt text or write controls.

The Triggers page groups rules by schedule and forge, with retained history, spend and a timezone-aware
schedule view. Its phone and viewer layouts keep the same facts readable. **Check an event** uses the
receiver filters to explain a hypothetical match without a forge call, queue write or spend. It is a
viewer read, available even on a read-only console; entered permissions remain assumptions and comment
text is neither saved nor logged. Rules and filters still work without JavaScript.
