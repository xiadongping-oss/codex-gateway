import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '../node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js'
import { StdioClientTransport } from '../node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js'
import { StreamableHTTPClientTransport } from '../node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js'
import { desktopFixture } from './lib/desktop-fixture.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const resources = process.env.CGW_MCP_TEST_RESOURCES || ROOT
const node = process.env.CGW_MCP_TEST_RESOURCES ? path.join(resources, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node') : process.execPath
const timeout = { timeout: 4000 }

for (const transportName of ['stdio-managed', 'stdio-lan-kit', 'streamable-http']) {
  test(`official MCP SDK client connects, discovers and calls tools: ${transportName}`, { timeout: 25000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-mcp-client-'))
    let f, client
    try {
      f = await desktopFixture({ resources, node, root })
      await f.start(); await f.login()
      await (await f.request('/__gw/strict-auth', { enabled: true })).arrayBuffer()
      const key = (await (await f.request('/__gw/apikeys', { name: 'SDK fixture' })).json()).key
      const imageName = 'sdk_fixture_A0001.png'
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC6kAAAAASUVORK5CYII=', 'base64')
      for (const dir of [path.join(f.dataRoot, 'gen-images'), path.join(f.home, '.chatgpt-bridge/gen-images')]) {
        fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, imageName), png)
        fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ [imageName]: { keyId: key.id, createdAt: Date.now() } }))
      }
      const transport = transportName === 'streamable-http'
        ? new StreamableHTTPClientTransport(new URL(f.ready.origin + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${key.token}` } } })
        : new StdioClientTransport({ command: node, args: [path.join(resources, transportName === 'stdio-managed' ? 'gateway/mcp-server.mjs' : process.env.CGW_MCP_TEST_RESOURCES ? 'lan-kit/mcp-server.mjs' : 'docs/lan-kit/mcp-server.mjs')], cwd: root,
          env: { ...f.env, CGW_STORAGE_MODE: 'managed', CGW_BASE: f.ready.origin, CGW_API_KEY: key.token }, stderr: 'pipe' })
      transport.stderr?.resume()
      client = new Client({ name: 'codex-gateway-compatibility-check', version: '1.0.0' }, { capabilities: {} })
      const errors = []; client.onerror = error => errors.push(error.message)
      try { await client.connect(transport, timeout) }
      catch (error) { throw new Error(`SDK connect failed: ${error.message}; transport errors: ${errors.join('; ')}`) }
      assert.equal(client.getServerVersion().name, 'codex-gateway-image')
      const listed = await client.listTools({}, timeout)
      const names = listed.tools.map(tool => tool.name).sort()
      assert.deepEqual(names, transportName === 'streamable-http'
        ? ['delete_generated_image', 'generate_image', 'list_generated_images']
        : ['generate_image', 'list_generated_images'])
      await client.ping(timeout)
      const images = await client.callTool({ name: 'list_generated_images', arguments: {} }, undefined, timeout)
      assert.notEqual(images.isError, true); assert.ok(images.content.some(c => c.type === 'text' && c.text.includes(imageName)))
      const invalid = await client.callTool({ name: 'generate_image', arguments: { prompt: '' } }, undefined, timeout)
      assert.equal(invalid.isError, true)
      await assert.rejects(client.callTool({ name: 'nonexistent_tool', arguments: {} }, undefined, timeout), /unknown tool/)
      if (transportName === 'streamable-http') {
        const deleted = await client.callTool({ name: 'delete_generated_image', arguments: { name: imageName } }, undefined, timeout)
        assert.notEqual(deleted.isError, true)
        assert.equal(fs.existsSync(path.join(f.dataRoot, 'gen-images', imageName)), false)
      }
      assert.deepEqual(errors, [], 'no schema/transport errors during normal SDK exchange')
      await client.close(); client = null
      assert.equal((await f.command('shutdown', { reason: 'user_exit' })).ok, true)
      assert.equal((await f.wait(frame => frame.type === 'stopped')).payload.outcome, 'graceful')
      assert.equal((await f.exitWithin())[0], 0)
    } finally {
      if (client) await client.close()
      if (f) await f.stop()
      const resolved = fs.realpathSync(root)
      assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()))
      assert.ok(path.basename(resolved).startsWith('cgw-mcp-client-'))
      fs.rmSync(resolved, { recursive: true, force: true })
    }
  })
}
