#!/usr/bin/env node
// codex-gateway · 上线前 AI 安全审计 —— 回归测试网（指南第三步）
//
// 把高风险功能的三类用例（正常 / 边界 / 异常）固化为一条命令。
// 设计约束：
//   1. 零依赖（纯 node 内置模块），node audit.mjs 即可跑。
//   2. **不只看状态码** —— 每个用例都断言响应内容。
//      反面教材：静态站 SPA fallback 会让任何未知路径都返回 200 index.html，
//      只看状态码会把「路径穿越成功」误判成通过。
//   3. 破坏性用例只应打隔离沙盒（4199），禁止打承载真实凭据的实例。
//
// 用法：
//   node audit.mjs                                  # 打沙盒 http://127.0.0.1:4199
//   node audit.mjs --readonly --base=http://127.0.0.1:4173   # 线上实例：只跑只读用例

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { HEALTH_ALIVE_STATUSES } from './lib/health.mjs'
const require = createRequire(import.meta.url)

function argOf(name) {
  const hit = process.argv.find((a) => a.startsWith(name + '='))
  return hit ? hit.slice(name.length + 1) : ''
}
const BASE = (argOf('--base') || 'http://127.0.0.1:4199').replace(/\/+$/, '')
const READONLY = process.argv.includes('--readonly')
const GEN_DIR = argOf('--gendir') || path.resolve('.', 'home', '.chatgpt-bridge', 'gen-images')
// 控制面管理令牌（F-01 后新增）：run.sh 会把沙盒的 admin-token.json 路径传进来。
// 只给 /__gw/* 带上，不能污染 /v1 —— 那边要测的正是「没有 cgw- Key」。
const ADMIN_TOKEN = (() => {
  const f = argOf('--tokenfile')
  if (!f) return ''
  try { return JSON.parse(fs.readFileSync(f, 'utf8')).token || '' } catch { return '' }
})()

