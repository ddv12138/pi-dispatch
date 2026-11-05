# 253 server deployment

What is deployed on the server reachable as `root@192.168.99.253`, and how to change it. This is a runbook, not a
record of past rollouts: it says what is true now. For the supported model see
[Linux Compose worker](worker-container.md), [upgrading](upgrading.md) and [job images](job-image.md).

## Layout

- Deployment directory `/root/pi-dispatch`. The directory has **no Git metadata**: source updates are staged from a
  committed snapshot of this repository, and `.env` and `runtime/` stay on the server across an update.
- Compose project `deploy`; the shipped file is `deploy/docker-compose.yml`, plus this host's
  `deploy/docker-compose.override.yml` (the receiver, below).
- The `worker` and `console` profiles run the locally built `deploy-worker` image (application under
  `/opt/pi-dispatch`), with the deployment directory mounted at the same absolute path so job paths resolve on the
  daemon host. The worker uses the host Docker socket.
- Ports: console `4790` on all host interfaces, plain HTTP; Valkey `127.0.0.1:6379`; receiver
  `192.168.99.253:3000` (the shipped file publishes `127.0.0.1:3000`, the override adds the LAN address).
- Egress is armed (`PI_EGRESS` unset) with a `pi-dispatch-egress-proxy` container in front of the jobs.
- Runtime state is under `/root/pi-dispatch/runtime`: `jobs/`, `logs/`, `sandboxes/`, `tmp/`, `home/`, the trigger and
  settings files, and the read-only job overlay `pi-global/`.

## Compose commands

**Both files must be named.** `docker compose -f deploy/docker-compose.yml …` does not pick up
`docker-compose.override.yml` beside it, so:

```bash
cd /root/pi-dispatch
C="docker compose --env-file .env -f deploy/docker-compose.yml -f deploy/docker-compose.override.yml"
$C --profile worker --profile console up -d              # worker and console
$C --profile receiver up -d                              # receiver
$C --profile receiver logs --tail 30 receiver
```

## The job image

The job image is published from a checkout, not by CI: on the maintainer's machine
`./image/publish.sh` builds and pushes

| Repository | What runs it |
|---|---|
| `docker.io/ddv12138/pi-job:<version>` | every job without its own `run.image` |
| `docker.io/ddv12138/pi-job-java21:<version>` | a Java flow, through that trigger's `run.image` |

Both carry `python3`, the three baked skills and the runner this repository ships; the Java one adds JDK 21 and
Maven. What this host runs is `PI_JOB_IMAGE` from `deploy/docker-compose.yml`, which wins over the same key in
`.env` (`environment:` beats `env_file:`). Keep the `.env` line pointing at the same image so nothing reads two
answers.

Jobs launch with `--pull=never`, so nothing is fetched at job time: pull the image here first, and verify it here
(`./image/verify-image.sh docker.io/ddv12138/pi-job:<version>`). Docker Hub itself is not reachable directly from
this host (`registry-1.docker.io` refuses); the pull works through the registry mirror configured in
`/etc/docker/daemon.json`.

Roll back by re-running the previous tag: keep the old `deploy-worker` image tag and the old job image tag in the
local store before an update.

## The Java trigger

A Java flow needs a JVM, so its trigger names the Java image by hand in `runtime/triggers.json` (the console's
trigger form has no image field):

```json
{ "on": { "type": "label", "any": ["afk-spec"] },
  "run": { "kind": "gitlab", "flow": "spec-run",
           "image": "docker.io/ddv12138/pi-job-java21:4.3.2",
           "statusComment": true, "maxTurns": 300 } }
```

A trigger naming an image that is not on this host is refused **before** spend (`job-image-missing`). The image's
Maven settings are baked at build time, not passed by the job:

- mirror `https://maven.aliyun.com/repository/public`, whose host must also be in `egress-allowlist.conf`;
- a `<proxies>` block, because **Java ignores `HTTPS_PROXY`** and a Maven job on the job network reaches nothing
  without it. The proxy host baked in must be the address a **job container** reaches, not the host's loopback.

## Triggers

`runtime/triggers.json`, pointed at by `PI_TRIGGERS_FILE`. It holds one rule: an issue label change that adds
`afk-spec` runs `spec-run`. `maxTurns` on the rule (300) overrides the deployment's `PI_MAX_TURNS` (30), and
`PI_DAILY_CAP` (25) bounds the number of containers a day.

The worker mounts the whole deployment directory, so an edit is seen and the rules reload. The **receiver** is
different: see below.

## The receiver (GitLab)

`deploy/docker-compose.override.yml` builds `deploy-receiver` from `receiver/Dockerfile` at this snapshot instead of
pulling `:latest`, and publishes the LAN address. Settings live in `.env`: `GITLAB_URL=https://git.133ec.com`,
`GITLAB_TOKEN` (a personal PAT of `liukang`, id 340), `GITLAB_WEBHOOK_MODE=token`, `GITLAB_WEBHOOK_SECRET`.
`GITHUB_AUTH_SOURCE=gh` is commented out, so this deployment serves GitLab only; re-enable it only together with
`WEBHOOK_SECRET` and a resolvable `gh` identity.

**An edited `triggers.json` needs `--force-recreate receiver`.** The container reads it through a SINGLE-FILE bind
mount, so an in-place rewrite changes the bytes but produces no directory event: `triggers_reloaded` never fires and
the process keeps its boot-time rules. Writing by rename instead leaves the mount on the old inode. Edit the file,
then:

```bash
$C --profile receiver up -d --no-deps --force-recreate receiver
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

A label rule keyed to a label a person applies is the safe shape ([gitlab.md](gitlab.md), "One identity").

**Who can trigger a job**: not the account the token belongs to (its events are its own). Use a second account with
Developer access on the serviced projects.

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

`egress-allowlist.conf` holds one host per line: `git.133ec.com` (a job's clone and push) and `maven.aliyun.com`
(the Java image's Maven mirror). Reload after an edit:

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

Stage a committed snapshot over the source (keeping `.env` and `runtime/`) and rebuild the worker image, because the
worker code decides the container env, the image defaults and the trigger validation.

```bash
cd /root/pi-dispatch
docker exec deploy-worker-1 node /opt/pi-dispatch/worker/src/cli.mjs status
docker exec deploy-worker-1 node /opt/pi-dispatch/worker/src/cli.mjs pause
docker exec deploy-worker-1 node /opt/pi-dispatch/worker/src/cli.mjs status   # repeat until active is 0
$C --profile worker --profile console build worker
docker pull docker.io/ddv12138/pi-job:<version>
docker pull docker.io/ddv12138/pi-job-java21:<version>
./image/verify-image.sh docker.io/ddv12138/pi-job:<version>
$C --profile worker --profile console up -d --no-deps --force-recreate worker console
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4790/healthz
docker exec deploy-worker-1 node /opt/pi-dispatch/worker/src/cli.mjs status
docker exec deploy-worker-1 node /opt/pi-dispatch/worker/src/cli.mjs resume
```

Resume only after both containers run and the console health check answers. If the build or the rollout fails, leave
the queue paused.

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
