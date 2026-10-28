// Codex Gateway · 账号额度（cockpit tools 同款展示）
//
// 数据契约：返回当前激活账号的订阅 / 用量摘要，结构固定，来源可替换。
//   真实身份（账号名 / 邮箱 / userId）来自 accounts.json + auth.json 的 id_token；
//   用量只认**上游自己给的限流头**（x-codex-*）——ChatGPT 不公开额度 API，
//   任何本地推算出来的百分比都是猜的，所以这里不猜：
//     1) realtime：该账号自己的 bridge 最近一次真实上游响应带回的限流头（首选）
//     2) manual：用户在界面上手填（旧版行为，保留但不生成假数据）
//     3) none：两者都没有，前端显示空态并提示「发一次调用后自动同步」
//   account-quota.json 现在只是**缓存与手动覆盖**，不再是数据来源。
//
// 多账号隔离（重要）：
//   网关支持多账号，额度必须按账号走，否则切换账号后数字不变会误导人。
//   查找顺序：accounts[当前账号 id]  →  shared（共用缺省）→ 示例数据
//   兼容旧扁平结构（plan/weekly 直接在根上）：整份视为 shared，老配置不丢。
//
// 百分比语义（统一，避免歧义）：
//   usedPercent      = 已用百分比 0–100
//   remainingPercent = 剩余百分比 = 100 - usedPercent（前端主进度条用这个）
//   resetIn          = 距离重置的剩余时间文案（优先按 resetsAt 实时算，失败回退 resetText）

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { jwtClaims, loadAccounts, accountAuthPath } from './auth-core.mjs'
import { writeJsonAtomic } from './atomic-write.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, 'data')
// CGW_QUOTA_FILE 让测试与沙盒指到临时文件，避免写坏真实数据目录
const QUOTA_FILE = process.env.CGW_QUOTA_FILE || path.join(DATA_DIR, 'account-quota.json')

const ACCOUNT_TYPES = ['标准', '优先', '团队', '企业']

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

// 以前这里会写一份「示例数据」（PRO 20X / 周用量 31%），但它既不是用户填的、
// 也不是上游给的，却被当成真实额度展示——demo 标记还因为 plan/weekly 存在而不亮。
// 现在只保证目录存在，绝不凭空造数字。
function ensureDataDir() {
  try {
    const dir = path.dirname(QUOTA_FILE)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  } catch {}
}

// 距离某个 ISO 时刻还剩多久；已过期返回 '已重置'
export function countdownText(iso) {
  if (!iso) return null
  const ms = new Date(iso).getTime() - Date.now()
  if (Number.isNaN(ms)) return null
  if (ms <= 0) return '已重置'
  const s = Math.floor(ms / 1000)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}天 ${h}小时`
  if (h > 0) return `${h}小时 ${m}分`
  return `${m}分钟`
}

function daysUntil(iso) {
  if (!iso) return null
  const ms = new Date(iso).getTime() - Date.now()
  if (Number.isNaN(ms)) return null
  return Math.floor(ms / 86400000)
}

// 剩余百分比决定颜色：越低越危险
function toneOf(remaining) {
  if (remaining <= 10) return 'rose'
  if (remaining <= 25) return 'amber'
  return 'emerald'
}

export function normalizeQuota(raw = {}) {
  const used = Number(raw.usedPercent)
  const u = Number.isFinite(used) ? Math.min(100, Math.max(0, used)) : 0
  const remaining = 100 - u
  return {
    id: raw.id || '',
    label: raw.label || raw.id || '',
    usedPercent: u,
    remainingPercent: remaining,
    tone: raw.tone || toneOf(remaining),
    resetIn: countdownText(raw.resetsAt) || raw.resetText || raw.usedTime || '—',
    resetsAt: raw.resetsAt || null
  }
}

// ---------- 多账号解析 ----------
// 返回 { config, scope }；scope: 'account' | 'shared'
export function resolveScope(cfg, accountId) {
  const accounts =
    cfg && cfg.accounts && typeof cfg.accounts === 'object' && !Array.isArray(cfg.accounts)
      ? cfg.accounts
      : null

  // 旧扁平结构（plan/weekly/models 直接挂在根上）整份视为 shared，保证老配置不丢
  const shared =
    cfg && cfg.shared && typeof cfg.shared === 'object'
      ? cfg.shared
      : cfg && (cfg.plan || cfg.weekly || cfg.models)
        ? cfg
        : {}

  if (accountId && accounts && accounts[accountId] && typeof accounts[accountId] === 'object') {
    return { config: accounts[accountId], scope: 'account' }
  }
  return { config: shared, scope: 'shared' }
}

// 当前激活账号 id（与身份解析共用同一份注册表，避免两边不一致）
function activeAccountId() {
  try {
    const reg = loadAccounts()
    return reg?.activeId || null
  } catch {
    return null
  }
}

// ---------- 实时额度：读 bridge 捕获的上游 x-codex-* 限流头 ----------
// 池化之后每个账号跑在自己的 bridge 进程上（端口不同、限流头也不同）。
// 以前这里写死 BRIDGE_PORT || 10531：切到第二个账号后读的还是第一个账号的
// 那个 bridge，于是「明明切了账号，余量数字一点没变」——正是多账号最忌讳的误导。
// 现在端口由调用方按激活账号传入。
const RT_FRESH_MS = 24 * 3600 * 1000
const RT_STALE_MS = 30 * 60 * 1000 // 超 30 分钟没观测到就标 stale：仍展示，但提示可能过期

async function fetchRealtimeQuota(port, { since = 0 } = {}) {
  const p = Number(port) || Number(process.env.BRIDGE_PORT || 10531)
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 1200)
    const res = await fetch(`http://127.0.0.1:${p}/health`, { signal: ctrl.signal })
    clearTimeout(timer)
    if (!res.ok) return null
    const j = await res.json()
    const lul = j?.last_upstream_limits
    // since：只要「不早于此时刻」的那份。主动探测必须传它——否则 bridge 里
    // 上一次调用留下的旧头（24h 内都算有效）会被当成本次探测的结果，
    // 界面显示「刚同步」，其实一行新数据都没拿到。
    if (!lul || !lul.at || lul.at < since || Date.now() - lul.at > RT_FRESH_MS) return null
    return realtimeQuotaFrom(lul.headers || {}, lul.at)
  } catch {
    return null
  }
}

