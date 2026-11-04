# Control-plane worker image. Job images remain separate, single-use containers built from image/Dockerfile.
FROM node:22.22.3-bookworm-slim@sha256:e21fc383b50d5347dc7a9f1cae45b8f4e2f0d39f7ade28e4eef7d2934522b752

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 dispatch \
    && useradd --uid 10001 --gid 10001 --home-dir /home/dispatch --create-home --shell /usr/sbin/nologin dispatch \
    && mkdir -p /root/pi-dispatch /usr/local/bin \
    && chmod 0755 /root \
    && touch /usr/local/bin/docker \
    && chmod 0755 /usr/local/bin/docker

WORKDIR /opt/pi-dispatch
COPY . .
RUN npm ci --omit=dev --ignore-scripts

ENV NODE_ENV=production
USER 10001:10001
CMD ["node", "worker/src/cli.mjs", "worker"]
