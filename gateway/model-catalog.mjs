// Codex Gateway · 模型目录与别名解析
//
// 为什么要这个模块：
//   chatgpt-bridge 的 /v1/models 是「纯透传上游」——上游一抽风（token 过期、
//   限流、区域封锁）整个模型列表就是空的前端下拉直接空掉，客户端也配不了模型。
//   同时上游并不会接受简写（'sol' / 'gpt-6'），必须给完整 slug。
//
// 这个模块做三件事：
//   1. 提供一份「Codex 主力模型目录」：即使上游不可达，网关依然能给出可选项；
//      上游恢复后再与真实列表求并集，以真实列表为准。
//   2. 提供别名解析：客户端填 'sol' / 'gpt-6' / 'terra' 也能正确打到真实 slug。
//   3. 做「列表精简」：目录只下发当前主力（文本 3 个 + 图片 2 档），
//      上游若仍返回旧世代 / 已下线 / 内部专用模型，一律在下发列表时隐藏
//      （只影响展示，请求体里硬写旧 slug 依然原样透传，不会被改写）。
//
// 数据来源与实证：
//   上游真实清单取自本机 Codex 官方客户端缓存的 `chatgpt-work-models-v1`，
//   官方客户端从上游拉取后落盘。据此校准本目录，避免出现「目录里有、上游没有」的
//   幽灵 slug —— 那类条目会让用户以为配了新模型，实则请求被上游拒绝。
//
//   ⚠️ 关于图片模型：ChatGPT 订阅通道**没有独立的图片模型**。
//   上游模型清单里只有文本模型；生图是通过「对话模型 + image_generation 工具」实现的。
//   本目录里的 gpt-image-2.5-sunburst / gpt-image-2.5-flare 是官方 API 命名占位，
//   在 bridge 的 /v1/models 里合成出来（让客户端能填合法的 model 字段），但在本通道上
//   /v1/images/generations 会**忽略** model 字段、一律用 IMAGE_MODEL + image_generation 工具渲染。
//   分辨率（size）与质量（quality）仍按请求参数正常透传。
//
// 命名沿用官方约定：小数点版本用点（gpt-6.1-sol），家族后缀用连字符（gpt-6-astra）。

// ---------- 生图实际使用的模型（唯一真源） ----------
// ChatGPT 订阅通道**没有独立的图片模型**：bridge 的 /v1/images/generations
// 从不读取请求体的 model 字段，buildImageRequest() 一律使用 cfg.imageModel
// + tools:[{type:"image_generation"}]。cfg.imageModel 取自环境变量
// CHATGPT_BRIDGE_IMAGE_MODEL，未设置时 bridge 自身默认 'gpt-6.1-sol'。
//
// 这里导出同一个值，供 launcher 注入 bridge 子进程 + 回写响应 + 前端展示，
// 确保「UI 展示的模型」与「真实渲染模型」永远是同一个。
export const IMAGE_MODEL =
  process.env.CGW_IMAGE_MODEL || process.env.CHATGPT_BRIDGE_IMAGE_MODEL || 'gpt-6.1-sol'

// ---------- 文本 / 编码模型（只保留 3 个主力） ----------
// core = true 的会强制出现在 /v1/models 里，无论上游是否可达。
//
// 2026-10 定稿：列表只保留这三档 —— 主力 / 旗舰 / 均衡。
// 旧世代（gpt-5.x 全系、gpt-6-sol、gpt-6-luna）已从目录移除，
// 由文件末尾的 isHiddenUpstream() 负责把上游残余条目也挡在列表之外。
export const CODEX_CHAT_MODELS = [
  {
    id: 'gpt-6.1-sol',
    label: 'GPT-6.1 Sol',
    tier: '主力',
    desc: '复杂编程、深度研究、Computer Use —— Codex 推荐默认模型',
    core: true,
    default: true,
    aliases: ['sol', 'gpt-6', 'gpt-6.1', 'sol1', '6.1-sol', 'gpt6.1-sol']
  },
  {
    id: 'gpt-6-astra',
    label: 'GPT-6 Astra',
    tier: '旗舰',
    desc: '最高智能水平、长程推理与跨上下文记忆',
    core: true,
    aliases: ['astra', '6-astra', 'gpt6-astra']
  },
  {
    id: 'gpt-6.1-terra',
    label: 'GPT-6.1 Terra',
    tier: '均衡',
    desc: '6.1 家族均衡档：质量与成本折中，适合日常批量任务',
    core: true,
    aliases: ['terra', '6.1-terra', 'gpt6.1-terra']
  }
]

