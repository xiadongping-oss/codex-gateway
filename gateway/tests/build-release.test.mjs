// 打包链路的回归测试（node --test）
//
// 为什么需要它：`--verify-zip` / `--verify-build` / 运行时锁 这三道「发布闸门」
// 守的是「发给别人的唯一凭证」。过去它们只被手工负样本验证过一次，本身没有测试——
// 重构 build-release.mjs 时，闸门可能静默失效，而坏包照样发得出去。
// 这与「测试全绿但其实没测到」是同一类风险。
//
// 做法：脚本用 `path.dirname(fileURLToPath(import.meta.url))` 推导 ROOT，
// 所以把这些测试放进一个临时「假仓库」里跑同一份脚本，就能完全控制
// package.json / 锁文件 / 目录树，而不碰真产物（release/ 不会被写）。
//
// 依赖：造 zip 用 python（build-release 的 --verify-zip 本身也依赖 unzip 或 python，
// 这里沿用同一前提；两者都缺时下面的 precheck 会明确报错，不是静默跳过）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')
const SCRIPT = path.join(REPO, 'build-release.mjs')
const VER = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf-8')).version
const NAME = `codex-gateway-v${VER}`

// ---------- 临时目录与清理 ----------
const TMP = []
function tmpdir(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `cgw-${tag}-`))
  TMP.push(d)
  return d
}
process.on('exit', () => {
  for (const d of TMP) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch {}
  }
})

// ---------- 跑脚本，拿退出码与合并输出 ----------
// execFileSync 在非零退出时抛错，这里统一成 { code, out }，避免每个用例写 try/catch。
function run(script, args, opts = {}) {
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...opts
    })
    return { code: 0, out: stdout }
  } catch (e) {
    return { code: typeof e.status === 'number' ? e.status : 1, out: `${e.stdout || ''}${e.stderr || ''}` }
  }
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

// ---------- 整棵树的哈希（可复现性用） ----------
// 按「相对路径 + 内容」排序后串联，所以不受目录遍历顺序与仓库绝对路径影响：
// 两个不同临时目录里打出的相同产物，哈希必须相等。
function treeHash(dir) {
  const files = []
  ;(function walk(d) {
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n)
      if (fs.statSync(p).isDirectory()) walk(p)
      else files.push(p)
    }
  })(dir)
  files.sort()
  const h = createHash('sha256')
  for (const f of files) {
    h.update(path.relative(dir, f).split(path.sep).join('/'))
    h.update('\0')
    h.update(fs.readFileSync(f))
    h.update('\0')
  }
  return h.digest('hex')
}

// 固定时间戳：不固定的话 BUILD-INFO.builtAt 每次都变，任何两次构建都无法比对。
const EPOCH = '1700000000'
const withEpoch = { ...process.env, SOURCE_DATE_EPOCH: EPOCH }

test('构建：只在 staging 固化补丁，记录指纹且不修改工作区依赖', () => {
  const { root } = fakeRepo()
  const source = path.join(root, 'gateway/node_modules/chatgpt-bridge/dist/cli.js')
  const before = fs.readFileSync(source)
  const result = run(path.join(root, 'build-release.mjs'), ['--no-runtime'], { env: withEpoch })
  assert.equal(result.code, 0, result.out)
  const stage = path.join(root, 'release/staging', NAME)
  const info = JSON.parse(fs.readFileSync(path.join(stage, 'BUILD-INFO.json')))
  for (const name of ['cli', 'index']) {
    const actual = fs.readFileSync(path.join(stage, `gateway/node_modules/chatgpt-bridge/dist/${name}.js`))
    assert.equal(actual.toString(), `// patched ${name}\n`)
    assert.equal(info.bridge.files[`${name}.js`], sha256(actual))
  }
  assert.equal(info.bridge.version, '0.3.0')
  assert.deepEqual(fs.readFileSync(source), before)
  assert.ok(!fs.existsSync(path.join(stage, 'prepare-bridge.mjs')), '运行包不分发补丁写入工具')
})

