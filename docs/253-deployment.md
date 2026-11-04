# 253 server deployment

Deployment notes for the server reachable as `root@192.168.99.253` in the local SSH configuration.
This is an instance record, not the general install guide; use [Linux Compose worker](worker-container.md)
and [upgrading](upgrading.md) for the supported deployment model.

## Layout

- Deployment directory: `/root/pi-dispatch`.
- Compose file: `deploy/docker-compose.yml`, project name `deploy`.
- The `worker` and `console` profiles use the locally built `deploy-worker` image. The image contains the
  application under `/opt/pi-dispatch`; the host directory is mounted for deployment data and same-path job
  access. The server directory has no Git metadata, so updates are staged from a committed source snapshot.
- The worker uses the host Docker socket. The console publishes port `4790` on all host interfaces and serves
  plain HTTP. Valkey is `valkey/valkey:8.1`, published on `127.0.0.1:6379`. The egress proxy is a separate
  container. The receiver profile was not part of the running deployment observed on 2026-11-04; it was added
  later the same day, see [the GitLab forge and the receiver](#the-gitlab-forge-and-the-receiver-2026-11-04).
- Runtime files live under `/root/pi-dispatch/runtime`; `.env` and runtime data stay on the server and their
  credential values do not belong in this document.

## Deployment record

On 2026-11-04, commit `1790266c` (`feat(admin): add Chinese console locale`) was built and deployed. The worker
and console packages and the job image use version `4.3.1`. The worker and console were recreated; Valkey and the egress
proxy were left running. The shared queue was paused for the rollout and resumed after verification.

The image's console modules passed `node --check`, the locale-selection smoke check passed, and the console login
page returned Chinese for `Accept-Language: zh-CN`. The final worker status was unpaused with zero active, waiting,
paused, delayed, or failed jobs. Before deployment, the full admin test suite was not green: some tests could not
open local sockets in the sandbox, several assertions did not account for HTML escaping, and width-table checks
failed independently of the locale changes.

On 2026-11-04, the fixed operator login was deployed from base commit `1790266c` with the local changes to
`admin/src/console/config.mjs` and `admin/src/console/server.mjs`. The rebuilt `deploy-worker` image is
`sha256:960efd2dee43db7c8b8a52acc98309f86f8420e41c96b370ae5a996429e2e82a`. The random credential is stored only
in the server's `.env`, which retains its original mode `0640`; no credential value belongs here. Console healthz
returned 200, a fixed-token login returned 200 as `fixed-token` / `operator`, logout returned 200, and the queue was
resumed with zero active, waiting, paused, delayed, or failed jobs. The worker and console containers were running.

Also on 2026-11-04, a follow-up corrected the fixed-token session recheck after the first login smoke showed that
`/api/whoami` immediately answered 401 `revoked`. The final image is
`sha256:bb6489a8776d229b30dc16fde14aeaffb3a7292ecfa06a8d89bf49c0e71700d8`, containing the session-store, console
wiring and gateway step-up fix. The repeated loop returned login 200, whoami 200 as `fixed-token` / `operator`, and
logout 200. Both containers were running without restarts, and the queue was resumed with all counts at zero.

## The GitLab forge and the receiver (2026-11-04)

The receiver is now part of this deployment for the first time. What was set up, in the files an operator
would have to touch again:

| What | Where | Value, or why |
|---|---|---|
| GitLab credentials | `.env` | `GITLAB_TOKEN` (a personal PAT of `liukang`, id 340), `GITLAB_URL=https://git.133ec.com`, `GITLAB_WEBHOOK_MODE=token`, `GITLAB_WEBHOOK_SECRET` (generated, read it from the file, never from this record) |
| GitHub arm disabled | `.env` | `GITHUB_AUTH_SOURCE=gh` is commented out. `decideServesGithub` treats an explicit source as "this deployment serves GitHub", and the GitHub arm then hard-fails boot resolving its own identity (`gh api user`, with no `gh` login in the container and an empty `GITHUB_PAT`). `triggers.json` names no GitHub rule, so nothing was lost. Re-enable it only together with `WEBHOOK_SECRET` and a resolvable `gh` identity. |
| Clone and API reach | `egress-allowlist.conf` | one line, `git.133ec.com`. Egress is armed by default (`PI_EGRESS` unset), and a job's clone and push go through the proxy. Reload with `docker exec pi-dispatch-egress-proxy squid -k reconfigure`. |
| Receiver image and port | `deploy/docker-compose.override.yml` (new) | builds `deploy-receiver` from `receiver/Dockerfile` at this same 4.3.1 snapshot instead of pulling `:latest`, and publishes `192.168.99.253:3000` beside the shipped `127.0.0.1:3000`. The shipped compose file stays byte-identical to `worker/deploy/`. |

**Compose needs BOTH files named on this host.** `docker compose -f deploy/docker-compose.yml ...` does not
pick up `docker-compose.override.yml` beside it (measured on Compose v2.21.0), so the receiver commands are:

```bash
cd /root/pi-dispatch
C="docker compose --env-file .env -f deploy/docker-compose.yml -f deploy/docker-compose.override.yml"
$C --profile receiver up -d
$C --profile receiver logs --tail 30 receiver
```

### The bot-loop guard is disarmed here (2026-11-04)

`PI_RECEIVER_ALLOW_SELF=1` is set in `.env`. The reason is the one this section keeps arriving at: this GitLab
has a **single identity**, so `liukang`'s own comments and labels arrive as the harness's, and with the guard
armed every gitlab rule matches nothing. The switch disarms **only** that comparison: the author gate still
needs Developer or above, resolution and verification are untouched, and the receiver announces it at boot
(`{"event":"bot_loop_guard_disabled","reason":"PI_RECEIVER_ALLOW_SELF=1"}`) while `pi-dispatch doctor` warns
about it by name.

**What bounds the spend from now on is `PI_DAILY_CAP` (25 container starts a day) and `PI_MAX_TURNS`, not the
guard.** So no trigger may be shaped like the harness's own output. Concretely, do not write:

- `on: {type:"pull_request", action:["update"]}` — every push the agent makes to its own merge request is an
  `update` authored by it, so one job would start the next;
- `on: {type:"comment", phrase:"@pi"}` where a flow's own output can contain `@pi` — the reply quotes the
  request, and a status comment is a comment too;
- close rules on items the agent closes itself.

A label rule keyed to a label a person applies is the safe shape. The full reasoning is in `docs/gitlab.md`,
"One identity: PI_RECEIVER_ALLOW_SELF".

Verified after the change: a delivery authored by `liukang` (creating an issue on project 3022) logs
`reason: "no-label-change"` instead of `reason: "self"`, i.e. the self compare stepped aside and routing
decided. `triggers.json` is still empty by choice, so nothing was enqueued.

Rollback: `.env.bak-allowself-2026-11-04`, then recreate the receiver and the worker (both read `.env` at
start). Removing the line restores the guard with no code change.

### This GitLab is 13.2.10, and what that needed

The instance is **13.2.10**, which is why `GITLAB_WEBHOOK_MODE` is `token`: `signature` needs 19.0+ and the
native delivery id needs 17.4+, so deliveries are deduplicated by `body-sha256-<hex>` over the event header
and the raw body (`docs/gitlab.md`).

Two consequences of that version were measured here, not inferred:

1. **Webhook bodies carry no `user.id`.** An `Issue Hook` body's `user` is `{name, username, avatar_url,
   email}` and nothing else. The gate requires a numeric sender id before it looks at anything else, so every
   delivery was verified and then dropped as `missing-sender-id`, forever, with the endpoint configured
   correctly.
2. **There are no project or group access tokens.** `/projects/:id/access_tokens` and
   `/groups/:id/access_tokens` both answer 404, so the credential is a personal PAT of `liukang` (id 340),
   which `CONST-TOKEN-SCOPED-PER-JOB` calls a residual: it reaches every project that account belongs to, and
   it makes the harness's own identity that human account. Measured reach on 2026-11-04: 137 projects
   visible, **130 of them at Maintainer**, 0 at Owner, and the account is not an admin. The token's own
   record is unreadable on this version, so its **name, scopes and expiry cannot be audited from the API at
   all** (`/personal_access_tokens/self`, `/personal_access_tokens`, `/users/:id/personal_access_tokens` all
   answer 404). Read them at `https://git.133ec.com/profile/personal_access_tokens` as that account, where
   the row whose **Last used** is the most recent is the one this deployment holds.

