import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { writeJsonAtomic } from './atomic-write.mjs'

const ID = /^[a-f0-9]{8}-[a-f0-9-]{27}$/
const fail = (message, status = 400) => Object.assign(new Error(message), { status })
function root(paths) { return path.join(paths.root, 'data', 'asset-trash') }
function dir(paths, id) { if (!ID.test(id || '')) throw fail('回收记录不存在', 404); return path.join(root(paths), id) }
function index(paths) {
  try { const value = JSON.parse(fs.readFileSync(path.join(paths.generated, 'index.json'), 'utf8')); if (!value || Array.isArray(value) || typeof value !== 'object') throw fail('生成图库索引损坏'); return value }
  catch (e) { if (e.code === 'ENOENT') return {}; throw e }
}
export function trashEntry(paths, id, keyId, admin = false) {
  let entry
  try { entry = JSON.parse(fs.readFileSync(path.join(dir(paths, id), 'entry.json'), 'utf8')) }
  catch (e) { if (e.code === 'ENOENT') throw fail('回收记录不存在', 404); throw e }
  if (!admin && (!keyId || entry.ownerKeyId !== keyId)) throw fail('回收记录不存在', 404)
  return entry
}
export function listTrash(paths, keyId, admin = false) {
  let names
  try { names = fs.readdirSync(root(paths)).filter(n => ID.test(n)) } catch (e) { if (e.code === 'ENOENT') return []; throw e }
  return names.map(id => { try { return trashEntry(paths, id, keyId, admin) } catch (e) { if (e.status === 404) return null; throw e } })
    .filter(entry => entry && fs.existsSync(path.join(dir(paths, entry.trashId), 'image')))
    .sort((a, b) => b.deletedAt - a.deletedAt)
}
export function trashFile(paths, sourceId, image, file) {
  const stat = fs.lstatSync(file.full)
  if (!stat.isFile() || stat.isSymbolicLink()) throw fail('素材文件不可回收')
  const generated = sourceId === 'generated', registry = generated ? index(paths) : null
  const generationRecord = generated ? registry[image.name] || null : null
  const id = crypto.randomUUID(), destination = dir(paths, id)
  const entry = { trashId: id, sourceId, name: image.name, image, originalPath: path.resolve(file.full), ownerKeyId: generationRecord?.keyId || null, generationRecord, contentType: file.contentType || 'application/octet-stream', mtime: stat.mtimeMs, atime: stat.atimeMs, deletedAt: Date.now() }
  fs.mkdirSync(destination, { recursive: true })
  writeJsonAtomic(path.join(destination, 'entry.json'), entry)
  // The original is removed only after an exclusive full copy succeeds, including cross-drive sources.
  fs.copyFileSync(file.full, path.join(destination, 'image'), fs.constants.COPYFILE_EXCL)
  try { fs.unlinkSync(file.full) } catch (e) { fs.unlinkSync(path.join(destination, 'image')); throw e }
  if (generated) { delete registry[image.name]; writeJsonAtomic(path.join(paths.generated, 'index.json'), registry) }
  return id
}
export function restoreTrash(paths, id, keyId, admin, destination) {
  const entry = trashEntry(paths, id, keyId, admin)
  if (!destination || path.resolve(destination) !== entry.originalPath) throw fail('素材源已移除或目录已变更，请先恢复原素材源', 409)
  if (fs.existsSync(destination)) throw fail('原位置已有同名文件，请先处理重名文件，未覆盖现有文件', 409)
  if (entry.sourceId === 'generated') {
    const registry = index(paths)
    if (entry.generationRecord) registry[entry.name] = entry.generationRecord
    writeJsonAtomic(path.join(paths.generated, 'index.json'), registry)
  }
  fs.copyFileSync(path.join(dir(paths, id), 'image'), destination, fs.constants.COPYFILE_EXCL)
  if (Number.isFinite(entry.mtime)) fs.utimesSync(destination, new Date(entry.atime || entry.mtime), new Date(entry.mtime))
  fs.unlinkSync(path.join(dir(paths, id), 'image'))
  fs.unlinkSync(path.join(dir(paths, id), 'entry.json')); fs.rmdirSync(dir(paths, id))
  return entry
}
export function purgeTrash(paths, id, keyId, admin) {
  trashEntry(paths, id, keyId, admin)
  fs.unlinkSync(path.join(dir(paths, id), 'image'))
  fs.unlinkSync(path.join(dir(paths, id), 'entry.json')); fs.rmdirSync(dir(paths, id))
}
export function trashImage(paths, id, keyId, admin) {
  const entry = trashEntry(paths, id, keyId, admin)
  return { bytes: fs.readFileSync(path.join(dir(paths, id), 'image')), contentType: entry.contentType }
}
