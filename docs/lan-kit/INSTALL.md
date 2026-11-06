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

桌面版默认本机端口为 **4173**、局域网共享端口为 **4174**。下文示例中的端口请以「局域网共享」页面实际地址为准；命令行版历史配置可能仍为 4173。下载接入脚本会保留页面的共享端口。

只配置对话模型不等于配置了生图工具。Agent 推荐连接同一地址的 `/mcp`，加载 `generate_image` 后再发出图片请求。素材页本身负责管理图片，不是出图表单。

1. 浏览器打开 **`http://<宿主机IP>:4173/setup`**（地址由主人提供，或用主人控制台「接入」按钮复制来的邀请）
2. 输入主人发给你的 `cgw-` Key → 验证通过，页面显示你的身份（Key 名 · 已生成图片数）
3. 推荐点击 **「复制给 Agent 的配置提示词」**，粘贴给能操作本机文件的 Agent，由它合并 MCP、安装生图 Skill 并验证连接。提示词包含当前 Key，页面预览已隐藏密钥。也可以继续按页面逐项手动复制／下载配置。
4. 验证：重启 WorkBuddy 后对 Agent 说「画一张测试图」；素材站在 `http://<宿主机IP>:4173/gallery`
   （Key 只存你自己浏览器、输入一次即可，页面头部会显示「我是谁 · 几张图」）

---

## 0+. 备选路径：一条命令，或一段 Prompt

**方式一：一键配置脚本**（本 kit 自带 `setup-client.mjs`，零依赖，只要本机有 Node）：

```bash
node setup-client.mjs --host 192.168.1.188 --key cgw-主人发给你的Key
```

一条命令同时完成：mcp.json 写入远程 MCP 条目 + 安装 GPT 图片生成 skill + 生成模型配置 JSON。
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

把本 kit 的 `skills/codex-gateway-image` **文件夹内容**复制到你的 `~/.workbuddy/skills/gpt-image/` 下（源文件夹名称保留用于兼容，安装名为 `gpt-image`），重启 WorkBuddy。

Skill 的作用：教任意模型在生图任务时正确调用 MCP 工具（或 HTTP 回退）、处理返回的链接/路径。
没装 skill 时 MCP 工具也能被模型发现，但触发可靠性和迭代引导会差一些。

> 注意：kit 里**没有** `codex-gateway-dev-verify`——那是网关开发者用的回归验证 skill，客户端用户不需要。

---

## 4. 网页素材站（/gallery）：分用户的图片管理页面

浏览器打开 `http://<网关IP>:4173/gallery`（或在 WorkBuddy 里让 Agent 帮你打开——
生图成功后 Agent 的返回结果里会直接带这个链接，WorkBuddy 会在**侧边浏览器**里展示）：

| 能力 | 说明 |
|---|---|
| 登录 | 首次打开输入你自己的 `cgw-` Key（浏览器记住，之后免输）；点右上「换 Key」可换成主人新发的 Key |
| 隔离 | **只显示你自己的 Key 生成的图片**；别人的看不到，宿主机控制台才可见全部 |
| 预览 | 点击缩略图看大图 |
| 复制链接 | 复制需携带同一个 API Key 的下载地址；普通浏览器查看图片请打开 `/gallery` 并输入该 Key |
| 下载 / 删除 | 下载原图；只能删除自己生成的图 |

宿主机控制台的「图片素材」可查看全部生成图；`/gallery` 是个人图库，只列出登录 Key 生成的图片。不带 Key 的本机请求不会自动归属某位用户。Agent 侧边浏览器可打开同一 `/gallery` 页面；每个浏览器分别记住登录 Key。内置浏览器若限制下载，可在系统浏览器打开同一素材页。

