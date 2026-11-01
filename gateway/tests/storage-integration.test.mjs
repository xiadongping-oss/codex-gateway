import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import vm from 'node:vm'
import net from 'node:net'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveStoragePaths } from '../storage-paths.mjs'
import { initializeStorage } from '../storage-init.mjs'
import { writeJsonAtomic } from '../atomic-write.mjs'

const GW = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC6kAAAAASUVORK5CYII=', 'base64')
function digest(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }
function tree(root) {
  const out = {}
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name)
      if (fs.statSync(file).isDirectory()) walk(file)
      else out[path.relative(root, file)] = digest(file)
    }
  }
  walk(root)
  return out
}
function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-storage-integration-'))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  const root = path.join(temp, '用户 数据')
  const home = path.join(temp, 'isolated-home')
  fs.mkdirSync(home)
  const env = { ...process.env, CGW_STORAGE_MODE: 'managed', CGW_DATA_DIR: root, USERPROFILE: home, HOME: home, APPDATA: home, LOCALAPPDATA: home, DISABLE_AUTOSTART: '1' }
  for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'CGW_QUOTA_FILE', 'ASSETS_STORE_PATH', 'API_PROVIDERS_STORE_PATH', 'CGW_ADMIN_TOKEN', 'CGW_ADMIN_AUTH', 'CGW_DESKTOP', 'CGW_OPEN_BROWSER', 'CODEX_HOME', 'CHATGPT_BRIDGE_HOME', 'CGW_TEST_SRC', 'BRIDGE_CLI', 'BRIDGE_NODE', 'BRIDGE_ARGS']) delete env[key]
  const paths = resolveStoragePaths(env, GW)
  return { temp, root, home, env, paths }
}
async function freePort() {
  const server = net.createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise((r) => server.close(r))
  return port
}

