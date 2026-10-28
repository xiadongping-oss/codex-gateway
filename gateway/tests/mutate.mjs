#!/usr/bin/env node
// codex-gateway · 上线前 AI 安全审计 —— 变异测试（指南第四步）
//
// 目的：证明 audit.mjs 是真测试，不是「永远显示通过」的假测试。
// 做法：往沙盒代码里注入真实缺陷（变异体），重跑测试——
//         测试失败  = 变异被杀死 = 这套测试确实在保护这块逻辑 ✓
//         测试仍然通过 = 变异存活 = 这块逻辑处于测试盲区，需要补 ✗
// 约定：只改沙盒副本（sandbox/），绝不触碰真实源码。
//
//   node mutate.mjs

import fs from 'node:fs'
import path from 'node:path'
import { spawn, execSync } from 'node:child_process'
import { isReady } from './lib/health.mjs'

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const SB = path.join(ROOT, 'sandbox')
const GEN = path.join(SB, 'home', '.chatgpt-bridge', 'gen-images')
const TOKEN_FILE = path.join(SB, 'admin-token.json')
const PORT = 4199
const BASE = `http://127.0.0.1:${PORT}`
const NODE = process.execPath

const C = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' }

// ---------- 变异体定义 ----------
// 每个变异对应一类真实事故：权限绕过 / 数据越权 / 敏感泄露 / 穿越
const MUTANTS = [
  {
    id: 'M1', cat: '权限', desc: '任何 cgw- 前缀 token 都命中第一个 Key（鉴权形同虚设）',
    file: 'apikeys.mjs',
    from: '  const hash = sha256(token)\n  const r = reg()',
    to: '  const _r0 = reg()\n  const hash = _r0.keys.length ? _r0.keys[0].hash : sha256(token)\n  const r = _r0'
  },
  {
    id: 'M2', cat: '权限', desc: '局域网模式下不再强制 /v1 鉴权（匿名可用）',
    file: 'launcher.mjs',
    from: '  const enforced = gwConfig.strictAuth || LAN_ENABLED',
    to: '  const enforced = gwConfig.strictAuth'
  },
  {
    id: 'M3', cat: '数据', desc: '图库列表返回全部人的图（跨 Key 数据泄露）',
    file: 'launcher.mjs',
    from: '  return listGenImages().filter((i) => i.ownerKeyId === keyId)',
    to: '  return listGenImages()'
  },
  {
    id: 'M4', cat: '数据', desc: '删除不做归属校验（任意 Key 可删他人素材）',
    file: 'launcher.mjs',
    from: "  if (keyId && (!meta || meta.keyId !== keyId)) return { ok: false, error: 'not_owner_or_not_found' }",
    to: '  if (false) return { ok: false, error: \'not_owner_or_not_found\' }'
  },
  {
    id: 'M5a', cat: '数据', expect: 'survive',
    desc: '仅放宽文件名正则 NAME_RE —— 应被第二道防线挡住（验证纵深）',
    file: 'assets.mjs', multi: [
      ['const NAME_RE = /^[^\\\\/:*?"<>|\\0]+$/', 'const NAME_RE = /^[\\s\\S]+$/'],
      ["  if (!name || typeof name !== 'string' || !NAME_RE.test(name) || name.includes('..') || name.startsWith('.')) return null",
        "  if (!name || typeof name !== 'string') return null"]
    ]
  },
  {
    id: 'M5b', cat: '数据', expect: 'survive',
    desc: '仅去掉目录边界前缀检查 —— 应被文件名正则挡住（验证纵深）',
    file: 'assets.mjs', multi: [
      ['  if (full !== base && !full.startsWith(base + path.sep)) return null', '  if (false) return null']
    ]
  },
  {
    id: 'M5c', cat: '数据', expect: 'kill',
    desc: '文件名校验 + 目录边界 + 扩展名白名单 + 生成图命名 全部失效（穿越成立）',
    file: 'assets.mjs', multi: [
      ['const NAME_RE = /^[^\\\\/:*?"<>|\\0]+$/', 'const NAME_RE = /^[\\s\\S]+$/'],
      ["  if (!name || typeof name !== 'string' || !NAME_RE.test(name) || name.includes('..') || name.startsWith('.')) return null",
        "  if (!name || typeof name !== 'string') return null"],
      ['  if (full !== base && !full.startsWith(base + path.sep)) return null', '  if (false) return null'],
      ['  if (!IMAGE_EXTS.has(path.extname(full).toLowerCase())) return null', '  if (false) return null'],
      ['const GEN_IMAGE_RE = /^[A-Za-z0-9_-]+\\.png$/', 'const GEN_IMAGE_RE = /^[\\s\\S]+$/'],
      ['  if (checkGen && !GEN_IMAGE_RE.test(name)) return null', '  if (false) return null']
    ]
  },
  {
    id: 'M6', cat: '数据', desc: 'Key 列表接口带出明文 token（凭据泄露）',
    file: 'apikeys.mjs',
    from: '        token: includeRaw ? (decryptToken(k.enc) || k.token || null) : null,',
    to: '        token: (decryptToken(k.enc) || k.token || null),'
  },

  // ---- 以下 6 个针对第二轮修复（F-02 / F-05 / F-06）----
  {
    id: 'M7', cat: '权限', desc: '整个控制面来源守卫被摘除（Host + CSRF 全失效）',
    file: 'launcher.mjs',
    from: '    if (controlPlaneGuard(req, res)) return',
    to: '    if (false) return'
  },
  {
    id: 'M8', cat: '权限', desc: 'Host 白名单被绕过（DNS rebinding 面重新打开）',
    file: 'launcher.mjs',
    from: '  if (h && !LOCAL_HOSTS.has(h)) {',
    to: '  if (false) {'
  },
  {
    id: 'M9', cat: '权限', desc: '只校验 Origin、忽略 Referer（无 Origin 的跨站请求可绕过 CSRF）',
    file: 'launcher.mjs',
    from: "  const raw = req.headers['origin'] || req.headers['referer']",
    to: "  const raw = req.headers['origin']"
  },
  {
    id: 'M10', cat: '可用性', desc: '回到「带没带凭据都报 missing_api_key」（错误码语义丢失）',
    file: 'launcher.mjs',
    from: '  const raw = rawBearer(req)',
    to: '  const raw = null'
  },
  {
    id: 'M11', cat: '数据', desc: '显示名不再净化（日志注入 / 同名伪装失效）',
    file: 'apikeys.mjs',
    from: '  let s = String(raw == null ? \'\' : raw)',
    to: '  let s = String(raw == null ? \'\' : raw)\n  return s.trim().slice(0, max) || fallback'
  },
  {
    id: 'M12', cat: '数据', desc: '显示名不截断（超长输入可撑爆 UI 与日志）',
    file: 'apikeys.mjs',
    from: '  return s.slice(0, max)',
    to: '  return s'
  },

  // ---- 以下针对第三轮修复（F-01 控制面鉴权）----
  {
    id: 'M13', cat: '权限', desc: '控制面管理鉴权被整段摘除（回到零鉴权 = F-01 重现）',
    file: 'launcher.mjs',
    from: '  if (adminAuth && !adminAuth.verifyRequest(req).ok) {',
    to: '  if (false) {'
  },
  {
    id: 'M14', cat: '权限', desc: '会话 Cookie 不再验签（伪造 Cookie 可直接进控制台）',
    file: 'admin-auth.mjs',
    from: '    if (!safeEqual(value.slice(i + 1), sign(body))) return false',
    to: '    if (false) return false'
  },
  {
    id: 'M15', cat: '权限', desc: '一次性登录链接不记录使用（可反复重放）',
    file: 'admin-auth.mjs',
    from: "    if (consumed.has(parts[0])) return { ok: false, reason: 'already_used' }",
    to: '    if (false) return { ok: false, reason: \'already_used\' }'
  },
  {
    id: 'M16', cat: '体验', desc: '首页引导页不再判断登录态（已登录用户被反复要求登录）',
    file: 'launcher.mjs',
    from: "  if (adminAuth && req.method === 'GET' && (p === '/' || p === '/index.html') && !adminAuth.verifyRequest(req).ok) {",
    to: "  if (adminAuth && req.method === 'GET' && (p === '/' || p === '/index.html')) {"
  },
  {
    id: 'M17', cat: '体验', desc: '去掉首页引导页（未登录直接看 401 白屏）',
    file: 'launcher.mjs',
    from: "  if (adminAuth && req.method === 'GET' && (p === '/' || p === '/index.html') && !adminAuth.verifyRequest(req).ok) {",
    to: "  if (false) {"
  },
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 沙盒代码必须与 gateway/ 一致，否则「变异杀死率」测的是上个月的代码
function syncSandbox() {
  const SRC = path.join(ROOT, '..')   // gateway/tests/.. = gateway
  for (const f of fs.readdirSync(SRC)) {
    if (f.endsWith('.mjs') || f.endsWith('.html')) {
      fs.copyFileSync(path.join(SRC, f), path.join(SB, f))
    }
  }
}

function killPort() {
  try {
    const out = execSync(`netstat -ano | grep ":${PORT}" | grep LISTENING`, { shell: 'bash' }).toString()
    for (const pid of new Set(out.trim().split('\n').map((l) => l.trim().split(/\s+/).pop()).filter(Boolean))) {
      try { execSync(`taskkill //F //PID ${pid}`, { stdio: 'ignore' }) } catch {}
    }
  } catch {}
}

function resetSandbox() {
  // 为什么不用 rm -rf：这条套件要跑十几个变异体，每个都递归删图库会撞上
  // 本机的批量删除保护（单回合 50 条），第 7 个变异体起直接"执行异常"，
  // 结论就变成一堆假存活。改用「覆盖写」把状态清零：
  // 图库索引清空 == 对上层不可见，物理图残留不影响任何断言。
  fs.mkdirSync(GEN, { recursive: true })
  fs.mkdirSync(path.join(SB, 'data'), { recursive: true })
  fs.writeFileSync(path.join(GEN, 'index.json'), '{}')
  fs.writeFileSync(path.join(SB, 'accounts.json'), '{"activeId":null,"accounts":[]}')
  fs.writeFileSync(path.join(SB, 'api-keys.json'), '{"keys":[]}')
  fs.writeFileSync(path.join(SB, 'data', 'asset-sources.json'), '{"sources":[]}')
  // 金丝雀配置：真实值只在沙盒存在。任何穿越/泄露路径读到它，测试必须报警。
  fs.writeFileSync(path.join(SB, '.gw-config.json'), JSON.stringify({
    mode: 'bridge', strictAuth: false, proxy: '',
    openaiApiKey: 'CANARY-SECRET-DO-NOT-LEAK',
    authFilePath: String(path.join(SB, 'home', '.chatgpt-bridge', 'auth.json'))
  }))
}

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) })
      // 只要拿到 HTTP 响应就算起来了。**不能只认 200**：沙盒里没有账号，
      // v1.3.0 起 /health 明确返回 503 bridge_not_running（502 是更早的语义）。
      // 按 200 判定会让整个变异框架一个都跑不起来，还把「框架崩了」误报成「全部盲区」。
      if (isReady(r.status)) return true
    } catch {}
    await sleep(250)
  }
  return false
}

