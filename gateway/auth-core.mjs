// Codex 网关 · 授权核心（零依赖，供 gateway/launcher.mjs 使用）
//
// 负责的“登录态”相关能力：
//   1. 多模式配置：bridge（复用 codex login OAuth） / openai（自带 API Key 直连）
//   2. 把 Token/JSON 或导入的 auth.json 写到本地文件，供 chatgpt-bridge 读取
//   3. OAuth 设备流（device flow）：浏览器/设备码授权，自动换 token 并落盘
//   4. API Key 模式：仅保存 key，由上层反代直接转发到 https://api.openai.com/v1
//
// 合规：本地 127.0.0.1、单用户自用；OAuth/Token 均来自用户自己的账号。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const OAUTH_ISSUER = 'https://auth.openai.com'
const OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const SCOPE = 'openid profile email offline_access api.connectors.read api.connectors.invoke'

// ---------- 默认 auth 文件路径（由 bridge 读取） ----------
export function defaultAuthFilePath() {
  // 优先用项目内的 gateway/auth.json，避免污染用户主目录；可被配置覆盖
  return path.join(__dirname, 'auth.json')
}

// ---------- 配置持久化（gateway/.gw-config.json） ----------
const CONFIG_PATH = path.join(__dirname, '.gw-config.json')

export function loadConfig() {
  // proxy: 出网代理地址，如 http://127.0.0.1:7897；留空表示直连
  // （Tailscale exit node / 系统层方案无需填写，因为它们对应用透明）
  const base = { mode: 'bridge', openaiApiKey: '', authFilePath: defaultAuthFilePath(), autoStart: true, proxy: '' }
  try {
    const txt = fs.readFileSync(CONFIG_PATH, 'utf-8')
    const j = JSON.parse(txt)
    return { ...base, ...j }
  } catch {
    return base
  }
}

export function saveConfig(cfg) {
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true })
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ mode: cfg.mode, openaiApiKey: cfg.openaiApiKey, authFilePath: cfg.authFilePath, autoStart: cfg.autoStart, proxy: cfg.proxy || '', strictAuth: !!cfg.strictAuth }, null, 2))
  } catch {}
  return cfg
}

// ---------- JWT 解析（仅读 payload，不校验签名） ----------
export function jwtClaims(token) {
  if (!token || !token.includes('.')) return
  const parts = token.split('.')
  if (parts.length !== 3 || !parts[1]) return
  try {
    const padded = parts[1] + '='.repeat((-parts[1].length % 4 + 4) % 4)
    const json = JSON.parse(Buffer.from(padded, 'base64url').toString('utf-8'))
    return typeof json === 'object' && json !== null ? json : undefined
  } catch {
    return
  }
}

export function accountIdFromIdToken(idToken) {
  const c = jwtClaims(idToken)
  if (!c) return
  const ns = c['https://api.openai.com/auth']
  if (typeof ns === 'object' && ns !== null && !Array.isArray(ns)) {
    const v = ns.chatgpt_account_id
    if (typeof v === 'string' && v.length) return v
  }
  return
}

export function emailFromIdToken(idToken) {
  const c = jwtClaims(idToken)
  if (!c) return
  const profile = c['https://api.openai.com/profile']
  if (typeof profile === 'object' && profile !== null && typeof profile.email === 'string') {
    return profile.email
  }
  if (typeof c.email === 'string') return c.email
  return
}

