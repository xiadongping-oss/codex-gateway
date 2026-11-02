import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { once } from 'node:events'
import { createDesktopLan } from '../desktop-lan.mjs'

async function freePort() {
  const s = net.createServer(); s.listen(0, '0.0.0.0'); await once(s, 'listening')
  const port = s.address().port; await new Promise(resolve => s.close(resolve)); return port
}
test('failed persistence closes candidate listener and keeps previous service and settings', async t => {
  let writable = true
  const manager = createDesktopLan({ consolePort: 4173, handler: (_req, res) => res.end('fixture'), persist: () => writable })
  t.after(() => manager.stop())
  const first = await freePort(), second = await freePort()
  await manager.configure({ enabled: true, port: first })
  writable = false
  await assert.rejects(manager.configure({ enabled: true, port: second }), { code: 'lan_save_failed' })
  assert.equal(manager.snapshot().port, first)
  assert.equal(await (await fetch(`http://127.0.0.1:${first}/v1/models`)).text(), 'fixture')
  await assert.rejects(fetch(`http://127.0.0.1:${second}/v1/models`))
  await assert.rejects(manager.configure({ enabled: false, port: first }), { code: 'lan_save_failed' })
  assert.equal(manager.snapshot().enabled, true)
  writable = true
  await manager.configure({ enabled: true, port: second })
  await assert.rejects(fetch(`http://127.0.0.1:${first}/v1/models`))
  assert.equal(manager.snapshot().port, second)
})
test('occupied saved port is nonfatal and can be disabled, with serialized changes and final stop', async t => {
  const busy = net.createServer(); busy.listen(0, '0.0.0.0'); await once(busy, 'listening')
  t.after(() => new Promise(resolve => busy.close(resolve)))
  const manager = createDesktopLan({ consolePort: 4173, handler: (_req, res) => res.end(), persist: () => true })
  t.after(() => manager.stop())
  const state = await manager.restore({ enabled: true, port: busy.address().port })
  assert.equal(state.enabled, false); assert.equal(state.configuredEnabled, true); assert.match(state.error, /已被占用/)
  const port = await freePort()
  await Promise.all([manager.configure({ enabled: true, port }), manager.configure({ enabled: false, port })])
  assert.equal(manager.snapshot().enabled, false)
  await manager.stop()
  await assert.rejects(manager.configure({ enabled: true, port }), { code: 'lan_stopped' })
})
