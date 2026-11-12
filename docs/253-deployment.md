# 253 服务器部署

本文描述 `root@192.168.99.253` 上部署了什么。部署目录是 `/root/pi-dispatch`，没有 Git 元数据；`.env`、
`egress-allowlist.conf`、`model-endpoints.conf`、`maven-repo/` 和 `runtime/` 是留在服务器上、不随快照走的
状态——同步 checkout 时必须保留（2026-11-10 的一次 checkout 同步曾把两个 conf 文件删掉，导致 egress-proxy
重建即不可用，后从运行中容器原样恢复；`maven-repo/` 是 2026-11-12 加入的私有 Maven 构件托管目录，见下文
"Maven 依赖代理"一节）。

## 布局

- Compose 项目 `deploy`，来自唯一随仓库发布的文件 `deploy/docker-compose.yml`。没有 override 文件：文件读取
  的每个值都是 compose 变量或 `.env` 里的键。`deploy/` 放该文件、`worker.Dockerfile`、
  `worker.Dockerfile.dockerignore`、`egress-proxy.conf`、`maven-proxy.conf`、`skills/`、`triggers.json` 和
  `triggers.ticket.example.json`——没有宿主机服务定义，也没有环境包装脚本。其中 `skills/`（ticket-merge、
  ticket-run 两个 flow）是必须项：compose 把它只读挂载到 worker 容器的 `/opt/pi-skills`，再由 worker 复制进
  每个 job 的 `/job/trigger-skills`；挂载源缺失时 Docker 会静默创建空目录，job 不报错但拿不到 skill。
  两个 triggers 文件都是示例脚手架，这台部署上没有组件读它们的内容（生效文件见下面 runtime 那一条）。
  历次服务器改动留过一批 `<文件>.bak-<时间戳>` 备份（根目录的 `.dsh-backup-ts` 是其中两轮的标记），
  2026-11-11 清理过一次：`.env` 和 trigger 备份每类只留最新一份，现行 compose 文件经比对与仓库逐字节
  一致，它的备份直接删除。之后再累积就再清。
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
  `192.168.99.253:3000`。egress-proxy 和 maven-proxy 都不发布任何宿主端口，只在容器网络内可达。
- Egress 已启用（`PI_EGRESS` 未设置），job 前面有 `pi-dispatch-egress-proxy` 容器。
- Maven 已启用（`maven` profile）：`pi-dispatch-maven-proxy` 为 Java job 缓存公开依赖并只读托管私有构件，
  详见下文 "Maven 依赖代理"。
- 运行状态在 `/root/pi-dispatch/runtime` 下：`jobs/`、`logs/`、`sandboxes/`、`tmp/`、`home/`、trigger 与
  settings 文件，以及只读 job overlay `pi-global/`。生效的触发器文件是 `runtime/triggers.json`：worker 与
  console 的 `PI_TRIGGERS_FILE` 由 compose 固定指向它，receiver 的挂载源默认是 `deploy/triggers.json`，但这
  台部署的 `.env` 设了 `PI_TRIGGERS_FILE=/root/pi-dispatch/runtime/triggers.json`，三个服务因此读同一个
  文件。`deploy/triggers.json` 只是 init 脚手架，内容与 runtime 文件无关，改它不生效。
- 运行六个容器：`valkey`、`worker`、`console`、`receiver`、`egress-proxy`、`maven-proxy`。
- 这台部署的 `.env` 设了 `COMPOSE_PROFILES=worker,console,receiver,egress,maven`，因此带 `--env-file .env`
  的普通 `up` 会启动全部六个服务；`--profile` 只在别的部署、或临时单独操作某个服务时才需要。

## GitLab 触发白名单

`.env` 的 `GITLAB_ALLOWED_ACTORS` 可以把 `/gitlab` 的触发者收窄到一份名单。未设时行为不变：项目成员
Developer 及以上就能触发。设了以后，触发者必须同时在名单里，并且仍然是 Developer 及以上——白名单是
叠加的第二道门槛，不是替代，所以从项目里移除的人不会被一份旧名单放回来。

值是逗号分隔的**数字** GitLab 用户 id，不是用户名。取 id 有两种方式：读 receiver 启动日志里的
`self_identity`（`forge: "gitlab"`）拿 PAT 主人自己的 id；或对任意成员用
`curl -H "PRIVATE-TOKEN: $GITLAB_TOKEN" "$GITLAB_URL/api/v4/user"` 拿当前 token 的 id。空值
（`GITLAB_ALLOWED_ACTORS=`）会在启动时报错，不会被理解成“所有人”或“没人”。

这台部署已经设了 `PI_RECEIVER_ALLOW_SELF=1`，所以可以在名单里写 PAT 主人（张三）自己的 id。反过来，
如果哪天关掉该开关，名单里又写着 PAT 主人，receiver 会拒绝启动并指出这两行配置互相矛盾——机器人的
循环防护会先丢掉那个账号的所有投递，白名单根本轮不到。失败在启动时比“能启动但永远不触发”更容易发现。

