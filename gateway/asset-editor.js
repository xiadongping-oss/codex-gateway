/* Shared editor for the authenticated desktop workspace and per-Key gallery. */
'use strict'
const $ = id => document.getElementById(id)
const params = new URL(location.href).searchParams
const gallery = params.get('surface') === 'gallery'
const source = gallery ? 'generated' : params.get('src') || 'generated'
const name = params.get('name') || ''
const endpoint = gallery ? '/v1/gen-images/edit-sessions' : '/__gw/assets/edit-sessions'
let session, image, tool = 'rect', activeMark = null, redo = [], dirty = false, change = 0, saving = null, timer, exportId, booted = false
let imageUrl = null
const canvas = $('canvas'), ctx = canvas.getContext('2d')
const headers = () => {
  if (!gallery) return { 'Content-Type': 'application/json' }
  let key = ''
  try { key = localStorage.getItem('cgw_gallery_key') || '' } catch {}
  if (!key) throw new Error('请先返回素材站输入与 WorkBuddy 相同的 Key')
  return { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }
}
function fail(e) { $('error').hidden = false; $('error').textContent = e.message || String(e) }
async function request(body, query = '') {
  const r = await fetch(endpoint + query, { method: body ? 'POST' : 'GET', headers: headers(), ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) })
  const data = await r.json()
  if (!r.ok) throw new Error(data.detail || data.error || '请求失败')
  return data
}
function edited() {
  dirty = true; change++; exportId = null; $('drag').hidden = true; $('handoffPanel').hidden = true
  $('saveStatus').textContent = '有未保存的修改'
  clearTimeout(timer); timer = setTimeout(() => saveDraft().catch(fail), 700)
}
function renderMark(context, mark, width, height) {
  const points = mark.points.map(p => ({ x: p.x * width, y: p.y * height }))
  const a = points[0], b = points.at(-1)
  context.strokeStyle = '#f14455'; context.fillStyle = '#f14455'; context.lineWidth = Math.max(2, width / 350); context.lineCap = 'round'
  context.beginPath()
  if (mark.type === 'rect') context.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y))
  if (mark.type === 'ellipse') context.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.max(1, Math.abs(a.x - b.x) / 2), Math.max(1, Math.abs(a.y - b.y) / 2), 0, 0, Math.PI * 2)
  if (mark.type === 'pen' || mark.type === 'arrow') {
    context.moveTo(a.x, a.y); for (const p of points.slice(1)) context.lineTo(p.x, p.y)
    if (mark.type === 'arrow') {
      const angle = Math.atan2(b.y - a.y, b.x - a.x), length = Math.max(12, width / 45)
      context.moveTo(b.x - length * Math.cos(angle - .45), b.y - length * Math.sin(angle - .45)); context.lineTo(b.x, b.y); context.lineTo(b.x - length * Math.cos(angle + .45), b.y - length * Math.sin(angle + .45))
    }
  }
  context.stroke()
  const radius = Math.max(12, width / 55), x = Math.max(radius, Math.min(width - radius, a.x)), y = Math.max(radius, Math.min(height - radius, a.y))
  context.beginPath(); context.arc(x, y, radius, 0, Math.PI * 2); context.fill()
  context.fillStyle = '#fff'; context.font = `bold ${Math.max(13, radius)}px sans-serif`; context.textAlign = 'center'; context.textBaseline = 'middle'; context.fillText(String(mark.number), x, y)
}
function paint(context = ctx, width = canvas.width, height = canvas.height, showMarks = !$('compare').checked, includeActive = true) {
  if (!image) return
  context.clearRect(0, 0, width, height); context.drawImage(image, 0, 0, width, height)
  if (showMarks) for (const mark of [...session.marks, ...(includeActive && activeMark ? [activeMark] : [])]) renderMark(context, mark, width, height)
}
function preview() { paint(ctx, canvas.width, canvas.height, true, false); const result = canvas.toDataURL('image/png'); paint(); return result }
function markFields() {
  $('marks').replaceChildren()
  if (!session.marks.length) { const p = document.createElement('p'); p.className = 'hint'; p.textContent = '还没有标注，也可以仅填写整体要求。'; $('marks').append(p) }
  session.marks.forEach((mark, index) => {
    mark.number = index + 1
    const div = document.createElement('div'); div.className = 'mark'
    const head = document.createElement('div'); head.className = 'mark-head'
    const label = document.createElement('label'); label.textContent = `标注 ${mark.number}`; label.htmlFor = `note-${index}`
    const remove = document.createElement('button'); remove.textContent = '删除'; remove.setAttribute('aria-label', `删除标注 ${mark.number}`)
    remove.onclick = () => { session.marks.splice(index, 1); redo = []; markFields(); paint(); edited() }
    head.append(label, remove)
    const input = document.createElement('textarea'); input.id = `note-${index}`; input.maxLength = 2000; input.placeholder = '描述这个位置要修改什么'; input.value = mark.note
    input.oninput = () => { mark.note = input.value; edited() }
    div.append(head, input); $('marks').append(div)
  })
  $('undo').disabled = !session.marks.length; $('redo').disabled = !redo.length
}
function point(e) { const rect = canvas.getBoundingClientRect(); return { x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)) } }
canvas.onpointerdown = e => {
  if (!session || e.button !== 0 || $('compare').checked || session.marks.length >= 100) return
  e.preventDefault(); canvas.setPointerCapture(e.pointerId)
  const p = point(e); activeMark = { number: session.marks.length + 1, type: tool, note: '', points: tool === 'point' ? [p] : [p, p] }; paint()
}
canvas.onpointermove = e => {
  if (!activeMark) return
  if (tool === 'pen') { if (activeMark.points.length < 3000) activeMark.points.push(point(e)) }
  else if (tool !== 'point') activeMark.points[1] = point(e)
  paint()
}
canvas.onpointerup = () => { if (!activeMark) return; session.marks.push(activeMark); activeMark = null; redo = []; markFields(); paint(); edited(); $('marks').lastElementChild?.querySelector('textarea')?.focus() }
canvas.onpointercancel = () => { activeMark = null; paint() }
for (const button of document.querySelectorAll('[data-tool]')) button.onclick = () => { tool = button.dataset.tool; for (const b of document.querySelectorAll('[data-tool]')) b.setAttribute('aria-pressed', String(b === button)) }
$('undo').onclick = () => { if (session.marks.length) { redo.push(session.marks.pop()); markFields(); paint(); edited() } }
$('redo').onclick = () => { if (redo.length) { session.marks.push(redo.pop()); markFields(); paint(); edited() } }
$('compare').onchange = () => paint()
function zoom() { if (image) canvas.style.width = `${Math.max(1, $('stage').clientWidth - 34) * Number($('zoom').value) / 100}px` }
$('zoom').oninput = zoom; window.addEventListener('resize', zoom)
for (const id of ['instruction', 'preserve']) $(id).oninput = edited
async function saveDraft() {
  clearTimeout(timer)
  if (saving) { await saving; return dirty ? saveDraft() : session }
  if (!dirty) return session
  const current = change
  const body = { id: session.id, revision: session.revision, marks: structuredClone(session.marks), instruction: $('instruction').value, preserve: $('preserve').value, ...(session.marks.length ? { preview: preview() } : {}) }
  $('saveStatus').textContent = '保存中…'
  saving = request(body).then(data => {
    // Keep newer in-memory edits; only advance the revision acknowledged by the server.
    session.revision = data.session.revision; session.hasPreview = data.session.hasPreview
    session.instruction = data.session.instruction; session.preserve = data.session.preserve
    dirty = current !== change; $('saveStatus').textContent = dirty ? '有未保存的修改' : '草稿已保存'
    $('error').hidden = true
  }).catch(e => { $('saveStatus').textContent = '保存失败'; throw e }).finally(() => { saving = null })
  await saving
  return dirty ? saveDraft() : session
}
$('save').onclick = () => saveDraft().catch(fail)
async function versions() {
  try {
    const data = await request(null, '?' + new URLSearchParams({ versions: 'true', src: source, name }))
    $('versions').replaceChildren()
    for (const version of data.images) {
      const a = document.createElement('a'); a.textContent = (version.parentId ? '↳ ' : '原图 · ') + version.title
      a.href = '/asset-editor?' + new URLSearchParams({ surface: gallery ? 'gallery' : 'workspace', src: version.source, name: version.name }); a.onclick = async e => { e.preventDefault(); try { await saveDraft(); location.href = a.href } catch (error) { fail(error) } }; $('versions').append(a)
    }
    if (!data.images.length) $('versions').textContent = '暂无关联版本'
  } catch (e) { $('versions').textContent = '版本记录加载失败：' + e.message }
}
$('refreshVersions').onclick = versions
async function start(keyId) {
  $('create').disabled = true
  try {
    session = (await request({ src: source, name, ...(keyId ? { keyId } : {}) })).session
    const r = await fetch(endpoint + '?' + new URLSearchParams({ id: session.id, file: 'original' }), { headers: headers(), signal: AbortSignal.timeout(20000) })
    if (!r.ok) throw new Error('原图读取失败')
    imageUrl = URL.createObjectURL(await r.blob()); image = new Image()
    await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error('图片解码失败')); image.src = imageUrl })
    const scale = Math.min(1, 2048 / Math.max(image.naturalWidth, image.naturalHeight))
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
    $('instruction').value = session.instruction; $('preserve').value = session.preserve
    $('imageTitle').textContent = session.title + ` · ${session.width}×${session.height}`
    $('editor').hidden = false; $('identity').hidden = true; $('saveStatus').textContent = '草稿已载入'; $('error').hidden = true
    markFields(); zoom(); paint(); versions(); booted = true
  } catch (e) { fail(e) } finally { $('create').disabled = false }
}
async function copyText(text) {
  if (navigator.clipboard?.writeText && window.isSecureContext) return navigator.clipboard.writeText(text)
  const input = document.createElement('textarea'); input.value = text; document.body.append(input); input.select()
  const ok = document.execCommand('copy'); input.remove(); if (!ok) throw new Error('请手动选择并复制指令')
}
$('handoff').onclick = async () => {
  try {
    await saveDraft()
    if (!session.keyId) throw new Error('此草稿尚未关联 WorkBuddy Key，请返回后选择相同 Key 再打开')
    if (!$('instruction').value.trim() && !session.marks.some(mark => mark.note.trim())) throw new Error('请先填写整体修改要求或编号标注说明')
    const args = { prompt: '按保存的标注编辑', edit_session_id: session.id, edit_revision: session.revision }
    $('handoffText').value = `请使用已配置的 GPT 图片生成网关调用 generate_image 编辑原图，参数为：\n${JSON.stringify(args, null, 2)}\n请使用素材页相同的 MCP Key。网关会自动读取原图和已保存的标注说明。请检查返回结果，并打开返回的素材页查看新版本。`
    $('handoffPanel').hidden = false; $('handoffStatus').textContent = '指令已准备，尚未发送到 WorkBuddy。'; $('handoffPanel').scrollIntoView({ block: 'nearest' })
  } catch (e) { fail(e) }
}
$('copyHandoff').onclick = () => copyText($('handoffText').value).then(() => { $('handoffStatus').textContent = '已复制，请粘贴到 WorkBuddy 当前输入框后发送。' }).catch(fail)
function pngBlob(marked) {
  const copy = document.createElement('canvas'); copy.width = marked ? canvas.width : image.naturalWidth; copy.height = marked ? canvas.height : image.naturalHeight
  paint(copy.getContext('2d'), copy.width, copy.height, marked)
  return new Promise((resolve, reject) => copy.toBlob(blob => { copy.width = copy.height = 0; blob ? resolve(blob) : reject(new Error('图片转换失败')) }, 'image/png'))
}
function copyImage(marked) {
  if (!window.isSecureContext || !navigator.clipboard?.write || typeof ClipboardItem === 'undefined') return fail(new Error('当前环境不支持图片复制，请下载图片后拖入 WorkBuddy'))
  const png = pngBlob(marked); png.catch(() => {})
  try { navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]).then(() => { $('saveStatus').textContent = '已复制图片，请在 WorkBuddy 输入框粘贴' }).catch(fail) } catch (e) { fail(e) }
}
$('copyOriginal').onclick = () => copyImage(false); $('copyPreview').onclick = () => copyImage(true)
function download(blob, filename) { const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 30000) }
$('downloadOriginal').onclick = () => fetch(imageUrl).then(r => r.blob()).then(blob => download(blob, 'original.' + session.format)).catch(fail)
$('downloadPreview').onclick = () => pngBlob(true).then(blob => download(blob, 'annotated.png')).catch(fail)
$('prepareDrag').onclick = async () => {
  try {
    await saveDraft()
    if (!window.__cgwNativeAssetDrag && !window.top.__cgwNativeAssetDrag) throw new Error('当前浏览器无法拖出系统文件。请下载原图与标注图，再拖入 WorkBuddy；也可复制图片或编辑指令。')
    exportId = (await request({ id: session.id, action: 'export' })).export.id
    $('drag').hidden = false; $('drag').scrollIntoView({ block: 'nearest' })
  } catch (e) { fail(e) }
}
$('drag').ondragstart = e => {
  e.preventDefault()
  if (!exportId) return
  const root = window.top || window
  root.location.href = `cgw-workspace://asset-drag/${exportId}`
}
window.addEventListener('cgw:asset-drag-result', e => { $('saveStatus').textContent = e.detail === 'dropped' ? '文件已交给目标窗口，请检查 WorkBuddy 附件' : e.detail === 'cancelled' ? '拖拽已取消' : '拖拽失败，请下载图片后添加' })
async function close() {
  try { if (session) await saveDraft() } catch (e) { fail(e); return }
  if (window.parent !== window) window.parent.postMessage({ type: 'cgw:editor-close' }, location.origin)
  else location.href = gallery ? '/gallery' : '/'
}
$('close').onclick = close
window.addEventListener('message', event => { if (event.origin === location.origin && event.source === window.parent && event.data?.type === 'cgw:editor-request-close') close() })
window.addEventListener('beforeunload', e => { if (dirty || saving) { e.preventDefault(); e.returnValue = '' } })
document.addEventListener('keydown', e => {
  if (/^(TEXTAREA|INPUT|SELECT)$/.test(e.target.tagName)) return
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? $('redo').click() : $('undo').click() }
  if (e.key === 'Escape' && !dirty) close()
})
async function init() {
  if (!name) throw new Error('缺少素材，请从素材卡片打开编辑器')
  if (gallery) return start()
  // Choosing the existing MCP identity also supports local-directory source images.
  const r = await fetch('/__gw/apikeys', { signal: AbortSignal.timeout(15000) })
  const data = await r.json(); if (!r.ok) throw new Error('控制台会话已失效，请重新打开')
  const keys = (data.keys || []).filter(key => !key.disabled)
  const none = document.createElement('option'); none.value = ''; none.textContent = source === 'generated' ? '使用图片原有 Key（无归属图片仅标注）' : '仅标注，不关联 WorkBuddy'; $('keyChoice').append(none)
  for (const key of keys) { const option = document.createElement('option'); option.value = key.id; option.textContent = key.name || key.id; $('keyChoice').append(option) }
  if (keys.length === 1) $('keyChoice').value = keys[0].id
  $('identity').hidden = false; $('imageTitle').textContent = name
}
$('create').onclick = () => { if (!booted) start($('keyChoice').value) }
init().catch(fail)
