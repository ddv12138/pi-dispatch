# pi-dispatch

**把日常的例行开发工作交给 AI 编码代理,你来决定盯着它到什么程度。**

pi-dispatch 在你自己的 Linux 服务器上后台运行 [pi](https://github.com/earendil-works/pi) 编码代理。你告诉它做什么、什么时候做:定时任务、issue 标签、一条评论都行。每个任务都在一个用完即弃的容器里跑,到轮数上限就停,全过程在一个网页上实时可见。在代码托管平台上,任务干完会给你提一个 pull request 等你审;什么能进你的默认分支,始终由人决定。

免费开源(MIT)。AI 用量费用由你付给模型厂商,或者用你已有的订阅。

## 安装

一台常开机的 Linux 主机(VM、VPS 或家里的服务器都行),装好 Docker Engine(带 Compose 插件)和 git。任务在容器里跑,所以主机上什么都不用再装:不用 npm install,没有包装脚本。另外需要:一个 AI 厂商的 key;如果任务要碰 GitHub,还需要一个 fine-grained PAT 放进 `GITHUB_PAT`,只授权给任务要用的仓库。所有配置都是 `.env` 里的一个键,`.env.example` 里每一项都有注释说明。

**1. 克隆仓库,写 `.env`。** 放在一个不会挪走的目录里:

```bash
git clone https://github.com/ddv12138/pi-dispatch.git my-dispatch
cd my-dispatch
cp .env.example .env
```

然后编辑 `.env`:填上厂商 key 和模型、`GITHUB_PAT`、`PI_SESSIONS_DIR`,以及允许任务访问的主机列表。

**2. 启动。** 镜像有两种来法:每次合入 main,CI 都会把构建好的镜像发布到 Docker Hub,先 `pull` 再 `up` 就直接用;本地没有镜像时,`up` 也会用旁边的源码现场构建(compose 里的 `build:` 块就是干这个的):

```bash
C="docker compose --env-file .env -f deploy/docker-compose.yml"
$C --profile worker --profile console pull     # 用 CI 发布的镜像;想本地构建就跳过这行
$C --profile worker --profile console up -d
```

这条命令会启动 Valkey、worker 和 console。receiver(`--profile receiver`)和出网代理(`--profile egress`)是可选的,用到再开;四者里只有 receiver 可能需要暴露到公网,而且只为了收 webhook——没有公网地址的话,用它的 `poll` 模式轮询就行,不需要公网。

**3. 创建 console 令牌并登录。** 没有操作员令牌,console 会拒绝服务:

```bash
docker exec deploy-worker-1 node /opt/pi-dispatch/admin/src/console/cli.mjs token add --name you --role operator
docker compose --env-file .env -f deploy/docker-compose.yml --profile console restart console
docker exec deploy-console-1 node /opt/pi-dispatch/admin/src/console/cli.mjs link --name you
```

第一条命令把令牌打印一次,把它粘贴到 `http://<主机>:4790/` 登录;或者直接打开最后一条命令生成的一次性链接。要从别的机器访问,把那个地址加进 `.env` 的 `PI_CONSOLE_ALLOWED_HOSTS`,然后重建 console 容器。console 是明文 HTTP:不可信的网络里请走 TLS 代理或 SSH 隧道。

首次打开时,console 会列出哪些就绪、哪些没配好(队列、worker、网络规则、厂商 key、第一个触发器),并给出配置菜谱。worker 容器里的 `doctor --live` 可以做一遍全量自检。想在终端里控制队列,worker 容器里的 CLI 直连 Valkey:`pause`、`resume`、`status`、`cancel <jobId>`、`run --trigger <id>`、`capacity`。

## 怎么用

**触发器(trigger)决定什么时候干活。** 所有触发器写在一个 `triggers.json` 里,worker 和 receiver 实时读取,console 也能改。每条触发器是一对 `{ on, run }`:`on` 说什么时候触发(定时、issue 标签、评论关键词、PR 事件、issue 关闭),`run` 说干什么:

```jsonc
{ "on": { "type": "label", "any": ["pi:fix"] }, "run": { "kind": "github", "flow": "fix" } }
```

`run` 指向一个 **flow**(流程文件)——一份 Markdown 指令,放在目标仓库的 `.pi/skills/<flow>/SKILL.md`,从默认分支读取,所以同一个 flow 名字,每个仓库可以有自己的写法;也可以指向一个已注册的 pi `command`。[triggers.example.json](triggers.example.json) 用注释写全了每种触发器和每个字段;[examples/](examples/) 有一套能直接抄的 `.pi` 样例。

**谁能触发任务,由你的托管平台决定,pi-dispatch 不另设门槛。** GitHub 上,只有协作者的标签、`@pi` 评论或正式 review 能启动任务——陌生人的 fork PR 不会自己启动任何东西。GitLab 上要求项目成员有 Developer 及以上权限,每次投递都实时查一次。Forgejo 要求 owner、admin 或 write 权限,同样每次都查。Azure DevOps 是四家里传输最弱的(没有 HMAC 签名),要开请格外小心配置。

**任务能碰什么。** 托管平台上的任务在默认分支的全新副本上干活,干完提 PR;默认分支没开分支保护的仓库会被直接拒绝。本地文件夹的任务是直接改那个文件夹的,没有撤销:文件夹里有未提交改动时它会拒绝启动,而且只应该指向你愿意从备份恢复的文件夹。

**模型。** 在 `.env` 里选厂商和模型(`PI_PROVIDER`、`PI_MODEL`、key);单条触发器可以用 `run.provider` 和 `run.model` 覆盖,用 `run.fallbackModels` 按顺序列备用模型。你已有的订阅也能用,但要通过显式连接配置——见 `.env.example` 里的 `PI_AUTH_CONNECTIONS_FILE`。可选的全局 pi 配置(`PI_GLOBAL_PI_DIR`)会以只读方式挂进每个任务、垫在仓库自己的 `.pi/` 下面;里面不能放任何凭证。

## 它怎么保护你

每个任务一个一次性容器:`--cap-drop=ALL`、no-new-privileges、内存/CPU/进程数限制、非 root 运行;网络默认全拒,只放行你列出的主机,每个任务单独一个网络、走代理出去。单任务轮数上限、并发数、每台主机的内存/CPU 预算共同限制一次运行;没有 token 或金额上限,所以**去你的 AI 厂商那里设一个消费限额**——那才是账单的硬顶。每次运行的 token 用量和花费都有记录、有展示。

两件事要说透。第一,agent 在容器里能读到你的厂商 key 和托管平台 token,告诉它别泄露的那段话只是提示词,不是强制——所以 key 靠厂商限额兜底,token 只授权给任务要用的仓库、定期轮换。第二,worker 拿着宿主机的 Docker socket,权限等于 root——只跑在你自己控制的机器上。这个项目自己的代码不调用任何 merge API,任务最多只能合并它的提示词明确授权的那一个 PR、只合进 `pi/issue-*` 分支;**默认分支的分支保护才是真正的闸门**,没开的仓库 worker 直接拒绝运行。

## 给开发者

```bash
git clone https://github.com/ddv12138/pi-dispatch && cd pi-dispatch
npm ci
npm test
```

CI(GitHub Actions)在每个 push 和 PR 上跑全量测试;合入 main 或打 `v*` tag 后,测试通过会自动把控制面镜像发布到 Docker Hub——worker 和 console 共用一个镜像,receiver 一个(`latest` 跟随最新,`sha-<sha>` 钉住每个构建用于回滚,`v*` tag 加版本号)。**任务镜像(`pi-job`)不走 CI**,由 `./image/publish.sh` 从本机构建发布:发布过的版本 tag 永不移动,Java 镜像还要把单个部署的 Maven 网络设置烤进去,这些是共享 runner 做不到的。

测试用 `node:test` 加手写的注入假件,不联网、不碰 Docker。少数集成测试需要真的 Valkey——起一个(compose 文件里的 `valkey` 服务就行)并设 `VALKEY_TEST_URL=redis://127.0.0.1:6379`,否则它们跳过。跑测试时让 `HOME` 指向临时目录外的空目录、用个短的 `TMPDIR`。任务启动带 `--pull=never`,所以先把用到的镜像 build 或 pull 好。pi 及其包保持精确锁版本。提交请用 `git commit -s` 签名:本项目遵循 [DCO](https://developercertificate.org/),不签 CLA。

| 目录 | 是什么 |
|---|---|
| `worker/` | 队列消费者、CLI(`pi-dispatch`)、各家托管平台的接入、doctor |
| `receiver/` | 常驻的触发入口(`pi-dispatch-receiver`):webhook 路由和轮询 |
| `admin/` | 网页控制台(`pi-dispatch-console`) |
| `gateway/` | 可选的沙箱浏览器终端 |
| `image/` | 任务镜像,以及镜像里的 runner |
| `deploy/` | Compose 文件、worker 镜像、出网代理配置 |
| `docs/` | 253 服务器部署手册和 agent 技能说明 |
| `launch/` | 控制台测试共用的固定部署和浏览器管线 |

## 许可证

MIT,见 [LICENSE](LICENSE)。基于 [pi](https://github.com/earendil-works/pi)(Mario Zechner 作),真正难的部分是它做的。与 npm 上同名的 `pi-dispatch` 包(一个轮换 ChatGPT Codex OAuth 账号的 pi 扩展)没有任何关系——同名,不同物。本项目不发布到 npm:从仓库检出运行,跑在容器里。
