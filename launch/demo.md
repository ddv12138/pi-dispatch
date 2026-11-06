# Recording the demo (GIF / video)

The web console is the hook now. Its still images are drawn from the committed goldens (`launch/console-picks.mjs`,
below), and a short recording of it moving, live, is worth more than any paragraph. A recording needs a real browser
and a running console, so it is yours to make: a screen recorder over `http://127.0.0.1:4790/` on a deployment with a
little state, or a terminal recorder over the CLI. Two terminal tools, if you want scripted output:
[`vhs`](https://github.com/charmbracelet/vhs) (scripted, reproducible, best for a clean GIF) or
[`asciinema`](https://asciinema.org) + [`agg`](https://github.com/asciinema/agg) (records a real session).

Run against a deployment with a little state (a couple of triggers, a finished run or two) so the pages aren't
empty: start the stack (`docker compose --env-file .env -f deploy/docker-compose.yml up -d`), queue one local job, let it
finish, then record.

Keep the file small (< ~3 MB): trim to ~25s, cap width at ~1200px, and prefer the GIF for GitHub autoplay.

## The CLI transcript images

`docs/images/cli-doctor.svg` and `cli-service-windows.svg` are real command
output drawn as a terminal window by `launch/transcript-svg.mjs`. Regenerate them when the output changes:

1. On a Linux host with Docker, as a throwaway account `you` (uid 1000) that is in the `docker` group and has
   nothing listening on 127.0.0.1:6379, and with `pi-job:latest`, `valkey/valkey:8.1` (`VALKEY_IMAGE` in
   `worker/src/valkey-auth.mjs`) and the egress proxy image already pulled (so no pull progress lands in the
   transcript):
   - `pi-dispatch init > init.txt` in an empty folder.
   - `pi-dispatch up --yes > up.txt 2>&1` in an empty `~/pi-work`, with a pi login holding a dummy
     Anthropic key in `~/.pi/agent/auth.json`, so the folded doctor ends ready.
   - `pi-dispatch doctor > doctor.txt 2>&1` in the same folder, after removing that pi login, setting a
     dummy `ANTHROPIC_API_KEY` in `.env`, and adding a github label trigger with flow `fix` and a
     `run.skillsDir` of `~/pi-work/skills` holding one skill. No gh login, so its warning shows.
2. Replace the account's home with `~` in each file. Nothing else in them names the host:

   ```sh
   sed -i -e 's#/home/you/#~/#g' -e 's#/home/you\b#~#g' init.txt up.txt doctor.txt
   ```

   This turns `/home/you/pi-work` into `~/pi-work` and `/home/you/.pi-dispatch` into `~/.pi-dispatch`.
   Keep `/tmp/pi-dispatch-1000` (the jobs dir of uid 1000) and `HOME=/home/pi` (the job container's home,
   not the host's) as printed.
3. Render:

   ```sh
   node launch/transcript-svg.mjs --title "~/pi-work · pi-dispatch doctor" --prompt '$ pi-dispatch doctor' doctor.txt > docs/images/cli-doctor.svg
   ```

4. Bump the `?v=` on each changed image in the README, so GitHub's image cache fetches the new one.

`cli-service-windows.svg` is `service render` with `platform: "win32"` and Windows paths passed through
`runService`'s seams, titled `PowerShell · C:\Users\you\pi-work`.

## The console images

The web console is the main image now. Every console image in `docs/images/console/` is one of the console's goldens
(`admin/test/fixtures/console/`) in headless Chrome, listed in `launch/console-picks.mjs`:

```sh
node launch/render-images.mjs --console              # the READMEs' picks, into docs/images/console/
node launch/render-images.mjs --console --all        # every golden at 1440 and 375, light and dark, into docs/images/console/all/
node launch/render-images.mjs --console --only panels/confirm-done.operator   # any one state
```

It needs Google Chrome and no server. `--all` is about a gigabyte and four minutes, and its folder is gitignored. After a change to the look,
re-render the picks and bump the `?v=` on each changed image, since no test catches a stale PNG.

## The insights image

`docs/images/insights-view.png`, the console's Spend page, is drawn on demand by the shipped code over one canned deployment:

```sh
node launch/render-images.mjs          # docs/images/insights-view.png
```

What it needs:

- `valkey-server` or `redis-server` on PATH. The script starts its own on a free port of 127.0.0.1, with no
  persistence and its files in a temporary directory, and stops it at the end. `--url redis://host:port/<db>` uses
  an existing database instead; it must be empty, and is emptied again when the script ends.
- Google Chrome: `/Applications/Google Chrome.app/...` on macOS, or set `CHROME` to its executable.
  It is driven headless over its DevTools pipe, with every host name mapped to nothing.
- git (the insights topology reads the two job folders' flow gate from git).

The deployment is `launch/fixture-deployment.mjs`: three hosts (`mini1`, `mini2`, `build3`), four projects (`web`,
`api`, `billing`, `ops`), repos under `acme`, a month of run records, all dated around one frozen instant and written
through the worker's own record, mirror, registry, budget, wait and allocation code. Its config and its records agree:
no run breaks a cap, a scoped limit, a host's slots or budget, or a project's share. build3 keeps its own logs for 7
days and trims the shared run mirror by them, so its history here starts at the age cutoff of its last trim that
removed a run (that write's time less 7 days), and the insights page hatches the time before as no data. The script empties its
environment before anything loads, so no key or deployment of the machine running it is read, and nothing is fetched.
The page is the console's `/insights?range=30d` page over that fixture, shot at 1240 px and device scale 2,
full page. The PNG is Chrome's rendering and is not held to bytes.

After a render, bump the `?v=` on each changed image in the README, so GitHub's image cache fetches the new one.
