# codex-gateway 局域网客户端接入指南（零安装优先）

面向：与网关主机**同一局域网**、想在自己电脑的 WorkBuddy 里使用网关（模型对话 + 生图）的成员。

**结论先说：可以做到零安装。** 网关主机侧已内置远程 MCP 端点（`/mcp`，streamable HTTP），
客户端三种接入方式按"装得越少越好"排序：

| 方案 | 本机要装什么 | 接入什么 | 适合 |
|---|---|---|---|
| **A. 网页接入页 `/setup`（最推荐）** | **什么都不装**，浏览器打开接入页点按即可 | 模型 + MCP 生图（全功能） | 绝大多数人 |
| **B. 远程 MCP** | **什么都不装**，mcp.json 只填 url + headers | 模型 + MCP 生图（全功能） | 想跳过网页直接写配置的 |
| **C. 纯 HTTP** | **什么都不装**，只装 skill 文件夹（复制即用） | 模型 + skill 教 agent 用 curl 生图 | 不想注册 MCP 的 |
| **D. stdio MCP（旧式）** | Node.js + `mcp-server.mjs` 单文件 | 模型 + MCP 生图 | 有特殊需求的 |

> 网关主机侧只需做一次：`cd gateway && node launcher.mjs --lan`（或根目录 `npm run start:lan`），
> 并在控制台「API Key」页给每位成员创建各自的 `cgw-` Key（创建后点该行的**「接入」**按钮，
> 即可复制"接入页地址 + Key"的邀请文案直接发给成员）。

---

## 0. 最快路径：打开一个网页（零命令行，推荐从这里开始）

1. 浏览器打开 **`http://<宿主机IP>:4173/setup`**（地址由主人提供，或用主人控制台「接入」按钮复制来的邀请）
2. 输入主人发给你的 `cgw-` Key → 验证通过，页面显示你的身份（Key 名 · 已生成图片数）
3. 按页面提示逐项**复制 / 下载**：MCP JSON → 模型配置 JSON → （可选）Skill / 一键脚本
4. 验证：重启 WorkBuddy 后对 Agent 说「画一张测试图」；素材站在 `http://<宿主机IP>:4173/gallery`
   （Key 只存你自己浏览器、输入一次即可，页面头部会显示「我是谁 · 几张图」）

---

## 0+. 备选路径：一条命令，或一段 Prompt

**方式一：一键配置脚本**（本 kit 自带 `setup-client.mjs`，零依赖，只要本机有 Node）：

```bash
node setup-client.mjs --host 192.168.1.188 --key cgw-主人发给你的Key
```

一条命令同时完成：mcp.json 写入远程 MCP 条目 + 安装 ImageGen 2.5 skill + 生成模型配置 JSON。
加 `--dry-run` 可先预览不写入；`--no-skill` / `--no-model-config` 可按需跳过。
**不带任何参数直接运行也可以**——会进入交互式问答，逐项询问地址和 Key。
（从接入页 `/setup` 下载的脚本已自动内嵌宿主机地址，只需再给 `--key`。）

**方式二：把 Prompt 丢给你的 Agent**（连 Node 都不用你碰）：
打开本 kit 的 [`AGENT-PROMPT.md`](AGENT-PROMPT.md)，复制「Prompt B：局域网用户接入」整段粘贴给 WorkBuddy，
替换 `<宿主机地址>` 和 `<我的Key>` 两个占位符，Agent 会自动完成配置 + 逐项验证。

---

## 0b. 先向网关主人要两样东西

| 东西 | 示例 | 用途 |
|---|---|---|
| 网关地址 | `http://192.168.1.188:4173` | 模型配置、MCP 都指向它（接入页自动识别，无需手填） |
| 你的个人 API Key | `cgw-xxxxxxxxxxxxxxxx` | `/v1/*` 与 MCP 鉴权（不要共用别人的） |

> `lan-kit/` 目录整包仅在走命令行 / stdio 方案时才需要（方案 C/D）；走网页接入页则完全不用。

---

## 1. 接入对话模型（所有方案共用，零安装）

在你的模型配置 JSON（如 `workbuddy-models-codex-gateway-lan.json`）里填：

