#!/usr/bin/env node
// Codex 网关 · 本地启动器（零依赖）
//
// 职责：
//   1. 自动拉起 chatgpt-bridge 子进程（开机自启，可一键启停/重启）
//   2. 托管构建好的 Vue 前端（frontend/dist）
//   3. 反向代理 /v1/* 与 /health 到 bridge
//   4. 暴露 /__gw/* 控制接口（状态 / 日志 / 启停 / 配置），供前端托管与使用后端
//
// 用法：
//   cd gateway
//   npm install      # 仅用于 "npm start" 脚本，无需任何依赖
//   npm start        # 或：node launcher.mjs
//   浏览器打开 http://127.0.0.1:4173
//
// 环境变量：
//   LAUNCHER_PORT    本启动器端口（默认 4173）
//   BRIDGE_PORT      chatgpt-bridge 端口（默认 10531）
//   FRONTEND_DIR     前端构建目录（默认 ../frontend/dist）
//   BRIDGE_CLI       本地 bridge 入口（默认 node_modules/chatgpt-bridge/dist/cli.js）
//   BRIDGE_NODE      运行 bridge 的 node（默认即本启动器所用的 node）
//   BRIDGE_ARGS      bridge 子命令与参数（默认 "serve"）
//   DISABLE_AUTOSTART=1  不自动启动 bridge

import http from 'node:http'
import https from 'node:https'
import { Transform, Readable } from 'node:stream'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  loadConfig,
  saveConfig,
  defaultAuthFilePath,
  writeAuthFile,
  normalizeAuthJson,
  startDeviceFlow,
  pollDeviceFlow,
  clearDeviceFlow,
  migrateLegacyAuth,
  resolveActiveAuthFilePath,
  accountAuthPath,
  loadAccounts,
  addAccount,
  setActiveAccount,
  removeAccount,
  renameAccount,
  addPendingAccount,
  completePendingAccount,
  startBrowserLogin,
  pollBrowserLogin,
  submitBrowserCallback,
  cancelBrowserLogin,
  getBrowserLoginInfo,
  jwtClaims
} from './auth-core.mjs'
import {
  listApiKeys,
  createApiKey,
  deleteApiKey,
  verifyApiKey,
  extractBearerToken,
  addKeyUsage,
  resolveKeyAccountId,
  revealApiKey
} from './apikeys.mjs'
import {
  applyProxy,
  getProxyInfo,
  testProxy,
  getUndici
} from './proxy.mjs'
import { ensureBridgePatched } from './bridge-patches.mjs'
import { recordCallLog, getCallLogs } from './call-logs.mjs'
import { handleAssets } from './assets.mjs'
import { mergeModelList, resolveModelId, defaultChatModel, IMAGE_MODEL } from './model-catalog.mjs'
import { getAccountQuota, saveAccountQuota } from './account-quota.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// 多模式配置：bridge（复用 codex login OAuth）/ openai（自带 API Key 直连）
let gwConfig = loadConfig()
// 多账号：启动迁移旧 auth.json，并让 bridge 指向“当前激活账号”
const _reg = migrateLegacyAuth()
if (_reg.activeId) gwConfig.authFilePath = accountAuthPath(_reg.activeId)

// 应用出网代理（仅影响本进程 fetch；bridge 子进程的代理在 startBridge 中注入）
try { applyProxy(gwConfig.proxy || '') } catch {}

const LAUNCHER_PORT = Number(process.env.LAUNCHER_PORT || 4173)
const BRIDGE_PORT = Number(process.env.BRIDGE_PORT || 10531)
const FRONTEND_DIR = process.env.FRONTEND_DIR || path.resolve(__dirname, '../frontend/dist')
const BRIDGE_CLI = process.env.BRIDGE_CLI || path.resolve(__dirname, 'node_modules/chatgpt-bridge/dist/cli.js')
const BRIDGE_NODE = process.env.BRIDGE_NODE || process.execPath
const BRIDGE_ARGS = (process.env.BRIDGE_ARGS || 'serve').split(/\s+/).filter(Boolean)
const AUTOSTART = process.env.DISABLE_AUTOSTART !== '1'
const BRIDGE_URL = `http://127.0.0.1:${BRIDGE_PORT}`

// ---- 生图实际使用的模型（重要） ----
// ChatGPT 订阅通道**没有独立的图片模型**：bridge 的 /v1/images/generations
// 从不读取请求体的 model 字段，buildImageRequest() 一律用 cfg.imageModel
// + tools:[{type:"image_generation"}] 渲染。cfg.imageModel 来自环境变量
// CHATGPT_BRIDGE_IMAGE_MODEL，未设置时 bridge 自己的默认是 'gpt-6.1-sol'。
//
// 因此网关侧显式注入同一个值，保证「UI 展示的模型」与「真实渲染模型」一致，
// 并在响应里回写真实模型，避免调用方填了 model 却静默无效却无从察觉。
// 取值定义在 model-catalog.mjs（唯一真源），此处直接导入使用。

// ---- 局域网接入（LAN） ----
// 默认只监听回环。开启后监听 0.0.0.0，让局域网内其他主机用
// 「接口地址 + cgw- API Key」接入（见截图中的自定义模型配置）。
// 安全策略（开启 LAN 时自动生效，不可通过控制面关闭）：
//   1) /__gw/* 控制面仅允许回环来源访问 —— 账号管理、API Key、配置写入绝不出局域网
//   2) /v1/* 强制 API Key 鉴权，不允许匿名放行
//   3) bridge 子进程仍只监听 127.0.0.1，不直接暴露
//
// 开启方式（两种等价，命令行更跨平台）：
//   node launcher.mjs --lan
//   GW_LAN=1 node launcher.mjs
// 可选 --lan-host=<addr> 覆盖监听地址（默认 0.0.0.0；显式给出地址即视为开启 LAN）
const CLI_ARGS = process.argv.slice(2)
const hasFlag = (name) => CLI_ARGS.some((a) => a === name || a.startsWith(name + '='))
const flagValue = (name) => {
  const hit = CLI_ARGS.find((a) => a.startsWith(name + '='))
  return hit ? hit.slice(name.length + 1) : ''
}
const LAN_ENABLED = hasFlag('--lan') || hasFlag('--lan-host') || process.env.GW_LAN === '1'
const LAN_HOST = flagValue('--lan-host') || process.env.GW_LAN_HOST || '0.0.0.0'
const LISTEN_HOST = LAN_ENABLED ? LAN_HOST : '127.0.0.1'

// 请求来源是否回环（用于控制面隔离）
function isLoopbackReq(req) {
  const addr = String(req.socket?.remoteAddress || '')
  if (!addr) return true // 拿不到就当作本机（保守起见放行控制面，避免把自己锁在门外）
  const a = addr.replace(/^::ffff:/i, '')
  return a === '127.0.0.1' || a === '::1' || a === 'localhost' || a.startsWith('127.')
}

// 本机所有可用的局域网 IPv4（用于给前端展示「接口地址」）
function lanAddresses() {
  const out = []
  try {
    const ifaces = os.networkInterfaces() || {}
    for (const [name, list] of Object.entries(ifaces)) {
      for (const ni of list || []) {
        if (ni.family !== 'IPv4' && ni.family !== 4) continue
        if (ni.internal) continue
        if (/^169\.254\./.test(ni.address)) continue // 链路本地，无实际意义
        out.push({ name, address: ni.address, port: LAUNCHER_PORT })
      }
    }
  } catch {}
  return out
}

const MAX_LOG = 800
const logBuf = []
let child = null
let startedAt = null
// 本地用量统计：经本启动器反代的请求数 与 命中的 429 限流数
let metrics = { requests: 0, rateLimited: 0, modelAliases: 0 }