for (const [label, extra, expected] of [
  ['快照损坏', { 'gateway/patches/index.patched.js': '// corrupt\n' }, /快照内容不匹配/],
  ['依赖版本漂移', { 'gateway/node_modules/chatgpt-bridge/package.json': '{"name":"chatgpt-bridge","version":"0.4.0"}' }, /版本不匹配/],
  ['补丁清单损坏', { 'gateway/patches/manifest.json': '{}' }, /清单格式无效/]
]) {
  test(`构建：${label} 必须阻断发行`, () => {
    const { root } = fakeRepo({ extra })
    const result = run(path.join(root, 'build-release.mjs'), ['--no-runtime'])
    assert.notEqual(result.code, 0, result.out)
    assert.match(result.out, expected)
    assert.ok(!fs.existsSync(path.join(root, 'release/staging', NAME, 'BUILD-INFO.json')))
  })
}

test('构建：快照缺失必须失败，不能依赖工作区已打补丁的 dist', () => {
  const { root } = fakeRepo()
  fs.unlinkSync(path.join(root, 'gateway/patches/cli.patched.js'))
  const result = run(path.join(root, 'build-release.mjs'), ['--no-runtime'])
  assert.notEqual(result.code, 0, result.out)
  assert.match(result.out, /快照缺失/)
})

test('依赖清理：剔除已审查的测试/示例，保留许可证、运行映射和同名运行目录', () => {
  const excluded = [
    '@modelcontextprotocol/sdk/dist/cjs/examples/server/sample.js',
    '@modelcontextprotocol/sdk/dist/esm/examples/server/sample.js.map',
    'json-schema-traverse/spec/fixtures/schema.js', 'object-inspect/example/circular.js',
    'qs/test/index.js', 'zod/src/v4/core/tests/index.ts'
  ]
  const retained = [
    '@modelcontextprotocol/sdk/LICENSE', '@modelcontextprotocol/sdk/NOTICE',
    '@modelcontextprotocol/sdk/dist/esm/server/index.js.map',
    'json-schema-traverse/index.js', 'json-schema-traverse/LICENSE',
    'unrelated/examples/runtime.js', 'unrelated/fixtures/runtime.json',
    'json-schema-traverse/specification/runtime.js'
  ]
  const extra = Object.fromEntries([...excluded, ...retained].map(rel => [`gateway/node_modules/${rel}`, '// fixture\n']))
  const { root, script } = fakeRepo({ extra })
  const result = run(script, ['--no-runtime'])
  assert.equal(result.code, 0, result.out)
  for (const rel of excluded) {
    assert.ok(!fs.existsSync(path.join(stagingOf(root), 'gateway/node_modules', rel)), rel)
    assert.ok(fs.existsSync(path.join(root, 'gateway/node_modules', rel)), 'source remains untouched')
  }
  for (const rel of retained) assert.ok(fs.existsSync(path.join(stagingOf(root), 'gateway/node_modules', rel)), rel)
})

// ---------- 造一个 zip（内容用 python 打包，条目为普通目录结构） ----------
function makeZip(zipPath, files) {
  const stage = tmpdir('zip')
  for (const [name, data] of Object.entries(files)) {
    const p = path.join(stage, name)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, data)
  }
  const code = [
    'import zipfile, os, sys',
    'base, out = sys.argv[1], sys.argv[2]',
    "z = zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, 6)",
    'for r, _, fs_ in os.walk(base):',
    '    for f in fs_:',
    '        p = os.path.join(r, f)',
    "        z.write(p, os.path.relpath(p, base).replace(os.sep, '/'))",
    'z.close()'
  ].join('\n')
  execFileSync('python', ['-c', code, stage, zipPath], { encoding: 'utf-8' })
  return zipPath
}