test('managed 真实网关：模块写入在初始化后，图库/素材/下载/删除/MCP 共享 D', async (t) => {
  const { paths, env, temp, home } = fixture(t)
  let foreignConnections = 0
  const foreign = net.createServer(socket => { foreignConnections++; socket.destroy() })
  foreign.listen(0, '127.0.0.1')
  await once(foreign, 'listening')
  t.after(() => new Promise(resolve => foreign.close(resolve)))
  env.BRIDGE_PORT = String(foreign.address().port)
  const protectedFiles = ['launcher.mjs', 'node_modules/chatgpt-bridge/dist/cli.js', 'node_modules/chatgpt-bridge/dist/index.js']
  const beforeProgram = protectedFiles.map((f) => digest(path.join(GW, f)))
  // Module evaluation can finish before listen's callback. Synchronize with the
  // actual listener instead of racing the first HTTP request against startup.
  const childCode = `const { gatewayReady } = await import(${JSON.stringify(pathToFileURL(path.join(GW, 'launcher.mjs')).href)}); await gatewayReady; console.log('FIXTURE_READY'); process.stdin.resume();process.stdin.once('data',()=>process.emit('SIGTERM'))`
  const port = await freePort()
  const child = spawn(process.execPath, ['--input-type=module', '-e', childCode, '--', 'storage-fixture', '--port', String(port)], { cwd: temp, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const exited = once(child, 'exit')
  let output = ''
  child.stdout.on('data', (b) => { output += b })
  child.stderr.on('data', (b) => { output += b })
  // hook LIFO 不依赖 t.after 顺序：本函数 finally 先停自建子进程，再让 fixture 删除目录。
  try {
    const until = Date.now() + 15000
    while (!output.includes('FIXTURE_READY') && child.exitCode === null && child.signalCode === null && Date.now() < until) await new Promise((r) => setTimeout(r, 40))
    assert.ok(output.includes('FIXTURE_READY'), output)
    assert.ok(fs.existsSync(paths.layout))
    assert.ok(fs.existsSync(path.join(paths.root, '.codex-client-identity')), '顶层身份文件须能在已准备的 D 落盘')
    const token = JSON.parse(fs.readFileSync(path.join(paths.root, 'admin-token.json'))).token
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    const request = (url, options = {}) => fetch(`http://127.0.0.1:${port}${url}`, { ...options, headers, signal: AbortSignal.timeout(5000) })
    for (const endpoint of ['/__gw/status', '/__gw/auth/state', '/__gw/models']) {
      assert.equal((await request(endpoint)).status, 200)
    }
    const quota = await (await request('/__gw/account/quota')).json()
    assert.equal(quota.source, 'none')
    assert.equal(quota.weekly, null)
    assert.equal(foreignConnections, 0, '空账号控制台不能探测其他实例的 bridge 基准端口')
    for (const dir of ['relative-pictures', GW]) {
      const rejected = await request('/__gw/assets/sources', { method: 'POST', body: JSON.stringify({ type: 'local', name: 'fixture', config: { dir } }) })
      assert.equal(rejected.status, 400, 'managed 外部素材不能使用相对目录或程序目录')
    }
    const external = path.join(temp, 'external-pictures')
    fs.mkdirSync(external)
    const added = await request('/__gw/assets/sources', { method: 'POST', body: JSON.stringify({ type: 'local', name: 'fixture', config: { dir: external } }) })
    assert.equal(added.status, 200)
    assert.ok(fs.existsSync(paths.assets), '素材源注册表位于 D')

    // 执行 launcher 实际保存函数；不用 OAuth 或真实上游，仍检查图片字节和归属索引。
    const source = fs.readFileSync(path.join(GW, 'launcher.mjs'), 'utf8')
    const funcs = ['genImagesDir', 'genImageIndexPath', 'readImageIndex', 'writeImageIndex', 'saveGenImageB64'].map((name) => {
      const match = source.match(new RegExp(`^function ${name}\\([^]*?^}`, 'm'))
      assert.ok(match, name)
      return match[0]
    }).join('\n')
    const context = { fs, path, crypto, Buffer, console, writeJsonAtomic, storagePaths: paths }
    vm.runInNewContext(funcs + '\nthis.saved=saveGenImageB64', context)
    const name = context.saved(PNG.toString('base64'), { keyId: 'fixture-key', keyName: 'fixture' })
    assert.ok(name)
    assert.deepEqual(fs.readFileSync(path.join(paths.generated, name)), PNG)
    assert.equal(JSON.parse(fs.readFileSync(path.join(paths.generated, 'index.json')))[name].keyId, 'fixture-key')

    const images = await (await request('/__gw/gen-images')).json()
    assert.ok(images.images.some((x) => x.name === name))
    const assets = await (await request('/__gw/assets?src=generated')).json()
    assert.ok(assets.images.some((x) => x.name === name))
    assert.deepEqual(Buffer.from(await (await request(`/__gw/gen-images/${name}`)).arrayBuffer()), PNG)
    assert.deepEqual(Buffer.from(await (await request(`/__gw/assets/file?src=generated&n=${name}`)).arrayBuffer()), PNG)

    const beforeMcp = tree(paths.root)
    const mcpOutput = execFileSync(process.execPath, [path.join(GW, 'mcp-server.mjs')], {
      env: { ...env, CGW_BASE: `http://127.0.0.1:${port}` }, cwd: temp, encoding: 'utf8', windowsHide: true,
      input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_generated_images' } }) + '\n', stdio: ['pipe', 'pipe', 'pipe']
    })
    assert.ok(JSON.parse(mcpOutput).result.content[0].text.includes(name))
    assert.deepEqual(tree(paths.root), beforeMcp, '独立 MCP 不应写入数据根')
    const indexFile = path.join(paths.generated, 'index.json')
    const savedIndex = fs.readFileSync(indexFile)
    fs.writeFileSync(indexFile, 'null')
    const refused = await request('/__gw/assets/files', { method: 'DELETE', body: JSON.stringify({ src: 'generated', names: [name] }) })
    assert.equal(refused.status, 400)
    assert.ok(fs.existsSync(path.join(paths.generated, name)), '索引损坏时不能删掉图片后再报错')
    fs.writeFileSync(indexFile, savedIndex)
    const deleted = await request('/__gw/assets/files', { method: 'DELETE', body: JSON.stringify({ src: 'generated', names: [name] }) })
    assert.equal((await deleted.json()).deleted, 1)
    assert.ok(!fs.existsSync(path.join(paths.generated, name)))
    assert.equal(JSON.parse(fs.readFileSync(path.join(paths.generated, 'index.json')))[name], undefined)
    assert.equal((await request(`/__gw/gen-images/${name}`)).status, 404)
    assert.deepEqual(tree(home), {}, '不在隔离 home 另写图库、凭据或缓存文件')
    assert.deepEqual(protectedFiles.map((f) => digest(path.join(GW, f))), beforeProgram)
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.stdin.write('stop\n')
    const timer = setTimeout(() => child.kill(), 3000)
    await exited
    clearTimeout(timer)
  }
  assert.ok(!fs.existsSync(path.join(paths.runtime, 'owner.lock')), '无 bridge 时正常退出释放锁')
})

test('bridge 实际生成分支：模拟上游 image 事件写入 D，图片可通过 bridge 读取', async (t) => {
  const { paths } = fixture(t)
  const lease = initializeStorage(paths, { protect() {} })
  try {
    const bridge = await import('../node_modules/chatgpt-bridge/dist/index.js')
    const { app, upstream } = bridge.createApp(bridge.loadConfig({ dataHome: paths.root }))
    const events = [
      { type: 'response.output_item.done', item: { type: 'image_generation_call', result: PNG.toString('base64') } },
      { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } } }
    ]
    upstream.call = async () => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } })
    const response = await app.request('/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'fixture' }], stream: false }) })
    assert.equal(response.status, 200)
    const result = await response.json()
    const files = fs.readdirSync(paths.generated).filter((f) => f.endsWith('.png'))
    assert.equal(files.length, 1, JSON.stringify(result))
    assert.ok(result.choices[0].message.content.includes(files[0]))
    assert.deepEqual(fs.readFileSync(path.join(paths.generated, files[0])), PNG)
    const served = await app.request(`/gen-images/${files[0]}`)
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), PNG)
  } finally { lease.release() }
})

