// Shared by the public setup page and desktop client. Never persist credentials here.
(function(root) {
'use strict'
  function buildClientPrompt(options) {
    var base = new URL(options.base).origin
    var secret = options.key
    var connectorName = /^(localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)$/i.test(new URL(base).hostname) ? 'codex-gateway' : 'codex-gateway-lan'
    var config = { mcpServers: {} }
    config.mcpServers[connectorName] = { url: base + '/mcp', headers: { Authorization: 'Bearer ' + secret, ...(options.device ? { 'X-CGW-Device-Name': encodeURIComponent(options.device.trim().slice(0,80)) } : {}) } }
    var lines = [
      '请为我当前使用的 Agent 客户端配置 Codex Gateway 的 MCP 和生图 Skill，并实际完成配置与连接检查。',
      '',
      '接入信息（保留完整地址和端口）：',
      '网关地址：' + base,
      '连接器名称：' + connectorName,
      'MCP 配置：',
      '```json', JSON.stringify(config, null, 2), '```',
      '生图 Skill 下载地址：' + base + '/lan-kit/skills/codex-gateway-image/SKILL.md',
      '我的素材页：' + base + '/gallery',
      '',
      '请按以下步骤操作：',
      '1. 识别我实际使用的 Agent 客户端、现有用户配置位置和支持的 MCP 格式。WorkBuddy 使用 ~/.workbuddy/mcp.json；其他客户端按其实际格式配置，不要误写到 WorkBuddy 目录。如果无法确定目标客户端，只询问客户端名称。',
      '2. 修改前备份已有配置；合并上面的连接器，保留其他连接器、偏好和已有模型配置。本机 codex-gateway 与远程 codex-gateway-lan 可以共存。同名条目若指向不同网关，保留原条目，为新连接器选唯一名称，不要直接覆盖。配置损坏时保留原文件并报告具体原因。',
      '3. 从上面的 Skill 地址下载内容，检查为带 YAML frontmatter 的有效 SKILL.md；根据目标客户端的用户 Skill 目录安装。WorkBuddy 路径是 ~/.workbuddy/skills/gpt-image/SKILL.md。Skill 名称为 gpt-image，中文名为 GPT 图片生成。旧 codex-gateway-image 先备份到 Skill 发现目录之外，再迁移名称，保留用户修改并避免重复启用。已有文件不同则先备份，不丢弃用户修改；客户端不支持 Skill 时明确说明，但继续验证 MCP。',
      '4. API Key 只保存到本机客户端的私有配置或凭据存储；不要写进项目仓库、Skill、下载网址、日志或最终回复。最终只显示掩码 Key。不要更改网关账号、共享设置或系统防火墙。',
      '5. 用这个 Key 的 Bearer 请求头分别检查 ' + base + '/v1/models 和 ' + base + '/v1/gen-images/me；再向 ' + base + '/mcp 发送 JSON-RPC tools/list（Accept 同时声明 application/json 和 text/event-stream），确认 generate_image、list_generated_images、delete_generated_image。正确解析 JSON 或 SSE 响应；不要仅凭 HTTP 200 判定通过。另检查 ' + base + '/health，单独报告上游状态，不将连接通过等同于真实出图已验证。',
      '6. 只做无出图成本的连接检查，不调用 generate_image，也不删除图片。将文件配置成功、接口检查成功、当前会话工具已加载分别报告。若需要用户重新加载连接器、重启客户端或完成信任操作，请指出确切位置，不要声称当前会话已可用。',
      '7. 完成后给我配置文件与备份位置、MCP/Skill 安装结果、各项验证结果、素材页地址和剩余操作。说明素材页使用与 MCP 相同的 Key，图片按 Key 分开显示；后续可让我发“调用网关 generate_image 生成一张图片”。',
      '',
      '请只处理上述 MCP 与 Skill 配置，保留现有对话模型设置。'
    ]
    lines.splice(1,0,
      '更新清单：' + base + '/client-assets.json（记录网关版本、Skill SHA-256、MCP 工具定义 SHA-256 和配置 Prompt SHA-256）。',
      '配置成功后，在用户配置目录保存 cgw-client-assets.json：仅记录网关地址、连接器名称和已验证安装的哈希，不保存密钥。',
      '每次出图成功后，使用可用的浏览器/预览工具打开或激活返回的 gallery_url 素材页；复用侧边页并刷新到新图。没有浏览器工具则提供可点击链接，不声称已打开。',
      '设备名仅为自报标签，可在 MCP 请求头 X-CGW-Device-Name 中传入 URI 编码的设备名；真实来源 IP 由网关连接记录。'
    )
    if (options.update) lines.splice(0,1,
      '请更新我当前 Agent 客户端已配置的 Codex Gateway MCP 和生图 Skill，并实际验证。',
      '先读取现有连接器与 cgw-client-assets.json，并获取上述更新清单；按内容哈希比较。清单获取失败时停止更新并保留现有配置，不把失败当成已是最新。',
      '更新前备份；保留现有凭据、设备名、其他 MCP、自定义 Skill 内容和模型设置。连接器地址匹配后更新该条目，不重复新增；自定义 Skill 与新版冲突时保留两份并说明差异。',
      'HTTP MCP 服务端随网关升级，无需下载服务端；重新连接并 tools/list 验证新工具定义。若现有使用旧 stdio 客户端，备份后按下面 HTTP 配置迁移，保留旧文件供回退。',
      '分别验证 Skill 文件原始字节的 SHA-256、MCP tools/list 的 result.tools 数组经 JSON.stringify 后 UTF-8 字节的 SHA-256，以及配置结果，再更新本地哈希记录。区分网关已升级、文件已更新、当前会话已重新加载；尚未加载的必须告知剩余操作。'
    )
    return lines.join('\n')
  }

root.CGWClientSetup = { buildClientPrompt };
})(globalThis);
