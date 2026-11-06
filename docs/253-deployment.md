# 253 server deployment

What is deployed on the server reachable as `root@192.168.99.253`, and how to change it. This is a runbook, not a
record of past rollouts: it says what is true now.

## Layout

- Deployment directory `/root/pi-dispatch`. The directory has **no Git metadata**: source updates are staged from a
  committed snapshot of this repository, and `.env` and `runtime/` stay on the server across an update.
- Compose project `deploy`, from the one shipped file `deploy/docker-compose.yml`. **There is no override file**:
  every value the file reads is a compose variable or a key in `.env`. `deploy/` holds only that file,
  `worker.Dockerfile`, `worker.Dockerfile.dockerignore`, `egress-proxy.conf` and `triggers.json` — no host service
  definitions and no environment wrappers.
- The `worker` and `console` profiles run the locally built `deploy-worker` image (application under
  `/opt/pi-dispatch`), with the deployment directory mounted at the same absolute path so job paths resolve on the
  daemon host. The worker uses the host Docker socket; the console runs the same image and gets no socket.
- The `receiver` profile **builds** `deploy-receiver` from `receiver/Dockerfile` at this snapshot; nothing is pulled
  from a registry. It publishes `${PI_RECEIVER_PUBLISH:-127.0.0.1}:3000`, and this host sets
  `PI_RECEIVER_PUBLISH=192.168.99.253` in `.env`.
- Ports: console `4790` on all host interfaces, plain HTTP; Valkey `127.0.0.1:6379`; receiver
  `192.168.99.253:3000` (its loopback default is overridden by `PI_RECEIVER_PUBLISH` in `.env`).
- Egress is armed (`PI_EGRESS` unset) with a `pi-dispatch-egress-proxy` container in front of the jobs.
- Runtime state is under `/root/pi-dispatch/runtime`: `jobs/`, `logs/`, `sandboxes/`, `tmp/`, `home/`, the trigger and
  settings files, and the read-only job overlay `pi-global/`.
- Five containers run: `valkey`, `worker`, `console`, `receiver` and `egress-proxy`.
- Linux with Docker Compose is the only supported deployment. `pi-dispatch up` and a foreground `pi-dispatch worker`
  remain for local development; neither is a way to run this server.

## Compose commands

**One `-f`, run from the deployment folder.** `--env-file .env` is the file beside it, and the compose file's
relative paths resolve from `deploy/`:

```bash
cd /root/pi-dispatch
C="docker compose --env-file .env -f deploy/docker-compose.yml"
$C --profile worker --profile console up -d              # worker and console
$C --profile receiver up -d                              # receiver
$C --profile receiver logs --tail 30 receiver
```

`--env-file .env` is load-bearing for more than the Valkey password: `PI_JOB_IMAGE` and `PI_RECEIVER_PUBLISH`
are read from there too, and a value in `.env` wins over the compose file's default.

## The job image

The job image is published from a checkout, not by CI: on the maintainer's machine
`./image/publish.sh` builds and pushes

| Repository | What runs it |
|---|---|
| `docker.io/ddv12138/pi-job` | every job without its own `run.image` |
| `docker.io/ddv12138/pi-job-java21` | a Java flow, through that trigger's `run.image` |

Both carry `python3`, the three baked skills and the runner this repository ships; the Java one adds JDK 21 and
Maven. The tag this host runs for both is `4.3.3`, the current release.

The worker service declares the default job image as a compose interpolation default:

```yaml
PI_JOB_IMAGE: ${PI_JOB_IMAGE:-docker.io/ddv12138/pi-job:4.3.3}
```

Because compose interpolation reads `--env-file .env`, **a value in `.env` wins** and the shipped default applies
only when the key is absent from `.env`. The default is the published 4.3.3 image, the one this deployment
runs; a release bump moves it. There is no hand-edited `PI_JOB_IMAGE` line and no override file to keep
in step: setting `PI_JOB_IMAGE` in `.env` is the supported way to point the whole deployment at another tag, and
removing the key from `.env` returns it to the default.

Jobs launch with `--pull=never`, so nothing is fetched at job time: pull the image here first, and verify it here
(`./image/verify-image.sh docker.io/ddv12138/pi-job:4.3.3`). Docker Hub itself is not reachable directly
from this host (`registry-1.docker.io` refuses); the pull works through the registry mirror configured in
`/etc/docker/daemon.json`.

