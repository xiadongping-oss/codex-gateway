import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { TARGETS, sha256, executableTarget, selectRuntime, verifyRuntimeBytes } from '../../runtime-lock.mjs'
import { readArchiveMembers } from '../../runtime-archive.mjs'
import { prepareRuntime, verifyPreparedRuntime } from '../../prepare-runtime.mjs'
import { GATEWAY_FILES, DESKTOP_TOOLS, prepareDesktop, verifyDesktop } from '../../prepare-desktop.mjs'

test('committed three-target lock agrees with the archived official checksums', () => {
  const root = fileURLToPath(new URL('../..', import.meta.url))
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'node-runtime.lock.json')))
  const checksums = fs.readFileSync(path.join(root, 'docs/runtime/node-v22.22.2-SHASUMS256.txt'))
  assert.equal(sha256(checksums), lock.sources['v22.22.2'].checksumsSha256)
  assert.deepEqual(Object.keys(lock.targets).sort(), Object.keys(TARGETS).sort())
  for (const target of Object.keys(TARGETS)) {
    const entry = selectRuntime(lock, target, { artifact: true })
    assert.ok(checksums.toString().split('\n').some(line => line.trim() === `${entry.artifact.sha256}  ${entry.artifact.filename}`))
  }
  assert.ok(checksums.toString().includes(`${lock.targets['win32-x64'].sha256}  win-x64/node.exe`))
})

function binary(target) {
  const b = Buffer.alloc(256)
  if (target === 'win32-x64') { b.writeUInt16LE(0x5a4d); b.writeUInt32LE(64, 60); b.writeUInt32LE(0x4550, 64); b.writeUInt16LE(0x8664, 68); b.writeUInt16LE(0x20b, 88) }
  else { b.writeUInt32LE(0xfeedfacf); b.writeUInt32LE(target === 'darwin-arm64' ? 0x0100000c : 0x01000007, 4); b.writeUInt32LE(2, 12) }
  return b
}
function tar(entries) {
  const parts = []
  for (const [name, bytes, type = '0'] of entries) {
    const h = Buffer.alloc(512)
    h.write(name); h.write('0000755\0', 100); h.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124)
    h.fill(32, 148, 156); h.write(type, 156)
    const sum = [...h].reduce((a, b) => a + b, 0)
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
    parts.push(h, bytes, Buffer.alloc((512 - bytes.length % 512) % 512))
  }
  return gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]))
}
function zip(entries) {
  const local = [], central = []; let offset = 0
  for (const [name, bytes] of entries) {
    const n = Buffer.from(name), h = Buffer.alloc(30), c = Buffer.alloc(46)
    h.writeUInt32LE(0x04034b50); h.writeUInt32LE(bytes.length, 18); h.writeUInt32LE(bytes.length, 22); h.writeUInt16LE(n.length, 26)
    c.writeUInt32LE(0x02014b50); c.writeUInt32LE(bytes.length, 20); c.writeUInt32LE(bytes.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42)
    local.push(h, n, bytes); central.push(c, n); offset += h.length + n.length + bytes.length
  }
  const dir = Buffer.concat(central), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, dir, end])
}
function fixture(t, target = 'win32-x64') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-runtime-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const cacheDir = path.join(root, 'cache'), outDir = path.join(root, 'prepared'), lockPath = path.join(root, 'node-runtime.lock.json')
  fs.mkdirSync(cacheDir)
  const version = 'v22.22.2', platform = TARGETS[target].platform, arch = TARGETS[target].arch
  const prefix = `node-${version}-${platform === 'win32' ? 'win' : 'darwin'}-${arch}`, format = platform === 'win32' ? 'zip' : 'tar.gz'
  const executable = `${prefix}/${platform === 'win32' ? 'node.exe' : 'bin/node'}`, licensePath = `${prefix}/LICENSE`
  const bin = binary(target), license = Buffer.from('Fixture license\n')
  const artifact = (format === 'zip' ? zip : tar)([[executable, bin], [licensePath, license]])
  const filename = `${prefix}.${format}`
  const entry = { version, platform, arch, sha256: sha256(bin), bytes: bin.length,
    artifact: { filename, format, url: `https://nodejs.org/dist/${version}/${filename}`, sha256: sha256(artifact), bytes: artifact.length,
      executable, license: licensePath, licenseSha256: sha256(license), licenseBytes: license.length } }
  const lock = { schemaVersion: 2, targets: { [target]: entry } }
  const save = () => fs.writeFileSync(lockPath, JSON.stringify(lock))
  save(); fs.writeFileSync(path.join(cacheDir, filename), artifact)
  return { root, target, outDir, lockPath, cacheDir, offline: true, entry, lock, save, bin, artifact }
}