**换 Key**：点右上「换 Key」→ 输入主人新发的 Key → 点「验证并更换」。页面会先用 `GET /v1/gen-images/me` 只读校验新 Key，通过后才写入本浏览器；验证失败会保留原 Key，中途点「取消，继续使用原 Key」可原样退回。换 Key **不会迁移也不会删除**旧图（旧图仍归原 keyId），要留旧图请先在旧 Key 下下载，或找宿主机在控制台「图片素材」取回。页面内的换 Key 与删除确认都不使用浏览器原生弹窗，因此在 WorkBuddy 侧边浏览器里也能正常操作。

工作原理：页面本身是网关主机伺服的静态单文件（局域网可达）；数据走 `/v1/gen-images/list`
与 `DELETE /v1/gen-images/<name>`，凭 Bearer Key 鉴权并按 Key 隔离。MCP 的
`list_generated_images` / `delete_generated_image` 与之同源同权限。

---

## 4+. 换 Key：对话模型与 MCP 必须同时换

客户端的 `cgw-` Key 会同时存在于**至少两处**，彼此独立、不会自动同步：

| 位置 | 用途 | 常见文件 / 字段 |
|---|---|---|
| 对话模型配置 | `POST /v1/chat/completions` | `workbuddy-models-codex-gateway-lan.json`，或客户端模型设置里 `url` 指向 `<网关>/v1` 的 `apiKey` |
| 生图 MCP | `/mcp` 的 `generate_image`、`/v1/images/generations` | `~/.workbuddy/mcp.json` → `mcpServers[*].headers.Authorization` |
| 浏览器素材站 | 只影响网页看图 | `/gallery` 的 localStorage `cgw_gallery_key`（网页右上「换 Key」） |
| 记录文件 | **不存 Key** | `cgw-client-assets.json` |

**避免分叉**：换 Key 一律用宿主机「客户端接入」→ 模式「更换 API Key」生成的 Prompt。新版会枚举以上位置、把前两处统一替换成新 Key，并分别请求 `/v1/gen-images/me` 比对 `keyId`；「更新 Skill / MCP」Prompt 不含 Key，不能代替换 Key；也不要只手动改 `mcp.json`。换完让用户在 `/gallery` 也换成同一把 Key。

**已经分叉怎么办**：

1. 宿主机控制台「调用日志」搜索框输入该用户 IP 或 Key 名称。同一 IP 出现两个不同的「密钥名 · keyId 后 8 位」就是分叉；`/v1/chat/completions` 那条是模型侧，`/mcp` 与 `/v1/images/generations` 是出图侧。401 激增通常是某处仍留着已被禁用/删除的旧 Key。
2. 首选干净重来：让用户在自己的 Agent 里执行宿主机生成的「**完全卸载**」Prompt（不含 Key、先备份、只删指向本网关的模型配置 / MCP / Skill / 记录，保留其他配置，不删网关图片）→ 重新加载客户端 → 再用同一把新 Key 的「首次配置」Prompt 一次装回。
3. 或者直接执行新版「更换 API Key」Prompt：它会把两处一起改并报告一致性；若报告「模型侧仍是旧 Key」，按它给出的文件路径手动改 `apiKey`。
4. 到 `/gallery` 退出旧 Key、用新 Key 登录。旧图不会迁移；宿主机控制台「图片素材」现在可按来源用户（生成时所用 API Key）筛选后取回。

「完全卸载」Prompt 在网页 `/setup` 无需验证 Key 也能复制（门禁卡片和 Agent 配置卡片各有一个入口），桌面控制台「客户端接入」也有「完全卸载」模式。要彻底收回访问权，还需宿主机在「API Key」页禁用或删除对应 Key。

