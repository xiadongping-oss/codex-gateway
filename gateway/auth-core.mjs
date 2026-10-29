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
import { writeJsonAtomic, writeTextAtomic, createCachedTextReader } from './atomic-write.mjs'
import { resolveDataRoot, normalizeAuthFilePath } from './data-root.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// 数据根：安装布局（CGW_DATA_DIR）下账号/配置/凭据住数据目录，
// 未设置时就是程序目录 —— 绿色版行为不变。
const DATA_ROOT = resolveDataRoot(process.env, __dirname)

const OAUTH_ISSUER = 'https://auth.openai.com'
const OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const SCOPE = 'openid profile email offline_access api.connectors.read api.connectors.invoke'

// ---------- 默认 auth 文件路径（由 bridge 读取） ----------
export function defaultAuthFilePath() {
  // 优先用数据根下的 auth.json，避免污染用户主目录；可被配置覆盖
  return path.join(DATA_ROOT, 'auth.json')
}

// ---------- 配置持久化（<数据根>/.gw-config.json） ----------
const CONFIG_PATH = path.join(DATA_ROOT, '.gw-config.json')

export function loadConfig() {
  // proxy: 出网代理地址，如 http://127.0.0.1:7897；留空表示直连
  // （Tailscale exit node / 系统层方案无需填写，因为它们对应用透明）
  // referenceRoot: 参考图允许所在的根目录，留空 = 用默认（gateway/references）
  const base = { mode: 'bridge', openaiApiKey: '', openaiBaseUrl: '', authFilePath: defaultAuthFilePath(), autoStart: true, proxy: '', referenceRoot: '' }
  try {
    const txt = fs.readFileSync(CONFIG_PATH, 'utf-8')
    const j = JSON.parse(txt)
    const merged = { ...base, ...j }
    // 绿色版 → 安装版升级后，config 里存的旧程序目录路径要归一化到数据根
    merged.authFilePath = normalizeAuthFilePath(merged.authFilePath, __dirname, defaultAuthFilePath())
    return merged
  } catch {
    return base
  }
}

export function saveConfig(cfg) {
  try {
    writeJsonAtomic(CONFIG_PATH, {
      mode: cfg.mode,
      openaiApiKey: cfg.openaiApiKey,
      openaiBaseUrl: cfg.openaiBaseUrl || '',
      authFilePath: cfg.authFilePath,
      autoStart: cfg.autoStart,
      proxy: cfg.proxy || '',
      strictAuth: !!cfg.strictAuth,
      referenceRoot: cfg.referenceRoot || ''
    })
  } catch (e) {
    // 以前是纯吞：磁盘只读 / 被占用时 saveConfig 一声不响，
    // 重启后 mode、proxy、激活账号全部回到默认值，用户只会觉得"它自己变了"。
    console.error('[codex-gateway] 写入配置失败（改动未落盘）：' + (e && e.message || e))
    return false
  }
  return true
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
  // 原子写。这里是 refresh_token 这类长期凭据，写一半被杀的结果是文件留在半截 JSON，
  // 上层把这当成「文件不存在」，用户在控制台看到的是账号莫名不可用。
  writeTextAtomic(filePath, JSON.stringify(data, null, 2) + '\n')
}