function ts() {
  return new Date().toISOString().slice(11, 19)
}
function pushLog(line) {
  logBuf.push(`${ts()}  ${line}`)
  if (logBuf.length > MAX_LOG) logBuf.shift()
}
function startBridge() {
  if (child) return { ok: false, msg: '已在运行' }
  if (gwConfig.mode === 'openai') {
    return { ok: false, msg: '当前为 API Key 模式，无需启动 bridge' }
  }
  if (!fs.existsSync(BRIDGE_CLI)) {
    const msg = '未找到本地 bridge：' + BRIDGE_CLI + '（请先 cd gateway && npm install）'
    pushLog('✗ ' + msg)
    return { ok: false, msg }
  }
  // vendored bridge 上叠了手写补丁，npm install 会清掉；启动前自动校验并从快照恢复
  ensureBridgePatched(pushLog)
  const env = {
    ...process.env,
    CHATGPT_BRIDGE_HOST: '127.0.0.1',
    CHATGPT_BRIDGE_PORT: String(BRIDGE_PORT),
    CHATGPT_BRIDGE_AUTH_FILE: gwConfig.authFilePath || defaultAuthFilePath(),
    // 生图实际使用的模型：必须与网关侧一致，否则 UI 展示的模型与真实渲染模型会脱节
    CHATGPT_BRIDGE_IMAGE_MODEL: IMAGE_MODEL,
    CGW_PROXY: gwConfig.proxy || ''
  }
  // 注入代理预加载：bridge 子进程的上游请求走代理（本地回环仍由 proxy.mjs 强制直连）
  if (gwConfig.proxy) {
    const preload = pathToFileURL(path.resolve(__dirname, 'proxy-preload.mjs')).href
    const existing = env.NODE_OPTIONS || ''
    env.NODE_OPTIONS = (existing + ' --import ' + preload).trim()
  }
  // 直接用本机 node 跑本地 cli.js（离线、不依赖 npx 解析）
  const args = [BRIDGE_CLI, ...BRIDGE_ARGS, '--host', '127.0.0.1', '--port', String(BRIDGE_PORT)]
  pushLog(`▶ 启动 bridge：${BRIDGE_NODE} ${args.join(' ')}`)
  child = spawn(BRIDGE_NODE, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  startedAt = Date.now()
  child.stdout.on('data', (d) => String(d).split('\n').forEach((l) => l.trim() && pushLog(l)))
  child.stderr.on('data', (d) => String(d).split('\n').forEach((l) => {
    if (!l.trim()) return
    // bridge 的启动横幅走 console.error，但不是错误；不带 [err] 前缀以免前端标红误导
    pushLog(/listening|starting chatgpt-bridge/i.test(l) ? l : '[err] ' + l)
  }))
  child.on('exit', (code, sig) => {
    pushLog(`■ bridge 退出 code=${code ?? ''} sig=${sig ?? ''}`)
    child = null
    startedAt = null
  })
  child.on('error', (e) => pushLog('[spawn error] ' + e.message))
  return { ok: true }
}
function stopBridge() {
  if (!child) return { ok: false, msg: '未运行' }
  child.kill('SIGTERM')
  pushLog('■ 发送 SIGTERM')
  return { ok: true }
}

// 热切换 bridge 到指定账号：若当前 activeId 与之不同则 stop+start。
// API Key 鉴权在请求到达时调用，确保该 key 绑定的账号被 bridge 加载。
// 同步等待，对调用方而言表现是首跨账号请求会停顿 ~200ms（实际表现取决于 spawn/启动开销）。
//
// 并发保护：多个 key 绑不同账号时，请求会并发到达。若不加锁，两个请求会同时
// 对 bridge 进程 kill/start —— 互相踩踏，最终 child 指针指向已死进程，
// 表现为随机的 502 / bridge_unreachable。这里用 promise 链把切换串行化，
// 并在队首做一次「目标是否已生效」复检，避免串行化后重复切换。
let bridgeSwitchChain = Promise.resolve()
function ensureBridgeForAccount(accountId) {
  if (!accountId) return Promise.resolve({ ok: true })
  const task = bridgeSwitchChain.then(() => doEnsureBridgeForAccount(accountId))
  // 无论成功失败都要让链继续，否则一次异常会卡死后续所有切换
  bridgeSwitchChain = task.then(() => {}, () => {})
  return task
}

async function doEnsureBridgeForAccount(accountId) {
  const target = accountAuthPath(accountId)
  if (!fs.existsSync(target)) return { ok: false, msg: '账号 auth 文件不存在：' + target }
  if (gwConfig.authFilePath === target && child) return { ok: true }
  gwConfig.authFilePath = target
  saveConfig(gwConfig)
  pushLog(`● 切换 bridge 鉴权至账号 ${accountId}`)
  if (child) {
    const dying = child
    child = null
    startedAt = null
    dying.kill('SIGTERM')
    // 给子进程机会退出，但不让上层 hang 太久
    await new Promise((r) => {
      if (!dying || dying.exitCode != null) return r()
      const t = setTimeout(() => { try { dying.kill('SIGKILL') } catch {} ; r() }, 1200)
      dying.once('exit', () => { clearTimeout(t); r() })
    })
  }
  const r = startBridge()
  // 等 bridge 真的起来，否则接下来 proxy 会 502
  for (let i = 0; i < 30 && !child; i++) await new Promise((r) => setTimeout(r, 80))
  if (r.ok) {
    // 等首条 /health 200，确认 auth 已加载
    const h = await fetchBridgeHealth()
    if (!h.ok) {
      pushLog('⚠ bridge 健康检查未过，但已监听：' + (h.status || '—'))
    }
  }
  return r
}

// 当前激活账号摘要（与 engine.js getActiveAccountSummary 对齐）：
// 读注册表 → 激活账号 → auth 文件 → 解 id_token 拿 email/exp，判断真实登录态
function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')) } catch { return null }
}
function getActiveAccountSummary() {
  if (gwConfig.mode === 'openai') {
    return gwConfig.openaiApiKey
      ? { accountId: null, name: 'OpenAI API Key', provider: 'apikey', email: 'API Key 模式', loggedIn: true, detail: 'API Key 模式 · 直连 OpenAI' }
      : { accountId: null, name: '—', provider: 'apikey', email: '未配置', loggedIn: false, detail: 'API Key 模式 · 未配置' }
  }
  const reg = loadAccounts()
  const active = (reg.accounts || []).find((a) => a.id === reg.activeId)
  if (!active) return { accountId: null, name: '—', provider: '—', email: '尚无账号', loggedIn: false, detail: '' }
  const filePath = accountAuthPath(active.id)
  let email = active.email || active.note || ''
  let expiresIn = null
  let loggedIn = false
  let detail = ''
  let provider = active.provider || 'token'
  if (fs.existsSync(filePath)) {
    const data = readJsonSafe(filePath)
    const idToken = data?.tokens?.id_token
    if (idToken) {
      try {
        const claims = jwtClaims(idToken)
        email = claims?.email || claims?.preferred_username || email
        if (typeof claims?.exp === 'number') expiresIn = claims.exp - Math.floor(Date.now() / 1000)
        loggedIn = !!claims?.sub
        detail = claims?.email ? `OAuth · ${claims.email}` : 'OAuth 登录态'
      } catch (e) {
        detail = 'Token 已失效：' + (e?.message || '解析失败')
      }
    } else if (data?.OPENAI_API_KEY || data?.tokens?.access_token) {
      loggedIn = true
      detail = 'Token 登录态'
    }
  } else {
    detail = 'auth 文件不存在'
  }
  return {
    accountId: active.id,
    name: active.name || '未命名账号',
    provider,
    email: email || '—',
    loggedIn,
    expiresIn,
    detail
  }
}

// 轻量健康检查：请求 bridge /health，带 1.2s 超时
function fetchBridgeHealth() {
  return new Promise((resolve) => {
    const req = http.get(`${BRIDGE_URL}/health`, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => {
        try {
          resolve({ ok: res.statusCode === 200, status: res.statusCode, data: JSON.parse(body) })
        } catch {
          resolve({ ok: res.statusCode === 200, status: res.statusCode, data: null })
        }
      })
    })
    req.setTimeout(1200, () => {
      req.destroy()
      resolve({ ok: false, status: 0, data: null, timeout: true })
    })
    req.on('error', () => resolve({ ok: false, status: 0, data: null }))
  })
}

function sendJson(res, code, obj) {
  const buf = Buffer.from(JSON.stringify(obj))
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(buf)
}

// 读取请求体 JSON
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => (data += c))
    req.on('end', () => {
      if (!data) return resolve({})
      try {
        resolve(JSON.parse(data))
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

// 应用模式切换：bridge ↔ openai，并相应启停 bridge
async function applyMode(mode, apiKey) {
  gwConfig.mode = mode === 'openai' ? 'openai' : 'bridge'
  if (mode === 'openai') gwConfig.openaiApiKey = apiKey || gwConfig.openaiApiKey || ''
  saveConfig(gwConfig)
  if (gwConfig.mode === 'openai') {
    stopBridge()
  } else if (AUTOSTART) {
    if (!child) startBridge()
  }
  return gwConfig
}

// 从上游响应体解析 token usage：兼容非流式 JSON 与流式 SSE（data: 行）
// 归一化两种字段命名：标准 OpenAI 用 prompt_tokens/completion_tokens；
// chatgpt-bridge 返回 input_tokens/output_tokens（Codex 风格）。统一成 {promptTokens, completionTokens}
function extractUsage(text) {
  if (!text) return null
  let raw = null
  try {
    const obj = JSON.parse(text)
    if (obj && obj.usage) raw = obj.usage
  } catch {}
  if (!raw) {
    // SSE：逐 event（以 \n\n 分隔）找含 usage 的 data 行
    for (const evt of text.split('\n\n')) {
      const m = evt.match(/data:\s*([\s\S]+)/)
      if (!m) continue
      const payload = m[1].trim()
      if (payload === '[DONE]') continue
      try {
        const obj = JSON.parse(payload)
        if (obj && obj.usage) { raw = obj.usage; break }
      } catch {}
    }
  }
  if (!raw) return null
  const prompt = raw.prompt_tokens ?? raw.input_tokens ?? 0
  const completion = raw.completion_tokens ?? raw.output_tokens ?? 0
  return { promptTokens: Number(prompt) || 0, completionTokens: Number(completion) || 0 }
}

// 反向代理：根据模式转发
//   bridge 模式 → 127.0.0.1:BRIDGE_PORT（chatgpt-bridge）
//   openai 模式 → https://api.openai.com（自带 API Key）
// keyId 非空时，对上游响应挂一个「只读旁路」：字节原样透传，流结束后解析 usage 归因到该 Key
// ---- 请求体改写：模型别名 -> 真实 slug（sol / gpt-6 / astra / terra …） ----
const MODEL_REWRITE_PATHS = new Set(['/v1/chat/completions', '/v1/responses'])
const MAX_BODY = 32 * 1024 * 1024

function collectBody(req, cb) {
  const chunks = []
  let size = 0
  req.on('data', (c) => {
    size += c.length
    if (size > MAX_BODY) {
      req.destroy()
      cb(new Error('body_too_large'), null)
      return
    }
    chunks.push(c)
  })
  req.on('end', () => cb(null, Buffer.concat(chunks)))
  req.on('error', (err) => cb(err, null))
}

function rewriteModelBody(buf) {
  let json = null
  try {
    json = JSON.parse(buf.toString('utf8'))
  } catch {
    return { body: buf, changed: false, from: null, to: null, qInjected: false }
  }
  if (!json || typeof json !== 'object' || typeof json.model !== 'string') {
    return { body: buf, changed: false, from: null, to: null, qInjected: false }
  }
  const r = resolveModelId(json.model)
  // 网关最高质量策略：会话内 image_generation 工具缺省 quality 时注入 high
  let qInjected = false
  if (Array.isArray(json.tools)) {
    for (const t of json.tools) {
      if (t && t.type === 'image_generation' && !t.quality) {
        t.quality = 'high'
        qInjected = true
      }
    }
  }
  if (!r.changed && !qInjected) return { body: buf, changed: false, from: json.model, to: json.model, qInjected: false }
  json.model = r.id
  return { body: Buffer.from(JSON.stringify(json), 'utf8'), changed: r.changed, from: r.from, to: r.id, qInjected }
}

// 真正的转发；bodyBuf 非空时用它替代原始请求流（改写过 model）
function pipeProxy(req, res, targetPath, keyId, bodyBuf) {
  metrics.requests++
  const callT0 = Date.now()
  let callModel = null
  if (bodyBuf) {
    try { callModel = JSON.parse(bodyBuf.toString('utf8'))?.model || null } catch {}
  }
  let callUsage = null
  if (targetPath.startsWith('/v1/')) {
    res.on('finish', () => {
      recordCallLog({
        method: req.method,
        endpoint: targetPath.split('?')[0],
        model: callModel || '—',
        status: res.statusCode || 0,
        latency: Date.now() - callT0,
        tokens: callUsage ? callUsage.promptTokens + callUsage.completionTokens : null
      })
    })
  }
  const attachUsageTap = (up) => {
    let buf = ''
    const tap = new Transform({
      transform(chunk, _enc, cb) {
        buf += chunk.toString('utf8')
        cb(null, chunk)
      },
      flush(cb) {
        const u = extractUsage(buf)
        if (u) {
          callUsage = u
          if (keyId) addKeyUsage(keyId, u.promptTokens, u.completionTokens)
        }
        cb()
      }
    })
    up.pipe(tap).pipe(res)
  }
  const prep = (base) => {
    const h = { ...base }
    delete h['content-length']
    delete h['transfer-encoding']
    if (bodyBuf) h['content-length'] = String(bodyBuf.length)
    return h
  }
  const pump = (p) => {
    if (bodyBuf) p.end(bodyBuf)
    else req.pipe(p)
  }
  if (gwConfig.mode === 'openai') {
    const headers = prep(req.headers)
    delete headers.host
    headers['Authorization'] = 'Bearer ' + (gwConfig.openaiApiKey || '')
    headers['Content-Type'] = headers['content-type'] || 'application/json'
    pipeOpenAi(req, res, targetPath, headers, bodyBuf, attachUsageTap)
    return
  }
  // bridge 模式
  const opts = {
    host: '127.0.0.1',
    port: BRIDGE_PORT,
    path: targetPath,
    method: req.method,
    headers: prep({ ...req.headers, host: `127.0.0.1:${BRIDGE_PORT}` })
  }
  const p = http.request(opts, (up) => {
    if (up.statusCode === 429) metrics.rateLimited++
    res.writeHead(up.statusCode || 502, up.headers)
    attachUsageTap(up)
  })
  p.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'bridge_unreachable', detail: `bridge 未运行或不可达（${BRIDGE_URL}）` }))
  })
  pump(p)
}

