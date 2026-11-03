import path from 'node:path'
import { decorateAssets, organizeAssets, queryAssets } from './asset-metadata.mjs'
import { listTrash, trashEntry, trashFile, restoreTrash, purgeTrash, trashImage } from './asset-trash.mjs'

export async function handleLibraryRoute(req, res, { paths, admin = false, keyId, readBody, sources, listImages, resolveFile, restorePath }) {
  const url = new URL(req.url, 'http://127.0.0.1')
  const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)) }
  try {
    if (!admin && !keyId) return send(401, { error: 'api_key_required' })
    if (req.method === 'GET') {
      if (url.searchParams.has('trashFile')) {
        const file = trashImage(paths, url.searchParams.get('trashFile'), keyId, admin)
        res.writeHead(200, { 'Content-Type': file.contentType, 'Content-Length': file.bytes.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'" }); return res.end(file.bytes)
      }
      const trash = url.searchParams.get('trash') === 'true'
      let all = trash ? listTrash(paths, keyId, admin).map(entry => ({ ...decorateAssets(paths, entry.sourceId, [entry.image])[0], sourceId: entry.sourceId, trashId: entry.trashId, deletedAt: entry.deletedAt }))
        : sources.flatMap(source => listImages(source.id).map(image => ({ ...image, sourceId: source.id })))
      const facets = { tags: [...new Set(all.flatMap(i => i.tags || []))].sort(), collections: [...new Set(all.flatMap(i => i.collections || []))].sort() }
      const source = url.searchParams.get('source')
      if (source) all = all.filter(i => i.sourceId === source)
      const images = queryAssets(all, { q: url.searchParams.get('q'), favorite: url.searchParams.get('favorite') === 'true', sort: url.searchParams.get('sort'), tag: url.searchParams.get('tag'), collection: url.searchParams.get('collection') })
      const offset = Math.max(0, Math.floor(Number(url.searchParams.get('offset')) || 0)), limit = Math.max(1, Math.min(100, Math.floor(Number(url.searchParams.get('limit')) || 24)))
      return send(200, { ok: true, total: images.length, images: images.slice(offset, offset + limit), facets, sources })
    }
    if (req.method !== 'POST') return send(405, { error: 'method_not_allowed' })
    const body = await readBody(req)
    if (['restore', 'purge'].includes(body.action)) {
      if (!Array.isArray(body.ids) || !body.ids.length || body.ids.length > 200 || new Set(body.ids).size !== body.ids.length) throw new Error('每次处理 1–200 条回收记录')
      // Verify ownership for the entire selection before changing any files.
      const entries = body.ids.map(id => trashEntry(paths, id, keyId, admin))
      const results = entries.map(entry => {
        try {
          if (body.action === 'restore') restoreTrash(paths, entry.trashId, keyId, admin, restorePath(entry))
          else purgeTrash(paths, entry.trashId, keyId, admin)
          return { id: entry.trashId, ok: true }
        } catch (e) { return { id: entry.trashId, ok: false, error: e.message } }
      })
      return send(200, { ok: true, results })
    }
    if (!['organize', 'trash'].includes(body.action)) throw new Error('未知素材操作')
    if (!Array.isArray(body.items) || !body.items.length || body.items.length > 200) throw new Error('每次处理 1–200 张素材')
    const lists = new Map(), seen = new Set()
    const images = body.items.map(item => {
      const source = admin ? item.sourceId : 'generated'
      if (!sources.some(s => s.id === source) || (!admin && item.sourceId !== 'generated')) throw Object.assign(new Error('素材不存在'), { status: 404 })
      if (!lists.has(source)) lists.set(source, listImages(source))
      const image = lists.get(source).find(i => i.name === item.name && i.id === item.id)
      if (!image || seen.has(image.id)) throw Object.assign(new Error('素材不存在或重复选择'), { status: 404 })
      seen.add(image.id)
      return { ...image, sourceId: source }
    })
    if (body.action === 'organize') return send(200, { ok: true, updated: organizeAssets(paths, images, body.operations) })
    const files = images.map(image => { const file = resolveFile(image.sourceId, image.name); if (!file) throw new Error('云端上传记录仅支持整理，回收图片请先导入本地'); return file })
    const results = images.map((image, i) => {
      try { return { id: image.id, ok: true, trashId: trashFile(paths, image.sourceId, image, files[i]) } }
      catch (e) { return { id: image.id, ok: false, error: e.message } }
    })
    return send(200, { ok: true, results })
  } catch (e) { return send(e.status || 400, { error: e.status === 404 ? 'not_found' : 'invalid_library_operation', detail: e.message }) }
}

export function generatedRestorePath(paths, entry) {
  return entry.sourceId === 'generated' && path.basename(entry.name) === entry.name && /^[A-Za-z0-9_-]+\.(png|jpeg|webp)$/.test(entry.name) ? path.join(paths.generated, entry.name) : null
}
