// 网关 API 层（对齐 chatgpt-bridge + 进程内启动器 engine.js）
//
// chatgpt-bridge 暴露的 OpenAI 兼容端点：
//   GET  /health                 桥状态（auth, rate, version）
//   GET  /v1/models              模型列表（含图片别名）
//   POST /v1/responses           透传 ChatGPT Responses API（支持多模态视觉输入）
//   POST /v1/chat/completions    转 /v1/responses
//   POST /v1/images/generations  生成 base64 PNG（gpt-image-2）
//   /v1/*                        通配透传
//
// 本地启动器（gateway/launcher.mjs）额外暴露：
//   GET  /__gw/status     网关运行状态（进程 / 健康 / 配置 / 当前账号）
//   POST /__gw/start      启动 bridge
//   POST /__gw/stop       停止 bridge
//   POST /__gw/restart    重启 bridge
//   GET  /__gw/logs       bridge 实时日志（环形缓冲）
//   GET  /__gw/proxy      出网代理配置
//   POST /__gw/proxy      写入出网代理
//   POST /__gw/proxy/test 联通性测试
//   GET  /__gw/auth/state 当前授权状态（含当前激活账号）
//   POST /__gw/auth/device/start    设备流授权（开始）
//   POST /__gw/auth/device/poll     设备流轮询
//   POST /__gw/auth/browser/start   浏览器回调授权（开始）
//   POST /__gw/auth/browser/poll    浏览器回调轮询
//   POST /__gw/auth/browser/callback 手动提交回调地址
//   POST /__gw/auth/browser/cancel  取消浏览器回调授权
//   POST /__gw/auth/save    Token·JSON 保存（导入）
//   POST /__gw/auth/mode    切换 bridge / api key 模式
//   GET  /__gw/accounts                      多账号列表
//   POST /__gw/accounts                      Token·JSON 添加账号
//   POST /__gw/accounts/pending              添加 OAuth 待授权卡片
//   POST /__gw/accounts/activate  切换激活账号
//   POST /__gw/accounts/rename     重命名账号
//   DELETE /__gw/accounts     删除账号
//   GET  /__gw/apikeys                  API Key 列表（永不返回明文）
//   POST /__gw/apikeys                  创建 API Key（一次性返回明文 token）
//   DELETE /__gw/apikeys                按 id 删除 API Key

import { request, gwRequest, parseBase, BASE, timeoutSignal } from './client'
import { copyImageUrl } from './image-clipboard'
function authRequest(path, method = 'GET', body = null) {
  return gwRequest(path, method, body, undefined, { strictJson: true })
}

// 上传 / 导入要传整个文件的二进制，超时给得比控制面宽得多：
// 大图 + 慢网时 30 秒不够，但没有上限又会让按钮永久转圈。
const UPLOAD_TIMEOUT_MS = 120000

// ---------- 代理状态（归一化 /__gw/status） ----------
export async function getProxyStatus() {
  const s = await gwRequest('/__gw/status', 'GET').catch(() => null)
  return {
    running: !!s?.running,
    host: parseBase().host,
    port: parseBase().port,
    version: (s?.health?.version) || 'chatgpt-bridge',
    qps: 0,
    uptime: s && s.uptimeSec ? formatUptime(s.uptimeSec) : '00:00:00',
    metrics: s?.metrics || { requests: 0, rateLimited: 0 }
  }
}

// ---------- 当前激活账号（统一入口） ----------
// 优先 /__gw/auth/state（含真实账号 id/name/email/provider/loggedIn），
// 失败回退到 bridge /health 的 auth 检查。
export async function getAccount() {
  const s = await gwRequest('/__gw/auth/state', 'GET').catch(() => null)
  if (s && s.account) {
    return {
      loggedIn: !!s.account.loggedIn,
      accountId: s.account.accountId || null,
      name: s.account.name || '未命名账号',
      provider: s.account.provider || '—',
      method: providerLabel(s.account.provider),
      email: s.account.email || s.authFilePath || '—',
      expiresAt: s.account.expiresIn ? `剩余 ${formatDuration(s.account.expiresIn)}` : '—',
      detail: s.account.detail || ''
    }
  }
  // 回退：用 /health 推断登录态
  const h = await request('/health').catch(() => null)
  // bridge 0.3.0 返回 auth:{loaded,...}，无 checks[]
  const loaded = !!h?.auth?.loaded
  const expSec = typeof h?.auth?.expires_in_seconds === 'number' ? h.auth.expires_in_seconds : null
  return {
    loggedIn: loaded,
    accountId: null,
    name: 'Codex 登录态',
    provider: 'oauth',
    method: 'OAuth · Codex CLI',
    email: h?.auth?.source_path || '~/.codex/auth.json',
    expiresAt: expSec != null && expSec > 0 ? `令牌剩余 ${formatDuration(expSec)}` : '令牌已过期',
    detail: loaded ? '' : '凭据未加载'
  }
}

