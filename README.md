# Codex Gateway

**本地化的 ChatGPT / Codex 接入网关**：用你自己的 ChatGPT 订阅（OAuth 登录态），对外提供标准 **OpenAI 兼容 API**，覆盖**文本对话、图片生成、视觉理解**能力，并附带可视化管理控制台。

- **开箱即用**：无需数据库、无需容器，Node.js 直接运行；Windows 发布包双击即用
- **默认仅本机**：只监听 `127.0.0.1`；需要时一键开启局域网共享（分用户隔离）
- **可视控制台**：账号登录与多账号切换、用量监控、模型管理、API Key 签发、调用日志、图片素材管理

| 你的角色 | 入口 |
|---|---|
| **宿主机**（自己用 / 给同事发 Key） | 本页[快速开始](#快速开始宿主机) |
| **局域网用户**（用别人电脑上的网关） | 浏览器打开 `http://<宿主机IP>:4173/setup`，输入管理员发的 Key，按页面指引复制/下载配置即可（**零命令行**） |
| **维护者**（构建发布包） | [`docs/RELEASE.md`](docs/RELEASE.md) |

> 使用前请务必阅读[合规与使用须知](#合规与使用须知)。

## 功能总览

- **OpenAI 兼容 API**：`/v1/chat/completions`、`/v1/responses`、`/v1/models`、`/v1/images/generations`——任意 OpenAI 兼容客户端（WorkBuddy、ChatBox、Open WebUI、curl 等）填地址 + Key 即用
- **图片生成**：API 直接生图，或以 **MCP 工具**供任意支持 Function Calling 的模型 / Agent 调用；生成结果自动进入**分用户网页素材站**（预览 / 复制链接 / 下载 / 删除）
- **局域网共享**：一条命令开放给同网段设备；每个成员使用独立 API Key，调用与图片素材按 Key 隔离
- **多账号登录**：控制台内完成 OAuth 授权，支持多账号保存与切换；可配置出网代理适配受限网络；本机装过 Codex CLI 时可**一键导入 `~/.codex/auth.json` 的现有登录态**（无需再走浏览器授权）

## 架构一览

```mermaid
flowchart LR
    A["浏览器<br/>可视控制台"] --> L["启动器 :4173<br/>控制台托管 · API 鉴权 · 管理接口"]
    C["OpenAI 兼容客户端<br/>WorkBuddy / ChatBox / curl"] --> L
    L -->|"有效 cgw- Key"| B["内置代理<br/>文本 · 生图 · 视觉"]
    L -.->|"/__gw 管理（仅本机）"| A
    B -->|"OAuth 登录态"| U["ChatGPT / Codex 上游"]
```

一个 Node 进程搞定一切：启动器托管控制台页面、对外提供鉴权后的 OpenAI 兼容 API、内置代理复用你的 ChatGPT 登录态访问上游。无需数据库。

## 界面速览

| 概览 · 用量 | 账号 · 登录态 |
|---|---|
| <img src="docs/img/ui-overview.png" width="100%"/> | <img src="docs/img/ui-account.png" width="100%"/> |

| 图片素材 · 生成图库 | API Key 管理 |
|---|---|
| <img src="docs/img/ui-images.png" width="100%"/> | <img src="docs/img/ui-apikeys.png" width="100%"/> |

| 局域网接入页 `/setup`（成员零配置入口） | 分用户素材站 `/gallery` |
|---|---|
| <img src="docs/img/page-setup.png" width="100%"/> | <img src="docs/img/page-gallery.png" width="100%"/> |

## 快速开始（宿主机）

前置：本机已安装 **Node.js 18+**（Windows 绿色版发布包用户无需本节，解压后按 `QUICK-START.md` 双击启动）。

```bash
npm run setup   # 首次：安装本地代理（已内置，离线可用）
npm run login   # 首次：ChatGPT OAuth 登录
npm start       # 启动并自动打开控制台 http://127.0.0.1:4173
```

启动后会在默认浏览器打开控制台（如果浏览器没弹出，手动访问 `http://127.0.0.1:4173`，页面会提示如何登录）。

### 控制台登录（管理令牌）

控制面 `/__gw/*`（账号、API Key、配置）默认启用管理令牌保护，防止本机上任意脚本无凭据读走明文 Key：

- **日常**：`npm start` / 双击启动图标会自动带上一次性登录链接打开控制台，无感。
- **手动**：`npm run admin` 打印一条一次性登录链接（60 秒内有效，使用后即失效）。
- **脚本/curl**：`npm run admin` 的同级命令 `node gateway/launcher.mjs admin-token` 打印令牌，请求时带 `Authorization: Bearer cgwadm-...`。
- 登录后浏览器持有 14 天本机会话 Cookie，期间无需重复登录。
- 关闭该保护（仅限完全可信的机器）：启动前设 `CGW_ADMIN_AUTH=0`。

数据面 `/v1/*` 的 `cgw-` API Key 用法完全不受影响。

## 模型

| 模型 | 用途 |
|---|---|
| `gpt-6.1-sol`（**默认**） | 编程 / 深度研究 / 通用主力 |
| `gpt-6-astra` | 旗舰：长上下文、高难度推理 |
| `gpt-6.1-terra` | 均衡档 |
| `gpt-image-2.5-sunburst` / `gpt-image-2.5-flare` | 图片生成入口（标准 / 高清档） |

- 常用简写（`sol`、`astra`、`sunburst` 等）会自动映射到完整模型 ID。
- 实际可用清单以 `GET /v1/models` 返回为准（控制台「模型能力」页可视化查看）。

## 图片生成

```mermaid
flowchart LR
    A["客户端 API 调用<br/>或 MCP generate_image"] --> B["对话模型 + 图像工具渲染"]
    B --> C["自动落盘生成图库<br/>按 API Key 记归属"]
    C --> D["响应返回 url + local_path"]
    C --> E["素材站 /gallery<br/>预览 · 复制 · 下载 · 删除"]
```

- **API 方式**：`POST /v1/images/generations`（标准 images 协议），`size` / `quality` 参数正常生效；未指定时自动使用最高质量档。
- **MCP 方式**：网关提供 `generate_image` / `list_generated_images` / `delete_generated_image` 三个 MCP 工具，本机（stdio）与局域网（HTTP）两种接入方式可并存，列表/删除按调用 Key 隔离。
- 生成结果自动落盘并进入素材站，响应附带可直接打开的 `url` 与本机 `local_path`。

> 说明：图片能力由对话模型 + 内置图像工具渲染，`gpt-image-2.5-*` 仅为客户端填写的入口名称；响应中的 `model` 字段会回写真实渲染模型。

## 接入客户端

任意 OpenAI 兼容客户端填三项：

| 字段 | 填什么 | 示例 |
|---|---|---|
| Base URL | 网关地址 + `/v1` | `http://127.0.0.1:4173/v1` |
| API Key | 控制台「API Key」页创建的 Key | `cgw-xxxxxxxxxxxxxxxx` |
| 模型 | 默认 `gpt-6.1-sol`，或 `/v1/models` 里任选 | `gpt-6.1-sol` |

WorkBuddy 模型配置示例（`workbuddy-models-codex-gateway.json`）：

```json
{
  "models": [
    {
      "id": "codex-gateway-local",
      "name": "Codex (本地网关)",
      "vendor": "Custom",
      "url": "http://127.0.0.1:4173/v1/chat/completions",
      "apiKey": "替换为控制台「API Key」页创建的 cgw-...",
      "supportsToolCall": true,
      "supportsReasoning": true
    }
  ]
}
```

## 局域网共享

默认仅本机可用。让同一局域网的成员/设备接入：

```bash
npm run start:lan    # 等价于 cd gateway && node launcher.mjs --lan
```

```mermaid
sequenceDiagram
    participant H as 宿主机
    participant M as 局域网成员
    H->>H: 控制台「API Key」页创建独立 Key
    H->>M: 点「接入」复制邀请信息
    M->>H: 浏览器打开 /setup 输入 Key
    H-->>M: 自动生成全部配置（复制 / 下载）
    M->>H: 调用 API 对话与生图
    M->>H: 素材站管理自己的图片（按 Key 隔离）
```

**推荐流程（全程 GUI，零命令行）：**

1. **宿主机**：控制台「API Key」页为每位成员创建独立 Key，点该 Key 的**「接入」**按钮，把复制出的邀请信息发给成员
2. **成员**：浏览器打开 `http://<宿主机IP>:4173/setup`，输入 Key → 页面自动生成全部配置，逐项复制/下载即可
3. **素材站**：`http://<宿主机IP>:4173/gallery`（首次输入自己的 Key 后浏览器记住；只显示/只能删除**自己**生成的图）

命令行与 Agent 自动化方式（可选）：见 [`docs/lan-kit/INSTALL.md`](docs/lan-kit/INSTALL.md)（含一键脚本与可直接粘贴给 Agent 的 Prompt）。

### 多个网卡时该发哪个地址

一台开发机常同时挂着好几个 IPv4：真实内网、Tailscale（`100.64.0.0/10`）、Docker 或 Hyper-V 的虚拟网卡。控制台和启动日志会把每个地址的类型标出来，**带「局域网同事用这个」的那一个才是该发出去的**：

```text
http://192.168.1.188:4173/v1   (以太网 2)                       ← 局域网同事用这个
http://192.168.176.1:4173/v1   (vEthernet (Default Switch))     ← 虚拟网卡，外部通常不可达
http://100.122.232.106:4173/v1   (Tailscale)                    ← 仅 Tailscale 网络内可达
```

排序是「真实内网 → 虚拟网卡 → Tailscale → 其它」，所以不给 Tailscale 同事时别顺手复制 `100.x`——那地址只有装了 Tailscale 且加入同一 tailnet 的设备才连得上。

### 运行平台

| 部分 | 支持 |
|---|---|
| Windows 发布包 | 仅 Windows x64（内含 node 运行时）。推荐双击解压后**顶层**的 `install.vbs` 一键安装（程序进 `%LOCALAPPDATA%\Programs`、数据进 `%LOCALAPPDATA%\CodexGateway`、开始菜单 + 可卸载）；也可双击 `gateway\service\start-gateway.vbs` 以绿色版运行（数据长在解压目录内） |
| 网关源码运行 | 跨平台：macOS / Linux 装 Node.js 20+ 后 `gateway/start-unix.sh` 直接跑 |
| 开机自启 | Windows：`gateway/service/install-autostart.vbs`（计划任务）；macOS：launchd；Linux：systemd `--user`。unix 侧见下 |
| 局域网客户端接入 | 跨平台：接入页任意浏览器可用；脚本任意 Node.js 16+ 系统可用 |

#### 数据目录（CGW_DATA_DIR）

账号凭据、API Key、配置、调用日志、参考图默认长在程序目录里（绿色版行为）。
设置环境变量 `CGW_DATA_DIR`（install-app.vbs 会写进 `gateway\service\installed.env`，
由 run-gateway.cmd 注入）后全部改住该目录 —— 卸载升级不再连数据一起删。
目录内布局与程序目录一致（`accounts.json`、`accounts/`、`data/`…），两种形态
数据原样互拷即可迁移。相对路径会被忽略（数据目录不允许随启动姿势漂移）。

#### macOS / Linux 的启动与自启

Windows 那套 `.vbs + schtasks` 在 unix 上没有等价物，用系统原生的守护方式：

```bash
cd <解压目录>/gateway/service-unix

./start-gateway.sh          # 手动前台启动（--lan + 打开浏览器，Ctrl+C 停止）
./start-gateway.sh --local  # 只监听 127.0.0.1

./install-autostart.sh      # 注册开机自启（macOS = launchd，Linux = systemd --user）
./stop-gateway.sh           # 停止（会先让守护别再拉起来，再杀进程）
./uninstall-autostart.sh    # 取消自启（不动账号 / Key / 日志）
```

- 运行时查找顺序：`CGW_NODE` 环境变量 → 包内 `gateway/runtime/bin/node` → `PATH` 里的 `node`；找不到会明确报错（退出码 127）而不是静默失败
- 日志：`gateway/logs/service.log`，上一轮留存为 `service.log.1`；systemd 还可 `journalctl --user -u codex-gateway -f`
- Linux 下若希望注销登录后仍运行，需 `sudo loginctl enable-linger $USER`（安装脚本会检测并提示）

### 安全边界

| 边界 | 行为 |
|---|---|
| 数据面鉴权 | `/v1/*` 必须携带有效 API Key，否则 401 |
| 控制面仅本机 | 账号 / 密钥 / 配置 / 日志等管理接口从局域网访问一律 403 |
| 内部代理不外露 | 核心代理仅绑定本机回环地址，外部无法直连 |
| 分用户隔离 | 图片素材按 Key 隔离，越权删除返回 403；宿主机控制台可见全部 |
| 密钥保护 | Key 列表只返回掩码，明文仅在点「复制」时单条下发 |
| 分发面最小化 | 局域网开放页仅含静态接入指引，不含任何密钥与账号数据 |

> ⚠️ 局域网模式等于把你的订阅额度开放给同网段设备——仅在可信网络（家庭/办公内网）临时开启，用完即关。

## 登录与账号

控制台「账号」页支持四种方式：

| 方式 | 说明 |
|---|---|
| **OAuth 授权**（推荐） | 设备流授权，浏览器输入用户码即完成；使用 ChatGPT 订阅额度 |
| **导入 / 粘贴 Token** | 导入 `auth.json` 登录态文件 |
| **API Key 模式** | 填 OpenAI 官方 API Key 直连官方接口（按 API 计费，非订阅额度） |

- 支持多账号保存与一键切换。
- 「设置 → 出网代理」可配置代理（如 Clash），适配网络受限环境。

### 多账号是怎么跑起来的

每个账号对应**一个独立的内部代理进程**，各自监听一个端口（10531 起依次分配）。
用某个账号的 Key 发请求时，网关直接转发到那个账号自己的端口，**不需要切换、不需要重启**：

- 冷启动只发生在某账号第一次被用到时，之后一直是热的；
- 两个账号的请求可以同时进行，互不排队；
- 切换「激活账号」不重启任何进程，只是改默认路由目标。

代价是内存：每个热着的账号占一个 Node 进程（约 60–90MB）。因此：

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `CGW_BRIDGE_POOL_MAX` | `6` | 最多同时存在几个账号实例；超出时回收最久未用的空闲实例，全都在忙则明确报错 |
| `CGW_BRIDGE_IDLE_MS` | `900000` | 非激活账号的实例空闲多久后回收（15 分钟）；当前激活账号常驻 |

只有一个账号时，行为与单进程版本完全一致。

### 一个账号撞上限流，会自动换一个

多账号还有一层用处：某个账号返回 **429（额度用尽）或 401（登录态失效）** 时，网关会把这个请求换到另一个可用账号重放，响应头里带 `X-CGW-Failover` 说明发生过降级，控制台日志也会写一条。

- 只降级这两种状态码。**400 之类的请求错误、5xx 之类的上游故障不降级**——换账号只会换个地方再错一次。
- 被降级的账号会**冷却**一段时间（429 五分钟、401 十五分钟），期间不再被选为降级目标；到期自动解除，重新登录后立刻可用。
- 单次请求最多换 **2** 个账号。整组账号都不健康时，如实把原始状态码返回，不把 429 伪装成 200。
- **超时和连接中断一律不重试**：那类情况属于「上游可能已经受理了」，重发有重复计费的风险。

选路是从当前账号的**下一位**开始环形遍历，所以 A、B 同时坏的时候不会在两者之间打转，第三个账号仍有被选中的机会。当前冷却状态可以在控制台 `/__gw/status` 的 `failover` 字段里看到。

### 额度数字是从哪来的

ChatGPT 没有公开的额度查询接口，剩余比例只能从**真实上游响应的限流头**（`x-codex-*`）里读。所以：

| 界面标记 | 含义 |
|---|---|
| `实时同步 · N 分钟前` | 该账号的 bridge 最近一次真实请求带回了限流头 |
| `手动填写` | 上游还没回过数据，当前显示的是你自己填的值 |
| 空态 | 两样都没有。**不画进度条、不编数字** |

想立刻拿到数字，点卡片右上角的「刷新额度」——网关会替你发一次 `max_tokens=1` 的极小请求，把限流头带回来（消耗极少量额度，同一账号 60 秒内只会发一次）。切换激活账号时也会自动探一次，不必手动点。

探测失败不会假装成功：拿不到新头就明确显示「上游这次没回限流头」，而不是把上一次的旧数字标成「刚刚同步」。

## 常用配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `GW_LAN` | `0` | 置 `1` 开启局域网监听（等价 `--lan`） |
| `LAUNCHER_PORT` | `4173` | 网关端口（控制台 + API 同端口） |
| `CGW_IMAGE_MODEL` | `gpt-6.1-sol` | 实际执行生图的对话模型 |
| `CGW_BRIDGE_POOL_MAX` | `6` | 最多同时存在几个账号实例（详见「多账号是怎么跑起来的」） |
| `CGW_BRIDGE_IDLE_MS` | `900000` | 非激活账号实例的空闲回收时间 |
| `BRIDGE_PORT` | `10531` | 实例池的**基准**端口（第一个槽位），实际端口依次 +1 |
| `DISABLE_AUTOSTART` | — | 置 `1` 不自动拉起内部代理 |

### 端口被占用怎么办

`4173` 正是 **vite preview 的默认端口**，机器上开着前端预览、或装过另一份网关时很容易撞。撞上不会静默——启动器会打出一段说明并以**退出码 2** 结束，双击启动的窗口里也会直接弹出原因（不用去翻日志）：

```
✗ 启动器端口 4173 已被占用，本次启动中止。
可能的原因：
  1) 网关已经在运行 —— 先试试直接打开 http://127.0.0.1:4173
  2) 别的程序占着这个端口 —— 4173 正是 vite preview 的默认端口，开着前端预览常会撞上
查处占用者：
  netstat -ano | findstr :4173
  tasklist /FI "PID eq <上一步最后一列的 PID>"
```

换端口的三种方式，按「影响范围从小到大」选：

| 场景 | 做法 |
|---|---|
| 只想这次换 | `run-gateway.cmd 4174`（macOS/Linux：`./start-gateway.sh --port 4174`） |
| 以后都用这个端口 | `cscript install-autostart.vbs 4174`（macOS/Linux：`./install-autostart.sh --port 4174`），会同时写进自启配置 |
| 临时命令行调试 | `node gateway/launcher.mjs --port 4174` |

启动器端口优先级：**`--port N` > `LAUNCHER_PORT` 环境变量 > `4173`**。

> **换端口是对外契约的变更，不是本地偏好。** 已经发给同事的模型配置、MCP 配置、防火墙规则、反向代理上游全都写死了原端口，改完需要**重新下发一遍**。这也是为什么端口没有做成控制台里的输入框——它需要重启进程才生效，而控制台页面本身就挂在这个端口上，保存的瞬间页面就失联了。
>
> 内部端口 `10531`（`bridge` 实例池基准）不建议改：只有启动器自己访问它，控制台上只做展示。确实需要时用 `--bridge-port N` 或 `BRIDGE_PORT`。

## 技术栈

- **gateway/**：Node.js（ESM、零依赖）启动器 + 内置的 chatgpt-bridge 兼容代理（OpenAI 协议 → Codex OAuth 上游）
- **frontend/**：Vue 3 + Vite 控制台，构建为单文件 `dist/index.html` 由启动器直接托管
- **无数据库 / 无 Redis**：全部状态为本地文件，删除目录即彻底重置

### 构建可复现

同一个版本号必须对应同一份二进制，否则「这个包到底是哪套源码 + 哪个运行时」无从核对。发布包在这一点上做了三件事：

- **锁定运行时**：`node-runtime.lock.json` 按 sha256 固定内置的 `node.exe`，与锁不一致直接构建失败（不是警告）；
- **锁定字节**：构建时主动规范化换行符（`.cmd/.bat/.vbs` → CRLF，其余文本 → LF），所以 `core.autocrlf` 开与不开的机器打出来的包**逐字节相同**；
- **留下指纹**：包内 `BUILD-INFO.json` 记录版本、git commit、运行时哈希（刻意不含绝对路径与主机名）。

验证方式：`node build-release.mjs --verify-build` 做「包内声明 ↔ 实物 ↔ 锁文件」三方核对。构建细节见 [`docs/RELEASE.md`](docs/RELEASE.md)。

## 合规与使用须知（重要）

> **⚠️ 局域网模式（`--lan`）走的是明文 HTTP。**
> 同一网段内任何具备抓包能力的设备（一台笔记本开 Wireshark 就够）都能直接嗅探到 `Authorization: Bearer cgw-…`，等同于拿到你的 Key 及其对应账号的额度。**仅在可信的家庭或办公内网临时开启；公共 Wi-Fi、咖啡馆、共享办公空间务必关闭。**
> 需要长期跨设备使用，请在网关前加一层 HTTPS 反向代理，或通过 VPN（如 Tailscale）组网，不要把明文端口暴露到不可信网络。

使用本项目前，请务必理解并接受以下条款：

1. **仅限个人本地使用**：本项目面向个人在自有设备上使用自己的订阅账号。不得部署为面向公众或第三方的经营性服务，不得转售或二次分发访问能力。
2. **上游服务条款**：通过本项目访问 OpenAI 服务时，你仍受 OpenAI 服务条款约束。以 API 方式使用订阅额度可能超出授权范围，由此产生的账号风控（限流、封禁等）风险由使用者自行承担。
3. **地区与法律**：OpenAI 服务未在所有国家/地区开放，部分地区直连会被拒绝；请自行确保在合规的网络环境下使用，并严格遵守所在地区法律法规。
4. **凭据安全**：OAuth 登录态与 API Key 均为敏感凭据，请勿分享、上传或提交至任何公开场所；局域网模式为明文传输，Key 可被同网段嗅探，仅在可信网络中临时开启（详见本章开头的警示）。
5. **内容责任**：通过本网关产生的全部内容（含生成图片）由使用者负责，须遵守上游服务内容政策与适用法律，不得用于任何违法违规用途。
6. **无关联声明**：本项目为独立开源工具，与 OpenAI 无任何隶属、合作或背书关系；ChatGPT、OpenAI、Codex 等名称与商标归其权利人所有，在此仅作说明用途。
7. **免责声明**：本项目按"现状"提供（详见 MIT License）。作者不对使用本软件导致的任何损失、账号处罚或法律风险承担责任；继续使用即表示你已阅读并同意本须知。

## License

[MIT](LICENSE)
