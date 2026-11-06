'use strict'
const $ = id => document.getElementById(id)
const gallery = new URL(location.href).searchParams.get('surface') === 'gallery'
const endpoint = gallery ? '/v1/gen-images/library' : '/__gw/assets/library'
let trash = false, favorite = false, page = 1, pages = 1, images = [], selected = new Map(), generation = 0, urls = [], requests = new AbortController(), timer, observer, lastIndex = -1, busy = false, pair = [], pairGeneration = 0
const headers = () => {
  const value = { 'Content-Type': 'application/json' }
  if (gallery) { const key = localStorage.getItem('cgw_gallery_key'); if (!key) throw new Error('请先返回素材站输入 Key'); value.Authorization = 'Bearer ' + key }
  return value
}
function error(e) { $('error').hidden = false; $('error').textContent = e.message || String(e) }
// 内嵌浏览器 / 沙箱 iframe 会静默吞掉原生 confirm（一律返回 false），
// 表现为「按钮点了没反应」。破坏性操作统一改用页面内浮层确认。
let confirmResolve = null
function askConfirm(text) {
  return new Promise(resolve => {
    if (confirmResolve) confirmResolve(false)
    confirmResolve = resolve
    $('confirmText').textContent = text
    $('confirmLayer').hidden = false
    try { $('confirmYes').focus() } catch {}
  })
}
function closeConfirm(answer) {
  $('confirmLayer').hidden = true
  const resolve = confirmResolve; confirmResolve = null
  if (resolve) resolve(answer)
}
$('confirmYes').onclick = () => closeConfirm(true)
$('confirmNo').onclick = () => closeConfirm(false)
$('confirmLayer').addEventListener('click', event => { if (event.target === $('confirmLayer')) closeConfirm(false) })
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('confirmLayer').hidden) closeConfirm(false) })
async function api(body, query = '', base = endpoint) {
  const r = await fetch(base + query, { method: body ? 'POST' : 'GET', headers: headers(), ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) })
  const data = await r.json(); if (!r.ok) throw new Error(data.detail || data.error || '请求失败'); return data
}
function options(select, values, first) {
  const value = select.value; select.replaceChildren(new Option(first, ''))
  for (const item of values) select.add(new Option(typeof item === 'string' ? item : item.name, typeof item === 'string' ? item : item.id))
  select.value = [...select.options].some(option => option.value === value) ? value : ''
}
function itemKey(image) { return trash ? image.trashId : image.id }
function selection() {
  $('selection').textContent = selected.size ? `已选 ${selected.size} 项（最多 200）` : '未选择 · 支持 Shift 连选'
  for (const id of ['organize', 'trash', 'restore', 'purge']) $(id).disabled = busy || !selected.size
  $('compare').disabled = busy || selected.size !== 2
  for (const card of $('grid').children) { const checked = selected.has(card.dataset.key); card.classList.toggle('selected', checked); card.querySelector('input').checked = checked }
}
function toggle(image, checked) {
  const key = itemKey(image)
  if (checked && !selected.has(key) && selected.size >= 200) throw new Error('每次最多选择 200 项，请先处理当前选择')
  checked ? selected.set(key, image) : selected.delete(key)
}
function fileUrl(image) {
  if (image.trashId) return endpoint + '?' + new URLSearchParams({ trashFile: image.trashId })
  if (gallery) return '/v1/gen-images/' + encodeURIComponent(image.name)
  return image.remote ? image.url : '/__gw/assets/file?' + new URLSearchParams({ src: image.sourceId, n: image.name })
}
async function blobUrl(image, signal = requests.signal) {
  const url = new URL(fileUrl(image), location.href)
  if (gallery && url.origin !== location.origin) throw new Error('图片地址不属于当前素材站')
  const r = await fetch(url, { headers: url.origin === location.origin ? headers() : undefined, signal })
  if (!r.ok) throw new Error('图片读取失败：HTTP ' + r.status)
  return URL.createObjectURL(await r.blob())
}
function button(text, handler, className = '') { const b = document.createElement('button'); b.textContent = text; b.className = className; b.onclick = handler; return b }
function openOrganize(items) {
  selected = new Map(items.map(image => [image.id, image])); selection()
  $('organizerForm').reset(); $('organizerTitle').textContent = `整理 ${items.length} 张素材`
  $('notesField').hidden = items.length !== 1; $('notes').value = items.length === 1 ? items[0].notes || '' : ''
  $('organizer').showModal()
}
async function load() {
  clearTimeout(timer); const current = ++generation; requests.abort(); requests = new AbortController(); observer?.disconnect()
  $('error').hidden = true; $('count').textContent = '载入中…'; $('empty').hidden = true
  urls.forEach(url => URL.revokeObjectURL(url)); urls = []; $('grid').replaceChildren()
  const query = '?' + new URLSearchParams({ trash, source: $('source').value, q: $('q').value, tag: $('tag').value, collection: $('collection').value, favorite, sort: $('sort').value, offset: (page - 1) * 24, limit: 24 })
  try {
    const data = await api(null, query)
    if (current !== generation) return
    pages = Math.max(1, Math.ceil(data.total / 24)); if (page > pages) { page = pages; return load() }
    options($('source'), data.sources, '全部来源'); options($('collection'), data.facets.collections, '全部集合'); options($('tag'), data.facets.tags, '全部标签')
    for (const [id, values] of [['tagSuggestions', data.facets.tags], ['collectionSuggestions', data.facets.collections]]) $(id).replaceChildren(...values.map(v => new Option(v, v)))
    urls.forEach(url => URL.revokeObjectURL(url)); urls = []
    images = data.images; $('grid').replaceChildren(); lastIndex = -1
    $('count').textContent = `共 ${data.total} 项`; $('empty').hidden = !!images.length
    $('pager').hidden = pages <= 1; $('pageInfo').textContent = `${page} / ${pages}`; $('page').value = page; $('page').max = pages; $('prev').disabled = page === 1; $('next').disabled = page === pages
    observer = new IntersectionObserver(entries => { for (const entry of entries) if (entry.isIntersecting) { observer.unobserve(entry.target); entry.target.load() } }, { rootMargin: '150px' })
    images.forEach((image, index) => {
      const card = document.createElement('article'); card.className = 'card'; card.dataset.key = itemKey(image)
      const thumb = document.createElement('div'); thumb.className = 'thumb'
      const img = document.createElement('img'); img.alt = image.title || image.name
      const check = document.createElement('input'); check.type = 'checkbox'; check.setAttribute('aria-label', '选择 ' + (image.title || image.name)); check.checked = selected.has(itemKey(image))
      check.onclick = event => { try { if (event.shiftKey && lastIndex >= 0) for (let n = Math.min(lastIndex, index); n <= Math.max(lastIndex, index); n++) toggle(images[n], check.checked); else toggle(image, check.checked); lastIndex = index } catch (e) { error(e) } selection() }
      thumb.append(img, check)
      thumb.load = async () => { try { const local = await blobUrl(image); if (current !== generation) { URL.revokeObjectURL(local); return } urls.push(local); img.src = local } catch (e) { if (current === generation) img.alt = e.message } }
      const info = document.createElement('div'); info.className = 'card-info'
      const title = document.createElement('div'); title.className = 'title'; title.textContent = (image.favorite ? '★ ' : '') + (image.title || image.name)
      const sub = document.createElement('div'); sub.className = 'sub'; sub.textContent = (data.sources.find(s => s.id === image.sourceId)?.name || '已移除来源') + (image.deletedAt ? ' · 回收于 ' + new Date(image.deletedAt).toLocaleString() : image.parentId ? ' · 新版本' : '')
      const chips = document.createElement('div'); chips.className = 'chips'
      for (const value of [...(image.collections || []).map(v => '▣ ' + v), ...(image.tags || []).map(v => '# ' + v)]) { const span = document.createElement('span'); span.className = 'chip'; span.textContent = value; chips.append(span) }
      const notes = document.createElement('div'); notes.className = 'sub notes'; notes.textContent = image.notes || ''; notes.title = image.notes || ''
      const actions = document.createElement('div'); actions.className = 'card-actions'
      if (trash) actions.append(button('恢复', () => mutate('restore', [image])), button('彻底删除', () => mutate('purge', [image]), 'danger'))
      else actions.append(button('整理', () => openOrganize([image])), button('版本对比', () => compareVersions(image)))
      info.append(title, sub, chips, notes, actions); card.append(thumb, info); $('grid').append(card); observer.observe(thumb)
    })
    selection()
  } catch (e) { if (current === generation) { $('count').textContent = '加载失败'; error(e) } }
}
async function mutate(action, items = [...selected.values()], operations) {
  if (busy || !items.length) return
  if (action === 'trash' && !(await askConfirm(`将 ${items.length} 张素材移入回收站？可以恢复，编辑草稿和其他版本仍保留。`))) return
  if (action === 'purge' && !(await askConfirm(`彻底删除所选 ${items.length} 张回收文件？此操作无法撤销；已有草稿和其他副本仍保留。`))) return
  // 浮层等待期间可能有其他操作抢占，重新检查后再落盘。
  if (busy || !items.length) return
  busy = true; selection(); $('saveOrganize').disabled = true
  try {
    const body = ['restore', 'purge'].includes(action) ? { action, ids: items.map(i => i.trashId) } : { action, items: items.map(i => ({ id: i.id, sourceId: i.sourceId, name: i.name })), ...(operations ? { operations } : {}) }
    const data = await api(body), failed = data.results?.filter(r => !r.ok) || []
    $('message').textContent = failed.length ? `完成 ${data.results.length - failed.length} 项，失败 ${failed.length} 项` : `已完成 ${data.updated || items.length} 项`
    selected.clear(); if (failed.length) for (const item of items) if (failed.some(r => r.id === item.id || r.id === item.trashId)) selected.set(itemKey(item), item)
    if ($('organizer').open) $('organizer').close()
    await load(); if (failed.length) error(new Error(failed.map(f => f.error).join('；')))
  } catch (e) { error(e) } finally { busy = false; selection(); $('saveOrganize').disabled = false }
}
const labels = value => [...new Set(value.split(/[,，\n]/).map(v => v.trim()).filter(Boolean))]
$('organizerForm').onsubmit = event => {
  event.preventDefault(); const operations = {}
  for (const id of ['addTags', 'removeTags', 'addCollections', 'removeCollections']) if ($(id).value.trim()) operations[id] = labels($(id).value)
  if ($('favoriteChange').value) operations.favorite = $('favoriteChange').value === 'true'
  if (selected.size === 1 && $('notes').value !== ([...selected.values()][0].notes || '')) operations.notes = $('notes').value
  mutate('organize', [...selected.values()], operations)
}
$('cancelOrganize').onclick = () => $('organizer').close()
$('organize').onclick = () => openOrganize([...selected.values()])
for (const action of ['trash', 'restore', 'purge']) $(action).onclick = () => mutate(action)
$('selectPage').onclick = () => { try { images.forEach(image => toggle(image, true)) } catch (e) { error(e) } selection() }
$('clearSelection').onclick = () => { selected.clear(); selection() }
function changeView(value) {
  closeConfirm(false)
  trash = value; selected.clear(); page = 1
  for (const id of ['q', 'tag', 'collection']) $(id).value = ''
  $('libraryTab').setAttribute('aria-pressed', String(!trash)); $('trashTab').setAttribute('aria-pressed', String(trash))
  for (const id of ['organize', 'trash']) $(id).hidden = trash
  for (const id of ['restore', 'purge']) $(id).hidden = !trash
  load()
}
$('libraryTab').onclick = () => changeView(false); $('trashTab').onclick = () => changeView(true)
for (const id of ['source', 'tag', 'collection', 'sort']) $(id).onchange = () => { page = 1; selected.clear(); load() }
$('q').oninput = () => { clearTimeout(timer); page = 1; selected.clear(); timer = setTimeout(load, 250) }
$('favorite').onclick = () => { favorite = !favorite; $('favorite').setAttribute('aria-pressed', String(favorite)); page = 1; selected.clear(); load() }
$('refresh').onclick = load; $('prev').onclick = () => { if (page > 1) { page--; load() } }; $('next').onclick = () => { if (page < pages) { page++; load() } }
function go() { page = Math.max(1, Math.min(pages, Math.floor(Number($('page').value)) || 1)); load() }
$('go').onclick = go; $('page').onkeydown = e => { if (e.key === 'Enter') go() }
$('size').oninput = () => { document.documentElement.style.setProperty('--size', $('size').value + 'px'); try { localStorage.setItem('cgw_library_size', $('size').value) } catch {} }
try { $('size').value = Math.max(160, Math.min(360, Number(localStorage.getItem('cgw_library_size')) || 220)); $('size').oninput() } catch {}
let compareUrls = []
async function comparePair(items, keepPicker = false) {
  const current = ++pairGeneration; pair = items
  if (!keepPicker) $('pairPicker').hidden = true
  if (!$('comparison').open) $('comparison').showModal()
  $('compareHint').textContent = '图片载入中…'
  try {
    const results = await Promise.allSettled(items.map(image => blobUrl(image, AbortSignal.timeout(20000))))
    if (results.some(r => r.status === 'rejected')) { for (const r of results) if (r.status === 'fulfilled') URL.revokeObjectURL(r.value); throw results.find(r => r.status === 'rejected').reason }
    const local = results.map(r => r.value)
    if (current !== pairGeneration) { local.forEach(u => URL.revokeObjectURL(u)); return }
    compareUrls.forEach(u => URL.revokeObjectURL(u)); compareUrls = local
    $('leftImage').src = $('wipeLeft').src = local[0]; $('rightImage').src = $('wipeRight').src = local[1]
    $('leftCaption').textContent = items[0].title || items[0].name; $('rightCaption').textContent = items[1].title || items[1].name
    $('compareHint').textContent = '完整显示原图；不同尺寸采用同一容器适配，滑动叠加用于观察构图，不代表像素级差异。'
  } catch (e) { if (current === pairGeneration) { $('compareHint').textContent = '对比加载失败：' + e.message } }
}
async function compareVersions(image) {
  try {
    const base = gallery ? '/v1/gen-images/edit-sessions' : '/__gw/assets/edit-sessions'
    const data = await api(null, '?' + new URLSearchParams({ versions: 'true', src: image.sourceId, name: image.name }), base)
    const others = data.images.filter(i => i.id !== image.id).map(i => ({ ...i, sourceId: i.source }))
    if (!others.length) throw new Error('还没有关联版本。也可以勾选任意两张素材进行对比。')
    $('versionChoice').replaceChildren(...others.map((v, i) => new Option(v.title || v.name, String(i))))
    $('pairPicker').hidden = false
    $('compareVersion').onclick = () => comparePair([image, others[Number($('versionChoice').value)]], true)
    await comparePair([image, others[0]], true)
  } catch (e) { error(e) }
}
$('compare').onclick = () => comparePair([...selected.values()])
$('swap').onclick = () => { if (pair.length === 2) comparePair([pair[1], pair[0]], !$('pairPicker').hidden) }
function mode(wipe) { $('sideStage').hidden = wipe; $('wipeStage').hidden = !wipe; $('wipeControl').hidden = !wipe; $('sideMode').setAttribute('aria-pressed', String(!wipe)); $('wipeMode').setAttribute('aria-pressed', String(wipe)) }
$('sideMode').onclick = () => mode(false); $('wipeMode').onclick = () => mode(true)
$('wipePosition').oninput = () => { $('wipeOverlay').style.clipPath = `inset(0 ${100 - Number($('wipePosition').value)}% 0 0)` }
$('closeCompare').onclick = () => $('comparison').close()
$('comparison').addEventListener('close', () => { pairGeneration++; compareUrls.forEach(u => URL.revokeObjectURL(u)); compareUrls = []; for (const id of ['leftImage', 'rightImage', 'wipeLeft', 'wipeRight']) $(id).removeAttribute('src') })
$('back').onclick = () => { if (window.parent !== window) window.parent.postMessage({ type: 'cgw:editor-close' }, location.origin); else location.href = gallery ? '/gallery' : '/' }
window.addEventListener('message', e => { if (e.origin === location.origin && e.source === window.parent && e.data?.type === 'cgw:editor-request-close') { if ($('organizer').open || $('comparison').open || !$('confirmLayer').hidden) return; $('back').click() } })
load()

window.addEventListener('storage', e => { if (gallery && e.key === 'cgw_gallery_key') { selected.clear(); $('organizer').close(); $('comparison').close(); load() } })