// 账号稳定指纹：用于去重。与 cockpit-tools 的 upsert_account 思路一致，
// 以 account_id + email 作为同一物理账号的标识；API Key 模式以 key 哈希标识。
export function accountFingerprint(data) {
  if (!data || typeof data !== 'object') return null
  // API Key 模式
  if (data.auth_mode === 'api_key') {
    const key = data.OPENAI_API_KEY || ''
    if (!key) return null
    return 'apikey:' + crypto.createHash('sha256').update(key).digest('hex').slice(0, 32)
  }
  const tokens = data.tokens || {}
  const acctId = tokens.account_id || accountIdFromIdToken(tokens.id_token)
  const email = emailFromIdToken(tokens.id_token)
  const sub = jwtClaims(tokens.id_token)?.sub
  const parts = []
  if (acctId) parts.push('acct:' + acctId)
  if (email) parts.push('email:' + email.toLowerCase())
  if (sub) parts.push('sub:' + sub)
  // 无 id_token 的纯 token 导入：退而求其次用 access_token 前 32 字节哈希
  if (!parts.length && tokens.access_token) {
    parts.push('access:' + crypto.createHash('sha256').update(tokens.access_token).digest('hex').slice(0, 32))
  }
  return parts.length ? parts.join('|') : null
}

export function findAccountByFingerprint(reg, data) {
  const fp = accountFingerprint(data)
  if (!fp || !reg || !Array.isArray(reg.accounts)) return null
  return reg.accounts.find((a) => {
    if (!a.fingerprint) return false
    // 任意一段匹配即视为同一账号（兼容后续指纹字段扩展）
    const aParts = a.fingerprint.split('|')
    const bParts = fp.split('|')
    return aParts.some((x) => bParts.includes(x))
  })
}

// ---------- 写入 bridge 兼容的 auth.json ----------
export async function writeAuthFile(filePath, data) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true })
  await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 })
}

// 把用户粘贴/导入的任意 JSON 规范化为 bridge 形态
export function normalizeAuthJson(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('auth 内容不是合法 JSON 对象')
  // 已经是 bridge 形态
  if (raw.tokens && (raw.tokens.access_token || raw.tokens.refresh_token)) {
    return {
      auth_mode: raw.auth_mode ?? 'chatgpt',
      OPENAI_API_KEY: raw.OPENAI_API_KEY ?? null,
      tokens: {
        access_token: raw.tokens.access_token,
        refresh_token: raw.tokens.refresh_token,
        id_token: raw.tokens.id_token ?? null,
        account_id: raw.tokens.account_id ?? accountIdFromIdToken(raw.tokens.id_token) ?? null
      },
      last_refresh: raw.last_refresh ?? new Date().toISOString()
    }
  }
  // 仅 access/refresh（无 tokens 包裹）
  if (raw.access_token || raw.refresh_token) {
    const idToken = raw.id_token ?? null
    return {
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: {
        access_token: raw.access_token ?? null,
        refresh_token: raw.refresh_token ?? null,
        id_token: idToken,
        account_id: raw.account_id ?? accountIdFromIdToken(idToken) ?? null
      },
      last_refresh: new Date().toISOString()
    }
  }
  // 含 OPENAI_API_KEY 的 API Key 形态
  if (raw.OPENAI_API_KEY || raw.api_key || raw.apiKey) {
    return {
      auth_mode: 'api_key',
      OPENAI_API_KEY: raw.OPENAI_API_KEY ?? raw.api_key ?? raw.apiKey,
      tokens: null,
      last_refresh: new Date().toISOString()
    }
  }
  throw new Error('无法识别的 auth 结构：需包含 tokens / access_token / OPENAI_API_KEY 之一')
}

// ---------- OAuth 设备流 ----------
// Codex 用的并不是标准 RFC 8628 端点。实测（2026-09-02，经代理绕过地区限制后）：
//   /oauth/device_authorization        → 404 Invalid URL（OpenAI 侧不存在）
//   /oauth/token + device_code grant   → 400 不支持该 grant_type
// 实际流程为 Codex 私有端点：
//   1) POST /api/accounts/deviceauth/usercode  → { device_auth_id, user_code, interval, expires_at }
//   2) 用户在 auth.openai.com/codex/device 输入 user_code
//   3) POST /api/accounts/deviceauth/token     → 待授权：403 “…is pending…”；成功：authorization_code + code_verifier
//   4) 用 /oauth/token 以 authorization_code + PKCE 换取 access/refresh token
const DEVICE_USERCODE_ENDPOINT = `${OAUTH_ISSUER}/api/accounts/deviceauth/usercode`
const DEVICE_TOKEN_ENDPOINT = `${OAUTH_ISSUER}/api/accounts/deviceauth/token`
const DEVICE_VERIFY_PAGE = `${OAUTH_ISSUER}/codex/device`
const DEVICE_CALLBACK_URI = `${OAUTH_ISSUER}/deviceauth/callback`

