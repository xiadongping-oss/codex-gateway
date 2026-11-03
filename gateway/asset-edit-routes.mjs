import fs from 'node:fs'
import { createEditSession, editSession, saveEditSession, editFile, exportEditSession } from './asset-edits.mjs'

export async function handleEditRoute(req, res, { paths, admin, keyId, readBody, listImages, resolveFile, validKeyIds = [] }) {
  const url = new URL(req.url, 'http://127.0.0.1')
  const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)) }
  try {
    if (!admin && !keyId) return send(401, { error: 'api_key_required' })
    if (req.method === 'POST') {
      const body = await readBody(req)
      if (!body.id) {
        const source = admin ? body.src || 'generated' : 'generated'
        const image = listImages(source).find(i => i.name === body.name)
        if (!image) return send(404, { error: 'not_found' })
        const file = resolveFile(source, body.name)
        if (!file || file.size > 25 * 1024 * 1024) return send(400, { error: '原图不可读或超过 25MB；云端图片请先下载并导入本地素材源' })
        const owner = admin ? image.ownerKeyId || body.keyId || null : keyId
        if (admin && body.keyId && image.ownerKeyId && body.keyId !== image.ownerKeyId) return send(400, { error: '请选择生成此图片的 Key' })
        if (admin && owner && !validKeyIds.includes(owner)) return send(400, { error: '所选 Key 不可用，请重新选择' })
        const session = createEditSession(paths, { source, name: image.name, title: image.title, bytes: fs.readFileSync(file.full), keyId: owner, parent: image.generation?.edit })
        return send(200, { ok: true, session })
      }
      const session = editSession(paths, body.id, keyId, admin)
      if (body.action === 'export') return send(200, { ok: true, export: exportEditSession(paths, session) })
      return send(200, { ok: true, session: saveEditSession(paths, body.id, keyId, admin, body) })
    }
    if (req.method !== 'GET') return send(405, { error: 'method_not_allowed' })
    if (url.searchParams.get('versions') === 'true') {
      const source = admin ? url.searchParams.get('src') || 'generated' : 'generated'
      const image = listImages(source).find(i => i.name === url.searchParams.get('name'))
      if (!image) return send(404, { error: 'not_found' })
      const family = image.familyId || image.id
      const versions = listImages('generated').filter(i => (i.familyId || i.id) === family)
      if (source !== 'generated') versions.push(image)
      return send(200, { ok: true, images: versions.map(i => ({ id: i.id, name: i.name, title: i.title || i.name, parentId: i.parentId, source: i.id === image.id ? source : 'generated', createdAt: i.mtime || i.at })) })
    }
    const session = editSession(paths, url.searchParams.get('id'), keyId, admin)
    const kind = url.searchParams.get('file')
    if (!kind) return send(200, { ok: true, session })
    const file = editFile(paths, session, kind)
    res.writeHead(200, { 'Content-Type': file.mime, 'Content-Length': file.bytes.length, 'Cache-Control': 'no-store', 'Content-Disposition': `inline; filename="${file.filename}"` }); res.end(file.bytes)
  } catch (e) { return send(e.status || 400, { error: e.status === 404 ? 'not_found' : 'invalid_edit', detail: e.message }) }
}