// ---------- 局域网接入（LAN） ----------
// 网关以 GW_LAN=1 启动时监听 0.0.0.0，局域网内其他主机可用
// 「接口地址 + cgw- API Key」接入。控制面 /__gw/* 仍仅限本机访问。
// 一台机器常同时挂着内网 / Tailscale / Docker 虚拟网卡，枚举顺序还各平台不同。
// 后端 lan-addr.mjs 已按「谁能连上」排好序并给第一个打了 preferred，
// 前端不该再拿 addresses[0] 硬猜——那正是把 100.x 发给局域网同事的原因。
export function primaryLanAddress(addresses) {
  const list = Array.isArray(addresses) ? addresses : []
  return list.find((a) => a.preferred) || list[0] || null
}

// 展示用类型标签。判定在后端，这里只管措辞。
export function lanKindLabel(addr) {
  if (!addr) return ''
  if (addr.kind === 'tailscale') return 'Tailscale'
  if (addr.kind === 'lan') return addr.virtual ? '内网·虚拟网卡' : '内网'
  return '其它'
}

export async function getLanInfo() {
  const s = await gwRequest('/__gw/status', 'GET').catch(() => null)
  const lan = s?.lan || {}
  return {
    enabled: !!lan.enabled,
    listenHost: lan.listenHost || '127.0.0.1',
    port: lan.port || 4173,
    addresses: Array.isArray(lan.addresses) ? lan.addresses : [],
    authRequired: !!lan.authRequired,
    controlPlaneLocalOnly: !!lan.controlPlaneLocalOnly
  }
}

// ---------- 模型列表 ----------
// chatgpt-bridge /v1/models 返回 OpenAI 标准形态：
//   { object: 'list', data: [{ id, object: 'model', created, owned_by }, ...] }
// 这里做 kind 推断：含 image / dall 的视为图片模型，其它按文本，
// 并通过名字看是否有视觉能力用于 UI。
export function classifyModel(id) {
  const i = String(id || '').toLowerCase()
  if (!i) return { kind: 'text', vision: false }
  const isImage = i.includes('image') || i.includes('dall-e') || i.includes('dalle')
  // GPT-4/5/6 全系支持图像输入；此前只认 gpt-4/o1/o3/o4，导致 5.x/6.x 被误判为无视觉
  // 去掉 -wm 后缀再判定，兼容上游「工作模型」形态（gpt-6.1-sol-wm 等）
  const base = i.replace(/-wm$/, '')
  const vision = !isImage && /^gpt-[4-6]|^o[134]|^codex|^sol|^astra|^luna|vision|gemini|claude/.test(base)
  return { kind: isImage ? 'image' : 'text', vision }
}
export async function getModels({ refresh = false } = {}) {
  // 走控制面 /__gw/models：与外部数据面 /v1/models 分流，UI 轮询不进调用日志
  // refresh=true 时绕过服务端 60s 缓存，强制回源（用户点「刷新」时用）
  const r = await gwRequest('/__gw/models' + (refresh ? '?refresh=1' : ''), 'GET').catch(() => null)
  const raw = (r && Array.isArray(r.data)) ? r.data : []
  const out = raw.map((m) => {
    const c = classifyModel(m.id)
    return {
      id: m.id,
      object: m.object,
      owned_by: m.owned_by,
      // 服务端目录字段（label / tier / core / desc）；缺失时回退本地推断
      kind: m.kind || c.kind,
      vision: typeof m.vision === 'boolean' ? m.vision : c.vision,
      label: m.label || m.id,
      tier: m.tier || '',
      desc: m.desc || '',
      core: !!m.core,
      catalog: !!m.catalog
    }
  })
  out.modelsOk = !!r && r.upstreamOk !== false
  out.upstreamError = (r && r.upstreamError) || null
  out.defaultModel = (r && r.defaultModel) || ''
  // 被网关精简掉的上游旧世代条目数（列表只留主力，见 model-catalog.mjs）
  out.hiddenCount = (r && Number(r.hiddenCount)) || 0
  out.hiddenUpstream = (r && Number(r.hiddenUpstream)) || 0
  return out
}

