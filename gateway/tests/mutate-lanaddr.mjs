#!/usr/bin/env node
// mutate-lanaddr.mjs — 证明 lan-addr.test.mjs 不是假测试
//
// 这块逻辑的特点是：错了不会有任何报错，只是把**错误的地址**摆到用户眼前。
// 用户照抄发给同事，对方连不上，然后怀疑是网关坏了。
// 四种最像样的写错方式都做成变异体：
//   · Tailscale 段只看 100 首段（把 100.128 公网段也当隧道）
//   · 私有段漏掉 172.16/12
//   · 用网段判断虚拟网卡（顺手把真用 172.17 的公司内网也降权了）
//   · 排序把 Tailscale 排到真实内网前面
//
// 与其它变异 runner 的区别：被测文件零依赖，只复制它自身和测试文件即可。
//
//   node mutate-lanaddr.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const GW = path.resolve(HERE, '..')
const C = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' }

const TARGET = 'lan-addr.mjs'
const TEST = 'tests/lan-addr.test.mjs'

const MUTANTS = [
  {
    id: 'ML1',
    desc: 'Tailscale 段上界写成 64（只认 100.64.0.0/16，100.65 之后的地址被当成公网）',
    from: 'return Number.isInteger(second) && second >= 64 && second <= 127',
    to: 'return Number.isInteger(second) && second >= 64 && second <= 64'
  },
  {
    id: 'ML2',
    desc: '只看 100 首段就当 Tailscale（100.128 是公网段，会误判）',
    from: '  const second = Number(p[1])\n  return Number.isInteger(second) && second >= 64 && second <= 127',
    to: '  const second = Number(p[1])\n  return Number.isInteger(second)'
  },
  {
    id: 'ML3',
    desc: '私有段漏掉 172.16/12（172.16~172.31 被当成公网，排到最后）',
    from: '  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true',
    to: '  if (p[0] === 172 && p[1] === 17) return true'
  },
  {
    id: 'ML4',
    desc: '用网段判断虚拟网卡（公司内网真用 172.17 时被无端降权）',
    from: '  const virtual = isVirtualIface(name)',
    to: '  const virtual = isVirtualIface(name) || /^172\\.(1[6-9]|2\\d|3[01])\\./.test(String(address || \'\'))'
  },
  {
    id: 'ML5',
    desc: 'virtual 恒为 false（Docker 网桥不再降权，可能抢到首选）',
    from: '  const virtual = isVirtualIface(name)',
    to: '  const virtual = false && isVirtualIface(name)'
  },
  {
    id: 'ML6',
    desc: '排序把 Tailscale 排到真实内网前面（局域网同事拿到连不上的地址）',
    from:
      '  if (addr.kind === KIND.LAN && !addr.virtual) return 0\n' +
      '  if (addr.kind === KIND.LAN) return 1\n' +
      '  if (addr.kind === KIND.TAILSCALE) return 2',
    to:
      '  if (addr.kind === KIND.TAILSCALE) return 0\n' +
      '  if (addr.kind === KIND.LAN && !addr.virtual) return 0\n' +
      '  if (addr.kind === KIND.LAN) return 1'
  },
  {
    id: 'ML7',
    desc: '不排序，只分类（枚举顺序即展示顺序，跨平台不可靠）',
    from: '    .sort((x, y) => x.r - y.r || x.i - y.i)',
    to: '    .sort(() => 0)'
  },
  {
    id: 'ML8',
    desc: 'preferred 挂在每一项上（前端 find() 拿到第一个，等于没排序）',
    from: '  return out.map((a, i) => ({ ...a, preferred: i === 0 }))',
    to: '  return out.map((a, i) => ({ ...a, preferred: i >= 0 }))'
  },
  {
    id: 'ML9',
    desc: '把虚拟网卡的地址说成普通内网（用户以为同事能连，其实只有本机通）',
    from: "  if (addr.kind === KIND.LAN && addr.virtual) return '内网（虚拟网卡）'",
    to: '  if (false) return \'内网（虚拟网卡）\''
  }
]

function makeCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-mut-lanaddr-'))
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true })
  fs.copyFileSync(path.join(GW, TARGET), path.join(dir, TARGET))
  fs.copyFileSync(path.join(HERE, 'lan-addr.test.mjs'), path.join(dir, TEST))
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

console.log(`${C.b}变异测试 · 验证局域网地址分类与排序的用例是否真能抓到缺陷${C.x}`)
console.log(`${C.d}被测对象：gateway/${TARGET} · 变异体 ${MUTANTS.length} 个${C.x}\n`)

const baseline = makeCopy()
const baseOk = runTest(baseline)
fs.rmSync(baseline, { recursive: true, force: true })
if (!baseOk) {
  console.error(`${C.r}✗ 基线失败：未变异的源码就过不了测试${C.x}`)
  console.error(`${C.d}  先单独跑：npm run test:unit${C.x}`)
  process.exit(1)
}
console.log(`${C.g}✓ 基线通过${C.x}  （lan-addr 25 例全绿）\n`)

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
