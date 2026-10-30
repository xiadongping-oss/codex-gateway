import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { spawn } from 'node:child_process'

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
export async function freePort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}
export async function desktopFixture({ resources, node, root, dataRoot = path.join(root, '数据 用户 & # % !'), port, overrides = {} }) {
  const home = path.join(root, '隔离 HOME')
  fs.mkdirSync(home, { recursive: true })
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (/^(CGW_|CHATGPT_|CODEX_HOME$|NODE_OPTIONS$|NODE_PATH$|LAUNCHER_PORT$|BRIDGE_|API_PROVIDERS_STORE_PATH$|ASSETS_STORE_PATH$|FRONTEND_DIR$|DISABLE_AUTOSTART$)/.test(key)) delete env[key]
  }
  Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
    CGW_DATA_DIR: dataRoot, LAUNCHER_PORT: String(port || await freePort()), DISABLE_AUTOSTART: '1' }, overrides)
  const child = spawn(node, [path.join(resources, 'gateway/desktop-entry.mjs')], { cwd: root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const exited = once(child, 'exit'), frames = [], launchId = crypto.randomUUID()
  let seq = 0, pending = '', stderr = '', totalBytes = 0
  child.stdin.on('error', () => {})
  child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-16000) })
  child.stdout.on('data', bytes => {
    totalBytes += bytes.length; pending += bytes
    while (pending.includes('\n')) {
      const end = pending.indexOf('\n'), line = pending.slice(0, end); pending = pending.slice(end + 1)
      try { frames.push(JSON.parse(line)) } catch { frames.push({ invalid: true }) }
    }
  })
  function encode(type, payload = {}, extra = {}) {
    seq++
    return JSON.stringify({ protocol: 'cgw.desktop', version: 1, launchId, seq, requestId: seq, kind: 'request', type, payload, ...extra }) + '\n'
  }
  function send(type, payload, extra) { child.stdin.write(encode(type, payload, extra)); return seq }
  async function wait(predicate, ms = 15_000, from = 0) {
    const end = performance.now() + ms
    while (performance.now() < end) {
      const frame = frames.slice(from).find(predicate)
      if (frame) return frame
      if (child.exitCode !== null || child.signalCode !== null) break
      await sleep(20)
    }
    assert.fail(`No expected frame (exit=${child.exitCode}); types=${frames.map(x => x.type).join(',')}; ${stderr}`)
  }
  async function exitWithin(ms = 8000) {
    const end = performance.now() + ms
    while (child.exitCode === null && child.signalCode === null && performance.now() < end) await sleep(20)
    assert.ok(child.exitCode !== null || child.signalCode !== null, 'owned Node did not exit within deadline')
    return exited
  }
  async function command(type, payload, extra) {
    const requestId = send(type, payload, extra)
    return wait(f => f.kind === 'response' && f.requestId === requestId)
  }
  async function initialize() {
    const challenge = crypto.randomBytes(32).toString('hex')
    const response = await command('initialize', { challenge })
    assert.equal(response.ok, true); assert.equal(response.payload.challenge, challenge); assert.equal(response.payload.pid, child.pid)
    return response.payload
  }
  let ready, cookie
  async function start() {
    await initialize(); assert.equal((await command('start')).ok, true)
    ready = (await wait(f => f.type === 'ready')).payload
    return ready
  }
  async function login() {
    const reply = await command('bootstrap'); assert.equal(reply.ok, true)
    const response = await fetch(reply.payload.url, { redirect: 'manual', signal: AbortSignal.timeout(3000) })
    assert.equal(response.status, 302)
    cookie = response.headers.get('set-cookie').split(';')[0]; await response.arrayBuffer()
    return cookie
  }
  async function request(p, body, method = body === undefined ? 'GET' : 'POST') {
    return fetch(ready.origin + p, { method, headers: { Cookie: cookie || '', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) })
  }
  async function stop() {
    if (child.exitCode !== null || child.signalCode !== null) return
    child.stdout.resume(); child.stdin.end()
    const end = performance.now() + 7000
    while (child.exitCode === null && child.signalCode === null && performance.now() < end) await sleep(25)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exited
  }
  return { child, frames, launchId, dataRoot, home, env, exited, encode, send, command, initialize, start, wait, exitWithin, stop, login, request,
    get ready() { return ready }, get cookie() { return cookie }, get stderr() { return stderr }, get outputBytes() { return totalBytes } }
}