```json
{
  "models": [
    {
      "id": "codex-gateway-lan",
      "name": "Codex (局域网网关)",
      "vendor": "Custom",
      "url": "http://192.168.1.188:4173/v1/chat/completions",
      "apiKey": "cgw-替换为主人发给你的Key",
      "supportsToolCall": true,
      "supportsReasoning": true,
      "extra": {
        "comment": "url 填 http://<网关IP>:4173/v1 也可，由 WorkBuddy 自动拼路径；若报 404 再换成 /v1/chat/completions",
        "modelNameHint": "模型名从 curl http://<网关IP>:4173/v1/models 的返回里挑，默认主力 gpt-6.1-sol"
      }
    }
  ]
}
```

---

## 2. 方案 A（推荐）：远程 MCP —— 零安装

网关内置了 `/mcp` 端点（streamable HTTP），客户端**不需要 Node.js、不需要任何文件**，
在你的 `~/.workbuddy/mcp.json` 的 `mcpServers` 里加一条：

```json
"codex-gateway-lan": {
  "url": "http://192.168.1.188:4173/mcp",
  "headers": { "Authorization": "Bearer cgw-替换为主人发给你的Key" }
}
```

重启 WorkBuddy；若弹出「自定义连接器」确认，对 `codex-gateway-lan` 点**信任**。
之后会话里就挂上了三个工具（由网关主机远程执行）：
`generate_image`（生图）/ `list_generated_images`（列**你自己**的图）/ `delete_generated_image`（删**你自己**的图）。

> 键名约定：`codex-gateway-lan` 表示"局域网远程"。**别占用 `codex-gateway` 这个名字**——
> 那是"本机自己部署"的约定键名（见第 4 节双模式共存）。

---

## 3. 安装 Skill（可选但推荐，复制即用）

把本 kit 的 `skills/codex-gateway-image` **整个文件夹**复制到你的 `~/.workbuddy/skills/` 下，重启 WorkBuddy。

Skill 的作用：教任意模型在生图任务时正确调用 MCP 工具（或 HTTP 回退）、处理返回的链接/路径。
没装 skill 时 MCP 工具也能被模型发现，但触发可靠性和迭代引导会差一些。

> 注意：kit 里**没有** `codex-gateway-dev-verify`——那是网关开发者用的回归验证 skill，客户端用户不需要。

---

## 4. 网页素材站（/gallery）：分用户的图片管理页面

浏览器打开 `http://<网关IP>:4173/gallery`（或在 WorkBuddy 里让 Agent 帮你打开——
生图成功后 Agent 的返回结果里会直接带这个链接，WorkBuddy 会在**侧边浏览器**里展示）：

| 能力 | 说明 |
|---|---|
| 登录 | 首次打开输入你自己的 `cgw-` Key（浏览器记住，之后免输） |
| 隔离 | **只显示你自己的 Key 生成的图片**；别人的看不到，宿主机控制台才可见全部 |
| 预览 | 点击缩略图看大图 |
| 复制链接 | 复制局域网内可直接打开的图片链接 |
| 下载 / 删除 | 下载原图；只能删除自己生成的图 |

工作原理：页面本身是网关主机伺服的静态单文件（局域网可达）；数据走 `/v1/gen-images/list`
与 `DELETE /v1/gen-images/<name>`，凭 Bearer Key 鉴权并按 Key 隔离。MCP 的
`list_generated_images` / `delete_generated_image` 与之同源同权限。

---

## 5. 双模式共存（自己部署 + 用别人的宿主机）

同一个 WorkBuddy 里，两种模式可以**同时配置、并存使用**——键名不同即互不冲突：

```json
"mcpServers": {
  "codex-gateway": {
    "command": "<node 绝对路径>",
    "args": ["<本机部署的 gateway/mcp-server.mjs 绝对路径>"],
    "env": { "CGW_BASE": "http://127.0.0.1:4173", "CGW_API_KEY": "cgw-自己的Key" }
  },
  "codex-gateway-lan": {
    "url": "http://192.168.1.188:4173/mcp",
    "headers": { "Authorization": "Bearer cgw-主人发的Key" }
  }
}
```

| 键名 | 含义 | 形态 | 生图执行位置 |
|---|---|---|---|
| `codex-gateway` | **本机自己部署**的网关 | stdio（本地起子进程） | 自己的 ChatGPT 订阅 |
| `codex-gateway-lan` | **局域网远程**宿主机的网关 | HTTP（只填 url） | 宿主机的 ChatGPT 订阅 |

- 模型配置同理：`workbuddy-models-codex-gateway.json`（本机）与 `workbuddy-models-codex-gateway-lan.json`（远程）并存，随取随用。
- 生图 skill 对两种模式都做了适配：**优先本机**（自己的订阅、无跨机限制），本机报「未运行/连接失败」再切远程。
- 典型场景：家里自己部署（本机模式）+ 公司用同事宿主机（远程模式），一套配置走天下。

