// Codex Gateway · 账号额度（cockpit tools 同款展示）
//
// 数据契约：返回当前激活账号的订阅 / 用量摘要，结构固定，来源可替换。
//   真实身份（账号名 / 邮箱 / userId）来自 accounts.json + auth.json 的 id_token；
//   订阅与用量来自 gateway/data/account-quota.json（用户维护，ChatGPT 不公开这些额度 API）。
//   后续若接上真实来源，只需替换 readConfig()，前端契约保持不变。
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

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, 'data')
const QUOTA_FILE = path.join(DATA_DIR, 'account-quota.json')

const ACCOUNT_TYPES = ['标准', '优先', '团队', '企业']

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

function ensureSampleFile() {
  if (fs.existsSync(QUOTA_FILE)) return
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
    const sample = {
      _note:
        '示例数据，请替换为真实额度。字段：usedPercent = 已用百分比(0-100)；resetsAt = 重置时刻(ISO，留空则用 resetText)；plan.expiresAt = 订阅到期。' +
        'accounts[账号id] 为该账号专属额度（优先），shared 为所有账号共用缺省。账号名/邮箱/ID 由 auth.json 自动覆盖，不用手填。',
      shared: {
        plan: { name: 'PRO', multiplier: '20X', expiresAt: '2026-09-05T23:15:00Z' },
        teamName: '个人账户',
        weekly: { label: 'Weekly', usedPercent: 31, resetText: '4d 18h 12m', resetsAt: '2026-09-07T10:34:00Z' },
        models: [
          { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol 5h', usedPercent: 22, resetText: '2h 41m', resetsAt: null },
          { id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra 5h', usedPercent: 82, resetText: '4h 59m', resetsAt: null },
          { id: 'gpt-6-astra', label: 'GPT-6 Astra Weekly', usedPercent: 96, resetText: '6d 23h 59m', resetsAt: null }
        ],
        accountType: '标准'
      },
      accounts: {}
    }
    fs.writeFileSync(QUOTA_FILE, JSON.stringify(sample, null, 2), { mode: 0o600 })
  } catch {}
}

// 距离某个 ISO 时刻还剩多久；已过期返回 '已重置'
function countdownText(iso) {
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

function normalizeQuota(raw = {}) {
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
function resolveScope(cfg, accountId) {
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
// bridge（vendored 补丁版）在每次真实上游响应后记录最近限流头，经 /health 透出；
// 这里取最近一次（at 距今 <24h 视为有效），映射为主窗口(weekly) + 次窗口/模型专属窗口
const RT_FRESH_MS = 24 * 3600 * 1000

async function fetchRealtimeQuota() {
  try {
    const port = Number(process.env.BRIDGE_PORT || 10531)
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 1200)
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: ctrl.signal })
    clearTimeout(timer)
    if (!res.ok) return null
    const j = await res.json()
    const lul = j?.last_upstream_limits
    if (!lul || !lul.at || Date.now() - lul.at > RT_FRESH_MS) return null
    const rt = realtimeQuotaFrom(lul.headers || {}, lul.at)
    if (rt) persistRealtimeSnapshot(rt)
    return rt
  } catch {
    return null
  }
}

// 重启后 bridge 内存里的限流头快照会丢：把最近一次实时额度缓存进 account-quota.json，
// 24h 内重启网关/bridge 也不退回示例数据（只在 syncedAt 变化时落盘，避免 30s 轮询反复写）
function persistRealtimeSnapshot(rt) {
  try {
    const raw = readJsonSafe(QUOTA_FILE) || {}
    if (raw._realtime?.syncedAt === rt.syncedAt) return
    raw._realtime = rt
    fs.writeFileSync(QUOTA_FILE, JSON.stringify(raw, null, 2))
  } catch {}
}

function cachedRealtime() {
  try {
    const rt = (readJsonSafe(QUOTA_FILE) || {})._realtime
    if (rt?.syncedAt && Date.now() - new Date(rt.syncedAt).getTime() <= RT_FRESH_MS) return rt
  } catch {}
  return null
}

function rtSecToIso(v) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null
}

function realtimeQuotaFrom(headers = {}, at = 0) {
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
  ensureSampleFile()

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

  // 2. 额度配置：账号专属 → 共用缺省
  const raw = readJsonSafe(QUOTA_FILE) || {}
  const { config: cfg, scope } = resolveScope(raw, accountId)
  const isDemo = !cfg.plan && !cfg.weekly

  const plan = cfg.plan || {}
  const expiresInDays = daysUntil(plan.expiresAt)
  let weekly = normalizeQuota({ ...(cfg.weekly || {}), label: cfg.weekly?.label || 'Weekly' })
  let models = Array.isArray(cfg.models) ? cfg.models.map(normalizeQuota) : []

  // 3. 实时覆盖：bridge 内存快照优先，重启后退回本地持久化缓存（均限 24h 内）
  const rt = (await fetchRealtimeQuota()) || cachedRealtime()
  if (rt) {
    if (rt.weekly) weekly = normalizeQuota({ ...rt.weekly, label: rt.weekly.label || weekly.label })
    if (rt.models && rt.models.length) models = rt.models.map((m) => normalizeQuota(m))
  }
  const effPlan = rt?.plan || plan

  return {
    ok: true,
    demo: isDemo,
    sample: rt ? false : cfg._sample === true, // 有实时数据时示例标记自动熄灭
    source: rt ? 'realtime' : 'local', // realtime = 来自上游限流头的真实用量
    syncedAt: rt?.syncedAt || null,
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
export async function saveAccountQuota(patch = {}, accountId = null) {
  ensureSampleFile()
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

  fs.writeFileSync(QUOTA_FILE, JSON.stringify(next, null, 2), { mode: 0o600 })
  return getAccountQuota()
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