// ---------- openai 模式出站 ----------
// 【为什么不用 node:https 直连】
//   node:https 完全不认识 undici 的 dispatcher。此前 openai 模式用
//   https.request 直连 api.openai.com，导致用户在「设置 → 出网代理」里配的
//   Clash/Tailscale 代理**完全失效**：请求从裸出口发出，OpenAI 按出口 IP
//   判定地区后返回 403 unsupported_country_region_territory。
//   改为走 undici 的低层 request()，它默认使用 getGlobalDispatcher()，
//   而 proxy.mjs 的 smartDispatcher 正是装在这个全局槽位上的——代理自然生效。
//
// 【为什么不用 fetch()】
//   fetch 会自动解压 content-encoding: gzip/br 并保留原头部，
//   对「字节原样透传」的反向代理是破坏性的。低层 request() 不做解压。
async function pipeOpenAi(req, res, targetPath, headers, bodyBuf, attachUsageTap) {
  const target = 'https://api.openai.com' + targetPath
  const mod = await getUndici().catch(() => null)
  if (!mod) {
    // 极端降级：undici 缺失时退回裸 https（无代理能力），至少功能可用
    return pipeOpenAiDirect(req, res, targetPath, headers, bodyBuf, attachUsageTap)
  }
  try {
    const up = await mod.request(target, {
      method: req.method,
      headers,
      body: bodyBuf ? bodyBuf : req,
      dispatcher: mod.getGlobalDispatcher(),
      headersTimeout: 180000,
      bodyTimeout: 600000
    })
    if (up.statusCode === 429) metrics.rateLimited++
    // undici 的 headers 对象：重复头会是数组，需要归一成 Node 期望的形态
    const outHeaders = {}
    for (const [k, v] of Object.entries(up.headers || {})) {
      if (Array.isArray(v)) outHeaders[k] = k.toLowerCase() === 'set-cookie' ? v : v.join(', ')
      else outHeaders[k] = v
    }
    res.writeHead(up.statusCode || 502, outHeaders)
    // 低层 request 的 body 是 web ReadableStream，转成 Node 流再接 usage 探针
    attachUsageTap(Readable.fromWeb(up.body))
  } catch (e) {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      error: 'openai_unreachable',
      detail: String((e && e.message) || e).slice(0, 200)
    }))
  }
}

// 降级路径：undici 不可用时的裸 https 直连（无代理）
function pipeOpenAiDirect(req, res, targetPath, headers, bodyBuf, attachUsageTap) {
  const opts = {
    host: 'api.openai.com',
    port: 443,
    path: targetPath,
    method: req.method,
    headers
  }
  const p = https.request(opts, (up) => {
    if (up.statusCode === 429) metrics.rateLimited++
    res.writeHead(up.statusCode || 502, up.headers)
    attachUsageTap(up)
  })
  p.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'openai_unreachable', detail: 'undici 不可用，已降级为直连（不经过出网代理）' }))
  })
  if (bodyBuf) p.end(bodyBuf)
  else req.pipe(p)
}

function proxy(req, res, targetPath, keyId, owner) {
  const basePath = targetPath.split('?')[0]
  const isJson = String(req.headers['content-type'] || '').includes('application/json')
  if ((req.method === 'POST' || req.method === 'PUT') && isJson && MODEL_REWRITE_PATHS.has(basePath)) {
    return collectBody(req, (err, raw) => {
      if (err || !raw) {
        if (!res.headersSent) res.writeHead(400, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ error: 'body_read_failed', detail: err ? err.message : 'empty body' }))
      }
      const r = rewriteModelBody(raw)
      if (r.changed) {
        metrics.modelAliases++
        pushLog(`⇄ 模型别名：${r.from} → ${r.to}`)
      }
      if (r.qInjected) pushLog('🖼 会话生图质量注入：quality=high（最高质量策略）')
      return pipeProxy(req, res, targetPath, keyId, r.body)
    })
  }
  // 生图端点：bridge 模式下缓冲响应，b64 落盘并附加 url / local_path 后返回
  if (req.method === 'POST' && isJson && basePath === '/v1/images/generations' && gwConfig.mode !== 'openai') {
    return collectBody(req, (err, raw) => {
      if (err || !raw) {
        if (!res.headersSent) res.writeHead(400, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ error: 'body_read_failed', detail: err ? err.message : 'empty body' }))
      }
      return imagesGenProxy(req, res, targetPath, keyId, raw, owner)
    })
  }
  return pipeProxy(req, res, targetPath, keyId, null)
}

// /v1/images/generations 专用反代（bridge 模式）：缓冲 JSON 响应 → 落盘 → 补 url/local_path
function imagesGenProxy(req, res, targetPath, keyId, bodyBuf, owner) {
  const t0 = Date.now()
  let model = null
  let body = bodyBuf
  // 网关最高质量策略：调用方缺省时注入 quality=high + size=auto（按内容选比例，上游给到该比例的原生最大分辨率）
  try {
    const j = JSON.parse(bodyBuf.toString('utf8'))
    if (j && typeof j === 'object') {
      model = j.model || null
      let injected = false
      if (!j.quality) { j.quality = 'high'; injected = true }
      if (!j.size) { j.size = 'auto'; injected = true }
      if (injected) {
        body = Buffer.from(JSON.stringify(j), 'utf8')
        pushLog('🖼 生图参数补全：quality=high size=auto（最高质量策略）')
      }
    }
  } catch {}
  const headers = { ...req.headers, host: `127.0.0.1:${BRIDGE_PORT}` }
  delete headers['content-length']
  headers['content-length'] = String(body.length)
  const p = http.request({
    host: '127.0.0.1', port: BRIDGE_PORT, path: targetPath, method: 'POST', headers
  }, (up) => {
    if (up.statusCode === 429) metrics.rateLimited++
    let buf = ''
    up.on('data', (c) => { buf += c.toString('utf8') })
    up.on('end', () => {
      try {
        const j = JSON.parse(buf)
        const b64 = j?.data?.[0]?.b64_json
        if (j?.data?.[0] && typeof b64 === 'string' && b64.length > 0) {
          const name = saveGenImageB64(b64, owner || (keyId ? { keyId } : null))
          if (name) {
            // url 跟随请求的 Host：本机调用=127.0.0.1:4173（行为不变）；
            // 局域网调用=http://<局域网IP>:4173/...，客户端浏览器可直接打开取图
            const hostHeader = req.headers.host || `127.0.0.1:${LAUNCHER_PORT}`
            j.data[0].url = `http://${hostHeader}/__gw/gen-images/${name}`
            j.data[0].local_path = path.join(genImagesDir(), name)
            pushLog('🖼 生成图片已落盘：' + name)
            buf = JSON.stringify(j)
          }
        }
      } catch {}
      // 回写真实渲染模型：bridge 忽略请求体的 model 字段，一律用 IMAGE_MODEL 渲染。
      // 调用方填的 model 只作「占位」，这里把真实值写回 body + 响应头，
      // 让「填了 model 却静默无效」变成可见事实，而不是让用户以为换模型生效了。
      let realModel = IMAGE_MODEL
      try {
        const j = JSON.parse(buf)
        if (j && typeof j === 'object') {
          j.model = IMAGE_MODEL
          if (!j.cgw_requested_model && model) j.cgw_requested_model = model
          if (!j.cgw_image_via) j.cgw_image_via = `${IMAGE_MODEL} + image_generation 工具`
          buf = JSON.stringify(j)
        }
      } catch {}
      const out = Buffer.from(buf)
      try {
        res.writeHead(up.statusCode || 200, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': out.length,
          'x-cgw-image-model': realModel
        })
        res.end(out)
      } catch {}
      // 调用方填的 model 与实际渲染模型不一致时，明确记一条日志
      if (model && model !== IMAGE_MODEL) {
        pushLog(`🖼 生图模型占位被忽略：请求填的是 ${model}，实际由 ${IMAGE_MODEL} + image_generation 工具渲染`)
      }
      recordCallLog({
        method: 'POST',
        endpoint: '/v1/images/generations',
        model: `${model || '—'} → ${realModel}`,
        status: up.statusCode || 200,
        latency: Date.now() - t0,
        tokens: null
      })
      if (keyId) addKeyUsage(keyId, 0, 0)
    })
  })
  p.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'bridge_unreachable', detail: `bridge 未运行或不可达（${BRIDGE_URL}）` }))
  })
  p.end(body)
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
}
function spaFallback(res, send) {
  const idx = path.join(FRONTEND_DIR, 'index.html')
  fs.readFile(idx, (e2, buf) => {
    if (e2 || !buf) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      return res.end('前端未构建：请先 cd frontend && npm run build')
    }
    send(buf, '.html')
  })
}

