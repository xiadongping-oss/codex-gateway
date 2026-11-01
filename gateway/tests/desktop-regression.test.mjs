import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { once } from 'node:events'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { prepareDesktop, verifyDesktop } from '../../prepare-desktop.mjs'
import { fixturePermissions } from './lib/readonly-fixture.mjs'
import { desktopFixture, sleep } from './lib/desktop-fixture.mjs'

const REPO = fileURLToPath(new URL('../..', import.meta.url))
const target = `${process.platform}-${process.arch}`
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-f06-'))
const resources = path.join(temp, "程序 资源 & # % ! ' [只读]")
let node, initialTimes
function times() {
  const result = {}
  function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name), stat = fs.statSync(file)
      if (stat.isDirectory()) walk(file)
      else result[path.relative(resources, file)] = stat.mtimeMs
    }
  }
  walk(resources); return result
}
function digestTree(dir) {
  const result = {}
  if (!fs.existsSync(dir)) return result
  function walk(current) {
    for (const name of fs.readdirSync(current).sort()) {
      const file = path.join(current, name)
      if (fs.statSync(file).isDirectory()) walk(file)
      else result[path.relative(dir, file)] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
    }
  }
  walk(dir); return result
}
before(async () => {
  const info = await prepareDesktop({ root: REPO, target, outDir: resources, cacheDir: path.join(REPO, 'release/runtime-cache'), offline: true })
  node = path.join(resources, info.node)
  fixturePermissions(temp, resources, true)
  // Prove the launched identity cannot modify files OR create entries. chmod on Windows
  // alone would not establish this; root on Unix must also fail this probe, never fake a pass.
  const result = JSON.parse(execFileSync(node, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    const outcomes=[];
    for (const [file,flags] of [[process.argv[1],'r+'],[process.argv[2],'wx']]) {
      try { const fd=fs.openSync(file,flags); fs.closeSync(fd); outcomes.push('WRITABLE') }
      catch(e) { outcomes.push(e.code) }
    }
    console.log(JSON.stringify(outcomes));
  `, path.join(resources, 'package.json'), path.join(resources, '__write_probe__')], { encoding: 'utf8', windowsHide: true }))
  assert.ok(result.every(code => ['EACCES', 'EPERM'].includes(code)), `Resource permissions are not enforced: ${result}`)
  initialTimes = times()
})
after(() => {
  try {
    if (initialTimes) {
      verifyDesktop({ target, outDir: resources })
      assert.deepEqual(times(), initialTimes, 'no identical-content rewrites in the program tree')
    }
  } finally {
    if (fs.existsSync(resources)) fixturePermissions(temp, resources, false)
    fs.rmSync(temp, { recursive: true, force: true }) // owned mkdtemp root only
  }
})
async function open(t, options = {}) {
  const root = fs.mkdtempSync(path.join(temp, 'case-'))
  const session = await desktopFixture({ resources, node, root, ...options })
  t.after(() => session.stop())
  return session
}
async function graceful(s) {
  assert.equal((await s.command('shutdown', { reason: 'user_exit' })).ok, true)
  const stopped = (await s.wait(f => f.type === 'stopped')).payload
  assert.equal(stopped.outcome, 'graceful'); assert.equal(stopped.persisted, true); assert.equal(stopped.childrenExited, true)
  assert.equal((await s.exitWithin())[0], 0)
  assert.equal(fs.existsSync(path.join(s.dataRoot, 'runtime/owner.lock')), false)
  assert.throws(() => process.kill(s.child.pid, 0), 'owned Node must actually be gone')
}
async function startupFailure(s, expected) {
  await s.initialize(); await s.command('start')
  const fatal = await s.wait(f => f.type === 'fatal')
  assert.equal(fatal.payload.code, expected)
  assert.notEqual((await s.exitWithin())[0], 0)
  assert.equal(s.frames.some(f => f.type === 'ready'), false)
  return fatal
}

test('real read-only resources at special-character paths: console, persistence, gallery and local MCP', async t => {
  const s = await open(t); await s.start(); await s.login()
  const page = await s.request('/'); assert.equal(page.status, 200); assert.match(await page.text(), /<html/i)
  const created = await s.request('/__gw/apikeys', { name: 'F06 disposable key' })
  assert.equal(created.status, 200); const key = (await created.json()).key
  assert.ok(key.token.startsWith('cgw-'))
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR0sAAAAASUVORK5CYII=', 'base64')
  fs.writeFileSync(path.join(s.dataRoot, 'gen-images/fixture.png'), png)
  const gallery = await s.request('/__gw/gen-images/fixture.png')
  assert.equal(gallery.status, 200); assert.deepEqual(Buffer.from(await gallery.arrayBuffer()), png)
  const output = execFileSync(node, [path.join(resources, 'gateway/mcp-server.mjs')], {
    env: { ...s.env, CGW_STORAGE_MODE: 'managed', CGW_BASE: s.ready.origin },
    cwd: s.home, windowsHide: true, encoding: 'utf8', timeout: 5000,
    input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_generated_images' } }) + '\n', stdio: ['pipe', 'pipe', 'pipe']
  })
  assert.match(JSON.parse(output).result.content[0].text, /fixture\.png/)
  await graceful(s)
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.dataRoot, 'api-keys.json'))).keys[0].name, 'F06 disposable key')
  assert.deepEqual(digestTree(s.home), {}, 'no credential/gallery fallback into HOME')
  assert.equal(s.frames.some(f => f.invalid), false)
  assert.deepEqual(s.frames.map(f => f.seq), s.frames.map((_, i) => i + 1))
})

for (const [label, dataRoot] of [['relative', 'relative/data'], ['program', path.join(resources, 'data')], ['app', path.join(temp, 'Fixture.app/data')]]) {
  test(`startup rejects ${label} data root without creating data`, async t => {
    const s = await open(t, { dataRoot }); await startupFailure(s, 'DATA_DIR_INVALID')
    assert.equal(fs.existsSync(dataRoot), false)
  })
}
test('startup rejects a junction/symlink into the program directory', async t => {
  const alias = path.join(temp, 'program-alias')
  fs.symlinkSync(resources, alias, process.platform === 'win32' ? 'junction' : 'dir')
  try {
    const s = await open(t, { dataRoot: path.join(alias, 'data') })
    await startupFailure(s, 'DATA_DIR_INVALID')
  } finally { fs.unlinkSync(alias) }
})
test('unwritable data parent reports a useful failure and leaves no partial identity', async t => {
  const parent = fs.mkdtempSync(path.join(temp, 'unwritable-'))
  fixturePermissions(temp, parent, true)
  try {
    const s = await open(t, { dataRoot: path.join(parent, 'data') })
    await startupFailure(s, 'DATA_DIR_UNWRITABLE')
    assert.deepEqual(fs.readdirSync(parent), [])
  } finally { fixturePermissions(temp, parent, false) }
})
for (const layout of ['legacy', 'higher-version', 'corrupt-version']) test(`startup preserves ${layout} data`, async t => {
  const dataRoot = fs.mkdtempSync(path.join(temp, 'existing-'))
  fs.writeFileSync(path.join(dataRoot, 'auth.json'), 'FIXTURE-CREDENTIAL-KEEP')
  if (layout !== 'legacy') fs.writeFileSync(path.join(dataRoot, 'storage-layout.json'), layout === 'higher-version' ? '{"schemaVersion":99}' : '{')
  const before = digestTree(dataRoot)
  const s = await open(t, { dataRoot })
  await startupFailure(s, layout === 'legacy' ? 'DATA_MIGRATION_REQUIRED' : 'DATA_VERSION_UNSUPPORTED')
  assert.deepEqual(digestTree(dataRoot), before)
})
test('two simultaneous owners cannot start the same data root', async t => {
  const dataRoot = path.join(temp, 'concurrent-data')
  const a = await open(t, { dataRoot }), b = await open(t, { dataRoot })
  await Promise.all([a.initialize(), b.initialize()]); await Promise.all([a.command('start'), b.command('start')])
  const results = await Promise.all([a.wait(f => ['ready', 'fatal'].includes(f.type)), b.wait(f => ['ready', 'fatal'].includes(f.type))])
  assert.equal(results.filter(f => f.type === 'ready').length, 1)
  const winner = results[0].type === 'ready' ? a : b, loser = winner === a ? b : a
  assert.equal(results.find(f => f.type === 'fatal').payload.code, 'DATA_IN_USE')
  assert.equal((await loser.exitWithin())[0], 1)
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataRoot, 'runtime/owner.lock'))).pid, winner.child.pid)
  assert.equal((await winner.command('status')).payload.state, 'ready')
  await graceful(winner)
})
test('crash keeps ownership record; a new process does not silently take over', async t => {
  const first = await open(t); await first.start()
  const before = digestTree(first.dataRoot)
  first.child.kill('SIGKILL'); await first.exitWithin()
  assert.equal(first.frames.some(f => f.type === 'stopped'), false)
  const second = await open(t, { dataRoot: first.dataRoot })
  await startupFailure(second, 'DATA_IN_USE')
  assert.deepEqual(digestTree(first.dataRoot), before)
})
test('clean restart retains data but rejects previous-instance bootstrap', async t => {
  const first = await open(t); await first.start()
  const old = (await first.command('bootstrap')).payload.url
  const port = first.ready.port
  await graceful(first)
  const second = await open(t, { dataRoot: first.dataRoot, port }); await second.start()
  const response = await fetch(old, { redirect: 'manual', signal: AbortSignal.timeout(3000) })
  assert.equal(response.status, 403); await response.arrayBuffer()
  await second.login(); await graceful(second)
})
test('foreign HTTP service on the configured port is never trusted or contacted', async t => {
  let hits = 0
  const other = http.createServer((req, res) => { hits++; res.end('{"ok":true}') })
  other.listen(0, '127.0.0.1'); await once(other, 'listening')
  t.after(() => new Promise(resolve => other.close(resolve)))
  const s = await open(t, { port: other.address().port }); await startupFailure(s, 'PORT_IN_USE')
  assert.equal(s.child.exitCode, 2); assert.equal(hits, 0)
  assert.equal(fs.existsSync(path.join(s.dataRoot, 'runtime/owner.lock')), false)
})
test('damaged bridge is rejected before data initialization and never repaired', async t => {
  const corrupt = fs.mkdtempSync(path.join(temp, 'corrupt-program-'))
  for (const file of ['package.json', 'gateway/desktop-entry.mjs', 'gateway/desktop-protocol.mjs', 'gateway/desktop-ticket.mjs', 'gateway/shutdown-manager.mjs', 'gateway/bridge-patches.mjs', 'gateway/patches/manifest.json', 'gateway/node_modules/chatgpt-bridge/package.json', 'gateway/node_modules/chatgpt-bridge/dist/cli.js', 'gateway/node_modules/chatgpt-bridge/dist/index.js']) {
    fs.mkdirSync(path.dirname(path.join(corrupt, file)), { recursive: true })
    fs.copyFileSync(path.join(resources, file), path.join(corrupt, file))
  }
  const file = path.join(corrupt, 'gateway/node_modules/chatgpt-bridge/dist/index.js')
  fs.chmodSync(file, 0o644); fs.appendFileSync(file, '\n// corrupted fixture\n')
  const before = digestTree(corrupt)
  const s = await open(t, { resources: corrupt }); await startupFailure(s, 'BRIDGE_PATCH_INVALID')
  assert.equal(fs.existsSync(s.dataRoot), false); assert.deepEqual(digestTree(corrupt), before)
})
for (const initialized of [false, true]) test(`handshake deadline before ${initialized ? 'start' : 'initialize'} exits without data`, async t => {
  const s = await open(t)
  if (initialized) await s.initialize()
  const start = performance.now()
  assert.equal((await s.exitWithin(8000))[0], 5)
  assert.ok(performance.now() - start >= 4500)
  assert.equal(fs.existsSync(s.dataRoot), false)
})
test('EOF during startup cannot leave a late-ready gateway or ownership lock', async t => {
  for (let i = 0; i < 3; i++) {
    const s = await open(t); await s.initialize(); s.send('start'); s.child.stdin.end()
    assert.equal((await s.exitWithin())[0], 5)
    const fatalAt = s.frames.findIndex(f => f.type === 'fatal')
    assert.ok(fatalAt >= 0)
    assert.equal(s.frames.slice(fatalAt).some(f => f.type === 'ready'), false, 'no ready after observing EOF')
    assert.equal(fs.existsSync(path.join(s.dataRoot, 'runtime/owner.lock')), false)
  }
})
for (const fault of ['identity', 'duplicate-key', 'oversized', 'utf8']) test(`live protocol ${fault} fails cleanly without echoing input`, async t => {
  const s = await open(t); await s.start()
  const secret = 'F06-PRIVATE-INPUT-NOT-FOR-LOGS'
  if (fault === 'identity') s.send('status', { secret }, { launchId: crypto.randomUUID() })
  else if (fault === 'duplicate-key') s.child.stdin.write(`{"secret":"${secret}","secret":"duplicate"}\n`)
  else if (fault === 'oversized') s.child.stdin.write(secret + 'x'.repeat(65536))
  else s.child.stdin.write(Buffer.from([0xc0, 0x80, 10]))
  const result = (await s.wait(f => f.type === 'fatal')).payload
  assert.equal(result.code, fault === 'identity' ? 'IDENTITY_MISMATCH' : 'FRAME_INVALID')
  assert.equal((await s.exitWithin())[0], 5)
  assert.equal(fs.existsSync(path.join(s.dataRoot, 'runtime/owner.lock')), false)
  assert.equal(JSON.stringify(s.frames).includes(secret) || s.stderr.includes(secret), false)
})
test('lost stdout and a non-reading controller both cause bounded failed shutdown', async t => {
  for (const mode of ['closed', 'backpressure']) {
    const s = await open(t); await s.start()
    if (mode === 'closed') { s.child.stdout.destroy(); s.send('status') }
    else {
      s.child.stdout.pause()
      // Exceed the protocol's 1 MiB queue limit while the reader stays paused.
      const requests = Array.from({ length: 6500 }, () => s.encode('status')).join('')
      s.child.stdin.write(requests)
    }
    assert.equal((await s.exitWithin(9000))[0], process.platform === 'win32' ? 1 : 5)
    s.child.stdout.resume()
    assert.equal(fs.existsSync(path.join(s.dataRoot, 'runtime/owner.lock')), false)
  }
})

test('real 30-second drain: repeat preserves deadline, continue or force is explicit', async t => {
  await Promise.all(['continue', 'force'].map(async choice => {
    const s = await open(t); await s.start(); await s.login()
    const body = JSON.stringify({ name: 'completed-after-wait' })
    const req = http.request(s.ready.origin + '/__gw/apikeys', { method: 'POST', headers: { Cookie: s.cookie, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } })
    req.on('error', () => {})
    const replied = new Promise(resolve => req.on('response', res => { res.resume(); res.once('end', () => resolve(res.statusCode)) }))
    t.after(() => req.destroy())
    req.write(body.slice(0, 5))
    for (let i = 0; i < 100; i++) {
      if ((await s.command('status')).payload.activeRequests) break
      await sleep(10)
    }
    const start = performance.now()
    await s.command('shutdown', { reason: 'user_exit' })
    assert.equal((await s.command('shutdown.force')).error.code, 'INVALID_STATE')
    await sleep(1000)
    await s.command('shutdown', { reason: 'user_exit' })
    const waiting = (await s.wait(f => f.type === 'shutdown.waiting', 34_000)).payload
    assert.equal(waiting.reason, 'DRAIN_TIMEOUT')
    const elapsed = performance.now() - start
    assert.ok(elapsed >= 29_500 && elapsed < 31_000, `deadline changed: ${elapsed}`)
    assert.equal(s.child.exitCode, null)
    assert.equal((await s.command('status')).payload.waiting, true)
    const rejected = await s.request('/__gw/apikeys', { name: 'MUST-NOT-BE-CREATED' })
    assert.equal(rejected.status, 503); assert.equal((await rejected.json()).error, 'gateway_shutting_down')
    if (choice === 'continue') {
      assert.equal((await s.command('shutdown.continue', { waitMs: 30000 })).ok, true)
      req.end(body.slice(5)); assert.equal(await replied, 200)
    } else assert.equal((await s.command('shutdown.force')).ok, true)
    const stopped = (await s.wait(f => f.type === 'stopped')).payload
    assert.equal(stopped.outcome, choice === 'continue' ? 'graceful' : 'forced', JSON.stringify(stopped))
    assert.equal((await s.exitWithin())[0], choice === 'continue' ? 0 : 4)
    const file = path.join(s.dataRoot, 'api-keys.json')
    const keys = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)).keys : []
    assert.deepEqual(keys.map(k => k.name), choice === 'continue' ? ['completed-after-wait'] : [], 'an aborted body must not create a key')
    assert.equal(fs.existsSync(path.join(s.dataRoot, 'runtime/owner.lock')), false)
  }))
})