let pendingDevice = null // 单会话：{ device_auth_id, user_code, interval, expires_at, lastPoll }

export async function startDeviceFlow() {
  const res = await fetch(DEVICE_USERCODE_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: OAUTH_CLIENT_ID })
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`设备授权请求失败 HTTP ${res.status} ${body.slice(0, 200)}`)
  }
  const j = await res.json()
  if (!j.device_auth_id || !j.user_code) {
    throw new Error('设备授权响应缺少 device_auth_id / user_code：' + JSON.stringify(j).slice(0, 160))
  }
  // expires_at 是 ISO 字符串；缺失时按 15 分钟兜底
  const expMs = j.expires_at ? Date.parse(j.expires_at) : NaN
  pendingDevice = {
    device_auth_id: j.device_auth_id,
    user_code: j.user_code,
    interval: Number(j.interval) || 5,
    expires_at: Number.isFinite(expMs) ? expMs : Date.now() + 15 * 60 * 1000,
    lastPoll: 0
  }
  return {
    verification_uri: DEVICE_VERIFY_PAGE,
    verification_uri_complete: `${DEVICE_VERIFY_PAGE}?user_code=${encodeURIComponent(j.user_code)}`,
    user_code: j.user_code,
    interval: pendingDevice.interval,
    expires_at: new Date(pendingDevice.expires_at).toISOString()
  }
}

export async function pollDeviceFlow() {
  if (!pendingDevice) throw new Error('没有进行中的设备授权，请先 start')
  if (Date.now() > pendingDevice.expires_at) {
    pendingDevice = null
    throw new Error('设备授权已过期，请重新发起')
  }
  const now = Date.now()
  if (now - pendingDevice.lastPoll < pendingDevice.interval * 1000) {
    return { pending: true }
  }
  pendingDevice.lastPoll = now

  const res = await fetch(DEVICE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      device_auth_id: pendingDevice.device_auth_id,
      user_code: pendingDevice.user_code
    })
  })
  const j = await res.json().catch(() => ({}))
  const errMsg = String((j.error && j.error.message) || j.error || '')

  if (!res.ok) {
    // 待授权是正常中间态：403 + “Device authorization is pending.”
    if (/pending/i.test(errMsg)) return { pending: true }
    if (/slow.?down/i.test(errMsg)) {
      pendingDevice.interval += 5
      return { pending: true }
    }
    pendingDevice = null
    throw new Error('设备授权失败：' + (errMsg || JSON.stringify(j).slice(0, 160)))
  }

  // 成功：拿到 authorization_code + code_verifier，再用 PKCE 换 token
  pendingDevice = null
  if (!j.authorization_code || !j.code_verifier) {
    throw new Error('设备授权响应缺少 authorization_code / code_verifier：' + JSON.stringify(j).slice(0, 200))
  }
  const data = await exchangeCodeForToken({
    code: j.authorization_code,
    verifier: j.code_verifier,
    redirectUri: DEVICE_CALLBACK_URI
  })
  return { pending: false, tokens: data }
}

export function clearDeviceFlow() {
  pendingDevice = null
}