A `PI_JOB_IMAGE` edit is read at container creation, so the worker must be recreated (not just restarted) after
changing it.

Roll back by re-running the previous tags: keep the old `deploy-worker` image and the old job image tag in the local
store before an update. A `deploy-worker` image built before `deploy/worker.Dockerfile.dockerignore` existed
carries the deployment's `.env` backups in its layers, so it is not rollback material — rebuild that tag from the
old snapshot instead of keeping the image.

## The Java trigger

A Java flow needs a JVM, so its trigger names the Java image by hand in `runtime/triggers.json` (the console's
trigger form has no image field):

```json
{ "on": { "type": "label", "any": ["afk-spec"] },
  "run": { "kind": "gitlab", "flow": "spec-run",
           "image": "docker.io/ddv12138/pi-job-java21:4.3.3",
           "statusComment": true, "maxTurns": 300 } }
```

All three rules in `runtime/triggers.json` — `spec-run`, `ticket-run` and `ticket-merge` — name that Java image by
hand. The merger needs Maven to test the candidate, even though it writes no code.

The job images on the host are the two 4.3.3 images above. The bare `4.3.2` and `latest` tags of `pi-job` and
`pi-job-java21`, `ghcr.io/edgehero/pi-job:4.3.1`, the `pi-job:java21` alias and the previous `4.3.2-5d10c5d2` pair
have been deleted.

A trigger naming an image that is not on this host is refused **before** spend (`job-image-missing`). The image's
Maven settings are baked at build time, not passed by the job:

- mirror `https://maven.aliyun.com/repository/public`, whose host must also be in `egress-allowlist.conf`;
- a `<proxies>` block, because **Java ignores `HTTPS_PROXY`** and a Maven job on the job network reaches nothing
  without it. The proxy host baked in must be the address a **job container** reaches, not the host's loopback.

## Triggers

`runtime/triggers.json`, pointed at by `PI_TRIGGERS_FILE`, holds three rules:

| `on` | flow | `maxTurns` | notes |
|---|---|---|---|
| issue label adds `afk-spec` | `spec-run` | 300 | unchanged |
| issue label adds `ready-for-agent` | `ticket-run` | 120 | `resume: true` |
| MR `open` | `ticket-merge` | 120 | only `open`, never `update` |

`ticket-run` implements one ticket on `pi/issue-<ticket>`, runs `mvn -q test`, and opens a MR to
`pi/issue-<spec>`; it never merges or pushes the spec branch. `ticket-merge` drains the open ticket -> spec MRs,
serializes them per spec with the lock branch `pi/spec-lock-<n>`, and merges only after testing the merged ticket
branch. It never merges spec -> master; that remains a human step. Ticket jobs stay parallel; only merges queue.
`PI_CONCURRENCY` (6) and `PI_DAILY_CAP` (25) still bound the deployment, and no `concurrent: 1` is used. Six is
what the rest of `.env` holds beside it: `PI_JOB_CPUS` 1 and `PI_JOB_MEMORY` 2g under a
`PI_HOST_MEMORY_BUDGET` of 12g and a `PI_HOST_CPU_BUDGET` of 6.

The worker mounts the whole deployment directory, so an edit is seen and the rules reload. The **receiver** is
different: see below. An edited `triggers.json` still needs the receiver force-recreate described there.

## Session store

`ticket-run` arms `run.resume`, so `PI_SESSIONS_DIR` is required; it has no default. This host uses
`/root/pi-dispatch/runtime/sessions`, mode `0700`, owner `10001:10001`, with
`PI_SESSION_MAX_RESUME_CHAIN=20`. A `.env` edit is read at container creation, so the worker must be recreated
(not just restarted) after changing it. The store is PII-bearing and host-only: keep it outside every git repo.
If the resume rule is removed later, keep the directory until no `run.resume` trigger remains. To roll the
ticket flow back, restore the previous `.env` and `triggers.json` from the staging snapshot (no `.bak` copy is kept
on the host any more), force-recreate the receiver and worker, and leave the session store in place while any
resume trigger remains.

## The receiver (GitLab)