// ---------- （-wm 工作模型变体已彻底移除） ----------
// 2026-10-27 实测：ChatGPT 登录态下所有 -wm 变体都被上游拒绝
// （400 model_not_found: not supported when using Codex with a ChatGPT account）。
// 列表不再收录、也不做别名回落；客户端若硬写 -wm，按原样透传，
// 由上游返回其自身错误信息（不静默改写，避免误导）。

// ---------- 图片模型（名义条目 · 实际由 IMAGE_MODEL + image_generation 工具渲染） ----------
// 重要事实（已对 vendored bridge dist 逐行核对）：
//   bridge 的 /v1/images/generations 从 **不读取** 请求体的 model 字段，
//   buildImageRequest() 一律使用 cfg.imageModel + tools:[{type:"image_generation"}]。
//   也就是说：这里列出的任何图片模型 ID，在本通道上都不会改变实际渲染模型。
//   它们存在的意义是让客户端能填出一个合法的 model 字段；
//   分辨率与质量按请求体的 size / quality 正常生效。
//
//   `via` 字段会在 /v1/models 的 desc 里明示实际渲染路径，避免用户误以为换了模型。
export const IMAGE_MODELS = [
  {
    id: 'gpt-image-2.5-sunburst',
    label: 'GPT Image 2.5 Sunburst',
    tier: '标准',
    via: IMAGE_MODEL + ' + image_generation 工具',
    desc: 'GPT Image 2.5 标准档（Sunburst）；本通道实际由 IMAGE_MODEL + image_generation 工具渲染',
    aliases: ['gpt-image-2.5', 'image-2.5', 'image-2.5-sunburst', 'sunburst']
  },
  {
    id: 'gpt-image-2.5-flare',
    label: 'GPT Image 2.5 Flare',
    tier: '高清',
    via: IMAGE_MODEL + ' + image_generation 工具',
    desc: 'GPT Image 2.5 高清档（Flare）；本通道实际由 IMAGE_MODEL + image_generation 工具渲染',
    aliases: ['image-2.5-flare', 'flare']
  }
]

// ---------- 别名索引 ----------
function buildAliasIndex() {
  const map = new Map()
  for (const m of [...CODEX_CHAT_MODELS, ...IMAGE_MODELS]) {
    map.set(m.id.toLowerCase(), m.id)
    for (const a of m.aliases || []) map.set(String(a).toLowerCase(), m.id)
  }
  // （-wm 变体已彻底移除，不登记别名，硬写时原样透传）
  return map
}
const ALIAS_INDEX = buildAliasIndex()

function findModel(id) {
  const k = String(id || '').toLowerCase()
  return CODEX_CHAT_MODELS.find((m) => m.id === k) || IMAGE_MODELS.find((m) => m.id === k) || null
}

/**
 * 解析模型名：
 *  - 命中别名（'sol' / 'gpt-6' / 'terra'）→ 返回真实 slug
 *  - 已是真实 slug → 原样返回
 *  - 目录里没有（旧世代 / 上游新模型）→ 原样返回，交给上游判断，绝不瞎改
 */
export function resolveModelId(name) {
  const raw = String(name == null ? '' : name).trim()
  if (!raw) return { id: raw, changed: false, from: raw }
  const hit = ALIAS_INDEX.get(raw.toLowerCase())
  if (hit && hit !== raw) return { id: hit, changed: true, from: raw }
  return { id: raw, changed: false, from: raw }
}

// 是否目录内的已知模型
export function isKnownModel(id) {
  return ALIAS_INDEX.has(String(id || '').toLowerCase())
}

// GPT-4 / 5 / 6 全系支持图像输入，视觉能力按家族判定
// （去掉 -wm 后缀再判定，兼容上游「工作模型」形态）
export function modelVision(id) {
  const i = String(id || '').toLowerCase()
  if (/image|dall/.test(i)) return false
  const base = i.replace(/-wm$/, '')
  return /^gpt-[4-6]|^o[134]|^codex|^sol|^astra|^terra|^luna|vision|gemini|claude/.test(base)
}

// 目录默认模型（用于下拉兜底）
export function defaultChatModel() {
  return (CODEX_CHAT_MODELS.find((m) => m.default) || CODEX_CHAT_MODELS[0]).id
}

