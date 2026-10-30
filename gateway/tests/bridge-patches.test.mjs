import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { prepareBridge } from '../../prepare-bridge.mjs'
import { bridgeSha256, verifyBridgePatched } from '../bridge-patches.mjs'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-bridge-patch-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const put = (rel, data) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), data)
  }
  const files = {}
  for (const name of ['cli', 'index']) {
    const bytes = `// chatTools.convertChatToolsToResponses ${name}\nexport const patched = true\n`
    files[`${name}.js`] = bridgeSha256(bytes)
    put(`patches/${name}.patched.js`, bytes)
    put(`node_modules/chatgpt-bridge/dist/${name}.js`, bytes)
  }
  put('patches/manifest.json', JSON.stringify({ schemaVersion: 1, package: 'chatgpt-bridge', version: '0.3.0', files }))
  put('node_modules/chatgpt-bridge/package.json', JSON.stringify({ name: 'chatgpt-bridge', version: '0.3.0' }))
  return { root, put }
}

// 比对内容、文件集合和修改时间，成功和失败路径都不能自修复或留下临时文件。
function tree(dir) {
  const result = {}
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name)
      if (entry.isDirectory()) walk(file)
      else result[path.relative(dir, file)] = [bridgeSha256(fs.readFileSync(file)), fs.statSync(file).mtimeMs]
    }
  }
  walk(dir)
  return result
}

// 执行 launcher 的实际入口函数，隔离 HTTP 服务和真实账号，捕获进程创建边界。
function launcherFunction(name, globals) {
  const source = fs.readFileSync(new URL('../launcher.mjs', import.meta.url), 'utf8')
  const match = source.match(new RegExp(`^function ${name}\\([^]*?^}`, 'm'))
  assert.ok(match, `launcher 必须保留 ${name} 入口`)
  return vm.runInNewContext(`(${match[0]})`, globals)
}

test('启动入口：损坏时返回失败，实例拉起前拒绝创建进程或目录', (t) => {
  const { root, put } = fixture(t)
  put('node_modules/chatgpt-bridge/dist/index.js', '// corrupt\n')
  const before = tree(root)
  let spawned = 0
  let created = 0
  const logs = []
  const globals = {
    verifyBridgePatched: (options) => verifyBridgePatched({ ...options, gatewayDir: root }),
    BRIDGE_CLI: path.join(root, 'node_modules/chatgpt-bridge/dist/cli.js'),
    pushLog: (line) => logs.push(line), gwConfig: {},
    bridgeLabel: () => 'test', bridgeAuthFile: () => 'unused-auth.json',
    process: { env: {} }, IMAGE_MODEL: 'test', BRIDGE_ARGS: [], BRIDGE_NODE: 'unused-node', path,
    referenceRootDir: () => root,
    bridgeStorageEnv: (env) => env, storagePaths: {}, storageLease: null,
    validateExternalPath: (value) => value,
    fs: { mkdirSync: () => { created++ } },
    spawn: () => { spawned++; return { stdout: { on() {} }, stderr: { on() {} } } }
  }
  const result = launcherFunction('startBridge', globals)()
  assert.equal(result.ok, false)
  assert.match(result.msg, /index.js 内容不匹配/)
  assert.throws(() => launcherFunction('spawnBridgeProcess', globals)('test', 1234), /index.js 内容不匹配/)
  assert.equal(spawned, 0)
  assert.equal(created, 0)
  assert.ok(logs.some((line) => line.includes('校验失败')))
  assert.deepEqual(tree(root), before)
  prepareBridge(root, root)
  launcherFunction('spawnBridgeProcess', globals)('test', 1234)
  assert.equal(spawned, 1, '构建准备修复后允许拉起实例')
})

test('构建准备：仓库真实快照可以组装到独立目标并通过运行校验', (t) => {
  const { root } = fixture(t)
  const result = prepareBridge(root)
  assert.deepEqual(verifyBridgePatched({ gatewayDir: root }), result.manifest)
  assert.equal(result.manifest.version, '0.3.0')
})

test('运行校验：不依赖补丁快照，文件只读时也通过且不改写资源', (t) => {
  const { root } = fixture(t)
  for (const name of ['cli', 'index']) fs.unlinkSync(path.join(root, `patches/${name}.patched.js`))
  const paths = Object.keys(tree(root)).map((rel) => path.join(root, rel))
  for (const file of paths) fs.chmodSync(file, 0o444)
  try {
    const before = tree(root)
    assert.equal(verifyBridgePatched({ gatewayDir: root }).version, '0.3.0')
    assert.deepEqual(tree(root), before)
  } finally {
    for (const file of paths) fs.chmodSync(file, 0o644)
  }
})