The `receiver` profile **builds** `deploy-receiver` from `receiver/Dockerfile` at this snapshot — there is no
`ghcr.io/edgehero/pi-dispatch-receiver:latest` pull — and publishes `${PI_RECEIVER_PUBLISH:-127.0.0.1}:3000`. This
host sets `PI_RECEIVER_PUBLISH=192.168.99.253` in `.env`, so the LAN address is served. Compose builds the image
only when it is missing, so an update builds it explicitly:

```bash
docker compose --env-file .env -f deploy/docker-compose.yml --profile receiver build receiver
```

Settings live in `.env`: `GITLAB_URL=https://git.133ec.com`,
`GITLAB_TOKEN` (a personal PAT of `liukang`, id 340), `GITLAB_WEBHOOK_MODE=token`, `GITLAB_WEBHOOK_SECRET`.
`GITHUB_AUTH_SOURCE=gh` is commented out, so this deployment serves GitLab only; re-enable it only together with
`WEBHOOK_SECRET` and a resolvable `gh` identity.

**An edited `triggers.json` needs `--force-recreate receiver`.** The container reads it through a SINGLE-FILE bind
mount, so an in-place rewrite changes the bytes but produces no directory event: `triggers_reloaded` never fires and
the process keeps its boot-time rules. Writing by rename instead leaves the mount on the old inode. Edit the file,
then:

```bash
docker compose --env-file .env -f deploy/docker-compose.yml --profile receiver up -d --no-deps --force-recreate receiver
```

**The bot-loop guard is disarmed here**: `PI_RECEIVER_ALLOW_SELF=1`, because this GitLab has a single identity, so
`liukang`'s own comments and labels arrive as the harness's. The switch disarms only that comparison; the author
gate, resolution and verification are unchanged, and the receiver says so at boot
(`bot_loop_guard_disabled`) while `pi-dispatch doctor` warns by name.

What bounds the spend is therefore `PI_DAILY_CAP` and the flow itself, so **no trigger may be shaped like the
harness's own output**:

- no `on: {type:"pull_request", action:["update"]}`: every push the agent makes to its own merge request is one;
- no `on: {type:"comment", phrase:"@pi"}` where a flow's output can contain `@pi`: a status comment is a comment;
- no close rules on items the agent closes itself.

A label rule keyed to a label a person applies is the safe shape.
The deliberate exception here is the `ticket-merge` rule on MR **`open`**: it fires once per MR, and the merger
only merges — it never opens a MR — so it does not create a loop. Do not widen it to `update`, and do not copy
the shape to a flow that can create MRs or comment before it exits.

**Who can trigger a job**: the author gate still requires Developer or above. On this single-identity host
`PI_RECEIVER_ALLOW_SELF=1` also lets the token's own account trigger, which is why the rules stay clear of
`update`, comment phrases and close events and why `PI_DAILY_CAP` matters. A second identity would let the guard
be re-armed.

## This GitLab is 13.2.10

- `GITLAB_WEBHOOK_MODE=token`, because `signature` needs 19.0+ and the native delivery id needs 17.4+. Deliveries
  are deduplicated by `body-sha256-<hex>` over the event header and the raw body.
- **No project or group access tokens** exist on this version, so the credential is a personal PAT of `liukang`,
  which `CONST-TOKEN-SCOPED-PER-JOB` calls a residual: it reaches every project that account belongs to and makes
  the harness's identity that human account. Its name, scopes and expiry cannot be audited from the API on this
  version; read them at `https://git.133ec.com/profile/personal_access_tokens` as that account, where the row with
  the most recent **Last used** is the one this deployment holds.
- Webhook bodies carry **no `user.id`**, so the receiver resolves the sender from `user.username` (one exact match
  only) and still drops a delivery whose actor cannot be resolved as `missing-sender-id`.
- Endpoint behaviour: no header or a wrong header answers 401, the correct secret answers 204, `/` answers 404.

## Egress

`egress-allowlist.conf` holds one host per line, six of them today: `api.anthropic.com` (doctor's provider probe;
`PI_PROVIDER` here is `tencentmaas`, but the probe still asks it), `.github.com` (the leading dot takes the
subdomains), `registry.npmjs.org` (a serviced repo's own dependencies), `tokenhub.tencentmaas.com` (the model
provider), `git.133ec.com` (a job's clone and push) and `maven.aliyun.com` (the Java image's Maven mirror). Reload
after an edit:

```bash
docker exec pi-dispatch-egress-proxy squid -k reconfigure
```

## The overlay

