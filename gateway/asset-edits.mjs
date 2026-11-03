import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { writeJsonAtomic } from './atomic-write.mjs'
import { assetId } from './asset-metadata.mjs'
import { imageFileInfo } from './image-file.mjs'

const ID = /^[a-f0-9-]{36}$/
const MAX_BYTES = 25 * 1024 * 1024
const error = (message, status = 400) => Object.assign(new Error(message), { status })
function directory(paths, id) {
  if (!ID.test(id || '')) throw error('编辑任务不存在', 404)
  return path.join(paths.root, 'data', 'asset-edits', id)
}
function read(paths, id) {
  try { return JSON.parse(fs.readFileSync(path.join(directory(paths, id), 'draft.json'), 'utf8')) }
  catch (e) { if (e.code === 'ENOENT') throw error('编辑任务不存在', 404); throw e }
}
export function editSession(paths, id, keyId, admin = false) {
  const session = read(paths, id)
  if (!admin && (!keyId || session.keyId !== keyId)) throw error('编辑任务不存在', 404)
  return session
}
export function createEditSession(paths, { source, name, title, bytes, keyId = null, parent = null }) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_BYTES) throw error('原图须小于 25MB')
  const info = imageFileInfo(bytes.toString('base64'))
  if (!['png', 'jpeg', 'webp'].includes(info.format) || !info.width || !info.height || info.width * info.height > 16 * 1024 * 1024) throw error('标注支持有效的 PNG、JPEG、WebP 图片（最多 16M 像素），请先转换其他格式')
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex')
  const latest = path.join(paths.root, 'data', 'asset-edits', `latest-${assetId(source, name)}-${keyId || 'admin'}.json`)
  try { const previous = read(paths, JSON.parse(fs.readFileSync(latest, 'utf8')).id); if (previous.keyId === keyId && previous.sha256 === sha256) return previous }
  catch (e) { if (e.code !== 'ENOENT' && e.status !== 404) throw e }
  const id = crypto.randomUUID(), dir = directory(paths, id)
  const session = { id, revision: 0, keyId, source, name, title: title || name, parentId: assetId(source, name),
    familyId: parent?.familyId || parent?.parentId || assetId(source, name),
    format: info.format, width: info.width, height: info.height, sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    marks: [], instruction: '', preserve: '', createdAt: Date.now(), updatedAt: Date.now() }
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'original.' + info.format), bytes, { mode: 0o600 })
  writeJsonAtomic(path.join(dir, 'draft.json'), session)
  writeJsonAtomic(latest, { id })
  return session
}
export function validateMarks(value) {
  if (!Array.isArray(value) || value.length > 100) throw error('最多保存 100 条标注')
  const number = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1
  return value.map((mark, i) => {
    if (!mark || !['rect', 'ellipse', 'arrow', 'pen', 'point'].includes(mark.type) || typeof mark.note !== 'string' || mark.note.length > 2000 || !Array.isArray(mark.points) || !mark.points.length || mark.points.length > 3000 || mark.points.some(p => !p || !number(p.x) || !number(p.y))) throw error('标注位置或说明无效')
    if (['rect', 'ellipse', 'arrow'].includes(mark.type) && mark.points.length !== 2) throw error('标注形状无效')
    return { number: i + 1, type: mark.type, points: mark.points.map(p => ({ x: p.x, y: p.y })), note: mark.note }
  })
}
export function saveEditSession(paths, id, keyId, admin, changes) {
  const session = editSession(paths, id, keyId, admin)
  if (changes.revision !== session.revision) throw error('草稿已被其他窗口修改，请重新打开后继续', 409)
  for (const field of ['instruction', 'preserve']) if (typeof changes[field] !== 'string' || changes[field].length > 16000) throw error('修改说明最多 16000 字')
  const marks = validateMarks(changes.marks)
  let preview = null
  if (marks.length) {
    if (typeof changes.preview !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(changes.preview) || changes.preview.length > 7 * 1024 * 1024) throw error('标注预览必须是小于 5MB 的 PNG')
    preview = Buffer.from(changes.preview.split(',')[1], 'base64')
    const info = imageFileInfo(preview.toString('base64'))
    if (info.format !== 'png' || !info.width || !info.height || info.width > 2048 || info.height > 2048) throw error('标注预览尺寸超出范围')
  }
  const revision = session.revision + 1
  // A revision owns its preview. A failed draft write cannot change an earlier handoff.
  if (preview) fs.writeFileSync(path.join(directory(paths, id), `preview-${revision}.png`), preview, { mode: 0o600 })
  const updated = { ...session, revision, marks, instruction: changes.instruction.trim(), preserve: changes.preserve.trim(), updatedAt: Date.now(), hasPreview: !!preview }
  writeJsonAtomic(path.join(directory(paths, id), 'draft.json'), updated)
  if (session.hasPreview) { try { fs.unlinkSync(path.join(directory(paths, id), `preview-${session.revision}.png`)) } catch (e) { if (e.code !== 'ENOENT') console.warn('[asset-edits] 旧预览清理失败') } }
  return updated
}
export function editFile(paths, session, kind) {
  const filename = kind === 'original' ? 'original.' + session.format : kind === 'preview' && session.hasPreview ? `preview-${session.revision}.png` : null
  if (!filename) throw error('文件不存在', 404)
  return { bytes: fs.readFileSync(path.join(directory(paths, session.id), filename)), mime: kind === 'original' ? 'image/' + session.format : 'image/png', filename }
}
export function editInstructions(session) {
  return [session.instruction, ...session.marks.map(m => `标注 ${m.number}：${m.note || '请根据标注位置进行修改'}`), session.preserve ? '需要保留：' + session.preserve : '',
    session.marks.length ? '第二张图只用于解释标注位置；以第一张无标注原图为编辑底图，不要把编号、箭头、圈线画进结果。' : '',
    '生成一个新版本，保留未要求修改的内容。'].filter(Boolean).join('\n')
}
export function resolveEditRequest(paths, body, keyId) {
  const { cgw_edit: ignored, ...clean } = body
  body = clean
  if (!body.edit_session_id) return body
  if (body.image || body.mask || body.reference_images || body.reference_paths || body.outpaint) throw error('编辑任务不能与其他原图或蒙版同时使用')
  const session = editSession(paths, body.edit_session_id, keyId)
  if (body.edit_revision !== session.revision) throw error('编辑指令版本已变更，请从素材页重新复制指令', 409)
  if (!session.instruction && !session.marks.some(m => m.note)) throw error('请先填写修改要求')
  const original = editFile(paths, session, 'original')
  const preview = session.hasPreview ? editFile(paths, session, 'preview') : null
  const { edit_session_id, edit_revision, ...rest } = body
  return { ...rest, action: 'edit', image: preview ? [`data:${original.mime};base64,${original.bytes.toString('base64')}`, `data:${preview.mime};base64,${preview.bytes.toString('base64')}`] : `data:${original.mime};base64,${original.bytes.toString('base64')}`,
    prompt: [editInstructions(session), body.prompt && body.prompt !== '按保存的标注编辑' ? '补充要求：' + body.prompt : ''].filter(Boolean).join('\n'),
    cgw_edit: { sessionId: session.id, revision: session.revision, parentId: session.parentId, familyId: session.familyId, source: session.source, name: session.name } }
}
export function exportEditSession(paths, session) {
  const id = crypto.randomUUID(), dir = path.join(paths.cache, 'asset-exports', id)
  fs.mkdirSync(dir, { recursive: true })
  const files = []
  for (const kind of session.hasPreview ? ['original', 'preview'] : ['original']) {
    const file = editFile(paths, session, kind)
    fs.writeFileSync(path.join(dir, file.filename), file.bytes, { mode: 0o600 }); files.push(file.filename)
  }
  fs.writeFileSync(path.join(dir, 'instructions.txt'), editInstructions(session) + '\n\n请调用同一 Key 的网关 generate_image，参数：\n' + JSON.stringify({ prompt: '按保存的标注编辑', edit_session_id: session.id, edit_revision: session.revision }, null, 2), { mode: 0o600 }); files.push('instructions.txt')
  writeJsonAtomic(path.join(dir, 'manifest.json'), { files, createdAt: Date.now() })
  return { id, files }
}
