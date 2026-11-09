# 253 server deployment

What is deployed on the server reachable as `root@192.168.99.253`. The deployment directory is `/root/pi-dispatch`,
with no Git metadata; `.env` and `runtime/` carry the state that stays on the server rather than in the snapshot.

## Layout

- Compose project `deploy`, from the one shipped file `deploy/docker-compose.yml`. There is no override file:
  every value the file reads is a compose variable or a key in `.env`. `deploy/` holds only that file,
  `worker.Dockerfile`, `worker.Dockerfile.dockerignore`, `egress-proxy.conf` and `triggers.json` — no host service
  definitions and no environment wrappers.
- The `worker` and `console` profiles run the locally built `deploy-worker` image (application under
  `/opt/pi-dispatch`), with the deployment directory mounted at the same absolute path, so job paths resolve on the
  daemon host. The worker holds the host Docker socket; the console runs the same image without a socket.
- The `receiver` profile builds `deploy-receiver` from `receiver/Dockerfile` at this snapshot; nothing is pulled
  from a registry. It publishes `${PI_RECEIVER_PUBLISH:-127.0.0.1}:3000`, and this host sets
  `PI_RECEIVER_PUBLISH=192.168.99.253` in `.env`.
- Ports: console `4790` on all host interfaces, plain HTTP; Valkey `127.0.0.1:6379`; receiver
  `192.168.99.253:3000`.
- Egress is armed (`PI_EGRESS` unset), with a `pi-dispatch-egress-proxy` container in front of the jobs.
- Runtime state is under `/root/pi-dispatch/runtime`: `jobs/`, `logs/`, `sandboxes/`, `tmp/`, `home/`, the trigger
  and settings files, and the read-only job overlay `pi-global/`.
- Five containers run: `valkey`, `worker`, `console`, `receiver` and `egress-proxy`.

## The job image

The job image is published from a checkout, not by CI: `./image/publish.sh` builds and pushes

| Repository | What runs it |
|---|---|
| `docker.io/ddv12138/pi-job` | every job without its own `run.image` |
| `docker.io/ddv12138/pi-job-java21` | a Java flow, through that trigger's `run.image` |

Both carry `python3`, the three baked skills and the runner this repository ships; the Java one adds JDK 21 and
Maven. The tag this host runs for both is `4.3.4`, the current release.

The worker service names the default job image as a compose interpolation default, and `.env` wins over it, so the
shipped default applies only when the key is absent from `.env`. `.env` here pins `PI_JOB_IMAGE` to
`docker.io/ddv12138/pi-job:4.3.4`, and the two tags are the whole set of job images on the host.

Jobs launch with `--pull=never`, so nothing is fetched at job time. Docker Hub is not reachable directly from this
host (`registry-1.docker.io` refuses); pulls go through the registry mirror configured in `/etc/docker/daemon.json`.
`PI_JOB_IMAGE` is read at container creation, so the running container keeps the value it was created with until the
worker is recreated.

## The Java trigger

A Java flow needs a JVM, so its trigger names the Java image by hand in `runtime/triggers.json` (the console's
trigger form has no image field):

```json
{ "on": { "type": "label", "any": ["afk-spec"] },
  "run": { "kind": "gitlab", "flow": "spec-run",
           "image": "docker.io/ddv12138/pi-job-java21:4.3.4",
           "statusComment": true, "maxTurns": 300 } }
```

All three rules in `runtime/triggers.json` — `spec-run`, `ticket-run` and `ticket-merge` — name that Java image by
hand, at `4.3.4`. The merger needs Maven to test the candidate, even though it writes no code.

A trigger naming an image that is not on this host is refused **before** spend (`job-image-missing`). The image's
Maven settings are baked at build time, not passed by the job:

- mirror `https://maven.aliyun.com/repository/public`, whose host is also in `egress-allowlist.conf`;
- a `<proxies>` block, because **Java ignores `HTTPS_PROXY`** and a Maven job on the job network reaches nothing
  without it. The proxy host baked in is the address a **job container** reaches, not the host's loopback.

## Triggers

`runtime/triggers.json`, pointed at by `PI_TRIGGERS_FILE`, holds three rules:

| `on` | flow | `maxTurns` | notes |
|---|---|---|---|
| issue label adds `afk-spec` | `spec-run` | 300 | label rule |
| issue label adds `ready-for-agent` | `ticket-run` | 120 | `resume: true` |
| MR `open` | `ticket-merge` | 120 | `open` only |

`ticket-run` implements one ticket on `pi/issue-<ticket>`, runs `mvn -q test`, and opens a MR to `pi/issue-<spec>`;
it does not merge or push the spec branch. `ticket-merge` drains the open ticket -> spec MRs, serializes them per
spec with the lock branch `pi/spec-lock-<n>`, and merges only after testing the merged ticket branch. It does not
merge spec -> master; that remains a human step. Ticket jobs stay parallel; only merges queue.

`PI_CONCURRENCY` (6) bounds the deployment, and no rule sets `concurrent: 1`. `.env` holds `PI_JOB_CPUS` 1 and
`PI_JOB_MEMORY` 2g beside it, under a `PI_HOST_MEMORY_BUDGET` of 12g and a `PI_HOST_CPU_BUDGET` of 6. The deployment
runs without job-start or token caps, and `.env` carries none of the retired cap keys.

