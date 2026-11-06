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
  // 客户端的 Key 至少存在两处：对话模型配置（/v1/chat/completions）与生图 MCP（/mcp）。
  // 只改其中一处就会在调用日志里出现「同一 IP、两个 keyId」，图库也随之分裂。
  function credentialSites(base) {
    return [
      '本网关的凭据可能同时存在多处，核对身份时必须逐处覆盖：',
      '  A. 对话模型配置：url / baseUrl 指向 ' + base + '/v1 或 ' + base + '/v1/chat/completions 的条目（常见文件名 workbuddy-models-codex-gateway*.json，或客户端模型设置里的自定义模型），字段 apiKey / OPENAI_API_KEY。',
      '  B. 生图 MCP：mcp.json 中 url 指向 ' + base + '/mcp 的条目（常见名 codex-gateway / codex-gateway-lan），字段 headers.Authorization；旧 stdio 为 env.CGW_API_KEY。',
      '  C. 记录与脚本：cgw-client-assets.json、setup-client.mjs 生成的模型配置 JSON、Skill 文件内被手工填入的 Key。',
      '  D. 浏览器素材站：' + base + '/gallery 的 localStorage（键 cgw_gallery_key），Agent 不得代改，需提示用户在网页右上「换 Key」手动更新。'
    ]
  }
  function consistencyCheck(base, strict) {
    return [
      '一致性自检（必须执行）：分别从 A 与 B 读取当前 Key，用各自的 Key 作鉴权头请求 ' + base + '/v1/gen-images/me，比较两个响应的 keyId。',
      strict
        ? '两处 keyId 必须相同且与新 Key 一致；不同时明确报告「模型侧 / MCP 侧仍是旧 Key」并指出具体文件与字段，不能声称已完成、不能静默继续。'
        : '若两处 keyId 不同，明确报告「凭据分叉」并列出各自文件与字段；本 Prompt 不授权更换 Key，只提示用户向宿主机索取「更换 API Key」Prompt。',
      '查询只读，不调用 generate_image、不删除或迁移图片；报告里只出现掩码或 keyId 后 8 位，不回显明文 Key。'
    ]
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
    ].concat(credentialSites(base), consistencyCheck(base, false), [
      '9. 分别报告「文件已更新」「连通与身份检查」「模型侧与 MCP 侧凭据是否一致」「当前会话是否已重新加载」。发现两处 Key 不同时明确告警，不要因为 MCP 更新成功就报告一切正常。'
    ]).join('\n')
  }
  function buildSwitchPrompt(base, config) {
    return [
      '请为我当前 Agent 客户端明确更换 Codex Gateway 的 API Key；这不是首次安装，也不是普通 Skill/MCP 更新。',
      '目标网关：' + base,
      scopeLine(base),
      '指定连接器：' + Object.keys(config.mcpServers)[0] + '（客户端若使用其他名称，以现有名称为准并保留，按地址匹配）。',
      '以下配置中的 Authorization 是我明确选择的新 API Key，仅用于本次更换：',
      '```json', JSON.stringify(config, null, 2), '```',
      '本次要求：对话模型与生图 MCP 必须使用同一个新 Key。此前出现过只换了 MCP、模型侧仍留旧 Key 的情况，调用日志会显示同一 IP 两个 keyId，个人图库也随之分裂。',
      '1. 先核对范围限制：若目标网关是 127.0.0.1 / localhost 而 Agent 不在网关这台电脑上，立即停止并要求用共享地址重新生成，不得按端口猜测或改写地址。再识别实际客户端与已有连接器，按目标网关地址（协议、主机、端口）完全一致匹配；多个匹配连接时让用户指定；没有匹配连接时停止说明，不能另行安装或覆盖其他连接。',
      '2. 修改前备份。保留连接器名称、地址、设备名、其他请求头、其他 MCP、Skill 和模型设置。'
    ].concat(credentialSites(base), [
      '3. 逐处枚举 A/B/C，分别报告当前凭据属于哪个 keyId（用 /v1/gen-images/me 查询）与掩码，不要显示明文。只处理接口地址指向目标网关 origin 且凭据为 cgw- 前缀的条目；指向其他网关、其他端口或其他供应商的配置一律不动。多个匹配时让用户指定，不按名称猜测。',
      '4. 把 A 与 B 两处凭据统一替换为本次新 Key（HTTP 替换 apiKey / Authorization；旧 stdio 替换 env.CGW_API_KEY，不顺带迁移传输方式）。C 中若发现明文旧 Key，改为与新 Key 一致或删除该副本。找不到模型配置文件、无权修改或无法确定归属时，停止该处并给出需要用户手动更新的具体文件与字段，不能声称已全量更换。',
      '5. 写入前用新 Key 只读检查 ' + base + '/v1/gen-images/me，确认新 keyId 和 keyName；旧 Key 可用时也检查原身份并说明变化。若新 Key 无效则停止且保留旧配置。不要把明文 Key 写入 Skill、URL、日志、最终回复或 cgw-client-assets.json。',
      '6. 换 Key 后图库切换到新 keyId 范围；旧图不会自动迁移，也不删除、禁用原 Key 或修改图片归属。同一 Key 的不同名称仍是同一身份。'
    ], consistencyCheck(base, true), [
      '7. 保存后复查 A/B 两处文件凭据；重新加载 MCP 连接器或重启客户端，再用当前会话的只读工具核对身份。会话仍使用旧 Key 时停止生成，明确报告“文件已更新，当前会话尚未切换”，不能声称换 Key 已完成。没有会话工具时说明尚待验证。',
      '8. 素材页：' + base + '/gallery。提醒用户退出素材站旧 Key 后使用同一新 Key 登录；不自动覆盖浏览器凭据。只做连通与身份检查，不出图、不删除图片。'
    ]).join('\n')
  }
  function buildUninstallPrompt(base) {
    return [
      '请把我当前 Agent 客户端里 Codex Gateway 的接入配置完全卸载，并逐项报告处理结果。',
      '目标网关：' + base,
      scopeLine(base),
      '本 Prompt 不含任何 API Key，也不授权访问、删除或迁移网关上的任何图片与历史记录。',
      '卸载清单（只处理指向上述目标网关的条目）：',
      '  1. MCP：mcp.json 的 mcpServers 中 url 指向 ' + base + '/mcp 的条目（常见名 codex-gateway / codex-gateway-lan）；旧 stdio 中 env.CGW_BASE 指向同一地址的条目。',
      '  2. 对话模型：url / baseUrl 指向 ' + base + '/v1 或 ' + base + '/v1/chat/completions 的条目（常见文件名 workbuddy-models-codex-gateway*.json），以及客户端模型设置里同源的自定义模型。',
      '  3. Skill：~/.workbuddy/skills/gpt-image/ 与旧 codex-gateway-image/ 中属于本网关的 SKILL.md。',
      '  4. 记录文件：cgw-client-assets.json 里该网关的记录（若还含其他网关，只删本条）。',
      '  5. 浏览器素材站：' + base + '/gallery 在浏览器保存的 Key 由用户手动清除（网页右上「换 Key」或清除该站点数据）；Agent 不得代删其他站点数据。',
      '执行规则：',
      '1. 先备份：把将要改动的配置与 Skill 目录整体复制到带时间戳的备份目录，报告绝对路径。备份失败即停止，不删任何东西。',
      '2. 严格按地址匹配，绝不按名称猜测；指向其他网关（含 127.0.0.1、其他端口/IP、其他供应商）的条目一律保留。多个匹配时列出来让用户确认；无法确定归属时保留并报告。',
      '3. 保留其他 MCP、其他模型、其他 Skill、其他偏好与凭据；不要删除整个 mcp.json、模型配置目录或 ~/.workbuddy。配置损坏时保留原文件并说明原因。',
      '4. 不读取、不显示、不回显任何明文 API Key；报告里只用掩码或 keyId 后 8 位。不请求网关接口、不出图、不删除图片，网关侧图片仍按原 keyId 保留。',
      '5. 完成后逐项报告「已删除 / 已保留 / 需用户手动处理」，说明需要重新加载连接器或重启客户端。若要彻底收回访问权，请让网关宿主机在「API Key」页禁用或删除对应 Key。',
      '6. 之后如需重新接入，让宿主机重新生成「首次配置」Prompt，一次性配置模型 + MCP + Skill，确保两处使用同一个 Key；不要分别用两个 Prompt 各配一半。'
    ].join('\n')
  }
  function buildClientPrompt(options) {
    var modes = ['update','switchKey','uninstall'].filter(function (m) { return !!options[m] })
    if (modes.length > 1) throw new Error('更新、更换 Key 与完全卸载不能同时执行。')
    var base = new URL(options.base).origin
    if (options.uninstall) {
      buildMcpConfig({base:base,target:options.target,key:''})
      return buildUninstallPrompt(base)
    }
    if (options.update) {
      buildMcpConfig({base:base,target:options.target,key:''})
      return buildUpdatePrompt(base)
    }
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
      '请只处理上述 MCP 与 Skill 配置，保留现有的其他模型设置。但若已存在指向本网关的对话模型配置，必须用 ' + base + '/v1/gen-images/me 核对它的 apiKey 与本次 MCP 的 Key 是否为同一 keyId；不一致时明确报告差异并让用户选择，不要静默留下「模型用旧 Key、MCP 用新 Key」的分叉。'
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
