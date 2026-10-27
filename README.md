# Codex 本地网关（monorepo）

**一份发布包，两种角色，按身份取文档：**

| 你的角色 | 看哪里 | 一句话路径 |
|---|---|---|
| **宿主机**（跑网关、给同事发 Key） | `QUICK-START.md` | 解压 → 双击启动 → 控制台 OAuth 登录 → 「API Key」页建 Key 发给同事 |
| **局域网用户**（用别人的网关） | 网页接入页 `/setup`（**零命令行，推荐**） | 打开 `http://<宿主机IP>:4173/setup`，输入 Key，按页面复制/下载即完成；也可 `node lan-kit/setup-client.mjs --host <IP> --key <cgw-…>` 一条命令，或把 [`AGENT-PROMPT.md`](docs/lan-kit/AGENT-PROMPT.md) 里的 Prompt 丢给你的 Agent 全自动配好 |
| 维护者（构建发布包） | `docs/RELEASE.md` | `node build-release.mjs`（白名单组装 + 机密自检，lan-kit 一并入包） |

本地化的 **Codex / ChatGPT 接入控制台**：用你自己的 ChatGPT 订阅（OAuth 登录态）提供文本 + 图片 + **视觉理解**能力，
对外暴露 OpenAI 兼容接口，前端带可视化管理后台，并**自动托管后端**。**无 PostgreSQL、无 Redis、无账号池**——
用薄代理替代 sub2api 全功能，仅保留你真正需要的部分。

> **定位说明**：本仓库是**个人本地网关**（默认只绑 `127.0.0.1` 自用；`--lan` 一键开放给同局域网，
> 含按 API Key 隔离的分用户素材站）。团队共享的中转走另一套
> **VPS sub2api 部署**（`deploy/sub2api/README.md`，数据面公网 + 控制面 Tailscale）。两者互不替代：
> 本地网关不上团队链路，VPS 中继不进本机。WorkBuddy 接哪一边的地址，取决于你当前要用个人通道还是团队通道。

## 目录

