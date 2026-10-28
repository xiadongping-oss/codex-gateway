#!/usr/bin/env node
// mutate-client.mjs — 证明 setup-client.test.mjs 不是假测试
//
// setup-client.mjs 是局域网用户的唯一入口，它出问题不会有任何报错，只有「照文档
// 做完但连不上」。给这种脚本补测试，最怕写出「永远绿」的用例——所以按项目惯例，
// 补完必须做变异验证：把真实行为一个个改坏，看测试是否逐个报红。
//
// 与其它两个变异 runner 的区别：
//   mutate.mjs        注入沙盒源码 → 起网关 → 跑 audit（HTTP 黑盒）
//   mutate-build.mjs  改构建脚本 → 跑 node --test（假仓库）
//   本脚本            改客户端脚本副本 → 跑 node --test（临时 HOME）
// 夹具不同，所以单独一个 runner，不去动已经验证过的两个框架。
//
//   node mutate-client.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')
const LANKIT = path.join(REPO, 'docs', 'lan-kit')
const TEST = path.join(HERE, 'setup-client.test.mjs')
const C = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' }

const MUTANTS = [
  {
    id: 'MC1', desc: '坏掉的 mcp.json 被直接覆盖（用户原配置丢失）',
    from: "    if (e.code !== 'ENOENT') die(`mcp.json 存在但无法解析（${e.message}），请先手工修复再运行。`)",
    to: '    if (false) die()'
  },
  {
    id: 'MC2', desc: '合并时清空已有条目（用户的其它 MCP 服务被抹掉）',
    from: '  const existed = !!mcp.mcpServers[name]',
    to: '  const existed = false; mcp.mcpServers = {}'
  },
  {
    id: 'MC3', desc: '--dry-run 也写盘（预览变成了真改）',
    from: '  if (!dryRun) {\n    fs.mkdirSync(path.dirname(mcpJsonPath), { recursive: true })',
    to: '  if (true) {\n    fs.mkdirSync(path.dirname(mcpJsonPath), { recursive: true })'
  },
  {
    id: 'MC4', desc: '非交互终端缺 --host 时不再报错（静默用默认地址装错机器）',
    from: "    if (!process.stdin.isTTY) die('缺少 --host（网关宿主机 IP 或域名，如 192.168.1.188）。也可在 http://<宿主机IP>:4173/setup 网页获取全部配置。')",
    to: "    if (false) host = '127.0.0.1'"
  },
  {
    id: 'MC5', desc: 'EMBEDDED_HOST 锚点被改成双引号（网关注入会静默失效）',
    from: "const EMBEDDED_HOST = ''",
    to: 'const EMBEDDED_HOST = ""'
  }
]

function makeCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-mut-client-'))
  // 连 skills/ 一起复制：有一条用例验证「随包 skill 会被安装」，
  // 只复制单个 .mjs 会让它降级跳过，变异就白跑了
  fs.cpSync(LANKIT, dir, { recursive: true })
  return { dir, script: path.join(dir, 'setup-client.mjs') }
}

function runTests(scriptPath) {
  try {
    execFileSync(process.execPath, ['--test', '--test-timeout=60000', TEST], {
      env: { ...process.env, CGW_SETUP_SCRIPT: scriptPath },
      stdio: 'ignore',
      timeout: 300000
    })
    return true
  } catch {
    return false
  }
}

console.log(`${C.b}变异测试 · 验证 setup-client.test.mjs 是否真能抓到缺陷${C.x}`)
console.log(`${C.d}被测对象：docs/lan-kit/setup-client.mjs · 变异体 ${MUTANTS.length} 个${C.x}\n`)

// 基线：不改任何东西时必须全绿。否则每个变异都会"被杀死"，毫无意义。
const baseline = makeCopy()
if (!runTests(baseline.script)) {
  console.error(`${C.r}✗ 基线失败：未变异的脚本就过不了测试${C.x}`)
  console.error(`${C.d}  先单独跑：npm run test:client${C.x}`)
  fs.rmSync(baseline.dir, { recursive: true, force: true })
  process.exit(1)
}
console.log(`${C.g}✓ 基线通过${C.x}  （未变异的脚本 14 例全绿）\n`)
fs.rmSync(baseline.dir, { recursive: true, force: true })

const rows = []
for (const m of MUTANTS) {
  const { dir, script } = makeCopy()
  try {
    const src = fs.readFileSync(script, 'utf8')
    if (!src.includes(m.from)) {
      rows.push({ ...m, result: 'anchor-missing' })
      console.log(`${C.y}! ${m.id} 锚点失效${C.x}  ${m.desc}`)
      continue
    }
    fs.writeFileSync(script, src.replace(m.from, m.to))
    const passed = runTests(script)
    rows.push({ ...m, result: passed ? 'survived' : 'killed' })
    if (passed) console.log(`${C.r}✗ ${m.id} 存活${C.x}  ${m.desc}`)
    else console.log(`${C.g}✓ ${m.id} 被杀死${C.x}  ${m.desc}`)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const killed = rows.filter((r) => r.result === 'killed').length
const survived = rows.filter((r) => r.result === 'survived')
const missing = rows.filter((r) => r.result === 'anchor-missing')

console.log('\n' + '─'.repeat(70))
console.log(`  变异体 ${rows.length} 个 · 杀死 ${killed} · 存活 ${survived.length} · 锚点失效 ${missing.length}`)
console.log('─'.repeat(70))

if (survived.length || missing.length) {
  if (survived.length) console.error(`${C.r}✗ 存在盲区${C.x}：${survived.map((r) => r.id).join(', ')}`)
  if (missing.length) console.error(`${C.y}! 锚点失效${C.x}：${missing.map((r) => r.id).join(', ')}（改了脚本请同步更新变异体）`)
  process.exit(1)
}
console.log(`${C.g}✅ 全部变异体被杀死，零盲区${C.x}`)
