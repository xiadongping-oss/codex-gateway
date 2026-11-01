// Native macOS diagnostic probes and a read-only release-binary gate.
// No existing executable is stripped, re-signed or launched by --binary.
// Only the tiny probes created in the new report directory are executed.
// https://doc.rust-lang.org/rustc/remap-source-paths.html#paths-generated-by-linkers
// https://doc.rust-lang.org/rustc/codegen-options/index.html#strip
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { releaseRustEnvironment } from './rust-environment.mjs'
import { inspectDistributionPaths } from './distribution-paths.mjs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
for (const arg of args) if (!arg.startsWith('--report-dir=') && !arg.startsWith('--binary=')) throw new Error(`Unknown option: ${arg}`)
const option = name => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) throw new Error('Native macOS ARM64 or x64 required')
if (!option('report-dir')) throw new Error('--report-dir=<new directory inside project output> is required')
const directory = path.resolve(option('report-dir')), output = path.resolve(root, 'output')
const relative = path.relative(output, directory)
if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Report directory must be inside project output')
fs.mkdirSync(path.dirname(directory), { recursive: true })
fs.mkdirSync(directory)
const env = releaseRustEnvironment(root)
const prefixes = [
  [env.CARGO_HOME, '<cargo-home>'], [env.RUSTUP_HOME, '<rustup-home>'],
  [directory, '<report>'], [root, '<workspace>'], [os.homedir(), '<user-home>']
].sort((a, b) => b[0].length - a[0].length)
const sanitize = text => prefixes.reduce((value, [prefix, replacement]) => value.replaceAll(prefix, replacement), text)
const report = { schemaVersion: 1, target: `darwin-${process.arch}`, status: 'running', probes: [],
  distribution: option('binary') ? 'pending' : 'not_requested',
  scope: 'Link-time debug stripping probes; optional read-only real binary gate. No Developer ID signing or app runtime acceptance.' }
const save = () => fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n')
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
function run(command, argv) {
  return execFileSync(command, argv, { cwd: root, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
}
function inspect(binary, name) {
  const before = hash(binary)
  const architecture = run('xcrun', ['lipo', '-archs', binary]).trim()
  assert.equal(architecture, process.arch === 'arm64' ? 'arm64' : 'x86_64', 'Executable must match the native CI architecture')
  const nm = run('xcrun', ['nm', '-ap', binary])
  const libraries = run('xcrun', ['otool', '-L', binary])
  const commands = run('xcrun', ['otool', '-l', binary])
  for (const [suffix, content] of [['nm', nm], ['libraries', libraries], ['load-commands', commands]]) {
    fs.writeFileSync(path.join(directory, `${name}-${suffix}.txt`), sanitize(content))
  }
  const signed = /\bLC_CODE_SIGNATURE\b/.test(commands)
  if (signed) run('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', binary])
  assert.equal(hash(binary), before, 'Inspection must not change the executable')
  return { sha256: before, bytes: fs.statSync(binary).size, architecture,
    paths: inspectDistributionPaths(binary, root, env),
    osoSymbols: (nm.match(/\bOSO\b/g) || []).length,
    signature: signed ? 'existing_signature_verified' : 'unsigned',
    libraries: libraries.split('\n').slice(1).map(line => line.trim()).filter(Boolean) }
}
save()
try {
  const rust = run('rustc', ['-vV'])
  assert.match(rust, new RegExp(`^host: ${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin$`, 'm'))
  const translated = run('/usr/sbin/sysctl', ['-in', 'sysctl.proc_translated']).trim()
  assert.ok(['', '0'].includes(translated), 'Rosetta cannot replace a native architecture check')
  report.tools = { rust: rust.split('\n')[0], sdk: run('xcrun', ['--sdk', 'macosx', '--show-sdk-version']).trim(),
    developerDirectory: sanitize(run('xcode-select', ['-p']).trim()) }
  const source = path.join(directory, 'source with spaces.rs')
  fs.writeFileSync(source, 'fn main() { let n: i32 = (0..8).collect::<Vec<i32>>().iter().sum(); println!("{}|{}", file!(), n); }\n', { flag: 'wx' })
  const expected = `/build/codex-gateway/${path.relative(root, source).split(path.sep).join('/')}|28`
  const baseFlags = env.CARGO_ENCODED_RUSTFLAGS.split('\x1f')
  const variants = [
    ['baseline', ['-Cstrip=none']],
    ['strip-debuginfo', ['-Cstrip=debuginfo']],
    // A comparison only: one OSO prefix cannot cover unrelated custom homes.
    ['oso-prefix', ['-Cstrip=none', '-Clink-arg=-Xlinker', '-Clink-arg=-oso_prefix', '-Clink-arg=-Xlinker', `-Clink-arg=${os.homedir()}`]]
  ]
  for (const [name, flags] of variants) {
    const binary = path.join(directory, name)
    run('rustc', [source, '--crate-name', 'distribution_probe', '-o', binary, ...baseFlags, '-Copt-level=3', '-Cdebuginfo=0', ...flags])
    const item = { name, ...inspect(binary, name) }
    // Only execute our own fixed, credential-free probe, never --binary.
    assert.equal(run(binary, []).trim(), expected)
    item.runtime = 'passed'
    report.probes.push(item); save()
  }
  const [baseline, stripped] = report.probes
  assert.equal(stripped.paths.status, 'passed', 'Stripped probe still contains local build paths')
  assert.equal(stripped.osoSymbols, 0, 'Stripped probe still contains OSO debug symbols')
  assert.deepEqual(stripped.libraries, baseline.libraries, 'Debug stripping must preserve dynamic library dependencies')
  report.probeConclusion = 'link_time_strip_debuginfo_passed'
  if (option('binary')) {
    const binary = fs.realpathSync(path.resolve(option('binary')))
    assert.ok(fs.lstatSync(binary).isFile(), 'Release executable must be a regular file')
    report.distribution = inspect(binary, 'release'); save()
    assert.equal(report.distribution.paths.status, 'passed', 'Release binary still contains local build paths')
    assert.equal(report.distribution.osoSymbols, 0, 'Release binary still contains OSO debug symbols')
    report.status = 'release_binary_gate_passed'
  } else report.status = 'probes_passed_release_not_checked'
} catch (error) {
  report.status = 'failed'
  report.error = sanitize(String(error.message))
  if (error.stderr) fs.writeFileSync(path.join(directory, 'failure-stderr.txt'), sanitize(String(error.stderr)))
  process.exitCode = 1
} finally {
  report.finishedAt = new Date().toISOString(); save()
  console.log(JSON.stringify({ status: report.status, target: report.target, report: path.relative(root, path.join(directory, 'report.json')) }))
}