// 路径穿越防护：用 path.relative 判定，比 startsWith 严谨
// （startsWith 会把 `dist-evil` 误判为 `dist` 的子目录 —— 前缀绕过）
function isInsideDir(base, target) {
  const rel = path.relative(base, target)
  if (!rel) return false
  if (rel.startsWith('..')) return false
  if (path.isAbsolute(rel)) return false
  return true
}

// 静态文件 ETag 缓存：以 mtime + size 为键，命中则 304，避免重复读盘与传输
const staticCache = new Map() // filePath -> { etag, buf, mtime, size, ext }
function makeEtag(stat) {
  return `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`
}

function serveStatic(req, res, urlPath) {
  let rel
  try {
    rel = decodeURIComponent(urlPath.split('?')[0])
  } catch {
    // 畸形百分号编码（如 %zz）会让 decodeURIComponent 抛异常 —— 直接 400，别打挂请求
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
    return res.end('bad request')
  }
  if (rel === '/' || rel === '' || rel.endsWith('/')) rel += 'index.html'
  const filePath = path.join(FRONTEND_DIR, rel)
  // 防目录穿越
  if (!isInsideDir(FRONTEND_DIR, filePath)) {
    res.writeHead(403)
    return res.end('forbidden')
  }
  fs.stat(filePath, (err, stat) => {
    const send = (buf, ext) => {
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': Buffer.byteLength(buf)
      })
      res.end(buf)
    }
    if (!err && stat.isFile()) {
      const ext = path.extname(filePath).toLowerCase()
      const etag = makeEtag(stat)
      // 条件请求：客户端带相同 ETag 直接 304
      const inm = String(req.headers['if-none-match'] || '')
      if (inm && inm.split(',').some((t) => t.trim() === etag)) {
        res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' })
        return res.end()
      }
      // 内存缓存命中且文件未变 → 直接复用，避免每次都 readFile
      const hit = staticCache.get(filePath)
      if (hit && hit.etag === etag) {
        res.writeHead(200, {
          'Content-Type': MIME[hit.ext] || 'application/octet-stream',
          'Content-Length': hit.buf.length,
          ETag: hit.etag,
          'Cache-Control': 'no-cache'
        })
        return res.end(hit.buf)
      }
      fs.readFile(filePath, (e2, buf) => {
        if (e2 || !buf) return spaFallback(res, send)
        staticCache.set(filePath, { etag, buf, mtime: stat.mtimeMs, size: stat.size, ext })
        res.writeHead(200, {
          'Content-Type': MIME[ext] || 'application/octet-stream',
          'Content-Length': buf.length,
          ETag: etag,
          'Cache-Control': 'no-cache'
        })
        res.end(buf)
      })
      return
    }
    spaFallback(res, send)
  })
}

// ---- 模型列表：上游真实列表 ∪ 本地目录（上游挂了也不至于空列表） ----
// 上游模型列表有 TTL 缓存：前端会轮询 /__gw/models，客户端也会频繁打 /v1/models。
// 原实现每次都实打实问一次上游（最多 5s 超时），上游抖动时会把请求线程一起拖住。
const MODELS_TTL_MS = 60_000
let modelsCache = { at: 0, ids: [], ok: false, error: null }
let modelsInflight = null

async function fetchBridgeModels({ force = false } = {}) {
  const now = Date.now()
  if (!force && now - modelsCache.at < MODELS_TTL_MS) {
    return { ok: modelsCache.ok, ids: modelsCache.ids, error: modelsCache.error, cached: true }
  }
  // 并发合并：同一时刻只发一个上游请求，其余等待同一个 promise
  if (modelsInflight) return modelsInflight
  modelsInflight = (async () => {
    try {
      const r = await fetch(`${BRIDGE_URL}/v1/models`, { signal: AbortSignal.timeout(5000) })
      const j = await r.json().catch(() => null)
      const ids = (j && Array.isArray(j.data)) ? j.data.map((m) => m && m.id).filter(Boolean) : []
      if (ids.length) {
        modelsCache = { at: Date.now(), ids, ok: true, error: null }
        return { ok: true, ids, error: null, cached: false }
      }
      const err = (j && j.error && (j.error.message || j.error.code)) || 'empty_model_list'
      modelsCache = { at: Date.now(), ids: [], ok: false, error: err }
      return { ok: false, ids: [], error: err, cached: false }
    } catch (e) {
      const err = e && e.message ? e.message : 'bridge_unreachable'
      modelsCache = { at: Date.now(), ids: [], ok: false, error: err }
      return { ok: false, ids: [], error: err, cached: false }
    } finally {
      modelsInflight = null
    }
  })()
  return modelsInflight
}

async function handleModels(res, { force = false } = {}) {
  const up = await fetchBridgeModels({ force })
  const payload = mergeModelList(up.ids, up.ok)
  return sendJson(res, 200, {
    ...payload,
    upstreamError: up.error,
    defaultModel: defaultChatModel(),
    imageModel: IMAGE_MODEL,
    imageModelVia: `${IMAGE_MODEL} + image_generation 工具`
  })
}

// ---- 生成图片：bridge image_generation 落盘产物（~/.chatgpt-bridge/gen-images） ----
// 控制面提供列表 / 原图伺服 / 删除，供前端「生成图片」页下载、复制、拖拽
const GEN_IMAGE_RE = /^[A-Za-z0-9_-]+\.png$/
function genImagesDir() {
  return path.join(os.homedir(), '.chatgpt-bridge', 'gen-images')
}
// /v1/images/generations 响应增强：b64 落盘 + 附加 url / local_path（供外部模型/客户端直接取用）
// owner：生成者身份 { keyId, keyName }。落盘同时写入 index.json，
// 供「分用户素材站」按人生成 / 按人看图 / 按人删图（遗留无主图仅宿主机控制台可见）。
function genImageIndexPath() {
  return path.join(genImagesDir(), 'index.json')
}
function readImageIndex() {
  try { return JSON.parse(fs.readFileSync(genImageIndexPath(), 'utf8')) } catch { return {} }
}
function writeImageIndex(idx) {
  try { fs.writeFileSync(genImageIndexPath(), JSON.stringify(idx)) } catch {}
}
function saveGenImageB64(b64, owner) {
  try {
    fs.mkdirSync(genImagesDir(), { recursive: true })
    const name = `${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}.png`
    fs.writeFileSync(path.join(genImagesDir(), name), Buffer.from(b64, 'base64'))
    if (owner && owner.keyId) {
      const idx = readImageIndex()
      idx[name] = { keyId: String(owner.keyId), keyName: owner.keyName || null, createdAt: Date.now() }
      writeImageIndex(idx)
    }
    return name
  } catch {
    return null
  }
}
function listGenImages() {
  const dir = genImagesDir()
  const idx = readImageIndex()
  let names = []
  try { names = fs.readdirSync(dir).filter((n) => GEN_IMAGE_RE.test(n)) } catch { return [] }
  const out = []
  for (const name of names) {
    try {
      const st = fs.statSync(path.join(dir, name))
      const meta = idx[name] || null
      out.push({
        name, size: st.size, mtime: st.mtimeMs, url: '/__gw/gen-images/' + name,
        ownerKeyId: meta ? meta.keyId : null,
        ownerKeyName: meta ? meta.keyName : null,
        createdAt: meta ? meta.createdAt : st.mtimeMs
      })
    } catch {}
  }
  out.sort((a, b) => b.mtime - a.mtime)
  return out
}
// 分用户素材站：/v1 侧调用者只看到自己 Key 生成的图（无 Key / 遗留无主图不外露）
function scopedGenImages(keyId) {
  if (!keyId) return []
  return listGenImages().filter((i) => i.ownerKeyId === keyId)
}
// 归属校验删除：带 keyId 时只能删自己生成的；控制台（无 keyId）可删任意（宿主机=管理员）
function deleteGenImage(name, keyId) {
  if (!GEN_IMAGE_RE.test(name)) return { ok: false, error: 'bad_name' }
  const idx = readImageIndex()
  const meta = idx[name]
  if (keyId && (!meta || meta.keyId !== keyId)) return { ok: false, error: 'not_owner_or_not_found' }
  const full = path.join(genImagesDir(), name)
  if (!isInsideDir(genImagesDir(), full)) return { ok: false, error: 'bad_name' }
  try { fs.unlinkSync(full) } catch (e) { return { ok: false, error: e.message } }
  if (meta) { delete idx[name]; writeImageIndex(idx) }
  return { ok: true }
}

// 严格鉴权：开启后所有 /v1/* 请求必须携带有效 cgw- API Key（/health 保持开放）
// 局域网模式下强制开启——匿名放行等于把你的 ChatGPT 订阅开放给整个局域网。
function strictAuthReject(req, res, p) {
  const enforced = gwConfig.strictAuth || LAN_ENABLED
  if (!enforced) return false
  const t = extractBearerToken(req.headers['authorization'])
  if (t && verifyApiKey(t).ok) return false
  recordCallLog({ method: req.method, endpoint: p.split('?')[0], model: '—', status: 401, latency: 0, tokens: null })
  res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({
    error: 'missing_api_key',
    reason: LAN_ENABLED
      ? '局域网模式：/v1 必须携带有效的 cgw- API Key'
      : '严格鉴权已开启：/v1 需要有效的 cgw- API Key（设置页可关闭）'
  }))
  return true
}

