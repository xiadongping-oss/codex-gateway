// Codex Gateway · API Key 管理
//
// 为 WorkBuddy 等第三方 OpenAI 兼容客户端提供「网关层 API Key」：
//   - 创建一个 cgw- 开头的随机串，仅创建时返回明文
//   - 服务端只存 SHA-256 哈希 + 元数据（name/account/createdAt/lastUsed/disabled）
//   - Authorization: Bearer <cgw-...> 时反代路由会用 key 绑定的账号替换当前激活账号
//   - 不绑定账号也可（默认跟随当前 activeId），适合「这个 key 就用默认那个账号」
//
// 安全要点：
//   - 哈希用 SHA-256（key 仅在本机 127.0.0.1 流转，碰撞风险可接受；用 argon2 会引入原生依赖）
//   - 文件 0o600，仅本机用户可读
//   - 删除立即生效，不留 archive
//
// 【密钥保管】明文只存在于两处：
//   1. 创建时的响应体（一次性）
//   2. 加密后的本地副本（供「接入配置」页复制给用户）
// 加密密钥由本机确定性派生（PBKDF2 + 机器指纹 + 固定盐），使 key 文件即便被拷走，
// 在别的机器/用户下也无法解出明文。局域网开启时这条尤其重要——api-keys.json
// 会被多台机器上的客户端间接接触到。
// 校验仍走 hash 比对（hash 明文存盘，比对无需解密，且不引入解密失败态）。

import fs from 'node:fs'
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const KEY_PREFIX = 'cgw'
const KEYS_FILE = path.join(__dirname, 'api-keys.json')

// ---------- 本机密钥派生 ----------
// 机器指纹：用户名 + 主机名 + 家目录路径（同机稳定，异机不同）
// 叠加固定盐，避免彩虹表；PBKDF2 迭代 100k 在本机开销可忽略
const CIPHER_SALT = 'cgw-apikey-store-v1'
function deriveKey() {
  const fp = [os.userInfo().username, os.hostname(), os.homedir()].join('|')
  return crypto.pbkdf2Sync(fp, CIPHER_SALT, 100000, 32, 'sha256')
}
const CIPHER_KEY = deriveKey()

function encryptToken(plain) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', CIPHER_KEY, iv)
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return 'v1:' + iv.toString('base64') + ':' + tag.toString('base64') + ':' + enc.toString('base64')
}