// ---------- 假仓库：满足 REQUIRED 清单，让脚本能跑过完整性校验 ----------
// 少了任何一个文件，脚本都会停在「缺少关键文件」，被测的结构自检根本执行不到——
// 那种用例看起来在测，其实什么都没测。
//
// eol='crlf' 用于模拟 core.autocrlf=true 的机器：所有文本按 CRLF 落地。
// 「同一源码在不同 git 配置下打出不同字节」正是这一轮要堵的东西，
// 所以必须有一个专门用它来跑的用例。
function fakeRepo({ lockSha, extra = {}, eol = 'lf' } = {}) {
  const root = tmpdir('repo')
  const w = (rel, data) => {
    const p = path.join(root, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    const out = eol === 'crlf'
      ? data.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')
      : data
    fs.writeFileSync(p, out)
  }
  w('package.json', JSON.stringify({ name: 'codex-gateway', version: VER }))
  w('README.md', '# r\n')
  w('QUICK-START.md', '# q\n')
  w('gateway/launcher.mjs', '//\n')
  w('gateway/bridge-pool.mjs', '//\n')
  w('gateway/gallery.html', '<html></html>')
  w('gateway/setup.html', '<html></html>')
  w('gateway/start-unix.sh', '#!/bin/sh\necho ok\n')          // LF：合规
  w('gateway/service/start-gateway.vbs', '@echo off\r\n')      // CRLF：合规
  w('gateway/service/stop-gateway.vbs', '@echo off\r\n')
  w('gateway/service/run-gateway.cmd', '@echo off\r\n')
  w('gateway/service/install-app.vbs', "\x27 installer\r\n")   // REQUIRED 清单里的一键安装/卸载
  w('gateway/service/uninstall-app.vbs', "\x27 uninstaller\r\n")
  w('gateway/service-unix/_common.sh', '#!/bin/sh\necho ok\n')   // LF：合规
  w('gateway/service-unix/start-gateway.sh', '#!/bin/sh\necho ok\n')
  w('gateway/service-unix/run-gateway.sh', '#!/bin/sh\necho ok\n')
  w('gateway/service-unix/stop-gateway.sh', '#!/bin/sh\necho ok\n')
  w('gateway/service-unix/install-autostart.sh', '#!/bin/sh\necho ok\n')
  w('gateway/service-unix/uninstall-autostart.sh', '#!/bin/sh\necho ok\n')
  w('gateway/node_modules/chatgpt-bridge/package.json', JSON.stringify({ name: 'chatgpt-bridge', version: '0.3.0' }))
  const bridgeFiles = {}
  for (const name of ['cli', 'index']) {
    const patched = `// patched ${name}\n`
    w(`gateway/node_modules/chatgpt-bridge/dist/${name}.js`, '// original\n')
    w(`gateway/patches/${name}.patched.js`, patched)
    bridgeFiles[`${name}.js`] = sha256(patched)
  }
  w('gateway/patches/manifest.json', JSON.stringify({ schemaVersion: 1, package: 'chatgpt-bridge', version: '0.3.0', files: bridgeFiles }))
  w('gateway/bridge-patches.mjs', fs.readFileSync(path.join(REPO, 'gateway/bridge-patches.mjs'), 'utf8'))
  w('runtime-lock.mjs', fs.readFileSync(path.join(REPO, 'runtime-lock.mjs'), 'utf8'))
  w('prepare-bridge.mjs', fs.readFileSync(path.join(REPO, 'prepare-bridge.mjs'), 'utf8'))
  w('dependency-resources.mjs', fs.readFileSync(path.join(REPO, 'dependency-resources.mjs'), 'utf8'))
  w('frontend/dist/index.html', '<html></html>')
  w('docs/lan-kit/INSTALL.md', '# i\n')
  w('docs/lan-kit/setup-client.mjs', '//\n')
  w('docs/lan-kit/AGENT-PROMPT.md', '# a\n')
  if (lockSha !== undefined) {
    w('node-runtime.lock.json', JSON.stringify({
      version: 'v22.0.0', sha256: lockSha, bytes: 1,
      platform: 'win32', arch: 'x64', note: 'test'
    }))
  }
  for (const [rel, data] of Object.entries(extra)) w(rel, data)
  fs.copyFileSync(SCRIPT, path.join(root, 'build-release.mjs'))
  return { root, script: path.join(root, 'build-release.mjs') }
}

// ---------- precheck：造 zip 需要 python ----------
// 缺工具时明确报错而不是让一堆用例神秘失败——这与脚本本身的取向一致。
function requirePython() {
  try {
    execFileSync('python', ['-c', 'print(1)'], { encoding: 'utf-8' })
  } catch {
    throw new Error('需要 python 才能构造测试用 zip（build-release 的 --verify-zip 同样依赖 unzip 或 python）')
  }
}

// ======================= --verify-zip =======================
test('verify-zip：结构合规的包应通过', () => {
  requirePython()
  const zip = makeZip(path.join(tmpdir('z'), 'ok.zip'), {
    [`${NAME}/README.md`]: '# hi\n',
    [`${NAME}/gateway/start-unix.sh`]: '#!/bin/sh\necho ok\n'
  })
  const r = run(SCRIPT, ['--verify-zip', `--zip=${zip}`])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /zip 校验通过/)
})

