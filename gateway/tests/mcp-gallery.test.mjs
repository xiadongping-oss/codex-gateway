import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { once } from 'node:events'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { desktopFixture } from './lib/desktop-fixture.mjs'

const resources = process.env.CGW_MCP_TEST_RESOURCES || fileURLToPath(new URL('../..', import.meta.url))
const node = process.env.CGW_MCP_TEST_RESOURCES ? path.join(resources, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node') : process.execPath
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC6kAAAAASUVORK5CYII=', 'base64')
const A = 'fixture_A0000001.png', B = 'fixture_B0000002.png', LEGACY = 'fixture_unowned1.png'

test('managed desktop MCP gallery: per-key list/download/delete, shared data root and graceful reopen', { timeout: 60000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-mcp-gallery-'))
  let foreignConnections = 0, f
  const foreign = net.createServer(socket => { foreignConnections++; socket.destroy() })
  foreign.listen(0, '127.0.0.1'); await once(foreign, 'listening')
  const overrides = { BRIDGE_PORT: String(foreign.address().port) }
  const open = async () => {
    f = await desktopFixture({ resources, node, root, overrides })
    await f.start(); await f.login()
  }
  const request = (route, key, method = 'GET', body) => fetch(f.ready.origin + route, {
    method, headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000)
  })
  const rpc = async (key, method, params) => {
    const res = await request('/mcp', key, 'POST', { jsonrpc: '2.0', id: 1, method, params })
    assert.equal(res.status, 200)
    return JSON.parse((await res.text()).split('\n').find(line => line.startsWith('data:')).slice(5))
  }
  const call = (key, name, args = {}) => rpc(key, 'tools/call', { name, arguments: args })
  const text = r => r.result.content[0].text
  async function shutdown() {
    assert.equal((await f.command('shutdown', { reason: 'user_exit' })).ok, true)
    const stopped = (await f.wait(frame => frame.type === 'stopped')).payload
    assert.equal(stopped.outcome, 'graceful'); assert.equal(stopped.persisted, true); assert.equal(stopped.childrenExited, true)
    assert.equal((await f.exitWithin())[0], 0)
    assert.equal(fs.existsSync(path.join(f.dataRoot, 'runtime/owner.lock')), false)
  }
  try {
    await open()
    assert.equal((await f.request('/__gw/strict-auth', { enabled: true })).status, 200)
    const keys = []
    for (const name of ['fixture A', 'fixture B']) {
      const res = await f.request('/__gw/apikeys', { name }); assert.equal(res.status, 200)
      keys.push((await res.json()).key)
    }
    const [a, b] = keys, dir = path.join(f.dataRoot, 'gen-images')
    fs.mkdirSync(dir, { recursive: true })
    for (const name of [A, B, LEGACY]) fs.writeFileSync(path.join(dir, name), PNG)
    fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ [A]: { keyId: a.id, keyName: 'fixture A', createdAt: Date.now() }, [B]: { keyId: b.id, keyName: 'fixture B', createdAt: Date.now() } }))

    const initialized = await rpc(a.token, 'initialize', { protocolVersion: '2025-03-26' })
    assert.equal(initialized.result.protocolVersion, '2025-03-26')
    const tools = (await rpc(a.token, 'tools/list')).result.tools.map(t => t.name)
    assert.deepEqual(tools.sort(), ['delete_generated_image', 'generate_image', 'list_generated_images'])
    assert.deepEqual((await rpc(a.token, 'ping')).result, {})
    const notify = await request('/mcp', a.token, 'POST', { jsonrpc: '2.0', method: 'notifications/initialized' })
    assert.equal(notify.status, 202); assert.equal(await notify.text(), '')
    assert.equal((await call(a.token, 'unknown')).error.code, -32602)
    assert.equal((await request('/mcp', null, 'POST', { id: 1, method: 'tools/list' })).status, 401)

    const listA = text(await call(a.token, 'list_generated_images'))
    const listB = text(await call(b.token, 'list_generated_images'))
    assert.ok(listA.includes(A) && !listA.includes(B) && !listA.includes(LEGACY))
    assert.ok(listB.includes(B) && !listB.includes(A) && !listB.includes(LEGACY))
    const apiList = await (await request('/v1/gen-images/list', a.token)).json()
    assert.equal(apiList.total, 1); assert.equal(apiList.images[0].local_path, path.join(dir, A))
    // A returned download link must work with the caller's Key, not require an admin session.
    const url = apiList.images[0].download_url || apiList.images[0].url
    const download = await fetch(url, { headers: { Authorization: `Bearer ${a.token}` }, signal: AbortSignal.timeout(5000) })
    assert.equal(download.status, 200, 'MCP/gallery caller cannot download its own returned image URL')
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), PNG)
    assert.match(listA, /\/v1\/gen-images\//)
    for (const [name, key, status] of [[A, null, 401], [A, b.token, 404], [LEGACY, a.token, 404], ['missing.png', a.token, 404]]) {
      const res = await request('/v1/gen-images/' + name, key)
      assert.equal(res.status, status); assert.equal((await res.arrayBuffer()).byteLength === PNG.length, false)
    }
    for (const bad of ['..%2fadmin-token.json', '%zz', '..%5capi-keys.json']) {
      const res = await request('/v1/gen-images/' + bad, a.token); assert.equal(res.status, 400); await res.arrayBuffer()
    }
    const all = await (await f.request('/__gw/gen-images')).json()
    assert.equal(all.images.length, 3)
    const stdio = JSON.parse(execFileSync(node, [path.join(resources, 'gateway/mcp-server.mjs')], {
      env: { ...f.env, CGW_STORAGE_MODE: 'managed', CGW_BASE: f.ready.origin }, windowsHide: true, timeout: 5000,
      input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_generated_images' } }) + '\n', encoding: 'utf8'
    }))
    for (const name of [A, B, LEGACY]) assert.ok(text(stdio).includes(name), 'host-side stdio reads managed data root')
    assert.equal((await call(a.token, 'delete_generated_image', { name: B })).result.isError, true)
    assert.equal((await call(a.token, 'delete_generated_image', { name: '../index.json' })).result.isError, true)
    assert.deepEqual(fs.readFileSync(path.join(dir, B)), PNG)
    assert.notEqual((await call(a.token, 'delete_generated_image', { name: A })).result.isError, true)
    assert.equal(fs.existsSync(path.join(dir, A)), false)
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'index.json')))[A], undefined)
    assert.equal((await call(a.token, 'delete_generated_image', { name: A })).result.isError, true)
    await shutdown(); await open()
    assert.match(text(await call(a.token, 'list_generated_images')), /图库为空/)
    assert.ok(text(await call(b.token, 'list_generated_images')).includes(B))
    assert.deepEqual(fs.readFileSync(path.join(dir, B)), PNG)
    assert.deepEqual(fs.readFileSync(path.join(dir, LEGACY)), PNG)
    await shutdown()
    assert.equal(foreignConnections, 0, 'local gallery operations must not contact or start a bridge')
  } finally {
    if (f) await f.stop()
    await new Promise(resolve => foreign.close(resolve))
    // Own fresh mkdtemp root only, checked before recursive cleanup.
    const resolved = fs.realpathSync(root)
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()))
    assert.ok(path.basename(resolved).startsWith('cgw-mcp-gallery-'))
    fs.rmSync(resolved, { recursive: true, force: true })
  }
})