// 把用户粘贴/导入的任意 JSON 规范化为 bridge 形态。
// 接受的形态（对齐常见工具的导出格式）：
//   1. bridge 形态 / 完整 auth.json（tokens 包裹）
//   2. 裸 access_token / refresh_token（snake_case，可带 id_token）
//   3. camelCase 单字段（accessToken / refreshToken / idToken）
//   4. API Key 形态（OPENAI_API_KEY / api_key / apiKey / personal_access_token）
//   5. Sub2API 等工具的导出 JSON：本层没有凭据字段时，向第一层嵌套对象找一次
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
  // camelCase（部分工具导出 accessToken / refreshToken）
  if (raw.accessToken || raw.refreshToken) {
    return normalizeAuthJson({
      access_token: raw.accessToken ?? null,
      refresh_token: raw.refreshToken ?? null,
      id_token: raw.idToken ?? null,
      account_id: raw.account_id ?? null
    })
  }
  // 含 OPENAI_API_KEY 的 API Key 形态（personal_access_token 同属此类）
  if (raw.OPENAI_API_KEY || raw.api_key || raw.apiKey || raw.personal_access_token) {
    return {
      auth_mode: 'api_key',
      OPENAI_API_KEY: raw.OPENAI_API_KEY ?? raw.api_key ?? raw.apiKey ?? raw.personal_access_token,
      tokens: null,
      last_refresh: new Date().toISOString()
    }
  }
  // Sub2API 等导出 JSON：凭据在第一层嵌套对象里。只找一层、命中即递归，
  // 不做全树深搜 —— 防止把任意深层未知 JSON 里的巧合字段误当凭据。
  if (!raw.__nestedLookup) {
    const nested = Object.values(raw).find(
      (v) => v && typeof v === 'object' && !Array.isArray(v) &&
        (v.tokens || v.access_token || v.refresh_token || v.accessToken ||
         v.OPENAI_API_KEY || v.api_key || v.apiKey || v.personal_access_token)
    )
    if (nested) return normalizeAuthJson({ ...nested, __nestedLookup: true })
  }
  throw new Error('无法识别的 auth 结构：需包含 tokens / access_token / accessToken / OPENAI_API_KEY 之一')
}

// ---------- 凭据文本解析（Token / JSON 标签页） ----------
// 除 JSON 外还接受三种裸文本形态；纯 refresh_token 会联网换取完整凭据。
export function looksLikeJwt(text) {
  return /^eyJ[\w-]+\.[\w-]+\.[\w-]*$/.test(String(text ?? '').trim())
}

export function parseAuthTokenText(text) {
  const raw = String(text ?? '').trim()
  if (!raw) throw new Error('请粘贴凭据内容')
  if (raw.startsWith('{') || raw.startsWith('[')) {
    let obj
    try { obj = JSON.parse(raw) } catch { throw new Error('JSON 解析失败：内容以 { 开头但不是合法 JSON') }
    return { kind: 'json', data: normalizeAuthJson(obj) }
  }
  // 个人访问令牌 / API Key（at-… 与 sk-…）
  if (/^(at-|sk-)/.test(raw)) {
    return { kind: 'json', data: normalizeAuthJson({ personal_access_token: raw }) }
  }
  // 裸 JWT access token：能导入但无续期能力，调用方应向用户提示
  if (looksLikeJwt(raw)) {
    return { kind: 'json', data: normalizeAuthJson({ access_token: raw }), warning: '该凭据没有 refresh_token，到期后需重新导入' }
  }
  // 其余非空文本 → 视为 refresh_token，联网换取完整凭据（exchangeRefreshToken）
  return { kind: 'refresh_token', refreshToken: raw }
}

// 用 refresh_token 向 OAuth 端点换取完整凭据（grant_type=refresh_token）。
// fetchImpl 可注入：测试不外联；上层出网代理走 undici 全局 dispatcher。
export async function exchangeRefreshToken(refreshToken, { fetchImpl = fetch } = {}) {
  const rt = String(refreshToken ?? '').trim()
  if (!rt) throw new Error('缺少 refresh_token')
  let resp
  try {
    resp = await fetchImpl(OAUTH_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: rt,
        client_id: OAUTH_CLIENT_ID
      })
    })
  } catch (e) {
    throw new Error('refresh_token 换取请求失败（网络或出网代理）：' + e.message)
  }
  const bodyText = await resp.text()
  let j
  try { j = JSON.parse(bodyText) } catch { throw new Error(`token 端点返回非 JSON（HTTP ${resp.status}）`) }
  if (!resp.ok || !j.access_token) {
    throw new Error('refresh_token 换取被拒绝：' + (j.error_description || j.error || `HTTP ${resp.status}`))
  }
  return normalizeAuthJson({
    tokens: {
      access_token: j.access_token,
      refresh_token: j.refresh_token || rt,
      id_token: j.id_token ?? null,
      account_id: null
    }
  })
}

