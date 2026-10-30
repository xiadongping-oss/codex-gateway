import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createBridgePool } from '../bridge-pool.mjs'

const GW = fileURLToPath(new URL('..', import.meta.url))
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function fixture(t, port) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-desktop-'))
  const root = path.join(temp, '数据 space'), home = path.join(temp, 'home')
  fs.mkdirSync(home)
  if (!port) {
    const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
    port = server.address().port; await new Promise(r => server.close(r))
  }
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
    CGW_DATA_DIR: root, DISABLE_AUTOSTART: '1', LAUNCHER_PORT: String(port) }
  for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'CGW_DESKTOP', 'CGW_STORAGE_MODE', 'CGW_QUOTA_FILE', 'API_PROVIDERS_STORE_PATH', 'ASSETS_STORE_PATH', 'CODEX_HOME', 'CHATGPT_BRIDGE_HOME', 'CHATGPT_BRIDGE_DATA_DIR', 'CGW_ADMIN_TOKEN', 'CGW_LAN', 'CGW_LAN_HOST']) delete env[key]
  const child = spawn(process.execPath, [path.join(GW, 'desktop-entry.mjs')], { cwd: temp, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const exited = once(child, 'exit')
  let stderr = '', partial = '', seq = 0
  const frames = [], launchId = crypto.randomUUID(), challenge = crypto.randomBytes(32).toString('hex')
  child.stderr.on('data', b => { stderr += b })
  child.stdout.on('data', b => {
    partial += b
    while (partial.includes('\n')) {
      const end = partial.indexOf('\n'), line = partial.slice(0, end); partial = partial.slice(end + 1)
      try { frames.push(JSON.parse(line)) } catch { frames.push({ invalid: line }) }
    }
  })
  child.stdin.on('error', () => {})
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin.end()
      await Promise.race([exited, sleep(6000)])
      if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited }
    }
    fs.rmSync(temp, { recursive: true, force: true }) // only this test's mkdtemp root
  })
  async function wait(predicate, ms = 15000) {
    const end = Date.now() + ms
    while (Date.now() < end) {
      const result = frames.find(predicate)
      if (result) return result
      if (child.exitCode !== null || child.signalCode !== null) break
      await sleep(20)
    }
    assert.fail(`No expected frame; exit=${child.exitCode}, frames=${JSON.stringify(frames.map(x => ({ type: x.type, payload: x.type === 'fatal' ? x.payload : undefined })))}, stderr=${stderr}`)
  }
  function send(type, payload = {}) {
    const requestId = ++seq
    child.stdin.write(JSON.stringify({ protocol: 'cgw.desktop', version: 1, launchId, seq, requestId, kind: 'request', type, payload }) + '\n')
    return requestId
  }
  const command = (type, payload) => { const id = send(type, payload); return wait(x => x.requestId === id && x.kind === 'response') }
  async function initialize() {
    const r = await command('initialize', { challenge })
    assert.equal(r.payload.pid, child.pid); assert.equal(r.payload.challenge, challenge)
    assert.equal(r.payload.resourceRoot, fs.realpathSync(path.join(GW, '..')))
  }
  async function start() { await initialize(); await command('start'); return (await wait(x => x.type === 'ready')).payload }
  return { root, temp, home, child, frames, send, command, wait, initialize, start, exited, get stderr() { return stderr } }
}

test('desktop handshake does not initialize storage; wrong version cannot start business', async t => {
  const r = await fixture(t)
  await r.initialize()
  assert.equal(fs.existsSync(r.root), false)
  assert.equal((await r.command('bootstrap')).error.code, 'INVALID_STATE')
  r.child.stdin.write(JSON.stringify({ protocol: 'cgw.desktop', version: 2 }) + '\n')
  await r.wait(x => x.type === 'fatal')
  assert.equal((await r.exited)[0], 5)
  assert.equal(fs.existsSync(r.root), false)
})

