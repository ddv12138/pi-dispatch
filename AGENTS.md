# Working on pi-dispatch

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues for ddv12138/pi-dispatch. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five default triage labels. See `docs/agents/triage-labels.md`.

### Domain docs

Use the single-context layout. See `docs/agents/domain.md`.

### 253 deployment

For deployments or recovery on the 253 server, read `docs/253-deployment.md` before changing `/root/pi-dispatch`.
It records the Compose topology, update procedure and rollback material. Preserve the remote `.env` and `runtime/`
state, and keep credential values in the server environment.