// ---------- 主动探测 ----------
// ChatGPT 没有额度查询接口，限流头只会跟着真实上游响应一起回来。
// 所以「主动拉一次」的实质是**发一个尽可能小的真实请求**把响应头带回来：
// max_tokens=1，一次极其轻微的额度消耗。正因如此，只在用户明确动作时做
// （切换激活账号 / 点刷新），绝不定时轮询——那等于替用户偷偷花钱。
const PROBE_COOLDOWN_MS = 60 * 1000
const probeState = new Map() // accountId -> { at, ok, status, reason }

export function probeCooldownOf(accountId) {
  const prev = probeState.get(accountId || '__shared')
  if (!prev) return 0
  const left = PROBE_COOLDOWN_MS - (Date.now() - prev.at)
  return left > 0 ? Math.ceil(left / 1000) : 0
}

export async function probeQuotaViaBridge({ accountId = null, bridgePort, model = null, timeoutMs = 20000 } = {}) {
  const key = accountId || '__shared'
  const wait = probeCooldownOf(accountId)
  if (wait > 0) return { ok: false, reason: 'cooldown', retryAfterSec: wait }

  const port = Number(bridgePort)
  if (!port) {
    probeState.set(key, { at: Date.now(), ok: false, reason: 'no_bridge_port' })
    return { ok: false, reason: 'no_bridge_port' }
  }

  // 请求发出前记下时刻，之后只要 at >= since 的快照，确保拿到的是这次探测的产物
  const probeStart = Date.now()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  let status = 0
  let netErr = null
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model || 'gpt-6.1-sol',
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false
      }),
      signal: ctrl.signal
    })
    status = res.status
    // 返回内容没用，但必须读完才会释放连接
    await res.arrayBuffer().catch(() => null)
  } catch (e) {
    netErr = e
  } finally {
    clearTimeout(timer)
  }

  // 成功还是 429 都去读一次 /health：限流头是 bridge 内部捕获的，
  // 而 429 响应本身通常就带着「已经用满」的那组头——那正是最该展示的信息。
  const rt = await fetchRealtimeQuota(port, { since: probeStart })
  if (rt && accountId) persistRealtimeSnapshot(accountId, rt)
  if (rt) {
    probeState.set(key, { at: Date.now(), ok: true, status })
    return { ok: true, source: 'realtime', status, syncedAt: rt.syncedAt }
  }
  const reason = netErr ? 'bridge_unreachable' : status ? 'no_limit_headers' : 'unknown'
  const detail = netErr ? netErr.message : status ? `探测请求返回 ${status}，但这次响应没带上限流头` : ''
  probeState.set(key, { at: Date.now(), ok: false, status, reason })
  return { ok: false, reason, status, detail }
}

