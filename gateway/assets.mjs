// 素材源适配层（Asset Sources Adapter Layer）
// 统一管理多来源图片素材：生成图库（bridge image_generation 落盘）/ 本地目录 /
// S3 兼容对象存储（R2 / OSS / COS / MinIO）/ Lsky Pro / SM.MS
// 由 gateway/launcher.mjs 挂载到 /__gw/assets/*，逻辑只此一份。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { writeJsonAtomic } from './atomic-write.mjs'

const MOD_DIR = path.dirname(fileURLToPath(import.meta.url))
const STORE_PATH = process.env.ASSETS_STORE_PATH || path.join(MOD_DIR, 'data', 'asset-sources.json')

const genImagesDir = () => path.join(os.homedir(), '.chatgpt-bridge', 'gen-images')
const GEN_IMAGE_RE = /^[A-Za-z0-9_-]+\.png$/

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'])
const CT_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml'
}
const SOURCE_TYPES = ['local', 's3', 'lsky', 'smms']
// 单段文件名：拒绝路径分隔符 / 盘符 / ..；允许中文、空格、常用括号
const NAME_RE = /^[^\\/:*?"<>|\0]+$/
const UPLOADS_CAP = 200

// ---------- 存储（sources + uploads 注册表） ----------
let storeCache = null
function store() {
  if (storeCache) return storeCache
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'))
    storeCache = { sources: Array.isArray(parsed.sources) ? parsed.sources : [], uploads: parsed.uploads && typeof parsed.uploads === 'object' ? parsed.uploads : {} }
  } catch {
    storeCache = { sources: [], uploads: {} }
  }
  return storeCache
}
function persist() {
  // 走统一的原子写：旧实现用的是固定 tmp 名（STORE_PATH + '.tmp'），
  // 两次并发写会互相覆盖同一个临时文件，rename 出来的可能是别人那半截内容。
  // 这里换成「tmp 名带 pid + 随机串」的实现，权限也一并收紧（文件里有云存储凭据）。
  try {
    writeJsonAtomic(STORE_PATH, store())
  } catch (e) {
    console.error('[codex-gateway] 写入素材源注册表失败：' + (e && e.message || e))
    throw e
  }
}

// ---------- 素材源 CRUD ----------
export function listSources() {
  return store().sources
}

// ---------- 外发 URL 安全校验（防 SSRF / 凭据外发） ----------
// 素材源的 endpoint / api 是「低信任输入」：它们决定 AccessKey/SecretKey/Token 发往哪台主机。
// 若不校验，诱导用户填一个恶意 endpoint 就等于把云存储密钥主动送出去。
// 这里拒绝内网 / 回环 / 链路本地 / 元数据地址，并禁止跟随重定向（302 到内网同样危险）。
const BLOCKED_HOST_PATTERNS = [
  /^127\./,                    // 回环
  /^10\./,                     // 私网 A
  /^192\.168\./,               // 私网 C
  /^172\.(1[6-9]|2\d|3[01])\./, // 私网 B
  /^169\.254\./,               // 链路本地（含云元数据 169.254.169.254）
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT
  /^0\./,                      // 本机
  /^\[?::1\]?$/,               // IPv6 回环
  /^fc|^fd/,                   // IPv6 唯一本地地址
  /^fe80/,                     // IPv6 链路本地
  /\.local$/i,                 // mDNS
  /\.internal$/i,
  /^localhost$/i,
  /^::$/                       // IPv6 未指定地址（等价于 0.0.0.0）
]