for (const target of Object.keys(TARGETS)) test(`${target}: offline preparation validates headers/hashes and preserves lock`, async t => {
  const f = fixture(t, target), before = fs.readFileSync(f.lockPath)
  assert.equal(executableTarget(f.bin), target)
  const info = await prepareRuntime(f)
  assert.equal(info.target, target)
  assert.deepEqual(fs.readFileSync(path.join(f.outDir, TARGETS[target].executable)), f.bin)
  assert.deepEqual(verifyPreparedRuntime(f), info)
  assert.deepEqual(fs.readFileSync(f.lockPath), before)
  await assert.rejects(prepareRuntime(f), { code: 'OUTPUT_EXISTS' })
  fs.appendFileSync(path.join(f.outDir, TARGETS[target].executable), 'corrupt')
  assert.throws(() => verifyPreparedRuntime(f), { code: 'RUNTIME_HASH_MISMATCH' })
})
for (const [label, mutate] of [
  ['missing target', f => { f.lock.targets = {} }],
  ['wrong platform', f => { f.entry.platform = 'darwin' }],
  ['wrong architecture', f => { f.entry.arch = 'arm64' }],
  ['wrong URL host', f => { f.entry.artifact.url = 'https://example.com/node.zip' }],
  ['archive path escape', f => { f.entry.artifact.executable = '../../node.exe' }],
  ['invalid digest', f => { f.entry.sha256 = 'a' }],
  ['missing artifact', f => { delete f.entry.artifact }],
  ['unsupported schema', f => { f.lock.schemaVersion = 3 }]
]) test(`lock rejects ${label} before output`, async t => {
  const f = fixture(t); mutate(f); f.save()
  await assert.rejects(prepareRuntime(f), { code: 'RUNTIME_LOCK_INVALID' })
  assert.equal(fs.existsSync(f.outDir), false)
})
test('target is mandatory and is never inferred from host or another record', t => {
  const f = fixture(t)
  for (const target of [undefined, 'linux-x64', 'x64', '../../escape']) assert.throws(() => selectRuntime(f.lock, target), { code: 'TARGET_UNSUPPORTED' })
  assert.throws(() => selectRuntime(f.entry, 'win32-x64'), { code: 'RUNTIME_LOCK_INVALID' })
  assert.equal(selectRuntime(f.entry, 'win32-x64', { legacy: true }), f.entry)
})
test('wrong executable architecture fails even when its hash was blessed in the lock', t => {
  const f = fixture(t), wrong = binary('darwin-arm64')
  assert.throws(() => verifyRuntimeBytes(wrong, { sha256: sha256(wrong), bytes: wrong.length }, 'win32-x64'), { code: 'RUNTIME_ARCH_INVALID' })
  for (const bytes of [Buffer.alloc(4), Buffer.alloc(256), Buffer.from('not a runtime'), Buffer.from('cafebabe'.repeat(20), 'hex')]) assert.throws(() => executableTarget(bytes), { code: 'RUNTIME_ARCH_INVALID' })
})
test('corrupt cache is not redownloaded, repaired, extracted, or written to the lock', async t => {
  const f = fixture(t), file = path.join(f.cacheDir, f.entry.artifact.filename), before = fs.readFileSync(f.lockPath)
  const damaged = Buffer.from(f.artifact); damaged[20] ^= 1; fs.writeFileSync(file, damaged)
  await assert.rejects(prepareRuntime(f), { code: 'RUNTIME_ARCHIVE_HASH_MISMATCH' })
  assert.equal(fs.existsSync(f.outDir), false); assert.deepEqual(fs.readFileSync(file), damaged); assert.deepEqual(fs.readFileSync(f.lockPath), before)
})
test('missing offline artifact fails without creating output', async t => {
  const f = fixture(t); fs.unlinkSync(path.join(f.cacheDir, f.entry.artifact.filename))
  await assert.rejects(prepareRuntime(f), { code: 'RUNTIME_CACHE_MISSING' })
  assert.equal(fs.existsSync(f.outDir), false)
})
test('binary and license hashes independently gate output', async t => {
  for (const key of ['sha256', 'licenseSha256']) {
    const f = fixture(t)
    if (key === 'sha256') f.entry.sha256 = 'f'.repeat(64)
    else f.entry.artifact.licenseSha256 = 'f'.repeat(64)
    f.save()
    await assert.rejects(prepareRuntime(f), { code: key === 'sha256' ? 'RUNTIME_HASH_MISMATCH' : 'RUNTIME_LICENSE_MISMATCH' })
    assert.equal(fs.existsSync(f.outDir), false)
  }
})
for (const format of ['zip', 'tar.gz']) test(`archive ${format}: duplicates/missing entries rejected, unrelated traversal never extracted`, () => {
  const pack = format === 'zip' ? zip : tar, content = Buffer.from('safe')
  assert.throws(() => readArchiveMembers(pack([['node', content], ['node', content]]), format, ['node']), { code: 'RUNTIME_ARCHIVE_INVALID' })
  assert.throws(() => readArchiveMembers(pack([['other', content]]), format, ['node']), { code: 'RUNTIME_ARCHIVE_INVALID' })
  assert.throws(() => readArchiveMembers(Buffer.alloc(10), format, ['node']), { code: 'RUNTIME_ARCHIVE_INVALID' })
  assert.deepEqual([...readArchiveMembers(pack([['../../outside', content], ['node', content]]), format, ['node']).keys()], ['node'])
})
test('archive tar: wanted symlink and PAX path override rejected', () => {
  for (const type of ['2', '1', 'x', 'g', 'L']) assert.throws(() => readArchiveMembers(tar([['node', Buffer.from('target'), type]]), 'tar.gz', ['node']), { code: 'RUNTIME_ARCHIVE_INVALID' })
})

