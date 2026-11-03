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
test('shared listener allows only exact public client GET routes and keeps management blocked',async t=>{
  const reached=[]
  const manager=createDesktopLan({consolePort:4173,persist:()=>true,handler:(req,res)=>{reached.push(req.url);assert.equal(req.desktopLan,true);res.end('client fixture')}})
  t.after(()=>manager.stop())
  const port=await freePort();await manager.configure({enabled:true,port})
  const base=`http://127.0.0.1:${port}`
  for(const route of ['/client-setup.js','/client-assets.json','/setup','/setup/','/gallery','/gallery/','/gallery?preview=1','/lan-kit/setup-client.mjs?host=192.0.2.1&port=4174','/lan-kit/INSTALL.md','/lan-kit/AGENT-PROMPT.md','/lan-kit/skills/codex-gateway-image/SKILL.md','/__gw/gen-images/fixture.jpeg','/__gw/gen-images/fixture.webp'])assert.equal((await fetch(base+route)).status,200,route)
  const count=reached.length
  for(const route of ['/','/settings','/gallery/admin','/setup-config','/lan-kit/admin-token.json','/__gw/status','/__gw/gen-images','/__gw/apikeys/reveal','/__gw/gen-images/fixture.svg'])assert.equal((await fetch(base+route)).status,403,route)
  for(const route of ['/setup','/gallery','/client-setup.js','/client-assets.json','/lan-kit/setup-client.mjs'])assert.equal((await fetch(base+route,{method:'POST'})).status,403)
  assert.equal(reached.length,count,'rejected requests never reach business/control handlers')
})