**This deployment therefore carries a local patch**, applied to `receiver/src/gitlab-members.mjs`,
`receiver/src/receiver.mjs` and `receiver/src/start.mjs` on top of the 4.3.1 snapshot, with the spec amended in
`INT-GITLAB-PAYLOAD-SUBSET` and `docs/gitlab.md` describing it. The sender is resolved from `user.username`
when the body has no `id` (one exact match only, never a lookalike), the payload's own `id` still wins when
present, an absent actor still drops as `missing-sender-id`, and an unreadable `/users` answer is a 503. A
deployment rebuilt from an upstream release that predates this patch would lose it: check that release before
staging a new snapshot over this folder.

Verified on 2026-11-04 with a real delivery from `git.133ec.com`: creating an issue on project
`liukang/test-afk` (3022) now logs `{"event":"dropped","reason":"self"}` rather than
`missing-sender-id`, which is the resolution working and the bot-loop guard comparing the resolved id to this
deployment's own identity (340). `triggers.json` is empty by choice, so nothing is enqueued yet.

Four hand-built deliveries against the running receiver, all token-verified, show every arm of the resolver
asking the real instance:

| `user.username` in the body | Drop reason | What it proves |
|---|---|---|
| `liukang` (this deployment's own account) | `self` | the resolved id is compared to the harness's identity |
| `guofj` (a real account, not a member of 3022) | `author-not-allowed` | the id was resolved AND the `members/all` lookup ran |
| a username nobody has | `missing-sender-id` | absence is determinate and spends no members lookup |
| no `user` object at all | `missing-sender-id` | an actor-less body is still refused before any call |

**Who can trigger a job here.** Not the account the token belongs to: the guard drops its events as `self`.
Mint the PAT from a dedicated account with Developer access on the serviced projects, or accept that a second
person's account must be the one that comments and labels.

Other checks with the receiver running: no header and a wrong header answer 401, the correct secret answers
204 (verified, no rule matched), `/` answers 404, and `pi-dispatch doctor` reports no GitLab problem. The hook
created on project 3022 pointing at `http://192.168.99.253:3000/gitlab` reported no delivery error, so the LAN
path from `git.133ec.com` to this host works.

Rollback: `.env.bak-gitlab-2026-11-04`, `egress-allowlist.conf.bak-gitlab-2026-11-04`, delete
`deploy/docker-compose.override.yml`, `$C --profile receiver down` (never `rm -f` the Valkey container), and
delete the hook. `docker image tag` nothing: `deploy-receiver` is built here, not pulled. Reverting the patch
means restoring the three `receiver/src` files from the 4.3.1 snapshot and rebuilding.

## Update this source deployment

Keep `.env` and `runtime/` on the server. Before changing source, inspect the queue through the running worker and
confirm that active jobs have finished. This host has no `PI_WORKER_NAME`, so the shared queue pause covers its
worker. After pausing, repeat `status` until `active` is zero before building or recreating either service.

```bash
cd /root/pi-dispatch
docker exec deploy-worker-1 node /opt/pi-dispatch/worker/src/cli.mjs status
docker exec deploy-worker-1 node /opt/pi-dispatch/worker/src/cli.mjs pause
docker exec deploy-worker-1 node /opt/pi-dispatch/worker/src/cli.mjs status
docker compose --env-file .env -f deploy/docker-compose.yml --profile worker build worker
docker compose --env-file .env -f deploy/docker-compose.yml --profile worker --profile console up -d --no-deps --force-recreate worker console
docker exec deploy-worker-1 node /opt/pi-dispatch/worker/src/cli.mjs status
curl -L -H 'Accept-Language: zh-CN' http://127.0.0.1:4790/ | grep '切换语言'
docker exec deploy-worker-1 node /opt/pi-dispatch/worker/src/cli.mjs resume
docker exec deploy-worker-1 node /opt/pi-dispatch/worker/src/cli.mjs status
```

Resume only after both containers are running and the console check succeeds. If the build or rollout fails, keep
the queue paused while restoring service.

## Rollback record

The previous image is retained as `deploy-worker:pre-zh-1790266`. The pre-deployment copies of the changed source
files that existed on the server are in `/root/pi-dispatch-backup-1790266/source-before.tar`.

To roll the running services back to the previous image, pause the queue, retag the saved image, then recreate the
same two services. Wait until `status` reports zero active jobs before recreating them:

```bash
docker exec deploy-worker-1 node /opt/pi-dispatch/worker/src/cli.mjs pause
docker exec deploy-worker-1 node /opt/pi-dispatch/worker/src/cli.mjs status
docker image tag deploy-worker:pre-zh-1790266 deploy-worker
docker compose --env-file .env -f deploy/docker-compose.yml --profile worker --profile console up -d --no-deps --force-recreate worker console
docker exec deploy-worker-1 node /opt/pi-dispatch/worker/src/cli.mjs status
docker exec deploy-worker-1 node /opt/pi-dispatch/worker/src/cli.mjs resume
```

The source archive and image tag are rollback material; keep them until the deployment has been accepted.
Update this record when a later source snapshot is deployed, including its commit, image tag and verification.

## Chinese console completion (2026-11-04)

Commit `33418a90` (`feat(admin): complete Chinese console copy`) was deployed from the committed source snapshot.
The `deploy-worker` image is `sha256:232863863e50eab399dacc5513e26dc48ebd5f8fcd526ee7c6685d692bf87999`.
Before rebuilding, the prior image (`sha256:bb6489a8776d229b30dc16fde14aeaffb3a7292ecfa06a8d89bf49c0e71700d8`)
was tagged `deploy-worker:pre-33418a90` for rollback. The queue was paused with zero active jobs; only the worker and
console were recreated. `.env`, `runtime/`, the receiver override, receiver, Valkey and the egress proxy were kept in
place. The console health check returned `ok`, a request with `Accept-Language: zh-CN` returned `lang="zh-CN"` and
the Chinese language-switch label, and the worker queue was resumed with zero active, waiting, paused, delayed or
failed jobs. The receiver and Valkey remained healthy.

Local verification: the admin build passed and the focused Chinese-console batch passed 96/96. The full admin test
suite was not green in this environment: 3,288 passed, 263 failed, 29 were cancelled and 91 skipped; terminal width
checks failed and Valkey-dependent tests logged that no local Valkey answered. Two Project assertions in the broader
focused batch also reproduce on the base revision.