// ---------- 列表精简：上游残余的旧世代 / 下线 / 内部模型一律不下发 ----------
// 只作用于「列表展示」。请求体里硬写 gpt-5.5 之类的 slug 依旧原样透传给上游，
// 不会被悄悄改写成别的模型（避免误以为换了模型）。
const KEEP_IDS = new Set([
  ...CODEX_CHAT_MODELS.map((m) => m.id),
  ...IMAGE_MODELS.map((m) => m.id)
])

// 旧世代 / 已下线 / 内部专用
const HIDDEN_PATTERNS = [
  /^gpt-4/,                  // GPT-4 全系
  /^gpt-5/,                  // GPT-5.x 全系（含 5.2 ~ 5.6 各种写法）
  /^gpt-6-(sol|luna)(-wm)?$/, // 上一代 6 系（非 6.1）
  /^gpt-image-[12]$/,        // 2.5 之前的图片占位名
  /^dall-e/,                 // DALL·E 系列
  /auto-review/              // 内部自动评审模型，不对使用者开放
]

/**
 * 上游 id 是否应该在列表里隐藏。
 * 保留名单优先（目录内模型永不隐藏），其余命中模式即隐藏；
 * 非保留模型的 -wm 变体也一并隐藏。
 */
export function isHiddenUpstream(id) {
  const i = String(id || '').trim().toLowerCase()
  if (!i) return true
  if (KEEP_IDS.has(i)) return false
  if (/-wm$/.test(i)) return true
  return HIDDEN_PATTERNS.some((re) => re.test(i))
}

// ---------- OpenAI 形态输出 ----------
function toEntry(m, kind, extra = {}) {
  return {
    id: m.id,
    object: 'model',
    created: 0,
    owned_by: kind === 'image' ? 'chatgpt-bridge' : 'codex-gateway',
    kind,
    label: m.label || m.id,
    tier: m.tier || '',
    desc: m.desc || '',
    core: !!m.core,
    catalog: true,
    vision: modelVision(m.id),
    // 图片模型的实际渲染路径（由哪个对话模型 + image_generation 工具渲染）
    ...(m.via ? { via: m.via } : {}),
    ...extra
  }
}

/**
 * 把上游真实 id 与本地目录求并集：
 *  - 目录里的模型：带上 label / tier / core 等元信息，且 core 恒在
 *  - 上游有、目录没有的：过滤掉旧世代后原样补在后面（新模型不丢）
 *  - 被隐藏的条数通过 hiddenCount 上报，前端可提示「已隐藏 N 个旧世代模型」
 */
export function mergeModelList(upstreamIds = [], upstreamOk = true) {
  const out = []
  const seen = new Set()
  let hiddenCount = 0
  let hiddenUpstream = 0

  const pushCatalog = (list, kind) => {
    for (const m of list) {
      if (seen.has(m.id)) continue
      seen.add(m.id)
      out.push(toEntry(m, kind))
    }
  }

  // 1. 核心模型优先（保证 gpt-6.1-sol 等永远在列表里）
  pushCatalog(CODEX_CHAT_MODELS.filter((m) => m.core), 'text')
  // 2. 其余目录文本模型
  pushCatalog(CODEX_CHAT_MODELS.filter((m) => !m.core), 'text')
  // 3. 上游真实返回（去重补充，旧世代剔除）
  for (const raw of upstreamIds) {
    const id = String(raw || '').trim()
    if (!id || seen.has(id)) continue
    if (isHiddenUpstream(id)) {
      hiddenCount++
      hiddenUpstream++
      continue
    }
    seen.add(id)
    const known = findModel(id)
    const kind = /image|dall/i.test(id) ? 'image' : 'text'
    out.push(known
      ? toEntry({ ...known, id }, kind)
      : { id, object: 'model', created: 0, owned_by: 'chatgpt-bridge', kind, label: id, tier: '', desc: '', core: false, catalog: false, vision: modelVision(id), upstream: true })
  }
  // 4. （原 -wm 工作模型变体已彻底移除，此处不再下发）
  // 5. 图片模型（官方 API 命名占位，兜底恒在）
  pushCatalog(IMAGE_MODELS, 'image')

  return {
    object: 'list',
    data: out,
    upstreamOk,
    upstreamCount: upstreamIds.length,
    hiddenCount,
    hiddenUpstream,
    textCount: out.filter((m) => m.kind === 'text').length,
    imageCount: out.filter((m) => m.kind === 'image').length,
    catalogVersion: 4
  }
}