// ---------- 本机 Codex CLI 登录的无感导入 ----------
// 官方 Codex CLI 把当前登录态存在 ~/.codex/auth.json（结构就是上面的
// tokens 形态：id/access/refresh + account_id）。用户机器上如果已经
// `codex login` 过，网关可以直接读这份文件注册成账号 —— 不用再走一遍
// 浏览器 OAuth。这正是 cockpit-tools 一类工具的「本地导入」做法。
//
// 路径解析与 cockpit-tools 对齐：
//   CODEX_HOME 环境变量（容忍 setx/shell 残留的成对引号与空白）> ~/.codex
export function codexCliAuthPath(env = process.env, homedir = os.homedir) {
  const raw = String(env?.CODEX_HOME ?? '').trim()
  const unquoted = raw.replace(/^["']+|["']+$/g, '').trim()
  if (unquoted) return path.join(unquoted, 'auth.json')
  return path.join(homedir(), '.codex', 'auth.json')
}

/**
 * 探测本机 Codex CLI 登录态。**只读不改**：真正的注册走导入端点。
 * 返回值里的 error 是稳定的机器可读码：
 *   not_found      没有这份文件（用户没用过 Codex CLI，正常情况）
 *   read_error     文件在但读不了（权限/占用）
 *   parse_error    不是合法 JSON（写了一半 / 被其它工具改坏）
 *   unsupported    JSON 合法但不包含可用的凭据结构
 * 探测本身不该抛 —— 前端按钮要拿这份结果决定显示「导入」还是「重新登录」。
 */
export function inspectCodexCliAuth(env = process.env, readFile) {
  const read = typeof readFile === 'function' ? readFile : (p) => fs.readFileSync(p, 'utf-8')
  const authPath = codexCliAuthPath(env)
  let raw
  try {
    raw = JSON.parse(read(authPath))
  } catch (e) {
    const code = e?.code === 'ENOENT' ? 'not_found' : e instanceof SyntaxError ? 'parse_error' : 'read_error'
    return { path: authPath, exists: false, error: code, detail: String(e?.message || e).slice(0, 200) }
  }
  let data
  try {
    data = normalizeAuthJson(raw)
  } catch (e) {
    return { path: authPath, exists: true, error: 'unsupported', detail: String(e?.message || e).slice(0, 200) }
  }
  if (data.auth_mode !== 'api_key' && !data.tokens?.refresh_token) {
    return { path: authPath, exists: true, error: 'unsupported', detail: 'tokens 缺少 refresh_token，导入后无法续期' }
  }
  return {
    path: authPath,
    exists: true,
    error: null,
    authMode: data.auth_mode,
    email: emailFromIdToken(data.tokens?.id_token) || '',
    accountId: data.tokens?.account_id || '',
    hasRefresh: !!data.tokens?.refresh_token,
    lastRefresh: typeof raw.last_refresh === 'string' ? raw.last_refresh : ''
  }
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
const CLIENT_IDENTITY_FILE = path.join(DATA_ROOT, '.codex-client-identity')

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
//    - 每个账号独立存于 <数据根>/accounts/<id>.json（bridge 规范化形态）
//    - <数据根>/accounts.json 为注册表：{ activeId, accounts: [...] }
//    - bridge 始终只读“当前激活账号”的 auth 文件，切换即改指向并重启
// ===================================================================
const ACCOUNTS_DIR = path.join(DATA_ROOT, 'accounts')
const ACCOUNTS_REGISTRY = path.join(DATA_ROOT, 'accounts.json')

function genAccountId() {
  return 'acc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

// accounts.json 是全仓读得最频繁的文件：每个 /v1/* 请求、每次 bridgeLabel /
// primaryAccountId / accountLabel 都会走一遍 loadAccounts()。
// 这里缓存掉磁盘读取那一层（解析仍然每次重做，见 createCachedTextReader 的说明）。
const registryReader = createCachedTextReader(ACCOUNTS_REGISTRY)

export function loadAccounts() {
  const txt = registryReader.read()
  if (txt == null) return { activeId: null, accounts: [] }
  try {
    const j = JSON.parse(txt)
    if (j && Array.isArray(j.accounts)) return j
  } catch {}
  return { activeId: null, accounts: [] }
}

// registry 是整份覆盖写的 read-modify-write。返回 false 表示没写进去，
// 调用方据此决定是继续还是报错给用户。
export function saveAccounts(reg) {
  try {
    writeJsonAtomic(ACCOUNTS_REGISTRY, reg)
    registryReader.invalidate()
  } catch (e) {
    console.error('[codex-gateway] 写入账号注册表失败（改动未落盘）：' + (e && e.message || e))
    return false
  }
  return true
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
  // 这段 reconstructed 的关键在于「唯一的 await 放在 load→save 之前」。
  //
  // registry 是**整份覆盖**的 read-modify-write：loadAccounts() 拿到的是当时的快照，
  // saveAccounts() 把这份快照整体写回磁盘。如果这个区间里插进一个 await，
  // 中间这段时间别的请求完全可以跑完一次完整的 load→save（例如切换激活账号），
  // 然后被这里拿着过期快照的整份写回无声覆盖 —— activeId 直接回滚。
  // 可复现：先 POST /__gw/accounts（auth.json 较大、落盘慢），
  //        紧接 POST /__gw/accounts/activate，切到的账号会退回旧的。
  //
  // Node 是单线程的，所以只要这段里不含 await，就不存在穿插，
  // load 出来的必定是此刻磁盘上的最新内容。
  const prelim = loadAccounts()
  const prelimHit = findAccountByFingerprint(prelim, data)
  const prelimId = prelimHit ? prelimHit.id : genAccountId()
  await writeAuthFile(accountAuthPath(prelimId), data)

  // ---- 从这里往下是同步段 ----
  const reg = loadAccounts()
  const existing = findAccountByFingerprint(reg, data)
  if (existing) {
    const id = existing.id
    // await 期间若另一个抢先注册了同一指纹的账号，凭证文件要跟着搬过去，
    // 否则 accounts/ 里会留下一份没人认领的 auth 文件。
    if (prelimId !== id) {
      try { fs.renameSync(accountAuthPath(prelimId), accountAuthPath(id)) } catch {}
    }
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
    return { id, reg, path: accountAuthPath(id), isExisting: true }
  }

  reg.accounts.push({
    id: prelimId,
    name: name || defaultAccountName(provider, data),
    provider,
    mode,
    fingerprint: accountFingerprint(data),
    email: emailFromIdToken(data?.tokens?.id_token) || '',
    createdAt: new Date().toISOString()
  })
  reg.activeId = prelimId
  saveAccounts(reg)
  return { id: prelimId, reg, path: accountAuthPath(prelimId), isExisting: false }
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
  // 与 addAccount 同理：先做完唯一的 await，再进纯同步的 load→save 段。
  const prelimPath = accountAuthPath(id)
  await writeAuthFile(prelimPath, data)

  const reg = loadAccounts()
  const pending = reg.accounts.find((a) => a.id === id)
  if (!pending) throw new Error('待授权账号不存在：' + id)

  const existing = findAccountByFingerprint(reg, data)
  if (existing && existing.id !== id) {
    // 待授权卡片的身份与已有账号重复：删除卡片，把 token 更新到已有账号
    const filePath = accountAuthPath(existing.id)
    try { fs.renameSync(prelimPath, filePath) } catch {}
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

  // auth 文件在上面那段已经写好了（prelimPath 就是 accountAuthPath(id)），
  // 这里不再 await —— 同步段要保持完整，否则又会丢别人的改动。
  const filePath = accountAuthPath(id)
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