// IPv4-mapped / IPv4-compatible 的 IPv6 写法会让上面这套黑名单整体失效：
// `::ffff:169.254.169.254` 既不以 "169.254." 开头，也不落在任何 IPv6 段规则里，
// 实测是放行的 —— 而请求发出去之后，目标仍然是云元数据服务。
// 所以判黑名单之前先把这两种写法还原成点分十进制。
function normalizeHostname(h) {
  const s = String(h || '').toLowerCase().replace(/^\[|\]$/g, '')
  // ::ffff:169.254.169.254（点分尾部）
  let m = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s)
  if (m) return m[1]
  // ::ffff:a9fe:a9fe（两段十六进制，同样等于 ::ffff:169.254.169.254）
  m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(s)
  if (m) {
    const hi = parseInt(m[1], 16)
    const lo = parseInt(m[2], 16)
    return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`
  }
  return s
}

function isBlockedHost(hostname) {
  // 先归一化再判定：HOST_PATTERNS 的规则都是按「点分十进制 / 常规写法」写的
  const h = normalizeHostname(String(hostname || '').toLowerCase().replace(/^\[|\]$/g, ''))
  if (!h) return true
  // 下面两条实测下来在当前链路上是**不可达的**：assertOutboundUrl 用的是 WHATWG URL，
  // 它会先把 "0177.0.0.1" 规范成 "127.0.0.1"、"2130706433" 也规范成 "127.0.0.1"，
  // 早在进黑名单之前就变成了普通的点分十进制，由上面的 /^127\./ 拦下。
  // 之所以仍留着：它们是「将来换了 URL 解析器、或有人绕过 URL 直接拿字符串匹配」
  // 时的第二道防线，成本为零。别把它们当冗余删掉 —— 删掉之后这部分防护
  // 就只剩下「WHATWG URL 恰好帮我们兜住了」这一个不再被显式表达的前提。
  if (/^\d+$/.test(h) || /^0x[0-9a-f]+$/.test(h)) return true
  // 带前导零的点分地址（0177.0.0.1 这类写法可以绕开 "127." 前缀匹配）
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(h) && /(^|\.)0\d/.test(h)) return true
  return BLOCKED_HOST_PATTERNS.some((re) => re.test(h))
}

/**
 * 校验一个将要携带凭据发往外部的 URL。
 * @param {string} raw       用户填写的 endpoint / api
 * @param {string} label     字段名（用于报错提示）
 * @param {boolean} allowInternal 私有部署（如自建 MinIO 在 192.168.x.x）时放行内网地址
 */
export function assertOutboundUrl(raw, label = '地址', { allowInternal = false } = {}) {
  const s = String(raw || '').trim()
  if (!/^https?:\/\//i.test(s)) throw new Error(`${label} 需为 http(s) URL`)
  let u
  try { u = new URL(s) } catch { throw new Error(`${label} 格式不正确`) }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`${label} 仅支持 http:// 或 https://`)
  }
  if (!allowInternal && isBlockedHost(u.hostname)) {
    throw new Error(
      `${label} 指向内网/回环地址（${u.hostname}）已被拒绝。` +
      '若确实是自建服务，请勾选「允许内网地址」。'
    )
  }
  return u
}

// 携带凭据请求时统一使用：不跟随重定向，避免 302 把凭据带到别处
const OUTBOUND_FETCH_OPTS = { redirect: 'manual' }

// 入参校验（saveSource / testSource 共用）
function validateSourceInput(body = {}) {
  const type = body.type
  if (!SOURCE_TYPES.includes(type)) throw new Error('unknown type: ' + type)
  const name = String(body.name || '').trim().slice(0, 40) || { local: '本地素材', s3: 'S3 兼容存储', lsky: 'Lsky Pro', smms: 'SM.MS' }[type]
  const cfgIn = body.config || {}
  let config
  if (type === 'local') {
    const dir = String(cfgIn.dir || '').trim()
    if (!dir) throw new Error('缺少目录路径')
    const st = fs.statSync(dir)
    if (!st.isDirectory()) throw new Error('不是目录：' + dir)
    config = { dir: path.resolve(dir) }
  } else if (type === 's3') {
    const endpoint = String(cfgIn.endpoint || '').trim().replace(/\/+$/, '')
    assertOutboundUrl(endpoint, 'S3 endpoint', { allowInternal: !!cfgIn.allowInternal })
    if (!cfgIn.bucket || !cfgIn.accessKey || !cfgIn.secretKey) throw new Error('S3 需要 bucket / accessKey / secretKey')
    config = {
      endpoint,
      bucket: String(cfgIn.bucket).trim(),
      region: String(cfgIn.region || 'us-east-1').trim() || 'us-east-1',
      accessKey: String(cfgIn.accessKey).trim(),
      secretKey: String(cfgIn.secretKey).trim(),
      prefix: String(cfgIn.prefix || '').trim(),
      publicBase: String(cfgIn.publicBase || '').trim().replace(/\/+$/, ''),
      pathStyle: cfgIn.pathStyle !== false,
      allowInternal: !!cfgIn.allowInternal
    }
  } else if (type === 'lsky') {
    const api = String(cfgIn.api || '').trim().replace(/\/+$/, '')
    assertOutboundUrl(api, 'Lsky API 地址', { allowInternal: !!cfgIn.allowInternal })
    if (!cfgIn.token) throw new Error('Lsky 需要授权 Token')
    config = { api, token: String(cfgIn.token).trim(), allowInternal: !!cfgIn.allowInternal }
  } else if (type === 'smms') {
    if (!cfgIn.token) throw new Error('SM.MS 需要 API Token')
    config = { token: String(cfgIn.token).trim() }
  }
  return { type, name, config }
}

