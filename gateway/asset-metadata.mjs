import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { writeJsonAtomic } from './atomic-write.mjs'

// IDs describe storage identity, independent of the editable display title.
export function assetId(source, name) {
  return 'asset_' + crypto.createHash('sha256').update(JSON.stringify([source, name])).digest('hex').slice(0, 32)
}
function read(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('素材信息文件损坏')
    return value
  } catch (e) { if (e.code === 'ENOENT') return {}; throw e }
}
export function decorateAssets(paths, source, images) {
  const edits = read(path.join(paths.root, 'data', 'asset-metadata.json'))
  const generated = source === 'generated' ? read(path.join(paths.generated, 'index.json')) : {}
  return images.map(image => {
    const id = assetId(source, image.name)
    const edit = generated[image.name]?.generation?.edit
    return { ...image, id, parentId: edit?.parentId || null, familyId: edit?.familyId || id, title: '', favorite: false, tags: [], collections: [], notes: '', generation: generated[image.name]?.generation || image.generation || null, ...edits[id] }
  })
}
export function updateAssetMetadata(paths, source, name, changes) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new Error('素材信息无效')
  const patch = {}
  if (Object.hasOwn(changes, 'title')) {
    if (typeof changes.title !== 'string' || changes.title.trim().length > 160) throw new Error('标题最多 160 字')
    patch.title = changes.title.trim()
  }
  if (Object.hasOwn(changes, 'favorite')) {
    if (typeof changes.favorite !== 'boolean') throw new Error('收藏状态无效')
    patch.favorite = changes.favorite
  }
  for (const field of ['tags', 'collections']) if (Object.hasOwn(changes, field)) patch[field] = labelList(changes[field], field)
  if (Object.hasOwn(changes, 'notes')) { if (typeof changes.notes !== 'string' || changes.notes.length > 8000) throw new Error('备注最多 8000 字'); patch.notes = changes.notes.trim() }
  if (!Object.keys(patch).length) throw new Error('没有可更新的信息')
  const file = path.join(paths.root, 'data', 'asset-metadata.json')
  const edits = read(file), id = assetId(source, name)
  edits[id] = { ...edits[id], ...patch }
  writeJsonAtomic(file, edits)
  return { id, ...edits[id] }
}
export function queryAssets(images, { q = '', favorite = false, sort = 'newest', tag = '', collection = '' } = {}) {
  const terms = String(q ?? '').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const result = images.filter(image => (!favorite || image.favorite) && (!tag || image.tags?.includes(tag)) && (!collection || image.collections?.includes(collection)) && terms.every(term =>
    [image.title, image.name, image.notes, ...(image.tags || []), ...(image.collections || []), image.generation?.prompt, image.generation?.revisedPrompt].filter(Boolean).join('\n').toLocaleLowerCase().includes(term)))
  return result.sort(sort === 'name'
    ? (a, b) => (a.title || a.name).localeCompare(b.title || b.name, 'zh-CN')
    : (a, b) => (b.deletedAt || b.mtime || b.at || 0) - (a.deletedAt || a.mtime || a.at || 0) || a.name.localeCompare(b.name))
}

export function labelList(value, field) {
  const max = field === 'tags' ? 32 : 20, width = field === 'tags' ? 40 : 80
  if (!Array.isArray(value) || value.length > max || value.some(v => typeof v !== 'string' || !v.trim() || v.trim().length > width || /[\u0000-\u001f\u007f]/.test(v))) throw new Error(`${field === 'tags' ? '标签' : '集合'}最多 ${max} 项，每项最多 ${width} 字`)
  return [...new Set(value.map(v => v.trim()))]
}
export function organizeAssets(paths, images, operations) {
  if (!operations || typeof operations !== 'object' || Array.isArray(operations)) throw new Error('整理操作无效')
  const normalized = {}
  for (const field of ['addTags', 'removeTags', 'addCollections', 'removeCollections']) if (Object.hasOwn(operations, field)) normalized[field] = labelList(operations[field], field.endsWith('Tags') ? 'tags' : 'collections')
  if (Object.hasOwn(operations, 'favorite')) { if (typeof operations.favorite !== 'boolean') throw new Error('收藏状态无效'); normalized.favorite = operations.favorite }
  if (Object.hasOwn(operations, 'notes')) { if (images.length !== 1 || typeof operations.notes !== 'string' || operations.notes.length > 8000) throw new Error('备注仅支持单图，最多 8000 字'); normalized.notes = operations.notes.trim() }
  if (!Object.keys(normalized).length) throw new Error('请选择整理操作')
  const file = path.join(paths.root, 'data', 'asset-metadata.json'), edits = read(file)
  for (const image of images) {
    const previous = edits[image.id] || {}, patch = { ...previous }
    for (const [field, suffix] of [['tags', 'Tags'], ['collections', 'Collections']]) {
      const removed = new Set(normalized['remove' + suffix] || [])
      patch[field] = labelList([...new Set([...(previous[field] || []), ...(normalized['add' + suffix] || [])])].filter(v => !removed.has(v)), field)
    }
    for (const field of ['favorite', 'notes']) if (Object.hasOwn(normalized, field)) patch[field] = normalized[field]
    edits[image.id] = patch
  }
  writeJsonAtomic(file, edits)
  return images.length
}