// ---------- 模型能力 ----------
// 从模型列表派生三项能力（纯函数，可就地复用，无需再发请求）
export function deriveCapabilities(list) {
  const ids = (list || []).map((x) => String(x.id || '').toLowerCase())
  return {
    text: ids.length > 0,
    image: ids.some((i) => i.includes('image') || i.includes('dall')),
    // 与 classifyModel 的 vision 判定保持一致（此前这里漏了 sol/astra/luna，
    // 导致 GPT-6 系列的视觉能力被误报为不支持）；同时兼容 -wm 后缀
    vision: ids.some((i) => {
      if (/image|dall/.test(i)) return false
      return /^gpt-[4-6]|^o[134]|^codex|^sol|^astra|^luna|vision|gemini|claude/.test(i.replace(/-wm$/, ''))
    })
  }
}
export async function getCapabilities() {
  const m = await getModels().catch(() => [])
  return deriveCapabilities(m)
}

// ---------- 网关生命周期 ----------
export async function getGatewayStatus() {
  return await gwRequest('/__gw/status', 'GET').catch(() => null)
}
export async function startGateway() { return await gwRequest('/__gw/start', 'POST').catch(() => null) }
export async function stopGateway() { return await gwRequest('/__gw/stop', 'POST').catch(() => null) }
export async function restartGateway() { return await gwRequest('/__gw/restart', 'POST').catch(() => null) }
export async function getGatewayLogs() {
  const result = await gwRequest('/__gw/logs', 'GET')
  if (!Array.isArray(result?.lines)) throw new Error('运行日志响应无效')
  return result
}

// ---------- 连接诊断 ----------
export async function diagnose() {
  return await request('/health').catch(() => null)
}

// 当前授权状态：mode / authFilePath / hasApiKey / account 摘要
// 来自 /__gw/auth.state（engine.js / launcher.mjs 都暴露）
export async function getAuthState() {
  return await gwRequest('/__gw/auth/state', 'GET').catch(() => null)
}

// ---------- 图片素材：素材源适配层（generated / local / s3 / lsky / smms） ----------
export async function getAssetSources() {
  const r = await gwRequest('/__gw/assets/sources', 'GET').catch(() => null)
  return (r && Array.isArray(r.sources)) ? r.sources : []
}
// 这几个接口此前是裸 fetch，一个超时都没有 —— 与 client.js 里
// 「避免网关假死 → 前端无限 pending → 按钮永远转圈」的设计目标直接冲突。
// 上传大图时网络卡死，uploading / importing 会永久为真，按钮再也不能点。
export async function saveAssetSource(body) {
  const res = await fetch('/__gw/assets/sources', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    signal: timeoutSignal(30000)
  })
  const j = await res.json().catch(() => ({}))
  if (!res.ok || !j.ok) throw new Error(j.detail || j.error || 'HTTP ' + res.status)
  return j
}
export async function deleteAssetSource(id) {
  // 其余素材接口都吞错返回 null，唯独这里会 reject：
  // 调用方没接 catch 就变成 unhandled rejection，界面「没反应」。
  return await gwRequest('/__gw/assets/sources', 'DELETE', { id }).catch(() => null)
}
// 连接测试（不落盘）：传 {type, config} 测表单值，或传 {id} 测已保存源
export async function testAssetSource(body) {
  const res = await fetch('/__gw/assets/sources/test', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    signal: timeoutSignal(30000)
  })
  const j = await res.json().catch(() => ({}))
  if (j.message === undefined) throw new Error(j.detail || j.error || 'HTTP ' + res.status)
  return j
}
export async function getAssets(src = 'generated') {
  const r = await gwRequest('/__gw/assets?src=' + encodeURIComponent(src), 'GET').catch(() => null)
  return (r && Array.isArray(r.images)) ? r.images : []
}
export const assetFileUrl = (src, name) =>
  BASE + '/__gw/assets/file?src=' + encodeURIComponent(src || 'generated') + '&n=' + encodeURIComponent(name)
export async function uploadAsset(sourceId, origin, name) {
  const res = await fetch('/__gw/assets/upload', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceId, origin, name }),
    signal: timeoutSignal(UPLOAD_TIMEOUT_MS)
  })
  const j = await res.json().catch(() => ({}))
  if (!res.ok || !j.ok) throw new Error(j.detail || j.error || 'HTTP ' + res.status)
  return j
}
// 导入本地文件到「本地目录」素材源（原始二进制 + 文件名头）
export async function importAsset(sourceId, file) {
  const res = await fetch('/__gw/assets/import?src=' + encodeURIComponent(sourceId), {
    method: 'POST',
    headers: { 'x-filename': encodeURIComponent(file.name), 'Content-Type': 'application/octet-stream' },
    body: file,
    signal: timeoutSignal(UPLOAD_TIMEOUT_MS)
  })
  const j = await res.json().catch(() => ({}))
  if (!res.ok || !j.ok) throw new Error(j.detail || j.error || 'HTTP ' + res.status)
  return j
}
export async function deleteUploadRecord(sourceId, name) {
  return await gwRequest('/__gw/assets/records', 'DELETE', { sourceId, name }).catch(() => null)
}