## Session store

`ticket-run` arms `run.resume`, so `PI_SESSIONS_DIR` is required; it has no default. This host's store is
`/root/pi-dispatch/runtime/sessions`, mode `0700`, owner `10001:10001`, with `PI_SESSION_MAX_RESUME_CHAIN=20`. It is
PII-bearing and host-only, outside every git repo.

## The receiver (GitLab)

`deploy-receiver` is built from `receiver/Dockerfile` at this snapshot — there is no
`ghcr.io/edgehero/pi-dispatch-receiver:latest` pull — and serves the published address above,
`192.168.99.253:3000`.

Settings live in `.env`: `GITLAB_URL=https://git.133ec.com`, `GITLAB_TOKEN` (a personal PAT of `liukang`, id 340),
`GITLAB_WEBHOOK_MODE=token`, `GITLAB_WEBHOOK_SECRET`. `GITHUB_AUTH_SOURCE=gh` is commented out, so this deployment
serves GitLab only.

The container reads `triggers.json` through a single-file bind mount: an in-place rewrite changes the bytes but
produces no directory event, so the process keeps its boot-time rules, and a write by rename leaves the mount on the
old inode.

**The bot-loop guard is disarmed here**: `PI_RECEIVER_ALLOW_SELF=1`, because this GitLab has a single identity, so
`liukang`'s own comments and labels arrive as the harness's. The switch disarms only that comparison; the author
gate, resolution and verification are unchanged, the receiver says so at boot (`bot_loop_guard_disabled`), and
`pi-dispatch doctor` warns by name.

What bounds the spend is the turn cap (`PI_MAX_TURNS`), `PI_CONCURRENCY`, the host memory/CPU budget and the flow
itself. The rules are therefore clear of the shapes that reproduce the harness's own output: no
`on: {type:"pull_request", action:["update"]}` (every push the agent makes to its own merge request is one), no
`on: {type:"comment", phrase:"@pi"}` (a status comment is a comment), and no close rules on items the agent closes
itself. The shapes in place are label rules keyed to a label a person applies.

The deliberate exception is the `ticket-merge` rule on MR **`open`**: it fires once per MR, and the merger only
merges — it does not open a MR — so it creates no loop.

**Who can trigger a job**: the author gate requires Developer or above. On this single-identity host
`PI_RECEIVER_ALLOW_SELF=1` also lets the token's own account trigger.

## This GitLab is 13.2.10

- `GITLAB_WEBHOOK_MODE=token`, because `signature` needs 19.0+ and the native delivery id needs 17.4+. Deliveries
  are deduplicated by `body-sha256-<hex>` over the event header and the raw body.
- **No project or group access tokens** exist on this version, so the credential is a personal PAT of `liukang`,
  which `CONST-TOKEN-SCOPED-PER-JOB` calls a residual: it reaches every project that account belongs to and makes
  the harness's identity that human account. Its name, scopes and expiry are not auditable from the API on this
  version; the only view is the token list at `https://git.133ec.com/profile/personal_access_tokens` for that
  account, where the row with the most recent **Last used** is the one this deployment holds.
- Webhook bodies carry **no `user.id`**, so the receiver resolves the sender from `user.username` (one exact match
  only) and drops a delivery whose actor cannot be resolved as `missing-sender-id`.
- Endpoint behaviour: no header or a wrong header answers 401, the correct secret answers 204, `/` answers 404.

## Egress

`egress-allowlist.conf` holds one host per line, six of them today: `api.anthropic.com` (doctor's provider probe;
`PI_PROVIDER` here is `tencentmaas`, but the probe still asks it), `.github.com` (the leading dot takes the
subdomains), `registry.npmjs.org` (a serviced repo's own dependencies), `tokenhub.tencentmaas.com` (the model
provider), `git.133ec.com` (a job's clone and push) and `maven.aliyun.com` (the Java image's Maven mirror).

## The overlay

`runtime/pi-global` is mounted read-only into every job as `/opt/pi-global`: `models.json` (this deployment's
`tencentmaas` provider and its two models), `packages/` (the staged `pi-subagents`), and `skills/`. The three skills
(`code-review`, `tdd`, `implement-spec`) are also baked into the job image; the overlay's copies win on this host.
`implement-spec` in the overlay has its `disable-model-invocation: true` line removed, because an unattended job
that loads that flag cannot call the skill.

`pi-subagents` is staged, not baked. A worker built from the current source applies its own reviewed compatibility
adaptation while staging the package.

## Doctor expectations

`pi-dispatch doctor` reports these on this host, and they are configuration rather than faults:

- `PI_RECEIVER_ALLOW_SELF=1`, the disarmed bot-loop guard;
- `GITHUB_AUTH_SOURCE=gh` with no `gh` login in the container, because the GitHub arm is off;
- `WEBHOOK_SECRET` unset: the GitLab arm verifies with `GITLAB_WEBHOOK_SECRET`;
- the console listening on `0.0.0.0:4790` in plain HTTP, and `PI_CONSOLE_ALLOWED_HOSTS=*`;
- `cpu_reserve_fail_open` on the local venue: this kernel is cgroup v1, so no CPU quota is held across jobs;
- staged packages load in every job (no trigger sets `run.packages: false`).
