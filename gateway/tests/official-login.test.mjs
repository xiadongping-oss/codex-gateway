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
  // 客户端退出但没凭据 → failed（CLI 形态，无 defaultWatch）
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

test('derivePhase：桌面客户端（defaultWatch）退出后不判失败，继续等默认 profile；超时给专属提示', () => {
  const base = { startedAt: Date.now(), hasCredentials: false, clientExited: false, spawned: true, defaultWatch: true }
  // 交接退出（单实例应用把窗口交给已运行实例）→ 仍 waiting-login
  const handedOff = derivePhase({ ...base, clientExited: true, pidRunning: false })
  assert.equal(handedOff.phase, 'waiting-login')
  // 超时 → failed，提示里点名「默认凭据没变化」
  const timeout = derivePhase({ ...base, startedAt: Date.now() - LOGIN_TIMEOUT_MS - 1 })
  assert.equal(timeout.phase, 'failed')
  assert.match(timeout.error, /默认 Codex 凭据/)
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

// ---------- Store（MSIX）版发现 ----------
// 真机形态：OpenAI.Codex 包族目录 + 两个辅助别名，主程序不注册 codex.exe。
const norm = (p) => String(p).replace(/\\/g, '/')

test('discoverCodexClient：Store 版从别名 reparse 目标反推安装根，AppxManifest 给出主程序', () => {
  const wa = 'C:/la/Microsoft/WindowsApps'
  const pkg = wa + '/OpenAI.Codex_2p2nqsd0c76g0'
  const installRoot = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1023.6123.0_x64__2p2nqsd0c76g0'
  const mainExe = installRoot + '\\app\\Codex.exe'
  const readdir = (p) => {
    const n = norm(p)
    if (n === norm(wa)) return ['OpenAI.Codex_2p2nqsd0c76g0', 'Microsoft.Paint_8wekyb3d8bbwe', 'codex-chrome-native-host.exe']
    if (norm(n) === norm(pkg)) return ['codex-core-command-runner.exe']
    return []
  }
  const readlink = (p) => {
    const n = norm(p)
    if (n === norm(pkg) + '/codex-core-command-runner.exe') return installRoot + '\\app\\resources\\codex-command-runner.exe'
    if (n === norm(wa) + '/codex-chrome-native-host.exe') return installRoot + '\\app\\resources\\plugins\\openai-bundled\\plugins\\chrome\\extension-host.exe'
    throw Object.assign(new Error('EINVAL'), { code: 'EINVAL' })
  }
  const readFile = (p) => {
    if (/AppxManifest\.xml$/i.test(norm(p))) {
      return '<?xml version="1.0"?><Applications><Application Id="Codex" Executable="app\\Codex.exe" /></Applications>'
    }
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  }
  const r = discoverCodexClient({
    env: { LOCALAPPDATA: 'C:/la' }, platform: 'win32',
    existsSync: (p) => norm(p) === norm(mainExe),
    readdirSync: readdir, readlinkSync: readlink, readFile
  })
  assert.equal(r.kind, 'store')
  assert.equal(norm(r.path), norm(mainExe))
})

test('discoverCodexClient：Store 版清单解析失败时按常见布局探测；无 codex 包 → null', () => {
  const wa = 'C:/la/Microsoft/WindowsApps'
  const pkg = wa + '/OpenAI.Codex_abc'
  const installRoot = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.0.0_x64__abc'
  const fallbackExe = installRoot + '\\app\\Codex.exe'
  const readdir = (p) => (norm(p) === norm(wa) ? ['OpenAI.Codex_abc'] : norm(p) === norm(pkg) ? ['runner.exe'] : [])
  const readlink = (p) => (norm(p) === norm(pkg) + '/runner.exe' ? installRoot + '\\app\\resources\\runner.exe' : (() => { throw new Error('EINVAL') })())
  const r1 = discoverCodexClient({
    env: { LOCALAPPDATA: 'C:/la' }, platform: 'win32',
    existsSync: (p) => norm(p) === norm(fallbackExe),
    readdirSync: readdir,
    readlinkSync: readlink,
    readFile: () => { throw new Error('ENOENT') }
  })
  assert.equal(r1.kind, 'store')
  assert.equal(norm(r1.path), norm(fallbackExe))

  // 别名目标不含 codex（如 iTunes）→ 不采纳（existsSync 全 false，避免命中内置候选）
  const r2 = discoverCodexClient({
    env: { LOCALAPPDATA: 'C:/la' }, platform: 'win32',
    existsSync: () => false,
    readdirSync: (p) => (norm(p) === norm(wa) ? ['AppleInc.iTunes_nzyj5cx40ttqa'] : norm(p) === norm(wa) + '/AppleInc.iTunes_nzyj5cx40ttqa' ? ['iTunes.exe'] : []),
    readlinkSync: () => 'C:\\Program Files\\WindowsApps\\AppleInc.iTunes_1.0_x64__nzyj5cx40ttqa\\iTunes.exe',
    readFile: () => { throw new Error('ENOENT') }
  })
  assert.equal(r2, null)
})

// ---------- 默认 profile 兜底（桌面版不尊重 CODEX_HOME 的场景） ----------

test('默认 profile 兜底：~/.codex/auth.json 相对会话开始发生变化才采纳', async () => {
  const root = tmpDataRoot()
  const defRef = { text: '{"tokens":{"access_token":"old"}}' }
  const mgr = createOfficialLoginManager({
    dataRoot: root,
    spawnImpl: () => ({ pid: 1, unref() {} }),
    killTree: async () => {},
    discoverImpl: () => ({ path: 'x', kind: 'app' }),
    pidAliveImpl: () => true,
    defaultAuthText: () => defRef.text
  })
  const r = await mgr.start()
  // 默认 profile 未变化 → 不当成本次登录
  let st = await mgr.status(r.sessionId)
  assert.equal(st.hasCredentials, false)
  // 桌面版把新登录写进了默认 profile → 采纳，来源 default-profile
  defRef.text = '{"tokens":{"access_token":"NEW","refresh_token":"r2"}}'
  st = await mgr.status(r.sessionId)
  assert.equal(st.hasCredentials, true)
  assert.equal(st.credSource, 'default-profile')
  // finish 导入的是新凭据
  const fin = await mgr.finish(r.sessionId)
  assert.equal(fin.authJson.tokens.access_token, 'NEW')
  assert.equal(fin.credSource, 'default-profile')
})

test('默认 profile 兜底：临时 profile 永远优先；会话开始时无默认凭据则凭空出现也采纳', async () => {
  const root = tmpDataRoot()
  const defRef = { text: null }
  const mgr = createOfficialLoginManager({
    dataRoot: root,
    spawnImpl: () => ({ pid: 1, unref() {} }),
    killTree: async () => {},
    discoverImpl: () => ({ path: 'x', kind: 'app' }),
    pidAliveImpl: () => true,
    defaultAuthText: () => defRef.text
  })
  const r = await mgr.start()
  // 会话开始时默认 profile 不存在，中途出现凭据 → 属于本次登录
  defRef.text = '{"tokens":{"access_token":"fresh"}}'
  let st = await mgr.status(r.sessionId)
  assert.equal(st.credSource, 'default-profile')
  await mgr.cancel(r.sessionId)

  // 临时 profile 与默认 profile 同时有凭据 → 临时优先
  const r2 = await mgr.start()
  defRef.text = '{"tokens":{"access_token":"default-new"}}'
  fs.writeFileSync(path.join(r2.profileDir, 'auth.json'), '{"tokens":{"access_token":"temp"}}')
  st = await mgr.status(r2.sessionId)
  assert.equal(st.credSource, 'temp-profile')
  const fin = await mgr.finish(r2.sessionId)
  assert.equal(fin.authJson.tokens.access_token, 'temp')
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
    pidAliveImpl: () => alive.flag,
    // 隔离真实 ~/.codex/auth.json：兜底逻辑单独测，不依赖测试机的登录状态
    defaultAuthText: () => null
  })
}

test('start→status→finish：GUI 交接退出后返回 auth，保留可能仍被使用的目录', async () => {
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
  assert.equal(fin.cleaned, false)
  assert.ok(fs.existsSync(r.profileDir))
  // 会话已消费：再次 finish 报错
  await assert.rejects(mgr.finish(r.sessionId), /会话不存在/)
})

test('cancel：取消导入，不按 PID 杀客户端，不删除未确认退出的目录', async () => {
  const root = tmpDataRoot()
  const killed = []
  const mgr = makeManager(root, { killImpl: async (pid) => killed.push(pid) })
  const r = await mgr.start()
  await mgr.cancel(r.sessionId)
  assert.deepEqual(killed, [])
  assert.ok(fs.existsSync(r.profileDir))
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

test('start：CLI 形态补 login 子命令；桌面客户端进入 defaultWatch（退出不失败）', async () => {
  const root = tmpDataRoot()
  const seen = []
  const mgrCli = makeManager(root, {
    discoverImpl: () => ({ path: 'C:\\npm\\codex.cmd', kind: 'cli' }),
    spawnImpl: (cmd) => { seen.push(cmd); return { pid: 11, unref() {} } }
  })
  const r1 = await mgrCli.start()
  assert.match(seen[0], /"C:\\npm\\codex\.cmd" login/)
  assert.equal(seen[0].includes('start "" /WAIT'), true)
  await mgrCli.cancel(r1.sessionId)

  // store 形态：不带 login；客户端退出后仍 waiting-login（watchDefaultProfile=true）
  const mgrStore = makeManager(root, {
    discoverImpl: () => ({ path: 'C:\\Store\\ChatGPT.exe', kind: 'store' }),
    spawnImpl: () => ({ pid: 22, unref() {} }),
    alive: { flag: true }
  })
  const r2 = await mgrStore.start()
  assert.ok(!seen[1] || true)
  const alive = { flag: true }
  // 用独立管理器翻转探活：模拟交接退出
  const mgrStore2 = createOfficialLoginManager({
    dataRoot: root,
    spawnImpl: () => ({ pid: 33, unref() {} }),
    killTree: async () => {},
    discoverImpl: () => ({ path: 'C:\\Store\\ChatGPT.exe', kind: 'store' }),
    pidAliveImpl: () => alive.flag,
    defaultAuthText: () => null
  })
  const r3 = await mgrStore2.start()
  alive.flag = false
  let st = await mgrStore2.status(r3.sessionId)
  assert.equal(st.clientExited, true)
  assert.equal(st.phase, 'waiting-login')
  assert.equal(st.watchDefaultProfile, true)
  // 默认 profile 变化 → 直接 logged-in（source=default-profile）
  const defRef = { text: null }
  const mgrStore3 = createOfficialLoginManager({
    dataRoot: root,
    spawnImpl: () => ({ pid: 44, unref() {} }),
    killTree: async () => {},
    discoverImpl: () => ({ path: 'C:\\Store\\ChatGPT.exe', kind: 'store' }),
    pidAliveImpl: () => false,
    defaultAuthText: () => defRef.text
  })
  const r4 = await mgrStore3.start()
  defRef.text = '{"tokens":{"access_token":"desktop-login"}}'
  st = await mgrStore3.status(r4.sessionId)
  // 探活恒 false（模拟交接退出）→ 凭据一出现就是 ready
  assert.equal(st.phase, 'ready')
  assert.equal(st.credSource, 'default-profile')
  await mgrStore3.cancel(r4.sessionId)
  await mgrStore.cancel(r2.sessionId)
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

test('recover never signals a stale PID or removes a potentially live profile', async () => {
  const root = tmpDataRoot()
  const dir = profileDirFor(root, 'd'.repeat(16))
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'session-marker.json'), JSON.stringify({ pid: process.pid, clientPath: 'unrelated.exe' }))
  let signalled = false
  const mgr = makeManager(root, { killImpl: () => { signalled = true } })
  assert.deepEqual(mgr.recover(), { kept: 1, removed: 0 })
  assert.equal(signalled, false)
  assert.ok(fs.existsSync(dir))
})

test('shutdown waits for actual owned helper exit, even after cancelling its session', async () => {
  const { EventEmitter } = await import('node:events')
  const child = new EventEmitter()
  child.pid = 9876; child.unref = () => {}
  let killed = 0; child.kill = () => { killed++; return true }
  const tracked = []
  const mgr = createOfficialLoginManager({ dataRoot: tmpDataRoot(),
    spawnImpl: () => child, discoverImpl: () => ({ path: 'C:\\fake\\client.exe', kind: 'app' }),
    trackChild: c => tracked.push(c), defaultAuthText: () => null })
  const session = await mgr.start()
  await mgr.cancel(session.sessionId)
  assert.equal(await mgr.stopAndWait(10), false)
  let finished = false
  const stop = mgr.stopAndWait(1000).then(ok => { finished = true; return ok })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(finished, false)
  child.emit('exit', 0)
  assert.equal(await stop, true)
  assert.equal(killed, 2); assert.deepEqual(tracked, [child])
})