// ---------------- 极简断言框架 ----------------
let pass = 0, fail = 0
const results = []
let group = ''
const C = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', x: '\x1b[0m' }

function G(name) { group = name; console.log(`\n${C.y}${name}${C.x}`) }
async function T(name, fn) {
  try {
    await fn()
    pass++; results.push({ type: 'pass', group, name })
    console.log(`  ${C.g}✓${C.x} ${name}`)
  } catch (e) {
    fail++; results.push({ type: 'fail', group, name, msg: e.message })
    console.log(`  ${C.r}✗${C.x} ${name}\n      ${C.r}${e.message}${C.x}`)
  }
}
function note(key, msg) { results.push({ type: 'note', group, name: key, msg }) }
function ok(cond, msg) { if (!cond) throw new Error(msg || '断言失败') }
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || '值不相等'}：期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`)
}

// ---------------- HTTP helper ----------------
async function req(p, opts = {}) {
  const { method = 'GET', headers = {}, body, rawText, timeout = 8000 } = opts
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeout)
  const isControl = p.startsWith('/__gw/')
  const admin = isControl && ADMIN_TOKEN ? { Authorization: 'Bearer ' + ADMIN_TOKEN } : {}
  try {
    const res = await fetch(BASE + p, {
      method,
      headers: { ...admin, ...(rawText !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: rawText !== undefined ? rawText : (body === undefined ? undefined : JSON.stringify(body)),
      signal: ac.signal
    })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch {}
    return { status: res.status, headers: Object.fromEntries(res.headers.entries()), text, json }
  } catch (e) {
    return { status: 0, headers: {}, text: '', json: null, err: String(e.message || e) }
  } finally { clearTimeout(timer) }
}

// fetch/undici 禁止覆写 Host 头，而 Host/Referer 伪造正是 CSRF 与
// DNS-rebinding 用例的核心手段 —— 必须走原始 socket 才能发得出去。
function rawSend(method, p, headers = {}, bodyBuf = null) {
  const u = new URL(BASE)
  const http = u.protocol === 'https:' ? require('node:https') : require('node:http')
  return new Promise((resolve) => {
    const r = http.request(
      { host: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), method, path: p, headers },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json = null
          try { json = JSON.parse(text) } catch {}
          resolve({ status: res.statusCode, text, json, headers: res.headers })
        })
      }
    )
    r.on('error', (e) => resolve({ status: 0, text: '', json: null, err: String(e.message || e) }))
    r.setTimeout(8000, () => { r.destroy(); resolve({ status: 0, text: '', json: null, err: 'timeout' }) })
    if (bodyBuf) r.write(bodyBuf)
    r.end()
  })
}

let INDEX_SIZE = -1
async function learnIndexFallback() {
  const r = await req('/__gw_impossible_path_xyz__')
  if (r.status === 200) INDEX_SIZE = r.text.length
}
// 静态站 SPA fallback：未知路径返回同一份 index.html（同样的长度）。
// 判定「是否真的拿到文件」必须排除它。
function isIndexHtml(r) {
  return r.status === 200 && INDEX_SIZE > 0 && r.text.length === INDEX_SIZE && /<!DOCTYPE html>/i.test(r.text)
}

// ---------------- 夹具 ----------------
let KEY_A = null, KEY_B = null, KEY_C = null
const A_IMG = 'aaaaaaaaaaa_A0000001.png'
const B_IMG = 'bbbbbbbbbbb_B0000002.png'
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'
)
// index.json 归属记录：模拟「历史生成图」，A/B 各一张
function seedImages(ids) {
  fs.mkdirSync(GEN_DIR, { recursive: true })
  fs.writeFileSync(path.join(GEN_DIR, A_IMG), PNG_1PX)
  fs.writeFileSync(path.join(GEN_DIR, B_IMG), PNG_1PX)
  const idx = { [A_IMG]: { keyId: ids.A, keyName: 'audit-A', createdAt: Date.now() }, [B_IMG]: { keyId: ids.B, keyName: 'audit-B', createdAt: Date.now() } }
  fs.writeFileSync(path.join(GEN_DIR, 'index.json'), JSON.stringify(idx))
}

async function setup() {
  await learnIndexFallback()
  const st = await req('/__gw/status')
  ok(st.json, `目标不可达或非网关实例：GET /__gw/status → HTTP ${st.status}。请先启动沙盒实例`)
  console.log(`${C.d}  目标 ${BASE}  mode=${st.json.mode}  LAN=${st.json.lan?.enabled}  鉴权强制=${st.json.lan?.authRequired}${C.x}`)
  if (READONLY) { console.log(`${C.d}  只读模式：跳过所有会改数据的用例${C.x}`); return }
  const mk = async (name) => (await req('/__gw/apikeys', { method: 'POST', body: { name } })).json?.key
  const a = await mk('audit-A'), b = await mk('audit-B'), c = await mk('audit-C')
  KEY_A = a?.token; KEY_B = b?.token; KEY_C = c?.token
  ok(KEY_A && KEY_B && KEY_C, '夹具创建失败：未能拿到三个测试 key 明文')
  seedImages({ A: a.id, B: b.id })
}
const auth = (k) => ({ Authorization: 'Bearer ' + k })

// =====================================================================
await setup()

G('K1 · API Key 鉴权（权限）')
await T('正常：有效 key 通过鉴权（非 401）', async () => {
  const r = await req('/v1/models', { headers: auth(KEY_A) })
  ok(r.status !== 401, `有效 key 被拒：HTTP ${r.status} ${r.text.slice(0, 100)}`)
  ok(r.json?.error !== 'invalid_api_key', '有效 key 被判为无效')
})
await T('异常：无 key 访问 /v1/models → 401 missing_api_key', async () => {
  const r = await req('/v1/models')
  eq(r.status, 401, '未鉴权请求未被拦截')
  eq(r.json?.error, 'missing_api_key', '错误类型不符')
})
// —— 错误码语义（原 F-05，已修复）——
// 修复前：有无凭据一律返回 missing_api_key，用户配错 key 会被提示成"忘记带 key"。
// 修复后必须区分「没带」与「带错了」，且三档失败原因要能指导排查。
await T('异常：伪造 cgw- key（不在登记表）→ 401 invalid_api_key/not_found', async () => {
  const r = await req('/v1/models', { headers: auth('cgw-AAAAAAAAAAAAAAAAAAAAAAAAAAAA') })
  eq(r.status, 401, '伪造 key 竟然通过鉴权')
  eq(r.json?.error, 'invalid_api_key', '带了凭据却被报成 missing，语义仍然丢失')
  eq(r.json?.reason, 'not_found', '未保留细分原因')
  ok(r.json?.message, '缺少可操作文案 message')
})
await T('异常：非 cgw- 前缀（误贴 OpenAI sk-）→ 401 invalid_api_key/bad_prefix', async () => {
  const r = await req('/v1/models', { headers: auth('sk-proj-fake-1234567890') })
  eq(r.status, 401)
  eq(r.json?.error, 'invalid_api_key')
  eq(r.json?.reason, 'bad_prefix')
  ok(r.json?.hint, '缺少可用于自助排查的 hint 字段')
})
await T('异常：已从登记表删除的 key → 401 invalid_api_key/not_found', async () => {
  const made = (await req('/__gw/apikeys', { method: 'POST', body: { name: 'audit-deleted' } })).json?.key
  ok(made?.token, '夹具失败：未能拿到明文')
  const before = await req('/v1/models', { headers: auth(made.token) })
  ok(before.status !== 401, '前置失败：新建的 key 应可用')
  const entry = (await req('/__gw/apikeys')).json.keys.find((k) => k.name === 'audit-deleted')
  await req('/__gw/apikeys', { method: 'DELETE', body: { id: entry.id } })
  const r = await req('/v1/models', { headers: auth(made.token) })
  eq(r.status, 401, '已删除的 key 仍可访问 /v1')
  eq(r.json?.reason, 'not_found')
})
await T('反例：无凭据 → 401 missing_api_key（不得与"凭据无效"混为一谈）', async () => {
  for (const h of [{}, { Authorization: KEY_A }, { Authorization: 'Bearer ' }]) {
    const r = await req('/v1/models', { headers: h })
    eq(r.status, 401, `异常凭据通过鉴权：${JSON.stringify(h).slice(0, 40)}`)
    eq(r.json?.error, 'missing_api_key', `未提供凭据却被报成 ${r.json?.error}`)
  }
})
await T('边界：大小写变形 / 截断 / 末位篡改 / 前缀剥离 均不绕过', async () => {
  for (const t of [KEY_A.toUpperCase(), KEY_A.slice(0, -1) + 'X', KEY_A.slice(0, 14), KEY_A.slice(4)]) {
    const r = await req('/v1/models', { headers: auth(t) })
    eq(r.status, 401, `变形 token 竟然通过：${String(t).slice(0, 16)}…`)
  }
})
// 反例容器：以下「看似通过」的行为是**合规**的，不能当成漏洞放行。
await T('反例：Bearer 后多余空白被视为有效（RFC 7235 OWS，非漏洞）', async () => {
  for (const t of [' ' + KEY_A, KEY_A + ' ', '\t' + KEY_A]) {
    const r = await req('/v1/models', { headers: auth(t) })
    ok(r.status !== 401, `Header OWS 未按标准处理：${JSON.stringify(t.slice(0, 8))}…`)
  }
  note('OK-ows', 'Bearer 前后空白按 RFC 7235 OWS 归一化，属合规行为；已固化为测试防止后续"修复"误伤')
})
await T('正常：删除 key 后凭据立即失效（权限回收）', async () => {
  const before = await req('/v1/models', { headers: auth(KEY_C) })
  ok(before.status !== 401, '前置失败：C 原本应可用')
  const list = await req('/__gw/apikeys')
  const entry = list.json.keys.find((k) => k.name === 'audit-C')
  const del = await req('/__gw/apikeys', { method: 'DELETE', body: { id: entry.id } })
  eq(del.status, 200, '删除接口异常')
  const after = await req('/v1/models', { headers: auth(KEY_C) })
  eq(after.status, 401, '已删除的 key 仍可访问 /v1')
})

G('K2 · 跨 Key 数据隔离（数据）')
await T('正常：A 只能看到自己那张图', async () => {
  const r = await req('/v1/gen-images/list', { headers: auth(KEY_A) })
  eq(r.status, 200)
  eq(r.json.total, 1, 'A 可见图数不对——要么越权看到别人的，要么夹具没生效')
  eq(r.json.images[0].name, A_IMG)
})
await T('正常：B 只能看到自己那张图', async () => {
  const r = await req('/v1/gen-images/list', { headers: auth(KEY_B) })
  eq(r.json.total, 1)
  eq(r.json.images[0].name, B_IMG)
})
await T('异常：A 删 B 的图 → 403，且文件仍在磁盘上', async () => {
  const r = await req('/v1/gen-images/' + B_IMG, { method: 'DELETE', headers: auth(KEY_A) })
  eq(r.status, 403, `越权删除未被拦截：HTTP ${r.status} ${r.text.slice(0, 80)}`)
  ok(fs.existsSync(path.join(GEN_DIR, B_IMG)), 'B 的图已被 A 实际删除')
})
await T('正常：A 删自己的图 → 200，且 index.json 记录被清', async () => {
  const r = await req('/v1/gen-images/' + A_IMG, { method: 'DELETE', headers: auth(KEY_A) })
  eq(r.status, 200, '删除自己的图失败')
  const idx = JSON.parse(fs.readFileSync(path.join(GEN_DIR, 'index.json'), 'utf8'))
  ok(idx[A_IMG] === undefined, 'index.json 未清理归属记录')
  fs.writeFileSync(path.join(GEN_DIR, A_IMG), PNG_1PX) // 复原夹具
  seedImages({
    A: (await req('/__gw/apikeys')).json.keys.find((k) => k.name === 'audit-A').id,
    B: (await req('/__gw/apikeys')).json.keys.find((k) => k.name === 'audit-B').id
  })
})
await T('异常：无 key 调 /v1/gen-images/me → 401', async () => {
  const r = await req('/v1/gen-images/me')
  eq(r.status, 401)
})
await T('边界：删除不存在 / 非法文件名 → 4xx 且不崩', async () => {
  for (const n of ['nope_XYZ.png', '..%2F..%2Fgw-config.json', 'a'.repeat(300) + '.png']) {
    const r = await req('/v1/gen-images/' + n, { method: 'DELETE', headers: auth(KEY_A) })
    ok([400, 403, 404].includes(r.status), `非法文件名 ${n.slice(0, 20)} → HTTP ${r.status}`)
  }
})

G('K3 · 路径穿越与注入（数据）')
const TRAVERSALS = [
  ['..%2F..%2F.gw-config.json', 'URL 编码斜杠'],
  ['%2e%2e%2f%2e%2e%2f.gw-config.json', '小写变体'],
  ['%252e%252e%252f.gw-config.json', '双重编码'],
  ['..%5c..%5c.gw-config.json', '反斜杠变体'],
  ['....//....//.gw-config.json', '点折叠'],
  ['..%00.png', 'NUL 截断'],
  // gen-images 位于 <root>/home/.chatgpt-bridge/gen-images，上溯 3 层才到项目根，
  // 那里放着含 CANARY 金丝雀值的 .gw-config.json 与 api-keys.json。
  // 这两条是专门用来钉死「目录边界校验」的：只要边界失效就会被读到。
  ['..%2F..%2F..%2F.gw-config.json', '配置(上溯3层·金丝雀)'],
  ['..%2F..%2F..%2Fapi-keys.json', '密钥注册表(上溯3层)'],
]
// 任何响应里出现金丝雀值 = 发生了真实泄露（沙盒专属，线上不存在该值）
const CANARY = 'CANARY-SECRET-DO-NOT-LEAK'
function noLeak(r, label) {
  ok(!r.text.includes(CANARY), `${label}：读到了金丝雀机密值（真实泄露）`)
  ok(!/"openaiApiKey"|"authFilePath"|\[fonts\]/.test(r.text), `${label}：疑似泄露配置内容 ${r.text.slice(0, 90)}`)
  ok(!/"keys"\s*:\s*\[/.test(r.text) || !/hash|enc/.test(r.text), `${label}：疑似泄露密钥注册表`)
}
for (const [payload, label] of TRAVERSALS) {
  await T(`异常：assets/file ${label} 不得读出配置/密钥`, async () => {
    const r = await req('/__gw/assets/file?src=generated&n=' + payload)
    noLeak(r, 'assets/file')
    if (r.status === 200) ok(!isIndexHtml(r), '命中 SPA fallback，需人工确认')
    else ok([400, 403, 404].includes(r.status), `意外状态码 ${r.status}`)
  })
  await T(`异常：gen-images ${label} 不得读出配置/密钥`, async () => {
    const r = await req('/__gw/gen-images/' + payload)
    noLeak(r, 'gen-images')
    ok([400, 403, 404].includes(r.status), `意外状态码 ${r.status}`)
  })
}
await T('异常：静态站穿越读不到源码与配置', async () => {
  for (const p of ['/../gateway/api-keys.json', '/..%2F.gw-config.json', '/../../.gw-config.json', '/../../.env']) {
    const r = await req(p)
    ok(!r.text.includes(CANARY) && !/"openaiApiKey"|"keys"\s*:\s*\[/.test(r.text), `静态站泄露：${p}`)
    if (r.status === 200) ok(isIndexHtml(r), `${p} 返回了非首页内容`)
  }
})
await T('异常：原型污染 __proto__ 不改写服务端状态', async () => {
  await req('/__gw/assets/sources', {
    method: 'POST', rawText: '{"name":"__proto__x","type":"local","config":{"dir":"C:\\\\"},"__proto__":{"polluted":"yes"}}'
  })
  const st = await req('/__gw/status')
  ok(st.json?.polluted === undefined, '服务端对象被原型污染')
  ok({}.polluted === undefined, '本地原型受影响')
})
await T('边界：超大参数 / 畸形 JSON / 畸形编码 不打挂进程', async () => {
  await req('/__gw/assets/file?src=generated&n=' + 'a'.repeat(8192) + '.png')
  await req('/__gw/apikeys', { method: 'POST', rawText: '{ not json' })
  await req('/%zz')
  const alive = await req('/health')
  // 200 = bridge 在跑且已登录；503 = 无实例（bridge_not_running）；502 = 实例在但库不可达
  ok(HEALTH_ALIVE_STATUSES.includes(alive.status), `服务失联：HTTP ${alive.status} ${alive.err || ''}`)
})

G('K4 · 敏感信息泄露（数据）')
await T('正常：key 列表永不返回明文或 hash', async () => {
  const dump = JSON.stringify((await req('/__gw/apikeys')).json)
  ok(!/"token"\s*:\s*"cgw-/.test(dump), '列表泄露明文 token')
  ok(!/"hash"\s*:/.test(dump), '列表泄露 hash')
  ok(!/[a-f0-9]{64}/i.test(dump), '响应中出现 sha256 串')
})
await T('正常：/health 不含内部路径与凭据', async () => {
  const r = await req('/health')
  ok(!r.text.includes(CANARY), '健康检查泄露金丝雀机密值')
  ok(!/authFilePath|openaiApiKey|api-keys/i.test(r.text), `健康检查泄露：${r.text.slice(0, 100)}`)
})
// 无实例时若直接透传到虚空，会得到 502 bridge_unreachable——看日志的人分不清
// 「还没启动」和「刚崩了」。要求给出机器可读原因 + 可操作文案。
await T('正常：无实例时 /health 明确报 bridge_not_running，而不是 502 到虚空', async () => {
  const r = await req('/health')
  if (r.status === 200) {
    ok(r.json?.ok === true, '/health 返回 200 但响应体不是 bridge 健康信息')
    note('OK-health', '沙盒里已有运行中的实例，跳过「无实例」分支的断言')
    return
  }
  eq(r.status, 503, `无实例时应返回 503，实际 ${r.status}`)
  eq(r.json?.error, 'bridge_not_running', '缺少机器可读的原因码')
  ok(r.json?.detail && r.json.detail.length > 8, '缺少可操作的处理提示')
})
await T('异常：错误响应不回显绝对路径与堆栈', async () => {
  const r = await req('/__gw/assets/file?src=nope&n=x.png')
  ok(!/C:\\\\Users\\\\|at .*\(.*:\d+:\d+\)/.test(r.text), `错误回显内部信息：${r.text.slice(0, 140)}`)
})
await T('异常：reveal 未知 id → 404 且不吐任何 token', async () => {
  const r = await req('/__gw/apikeys/reveal?id=k_not_exist')
  ok(r.status === 404 || r.json?.ok === false, `意外 HTTP ${r.status}`)
  ok(!/cgw-[A-Za-z0-9_-]{10,}/.test(r.text), '响应含 cgw- 明文')
})

// —— 原 F-02（已修复）——
// 威胁模型：控制面只认本机来源，网络层已拦局域网；但**本机浏览器**可被任意网页驱动
// ——恶意页面用 fetch 直指 127.0.0.1:4173/__gw/*，源 IP 就是回环，网络层看不见。
// 因此补两道应用层闸门：Host 白名单（挡 DNS rebinding）+ Origin 同源（挡 CSRF）。
G('K5 · 来源信任 · Host 与 CSRF（权限）')
await T('异常：伪造 Host 头访问控制面 → 403 host_not_allowed', async () => {
  const r = await rawSend('GET', '/__gw/apikeys', { Host: 'evil.attacker.com:4199' })
  eq(r.status, 403, `DNS-rebinding 面未堵住：HTTP ${r.status}`)
  eq(r.json?.error, 'host_not_allowed')
  ok(!/cgw-[A-Za-z0-9_-]{10,}/.test(r.text), '响应泄露明文 ')
})
// 关键用例：DNS rebinding 时攻击者域名会「同源」——Origin 与 Host 一致，
// 只做 CSRF 检查会被绕过，必须 Host 白名单兜底。
await T('异常：DNS rebinding（Host 与 Origin 同源但非本机）→ 403', async () => {
  const r = await rawSend('GET', '/__gw/apikeys', {
    Host: 'evil.attacker.com:4199',
    Origin: 'http://evil.attacker.com:4199',
    Referer: 'http://evil.attacker.com:4199/'
  })
  eq(r.status, 403, '仅依赖同源校验会被 DNS rebinding 绕过')
  eq(r.json?.error, 'host_not_allowed')
})
await T('异常：跨站 Origin 发起控制面写请求 → 403 cross_origin_denied（CSRF）', async () => {
  const before = (await req('/__gw/apikeys')).json.keys.length
  const r = await rawSend('POST', '/__gw/apikeys',
    { Host: new URL(BASE).host, Origin: 'https://evil.example', 'Content-Type': 'application/json' },
    Buffer.from(JSON.stringify({ name: 'csrf-probe' })))
  eq(r.status, 403, `跨站写请求未被拦截：HTTP ${r.status}`)
  eq(r.json?.error, 'cross_origin_denied')
  const after = (await req('/__gw/apikeys')).json.keys.length
  eq(after, before, '跨站请求真的创建出了 Key —— CSRF 可利用')
})
await T('异常：跨站 Referer（无 Origin）→ 403 cross_origin_denied', async () => {
  const r = await rawSend('GET', '/__gw/apikeys',
    { Host: new URL(BASE).host, Referer: 'https://evil.example/steal.html' })
  eq(r.status, 403, '缺少 Origin 时未回退到 Referer 校验，存在绕过')
  eq(r.json?.error, 'cross_origin_denied')
})
await T('反例：同源 Origin 正常放行（前端 SPA 不受影响）', async () => {
  const host = new URL(BASE).host
  const r = await rawSend('GET', '/__gw/status', {
    Host: host,
    Origin: `http://${host}`,
    Referer: `http://${host}/keys`,
    Authorization: 'Bearer ' + ADMIN_TOKEN // 这里验的是 CSRF 不误伤，凭据本身单独由 K7 覆盖
  })
  ok(r.status === 200, `同源请求被误杀：HTTP ${r.status} ${r.text.slice(0, 90)}`)
  ok(r.json?.mode !== undefined, '响应体异常')
})
await T('反例：无 Origin / 无 Referer 的命令行调用放行（curl / MCP / lan-kit 不受影响）', async () => {
  const r = await req('/__gw/status')
  eq(r.status, 200, '程序化客户端被 CSRF 防护误伤——这会直接搞坏 lan-kit 安装脚本')
})
await T('反例：/health 与静态资源不走控制面守卫（保持对外开放）', async () => {
  const h = await req('/health')
  ok(HEALTH_ALIVE_STATUSES.includes(h.status), `/health 意外 HTTP ${h.status}`)
})

