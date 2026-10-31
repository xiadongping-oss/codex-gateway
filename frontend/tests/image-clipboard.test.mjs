import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyImageUrl } from '../src/api/image-clipboard.js'

function install(t, name, value) {
  const original = Object.getOwnPropertyDescriptor(globalThis, name)
  Object.defineProperty(globalThis, name, { configurable: true, value })
  t.after(() => original ? Object.defineProperty(globalThis, name, original) : delete globalThis[name])
}

test('clipboard write starts synchronously before the image request; PNG is not reencoded', async t => {
  const png = new Blob(['png-fixture'], { type: 'image/png' })
  let requested = false, written = false, finishRequest
  install(t, 'fetch', () => { requested = true; return new Promise(resolve => { finishRequest = resolve }) })
  install(t, 'ClipboardItem', class { constructor(data) { this.data = data } })
  install(t, 'navigator', { clipboard: { write(items) {
    assert.equal(requested, false)
    written = true
    assert.deepEqual(Object.keys(items[0].data), ['image/png'])
    return items[0].data['image/png'].then(blob => assert.equal(blob, png))
  } } })
  const pending = copyImageUrl('/slow.png')
  assert.equal(written, true)
  await Promise.resolve()
  finishRequest({ ok: true, blob: async () => png })
  await pending
})

test('unsupported clipboard fails without fetching private image data', async t => {
  install(t, 'navigator', {})
  install(t, 'fetch', () => assert.fail('must not fetch'))
  await assert.rejects(copyImageUrl('/image'), /不支持/)
})

test('HTTP errors reject the pending clipboard operation', async t => {
  install(t, 'fetch', async () => ({ ok: false, status: 401 }))
  install(t, 'ClipboardItem', class { constructor(data) { this.data = data } })
  install(t, 'navigator', { clipboard: { write: items => items[0].data['image/png'] } })
  await assert.rejects(copyImageUrl('/private.png'), /HTTP 401/)
})

test('permission denial remains a failure even when the pending image request also fails', async t => {
  const denied = new Error('permission denied')
  install(t, 'fetch', async () => { throw new Error('offline') })
  install(t, 'ClipboardItem', class {})
  install(t, 'navigator', { clipboard: { write: () => Promise.reject(denied) } })
  await assert.rejects(copyImageUrl('/image'), e => e === denied)
  await new Promise(resolve => setImmediate(resolve))
})
