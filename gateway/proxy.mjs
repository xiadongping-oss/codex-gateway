// Codex Gateway · 出网代理
//
// 为什么需要这个模块：
//   Node 的 fetch（undici）默认**不读** HTTP_PROXY / HTTPS_PROXY 环境变量，
//   这与浏览器行为完全不同。实测（Node 22）：设了环境变量仍走裸出口拿 403，
//   必须显式 setGlobalDispatcher(new ProxyAgent(...)) 才生效。
//
// 设计要点：
//   1. 进程内 bridge 与引擎共用同一个 Node 进程，因此一次全局 dispatcher
//      就能同时覆盖两者，无需分别配置。
//   2. 本地回环地址强制直连 —— 否则 4173 控制台与 10531 bridge 健康检查
//      会被一起送进代理，导致网关自身不可用。
//   3. 代理不可用时自动降级为直连，不让网络问题拖垮整个网关。

import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let undici = null
let directAgent = null
let proxyAgent = null
let smartDispatcher = null
let currentProxy = ''
let lastError = ''
let available = false

// ---------- 本地回环判定 ----------
// 这些目标必须直连：控制台自身、bridge 健康检查、loopback OAuth 回调
function isLocalTarget(origin) {
  if (!origin) return false
  let host = ''
  if (typeof origin === 'string') host = origin
  else if (origin.hostname) host = origin.hostname
  else if (origin.host) host = origin.host
  else host = String(origin)
  host = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase()
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '0.0.0.0' ||
    host.endsWith('.localhost')
  )
}

// ---------- 加载 undici ----------
// 开发态与打包态路径一致：本文件始终与 node_modules/ 同级
async function loadUndici() {
  if (undici !== null) return undici
  try {
    undici = await import('./node_modules/undici/index.js')
    available = true
  } catch (e) {
    try {
      undici = await import('undici')
      available = true
    } catch {
      undici = false
      available = false
      lastError = 'undici 未安装，代理功能不可用（npm i undici）'
    }
  }
  return undici
}

