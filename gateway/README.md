# gateway/ — Codex 本地薄代理（chatgpt-bridge）+ 启动器

本地 OpenAI 兼容代理，**复用官方 Codex CLI 的 OAuth 登录态**提供文本 + 图片 + 视觉能力。
**无 PostgreSQL、无 Redis、无数据库、无遥测**——这正是用它替代 sub2api 全功能的原因。

本目录额外提供一个**零依赖 Node 启动器**（`launcher.mjs`），让前端能够**自动托管并直接使用**后端：
开机自动拉起 bridge、托管构建好的 Vue 前端、反向代理 `/v1`、并暴露 `/__gw/*` 控制接口。

> **已本地化打包**：`chatgpt-bridge@0.3.0` 已 `npm install` 进本目录 `node_modules/`，
> 运行时直接用本机 `node` 跑本地 cli，**不再依赖 `npx` 联网拉取**。

## 它解决什么

- 你已在本地用 `npx @openai/codex login` 登录过 ChatGPT（OAuth），登录态写在 `~/.codex/auth.json`
- chatgpt-bridge 读这个文件，对外暴露 `http://127.0.0.1:10531/v1`，把 OpenAI 格式的请求翻译成 Codex OAuth 上游
- 上层（Vue 控制台、WorkBuddy、Codex CLI、任何 OpenAI SDK）把 `base_url` 指向它即可，API Key 被忽略

## 推荐运行方式：本地启动器（自动托管，一键）

```bash
cd gateway
npm install     # 仅首次：把 chatgpt-bridge 装进本地 node_modules（离线可用）
npm start       # = node launcher.mjs  → 自动拉起 bridge + 托管前端
# 浏览器打开 http://127.0.0.1:4173
```

启动器会：
1. **自动拉起** chatgpt-bridge 子进程（用本机 `node` 跑 `node_modules/chatgpt-bridge/dist/cli.js`，可用控制接口启停/重启）
2. **托管前端**：把 `../frontend/dist` 当作静态资源服务（无需单独起 Vite）
3. **反向代理**：`/v1/*` 与 `/health` 转发到 bridge（`127.0.0.1:10531`）
4. **控制接口**：`/__gw/*` 供前端托管与使用后端

环境变量：`LAUNCHER_PORT`（默认 4173）、`BRIDGE_PORT`（默认 10531）、
`FRONTEND_DIR`、`BRIDGE_CLI`（本地 cli 路径，默认 `node_modules/chatgpt-bridge/dist/cli.js`）、
`BRIDGE_NODE`（运行 bridge 的 node，默认即启动器自身 node）、
`BRIDGE_ARGS`（默认 `serve`）、`DISABLE_AUTOSTART=1`。

### 启动器控制接口（前端经此自动托管后端）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET  | `/__gw/status`  | 网关运行状态（进程 PID / 健康 / 配置 / 运行时长） |
| POST | `/__gw/start`   | 启动 bridge |
| POST | `/__gw/stop`    | 停止 bridge |
| POST | `/__gw/restart` | 重启 bridge（登录态变更后点这个重载） |
| GET  | `/__gw/logs`    | bridge 实时日志（环形缓冲，最近 200 行） |
| GET  | `/__gw/config`  | 当前配置 |

## 备选运行方式（不使用启动器）

### A. 原生运行（最直观，仍用本地包）

```bash
npx @openai/codex login                                   # 仅一次：浏览器登录 → 写 ~/.codex/auth.json
node node_modules/chatgpt-bridge/dist/cli.js serve         # 默认 127.0.0.1:10531
```
此时前端需用 `VITE_API_BASE=http://127.0.0.1:10531` 直连（而非留空走启动器）。

### B. Docker Compose（隔离环境）

```bash
cp .env.example .env          # 改 CODEX_AUTH_DIR 指向本机 ~/.codex
docker compose up -d
```
> Windows + Docker Desktop：`.env` 里 `CODEX_AUTH_DIR` 填 Windows 绝对路径（如 `C:/Users/Designer/.codex`），
> 且 Docker Desktop 需已共享该盘符。

## 健康检查

```bash
node node_modules/chatgpt-bridge/dist/cli.js doctor
# 期望：{ "status": "healthy", ... }
curl http://127.0.0.1:10531/health
```

## 快速验证图片 / 视觉

```bash
# 图片生成
curl http://127.0.0.1:10531/v1/images/generations \
  -H "Content-Type: application/json" \
  -d '{ "model": "gpt-image-2", "prompt": "a tiny dragon on a stack of books", "size": "1024x1024", "quality": "high" }' \
  | jq -r '.data[0].b64_json' | base64 --decode > out.png

# 视觉理解（多模态）
curl http://127.0.0.1:10531/v1/responses \
  -H "Content-Type: application/json" \
  -d '{ "model":"gpt-4o", "input":[ {"role":"user","content":[ {"type":"input_text","text":"描述这张图"}, {"type":"input_image","image_url":"data:image/png;base64,..."} ]} ] }'
```

## 可用环境变量（bridge）

| 变量 | 默认 | 说明 |
|------|------|------|
| `CHATGPT_BRIDGE_HOST` | `127.0.0.1` | 绑定主机 |
| `CHATGPT_BRIDGE_PORT` | `10531` | 绑定端口 |
| `CHATGPT_BRIDGE_AUTH_FILE` | 自动查找 | 覆盖 auth.json 路径 |
| `CHATGPT_BRIDGE_IMAGE_MODEL` | 见 bridge 默认 | 触发图片工具的文本模型 |
| `CHATGPT_BRIDGE_CLIENT_ID` | Codex CLI 的 client_id | OAuth client_id |

auth.json 查找顺序（首个命中为准）：
`$CHATGPT_BRIDGE_AUTH_FILE` → `$CHATGPT_LOCAL_HOME/auth.json` → `$CODEX_HOME/auth.json` →
`~/.chatgpt-local/auth.json` → `~/.codex/auth.json` → `~/.chatgpt-bridge/auth.json`

## 已知限制（重要）

- **地区限制**：OpenAI 对部分国家/地区（如中国大陆）直接 403 `unsupported_country_region_territory`。
  此时 bridge 能启动并监听，但 `/health` 返回 503、请求失败。**这不是打包问题**，需在支持的网络环境下使用（或你自行解决网络可达性）。
- **需真实登录态**：未 `codex login` 或 token 失效时，上游会 401/403。在「网关控制」点 **重启网关** 即可重载 `~/.codex/auth.json`。

## 安全与合规

- **仅监听 `127.0.0.1`**，不要把端口映射到 `0.0.0.0` 或暴露到公网。
- 令牌仅留本地：auth.json 被读取、刷新并写回原文件，不会被复制到别处；除 chatgpt.com / auth.openai.com 外无出站流量。
- **合规提醒**：用真实 ChatGPT 订阅走 API 属于灰色地带（非官方 sanctioned API），OpenAI ToS 一般不建议对消费级界面做自动化访问。仅限**个人本地单用户**使用，不要做成多用户 SaaS 分摊订阅。
- 桥内置保守的速率限制与人性化抖动，以降低风控风险。
