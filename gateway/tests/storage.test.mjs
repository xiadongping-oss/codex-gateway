import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { resolveStoragePaths, bridgeStorageEnv } from '../storage-paths.mjs'
import { initializeStorage, validateExternalPath } from '../storage-init.mjs'

const GW = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-storage-'))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  const program = path.join(temp, '资源 程序')
  fs.mkdirSync(path.join(program, 'gateway'), { recursive: true })
  const root = path.join(temp, '用户 数据')
  const env = { CGW_STORAGE_MODE: 'managed', CGW_DATA_DIR: root }
  return { temp, root, program, env, paths: resolveStoragePaths(env, path.join(program, 'gateway')) }
}
const unprotected = { protect() {} }

test('路径：Windows/macOS managed、legacy 与空格中文路径', () => {
  for (const [api, root, gateway, home] of [
    [path.win32, 'C:\\用户 数据\\CodexGateway', 'C:\\Programs\\Gateway\\resources\\gateway', 'C:\\Users\\Example'],
    [path.posix, '/Users/test/Library/Application Support/CodexGateway', '/Applications/Gateway.app/Contents/Resources/gateway', '/Users/test']
  ]) {
    const p = resolveStoragePaths({ CGW_STORAGE_MODE: 'managed', CGW_DATA_DIR: root }, gateway, { api, home })
    assert.equal(p.generated, api.join(root, 'gen-images'))
    assert.equal(p.references, api.join(root, 'references'))
    assert.equal(p.loginTemp, api.join(root, 'tmp/codex-temp-login'))
    const old = resolveStoragePaths({ CGW_DATA_DIR: root }, gateway, { api, home })
    assert.equal(old.root, root)
    assert.equal(old.generated, api.join(home, '.chatgpt-bridge/gen-images'))
    assert.equal(resolveStoragePaths({}, gateway, { api, home }).root, gateway)
  }
})

test('路径：managed 不能回退或覆盖固定存储，桌面标记强制 managed', (t) => {
  const { paths, env } = fixture(t)
  for (const value of ['', 'relative', './data']) {
    assert.throws(() => resolveStoragePaths({ ...env, CGW_DATA_DIR: value }), { code: 'DATA_DIR_INVALID' })
  }
  for (const key of ['CGW_QUOTA_FILE', 'API_PROVIDERS_STORE_PATH', 'ASSETS_STORE_PATH']) {
    assert.throws(() => resolveStoragePaths({ ...env, [key]: 'elsewhere' }), { code: 'DATA_DIR_INVALID' })
  }
  assert.throws(() => resolveStoragePaths({ CGW_DESKTOP: '1' }), { code: 'DATA_DIR_INVALID' })
  assert.equal(resolveStoragePaths({ CGW_DESKTOP: '1', CGW_DATA_DIR: paths.root }).managed, true)
})

test('路径：程序和数据不可相互包含或写进 .app', (t) => {
  const { program, env } = fixture(t)
  for (const root of [program, path.join(program, 'data'), path.dirname(program), path.join(path.dirname(program), 'Other.app/data')]) {
    assert.throws(() => resolveStoragePaths({ ...env, CGW_DATA_DIR: root }, path.join(program, 'gateway')), { code: 'DATA_DIR_INVALID' })
  }
})

test('初始化：创建 v1、排他锁、正常释放后重开，不重写版本标记', (t) => {
  const { paths } = fixture(t)
  const lease = initializeStorage(paths, unprotected)
  const firstTime = fs.statSync(paths.layout).mtimeMs
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.layout)), { schemaVersion: 1 })
  assert.ok(fs.existsSync(paths.generated))
  assert.throws(() => initializeStorage(paths, unprotected), { code: 'DATA_IN_USE' })
  assert.equal(lease.release(), true)
  assert.equal(lease.release(), false)
  const again = initializeStorage(paths, unprotected)
  assert.equal(fs.statSync(paths.layout).mtimeMs, firstTime)
  again.release()
})

