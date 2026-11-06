<p align="center">
  <img src="https://raw.githubusercontent.com/edgehero/pi-dispatch/main/docs/images/banner.png?v=2026-11-03" alt="pi-dispatch: hand software work to an AI coding agent, and decide how closely you watch it" width="880">
</p>

# pi-dispatch: hand software work to an AI coding agent, and decide how closely you watch it

[pi](https://github.com/earendil-works/pi) is an open source coding agent that you normally run in a terminal. pi-dispatch runs it for you
in the background: on a schedule, on your repo's issues and pull requests, or from the command line. Each job happens in a sealed box that is
thrown away afterwards, stops at the spending limit you set, and shows up live on one web page. You start in the loop, watching it work. You
move to near the loop, where it asks when it needs you, and to out of the loop, where you review what comes back. pi-dispatch never merges
anything, so what ships stays a person's decision. It runs on a provider key or a subscription you already have, falls back to other models you
list, and brings your own pi setup and extensions along with `pi-dispatch import-pi`. The [main README](https://github.com/edgehero/pi-dispatch#readme)
explains all of it.

<p align="center">
  <img src="https://raw.githubusercontent.com/edgehero/pi-dispatch/main/docs/images/console/console-overview.png?v=2026-11-03" alt="The web console's overview page: what needs you, what is waiting and why, what is running, what today has cost, and a timeline of every project's runs" width="820">
</p>

> This npm package, **`@edgehero/pi-dispatch-admin`**, holds the way to work with a deployment: the **web console**
> (`pi-dispatch-console`, above). The service itself is
> [`@edgehero/pi-dispatch`](https://www.npmjs.com/package/@edgehero/pi-dispatch) (worker and CLI) and
> [`@edgehero/pi-dispatch-receiver`](https://www.npmjs.com/package/@edgehero/pi-dispatch-receiver) (the webhook edge). The
> [main repo](https://github.com/edgehero/pi-dispatch) has the job image, the docs (Docker, Podman, egress, every forge) and SECURITY.md.

## How it works

Every trigger produces the same job, through the same path: one queue, one container, one budget.

```
   CLI · cron · label / comment / PR on GitHub, GitLab, Forgejo or Azure DevOps
                │  enqueue
                ▼
        Valkey + BullMQ            durable queue: survives reboots, absorbs bursts
                │
                ▼
     under the day, week and       if not: refused here, before any spend
     month caps (jobs, tokens,
     dollars), the scoped limits,
     the project's share of the
     envelope and the turn budget?
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
daemon. That is why an image has to meet the checklist in
[`docs/job-image.md`](https://github.com/edgehero/pi-dispatch/blob/main/docs/job-image.md). What each
container runtime guarantees is declared in
[`docs/backends.md`](https://github.com/edgehero/pi-dispatch/blob/main/docs/backends.md), and
`pi-dispatch doctor --live` reads it back from real containers.

**Where it runs.** On any Linux server or VM you control, or your own Mac or Windows machine with Docker
Desktop: the worker is a long running process beside a container runtime on the same host. Serverless
platforms, hosted sandbox services and a container daemon on another machine are not supported. pi-dispatch
itself needs no AI key; the provider key is for pi inside each job. The details are in the
[main README](https://github.com/edgehero/pi-dispatch#where-it-can-run).

Spend is checked before a container starts, so a runaway or a junk trigger costs a refusal, not a bill.
The job image ships Playwright and Chromium, so a flow can build a frontend, screenshot it and iterate.

**What the agent can see.** Two credentials go into each job as environment values, the provider key and
the forge token, and **the agent can read both**. The guardrails tell it never to print or send them, but
that is prompt text, not enforcement. Set a spend limit at your provider. On GitHub, the default `gh` auth
source forwards **your whole login, full scope and never expiring**, and `pi-dispatch doctor` warns about
it; the GitHub App gives each job a one hour token for one repo instead. Network egress is denied by
default and goes through an allowlist proxy, and the allowed hosts are yours to list
([`docs/egress.md`](https://github.com/edgehero/pi-dispatch/blob/main/docs/egress.md)).

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
matching. The full reference is
[`docs/triggers.md`](https://github.com/edgehero/pi-dispatch/blob/main/docs/triggers.md).

**Flows and workflows.** `run.flow` names a skill committed to the target repo at
`.pi/skills/<flow>/SKILL.md`, read from the **default branch**. The repo owns the prompt, and merging it
is the repo's consent. A skill may call other skills, which is already a workflow. For typed multi-stage
workflows, stage a pi extension such as `@juicesharp/rpiv-workflow` into the deployment. It is pinned to an
exact version, installed on your host (never at job time, since jobs run offline), loaded in every
container and declinable per trigger. Anything you installed with `pi install` is staged automatically at
your host's version.

`run.command` is the second entry point. A trigger may name a registered command that a staged extension
provides (`"command": "wf run nightly"`). The job's whole prompt is that line, handled by the extension
with no model turn in between. It picks which vetted command runs, never what code runs, and it is never
AI triggerable: job chaining refuses a request naming one.

Four things to know before you build on it:

- A trigger names a **flow or a command, never a workflow**. That entry point decides which stages run.
- A job is **not an interactive session**. The container hands pi one prompt and reads the exit line.
- One trigger is **one job, one budget slot and one turn budget**. Ten stages share the same
  `PI_MAX_TURNS` and token budget, and running out ends the job as a policy refusal that is never retried.
- **State survives only on local jobs.** A cron or CLI job has your folder mounted read-write, so state
  persists. A forge job gets a fresh clone that is thrown away with the container
  ([`docs/workflows.md`](https://github.com/edgehero/pi-dispatch/blob/main/docs/workflows.md)).

## The operator console

The same package installs `pi-dispatch-console`, a separate process that serves a live web console for the
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
link, never a token), and `pi-dispatch-console link --name <you> --port <n>` prints the link for an SSH tunnel's local
port. The sign-in page says why a session ended. Every running job's progress shows in its row on the fleet page
and on its run page, and its transcript, redacted, streams live
on its run page for operators. Nothing listens unless you start it. See
[`docs/console.md`](https://github.com/edgehero/pi-dispatch/blob/main/docs/console.md).

- **Triggers, editable live.** Add, edit and delete triggers without a restart, on the Triggers page and a page per
  trigger. Drill-ins show what fires each one, what it runs and who may fire it. A one-shot shows armed or spent. A
  spent entry stays in the list, matches nothing, and is re-armed when you delete its `on.disarmed` mark from the
  file. Triggers that run third party code or a custom image carry a badge. Turning either on or off stays an
  edit to the reviewed `triggers.json`, which no form makes for you.
  A portfolio manager's cron trigger is marked "writes the budget split". The console's editor can turn on
  `progress` (the job gets a `report_progress` tool to name its phases) and `statusComment` (one forge comment
  the worker edits as the run goes, numbers only), and `recover` (a run the worker loses continues from its last
  checkpoint), behind your confirm.
- **MCP servers, read-only.** The Connections page shows each overlay MCP server as the overlay offers it now:
  where it runs, how its tools are reached, the variable names it is handed, and any server the worker refuses,
  with why. No form and no key changes them; they are rewritten by `pi-dispatch import-pi`.
- **Insights, the one analytics page.** `/insights` shows the budget dials, plan verdicts against API rates, daily,
  cumulative and per flow spend charts, five breakdowns (by flow, trigger, model, repo and project), the
  budget split with each project's share, spend and floor and the split's history, how busy each host was
  (jobs only), and the trigger and flow topology with spend on each trigger, plus a what if form that re-prices a
  flow on another model. A plan covered run never shows as $0.00, and an estimate is
  always marked as one ([`docs/insights.md`](https://github.com/edgehero/pi-dispatch/blob/main/docs/insights.md)).

<p align="center">
  <img src="https://raw.githubusercontent.com/edgehero/pi-dispatch/main/docs/images/console/console-spend.png?v=2026-11-03" alt="The Spend page: KPI tiles, budget dials, the budget split, a plan verdict, spend charts, the five breakdowns, how busy each host was, and the topology with spend badges" width="820">
</p>

- **Quiet hours.** Pause windows per folder or repo, timezone aware, edited on the Configuration page. A paused job
  waits, never drops, and costs nothing.
- **Scoped limits.** Job caps per repo, folder or project (day, week, month), refused before any spend, plus a
  ceiling on how many run at once, enforced by making jobs wait. Dollar caps per day, week or month for a
  repo, a folder, a model (`model:<provider>/<id>`) or a project (`project:<id>`). Write a repo with its
  forge (`github:acme/web`) to limit it on that forge only. Local jobs also have a fixed guard with
  no switch: one job per folder at a time (it lives in the worker process, and one worker per container
  daemon is the supported shape), because two agents editing one working tree race each other with no
  gate and no undo.
- **Job sizes.** A project row can set the memory and CPUs of its jobs, and how much of a machine they may hold
  (`hostShare`) or keep room for (`minJobs`). The project page shows each project's measured size, the runs' peaks
  against it and a suggestion, with the exact call behind a **Preview this size** confirm; nothing applies a
  size by itself ([`docs/sizing.md`](https://github.com/edgehero/pi-dispatch/blob/main/docs/sizing.md)).
- **Dollar windows.** With dollar caps set, the Spend page's Caps card shows each window's spend and holds against
  its cap, and what the run records settled ([`docs/costs.md`](https://github.com/edgehero/pi-dispatch/blob/main/docs/costs.md)).
- **Projects.** The project page shows each project with its members and this month's spend, and links to its
  runs. Member edits, adds and deletes go through the console's preview and confirm.
- **Hosts.** The fleet page shows each worker host: how long ago it beat, its slots in use, what its budget has
  promised its jobs, and its running jobs with project, size and age, then how busy it was over the last 7 days (busy
  share, jobs at once, time full, the wait and the top projects). Time before a host's history starts is said and not counted,
  but a host that is new, or was down, inside history that is here reads as idle for that time. `pi-dispatch capacity`
  prints the same report
  ([`docs/multi-host.md`](https://github.com/edgehero/pi-dispatch/blob/main/docs/multi-host.md#what-the-console-and-doctor-show-you)).
  It counts jobs only: a machine busy with other work reads as idle.

- **The budget split.** With an allocation envelope (a dollar total per window and a floor per project), the Spend
  page's budget split shows each project's share and spend, the applied plan with the reasons it gave, and the history.
  Revert on a history row goes back to it after a preview and a confirm. The page's priorities and envelope forms set a
  plan of weights and change the envelope inside the same checks the worker applies
  ([`docs/allocation.md`](https://github.com/edgehero/pi-dispatch/blob/main/docs/allocation.md)).
  A run's detail names the plan a portfolio run wrote and the dollars it settled.

- **The portfolio manager.** A weekly flow you own reads the budget and writes a plan of weights. The
  worker applies it inside the envelope, bounds each move and logs it, so you can revert it
  ([`docs/portfolio-manager.md`](https://github.com/edgehero/pi-dispatch/blob/main/docs/portfolio-manager.md)).
- **Held and failed jobs.** A trigger with `run.waitFor` holds its job in the queue, unstarted and
  unbilled, until a time passes or your check script exits 0. The fleet page shows a **held** section while
  anything waits (the target, the condition and how long), and a **failed** section for jobs the queue
  marked failed after their last attempt, each with its record's reason.

## More than one machine

The console reads the whole deployment, not one host. Its overview names the workers once they have
names, and a run's page names the machine that ran a job. The pause switch stops every queue, and the
schedules view spans hosts. On a single host none of that shows, because there is nothing to tell apart.
The fleet page's Hosts card shows each machine's slots, budget and running jobs now and how busy it was over the last 7
days; `pi-dispatch capacity`, doctor and the insights page read the same capacity report, from
the run records (jobs only: a machine busy with other work reads as idle).
See [`docs/multi-host.md`](https://github.com/edgehero/pi-dispatch/blob/main/docs/multi-host.md).

## Install

```bash
mkdir my-dispatch && cd my-dispatch
npm install --save-exact @edgehero/pi-dispatch@<version> @edgehero/pi-dispatch-admin@<version> @earendil-works/pi-coding-agent@<version> --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund
./node_modules/.bin/pi-dispatch up --console
```

**This is the way to set up pi-dispatch.** `up --console` checks the installed console, the exact pi peer, the
supported user manager, the deployment, the token file and the service paths before changing anything, then runs the
consented pass: the job image, Valkey, the egress proxy, `init` and the console's service. It preserves existing
tokens, or creates an operator hash and discards its durable plaintext, starts only the console service and prints a
one-use `/setup` sign-in link after that console answers. The checklist uses actual heartbeat and doctor evidence,
keeps Starting distinct from Ready, and offers individually previewed and confirmed service actions, a create-only
provider key field and editable first-trigger recipes. [First run](../docs/console.md#first-run) explains the
explicit local host grant, read-only/viewer/agent views, key and invitation privacy, and terminal recovery.

Forge credentials are the one terminal step: `pi-dispatch setup github --webhook-url '<receiver URL>'` creates a
GitHub App in one browser click, or `--no-webhook` for polling. Every step says what it will do, asks first and can
be declined. Nothing is written into your repo, and no credential passes through a dialog. A deployment whose queue
is only down keeps the unreachable banner: setup appears when there is nothing, never over an outage.

**Already have a deployment?** The console finds it with `--deployment <dir>` if you pass it, else the folder a
deployment pointer (`pi-dispatch-deployment.json`) names, else the current folder. It reads its settings from that
deployment's `.env`; a value exported in your shell wins. The switches that grant a capability (`PI_BACKENDS`,
`PI_EGRESS`, `DOCKER_HOST`) are never read from a file.

Run every `pi-dispatch-console` command as the account that runs the deployment, on the deployment's host, and keep
the worker's and the console's packages on the same release: upgrade them together
([`docs/upgrading.md`](https://github.com/edgehero/pi-dispatch/blob/main/docs/upgrading.md)).

## Get the whole thing

### → **https://github.com/edgehero/pi-dispatch**

MIT, self hosted. Read [`SECURITY.md`](https://github.com/edgehero/pi-dispatch/blob/main/SECURITY.md)
before you rely on it: it states plainly what is and is not defended. Short version: the trust model is a
GitHub Action's. Whoever can merge to your default branch can instruct the agent.

## Configuration in the browser

The [operator console](../docs/console.md#configuration-and-trigger-pages) includes a Pulse Configuration
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
