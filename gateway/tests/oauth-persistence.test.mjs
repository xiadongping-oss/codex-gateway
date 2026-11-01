import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { pathToFileURL, fileURLToPath } from 'node:url'

async function fixture(t, root = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-oauth-persist-'))) {
  const keys = ['CGW_DATA_DIR', 'CGW_STORAGE_MODE', 'APPDATA', 'LOCALAPPDATA']
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  const homedir = os.homedir
  os.homedir = () => root
  Object.assign(process.env, { CGW_DATA_DIR: root, CGW_STORAGE_MODE: 'managed', APPDATA: root, LOCALAPPDATA: root })
  let core
  try {
    const source = process.env.CGW_TEST_SRC || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const url = pathToFileURL(path.join(source, 'auth-core.mjs'))
    url.searchParams.set('fixture', crypto.randomUUID())
    core = await import(url.href)
  } finally {
    os.homedir = homedir
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  t.after(() => {
    core.cancelBrowserLogin({ force: true })
    core.clearDeviceFlow({ force: true })
  })
  return { root, core, file: kind => path.join(root, `.oauth-${kind}-pending.json`) }
}

function issuer(t) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options) => {
    const endpoint = new URL(url)
    assert.equal(endpoint.origin, 'https://auth.openai.com', 'unexpected network target blocked')
    calls.push(endpoint.pathname)
    let body
    if (endpoint.pathname.endsWith('/deviceauth/usercode')) body = { device_auth_id: 'fixture-device', user_code: 'FIXTURE', interval: 1 }
    else if (endpoint.pathname.endsWith('/deviceauth/token')) body = { authorization_code: 'fixture-device-code', code_verifier: 'fixture-verifier' }
    else if (endpoint.pathname === '/oauth/token') {
      const code = new URLSearchParams(options.body).get('code')
      body = { access_token: `${code}-access`, refresh_token: `${code}-refresh` }
    } else assert.fail('unexpected issuer endpoint blocked')
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  t.after(() => { globalThis.fetch = original })
  return { calls, exchanges: () => calls.filter(p => p === '/oauth/token').length }
}

async function browser(core, code = 'fixture-browser-code') {
  const info = await core.startBrowserLogin({ callbackPort: 0 })
  const callback = new URL(info.redirectUri)
  callback.searchParams.set('code', code)
  callback.searchParams.set('state', new URL(info.authUrl).searchParams.get('state'))
  return { info, callback: callback.href }
}

const persistenceFailure = () => { throw new Error('fixture persistence failed') }

test('browser manual callback retains exact tokens on save failure and excludes concurrent submission/cancel', async t => {
  const { core, file } = await fixture(t)
  const remote = issuer(t)
  const { callback } = await browser(core)
  await assert.rejects(core.submitBrowserCallback(callback, tokens => {
    tokens.tokens.access_token = 'mutated-by-callback'
    return persistenceFailure()
  }), /fixture persistence failed/)
  assert.ok(core.getBrowserLoginInfo())
  assert.equal(JSON.parse(fs.readFileSync(file('browser'), 'utf-8')).result.tokens.access_token, 'fixture-browser-code-access')
  assert.deepEqual(await core.startBrowserLogin({ callbackPort: 0 }), { ok: true, pendingImport: true, loginId: core.getBrowserLoginInfo().loginId })
  let release, committed = 0
  const finish = core.pollBrowserLogin(async tokens => {
    assert.equal(tokens.tokens.access_token, 'fixture-browser-code-access')
    committed++
    await new Promise(resolve => { release = resolve })
    return { accountId: 'saved' }
  })
  assert.deepEqual(await core.pollBrowserLogin(() => { committed++ }), { pending: true })
  assert.equal(core.cancelBrowserLogin(), false)
  await assert.rejects(core.submitBrowserCallback(callback), /正在处理/)
  release()
  const result = await finish
  assert.deepEqual(result, { pending: false, persisted: { accountId: 'saved' } })
  assert.equal(committed, 1)
  assert.equal(remote.exchanges(), 1)
  assert.equal(core.getBrowserLoginInfo(), null)
  assert.equal(fs.existsSync(file('browser')), false)
})

test('real loopback callback plus mocked token exchange survives shutdown/restart persistence failure', async t => {
  const first = await fixture(t)
  const remote = issuer(t)
  const { callback } = await browser(first.core)
  const local = new URL(callback); local.hostname = '127.0.0.1'
  const page = await new Promise((resolve, reject) => {
    http.get(local, res => { let text = ''; res.on('data', data => { text += data }); res.on('end', () => resolve(text)) }).on('error', reject)
  })
  assert.match(page, /授权成功/)
  assert.ok(!page.includes('fixture-browser-code-access'))
  await assert.rejects(first.core.pollBrowserLogin(persistenceFailure), /fixture persistence failed/)
  first.core.cancelBrowserLogin({ force: true, preserveResult: true })
  const resumed = await fixture(t, first.root)
  const result = await resumed.core.pollBrowserLogin(tokens => {
    assert.equal(tokens.tokens.access_token, 'fixture-browser-code-access')
    return { accountId: 'restored' }
  })
  assert.equal(result.persisted.accountId, 'restored')
  assert.equal(remote.exchanges(), 1)
  assert.equal(fs.existsSync(first.file('browser')), false)
})

