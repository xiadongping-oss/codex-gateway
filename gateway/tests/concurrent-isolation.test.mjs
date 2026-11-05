import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { once } from 'node:events'
import { PNG } from '../node_modules/pngjs/lib/png.js'
import { Client } from '../node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js'
import { StdioClientTransport } from '../node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js'
import { createAuditHarness } from './audit-harness.mjs'

test('concurrent A/B chat and image requests retain responses and per-key gallery ownership', { timeout: 30000 }, async t => {
  const harness = await createAuditHarness()
  const upstream = http.createServer(async (req, res) => {
    const parts = []; for await (const part of req) parts.push(part)
    res.setHeader('Content-Type', 'application/json')
    if (req.method !== 'POST') { res.end('{"data":[]}'); return }
    const body = JSON.parse(Buffer.concat(parts))
    const marker = body.prompt || body.messages[0].content
    // Finish out of submission order, using one shared upstream for both users.
    await new Promise(resolve => setTimeout(resolve, 200 - Number(marker.split('-').at(-1)) * 20))
    if (req.url === '/v1/chat/completions') {
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: marker }, finish_reason: 'stop' }] }))
    } else {
      const png = new PNG({ width: 1, height: 1 })
      png.data.set([marker.startsWith('A') ? 255 : 0, Number(marker.split('-').at(-1)), 0, 255])
      res.end(JSON.stringify({ data: [{ b64_json: PNG.sync.write(png).toString('base64'), revised_prompt: marker }] }))
    }
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  t.after(async () => {
    await harness.close()
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve))
  })
  harness.env.BRIDGE_PORT = String(upstream.address().port)
  harness.reset(); await harness.start()
  const admin = JSON.parse(fs.readFileSync(path.join(harness.sandbox, 'admin-token.json'))).token
  const request = (route, key, body, method) => fetch(harness.base + route, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000)
  })
  const keys = await Promise.all(['A', 'B'].map(async name => {
    const response = await request('/__gw/apikeys', admin, { name })
    assert.equal(response.status, 200)
    return (await response.json()).key
  }))
  const owned = [[], []]
  const work = keys.flatMap((key, user) => Array.from({ length: 8 }, (_, index) => (async () => {
    const marker = `${user ? 'B' : 'A'}-${index}`
    const chat = index < 4, mcp = index >= 6
    const body = chat ? { model: 'gpt-6.1-sol', messages: [{ role: 'user', content: marker }], stream: false }
      : mcp ? { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'generate_image', arguments: { prompt: marker } } }
        : { prompt: marker }
    const response = await request(chat ? '/v1/chat/completions' : mcp ? '/mcp' : '/v1/images/generations', key.token, body)
    assert.equal(response.status, 200)
    if (chat) {
      assert.equal((await response.json()).choices[0].message.content, marker)
      return
    }
    let name
    if (mcp) {
      const text = await response.text()
      const messages = text.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)))
      const result = messages.find(m => m.id === 1).result
      assert.notEqual(result.isError, true)
      assert.ok(result.content[0].text.includes(marker))
      assert.ok(!result.content[0].text.includes(user ? 'A-' : 'B-'))
      name = new URL(result.structuredContent.gallery_url).searchParams.get('image')
    } else {
      const result = (await response.json()).data[0]
      assert.equal(result.revised_prompt, marker)
      name = new URL(result.download_url).pathname.split('/').pop()
    }
    assert.ok(name)
    owned[user].push(name)
    const download = await request('/v1/gen-images/' + name, key.token)
    assert.equal(download.status, 200)
    const png = PNG.sync.read(Buffer.from(await download.arrayBuffer()))
    assert.deepEqual([...png.data], [user ? 0 : 255, index, 0, 255])
  })()))
  await Promise.all(work)
  assert.equal(new Set(owned.flat()).size, 8)
  for (const [user, key] of keys.entries()) {
    const list = await (await request('/v1/gen-images/list', key.token)).json()
    assert.deepEqual(list.images.map(image => image.name).sort(), owned[user].sort())
    assert.ok(list.images.every(image => image.ownerKeyId === key.id && image.generation.prompt.startsWith(user ? 'B-' : 'A-')))
    const other = owned[1 - user][0]
    const deniedDownload = await request('/v1/gen-images/' + other, key.token)
    assert.equal(deniedDownload.status, 404); await deniedDownload.arrayBuffer()
    const deniedDelete = await request('/v1/gen-images/' + other, key.token, null, 'DELETE')
    assert.equal(deniedDelete.status, 403); await deniedDelete.arrayBuffer()
    const library = await (await request('/v1/gen-images/library', key.token)).json()
    assert.deepEqual(library.images.map(image => image.name).sort(), owned[user].sort())
    // A second device using the same Key intentionally sees that Key's gallery.
    const sameKey = await (await request('/v1/gen-images/list', key.token)).json()
    assert.equal(sameKey.total, 4)
  }
  const all = await (await request('/__gw/gen-images', admin)).json()
  assert.equal(all.images.length, 8, 'host administrator intentionally sees both users')
  for (const file of ['mcp-server.mjs', 'lan-kit/mcp-server.mjs']) {
    // Run on the gateway host: its disk contains both users' files. The Key
    // must still restrict results, and an invalid Key must never fall back to disk.
    for (const [user, key] of keys.entries()) {
      const client = new Client({ name: 'isolation-regression', version: '1' })
      const transport = new StdioClientTransport({ command: process.execPath,
        args: [path.join(harness.sandbox, file)], env: { ...harness.env, CGW_BASE: harness.base, CGW_API_KEY: key.token }, stderr: 'pipe' })
      transport.stderr?.resume()
      try {
        await client.connect(transport)
        const result = await client.callTool({ name: 'list_generated_images', arguments: {} })
        assert.notEqual(result.isError, true)
        const text = result.content[0].text
        assert.ok(owned[user].every(name => text.includes(name)))
        assert.ok(owned[1 - user].every(name => !text.includes(name)))
      } finally { await client.close() }
    }
    const client = new Client({ name: 'invalid-key-regression', version: '1' })
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [path.join(harness.sandbox, file)], env: { ...harness.env, CGW_BASE: harness.base, CGW_API_KEY: 'cgw-invalid-fixture' }, stderr: 'pipe' })
    transport.stderr?.resume()
    try {
      await client.connect(transport)
      const result = await client.callTool({ name: 'list_generated_images', arguments: {} })
      assert.equal(result.isError, true)
      assert.ok(owned.flat().every(name => !result.content[0].text.includes(name)))
    } finally { await client.close() }
  }
})