// ---- 远程 MCP 端点（streamable HTTP，无状态） ----
// 让局域网客户端零安装接入生图工具：mcp.json 里只填 url + headers，无需本机 Node/npm。
// 协议：POST JSON-RPC → 响应 text/event-stream（单条 message 事件后关闭）；
//       GET/DELETE → 405（无服务器主动推送）；OPTIONS → CORS 预检。
// 鉴权与 /v1 同策略：strictAuth 或 LAN 模式强制 Bearer cgw- Key，key 无效直接 401。
const MCP_HTTP_TOOLS = [
  {
    name: 'generate_image',
    description:
      '用 Codex 网关生成图片（OpenAI 图像模型，gpt-image 系）。' +
      '适用于用户要求「画/生成/绘制图片」的任务。返回图片的 http url（浏览器可直接打开）与网关主机侧路径 local_path：' +
      '局域网客户端请用 url（或下载后用 Read 做视觉理解）；在网关主机本机可用 Read 直接查看 local_path。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '图像描述（建议具体：主体/风格/构图/色调）' },
        size: { type: 'string', enum: ['1024x1024', '1024x1536', '1536x1024', 'auto'], description: '尺寸，缺省 auto（按内容选比例，上游给原生最大分辨率；该通道实测上限 1536，4K 会被上游降级）' },
        quality: { type: 'string', enum: ['low', 'medium', 'high', 'auto'], description: '质量，缺省 high（网关最高质量策略）' },
        reference_paths: {
          type: 'array', items: { type: 'string' },
          description: '可选：参考图路径（最多 8 张），生成风格/构图与之协调的新图。注意：路径以「网关主机」磁盘视角解析——网关主机本机调用传本机路径；局域网客户端必须传网关主机上的路径，传客户端本机路径无效'
        }
      },
      required: ['prompt']
    }
  },
  {
    name: 'list_generated_images',
    description: '列出你在网关生成图库中的图片（新→旧，仅你自己用当前 Key 生成的；宿主机控制台可见全部），附可直接打开的链接与网页版素材站入口。远程客户端可用（由网关主机代读）。',
    inputSchema: { type: 'object', properties: { limit: { type: 'number', description: '返回条数，默认 20' } } }
  },
  {
    name: 'delete_generated_image',
    description: '从网关生成图库删除一张图片（只能删除你自己生成的，按 list_generated_images 返回的 name）。',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: '图片文件名，来自 list_generated_images' } },
      required: ['name']
    }
  }
]

function mcpSse(res, obj, headers = {}) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    ...headers
  })
  res.end('event: message\ndata: ' + JSON.stringify(obj) + '\n\n')
}

