#!/usr/bin/env node
// mutate-failover.mjs — 证明 failover.test.mjs / quota.test.mjs 的探测部分不是假测试
//
// 这两块逻辑的特点：出问题**不会报错**，只会安静地做错事。
//   降级：该降的没降（用户看到 429）、不该降的降了（把 400 也拿去换账号重放）；
//   探测：旧限流头冒充本次结果（界面显示「刚刚同步」，其实一行新数据都没有）。
// 所以补完用例必须做变异验证：把真实行为一个个改坏，看测试是否逐个报红。
//
// 与其它变异 runner 的区别：
//   mutate.mjs        注入沙盒源码 → 起网关 → 跑 audit（HTTP 黑盒）
//   mutate-build.mjs  改构建脚本 → 跑 node --test（假仓库）
//   mutate-client.mjs 改客户端脚本副本 → 跑 node --test（临时 HOME）
//   本脚本            复制整个 gateway/（排除 node_modules）→ 改副本 → 跑 node --test
//
//   node mutate-failover.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const GW = path.resolve(HERE, '..')
const C = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' }

const FAILOVER = { file: 'failover.mjs', test: 'tests/failover.test.mjs' }
const QUOTA = { file: 'account-quota.mjs', test: 'tests/quota.test.mjs' }

const MUTANTS = [
  // ---- 降级判定 ----
  {
    ...FAILOVER, id: 'MF1',
    desc: '把 400 也算成可降级（请求本身有问题，换账号重放只是换个地方再错一次）',
    from: 'export const FAILOVER_STATUSES = new Set([429, 401])',
    to: 'export const FAILOVER_STATUSES = new Set([429, 401, 400])'
  },
  {
    ...FAILOVER, id: 'MF2',
    desc: '429 与 401 用同一个冷却时长（额度窗口和凭据失效恢复速度差一个量级）',
    from: 'export const DEFAULT_DEGRADE_MS = { 429: 5 * 60_000, 401: 15 * 60_000 }',
    to: 'export const DEFAULT_DEGRADE_MS = { 429: 5 * 60_000, 401: 5 * 60_000 }'
  },
  {
    ...FAILOVER, id: 'MF3',
    desc: '请求体没留住也降级（重放会发出一个空 body）',
    from: '    if (!canReplay) return false',
    to: '    if (false) return false'
  },
  {
    ...FAILOVER, id: 'MF4',
    desc: '没有账号归属也降级（不知道该把谁标成不可用）',
    // 锚点必须带上一行：`if (!accountId) return false` 在文件里出现三处
    // （isDegraded / markDegraded / canRetry），只用这一行会改错地方
    from: '    if (!canReplay) return false\n    if (!accountId) return false',
    to: '    if (!canReplay) return false'
  },
  {
    ...FAILOVER, id: 'MF5',
    desc: '重试上限边界写成 <=（比配置多换一个账号）',
    from: '    return Number(attempt || 0) < maxAttempts',
    to: '    return Number(attempt || 0) <= maxAttempts'
  },
  // ---- 选路 ----
  {
    ...FAILOVER, id: 'MF6',
    desc: '每次都从第一个账号找起（A、B 一起坏时会永远在 A→B→A 打转，C 轮不到）',
    from: '    const ordered = idx >= 0 ? [...list.slice(idx + 1), ...list.slice(0, idx + 1)] : list',
    to: '    const ordered = list'
  },
  {
    ...FAILOVER, id: 'MF7',
    desc: '不跳过冷却中的账号（刚撞完 429 又撞回去）',
    from: '      if (isDegraded(a.id)) {\n        stats.skippedDegraded++\n        continue\n      }',
    to: '      if (false) {\n        stats.skippedDegraded++\n        continue\n      }'
  },
  {
    ...FAILOVER, id: 'MF8',
    desc: '不跳过没有 auth 文件的账号（切过去只会拿到 401）',
    from: '      if (!a.hasAuth) {\n        stats.skippedNoAuth++\n        continue\n      }',
    to: '      if (false) {\n        stats.skippedNoAuth++\n        continue\n      }'
  },
  {
    ...FAILOVER, id: 'MF9',
    desc: '冷却到期不自动解除（用户重新登录后账号仍然被拉黑）',
    from: '    if (now() >= until) {\n      degradedUntil.delete(accountId)\n      return false\n    }',
    to: '    if (now() >= until) {\n      return true\n    }'
  },
  {
    ...FAILOVER, id: 'MF10',
    desc: '未知状态码也标记降级（500 也把账号拉黑 60 秒）',
    from: '    const ttl = degradeMs[Number(status)]\n    if (!ttl) return false',
    to: '    const ttl = degradeMs[Number(status)] || 60_000'
  },
  // ---- 额度探测 ----
  {
    ...QUOTA, id: 'MQ1',
    desc: '探测不校验时间戳（bridge 里上一次的旧限流头冒充本次结果）',
    from: '    if (!lul || !lul.at || lul.at < since || Date.now() - lul.at > RT_FRESH_MS) return null',
    to: '    if (!lul || !lul.at || Date.now() - lul.at > RT_FRESH_MS) return null'
  },
  {
    ...QUOTA, id: 'MQ2',
    desc: '探测请求放大 max_tokens（从「极小请求」变成真的跑一次对话）',
    from: '        max_tokens: 1,',
    to: '        max_tokens: 512,'
  },
  {
    ...QUOTA, id: 'MQ3',
    desc: '冷却失效（连点刷新会一次次消耗额度）',
    from: "  if (wait > 0) return { ok: false, reason: 'cooldown', retryAfterSec: wait }",
    to: '  if (false) return { ok: false }'
  },
  {
    ...QUOTA, id: 'MQ4',
    desc: '没拿到新头也报成功（界面显示「实时同步」，数据其实是空的）',
    from: '  if (rt) {\n    probeState.set(key, { at: Date.now(), ok: true, status })\n    return { ok: true, source: \'realtime\', status, syncedAt: rt.syncedAt }\n  }',
    to: "  if (true) {\n    probeState.set(key, { at: Date.now(), ok: true, status })\n    return { ok: true, source: 'realtime', status, syncedAt: rt?.syncedAt || null }\n  }"
  }
]