test('verify-zip：两个顶层目录必须被拦住（v1.1.0 坏包复现）', () => {
  requirePython()
  const zip = makeZip(path.join(tmpdir('z'), 'two-tops.zip'), {
    [`${NAME}/README.md`]: '# hi\n',
    'codex-gateway-v0.0.1/README.md': '# old\n'
  })
  const r = run(SCRIPT, ['--verify-zip', `--zip=${zip}`])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /顶层应恰好 1 个目录/)
})

test('verify-zip：顶层目录名与当前版本不符要被拦住', () => {
  requirePython()
  const zip = makeZip(path.join(tmpdir('z'), 'wrong-name.zip'), {
    'codex-gateway-v0.0.0/README.md': '# hi\n'
  })
  const r = run(SCRIPT, ['--verify-zip', `--zip=${zip}`])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /顶层目录应为/)
})

test('verify-zip：gateway/data 整类目录要被拦住', () => {
  requirePython()
  const zip = makeZip(path.join(tmpdir('z'), 'has-data.zip'), {
    [`${NAME}/README.md`]: '# hi\n',
    [`${NAME}/gateway/data/call-logs.json`]: '[]'
  })
  const r = run(SCRIPT, ['--verify-zip', `--zip=${zip}`])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /禁止内容/)
})

test('verify-zip：api-keys.json 要被拦住', () => {
  requirePython()
  const zip = makeZip(path.join(tmpdir('z'), 'has-keys.zip'), {
    [`${NAME}/README.md`]: '# hi\n',
    [`${NAME}/gateway/api-keys.json`]: '{}'
  })
  const r = run(SCRIPT, ['--verify-zip', `--zip=${zip}`])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /禁止内容/)
})

test('verify-zip：压缩后 .sh 变成 CRLF 要被拦住', () => {
  requirePython()
  const zip = makeZip(path.join(tmpdir('z'), 'crlf-sh.zip'), {
    [`${NAME}/gateway/start-unix.sh`]: '#!/bin/sh\r\necho ok\r\n'
  })
  const r = run(SCRIPT, ['--verify-zip', `--zip=${zip}`])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /CRLF/)
})

test('verify-zip：包不存在时明确报错，而不是静默通过', () => {
  const r = run(SCRIPT, ['--verify-zip', `--zip=${path.join(tmpdir('z'), 'nope.zip')}`])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /找不到/)
})

// ======================= --verify-build =======================
// 全部在假仓库里跑同一份脚本：ROOT 变了，锁文件也跟着走，所以能精确构造
// 「声明 / 实物 / 锁」三者的任意不一致，而不必真造一个 83MB 的 node.exe。
const FAKE_NODE = Buffer.alloc(256)
FAKE_NODE.writeUInt16LE(0x5a4d); FAKE_NODE.writeUInt32LE(64, 60)
FAKE_NODE.writeUInt32LE(0x4550, 64); FAKE_NODE.writeUInt16LE(0x8664, 68); FAKE_NODE.writeUInt16LE(0x20b, 88)
const NODE_SHA = sha256(FAKE_NODE)

