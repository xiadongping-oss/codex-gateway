import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { Client } from '../node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js'
import { StdioClientTransport } from '../node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js'
import { StreamableHTTPClientTransport } from '../node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js'
import { createAuditHarness } from './audit-harness.mjs'
import { startMcpProgress } from '../mcp-progress.mjs'

test('progress accepts zero tokens, omits invented totals and stops after cleanup', async () => {
  const messages = []
  const stop = startMcpProgress({ _meta: { progressToken: 0 } }, m => messages.push(m), { intervalMs: 10 })
  await new Promise(r => setTimeout(r, 35)); stop()
  const count = messages.length
  assert.ok(count > 0)
  await new Promise(r => setTimeout(r, 30))
  assert.equal(messages.length, count)
  assert.equal(messages[0].params.progressToken, 0)
  assert.equal(messages[0].params.total, undefined)
})

test('slow image calls survive 30 seconds with HTTP and both stdio SDK clients', { timeout: 55000 }, async t => {
  const harness = await createAuditHarness()
  const clients = []
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC6kAAAAASUVORK5CYII='
  const timers = new Set()
  const bridge = http.createServer(async (req, res) => {
    for await (const _ of req) { /* consume request */ }
    if (req.method !== 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [] }))
      return
    }
    const timer = setTimeout(() => {
      timers.delete(timer)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [{ b64_json: png }] }))
    }, 32000)
    timers.add(timer)
    res.once('close', () => { clearTimeout(timer); timers.delete(timer) })
  })
  t.after(async () => {
    await Promise.all(clients.map(c => c.close()))
    for (const timer of timers) clearTimeout(timer)
    bridge.closeAllConnections()
    await new Promise(r => bridge.close(r))
    await harness.close()
  })
  bridge.listen(0, '127.0.0.1'); await once(bridge, 'listening')
  harness.env.BRIDGE_PORT = String(bridge.address().port)
  harness.reset(); await harness.start()
  const token = JSON.parse(fs.readFileSync(path.join(harness.sandbox, 'admin-token.json'))).token
  const created = await fetch(harness.base + '/__gw/apikeys', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'slow-fixture' }) })
  const key = (await created.json()).key.token
  const headers = { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }
  const root = fileURLToPath(new URL('../..', import.meta.url))
  await Promise.all(['http', 'managed', 'lan-kit'].map(async mode => {
    const transport = mode === 'http'
      ? new StreamableHTTPClientTransport(new URL(harness.base + '/mcp'), { requestInit: { headers } })
      : new StdioClientTransport({ command: process.execPath,
        args: [path.join(root, mode === 'managed' ? 'gateway/mcp-server.mjs' : 'docs/lan-kit/mcp-server.mjs')],
        env: { ...harness.env, CGW_BASE: harness.base, CGW_API_KEY: key }, stderr: 'pipe' })
    transport.stderr?.resume()
    const client = new Client({ name: 'slow-image-regression', version: '1' })
    clients.push(client)
    await client.connect(transport)
    const progress = []
    const result = await client.callTool({ name: 'generate_image', arguments: { prompt: 'offline slow fixture' } }, undefined,
      { timeout: 15000, maxTotalTimeout: 45000, resetTimeoutOnProgress: true, onprogress: p => progress.push(p) })
    assert.notEqual(result.isError, true, JSON.stringify(result))
    assert.ok(progress.length >= 3, mode + ' must keep the SDK timeout alive')
    assert.ok(progress.every(p => p.total === undefined))
  }))
})