// 缓存结构 v2：{ version: 2, byAccount: { [accountId]: snapshot } }
// 旧版是单个扁平快照（根上带 syncedAt），迁移时归到当时那个账号，之后不再跨账号复用。
function realtimeCacheOf(raw) {
  const rt = raw && raw._realtime
  if (rt && rt.version === 2 && rt.byAccount && typeof rt.byAccount === 'object') {
    return { version: 2, byAccount: { ...rt.byAccount } }
  }
  return null // 空或旧扁平结构，交给调用方决定归属
}

function freshSnapshot(snap) {
  if (!snap || typeof snap.syncedAt !== 'string') return null
  const at = new Date(snap.syncedAt).getTime()
  if (Number.isNaN(at)) return null
  return Date.now() - at <= RT_FRESH_MS ? snap : null
}

export function readCachedRealtime(accountId) {
  const raw = readJsonSafe(QUOTA_FILE) || {}
  const cache = realtimeCacheOf(raw)
  if (!cache) return null
  return freshSnapshot(accountId ? cache.byAccount[accountId] : null)
}

// 旧扁平快照没有账号归属：第一次读到时就落到当前账号名下，顺带把结构升级掉。
// 不保留「所有账号共用同一份」的读路径——那等于把 A 的余量当成 B 的。
export function migrateLegacyRealtime(accountId) {
  try {
    const raw = readJsonSafe(QUOTA_FILE) || {}
    if (realtimeCacheOf(raw)) return null
    const legacy = freshSnapshot(raw._realtime)
    if (!legacy) return null
    raw._realtime = { version: 2, byAccount: { [accountId || '__shared']: legacy } }
    writeJsonAtomic(QUOTA_FILE, raw)
    return legacy
  } catch {
    return null
  }
}

export function persistRealtimeSnapshot(accountId, rt) {
  try {
    const raw = readJsonSafe(QUOTA_FILE) || {}
    const cache = realtimeCacheOf(raw) || { version: 2, byAccount: {} }
    for (const [k, v] of Object.entries(cache.byAccount)) {
      if (!freshSnapshot(v)) delete cache.byAccount[k] // 顺手清过期条目，文件别越攒越大
    }
    const key = accountId || '__shared'
    if (cache.byAccount[key]?.syncedAt === rt.syncedAt) return // 30s 轮询不必反复落盘
    cache.byAccount[key] = rt
    raw._realtime = cache
    writeJsonAtomic(QUOTA_FILE, raw)
  } catch {}
}

function rtSecToIso(v) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null
}

export function realtimeQuotaFrom(headers = {}, at = 0) {
  const num = (k) => {
    const v = headers[k]
    if (v == null || v === '') return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)))

  const primaryUsed = num('x-codex-primary-used-percent')
  if (primaryUsed === null) return null

  // primary = 账号主用量窗口（10080 分钟 = 周窗口）
  const winMin = num('x-codex-primary-window-minutes') || 0
  const weekly = {
    label: winMin >= 10000 ? 'Weekly' : winMin > 0 ? `${Math.round(winMin / 60)}h 窗口` : 'Weekly',
    usedPercent: clamp(primaryUsed),
    resetsAt: rtSecToIso(headers['x-codex-primary-reset-at'])
  }

  // secondary = 次窗口；bengalfox-* = 上游 Spark 家族专属窗口（头部名由上游定义，标签按当前世代表述）
  const models = []
  const secUsed = num('x-codex-secondary-used-percent')
  const secWin = num('x-codex-secondary-window-minutes') || 0
  if (secWin > 0 && secUsed !== null) {
    models.push({
      id: 'codex-secondary',
      label: `Codex ${Math.round(secWin / 60)}h 窗口`,
      usedPercent: clamp(secUsed),
      resetsAt: rtSecToIso(headers['x-codex-secondary-reset-at'])
    })
  }
  const bfUsed = num('x-codex-bengalfox-primary-used-percent')
  if (bfUsed !== null) {
    const bfWin = num('x-codex-bengalfox-primary-window-minutes') || 300
    models.push({
      id: 'spark-5h',
      label: `Codex Spark ${Math.round(bfWin / 60)}h`,
      usedPercent: clamp(bfUsed),
      resetsAt: rtSecToIso(headers['x-codex-bengalfox-primary-reset-at'])
    })
    const bfWeekly = num('x-codex-bengalfox-secondary-used-percent')
    if (bfWeekly !== null) {
      models.push({
        id: 'spark-weekly',
        label: 'Codex Spark Weekly',
        usedPercent: clamp(bfWeekly),
        resetsAt: rtSecToIso(headers['x-codex-bengalfox-secondary-reset-at'])
      })
    }
  }

  const planType = String(headers['x-codex-plan-type'] || '').trim()
  return {
    plan: planType ? { name: planType.toUpperCase(), multiplier: '' } : null,
    weekly,
    models,
    syncedAt: new Date(at).toISOString()
  }
}

