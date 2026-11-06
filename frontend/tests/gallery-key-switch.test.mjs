import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const html = fs.readFileSync(new URL('../../gateway/gallery.html', import.meta.url), 'utf8')
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
const OLD = 'cgw-old-key-000000', NEW = 'cgw-new-key-000000'
const STORE = 'cgw_gallery_key'
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(setImmediate) }

function page({ origin = 'http://192.0.2.7:4174', storedKey = OLD, meStatus = 200, withImage = false } = {}) {
  const nodes = new Map(), created = [], requests = [], docListeners = {}
  const store = new Map()
  if (storedKey) store.set(STORE, storedKey)
  const state = { meStatus, confirmCalls: 0 }
  const nativeConfirm = () => { state.confirmCalls++; return false } // 内嵌浏览器/沙箱 iframe：静默返回 false
  // 让桩读到 HTML 里静态的 hidden 属性，否则所有元素都会被当成初始可见。
  const initiallyHidden = id => {
    const tag = html.match(new RegExp('<[^>]*\\bid="' + id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"[^>]*>'))?.[0] || ''
    return /\shidden(?=[\s/>])/.test(tag)
  }
  const makeNode = id => ({
    id, textContent: '', innerHTML: '', value: '', hidden: initiallyHidden(id), disabled: false, open: false,
    style: { setProperty() {} }, children: [], listeners: {}, attrs: {}, focused: 0, selected: 0,
    setAttribute(n, v) { this.attrs[n] = v; this[n] = v },
    removeAttribute(n) { delete this.attrs[n] },
    replaceChildren() { this.children = [] },
    appendChild(c) { this.children.push(c); return c },
    removeChild() {},
    querySelector() { return makeNode('query-' + id) },
    scrollIntoView() {},
    addEventListener(name, fn) { this.listeners[name] = fn },
    click(e) { const ev = e || { target: this }; if (this.listeners.click) return this.listeners.click.call(this, ev); if (this.onclick) return this.onclick.call(this, ev) },
    focus() { this.focused++ }, select() { this.selected++ },
    close() { this.open = false }, showModal() { this.open = true },
    classList: { add() {}, remove() {} },
    contentWindow: {}
  })
  const node = id => { if (!nodes.has(id)) nodes.set(id, makeNode(id)); return nodes.get(id) }
  const document = {
    getElementById: node,
    createElement(tag) { const n = makeNode(tag + '-' + (created.length + 1)); created.push(n); return n },
    body: { appendChild(n) { created.push(n) }, removeChild() {} },
    documentElement: { style: { setProperty() {} } },
    execCommand() { return true },
    addEventListener(name, fn) { docListeners[name] = fn }
  }
  const localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k)
  }
  function fetchStub(url, options = {}) {
    const u = String(url); requests.push({ url: u, options })
    if (u.startsWith('/v1/gen-images/me')) {
      return state.meStatus === 200
        ? Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, keyName: '新成员', images: 0, bytes: 0 }) })
        : Promise.resolve({ ok: false, status: state.meStatus, json: async () => ({ ok: false }) })
    }
    if (u.startsWith('/v1/gen-images/list')) {
      const images = withImage ? [{ name: 'fixture.png', title: 'fixture', download_url: origin + '/v1/gen-images/fixture.png', size: 2048, mtime: Date.now(), favorite: false }] : []
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, total: images.length, images }) })
    }
    if (String(options.method) === 'DELETE') return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) })
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) })
  }
  const context = vm.createContext({
    document, localStorage, URL, URLSearchParams, AbortController, AbortSignal, Promise, console,
    location: new URL(origin + '/gallery'),
    window: { isSecureContext: true, addEventListener() {}, confirm: nativeConfirm },
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    confirm: nativeConfirm,
    setTimeout: () => 1, clearTimeout() {}, fetch: fetchStub
  })
  vm.runInContext(script, context)
  return {
    node, store, state, requests, created, docListeners,
    switchKey() { node('btnKey').click() },
    save(value) { node('keyInput').value = value; node('btnSave').click() }
  }
}

test('内嵌浏览器吞掉原生 confirm 时，换 Key 点击仍立即给出可输入界面', async () => {
  const p = page()
  await settle()
  assert.equal(p.node('gate').hidden, true, '旧 Key 已登录，应直接显示图库')
  p.switchKey()
  assert.equal(p.state.confirmCalls, 0, '换 Key 不得再依赖原生 confirm')
  assert.equal(p.node('gate').hidden, false, '点击后必须出现可输入界面')
  assert.equal(p.node('app').hidden, true)
  assert.equal(p.node('gateTitle').textContent, '更换 API Key')
  assert.equal(p.node('gateDescSwitch').hidden, false)
  assert.equal(p.node('gateDescLogin').hidden, true)
  assert.equal(p.node('btnSave').textContent, '验证并更换')
  assert.equal(p.node('btnCancelSwitch').hidden, false)
  assert.ok(p.node('keyInput').focused > 0, '输入框应立即获得焦点')
  assert.match(p.node('toast').textContent, /已暂停当前身份/)
  assert.equal(p.store.get(STORE), OLD, '切换完成前不得清除旧 Key')
})