function buildZipWithNode(zipPath, { declaredSha, nodeBuf = FAKE_NODE, infoVersion = VER }) {
  const info = {
    app: 'codex-gateway',
    version: infoVersion,
    builtAt: '2026-01-01T00:00:00.000Z',
    git: { commit: 'abc1234', dirty: false },
    node: { version: 'v22.0.0', sha256: declaredSha, bytes: nodeBuf.length, source: 'process.execPath' },
    totalsExcludingSelf: { files: 1, bytes: nodeBuf.length }
  }
  return makeZip(zipPath, {
    [`${NAME}/BUILD-INFO.json`]: JSON.stringify(info, null, 2),
    [`${NAME}/gateway/service/node/node.exe`]: nodeBuf,
    [`${NAME}/README.md`]: '# hi\n'
  })
}

test('verify-build：声明与实物与锁三方一致时通过', () => {
  requirePython()
  const { script } = fakeRepo({ lockSha: NODE_SHA })
  const zip = buildZipWithNode(path.join(tmpdir('z'), 'good.zip'), { declaredSha: NODE_SHA })
  const r = run(script, ['--verify-build', `--zip=${zip}`])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /构建指纹校验通过/)
})

test('verify-build：声明的哈希与包内实物不符要被拦住', () => {
  requirePython()
  // 锁文件与「声明」一致，只有实物被换掉 —— 隔离出「声明 vs 实物」这一层
  const { script } = fakeRepo({ lockSha: NODE_SHA })
  const zip = buildZipWithNode(path.join(tmpdir('z'), 'swapped.zip'), {
    declaredSha: NODE_SHA,
    nodeBuf: Buffer.from('a different runtime')
  })
  const r = run(script, ['--verify-build', `--zip=${zip}`])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /内嵌 node.exe 哈希与声明不符/)
})

test('verify-build：声明与锁文件不一致要被拦住（可复现构建的底线）', () => {
  requirePython()
  const wrongLock = 'f'.repeat(64)
  const { script } = fakeRepo({ lockSha: wrongLock })
  const zip = buildZipWithNode(path.join(tmpdir('z'), 'drift.zip'), { declaredSha: NODE_SHA })
  const r = run(script, ['--verify-build', `--zip=${zip}`])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /与锁文件不一致/)
})

test('verify-build：老包没有 BUILD-INFO 时明确报「无法核对」，而不是假装通过', () => {
  requirePython()
  const { script } = fakeRepo({ lockSha: NODE_SHA })
  const zip = makeZip(path.join(tmpdir('z'), 'legacy.zip'), {
    [`${NAME}/README.md`]: '# hi\n',
    [`${NAME}/gateway/service/node/node.exe`]: FAKE_NODE
  })
  const r = run(script, ['--verify-build', `--zip=${zip}`])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /无法核对/)
})

// ======================= 结构自检（打包阶段） =======================
// 用 --no-runtime 跳过内置 node 的 83MB 复制，结构检查照样会跑。
test('结构自检：干净的树应通过（证明闸门不会假警报）', () => {
  const { root, script } = fakeRepo()
  const r = run(script, ['--no-runtime'], { cwd: root })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /staging 就绪/)
})

// 注意这一组的分工：
//   · 数据目录/密钥在**复制阶段**就被 GATEWAY_DENY 滤掉，根本进不了 staging；
//     所以「结构自检拦住 gateway/data」这种用例永远触发不到——那不是测试，是摆设。
//     这里断言的是真正会错的不变量：这些东西**没有**被复制进去。
//   · staging 上的 DIR_DENY 是第二层（防的正是「有人把 GATEWAY_DENY 改坏了」），
//     它由 mutate.mjs 的变异体验证：摘掉复制黑名单后，构建必须在结构自检处中止。
test('复制阶段：用户数据 / 密钥 / 测试套件不会被带进 staging', () => {
  const { root, script } = fakeRepo({
    extra: {
      'gateway/data/call-logs.json': '[]',
      'gateway/api-keys.json': '{}',
      'gateway/accounts/acc.json': '{}',
      'gateway/logs/launcher.log': 'x',
      'gateway/tests/audit.mjs': '// attack payload'
    }
  })
  const r = run(script, ['--no-runtime'], { cwd: root })
  assert.equal(r.code, 0, r.out)

  const staging = path.join(root, 'release', 'staging', NAME)
  for (const rel of ['gateway/data', 'gateway/api-keys.json', 'gateway/accounts', 'gateway/logs', 'gateway/tests']) {
    assert.ok(!fs.existsSync(path.join(staging, rel)), `不应被复制进发布包：${rel}`)
  }
})