for (const name of ['cli', 'index']) {
  for (const mode of ['missing', 'corrupt', 'crlf']) {
    test(`运行校验：${name} ${mode} 明确失败且不恢复`, (t) => {
      const { root } = fixture(t)
      const file = path.join(root, `node_modules/chatgpt-bridge/dist/${name}.js`)
      if (mode === 'missing') fs.unlinkSync(file)
      else if (mode === 'corrupt') fs.appendFileSync(file, '// marker 仍在，但完整内容已损坏\n')
      else fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\n/g, '\r\n'))
      const before = tree(root)
      assert.throws(() => verifyBridgePatched({ gatewayDir: root }), { code: 'BRIDGE_PATCH_INVALID' })
      assert.deepEqual(tree(root), before)
    })
  }
}

for (const [description, file, content] of [
  ['版本不匹配', 'node_modules/chatgpt-bridge/package.json', '{"name":"chatgpt-bridge","version":"0.4.0"}'],
  ['清单缺失', 'patches/manifest.json', null],
  ['清单损坏', 'patches/manifest.json', '{'],
  ['清单为空', 'patches/manifest.json', 'null'],
  ['清单条目缺失', 'patches/manifest.json', '{"schemaVersion":1,"package":"chatgpt-bridge","version":"0.3.0","files":{}}'],
  ['依赖元信息缺失', 'node_modules/chatgpt-bridge/package.json', null]
]) {
  test(`运行校验：${description} 拒绝运行且不修改文件`, (t) => {
    const { root, put } = fixture(t)
    if (content === null) fs.unlinkSync(path.join(root, file))
    else put(file, content)
    const before = tree(root)
    assert.throws(() => verifyBridgePatched({ gatewayDir: root }), { code: 'BRIDGE_PATCH_INVALID' })
    assert.deepEqual(tree(root), before)
  })
}

test('运行校验：BRIDGE_CLI 指向的实际入口也受校验', (t) => {
  const { root } = fixture(t)
  const external = fixture(t)
  const cli = path.join(external.root, 'node_modules/chatgpt-bridge/dist/cli.js')
  assert.doesNotThrow(() => verifyBridgePatched({ gatewayDir: root, bridgeCli: cli }))
  fs.appendFileSync(cli, '// broken\n')
  assert.throws(() => verifyBridgePatched({ gatewayDir: root, bridgeCli: cli }), /cli.js 内容不匹配/)
})

test('构建准备：CRLF 快照生成 LF 文件，支持恢复缺失入口，重复执行内容稳定', (t) => {
  const source = fixture(t)
  const target = fixture(t)
  for (const name of ['cli', 'index']) {
    const snap = path.join(source.root, `patches/${name}.patched.js`)
    fs.writeFileSync(snap, fs.readFileSync(snap, 'utf8').replace(/\n/g, '\r\n'))
    fs.unlinkSync(path.join(target.root, `node_modules/chatgpt-bridge/dist/${name}.js`))
  }
  const before = tree(source.root)
  assert.equal(prepareBridge(target.root, source.root).addedFiles, 2)
  const first = verifyBridgePatched({ gatewayDir: target.root })
  assert.equal(prepareBridge(target.root, source.root).addedFiles, 0)
  assert.deepEqual(verifyBridgePatched({ gatewayDir: target.root }), first)
  assert.deepEqual(tree(source.root), before)
})

for (const mode of ['missing', 'corrupt', 'lone-cr', 'version']) {
  test(`构建准备：${mode} 在任何写入前失败`, (t) => {
    const source = fixture(t)
    const target = fixture(t)
    const snap = path.join(source.root, 'patches/index.patched.js')
    if (mode === 'missing') fs.unlinkSync(snap)
    else if (mode === 'version') target.put('node_modules/chatgpt-bridge/package.json', '{"name":"chatgpt-bridge","version":"0.4.0"}')
    else fs.appendFileSync(snap, mode === 'lone-cr' ? '\r' : '// damaged\n')
    const before = tree(target.root)
    assert.throws(() => prepareBridge(target.root, source.root), /bridge.*(快照|版本)/)
    assert.deepEqual(tree(target.root), before)
  })
}
