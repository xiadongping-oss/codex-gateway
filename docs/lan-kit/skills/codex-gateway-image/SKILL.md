---
name: codex-gateway-image
display_name_zh: ImageGen 2.5
display_name_en: ImageGen 2.5
description: 通过 Codex 网关生成图片（ImageGen 2.5）。当当前模型没有原生生图能力、或用户要求用网关/Codex 生图时触发。调用网关 MCP 工具 generate_image（或 HTTP 回退），返回图片链接/本地路径，可用 Read 查看结果做视觉理解并迭代；生成后附网页素材站链接（/gallery，分用户管理）。支持本机网关与局域网网关，两种模式可共存（codex-gateway=本机，codex-gateway-lan=远程）。
agent_created: true
---

# ImageGen 2.5（Codex 网关生图）

把生图任务交给 Codex 网关（OpenAI 图像模型执行），任何模型都可调用。
网关可以在本机（`127.0.0.1:4173`），也可以是局域网内另一台主机——**两种模式可同时配置、共存使用**。

## 何时使用

- 当前会话模型没有原生图片生成能力，且用户要求「画 / 生成 / 绘制图片」
- 用户明确要求用「网关」「Codex」生图
- 需要参考图生成风格协调的新图

## 首选方式：MCP 工具

会话里可能挂着**两套**网关生图工具（键名约定：`codex-gateway`=本机部署，`codex-gateway-lan`=局域网远程），任一可用即可直接调用：

- `generate_image({ prompt, size?, quality?, reference_paths? })`
  - `prompt`：具体描述（主体 / 风格 / 构图 / 色调）
  - `size`：`1024x1024` | `1024x1536`（竖版）| `1536x1024`（横版）| `auto`（缺省，按内容选比例）
  - `quality`：`low` | `medium` | `high`（缺省）| `auto`
  - `reference_paths`：参考图路径数组（≤8 张）。**注意：路径以「网关主机」磁盘视角解析**——本机网关传本机路径；局域网网关必须传网关主机上的路径，传你本机路径无效。且本地路径**必须位于网关的参考图目录**（默认 `gateway/references/`）内，目录外路径会被拒绝；URL 与 data-URL 不受限制
  - 返回：本机模式给 `文件（local_path）` + `链接（url）`；局域网模式给可直达的 `链接（url）`（浏览器可打开）+ 主机侧路径
- `list_generated_images({ limit? })`：列出**你当前 Key 自己生成**的图（新→旧）。远程 MCP（HTTP 端点）由网关主机代读、远程可用；本机 stdio 版读本机图库（宿主机视角=全部）
- `delete_generated_image({ name })`（仅远程 HTTP 端点提供）：删除一张**你自己生成的**图片，按 list 返回的 `name`

**双模式共存时的选择**：优先本机 `codex-gateway`；若报「连接失败 / 网关未运行」再换 `codex-gateway-lan`。工具前缀不同（`mcp__codex-gateway__*` / `mcp__codex-gateway-lan__*`），以会话实际挂载的为准。

## 回退方式：HTTP 直连（MCP 未连接时）

从 `~/.workbuddy/mcp.json` 解析网关地址与 Key（按下表顺序，找到即用）：

| mcpServers 条目 | 地址来源 | Key 来源 |
|---|---|---|
| `codex-gateway`（本机 stdio） | `env.CGW_BASE`（缺省 `http://127.0.0.1:4173`） | `env.CGW_API_KEY` |
| `codex-gateway-lan`（远程 HTTP） | `url` 的 origin（如 `http://192.168.1.188:4173`） | `headers.Authorization`（去掉 `Bearer ` 前缀） |

两个条目都没有 → 向网关主人要地址和 Key，直接替换命令里的 `<CGW_BASE>` / `<KEY>`：

```bash
curl -s -X POST <CGW_BASE>/v1/images/generations \
  -H "Authorization: Bearer <KEY>" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"...","size":"1024x1024","quality":"high"}'
```

响应 `data[0]` 含 `b64_json`、`url`（跟随访问地址，局域网下可直接打开）、`local_path`（网关主机磁盘路径）、`revised_prompt`。

## 结果处理

1. **本机网关**：把 `local_path` 告知用户；需要确认效果时用 Read 读取 `local_path` 做视觉理解，再按反馈迭代 prompt
2. **局域网网关**：把返回的 `链接（url）` 给用户（浏览器直接打开）；如需视觉理解迭代，先 `curl -o` 下载到本机再用 Read 查看
3. **打开网页素材站（重要）**：局域网模式下生成成功后，结果里带 `网页素材站：http://<host>:4173/gallery` 链接 —— **立即把该 URL 作为可预览链接展示/打开**（WorkBuddy 会进入侧边浏览器面板）。用户首次打开需输入自己的 `cgw-` Key（浏览器记住），之后可自助浏览 / 复制链接 / 下载 / 删除自己的全部生成图
4. 若返回 `isError`（如 429 限流 / bridge 未运行），原样转述错误并建议在网关控制台「账号管理」检查状态

## 注意

- 严格鉴权开启时所有 /v1 请求必须带 key；key 泄露可在控制台「API Key」页吊销重建
- 网关未运行时先在网关主机上启动（控制台「账号管理 → 网关运行控制」或 `npm start`；局域网模式加 `--lan`）
- 生图链接含不可猜测的随机文件名，视作能力令牌，不要外传到局域网之外
