# 253 服务器部署

本文描述 `root@192.168.99.253` 上部署了什么。部署目录是 `/root/pi-dispatch`，没有 Git 元数据；`.env` 和
`runtime/` 保存留在服务器上、不随快照走的状态。

## 布局

- Compose 项目 `deploy`，来自唯一随仓库发布的文件 `deploy/docker-compose.yml`。没有 override 文件：文件读取
  的每个值都是 compose 变量或 `.env` 里的键。`deploy/` 只放该文件、`worker.Dockerfile`、
  `worker.Dockerfile.dockerignore`、`egress-proxy.conf` 和 `triggers.json`——没有宿主机服务定义，也没有环境
  包装脚本。
- `worker` 和 `console` 两个 profile 运行 `docker.io/ddv12138/pi-dispatch-worker:latest`（应用在
  `/opt/pi-dispatch`），从 Docker Hub 拉取。该镜像由 GitHub Actions（`.github/workflows/images.yml`）在每次
  push main 时构建并推送——与测试套件（`.github/workflows/ci.yml`）并行、不被测试门禁：部署端是显式
  pull，拉取前可以先看测试状态，且每个构建都会落一个不可变的 `sha-<短sha>` tag 可钉住或回滚。
  `latest` 随 main 移动，`v*` git tag 会推出版本号 tag。compose 里保留的 `build:` 块只服务本地开发——
  服务器上不在现场构建。部署目录按同样的
  绝对路径挂载进容器，因此 job 路径在 daemon 主机上可以解析。worker 持有宿主机 Docker socket；console 用
  同一镜像但不挂 socket。
- `receiver` profile 运行 `docker.io/ddv12138/pi-dispatch-receiver:latest`，同样由 CI 构建推送、部署端
  拉取，不在现场构建。它发布 `${PI_RECEIVER_PUBLISH:-127.0.0.1}:3000`，这台主机在 `.env` 里设
  `PI_RECEIVER_PUBLISH=192.168.99.253`。
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
worker 据此加入 socket 的组。receiver 在 `profiles: ["receiver"]` 后面，操作它要带该 profile：

```bash
docker compose --env-file .env -f deploy/docker-compose.yml --profile receiver restart receiver
```

## 更新与回滚

日常更新就是两步——本地 push 触发 CI（测试 + 构建推送镜像）之后，在部署根目录：

```bash
cd /root/pi-dispatch
docker compose --env-file .env -f deploy/docker-compose.yml \
  --profile worker --profile console --profile receiver pull
docker compose --env-file .env -f deploy/docker-compose.yml \
  --profile worker --profile console --profile receiver up -d
```

- 必须先 `pull` 再 `up`：compose 文件里保留了 `build:` 块，镜像在本地存储缺失时 `up` 会退回现场构建；先
  `pull` 把 registry 镜像放进本地存储，`up` 才会使用它。
- valkey 和 egress-proxy 不在这两个命令的 profile 里，正在运行的它们不受影响。
- worker 有 35s 优雅停机，console 15s；挑没有 job 在跑的时候执行。
- 这台主机无法直连 Docker Hub，拉取走 `/etc/docker/daemon.json` 里的 registry mirror（与拉 job 镜像同一
  条路）。
- 只有 `deploy/docker-compose.yml` 本身变化（端口、挂载、环境变量）才需要从仓库把该文件 scp 过来；镜像
  更新不需要同步任何文件。

回滚：把上一个构建的 `sha-<短sha>` tag 写进 `.env` 钉住引用，再 pull + up：

```bash
PI_WORKER_IMAGE=docker.io/ddv12138/pi-dispatch-worker:sha-<短sha>      # worker + console
PI_RECEIVER_IMAGE=docker.io/ddv12138/pi-dispatch-receiver:sha-<短sha>  # 仅回滚 receiver 时
```

恢复到最新后再把该键从 `.env` 删掉或更新，否则部署会一直钉在旧镜像上。

## job 镜像

job 镜像不走 CI：从 checkout 在本机构建并推送，`./image/publish.sh` 负责构建和推送（版本 tag 不可变，且
Java 镜像烘焙了本部署网络的 Maven 代理配置——CI 共享 runner 无法知道这些，见该脚本头注释）。

| 仓库 | 谁在运行 |
|---|---|
| `docker.io/ddv12138/pi-job` | 所有没有自己 `run.image` 的 job |
| `docker.io/ddv12138/pi-job-java21` | Java flow，经由该 trigger 的 `run.image` |

两个镜像都带 `python3`、三个 baked skill 和本仓库的 runner；Java 那个额外带 JDK 21 和 Maven。这台主机两个
都用 `4.3.5`，即当前发布版本。

worker 服务把默认 job 镜像作为 compose 插值默认值，`.env` 覆盖它，所以只有 `.env` 缺少该键时随仓库的默认值
才生效。这台主机的 `.env` 把 `PI_JOB_IMAGE` 固定为 `docker.io/ddv12138/pi-job:4.3.5`；这两个 tag 就是主机上
全部的 job 镜像。

job 以 `--pull=never` 启动，运行时不拉取任何东西。`PI_JOB_IMAGE` 在创建容器时读取，所以运行中的容器一直用
它创建时的值，直到 worker 被重建。