test('初始化：真实平台权限设置并保持新文件继承保护', (t) => {
  const { paths } = fixture(t)
  const lease = initializeStorage(paths)
  try {
    const file = path.join(paths.root, 'auth.json')
    fs.writeFileSync(file, '{}', { mode: 0o600 })
    if (process.platform === 'win32') {
      const script = "$a=[IO.File]::GetAccessControl($env:CGW_PERMISSION_TARGET); $a.Access | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value }"
      const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { env: { ...process.env, CGW_PERMISSION_TARGET: file }, encoding: 'utf8', windowsHide: true })
      assert.ok(output.includes('S-1-5-18'))
      assert.ok(!/S-1-1-0\s|S-1-5-32-545\s/.test(output), '不应继承 Everyone/Users')
    } else {
      assert.equal(fs.statSync(paths.root).mode & 0o777, 0o700)
      assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    }
  } finally { lease.release() }
})

test('初始化：权限失败不产生身份/布局，保留稳定互斥后可重试', (t) => {
  const { paths } = fixture(t)
  assert.throws(() => initializeStorage(paths, { protect() { throw new Error('denied') } }), { code: 'DATA_DIR_UNWRITABLE' })
  let guardIdentity
  if (process.platform === 'darwin') {
    assert.deepEqual(fs.readdirSync(paths.root), ['runtime'])
    assert.deepEqual(fs.readdirSync(paths.runtime), ['owner.guard'])
    assert.equal(fs.readFileSync(path.join(paths.runtime, 'owner.guard')).length, 0)
    guardIdentity = fs.statSync(path.join(paths.runtime, 'owner.guard')).ino
  } else assert.deepEqual(fs.readdirSync(paths.root), [])
  initializeStorage(paths, unprotected).release()
  if (process.platform === 'darwin') assert.equal(fs.statSync(path.join(paths.runtime, 'owner.guard')).ino, guardIdentity)
})

test('初始化：旧目录和更高/损坏布局拒绝启动，原数据保持不变', (t) => {
  const { paths } = fixture(t)
  fs.mkdirSync(paths.root)
  const auth = path.join(paths.root, 'auth.json')
  fs.writeFileSync(auth, 'CANARY')
  assert.throws(() => initializeStorage(paths, unprotected), { code: 'DATA_MIGRATION_REQUIRED' })
  for (const contents of ['{"schemaVersion":2}', '{']) {
    fs.writeFileSync(paths.layout, contents)
    assert.throws(() => initializeStorage(paths, unprotected), { code: 'DATA_VERSION_UNSUPPORTED' })
    assert.equal(fs.readFileSync(paths.layout, 'utf8'), contents)
  }
  assert.equal(fs.readFileSync(auth, 'utf8'), 'CANARY')
  assert.ok(!fs.existsSync(paths.runtime))
})

test('初始化：陈旧锁/复用 PID 不自动接管，有存活 bridge 时不释放', (t) => {
  const { paths } = fixture(t)
  const lease = initializeStorage(paths, unprotected)
  const child = new EventEmitter()
  lease.trackChild(child)
  assert.equal(lease.release(), false)
  child.emit('exit', 0)
  assert.equal(lease.release(), true)
  const lock = path.join(paths.runtime, 'owner.lock')
  const record = JSON.stringify({ ownerId: 'old', pid: process.pid, processStartedAt: '1970-01-01' })
  fs.writeFileSync(lock, record)
  assert.throws(() => initializeStorage(paths, unprotected), { code: 'DATA_IN_USE' })
  assert.equal(fs.readFileSync(lock, 'utf8'), record)
})

test('初始化：跨进程竞争同一数据目录被拒绝', (t) => {
  const { paths } = fixture(t)
  const lease = initializeStorage(paths, unprotected)
  try {
    const code = `import {initializeStorage} from ${JSON.stringify(pathToFileURL(path.join(GW, 'storage-init.mjs')).href)}; try { initializeStorage(${JSON.stringify(paths)}, {protect(){}}); process.exitCode=2 } catch(e) { console.log(e.code) }`
    assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' }).trim(), 'DATA_IN_USE')
  } finally { lease.release() }
})

