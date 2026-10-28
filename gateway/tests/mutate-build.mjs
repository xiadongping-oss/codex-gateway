#!/usr/bin/env node
// 打包闸门的变异测试
//
// 目的：证明 build-release.test.mjs 真的在保护那三道闸门，而不是「碰巧全绿」。
// 做法与 mutate.mjs 同源——注入真实缺陷，看测试是否变红：
//   测试失败 = 变异被杀死 = 这块逻辑确实受保护 ✓
//   测试仍绿 = 变异存活 = 盲区 ✗
//
// 为什么单独一个 runner：mutate.mjs 是「往沙盒源码注入缺陷 + 起服务 + 跑 audit」，
// 而这批变异作用于构建脚本、跑的是 node --test，两者夹具完全不同。
// 硬塞进 mutate.mjs 会把一个已验证过的框架改复杂，不值。
//
//   node mutate-build.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')
const SCRIPT = path.join(REPO, 'build-release.mjs')
const TEST_FILE = path.join(HERE, 'build-release.test.mjs')
const PKG = path.join(REPO, 'package.json')

const C = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' }

// ---------- 变异体 ----------
// 每一条都对应「闸门失效」的一种具体方式，不是随便改个符号。
const MUTANTS = [
  {
    id: 'MB1', desc: 'zip 层不再要求「顶层恰好一个目录」（v1.1.0 双目录坏包即可发出）',
    from: "  const tops = [...new Set(names.map((n) => n.split('/')[0]))]\n  if (tops.length !== 1) {",
    to: "  const tops = [NAME]\n  if (false) {"
  },
  {
    id: 'MB2', desc: 'zip 层不再拦 gateway/data（调用日志随包分发）',
    from: "    '/gateway/data/',\n",
    to: ''
  },
  {
    id: 'MB3', desc: 'zip 层不再检查 .sh 的 CRLF（bash 直接不可用）',
    from: '    if (readZipEntry(zipPath, n).includes(0x0d)) {',
    to: '    if (false) {'
  },
  {
    id: 'MB4', desc: '结构自检不再扫打包机绝对路径（v1.2.0 家目录泄露重现）',
    from: '        if (real.length) LEAK_HITS.push(',
    to: '        if (false) LEAK_HITS.push('
  },
  {
    id: 'MB5', desc: '复制黑名单放行 data/（数据目录会被带进 staging）',
    from: "  'data', 'logs', 'launcher.log',",
    to: "  'logs', 'launcher.log',"
  },
  {
    id: 'MB6', desc: '构建时不再比对运行时锁（同版本号静默产出不同二进制）',
    from: '  } else if (lock && lock.sha256 !== digest) {',
    to: '  } else if (false) {'
  },
  {
    id: 'MB7', desc: '校验时不再比对「声明哈希 vs 包内实物」',
    from: '    if (actual && actual !== info.node.sha256) {',
    to: '    if (false) {'
  },
  // ---- 换行符规范化与可复现构建 ----
  // 这一组的共同点：失效后包**照样能打出来、也能跑**，只是两台机器打出的字节不同，
  // 或者文件内容被悄悄改了一个换行。属于最难靠肉眼发现的一类。
  {
    id: 'MB8', desc: '复制阶段不再规范化换行符（CRLF 工作区打出的包与 LF 工作区不同）',
    from: '  if (TEXT_EXT.has(ext)) {\n    const fixed = normalizeEol(buf, ext)',
    to: '  if (false) {\n    const fixed = normalizeEol(buf, ext)'
  },
  {
    id: 'MB9', desc: '不把 LF 的 Windows 脚本补成 CRLF（cmd 对纯 LF 不稳）',
    from: '  return wantCRLF ? toCRLF(lf) : lf',
    to: '  return lf'
  },
  {
    id: 'MB10', desc: '把孤立 CR 静默转成换行（\\r\\r\\n 变成两个换行，悄悄改变内容）',
    from: "  if (lf.includes(0x0d)) return buf\n  return wantCRLF ? toCRLF(lf) : lf",
    to: "  return wantCRLF ? toCRLF(lf) : Buffer.from(lf.toString('latin1').replace(/\\r/g, '\\n'), 'latin1')"
  },
  {
    id: 'MB11', desc: '忽略 SOURCE_DATE_EPOCH（同源码两次构建的 BUILD-INFO 必然不同，无法比对）',
    from: '  builtAt: buildTimestamp(),',
    to: '  builtAt: new Date().toISOString(),'
  },
  {
    id: 'MB12', desc: 'SOURCE_DATE_EPOCH 非法值不再报错（悄悄回落到当前时间）',
    from: '  if (!Number.isFinite(sec) || sec <= 0) {',
    to: '  if (false) {'
  }
]