// ---------- 校验与归一化代理地址 ----------
export function normalizeProxyUrl(input) {
  const raw = String(input || '').trim()
  if (!raw) return { ok: true, url: '' }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`
  let u
  try {
    u = new URL(withScheme)
  } catch {
    return { ok: false, error: '代理地址格式不正确，示例：http://127.0.0.1:7897' }
  }
  if (u.protocol === 'socks5:' || u.protocol === 'socks4:') {
    return {
      ok: false,
      error: '暂不支持 SOCKS，请填 HTTP 代理端口（Clash 的「混合端口」同时支持 HTTP 与 SOCKS）'
    }
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, error: '仅支持 http:// 或 https:// 代理' }
  }
  return { ok: true, url: u.origin }
}

// 关闭连接池：加超时保护，避免有挂起连接时永久阻塞
async function safeClose(agent) {
  if (!agent) return
  try {
    await Promise.race([agent.close(), new Promise((r) => setTimeout(r, 2000))])
  } catch {}
}

// ---------- 应用代理 ----------
// 传入空字符串表示关闭代理（恢复直连）
export async function applyProxy(proxyUrl) {
  const norm = normalizeProxyUrl(proxyUrl)
  if (!norm.ok) {
    lastError = norm.error
    return { ok: false, error: norm.error, url: currentProxy }
  }
  const next = norm.url

  // 未变化则跳过重建，避免频繁请求时反复创建连接池
  if (next === currentProxy && smartDispatcher) {
    return { ok: true, url: currentProxy, changed: false }
  }

  const mod = await loadUndici()
  if (!mod) {
    return { ok: false, error: lastError, url: '' }
  }

  // 新建的 agent（失败时要在 catch 里关掉，避免泄漏一个半初始化的连接池）
  let fresh = []
  try {
    // 「先建新 → 切全局 → 再关旧」，顺序不能反。
    // 旧写法是先 close 旧的、再 new 新的：一旦 new ProxyAgent（URI 非法）
    // 或 setGlobalDispatcher 抛错，smartDispatcher 会永久指向一个已 close 的
    // agent，此后所有出网 fetch 全部失败且无法自愈，只能重启网关。
    const direct = new mod.Agent({ connectTimeout: 15000 })
    const proxied = next ? new mod.ProxyAgent({ uri: next, connectTimeout: 15000 }) : direct
    fresh = proxied === direct ? [direct] : [direct, proxied]
    const enabled = !!next

    // 自定义 dispatcher：按目标主机二选一
    // undici 只要求实现 dispatch(opts, handler)，但 close/destroy 一并实现以防内部调用
    smartDispatcher = {
      dispatch(opts, handler) {
        try {
          const target = (!enabled || isLocalTarget(opts && opts.origin)) ? direct : proxied
          return target.dispatch(opts, handler)
        } catch (e) {
          // 兜底：任何判定异常都退回直连，优先保证网关自身可用
          return direct.dispatch(opts, handler)
        }
      },
      close: () => Promise.all([direct.close(), proxied === direct ? null : proxied.close()].filter(Boolean)),
      destroy: (err) => Promise.all([direct.destroy(err), proxied === direct ? null : proxied.destroy(err)].filter(Boolean))
    }

    mod.setGlobalDispatcher(smartDispatcher)

    // 到这里切换已经成功，才轮到回收旧的连接池。
    // 注意：未启用代理时旧 proxyAgent 与旧 directAgent 是同一个对象，必须去重，
    // 否则对同一 agent 二次 close() 会挂起（曾导致设置代理时接口无响应）。
    const prevDirect = directAgent
    const prevProxy = proxyAgent
    directAgent = direct
    proxyAgent = proxied
    currentProxy = next
    lastError = ''
    try {
      if (prevProxy && prevProxy !== prevDirect) await safeClose(prevProxy)
      await safeClose(prevDirect)
    } catch { /* 旧池关不掉不影响新池可用 */ }
    return { ok: true, url: next, changed: true }
  } catch (e) {
    // 构造/切换失败：旧池此刻仍完好（还没关），只回收这次新建出来的
    try { for (const a of fresh) await safeClose(a) } catch {}
    lastError = String((e && e.message) || e)
    return { ok: false, error: lastError, url: currentProxy }
  }
}

// ---------- 查询状态 ----------
export function getProxyInfo() {
  return { url: currentProxy, enabled: !!currentProxy, available, error: lastError || '' }
}

// ---------- 供 launcher 使用：拿到与全局 dispatcher 同源的 undici 实例 ----------
// 关键：必须与 applyProxy 用的是**同一个** undici 模块实例。
// Node 的全局 dispatcher 存在 globalThis[Symbol.for('undici.globalDispatcher.1')]，
// undici v6 的 getGlobalDispatcher() 读的就是这个全局符号，所以
// vendored undici 的 setGlobalDispatcher() 同样能作用到 Node 内建 fetch。
// 但若 launcher 另起一份 undici 实例，它自己的 request() 会走自己的默认 Agent，
// 代理就失效了——因此这里统一从 proxy.mjs 暴露实例。
export async function getUndici() {
  return await loadUndici()
}

// ---------- 连通性测试 ----------
// 直连 OpenAI 的设备授权端点：这是网关真正依赖的端点，测它最有说服力
export async function testProxy(proxyUrl, timeoutMs = 15000) {
  const target = 'https://auth.openai.com/api/accounts/deviceauth/usercode'
  const probe = String(proxyUrl === undefined ? currentProxy : proxyUrl).trim()

  // 用独立 Agent 探测，避免污染全局配置
  const mod = await loadUndici()
  if (!mod) return { ok: false, error: lastError || 'undici 不可用' }

  const norm = normalizeProxyUrl(probe)
  if (!norm.ok) return { ok: false, error: norm.error }

  let agent = null
  // 走代理分支时的 ProxyAgent 此前是内联 new 出来的，既没被 agent 持有也没被 close，
  // 于是每点一次「测试代理」就泄漏一个 undici 连接池（含 keep-alive 上的 socket）。
  let proxyAgent = null
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  const started = Date.now()
  try {
    agent = new mod.Agent({ connectTimeout: timeoutMs })
    if (norm.url) proxyAgent = new mod.ProxyAgent({ uri: norm.url, connectTimeout: timeoutMs })
    const res = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://auth.openai.com' },
      body: JSON.stringify({ client_id: 'app_EMoamEEZ73f0CkXaXp7hrann' }),
      signal: ac.signal,
      dispatcher: proxyAgent || agent
    })
    const ms = Date.now() - started
    if (res.ok) {
      return { ok: true, status: res.status, ms, via: norm.url || '直连' }
    }
    // 403 + unsupported_country_region_territory = 出口仍在不被支持的地区
    let detail = ''
    try {
      const j = await res.json()
      detail = (j && j.error && j.error.code) || ''
    } catch {}
    return {
      ok: false,
      status: res.status,
      ms,
      via: norm.url || '直连',
      error: detail === 'unsupported_country_region_territory'
        ? '出口 IP 所在地区不受支持，换一个代理节点试试'
        : `目标返回 ${res.status}${detail ? '（' + detail + '）' : ''}`
    }
  } catch (e) {
    const msg = String((e && e.message) || e)
    return {
      ok: false,
      ms: Date.now() - started,
      via: norm.url || '直连',
      error: /abort/i.test(msg) ? `连接超时（>${timeoutMs}ms）` : `无法连接：${msg.slice(0, 120)}`
    }
  } finally {
    clearTimeout(timer)
    if (agent) { try { await agent.close() } catch {} }
    if (proxyAgent) { try { await proxyAgent.close() } catch {} }
  }
}

// ---------- 系统代理检测（只读，不应用） ----------
// 装机后最常见的翻车：上游 403 unsupported_country_region_territory，
// 而机器上明明挂着 Clash。这里把「现成可用的代理地址」找出来给设置页一键填充：
//   1) 环境变量 HTTPS_PROXY / HTTP_PROXY / ALL_PROXY（大小写都看）
//   2) Windows 系统代理（注册表 Internet Settings，reg query 即可，不引 PowerShell）
// 只报告、不写配置 —— 代理是否可用由用户点「测试」确认。
function parseWinProxyServer(server) {
  // ProxyServer 取值形如 "127.0.0.1:7890" 或 "ftp=...;http=...;https=..."，
  // 浏览器语义里分协议条目优先于裸地址；这里优先 https，其次 http，最后裸地址。
  const pick = (re) => {
    const m = re.exec(server)
    return m ? m[1].trim() : ''
  }
  return (
    pick(/(?:^|;)https=([^;]+)/i) ||
    pick(/(?:^|;)http=([^;]+)/i) ||
    (server.includes('=') ? '' : server.trim())
  )
}

export async function detectSystemProxies({
  env = process.env,
  platform = process.platform,
  execFileImpl,
  regQueryArgs = ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings']
} = {}) {
  const candidates = []
  const push = (source, raw) => {
    const trimmed = String(raw || '').trim()
    if (!trimmed) return
    const norm = normalizeProxyUrl(trimmed)
    const url = norm.ok ? norm.url : ''
    if (url && !candidates.some((c) => c.url === url)) candidates.push({ source, url, raw: trimmed })
  }
  const envHit =
    env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy
  if (envHit) push('env', envHit)

  if (platform === 'win32' && execFileImpl) {
    try {
      const stdout = await new Promise((resolve, reject) => {
        execFileImpl('reg', regQueryArgs, { timeout: 4000 }, (e, out) => (e ? reject(e) : resolve(String(out || ''))))
      })
      const enabled = /ProxyEnable\s+REG_DWORD\s+0x1/i.test(stdout)
      const server = /ProxyServer\s+REG_SZ\s+(\S+)/i.exec(stdout)
      if (enabled && server) push('system', parseWinProxyServer(server[1]))
    } catch { /* 没开系统代理 / reg 不可用，都算「没检测到」 */ }
  }
  return { candidates, primary: candidates.length ? candidates[0].url : null }
}
