import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createAuditHarness } from './audit-harness.mjs'

test('admin can rename a Key without rotating credentials or changing gallery identity; rename survives restart', { timeout: 30000 }, async t => {
  const harness = await createAuditHarness()
  t.after(() => harness.close())
  harness.reset()
  let child = await harness.start()
  const admin = JSON.parse(fs.readFileSync(path.join(harness.sandbox, 'admin-token.json'))).token
  const request = (route, token = admin, method = 'GET', body) => fetch(harness.base + route, {
    method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000)
  })
  const created = await (await request('/__gw/apikeys', admin, 'POST', { name: 'A' })).json()
  const key = created.key
  const filename = 'rename_fixture_A01.png'
  fs.writeFileSync(path.join(harness.generated, filename), Buffer.from('fixture'))
  fs.writeFileSync(path.join(harness.generated, 'index.json'), JSON.stringify({ [filename]: { keyId: key.id, keyName: key.name } }))
  const before = (await (await request('/__gw/apikeys')).json()).keys[0]
  const response = await request('/__gw/apikeys', admin, 'PATCH', { id: key.id, name: '  设计部\n小王\u202e  ', accountIds: ['must-not-apply'], disabled: true })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true, id: key.id, name: '设计部 小王' })
  const after = (await (await request('/__gw/apikeys')).json()).keys[0]
  assert.deepEqual({ ...after, name: before.name }, before)
  const revealed = await (await request('/__gw/apikeys/reveal?id=' + key.id)).json()
  assert.equal(revealed.token, key.token)
  for (const [token, body, status] of [
    [key.token, { id: key.id, name: 'unauthorized' }, 401],
    [admin, { id: key.id, name: ' \u200b ' }, 400],
    [admin, { id: key.id, name: {} }, 400],
    [admin, { id: 'missing', name: 'missing' }, 404]
  ]) {
    const rejected = await request('/__gw/apikeys', token, 'PATCH', body)
    assert.equal(rejected.status, status); await rejected.arrayBuffer()
  }
  await harness.stop(child)
  child = await harness.start()
  const me = await (await request('/v1/gen-images/me', key.token)).json()
  assert.equal(me.keyId, key.id); assert.equal(me.keyName, '设计部 小王'); assert.equal(me.images, 1)
  const gallery = await (await request('/v1/gen-images/list', key.token)).json()
  assert.equal(gallery.images[0].name, filename)
})
