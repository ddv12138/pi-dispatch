# Notifications

Free refusals announce why no job ran. For a paid job that ends in a policy stop or a final infrastructure failure, the worker posts a fixed failure comment where applicable. Retries that later succeed, completions and operator cancellations do not trigger failure notifications. A trigger can also request a running status comment with `statusComment` ([triggers](triggers.md#optional-run-fields)).

## Inspect notifications in the console

The console shows recent hook runs and their exit status. Hook delivery is best effort; a successful hook does not prove the remote service received a notification.

## `PI_ON_FAILURE`: one command, wired by you

Set a command in the worker's `.env`:

```sh
PI_ON_FAILURE=/opt/pi/notify.sh
```

The worker runs it as its own account with its environment, without a shell, once on a terminal paid failure:

```text
/opt/pi/notify.sh <jobId> <outcome> <reason> <host>
```

`outcome` is `failed` or `policy`; `reason` is a fixed run-record token, and `host` may be empty. No payload or error text is passed. The hook does not fire for free refusals, successful retries or operator cancellations. It is best effort and cannot change the job result; its output is ignored. `PI_ON_FAILURE_TIMEOUT_MS` controls the timeout (default 10 seconds).

Wire your own transport, for example:

```sh
#!/bin/sh
exec curl -fsS -d "pi-dispatch: job $1 ended $2 ($3) on ${4:-this host}" ntfy.sh/my-topic
```