test('新 Key 先只读验证：失败不落盘，成功才写入并切换', async () => {
  const p = page()
  await settle()
  p.switchKey()
  p.state.meStatus = 401
  p.save(NEW)
  await settle()
  assert.match(p.node('gateErr').textContent, /Key 无效或已被禁用/)
  assert.equal(p.store.get(STORE), OLD, '验证失败不得覆盖已保存的 Key')
  assert.equal(p.node('gate').hidden, false, '验证失败应停留在换 Key 界面')
  assert.equal(p.node('btnSave').disabled, false)

  p.state.meStatus = 200
  p.save(NEW)
  await settle()
  assert.equal(p.store.get(STORE), NEW)
  assert.equal(p.node('gate').hidden, true)
  assert.match(p.node('toast').textContent, /已切换到 新成员/)
  const verify = p.requests.filter(r => r.url === '/v1/gen-images/me' && r.options.headers?.Authorization === 'Bearer ' + NEW)
  assert.ok(verify.length >= 1, '应携带新 Key 做身份校验')
  assert.ok(verify.every(r => !r.options.method), '身份校验必须是 GET')
  assert.equal(p.requests.some(r => r.options.method === 'DELETE'), false, '换 Key 不得删除任何素材')
})

test('取消换 Key 恢复原身份，旧 Key 全程保留', async () => {
  const p = page()
  await settle()
  p.switchKey()
  p.node('btnCancelSwitch').click()
  await settle()
  assert.equal(p.store.get(STORE), OLD)
  assert.equal(p.node('gate').hidden, true)
  assert.equal(p.node('btnCancelSwitch').hidden, true)
  assert.match(p.node('toast').textContent, /已恢复原 Key/)
})

test('未登录时点击换 Key 也有可见反馈，且不显示取消按钮', async () => {
  const p = page({ storedKey: null })
  await settle()
  assert.equal(p.node('gate').hidden, false, '未登录本来就在门禁页')
  p.switchKey()
  assert.equal(p.node('gateTitle').textContent, '更换 API Key')
  assert.equal(p.node('btnCancelSwitch').hidden, true, '没有旧身份可恢复')
  assert.match(p.node('toast').textContent, /当前未登录/)
  p.save(NEW)
  await settle()
  assert.equal(p.store.get(STORE), NEW)
  assert.equal(p.node('gate').hidden, true)
})

test('换 Key 成功后清空旧 Key 的搜索与收藏筛选', async () => {
  const p = page()
  await settle()
  p.node('search').value = '旧图'
  p.node('favorites').click()
  p.switchKey()
  p.save(NEW)
  await settle()
  assert.equal(p.store.get(STORE), NEW)
  assert.equal(p.node('search').value, '')
  assert.equal(p.node('favorites').attrs['aria-pressed'], 'false')
  assert.equal(p.node('favorites').textContent, '☆ 只看收藏')
})

test('删除确认改用页面内浮层，取消不发请求、确定才删除', async () => {
  const p = page({ withImage: true })
  await settle()
  assert.doesNotMatch(script, /(?<![.\w])confirm\s*\(/, '素材站不得调用原生 confirm')
  assert.match(script, /askConfirm\(/)
  assert.match(html, /id="confirmLayer"/)
  assert.match(html, /id="confirmYes"/)
  assert.match(html, /id="confirmNo"/)
  const del = p.created.find(n => n.textContent === '删除')
  assert.ok(del, '应能从卡片里构造出删除按钮')
  assert.equal(p.node('confirmLayer').hidden, true)

  del.click()
  assert.equal(p.node('confirmLayer').hidden, false, '确认浮层必须可见')
  assert.match(p.node('confirmText').textContent, /移入回收站/)
  assert.equal(p.state.confirmCalls, 0)
  p.node('confirmNo').click()
  await settle()
  assert.equal(p.requests.some(r => r.options.method === 'DELETE'), false, '取消不得删除')

  del.click()
  p.node('confirmYes').click()
  await settle()
  assert.equal(p.node('confirmLayer').hidden, true)
  assert.ok(p.requests.some(r => r.options.method === 'DELETE'), '确定后才发删除请求')
})