export function saveSource(body = {}) {
  const { type, name, config } = validateSourceInput(body)

  const sources = store().sources
  let id = body.id
  if (id) {
    const idx = sources.findIndex((s) => s.id === id)
    if (idx === -1) throw new Error('素材源不存在：' + id)
    sources[idx] = { ...sources[idx], type, name, config }
  } else {
    id = 'as_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    sources.push({ id, type, name, config, createdAt: Date.now() })
  }
  persist()
  return sources.find((s) => s.id === id)
}

// ---------- 素材源连接测试（不落盘，凭据错误提前暴露） ----------
const PROBE_TIMEOUT = 12000
const EMPTY_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

async function probeS3(cfg) {
  const { origin, host, canonicalUri } = s3Urls(cfg, '')
  const query = { 'list-type': '2', 'max-keys': '1' }
  const { authorization, amzdate } = signS3Request({
    method: 'GET', canonicalUri, query, payloadHash: EMPTY_SHA,
    headers: { host }, accessKey: cfg.accessKey, secretKey: cfg.secretKey, region: cfg.region
  })
  const qs = Object.keys(query).map((k) => `${uriEncode(k)}=${uriEncode(query[k])}`).join('&')
  const res = await fetch(`${origin}${canonicalUri}?${qs}`, {
    method: 'GET',
    headers: { Host: host, Authorization: authorization, 'x-amz-content-sha256': EMPTY_SHA, 'x-amz-date': amzdate },
    signal: AbortSignal.timeout(PROBE_TIMEOUT),
    ...OUTBOUND_FETCH_OPTS // 不跟随重定向：避免 302 把凭据带到别处
  })
  if (res.ok) return { ok: true, message: '连接成功，bucket 可访问' }
  if (res.status === 403) return { ok: false, message: '密钥被拒（403）：检查 AccessKey / SecretKey' }
  if (res.status === 404) return { ok: false, message: 'bucket 不存在（404）：检查 Bucket 名与 path-style 设置' }
  if (res.status === 301) return { ok: false, message: '端点重定向（301）：检查 Endpoint / Region 是否匹配' }
  return { ok: false, message: `HTTP ${res.status}：${(await res.text().catch(() => '')).slice(0, 160)}` }
}

async function probeLsky(cfg) {
  const res = await fetch(cfg.api + '/api/v1/profile', {
    headers: { Authorization: 'Bearer ' + cfg.token },
    signal: AbortSignal.timeout(PROBE_TIMEOUT),
    ...OUTBOUND_FETCH_OPTS
  })
  const j = await res.json().catch(() => null)
  if (res.ok && j?.status && j?.data) return { ok: true, message: `连接成功：${j.data?.name || j.data?.email || '账号可用'}` }
  return { ok: false, message: `HTTP ${res.status}：${(j?.message || 'Token 无效或站点不可达').toString().slice(0, 160)}` }
}

async function probeSmms(cfg) {
  const res = await fetch('https://sm.ms/api/v2/profile', {
    headers: { Authorization: 'Bearer ' + cfg.token },
    signal: AbortSignal.timeout(PROBE_TIMEOUT)
  })
  const j = await res.json().catch(() => null)
  if (res.ok && j?.success) return { ok: true, message: `连接成功：${j.data?.email || '账号可用'}` }
  return { ok: false, message: `HTTP ${res.status}：${(j?.message || 'Token 无效').toString().slice(0, 160)}` }
}

