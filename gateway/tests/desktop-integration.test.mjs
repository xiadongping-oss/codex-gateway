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
import { migrationGuardPath } from '../storage-paths.mjs'
import { accountFingerprint } from '../auth-core.mjs'

const GW = fileURLToPath(new URL('..', import.meta.url))
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function fixture(t, port, dataRoot) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-desktop-'))
  const root = dataRoot || path.join(temp, '数据 space'), home = path.join(temp, 'home')
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

test('desktop publishes audited capabilities and authentication switches only after durable save',async t=>{
  const r=await fixture(t), ready=await r.start()
  const login=await fetch((await r.command('bootstrap')).payload.url,{redirect:'manual'})
  const headers={Cookie:login.headers.get('set-cookie').split(';')[0],'Content-Type':'application/json'}
  const catalog=await(await fetch(ready.origin+'/__gw/models',{headers})).json()
  assert.equal(catalog.capabilities.mode,'bridge')
  assert.equal(catalog.capabilities.image.find(f=>f.id==='mask').status,'wired')
  assert.equal(catalog.capabilities.verification,null,'fresh workspaces do not inherit another account’s live evidence')
  const update=enabled=>fetch(ready.origin+'/__gw/strict-auth',{method:'POST',headers,body:JSON.stringify({enabled})})
  assert.equal((await update(true)).status,200)
  assert.equal((await fetch(ready.origin+'/v1/models')).status,401)
  const config=path.join(r.root,'.gw-config.json'), original=path.join(r.root,'config-before-failed-save.json')
  fs.renameSync(config,original);fs.mkdirSync(config)
  assert.equal((await update(false)).status,503)
  const state=await(await fetch(ready.origin+'/__gw/strict-auth',{headers})).json()
  assert.equal(state.enabled,true);assert.equal(state.enforced,true)
  assert.equal((await fetch(ready.origin+'/v1/models')).status,401,'failed disk write cannot relax access control')
  fs.rmdirSync(config);fs.renameSync(original,config)
  assert.equal((await update(false)).status,200)
  assert.equal((await fetch(ready.origin+'/v1/models')).status,200)
  await r.command('shutdown',{reason:'user_exit'});await r.exited
})

