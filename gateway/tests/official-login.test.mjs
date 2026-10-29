// 官方客户端临时登录 + 已保存供应商 的单测
// 全程注入：不真启进程、不外联、不碰真实数据目录。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  authFileHasCredentials,
  derivePhase,
  discoverCodexClient,
  createOfficialLoginManager,
  profileDirFor,
  tempLoginRootDir,
  LOGIN_TIMEOUT_MS
} from '../codex-official-login.mjs'

function tmpDataRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-offlogin-'))
}

// ---------- 纯函数 ----------

test('authFileHasCredentials：tokens.access_token / OPENAI_API_KEY 命中，空对象/坏 JSON 不命中', () => {
  assert.equal(authFileHasCredentials('{"tokens":{"access_token":"a"}}'), true)
  assert.equal(authFileHasCredentials('{"OPENAI_API_KEY":"sk-x"}'), true)
  assert.equal(authFileHasCredentials('{"tokens":{}}'), false)
  assert.equal(authFileHasCredentials('not json'), false)
  assert.equal(authFileHasCredentials('{}'), false)
})

test('derivePhase：六阶段推进 + 两条失败路径', () => {
  const base = { startedAt: Date.now(), hasCredentials: false, clientExited: false, spawned: true }
  assert.equal(derivePhase(base).phase, 'waiting-login')
  // 登录完成但客户端还开着 → logged-in（提示用户关闭）
  assert.equal(derivePhase({ ...base, hasCredentials: true }).phase, 'logged-in')
  // 客户端退出 + 凭据 → ready
  assert.equal(derivePhase({ ...base, hasCredentials: true, clientExited: true }).phase, 'ready')
  // 客户端退出但没凭据 → failed
  const closed = derivePhase({ ...base, clientExited: true, pidRunning: false })
  assert.equal(closed.phase, 'failed')
  assert.match(closed.error, /没有读到登录信息/)
  // 超时 → failed
  const timeout = derivePhase({ ...base, startedAt: Date.now() - LOGIN_TIMEOUT_MS - 1 })
  assert.equal(timeout.phase, 'failed')
  assert.match(timeout.error, /超时/)
  // 终态透传
  assert.equal(derivePhase({ phase: 'failed', error: 'x', hasCredentials: false }).phase, 'failed')
})

test('profileDirFor：非法会话 ID 拒绝（路径穿越防护）', () => {
  assert.throws(() => profileDirFor('/x', '../escape'), /非法的会话 ID/)
  assert.throws(() => profileDirFor('/x', 'abcd'), /非法的会话 ID/)
  const ok = profileDirFor('/x', '0123456789abcdef')
  assert.ok(ok.includes('0123456789abcdef'))
})

// ---------- 客户端发现 ----------

test('discoverCodexClient：显式环境变量优先；win32 执行别名次之', () => {
  const fsMap = new Set(['/custom/codex.exe'])
  const exists = (p) => fsMap.has(p.replace(/\\/g, '/'))
  const r1 = discoverCodexClient({
    env: { CODEX_CLIENT_PATH: '/custom/codex.exe' }, platform: 'win32', existsSync: exists
  })
  assert.equal(r1.kind, 'explicit')
  const r2 = discoverCodexClient({
    env: { LOCALAPPDATA: '/la' }, platform: 'win32', existsSync: exists
  })
  // fsMap 里没有 /la/... 命中（exists 对任意 /la 路径都 false）→ 需要 where 命中
  assert.equal(r2, null)
})

test('discoverCodexClient：where codex 命中 → kind cli；全部落空 → null', () => {
  const r = discoverCodexClient({
    env: { LOCALAPPDATA: '/la' }, platform: 'win32',
    existsSync: (p) => /found[\\/]codex\.exe$/.test(p),
    execSync: () => 'C:\\found\\codex.exe\n'
  })
  assert.equal(r.kind, 'cli')
  assert.ok(r.path.endsWith('codex.exe'))
  assert.equal(discoverCodexClient({ env: {}, platform: 'win32', existsSync: () => false, execSync: () => { throw new Error('no') } }), null)
})

// ---------- 会话管理器（注入 spawn/kill） ----------

function makeManager(root, { spawnImpl, killImpl, discoverImpl, alive = { flag: true } } = {}) {
  return createOfficialLoginManager({
    dataRoot: root,
    spawnImpl: spawnImpl || (() => ({ pid: 4321, unref() {} })),
    killTree: killImpl || (async () => {}),
    // 默认注入假发现/假探活：单测不依赖本机是否装了 Codex、不真探进程。
    // alive.flag 可在测试中翻转，模拟官方客户端退出。
    discoverImpl: discoverImpl || (() => ({ path: 'C:\\fake\\Codex.exe', kind: 'app' })),
    pidAliveImpl: () => alive.flag
  })
}