// 生图：内部走 /v1/images/generations，完整复用鉴权 / 按 key 账号热切 / b64 落盘 / 调用日志。
// 唯一补充：把响应里的 127.0.0.1 链接改写成调用方 Host，局域网客户端拿到可直接打开的地址。
async function mcpGenerateImage(args, req) {
  const prompt = String(args?.prompt || '').trim()
  if (!prompt) return { ok: false, error: 'prompt 不能为空' }
  const body = { prompt, size: args?.size || 'auto', quality: args?.quality || 'high', response_format: 'b64_json' }
  if (Array.isArray(args?.reference_paths) && args.reference_paths.length) {
    body.reference_images = args.reference_paths.slice(0, 8).map((p) => ({ path: String(p) }))
  }
  let r, j
  try {
    r = await fetch(`http://127.0.0.1:${LAUNCHER_PORT}/v1/images/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {})
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300000)
    })
    j = await r.json().catch(() => null)
  } catch (e) {
    return { ok: false, error: '网关请求失败：' + (e && e.message || e) }
  }
  if (!r.ok || !j?.data?.[0]?.b64_json) {
    const detail = (j && j.error && (j.error.message || j.error.reason)) || ('HTTP ' + r.status)
    return { ok: false, error: '生图失败：' + detail }
  }
  const item = j.data[0]
  const hostHeader = req.headers.host || `127.0.0.1:${LAUNCHER_PORT}`
  if (item.url) item.url = String(item.url).replace(/^http:\/\/127\.0\.0\.1(:\d+)?/, 'http://' + hostHeader)
  const loopback = isLoopbackReq(req)
  const lines = [
    '✓ 图片已生成',
    loopback
      ? (item.local_path ? `文件：${item.local_path}（用 Read 工具查看可做视觉理解）` : null)
      : (item.url ? `链接：${item.url}（浏览器打开查看/下载，或下载后用 Read 做视觉理解）` : null),
    !loopback && item.local_path ? `主机路径：${item.local_path}（仅网关主机可读）` : null,
    !loopback && Array.isArray(args?.reference_paths) && args.reference_paths.length
      ? '⚠️ 参考图按「网关主机」磁盘路径解析：你传的客户端本机路径主机读不到，参考图效果可能未生效。' : null,
    item.revised_prompt ? `优化后的提示词：${item.revised_prompt}` : null,
    loopback
      ? '该图片已自动进入网关控制台「图片素材 → 生成图库」。'
      : `网页素材站：http://${hostHeader}/gallery ← 请用侧边浏览器/内置浏览器打开，输入你的 cgw- Key 即可管理你生成的全部图片（预览/复制链接/下载/删除）。`
  ].filter(Boolean)
  return { ok: true, text: lines.join('\n'), localPath: item.local_path || null, url: item.url || null }
}

// 图库列表：由网关主机代读（远程 MCP 下三个工具都完整可用，比 stdio 版在客户端跑更合理）。
// 分用户：携带有效 Key 的调用者只看到自己生成的图；无 Key（本机未开鉴权）看到全部。
function mcpListImages(args, req, caller) {
  const all = caller && caller.keyId ? scopedGenImages(caller.keyId) : listGenImages()
  const limit = Math.max(1, Math.min(100, Number(args?.limit) || 20))
  const hostHeader = req.headers.host || `127.0.0.1:${LAUNCHER_PORT}`
  if (!all.length) {
    return { ok: true, text: `你的生成图库为空。\n网页素材站：http://${hostHeader}/gallery（生成图片后会自动出现在这里）` }
  }
  const rows = all.slice(0, limit).map((i) => {
    const kb = i.size >= 1024 * 1024 ? (i.size / 1024 / 1024).toFixed(1) + ' MB' : Math.max(1, Math.round(i.size / 1024)) + ' KB'
    const d = new Date(i.mtime)
    const p2 = (x) => String(x).padStart(2, '0')
    return `${i.name}  ${kb}  ${d.getMonth() + 1}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}  http://${hostHeader}/__gw/gen-images/${i.name}`
  })
  return {
    ok: true,
    text: `你的生成图库共 ${all.length} 张（前 ${rows.length}，链接局域网内可直接打开；可用 delete_generated_image 删除自己的图）：\n` + rows.join('\n') +
      `\n网页素材站：http://${hostHeader}/gallery（侧边浏览器打开，输入你的 cgw- Key 管理全部图片）`
  }
}

// 删除：带 Key 调用者只能删自己生成的（归属校验在 deleteGenImage 内）
function mcpDeleteImage(args, caller) {
  const name = String(args?.name || '').trim()
  if (!name) return { ok: false, error: '缺少图片文件名 name（来自 list_generated_images）' }
  const r = deleteGenImage(name, caller && caller.keyId)
  if (!r.ok) {
    return { ok: false, error: r.error === 'not_owner_or_not_found'
      ? '删除失败：图片不存在或不属于你（只能删除你自己生成的图片）'
      : '删除失败：' + r.error }
  }
  return { ok: true, text: '✓ 已删除：' + name }
}

async function handleMcpEndpoint(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'authorization, content-type, mcp-session-id, last-event-id',
      'Access-Control-Max-Age': '86400'
    })
    return res.end()
  }
  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'method_not_allowed', reason: '无状态 streamable HTTP MCP：仅支持 POST（JSON-RPC）' })
  }
  // 鉴权与 /v1 同策略：缺失 key 按 strictAuth/LAN 判定；带了 key 就必须有效
  if (strictAuthReject(req, res, '/mcp')) return
  const token = extractBearerToken(req.headers['authorization'])
  let caller = null
  if (token) {
    const v = verifyApiKey(token)
    if (!v.ok) {
      recordCallLog({ method: req.method, endpoint: '/mcp', model: '—', status: 401, latency: 0, tokens: null })
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' })
      return res.end(JSON.stringify({ error: 'invalid_api_key', reason: v.reason }))
    }
    caller = { keyId: v.keyId, keyName: v.name }
  }

  let msg
  try { msg = await readBody(req) } catch { return sendJson(res, 400, { error: 'bad_json' }) }
  const messages = Array.isArray(msg) ? msg : [msg]

  // 纯通知（initialized 等，无 id）：202 空响应
  if (messages.every((m) => !m || (m.id === undefined && m.id === null))) {
    res.writeHead(202, { 'Access-Control-Allow-Origin': '*' })
    return res.end()
  }

  const replies = []
  let sessionId = null
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue
    const { id, method, params } = m
    if (method === 'initialize') {
      sessionId = 'mcp-' + crypto.randomUUID()
      replies.push({ jsonrpc: '2.0', id, result: {
        protocolVersion: (params && params.protocolVersion) || '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'codex-gateway-image', version: '1.2.0-http' }
      } })
    } else if (method === 'tools/list') {
      replies.push({ jsonrpc: '2.0', id, result: { tools: MCP_HTTP_TOOLS } })
    } else if (method === 'tools/call') {
      const name = params && params.name
      const args = (params && params.arguments) || {}
      const t0 = Date.now()
      let r
      if (name === 'generate_image') r = await mcpGenerateImage(args, req, caller)
      else if (name === 'list_generated_images') r = mcpListImages(args, req, caller)
      else if (name === 'delete_generated_image') r = mcpDeleteImage(args, caller)
      else {
        replies.push({ jsonrpc: '2.0', id, error: { code: -32602, message: 'unknown tool: ' + name } })
        continue
      }
      recordCallLog({ method: 'POST', endpoint: '/mcp:' + name, model: name === 'generate_image' ? IMAGE_MODEL : '—', status: r.ok ? 200 : 500, latency: Date.now() - t0, tokens: null })
      replies.push({ jsonrpc: '2.0', id, result: r.ok
        ? { content: [{ type: 'text', text: r.text }] }
        : { content: [{ type: 'text', text: '✗ ' + r.error }], isError: true } })
    } else if (method === 'ping') {
      replies.push({ jsonrpc: '2.0', id, result: {} })
    } else if (id !== undefined && id !== null) {
      replies.push({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + method } })
    }
    // 无 id 的通知：忽略
  }

  const sessionHeaders = sessionId ? { 'Mcp-Session-Id': sessionId } : {}
  if (!replies.length) {
    res.writeHead(202, { 'Access-Control-Allow-Origin': '*', ...sessionHeaders })
    return res.end()
  }
  return mcpSse(res, replies.length === 1 ? replies[0] : replies, sessionHeaders)
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${LAUNCHER_PORT}`)
  const p = url.pathname

  // ---- 远程 MCP（streamable HTTP）：局域网客户端零安装接入（mcp.json 填 url 即可） ----
  if (p === '/mcp') {
    return await handleMcpEndpoint(req, res)
  }

  // ---- 网页素材站（分用户）：单文件静态页，LAN 可达（不在 /__gw 控制面守卫内），
  //      页面内数据请求走 /v1/gen-images/*（Bearer cgw- Key 鉴权，按 Key 隔离）。 ----
  if (p === '/gallery' || p === '/gallery/') {
    fs.readFile(path.join(__dirname, 'gallery.html'), (e2, buf) => {
      if (e2 || !buf) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        return res.end('gallery.html 缺失（应位于 gateway/gallery.html）')
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' })
      res.end(buf)
    })
    return
  }

  // ---- 客户端网页接入（分用户，零命令行）：输入 Key → 复制 MCP/模型 JSON / 下载 skill / 下载一键脚本。 ----
  if (p === '/setup' || p === '/setup/') {
    fs.readFile(path.join(__dirname, 'setup.html'), (e2, buf) => {
      if (e2 || !buf) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        return res.end('setup.html 缺失（应位于 gateway/setup.html）')
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' })
      res.end(buf)
    })
    return
  }

  // ---- lan-kit 文件分发（LAN 可达，白名单；setup-client.mjs 支持 ?host= 注入宿主机地址） ----
  if (p.startsWith('/lan-kit/')) {
    const LAN_KIT_WHITELIST = {
      '/lan-kit/setup-client.mjs': { file: 'setup-client.mjs', type: 'text/javascript; charset=utf-8', inject: true },
      '/lan-kit/INSTALL.md': { file: 'INSTALL.md', type: 'text/markdown; charset=utf-8' },
      '/lan-kit/AGENT-PROMPT.md': { file: 'AGENT-PROMPT.md', type: 'text/markdown; charset=utf-8' },
      '/lan-kit/skills/codex-gateway-image/SKILL.md': { file: path.join('skills', 'codex-gateway-image', 'SKILL.md'), type: 'text/markdown; charset=utf-8' }
    }
    const entry = LAN_KIT_WHITELIST[p]
    if (!entry) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      return res.end('未知文件（仅白名单文件可下载）')
    }
    // 兼容两种布局：源码仓库 docs/lan-kit、发布包根目录 lan-kit/
    const candidates = [path.join(__dirname, '..', 'docs', 'lan-kit'), path.join(__dirname, '..', 'lan-kit'), path.join(__dirname, 'lan-kit')]
    const base = candidates.find((c) => fs.existsSync(path.join(c, entry.file)))
    if (!base) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      return res.end('lan-kit 文件不存在')
    }
    fs.readFile(path.join(base, entry.file), (e2, buf) => {
      if (e2 || !buf) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
        return res.end('读取失败')
      }
      if (entry.inject) {
        const h = String(url.searchParams.get('host') || '').trim()
        if (h && /^[A-Za-z0-9._-]+$/.test(h)) {
          buf = Buffer.from(buf.toString('utf8').replace("const EMBEDDED_HOST = ''", `const EMBEDDED_HOST = '${h}'`))
        }
        res.writeHead(200, { 'Content-Type': entry.type, 'Cache-Control': 'no-cache' })
      } else {
        res.writeHead(200, { 'Content-Type': entry.type, 'Cache-Control': 'no-store' })
      }
      res.end(buf)
    })
    return
  }

  // ---- 控制接口（同源，供前端托管后端） ----
  // 局域网模式下控制面仅限回环访问：账号管理 / API Key / 配置写入绝不能出本机。
  // 局域网用户只需要 /v1/*（带 cgw- API Key）与 /health。
  if (p.startsWith('/__gw/')) {
    // 局域网放行例外：单个生成图 GET（文件名=时间戳36进制+随机UUID片段，不可枚举，视作能力令牌）。
    // 图库列表 / 删除 / 其余控制面（账号/密钥/配置/日志）仍仅限本机。
    const lanGenImageGet = req.method === 'GET' && /^\/__gw\/gen-images\/[A-Za-z0-9_-]+\.png$/.test(p)
    if (LAN_ENABLED && !isLoopbackReq(req) && !lanGenImageGet) {
      recordCallLog({ method: req.method, endpoint: p.split('?')[0], model: '—', status: 403, latency: 0, tokens: null })
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' })
      return res.end(JSON.stringify({
        error: 'control_plane_local_only',
        reason: '局域网模式下控制接口仅允许本机访问；请使用 /v1/* 接口并携带 cgw- API Key'
      }))
    }
    if (p === '/__gw/status') {
      const health = await fetchBridgeHealth()
      return sendJson(res, 200, {
        running: !!child,
        pid: child ? child.pid : null,
        startedAt,
        uptimeSec: startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0,
        health,
        metrics,
        apikeysCount: listApiKeys().length,
        tokensTotal: listApiKeys().reduce((s, k) => s + (k.tokens || 0), 0),
        mode: gwConfig.mode,
        // 实际生图模型：本通道没有独立图片模型，一律由该对话模型 + image_generation 工具渲染
        imageModel: IMAGE_MODEL,
        imageModelVia: `${IMAGE_MODEL} + image_generation 工具`,
        config: {
          launcherPort: LAUNCHER_PORT,
          bridgePort: BRIDGE_PORT,
          bridgeUrl: BRIDGE_URL,
          frontendDir: FRONTEND_DIR,
          autoStart: AUTOSTART,
          bridgeCli: BRIDGE_CLI,
          mode: gwConfig.mode,
          authFilePath: gwConfig.authFilePath,
          hasApiKey: !!(gwConfig.mode === 'openai' && gwConfig.openaiApiKey),
          proxy: gwConfig.proxy || '',
          proxyEnabled: !!gwConfig.proxy,
          proxyAvailable: getProxyInfo().available
        },
        lan: {
          enabled: LAN_ENABLED,
          listenHost: LISTEN_HOST,
          port: LAUNCHER_PORT,
          addresses: LAN_ENABLED ? lanAddresses() : [],
          // 局域网模式下 /v1 强制鉴权，strictAuth 的开关值不再影响外部行为
          authRequired: LAN_ENABLED || !!gwConfig.strictAuth,
          controlPlaneLocalOnly: LAN_ENABLED
        }
      })
    }

    if (p === '/__gw/account/quota' && req.method === 'GET') {
      return sendJson(res, 200, await getAccountQuota(gwConfig))
    }

    if (p === '/__gw/account/quota' && req.method === 'POST') {
      const body = await readBody(req).catch(() => ({}))
      try {
        return sendJson(res, 200, await saveAccountQuota(body || {}))
      } catch (e) {
        return sendJson(res, 400, { error: 'quota_save_failed', detail: e.message })
      }
    }
    if (p === '/__gw/start' && req.method === 'POST') {
      const r = startBridge()
      return sendJson(res, r.ok ? 200 : 409, r)
    }
    if (p === '/__gw/stop' && req.method === 'POST') {
      const r = stopBridge()
      return sendJson(res, r.ok ? 200 : 409, r)
    }
    if (p === '/__gw/restart' && req.method === 'POST') {
      stopBridge()
      // 给一点时间让旧进程退出
      setTimeout(() => {
        const r = startBridge()
        sendControlQueue.push(r)
      }, 400)
      return sendJson(res, 200, { ok: true, msg: 'restarting' })
    }
    if (p === '/__gw/logs' && req.method === 'GET') {
      return sendJson(res, 200, { lines: logBuf.slice(-200) })
    }
    if (p === '/__gw/call-logs' && req.method === 'GET') {
      return sendJson(res, 200, { logs: getCallLogs(100) })
    }
    if (p === '/__gw/models' && req.method === 'GET') {
      // 控制面模型列表：与 /v1/models 同源同处理，但 UI 轮询不进调用日志
      // ?refresh=1 绕过 60s 缓存，强制回源（用户在控制台点「刷新」时用）
      const force = /(^|[?&])refresh=1(&|$)/.test(url.search || '')
      return await handleModels(res, { force })
    }

    // ---- 图片素材源适配层（generated / local / s3 / lsky / smms） ----
    if (p === '/__gw/assets' || p.startsWith('/__gw/assets/')) {
      return await handleAssets(req, res, p)
    }

    // ---- 生成图片（bridge image_generation 落盘产物） ----
    if (p === '/__gw/gen-images' && req.method === 'GET') {
      return sendJson(res, 200, { images: listGenImages() })
    }
    if (p === '/__gw/gen-images' && req.method === 'DELETE') {
      const body = await readBody(req).catch(() => ({}))
      if (!body.name || !GEN_IMAGE_RE.test(body.name)) return sendJson(res, 400, { error: 'bad_name' })
      try {
        fs.unlinkSync(path.join(genImagesDir(), body.name))
        pushLog('● 已删除生成图片：' + body.name)
        return sendJson(res, 200, { ok: true })
      } catch (e) {
        return sendJson(res, 404, { error: 'not_found', detail: e.message })
      }
    }
    if (p.startsWith('/__gw/gen-images/') && req.method === 'GET') {
      const name = decodeURIComponent(p.slice('/__gw/gen-images/'.length))
      if (!GEN_IMAGE_RE.test(name)) return sendJson(res, 400, { error: 'bad_name' })
      try {
        // 与 /__gw/assets/file 一致：ETag 条件请求，避免图库轮询反复全量下载原图
        const full = path.join(genImagesDir(), name)
        const st = fs.statSync(full)
        const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`
        const inm = req.headers['if-none-match']
        if (inm && inm.split(',').some((t) => t.trim() === etag)) {
          res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' })
          return res.end()
        }
        const buf = fs.readFileSync(full)
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Content-Length': buf.length,
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache',
          ETag: etag
        })
        return res.end(buf)
      } catch {
        return sendJson(res, 404, { error: 'not_found' })
      }
    }
    if (p === '/__gw/strict-auth' && req.method === 'GET') {
      return sendJson(res, 200, { enabled: !!gwConfig.strictAuth, enforced: LAN_ENABLED || !!gwConfig.strictAuth })
    }
    if (p === '/__gw/strict-auth' && req.method === 'POST') {
      const body = await readBody(req).catch(() => ({}))
      gwConfig.strictAuth = !!body.enabled
      saveConfig(gwConfig)
      if (LAN_ENABLED) {
        pushLog(gwConfig.strictAuth
          ? '● 严格鉴权已开启（局域网模式下本就强制生效）'
          : '● 严格鉴权开关已关闭（局域网模式下 /v1 仍强制鉴权，不受影响）')
      } else {
        pushLog(gwConfig.strictAuth
          ? '● 严格鉴权已开启：/v1 必须携带有效 cgw- API Key'
          : '● 严格鉴权已关闭：未带 key 的 /v1 请求放行（不进按 key 统计）')
      }
      return sendJson(res, 200, { ok: true, enabled: gwConfig.strictAuth, enforced: LAN_ENABLED || !!gwConfig.strictAuth })
    }
    if (p === '/__gw/config' && req.method === 'GET') {
      return sendJson(res, 200, {
        launcherPort: LAUNCHER_PORT,
        bridgePort: BRIDGE_PORT,
        bridgeUrl: BRIDGE_URL,
        frontendDir: FRONTEND_DIR,
        autoStart: AUTOSTART,
        mode: gwConfig.mode,
        authFilePath: gwConfig.authFilePath,
        strictAuth: !!gwConfig.strictAuth,
        hasApiKey: !!(gwConfig.mode === 'openai' && gwConfig.openaiApiKey),
        proxy: gwConfig.proxy || '',
        proxyEnabled: !!gwConfig.proxy,
        proxyAvailable: getProxyInfo().available,
        lan: {
          enabled: LAN_ENABLED,
          listenHost: LISTEN_HOST,
          port: LAUNCHER_PORT,
          addresses: LAN_ENABLED ? lanAddresses() : [],
          authRequired: LAN_ENABLED || !!gwConfig.strictAuth,
          controlPlaneLocalOnly: LAN_ENABLED
        }
      })
    }

    // ---- 出网代理（与 engine.js 对称；bridge 为子进程，需重启以应用） ----
    if (p === '/__gw/proxy' && req.method === 'GET') {
      return sendJson(res, 200, { ...getProxyInfo(), configured: gwConfig.proxy || '' })
    }
    if (p === '/__gw/proxy' && req.method === 'POST') {
      try {
        const body = await readBody(req).catch(() => ({}))
        const r = await applyProxy(body.proxy || '')
        if (!r.ok) return sendJson(res, 400, { error: 'proxy_failed', detail: r.error })
        gwConfig.proxy = r.url || ''
        saveConfig(gwConfig)
        pushLog(gwConfig.proxy ? '● 出网代理已启用：' + gwConfig.proxy : '● 出网代理已关闭（直连）')
        // 子进程需重新拉起才能注入新的代理预加载
        if (child) {
          child.kill('SIGTERM')
          setTimeout(() => startBridge(), 400)
        }
        return sendJson(res, 200, { ok: true, url: gwConfig.proxy, enabled: !!gwConfig.proxy })
      } catch (e) {
        return sendJson(res, 400, { error: 'proxy_failed', detail: e.message })
      }
    }
    if (p === '/__gw/proxy/test' && req.method === 'POST') {
      try {
        const body = await readBody(req).catch(() => ({}))
        return sendJson(res, 200, await testProxy(body.proxy === undefined ? gwConfig.proxy : body.proxy))
      } catch (e) {
        return sendJson(res, 400, { error: 'proxy_test_failed', detail: e.message })
      }
    }

    // ---- 授权管理（多模式） ----
    // OAuth 授权完成后的统一收尾：落到待授权卡片（若指定）或新建账号，并重启 bridge
    async function finishOAuthLogin(tokens, { pendingId, name } = {}) {
      const acct = pendingId
        ? await completePendingAccount(pendingId, tokens, { name, provider: 'oauth', mode: 'bridge' })
        : await addAccount({ name, provider: 'oauth', mode: 'bridge', data: tokens })
      gwConfig.authFilePath = acct.path
      saveConfig(gwConfig)
      pushLog(acct.isExisting
        ? '● OAuth 授权完成，已更新现有账号：' + acct.path
        : '● OAuth 授权完成，已建档：' + acct.path)
      if (gwConfig.mode === 'bridge' && child) {
        stopBridge()
        setTimeout(() => startBridge(), 300)
      }
      return acct
    }

    if (p === '/__gw/auth/state' && req.method === 'GET') {
      // bridge 0.3.0 的 /health 没有 checks[]，登录态以本地 auth 文件解析为准；
      // bridge auth.loaded 仅作辅助参考
      const [h, summary] = await Promise.all([fetchBridgeHealth(), Promise.resolve(getActiveAccountSummary())])
      let account = summary
      if (gwConfig.mode === 'bridge' && h.data?.auth && !summary.loggedIn) {
        account = { ...summary, detail: h.data.auth.loaded ? summary.detail : (h.data.error || '凭据未加载，请重新授权') }
      }
      return sendJson(res, 200, {
        mode: gwConfig.mode,
        authFilePath: gwConfig.authFilePath,
        hasApiKey: !!gwConfig.openaiApiKey,
        account
      })
    }
    if (p === '/__gw/auth/save' && req.method === 'POST') {
      try {
        const body = await readBody(req)
        const raw = body.json
        if (!raw) return sendJson(res, 400, { error: 'missing json' })
        const data = normalizeAuthJson(typeof raw === 'string' ? JSON.parse(raw) : raw)
        const filePath = gwConfig.authFilePath || defaultAuthFilePath()
        await writeAuthFile(filePath, data)
        pushLog('● 已写入 auth 文件：' + filePath)
        // bridge 模式下重启以加载新登录态
        if (gwConfig.mode === 'bridge' && child) {
          stopBridge()
          setTimeout(() => startBridge(), 300)
        }
        return sendJson(res, 200, { ok: true, path: filePath, auth_mode: data.auth_mode })
      } catch (e) {
        return sendJson(res, 400, { error: 'save_failed', detail: e.message })
      }
    }
    if (p === '/__gw/auth/device/start' && req.method === 'POST') {
      try {
        const info = await startDeviceFlow()
        return sendJson(res, 200, info)
      } catch (e) {
        return sendJson(res, 502, { error: 'device_start_failed', detail: e.message })
      }
    }
    if (p === '/__gw/auth/device/poll' && req.method === 'POST') {
      try {
        const body = await readBody(req).catch(() => ({}))
        const r = await pollDeviceFlow()
        if (r.pending) return sendJson(res, 200, { pending: true })
        // 设备流成功 → 落到待授权卡片（若指定）或新建 OAuth 账号，并激活
        const acct = await finishOAuthLogin(r.tokens, body)
        return sendJson(res, 200, { ok: true, accountId: acct.id, path: acct.path })
      } catch (e) {
        return sendJson(res, 400, { error: 'device_poll_failed', detail: e.message })
      }
    }
    // ---- 浏览器回调登录（Authorization Code + PKCE + loopback） ----
    if (p === '/__gw/auth/browser/start' && req.method === 'POST') {
      try {
        const info = await startBrowserLogin()
        pushLog('● 浏览器登录已发起，回调端口：' + info.port + (info.portDrifted ? `（1455 被占用，已漂移；原始约定为 ${info.preferredPort}）` : ''))
        if (info.warning) pushLog('⚠ ' + info.warning)
        return sendJson(res, 200, info)
      } catch (e) {
        return sendJson(res, 502, { error: 'browser_start_failed', detail: e.message })
      }
    }
    if (p === '/__gw/auth/browser/poll' && req.method === 'POST') {
      try {
        const body = await readBody(req).catch(() => ({}))
        const r = await pollBrowserLogin()
        if (r.pending) return sendJson(res, 200, { pending: true, info: getBrowserLoginInfo() })
        const acct = await finishOAuthLogin(r.tokens, body)
        return sendJson(res, 200, { ok: true, accountId: acct.id, path: acct.path })
      } catch (e) {
        return sendJson(res, 400, { error: 'browser_poll_failed', detail: e.message })
      }
    }
    if (p === '/__gw/auth/browser/callback' && req.method === 'POST') {
      try {
        const body = await readBody(req)
        const r = await submitBrowserCallback(body.callbackUrl)
        const acct = await finishOAuthLogin(r.tokens, body)
        return sendJson(res, 200, { ok: true, accountId: acct.id, path: acct.path })
      } catch (e) {
        return sendJson(res, 400, { error: 'browser_callback_failed', detail: e.message })
      }
    }
    if (p === '/__gw/auth/browser/cancel' && req.method === 'POST') {
      cancelBrowserLogin()
      return sendJson(res, 200, { ok: true })
    }
    if (p === '/__gw/auth/mode' && req.method === 'POST') {
      try {
        const body = await readBody(req)
        const cfg = await applyMode(body.mode, body.apiKey)
        return sendJson(res, 200, { ok: true, mode: cfg.mode, hasApiKey: !!cfg.openaiApiKey })
      } catch (e) {
        return sendJson(res, 400, { error: 'mode_failed', detail: e.message })
      }
    }

    // ---- 多账号管理 ----
    if (p === '/__gw/accounts' && req.method === 'GET') {
      const reg = loadAccounts()
      const list = reg.accounts.map((a) => ({
        ...a,
        active: a.id === reg.activeId,
        hasAuth: fs.existsSync(accountAuthPath(a.id))
      }))
      return sendJson(res, 200, { activeId: reg.activeId, accounts: list })
    }
    if (p === '/__gw/accounts' && req.method === 'POST') {
      try {
        const body = await readBody(req)
        const raw = body.json
        if (!raw) return sendJson(res, 400, { error: 'missing json' })
        const data = normalizeAuthJson(typeof raw === 'string' ? JSON.parse(raw) : raw)
        const acct = await addAccount({
          name: body.name,
          provider: body.provider || (data.auth_mode === 'api_key' ? 'apikey' : 'token'),
          mode: 'bridge',
          data
        })
        gwConfig.authFilePath = acct.path
        saveConfig(gwConfig)
        pushLog('● 已添加账号：' + acct.path)
        if (gwConfig.mode === 'bridge' && child) {
          stopBridge()
          setTimeout(() => startBridge(), 300)
        }
        return sendJson(res, 200, { ok: true, accountId: acct.id, activeId: acct.reg.activeId })
      } catch (e) {
        return sendJson(res, 400, { error: 'add_account_failed', detail: e.message })
      }
    }
    if (p === '/__gw/accounts/pending' && req.method === 'POST') {
      try {
        const body = await readBody(req)
        const r = addPendingAccount({
          name: body.name,
          email: body.email,
          note: body.note,
          provider: body.provider || 'oauth'
        })
        pushLog('● 已保存待授权卡片：' + (body.email || body.name || r.id))
        return sendJson(res, 200, { ok: true, accountId: r.id })
      } catch (e) {
        return sendJson(res, 400, { error: 'add_pending_failed', detail: e.message })
      }
    }
    if (p === '/__gw/accounts/activate' && req.method === 'POST') {
      try {
        const body = await readBody(req)
        const r = setActiveAccount(body.id)
        gwConfig.authFilePath = r.path
        saveConfig(gwConfig)
        pushLog('● 切换激活账号：' + r.path)
        if (gwConfig.mode === 'bridge' && child) {
          stopBridge()
          setTimeout(() => startBridge(), 300)
        }
        return sendJson(res, 200, { ok: true, path: r.path })
      } catch (e) {
        return sendJson(res, 400, { error: 'activate_failed', detail: e.message })
      }
    }
    if (p === '/__gw/accounts/rename' && req.method === 'POST') {
      try {
        const body = await readBody(req)
        if (!body.id) return sendJson(res, 400, { error: 'missing id' })
        const r = renameAccount(body.id, { name: body.name, note: body.note })
        pushLog('● 已重命名账号：' + r.account.name)
        return sendJson(res, 200, { ok: true, account: r.account })
      } catch (e) {
        return sendJson(res, 400, { error: 'rename_failed', detail: e.message })
      }
    }
    if (p === '/__gw/accounts' && req.method === 'DELETE') {
      try {
        const body = await readBody(req)
        const r = removeAccount(body.id)
        gwConfig.authFilePath = r.path || defaultAuthFilePath()
        saveConfig(gwConfig)
        pushLog('● 已删除账号，当前激活：' + (r.activeId || '无'))
        if (gwConfig.mode === 'bridge' && child) {
          stopBridge()
          setTimeout(() => startBridge(), 300)
        }
        return sendJson(res, 200, { ok: true, activeId: r.activeId })
      } catch (e) {
        return sendJson(res, 400, { error: 'remove_failed', detail: e.message })
      }
    }

    // ---- API Key 管理 ----
    //   GET    /__gw/apikeys          列出所有 key（永不返回 hash / 明文）
    //   GET    /__gw/apikeys/reveal   按 id 单条取明文（用户点「复制」时调用一次）
    //   POST   /__gw/apikeys          创建 key，返回明文 token 仅一次
    //   DELETE /__gw/apikeys          按 { id } 删除
    if (p === '/__gw/apikeys' && req.method === 'GET') {
      return sendJson(res, 200, { keys: listApiKeys() })
    }
    // 单条明文：前端仅在用户明确点击「复制」时调用，不进轮询路径
    if (p === '/__gw/apikeys/reveal' && req.method === 'GET') {
      const id = new URL(req.url, 'http://localhost').searchParams.get('id') || ''
      const r = revealApiKey(id)
      return sendJson(res, r.ok ? 200 : 404, r)
    }
    if (p === '/__gw/apikeys' && req.method === 'POST') {
      try {
        const body = await readBody(req).catch(() => ({}))
        const reg = loadAccounts()
        // accountIds：
        //   - 不传 / 空数组 / ['*']  表示「全部账号」（跟随当前激活账号）
        //   - ['acc_xxx', ...]       表示「指定账号」，请求时自动切换
        let accountIds = body.accountIds
        if (body.accountId && (!accountIds || accountIds.length === 0)) {
          accountIds = [body.accountId]
        }
        accountIds = Array.isArray(accountIds) ? accountIds.filter(Boolean) : null
        if (accountIds && accountIds.length > 0) {
          const unknown = accountIds.find((id) => !reg.accounts.find((a) => a.id === id))
          if (unknown) {
            return sendJson(res, 400, { error: 'unknown_account', detail: unknown })
          }
        }
        const k = createApiKey({ name: body.name, accountIds })
        const scopeLabel = k.accountIds && k.accountIds.length > 0
          ? `指定账号（${k.accountIds.length} 个）`
          : '全部账号'
        pushLog(`● 已创建 API Key：${k.name}（${scopeLabel}）`)
        return sendJson(res, 200, { ok: true, key: k })
      } catch (e) {
        return sendJson(res, 400, { error: 'create_failed', detail: e.message })
      }
    }
    if (p === '/__gw/apikeys' && req.method === 'DELETE') {
      try {
        const body = await readBody(req)
        if (!body.id) return sendJson(res, 400, { error: 'missing id' })
        const r = deleteApiKey(body.id)
        if (!r.ok) return sendJson(res, 404, r)
        pushLog('● 已删除 API Key：' + body.id)
        return sendJson(res, 200, { ok: true })
      } catch (e) {
        return sendJson(res, 400, { error: 'delete_failed', detail: e.message })
      }
    }

    return sendJson(res, 404, { error: 'unknown_control' })
  }

  // ---- 模型列表：目录兜底 + 上游并集（先于 /v1/* 通用反代） ----
  if (p === '/v1/models' && req.method === 'GET') {
    if (strictAuthReject(req, res, p)) return
    const mT0 = Date.now()
    return await handleModels(res).finally(() => {
      recordCallLog({ method: 'GET', endpoint: '/v1/models', model: '—', status: res.statusCode || 0, latency: Date.now() - mT0, tokens: null })
    })
  }

  // ---- 反向代理到 bridge ----
  // 在此之前先做 API Key 鉴权：如果 Authorization 是 cgw-...，验证后按 key 绑定的账号
  // 热切换 bridge，并原样转发 /v1/*（bridge 会用其内部 auth 头覆盖客户端 auth）。
  if (p.startsWith('/v1/') || p === '/health') {
    if (p.startsWith('/v1/') && strictAuthReject(req, res, p)) return
    const token = extractBearerToken(req.headers['authorization'])
    let authKeyId = null
    let authOwner = null
    if (token) {
      const v = verifyApiKey(token)
      if (!v.ok) {
        recordCallLog({ method: req.method, endpoint: p.split('?')[0], model: '—', status: 401, latency: 0, tokens: null })
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' })
        return res.end(JSON.stringify({ error: 'invalid_api_key', reason: v.reason }))
      }
      authKeyId = v.keyId
      authOwner = { keyId: v.keyId, keyName: v.name }
      const reg = loadAccounts()
      const targetAccountId = resolveKeyAccountId(v.accountIds, reg.activeId)
      if (targetAccountId && gwConfig.mode === 'bridge') {
        const sw = await ensureBridgeForAccount(targetAccountId)
        if (!sw.ok) {
          res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' })
          return res.end(JSON.stringify({ error: 'bridge_switch_failed', detail: sw.msg }))
        }
      } else if (targetAccountId && gwConfig.mode === 'openai') {
        // API Key + openai 直连模式没有"账号"概念，忽略
      }
    }
    // ---- 分用户素材站 API（/v1 域内，Bearer 鉴权，按 Key 隔离；网页版见 /gallery）----
    if (p === '/v1/gen-images/me' && req.method === 'GET') {
      if (!authKeyId) return sendJson(res, 401, { ok: false, error: 'api_key_required' })
      const all = scopedGenImages(authKeyId)
      const meta = listApiKeys().find((k) => k.id === authKeyId) || {}
      const hostHeader = req.headers.host || `127.0.0.1:${LAUNCHER_PORT}`
      return sendJson(res, 200, {
        ok: true,
        keyId: authKeyId,
        keyName: authOwner?.keyName || meta.name || '(未命名)',
        createdAt: meta.createdAt || null,
        lastUsedAt: meta.lastUsedAt || null,
        images: all.length,
        bytes: all.reduce((s, i) => s + (i.size || 0), 0),
        setup: `http://${hostHeader}/setup`,
        gallery: `http://${hostHeader}/gallery`
      })
    }
    if (p === '/v1/gen-images/list' && req.method === 'GET') {
      const hostHeader = req.headers.host || `127.0.0.1:${LAUNCHER_PORT}`
      const all = scopedGenImages(authKeyId)
      const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 100))
      const images = all.slice(0, limit).map((i) => ({
        ...i,
        url: `http://${hostHeader}/__gw/gen-images/${i.name}`,
        local_path: path.join(genImagesDir(), i.name)
      }))
      return sendJson(res, 200, { ok: true, total: all.length, images, gallery: `http://${hostHeader}/gallery` })
    }
    if (p.startsWith('/v1/gen-images/') && req.method === 'DELETE') {
      const name = decodeURIComponent(p.slice('/v1/gen-images/'.length))
      const r = deleteGenImage(name, authKeyId)
      recordCallLog({ method: 'DELETE', endpoint: p.split('?')[0], model: '—', status: r.ok ? 200 : (r.error === 'not_owner_or_not_found' ? 403 : 400), latency: 0, tokens: null })
      if (!r.ok) return sendJson(res, r.error === 'not_owner_or_not_found' ? 403 : 400, { ok: false, error: r.error })
      pushLog('🗑 素材站删除（分用户）：' + name)
      return sendJson(res, 200, { ok: true })
    }

    return proxy(req, res, p + (url.search || ''), authKeyId, authOwner)
  }

  // ---- 静态前端 ----
  return serveStatic(req, res, p)
})