test('real desktop: ticket exchange, replacement/replay, drain slow request, save and release', async t => {
  const r = await fixture(t), ready = await r.start()
  assert.equal(ready.dataRoot, r.root)
  const first = (await r.command('bootstrap')).payload.url
  const second = (await r.command('bootstrap')).payload.url
  assert.equal((await fetch(first, { redirect: 'manual' })).status, 403)
  const login = await fetch(second, { redirect: 'manual' })
  assert.equal(login.status, 302); assert.equal(login.headers.get('location'), '/')
  assert.equal(login.headers.get('referrer-policy'), 'no-referrer')
  assert.match(login.headers.get('set-cookie'), /HttpOnly/i)
  assert.equal((await fetch(second, { redirect: 'manual' })).status, 403)
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const body = JSON.stringify({ name: 'drain fixture' })
  const agent = new http.Agent({ keepAlive: true })
  t.after(() => agent.destroy())
  // Pre-existing keep-alive socket must also enforce admission on each request.
  const get = p => new Promise((resolve, reject) => {
    http.get(ready.origin + p, { agent, headers: { Cookie: cookie } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)) }).on('error', reject)
  })
  assert.equal(await get('/__gw/status'), 200)
  const slow = http.request(ready.origin + '/__gw/apikeys', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } })
  const response = new Promise((resolve, reject) => { slow.on('response', res => { res.resume(); res.on('end', () => resolve(res.statusCode)) }); slow.on('error', reject) })
  slow.write(body.slice(0, 5))
  for (let i = 0; i < 50; i++) {
    if ((await r.command('status')).payload.activeRequests > 0) break
    await sleep(20)
  }
  await r.command('shutdown', { reason: 'user_exit' })
  assert.equal((await r.command('status')).payload.state, 'draining')
  assert.equal(await get('/v1/models'), 503)
  assert.equal((await r.command('bootstrap')).error.code, 'INVALID_STATE')
  assert.equal(r.frames.some(x => x.type === 'stopped'), false)
  slow.end(body.slice(5))
  assert.equal(await response, 200)
  const stopped = (await r.wait(x => x.type === 'stopped')).payload
  assert.deepEqual(stopped, { state: 'stopped', outcome: 'graceful', persisted: true, childrenExited: true, exitCode: 0 })
  assert.equal((await r.exited)[0], 0)
  assert.equal(fs.existsSync(path.join(r.root, 'runtime/owner.lock')), false)
  assert.equal(JSON.parse(fs.readFileSync(path.join(r.root, 'api-keys.json'))).keys[0].name, 'drain fixture')
  assert.equal(r.frames.some(x => x.invalid), false)
  assert.deepEqual(r.frames.map(x => x.seq), r.frames.map((_, i) => i + 1))
  assert.equal(r.stderr.includes('_cgw_bootstrap='), false)
})

test('real desktop: occupied port reports failure, never sends ready, releases owned lock', async t => {
  const occupying = net.createServer(); occupying.listen(0, '127.0.0.1'); await once(occupying, 'listening')
  t.after(() => new Promise(resolve => occupying.close(resolve)))
  const r = await fixture(t, occupying.address().port)
  await r.initialize(); await r.command('start')
  assert.equal((await r.wait(x => x.type === 'fatal')).payload.code, 'PORT_IN_USE')
  assert.equal((await r.exited)[0], 2)
  assert.equal(r.frames.some(x => x.type === 'ready'), false)
  assert.equal(fs.existsSync(path.join(r.root, 'runtime/owner.lock')), false)
})

test('real desktop: parent EOF shuts down over pipe, without signals', async t => {
  const r = await fixture(t); await r.start(); r.child.stdin.end()
  const result = (await r.wait(x => x.type === 'stopped')).payload
  assert.equal(result.childrenExited, true); assert.equal(result.exitCode, 5)
  assert.equal((await r.exited)[0], 5)
  assert.equal(fs.existsSync(path.join(r.root, 'runtime/owner.lock')), false)
})

test('real desktop: flush failure stays draining; repair and continue saves pending key', async t => {
  const r = await fixture(t), ready = await r.start()
  const link = (await r.command('bootstrap')).payload.url
  const login = await fetch(link, { redirect: 'manual' })
  const cookie = login.headers.get('set-cookie').split(';')[0]
  // A directory in place of the target file reliably fails on Windows and Unix.
  const target = path.join(r.root, 'api-keys.json')
  fs.mkdirSync(target)
  const response = await fetch(ready.origin + '/__gw/apikeys', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'retry via pipe' }) })
  assert.equal(response.status, 200)
  await response.arrayBuffer()
  await r.command('shutdown', { reason: 'update' })
  const waiting = await r.wait(x => x.type === 'shutdown.waiting')
  assert.equal(waiting.payload.reason, 'FLUSH_FAILED')
  assert.equal(r.child.exitCode, null)
  assert.equal(fs.existsSync(path.join(r.root, 'runtime/owner.lock')), true)
  assert.equal((await r.command('status')).payload.state, 'draining')
  assert.equal((await r.command('shutdown.continue', { waitMs: 1 })).error.code, 'INVALID_ARGUMENT')
  fs.rmdirSync(target)
  await r.command('shutdown.continue', { waitMs: 30000 })
  assert.equal((await r.wait(x => x.type === 'stopped')).payload.outcome, 'graceful')
  assert.equal((await r.exited)[0], 0)
  assert.equal(JSON.parse(fs.readFileSync(target)).keys[0].name, 'retry via pipe')
})