// 调用日志：网关反代层逐笔记录的真实 /v1 调用（环形缓冲 200 条）
export async function getLogs(_opts = {}) {
  const r = await gwRequest('/__gw/call-logs', 'GET')
  if (!Array.isArray(r?.logs)) throw new Error('调用日志响应无效')
  return r.logs
}

// ---------- 生成图片（bridge image_generation 落盘产物） ----------
export async function getGenImages() {
  const r = await gwRequest('/__gw/gen-images', 'GET').catch(() => null)
  return r && Array.isArray(r.images) ? r.images : []
}
export function genImageUrl(name) {
  return '/__gw/gen-images/' + encodeURIComponent(name)
}
// 批量删除 / 清空（生成图库 + 本地目录源；all=true 清空全部）
export async function deleteAssets(src, names, all = false) {
  return await gwRequest('/__gw/assets/files', 'DELETE', { src, names, all }).catch(() => null)
}
// 复制图片到系统剪贴板（blob → ClipboardItem；src 缺省 = 生成图库）
export function copyImageToClipboardImg(src, name) {
  return copyImageUrl(assetFileUrl(src, name))
}

// ---------- 授权：设备流 ----------
export async function startDeviceFlowApi() {
  return await authRequest('/__gw/auth/device/start', 'POST', {})
}
export async function pollDeviceFlowApi(payload = {}) {
  return await authRequest('/__gw/auth/device/poll', 'POST', payload)
}
export async function cancelDeviceFlowApi() {
  return await authRequest('/__gw/auth/device/cancel', 'POST', {})
}

// ---------- 授权：浏览器回调 ----------
export async function startBrowserLoginApi() {
  return await authRequest('/__gw/auth/browser/start', 'POST', {})
}
export async function pollBrowserLoginApi(payload = {}) {
  return await authRequest('/__gw/auth/browser/poll', 'POST', payload)
}
export async function submitBrowserCallbackApi(callbackUrl, payload = {}) {
  return await authRequest('/__gw/auth/browser/callback', 'POST', { ...payload, callbackUrl })
}
export async function cancelBrowserLoginApi() {
  return await authRequest('/__gw/auth/browser/cancel', 'POST', {})
}

// ---------- 授权：Token·JSON 保存 / 模式切换 ----------
export async function setAuthMode(mode, apiKey, baseUrl) {
  return await authRequest('/__gw/auth/mode', 'POST', { mode, apiKey, baseUrl })
}

// ---------- 官方客户端临时登录（6 步骤流程） ----------
export async function officialLoginStart() {
  return await authRequest('/__gw/codex-official-login/start', 'POST', {})
}
export async function officialLoginStatus(sessionId) {
  return await authRequest('/__gw/codex-official-login/status?sessionId=' + encodeURIComponent(sessionId || ''), 'GET')
}
export async function officialLoginFinish(sessionId, name) {
  return await authRequest('/__gw/codex-official-login/finish', 'POST', { sessionId, name })
}
export async function officialLoginCancel(sessionId) {
  return await authRequest('/__gw/codex-official-login/cancel', 'POST', { sessionId })
}

// ---------- Token / JSON 多格式文本导入 ----------
export async function importTokenText(text, name) {
  return await authRequest('/__gw/accounts/import-text', 'POST', { text, name })
}

// ---------- 已保存供应商（API Key 快选） ----------
export async function getProviders() {
  return await gwRequest('/__gw/providers', 'GET').catch(() => null)
}
export async function saveProvider(name, baseUrl) {
  return await gwRequest('/__gw/providers', 'POST', { name, baseUrl }).catch(() => null)
}
export async function deleteProvider(id) {
  return await gwRequest('/__gw/providers/delete', 'POST', { id }).catch(() => null)
}