export async function getAccountQuota(gwConfig = {}) {
  ensureDataDir()

  // 1. 真实账号身份：accounts.json（激活项）+ auth.json 的 id_token
  let email = ''
  let userId = ''
  let name = ''
  let provider = ''
  let accountId = null
  try {
    const reg = loadAccounts()
    accountId = reg?.activeId || null
    const active = (reg?.accounts || []).find((a) => a.id === accountId)
    if (active) {
      name = active.name || ''
      provider = active.provider || ''
      const filePath = accountAuthPath(active.id)
      if (fs.existsSync(filePath)) {
        const data = readJsonSafe(filePath)
        const idToken = data?.tokens?.id_token
        if (idToken) {
          const claims = jwtClaims(idToken) || {}
          email =
            claims?.['https://api.openai.com/profile']?.email ||
            claims?.email ||
            claims?.preferred_username ||
            ''
          userId = claims?.['https://api.openai.com/auth']?.chatgpt_account_id || claims?.sub || ''
        }
      }
    }
  } catch {}

  // 2. 手动配置：账号专属 → 共用缺省。没有就是没有，不再补示例。
  const raw = readJsonSafe(QUOTA_FILE) || {}
  const { config: cfg, scope } = resolveScope(raw, accountId)
  const hasLocal = !!(
    cfg.plan ||
    cfg.weekly ||
    (Array.isArray(cfg.models) && cfg.models.length) ||
    cfg.teamName ||
    cfg.accountType
  )
  // 老版本自动生成的示例文件带 _note；用户手动存过一次就不会再被视为示例
  const legacySample = !!raw._note && raw._sample !== false

  const plan = cfg.plan || {}
  const expiresInDays = daysUntil(plan.expiresAt)
  // 没有任何数据时不给「剩余 100%」这种假数字，宁可给 null 让界面显示空态
  let weekly = cfg.weekly ? normalizeQuota({ ...cfg.weekly, label: cfg.weekly.label || 'Weekly' }) : null
  let models = Array.isArray(cfg.models) ? cfg.models.map(normalizeQuota) : []

  // 3. 实时优先：该账号自己的 bridge（端口由 launcher 按激活账号给出）
  let rt = await fetchRealtimeQuota(gwConfig.bridgePort)
  if (rt) persistRealtimeSnapshot(accountId, rt)
  if (!rt) rt = readCachedRealtime(accountId)
  if (!rt) rt = migrateLegacyRealtime(accountId)
  if (rt) {
    if (rt.weekly) weekly = normalizeQuota({ ...rt.weekly, label: rt.weekly.label || weekly?.label || 'Weekly' })
    // 一旦拿到实时数据，模型窗口就只认上游这一份。
    // 上游这次只回了主窗口、没回模型级窗口时，宁可空着——把上次手填的数字
    // 贴在「实时同步」标签底下，正是这轮要消灭的那类误导。
    models = (rt.models || []).map((m) => normalizeQuota(m))
  }
  const effPlan = rt?.plan || plan

  const syncedAt = rt?.syncedAt || null
  const ageSec = syncedAt ? Math.max(0, Math.round((Date.now() - new Date(syncedAt).getTime()) / 1000)) : null
  const source = rt ? 'realtime' : hasLocal ? 'manual' : 'none'

  return {
    ok: true,
    demo: source === 'none', // 「什么都没有」才是示例/空态
    sample: legacySample && source !== 'realtime',
    source, // realtime = 上游限流头；manual = 用户手填；none = 无数据
    syncedAt,
    ageSec, // 距上次真实观测的秒数，前端用来显示「N 分钟前」
    stale: ageSec != null && ageSec * 1000 > RT_STALE_MS,
    scope, // 'account' = 该账号专属；'shared' = 所有账号共用
    accountId: accountId || null,
    account: {
      email: email || cfg.email || '—',
      userId: userId || cfg.userId || '—',
      name: name || cfg.name || '当前账号',
      provider: provider || cfg.provider || '—',
      teamName: cfg.teamName || '个人账户'
    },
    plan: {
      name: effPlan.name || '—',
      multiplier: effPlan.multiplier || '',
      badge: effPlan.name && effPlan.multiplier ? `${effPlan.name} ${effPlan.multiplier}` : effPlan.name || '—',
      expiresAt: effPlan.expiresAt || null,
      expiresInDays: rt?.plan ? null : expiresInDays,
      expiresInText:
        rt?.plan || expiresInDays === null ? '—' : expiresInDays < 0 ? '已过期' : `剩余 ${expiresInDays} 天`
    },
    weekly,
    models,
    accountType: cfg.accountType || '标准',
    accountTypes: ACCOUNT_TYPES,
    // 未经归一化的原始配置，供前端编辑用（避免把算出来的倒计时当静态文案写回）
    editable: {
      teamName: cfg.teamName || '',
      accountType: cfg.accountType || '标准',
      plan: cfg.plan || {},
      weekly: cfg.weekly || {},
      models: Array.isArray(cfg.models) ? cfg.models : []
    },
    updatedAt: new Date().toISOString()
  }
}