G('K6 · 输入净化 · 显示名（数据）')
// 原 F-06（已修复）。前端虽已全程 textContent 渲染，存 <script> 也不会 XSS，
// 但两类「看着正常实为陷阱」的输入仍必须在后端拦掉：
//   · 控制字符 —— 撑破控制台表格、伪造一行假的 pushLog 误导排查
//   · 零宽 / BiDi 覆写 —— 让两个不同 Key 显示成同名，或让名字倒着显示做界面伪装
await T('异常：显示名中的控制字符被剥离（防日志注入 / UI 撑破）', async () => {
  // 典型日志注入：名字里塞换行再伪造一行管理员操作记录，误导事后排查
  const FORGED = '● 已删除 API Key：k_FORGED_BY_NAME'
  const r = (await req('/__gw/apikeys', { method: 'POST', body: { name: `abc\n${FORGED}\r\t def` } })).json
  ok(r?.key?.name, '创建失败')
  ok(!/[\u0000-\u001f\u007f-\u009f]/.test(r.key.name), `控制字符未被剥离：${JSON.stringify(r.key.name)}`)
  const logs = (await req('/__gw/logs')).json?.lines || []
  // 关键：名字里塞不进换行 → 不可能伪造出独立的一行操作记录
  const forgedLines = logs.filter((l) => /^\d{2}:\d{2}:\d{2}  ● 已删除/.test(String(l).trim()) && l.includes('k_FORGED_BY_NAME'))
  eq(forgedLines.length, 0, `日志被伪造出独立记录行：${JSON.stringify(forgedLines[0])}`)
  eq(r.key.name, 'abc ● 已删除 API Key：k_FORGED_BY_NAME def', '控制字符应塌陷为单个空格而非直接删除（否则词会粘成一坨）')
})
await T('异常：零宽 / BiDi 覆写字符被剥离（防同名伪装）', async () => {
  // U+200B 零宽空格 + U+202E 右到左覆写：UI 上会渲染成 "audit-Adetcejni"，
  // 且零宽字符让两个不同的 Key 可以显示成看起来一样的名字（同名伪装）
  const SPOOFED = 'audit-A' + '\u200b\u202e' + 'injected'
  const r = (await req('/__gw/apikeys', { method: 'POST', body: { name: SPOOFED } })).json
  ok(r?.key?.name, '创建失败')
  ok(!/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/.test(r.key.name), `零宽/BiDi 未被剥离：${JSON.stringify(r.key.name)}`)
  eq(r.key.name, 'audit-Ainjected', '应只剥离隐形字符、保留可见字符')
  // 伪装核心：注入后的名字不能再与已存在的 "audit-A" 视觉同形
  const names = (await req('/__gw/apikeys')).json.keys.map((k) => k.name)
  const visible = names.map((n) => n.replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, ''))
  const dup = visible.filter((n, i) => visible.indexOf(n) !== i)
  eq(dup.length, 0, `存在同名伪装：${dup.map((d) => JSON.stringify(d)).join(', ')}`)
})
await T('边界：超长名被截断到 40；纯空白回落为「未命名」', async () => {
  const long = (await req('/__gw/apikeys', { method: 'POST', body: { name: 'x'.repeat(500) } })).json
  eq(long?.key?.name?.length, 40, '未限长')
  const blank = (await req('/__gw/apikeys', { method: 'POST', body: { name: '   \n\t  ' } })).json
  eq(blank?.key?.name, '未命名', '纯空白未回落到默认名')
})
await T('反例：正常中文名与 emoji 完整保留（不得误伤）', async () => {
  const r = (await req('/__gw/apikeys', { method: 'POST', body: { name: ' 夏冬平的笔记本 🎨  ' } })).json
  eq(r?.key?.name, '夏冬平的笔记本 🎨', '正常名被错误改写')
})

