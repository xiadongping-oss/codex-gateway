import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import readline from 'node:readline'
import { crc32, deflateSync } from 'node:zlib'
import { imageSizeInfo } from '../image-size.mjs'
import { generateImage, ImageRequest, Upstream } from '../node_modules/chatgpt-bridge/dist/index.js'
import { createAuditHarness } from './audit-harness.mjs'

function png(width, height) {
  const chunk = (type, data) => {
    const name = Buffer.from(type), out = Buffer.alloc(data.length + 12)
    out.writeUInt32BE(data.length); name.copy(out, 4); data.copy(out, 8)
    out.writeUInt32BE(crc32(Buffer.concat([name, data])), out.length - 4)
    return out
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc((width * 4 + 1) * height))), chunk('IEND', Buffer.alloc(0))])
}
const original = png(1254, 1254), matching = png(1024, 1024)

test('PNG size reporting distinguishes mismatch, match, and automatic sizing without altering bytes', () => {
  const b64 = original.toString('base64')
  const mismatch = imageSizeInfo(b64, '1024x1024')
  assert.equal(mismatch.actual, '1254x1254'); assert.equal(mismatch.matchesRequested, false)
  assert.match(mismatch.message, /与请求 1024x1024 不一致/)
  assert.equal(imageSizeInfo(matching.toString('base64'), '1024x1024').matchesRequested, true)
  assert.equal(imageSizeInfo(b64).matchesRequested, null)
  assert.equal(imageSizeInfo(b64).requested, 'auto')
  assert.deepEqual(Buffer.from(b64, 'base64'), original)
})

test('unknown, truncated, zero-size, and damaged IHDR are never reported as matching', () => {
  const damaged = Buffer.from(original); damaged[20] ^= 1
  const zero = Buffer.from(original); zero.writeUInt32BE(0, 16); zero.writeUInt32BE(crc32(zero.subarray(12, 29)), 29)
  for (const value of [undefined, '', 'not a PNG', original.subarray(0, 32).toString('base64'), damaged.toString('base64'), zero.toString('base64')]) {
    const result = imageSizeInfo(value, '1024x1024')
    assert.equal(result.actual, null); assert.equal(result.matchesRequested, null)
    assert.match(result.message, /未识别/)
  }
})

async function listen(server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  return server.address().port
}
async function close(server) {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
}
async function stdioCall(file, env, args) {
  const child = spawn(process.execPath, [file], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const ended = once(child, 'exit'); let errors = ''
  child.stderr.on('data', b => { errors += b })
  const lines = readline.createInterface({ input: child.stdout })
  const result = new Promise((resolve, reject) => {
    lines.on('line', line => { try { resolve(JSON.parse(line)) } catch (e) { reject(e) } })
    child.once('error', reject)
    child.once('exit', () => reject(new Error('MCP exited before response: ' + errors)))
  })
  const timer = setTimeout(() => child.kill(), 15000)
  try {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'generate_image', arguments: args } }) + '\n')
    return await result
  } finally {
    child.stdin.end(); await ended; clearTimeout(timer); lines.close()
  }
}

