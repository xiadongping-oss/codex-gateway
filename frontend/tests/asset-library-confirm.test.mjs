import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const ROOT = new URL('../../gateway/', import.meta.url)
const js = fs.readFileSync(new URL('asset-library.js', ROOT), 'utf8')
const html = fs.readFileSync(new URL('asset-library.html', ROOT), 'utf8')
const css = fs.readFileSync(new URL('asset-library.css', ROOT), 'utf8')
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate) }

const images = [
  { id: 'asset-a', sourceId: 'generated', name: 'a.png', title: 'A', trashId: 'trash-a' },
  { id: 'asset-b', sourceId: 'generated', name: 'b.png', title: 'B', trashId: 'trash-b' }
]

// 极简 DOM 桩：足以真实执行 asset-library.js 的顶层绑定与 load() 渲染。
function page() {
  const nodes = new Map(), requests = [], docListeners = {}, winListeners = {}
  const state = { confirmCalls: 0, backClicks: 0 }
  const nativeConfirm = () => { state.confirmCalls++; return false } // 内嵌浏览器 / 沙箱 iframe
  const initiallyHidden = id => {
    const tag = html.match(new RegExp('<[^>]*\\bid="' + id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"[^>]*>'))?.[0] || ''
    return /\shidden(?=[\s/>])/.test(tag)
  }
  const makeNode = id => {
    const n = {
      id, tag: id, textContent: '', innerHTML: '', value: '', hidden: initiallyHidden(id),
      disabled: false, open: false, checked: false, max: '', focused: 0,
      dataset: {}, attrs: {}, children: [], options: [], listeners: {},
      style: { setProperty() {} }, classList: { add() {}, remove() {}, toggle() {} },
      setAttribute(name, value) { this.attrs[name] = value; this[name] = value },
      removeAttribute(name) { delete this.attrs[name] },
      addEventListener(name, fn) { this.listeners[name] = fn },
      replaceChildren(...args) { this.children = args; this.options = args.filter(a => a && a.tag === 'option') },
      add(option) { this.options.push(option) },
      append(...args) { this.children.push(...args) },
      appendChild(child) { this.children.push(child); return child },
      querySelector() { return this._input ||= makeNode('input-' + id) },
      focus() { this.focused++ }, reset() {}, close() { this.open = false }, showModal() { this.open = true },
      scrollIntoView() {}, load() {},
      click(event) {
        const e = event || { target: this, key: undefined }
        if (this.listeners.click) return this.listeners.click.call(this, e)
        if (this.onclick) return this.onclick.call(this, e)
      }
    }
    return n
  }
  const node = id => { if (!nodes.has(id)) nodes.set(id, makeNode(id)); return nodes.get(id) }
  const document = {
    getElementById: node,
    createElement(tag) { return makeNode(tag) },
    documentElement: { style: { setProperty() {} } },
    addEventListener(name, fn) { docListeners[name] = fn }
  }
  const location = new URL('http://192.0.2.7:4174/asset-library.html')
  const win = { parent: null, addEventListener(name, fn) { winListeners[name] = fn } }
  win.parent = win
  function Option(text, value) { return { tag: 'option', text, value } } // new Option(...) 必须是构造函数
  const fetchStub = (url, options = {}) => {
    requests.push({ url: String(url), options })
    if (options.body) return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, updated: 2, results: [] }) })
    return Promise.resolve({
      ok: true, status: 200,
      json: async () => ({ ok: true, total: 2, images, sources: [{ id: 'generated', name: '生成图片' }], facets: { collections: [], tags: [] } })
    })
  }
  const context = vm.createContext({
    document, location, window: win, console, fetch: fetchStub, localStorage: {
      getItem: () => null, setItem() {}, removeItem() {}
    },
    URL, URLSearchParams, AbortController, AbortSignal, URLSearchParams,
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    Option, confirm: nativeConfirm,
    setTimeout, clearTimeout
  })
  vm.runInContext(js, context)
  const backOriginal = node('back').onclick
  node('back').onclick = function (event) { state.backClicks++; return backOriginal.call(this, event) }
  return {
    node, state, requests, docListeners, winListeners, context, self: win,
    posts: () => requests.filter(r => r.options.body),
    selectAll: () => node('selectPage').click(),
    confirmYes: () => node('confirmYes').onclick(),
    confirmNo: () => node('confirmNo').onclick(),
    escape: () => docListeners.keydown({ key: 'Escape' }),
    backdrop: () => node('confirmLayer').click(),
    trash: () => node('trash').click(),
    purge: () => node('purge').click(),
    toTrash: () => node('trashTab').click()
  }
}