后台「图片素材」筛选器按落盘时的 `keyId` 分组，显示当时的 Key 名称与 keyId 后 8 位；Key 被改名或删除后，历史图片仍归原 keyId，可继续筛选（名称显示为「已删除的 Key」）。早于归属字段的版本生成的图归入「无归属（旧图）」。

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
| 2 | 浏览器打开 `http://<网关IP>:4173/health` | `{"ok":true}` 表示宿主机账号通道正常；`503 bridge_not_running` 表示宿主机还没登录账号（找宿主机处理），此时上一条若已通过，说明你的接入没问题。远程只返回结论字段（登录态/限流/版本等细节仅限宿主机本机查看） |
| 3 | WorkBuddy 新会话查看 MCP 工具 | 出现 `generate_image` / `list_generated_images` / `delete_generated_image` |
| 4 | 让 agent「画一张测试图」 | 返回「链接」+「网页素材站」两个地址；链接打开能看到图 |
| 5 | 浏览器打开返回的素材站链接，输入你的 Key | 能看到刚才那张图（且只有你的图） |
| 6 | 素材站里点「删除」刚才那张测试图 | 图消失；再调 `list_generated_images` 确认 |

---

## 7. 已知边界

- `reference_paths` 按**网关主机**磁盘路径解析：传你本机路径无效（主机读不到你的盘）。且路径**必须位于网关的参考图目录**（默认 `gateway/references/`，宿主机可在 `.gw-config.json` 的 `referenceRoot` 里改）——传目录外的路径会被直接拒绝；URL 与 data-URL 不受此限制
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
| 换 Key / 配置 Prompt 里的目标网关是 `127.0.0.1:<共享端口>` | 宿主机在共享端口的回环页用「网关本机用户」生成后转发给了别的电脑，这种 Prompt 不可转发。请宿主机在「客户端接入」改选「局域网用户」或用管理端口的本机接入页重新生成；客户端不要自行替换 IP，否则素材页、Skill 下载与身份检查地址会混用两套地址 |
| 素材站打开后一直要 Key / 提示无效 | Key 错误或被吊销 → 找主人重建；浏览器曾存旧 Key → 点右上「换 Key」重输 |
| 点素材站「换 Key」没反应 | 旧版本用了浏览器原生确认框，在 WorkBuddy 侧边浏览器 / 内嵌页里会被静默拦截。升级到含页面内换 Key 的版本后：点击应立即变成「更换 API Key」页（有输入框、验证并更换、取消按钮）；若页面毫无变化，先在系统浏览器打开同一 `/gallery` 应急，再让宿主机更新桌面版资源 |
| 同一台电脑调用日志出现两个 keyId / 能聊天但出图身份不对 | 对话模型与 MCP 用了不同 Key → 见「4+. 换 Key」；先用「完全卸载」Prompt 清干净，再用「首次配置」Prompt 一次装回 |
| 401 突然增多 | 某处配置仍留着已被禁用/删除的旧 Key；在调用日志按 IP / 密钥名定位端点，模型侧是 `/v1/chat/completions`，出图侧是 `/mcp` 或 `/v1/images/generations` |
| 想彻底清掉某台电脑的接入配置 | 用宿主机生成的「完全卸载」Prompt（不含 Key、先备份、保留其他连接器与模型）；之后重新用「首次配置」Prompt 装回 |
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
> `gateway/mcp-server.mjs` 与 `~/.workbuddy/skills/gpt-image/` 为准。


## 更新 Skill / MCP（推荐 Prompt）

在桌面「客户端接入 → 更新 Skill / MCP」或网页 `/setup` 复制更新 Prompt，交给目标 Agent 执行。它会读取 `/client-assets.json`，对比 Skill、MCP 工具定义与配置 Prompt 的 SHA-256；备份并合并配置、验证工具加载后保存本地版本记录。HTTP MCP 的服务端随网关更新，客户端需要重新连接以刷新工具定义。无需生成图片来验证更新。

生图 Skill 的名称为 `gpt-image`（`/gpt-image`），中文「GPT 图片生成」。旧 `codex-gateway-image` 安装应备份到 Skill 发现目录之外再迁移，保留自定义内容，避免启用两份。每次生成成功后由 Agent 的浏览器工具打开/刷新素材页；无浏览器工具时返回链接。素材站使用同一 Key，不能在 URL 中传密钥。