export async function testSource(body = {}) {
  let type, config
  if (body.id) {
    const src = findSource(body.id)
    if (!src) throw new Error('素材源不存在：' + body.id)
    type = src.type
    config = src.config
  } else {
    ;({ type, config } = validateSourceInput(body))
  }
  if (type === 'local') {
    const files = listLocalDir(config.dir)
    return { ok: true, message: `目录可用，当前 ${files.length} 张图片` }
  }
  if (type === 's3') return probeS3(config)
  if (type === 'lsky') return probeLsky(config)
  if (type === 'smms') return probeSmms(config)
  throw new Error('unknown type: ' + type)
}

export function deleteSource(id) {
  const s = store()
  const before = s.sources.length
  s.sources = s.sources.filter((x) => x.id !== id)
  if (s.sources.length === before) return { ok: false }
  delete s.uploads[id]
  persist()
  return { ok: true }
}

function findSource(id) {
  return store().sources.find((s) => s.id === id) || null
}

// ---------- 列表 ----------
function listGenerated() {
  const dir = genImagesDir()
  let names = []
  try { names = fs.readdirSync(dir).filter((n) => GEN_IMAGE_RE.test(n)) } catch { return [] }
  const out = []
  for (const name of names) {
    try {
      const st = fs.statSync(path.join(dir, name))
      out.push({ name, size: st.size, mtime: st.mtimeMs, url: assetFileUrl('generated', name) })
    } catch {}
  }
  out.sort((a, b) => b.mtime - a.mtime)
  return out
}

export function listLocalDir(dir) {
  let names = []
  try {
    names = fs.readdirSync(dir).filter((n) => {
      if (!NAME_RE.test(n) || n.startsWith('.')) return false
      try {
        // 用 lstat 并排除符号链接：软链可能指向目录外的敏感文件
        const st = fs.lstatSync(path.join(dir, n))
        return !st.isSymbolicLink() && st.isFile() && IMAGE_EXTS.has(path.extname(n).toLowerCase())
      } catch { return false }
    })
  } catch { return [] }
  const out = []
  for (const name of names) {
    try {
      const st = fs.statSync(path.join(dir, name))
      out.push({ name, size: st.size, mtime: st.mtimeMs })
    } catch {}
  }
  out.sort((a, b) => b.mtime - a.mtime)
  return out
}

export function listAssets(sourceId) {
  if (!sourceId || sourceId === 'generated') return listGenerated()
  const src = findSource(sourceId)
  if (!src) throw new Error('素材源不存在：' + sourceId)
  if (src.type === 'local') {
    return listLocalDir(src.config.dir).map((x) => ({ ...x, url: assetFileUrl(sourceId, x.name) }))
  }
  // 云端源：返回上传记录（含外链）
  const recs = store().uploads[sourceId] || []
  return recs.map((u) => ({ ...u, remote: true }))
}

export function getUploads(sourceId) {
  return store().uploads[sourceId] || []
}

function recordUpload(sourceId, entry) {
  const s = store()
  const arr = s.uploads[sourceId] || (s.uploads[sourceId] = [])
  arr.unshift(entry)
  if (arr.length > UPLOADS_CAP) arr.length = UPLOADS_CAP
  persist()
}

// ---------- 文件解析与伺服（本地两类源） ----------
export function resolveFile(sourceId, name) {
  if (!name || typeof name !== 'string' || !NAME_RE.test(name) || name.includes('..') || name.startsWith('.')) return null
  let base = null
  let checkGen = false
  if (!sourceId || sourceId === 'generated') { base = genImagesDir(); checkGen = true }
  else {
    const src = findSource(sourceId)
    if (!src || src.type !== 'local') return null
    base = src.config.dir
  }
  if (checkGen && !GEN_IMAGE_RE.test(name)) return null
  let full = path.resolve(base, name)
  if (full !== base && !full.startsWith(base + path.sep)) return null
  // 扩展名白名单：与 listLocalDir 的列举逻辑保持一致。
  // 否则本地素材源目录里混入的 .env / *.sqlite / 私钥都能通过本端点下载。
  if (!IMAGE_EXTS.has(path.extname(full).toLowerCase())) return null
  try {
    const st = fs.lstatSync(full)
    // 拒绝符号链接：软链可指向目录外的敏感文件
    if (st.isSymbolicLink()) return null
    if (!st.isFile()) return null
const ct = CT_BY_EXT[path.extname(full).toLowerCase()] || 'application/octet-stream'
      return { full, size: st.size, contentType: ct, mtimeMs: st.mtimeMs }
  } catch { return null }
}