function decryptToken(stored) {
  if (!stored || typeof stored !== 'string') return null
  if (!stored.startsWith('v1:')) return null
  try {
    const [, ivB64, tagB64, dataB64] = stored.split(':')
    const decipher = crypto.createDecipheriv('aes-256-gcm', CIPHER_KEY, Buffer.from(ivB64, 'base64'))
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}

function loadReg() {
  try {
    const j = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf-8'))
    if (j && Array.isArray(j.keys)) return j
  } catch {}
  return { keys: [] }
}

// 旧版迁移：把历史明文 token 字段转成加密存储
// 触发时机：读到旧记录时顺手迁移一次（幂等，迁完即删明文字段）
function migratePlaintextTokens(r) {
  let changed = false
  for (const k of r.keys || []) {
    if (!k.token) continue
    if (!k.enc) {
      try {
        k.enc = encryptToken(k.token)
        changed = true
      } catch {}
    }
    delete k.token // 明文不再落盘
    changed = true
  }
  return changed
}

// ---------- 内存缓存 + 合并写盘 ----------
// 原实现每次 verifyApiKey / addKeyUsage 都全量读文件 + 全量写回：
//   - 高频调用时是明显的同步磁盘 IO 瓶颈
//   - 并发请求各自持有旧快照 → 后写覆盖先写，统计数据随机丢失
// 现在：内存持有注册表，写入走防抖合并（debounce），落盘用 tmp+rename 原子替换。
let regCache = null
let writeTimer = null
let writing = false
let writeAgain = false

function reg() {
  if (!regCache) {
    regCache = loadReg()
    // 首次加载时迁移旧版明文 token
    if (migratePlaintextTokens(regCache)) scheduleWrite()
  }
  return regCache
}

function scheduleWrite() {
  if (writeTimer) return
  writeTimer = setTimeout(async () => {
    writeTimer = null
    if (writing) { writeAgain = true; return }
    writing = true
    try {
      const data = JSON.stringify(regCache, null, 2)
      const tmp = KEYS_FILE + '.tmp'
      fs.mkdirSync(path.dirname(KEYS_FILE), { recursive: true })
      fs.writeFileSync(tmp, data, { encoding: 'utf-8', mode: 0o600 })
      fs.renameSync(tmp, KEYS_FILE)
    } catch {}
    writing = false
    if (writeAgain) { writeAgain = false; scheduleWrite() }
  }, 250)
  if (writeTimer.unref) writeTimer.unref()
}

function saveReg(regObj) {
  regCache = regObj
  scheduleWrite()
  return regObj
}

function sha256(input) {
  return crypto.createHash('sha256').update(String(input)).digest('hex')
}

// 生成符合 base62 长度、避免歧义字符的随机串
// 28 字符 ≈ 164 位熵，远超 uint128 碰撞阈值；token 合计前缀+随机共约 32 字符
function randomSecret(bytes = 22) {
  // 直接用 base64url（避免 + / =），base64url 字符集 [A-Za-z0-9-_]
  return crypto.randomBytes(bytes).toString('base64url')
}

// 内部 key id（用于登记表中索引、对外显示）
function genKeyId() {
  return 'k_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

// 生成对外展示的 token。形如：cgw-XXXXXX...
// 注意：token 本身带着可读前缀，但不包含可推断的信息（id 是随机）。
function issueToken() {
  return `${KEY_PREFIX}-${randomSecret(22)}`
}

// 解析 Authorization: Bearer xxx 形式的 token，仅接受 cgw- 前缀
export function extractBearerToken(authHeader) {
  if (!authHeader) return null
  const m = String(authHeader).match(/^Bearer\s+(.+)$/i)
  if (!m) return null
  const t = m[1].trim()
  if (!t.startsWith(KEY_PREFIX + '-')) return null
  return t
}

// 账号作用域归一化：
//   - null / [] / ['*']  都表示「全部账号」（跟随当前激活账号）
//   - ['acc_xxx', ...]    表示「指定账号」
function normalizeAccountIds(accountIds, accountId) {
  if (Array.isArray(accountIds) && accountIds.length > 0) {
    if (accountIds.includes('*') || accountIds.includes('all')) return null
    return accountIds.filter(Boolean)
  }
  if (accountId) return [accountId]
  return null
}

function isAllAccounts(accountIds) {
  return !accountIds || accountIds.length === 0 || accountIds.includes('*')
}

// mask：保留首尾各 4 字符，中段省略号，如 cgw-XXXX…XXX
function mask(token) {
  if (!token) return ''
  return token.slice(0, 8) + '…' + token.slice(-4)
}

export function listApiKeys({ includeRaw = false } = {}) {
  const r = reg()
  return r.keys
    .slice()
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    .map((k) => {
      const ids = normalizeAccountIds(k.accountIds, k.accountId)
      return {
        id: k.id,
        name: k.name,
        accountIds: isAllAccounts(ids) ? null : ids,
        accountId: isAllAccounts(ids) ? null : (ids[0] || null), // 兼容旧消费方
        createdAt: k.createdAt,
        lastUsedAt: k.lastUsedAt || null,
        lastUsedFrom: k.lastUsedFrom || null,
        callCount: k.callCount || 0,
        promptTokens: k.promptTokens || 0,
        completionTokens: k.completionTokens || 0,
        tokens: (k.promptTokens || 0) + (k.completionTokens || 0),
        disabled: !!k.disabled,
        // 明文按需解密：默认**不返回**。
        // 列表接口会被前端每 3 秒轮询一次，若每次都带明文，
        // 等于把跨机凭据持续摊在 DOM 与网络面板里（局域网模式下更危险）。
        // 需要复制时前端显式调 revealApiKey(id) 单条取。
        token: includeRaw ? (decryptToken(k.enc) || k.token || null) : null,
        prefix: k.prefix,
        mask: k.mask
      }
    })
}

// 按需解密单个 key 的明文。
// 仅供本机控制面在用户**明确点击「复制」**时调用一次；不进入任何轮询路径。
export function revealApiKey(id) {
  const r = reg()
  const k = r.keys.find((x) => x.id === id)
  if (!k) return { ok: false, msg: 'key 不存在' }
  const token = decryptToken(k.enc) || k.token || null
  if (!token) {
    return { ok: false, msg: '无法解密该 Key（可能由其它机器创建，或存储文件已损坏）' }
  }
  return { ok: true, id: k.id, name: k.name, token, mask: k.mask }
}

// 创建 key。返回 { id, name, token, mask, accountIds, ... }，token 仅此一次可读。
export function createApiKey({ name, accountId = null, accountIds = null } = {}) {
  const cleanName = String(name || '').trim().slice(0, 40) || '未命名'
  const ids = normalizeAccountIds(accountIds, accountId)
  const token = issueToken()
  const id = genKeyId()
  const now = new Date().toISOString()
  const r = reg()
  const entry = {
    id,
    name: cleanName,
    accountIds: isAllAccounts(ids) ? null : ids,
    accountId: null, // 旧字段，已废弃，保留兼容
    hash: sha256(token),
    enc: encryptToken(token), // 加密存储：仅本机可解，供「接入配置」复制
    prefix: token.slice(0, 8),
    mask: mask(token),
    createdAt: now,
    lastUsedAt: null,
    lastUsedFrom: null,
    callCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    disabled: false
  }
  r.keys.push(entry)
  saveReg(r)
  return {
    id: entry.id,
    name: entry.name,
    accountIds: entry.accountIds,
    accountId: entry.accountIds && entry.accountIds[0] ? entry.accountIds[0] : null,
    token,        // 明文仅这一次
    prefix: entry.prefix,
    mask: entry.mask,
    createdAt: entry.createdAt
  }
}

export function deleteApiKey(id) {
  const r = reg()
  const idx = r.keys.findIndex((k) => k.id === id)
  if (idx === -1) return { ok: false, msg: 'key 不存在' }
  r.keys.splice(idx, 1)
  saveReg(r)
  return { ok: true }
}

export function disableApiKey(id, disabled = true) {
  const r = reg()
  const k = r.keys.find((x) => x.id === id)
  if (!k) return { ok: false, msg: 'key 不存在' }
  k.disabled = !!disabled
  saveReg(r)
  return { ok: true, disabled: !!disabled }
}

// 鉴权核心：传入原始 token，返回 { ok, accountIds, keyId, name }
//   - 命中：返回登记信息（含 accountIds 用于反代切账号）
//   - 失败：返回 { ok: false, reason }
// 命中时顺手写 lastUsed（内存更新 + 防抖刷盘，不阻塞主请求）
export function verifyApiKey(token) {
  if (!token || !token.startsWith(KEY_PREFIX + '-')) return { ok: false, reason: 'bad_prefix' }
  const hash = sha256(token)
  const r = reg()
  const k = r.keys.find((x) => x.hash === hash)
  if (!k) return { ok: false, reason: 'not_found' }
  if (k.disabled) return { ok: false, reason: 'disabled' }
  // 命中后异步更新 lastUsed（不 await，失败也不影响请求）
  updateLastUsed(k.id)
  const ids = normalizeAccountIds(k.accountIds, k.accountId)
  return { ok: true, accountIds: ids, keyId: k.id, name: k.name }
}

// 根据 key 的作用域与当前激活账号，决定实际要把 bridge 切到哪个账号。
//   - 全部账号：返回 null（跟随当前激活，不切）
//   - 指定账号且当前激活在列表内：返回当前激活（不切）
//   - 指定账号且当前激活不在列表内：返回列表第一个（需要切）
export function resolveKeyAccountId(accountIds, activeId) {
  if (isAllAccounts(accountIds)) return null
  if (accountIds.includes(activeId)) return activeId
  return accountIds[0] || null
}

// 命中后更新 lastUsed / callCount。
// 直接改内存缓存对象并触发防抖写盘——原实现每次都重新读文件，
// 并发请求会各持一份旧快照，后写覆盖先写，callCount 随机丢失。
function updateLastUsed(id) {
  try {
    const k = reg().keys.find((x) => x.id === id)
    if (!k) return
    k.lastUsedAt = new Date().toISOString()
    k.callCount = (k.callCount || 0) + 1
    scheduleWrite()
  } catch {}
}

// 按 Key 累计 token 用量（从代理转发的上游响应里解析 usage 后调用）。
// 与 updateLastUsed 一样内存更新 + 防抖刷盘、失败不影响主请求。
export function addKeyUsage(keyId, promptTokens = 0, completionTokens = 0) {
  try {
    const k = reg().keys.find((x) => x.id === keyId)
    if (!k) return
    k.promptTokens = (k.promptTokens || 0) + (Number(promptTokens) || 0)
    k.completionTokens = (k.completionTokens || 0) + (Number(completionTokens) || 0)
    scheduleWrite()
  } catch {}
}

// 进程退出前把待写数据落盘（防抖窗口内可能被回收）
export function flushApiKeys() {
  if (writeTimer) {
    clearTimeout(writeTimer)
    writeTimer = null
  }
  try {
    const data = JSON.stringify(regCache, null, 2)
    const tmp = KEYS_FILE + '.tmp'
    fs.mkdirSync(path.dirname(KEYS_FILE), { recursive: true })
    fs.writeFileSync(tmp, data, { encoding: 'utf-8', mode: 0o600 })
    fs.renameSync(tmp, KEYS_FILE)
  } catch {}
}

for (const sig of ['exit', 'SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    try { flushApiKeys() } catch {}
    if (sig !== 'exit') process.exit(0)
  })
}
