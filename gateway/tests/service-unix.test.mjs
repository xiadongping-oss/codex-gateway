// gateway/service-unix/ 的回归测试
//
// 为什么值得测：这些脚本在开发机上（Windows / Git Bash）根本跑不到真实
// launchd 与 systemd，只能靠肉眼 review；而它们的失败方式是「静默不生效」——
// 自启装好了但一开机就退、点了停止 5 秒又被拉起来。这类问题上线后才暴露太贵。
//
// 做法：把脚本复制进临时沙盒，PATH 前置一组 shell shim（uname / launchctl /
// systemctl / loginctl / ps / lsof / node），断言「调用了什么、写了什么文件、
// 退出码多少」。沙盒里的 HOME 也是临时的，不会碰到真实 ~/Library 或 ~/.config。
//
// CGW_SERVICE_SRC 可指向被变异的脚本副本（见 mutate-unix.mjs）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../..')
const SRC = process.env.CGW_SERVICE_SRC || path.join(REPO, 'gateway', 'service-unix')

const SHIM = `#!/usr/bin/env bash
name="$(basename "$0")"
printf '%s %s\\n' "$name" "$*" >> "$SHIM_LOG"
case "$name" in
  uname)
    echo "\${FAKE_UNAME:-Linux}"
    ;;
  launchctl)
    case "$1" in
      print) if [ "\${FAKE_LAUNCHD_LOADED:-0}" = "1" ]; then exit 0; else exit 1; fi ;;
      bootstrap) if [ "\${FAKE_BOOTSTRAP_FAIL:-0}" = "1" ]; then exit 1; else exit 0; fi ;;
      load) if [ "\${FAKE_LOAD_FAIL:-0}" = "1" ]; then exit 1; else exit 0; fi ;;
      *) exit 0 ;;
    esac
    ;;
  systemctl)
    for a in "$@"; do
      if [ "$a" = "is-active" ]; then
        if [ "\${FAKE_SVC_ACTIVE:-0}" = "1" ]; then exit 0; else exit 1; fi
      fi
    done
    exit 0
    ;;
  loginctl)
    echo "Linger=\${FAKE_LINGER:-no}"
    ;;
  ps)
    printf '%s\\n' "\${FAKE_PS_CMD:-}"
    ;;
  lsof)
    if [ -n "\${FAKE_LSOF_PIDS:-}" ]; then printf '%s\\n' "\${FAKE_LSOF_PIDS}"; fi
    exit 0
    ;;
  node)
    if [ "$1" = "-p" ]; then
      case "$2" in
        *split*|*major*) echo "\${FAKE_NODE_MAJOR:-22}" ;;
        *versions.node*) echo "\${FAKE_NODE_MAJOR:-22}.22.2" ;;
        *) echo ok ;;
      esac
      exit 0
    fi
    echo "RUN $*"
    ;;
  *) exit 0 ;;
esac
`

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-unix-'))
  const bin = path.join(root, 'bin')
  const home = path.join(root, 'home')
  const gw = path.join(root, 'gateway')
  const svc = path.join(gw, 'service-unix')
  fs.mkdirSync(bin, { recursive: true })
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(path.join(gw, 'logs'), { recursive: true })
  fs.mkdirSync(svc, { recursive: true })
  for (const f of fs.readdirSync(SRC)) {
    if (!f.endsWith('.sh')) continue
    const dst = path.join(svc, f)
    fs.copyFileSync(path.join(SRC, f), dst)
    fs.chmodSync(dst, 0o755)
  }
  for (const name of ['uname', 'launchctl', 'systemctl', 'loginctl', 'ps', 'lsof', 'node', 'sleep']) {
    if (name === 'sleep') continue // 用系统的 sleep，避免拖慢
    const p = path.join(bin, name)
    fs.writeFileSync(p, SHIM, { mode: 0o755 })
    fs.chmodSync(p, 0o755)
  }
  const shimLog = path.join(root, 'shim.log')
  const env = {
    ...process.env,
    PATH: bin + path.delimiter + (process.env.PATH || ''),
    HOME: home,
    SHIM_LOG: shimLog,
    USER: process.env.USER || 'tester'
  }
  const calls = () => (fs.existsSync(shimLog) ? fs.readFileSync(shimLog, 'utf8') : '')
  const run = (script, args = [], extra = {}) => {
    const r = spawnSync('bash', [path.join(svc, script), ...args], {
      env: { ...env, ...extra },
      encoding: 'utf8',
      timeout: 20000
    })
    return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }
  }
  return { root, bin, home, gw, svc, env, run, calls, path: { unit: path.join(home, '.config/systemd/user/codex-gateway.service'), plist: path.join(home, 'Library/LaunchAgents/com.codex-gateway.gateway.plist') } }
}

// ---------- 换行符：CRLF 的 .sh 在 bash 里会 `set: $'\r': invalid option` ----------