test('managed 旧数据拒绝启动时不生成身份、不触碰原文件', (t) => {
  const { paths, env, temp } = fixture(t)
  fs.mkdirSync(paths.root)
  fs.writeFileSync(path.join(paths.root, 'auth.json'), 'KEEP')
  const before = tree(paths.root)
  assert.throws(() => execFileSync(process.execPath, [path.join(GW, 'launcher.mjs')], { cwd: temp, env, windowsHide: true, stdio: 'pipe', timeout: 5000 }), (error) => {
    assert.ok(error.stderr.toString().includes('DATA_MIGRATION_REQUIRED'))
    return true
  })
  assert.deepEqual(tree(paths.root), before)
})

test('远端 MCP 不检查或创建客户端的 managed 本机目录', (t) => {
  const { paths, env, temp } = fixture(t)
  const output = execFileSync(process.execPath, [path.join(GW, 'mcp-server.mjs')], {
    env: { ...env, CGW_BASE: 'http://192.0.2.10:4173' }, cwd: temp, encoding: 'utf8', windowsHide: true,
    input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_generated_images' } }) + '\n', stdio: ['pipe', 'pipe', 'pipe']
  })
  const response = JSON.parse(output)
  assert.equal(response.result.isError, true)
  assert.ok(response.result.content[0].text.includes('仅在网关主机本机可用'))
  assert.ok(!fs.existsSync(paths.root))
})