export function assetFileUrl(sourceId, name) {
  return '/__gw/assets/file?src=' + encodeURIComponent(sourceId || 'generated') + '&n=' + encodeURIComponent(name)
}

// ---------- 上传适配器 ----------
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest()
const sha256hex = (d) => crypto.createHash('sha256').update(d).digest('hex')

function amzDates(d = new Date()) {
  const iso = d.toISOString().replace(/[:-]|\.\d{3}/g, '')
  return { amzdate: iso, datestamp: iso.slice(0, 8) }
}

// S3 SigV4 通用签名（canonicalUri 已按段 URI 编码）
export function signS3Request({ method, canonicalUri, query = {}, headers = {}, payloadHash, accessKey, secretKey, region, service = 's3', now = new Date(), signPayloadHeader = true }) {
  const { amzdate, datestamp } = amzDates(now)
  const allHeaders = {
    ...(signPayloadHeader ? { 'x-amz-content-sha256': payloadHash } : {}),
    'x-amz-date': amzdate,
    ...headers
  }
  const signedNames = Object.keys(allHeaders).map((k) => k.toLowerCase()).sort()
  const lowered = {}
  for (const k of Object.keys(allHeaders)) lowered[k.toLowerCase()] = String(allHeaders[k]).trim()
  const canonicalHeaders = signedNames.map((k) => `${k}:${lowered[k]}\n`).join('')
  const signedHeaders = signedNames.join(';')

  const canonicalQuery = Object.keys(query).sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(query[k])}`)
    .join('&')

  const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n')
  const stringToSign = ['AWS4-HMAC-SHA256', amzdate, `${datestamp}/${region}/${service}/aws4_request`, sha256hex(canonicalRequest)].join('\n')
  const kSigning = hmac(hmac(hmac(hmac('AWS4' + secretKey, datestamp), region), service), 'aws4_request')
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex')

  return {
    amzdate,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${datestamp}/${region}/${service}/aws4_request,SignedHeaders=${signedHeaders},Signature=${signature}`,
    payloadHash
  }
}

// SigV4 的 URI 编码：大写十六进制、保留未保留字符、按需编码 '/'
export function uriEncode(str, encodeSlash = true) {
  let out = ''
  for (const ch of String(str)) {
    if (/[A-Za-z0-9\-._~]/.test(ch)) out += ch
    else if (ch === '/' && !encodeSlash) out += ch
    else out += [...Buffer.from(ch, 'utf-8')].map((b) => '%' + b.toString(16).toUpperCase().padStart(2, '0')).join('')
  }
  return out
}

function s3Key(cfg, name) {
  return (cfg.prefix ? cfg.prefix.replace(/^\/+|\/+$/g, '') + '/' : '') + name
}

function s3Urls(cfg, key) {
  const ep = new URL(cfg.endpoint)
  const pathStyle = cfg.pathStyle !== false
  const host = pathStyle ? ep.host : `${cfg.bucket}.${ep.host}`
  const encoded = key.split('/').map((s) => uriEncode(s)).join('/')
  const canonicalUri = pathStyle ? `/${cfg.bucket}/${encoded}` : `/${encoded}`
  return { origin: ep.origin, host, canonicalUri }
}

async function s3Put(cfg, name, buf, contentType) {
  const key = s3Key(cfg, name)
  const { origin, host, canonicalUri } = s3Urls(cfg, key)
  const payloadHash = sha256hex(buf)
  const { authorization, amzdate } = signS3Request({
    method: 'PUT', canonicalUri, payloadHash,
    headers: { host }, accessKey: cfg.accessKey, secretKey: cfg.secretKey, region: cfg.region
  })
  const res = await fetch(`${origin}${canonicalUri}`, {
    method: 'PUT',
    ...OUTBOUND_FETCH_OPTS,
    headers: {
      Host: host,
      Authorization: authorization,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzdate,
      'Content-Type': contentType,
      'Content-Length': String(buf.length)
    },
    body: Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
  })
  if (!res.ok) throw new Error(`S3 上传失败 HTTP ${res.status}：${(await res.text().catch(() => '')).slice(0, 200)}`)
  return publicUrlFor(cfg, key)
}