`runtime/pi-global` is mounted read-only into every job as `/opt/pi-global`: `models.json` (this deployment's
`tencentmaas` provider and its two models), `packages/` (the staged `pi-subagents`), and `skills/`. The three skills
(`code-review`, `tdd`, `implement-spec`) are also baked into the job image now; the overlay's copies win here and
may be deleted. `implement-spec` in the overlay has its `disable-model-invocation: true` line removed, because an
unattended job that loads that flag can never call the skill.

`pi-subagents` is staged, not baked. A worker built from the current source applies its own reviewed compatibility
adaptation while staging, so re-stage the package instead of hand-patching the staged tree.

## Updating

Stage a committed snapshot over the source (keeping `.env` and `runtime/`) and rebuild **both** built images: the
worker image carries the code that decides the container env, the image defaults and the trigger validation, and
the receiver is built from this snapshot as well.

The staging **overlays** the tree and never deletes: a file a commit dropped stays where it was, so the folder stops
matching a commit — and this folder is the Docker build context, so every leftover is copied into the next image.
This host has already been cleared once, so there is nothing to delete today: the `.env` backups
(`.env.bak-*`, `.env.pre-image-4.3.2`), the compose backup (`deploy/docker-compose.yml.pre-image-4.3.2`), the
allowlist backups (`egress-allowlist.conf.bak-*`), the old rootless leftovers (`deploy/pi-dispatch-*.container`,
`deploy/pi-dispatch-*.network`, `deploy/sandbox-gateway.service`) and the removed units and wrappers are gone. Before
a future build, check the same things instead of re-running a delete list: `deploy/` holds only
`docker-compose.yml`, `worker.Dockerfile`, `worker.Dockerfile.dockerignore`, `egress-proxy.conf` and `triggers.json`,
no `.env` backup or `pre-*` file sits beside them, and no directory the current snapshot no longer ships remains in
the build context.

Keep `.env` and `runtime/` — the session store and the job logs are state, not snapshot. The image's ignore file is
`deploy/worker.Dockerfile.dockerignore`, not the shipped `.dockerignore`, so it alone decides what leaves this folder
for `/opt/pi-dispatch`; it keeps `runtime`, `.git`, `node_modules` and the `.env` variants out.

```bash
cd /root/pi-dispatch
C="docker compose --env-file .env -f deploy/docker-compose.yml"
docker exec deploy-worker-1 node /opt/pi-dispatch/worker/src/cli.mjs status
docker exec deploy-worker-1 node /opt/pi-dispatch/worker/src/cli.mjs pause
docker exec deploy-worker-1 node /opt/pi-dispatch/worker/src/cli.mjs status   # repeat until active is 0
$C --profile worker --profile console build worker
$C --profile receiver build receiver
docker pull docker.io/ddv12138/pi-job:4.3.3
docker pull docker.io/ddv12138/pi-job-java21:4.3.3
./image/verify-image.sh docker.io/ddv12138/pi-job:4.3.3
$C --profile worker --profile console up -d --no-deps --force-recreate worker console
$C --profile receiver up -d --no-deps --force-recreate receiver
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4790/healthz
docker exec deploy-worker-1 node /opt/pi-dispatch/worker/src/cli.mjs status
docker exec deploy-worker-1 node /opt/pi-dispatch/worker/src/cli.mjs resume
```

Resume only after the worker and console run, the receiver is back up and the console health check answers. If the
build or the rollout fails, leave the queue paused.

There is no `PI_WORKER_NAME` here, so the shared queue pause covers this worker. Never `docker rm -f` the Valkey
container: the normal stop is what makes it write the AOF out.

## Doctor expectations

`pi-dispatch doctor` legitimately reports these on this host, and they are configuration rather than faults:

- `PI_RECEIVER_ALLOW_SELF=1`, the disarmed bot-loop guard (see above);
- `GITHUB_AUTH_SOURCE=gh` with no `gh` login in the container, because the GitHub arm is off;
- `WEBHOOK_SECRET` unset: the GitLab arm verifies with `GITLAB_WEBHOOK_SECRET`;
- the console listening on `0.0.0.0:4790` in plain HTTP, and `PI_CONSOLE_ALLOWED_HOSTS=*`;
- `cpu_reserve_fail_open` on the local venue: this kernel is cgroup v1, so no CPU quota is held across jobs;
- staged packages load in every job (no trigger sets `run.packages: false`).