// 复制整个 gateway/（排除 node_modules 与运行时数据）：
// account-quota.mjs 会 import 同目录的其它模块，只复制单个文件跑不起来。
function makeCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-mut-failover-'))
  fs.cpSync(GW, dir, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(GW, src)
      if (!rel) return true
      const top = rel.split(path.sep)[0]
      return top !== 'node_modules' && top !== 'data' && top !== 'logs'
    }
  })
  return dir
}

function runTest(dir, relTest) {
  try {
    execFileSync(process.execPath, ['--test', '--test-timeout=60000', path.join(dir, relTest)], {
      cwd: dir,
      stdio: 'ignore',
      timeout: 180000
    })
    return true
  } catch {
    return false
  }
}

// 语法预检：变异若把文件改出语法错误，测试也会「失败」——那是假杀死，不算数
function syntaxOk(file) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

console.log(`${C.b}变异测试 · 验证降级策略与额度探测的用例是否真能抓到缺陷${C.x}`)
console.log(`${C.d}被测对象：gateway/failover.mjs · gateway/account-quota.mjs · 变异体 ${MUTANTS.length} 个${C.x}\n`)

// 基线：不改任何东西必须全绿，否则每个变异都「被杀死」，毫无意义
const baseline = makeCopy()
const baseOk = runTest(baseline, FAILOVER.test) && runTest(baseline, QUOTA.test)
fs.rmSync(baseline, { recursive: true, force: true })
if (!baseOk) {
  console.error(`${C.r}✗ 基线失败：未变异的源码就过不了测试${C.x}`)
  console.error(`${C.d}  先单独跑：npm run test:unit${C.x}`)
  process.exit(1)
}
console.log(`${C.g}✓ 基线通过${C.x}  （failover 14 例 + quota 20 例全绿）\n`)

const rows = []
for (const m of MUTANTS) {
  const dir = makeCopy()
  try {
    const target = path.join(dir, m.file)
    const src = fs.readFileSync(target, 'utf8')
    if (!src.includes(m.from)) {
      rows.push({ ...m, result: 'anchor-missing' })
      console.log(`${C.y}! ${m.id} 锚点失效${C.x}  ${m.desc}`)
      continue
    }
    fs.writeFileSync(target, src.replace(m.from, m.to))
    if (!syntaxOk(target)) {
      rows.push({ ...m, result: 'syntax' })
      console.log(`${C.y}! ${m.id} 变异体本身语法错误（假杀死，不计入）${C.x}  ${m.desc}`)
      continue
    }
    const passed = runTest(dir, m.test)
    rows.push({ ...m, result: passed ? 'survived' : 'killed' })
    if (passed) console.log(`${C.r}✗ ${m.id} 存活${C.x}  ${m.desc}`)
    else console.log(`${C.g}✓ ${m.id} 被杀死${C.x}  ${m.desc}`)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const killed = rows.filter((r) => r.result === 'killed').length
const survived = rows.filter((r) => r.result === 'survived')
const broken = rows.filter((r) => r.result === 'anchor-missing' || r.result === 'syntax')

console.log('\n' + '─'.repeat(70))
console.log(`  变异体 ${rows.length} 个 · 杀死 ${killed} · 存活 ${survived.length} · 无效 ${broken.length}`)
console.log('─'.repeat(70))

if (survived.length || broken.length) {
  if (survived.length) console.error(`${C.r}✗ 存在盲区${C.x}：${survived.map((r) => r.id).join(', ')}`)
  if (broken.length) console.error(`${C.y}! 无效变异体${C.x}：${broken.map((r) => r.id).join(', ')}（改了源码请同步更新锚点）`)
  process.exit(1)
}
console.log(`${C.g}✅ 全部变异体被杀死，零盲区${C.x}`)
