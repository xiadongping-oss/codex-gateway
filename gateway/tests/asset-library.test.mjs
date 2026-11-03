import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { desktopFixture } from './lib/desktop-fixture.mjs'
import { assetId, updateAssetMetadata, decorateAssets } from '../asset-metadata.mjs'

test('asset identities, validated metadata, and corrupt-store preservation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-asset-meta-'))
  const paths = { root, generated: path.join(root, 'generated') }
  try {
    assert.notEqual(assetId('a', 'x.png'), assetId('b', 'x.png'))
    const id = assetId('a', 'x.png')
    updateAssetMetadata(paths, 'a', 'x.png', { title: ' 新标题 ', favorite: true, id: 'overwrite', generation: { prompt: 'overwrite' } })
    const [image] = decorateAssets(paths, 'a', [{ name: 'x.png' }])
    assert.equal(image.id, id); assert.equal(image.title, '新标题'); assert.equal(image.favorite, true); assert.equal(image.generation, null)
    assert.throws(() => updateAssetMetadata(paths, 'a', 'x.png', { title: 'x'.repeat(161) }))
    assert.throws(() => updateAssetMetadata(paths, 'a', 'x.png', { favorite: 'true' }))
    const file = path.join(root, 'data', 'asset-metadata.json')
    fs.writeFileSync(file, 'broken')
    assert.throws(() => updateAssetMetadata(paths, 'a', 'x.png', { title: 'lost' }))
    assert.equal(fs.readFileSync(file, 'utf8'), 'broken')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('gallery paging beyond 200, scoped search, cross-surface metadata and restart persistence', { timeout: 60000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-asset-library-'))
  const resources = fileURLToPath(new URL('../..', import.meta.url))
  let fixture
  const open = async () => {
    fixture = await desktopFixture({ resources, node: process.execPath, root })
    await fixture.start(); await fixture.login()
  }
  try {
    await open()
    const keys = []
    for (const name of ['A', 'B']) keys.push((await (await fixture.request('/__gw/apikeys', { name })).json()).key)
    const [a, b] = keys, dir = path.join(fixture.dataRoot, 'gen-images'), index = {}
    fs.mkdirSync(dir, { recursive: true })
    for (let i = 0; i < 211; i++) {
      const name = `fixture_${String(i).padStart(4, '0')}.png`
      fs.writeFileSync(path.join(dir, name), Buffer.from('fixture'))
      index[name] = { keyId: i === 210 ? b.id : a.id, size: 7, mtime: i, generation: i === 0 ? { prompt: '蓝色 山峰', revisedPrompt: 'mountain landscape', requested: { size: 'auto' }, actual: { actual: '1024x1024' } } : null }
    }
    fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(index))
    const request = (route, key = a.token, body) => fetch(fixture.ready.origin + route, {
      method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000)
    })
    const page = await (await request('/v1/gen-images/list?limit=24&offset=192')).json()
    assert.equal(page.total, 210); assert.equal(page.images.length, 18)
    assert.ok(page.images.some(i => i.name === 'fixture_0000.png'))
    const match = await (await request('/v1/gen-images/list?q=' + encodeURIComponent('蓝色 山峰'))).json()
    assert.equal(match.total, 1); assert.equal(match.images[0].generation.prompt, '蓝色 山峰')
    const image = match.images[0]
    assert.equal((await request('/v1/gen-images/metadata', b.token, { name: image.name, changes: { favorite: true } })).status, 404)
    assert.equal((await request('/v1/gen-images/metadata', '', { name: image.name, changes: { favorite: true } })).status, 401)
    assert.equal((await request('/v1/gen-images/metadata', a.token, { name: image.name, changes: { title: '山峰背景', favorite: true } })).status, 200)
    const client = await (await fixture.request('/__gw/assets?src=generated')).json()
    const same = client.images.find(i => i.id === image.id)
    assert.equal(same.title, '山峰背景'); assert.equal(same.favorite, true)
    assert.equal((await fixture.request('/__gw/assets/metadata', { name: image.name, changes: { title: '官网背景' } })).status, 200)
    assert.equal((await (await request('/v1/gen-images/list?favorite=true&q=' + encodeURIComponent('官网'))).json()).total, 1)
    assert.equal((await (await request('/v1/gen-images/list?favorite=true', b.token)).json()).total, 0)
    await fixture.stop(); await open()
    const persisted = await (await request('/v1/gen-images/list?favorite=true')).json()
    assert.equal(persisted.total, 1); assert.equal(persisted.images[0].id, image.id); assert.equal(persisted.images[0].title, '官网背景')
    assert.equal(fs.readFileSync(path.join(dir, image.name), 'utf8'), 'fixture')
  } finally { if (fixture) await fixture.stop(); fs.rmSync(root, { recursive: true, force: true }) }
})
