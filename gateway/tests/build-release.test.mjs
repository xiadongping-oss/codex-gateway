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
function fakeRepo({ lockSha, extra = {} } = {}) {
  const root = tmpdir('repo')
  const w = (rel, data) => {
    const p = path.join(root, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, data)
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
  w('gateway/node_modules/chatgpt-bridge/dist/cli.js', '//\n')  // node_modules 不参与路径扫描
  w('gateway/patches/keep.patch', '')
  w('frontend/dist/index.html', '<html></html>')
  w('docs/lan-kit/INSTALL.md', '# i\n')
  w('docs/lan-kit/setup-client.mjs', '//\n')
  w('docs/lan-kit/AGENT-PROMPT.md', '# a\n')
  if (lockSha !== undefined) {
    w('node-runtime.lock.json', JSON.stringify({
      version: 'v22.0.0', sha256: lockSha, bytes: 1,
      platform: process.platform, arch: process.arch, note: 'test'
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
const FAKE_NODE = Buffer.from('not a real node runtime, just bytes for hashing')
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

test('结构自检：.sh 为 CRLF 要被拦住', () => {
  const { root, script } = fakeRepo({
    extra: { 'gateway/extra.sh': '#!/bin/sh\r\necho hi\r\n' }
  })
  const r = run(script, ['--no-runtime'], { cwd: root })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /换行符不符/)
})

// ======================= 运行时锁（构建阶段） =======================
test('构建：内置运行时与锁文件不一致时中止，并给出两条出路', () => {
  const { root, script } = fakeRepo({ lockSha: 'a'.repeat(64) })
  const r = run(script, [`--node=${process.execPath}`], { cwd: root })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /与锁文件不一致/)
  assert.match(r.out, /--write-lock/)
  assert.match(r.out, /--node=/)
})

test('构建：锁文件一致时通过，且 BUILD-INFO 不含绝对路径与主机名', () => {
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
