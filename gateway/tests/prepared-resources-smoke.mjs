// Explicit native-host smoke test of a prepared resource tree, using disposable data.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { verifyDesktop } from '../../prepare-desktop.mjs'

const arg = process.argv.find(a => a.startsWith('--resources='))?.slice(12)
if (!arg) throw new Error('需要 --resources=<已准备的资源目录>')
const resources = path.resolve(arg), target = `${process.platform}-${process.arch}`
const info = verifyDesktop({ target, outDir: resources })
const node = path.join(resources, info.node)
const identity = JSON.parse(execFileSync(node, ['-p', 'JSON.stringify({version:process.version,platform:process.platform,arch:process.arch})'], { encoding: 'utf8', windowsHide: true }))
assert.equal(identity.version, info.runtime.version)
assert.equal(`${identity.platform}-${identity.arch}`, target)

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-prepared-smoke-'))
const dataRoot = path.join(temp, '数据 with space'), home = path.join(temp, 'home')
fs.mkdirSync(home)
const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
  CGW_DATA_DIR: dataRoot, DISABLE_AUTOSTART: '1' }
for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'CGW_DESKTOP', 'CGW_STORAGE_MODE', 'CGW_QUOTA_FILE', 'API_PROVIDERS_STORE_PATH', 'ASSETS_STORE_PATH', 'CODEX_HOME', 'CHATGPT_BRIDGE_HOME', 'CHATGPT_BRIDGE_DATA_DIR', 'CGW_ADMIN_TOKEN', 'CGW_ADMIN_AUTH', 'CGW_LAN', 'CGW_LAN_HOST', 'FRONTEND_DIR', 'BRIDGE_CLI', 'BRIDGE_NODE', 'BRIDGE_ARGS', 'BRIDGE_PORT']) delete env[key]
const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
env.LAUNCHER_PORT = String(server.address().port)
await new Promise(resolve => server.close(resolve))
const child = spawn(node, [path.join(resources, info.entry)], { cwd: temp, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
const exited = once(child, 'exit'), frames = []
let seq = 0, incoming = '', stderr = ''
const launchId = crypto.randomUUID(), challenge = crypto.randomBytes(32).toString('hex')
child.stdin.on('error', () => {})
child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-2000) })
child.stdout.on('data', bytes => {
  incoming += bytes
  while (incoming.includes('\n')) {
    const i = incoming.indexOf('\n'), line = incoming.slice(0, i); incoming = incoming.slice(i + 1)
    try { frames.push(JSON.parse(line)) } catch { frames.push({ invalid: true }) }
  }
})
async function wait(predicate) {
  const end = performance.now() + 15_000
  while (performance.now() < end) {
    const frame = frames.find(predicate)
    if (frame) return frame
    if (child.exitCode !== null || child.signalCode !== null) break
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`Prepared gateway smoke timed out (exit=${child.exitCode}): ${stderr}`)
}
async function command(type, payload = {}) {
  const requestId = ++seq
  child.stdin.write(JSON.stringify({ protocol: 'cgw.desktop', version: 1, launchId, seq, requestId, kind: 'request', type, payload }) + '\n')
  const result = await wait(f => f.kind === 'response' && f.requestId === requestId)
  assert.equal(result.ok, true)
  return result.payload
}
try {
  const initialized = await command('initialize', { challenge })
  assert.equal(initialized.pid, child.pid); assert.equal(initialized.challenge, challenge)
  assert.equal(initialized.resourceRoot, fs.realpathSync(resources))
  assert.equal(fs.existsSync(dataRoot), false)
  await command('start')
  const ready = (await wait(f => f.type === 'ready')).payload
  assert.equal(ready.dataRoot, dataRoot)
  const bootstrap = await command('bootstrap')
  const response = await fetch(bootstrap.url, { redirect: 'manual', signal: AbortSignal.timeout(3000) })
  assert.equal(response.status, 302); await response.arrayBuffer()
  await command('shutdown', { reason: 'user_exit' })
  const stopped = (await wait(f => f.type === 'stopped')).payload
  assert.equal(stopped.outcome, 'graceful'); assert.equal(stopped.persisted, true); assert.equal(stopped.childrenExited, true)
  assert.equal((await exited)[0], 0)
  assert.equal(fs.existsSync(path.join(dataRoot, 'runtime/owner.lock')), false)
  assert.equal(frames.some(f => f.invalid), false)
  verifyDesktop({ target, outDir: resources })
  console.log(`✓ ${target} bundled Node ${identity.version}: initialize/start/ready/bootstrap/shutdown/exit passed; resources unchanged; disposable data only`)
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    child.stdin.end()
    for (let i = 0; i < 120 && child.exitCode === null && child.signalCode === null; i++) await new Promise(resolve => setTimeout(resolve, 50))
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exited
  }
  fs.rmSync(temp, { recursive: true, force: true })
}