---

## 6. 验证清单（按顺序）

| # | 命令/操作 | 期望结果 |
|---|---|---|
| 1 | 用你的 Key 请求 `http://<网关IP>:4173/v1/models` | 返回模型列表（含 `gpt-6.1-sol`）—— 网络、Key、网关三项一次验完 |
| 2 | 浏览器打开 `http://<网关IP>:4173/health` | `{"ok":true,...}` 表示宿主机账号通道正常；`503 bridge_not_running` 表示宿主机还没登录账号（找宿主机处理），此时上一条若已通过，说明你的接入没问题 |
| 3 | WorkBuddy 新会话查看 MCP 工具 | 出现 `generate_image` / `list_generated_images` / `delete_generated_image` |
| 4 | 让 agent「画一张测试图」 | 返回「链接」+「网页素材站」两个地址；链接打开能看到图 |
| 5 | 浏览器打开返回的素材站链接，输入你的 Key | 能看到刚才那张图（且只有你的图） |
| 6 | 素材站里点「删除」刚才那张测试图 | 图消失；再调 `list_generated_images` 确认 |

---

## 7. 已知边界

- `reference_paths` 按**网关主机**磁盘路径解析：传你本机路径无效（主机读不到你的盘）
- 生图链接文件名含随机 UUID 片段、不可枚举，视作能力令牌——**不要外传到局域网之外**
- 素材站按 Key 隔离：你只能看到/删除**自己**生成的图；kit 接入前宿主机上已存在的旧图归宿主机所有，仅主机控制台可见
- 访问 `/__gw/*` 返回 403 `control_plane_local_only` 是**正常安全设计**（账号/密钥/配置管理仅限主机本机；单个生成图 GET 是唯一放行例外）
- 生图走宿主机的 ChatGPT 订阅额度，高峰期可能 429

---

## 8. 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| 401 `missing_api_key` / `invalid_api_key` | Key 错误或已被吊销 → 找主人重建 |
| 连接拒绝 / 超时 | 主机没开 `--lan`；主机防火墙没放行（只放行**专用网络**）；不在同一网段 |
| 403 `control_plane_local_only` | 打到控制面了；客户端只应使用 `/v1/*`、`/mcp` 与生成图链接 |
| MCP 工具没出现在会话里 | mcp.json 键名/格式检查；重启 WorkBuddy；自定义连接器页是否点了信任 |
| 素材站打开后一直要 Key / 提示无效 | Key 错误或被吊销 → 找主人重建；浏览器曾存旧 Key → 点右上「换 Key」重输 |
| 素材站里看不到别人的图 | 这是**按 Key 隔离**的正常设计，不是故障 |
| 429 | 限流/额度用尽，稍后再试 |
| 生图返回的链接打不开 | 确认从**局域网内**访问；主机防火墙放行 4173 端口 |

---

## 9. 安全须知

- 局域网模式 = 网关主人把**自己的 ChatGPT 订阅**开放给同网段设备，仅限可信网络短时开启
- 你的 Key 等同你的使用身份：泄露立刻告知主人吊销重建
- 生成图片链接在局域网内凭文件名即可访问，请勿把链接发到局域网外

---

## 附：方案 C（旧式 stdio，需要 Node.js）

若你的客户端不支持远程 HTTP MCP，退回拷文件方式：
1. 本机装 Node.js；把本 kit 的 `mcp-server.mjs` 放到固定位置（如 `C:\Users\你\cgw\`）
2. mcp.json 注册（`CGW_BASE` 填**网关主机地址**，不是 127.0.0.1）：

```json
"codex-gateway-lan": {
  "command": "<node 绝对路径>",
  "args": ["C:\\Users\\你\\cgw\\mcp-server.mjs"],
  "env": { "CGW_BASE": "http://192.168.1.188:4173", "CGW_API_KEY": "cgw-你的Key" }
}
```

> stdio 版跑在**你本机**，`list_generated_images` 读的是你本机磁盘（会提示图库为空）——这是它与远程版的本质差异，故推荐方案 A。

---

> 本 kit 内的 `mcp-server.mjs` / `SKILL.md` 为分发快照；最新版以网关仓库
> `gateway/mcp-server.mjs` 与 `~/.workbuddy/skills/codex-gateway-image/` 为准。
