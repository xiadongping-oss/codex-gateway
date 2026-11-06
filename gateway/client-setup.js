// Shared by the public setup page and desktop client. Never persist credentials here.
(function(root) {
'use strict'
  function isLoopbackBase(base) {
    return /^(localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)$/i.test(new URL(base).hostname)
  }
  // 回环地址生成的「更新 / 换 Key」Prompt 一旦转发给别的电脑，Agent 会因为找不到匹配连接而卡住，
  // 或者更糟——按端口相同去猜一个本机连接。把范围限制写进 Prompt 正文，让接收方第一时间停住并要求重发。
  function scopeLine(base) {
    return isLoopbackBase(new URL(base).origin)
      ? '范围限制：目标网关是 127.0.0.1 / localhost，本 Prompt 只对生成它的网关本机有效，禁止转发给其他设备。其他电脑必须由网关主机在「客户端接入」选择“局域网用户”、使用共享地址重新生成；仅端口相同但主机地址不同的连接不算匹配。'
      : '范围限制：只处理地址与上述目标网关完全一致的现有连接；127.0.0.1 / localhost 永远指执行请求的那台电脑，仅端口相同不算匹配。'
  }
  function buildMcpConfig(options) {
    var url = new URL(options.base)
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password || ['0.0.0.0','[::]'].includes(url.hostname)) throw new Error('请使用可访问的网关地址，不能使用监听通配地址或带凭据的 URL。')
    if (options.target === 'remote' && isLoopbackBase(url.origin)) throw new Error('其他设备不能连接 127.0.0.1 / localhost，请选择网关主机的共享地址。')
    var name = isLoopbackBase(url.origin) ? 'codex-gateway' : 'codex-gateway-lan'
    return {mcpServers:{[name]:{url:url.origin+'/mcp',headers:{Authorization:'Bearer '+options.key,...(options.device?.trim() ? {'X-CGW-Device-Name':encodeURIComponent(options.device.trim().slice(0,80))} : {})}}}}
  }
  function buildUpdatePrompt(base) {
    return [
      '请更新我当前 Agent 客户端已配置的 Codex Gateway MCP 和生图 Skill，并实际验证。',
      '本次仅更新 Skill/MCP，保留现有凭据。本 Prompt 不携带新 API Key，不授权更换用户身份。',
      '网关地址：' + base,
      scopeLine(base),
      '更新清单：' + base + '/client-assets.json',
      '生图 Skill 下载地址：' + base + '/lan-kit/skills/codex-gateway-image/SKILL.md',
      '素材页：' + base + '/gallery',
      '1. 先识别实际客户端、读取现有连接器与 cgw-client-assets.json；只处理地址匹配的连接，不重复新增。多个匹配连接时让用户指定连接器，不按名称猜测。没有现有连接、缺少凭据或配置损坏时停止并说明，不能用管理员页面所选 Key、其他连接器 Key 或示例值代替。',
      '2. 更新前备份；保留现有凭据、连接器名称、网关地址、设备名、其他 MCP、自定义 Skill 内容和模型设置。只从匹配连接器的私有配置或凭据存储读取原 Key；HTTP 使用原 Authorization，旧 stdio 使用原 env.CGW_API_KEY。密钥不写入 Skill、URL、日志、回复或哈希记录。',
      '3. 使用原 Key 调用 /v1/gen-images/me，记录原 keyId；获取更新清单并按内容哈希比较，清单获取失败时停止更新并保留现有配置。401/403 不更换 Key、不猜测其他凭据，向用户说明需要恢复原凭据或明确执行“更换 API Key”。',
      '4. WorkBuddy 使用 ~/.workbuddy/mcp.json 和 ~/.workbuddy/skills/gpt-image/SKILL.md；其他客户端按其实际配置位置操作。Skill 名称 gpt-image，中文名 GPT 图片生成。旧 codex-gateway-image 先备份到 Skill 发现目录之外再迁移，保留用户修改；自定义内容冲突时保留两份并说明差异。',
      '5. HTTP MCP 服务端随网关升级，无需下载服务端；只重新连接并 tools/list 验证。旧 stdio 需迁移时，保留原连接名称与原 Key，将原 CGW_BASE 对应地址转换为 HTTP /mcp 与 Authorization，不使用其他新 Key。',
      '6. 分别验证 Skill 原始字节的 SHA-256、MCP tools/list 的 result.tools 数组经 JSON.stringify 后 UTF-8 字节的 SHA-256；检查 /v1/models 和 /v1/gen-images/me，确认更新前后 keyId 一致，再记录已验证的哈希。只做只读检查，不出图、不删除图片。',
      '7. 区分网关已升级、文件已更新、当前会话已重新加载。比较会话连接与文件配置的 keyId；若不一致，停止生成并指出客户端重新加载连接器或重启的位置，不能声称已生效。没有会话工具时也明确报告尚未验证，不能猜测身份。',
      '8. 不自动改写浏览器素材站已保存的 Key。用户在 /gallery 使用与自己的 MCP 相同的 Key；历史图片仍归原 keyId。完成后给出备份位置、验证结果与剩余操作，不泄露密钥。'
    ].join('\n')
  }
  function buildSwitchPrompt(base, config) {
    return [
      '请为我当前 Agent 客户端明确更换 Codex Gateway 的 API Key；这不是首次安装，也不是普通 Skill/MCP 更新。',
      '目标网关：' + base,
      scopeLine(base),
      '指定连接器：' + Object.keys(config.mcpServers)[0] + '（客户端若使用其他名称，以现有名称为准并保留，按地址匹配）。',
      '以下配置中的 Authorization 是我明确选择的新 API Key，仅用于本次更换：',
      '```json', JSON.stringify(config, null, 2), '```',
      '1. 先核对范围限制：若目标网关是 127.0.0.1 / localhost 而 Agent 不在网关这台电脑上，立即停止并要求用共享地址重新生成，不得按端口猜测或改写地址。再识别实际客户端与已有连接器，按目标网关地址（协议、主机、端口）完全一致匹配；多个匹配连接时让用户指定；没有匹配连接时停止说明，不能另行安装或覆盖其他连接。',
      '2. 修改前备份。保留连接器名称、地址、设备名、其他请求头、其他 MCP、Skill 和模型设置，只替换指定连接器的凭据。HTTP 替换 Authorization；旧 stdio 替换 env.CGW_API_KEY，不顺带迁移传输方式。',
      '3. 写入前用新 Key 只读检查 ' + base + '/v1/gen-images/me，确认新 keyId 和 keyName；旧 Key 可用时也检查原身份并说明变化。若新 Key 无效则停止且保留旧配置。不要把明文 Key 写入 Skill、URL、日志、最终回复或 cgw-client-assets.json。',
      '4. 换 Key 后图库切换到新 keyId 范围；旧图不会自动迁移，也不删除、禁用原 Key 或修改图片归属。同一 Key 的不同名称仍是同一身份。',
      '5. 保存后复查文件凭据对应的新 keyId；重新加载 MCP 连接器或重启客户端，再用当前会话的只读工具核对身份。会话仍使用旧 Key 时停止生成，明确报告“文件已更新，当前会话尚未切换”，不能声称换 Key 已完成。没有会话工具时说明尚待验证。',
      '6. 素材页：' + base + '/gallery。提醒用户退出素材站旧 Key 后使用同一新 Key 登录；不自动覆盖浏览器凭据。只做连通与身份检查，不出图、不删除图片、不修改对话模型 Key。'
    ].join('\n')
  }
  function buildClientPrompt(options) {
    if (options.update && options.switchKey) throw new Error('更新与更换 Key 不能同时执行。')
    if (options.update) {
      buildMcpConfig({base:options.base,target:options.target,key:''})
      return buildUpdatePrompt(new URL(options.base).origin)
    }
    var base = new URL(options.base).origin
    var config = buildMcpConfig(options)
    var connectorName = Object.keys(config.mcpServers)[0]
    if (options.switchKey) return buildSwitchPrompt(base, config)
    var remote = !isLoopbackBase(base)
    var lines = [
      '请为我当前使用的 Agent 客户端配置 Codex Gateway 的 MCP 和生图 Skill，并实际完成配置与连接检查。',
      '',
      '接入信息（保留完整地址和端口）：',
      '网关地址：' + base,
      remote ? '接入目标：另一台网关主机。我的电脑只运行 Agent，通过远程 HTTP MCP 使用工具，不需要安装 Codex Gateway、Node.js、网关服务端或宿主机登录账号。' : '接入目标：与网关在同一台电脑上的 Agent。127.0.0.1 / localhost 永远指执行请求的那台电脑，此配置不能转发给其他设备使用。',
      '连接器名称：' + connectorName,
      'MCP 配置：',
      '```json', JSON.stringify(config, null, 2), '```',
      '生图 Skill 下载地址：' + base + '/lan-kit/skills/codex-gateway-image/SKILL.md',
      '我的素材页：' + base + '/gallery',
      '',
      '请按以下步骤操作：',
      '0. 写配置前先核实连接目标。若用户在其他电脑使用，而地址是 127.0.0.1 / localhost，先索取网关主机的共享地址和端口，再统一替换 MCP、Skill、素材页及更新清单地址；不要建议在用户电脑安装或启动网关，也不要猜测 IP。连接被拒绝（10061）只证明所连接地址无监听，不能证明远程网关停机。远程地址不可达时检查主机共享、网络互通与共享端口；401/403 应检查 API Key 或访问权限，不能当成端口未启动。/health 返回带 JSON 的 503 表示网关可达但上游未就绪。',
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
    return lines.join('\n')
  }

root.CGWClientSetup = { buildClientPrompt, buildMcpConfig, isLoopbackBase };
})(globalThis);