test('start→status→finish 全流程：凭据出现+客户端退出 → finish 返回 auth 并清理目录', async () => {
  const root = tmpDataRoot()
  const alive = { flag: true }
  const mgr = makeManager(root, { alive })
  const r = await mgr.start()
  assert.match(r.sessionId, /^[0-9a-f]{16}$/)
  assert.ok(r.profileDir.startsWith(tempLoginRootDir(root)))

  // 未登录：waiting-login
  let st = await mgr.status(r.sessionId)
  assert.equal(st.phase, 'waiting-login')
  // 写凭据（模拟官方客户端登录完成）
  fs.writeFileSync(path.join(r.profileDir, 'auth.json'), JSON.stringify({ tokens: { access_token: 'a', refresh_token: 'b' } }))
  st = await mgr.status(r.sessionId)
  assert.equal(st.phase, 'logged-in')
  // 模拟客户端退出 → ready
  alive.flag = false
  st = await mgr.status(r.sessionId)
  assert.equal(st.phase, 'ready')

  const fin = await mgr.finish(r.sessionId)
  assert.equal(fin.authJson.tokens.refresh_token, 'b')
  assert.equal(fin.cleaned, true)
  assert.ok(!fs.existsSync(r.profileDir))
  // 会话已消费：再次 finish 报错
  await assert.rejects(mgr.finish(r.sessionId), /会话不存在/)
})

test('cancel：杀进程 + 清理目录 + 会话移除', async () => {
  const root = tmpDataRoot()
  const killed = []
  const mgr = makeManager(root, { killImpl: async (pid) => killed.push(pid) })
  const r = await mgr.start()
  await mgr.cancel(r.sessionId)
  assert.deepEqual(killed, [4321])
  assert.ok(!fs.existsSync(r.profileDir))
  const st = await mgr.status(r.sessionId)
  assert.equal(st.phase, 'unknown')
})

test('start：客户端未找到 / spawn 失败 → 明确报错且不留目录', async () => {
  const root = tmpDataRoot()
  const mgrNone = makeManager(root, { discoverImpl: () => null })
  await assert.rejects(mgrNone.start(), /未找到官方 Codex 客户端/)

  const mgrBoom = makeManager(root, { spawnImpl: () => { throw new Error('boom') } })
  await assert.rejects(mgrBoom.start(), /启动官方客户端失败.*boom/)
  // tmp 根下不应留任何会话目录
  assert.equal(fs.readdirSync(tempLoginRootDir(root)).length, 0)
})

test('recover：有凭据的旧会话保留为 ready；没凭据的清掉', async () => {
  const root = tmpDataRoot()
  // 造两个旧会话目录
  const good = profileDirFor(root, 'a'.repeat(16))
  const bad = profileDirFor(root, 'b'.repeat(16))
  fs.mkdirSync(good, { recursive: true })
  fs.mkdirSync(bad, { recursive: true })
  fs.writeFileSync(path.join(good, 'auth.json'), '{"tokens":{"access_token":"a"}}')
  fs.writeFileSync(path.join(good, 'session-marker.json'), JSON.stringify({ sessionId: 'a'.repeat(16), createdAt: new Date().toISOString() }))
  fs.writeFileSync(path.join(bad, 'session-marker.json'), JSON.stringify({ sessionId: 'b'.repeat(16), createdAt: new Date().toISOString() }))

  const mgr = makeManager(root)
  const rec = mgr.recover()
  assert.equal(rec.kept, 1)
  assert.equal(rec.removed, 1)
  assert.ok(!fs.existsSync(bad))
  // good 会话直接可 finish 导入，不必重新登录
  const fin = await mgr.finish('a'.repeat(16))
  assert.equal(fin.authJson.tokens.access_token, 'a')
})

test('destroyProfile：只删会话命名空间内的目录', async () => {
  const root = tmpDataRoot()
  const mgr = makeManager(root)
  // 根目录外的路径不删
  const outside = path.join(root, '..', 'outside-dir')
  fs.mkdirSync(outside, { recursive: true })
  assert.equal(mgr.destroyProfile(outside), false)
  assert.ok(fs.existsSync(outside))
  fs.rmSync(outside, { recursive: true, force: true })
  // 合法会话目录可删
  const sess = profileDirFor(root, 'c'.repeat(16))
  fs.mkdirSync(sess, { recursive: true })
  assert.equal(mgr.destroyProfile(sess), true)
  assert.ok(!fs.existsSync(sess))
})