// 保存到「当前激活账号」名下；原共用配置会自动作为初始值继承，不会清空
// patch.reset === true 时删除该账号专属配置，回落共用缺省（撤销用）
export async function saveAccountQuota(patch = {}, accountId = null, gwConfig = {}) {
  ensureDataDir()
  const raw = readJsonSafe(QUOTA_FILE) || {}
  const targetId = accountId || activeAccountId()

  // 旧扁平结构迁移：把根上的配置搬进 shared，腾出 accounts 空间
  let next = { ...raw }
  if (!next.shared && (raw.plan || raw.weekly || raw.models)) {
    next.shared = {
      plan: raw.plan,
      teamName: raw.teamName,
      provider: raw.provider,
      weekly: raw.weekly,
      models: raw.models,
      accountType: raw.accountType
    }
    delete next.plan
    delete next.teamName
    delete next.provider
    delete next.weekly
    delete next.models
    delete next.accountType
  }
  if (!next.shared || typeof next.shared !== 'object') next.shared = {}
  if (!next.accounts || typeof next.accounts !== 'object' || Array.isArray(next.accounts)) next.accounts = {}

  if (!targetId) {
    // 没有激活账号时退回写共用配置
    next.shared = { ...next.shared, ...pickKnown(patch) }
  } else if (patch.reset === true) {
    // 丢弃该账号专属配置，回落到共用缺省
    delete next.accounts[targetId]
  } else {
    // 首次为该账号保存时，以当前生效配置为底稿
    const base = next.accounts[targetId] || next.shared || {}
    next.accounts[targetId] = { ...base, ...pickKnown(patch) }
  }

  writeJsonAtomic(QUOTA_FILE, next)
  return getAccountQuota(gwConfig)
}

// ---------- 写入清洗（前端可编辑后必须做，别信输入） ----------
const clampPct = (v) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return 0
  return Math.min(100, Math.max(0, Math.round(n)))
}
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
// 只接受合法 ISO 时间，其余一律置空（避免脏日期让倒计时永远算不出来）
const isoOr = (v) => {
  if (typeof v !== 'string' || !v.trim()) return null
  const ms = new Date(v).getTime()
  return Number.isNaN(ms) ? null : new Date(ms).toISOString()
}

function sanQuota(raw = {}) {
  const out = {}
  if (raw.id != null) out.id = str(raw.id, 60)
  if (raw.label != null) out.label = str(raw.label, 80)
  if (raw.usedPercent != null) out.usedPercent = clampPct(raw.usedPercent)
  if (raw.resetText != null) out.resetText = str(raw.resetText, 40)
  if (raw.resetsAt !== undefined) out.resetsAt = isoOr(raw.resetsAt)
  return out
}

function pickKnown(patch = {}) {
  const out = {}
  if (typeof patch.accountType === 'string') {
    out.accountType = ACCOUNT_TYPES.includes(patch.accountType) ? patch.accountType : '标准'
  }
  if (typeof patch.teamName === 'string' && patch.teamName.trim()) {
    out.teamName = str(patch.teamName, 60)
  }
  if (patch.weekly && typeof patch.weekly === 'object' && !Array.isArray(patch.weekly)) {
    out.weekly = sanQuota(patch.weekly)
  }
  if (Array.isArray(patch.models)) {
    out.models = patch.models
      .filter((m) => m && typeof m === 'object')
      .slice(0, 30)
      .map(sanQuota)
      .filter((m) => m.label || m.id)
  }
  if (patch.plan && typeof patch.plan === 'object' && !Array.isArray(patch.plan)) {
    out.plan = {
      name: str(patch.plan.name, 40),
      multiplier: str(patch.plan.multiplier, 12),
      expiresAt: isoOr(patch.plan.expiresAt)
    }
  }
  return out
}