test('内嵌浏览器吞掉原生 confirm 时，移入回收站仍弹出页面内确认', async () => {
  const p = page()
  await settle()
  p.selectAll()
  p.trash()
  await settle()
  assert.equal(p.state.confirmCalls, 0, '不得依赖原生 confirm')
  assert.equal(p.node('confirmLayer').hidden, false, '必须出现可见的页面内确认浮层')
  assert.match(p.node('confirmText').textContent, /移入回收站/)
  assert.ok(p.node('confirmYes').focused > 0, '确认按钮应立即获得焦点')
  assert.equal(p.posts().length, 0, '确认前不得发出任何写请求')
})

test('取消 / Esc / 点遮罩都不执行删除', async () => {
  for (const dismiss of ['confirmNo', 'escape', 'backdrop']) {
    const p = page()
    await settle()
    p.selectAll(); p.trash(); await settle()
    assert.equal(p.node('confirmLayer').hidden, false)
    p[dismiss]()
    await settle()
    assert.equal(p.node('confirmLayer').hidden, true, dismiss + ' 应关闭浮层')
    assert.equal(p.posts().length, 0, dismiss + ' 不得发出写请求')
    assert.equal(p.state.confirmCalls, 0)
  }
})

test('点确定后才提交移入回收站请求，且只提交一次', async () => {
  const p = page()
  await settle()
  p.selectAll(); p.trash(); await settle()
  p.confirmYes()
  await settle()
  assert.equal(p.node('confirmLayer').hidden, true)
  const body = JSON.parse(p.posts()[0].options.body)
  assert.equal(body.action, 'trash')
  assert.equal(body.items.length, 2)
  assert.equal(p.posts().length, 1, '确认一次只提交一次')
})

test('重复点击按钮时旧确认作废，不会叠加提交', async () => {
  const p = page()
  await settle()
  p.selectAll(); p.trash(); await settle()
  p.trash(); await settle() // 第二次打开应先取消第一次
  assert.equal(p.node('confirmLayer').hidden, false)
  p.confirmYes()
  await settle()
  assert.equal(p.posts().length, 1, '两个确认只允许一个生效')
})

test('回收站的彻底删除同样走页面内确认', async () => {
  const p = page()
  await settle()
  p.toTrash(); await settle()
  p.selectAll(); p.purge(); await settle()
  assert.equal(p.state.confirmCalls, 0)
  assert.equal(p.node('confirmLayer').hidden, false)
  assert.match(p.node('confirmText').textContent, /彻底删除/)
  assert.equal(p.posts().length, 0)
  p.confirmYes()
  await settle()
  const body = JSON.parse(p.posts()[0].options.body)
  assert.equal(body.action, 'purge')
  assert.deepEqual(body.ids, ['trash-a', 'trash-b'])
})

test('恢复等无破坏性操作不弹确认，直接执行', async () => {
  const p = page()
  await settle()
  await p.context.mutate('restore', images)
  await settle()
  assert.equal(p.node('confirmLayer').hidden, true)
  assert.equal(p.state.confirmCalls, 0)
  assert.equal(JSON.parse(p.posts()[0].options.body).action, 'restore')
})

test('切换视图会关闭未决确认，确认中不允许父窗口关闭页面', async () => {
  const p = page()
  await settle()
  p.selectAll(); p.trash(); await settle()
  assert.equal(p.node('confirmLayer').hidden, false)
  const message = p.winListeners.message
  message({ origin: 'http://192.0.2.7:4174', source: p.self, data: { type: 'cgw:editor-request-close' } })
  assert.equal(p.state.backClicks, 0, '确认浮层打开时不应触发返回/关闭页面')
  assert.equal(p.node('confirmLayer').hidden, false, '确认浮层打开时不应被父窗口消息关闭')
  p.toTrash(); await settle()
  assert.equal(p.node('confirmLayer').hidden, true, '切换视图应取消未决确认')
  assert.equal(p.posts().length, 0)
})

test('静态契约：源码无原生对话框，浮层与样式齐备', () => {
  assert.doesNotMatch(js, /(?<![.\w])confirm\s*\(/, 'asset-library.js 不得调用原生 confirm')
  assert.match(html, /id="confirmLayer"/)
  assert.match(html, /id="confirmYes"/)
  assert.match(html, /id="confirmNo"/)
  assert.match(css, /#confirmLayer\{/)
  assert.match(js, /Escape/)
  assert.match(js, /closeConfirm\(false\)/)
  assert.match(js, /confirmLayer'\)\.hidden/)
})
