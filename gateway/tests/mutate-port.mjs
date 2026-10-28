#!/usr/bin/env node
// mutate-port.mjs — 证明 port.test.mjs 不是假测试
//
// 这块逻辑的失败方式同样"沉默"：
//   · 端口字符串被 Number() 宽容放过（'0x1051' → 4177、'4174.0' → 4174），
//     用户在配置里多打一个字符，网关就监听在一个他没写过的端口上；
//   · 冲突诊断里写死 4173 而不是传进来的端口，换过端口的人照着命令排查永远查不到；
//   · 平台命令写反（macOS 上给 netstat），照着敲就是 command not found。
// 每一个变异体都对应一种"看起来没问题、实际把人带沟里"的写法。
//
// 只复制 port-util.mjs 与被测用例（纯函数部分）；涉及真进程的用例在沙盒里自动跳过。
//
//   node mutate-port.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const GW = path.resolve(HERE, '..')
const C = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' }

const TARGET = 'port-util.mjs'
const TEST = 'tests/port.test.mjs'

const MUTANTS = [
  {
    id: 'MP1',
    desc: '上限校验漏掉 65535 之上（65536 被当成合法端口，绑定时才失败）',
    from: '  if (!Number.isInteger(n) || n < MIN_PORT || n > MAX_PORT) {',
    to: '  if (!Number.isInteger(n) || n < MIN_PORT) {'
  },
  {
    id: 'MP2',
    desc: '正则放过小数（"4174.0" 被 Number() 悄悄变成 4174，用户写的端口和实际不符）',
    from: '  if (!/^\\d+$/.test(s)) {',
    to: '  if (!/^\\d+(\\.\\d+)?$/.test(s)) {'
  },
  {
    id: 'MP3',
    desc: '不 trim 输入（" 4174 " 被判成非法，"从文档里复制带空格"直接起不来）',
    from: '  const s = String(raw).trim()',
    to: '  const s = String(raw)'
  },
  {
    id: 'MP4',
    desc: '校验失败时把原始输入当端口返回（半成品传下去，崩在更远的地方）',
    from: '    return { port: fallback, error: `端口必须是纯数字（收到 "${s}"）` }',
    to: '    return { port: Number(s), error: `端口必须是纯数字（收到 \\"${s}\\"）` }'
  },
  {
    id: 'MP5',
    desc: '下界校验写成 0（端口 0 被放行，Node 会随机分配一个谁也猜不到的端口）',
    from: '  if (!Number.isInteger(n) || n < MIN_PORT || n > MAX_PORT) {',
    to: '  if (!Number.isInteger(n) || n < 0 || n > MAX_PORT) {'
  },
  {
    id: 'MP6',
    desc: '换端口建议到顶不回绕（65536 被写进提示，照着敲还是错的）',
    from: '  return n + 1 > MAX_PORT ? 4000 : n + 1',
    to: '  return n + 1 > MAX_PORT ? 65535 : n + 1'
  },
  {
    id: 'MP7',
    desc: '非 Windows 平台也给 netstat（macOS/Linux 上照着敲是 command not found）',
    from: '  return [`lsof -nP -iTCP:${port} -sTCP:LISTEN`]',
    to: '  return [`netstat -ano | findstr :${port}`]'
  },
  {
    id: 'MP8',
    desc: 'vite preview 的解释无条件出现（换到 5000 端口还说"4173 正是 vite"，把人带偏）',
    from: '      ? port === DEFAULT_LAUNCHER_PORT',
    to: '      ? true'
  },
  {
    id: 'MP9',
    desc: '局域网提示无条件出现（没开 --lan 的人也被告知"接入地址会变"）',
    from: '  if (lanEnabled) {',
    to: '  if (true) {'
  },
  {
    id: 'MP10',
    desc: '特权端口提示不再解释 1024（用户不知道该换到哪个区间）',
    from: "    '低于 1024 的端口属于特权端口，普通用户无法绑定。请改用高位端口：',",
    to: "    '端口绑定失败：',"
  },
  {
    id: 'MP11',
    desc: '冲突诊断里写死 4173（换过端口的人照着命令查，什么都查不到）',
    from: '      `netstat -ano | findstr :${port}`,',
    to: '      `netstat -ano | findstr :4173`,'
  }
]

function makeCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-mut-port-'))
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true })
  fs.copyFileSync(path.join(GW, TARGET), path.join(dir, TARGET))
  fs.copyFileSync(path.join(HERE, 'port.test.mjs'), path.join(dir, TEST))
  return dir
}

function runTest(dir) {
  try {
    execFileSync(process.execPath, ['--test', '--test-timeout=30000', path.join(dir, TEST)], {
      cwd: dir,
      stdio: 'ignore',
      timeout: 120000
    })
    return true
  } catch {
    return false
  }
}

// 语法预检：变异把文件改出语法错误时测试也会「失败」，那是假杀死
function syntaxOk(file) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

console.log(`${C.b}变异测试 · 验证端口解析与冲突诊断的用例是否真能抓到缺陷${C.x}`)
console.log(`${C.d}被测对象：gateway/${TARGET} · 变异体 ${MUTANTS.length} 个${C.x}\n`)

const baseline = makeCopy()
const baseOk = runTest(baseline)
fs.rmSync(baseline, { recursive: true, force: true })
if (!baseOk) {
  console.error(`${C.r}✗ 基线失败：未变异的源码就过不了测试${C.x}`)
  console.error(`${C.d}  先单独跑：npm run test:unit${C.x}`)
  process.exit(1)
}
console.log(`${C.g}✓ 基线通过${C.x}  （port-util 纯函数部分全绿）\n`)

const rows = []
for (const m of MUTANTS) {
  const dir = makeCopy()
  try {
    const target = path.join(dir, TARGET)
    const src = fs.readFileSync(target, 'utf8')
    const hit = src.indexOf(m.from)
    if (hit < 0) {
      rows.push({ ...m, result: 'anchor-missing' })
      console.log(`${C.y}! ${m.id} 锚点失效${C.x}  ${m.desc}`)
      continue
    }
    // 锚点必须唯一：出现多次说明它可能改到别处（MF4 那次就栽在这）
    if (src.indexOf(m.from, hit + 1) >= 0) {
      rows.push({ ...m, result: 'anchor-ambiguous' })
      console.log(`${C.y}! ${m.id} 锚点不唯一${C.x}  ${m.desc}`)
      continue
    }
    fs.writeFileSync(target, src.replace(m.from, m.to))
    if (!syntaxOk(target)) {
      rows.push({ ...m, result: 'syntax' })
      console.log(`${C.y}! ${m.id} 变异体本身语法错误（假杀死，不计入）${C.x}  ${m.desc}`)
      continue
    }
    const passed = runTest(dir)
    rows.push({ ...m, result: passed ? 'survived' : 'killed' })
    if (passed) console.log(`${C.r}✗ ${m.id} 存活${C.x}  ${m.desc}`)
    else console.log(`${C.g}✓ ${m.id} 被杀死${C.x}  ${m.desc}`)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const killed = rows.filter((r) => r.result === 'killed').length
const survived = rows.filter((r) => r.result === 'survived')
const broken = rows.filter((r) => ['anchor-missing', 'anchor-ambiguous', 'syntax'].includes(r.result))

console.log('\n' + '─'.repeat(70))
console.log(`  变异体 ${rows.length} 个 · 杀死 ${killed} · 存活 ${survived.length} · 无效 ${broken.length}`)
console.log('─'.repeat(70))

if (survived.length || broken.length) {
  if (survived.length) console.error(`${C.r}✗ 存在盲区${C.x}：${survived.map((r) => r.id).join(', ')}`)
  if (broken.length) console.error(`${C.y}! 无效变异体${C.x}：${broken.map((r) => r.id).join(', ')}（改了源码请同步更新锚点）`)
  process.exit(1)
}
console.log(`${C.g}✅ 全部变异体被杀死，零盲区${C.x}`)