- [1. 架构](#1-架构)
- [2. 模型目录（GPT-6 全系）](#2-模型目录gpt-6-全系)
- [3. 图片模型语义（重要）](#3-图片模型语义重要)
- [4. 跨模型生图（MCP）](#4-跨模型生图mcp)
- [5. 快速开始](#5-快速开始)
- [6. 接入客户端（WorkBuddy / 任意 OpenAI 兼容客户端）](#6-接入客户端workbuddy--任意-openai-兼容客户端)
- [7. 组件说明](#7-组件说明)
- [8. 接真数据的开关](#8-接真数据的开关)
- [9. 多授权登录](#9-多授权登录)
- [10. 局域网接入（GW_LAN=1）](#10-局域网接入gw_lan1)
- [11. 常用环境变量](#11-常用环境变量)
- [12. 回归测试](#12-回归测试)
- [13. 已知限制 / 安全合规](#13-已知限制--安全合规)

---

## 1. 架构

```
浏览器 ── http://127.0.0.1:4173 ──► 本地启动器 (gateway/launcher.mjs)
        │  自动拉起 bridge 子进程 + 托管前端 + 反向代理 /v1 + /__gw 控制
        ▼
┌──────────────────────────────────────────────┐
│  chatgpt-bridge (薄代理, 127.0.0.1:10531)      │  读 ~/.codex/auth.json，OAuth 转发
│  文本 + 图片(gpt-6.1-sol + image_generation)  │  无数据库
│  + 视觉理解(多模态)                            │
└──────────────────────┬───────────────────────┘
                       │  OAuth 转发
                       ▼
              ChatGPT / Codex 服务端（你的真实登录态）
```

```
codex-gateway/
├── package.json     # 根脚本：start / build / setup / login
├── frontend/        # Vue 3 + Vite 控制台（已构建单文件 dist/index.html）
├── gateway/         # chatgpt-bridge 薄代理(已本地安装) + 零依赖启动器 + MCP server + compose
└── README.md
```

---

## 2. 模型目录（只留主力）

网关的模型清单 = **上游真实列表 ∪ 本地目录兜底**。上游不可达时仍有主力模型可选。

**当前只下发 3 个文本主力 + 3 个工作变体 + 2 档图片模型（共 8 条）**：

| 模型 ID | 档位 | 说明 |
|---|---|---|
| `gpt-6.1-sol` | 主力（**默认**） | 复杂编程 / 深度研究 / Computer Use，Codex 推荐默认 |
| `gpt-6-astra` | 旗舰 | 长上下文 / 高难度推理 |
| `gpt-6.1-terra` | 均衡 | 6.1 家族均衡档，质量与成本折中 |
| `gpt-image-2.5-sunburst`（标准）/ `gpt-image-2.5-flare`（高清） | 图片（**名义条目**） | 见下方「图片模型语义」 |

> `-wm` 工作模型变体（如 `gpt-6.1-sol-wm`）已**彻底移除**：2026-10-27 实测在 ChatGPT 登录态下上游一律返回
> `model_not_found`（not supported when using Codex with a ChatGPT account）。不在目录收录、也不做别名回落，
> 客户端硬写 `-wm` 时按原样透传给上游。

**旧世代一律不出现在列表里**（仍在请求里原样透传，不会被改写）：
`gpt-5.x` 全系（5.2 / 5.3-codex* / 5.4* / 5.5 / 5.6*）、`gpt-6-sol`、`gpt-6-luna`、
`gpt-image-1`、`gpt-image-2`、`dall-e-3`、内部专用 `codex-auto-review`，
以及非保留模型的 `-wm` 变体。过滤逻辑在 `gateway/model-catalog.mjs` 的 `isHiddenUpstream()`，
`/v1/models` 会返回 `hiddenCount` 让控制台提示「已隐藏 N 个旧世代模型」。

**别名解析**：`sol` / `gpt-6` / `gpt-6.1` / `astra` / `terra` / `sunburst` / `flare` / `image-2.5` 等简写会自动映射到真实 ID；
未知模型 ID 原样透传给上游（不做臆测）。

---

## 3. 图片模型语义（重要：本通道没有独立图片模型）

ChatGPT 订阅通道**不提供独立的图片模型**。上游模型清单里只有文本模型；
生图是通过「**对话模型 + `image_generation` 工具**」实现的。

因此：

- 列表里的 `gpt-image-2.5-sunburst`（标准）/ `gpt-image-2.5-flare`（高清）是 OpenAI 官方 API 命名的**占位条目**，
  作用仅是让客户端能填出一个合法的 `model` 字段；`size` / `quality` 按请求参数正常生效。
- `POST /v1/images/generations` **会忽略请求体的 `model` 字段**，一律由
  `CHATGPT_BRIDGE_IMAGE_MODEL`（默认 `gpt-6.1-sol`）+ `image_generation` 工具渲染。
- 网关会在响应里**回写真实模型**：`model` 字段、`x-cgw-image-model` 响应头，
  并把调用方填的占位名记在 `cgw_requested_model`，让「填了 model 却静默无效」变成可见事实。

> 换生图模型请改环境变量 `CGW_IMAGE_MODEL`（网关侧生效）与 `CHATGPT_BRIDGE_IMAGE_MODEL`
> （bridge 侧生效），两者会由网关自动对齐；占位名里的 `2.5-sunburst` / `2.5-flare`
> 只是命名，**本通道不存在独立的图片模型**。

---

## 4. 跨模型生图（MCP）

网关把生图开放给任意支持 Function Calling 的模型（Claude / GLM / Gemini …）：

- **MCP Server**：`gateway/mcp-server.mjs`（stdio、零依赖），暴露 `generate_image` / `list_generated_images` 两个工具
- **接入**：`~/.workbuddy/mcp.json` 的 `mcpServers` 中注册（env 传 `CGW_API_KEY`，在控制台「API Key」页创建）。**本机 stdio 与远程接入可共存**：网关内置远程 MCP 端点 `/mcp`（streamable HTTP），局域网客户端只填 `url` + `headers` 即可零安装接入，约定键名 `codex-gateway-lan`（`codex-gateway` 留给本机 stdio）。远程端点暴露三个工具：`generate_image` / `list_generated_images` / `delete_generated_image`（后两个按调用 Key 隔离，只看到/只能删**自己**生成的图）。完整步骤见 [`docs/lan-kit/INSTALL.md`](docs/lan-kit/INSTALL.md)
- **网页素材站**：`http://<网关地址>/gallery` —— 分用户的图片管理页（首次输入自己的 `cgw-` Key，之后免输；预览 / 复制链接 / 下载 / 删除，全部只针对自己的图）。局域网用户可在 WorkBuddy 等 Agent 的**侧边浏览器**中打开；MCP 生图成功的结果里会直接附带该链接
- **响应增强**：launcher 拦截 `POST /v1/images/generations`，b64 自动落盘到生成图库（归属按 Key 记入 `index.json`），响应附加 `url`（跟随访问地址的直链）与 `local_path`（磁盘绝对路径）
- **最高质量策略**：调用方缺省时网关自动注入 `quality=high` + `size=auto`（会话内 `/v1/responses` 的 image_generation 工具同样注入 high），不再落到 1024x1024 低档默认。实测本通道（ChatGPT 账号 / Codex Responses）分辨率上限为 1536 档，请求 4K 会被上游静默降级到 1536x1024；`auto` 由上游按内容选比例并给原生最大分辨率
- **技能**：`~/.workbuddy/skills/codex-gateway-image/`（显示名 **ImageGen 2.5**）教任意模型的 agent 识别生图任务并调用（MCP 优先，HTTP 回退），并引导用侧边浏览器打开素材站

---

## 5. 快速开始

> 前置：本机已安装 **Node.js**（建议 LTS）。启动器为 ESM、零依赖；bridge 已 `npm install` 进 `gateway/node_modules/`。

```bash
# 0) 首次：把 bridge 装进本地（离线可用，不再联网 npx）
npm run setup

# 1) 首次登录 ChatGPT（写 ~/.codex/auth.json）
npm run login

# 2) 起启动器（自动拉起 bridge + 托管前端，浏览器打开）
npm start
# 打开 http://127.0.0.1:4173
```

> 启动器自动托管一切：前端在 4173 同源提供，`/v1/*` 与 `/health` 反向代理到 10531 的 bridge，
> 前端经 `/__gw/*` 控制启停/重启/查看日志。无需手动起任何服务。
> 确认 `http://127.0.0.1:4173/__gw/status` 显示 `health.ok=true` 后再接入客户端。

---

## 6. 接入客户端（WorkBuddy / 任意 OpenAI 兼容客户端）

本网关对外就是**标准 OpenAI 兼容 API**，客户端只需填三项：

| 字段 | 填什么 | 示例 |
|---|---|---|
| 接口地址 (Base URL) | 启动器地址 + `/v1` | `http://127.0.0.1:4173/v1` |
| API Key | 控制台「API Key」页创建的 `cgw-…` | `cgw-xxxxxxxxxxxxxxxxxxxx` |
| 模型名称 | 「模型能力」页里可用的模型（默认 `gpt-6.1-sol`） | `gpt-6.1-sol` |

**在 WorkBuddy 中配置**（模型配置文件，例如 `workbuddy-models-codex-gateway.json`）：

```json
{
  "models": [
    {
      "id": "codex-gateway-local",
      "name": "Codex (本地网关)",
      "vendor": "Custom",
      "url": "http://127.0.0.1:4173/v1/chat/completions",
      "apiKey": "在此替换为控制台「API Key」页创建的 cgw-...",
      "supportsToolCall": true,
      "supportsReasoning": true,
      "extra": {
        "comment": "模型名用 gpt-6.1-sol（默认主力）；生图走 images/generations 由网关兜底 model",
        "modelNameHint": "在控制台「模型能力」页查看可用模型，不要照抄示例"
      }
    }
  ]
}
```

- `url` 填 `http://127.0.0.1:4173/v1` 也可，由 WorkBuddy 自动拼 `/chat/completions`；若报 404 再换成 `/v1/chat/completions`。
- 可用模型名请从 `http://127.0.0.1:4173/v1/models` 的返回里挑，不要照抄示例。
- 想让**同一局域网内的其它设备**也用这份网关，见 [第 10 节](#10-局域网接入gw_lan1) 的 LAN 模式（`--lan`）。

---

## 7. 组件说明

### frontend/ — Vue 控制台
管理后台，含：**概览（含用量）、账号管理（含网关运行控制）、图片素材（多来源统一管理）、模型能力（含视觉理解）、API Key、调用日志（业务调用 + Bridge 日志）、设置**。
- 构建：`npm run build`（在 `frontend/` 下）→ 产出单文件 `dist/index.html`
- `npm run dev` 仅用于本地开发；预览建议用构建后的 `dist/index.html`
- 接口层对齐 chatgpt-bridge：`/health`、`/v1/models`；视觉走 `/v1/responses` 多模态；登录引导指向 `npx @openai/codex login`
- 网关控制走启动器 `/__gw/*`（启停/重启/日志/状态）
- **模型能力开关**只影响本机界面的显示与隐藏，不会改变网关实际开放的接口

### gateway/ — 薄代理 + 启动器
- `chatgpt-bridge@0.3.0`：本地 OpenAI 兼容代理，复用 Codex OAuth 登录态，**已 `npm install` 进 `node_modules/`**
- `launcher.mjs`：零依赖 Node 启动器，自动托管 bridge 并托管前端
- 启动器：`cd gateway && npm start`（推荐）
- 原生：`node node_modules/chatgpt-bridge/dist/cli.js serve`
- 容器：`cd gateway && docker compose up -d`

---

## 8. 接真数据的开关

前端 `frontend/.env`：
```
VITE_USE_MOCK=false
VITE_API_BASE=            # 留空：经启动器同源托管（推荐）；或填 http://127.0.0.1:10531 直连
```
先确保 `npm start` 后 `http://127.0.0.1:4173/__gw/status` 显示 `health.ok=true`，再关掉前端 mock。

---

## 9. 多授权登录

控制台「账号」页支持四种授权方式（弹窗在 `frontend/src/components/SetupModal.vue`）：

| 方式 | 说明 | 后端落点 |
|---|---|---|
| **OAuth 授权** | 设备流（device flow），点「发起设备授权」→ 浏览器打开授权链接、输入用户码 → 自动轮询换 token 并写入登录态 | `gateway/auth.json`（bridge 形态） |
| **Token·JSON** | 粘贴 `auth.json` 内容（支持 `tokens` 包裹或平铺 `access_token/refresh_token`） | 同上 |
| **导入** | 从本机选择 `auth.json` 文件，等效于 Token·JSON | 同上 |
| **API Key** | 填入 OpenAI 官方 API Key，切换为「API Key 模式」直连 `api.openai.com` | 仅保存在本地 `.gw-config.json` |

- 模式切换由 `/__gw/auth/mode` 控制：`bridge` 模式反代到本地 chatgpt-bridge（10531）；`openai` 模式改为 https 直连 OpenAI 官方接口，不再启动 bridge。
- **openai 模式的出网代理**：直连走 undici 的全局 dispatcher，因此「设置 → 出网代理」里配的 Clash / Tailscale 代理**同样生效**（旧实现用 `node:https` 直连会完全绕过代理，导致「配了代理仍 403 unsupported_country_region_territory」）。
- 授权核心逻辑在 `gateway/auth-core.mjs`（零依赖，launcher 使用），OAuth 设备流复用与 Codex CLI 相同的 client_id 与 scope。
- **注意**：chatgpt-bridge 本身只认 OAuth 登录态、不认 API Key；API Key 模式是我们自己的反代实现，等同于 OpenAI API 网关（按 API 计费，非 ChatGPT 订阅额度）。OAuth 设备流需在支持地区运行。

---

## 10. 局域网接入（GW_LAN=1）

网关默认**只监听 `127.0.0.1`**，仅本机可访问。确需让同一局域网的其它主机接入时，用 `--lan` 开启：

```bash
npm run start:lan          # 根目录
# 或
cd gateway && node launcher.mjs --lan
# 或（等价）
GW_LAN=1 node launcher.mjs
```

开启后启动器监听 `0.0.0.0:4173`，局域网内的客户端在「自定义供应商」里填三项即可使用：

| 字段 | 填什么 | 示例 |
|---|---|---|
| 接口地址 | `http://<宿主机局域网 IP>:4173/v1` | `http://192.168.1.188:4173/v1` |
| API Key | 控制台「API Key」页创建的 `cgw-…` | `cgw-xxxxxxxxxxxxxxxxxxxx` |
| 模型名称 | 「模型能力」页里可用的模型 | `gpt-6.1-sol` |

启动日志会直接打印本机所有可用局域网地址；控制台「模型能力 → 局域网接入」面板也会列出并支持一键复制。

> **客户端侧安装**（模型配置 / MCP / Skill 的完整步骤与排错）见 [`docs/lan-kit/INSTALL.md`](docs/lan-kit/INSTALL.md)。
> **最快路径（全程 GUI，零命令行）**：
> ① 宿主机：控制台「API Key」页对相应 Key 点**「接入」**，把复制出的邀请（接入页地址 + Key）发给成员；
> ② 成员：浏览器打开 `http://<宿主机IP>:4173/setup`，输入 Key → 页面自动生成全部配置，逐项复制/下载即可；
> ③ 素材站：`http://<宿主机IP>:4173/gallery`（输入 Key 后浏览器记住，免重复登录；可见「我是谁 · 几张图」）。
> 命令行可选：把 `lan-kit/` 发给成员后 `node lan-kit/setup-client.mjs --host <IP> --key <Key>`（无参数运行会交互式逐项询问）；
> 或让成员把 [`lan-kit/AGENT-PROMPT.md`](docs/lan-kit/AGENT-PROMPT.md) 的「Prompt B」整段粘贴给自己的 Agent，全自动配置并逐项验证。

### 运行平台

| 部分 | 平台支持 |
|---|---|
| **发布包（绿色版 zip）** | **仅 Windows**（内含 `service/*.vbs` 等 Windows 服务脚本） |
| **网关本体源码** | **跨平台**：macOS / Linux 装 Node.js 18+ 后 `gateway/start-unix.sh [--lan]`（或 `node launcher.mjs`）直接跑 |
| **lan-kit 客户端** | **跨平台**：接入页 `/setup` 任意浏览器可用；`setup-client.mjs` 任意有 Node.js 16+ 的系统可用 |
> 生成图链接已跟随访问地址（Host）返回，局域网客户端可直接打开取图；单个生成图 GET 是控制面唯一的局域网放行例外（文件名不可枚举，视作能力令牌）。

### 分用户素材站（/gallery）

| 项 | 说明 |
|---|---|
| 页面 | `http://<宿主机IP>:4173/gallery`（静态单文件 `gateway/gallery.html`，局域网可达；不在 `/__gw` 控制面守卫内） |
| 鉴权 | 页面内数据走 `GET /v1/gen-images/list` 与 `DELETE /v1/gen-images/<name>`，Bearer `cgw-` Key；Key 存浏览器 localStorage，可随时「换 Key」 |
| 隔离 | 生成时按调用 Key 落归属（`gen-images/index.json`）；每个 Key 只能看到/删除**自己**生成的图，宿主机控制台可见全部（含无归属的存量图） |
| 越权防护 | 删除时归属校验，非本人图片一律 **403** `not_owner_or_not_found` |
| 工具同源 | 远程 MCP 的 `list_generated_images` / `delete_generated_image` 与素材站共用同一套按 Key 过滤逻辑 |

### 安全边界（开启后仍然成立）

| 边界 | 行为 |
|---|---|
| 控制面仅本机 | `/__gw/*`（账号 / 密钥 / 配置 / 日志）从局域网访问一律 **403** `control_plane_local_only`（唯一例外：单个生成图 GET，文件名含随机 UUID 片段不可枚举，视作能力令牌） |
| 数据面强制鉴权 | `/v1/*` 必须携带有效 `cgw-` API Key，否则 **401**；`strictAuth` 开关在 LAN 模式下被强制覆盖 |
| bridge 不外露 | chatgpt-bridge 仍只绑 `127.0.0.1:10531`，外部主机无法直接访问 |
| 密钥按需解密 | API Key 明文只在用户点「复制」时单条解密下发，列表接口只返回掩码 |
| 分发面最小化 | `/setup`（接入页）与 `/lan-kit/*` 对局域网开放，但仅限**白名单静态文件**（接入页 / 指南 / 脚本），不含任何密钥与账号数据；Key 明文只经成员自己输入 |
| 防火墙 | 首次启动 Windows 会询问放行端口；需要手动放行时请只放行**专用网络**，不要放行公网 |

> ⚠️ 局域网模式等于把你的 ChatGPT 订阅开放给同一网络内的所有设备。仅在可信网络（如家庭 / 办公内网）短时开启，用完关掉。

---

## 11. 常用环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `GW_LAN` | `0` | 置 `1` 开启局域网监听（等价于 `--lan`） |
| `GW_LAN_HOST` | `0.0.0.0` | 局域网模式的监听地址（等价于 `--lan-host=<addr>`） |
| `LAUNCHER_PORT` | `4173` | 启动器端口（前端 + `/v1` + `/__gw` 都在这里） |
| `BRIDGE_PORT` | `10531` | chatgpt-bridge 内部端口（仅本机） |
| `CGW_IMAGE_MODEL` | `gpt-6.1-sol` | **实际生图模型**（对话模型 + image_generation 工具）。网关会自动把它注入 bridge，两侧永远对齐 |
| `DISABLE_AUTOSTART` | — | 置 `1` 不自动拉起 bridge |

---

## 12. 回归测试

以下自检脚本属于**本地开发环境**（`.verify/` 目录含脚本与截图，不随公开仓库分发），全部基于真实服务 / 真实浏览器（playwright-core + msedge）：

| 脚本 | 覆盖 |
|---|---|
| `verify-image-model.mjs` | 图片模型语义：目录只含 3 个官方名义条目、无幽灵 slug、`IMAGE_MODEL` 单一真源、`-wm` 变体 vision 判定（24 项） |
| `verify-image-e2e.mjs` | 生图响应回写真实模型（body.model / `x-cgw-image-model` / `cgw_requested_model` / `cgw_image_via`）（14 项） |
| `verify-assets-ssrf.mjs` | 素材源 SSRF 防护 + 任意文件读取防护（32 项） |
| `verify-backend-lan.mjs` | 局域网模式：控制面 403 / 数据面 401 / 路径穿越 / ETag 304 / 模型列表（30 项） |
| `verify-openai-proxy.mjs` | openai 模式代理生效对照实验（4 项） |
| `verify-p1-fixes.mjs` | 前端 P1 缺陷浏览器断言 + 窄屏无横向溢出（20 项） |
| `verify-gpt6-lan.mjs` | GPT-6 模型目录 + 局域网面板 UI（22 项） |
| `verify-nav.mjs` / `verify-ui.mjs` / `verify-manage.mjs` / `verify-accounts.mjs` / `verify-zone.mjs` / `verify-quality.mjs` / `verify-qinject.mjs` | 导航 / 图库 / 素材管理 / 账号 / 分区 / 生图质量 / 会话生图注入 |

```bash
# 需先启动网关（前端已构建）
cd gateway && node launcher.mjs --lan
# 另开终端
node .verify/verify-image-model.mjs   # 纯逻辑，无需服务
node .verify/verify-image-e2e.mjs     # 需服务 + bridge 已启动
```

---

## 13. 已知限制 / 安全合规

- **地区限制**：OpenAI 对部分国家/地区（如中国大陆）直接 403。bridge 能启动但 `/health` 会 503——这不是打包问题，需在支持的网环境下使用。
- **默认仅本机**：不设 `GW_LAN=1` 时启动器只绑 `127.0.0.1`，外部无法访问；开启局域网后请务必阅读上方安全边界表。
- **生图模型只有一个**：本通道没有独立图片模型，`gpt-image-2` 等只是名义占位，实际由 `CGW_IMAGE_MODEL` 指定的对话模型渲染。
- **合规**：真实 ChatGPT 订阅走 API 属灰色地带，违反 OpenAI ToS 风险自负；仅限个人本地单用户。

---

## 14. License

[MIT](LICENSE)