test('service-unix 下所有 .sh 都是 LF（CRLF 会让脚本直接跑不起来）', () => {
  const bad = []
  for (const f of fs.readdirSync(SRC)) {
    if (!f.endsWith('.sh')) continue
    if (fs.readFileSync(path.join(SRC, f)).includes(0x0d)) bad.push(f)
  }
  assert.deepEqual(bad, [], `以下脚本含 CR：${bad.join(', ')}`)
})

// ---------- Linux / systemd ----------

test('Linux 安装：写 unit、ExecStart 路径带引号、启用并重启服务', () => {
  const sb = makeSandbox()
  const r = sb.run('install-autostart.sh', [], { FAKE_UNAME: 'Linux' })
  assert.equal(r.code, 0, r.out)
  assert.ok(fs.existsSync(sb.path.unit), '应写出 systemd 用户单元')
  const unit = fs.readFileSync(sb.path.unit, 'utf8')
  assert.match(unit, /ExecStart=\/bin\/bash ".*run-gateway\.sh"/, '带空格的安装路径必须加引号，否则 systemd 按空格切参数')
  assert.match(unit, /Restart=always/)
  assert.match(unit, /WantedBy=default\.target/)
  const calls = sb.calls()
  assert.match(calls, /systemctl --user daemon-reload/)
  assert.match(calls, /systemctl --user enable codex-gateway\.service/)
  assert.match(calls, /systemctl --user restart codex-gateway\.service/)
})

test('Linux 安装：未开 linger 时给出 enable-linger 提示', () => {
  const sb = makeSandbox()
  const r = sb.run('install-autostart.sh', [], { FAKE_UNAME: 'Linux', FAKE_LINGER: 'no' })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /loginctl enable-linger/)
})

test('Linux 安装：已开 linger 时不再啰嗦', () => {
  const sb = makeSandbox()
  const r = sb.run('install-autostart.sh', [], { FAKE_UNAME: 'Linux', FAKE_LINGER: 'yes' })
  assert.equal(r.code, 0, r.out)
  assert.doesNotMatch(r.out, /loginctl enable-linger/)
})

test('Linux 卸载：disable + 删除单元文件', () => {
  const sb = makeSandbox()
  sb.run('install-autostart.sh', [], { FAKE_UNAME: 'Linux' })
  assert.ok(fs.existsSync(sb.path.unit))
  const r = sb.run('uninstall-autostart.sh', [], { FAKE_UNAME: 'Linux' })
  assert.equal(r.code, 0, r.out)
  assert.equal(fs.existsSync(sb.path.unit), false)
  assert.match(sb.calls(), /systemctl --user disable codex-gateway\.service/)
})

// ---------- macOS / launchd ----------

test('macOS 安装：plist 含 Label / Runner / KeepAlive，并 bootstrap', () => {
  const sb = makeSandbox()
  const r = sb.run('install-autostart.sh', [], { FAKE_UNAME: 'Darwin' })
  assert.equal(r.code, 0, r.out)
  assert.ok(fs.existsSync(sb.path.plist), '应写出 LaunchAgent plist')
  const plist = fs.readFileSync(sb.path.plist, 'utf8')
  assert.match(plist, /<string>com\.codex-gateway\.gateway<\/string>/)
  assert.match(plist, /run-gateway\.sh<\/string>/)
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/)
  assert.match(sb.calls(), /launchctl bootstrap gui\/\d+ .*com\.codex-gateway\.gateway\.plist/)
})

test('macOS 安装：bootstrap 失败时回退 load，两条都失败必须报错退出', () => {
  const ok = makeSandbox()
  const r1 = ok.run('install-autostart.sh', [], { FAKE_UNAME: 'Darwin', FAKE_BOOTSTRAP_FAIL: '1' })
  assert.equal(r1.code, 0, '应回退 launchctl load')
  assert.match(ok.calls(), /launchctl load -w/)

  const bad = makeSandbox()
  const r2 = bad.run('install-autostart.sh', [], { FAKE_UNAME: 'Darwin', FAKE_BOOTSTRAP_FAIL: '1', FAKE_LOAD_FAIL: '1' })
  assert.equal(r2.code, 1, '两种加载方式都失败时不能假装成功')
})

test('macOS 卸载：bootout 并删除 plist', () => {
  const sb = makeSandbox()
  sb.run('install-autostart.sh', [], { FAKE_UNAME: 'Darwin' })
  const r = sb.run('uninstall-autostart.sh', [], { FAKE_UNAME: 'Darwin' })
  assert.equal(r.code, 0, r.out)
  assert.equal(fs.existsSync(sb.path.plist), false)
  assert.match(sb.calls(), /launchctl bootout gui\/\d+\/com\.codex-gateway\.gateway/)
})

// ---------- 平台门禁 ----------

test('非 macOS/Linux 平台明确拒绝，不写任何文件', () => {
  const sb = makeSandbox()
  const r = sb.run('install-autostart.sh', [], { FAKE_UNAME: 'MINGW64_NT-10.0' })
  assert.equal(r.code, 1)
  assert.match(r.out, /不支持的平台/)
  assert.equal(fs.existsSync(sb.path.unit), false)
  assert.equal(fs.existsSync(sb.path.plist), false)
})

