// 控制面管理鉴权（原 F-01）
//
// 原状：`/__gw/*` 完全零鉴权 —— 任何能连上 127.0.0.1:4173 的东西（恶意 npm 包、
// 远控脚本、甚至本机浏览器里的一个网页）都能直接调
// `/__gw/apikeys/reveal` 把明文 API Key 取走。
//
// 目标形态对齐 model-gateway：
//   · 启动自动生成**管理令牌**（本机数据目录，脱离仓库），支持环境变量注入
//   · 浏览器要进控制台，得先用 `node launcher.mjs admin` 申请一条
//     **一次性登录链接**（60 秒有效、用过即废）
//   · 凭链接换取本机会话 Cookie（HttpOnly + SameSite=Strict），有效期 14 天
//   · 命令行场景用 Authorization: Bearer <管理令牌>，便于脚本化
//
// 为什么这么做**不需要改前端**：会话走 Cookie，同源请求由浏览器自动携带，
// 前端 SPA 的 fetch 一行都不用动。
//
// 关于威胁边界，这里要说清楚：同一台机器、同一个用户身份运行的恶意进程，
// 理论上可以直接读走 admin-token.json —— 这个世界上没有任何纯软件方案能防住它
// （model-gateway 也一样，它的令牌就存在密钥库里）。本机制防的是
// 「不知道令牌的进程 / 浏览器里的网页 / 顺手写的脚本」这一大类，
// 把控制面从"零门槛"抬高到"必须持有令牌"，属于纵深防御，不是银弹。

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export const ADMIN_TOKEN_PREFIX = 'cgwadm-'
export const SESSION_COOKIE = 'cgw_session'
export const BOOTSTRAP_PARAM = '_cgw_bootstrap'
const BOOTSTRAP_TTL_MS = 60_000 // 一次性登录链接的有效期
export const DEFAULT_SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000 // 14 天，本机长期会话

function randomToken() {
  return ADMIN_TOKEN_PREFIX + crypto.randomBytes(24).toString('base64url')
}

/**
 * 读取或首次生成管理令牌。落在数据目录而不是仓库里，
 * 保证它不会跟着 git 提交走。
 */
export function loadOrCreateAdminToken(dir, envOverride = process.env.CGW_ADMIN_TOKEN) {
  fs.mkdirSync(dir, { recursive: true })
  if (envOverride && envOverride.trim()) {
    const token = envOverride.trim()
    return { token, source: 'env' }
  }
  const file = path.join(dir, 'admin-token.json')
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (typeof j?.token === 'string' && j.token.startsWith(ADMIN_TOKEN_PREFIX)) {
      return { token: j.token, source: 'file', createdAt: j.createdAt }
    }
  } catch {}
  const token = randomToken()
  const record = { token, createdAt: new Date().toISOString() }
  fs.writeFileSync(file, JSON.stringify(record, null, 2))
  // 尽力收紧权限（Windows 上是 no-op，但 Linux/macOS 有效）
  try { fs.chmodSync(file, 0o600) } catch {}
  return { token, source: 'generated', createdAt: record.createdAt }
}

export function createAdminAuth(options = {}) {
  const token = options.token
  const ttlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS
  const now = options.now || (() => Date.now())
  // 已用掉的一次性链接 —— 防止同一条 URL 反复换会话
  const consumed = new Map()

  if (!token) throw new Error('admin token 缺失')

  const sign = (body) => crypto.createHmac('sha256', token).update(body).digest('hex')
  const safeEqual = (a, b) => {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
    try { return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)) } catch { return false }
  }

  /** 签发本机会话值（无状态：服务端靠签名验证，不落任何表） */
  function issueSession() {
    const body = `${crypto.randomBytes(16).toString('hex')}.${now() + ttlMs}`
    return `${body}.${sign(body)}`
  }

  function verifySession(value) {
    if (typeof value !== 'string' || !value) return false
    const i = value.lastIndexOf('.')
    if (i <= 0) return false
    const body = value.slice(0, i)
    if (!safeEqual(value.slice(i + 1), sign(body))) return false
    const exp = Number(body.slice(body.indexOf('.') + 1))
    return Number.isFinite(exp) && exp > now()
  }

  /** 签发一次性登录链接里的随机数 */
  function issueBootstrap(ttlMsOverride) {
    const exp = now() + (ttlMsOverride ?? BOOTSTRAP_TTL_MS)
    const body = `${crypto.randomBytes(24).toString('hex')}.${exp}`
    return `${body}.${sign(body)}`
  }

  /** 校验并作废一次性随机数：单次使用、过期作废、重放拒绝 */
  function consumeBootstrap(value) {
    if (typeof value !== 'string' || !value) return { ok: false, reason: 'missing' }
    const parts = value.split('.')
    if (parts.length !== 3) return { ok: false, reason: 'malformed' }
    const body = `${parts[0]}.${parts[1]}`
    if (!safeEqual(parts[2], sign(body))) return { ok: false, reason: 'bad_signature' }
    if (consumed.has(parts[0])) return { ok: false, reason: 'already_used' }
    const exp = Number(parts[1])
    if (!Number.isFinite(exp) || exp <= now()) return { ok: false, reason: 'expired' }
    consumed.set(parts[0], exp)
    // 顺手清掉过期项，避免这个 Map 无限长大
    for (const [k, v] of consumed) if (v <= now()) consumed.delete(k)
    return { ok: true }
  }

  function parseCookies(header) {
    const out = {}
    for (const part of String(header || '').split(';')) {
      const eq = part.indexOf('=')
      if (eq < 0) continue
      const k = part.slice(0, eq).trim()
      if (!k) continue
      // 畸形百分号编码（Cookie: a=%）会让 decodeURIComponent 抛 URIError。
      // 这个 header 是客户端完全可控的，不能让半吊子编码把请求处理器掀翻 ——
      // 单条解不开就当这条 Cookie 不存在，其余照常解析。
      try {
        out[k] = decodeURIComponent(part.slice(eq + 1).trim())
      } catch {
        out[k] = part.slice(eq + 1).trim()
      }
    }
    return out
  }

  /**
   * 判定一个请求是否通过了管理鉴权。
   * 两种凭据皆可：Authorization: Bearer <令牌>（脚本/CLI）或本机会话 Cookie（浏览器）。
   */
  function verifyRequest(req) {
    const auth = String(req.headers?.authorization || '')
    const m = auth.match(/^Bearer\s+(.+)$/i)
    if (m && safeEqual(m[1].trim(), token)) return { ok: true, via: 'token' }
    const cookie = parseCookies(req.headers?.cookie)[SESSION_COOKIE]
    if (cookie && verifySession(cookie)) return { ok: true, via: 'session' }
    return { ok: false }
  }

  function sessionCookieHeader(value = issueSession()) {
    const maxAge = Math.floor(ttlMs / 1000)
    return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`
  }

  return Object.freeze({
    token,
    sessionTtlMs: ttlMs,
    issueSession,
    verifySession,
    issueBootstrap,
    consumeBootstrap,
    verifyRequest,
    sessionCookieHeader,
    parseCookies
  })
}
