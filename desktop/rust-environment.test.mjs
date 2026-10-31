import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { releaseRustEnvironment } from './rust-environment.mjs'
import { inspectDistributionPaths } from './distribution-paths.mjs'

test('distribution flags preserve encoded arguments and custom Windows tool locations', () => {
  const inherited = { CARGO_HOME: 'D:\\Build Tools\\cargo', RUSTUP_HOME: 'D:\\Build Tools\\rustup', CARGO_ENCODED_RUSTFLAGS: '-C\x1ftarget-feature=+sse2', RUSTFLAGS: '--invalid-lower-priority' }
  const env = releaseRustEnvironment('C:\\Users\\Example\\project', inherited, { home: 'C:\\Users\\Example', platform: 'win32' })
  const flags = env.CARGO_ENCODED_RUSTFLAGS.split('\x1f')
  assert.deepEqual(flags.slice(0, 2), ['-C', 'target-feature=+sse2'])
  assert.ok(flags.includes('--remap-path-prefix=D:\\Build Tools\\cargo=/build/cargo'))
  assert.ok(flags.includes('--remap-path-prefix=D:/Build Tools/cargo=/build/cargo'))
  assert.ok(flags.indexOf('--remap-path-prefix=C:\\Users\\Example=/build/home') < flags.indexOf('--remap-path-prefix=C:\\Users\\Example\\project=/build/codex-gateway'))
  assert.equal(env.RUSTFLAGS, undefined)
  assert.equal(inherited.RUSTFLAGS, '--invalid-lower-priority')
  const relative = releaseRustEnvironment('/repo', { CARGO_HOME: 'tools/cargo', RUSTUP_HOME: 'tools/rustup' }, { home: '/home/example', platform: 'linux' })
  assert.equal(relative.CARGO_HOME, '/repo/tools/cargo')
  assert.equal(relative.RUSTUP_HOME, '/repo/tools/rustup')
  assert.ok(relative.CARGO_ENCODED_RUSTFLAGS.split('\x1f').includes('--remap-path-prefix=/repo/tools/cargo=/build/cargo'))
  const mac = releaseRustEnvironment('/repo', {}, { home: '/Users/example', platform: 'darwin' })
  assert.equal(mac.CARGO_ENCODED_RUSTFLAGS.split('\x1f').at(-1), '-Cstrip=debuginfo')
  assert.ok(!env.CARGO_ENCODED_RUSTFLAGS.includes('strip=debuginfo'))
})

test('a real compiler removes an absolute source path with spaces from file! output', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-rust-remap-'))
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()))
    assert.ok(path.basename(root).startsWith('cgw-rust-remap-'))
    fs.rmSync(root, { recursive: true, force: true })
  })
  const source = path.join(root, 'source with spaces.rs'), binary = path.join(root, process.platform === 'win32' ? 'probe.exe' : 'probe')
  fs.writeFileSync(source, 'fn main() { println!("{}", file!()); }\n')
  const env = releaseRustEnvironment(root)
  execFileSync('rustc', [source, '--crate-name', 'path_probe', '-o', binary, ...env.CARGO_ENCODED_RUSTFLAGS.split('\x1f')], { env, windowsHide: true, timeout: 60000, stdio: 'pipe' })
  const result = execFileSync(binary, [], { encoding: 'utf8', windowsHide: true }).trim().replaceAll('\\', '/')
  assert.equal(result, '/build/codex-gateway/source with spaces.rs')
  assert.equal(fs.readFileSync(binary).includes(Buffer.from(root)), false)
  const binaryPaths = inspectDistributionPaths(binary, root, env)
  // This binary gate is used by package-windows.mjs. macOS linker OSO entries
  // and precompiled libraries are outside rustc's source-prefix remapping;
  // record that separate distribution concern without claiming it is solved.
  // https://doc.rust-lang.org/rustc/remap-source-paths.html#paths-generated-by-linkers
  if (process.platform === 'win32') assert.equal(binaryPaths.status, 'passed')
  else console.log('Non-Windows probe binary scan (informational, final distribution pending): ' + JSON.stringify(binaryPaths))
  const fixture = path.join(root, 'path-fixture.bin')
  for (const example of ['D:/other-builder/cache/src/lib.rs', 'D:\\other-builder\\cache\\src\\lib.rs']) {
    fs.writeFileSync(fixture, example)
    assert.equal(inspectDistributionPaths(fixture, root).status, 'failed')
  }
  fs.writeFileSync(fixture, 'tauri://localhost/src/lib.rs /rustc/commit/library/core/src/lib.rs')
  assert.equal(inspectDistributionPaths(fixture, root).status, 'passed')
})
