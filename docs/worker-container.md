# Linux Compose worker

The worker can run in a container on a Linux server with a local Docker Engine. Compose starts Valkey and the worker together; the optional receiver can run in its own container too. The job agent still runs in a fresh job container created by the worker.

## What the worker container can control

The worker container receives `/var/run/docker.sock` and the host's Docker CLI. Anyone who can control that socket can ask the daemon to start privileged containers, mount host files and take control of the machine. Running the worker as uid 10001 and dropping Linux capabilities hardens its own process, but does not reduce the authority of the Docker socket. The socket is mounted only into the trusted worker container, never into a job container.

Keep the Docker socket on the Unix socket. Do not expose the daemon on TCP port 2375. Docker Desktop, Windows and remote Docker contexts use the host worker because the daemon's filesystem is different from the client filesystem.

## Path rule

The Docker daemon resolves bind mount paths on its host. Run Compose from the deployment directory: `${PWD}` supplies the same absolute path for the worker's cwd, deployment mount target, console deployment and runtime files. The worker and console execute code from `/opt/pi-dispatch` by absolute path, but read deployment policy files from the live mount. A Docker source path outside that mount is invalid unless you add the path as another bind mount at the identical absolute path in both places.

Keep local-folder projects under `/root/pi-dispatch/projects`, or add their parent directory as a same-path mount to the worker service. Files in a mounted local project must be writable by uid 10001, which is also the uid used by a job on this native Linux Docker host.

## Set it up

Run from the deployment directory on the Linux server:

```bash
cp .env.example .env
chgrp 10001 .env
chmod 640 .env
mkdir -p runtime projects
chown -R 10001:10001 runtime projects
```

The worker reads `PI_VALKEY_SHARED` from `.env` at startup, so in this Compose mode the non-root uid 10001 needs
read access to the file. Keep root as owner and group 10001 as read-only; do not make `.env` group-writable or
world-readable. The same credentials are already passed to the trusted worker/console processes by Compose.

Edit `.env` and set a fresh `VALKEY_PASSWORD` plus provider and forge credentials for the triggers you will use. `openssl rand -hex 32` makes a suitable Valkey password. The worker service sets `VALKEY_URL` to Compose's `valkey` service and uses the pinned job image for this release.

Store the host Docker socket's group id and the Docker CLI path in `.env`, then scaffold the deployment from the worker image. Compose needs these values again whenever it recreates the worker:

```bash
cat >> .env <<EOF
DOCKER_GID=$(stat -c '%g' /var/run/docker.sock)
DOCKER_CLI_BIN=$(command -v docker)
EOF
docker compose --env-file .env -f deploy/docker-compose.yml --profile worker build worker
docker compose --env-file .env -f deploy/docker-compose.yml --profile worker run --rm --user 0 worker node /opt/pi-dispatch/worker/src/cli.mjs init
mv triggers.json pause-windows.json scoped-limits.json projects.json runtime/
cat >> .env <<'EOF'
PI_TRIGGERS_FILE=${PWD}/runtime/triggers.json
PI_PAUSE_WINDOWS_FILE=${PWD}/runtime/pause-windows.json
PI_SCOPED_LIMITS_FILE=${PWD}/runtime/scoped-limits.json
PI_PROJECTS_FILE=${PWD}/runtime/projects.json
PI_JOBS_DIR=${PWD}/runtime/jobs
PI_LOGS_DIR=${PWD}/runtime/logs
PI_SANDBOX_DIR=${PWD}/runtime/sandboxes
PI_SETTINGS_FILE=${PWD}/runtime/settings.json
EOF
chown -R 10001:10001 runtime projects
```

Build and start the worker profile:

```bash
docker compose --env-file .env -f deploy/docker-compose.yml --profile worker --profile egress up -d --build
```

The worker container image uses the repository's pinned Node base, installs the workspace from the lockfile, and runs as uid/gid `10001:10001`. The bind mount preserves the daemon's view of the job paths. Build or pull the exact job image named by `PI_JOB_IMAGE` before enabling triggers:

```bash
docker pull ghcr.io/edgehero/pi-job:4.3.1
```

To run the browser console as a container, first create its operator token. The console profile has no Docker socket and
publishes port 4790 on all host interfaces; add the host name or IP clients will use to `PI_CONSOLE_ALLOWED_HOSTS` in
`.env`:

```bash
docker compose --env-file .env -f deploy/docker-compose.yml --profile console run --rm --no-deps console \
  node /opt/pi-dispatch/admin/src/console/cli.mjs token add --name you --role operator --deployment "$PWD"
docker compose --env-file .env -f deploy/docker-compose.yml --profile console up -d
```

Save the one-time token output. Open `http://<host-address>:4790/` and sign in with it. This is plain HTTP; use a
trusted TLS proxy on a network you trust.

To run the webhook receiver in Compose as well, add `--profile receiver` to the command. Its bind mount reads the absolute `PI_TRIGGERS_FILE` from `.env`. Keep its port on loopback and put a TLS reverse proxy or tunnel in front of it, as described in [GitHub automation](github.md#three-ways-to-run-the-trigger-edge).

Use `docker compose --env-file .env -f deploy/docker-compose.yml --profile worker --profile egress logs -f worker` to follow the worker. The same command ending in `stop worker` lets running jobs finish according to the worker's shutdown rules. `docker compose ... down` removes the services but keeps the Valkey named volume; do not add `-v` unless you intend to delete the queue.

## Limitations

- This mode requires Linux, local Docker Engine, Compose, the host Docker CLI binary and a readable/writable same-path bind mount.
- The worker process must not run as uid 0. The compose service uses uid/gid 10001 and adds the host socket's group.
- Local-folder jobs can access only the deployment tree and any additional same-path roots mounted into the worker.
- The Docker socket grants host-root-equivalent authority to the worker. Do not run untrusted code in the worker image, and do not mount the socket into any job image or receiver.
- The host worker remains the portable mode for Docker Desktop, Windows and remote Docker contexts.