test('desktop local import preserves a newer saved login without changing credentials or selection', async t => {
  const r = await fixture(t), ready = await r.start()
  const snapshot = (iat, refresh) => ({ auth_mode: 'chatgpt', last_refresh: new Date(iat * 1000).toISOString(),
    tokens: { account_id: 'synthetic-local-import', refresh_token: refresh,
      access_token: `e30.${Buffer.from(JSON.stringify({ iat })).toString('base64url')}.synthetic` } })
  const saved = snapshot(200, 'synthetic-newer'), incoming = snapshot(100, 'synthetic-older')
  fs.mkdirSync(path.join(r.root, 'accounts'), { recursive: true })
  fs.mkdirSync(path.join(r.home, '.codex'), { recursive: true })
  const authPath = path.join(r.root, 'accounts', 'acc_saved.json')
  const registryPath = path.join(r.root, 'accounts.json')
  const authBytes = JSON.stringify(saved), registryBytes = JSON.stringify({ activeId: 'acc_saved',
    accounts: [{ id: 'acc_saved', name: 'Saved login', provider: 'oauth', mode: 'bridge', fingerprint: accountFingerprint(saved) }] })
  fs.writeFileSync(authPath, authBytes)
  fs.writeFileSync(registryPath, registryBytes)
  fs.writeFileSync(path.join(r.home, '.codex', 'auth.json'), JSON.stringify(incoming))
  const readConfig = () => fs.existsSync(path.join(r.root, '.gw-config.json')) ? fs.readFileSync(path.join(r.root, '.gw-config.json'), 'utf8') : null
  const configBytes = readConfig()
  const login = await fetch((await r.command('bootstrap')).payload.url, { redirect: 'manual' })
  const headers = { Cookie: login.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json' }
  const response = await fetch(ready.origin + '/__gw/codex-local/import', { method: 'POST', headers, body: '{}' })
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.equal(result.preservedExistingAuth, true)
  assert.equal(result.preservationReason, 'newer')
  assert.equal(result.activeId, 'acc_saved')
  assert.equal(fs.readFileSync(authPath, 'utf8'), authBytes, 'saved refresh token must not be overwritten')
  assert.equal(fs.readFileSync(registryPath, 'utf8'), registryBytes)
  assert.equal(readConfig(), configBytes)
  assert.deepEqual(fs.readdirSync(path.join(r.root, 'accounts')), ['acc_saved.json'])
  assert.equal((await (await fetch(ready.origin + '/__gw/status', { headers })).json()).bridgeInstances.length, 0, 'preserving login must not restart the bridge')
  const inactiveRegistry = JSON.stringify({ ...JSON.parse(registryBytes), activeId: null })
  fs.writeFileSync(registryPath, inactiveRegistry)
  const inactive = await fetch(ready.origin + '/__gw/codex-local/import', { method: 'POST', headers, body: '{}' })
  assert.equal(inactive.status, 409)
  assert.equal((await inactive.json()).error, 'local_auth_older_than_saved')
  assert.equal(fs.readFileSync(authPath, 'utf8'), authBytes)
  assert.equal(fs.readFileSync(registryPath, 'utf8'), inactiveRegistry, 'import must not silently switch accounts')
  await r.command('shutdown', { reason: 'user_exit' }); await r.exited
})

test('desktop LAN: live management, authentication, rollback, persistence and shutdown', async t => {
  const r = await fixture(t), ready = await r.start()
  assert.equal(ready.bindHost, '127.0.0.1')
  const login = await fetch((await r.command('bootstrap')).payload.url, { redirect: 'manual' })
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const headers = { Cookie: cookie, 'Content-Type': 'application/json' }
  const control = (body, extra = {}) => fetch(ready.origin + '/__gw/lan', { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) })
  const occupying = net.createServer(); occupying.listen(0, '0.0.0.0'); await once(occupying, 'listening')
  t.after(() => new Promise(resolve => occupying.close(resolve)))
  const busyPort = occupying.address().port
  const probe = net.createServer(); probe.listen(0, '0.0.0.0'); await once(probe, 'listening')
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve))
  assert.equal((await control({ enabled: true, port }, { Cookie: '' })).status, 401)
  assert.equal((await control({ enabled: true, port }, { Origin: 'https://example.com' })).status, 403)
  assert.equal((await control({ enabled: true, port: ready.port })).status, 400)
  assert.equal((await control({ enabled: true, port: '4174' })).status, 400)
  const enabled = await control({ enabled: true, port })
  assert.equal(enabled.status, 200)
  const status = (await enabled.json()).lan
  assert.equal(status.enabled, true); assert.equal(status.port, port); assert.equal(status.manageable, true)
  assert.ok(status.addresses.every(a => a.port === port))
  const origin = `http://127.0.0.1:${port}`
  assert.equal((await fetch(origin + '/v1/models')).status, 401)
  assert.equal((await fetch(origin + '/v1/models', { headers: { Authorization: 'Bearer cgw-invalid-fixture' } })).status, 401)
  for (const p of ['/', '/__gw/status', '/__gw/apikeys', '/__gw/admin/bootstrap', '/__gw/lan']) {
    assert.equal((await fetch(origin + p, { headers })).status, 403, p)
  }
  const key = await (await fetch(ready.origin + '/__gw/apikeys', { method: 'POST', headers, body: '{"name":"LAN fixture"}' })).json()
  assert.equal((await fetch(origin + '/v1/models', { headers: { Authorization: `Bearer ${key.key.token}` } })).status, 200)
  // Real shared-port browser entrypoints, client download and per-Key gallery.
  for(const route of ['/setup','/gallery']) {
    const page=await fetch(origin+route);assert.equal(page.status,200,route)
    assert.match(page.headers.get('content-type'),/text\/html/)
    const body=await page.text();assert.match(body,/API Key/)
    if(route==='/setup'){
      assert.ok(!body.includes('__CGW_LOCAL_ORIGIN__'),'共享端口的 /setup 必须注入本机规范地址')
      assert.ok(body.includes(`servedLocalOrigin = 'http://127.0.0.1:${ready.port}'`),'注入值必须是管理端口，不能是共享端口')
    }
    assert.equal((await fetch(origin+route,{method:'POST'})).status,403)
  }
  const client=await fetch(origin+`/lan-kit/setup-client.mjs?host=192.0.2.1&port=${port}`)
  assert.equal(client.status,200)
  const script=await client.text();assert.ok(script.includes("const EMBEDDED_HOST = '192.0.2.1'"));assert.ok(script.includes(`const EMBEDDED_PORT = '${port}'`))
  assert.equal((await fetch(origin+'/lan-kit/setup-client.mjs?port=1%27;throw')).status,400)
  assert.equal((await fetch(origin+'/lan-kit/setup-client.mjs?port=65536')).status,400)
  assert.equal((await fetch(origin+'/lan-kit/skills/codex-gateway-image/SKILL.md')).status,200)
  const manifest=await(await fetch(origin+'/client-assets.json')).json()
  assert.match(manifest.skill.sha256,/^[a-f0-9]{64}$/);assert.equal((await fetch(origin+'/client-setup.js')).status,200)
  const other=await(await fetch(ready.origin+'/__gw/apikeys',{method:'POST',headers,body:'{"name":"Other gallery user"}'})).json()
  const imageDir=path.join(r.root,'gen-images'),image='shared_fixture.jpeg',imageBytes=Buffer.from([255,216,255,217])
  fs.mkdirSync(imageDir,{recursive:true});fs.writeFileSync(path.join(imageDir,image),imageBytes)
  fs.writeFileSync(path.join(imageDir,'index.json'),JSON.stringify({[image]:{keyId:key.key.id,createdAt:Date.now()}}))
  const ownHeaders={Authorization:`Bearer ${key.key.token}`},otherHeaders={Authorization:`Bearer ${other.key.token}`}
  assert.equal((await fetch(origin+'/v1/gen-images/list')).status,401)
  const ownList=await(await fetch(origin+'/v1/gen-images/list',{headers:ownHeaders})).json()
  assert.equal(ownList.images.length,1);assert.ok(ownList.images[0].download_url.startsWith(origin+'/'))
  const file=await fetch(ownList.images[0].download_url,{headers:ownHeaders})
  assert.equal(file.status,200);assert.equal(file.headers.get('content-type'),'image/jpeg');assert.deepEqual(Buffer.from(await file.arrayBuffer()),imageBytes)
  assert.equal((await(await fetch(origin+'/v1/gen-images/list',{headers:otherHeaders})).json()).images.length,0)
  assert.equal((await fetch(origin+'/v1/gen-images/'+image,{headers:otherHeaders})).status,404)
  assert.equal((await fetch(origin+'/v1/gen-images/'+image,{headers:otherHeaders,method:'DELETE'})).status,403)
  assert.equal((await fetch(origin+'/v1/gen-images/'+image,{headers:ownHeaders,method:'DELETE'})).status,200)
  assert.equal(fs.existsSync(path.join(imageDir,image)),false)
  const conflict = await control({ enabled: true, port: busyPort })
  assert.equal(conflict.status, 409); assert.equal((await conflict.json()).error, 'lan_port_in_use')
  assert.equal((await fetch(origin + '/v1/models')).status, 401, 'old listener survives failed replacement')
  const stored = JSON.parse(fs.readFileSync(path.join(r.root, '.gw-config.json')))
  assert.equal(stored.desktopLanEnabled, true); assert.equal(stored.desktopLanPort, port)
  await r.command('shutdown', { reason: 'user_exit' }); await r.exited
  await assert.rejects(fetch(origin + '/v1/models'))
  const restarted = await fixture(t, ready.port, r.root), again = await restarted.start()
  assert.equal(again.bindHost, '127.0.0.1')
  assert.equal((await fetch(origin + '/v1/models')).status, 401, 'saved listener is restored on process restart')
  const relogin = await fetch((await restarted.command('bootstrap')).payload.url, { redirect: 'manual' })
  const newHeaders = { Cookie: relogin.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json' }
  assert.equal((await fetch(again.origin + '/__gw/lan', { method: 'POST', headers: newHeaders, body: JSON.stringify({ enabled: false, port }) })).status, 200)
  await assert.rejects(fetch(origin + '/v1/models'))
  assert.equal((await fetch(again.origin + '/__gw/status', { headers: newHeaders })).status, 200)
  assert.equal(JSON.parse(fs.readFileSync(path.join(r.root, '.gw-config.json'))).desktopLanEnabled, false)
  await restarted.command('shutdown', { reason: 'user_exit' }); await restarted.exited
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

test('real desktop: unfinished migration reports actionable failure before creating an empty database', async t => {
  const r = await fixture(t)
  const guard = migrationGuardPath(r.root)
  fs.mkdirSync(guard)
  fs.writeFileSync(path.join(guard, 'sentinel'), 'preserve recovery evidence')
  await r.initialize(); await r.command('start')
  assert.equal((await r.wait(x => x.type === 'fatal')).payload.code, 'DATA_MIGRATION_PENDING')
  assert.notEqual((await r.exited)[0], 0)
  assert.equal(r.frames.some(x => x.type === 'ready'), false)
  assert.equal(fs.existsSync(r.root), false)
  assert.equal(fs.readFileSync(path.join(guard, 'sentinel'), 'utf8'), 'preserve recovery evidence')
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
  const request = http.request(ready.origin + '/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${key.key.token}`, 'Content-Type': 'application/json', 'X-CGW-Device-Name':encodeURIComponent('日志测试设备'), 'X-Forwarded-For':'198.51.100.9' } })
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
  assert.equal(log.caller.ip,'127.0.0.1');assert.equal(log.caller.device,'日志测试设备');assert.equal(log.caller.keyName,'stream fixture');assert.equal(log.caller.keyId,key.key.id)
  assert.ok(!JSON.stringify(log).includes(key.key.token))
})
