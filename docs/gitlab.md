# GitLab triggers

pi-dispatch services GitLab projects the same way it services GitHub repositories: an issue label, an
`@pi` comment, or merge-request activity starts a job that clones the project at its default-branch SHA,
runs your flow in a container, and comments back.

Triggers live in the same `triggers.json`, with the same `{any, all, none}` label predicates and the same
`flow` / `packages` / `image` options. The only new field is `run.kind`:

```jsonc
{ "triggers": [
  { "on": { "type": "label", "any": ["pi:fix"] },
    "run": { "kind": "gitlab", "flow": "fix" } },

  { "on": { "type": "comment", "phrase": "@pi" },
    "run": { "kind": "gitlab", "flow": "triage" } },

  { "on": { "type": "pull_request", "action": ["open", "update"] },
    "run": { "kind": "gitlab", "flow": "review" } }
] }
```

You can serve both forges from one deployment. Rules are grouped per forge, so a GitHub delivery never
matches a rule you wrote for GitLab even when both select the same label — and you may have one `@pi`
comment trigger on each.

## Set it up

**1. Mint a project access token.** Project Settings → Access tokens. Scope it `api` (see
[the scope trade-off](#the-scope-trade-off) below), give it the **Developer** role, and set the
shortest expiry you will tolerate re-minting. Not Maintainer: a Maintainer token lets the job (and the forge's own
MCP server, [mcp.md](mcp.md#the-forges-own-server)) unprotect a branch or change who may merge, which is the
boundary the next steps rely on.

```bash
GITLAB_TOKEN=glpat-xxxxxxxxxxxx
GITLAB_URL=https://gitlab.com          # your instance, if self-hosted
```

There is no source to choose. `GITLAB_AUTH_SOURCE` exists, accepts only `pat`, and defaults to it: GitLab
has no App or installation-token equivalent, so the variable is there to answer an operator who reasons by
symmetry with `GITHUB_AUTH_SOURCE` and sets `app`, which gets a refusal naming the reason rather than a
setting that quietly does nothing. It is read only once `GITLAB_TOKEN` is set: with no token there is no
GitLab configured and the whole block, this variable included, is skipped.

**2. Add the webhook.** Project Settings → Webhooks, URL `https://<your-host>/gitlab` — note the path;
`/` is the GitHub endpoint. Subscribe to **Issues events**, **Comments**, and **Merge request events**.

**3. Choose a verification mode.** This is required and has no default, because the two are not equally
strong:

| Mode | What it proves | Needs |
|---|---|---|
| `signature` | The body arrived exactly as GitLab sent it (HMAC-SHA256, replay-windowed) | GitLab **19.0+** |
| `token` | The sender knew a secret. **Nothing about the body.** | any version |

```bash
GITLAB_WEBHOOK_MODE=signature
GITLAB_WEBHOOK_SECRET=whsec_...        # the "Signing token" GitLab shows you
```

or

```bash
GITLAB_WEBHOOK_MODE=token
GITLAB_WEBHOOK_SECRET=<the "Secret token" you set on the webhook>
```

The receiver verifies **exactly** the mode you declared. A delivery carrying the other mode's header is
refused even if it is correct — otherwise a sender could pick which gate it faced, and it would always
pick the weaker one.

**4. A GitLab-only deployment needs nothing from GitHub.** Every forge arm is conditional: the receiver
mounts a forge's route, resolves its identity for the bot-loop guard, and requires its credentials only
when your triggers name that forge. So no `WEBHOOK_SECRET` and no `gh` login are needed here, and `/`
(the GitHub endpoint) answers 404 rather than 401, because an endpoint that answers is one you could
believe is armed. Add a `github` trigger later and both become required again, as they should.

**5. Check it.** `pi-dispatch doctor` reports whether the token, the verification mode and the webhook
secret are set when your triggers name GitLab, plus `WEBHOOK_SECRET` for any forge at all.

**6. Start it.** `pi-dispatch-receiver` from your deployment folder; `serve` is the default command, so
there is nothing to type after the name. A container profile is the alternative
(`docker compose --env-file .env -f deploy/docker-compose.yml --profile receiver up -d`, which needs
`deploy/docker-compose.yml`: a clone carries it, and you copy it in when you choose the receiver
container), and [`docs/github.md`](github.md#three-ways-to-run-the-trigger-edge) lays out the choice. The third way it offers, `pi-dispatch-receiver poll`, cannot serve this forge: the poller
reads api.github.com and has no GitLab path at all.

## Self-hosted instances

Set `GITLAB_URL` to your instance root and everything follows it: the receiver's member lookup, the
worker's API calls and clone URL, and `GITLAB_HOST` inside the job container so `glab` talks to your
instance rather than gitlab.com. Nothing is hardcoded to gitlab.com; that value is only the default.
(Webhook verification is the exception that needs nothing here, because it reads the delivery's own headers
and the configured mode and secret, never an instance URL.)

```bash
GITLAB_URL=https://gitlab.internal.example.com
```

Two things are worth knowing before you point it at a private instance.

**A private CA needs to be trusted, in two places.** The worker and receiver run on the host, so a CA that
your OS trusts is not automatically one Node trusts:

```bash
NODE_EXTRA_CA_CERTS=/etc/ssl/certs/your-internal-ca.pem
```

Without it, every call fails, and the log names the reason rather than the bare `fetch failed` Node rejects
with. The receiver's boot-time identity check reports `gitlab identity: GET /user failed (...)`, and inside
those parentheses is the fetch's whole cause chain, joined with colons, so the certificate error itself is
what you read. That message is the diagnosis; if you see it, this is what it means. A trust failure is
treated as configuration, so the receiver exits 2 and your supervisor leaves it stopped: setting the CA is
the only thing that changes the answer, and restarting into the same failure would only hide it. An
instance that is merely unreachable is retried in-process (5 seconds between attempts, backing off to 30,
for `RECEIVER_IDENTITY_RETRY_SECONDS`, default 10 minutes); when a window ends the receiver exits 1 and
the supervisor starts another, so an instance restart measured in minutes is ridden out rather than
outlasting the recovery.

The **job container** is a separate trust store: the job's `git push` and `fetch` and `glab` run inside it
(the clone runs on the host first), so the CA has to be in the image. Add it to your own image
(`docs/job-image.md`): a `COPY` of the cert into
`/usr/local/share/ca-certificates/` plus `update-ca-certificates`. The stock image trusts only the public
roots.

**How a job's git authenticates, and who it commits as.** The clone runs on the host and its `origin` is
deliberately tokenless, so no `.git/config` inside the workspace ever holds a credential (the agent can rewrite
that file, and a retained sandbox keeps the tree for a day). In the container the token reaches git through a
helper: the worker writes `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_0=credential.helper` and a `GIT_CONFIG_VALUE_0`
whose body only *names* the token's variable (`!f() { test "$1" = get || exit 0; echo username=oauth2; echo
"password=$GITLAB_TOKEN"; }; f`), so the value holds no secret and git reads the variable when it asks. That is
why an envelope's plain `git push` works with no `git credential` setup of its own, and why a job with no forge
token gets no helper at all rather than a prompt nobody can answer. The same three variables reach the `openshell`
venue, where the value is a placeholder the gateway resolves. GitHub jobs get `x-access-token` with
`$GITHUB_TOKEN`; Forgejo jobs `pi-dispatch` with `$FORGEJO_TOKEN`.

`git commit` needs an author and a container has no `~/.gitconfig`, so the worker also sets `GIT_AUTHOR_NAME`,
`GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME` and `GIT_COMMITTER_EMAIL` to `pi-dispatch <pi-dispatch@localhost>`: every
job's commits carry the same provenance instead of whatever name a model invented that day. `git config` cannot
show those variables, so every envelope also tells the agent its identity is already set and never to change it: a
job that reads `git config user.name` finds nothing back and would otherwise set an author by hand, which the
variables then overrule. A trigger cannot set any of the seven names (`run.secrets` and `PI_FORWARD_ENV` refuse them),
which is what stops one trigger installing a helper of its own and pointing a job's credential at a host the
operator never allowlisted.

**Redirects are refused, not followed.** If `GITLAB_URL` is `http://…` and your instance redirects to
HTTPS, calls fail rather than silently following — a redirect is somewhere to send a credential, and
following one is how a token ends up at a host you did not name. Set `GITLAB_URL` to the final URL.

Plain `http://` works only with the egress policy off (`PI_EGRESS=0`). It sends the token in the clear on
every API call, push and fetch (and the clone on the host), so it is only reasonable on a trusted network, and it is not what the
isolation model assumes elsewhere. With the policy on (the default), GitLab must be served over `https://` on
port 443: git in a job never sends an `http://` remote through the proxy, and the proxy refuses a `CONNECT` to
any other port (issue #508, `docs/egress.md`). Otherwise a job's git push and fetch fail, and on a port other
than 80 its API calls fail too.
`pi-dispatch doctor` warns when `GITLAB_URL` is anything but `https://` on 443.

## GitLab versions and delivery deduplication

GitLab 17.4+ provides `Idempotency-Key`, and 19.0+ also provides `webhook-id`; pi-dispatch prefers
either native delivery ID when present. Older GitLab versions can use `token` mode without either header.
For those requests, pi-dispatch hashes the event header and the exact raw request body and uses that digest
as the queue delivery ID. Byte-identical retries therefore coalesce within the normal 31-day job retention.

This is best-effort deduplication, not a GitLab delivery ID: if a retry changes the body or event header,
its hash changes and it can run again. Two independent deliveries with identical event header and body
coalesce. Signature mode still requires GitLab's signed delivery headers, so it remains available only on
GitLab 19.0+ (GA in 19.1).

## `glab` on an older instance

`glab` states its own floor: it "officially supports GitLab versions 16.0 and later", and a command may still work
on 15.x or earlier with no support. Measured against 13.2.10:

| | 13.2.10 |
|---|---|
| `glab api`, `glab mr list`, `glab mr view`, `glab mr create`, `glab mr note` | work |
| `glab issue view` | panics, a Go nil dereference in `issuable/view.rawIssuePreview` |
| `glab auth status` | reports the host unauthenticated while `GITLAB_TOKEN` is set and every other command works |

Nothing here needs configuring and none of it is a token problem. The gitlab envelope names the instance as the
cause and gives the API route for what breaks: `glab api projects/:id/issues/<n>` reads an issue, and the
check-first step has a `state=opened` API form beside `glab mr list`. A job therefore keeps working on an old
instance instead of spending turns on `glab auth login`, and gives up only `glab`'s own rendering.

Running `glab` inside its support matrix means a recent GitLab; an instance below it is accommodated in the prompt,
not in the image, because the image cannot know what it will be pointed at.

## Instances older than `user.id`

GitLab 13.x and earlier build a webhook's `user` object out of `name`, `username`, `avatar_url` and `email` and
send no `id` (measured on 13.2.10). pi-dispatch needs a numeric sender id: it is what the author gate looks up
and what the bot-loop guard compares. Without one every delivery drops as `missing-sender-id`, with the
endpoint configured perfectly.

So the sender is resolved from `user.username` when the payload carries no `id`: one `GET /users?username=<name>`
against the instance, accepted only when it matches **exactly one** account, then the same `members/all` lookup
by the resolved id. Four things do not change:

- the payload's own `user.id` always wins when it is present, so an instance that sends one pays no extra call
  and the fallback can never disagree with it;
- the gate still needs Developer or above, from the same endpoint (`CONST-TRIGGER-AUTHOR-GATE`);
- the harness still cannot trigger itself, because the comparison is between numbers either way;
- no username reaches a job, a log line or the run record, exactly as before.

Two failure shapes are worth knowing apart:

- A username matching no account, or several, is a delivery with **no sender**: dropped as `missing-sender-id`,
  and the members lookup is never spent on it. A lookalike spelling therefore refuses rather than guesses.
- A `/users` answer that fails, or is not a list, is a **503**: GitLab redelivers and the `body-sha256-` id above
  coalesces the retry. An outage never reads as "no such person".

**Where project and group access tokens do not exist** (measured on 13.2.10: `/projects/:id/access_tokens` and
`/groups/:id/access_tokens` both answer 404), the only credential is a personal access token, and that is a
residual against `CONST-TOKEN-SCOPED-PER-JOB`: it reaches every project its owner belongs to, and it makes the
harness's own identity that human account, so the bot-loop guard drops every event that account authors. Mint it
from a dedicated account with Developer access on the projects you service, never from the account whose
comments you want to trigger jobs, and rotate it.

## One identity: `PI_RECEIVER_ALLOW_SELF`

Every delivery is dropped when its author is the harness's own account, because our own output is an event a
trigger can match: a status comment carrying the trigger phrase, a label a flow applied, and above all a push
to a merge request's source branch, which GitLab reports as an `update` of that MR. One job would start the
next.

That guard becomes a deadlock when the forge gives you a **single identity** (a personal PAT, or any instance
where you and the harness are the same account): your own comment and your own label arrive as ours, so every
rule you write matches nothing. GitLab's own answer is a second account, `docs/gitlab.md` above says why, and
where that is not possible the guard can be disarmed for the whole deployment:

```bash
PI_RECEIVER_ALLOW_SELF=1
```

`1` disarms it, unset or `0` keep it, and anything else refuses at the receiver's boot. It disarms **only** the
self comparison: the author gate still runs, still needs Developer or above, and a delivery that is self **and**
unauthorised still refuses as `author-not-allowed`. The receiver says `{"event":"bot_loop_guard_disabled"}` at
boot and `pi-dispatch doctor` warns while it is set.

**What now bounds the spend is your caps, not the guard.** So keep every trigger clear of what the harness
produces itself. Two shapes are matched by its own output and turn the guard into a daily budget:

| Do not write, with the guard off | Why |
|---|---|
| `on: {type:"pull_request", action:["update"]}` | every push the agent makes to its own MR is an `update` authored by it |
| `on: {type:"comment", phrase:"@pi"}` where the flow's own output can contain `@pi` | its reply quotes the request; a status comment is a comment too |
| close rules (`action:["closed"]`, `on.once`) on items the agent closes | it closes the issue itself |

Labels are the safest shape here, and even they need care: a rule keyed to a label **you** apply is fine, one
keyed to a label the flow applies to its own issue is a loop. The honest summary: with one identity, "the agent
works on what I hand it" and "the agent reacts to its own work" cannot both be true, and the switch chooses the
first.

## Who can trigger a job

**A project member with Developer access or above — resolved from the API, for every trigger type.**

This is stricter than the GitHub arm, and it has to be. On GitHub, applying a label requires write access,
so the label *is* the approval step. On GitLab that reasoning fails three ways:

- the minimum role for managing labels has differed across GitLab versions;
- Ultimate's **custom roles** let you grant it at any level;
- **a Guest can set labels on an issue they are creating** — so a stranger can open an issue with your
  trigger label already on it.

So a GitLab label is a routing hint, never an approval, and the actor's `access_level` is checked on every
delivery. Group-inherited membership counts (the lookup uses `members/all`), so a maintainer who holds
their role at the group level is not refused.

If that lookup cannot complete — a 5xx, a dead socket, a revoked token — the receiver answers **503** and
GitLab redelivers. It does not silently drop the event: "we could not tell" and "you are not allowed" are
different answers, and only one of them should look like a refusal.

## Labels: the diff is the trigger

GitLab has no `labeled` event. Adding a label arrives as `action: "update"` carrying a before/after diff,
so pi-dispatch fires on **the labels an event added**, not on the labels an issue currently has.

This matters more than it sounds. If it matched the current set, then every later edit of a labelled issue
— retitling it, reassigning it, changing its milestone — would start another paid run, forever.

Practical consequences:

- Adding your trigger label fires exactly once.
- Editing the issue afterwards fires nothing.
- **Removing** the label fires nothing.
- An issue **opened** with the label already on it fires once (there is no previous set to diff against),
  which is safe only because the access gate above already ran.

## Merge-request actions are GitLab's own words

| GitHub | GitLab |
|---|---|
| `opened` | `open` |
| `reopened` | `reopen` |
| `synchronize` | `update` (carrying `oldrev`) |
| `labeled` | — *(a label add is `update` with a `changes.labels` diff)* |
| `review_submitted` | `approved` *(near, not equal — see below)* |
| `closed` | `close` |

`approved` and `review_submitted` are the closest the two vocabularies come, and treating them as the same
word would mislead in both directions. `approved` is **one verdict**: GitLab emits it when an approval
lands, and nothing at all for a comment-only review. `review_submitted` is **every verdict** — an approve,
a request-changes and a plain commented review alike — which is why the GitHub side has an
`on.reviewState` narrowing and GitLab has no need of one. The gates differ too: a GitLab trigger is
access-gated by an API lookup on the actor whatever the action, while `review_submitted` is gated on the
reviewer's `author_association` specifically (see `SECURITY.md`).

Writing a GitHub word on a GitLab trigger is **refused when the file loads**. It would not crash anything
otherwise — it would simply never match an event, and the trigger would sit there looking configured and
doing nothing.

`close` is close-only: it never shares a rule with other actions, because a close is gated on the actor
who closed the MR rather than on the author, and it takes `on.number` (the **iid**, the number in the MR's
own URL, not the global id) and `on.once`: see [close triggers and one-shots](triggers.md#close-triggers-and-one-shots). `merge` is still not
offered, and a merged MR does not fire the close rule either: GitLab reports a merge as its own
`merge` action, which drops unhandled, so a close rule fires on an explicit close only.

An MR rule with a label predicate fires on the labels that event added. An MR rule without one fires on
its named actions, which is safe here because every GitLab trigger is access-gated regardless.

## The scope trade-off

A GitLab project access token needs the **`api`** scope to post a note, and `api` grants full read/write
to that project's API. GitLab offers no narrower split — no equivalent of GitHub's `contents` vs
`pull-requests`, and no short-expiry per-job token like a GitHub App's.

So on the credential axis, GitLab is weaker than GitHub's App path, and equal to its `gh` / PAT paths.
`CONST-TOKEN-SCOPED-PER-JOB` states this rather than papering over it. What you can do:

- **Use a project token, not a group token.** A group token reaches every project in the group.
- **Rotate it.** The expiry bound the constitution names as the blast-radius limit is yours to enforce
  here, because no GitLab mechanism enforces it for you.
- **Protect your default branch.** The worker refuses a job whose default branch is unprotected, before
  spending anything — wildcard protection rules (`release/*`, `*`) count.
- **Keep the token at Developer.** Leave "Allowed to merge" on the protected branch at Maintainers, and let no
  approval rule count the token's bot user: then nothing the job runs (`glab`, a `/merge` quick action in a note,
  the forge's MCP server) can merge into it.

The token reaches the container as `GITLAB_TOKEN` / `GL_TOKEN` only, never under the GitHub names: `gh`
would send a GitLab credential to github.com on its first invocation.

## What runs in the container

A GitLab job gets `glab`, not `gh`, and its prompt envelope is written in `glab mr` terms. Both CLIs ship
in the job image; `image/verify-image.sh` checks for both, because a missing one fails silently — the
agent follows an envelope naming a command that is not there, explains itself in prose, and exits 0.

Everything else is identical to a GitHub job: the same isolation flags, the same `/job:ro` inputs, the
same budget and pause windows, the same run history, and the same rule that **the harness never merges**.

**`run.replicas` works here** (issue #187). `"replicas": 2` on a `label`, `comment` or `pull_request` rule
races two independent sandboxes on one delivery, each on its own `pi/issue-<iid>-r<i>` branch, each opening
its own merge request titled `[r1/2] …`. Two caveats specific to this arm. It is **webhook only**: there is
no GitLab poller, so nothing fans out on a poll. And GitLab's `update` action is a firehose: a merge request
edit, a label change, a description tweak and a push all arrive as `update`, and unlike GitHub's `labeled`
there is no positive-selector requirement to narrow it, so `replicas: 2` on `action: ["update"]` multiplies
every edit rather than every push. See `docs/replicas` for the budget arithmetic.

## What is not supported

- **Group-level webhooks.** Untested, and nothing refuses one: verification reads only the delivery's
  headers, and the gate routes on the project id the payload carries. So do not expect an error if you
  configure one; expect behaviour nobody has checked. Configure the webhook per project.
- **Chaining from a GitLab job.** A forge job gets no `/outbox`, exactly as a GitHub job does not — its
  task text is adversarial input (`OQ-009`).
- **Multiple GitLab instances in one deployment.** One `GITLAB_URL`.
- **Per-job token minting.** GitLab can mint project tokens by API, but only from a personal access token
  and only with a date-granular expiry. Not shipped; see `CONST-TOKEN-SCOPED-PER-JOB`.

`OQ-013` in the project history is the honest statement of where this
arm is weaker than the GitHub one, and what would close the gap.