// ===================================================================
//  OAuth 浏览器回调（Authorization Code + PKCE + loopback 回调）
//
//  与设备流并存，两条路都能拿到同一形态的 auth 数据：
//    - 浏览器回调：本地起 127.0.0.1:<port> 接住 /auth/callback，授权码换 token
//    - 设备流：轮询 device_code（见上）
//
//  redirect_uri 用 loopback 地址（RFC 8252 native app 规范）：
//  public client 允许 localhost 回环回调，无需在服务商后台预先注册精确 URI。
//  这也是 Codex 官方桌面端采用的方式。
// ===================================================================
const OAUTH_AUTHORIZE_ENDPOINT = `${OAUTH_ISSUER}/oauth/authorize`
const OAUTH_TOKEN_ENDPOINT = `${OAUTH_ISSUER}/oauth/token`
const HOSTED_AUTH_ENDPOINT = 'https://chatgpt.com/codex/desktop-auth'
const ORIGINATOR = 'Codex Desktop'
const OAUTH_CALLBACK_PORT = 1455
const OAUTH_TIMEOUT_MS = 10 * 60 * 1000
const OFFICIAL_CLIENT_VERSION = '26.820.60940'
const CLIENT_IDENTITY_FILE = path.join(__dirname, '.codex-client-identity')

let pendingBrowser = null

// 查找本机已有的官方 Codex 客户端身份文件（cockpit-tools / 官方 Codex CLI 会生成）
function findOfficialClientIdentity() {
  const home = os.homedir()
  const candidates = []
  if (process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, 'Codex', 'codex-official-client-identity.txt'))
  }
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'Codex', 'codex-official-client-identity.txt'))
  }
  candidates.push(
    path.join(home, '.antigravity_cockpit', 'codex-official-client-identity.txt'),
    path.join(home, '.codex', 'codex-official-client-identity.txt'),
    path.join(home, '.openai', 'codex-official-client-identity.txt')
  )
  for (const p of candidates) {
    try {
      const txt = fs.readFileSync(p, 'utf-8').trim()
      if (/^[0-9a-fA-F-]{36,}$/.test(txt)) return { id: txt, source: p }
    } catch {}
  }
  return null
}

// 读取或生成稳定的官方客户端身份 ID
function loadClientIdentity() {
  // 优先复用已存在的官方身份（OpenAI 会校验这个 stable_id）
  const official = findOfficialClientIdentity()
  if (official) return official.id

  // 兜底：读取/生成本地身份
  try {
    const txt = fs.readFileSync(CLIENT_IDENTITY_FILE, 'utf-8').trim()
    if (txt.length >= 32) return txt
  } catch {}
  const id = crypto.randomUUID()
  try {
    fs.writeFileSync(CLIENT_IDENTITY_FILE, id, { encoding: 'utf-8', mode: 0o600 })
  } catch {}
  return id
}
const CLIENT_IDENTITY = loadClientIdentity()

function b64url(input) {
  return Buffer.from(input).toString('base64url')
}

function generatePkce() {
  const verifier = b64url(crypto.randomBytes(32))
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

function buildAuthorizeUrl({ redirectUri, codeChallenge, state }) {
  // 必须与 cockpit-tools 的 urlencoding::encode 完全一致：空格编码为 "+"。
  // 之前用 encodeURIComponent 会得到 "%20"，chatgpt.com/codex/desktop-auth 校验不通过。
  // 以下 4 个参数来自 cockpit-tools：缺少任意一个都会导致 OpenAI authorize 返回 missing_required_parameter。
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: SCOPE,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    codex_streamlined_login: 'true',
    state,
    originator: ORIGINATOR,
    codex_app_version: OFFICIAL_CLIENT_VERSION,
    source_surface_stable_id: CLIENT_IDENTITY,
    codex_origin_stable_id: CLIENT_IDENTITY
  })
  return `${OAUTH_AUTHORIZE_ENDPOINT}?${params.toString()}`
}

// 包装成官方桌面端托管登录页，可复用 ChatGPT 网页端已登录会话
function buildHostedUrl(authUrl) {
  return (
    `${HOSTED_AUTH_ENDPOINT}?authorize_url=${encodeURIComponent(authUrl)}` +
    '&codex_streamlined_login=true&no_universal_links=1'
  )
}

