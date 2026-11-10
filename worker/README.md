# pi-dispatch worker

The worker and the `pi-dispatch` command line tool of
**[pi-dispatch](https://github.com/edgehero/pi-dispatch)**, which runs the
[pi](https://github.com/earendil-works/pi) coding agent for you in the background, in a sealed box for each job, up to the spending limit
you set, and shows it all on one web page. Most people want the
[main README](https://github.com/edgehero/pi-dispatch#readme) first: it explains why and how to use it.

The worker takes jobs from a durable queue (Valkey with BullMQ). Before anything is spent it checks every
cap that applies: job counts and a daily token count for the whole deployment, job counts per repo, folder
or project, and dollars per day, week or month for the deployment and per repo, folder, project or model,
plus each project's share of the budget split. It then starts one locked down container per job (Docker or
Podman), holds the job to its own dollar cap when one is set, gives the agent the job, records what it did
and what it cost, and removes the container. Jobs come from cron triggers, from `run --trigger`, or from
forge events that the [receiver](https://github.com/edgehero/pi-dispatch/tree/main/receiver) queues.

## Start

The supported deployment is Linux with Docker Compose, from a checkout of this repository. There is no npm
install and no host wrapper script: the worker, the console and the receiver are containers built from the
checkout beside them.

```bash
git clone https://github.com/ddv12138/pi-dispatch.git my-dispatch && cd my-dispatch
cp .env.example .env                             # then set the provider key and GITHUB_PAT
C="docker compose --env-file .env -f deploy/docker-compose.yml"
$C --profile worker --profile console build
$C --profile worker --profile console up -d
docker exec deploy-worker-1 node /opt/pi-dispatch/admin/src/console/cli.mjs token add --name you --role operator
$C --profile console restart console
```

The console refuses to serve until `runtime/console-tokens.json` holds an operator token, which is why the token is made
from the worker container and the console restarted after it. The CLI runs in the worker container, and the console's own
command runs in the console container:

```bash
docker exec deploy-worker-1 node /opt/pi-dispatch/worker/src/cli.mjs doctor --live
docker exec deploy-worker-1 node /opt/pi-dispatch/worker/src/cli.mjs run --trigger nightly-tidy
docker exec deploy-console-1 node /opt/pi-dispatch/admin/src/console/cli.mjs link --name you
```

On the NVIDIA OpenShell venue (`PI_BACKENDS=openshell` in `.env`), `doctor --openshell` checks its gateway
before a job starts. It never installs OpenShell, and the job image must already be in the gateway's engine.

A local job edits your folder **in place**, and there is no undo, so commit first. The worker refuses a
folder with uncommitted changes. The folder must be the root of a git repository with at least one commit,
and a local trigger refuses any other folder before it queues anything.

## Commands

| Command | Does |
|---|---|
| `init` | write `.env` and the config files into this folder (never overwrites) |
| `doctor [--fix] [--live] [--openshell] [--secrets] [--no-publish]` | check the whole setup; `--live` reads the isolation guarantees back from real containers; each run publishes its checks (paths, URLs and secret values cut out) for the console, unless `--no-publish` |
| `worker` | run jobs from the queue (the worker container's own command) |
| `run --trigger <id>` | fire one cron trigger from the triggers file now, once, as its schedule would |
| `status`, `pause`, `resume`, `cancel <jobId>` | control the running worker from any terminal |
| `steer <jobId> "..."` | send a running job a message, which the agent reads between its steps (`--later` once it would otherwise stop) |
| `capacity` | how busy each host was over the last day, week or thirty days, read from the run records |
| `auth` | manage host owned subscription authentication: `status`, `login`, `logout`, `usage`, `trial` |
| `canary` | replay up to three retained jobs on another model in disposable workspaces, under one experiment cap |
| `updates` | which pi and which extensions jobs run, what is newer, and adopting it |
| `opener install` | register `pi-dispatch-open`, so the console can open a sandbox in your own terminal |
| `sandbox <jobId>` | reopen a finished run's workspace in a fresh container with no credentials; `--list`, `--attach` and `--new` to see, return to or prepare one |
| `egress render` | write `model-endpoints.conf` from `model-endpoints.json`, then print the command that reloads the egress proxy |

The global overlay, when `PI_GLOBAL_PI_DIR` is set, is a directory you populate by hand with `models.json`,
`APPEND_SYSTEM.md`, `skills/`, `extensions/`, `prompts/`, `mcp.json` and an optional `packages/`. It is
mounted read only into each job; file changes take effect on the next job, and changing its path needs the
worker container recreated.

Before you rely on it, read [`SECURITY.md`](https://github.com/edgehero/pi-dispatch/blob/main/SECURITY.md).
In short: the agent can read the provider key and the GitHub PAT inside its container, and the guardrails
that tell it not to leak them are prompt text. One fine-grained, repo-scoped PAT in `GITHUB_PAT` is shared
by every job until you rotate it. pi-dispatch never merges anything, but the token can, so branch protection
on your default branch is the real control.

The full guide, with the console, triggers, providers and every forge, is the
[main README](https://github.com/edgehero/pi-dispatch#readme). MIT licensed.