test('结构自检：打包机个人绝对路径要被拦住（v1.2.0 泄露家目录同类）', () => {
  const { root, script } = fakeRepo({
    extra: { 'gateway/notes.md': '安装路径：C:\\Users\\realperson\\codex-gateway\n' }
  })
  const r = run(script, ['--no-runtime'], { cwd: root })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /个人绝对路径/)
})

test('结构自检：文档里的占位符用户名不应误报（否则自检会被当狼来了）', () => {
  const { root, script } = fakeRepo({
    extra: { 'gateway/notes.md': '示例：C:\\Users\\me\\codex-gateway 与 C:\\Users\\<用户名>\\x\n' }
  })
  const r = run(script, ['--no-runtime'], { cwd: root })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /staging 就绪/)
})

test('结构自检：源里 CRLF 的 .sh 会被规范化，产物必须是 LF', () => {
  // 行为变更记录：早先的策略是「发现 CRLF 的 .sh 就拒绝打包」；现在改为
  // 构建阶段直接规范化（否则 autocrlf=true 的机器根本打不出包）。
  // 守护的不变量没变——**发布包里的 .sh 必须是 LF**，否则 bash 报
  // `set: $'\r': invalid option`，入库即不可用。
  const { root, script } = fakeRepo({
    extra: { 'gateway/extra.sh': '#!/bin/sh\r\necho hi\r\n' }
  })
  const r = run(script, ['--no-runtime'], { cwd: root })
  assert.equal(r.code, 0, r.out)
  const buf = fs.readFileSync(path.join(root, 'release', 'staging', NAME, 'gateway/extra.sh'))
  assert.ok(!buf.includes(0x0d), '.sh 进包前必须被转成 LF')
  assert.equal(buf.toString(), '#!/bin/sh\necho hi\n')
})

// ======================= 包根一键入口 =======================
// 入口必须在 zip 解压后的顶层——要让用户钻进 gateway\service\ 才能装的包，不算一键安装。
test('构建：包根生成 install.vbs / uninstall.vbs，与 service 副本字节一致且为 CRLF', () => {
  const { root, script } = fakeRepo()
  const r = run(script, ['--no-runtime'], { cwd: root })
  assert.equal(r.code, 0, r.out)
  const stage = path.join(root, 'release', 'staging', NAME)
  for (const [top, svc] of [
    ['install.vbs', 'gateway/service/install-app.vbs'],
    ['uninstall.vbs', 'gateway/service/uninstall-app.vbs']
  ]) {
    const topBuf = fs.readFileSync(path.join(stage, top))
    const svcBuf = fs.readFileSync(path.join(stage, svc))
    assert.ok(topBuf.equals(svcBuf), `${top} 必须与 ${svc} 字节一致`)
    assert.ok(topBuf.includes(0x0d), `${top} 必须是 CRLF（Windows 脚本）`)
  }
})

// ======================= 运行时锁（构建阶段） =======================
test('构建：内置运行时与锁文件不一致时中止，并给出两条出路', { skip: process.platform !== 'win32' || process.arch !== 'x64' }, () => {
  const { root, script } = fakeRepo({ lockSha: 'a'.repeat(64) })
  const r = run(script, [`--node=${process.execPath}`], { cwd: root })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /与锁文件不一致/)
  assert.match(r.out, /--write-lock/)
  assert.match(r.out, /--node=/)
})