调用日志记录真实连接 IP、密钥名称与 ID；可选 `X-CGW-Device-Name` 请求头为 URI 编码的自报设备标签，不能作为鉴权依据。建议每人/每设备使用独立 Key，不共享密钥，便于区分与停用。


## 用户电脑无需安装网关：先区分本机与远程

HTTP MCP 在网关主机上执行。用户电脑只需支持 Streamable HTTP MCP 的 Agent 和自己的 API Key，不需要安装 Codex Gateway、Node.js 或复制宿主机账号。生图 Skill 下载和素材页也使用同一台主机地址。

- 网关本机：`http://127.0.0.1:4173/mcp`，仅供网关这台电脑使用。
- 其他电脑：`http://<网关主机IP>:<共享端口>/mcp`。桌面版默认共享端口为 4174，以「局域网共享」显示的实际地址为准；命令行版的端口以实际启动参数为准。
- 接入页：同一共享地址下的 `/setup`；素材页：`/gallery`。两台电脑必须网络互通；Tailscale 地址只适用于可互通的 Tailscale 网络。网关主机需要保持运行。

在桌面「客户端接入」先选择 Agent 在“网关这台电脑”还是“其他设备”；远程接入前先开启共享。也可直接从「局域网共享」复制远程 MCP Prompt 或共享接入页地址。不要把本机的 `/setup` 配置复制给另一台电脑。

### 已误配置成 localhost 时的修复 Prompt

```text
这是连接另一台电脑的远程 HTTP MCP，用户电脑不需要安装或启动 Codex Gateway。
正确的网关共享地址是：<粘贴网关主机共享地址，包含协议和端口>
请备份当前 MCP 配置，修复本次误写为 127.0.0.1:4173 的条目，沿用该条目中已有的 API Key 和设备名，不显示完整 Key，不修改对话模型或其他正常连接器。
将本连接器及 Skill 下载、素材页、更新清单的地址统一改为上述主机地址，使用 codex-gateway-lan 名称；若同名条目属于另一台主机，保留它并为新连接器选唯一名称。
然后获取 /client-assets.json、用 Bearer Key 检查 /v1/gen-images/me，并向 /mcp 发送 JSON-RPC tools/list（Accept: application/json, text/event-stream），实际确认 generate_image、list_generated_images、delete_generated_image，正确解析 JSON/SSE。
连通后下载并安装 gpt-image Skill，说明是否需要信任或重新加载连接器。只检查连接，不自动生成或删除图片。
```

`10061` / connection refused 只说明目标地址没有监听，不代表远程主机的网关停机。若目标是 `127.0.0.1`，先检查是否误用了本机地址。远程地址连接失败再检查主机共享、网络和端口；401/403 检查 Key/权限；`/health` 返回 JSON 503 表示网关已可达但上游未就绪。


网页 `/setup` 同样先选择“网关本机用户”或“局域网用户”。在主机的回环页面为局域网用户生成 Prompt 时，页面会读取当前实际开启的共享地址；共享未开启、读取失败或只有回环地址时停止生成，不自动回退本机地址。切换用户类型或共享地址会使之前的密钥验证与配置失效，需要重新验证。Prompt、MCP、Skill 下载、素材页及更新清单均跟随所选地址。

**带 `127.0.0.1` 的 Prompt 不能转发给其他电脑。** 首次配置、更换 API Key、更新 Skill / MCP 三类 Prompt 都会写入「范围限制」：回环目标只对生成它的网关本机有效，接收方 Agent 会先停住并要求用共享地址重新生成；仅端口相同不算地址匹配。共享端口的回环页（例如 `http://127.0.0.1:4174/setup`）由服务端注入管理端口的本机规范地址，因此选「网关本机用户」时会被直接拒绝，并提示去 `http://127.0.0.1:4173/setup` 或改选「局域网用户」。换 Key 只替换匹配连接器的凭据；升级 Skill / MCP 定义请用不含 Key 的「更新 Skill / MCP」Prompt，两者不要合并。