function findAvailablePort(startPort) {
  return new Promise((resolve, reject) => {
    const tryPort = (port) => {
      if (port > startPort + 20) return reject(new Error('找不到可用的本地回调端口'))
      const probe = http.createServer()
      probe.once('error', () => tryPort(port + 1))
      probe.once('listening', () => probe.close(() => resolve(port)))
      probe.listen(port, '127.0.0.1')
    }
    tryPort(startPort)
  })
}

async function exchangeCodeForToken({ code, verifier, redirectUri }) {
  const res = await fetch(OAUTH_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json'
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: OAUTH_CLIENT_ID,
      code_verifier: verifier
    })
  })
  const j = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error('Token 交换失败：' + (j.error_description || j.error || `HTTP ${res.status}`))
  }
  if (!j.access_token) throw new Error('Token 交换响应缺少 access_token')
  const idToken = j.id_token ?? null
  return {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      access_token: j.access_token,
      refresh_token: j.refresh_token ?? null,
      id_token: idToken,
      account_id: accountIdFromIdToken(idToken) ?? null
    },
    last_refresh: new Date().toISOString()
  }
}

function respondHtml(res, title, body) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(
    `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
      `<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;` +
      `background:#0a0b0e;color:#e7e9ec;font:14px/1.6 system-ui">` +
      `<div style="text-align:center"><div style="font-size:16px;font-weight:600;margin-bottom:8px">${title}</div>` +
      `<div style="color:#9ca3af">${body}</div></div></body>`
  )
}

// 发起浏览器登录：起本地回调服务器，返回授权地址（含官方托管登录页地址）
export async function startBrowserLogin() {
  if (pendingBrowser) cancelBrowserLogin()
  const port = await findAvailablePort(OAUTH_CALLBACK_PORT)
  const { verifier, challenge } = generatePkce()
  const state = b64url(crypto.randomBytes(24))
  const loginId = b64url(crypto.randomBytes(16))
  const redirectUri = `http://localhost:${port}/auth/callback`
  const authUrl = buildAuthorizeUrl({ redirectUri, codeChallenge: challenge, state })

  const session = {
    loginId,
    state,
    verifier,
    redirectUri,
    port,
    expiresAt: Date.now() + OAUTH_TIMEOUT_MS,
    server: null,
    timer: null,
    result: null,
    error: null
  }

  const server = http.createServer((req, res) => {
    const u = new URL(req.url || '/', `http://127.0.0.1:${port}`)
    if (u.pathname !== '/auth/callback') {
      res.writeHead(404)
      return res.end('not found')
    }
    const oauthErr = u.searchParams.get('error')
    if (oauthErr) {
      session.error = '授权未完成：' + oauthErr
      return respondHtml(res, '授权失败', `${oauthErr}，请回到应用重试。`)
    }
    const code = u.searchParams.get('code')
    const st = u.searchParams.get('state')
    if (!code) {
      return respondHtml(res, '授权未完成', '未收到授权码，请回到应用重试。')
    }
    if (st !== session.state) {
      session.error = 'state 校验失败，已中止此次登录'
      return respondHtml(res, '授权已中止', 'state 不匹配，已中止此次登录。')
    }
    exchangeCodeForToken({ code, verifier: session.verifier, redirectUri: session.redirectUri })
      .then((tokens) => {
        session.result = tokens
        respondHtml(res, '授权成功', '已获取登录态，可关闭此页面并返回应用。')
      })
      .catch((e) => {
        session.error = e.message
        respondHtml(res, '授权失败', e.message)
      })
  })

  session.server = server
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })

  session.timer = setTimeout(() => {
    if (pendingBrowser === session && !session.result) {
      session.error = '登录超时（10 分钟），请重新发起'
      cancelBrowserLogin()
    }
  }, OAUTH_TIMEOUT_MS)

  pendingBrowser = session
  // 端口漂移风险提示：官方 Codex 桌面端 / CLI 常驻占用 1455，
  // 一旦漂移到其它端口，redirect_uri 与官方客户端的既有约定不一致，
  // 部分账号（尤其 Google 联邦登录）会在授权页直接报 URL / redirect_uri 错误。
  // 这里显式回报，让 UI 与日志能说明「为什么这次回调地址不是 1455」。
  const portDrifted = port !== OAUTH_CALLBACK_PORT
  return {
    loginId,
    authUrl,
    hostedUrl: buildHostedUrl(authUrl),
    redirectUri,
    port,
    preferredPort: OAUTH_CALLBACK_PORT,
    portDrifted,
    warning: portDrifted
      ? `回调端口 1455 被占用，本次改用 ${port}。若浏览器提示 URL 错误 / redirect_uri 不匹配，` +
        `请改用「设备码登录」，或先退出占用 1455 的进程（通常是官方 Codex 客户端）后重试。`
      : '',
    expiresAt: session.expiresAt
  }
}