test('路径：junction 不能将数据或外部配置指回程序，子目录链接也拒绝', (t) => {
  const { paths, temp, program } = fixture(t)
  const link = path.join(temp, 'alias')
  fs.symlinkSync(program, link, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => initializeStorage({ ...paths, root: path.join(link, 'data') }, unprotected), { code: 'DATA_DIR_INVALID' })
  assert.throws(() => validateExternalPath(path.join(link, 'auth.json'), paths, '凭据'), { code: 'DATA_DIR_INVALID' })
  fs.mkdirSync(paths.root)
  fs.symlinkSync(program, path.join(paths.root, 'gen-images'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => initializeStorage(paths, unprotected), { code: 'DATA_DIR_INVALID' })
})

test('bridge 环境：固定 D 和账号，清理 home 与 Node 注入变量，legacy 保持原样', (t) => {
  const { paths } = fixture(t)
  const inherited = { CODEX_HOME: 'outside', CHATGPT_BRIDGE_HOME: 'outside', CHATGPT_LOCAL_HOME: 'outside', NODE_OPTIONS: '--import=bad', NODE_PATH: 'bad', USERPROFILE: 'real-home' }
  const auth = path.join(paths.root, 'accounts/a.json')
  const managed = bridgeStorageEnv(inherited, paths, auth)
  assert.equal(managed.CHATGPT_BRIDGE_DATA_DIR, paths.root)
  assert.equal(managed.CHATGPT_BRIDGE_AUTH_FILE, auth)
  assert.equal(managed.CGW_BRIDGE_AUTH_STRICT, '1')
  assert.equal(managed.USERPROFILE, 'real-home')
  assert.equal(managed.CODEX_HOME, undefined)
  assert.equal(managed.NODE_OPTIONS, undefined)
  assert.equal(bridgeStorageEnv(inherited, { managed: false }, auth).CODEX_HOME, 'outside')
})

test('两份 bridge 补丁：严格模式不回退外部凭据，图库使用明确 dataHome', async (t) => {
  const { paths, temp } = fixture(t)
  fs.mkdirSync(paths.root)
  const other = path.join(temp, 'other')
  fs.mkdirSync(other)
  const jwt = 'e30.' + Buffer.from(JSON.stringify({ exp: 4102444800 })).toString('base64url') + '.sig'
  const credentials = JSON.stringify({ tokens: { access_token: jwt, account_id: 'fixture' } })
  fs.writeFileSync(path.join(other, 'auth.json'), credentials)
  for (const file of ['cli.patched.js', 'index.patched.js']) {
    const source = fs.readFileSync(path.join(GW, 'patches', file), 'utf8')
    const start = source.indexOf('function homeDir()')
    const end = source.indexOf('var DEFAULT_CHAT_MODEL', start)
    const context = { process: { env: { CGW_BRIDGE_AUTH_STRICT: '1', CHATGPT_BRIDGE_DATA_DIR: paths.root, CHATGPT_BRIDGE_AUTH_FILE: path.join(paths.root, 'missing.json'), CODEX_HOME: other } }, path, os, DEFAULTS: {} }
    vm.runInNewContext(source.slice(start, end) + '\nthis.config=loadConfig();this.candidates=authFileCandidates(config)', context)
    assert.equal(context.config.dataHome, paths.root)
    assert.deepEqual(Array.from(context.candidates), [path.join(paths.root, 'missing.json')])
  }
  // 执行实际发布模块的 Auth，而非只检查源码符号。
  const bridge = await import('../node_modules/chatgpt-bridge/dist/index.js')
  const saved = { ...process.env }
  try {
    process.env.CGW_BRIDGE_AUTH_STRICT = '1'
    process.env.CODEX_HOME = other
    const cfg = bridge.loadConfig({ authFilePath: path.join(paths.root, 'missing.json'), dataHome: paths.root })
    await assert.rejects(new bridge.Auth(cfg).ensure(), /auth.json not found/)
    fs.writeFileSync(cfg.authFilePath, '{broken')
    await assert.rejects(new bridge.Auth(cfg).ensure(), /auth.json not found/)
    fs.writeFileSync(cfg.authFilePath, credentials)
    assert.equal((await new bridge.Auth(cfg).ensure()).accountId, 'fixture')
    assert.equal(fs.readFileSync(path.join(other, 'auth.json'), 'utf8'), credentials)
  } finally {
    for (const key of ['CGW_BRIDGE_AUTH_STRICT', 'CODEX_HOME']) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]
    }
  }
})
