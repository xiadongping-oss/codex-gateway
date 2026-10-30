// Development-only native window smoke. Always isolates data, HOME and WebView state.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { verifyDesktop } from '../prepare-desktop.mjs'
import { NATIVE_SCENARIOS } from './validation.mjs'

const desktop = path.dirname(fileURLToPath(import.meta.url))
const target = `${process.platform}-${process.arch}`
const executable = path.join(desktop, 'src-tauri/target/debug', process.platform === 'win32' ? 'codex-gateway-desktop.exe' : 'codex-gateway-desktop')
const resources = path.join(path.dirname(executable), 'gateway-resources')
verifyDesktop({ target, outDir: resources })
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-d01-window-'))
const data = path.join(root, '数据 & # % !')
const interactive = process.argv.includes('--interactive'), conflict = process.argv.includes('--port-conflict')
const scenario = process.argv.find(a => a.startsWith('--case='))?.slice(7) || 'normal'
assert.ok(['normal', 'session-loss', 'channel-loss', 'desktop', 'tray-menu', 'node-crash', 'crash-loop', 'shell-crash'].includes(scenario), 'unknown smoke case')
assert.ok(scenario !== 'tray-menu' || interactive, 'tray-menu requires --interactive')
let foreignConnections = 0
const server = net.createServer(socket => { foreignConnections++; socket.destroy() })
server.listen(0, '127.0.0.1'); await once(server, 'listening')
const port = server.address().port
if (!conflict) await new Promise(resolve => server.close(resolve))
else if (interactive) setTimeout(() => server.close(), 12_000).unref()
const isolatedArgs = [`--data-dir=${data}`, `--resources=${resources}`, `--port=${port}`, '--isolated']
let child = spawn(executable, [...isolatedArgs, ...(scenario === 'desktop' ? ['--from-autostart'] : []), ...(!interactive ? ['--smoke', `--smoke-case=${scenario}`] : scenario === 'tray-menu' ? ['--smoke-case=tray-menu'] : [])], { cwd: os.tmpdir(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
child.stdout.on('data', () => {})
let stderr = ''; child.stderr.on('data', b => { stderr = (stderr + b).slice(-3000) })
let crashedNode = null
if (scenario === 'shell-crash') child.stderr.on('data', () => {
  if (!crashedNode && stderr.includes('D04_SHELL_READY')) {
    crashedNode = JSON.parse(fs.readFileSync(path.join(data, 'runtime/owner.lock'))).pid
    child.kill('SIGKILL')
  }
})
console.log(JSON.stringify({ phase: 'window-started', pid: child.pid, port, testRoot: root }))
let expired = false, passed = false
const deadline = interactive ? 180_000 : NATIVE_SCENARIOS[conflict ? 'port-conflict' : scenario]
const started = Date.now()
const timer = setTimeout(() => { expired = true; child.kill('SIGKILL') }, deadline)
try {
  let [code] = await once(child, 'exit')
  if (scenario === 'shell-crash') {
    assert.ok(crashedNode, 'native console must be ready before shell termination')
    let alive = true
    for (let attempt = 0; attempt < 100 && alive; attempt++) {
      try { process.kill(crashedNode, 0) } catch (error) { if (error.code === 'ESRCH') alive = false; else throw error }
      if (alive) await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.equal(alive, false, 'kill-on-close must stop the actual bundled Node')
    // On macOS the closed private pipe may let Node release its lock before the
    // guardian terminates the group. Both outcomes must allow a fresh session.
    const staleOwnership = fs.existsSync(path.join(data, 'runtime/owner.lock'))
    if (process.platform === 'win32') assert.ok(staleOwnership, 'abrupt exit should leave the matching ownership receipt for recovery')
    child = spawn(executable, [...isolatedArgs, '--smoke'], { cwd: os.tmpdir(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', () => {}); child.stderr.on('data', b => { stderr = (stderr + b).slice(-3000) })
    ;[code] = await once(child, 'exit')
    const log = fs.readFileSync(path.join(root, 'CodexGatewayDesktop/logs/desktop.log'), 'utf8')
    if (staleOwnership) assert.match(log, /recovery_scheduled/)
    console.log(JSON.stringify({ shellCrash: staleOwnership ? 'owned_lock_recovered' : 'gateway_released_on_pipe_close' }))
    console.log('D04_SHELL_RECOVERY true')
  }
  clearTimeout(timer)
  const recoveryEvidence = { scheduled: (stderr.match(/D04_RECOVERY_SCHEDULED/g) || []).length, limitVerified: stderr.includes('D04_RECOVERY_LIMIT true') }
  console.log(JSON.stringify({ scenario, elapsedMs: Date.now() - started, deadlineMs: deadline, expired, recovery: recoveryEvidence }))
  assert.equal(expired, false, 'window failed to finish within its test deadline; see recovery counters above')
  assert.equal(code, conflict && !interactive ? 1 : 0, stderr || 'unexpected desktop exit')
  assert.equal(foreignConnections, 0, 'a foreign service must never receive a login request')
  if (conflict && !interactive) {
    const log = fs.readFileSync(path.join(root, 'CodexGatewayDesktop/logs/desktop.log'), 'utf8')
    assert.match(log, /port_in_use/)
    assert.equal((log.match(/ starting\n/g) || []).length, 1)
    assert.equal(log.includes('recovery_scheduled'), false)
  }
  if (!interactive && !conflict) {
    const report = JSON.parse(stderr.split('\n').findLast(line => line.startsWith('D02_CHECK '))?.slice(10) || '{}')
    for (const key of ['authenticated','mounted','cleanUrl','nativeDenied','coreDenied','cookieHidden','historyClean','navigationSafe']) assert.equal(report[key], true, `native console check: ${key}`)
    assert.ok(report.externalDispatches >= 2)
    if (scenario === 'session-loss') assert.match(stderr, /D02_SESSION_RETURN true/)
    if (scenario === 'channel-loss') assert.match(stderr, /D02_CHANNEL_RETURN true/)
    if (scenario === 'node-crash') assert.equal((stderr.match(/D04_RECOVERY_SCHEDULED/g) || []).length, 1)
    if (scenario === 'crash-loop') { assert.match(stderr, /D04_RECOVERY_LIMIT true/); assert.equal((stderr.match(/D04_RECOVERY_SCHEDULED/g) || []).length, 3) }
    if (scenario === 'desktop') for (const check of ['AUTOSTART', 'RESIDENT', 'SINGLE_INSTANCE']) assert.ok(stderr.includes(`D03_${check} true`), `desktop check: ${check}`)
    console.log(JSON.stringify({ scenario, console: report, recoveryVerified: scenario !== 'normal' }))
  }
  assert.equal(fs.existsSync(path.join(data, 'runtime/owner.lock')), false, 'gateway ownership was not released')
  if (!conflict || interactive) assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'storage-layout.json'))).schemaVersion, 1)
  verifyDesktop({ target, outDir: resources })
  passed = true
} finally {
  clearTimeout(timer); if (server.listening) server.close()
  // Preserve failed runs for diagnosis; only remove the explicitly owned temp root.
  if (passed) {
    const actual = fs.realpathSync(root), parent = fs.realpathSync(os.tmpdir())
    assert.equal(path.dirname(actual), parent); assert.ok(path.basename(actual).startsWith('cgw-d01-window-'))
    fs.rmSync(actual, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    console.log('PASS: native window, bundled Node, isolated data, actual exit, released lock, unchanged resources')
  }
}
