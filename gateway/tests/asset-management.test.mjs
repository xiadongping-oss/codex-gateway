import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from '../node_modules/pngjs/lib/png.js'
import { desktopFixture } from './lib/desktop-fixture.mjs'
import { assetId, organizeAssets, decorateAssets } from '../asset-metadata.mjs'

test('batch metadata preserves other fields and rejects invalid updates without partial writes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-management-meta-')), paths = { root, generated: path.join(root, 'images') }
  try {
    const images = [{ name: 'a.png', id: assetId('generated', 'a.png') }, { name: 'b.png', id: assetId('generated', 'b.png') }]
    organizeAssets(paths, images, { addTags: [' 插画 ', '插画'], addCollections: ['官网', '海报'], favorite: true })
    organizeAssets(paths, [images[0]], { notes: '透明背景，待确认', removeCollections: ['海报'] })
    const decorated = decorateAssets(paths, 'generated', images)
    assert.deepEqual(decorated[0].tags, ['插画']); assert.deepEqual(decorated[0].collections, ['官网']); assert.equal(decorated[0].favorite, true)
    assert.equal(decorated[0].notes, '透明背景，待确认'); assert.deepEqual(decorated[1].collections, ['官网', '海报'])
    const before = fs.readFileSync(path.join(root, 'data/asset-metadata.json'))
    assert.throws(() => organizeAssets(paths, images, { addTags: Array.from({ length: 33 }, (_, i) => String(i)) }))
    assert.throws(() => organizeAssets(paths, images, { notes: 'ambiguous' }))
    assert.deepEqual(fs.readFileSync(path.join(root, 'data/asset-metadata.json')), before)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('cross-source collections, scoped batches, recycle/restore conflicts, restart persistence and permanent deletion', { timeout: 60000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-management-'))
  const resources = fileURLToPath(new URL('../..', import.meta.url))
  const png = new PNG({ width: 4, height: 4 }); png.data.fill(255); const bytes = PNG.sync.write(png)
  let fixture
  const open = async () => { fixture = await desktopFixture({ resources, node: process.execPath, root }); await fixture.start(); await fixture.login() }
  try {
    await open()
    const a = (await (await fixture.request('/__gw/apikeys', { name: 'A' })).json()).key
    const b = (await (await fixture.request('/__gw/apikeys', { name: 'B' })).json()).key
    const dir = path.join(fixture.dataRoot, 'gen-images'); fs.mkdirSync(dir, { recursive: true })
    for (const name of ['A.png', 'A2.png', 'B.png']) fs.writeFileSync(path.join(dir, name), bytes)
    const originalIndex = { 'A.png': { keyId: a.id, keyName: 'A', createdAt: 1, generation: { prompt: 'blue mountain' } }, 'A2.png': { keyId: a.id, keyName: 'A', createdAt: 2 }, 'B.png': { keyId: b.id, keyName: 'B' } }
    fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(originalIndex))
    const localDir = path.join(root, 'local'); fs.mkdirSync(localDir); fs.writeFileSync(path.join(localDir, 'local.png'), bytes)
    const source = (await (await fixture.request('/__gw/assets/sources', { type: 'local', name: 'Local', config: { dir: localDir } })).json()).source
    const request = (route, key = a.token, body) => fetch(fixture.ready.origin + route, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000) })
    const side = '/v1/gen-images/library', admin = '/__gw/assets/library'
    // 后台素材列表必须透出生成时的 keyId/keyName，供「按来源用户」筛选。
    const generated = await (await fixture.request('/__gw/assets?src=generated')).json()
    const byName = Object.fromEntries(generated.images.map(i => [i.name, i]))
    assert.equal(byName['A.png'].ownerKeyId, a.id); assert.equal(byName['A.png'].ownerKeyName, 'A')
    assert.equal(byName['B.png'].ownerKeyId, b.id); assert.equal(byName['B.png'].ownerKeyName, 'B')
    const all = await (await fixture.request(admin)).json()
    assert.equal(all.total, 4); assert.equal(all.sources.length, 2)
    const items = all.images.filter(i => ['A.png', 'local.png'].includes(i.name)).map(({ id, sourceId, name }) => ({ id, sourceId, name }))
    assert.equal((await fixture.request(admin, { action: 'organize', items, operations: { addTags: ['透明', '待确认'], addCollections: ['官网'], favorite: true } })).status, 200)
    const cross = await (await fixture.request(admin + '?collection=' + encodeURIComponent('官网'))).json()
    assert.equal(cross.total, 2)
    const own = await (await request(side)).json(); assert.equal(own.total, 2)
    assert.ok(own.facets.tags.includes('透明')); assert.equal((await (await request(side, b.token)).json()).facets.tags.length, 0)
    assert.equal((await (await request(side + '?q=' + encodeURIComponent('官网 透明'))).json()).total, 1)
    const foreign = all.images.find(i => i.name === 'B.png'), first = own.images.find(i => i.name === 'A.png')
    const mixed = [first, foreign].map(({ id, sourceId, name }) => ({ id, sourceId, name }))
    assert.equal((await request(side, a.token, { action: 'organize', items: mixed, operations: { addTags: ['should-not-write'] } })).status, 404)
    assert.equal((await (await request(side + '?tag=should-not-write')).json()).total, 0)
    const removed = await (await request(side, a.token, { action: 'trash', items: [mixed[0]] })).json()
    assert.equal(removed.results[0].ok, true); const id = removed.results[0].trashId
    assert.equal(fs.existsSync(path.join(dir, 'A.png')), false)
    assert.equal((await request('/v1/gen-images/A.png')).status, 404)
    const recycle = await (await request(side + '?trash=true')).json()
    assert.equal(recycle.total, 1); assert.deepEqual(recycle.images[0].tags, ['透明', '待确认'])
    assert.equal((await (await request(side + '?trash=true', b.token)).json()).total, 0)
    assert.equal((await request(side + '?trashFile=' + id, b.token)).status, 404)
    assert.equal((await request(side, b.token, { action: 'restore', ids: [id] })).status, 404)
    assert.deepEqual(Buffer.from(await (await request(side + '?trashFile=' + id)).arrayBuffer()), bytes)
    fs.writeFileSync(path.join(dir, 'A.png'), 'existing file')
    const conflict = await (await request(side, a.token, { action: 'restore', ids: [id] })).json()
    assert.equal(conflict.results[0].ok, false); assert.match(conflict.results[0].error, /同名/)
    assert.equal(fs.readFileSync(path.join(dir, 'A.png'), 'utf8'), 'existing file'); fs.unlinkSync(path.join(dir, 'A.png'))
    await fixture.stop(); await open()
    assert.equal((await (await request(side + '?trash=true')).json()).total, 1)
    assert.equal((await (await request(side, a.token, { action: 'restore', ids: [id] })).json()).results[0].ok, true)
    assert.deepEqual(fs.readFileSync(path.join(dir, 'A.png')), bytes)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'index.json')))['A.png'], originalIndex['A.png'])
    const restored = await (await request(side + '?collection=' + encodeURIComponent('官网'))).json()
    assert.equal(restored.total, 1); assert.equal(restored.images[0].id, first.id)
    const localTrash = await (await fixture.request(admin, { action: 'trash', items: items.filter(i => i.sourceId === source.id) })).json()
    const localId = localTrash.results[0].trashId; assert.equal(fs.existsSync(path.join(localDir, 'local.png')), false)
    assert.equal((await (await request(side + '?trash=true')).json()).total, 0)
    assert.equal((await (await fixture.request(admin, { action: 'restore', ids: [localId] })).json()).results[0].ok, true)
    assert.deepEqual(fs.readFileSync(path.join(localDir, 'local.png')), bytes)
    // Legacy UI delete now shares the reversible path; it never contacts the image provider.
    const oldDelete = await (await fixture.request('/__gw/assets/files', { src: 'generated', names: ['A2.png'] }, 'DELETE')).json()
    assert.equal(oldDelete.deleted, 1); const purgeId = oldDelete.results[0].trashId
    assert.equal((await (await request(side, a.token, { action: 'purge', ids: [purgeId] })).json()).results[0].ok, true)
    assert.equal((await request(side + '?trashFile=' + purgeId)).status, 404)
    assert.equal(fs.existsSync(path.join(dir, 'B.png')), true)
  } finally { if (fixture) await fixture.stop(); fs.rmSync(root, { recursive: true, force: true }) }
})