// restart 的异步结果队列（简化：直接写入 logs 即可，status 会反映最新）
const sendControlQueue = []
setInterval(() => {
  while (sendControlQueue.length) {
    const r = sendControlQueue.shift()
    pushLog(r.ok ? '▶ bridge 已重启' : '✗ bridge 重启失败：' + (r.msg || ''))
  }
}, 200)

server.listen(LAUNCHER_PORT, LISTEN_HOST, () => {
  pushLog(`◆ 启动器已就绪：http://127.0.0.1:${LAUNCHER_PORT}`)
  if (LAN_ENABLED) {
    pushLog(`◆ 局域网模式已开启：监听 ${LAN_HOST}:${LAUNCHER_PORT}`)
    pushLog('  · 控制面 /__gw/* 仅限本机访问（账号/密钥/配置不外泄）')
    pushLog('  · /v1/* 强制 cgw- API Key 鉴权')
    for (const a of lanAddresses()) {
      pushLog(`  · 局域网接入地址：http://${a.address}:${LAUNCHER_PORT}/v1  (${a.name})`)
    }
    pushLog('  · 提醒：Windows 防火墙需放行该端口（首次启动会弹窗询问）')
  }
  if (AUTOSTART) {
    const r = startBridge()
    if (!r.ok) pushLog('⚠ 自动启动失败：' + (r.msg || ''))
  } else {
    pushLog('· 自动启动已禁用（DISABLE_AUTOSTART=1）')
  }
})
