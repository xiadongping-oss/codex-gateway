# Agent 安装与部署 Prompt（复制即用）

> 用法：把对应角色的 Prompt 整段复制给你的 AI Agent（WorkBuddy / Claude Code 等），
> 先把 `<尖括号>` 占位符替换成实际值。Agent 会按步骤执行并自验。

推荐先打开实际网关地址的 `/setup`，验证自己的 Key 后，点击 **「复制给 Agent 的配置提示词」**。该提示词自动带入本机／局域网地址、实际端口、连接器名称和 Key，包含 MCP 合并、Skill 安装与连接验证步骤；预览隐藏 Key，复制时才填入。只做配置检查，不自动生成图片。

---

## Prompt A：宿主机部署（拿到发布包 zip 的机器）

```text
请帮我在本机部署 codex-gateway 局域网网关（服务启动器绿色版）。

包位置：<zip 文件完整路径，例如 C:\Users\me\Downloads\codex-gateway-v1.3.1-win64.zip>
安装目录：<例如 C:\codex-gateway>

请按以下步骤执行，每步失败就停下并告诉我原因：
1. 解压 zip 到安装目录（保留目录结构）。
2. 用包内自带的 node 运行：<安装目录>\gateway\service\node\node.exe <安装目录>\gateway\launcher.mjs --lan
   （后台运行；也可直接双击 <安装目录>\gateway\service\start-gateway.vbs 启动并注册开机自启）
3. 等待 3 秒后访问 http://127.0.0.1:4173/health 确认服务已起来。
   **判定标准：只要返回任何一段 JSON 就算就绪**——此时还没有登录账号，返回
   503 {"ok":false,"error":"bridge_not_running"} 是**正常状态**，不是故障。
   只有连接被拒绝 / 返回 403 / 返回 HTML 才算失败，那时才停下报我。
4. 打开控制台 http://127.0.0.1:4173/ ，在「账号管理」完成 ChatGPT 账号 OAuth 登录
   （浏览器打开授权页 → 授权 → 回到控制台确认登录态有效）。
5. 在控制台「API Key」页创建一个 Key（名字用我的称呼），把 cgw- 开头的 Key 告诉我。
6. 从控制台「局域网接入」面板读出本机局域网 IP（192.168.x.x），告诉我：
   「局域网地址 = <IP>:4173」+ 上面那个 Key，并提醒我把这两样发给需要的局域网同事。
7. 防火墙放行：为本机 4173 端口加入站规则（需要管理员权限时给出确切命令让我确认执行）。

完成后给我一张表：安装目录 / 服务状态 / 局域网地址 / API Key / 素材站地址。
不要把 Key 发到任何外部服务。
```

---

## Prompt B：局域网用户接入（已知宿主机地址 + Key，零安装）

```text
请把我的 WorkBuddy（或本机其他 Agent 工具）接入局域网里的 codex-gateway 网关。
这是我拿到的接入信息：
  宿主机地址：<例如 192.168.1.188:4174，以实际共享端口为准>
  我的 API Key：<cgw-xxxxxxxx>

优先方式（推荐，最省事）：如果网关宿主机给了我 lan-kit 安装包，先找到里面的
setup-client.mjs，然后执行：
  node setup-client.mjs --host <宿主机IP> --port <端口，默认4173> --key <我的Key>
（本机没有 Node 时，或找不到安装包，再退回手动方式。）

手动方式（任选其一执行）：
1. 修改 ~/.workbuddy/mcp.json（没有就新建），在 mcpServers 里加：
     "codex-gateway-lan": {
       "url": "http://<宿主机IP>:<端口>/mcp",
       "headers": { "Authorization": "Bearer <我的Key>" }
     }
   其他已有条目必须原样保留。
2. 安装生图 Skill：从 http://<宿主机IP>:<端口>/lan-kit/skills/codex-gateway-image/SKILL.md
   下载，验证包含有效 YAML frontmatter，然后安装到客户端的用户 Skill 目录。
   WorkBuddy 使用 ~/.workbuddy/skills/gpt-image/SKILL.md；其他客户端按实际支持配置。
   修改前备份；保留其他连接器及用户配置，不将 Key 写进 Skill。
3. （可选）生成模型配置文件 workbuddy-models-codex-gateway-lan.json，内容指向
   http://<宿主机IP>:<端口>/v1/chat/completions，apiKey 用我的 Key。

配置完成后逐项验证并给我结果：
  a. 用我的 Key 调 http://<宿主机IP>:<端口>/v1/models 能列出模型（默认主力 gpt-6.1-sol）
     —— 这是**权威判据**：它同时证明网络可达、我的 Key 有效、网关在工作。
  b. 另外看一眼 http://<宿主机IP>:<端口>/health（不需要 Key）：返回 200 表示宿主机账号
     通道正常；返回 503 {"error":"bridge_not_running"} 表示宿主机还没登录账号或通道没起来，
     这时请提醒我去找宿主机的人，**不要判定为我的接入失败**（a 已通即接线正确）。
  c. 用我的 Key POST http://<宿主机IP>:<端口>/mcp 执行 tools/list，应列出
     generate_image / list_generated_images / delete_generated_image 三个工具
  d. 告诉我网页素材站地址 http://<宿主机IP>:<端口>/gallery ，
     并在 WorkBuddy 侧边浏览器里帮我打开它（首次需输入我的 Key）

注意：不要把我的 Key 写进任何会同步到云端的文件，也不要发给别人。
只把 Key 保存到客户端私有配置／凭据存储，最终回复显示掩码。
只验证连接，不生成或删除图片；分别报告文件已配置、API 已验证、当前会话工具是否已加载。
```

---

## 说明

| 角色 | 用哪段 | 产出 |
|---|---|---|
| 网关宿主机（服务提供者） | Prompt A | 本机跑起 `--lan` 网关 + OAuth 登录 + 分发 Key |
| 局域网用户（服务使用者） | Prompt B | mcp.json 远程 MCP + skill + 模型配置，全程零安装 |


## 更新 Skill / MCP（推荐 Prompt）

在桌面「客户端接入 → 更新 Skill / MCP」或网页 `/setup` 复制更新 Prompt，交给目标 Agent 执行。它会读取 `/client-assets.json`，对比 Skill、MCP 工具定义与配置 Prompt 的 SHA-256；备份并合并配置、验证工具加载后保存本地版本记录。HTTP MCP 的服务端随网关更新，客户端需要重新连接以刷新工具定义。无需生成图片来验证更新。

生图 Skill 的名称为 `gpt-image`（`/gpt-image`），中文「GPT 图片生成」。旧 `codex-gateway-image` 安装应备份到 Skill 发现目录之外再迁移，保留自定义内容，避免启用两份。每次生成成功后由 Agent 的浏览器工具打开/刷新素材页；无浏览器工具时返回链接。素材站使用同一 Key，不能在 URL 中传密钥。

调用日志记录真实连接 IP、密钥名称与 ID；可选 `X-CGW-Device-Name` 请求头为 URI 编码的自报设备标签，不能作为鉴权依据。建议每人/每设备使用独立 Key，不共享密钥，便于区分与停用。