function resources(f) {
  const put = (name, bytes) => { const file = path.join(f.root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes) }
  for (const file of GATEWAY_FILES) put('gateway/' + file, file.endsWith('.json') ? '{}' : '// fixture\r\n')
  for (const file of DESKTOP_TOOLS) put('desktop/' + file, '// fixture\r\n')
  put('package.json', '{"name":"codex-gateway","version":"1.0.0"}')
  put('frontend/dist/index.html', '<html>fixture</html>\r\n')
  put('docs/lan-kit/INSTALL.md', 'fixture\r\n')
  put('gateway/node_modules/chatgpt-bridge/package.json', '{"name":"chatgpt-bridge","version":"0.3.0"}')
  const files = {}
  for (const name of ['cli', 'index']) {
    put(`gateway/node_modules/chatgpt-bridge/dist/${name}.js`, '// original\n')
    put(`gateway/patches/${name}.patched.js`, '// patched\r\n')
    files[`${name}.js`] = sha256(Buffer.from('// patched\n'))
  }
  put('gateway/patches/manifest.json', JSON.stringify({ schemaVersion: 1, package: 'chatgpt-bridge', version: '0.3.0', files }))
  for (const file of ['admin-token.json', 'api-keys.json', '.gw-config.json', 'accounts/secret.json', 'data/call-logs.json', 'logs/test.log', 'service/node/node.exe', 'tests/private.mjs', 'random-unlisted.mjs']) put('gateway/' + file, 'DO-NOT-DISTRIBUTE')
  return put
}
test('desktop resources: allowlist, shared build-time bridge patches, immutable source and deterministic output', async t => {
  const f = fixture(t); resources(f)
  const original = fs.readFileSync(path.join(f.root, 'gateway/node_modules/chatgpt-bridge/dist/cli.js'))
  const info = await prepareDesktop(f)
  assert.equal(info.phase, 'pre-signing')
  assert.equal(info.node, 'runtime/node.exe')
  assert.equal(fs.readFileSync(path.join(f.outDir, 'gateway/node_modules/chatgpt-bridge/dist/cli.js'), 'utf8'), '// patched\n')
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'gateway/node_modules/chatgpt-bridge/dist/cli.js')), original)
  assert.equal(fs.existsSync(path.join(f.outDir, 'gateway/admin-token.json')), false)
  assert.equal(fs.existsSync(path.join(f.outDir, 'gateway/service')), false)
  assert.equal(fs.existsSync(path.join(f.outDir, 'gateway/patches/cli.patched.js')), false)
  for (const file of Object.keys(info.files)) assert.equal(fs.readFileSync(path.join(f.outDir, file)).includes(Buffer.from('DO-NOT-DISTRIBUTE')), false)
  assert.equal(verifyDesktop(f).target, f.target)
  const second = await prepareDesktop({ ...f, outDir: path.join(f.root, 'second') })
  assert.deepEqual(second, info)
  fs.appendFileSync(path.join(f.outDir, 'frontend/dist/index.html'), 'modified')
  assert.throws(() => verifyDesktop(f), { code: 'RESOURCE_HASH_MISMATCH' })
})
test('desktop resource failure never merges into an existing output or leaves partial output', async t => {
  const f = fixture(t), put = resources(f)
  fs.mkdirSync(f.outDir); fs.writeFileSync(path.join(f.outDir, 'owned'), 'keep')
  await assert.rejects(prepareDesktop(f), { code: 'OUTPUT_EXISTS' })
  assert.equal(fs.readFileSync(path.join(f.outDir, 'owned'), 'utf8'), 'keep')
  put('gateway/node_modules/native.node', Buffer.alloc(100))
  const output = path.join(f.root, 'failed')
  await assert.rejects(prepareDesktop({ ...f, outDir: output }), { code: 'RESOURCE_NATIVE_DEPENDENCY' })
  assert.equal(fs.existsSync(output), false)
  await assert.rejects(prepareDesktop({ ...f, outDir: path.join(f.root, 'gateway/resources') }), { code: 'RESOURCE_INVALID' })
})

