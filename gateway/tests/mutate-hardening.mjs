#!/usr/bin/env node
// mutate-hardening.mjs — 证明 hardening.test.mjs 不是假测试
//
// 针对本轮全仓审查修掉的缺陷，反向验证「修复有没有真的被测试守住」。
// 跑法与其它 mutate runner 一致：先确认基线绿，再逐个注入真实缺陷，存活即盲区。
//
//   node mutate-hardening.mjs
//
// 两个刻意不做的变异体，理由写在这里以免以后又被当成「漏了」：
//   · 「前导零写法」规则：assertOutboundUrl 用的是 WHATWG URL，它已经先把
//     "0177.0.0.1" 规范成 "127.0.0.1"，由 /^127\./ 拦下。该规则在当前链路上
//     不可达，注入等价变异只会得到「存活」的假信号。
//   · 「0o600 权限位」：Windows 的文件权限不体现在 stat().mode 的低 9 位上，
//     本机无法验证。这类平台相关的断言已标注跳过，不参与变异。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const GW = path.resolve(HERE, '..')
const C = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' }

// 被测文件必须整组复制：assets.mjs 内部会 import './atomic-write.mjs'，
// 只复制其中一个的话，另一个仍指向真源码，变异就白变了 ——
// 这正是本 runner 最初写错、导致 7 个变异体全部「存活」的原因。
const FILES = ['atomic-write.mjs', 'assets.mjs']
const TEST_FILE = 'hardening.test.mjs'

const MUTANTS = [
  {
    id: 'MH1',
    file: 'atomic-write.mjs',
    desc: '临时文件名退化成固定值 —— 并发写入互相踩踏（就是旧实现）',
    from: 'return path.join(dir, `.${base}.${process.pid}.${crypto.randomBytes(6).toString(\'hex\')}.tmp`)',
    to: 'return path.join(dir, `${base}.tmp`)'
  },
  {
    id: 'MH2',
    file: 'atomic-write.mjs',
    desc: '退回非原子覆盖写 —— 写一半被杀就是半截 JSON（旧实现的原罪）',
    from: 'fs.writeFileSync(tmp, text, WRITE_OPTS)\n    fs.renameSync(tmp, target)',
    to: 'fs.writeFileSync(target, text, WRITE_OPTS)'
  },
  {
    id: 'MH3',
    file: 'atomic-write.mjs',
    desc: '写失败被静默吞掉 —— 磁盘只读时接口照样返回成功，重启后改动全丢',
    from: 'try { fs.unlinkSync(tmp) } catch {}\n    throw e',
    to: 'return false'
  },
  {
    id: 'MH4',
    file: 'atomic-write.mjs',
    desc: '失败后不清理残留的临时文件（数据目录逐渐堆满垃圾）',
    from: 'try { fs.unlinkSync(tmp) } catch {}\n    throw e',
    to: 'throw e'
  },
  {
    id: 'MH5',
    file: 'atomic-write.mjs',
    desc: 'sweep 不再按 pid/hex 结构校验 —— 会把用户自己的 .tmp 文件一起删掉',
    from: 'if (!/^\\d+$/.test(pidSeg) || !/^[0-9a-f]{12}$/.test(hexSeg)) continue',
    to: 'if (false) continue'
  },
  {
    id: 'MH6',
    file: 'atomic-write.mjs',
    desc: 'sweep 不再看文件年龄 —— 刚写出去的临时文件会被自己扫掉',
    from: 'if (!st.isFile() || now - st.mtimeMs < maxAgeMs) continue',
    to: 'if (!st.isFile()) continue'
  },
  {
    id: 'MH7',
    file: 'assets.mjs',
    desc: '不再归一化 IPv4-mapped IPv6 —— [::ffff:169.254.169.254] 重新绕过黑名单',
    from: 'const h = normalizeHostname(String(hostname || \'\').toLowerCase().replace(/^\\[|\\]$/g, \'\'))',
    to: 'const h = String(hostname || \'\').toLowerCase().replace(/^\\[|\\]$/g, \'\')'
  },
  {
    id: 'MH8',
    file: 'assets.mjs',
    desc: '放行 IPv6 未指定地址（:: 等价于 0.0.0.0）',
    from: '  /^::$/                       // IPv6 未指定地址（等价于 0.0.0.0）\n]',
    to: ']'
  },
  {
    id: 'MH9',
    file: 'assets.mjs',
    desc: '丢掉整个内网黑名单 —— 这是最粗暴的退化，必须被立刻抓住',
    from: 'return BLOCKED_HOST_PATTERNS.some((re) => re.test(h))',
    to: 'return false'
  }
]

function makeCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-mut-hardening-'))
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true })
  for (const f of FILES) fs.copyFileSync(path.join(GW, f), path.join(dir, f))
  fs.copyFileSync(path.join(HERE, TEST_FILE), path.join(dir, 'tests', TEST_FILE))
  return dir
}

function runTest(dir) {
  try {
    execFileSync(process.execPath, ['--test', '--test-timeout=30000', path.join(dir, 'tests', TEST_FILE)], {
      cwd: dir,
      stdio: 'ignore',
      timeout: 120000,
      env: { ...process.env, CGW_TEST_SRC: dir }
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

console.log(`${C.b}变异测试 · 验证本轮加固的用例是否真能抓到缺陷${C.x}`)
console.log(`${C.d}被测对象：gateway/atomic-write.mjs + gateway/assets.mjs · 变异体 ${MUTANTS.length} 个${C.x}\n`)

const baselineDir = makeCopy()
const baseOk = runTest(baselineDir)
fs.rmSync(baselineDir, { recursive: true, force: true })
if (!baseOk) {
  console.error(`${C.r}✗ 基线失败：未变异的源码就过不了测试${C.x}`)
  console.error(`${C.d}  先单独跑：npm run test:unit${C.x}`)
  process.exit(1)
}
console.log(`${C.g}✓ 基线通过${C.x}  （hardening 全部用例全绿）\n`)

const rows = []
for (const m of MUTANTS) {
  const dir = makeCopy()
  try {
    const target = path.join(dir, m.file)
    const src = fs.readFileSync(target, 'utf8')
    const hit = src.indexOf(m.from)
    if (hit < 0) {
      rows.push({ ...m, result: 'anchor-missing' })
      console.log(`${C.y}! ${m.id} 锚点失效${C.x}  ${m.desc}`)
      continue
    }
    // 锚点必须唯一：出现多次说明它可能改到别处（项目历史上栽过多次）
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