落地顺序不能反：

1. 先合入代码并发布新的 receiver 镜像。旧镜像不认识这个变量，设了也不会生效。
2. 在 `/root/pi-dispatch/.env` 加 `GITLAB_ALLOWED_ACTORS=<张三的 id>`。compose 的 receiver 用
   `env_file: ../.env`，不需要改 `deploy/docker-compose.yml`。
3. `docker compose --env-file .env -f deploy/docker-compose.yml --profile receiver up -d receiver`。
4. 确认启动日志里有 `gitlab_allowed_actors`，并列出预期的 id。

验证：让不在名单里的人给 issue 加 `ready-for-agent`，receiver 应返回 204 并在日志里记
`dropped reason: actor-not-allowed`；名单内的人做同样操作会正常入队。

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

## 资源约束

这台主机是 4 核（CentOS 7，cgroup v1）。`.env` 设 `PI_CONCURRENCY=1`、`PI_HOST_CPU_BUDGET=3`：
一次只跑一个 job，单容器的 `--cpus` 由 3 CPU 的 host budget 决定，留 1 核给 worker、Valkey 和宿主。
`PI_JOB_CPUS=1` 只用于预算记账和 cpu-shares，不是硬上限。cgroup v1 上 worker 启动会报
`cpu_reserve_fail_open reason=cgroup-v1`，意思是父 cgroup 的聚合配额落不下去，不是单容器没有限制。

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
- 这台主机无法直连 Docker Hub，拉取走 systemd drop-in（`/etc/systemd/system/docker.service.d/afk-proxy.conf`）
  配置的 HTTP 代理——运维者 Mac 上的 `192.168.3.120:1080`。Mac 合盖、休眠或代理应用没开时，253 拉不了任何
  镜像（afk 之名由此而来），日常更新要挑代理在线的时候。registry mirror 已于 2026-11-10 删除：旧的阿里云
  个人加速域名已停办（直连 403），`daemon.json` 现在是空配置，拉取只有代理这一条路。
- 只有 `deploy/docker-compose.yml` 本身变化（端口、挂载、环境变量）才需要从仓库把该文件 scp 过来；镜像
  更新不需要同步任何文件。

回滚：把上一个构建的 `sha-<短sha>` tag 写进 `.env` 钉住引用，再 pull + up：

```bash
PI_WORKER_IMAGE=docker.io/ddv12138/pi-dispatch-worker:sha-<短sha>      # worker + console
PI_RECEIVER_IMAGE=docker.io/ddv12138/pi-dispatch-receiver:sha-<短sha>  # 仅回滚 receiver 时
```

恢复到最新后再把该键从 `.env` 删掉或更新，否则部署会一直钉在旧镜像上。

运维提醒：如果曾用 rsync/checkout 方式同步部署目录，同步后必须运行 `pi-dispatch doctor`——它会对
egress-proxy 的挂载做 drift 检查，allowlist 缺失时会明确报 "does not exist on this host"。

## job 镜像

job 镜像不走 CI：从 checkout 在本机构建并推送，`./image/publish.sh` 负责构建和推送（版本 tag 不可变。
4.3.6 及更早的 Java 镜像把本部署网络的 Maven 代理配置烘焙在镜像里；4.3.7 起改为运行时渲染，见上文
"Maven 依赖代理"——Dockerfile 的 MAVEN_* 构建参数机制保留，但本部署的发布不再传它们）。

| 仓库 | 谁在运行 |
|---|---|
| `docker.io/ddv12138/pi-job` | 所有没有自己 `run.image` 的 job |
| `docker.io/ddv12138/pi-job-java21` | Java flow，经由该 trigger 的 `run.image` |

两个镜像都带 `python3`、三个 baked skill 和本仓库的 runner；Java 那个额外带 JDK 21 和 Maven。这台主机的
默认是 `4.3.7`，即当前发布版本。

worker 服务把默认 job 镜像作为 compose 插值默认值，`.env` 覆盖它，所以只有 `.env` 缺少该键时随仓库的默认值
才生效。这台主机的 `.env` 把 `PI_JOB_IMAGE` 固定为 `docker.io/ddv12138/pi-job:4.3.7`；两个 trigger 都用
`run.image` 覆盖为 `docker.io/ddv12138/pi-job-java21:4.3.7`（2026-11-12 核对）。

2026-11-12 清理后，主机上与这台部署相关的 job 镜像只有两个：`pi-job:4.3.7`（默认）和
`pi-job-java21:4.3.7`（两个 trigger 的 `run.image` 正指着）。4.3.6 及更早的版本 tag、`4.3.5-m2seed` 和
`4.3.6-m2seed` 变体都已从主机删除——版本 tag 在 Docker Hub 上不可变，需要回滚时代理在线重新 pull 即可，
主机不常备旧镜像。`m2seed` 不再是发布路径：4.3.7 起 Java 的 Maven 依赖由运行时缓存代理提供，见下文
"Maven 依赖代理"。