// —— 原 F-01（已修复）——
// 原状：控制面零鉴权，任何能连上回环端口的东西都能直取明文 Key。
// 修复形态对齐 model-gateway：管理令牌 + 一次性登录链接 + 本机会话 Cookie。
// 诚实的边界：同一用户身份的恶意进程仍能读 admin-token.json，防御分不在那里，
// 而在于把门槛从「零」抬到「必须持有令牌」。
G('K7 · 控制面管理鉴权（权限）')
const NO_ADMIN = '/__gw/status'
await T('异常：无凭据访问控制面 → 401 admin_auth_required', async () => {
  for (const p of [NO_ADMIN, '/__gw/apikeys', '/__gw/accounts', '/__gw/config', '/__gw/logs']) {
    const r = await rawSend('GET', p, { Host: new URL(BASE).host })
    eq(r.status, 401, `${p} 竟然无需凭据即可访问`)
    eq(r.json?.error, 'admin_auth_required')
  }
})
await T('异常：普通 cgw- API Key 不能充当管理令牌（凭据不越界）', async () => {
  const r = await rawSend('GET', NO_ADMIN, { Host: new URL(BASE).host, Authorization: 'Bearer ' + KEY_A })
  eq(r.status, 401, '数据面 Key 被当成了控制面凭据')
  // 反向：管理令牌也不能当数据面 Key 用
  const v = await req('/v1/models', { headers: { Authorization: 'Bearer ' + ADMIN_TOKEN } })
  eq(v.status, 401, '管理令牌被 /v1 接受：凭据作用域串了')
  eq(v.json?.reason, 'bad_prefix')
})
await T('正常：管理令牌通过鉴权，可取控制面数据', async () => {
  const r = await rawSend('GET', NO_ADMIN, { Host: new URL(BASE).host, Authorization: 'Bearer ' + ADMIN_TOKEN })
  eq(r.status, 200)
  ok(r.json?.mode !== undefined, '响应体异常')
})
await T('异常：伪造/篡改会话 Cookie 被拒', async () => {
  const host = new URL(BASE).host
  const cases = [
    ['cgw_session=notavalidsession', '整体乱码'],
    ['cgw_session=a.b.c.forged', '结构不符'],
    ['cgw_session=', '空值'],
    // 关键：这条的「过期时间」是合法的，只有签名是错的。
    // 若只测上面三条，会被过期校验顺手挡住，从而漏掉签名校验失效这类缺陷。
    [`cgw_session=deadbeef.${Date.now() + 3600_000}.${'a'.repeat(64)}`, '未来过期 + 伪造签名'],
    [`cgw_session=deadbeef.${Date.now() - 3600_000}.${'a'.repeat(64)}`, '已过期（无论签名如何）']
  ]
  for (const [cookie, label] of cases) {
    const r = await rawSend('GET', NO_ADMIN, { Host: host, Cookie: cookie })
    eq(r.status, 401, `伪造 Cookie 通过了鉴权（${label}）：${cookie.slice(0, 48)}`)
  }
})
await T('正常：一次性登录链接可换取会话 Cookie，且 Cookie 自动生效', async () => {
  const host = new URL(BASE).host
  const posted = await rawSend('POST', '/__gw/admin/bootstrap', {
    Host: host, Authorization: 'Bearer ' + ADMIN_TOKEN, 'Content-Type': 'application/json'
  }, Buffer.from('{}'))
  eq(posted.status, 200, '签发一次性链接失败')
  ok(/\?_cgw_bootstrap=/.test(posted.json?.url || ''), '返回体不含登录 URL')

  const nonce = new URL(posted.json.url).searchParams.get('_cgw_bootstrap')
  const land = await rawSend('GET', '/?' + new URLSearchParams({ _cgw_bootstrap: nonce }), { Host: host })
  eq(land.status, 302, '兑换未产生重定向')
  const setCookie = String(land.headers['set-cookie'] || '')
  ok(/cgw_session=/.test(setCookie), '未下发会话 Cookie')
  ok(/HttpOnly/i.test(setCookie), 'Cookie 缺 HttpOnly（XSS 可窃取）')
  ok(/SameSite=Strict/i.test(setCookie), 'Cookie 缺 SameSite=Strict（CSRF 可携带）')

  const session = /(?:^|,\s*)cgw_session=([^;]+)/.exec(setCookie)?.[1]
  ok(session, '解析不出会话值')
  const authed = await rawSend('GET', NO_ADMIN, { Host: host, Cookie: `cgw_session=${session}` })
  eq(authed.status, 200, '会话 Cookie 未通过鉴权')
})
await T('异常：一次性链接用过即废（重放攻击）', async () => {
  const host = new URL(BASE).host
  const posted = await rawSend('POST', '/__gw/admin/bootstrap', {
    Host: host, Authorization: 'Bearer ' + ADMIN_TOKEN, 'Content-Type': 'application/json'
  }, Buffer.from('{}'))
  const nonce = new URL(posted.json.url).searchParams.get('_cgw_bootstrap')
  const first = await rawSend('GET', '/?' + new URLSearchParams({ _cgw_bootstrap: nonce }), { Host: host })
  eq(first.status, 302, '首次兑换应成功')
  const replay = await rawSend('GET', '/?' + new URLSearchParams({ _cgw_bootstrap: nonce }), { Host: host })
  eq(replay.status, 403, '同一条链接被重复兑换居然成功')
  ok(/已被使用过/.test(replay.text), '重放未给出明确提示')
})
await T('异常：篡改签名的一次性链接被拒', async () => {
  const host = new URL(BASE).host
  for (const bad of ['abc.123.deadbeef', 'a.b', '', '../../etc/passwd']) {
    const r = await rawSend('GET', '/?' + new URLSearchParams({ _cgw_bootstrap: bad }), { Host: host })
    eq(r.status, 403, `非法链接未被拒绝：${bad.slice(0, 30)}`)
  }
})
await T('异常：未通过鉴权时，reveal 取不到任何明文（原 F-01 的核心场景）', async () => {
  const listed = await req('/__gw/apikeys')
  const id = listed.json.keys[0]?.id
  ok(id, '夹具失败：没有可取回的 key')
  const r = await rawSend('GET', '/__gw/apikeys/reveal?id=' + id, { Host: new URL(BASE).host })
  eq(r.status, 401, '未认证即可取明文 —— F-01 未修复')
  ok(!/cgw-[A-Za-z0-9_-]{10,}/.test(r.text), '响应泄露明文')
})
await T('边界：管理令牌不随仓库分发（不进 git、不与 Key 混放）', async () => {
  const r = await req('/__gw/admin/token')
  ok(!r.json?.token || r.json.token.startsWith('cgwadm-'), '令牌格式异常')
  eq(r.json?.token, ADMIN_TOKEN, '接口返回的令牌与本机存储不一致')
  note('OK-admintoken', `管理令牌落本机数据目录（source=${r.json?.source}），格式 cgwadm- 与数据面 cgw- 完全区分`)
})