function publicUrlFor(cfg, key) {
  if (cfg.publicBase) return `${cfg.publicBase.replace(/\/+$/, '')}/${key.split('/').map((s) => uriEncode(s)).join('/')}`
  // 未配置公开域名：给 7 天有效的预签名 URL
  const { origin, host, canonicalUri } = s3Urls(cfg, key)
  const { amzdate } = amzDates()
  const query = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${cfg.accessKey}/${amzdate.slice(0, 8)}/${cfg.region}/s3/aws4_request`,
    'X-Amz-Date': amzdate,
    'X-Amz-Expires': '604800',
    'X-Amz-SignedHeaders': 'host'
  }
  const canonicalQuery = Object.keys(query).sort().map((k) => `${uriEncode(k)}=${uriEncode(query[k])}`).join('&')
  const canonicalRequest = ['GET', canonicalUri, canonicalQuery, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n')
  const stringToSign = ['AWS4-HMAC-SHA256', amzdate, `${amzdate.slice(0, 8)}/${cfg.region}/s3/aws4_request`, sha256hex(canonicalRequest)].join('\n')
  const kSigning = hmac(hmac(hmac(hmac('AWS4' + cfg.secretKey, amzdate.slice(0, 8)), cfg.region), 's3'), 'aws4_request')
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex')
  return `${origin}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`
}

async function lskyPut(cfg, name, buf, contentType) {
  const fd = new FormData()
  fd.append('file', new Blob([buf], { type: contentType }), name)
  const res = await fetch(cfg.api + '/api/v1/upload', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + cfg.token },
    body: fd,
    ...OUTBOUND_FETCH_OPTS
  })
  const j = await res.json().catch(() => null)
  const url = j?.data?.links?.url || j?.data?.url
  if (!res.ok || !url) throw new Error(`Lsky 上传失败 HTTP ${res.status}：${(j?.message || '').slice(0, 200)}`)
  return url
}

async function smmsPut(cfg, name, buf, contentType) {
  const fd = new FormData()
  fd.append('smfile', new Blob([buf], { type: contentType }), name)
  const res = await fetch('https://sm.ms/api/v2/upload', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + cfg.token },
    body: fd
  })
  const j = await res.json().catch(() => null)
  const url = j?.data?.url
  if (!url) throw new Error(`SM.MS 上传失败 HTTP ${res.status}：${(j?.message || j?.code || '').toString().slice(0, 200)}`)
  return url
}

export async function uploadToSource(sourceId, { name, buf, contentType }) {
  const src = findSource(sourceId)
  if (!src) throw new Error('素材源不存在：' + sourceId)
  if (!buf || !buf.length) throw new Error('空文件')
  let url
  if (src.type === 's3') url = await s3Put(src.config, name, buf, contentType)
  else if (src.type === 'lsky') url = await lskyPut(src.config, name, buf, contentType)
  else if (src.type === 'smms') url = await smmsPut(src.config, name, buf, contentType)
  else throw new Error('该素材源类型不支持上传：' + src.type)
  const entry = { name, url, size: buf.length, at: Date.now() }
  recordUpload(sourceId, entry)
  return entry
}

// ---------- 本地源导入（浏览器文件写入目录） ----------
const IMPORT_MAX = 30 * 1024 * 1024

export function importAsset(sourceId, name, buf) {
  const src = findSource(sourceId)
  if (!src || src.type !== 'local') throw new Error('仅本地目录素材源支持导入')
  if (!name || !NAME_RE.test(name) || name.startsWith('.')) throw new Error('文件名不合法：' + name)
  const ext = path.extname(name).toLowerCase()
  if (!IMAGE_EXTS.has(ext)) throw new Error('不支持的图片格式：' + ext)
  if (!buf || !buf.length) throw new Error('空文件')
  if (buf.length > IMPORT_MAX) throw new Error('文件超过 30MB 上限')

  fs.mkdirSync(src.config.dir, { recursive: true })
  // 重名自动加序号，绝不覆盖已有文件
  let finalName = name
  const stem = name.slice(0, -ext.length)
  let i = 1
  while (fs.existsSync(path.join(src.config.dir, finalName))) {
    finalName = `${stem}-${i++}${ext}`
  }
  fs.writeFileSync(path.join(src.config.dir, finalName), buf)
  const st = fs.statSync(path.join(src.config.dir, finalName))
  return { name: finalName, size: st.size, mtime: st.mtimeMs, url: assetFileUrl(sourceId, finalName) }
}

// 移除云端源的上传记录（不影响云端文件本身）
export function deleteUploadRecord(sourceId, name) {
  const s = store()
  const arr = s.uploads[sourceId]
  if (!arr) return { ok: false }
  const before = arr.length
  s.uploads[sourceId] = arr.filter((x) => x.name !== name)
  if (s.uploads[sourceId].length === before) return { ok: false }
  persist()
  return { ok: true }
}

// ---------- 批量删除 / 清空（生成图库 + 本地目录源；云端源不支持删文件） ----------
export function deleteAssets(sourceId, names, all = false) {
  if (!sourceId || sourceId === 'generated') {
    const dir = genImagesDir()
    let targets = []
    if (all) {
      try { targets = fs.readdirSync(dir).filter((n) => GEN_IMAGE_RE.test(n)) } catch { targets = [] }
    } else {
      targets = (Array.isArray(names) ? names : []).filter((n) => GEN_IMAGE_RE.test(n))
    }
    let deleted = 0
    for (const n of targets) { try { fs.unlinkSync(path.join(dir, n)); deleted++ } catch {} }
    return { ok: true, deleted }
  }
  const src = findSource(sourceId)
  if (!src || src.type !== 'local') throw new Error('该素材源不支持删除文件（云端源请移除记录）')
  const base = path.resolve(src.config.dir)
  const targets = all
    ? listLocalDir(base).map((x) => x.name)
    : (Array.isArray(names) ? names : []).filter((n) => NAME_RE.test(n) && !n.startsWith('.') && !n.includes('..'))
  let deleted = 0
  for (const n of targets) {
    const full = path.resolve(base, n)
    if (full === base || !full.startsWith(base + path.sep)) continue // 路径防逃逸
    try { fs.unlinkSync(full); deleted++ } catch {}
  }
  return { ok: true, deleted }
}

// ---------- 路由处理器（/__gw/assets*） ----------
function json(res, code, obj) {
  const buf = Buffer.from(JSON.stringify(obj))
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(buf)
}
const READ_BODY_MAX = 8 * 1024 * 1024
// 与 launcher.mjs 那份 readBody 同样的两个坑：无上限累积 + 不处理中途断连。
// 这里是控制面素材接口的入口，任一条 POST 都能被拿来耗内存；
// 而一旦客户端在传完前断开，promise 再也没人 settle，路由会永久挂起。
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const done = (err, value) => {
      if (settled) return
      settled = true
      err ? reject(err) : resolve(value)
    }
    req.on('data', (c) => {
      size += c.length
      if (size > READ_BODY_MAX) {
        req.destroy()
        return done(new Error('body_too_large'), null)
      }
      chunks.push(c)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text) return done(null, {})
      try { done(null, JSON.parse(text)) } catch (e) { done(e, null) }
    })
    req.on('error', (e) => done(e, null))
    req.on('aborted', () => done(new Error('request_aborted'), null))
  })
}

export async function handleAssets(req, res, p) {
  const q = new URL(req.url, 'http://127.0.0.1').searchParams

  // 素材源 CRUD
  if (p === '/__gw/assets/sources' && req.method === 'GET') {
    return json(res, 200, { sources: listSources() })
  }
  if (p === '/__gw/assets/sources' && req.method === 'POST') {
    try {
      const body = await readBody(req)
      const src = saveSource(body)
      return json(res, 200, { ok: true, source: src })
    } catch (e) {
      return json(res, 400, { error: 'bad_source', detail: e.message })
    }
  }
  // 连接测试（不落盘；传 id 则测已保存的源，否则按传入配置测）
  if (p === '/__gw/assets/sources/test' && req.method === 'POST') {
    try {
      const body = await readBody(req)
      return json(res, 200, await testSource(body))
    } catch (e) {
      return json(res, 400, { ok: false, error: 'test_failed', message: e.message })
    }
  }
  if (p === '/__gw/assets/sources' && req.method === 'DELETE') {
    try {
      const body = await readBody(req)
      return json(res, 200, deleteSource(body.id))
    } catch (e) {
      return json(res, 400, { error: 'delete_failed', detail: e.message })
    }
  }

  // 某来源的素材列表
  if (p === '/__gw/assets' && req.method === 'GET') {
    try {
      return json(res, 200, { images: listAssets(q.get('src') || 'generated') })
    } catch (e) {
      return json(res, 400, { error: 'bad_source', detail: e.message })
    }
  }

  // 本地文件伺服（generated / local 源）
  if (p === '/__gw/assets/file' && req.method === 'GET') {
    const f = resolveFile(q.get('src') || 'generated', q.get('n'))
    if (!f) return json(res, 404, { error: 'not_found' })
    try {
      // ETag + 条件请求：素材原图动辄数 MB，网格一屏就是几十张。
      // 此前固定 no-cache 且无 ETag，浏览器每次全量重下，轮询一开就是几百 MB。
      // 现在用「大小 + mtime」做强校验：内容没变返回 304，带宽几乎归零。
      const etag = `W/"${f.size.toString(16)}-${Math.floor(f.mtimeMs || 0).toString(16)}"`
      const inm = req.headers['if-none-match']
      if (inm && inm.split(',').some((t) => t.trim() === etag)) {
        res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' })
        return res.end()
      }
      const buf = fs.readFileSync(f.full)
      res.writeHead(200, {
        'Content-Type': f.contentType,
        'Content-Length': buf.length,
        'Cache-Control': 'no-cache',
        ETag: etag
      })
      return res.end(buf)
    } catch (e) {
      return json(res, 404, { error: 'not_found', detail: e.message })
    }
  }

  // 上传本地素材（generated / local 源中的文件）到云端源
  if (p === '/__gw/assets/upload' && req.method === 'POST') {
    try {
      const body = await readBody(req)
      const f = resolveFile(body.origin || 'generated', body.name)
      if (!f) return json(res, 400, { error: 'bad_file', detail: '源文件不存在或不可访问' })
      const buf = fs.readFileSync(f.full)
      const entry = await uploadToSource(body.sourceId, { name: body.name, buf, contentType: f.contentType })
      return json(res, 200, { ok: true, ...entry })
    } catch (e) {
      return json(res, 502, { error: 'upload_failed', detail: e.message })
    }
  }

  // 浏览器导入图片到本地源（原始二进制 + x-filename 头）
  if (p === '/__gw/assets/import' && req.method === 'POST') {
    try {
      const sourceId = q.get('src')
      const name = decodeURIComponent(req.headers['x-filename'] || '')
      const chunks = []
      let total = 0
      await new Promise((resolve, reject) => {
        req.on('data', (c) => {
          total += c.length
          if (total > IMPORT_MAX + 1024) { reject(new Error('文件超过 30MB 上限')); req.destroy(); return }
          chunks.push(c)
        })
        req.on('end', resolve)
        req.on('error', reject)
      })
      const entry = importAsset(sourceId, name, Buffer.concat(chunks))
      return json(res, 200, { ok: true, ...entry })
    } catch (e) {
      return json(res, 400, { error: 'import_failed', detail: e.message })
    }
  }

  // 移除云端源上传记录
  // 批量删除 / 清空（生成图库 + 本地目录源）
  if (p === '/__gw/assets/files' && req.method === 'DELETE') {
    try {
      const body = await readBody(req)
      return json(res, 200, deleteAssets(body.src, body.names, !!body.all))
    } catch (e) {
      return json(res, 400, { error: 'delete_failed', detail: e.message })
    }
  }
  if (p === '/__gw/assets/records' && req.method === 'DELETE') {
    try {
      const body = await readBody(req)
      return json(res, 200, deleteUploadRecord(body.sourceId, body.name))
    } catch (e) {
      return json(res, 400, { error: 'delete_failed', detail: e.message })
    }
  }

  return json(res, 404, { error: 'not_found', detail: p })
}
