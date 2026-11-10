# Example .pi Starter

A minimal `.pi` folder that pi-dispatch jobs can use. It holds two files:

- `.pi/APPEND_SYSTEM.md`, a short persona that is added to the built-in guardrails (it cannot remove them);
- `.pi/skills/tidy/SKILL.md`, a flow named `tidy`. A trigger names a flow, and the skill file is the prompt the
  agent follows.

Copy the `.pi` folder into the root of your project, edit the persona and skills to suit your project, commit the changes. Then add a cron trigger in `triggers.json` (or in the console) that names the flow, and fire it once by hand:

```jsonc
{ "on": { "type": "cron", "id": "tidy", "pattern": "0 3 * * *" },
  "run": { "kind": "local", "folder": "/path/to/your/project", "flow": "tidy", "task": "your task here" } }
```

```bash
docker exec deploy-worker-1 node /opt/pi-dispatch/worker/src/cli.mjs run --trigger tidy
```

Commit first: a local job edits the folder in place, and the worker refuses a folder with uncommitted
changes. Forge triggers read flows from the default branch, so merge a flow before a trigger uses it.