async function startGateway() {
  const p = spawn(NODE, ['launcher.mjs', '--lan'], {
    cwd: SB,
    env: { ...process.env, USERPROFILE: path.join(SB, 'home'), HOME: path.join(SB, 'home'), LAUNCHER_PORT: String(PORT), BRIDGE_PORT: '10999', DISABLE_AUTOSTART: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  // 留一段 stderr 尾巴：启动失败时能直接看到原因，而不是只有一句「网关未能启动」。
  let tail = ''
  p.stderr.on('data', (d) => { tail = (tail + d).slice(-800) })
  p.stdout.on('data', () => {})
  if (!(await waitReady())) {
    p.kill('SIGKILL')
    throw new Error('网关未能启动' + (tail ? `：${tail.trim().split('\n').slice(-3).join(' / ')}` : ''))
  }
  return p
}

function runAudit() {
  return new Promise((resolve) => {
    const a = spawn(NODE, [path.join(ROOT, 'audit.mjs'), '--base=' + BASE, '--gendir=' + GEN, '--tokenfile=' + TOKEN_FILE], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    a.stdout.on('data', (d) => (out += d))
    a.stderr.on('data', (d) => (out += d))
    a.on('close', (code) => resolve({ code, out }))
  })
}

function applyMutation(m) {
  const file = path.join(SB, m.file)
  const orig = fs.readFileSync(file, 'utf8')
  // 仓库可能以 CRLF 落盘，注入点若按 LF 书写会匹配不上——这里按实际换行对齐。
  const nl = orig.includes('\r\n') ? '\r\n' : '\n'
  const fit = (s) => s.replace(/\n/g, nl)
  let next = orig
  const pairs = m.multi ? m.multi : [[m.from, m.to]]
  for (const [rawFrom, rawTo] of pairs) {
    const from = fit(rawFrom), to = fit(rawTo)
    if (!next.includes(from)) throw new Error(`注入点未命中：${m.file} :: ${rawFrom.slice(0, 70)}…（代码已变更或换行不一致？）`)
    next = next.split(from).join(to)
  }
  if (next === orig) throw new Error('变异后内容与原文一致')
  fs.writeFileSync(file, next)
  return orig
}

function failedTests(out) {
  return out.split('\n')
    .filter((l) => l.includes('  ✗'))
    .map((l) => l.replace(/\x1b\[\d+m/g, '').replace(/^\s*✗\s*/, '').trim())
}

// ---------------- 主流程 ----------------
// 先把 gateway/ 的最新源码同步进沙盒 —— 否则会拿旧代码做变异，结论不可信。
syncSandbox()
console.log(`${C.b}变异测试 · 验证 audit.mjs 是否真能抓到缺陷${C.x}`)
console.log(`${C.d}每个变异体都是一处真实事故；测试必须失败，否则说明该逻辑在测试盲区${C.x}\n`)

const rows = []
for (const m of MUTANTS) {
  const expect = m.expect || 'kill'
  const file = path.join(SB, m.file)
  const backup = fs.readFileSync(file, 'utf8')
  let errored = false, failures = [], detail = ''
  let proc = null
  try {
    applyMutation(m)
    killPort(); await sleep(300)
    resetSandbox()
    proc = await startGateway()
    const r = await runAudit()
    const thed = r.code !== 0            // 测试是否失败 = 变异是否被杀死
    failures = failedTests(r.out)
    detail = failures.slice(0, 3).join(' | ') || '（无任何用例失败）'
    errored = false
    var died = thed
  } catch (e) {
    errored = true
    detail = '变异执行异常：' + e.message
    var died = false
  } finally {
    fs.writeFileSync(file, backup)          // 无论成败都还原，不污染沙盒
    if (proc) try { proc.kill('SIGKILL') } catch {}
    killPort(); await sleep(200)
  }
  // 判定：
  //   expect=kill    必须 died=true  → 否则是测试盲区
  //   expect=survive 必须 died=false → 否则说明单一防线失效就崩（防线太薄）
  const good = errored ? false : (expect === 'kill' ? died : !died)
  rows.push({ ...m, expect, died, good, detail, failures, errored })
  const tag = errored ? `${C.y}执行异常${C.x}` : (expect === 'kill'
    ? (died ? `${C.g}已杀死${C.x}` : `${C.r}存活→盲区${C.x}`)
    : (died ? `${C.y}防线偏薄${C.x}` : `${C.g}被兜住${C.x}`))
  console.log(`${good ? '✓' : '✗'} ${m.id} [${m.cat}] ${tag}  ${m.desc}`)
  console.log(`     ${C.d}${errored ? detail : (expect === 'kill' ? '被捕获：' : '未受影响：') + detail.slice(0, 120)}${C.x}`)
}

const okCount = rows.filter((r) => r.good).length
// 「执行异常」必须与「测试盲区」分开统计：前者是框架/环境坏了（比如网关没起来），
// 后者才是测试真的漏了。混在一起会得出「17 个盲区」这种假结论——发生过一次，
// 实际原因只是 /health 语义从 502 改成 503 后 waitReady 再也等不到就绪。
const erroredRows = rows.filter((r) => r.errored)
const blind = rows.filter((r) => r.expect === 'kill' && !r.died && !r.errored)
console.log('\n' + '─'.repeat(70))
console.log(`  变异体 ${rows.length} · 符合预期 ${C.g}${okCount}${C.x} · 不符合 ${okCount === rows.length ? 0 : rows.length - okCount}${C.x}`)
console.log(`  需杀死的变异 ${rows.filter((r) => r.expect === 'kill').length} 个，测试盲区 ${blind.length} 个，执行异常 ${erroredRows.length} 个`)
if (erroredRows.length === rows.length) {
  console.log(`${C.r}⚠ 全部变异体都执行异常 —— 这是框架/环境问题，不是测试盲区。${C.x}`)
  console.log(`${C.d}  先确认沙盒能起来：cd ${path.relative(process.cwd(), SB) || '.'} && node launcher.mjs --lan${C.x}`)
}
console.log('─'.repeat(70))
if (blind.length) {
  console.log(`${C.r}需要补测试（这些缺陷目前漏得出去）：${C.x}`)
  for (const b of blind) console.log(`  · ${b.id} ${b.desc}`)
} else if (!erroredRows.length) {
  console.log(`${C.g}所有「必须被杀死」的变异都被捕获 —— audit.mjs 不是假测试。${C.x}`)
}
console.log(`${C.d}标「被兜住」的变异体刻意保留：它们证明同一条攻击面存在多层独立防线。${C.x}`)

process.exit(okCount === rows.length ? 0 : 1)