test('构建：锁文件一致时通过，且 BUILD-INFO 不含绝对路径与主机名', { skip: process.platform !== 'win32' || process.arch !== 'x64' }, () => {
  const { root, script } = fakeRepo({ lockSha: sha256(fs.readFileSync(process.execPath)) })
  const r = run(script, [`--node=${process.execPath}`], { cwd: root })
  assert.equal(r.code, 0, r.out)

  const raw = fs.readFileSync(path.join(root, 'release', 'staging', NAME, 'BUILD-INFO.json'), 'utf-8')
  const info = JSON.parse(raw)
  assert.equal(info.version, VER)
  assert.equal(info.node.sha256, sha256(fs.readFileSync(process.execPath)))
  // v1.2.0 栽过的坑：构建指纹把打包者家目录带进了分发包
  assert.doesNotMatch(raw, /[A-Za-z]:[\\/]+Users[\\/]+[A-Za-z0-9._-]+/)
  assert.ok(!raw.includes(os.hostname()), 'BUILD-INFO 不应记录主机名')
})

function v2Lock(root, targets) {
  fs.writeFileSync(path.join(root, 'node-runtime.lock.json'), JSON.stringify({ schemaVersion: 2, targets }))
}
const nativeEntry = () => ({ version: process.version, platform: 'win32', arch: 'x64', bytes: fs.statSync(process.execPath).size, sha256: sha256(fs.readFileSync(process.execPath)) })
test('构建：v2 选择 Windows 目标，缺失记录或缺失锁不能放行', { skip: process.platform !== 'win32' || process.arch !== 'x64' }, () => {
  for (const targets of [null, {}, { 'darwin-arm64': { ...nativeEntry(), platform: 'darwin', arch: 'arm64' } }]) {
    const { root, script } = fakeRepo()
    if (targets) v2Lock(root, targets)
    const r = run(script, [`--node=${process.execPath}`])
    assert.notEqual(r.code, 0, r.out)
    assert.match(r.out, /锁缺失|锁缺少目标/)
  }
})
test('构建：v2 版本和大小都受锁约束', { skip: process.platform !== 'win32' || process.arch !== 'x64' }, () => {
  for (const change of [{ bytes: 1 }, { version: 'v22.0.0' }]) {
    const { root, script } = fakeRepo()
    v2Lock(root, { 'win32-x64': { ...nativeEntry(), ...change } })
    const r = run(script, [`--node=${process.execPath}`])
    assert.notEqual(r.code, 0, r.out); assert.match(r.out, /版本或大小与锁文件不一致/)
  }
})
test('构建：显式更新 Windows 锁不覆盖 Mac 记录，可补齐缺失目标', { skip: process.platform !== 'win32' || process.arch !== 'x64' }, () => {
  const { root, script } = fakeRepo()
  const mac = { version: 'v22.22.2', platform: 'darwin', arch: 'arm64', bytes: 123, sha256: 'a'.repeat(64) }
  v2Lock(root, { 'darwin-arm64': mac })
  const r = run(script, [`--node=${process.execPath}`, '--write-lock'])
  assert.equal(r.code, 0, r.out)
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'node-runtime.lock.json')))
  assert.deepEqual(lock.targets['darwin-arm64'], mac)
  assert.deepEqual(lock.targets['win32-x64'], nativeEntry())
})
test('构建：错误架构在尝试执行之前拒绝，不能把 Mac Node 改名 node.exe', () => {
  const { root, script } = fakeRepo()
  const node = Buffer.alloc(256)
  node.writeUInt32LE(0xfeedfacf); node.writeUInt32LE(0x0100000c, 4); node.writeUInt32LE(2, 12)
  fs.writeFileSync(path.join(root, 'foreign.exe'), node)
  const r = run(script, ['--node=' + path.join(root, 'foreign.exe')])
  assert.notEqual(r.code, 0); assert.match(r.out, /Windows x64/)
})

// ======================= 换行符规范化（可复现构建） =======================
// 为什么单独一组：只锁 node.exe 不足以谈可复现。core.autocrlf=true 的机器
// checkout 出来是 CRLF、false 的是 LF，同一 commit 打出的 zip 字节就不同。
// 本仓库实测确有混态（apikeys.mjs / assets.mjs / account-quota.mjs 曾是全 CRLF），
// 所以构建阶段必须主动规范化，而不是依赖每台机器的 git 配置。
const stagingOf = (root) => path.join(root, 'release', 'staging', NAME)