// ---------- 多账号管理 ----------
export async function getAccounts() {
  return await gwRequest('/__gw/accounts', 'GET').catch(() => null)
}
export async function addAccount({ name, provider, json }) {
  return await authRequest('/__gw/accounts', 'POST', { name, provider, json })
}
export async function addPendingAccount({ name, email, note, provider }) {
  return await authRequest('/__gw/accounts/pending', 'POST', { name, email, note, provider })
}
export async function activateAccount(id) {
  return await gwRequest('/__gw/accounts/activate', 'POST', { id }).catch(() => null)
}
export async function removeAccount(id) {
  return await gwRequest('/__gw/accounts', 'DELETE', { id }).catch(() => null)
}
export async function renameAccount(id, { name, note } = {}) {
  return await gwRequest('/__gw/accounts/rename', 'POST', { id, name, note }).catch(() => null)
}

// ---------- 本机 Codex CLI 登录无感导入 ----------
// 探测 ~/.codex/auth.json（CODEX_HOME 可覆盖）；返回 { exists, error, email, ... }
export async function inspectCodexLocal() {
  return await authRequest('/__gw/codex-local', 'GET')
}
// 一键注册为本机网关账号并切激活；返回 { ok, accountId, email, isExisting }
export async function importCodexLocal() {
  return await authRequest('/__gw/codex-local/import', 'POST', {})
}

// ---------- API Key 管理 ----------
export async function listApiKeys() {
  const r = await gwRequest('/__gw/apikeys', 'GET').catch(() => null)
  return r && Array.isArray(r.keys) ? r.keys : []
}
export async function createApiKey({ name, accountIds } = {}) {
  const r = await gwRequest('/__gw/apikeys', 'POST', { name, accountIds }).catch(() => null)
  return r && r.key ? r.key : null  // 注意：r.key.token 仅此一次可见
}
export async function deleteApiKey(id) {
  return await gwRequest('/__gw/apikeys', 'DELETE', { id }).catch(() => null)
}
// 按需取单个 Key 的明文：仅在用户点「复制」时调用一次。
// 列表接口不再携带明文，避免每 3 秒轮询把凭据摊在 DOM / 网络面板里。
export async function revealApiKey(id) {
  const r = await gwRequest('/__gw/apikeys/reveal?id=' + encodeURIComponent(id), 'GET').catch(() => null)
  return r && r.ok ? r : null
}

// ---------- 账号额度（cockpit 同款：订阅 / 周用量 / 模型级用量） ----------
export async function getAccountQuota() {
  return await gwRequest('/__gw/account/quota', 'GET').catch(() => null)
}
export async function saveAccountQuota(patch = {}) {
  return await gwRequest('/__gw/account/quota', 'POST', patch).catch(() => null)
}
// 主动探测：让该账号的 bridge 发一次最小请求，把上游限流头拉回来。
// 会消耗极少量额度，只在用户点「刷新」时调用。
export async function probeAccountQuota() {
  return await gwRequest('/__gw/account/quota/probe', 'POST', {}).catch(() => null)
}

// ---------- 严格鉴权 ----------
export async function getStrictAuth() {
  const r = await gwRequest('/__gw/strict-auth', 'GET').catch(() => null)
  return !!r?.enabled
}
export async function setStrictAuth(enabled) {
  return await gwRequest('/__gw/strict-auth', 'POST', { enabled }).catch(() => null)
}

// 在浏览器打开外链：Electron 用 window.api.openExternal，Web 回退 window.open
export function openBrowser(url) {
  if (typeof window === 'undefined' || !url) return
  const w = window
  if (w.api && typeof w.api.openExternal === 'function') w.api.openExternal(url)
  else if (typeof w.open === 'function') w.open(url, '_blank')
}

// ---------- helpers ----------
function formatUptime(sec) {
  const h = String(Math.floor(sec / 3600)).padStart(2, '0')
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0')
  const s = String(sec % 60).padStart(2, '0')
  return `${h}:${m}:${s}`
}

function providerLabel(p) {
  return ({ oauth: 'OAuth', token: 'Token', import: '导入', apikey: 'API Key' }[p]) || 'OAuth · Codex CLI'
}

// 把 expires_in（秒）或绝对过期时间规整为"剩余 X"
function formatDuration(secondsOrIso) {
  if (!secondsOrIso) return ''
  const ms = typeof secondsOrIso === 'number'
    ? secondsOrIso * 1000
    : new Date(secondsOrIso).getTime() - Date.now()
  if (Number.isNaN(ms) || ms < 0) return '已过期'
  const s = Math.floor(ms / 1000)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  if (d > 0) return `${d}天${h}小时`
  const m = Math.floor((s % 3600) / 60)
  if (h > 0) return `${h}小时${m}分`
  return `${m}分钟`
}