// 轮询登录状态：与设备流返回结构保持一致（pending / tokens）
export async function pollBrowserLogin() {
  const s = pendingBrowser
  if (!s) throw new Error('没有进行中的浏览器登录，请先发起')
  if (s.error) {
    const msg = s.error
    cancelBrowserLogin()
    throw new Error(msg)
  }
  if (s.result) {
    const tokens = s.result
    cancelBrowserLogin()
    return { pending: false, tokens }
  }
  if (Date.now() > s.expiresAt) {
    cancelBrowserLogin()
    throw new Error('浏览器登录已过期，请重新发起')
  }
  return { pending: true }
}

// 手动兜底：本地回调服务器未能接住时，粘贴完整回调地址
export async function submitBrowserCallback(callbackUrl) {
  const s = pendingBrowser
  if (!s) throw new Error('没有进行中的浏览器登录，请先发起')
  const raw = String(callbackUrl || '').trim()
  if (!raw) throw new Error('请粘贴完整的回调地址')
  let u
  try {
    u = new URL(raw)
  } catch {
    throw new Error('回调地址不是合法 URL')
  }
  const code = u.searchParams.get('code')
  const st = u.searchParams.get('state')
  if (!code) throw new Error('回调地址中未找到 code 参数')
  if (st && st !== s.state) throw new Error('state 校验失败，已中止此次登录')
  const tokens = await exchangeCodeForToken({
    code,
    verifier: s.verifier,
    redirectUri: s.redirectUri
  })
  cancelBrowserLogin()
  return { pending: false, tokens }
}

export function getBrowserLoginInfo() {
  const s = pendingBrowser
  if (!s) return null
  return { loginId: s.loginId, redirectUri: s.redirectUri, port: s.port, expiresAt: s.expiresAt }
}

export function cancelBrowserLogin() {
  const s = pendingBrowser
  pendingBrowser = null
  if (!s) return
  if (s.timer) clearTimeout(s.timer)
  try {
    s.server?.close()
  } catch {}
}

// ===================================================================
//  多账号仓库（本地，单用户自用）
//    - 每个账号独立存于 gateway/accounts/<id>.json（bridge 规范化形态）
//    - gateway/accounts.json 为注册表：{ activeId, accounts: [...] }
//    - bridge 始终只读“当前激活账号”的 auth 文件，切换即改指向并重启
// ===================================================================
const ACCOUNTS_DIR = path.join(__dirname, 'accounts')
const ACCOUNTS_REGISTRY = path.join(__dirname, 'accounts.json')