// ---------- 停止 ----------

test('停止：注册过自启时先交给 systemd 停（否则会被 Restart=always 拉回来）', () => {
  const sb = makeSandbox()
  const r = sb.run('stop-gateway.sh', [], { FAKE_UNAME: 'Linux', FAKE_SVC_ACTIVE: '1' })
  assert.equal(r.code, 0, r.out)
  const calls = sb.calls()
  assert.match(calls, /systemctl --user is-active --quiet codex-gateway\.service/)
  assert.match(calls, /systemctl --user stop codex-gateway\.service/)
})

// 起一个「假网关进程」：让 bash 自己把 MSYS pid 写进文件再 exec sleep。
// 直接用 Node 的 child.pid 在 Windows 上拿到的是原生 pid，MSYS 的 kill 不认，
// 会让「杀不掉」和「没敢杀」两种完全不同的结果看起来一样。
function startDummy(pidFile) {
  const child = spawn('bash', ['-c', `echo $$ > "${pidFile}"; exec sleep 60`], { stdio: 'ignore' })
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim()) break
    spawnSync('bash', ['-c', 'sleep 0.05'])
  }
  return child
}

// 存活判断也走 bash（与脚本同一套 pid 语义）
function alive(pid) {
  return spawnSync('bash', ['-c', `kill -0 ${pid}`]).status === 0
}

test('停止：pid 文件指向 launcher 就杀掉并清 pid 文件', () => {
  const sb = makeSandbox()
  const pidFile = path.join(sb.gw, 'logs', 'service.pid')
  const child = startDummy(pidFile)
  try {
    const pid = fs.readFileSync(pidFile, 'utf8').trim()
    const r = sb.run('stop-gateway.sh', [], { FAKE_UNAME: 'Linux', FAKE_PS_CMD: 'node launcher.mjs --lan' })
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /已停止进程/)
    assert.equal(alive(pid), false, 'pid 匹配 launcher 的进程应该被杀掉')
    assert.equal(fs.existsSync(pidFile), false)
  } finally {
    child.kill()
  }
})

test('停止：pid 被别的程序复用时不许误杀', () => {
  const sb = makeSandbox()
  const pidFile = path.join(sb.gw, 'logs', 'service.pid')
  const child = startDummy(pidFile)
  try {
    const pid = fs.readFileSync(pidFile, 'utf8').trim()
    const r = sb.run('stop-gateway.sh', [], { FAKE_UNAME: 'Linux', FAKE_PS_CMD: '/usr/bin/something-else --flag' })
    assert.equal(r.code, 0, r.out)
    assert.equal(alive(pid), true, '命令行不含 launcher.mjs 的进程必须放过')
    // pid 文件仍应被清掉：它已经指向一个无关进程，留着下次更危险
    assert.equal(fs.existsSync(pidFile), false)
  } finally {
    child.kill()
  }
})

test('停止：没有任何实例时不报错，只说没找到', () => {
  const sb = makeSandbox()
  const r = sb.run('stop-gateway.sh', [], { FAKE_UNAME: 'Linux', FAKE_LSOF_PIDS: '' })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /没有发现运行中的网关/)
})

// ---------- 运行器 ----------

test('运行器：日志轮转、透传参数、记录 pid、用 CGW_NODE 指定的运行时', () => {
  const sb = makeSandbox()
  const logFile = path.join(sb.gw, 'logs', 'service.log')
  fs.writeFileSync(logFile, '上一轮日志\n')
  const nodeShim = path.join(sb.bin, 'node')
  const r = sb.run('run-gateway.sh', ['--demo'], { FAKE_UNAME: 'Linux', CGW_NODE: nodeShim })
  assert.equal(r.code, 0, r.out)
  assert.equal(fs.readFileSync(path.join(sb.gw, 'logs', 'service.log.1'), 'utf8'), '上一轮日志\n', '旧日志应留存为 .1')
  const log = fs.readFileSync(logFile, 'utf8')
  assert.match(log, /RUN launcher\.mjs --lan --demo/, '必须以 --lan 启动并透传额外参数')
  const pid = fs.readFileSync(path.join(sb.gw, 'logs', 'service.pid'), 'utf8').trim()
  assert.match(pid, /^\d+$/)
})

test('运行器：Node 版本过低时给出警告但不阻断启动', () => {
  const sb = makeSandbox()
  const nodeShim = path.join(sb.bin, 'node')
  const r = sb.run('run-gateway.sh', [], { FAKE_UNAME: 'Linux', CGW_NODE: nodeShim, FAKE_NODE_MAJOR: '18' })
  // 警告写 stderr（不进 service.log），启动本身照常
  assert.match(r.out, /低于建议的 20/)
  assert.equal(fs.readFileSync(path.join(sb.gw, 'logs', 'service.log'), 'utf8').includes('RUN launcher.mjs'), true)
})
