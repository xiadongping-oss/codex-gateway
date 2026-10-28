#!/usr/bin/env node
// gateway/service-unix/ 的变异测试
//
// 目的：证明 service-unix.test.mjs 里的 15 条不是「碰巧全绿」。
// 这批脚本的失败方式都是静默的——自启装好了但开机就退、点了停止又被守护拉回来、
// 路径带空格时 systemd 按空格切参数。它们的共同点是：脚本仍然「能跑完、退出码 0」，
// 只有断言真的看住了行为才拦得住。
//
//   node gateway/tests/mutate-unix.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')
const SRC = path.join(REPO, 'gateway', 'service-unix')
const TEST_FILE = path.join(HERE, 'service-unix.test.mjs')

const C = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', b: '\x1b[1m', x: '\x1b[0m' }

// ---------- 变异体 ----------
const MUTANTS = [
  {
    id: 'MU1', file: 'install-autostart.sh',
    desc: 'systemd ExecStart 的路径不加引号（安装在带空格的目录就起不来）',
    from: 'ExecStart=/bin/bash "$RUNNER"',
    to: 'ExecStart=/bin/bash $RUNNER'
  },
  {
    id: 'MU2', file: 'install-autostart.sh',
    desc: '安装时不 enable 服务（开机根本不会启动）',
    from: '    systemctl --user enable codex-gateway.service || exit 1\n',
    to: ''
  },
  {
    id: 'MU3', file: 'install-autostart.sh',
    desc: '不支持的平台静默返回 0（用户以为装好了）',
    from: '    exit 1\n    ;;\nesac',
    to: '    exit 0\n    ;;\nesac'
  },
  {
    id: 'MU4', file: 'stop-gateway.sh',
    desc: '停止时不管 systemd（5 秒后被 Restart=always 拉回来）',
    from: '    if systemctl --user stop codex-gateway.service 2>/dev/null; then',
    to: '    if false; then'
  },
  {
    id: 'MU5', file: 'stop-gateway.sh',
    desc: '不校验命令行就杀 pid（pid 复用会误杀其它程序）',
    from: '  case "$cmd" in\n    *launcher.mjs*) ;;\n    *) return 1 ;;\n  esac',
    to: '  case "$cmd" in *) ;; esac'
  },
  {
    id: 'MU6', file: 'run-gateway.sh',
    desc: '不再轮转日志（每次启动覆盖上一轮，出事没有现场）',
    from: '  mv -f "$CGW_LOG_DIR/service.log" "$CGW_LOG_DIR/service.log.1"',
    to: '  :'
  },
  {
    id: 'MU7', file: 'start-gateway.sh', crlf: true,
    desc: '脚本被存成 CRLF（bash 直接报 invalid option，跑不起来）'
  }
]

function makeDir(mutant) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-mut-unix-'))
  for (const f of fs.readdirSync(SRC)) {
    if (!f.endsWith('.sh')) continue
    fs.copyFileSync(path.join(SRC, f), path.join(dir, f))
  }
  if (!mutant) return { dir, ok: true }
  const target = path.join(dir, mutant.file)
  let src = fs.readFileSync(target, 'utf8')
  if (mutant.crlf) {
    fs.writeFileSync(target, src.replace(/\n/g, '\r\n'))
    return { dir, ok: true }
  }
  if (!src.includes(mutant.from)) return { dir, ok: false }
  src = src.replace(mutant.from, mutant.to)
  fs.writeFileSync(target, src)
  // 语法预检：变异把脚本改成语法错误时所有用例都会红，看着也像「被杀死」，
  // 但那只是把被测对象整个打碎了，证明不了断言有效。
  try {
    execFileSync('bash', ['-n', target], { stdio: 'ignore' })
  } catch {
    return { dir, ok: true, syntaxError: true }
  }
  return { dir, ok: true }
}

function runTests(dir) {
  try {
    execFileSync(process.execPath, ['--test', '--test-timeout=30000', TEST_FILE], {
      cwd: REPO,
      env: { ...process.env, CGW_SERVICE_SRC: dir },
      stdio: 'ignore',
      timeout: 300000
    })
    return true
  } catch {
    return false
  }
}

// ---------- 0) 基线 ----------
console.log(`${C.b}基线检查${C.x}：未变异的副本应当全绿`)
const base = makeDir(null)
try {
  if (!runTests(base.dir)) {
    console.error(`${C.r}✗ 基线没通过${C.x} —— 先修 service-unix.test.mjs，别在坏基线上做变异测试。`)
    process.exit(1)
  }
  console.log(`${C.g}✓ 基线通过${C.x}\n`)
} finally {
  fs.rmSync(base.dir, { recursive: true, force: true })
}

// ---------- 逐个注入 ----------
const rows = []
for (const m of MUTANTS) {
  const made = makeDir(m)
  try {
    if (!made.ok) {
      rows.push({ ...m, result: 'anchor-missing' })
      console.log(`${C.y}? ${m.id}${C.x} 锚点未命中 —— 源码已变，请更新变异体`)
      continue
    }
    if (made.syntaxError) {
      rows.push({ ...m, result: 'syntax-error' })
      console.log(`${C.y}! ${m.id} 变异后语法不合法${C.x}  ${m.desc} —— 该变异体无效`)
      continue
    }
    const passed = runTests(made.dir)
    rows.push({ ...m, result: passed ? 'survived' : 'killed' })
    console.log(passed ? `${C.r}✗ ${m.id} 存活${C.x}  ${m.desc}` : `${C.g}✓ ${m.id} 被杀死${C.x}  ${m.desc}`)
  } finally {
    fs.rmSync(made.dir, { recursive: true, force: true })
  }
}

const killed = rows.filter((r) => r.result === 'killed').length
const survived = rows.filter((r) => r.result === 'survived')
const missing = rows.filter((r) => r.result === 'anchor-missing')
const broken = rows.filter((r) => r.result === 'syntax-error')

console.log(`\n${C.b}结果${C.x}：${killed}/${rows.length} 被杀死`)
if (survived.length) {
  console.error(`${C.r}✗ 盲区 ${survived.length} 个：${survived.map((m) => m.id).join(', ')}${C.x}`)
  console.error('  说明这些行为没有断言在看，补用例后重跑。')
}
if (missing.length) console.error(`${C.y}? 锚点失效 ${missing.length} 个：${missing.map((m) => m.id).join(', ')}${C.x}`)
if (broken.length) console.error(`${C.y}! 无效变异 ${broken.length} 个：${broken.map((m) => m.id).join(', ')}${C.x}`)

process.exit(survived.length || missing.length || broken.length ? 1 : 0)