// ---------- 夹具：只拷三个文件就能跑测试 ----------
// 测试用 REPO = 测试文件的「上上层」，因此最小仓库 = package.json + build-release.mjs
// + gateway/tests/build-release.test.mjs。不必复制 292MB 的整个仓库。
function makeRepo(mutatedSource) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-mut-'))
  fs.mkdirSync(path.join(dir, 'gateway', 'tests'), { recursive: true })
  fs.copyFileSync(PKG, path.join(dir, 'package.json'))
  fs.copyFileSync(TEST_FILE, path.join(dir, 'gateway', 'tests', 'build-release.test.mjs'))
  fs.writeFileSync(path.join(dir, 'build-release.mjs'), mutatedSource)
  return dir
}

function runTests(dir) {
  try {
    execFileSync(process.execPath, ['--test', '--test-timeout=60000', 'gateway/tests/build-release.test.mjs'], {
      cwd: dir, stdio: 'ignore', timeout: 300000
    })
    return { passed: true }
  } catch (e) {
    return { passed: false, code: typeof e.status === 'number' ? e.status : 1 }
  }
}

// 语法预检：变异若把脚本改成语法错误，所有用例都会红，看着也像「被杀死」，
// 但这样证明不了任何东西——那只是把被测对象整个打碎了。这类变异要单独标记。
function parses(file) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const source = fs.readFileSync(SCRIPT, 'utf-8')

// ---------- 0) 基线：未变异的副本必须全绿 ----------
// 否则「变异被杀」可能只是因为环境本来就跑不过，会给你虚假的安心。
console.log(`${C.b}基线检查${C.x}：未变异的副本应当全绿`)
const baseDir = makeRepo(source)
try {
  const base = runTests(baseDir)
  if (!base.passed) {
    console.error(`${C.r}✗ 基线没通过${C.x} —— 先修 build-release.test.mjs，别在坏基线上做变异测试。`)
    process.exit(1)
  }
  console.log(`${C.g}✓ 基线通过${C.x}\n`)
} finally {
  fs.rmSync(baseDir, { recursive: true, force: true })
}

// ---------- 逐个注入 ----------
const rows = []
for (const m of MUTANTS) {
  if (!source.includes(m.from)) {
    rows.push({ ...m, result: 'anchor-missing' })
    console.log(`${C.y}? ${m.id}${C.x} 锚点未命中 —— 源码已变，请更新变异体`)
    continue
  }
  const dir = makeRepo(source.replace(m.from, m.to))
  try {
    if (!parses(path.join(dir, 'build-release.mjs'))) {
      rows.push({ ...m, result: 'syntax-error' })
      console.log(`${C.y}! ${m.id} 变异后语法不合法${C.x}  ${m.desc} —— 该变异体无效，请改写法`)
      continue
    }
    const r = runTests(dir)
    rows.push({ ...m, result: r.passed ? 'survived' : 'killed' })
    if (r.passed) console.log(`${C.r}✗ ${m.id} 存活${C.x}  ${m.desc}`)
    else console.log(`${C.g}✓ ${m.id} 被杀死${C.x}  ${m.desc}`)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const killed = rows.filter((r) => r.result === 'killed').length
const survived = rows.filter((r) => r.result === 'survived')
const missing = rows.filter((r) => r.result === 'anchor-missing')
const broken = rows.filter((r) => r.result === 'syntax-error')

console.log('\n' + '─'.repeat(70))
console.log(`  变异体 ${rows.length} 个 · 杀死 ${killed} · 存活 ${survived.length} · 锚点失效 ${missing.length} · 语法无效 ${broken.length}`)
console.log('─'.repeat(70))

if (survived.length || missing.length || broken.length) {
  if (survived.length) console.error(`${C.r}✗ 存在盲区${C.x}：${survived.map((r) => r.id).join(', ')}`)
  if (missing.length) console.error(`${C.y}! 锚点失效${C.x}：${missing.map((r) => r.id).join(', ')}`)
  if (broken.length) console.error(`${C.y}! 变异体语法无效${C.x}：${broken.map((r) => r.id).join(', ')}`)
  process.exit(1)
}
console.log(`${C.g}✅ 全部变异体被杀死，零盲区${C.x}`)