for (const target of Object.keys(TARGETS)) test(`${target}: dependency cleanup preserves runtime assets, licenses and maps`, async t => {
  const f = fixture(t, target), put = resources(f)
  const excluded = [
    '@modelcontextprotocol/sdk/dist/esm/examples/server/sample.js',
    '@modelcontextprotocol/sdk/dist/cjs/examples/server/sample.js.map',
    'json-schema-traverse/spec/fixtures/schema.js', 'json-schema-traverse/spec/index.spec.js',
    'object-inspect/example/circular.js', 'qs/test/index.js', 'zod/src/v4/core/tests/index.ts'
  ]
  const retained = [
    '@modelcontextprotocol/sdk/LICENSE', '@modelcontextprotocol/sdk/NOTICE',
    '@modelcontextprotocol/sdk/dist/esm/server/index.js',
    '@modelcontextprotocol/sdk/dist/esm/server/index.js.map',
    'json-schema-traverse/LICENSE', 'json-schema-traverse/index.js',
    'unrelated/examples/runtime.js', 'unrelated/fixtures/runtime.json',
    'json-schema-traverse/specification/runtime.js'
  ]
  for (const rel of [...excluded, ...retained]) put(`gateway/node_modules/${rel}`, '// fixture\n')
  const manifest = await prepareDesktop(f)
  for (const rel of excluded) {
    assert.ok(!manifest.files[`gateway/node_modules/${rel}`], rel)
    assert.ok(fs.existsSync(path.join(f.root, 'gateway/node_modules', rel)), 'source remains untouched')
  }
  for (const rel of retained) assert.ok(manifest.files[`gateway/node_modules/${rel}`], rel)
  assert.equal(verifyDesktop(f).target, target)
})
test('desktop resources reject missing required files and damaged bridge snapshots', async t => {
  for (const type of ['missing', 'patch']) {
    const f = fixture(t), put = resources(f)
    if (type === 'missing') fs.unlinkSync(path.join(f.root, 'gateway/desktop-entry.mjs'))
    else put('gateway/patches/index.patched.js', 'damaged')
    await assert.rejects(prepareDesktop(f))
    assert.equal(fs.existsSync(f.outDir), false)
  }
})
