import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { NO_OWNER, buildOwnerOptions, matchesOwner } from '../src/api/asset-owners.js'

const images = [
  { name: 'a.png', ownerKeyId: 'key_aaaa1111', ownerKeyName: 'lan' },
  { name: 'b.png', ownerKeyId: 'key_aaaa1111', ownerKeyName: 'lan' },
  { name: 'c.png', ownerKeyId: 'key_bbbb2222', ownerKeyName: 'lan2' },
  { name: 'd.png', ownerKeyId: 'key_cccc3333', ownerKeyName: null },
  { name: 'e.png', ownerKeyId: null }
]

test('owner options group by keyId, count images and keep a bucket for legacy unowned images', () => {
  const options = buildOwnerOptions(images)
  assert.equal(options.length, 4)
  assert.deepEqual(options.map(o => o.count), [2, 1, 1, 1])
  const lan = options.find(o => o.id === 'key_aaaa1111')
  assert.equal(lan.label, 'lan · aaaa1111')
  assert.equal(options.find(o => o.id === 'key_bbbb2222').label, 'lan2 · bbbb2222')
  assert.equal(options.find(o => o.id === 'key_cccc3333').label, '已删除的 Key · cccc3333', 'Key 被删后仍可按 keyId 筛选')
  assert.equal(options.find(o => o.id === NO_OWNER).label, '无归属（旧图）')
  assert.deepEqual(buildOwnerOptions([]), [])
})

test('owner filter only matches the selected keyId; non-generated sources are never filtered out', () => {
  assert.equal(images.filter(i => matchesOwner(i, '')).length, 5, '空筛选显示全部')
  assert.deepEqual(images.filter(i => matchesOwner(i, 'key_aaaa1111')).map(i => i.name), ['a.png', 'b.png'])
  assert.deepEqual(images.filter(i => matchesOwner(i, 'key_bbbb2222')).map(i => i.name), ['c.png'])
  assert.deepEqual(images.filter(i => matchesOwner(i, NO_OWNER)).map(i => i.name), ['e.png'])
  assert.equal(matchesOwner({ name: 'local.png' }, 'key_aaaa1111'), false)
})

test('generated list exposes ownership and the workspace page wires the filter', () => {
  const assets = fs.readFileSync(new URL('../../gateway/assets.mjs', import.meta.url), 'utf8')
  assert.match(assets, /ownerKeyId:\s*meta\.keyId/)
  assert.match(assets, /ownerKeyName:\s*meta\.keyName/)
  const view = fs.readFileSync(new URL('../src/views/Images.vue', import.meta.url), 'utf8')
  assert.match(view, /import \{ buildOwnerOptions, matchesOwner \}/)
  assert.match(view, /const ownerOptions = computed\(/)
  assert.match(view, /matchesOwner\(img, ownerFilter\.value\)/)
  assert.match(view, /v-model="ownerFilter"[^>]*aria-label="按来源用户筛选"/)
  assert.match(view, /v-for="o in ownerOptions"/)
  assert.match(view, /img\.ownerKeyId\.slice\(-8\)/, '卡片上应显示归属 keyId 后 8 位')
  assert.match(view, /ownerFilter\.value = ''/, '切换素材源时重置筛选')
})
