import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { HOSTS, validateHost, inspectHost, ValidationRun, cargoEnvironment } from './validation.mjs'

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-validation-'))
  t.after(() => {
    const actual = fs.realpathSync(root), parent = fs.realpathSync(os.tmpdir())
    assert.equal(path.dirname(actual), parent)
    assert.ok(path.basename(actual).startsWith('cgw-validation-'))
    fs.rmSync(actual, { recursive: true, force: true })
  })
  return root
}

test('host checks refuse wrong architecture, translation, cross-target and unsupported systems', () => {
  for (const [target, rustHost] of Object.entries(HOSTS)) {
    const [platform, arch] = target.split('-')
    assert.equal(validateHost({ platform, arch, rustHost, expected: target }), target)
    for (const change of [{ expected: 'foreign-target' }, { rustHost: 'foreign-rust' }, { translated: true }, { cargoTarget: rustHost }])
      assert.throws(() => validateHost({ platform, arch, rustHost, expected: target, ...change }))
  }
  assert.throws(() => validateHost({ platform: 'linux', arch: 'x64', rustHost: 'x86_64-unknown-linux-gnu' }))
})

test('Mac preflight requires usable SDK tools and records the real OS instead of inferring support', () => {
  const outputs = { 'rustc -vV': 'rustc 1.94.0\nhost: aarch64-apple-darwin', 'cargo --version': 'cargo 1.94.0', '/usr/sbin/sysctl -in sysctl.proc_translated': '0', 'sw_vers -productVersion': '15.7', 'xcode-select -p': '/Applications/Xcode.app/Contents/Developer', 'xcrun --sdk macosx --show-sdk-version': '15.5', 'xcrun clang --version': 'Apple clang version 17' }
  const run = (exe, args) => { const value = outputs[[exe, ...args].join(' ')]; if (value === undefined) throw new Error('missing tool'); return value }
  const options = { run, platform: 'darwin', arch: 'arm64', env: {} }
  assert.equal(inspectHost('darwin-arm64', options).mac.version, '15.7')
  outputs['/usr/sbin/sysctl -in sysctl.proc_translated'] = '1'
  assert.throws(() => inspectHost('darwin-arm64', options), /Rosetta/)
  delete outputs['/usr/sbin/sysctl -in sysctl.proc_translated']
  assert.throws(() => inspectHost('darwin-arm64', options), /missing tool/)
  outputs['/usr/sbin/sysctl -in sysctl.proc_translated'] = ''
  assert.equal(inspectHost('darwin-arm64', options).target, 'darwin-arm64')
  delete outputs['xcrun --sdk macosx --show-sdk-version']
  assert.throws(() => inspectHost('darwin-arm64', options), /missing tool/)
})

test('failed child stops validation and preserves a failed report, not a success marker', async t => {
  const root = temporary(t), directory = path.join(root, 'run')
  const run = new ValidationRun(directory)
  await assert.rejects(run.step('failure', process.execPath, ['-e', 'console.error("synthetic failure");process.exit(7)']))
  await assert.rejects(run.step('later', process.execPath, ['-e', 'process.exit(0)']))
  assert.throws(() => run.finish(), /不能改记为通过/)
  const report = JSON.parse(fs.readFileSync(path.join(directory, 'report.json')))
  assert.equal(report.status, 'failed'); assert.equal(report.stages.length, 1)
  assert.equal(report.stages[0].exitCode, 7)
  assert.equal(report.acceptance.nativeUi, 'not_run'); assert.equal(report.acceptance.realOAuth, 'not_run')
  assert.match(fs.readFileSync(path.join(directory, 'failure.log'), 'utf8'), /synthetic failure/)
  assert.throws(() => new ValidationRun(directory), /EEXIST/)
})

test('missing executables and timed-out owned children cannot produce passing stages', async t => {
  const root = temporary(t)
  const absent = new ValidationRun(path.join(root, 'absent'))
  await assert.rejects(absent.step('missing', path.join(root, 'missing-program'), []))
  assert.equal(absent.report.stages[0].status, 'failed')
  const timed = new ValidationRun(path.join(root, 'timeout'))
  await assert.rejects(timed.step('timeout', process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 100 }))
  assert.equal(timed.report.stages[0].timedOut, true)
})

test('cargo context refuses stale foreign resources and reconstructs its config', t => {
  const root = temporary(t), outDir = path.join(root, 'desktop/.generated/current')
  fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(path.join(outDir, 'DESKTOP-RESOURCES.json'), '{}')
  const target = `${process.platform}-${process.arch}`
  const env = cargoEnvironment(root, { target, outDir, overlay: { invalid: 'untrusted' } }, {})
  assert.equal(env.CGW_BUILD_RESOURCES, fs.realpathSync(outDir))
  assert.equal(JSON.stringify(JSON.parse(env.TAURI_CONFIG)).includes('untrusted'), false)
  assert.throws(() => cargoEnvironment(root, { target: 'wrong', outDir }, {}))
  assert.throws(() => cargoEnvironment(root, { target, outDir: root }, {}))
})