test('browser snapshot write failure keeps exchanged tokens and retries without exchanging a one-use code twice', async t => {
  const { core, file } = await fixture(t)
  const remote = issuer(t)
  const { callback } = await browser(core)
  const rename = fs.renameSync
  let persisted = 0
  fs.renameSync = (from, to) => {
    if (path.resolve(String(to)) === file('browser')) throw new Error('fixture snapshot denied')
    return rename(from, to)
  }
  try { await assert.rejects(core.submitBrowserCallback(callback, () => { persisted++ }), /fixture snapshot denied/) }
  finally { fs.renameSync = rename }
  assert.equal(persisted, 0)
  const result = await core.submitBrowserCallback(callback, tokens => ({ accountId: tokens.tokens.access_token }))
  assert.equal(result.persisted.accountId, 'fixture-browser-code-access')
  assert.equal(remote.exchanges(), 1)
})

test('device tokens survive save failure/restart, keep source isolation and reject new flow overwrite', async t => {
  const first = await fixture(t)
  const remote = issuer(t)
  await first.core.startDeviceFlow()
  await assert.rejects(first.core.pollDeviceFlow(persistenceFailure), /fixture persistence failed/)
  assert.equal((await first.core.startDeviceFlow()).pendingImport, true)
  first.core.clearDeviceFlow({ force: true, preserveResult: true })
  const resumed = await fixture(t, first.root)
  const { callback } = await browser(resumed.core, 'second-browser')
  await assert.rejects(resumed.core.submitBrowserCallback(callback, persistenceFailure), /fixture persistence failed/)
  assert.ok(fs.existsSync(first.file('device')) && fs.existsSync(first.file('browser')))
  assert.equal(fs.readdirSync(first.root).filter(name => /^\.oauth-.*-pending\.json$/.test(name)).length, 2)
  resumed.core.cancelBrowserLogin()
  await assert.rejects(resumed.core.pollBrowserLogin(), /没有进行中的浏览器/)
  const result = await resumed.core.pollDeviceFlow(tokens => {
    assert.equal(tokens.tokens.access_token, 'fixture-device-code-access')
    return { accountId: 'device-restored' }
  })
  assert.equal(result.persisted.accountId, 'device-restored')
  assert.equal(remote.exchanges(), 2, 'one exchange per original source only')
  assert.equal(fs.existsSync(first.file('device')), false)
  assert.equal(fs.existsSync(first.file('browser')), false)
})

test('device persistence is single-flight and cancellation cannot resurrect or consume a busy result', async t => {
  const { core, file } = await fixture(t)
  const remote = issuer(t)
  await core.startDeviceFlow()
  await assert.rejects(core.pollDeviceFlow(persistenceFailure), /fixture persistence failed/)
  let release, writes = 0
  const commit = core.pollDeviceFlow(async () => {
    writes++
    await new Promise(resolve => { release = resolve })
    return { accountId: 'device' }
  })
  assert.deepEqual(await core.pollDeviceFlow(() => { writes++ }), { pending: true })
  assert.equal(core.clearDeviceFlow(), false)
  release()
  assert.equal((await commit).persisted.accountId, 'device')
  assert.equal(writes, 1)
  assert.equal(remote.exchanges(), 1)
  await core.startDeviceFlow()
  await assert.rejects(core.pollDeviceFlow(persistenceFailure), /fixture persistence failed/)
  assert.equal(core.clearDeviceFlow(), true)
  assert.equal(fs.existsSync(file('device')), false)
  await assert.rejects(core.pollDeviceFlow(), /没有进行中的设备/)
})

test('legacy no-callback contracts still return tokens and consume browser/device results', async t => {
  const { core } = await fixture(t)
  issuer(t)
  const { callback } = await browser(core)
  const manual = await core.submitBrowserCallback(callback)
  assert.equal(manual.pending, false)
  assert.equal(manual.tokens.tokens.access_token, 'fixture-browser-code-access')
  assert.equal(core.getBrowserLoginInfo(), null)
  const next = await browser(core, 'fixture-poll-code')
  const local = new URL(next.callback); local.hostname = '127.0.0.1'
  await new Promise((resolve, reject) => {
    http.get(local, res => { res.resume(); res.on('end', resolve) }).on('error', reject)
  })
  assert.equal((await core.pollBrowserLogin()).tokens.tokens.access_token, 'fixture-poll-code-access')
  assert.equal(core.getBrowserLoginInfo(), null)
  await core.startDeviceFlow()
  const device = await core.pollDeviceFlow()
  assert.equal(device.tokens.tokens.access_token, 'fixture-device-code-access')
  await assert.rejects(core.pollDeviceFlow(), /没有进行中的设备/)
})

test('damaged pending records are retained without leaking their contents or starting another authorization', async t => {
  const { core, file } = await fixture(t)
  const remote = issuer(t)
  const malformed = '{"fixture-private-content":broken'
  fs.writeFileSync(file('browser'), malformed)
  await assert.rejects(core.startBrowserLogin({ callbackPort: 0 }), error => {
    assert.ok(!error.message.includes('fixture-private-content'))
    return /无法读取/.test(error.message)
  })
  assert.throws(() => core.cancelBrowserLogin(), error => {
    assert.ok(!error.message.includes('fixture-private-content'))
    return /无法清理/.test(error.message)
  })
  assert.equal(fs.readFileSync(file('browser'), 'utf-8'), malformed)
  assert.equal(remote.calls.length, 0)
  // Remove only this exact malformed synthetic fixture so normal test teardown can run.
  fs.unlinkSync(file('browser'))
})