test('real desktop: force after flush failure reports lost persistence and nonzero exit', async t => {
  const r = await fixture(t), ready = await r.start()
  const login = await fetch((await r.command('bootstrap')).payload.url, { redirect: 'manual' })
  fs.mkdirSync(path.join(r.root, 'api-keys.json'))
  const response = await fetch(ready.origin + '/__gw/apikeys', { method: 'POST', headers: { Cookie: login.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json' }, body: '{"name":"force fixture"}' })
  await response.arrayBuffer()
  await r.command('shutdown', { reason: 'user_exit' })
  await r.wait(x => x.type === 'shutdown.waiting')
  await r.command('shutdown.force')
  const result = (await r.wait(x => x.type === 'stopped')).payload
  assert.equal(result.persisted, false); assert.equal(result.outcome, 'failed'); assert.equal(result.exitCode, 1)
  assert.equal((await r.exited)[0], 1)
})

test('real stores: failed atomic writes throw; retry persists the same pending records', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-flush-'))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  const script = `
    const fs = await import('node:fs');
    const keys = await import(${JSON.stringify(pathToFileURL(path.join(GW, 'apikeys.mjs')).href)});
    const logs = await import(${JSON.stringify(pathToFileURL(path.join(GW, 'call-logs.mjs')).href)});
    keys.createApiKey({name:'retry'}); logs.recordCallLog({endpoint:'fixture'});
    fs.mkdirSync(process.env.CGW_DATA_DIR+'/api-keys.json');
    fs.mkdirSync(process.env.CGW_DATA_DIR+'/data/call-logs.json',{recursive:true});
    let failures=0; for (const flush of [keys.flushApiKeys,logs.flushCallLogs]) {try {flush()} catch {failures++}}
    if(failures!==2) process.exit(1);
    fs.rmdirSync(process.env.CGW_DATA_DIR+'/api-keys.json');
    fs.rmdirSync(process.env.CGW_DATA_DIR+'/data/call-logs.json');
    keys.flushApiKeys(); logs.flushCallLogs();
  `
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, CGW_DATA_DIR: temp, CGW_STORAGE_MODE: 'legacy', CGW_DESKTOP: '0' }, windowsHide: true, stdio: 'ignore' })
  assert.equal((await once(child, 'exit'))[0], 0)
  assert.equal(JSON.parse(fs.readFileSync(path.join(temp, 'api-keys.json'))).keys[0].name, 'retry')
  assert.equal(JSON.parse(fs.readFileSync(path.join(temp, 'data/call-logs.json'))).logs[0].endpoint, 'fixture')
})

test('real child process: pool stop waits for the OS exit event', async t => {
  let child, exited
  const pool = createBridgePool({
    spawn() {
      child = spawn(process.execPath, ['-e', 'process.stdout.write("ready\\n");setInterval(()=>{},1000)'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
      exited = once(child, 'exit')
      return child
    },
    probe: async () => { await once(child.stdout, 'data'); return { listening: true } }
  })
  t.after(async () => { pool.dispose(); if (child?.exitCode === null && child?.signalCode === null) { child.kill(); await exited } })
  assert.equal((await pool.start('fixture')).ok, true)
  assert.equal(pool.childCount(), 1)
  assert.equal(await pool.stopAndWait(3000), true)
  await exited
  assert.equal(pool.childCount(), 0)
  assert.throws(() => process.kill(child.pid, 0))
})

test('real streaming proxy: shutdown waits for final usage and persists the call log', async t => {
  let upstreamResponse
  const upstream = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      upstreamResponse = res
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: {"choices":[]}\n\n')
    })
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  t.after(() => { upstream.closeAllConnections(); return new Promise(resolve => upstream.close(resolve)) })
  const r = await fixture(t), ready = await r.start()
  const login = await fetch((await r.command('bootstrap')).payload.url, { redirect: 'manual' })
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const mode = await fetch(ready.origin + '/__gw/auth/mode', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'openai', apiKey: 'fixture-only', baseUrl: `http://127.0.0.1:${upstream.address().port}` }) })
  assert.equal(mode.status, 200); await mode.arrayBuffer()
  const keyResponse = await fetch(ready.origin + '/__gw/apikeys', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{"name":"stream fixture"}' })
  const key = await keyResponse.json()
  const request = http.request(ready.origin + '/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${key.key.token}`, 'Content-Type': 'application/json' } })
  const responsePromise = once(request, 'response')
  request.end('{"model":"fixture","stream":true,"messages":[]}')
  const [response] = await responsePromise
  assert.equal(response.statusCode, 200)
  const ended = once(response, 'end'); response.resume()
  await r.command('shutdown', { reason: 'user_exit' })
  const status = (await r.command('status')).payload
  assert.equal(status.state, 'draining'); assert.ok(status.activeRequests + status.backgroundTasks > 0)
  assert.equal(r.frames.some(x => x.type === 'stopped'), false)
  upstreamResponse.end('data: {"usage":{"prompt_tokens":7,"completion_tokens":3}}\n\ndata: [DONE]\n\n')
  await ended
  assert.equal((await r.wait(x => x.type === 'stopped')).payload.outcome, 'graceful')
  assert.equal((await r.exited)[0], 0)
  const stored = JSON.parse(fs.readFileSync(path.join(r.root, 'api-keys.json'))).keys[0]
  assert.equal(stored.promptTokens, 7); assert.equal(stored.completionTokens, 3)
  const log = JSON.parse(fs.readFileSync(path.join(r.root, 'data/call-logs.json'))).logs[0]
  assert.equal(log.endpoint, '/v1/chat/completions'); assert.equal(log.status, 200)
})