function genAccountId() {
  return 'acc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

export function loadAccounts() {
  try {
    const txt = fs.readFileSync(ACCOUNTS_REGISTRY, 'utf-8')
    const j = JSON.parse(txt)
    if (j && Array.isArray(j.accounts)) return j
  } catch {}
  return { activeId: null, accounts: [] }
}

export function saveAccounts(reg) {
  try {
    fs.mkdirSync(path.dirname(ACCOUNTS_REGISTRY), { recursive: true })
    fs.writeFileSync(ACCOUNTS_REGISTRY, JSON.stringify(reg, null, 2))
  } catch {}
  return reg
}

// 某账号 auth 文件的绝对路径
export function accountAuthPath(id) {
  return path.join(ACCOUNTS_DIR, id + '.json')
}

function defaultAccountName(provider, data) {
  if (provider === 'oauth' && data?.tokens?.account_id) {
    return 'ChatGPT·' + String(data.tokens.account_id).slice(-6)
  }
  if (provider === 'apikey') return 'OpenAI API Key'
  const n = (loadAccounts().accounts || []).length + 1
  return '账号 ' + n
}

// 写入已规范化 bridge 形态 data，并登记为新账号（自动激活）
// 若指纹命中已有账号，则更新该账号的 token 与元数据，避免重复建档。
export async function addAccount({ name, provider = 'token', mode = 'bridge', data }) {
  const reg = loadAccounts()
  const existing = findAccountByFingerprint(reg, data)
  if (existing) {
    const id = existing.id
    const filePath = accountAuthPath(id)
    await writeAuthFile(filePath, data)
    // 不降级 provider：oauth 比 token 更具体，保留已有更精确标签
    if (provider !== 'token' || existing.provider !== 'oauth') {
      existing.provider = provider
    }
    existing.mode = mode
    if (name && name.trim()) existing.name = name.trim().slice(0, 40)
    existing.fingerprint = accountFingerprint(data)
    existing.email = emailFromIdToken(data?.tokens?.id_token) || existing.email || ''
    existing.updatedAt = new Date().toISOString()
    reg.activeId = id
    saveAccounts(reg)
    return { id, reg, path: filePath, isExisting: true }
  }

  const id = genAccountId()
  const filePath = accountAuthPath(id)
  await writeAuthFile(filePath, data)
  reg.accounts.push({
    id,
    name: name || defaultAccountName(provider, data),
    provider,
    mode,
    fingerprint: accountFingerprint(data),
    email: emailFromIdToken(data?.tokens?.id_token) || '',
    createdAt: new Date().toISOString()
  })
  reg.activeId = id
  saveAccounts(reg)
  return { id, reg, path: filePath, isExisting: false }
}

// 切换激活账号，返回该账号 auth 文件路径
export function setActiveAccount(id) {
  const reg = loadAccounts()
  const found = reg.accounts.find((a) => a.id === id)
  if (!found) throw new Error('账号不存在：' + id)
  reg.activeId = id
  saveAccounts(reg)
  return { ok: true, path: accountAuthPath(id) }
}

// 删除账号；返回新的 activeId（若有）
export function removeAccount(id) {
  const reg = loadAccounts()
  const idx = reg.accounts.findIndex((a) => a.id === id)
  if (idx === -1) throw new Error('账号不存在：' + id)
  reg.accounts.splice(idx, 1)
  try { fs.unlinkSync(accountAuthPath(id)) } catch {}
  if (reg.activeId === id) {
    reg.activeId = reg.accounts.length ? reg.accounts[reg.accounts.length - 1].id : null
  }
  saveAccounts(reg)
  return { ok: true, activeId: reg.activeId, path: reg.activeId ? accountAuthPath(reg.activeId) : null }
}

// 重命名 / 备注：仅改注册表，不动 auth 文件
export function renameAccount(id, { name, note } = {}) {
  const reg = loadAccounts()
  const found = reg.accounts.find((a) => a.id === id)
  if (!found) throw new Error('账号不存在：' + id)
  if (typeof name === 'string' && name.trim()) found.name = name.trim().slice(0, 40)
  if (typeof note === 'string') found.note = note.slice(0, 120)
  saveAccounts(reg)
  return { ok: true, account: { ...found } }
}

// 待授权账号：先登记（此时无 auth 文件），授权完成后补全
// 用途：OAuth 发起前先把邮箱 / 备注存成卡片，授权成功后落到该卡片上，
//       避免只能拿到自动生成的 ChatGPT·XXXXXX 这类名字。
export function addPendingAccount({ name, email, note, provider = 'oauth' } = {}) {
  const id = genAccountId()
  const reg = loadAccounts()
  const label = (name && name.trim()) || (email && email.trim()) || '待授权账号'
  reg.accounts.push({
    id,
    name: label.slice(0, 40),
    email: (email || '').trim().slice(0, 80),
    note: (note || '').slice(0, 120),
    provider,
    mode: 'bridge',
    status: 'pending',
    createdAt: new Date().toISOString()
  })
  saveAccounts(reg)
  return { id, reg }
}

// 补全待授权账号：写入 auth 文件、置为 active 并激活
// 若该 token 已对应另一个已有账号，则合并到已有账号并删除待授权卡片。
export async function completePendingAccount(id, data, { name, provider = 'oauth', mode = 'bridge' } = {}) {
  const reg = loadAccounts()
  const pending = reg.accounts.find((a) => a.id === id)
  if (!pending) throw new Error('待授权账号不存在：' + id)

  const existing = findAccountByFingerprint(reg, data)
  if (existing && existing.id !== id) {
    // 待授权卡片的身份与已有账号重复：删除卡片，把 token 更新到已有账号
    const filePath = accountAuthPath(existing.id)
    await writeAuthFile(filePath, data)
    existing.provider = provider
    existing.mode = mode
    if (name && name.trim()) existing.name = name.trim().slice(0, 40)
    existing.fingerprint = accountFingerprint(data)
    existing.email = emailFromIdToken(data?.tokens?.id_token) || existing.email || ''
    existing.updatedAt = new Date().toISOString()
    // 移除待授权卡片
    const idx = reg.accounts.findIndex((a) => a.id === id)
    if (idx !== -1) reg.accounts.splice(idx, 1)
    try { fs.unlinkSync(accountAuthPath(id)) } catch {}
    reg.activeId = existing.id
    saveAccounts(reg)
    return { id: existing.id, reg, path: filePath, isExisting: true }
  }

  const filePath = accountAuthPath(id)
  await writeAuthFile(filePath, data)
  pending.status = 'active'
  pending.provider = provider
  pending.mode = mode
  if (name && name.trim()) pending.name = name.trim().slice(0, 40)
  pending.fingerprint = accountFingerprint(data)
  pending.email = emailFromIdToken(data?.tokens?.id_token) || pending.email || ''
  pending.updatedAt = new Date().toISOString()
  reg.activeId = id
  saveAccounts(reg)
  return { id, reg, path: filePath, isExisting: false }
}

// 解析当前应被 bridge 读取的 auth 文件：多账号优先，否则旧单文件兜底
export function resolveActiveAuthFilePath() {
  const reg = loadAccounts()
  if (reg.activeId) {
    const f = accountAuthPath(reg.activeId)
    if (fs.existsSync(f)) return f
  }
  return defaultAuthFilePath()
}

// 首次启动迁移：已有旧 auth.json 且无账号仓库时，导入为“默认账号”
export function migrateLegacyAuth() {
  const reg = loadAccounts()
  if (reg.accounts.length) return reg
  const legacy = defaultAuthFilePath()
  if (fs.existsSync(legacy)) {
    try {
      const raw = JSON.parse(fs.readFileSync(legacy, 'utf-8'))
      const data = normalizeAuthJson(raw)
      addAccount({
        name: '默认账号',
        provider: data.auth_mode === 'api_key' ? 'apikey' : 'token',
        mode: 'bridge',
        data
      })
    } catch {}
  }
  return loadAccounts()
}