// 首页引导页：没有它，未登录用户打开控制台只会看到一片 401 白屏。
await T('正常：未登录访问首页 → 引导页（而不是白屏 SPA）', async () => {
  const r = await rawSend('GET', '/', { Host: new URL(BASE).host })
  eq(r.status, 200, `首页应返回引导页，实际 HTTP ${r.status}`)
  ok(/管理控制台|管理令牌/.test(r.text), '未返回引导页')
  ok(/launcher\.mjs admin-token/.test(r.text), '引导页没告诉用户去哪里拿令牌')
  ok(!/"keys"\s*:\s*\[/.test(r.text), '引导页混入了控制面数据')
})
await T('反例：已持凭据访问首页不再返回引导页（避免反复要求登录）', async () => {
  const r = await rawSend('GET', '/', { Host: new URL(BASE).host, Authorization: 'Bearer ' + ADMIN_TOKEN })
  ok(!/launcher\.mjs admin-token/.test(r.text), '已登录用户仍被要求登录')
  ok(r.status !== 401, `已持凭据访问首页被拒：HTTP ${r.status}`)
})

// =====================================================================
// K8 · 并发架构（原 F-03 二期）
// 这一组存在的意义：如果将来有人把「一账号一实例」改回「单进程 + 切账号重启」，
// 功能测试很可能全绿（请求照样能通），但架构已经退化。所以必须直接断言：
//   · 两个账号各占一个端口；
//   · 用账号 2 时账号 1 的进程不能被拆掉；
//   · 实例启动次数与请求量解耦。
// =====================================================================
G('K8 · 并发架构 · 多账号实例池（原 F-03 二期）')
if (READONLY) {
  console.log(`${C.d}  只读模式：跳过（会创建账号）${C.x}`)
} else {
  const mkAcct = async (name) =>
    (await req('/__gw/accounts', {
      method: 'POST',
      body: { name, json: { access_token: 'audit-' + name, refresh_token: 'r-' + name } }
    })).json
  const acct1 = await mkAcct('pool-1')
  const acct2 = await mkAcct('pool-2')
  const mkBoundKey = async (name, ids) =>
    (await req('/__gw/apikeys', { method: 'POST', body: { name, accountIds: ids } })).json?.key
  const k1 = acct1?.accountId ? await mkBoundKey('pool-key-1', [acct1.accountId]) : null
  const k2 = acct2?.accountId ? await mkBoundKey('pool-key-2', [acct2.accountId]) : null
  // 账号用的是假 token，上游必然失败；这里只关心「请求被路由到哪个实例」，
  // 所以不看响应码，只看实例与端口。
  const ask = (k) =>
    req('/v1/chat/completions', {
      method: 'POST',
      headers: auth(k.token),
      body: { model: 'gpt-6.1-sol', messages: [{ role: 'user', content: 'hi' }] },
      timeout: 20000
    })

  if (!k1 || !k2) {
    await T('异常：多账号实例池夹具可用', async () => { throw new Error('未能创建两个账号及绑定 Key') })
  } else {
    await T('异常：每个账号各自占用独立端口（不再共享单一 bridge）', async () => {
      await ask(k1)
      let st = (await req('/__gw/status')).json
      ok(Array.isArray(st.bridgeInstances), 'status 未提供 bridgeInstances（实例池架构缺失）')
      const i1 = st.bridgeInstances.find((i) => i.label === 'pool-1')
      ok(i1, `账号 1 未生成实例：${JSON.stringify(st.bridgeInstances)}`)
      ok(i1.port >= st.config.bridgeBasePort, `端口 ${i1.port} 不在实例池区间（base ${st.config.bridgeBasePort}）`)
      const pid1 = i1.pid

      await ask(k2)
      st = (await req('/__gw/status')).json
      const i2 = st.bridgeInstances.find((i) => i.label === 'pool-2')
      ok(i2, `账号 2 未生成实例：${JSON.stringify(st.bridgeInstances)}`)
      ok(i2.port !== i1.port, `两个账号复用了同一端口 ${i2.port} —— 仍是单进程架构`)
      // 最关键的一条：切到账号 2 不能把账号 1 的进程拆掉。
      // 回退成「单进程 + kill/spawn」时，这一条必然失败。
      const i1After = st.bridgeInstances.find((i) => i.label === 'pool-1')
      ok(i1After, '用账号 2 之后账号 1 的实例消失了（回退成了单进程架构）')
      eq(i1After.pid, pid1, '账号 1 的进程被重启了（使用其它账号不应打断已有通道）')
    })

    await T('正常：交替账号 12 次请求不新增实例启动（切换次数与请求量解耦）', async () => {
      const before = (await req('/__gw/status')).json.bridgePool?.starts
      ok(typeof before === 'number', 'status 缺少 bridgePool.starts 字段')
      await Promise.all(Array.from({ length: 12 }, (_, i) => ask(i % 2 ? k2 : k1)))
      const st = (await req('/__gw/status')).json
      eq(st.bridgePool.starts, before, `交替 12 次后实例启动次数由 ${before} 变为 ${st.bridgePool.starts}`)
      ok(st.bridgePool.starts <= 2, `实例启动次数 ${st.bridgePool.starts} 超过账号数 2`)
      eq(st.bridgePool.failures, 0, '实例启动出现失败')
    })
  }
}

// ---------------- 汇总 ----------------
console.log('\n' + '─'.repeat(70))
console.log(`  ${BASE}    通过 ${C.g}${pass}${C.x}   失败 ${C.r}${fail}${C.x}`)
console.log('─'.repeat(70))
const notes = results.filter((r) => r.type === 'note')
if (notes.length) { console.log('\n取证记录（非通过/失败，供人工研判）：'); for (const n of notes) console.log(`  · [${n.group}] ${n.name} — ${n.msg}`) }
if (fail) { console.log('\n失败明细：'); for (const r of results.filter((x) => x.type === 'fail')) console.log(`  ✗ [${r.group}] ${r.name}\n    ${r.msg}`) }
console.log(`\n重跑命令：node gateway/tests/audit.mjs --base=${BASE}`)
process.exit(fail ? 1 : 0)