test('real gateway HTTP and both stdio MCP clients report returned size; bridge forwards parameters and original bytes', { timeout: 45000 }, async () => {
  // Real gateway and bridge generation engine; loopback-only upstream fixture.
  // No account credentials, provider API, UI, or image-generation service involved.
  const harness = await createAuditHarness()
  const wire = [], bridgeRequests = []
  const upstreamServer = http.createServer(async (req, res) => {
    const parts = []; for await (const p of req) parts.push(p)
    const body = JSON.parse(Buffer.concat(parts)); wire.push(body.tools[0])
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.end('event: response.output_item.done\ndata: ' + JSON.stringify({ type: 'response.output_item.done', item: { type: 'image_generation_call', result: original.toString('base64') } }) + '\n\nevent: response.completed\ndata: {"type":"response.completed","response":{}}\n\n')
  })
  let bridge
  try {
    const port = await listen(upstreamServer)
    const cfg = { imageModel: 'offline-fixture', timeoutMs: 5000, upstreamBase: `http://127.0.0.1:${port}` }
    const upstream = new Upstream(cfg, { headers: async () => ({}) })
    bridge = http.createServer(async (req, res) => {
      try {
        const parts = []; for await (const p of req) parts.push(p)
        const body = JSON.parse(Buffer.concat(parts)); bridgeRequests.push(body)
        const result = await generateImage(cfg, upstream, ImageRequest.parse(body))
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ data: [{ b64_json: result.b64 }] }))
      } catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: e.message } })) }
    })
    harness.env.BRIDGE_PORT = String(await listen(bridge))
    harness.reset(); await harness.start()
    const token = JSON.parse(fs.readFileSync(path.join(harness.sandbox, 'admin-token.json'))).token
    const created = await fetch(harness.base + '/__gw/apikeys', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'offline-size-test' }), signal: AbortSignal.timeout(5000) })
    const key = (await created.json()).key.token
    const request = async (route, body) => {
      const res = await fetch(harness.base + route, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) })
      assert.equal(res.status, 200); return res
    }
    const args = { prompt: 'offline fixture', size: '1024x1024', quality: 'low' }
    const response = await (await request('/v1/images/generations', args)).json()
    const item = response.data[0]
    assert.equal(item.cgw_image_size.actual, '1254x1254'); assert.equal(item.cgw_image_size.matchesRequested, false)
    assert.deepEqual(Buffer.from(item.b64_json, 'base64'), original)
    assert.deepEqual(fs.readFileSync(item.local_path), original)
    assert.match(item.download_url, /\/v1\/gen-images\//)
    const keyedDownload = await fetch(item.download_url, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(5000) })
    assert.equal(keyedDownload.status, 200); assert.deepEqual(Buffer.from(await keyedDownload.arrayBuffer()), original)
    const download = await fetch(item.url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) })
    assert.equal(download.status, 200); assert.deepEqual(Buffer.from(await download.arrayBuffer()), original)
    assert.equal(bridgeRequests[0].size, args.size); assert.equal(wire[0].size, args.size); assert.equal(wire[0].quality, 'low')

    const auto = await (await request('/v1/images/generations', { prompt: 'default fixture' })).json()
    assert.equal(auto.data[0].cgw_image_size.requested, 'auto'); assert.equal(auto.data[0].cgw_image_size.matchesRequested, null)
    assert.equal(wire.at(-1).size, 'auto'); assert.equal(wire.at(-1).quality, 'high')
    const httpText = await (await request('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'generate_image', arguments: args } })).text()
    const httpResult = JSON.parse(httpText.split('\n').find(line => line.startsWith('data:')).slice(5))
    assert.match(httpResult.result.content[0].text, /实际尺寸：1254x1254/)
    assert.match(httpResult.result.content[0].text, /与请求 1024x1024 不一致/)
    assert.match(httpResult.result.content[0].text, /下载：http:\/\/127\.0\.0\.1:\d+\/v1\/gen-images\//)
    for (const file of [path.join(harness.sandbox, 'mcp-server.mjs'), path.join(harness.sandbox, 'lan-kit/mcp-server.mjs')]) {
      const result = await stdioCall(file, { ...harness.env, CGW_BASE: harness.base, CGW_API_KEY: key }, args)
      assert.notEqual(result.result.isError, true)
      assert.match(result.result.content[0].text, /实际尺寸：1254x1254/)
      assert.match(result.result.content[0].text, /与请求 1024x1024 不一致/)
      assert.match(result.result.content[0].text, /下载：http:\/\/127\.0\.0\.1:\d+\/v1\/gen-images\//)
    }
    assert.equal(bridgeRequests.length, 5); assert.equal(wire.length, 5)
    assert.ok(wire.every(t => t.size === 'auto' || t.size === '1024x1024'))
  } finally {
    await harness.close()
    if (bridge) await close(bridge)
    await close(upstreamServer)
  }
})
