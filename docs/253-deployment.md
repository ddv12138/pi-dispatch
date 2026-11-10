# 253 服务器部署

本文描述 `root@192.168.99.253` 上部署了什么。部署目录是 `/root/pi-dispatch`，没有 Git 元数据；`.env` 和
`runtime/` 保存留在服务器上、不随快照走的状态。

## 布局

- Compose 项目 `deploy`，来自唯一随仓库发布的文件 `deploy/docker-compose.yml`。没有 override 文件：文件读取
  的每个值都是 compose 变量或 `.env` 里的键。`deploy/` 只放该文件、`worker.Dockerfile`、
  `worker.Dockerfile.dockerignore`、`egress-proxy.conf` 和 `triggers.json`——没有宿主机服务定义，也没有环境
  包装脚本。
- `worker` 和 `console` 两个 profile 运行本地构建的 `deploy-worker` 镜像（应用在 `/opt/pi-dispatch`），部署
  目录按同样的绝对路径挂载进去，因此 job 路径在 daemon 主机上可以解析。worker 持有宿主机 Docker socket；
  console 用同一镜像但不挂 socket。
- `receiver` profile 从本快照的 `receiver/Dockerfile` 构建 `deploy-receiver`，不从任何 registry 拉取。它发布
  `${PI_RECEIVER_PUBLISH:-127.0.0.1}:3000`，这台主机在 `.env` 里设 `PI_RECEIVER_PUBLISH=192.168.99.253`。
- 端口：console `4790` 监听所有宿主接口、明文 HTTP；Valkey `127.0.0.1:6379`；receiver
  `192.168.99.253:3000`。
- Egress 已启用（`PI_EGRESS` 未设置），job 前面有 `pi-dispatch-egress-proxy` 容器。
- 运行状态在 `/root/pi-dispatch/runtime` 下：`jobs/`、`logs/`、`sandboxes/`、`tmp/`、`home/`、trigger 与
  settings 文件，以及只读 job overlay `pi-global/`。
- 运行五个容器：`valkey`、`worker`、`console`、`receiver`、`egress-proxy`。

## 运行 compose

Compose 从部署根目录运行，带 env 文件和随仓库发布的 compose 文件：

```bash
cd /root/pi-dispatch
docker compose --env-file .env -f deploy/docker-compose.yml up -d worker console
```

cwd 和 env 文件都是必须的：worker 与 console 通过 `"../:${PWD}"` 挂载代码树，`DOCKER_GID` 来自 `.env`，
worker 据此加入 socket 的组。receiver 在 `profiles: ["receiver"]` 后面，重启要带该 profile：

```bash
docker compose --env-file .env -f deploy/docker-compose.yml --profile receiver restart receiver
```

## job 镜像

job 镜像从 checkout 构建并推送，不走 CI：`./image/publish.sh` 负责构建和推送。

| 仓库 | 谁在运行 |
|---|---|
| `docker.io/ddv12138/pi-job` | 所有没有自己 `run.image` 的 job |
| `docker.io/ddv12138/pi-job-java21` | Java flow，经由该 trigger 的 `run.image` |

两个镜像都带 `python3`、三个 baked skill 和本仓库的 runner；Java 那个额外带 JDK 21 和 Maven。这台主机两个
都用 `4.3.5`，即当前发布版本。

worker 服务把默认 job 镜像作为 compose 插值默认值，`.env` 覆盖它，所以只有 `.env` 缺少该键时随仓库的默认值
才生效。这台主机的 `.env` 把 `PI_JOB_IMAGE` 固定为 `docker.io/ddv12138/pi-job:4.3.5`；这两个 tag 就是主机上
全部的 job 镜像。

job 以 `--pull=never` 启动，运行时不拉取任何东西。这台主机无法直连 Docker Hub（`registry-1.docker.io`
拒绝），拉取走 `/etc/docker/daemon.json` 里配置的 registry mirror。`PI_JOB_IMAGE` 在创建容器时读取，
所以运行中的容器一直用它创建时的值，直到 worker 被重建。