job 以 `--pull=never` 启动，运行时不拉取任何东西。`PI_JOB_IMAGE` 在创建容器时读取，所以运行中的容器一直用
它创建时的值，直到 worker 被重建；`run.image` 指到的 tag 也必须在主机上现成存在，删镜像前先确认没有
trigger 或运行中的容器还钉着它。

## Maven 依赖代理

4.3.7 起 Java job 的 Maven 依赖不再烘焙进镜像：`run.image` 用标准 `pi-job-java21` tag（无 `-m2seed` 变体），
依赖在运行时从 `maven-proxy` 容器拉。该容器是 `deploy/docker-compose.yml` 里 `profiles: ["maven"]` 的
nginx 服务（`pi-dispatch-maven-proxy`，`deploy/maven-proxy.conf` 是它的规则）：公开依赖代理
maven.aliyun.com 并缓存在 `maven-cache` 卷（第一个 job 拉一次，后续复用，metadata 只缓存 10 分钟），私有
构件从宿主机 `/root/pi-dispatch/maven-repo/hosted/` 只读服务。整条链路：

```
job --(http:80)--> pi-dispatch-maven-proxy --(https:443)--> maven.aliyun.com
```

两条链路是分开的。job 到 maven-proxy 受 squid 白名单约束，所以 `egress-allowlist.conf` 里必须有
`pi-dispatch-maven-proxy` 这一行；maven-proxy 到 aliyun 由本容器直接出网——`egress-out` 是普通 bridge，
带 NAT，这一跳不经过 squid，白名单也不约束它。`maven.aliyun.com` 留在白名单里只是为了 job 直连的兜底
场景，不是 maven-proxy 的上游路径。

启用：`--profile egress --profile maven up -d maven-proxy`。默认 `up` 不启动它，与 receiver/console/egress
同一条 opt-in 约定。

### .env 的键

worker 的容器环境里追加这四个键，再靠 PI_FORWARD_ENV 转发进 job 容器（worker/src/env-allowlist.mjs 按精确
名转发，空值跳过）：

```
MAVEN_MIRROR_URL=http://pi-dispatch-maven-proxy
MAVEN_PROXY_HOST=pi-dispatch-egress-proxy
MAVEN_PROXY_PORT=3128
PI_FORWARD_ENV=MAVEN_MIRROR_URL,MAVEN_PROXY_HOST,MAVEN_PROXY_PORT
```

`MAVEN_PROXY_NONPROXY` 不设：转发器跳过空值，渲染器把缺省当作空 nonProxyHosts，与 4.3.6 镜像内烘焙的
行为一致。job 容器没有绕过 squid 的路由；maven-proxy 自身是直接出网，不走 squid。

job 容器内的 `~/.m2/settings.xml` 由 runner 在准备阶段渲染（image/runner/src/maven-settings.mjs）：
`MAVEN_MIRROR_URL` 或 `MAVEN_PROXY_HOST` 任一被转发进来就写，XML 形状与 Dockerfile.java21 的构建时模板
逐字段一致，两者都未设置时什么都不写（非 Java job 零影响）。渲染失败（端口非法、home 不可写等）是
exit 2 的预消费配置错误，不会静默。4.3.7 的标准镜像里全局 settings.xml 是空壳，这个运行时文件是唯一
来源；Dockerfile 的 MAVEN_* 构建参数机制保留做向后兼容，发布时不传。

### 补包流程

构建报 `Could not resolve com.sscloud.xxx:yyy:zzz` 时，把该构件目录从旧 seed 镜像或开发机 `~/.m2` 拷到
宿主机对应路径：

```bash
cp -r ~/.m2/repository/com/sscloud/xxx/yyy/zzz /root/pi-dispatch/maven-repo/hosted/com/sscloud/xxx/yyy/
```

- SNAPSHOT 必须整个版本目录一起拷（含 `maven-metadata.xml`），缺 metadata 时 SNAPSHOT 解析不出具体时间戳
  构件。
- 目录改动即时生效：nginx 只按路径读文件，无需重启容器。
- 拷错/多拷不影响已有内容，`:ro` 挂载保证容器侧改不了这些文件。

## 2026-11-12 job stall

17:44 启动的 Java job 在 17:46 被判 `job stalled`，主机 load 峰值 74。事后核对：job 平均只占 0.32 核，
瓶颈是磁盘 I/O（当时 `%iowait` 31%、dm 队列 1817、await 2.9 秒，job 启动前盘已 97% util）；worker 的锁
续租在 30 秒 TTL 内没有到达 Valkey，BullMQ 的 stall 检查因此判死。判失败后容器没有停，直到人工
`docker stop`。

三个叠加因素：镜像清理的磁盘 I/O 与 Maven 首次构建（1033 次依赖请求、约 1000 个小文件）重叠；
`PI_HOST_CPU_BUDGET=6` 在 4 核机器上超过物理核数，6 并发没有聚合配额；BullMQ 的 stall/失败路径不负责
停容器。已把 `PI_CONCURRENCY` 降到 1、`PI_HOST_CPU_BUDGET` 降到 3。"失败后停容器"仍需代码修复。