test('换行符：CRLF 源文件被打成 LF（不靠 git 配置，靠构建脚本）', () => {
  const { root, script } = fakeRepo({ extra: { 'gateway/crlf.mjs': 'const a = 1\r\nconst b = 2\r\n' } })
  const r = run(script, ['--no-runtime'], { cwd: root })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /换行符规范化：修正 \d+ 个文件/)

  const buf = fs.readFileSync(path.join(stagingOf(root), 'gateway/crlf.mjs'))
  assert.ok(!buf.includes(0x0d), 'CRLF 源文件应在产物中被规范化为 LF')
  assert.equal(buf.toString(), 'const a = 1\nconst b = 2\n')
})

test('换行符：node_modules 里的 CRLF 同样要规范化', () => {
  // 曾经的实现跳过整个 node_modules（为了避免绝对路径误报），
  // 顺带连换行符也没查 —— vendored 包自带的 CRLF 就这样进了产物。
  const { root, script } = fakeRepo({
    extra: { 'gateway/node_modules/somepkg/index.js': 'module.exports = 1\r\n' }
  })
  const r = run(script, ['--no-runtime'], { cwd: root })
  assert.equal(r.code, 0, r.out)
  const buf = fs.readFileSync(path.join(stagingOf(root), 'gateway/node_modules/somepkg/index.js'))
  assert.ok(!buf.includes(0x0d), 'node_modules 内的 CRLF 也必须被规范化')
})

test('换行符：Windows 脚本若为 LF，要补成 CRLF', () => {
  const { root, script } = fakeRepo({ extra: { 'gateway/extra.cmd': '@echo off\nrem x\n' } })
  const r = run(script, ['--no-runtime'], { cwd: root })
  assert.equal(r.code, 0, r.out)
  const buf = fs.readFileSync(path.join(stagingOf(root), 'gateway/extra.cmd'))
  assert.equal(buf.toString(), '@echo off\r\nrem x\r\n')
})

test('换行符：被二次转换的损坏文件（\\r\\r\\n）必须中止，不得静默"修复"', () => {
  // 把孤立 CR 当换行会把 \r\r\n 变成 \n\n，凭空多一个空行、静默改变内容。
  // 那类文件通常是被某个工具二次转换过，属于需要人看的情况，打包器不该替它猜。
  const { root, script } = fakeRepo({ extra: { 'gateway/broken.mjs': 'const a = 1\r\r\nconst b = 2\r\n' } })
  const r = run(script, ['--no-runtime'], { cwd: root })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /换行符不符/)
})

// ======================= 可复现构建 =======================
test('可复现：同一源码连续两次构建，产物逐字节一致', () => {
  const { root, script } = fakeRepo()
  assert.equal(run(script, ['--no-runtime'], { cwd: root, env: withEpoch }).code, 0)
  const first = treeHash(stagingOf(root))
  assert.equal(run(script, ['--no-runtime'], { cwd: root, env: withEpoch }).code, 0)
  assert.equal(treeHash(stagingOf(root)), first, '两次构建产物必须完全一致')
})

test('可复现：LF 工作区与 CRLF 工作区打出的包必须一致（本轮核心）', () => {
  // 这一条就是「同一版本号、不同二进制」的正面回击：
  // 两台机器只有 git 换行符配置不同，产物哈希必须相同。
  const lf = fakeRepo({ eol: 'lf' })
  const crlf = fakeRepo({ eol: 'crlf' })
  assert.equal(run(lf.script, ['--no-runtime'], { cwd: lf.root, env: withEpoch }).code, 0)
  assert.equal(run(crlf.script, ['--no-runtime'], { cwd: crlf.root, env: withEpoch }).code, 0)

  assert.equal(
    treeHash(stagingOf(crlf.root)),
    treeHash(stagingOf(lf.root)),
    'CRLF 工作区与 LF 工作区打出的包不一致 —— 可复现构建失效'
  )
})

test('可复现：SOURCE_DATE_EPOCH 非法时明确报错，而不是悄悄用当前时间', () => {
  const { root, script } = fakeRepo()
  const r = run(script, ['--no-runtime'], { cwd: root, env: { ...process.env, SOURCE_DATE_EPOCH: 'not-a-number' } })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /SOURCE_DATE_EPOCH/)
})
