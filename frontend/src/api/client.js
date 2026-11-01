// 请求封装层（对齐 chatgpt-bridge 真实形态 + 启动器控制接口）
//
// chatgpt-bridge 是 OpenAI 兼容的本地薄代理：
//   - 无 {code,message,data} 包装，直接返回 OpenAI 原始形状
//   - apiKey 被忽略（鉴权来自 ~/.codex/auth.json）
//   - 无 Postgres / Redis，无账号池，无管理员 Token
//
// 两种运行形态：
//   A) 经本地启动器（gateway/launcher.mjs）托管：BASE 留空，所有请求走同源相对路径，
//      启动器负责拉起 bridge、反向代理 /v1、并暴露 /__gw/* 控制接口。
//   B) 直连 bridge：VITE_API_BASE=http://127.0.0.1:10531，前端单独 dev 时手动起 bridge。

// 留空 = 同源相对路径（经启动器）。设了绝对地址则直连该地址。
export const BASE = import.meta.env?.VITE_API_BASE || ''
export const MOCK = false // mock 数据已下线；fetch 失败抛错，由上层渲染空态

// 启动器默认端口。经启动器托管时对外地址 = 页面自身 origin（4173），
// 而不是 bridge 内部端口 10531——外部客户端根本连不到 10531。
export const LAUNCHER_PORT = 4173

// 从 BASE 推断 host / port（用于状态卡展示）
export function parseBase() {
  if (!BASE) {
    // 同源相对路径：说明页面由启动器（或 dev server）直接提供，
    // 用 location 的真实端口，避免把 bridge 内部端口当成对外端口。
    if (typeof window !== 'undefined' && window.location && window.location.hostname) {
      return {
        host: window.location.hostname,
        port: Number(window.location.port) || LAUNCHER_PORT
      }
    }
    return { host: '127.0.0.1', port: LAUNCHER_PORT }
  }
  try {
    const u = new URL(BASE)
    return { host: u.hostname, port: Number(u.port) || 10531 }
  } catch {
    return { host: '127.0.0.1', port: LAUNCHER_PORT }
  }
}

// 对外可用的「主机:端口」文本（局域网场景下替换 host 即为局域网地址）
export function endpointText(host = parseBase().host, port = parseBase().port) {
  return `${host}:${port}`
}

// 默认请求超时：控制面接口应当是毫秒级返回，30s 足够宽松，
// 又能避免「网关假死 → 前端无限 pending → 按钮永远转圈」。
const DEFAULT_TIMEOUT_MS = 30000

function safeDetail(value) {
  if (typeof value !== 'string') return ''
  return value.replace(/[\u0000-\u001f]/g, ' ').replace(/Bearer\s+\S+/gi, 'Bearer [已隐藏]').replace(/\b(?:sk-|cgw-|eyJ)[A-Za-z0-9_.-]{12,}/g, '[已隐藏]').slice(0, 400)
}
function gatewayError(message, status, code, detail = '') {
  return Object.assign(new Error(message), { status, code, detail })
}

// bridge 端点（/v1, /health）。失败抛错，由上层显示空态/重试。
export async function request(path, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const url = BASE ? BASE + path : path
  const res = await fetch(url, { method: 'GET', signal: timeoutSignal(timeoutMs) })
  if (!res.ok) throw new Error('bridge HTTP ' + res.status + ' ' + path)
  return await res.json().catch(() => null)
}

// 启动器控制接口（/__gw/*），始终同源相对路径。
//
// fallback（第 4 个形参）：请求失败时返回的兜底值。
//   - 传函数 → 调用它取得兜底值
//   - 传值   → 直接返回该值
//   - 不传   → 抛错（保持原有语义）
// 之前该形参缺失，调用方传了 fallback 却被静默忽略，
// 导致「保存代理」失败时按钮永久卡在「应用中…」。
export async function gwRequest(path, method = 'GET', body = null, fallback = undefined, { timeoutMs = DEFAULT_TIMEOUT_MS, strictJson = false } = {}) {
  const useFallback = fallback !== undefined && fallback !== null
  const fb = () => (typeof fallback === 'function' ? fallback() : fallback)
  let res
  try {
    res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : null,
      signal: timeoutSignal(timeoutMs)
    })
  } catch (e) {
    if (useFallback) return fb()
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError'
    throw gatewayError(timedOut ? '请求超时，请检查网关后重试。' : '无法连接本机网关，请检查服务后重试。', 0, timedOut ? 'timeout' : 'network_error')
  }
  if (!res.ok) {
    if (useFallback) return fb()
    const data = await res.json().catch(() => null)
    const detail = safeDetail(data?.detail || data?.error?.message || data?.message)
    const rawCode = data?.code || (typeof data?.error === 'string' ? data.error : data?.error?.code)
    const code = typeof rawCode === 'string' && /^[\w-]{1,80}$/.test(rawCode) ? rawCode : 'http_error'
    const label = res.status === 401 ? '控制台登录已失效，请重新打开控制台。' : res.status === 403 ? '当前操作没有权限，请检查控制台访问权限。' : '请求失败（HTTP ' + res.status + '）'
    throw gatewayError(detail ? label + ' ' + detail : label, res.status, code, detail)
  }
  try { return await res.json() } catch {
    if (!strictJson) return {}
    if (useFallback) return fb()
    throw gatewayError('网关返回了无法读取的响应，请重试。', res.status, 'invalid_json')
  }
}

// 超时控制器：Node/浏览器都支持 AbortSignal.timeout，优先用它。
// 导出是因为 gateway.js 里几个需要自定义语义的接口（上传、导入、连接测试）
// 直接用了 fetch，它们同样不能没有超时。
export function timeoutSignal(ms) {
  if (!ms) return undefined
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms)
  }
  const ac = new AbortController()
  setTimeout(() => ac.abort(), ms)
  return ac.signal
}

// ---------- 剪贴板 ----------
// 统一封装：此前各页面直接 navigator.clipboard?.writeText(...).then(...)，
// 在非安全上下文（http 局域网 IP 访问）或权限被拒时**静默失败**——
// 用户看到按钮没反应，既不知道失败也不知道原因。
// 这里统一抛出可读错误，由调用方决定如何提示。
export async function copyText(text) {
  const s = String(text ?? '')
  if (!s) throw new Error('没有可复制的内容')
  if (typeof navigator === 'undefined' || !navigator.clipboard || !navigator.clipboard.writeText) {
    throw new Error('当前环境不支持剪贴板写入（需 HTTPS 或 localhost）')
  }
  try {
    await navigator.clipboard.writeText(s)
    return true
  } catch (e) {
    const msg = String((e && e.message) || e)
    if (/denied|not allowed|permission/i.test(msg)) {
      throw new Error('剪贴板权限被拒绝，请手动选中复制')
    }
    throw new Error('复制失败：' + msg.slice(0, 120))
  }
}
