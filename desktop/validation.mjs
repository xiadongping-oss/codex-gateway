import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'

// Harness deadlines, not production recovery limits. Multi-launch checks include
// repeated resource hashing, WebView startup and the fixed recovery backoff.
export const NATIVE_SCENARIOS = Object.freeze({
  normal: 60_000, 'session-loss': 60_000, unresponsive: 120_000, 'channel-loss': 60_000, desktop: 60_000,
  'node-crash': 120_000, 'crash-loop': 180_000, 'shell-crash': 120_000, 'port-conflict': 60_000, migration: 240_000, 'migration-fresh': 180_000
})

export const HOSTS = Object.freeze({
  'win32-x64': 'x86_64-pc-windows-msvc',
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin'
})

export function validateHost({ platform, arch, rustHost, expected, translated = false, cargoTarget }) {
  const target = `${platform}-${arch}`
  if (!HOSTS[target]) throw new Error('不支持此构建主机，需 Windows x64 或原生 macOS ARM64/x64')
  if (expected && expected !== target) throw new Error(`验证目标不匹配：预期 ${expected}，实际 ${target}`)
  if (translated) throw new Error('请使用 Mac 原生架构的 Node 和 Rust，不通过 Rosetta 代替另一架构验收')
  if (rustHost !== HOSTS[target]) throw new Error(`Rust 主机架构不匹配：需要 ${HOSTS[target]}`)
  if (cargoTarget) throw new Error('请取消 CARGO_BUILD_TARGET；此入口验证原生主机，不执行交叉编译')
  return target
}

export function inspectHost(expected, { run = execFileSync, platform = process.platform, arch = process.arch, env = process.env } = {}) {
  const read = (exe, args) => run(exe, args, { encoding: 'utf8', timeout: 15_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const rust = read('rustc', ['-vV'])
  let translated = false, mac = null
  if (platform === 'darwin') {
    // -i permits the missing OID on native Intel, but command/permission failures
    // must not silently count as evidence that Rosetta is absent.
    const translation = read('/usr/sbin/sysctl', ['-in', 'sysctl.proc_translated'])
    if (!['', '0', '1'].includes(translation)) throw new Error('无法确认 Mac 原生架构')
    translated = translation === '1'
    const version = read('sw_vers', ['-productVersion'])
    if (!/^\d+\.\d+/.test(version) || Number(version.split('.')[0]) < 13) throw new Error('当前 Mac 验证基线要求 macOS 13 或更高版本，最低正式支持版本仍待实测')
    mac = { version, developerDirectory: read('xcode-select', ['-p']), sdkVersion: read('xcrun', ['--sdk', 'macosx', '--show-sdk-version']), clang: read('xcrun', ['clang', '--version']).split('\n')[0] }
  }
  const rustHost = /^host: (.+)$/m.exec(rust)?.[1]?.trim()
  const target = validateHost({ platform, arch, rustHost, expected, translated, cargoTarget: env.CARGO_BUILD_TARGET })
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('验证脚本需要 Node 22 或更高版本')
  return { target, rustHost, node: process.version, osRelease: os.release(), rust: rust.split('\n')[0], cargo: read('cargo', ['--version']), mac }
}

export function cargoEnvironment(root, build, inherited = process.env) {
  const expected = `${process.platform}-${process.arch}`
  const generated = fs.realpathSync(path.join(root, 'desktop/.generated'))
  const resources = fs.realpathSync(build.outDir)
  const relative = path.relative(generated, resources)
  if (build.target !== expected || !relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('构建记录不属于当前主机或本项目的独立资源目录')
  const manifest = path.join(resources, 'DESKTOP-RESOURCES.json')
  if (!fs.existsSync(manifest)) throw new Error('构建记录缺少资源清单')
  // Reconstruct the overlay instead of trusting arbitrary config from a previous run.
  const overlay = { bundle: { resources: { [path.relative(path.join(root, 'desktop/src-tauri'), resources).replaceAll('\\', '/') + '/']: 'gateway-resources/' } } }
  const env = { ...inherited, CGW_BUILD_RESOURCES: resources, CARGO_TARGET_DIR: path.join(root, 'desktop/src-tauri/target'), TAURI_CONFIG: JSON.stringify(overlay) }
  if (process.platform === 'darwin') env.MACOSX_DEPLOYMENT_TARGET = '13.0'
  return env
}

export class ValidationRun {
  constructor(directory, metadata = {}) {
    this.directory = path.resolve(directory)
    // Refuse to merge with older logs: every report represents exactly one run.
    fs.mkdirSync(path.dirname(this.directory), { recursive: true })
    fs.mkdirSync(this.directory)
    this.report = { schemaVersion: 1, startedAt: new Date().toISOString(), status: 'running', scope: 'build_and_core_tests', ...metadata,
      acceptance: { nativeUi: 'not_run', realOAuth: 'not_run', signedInstaller: 'not_run', macLockRecovery: 'not_run' }, stages: [] }
    this.save()
  }
  save() { fs.writeFileSync(path.join(this.directory, 'report.json'), JSON.stringify(this.report, null, 2) + '\n') }
  async step(name, executable, args, { cwd, env = process.env, timeout = 15 * 60_000 } = {}) {
    if (!/^[a-z0-9-]+$/.test(name) || this.report.status !== 'running') throw new Error('验证阶段无效或验证已结束')
    const stage = { name, status: 'running', startedAt: new Date().toISOString() }
    this.report.stages.push(stage); this.save()
    const fd = fs.openSync(path.join(this.directory, `${name}.log`), 'wx')
    let child, timer, expired = false
    try {
      const result = await new Promise((resolve, reject) => {
        child = spawn(executable, args, { cwd, env, windowsHide: true, stdio: ['ignore', fd, fd] })
        child.once('error', reject)
        child.once('exit', (code, signal) => resolve({ code, signal }))
        timer = setTimeout(() => { expired = true; child.kill('SIGKILL') }, timeout)
      })
      stage.exitCode = result.code; stage.signal = result.signal; stage.timedOut = expired
      if (expired || result.code !== 0) throw new Error(`${name} ${expired ? '超时' : '失败'}，详见对应日志`)
      stage.status = 'passed'
    } catch (error) {
      stage.status = 'failed'; this.report.status = 'failed'; throw error
    } finally {
      clearTimeout(timer); fs.closeSync(fd); stage.finishedAt = new Date().toISOString(); this.save()
    }
  }
  finish(status = 'passed') {
    if (!['passed', 'preflight_passed', 'failed'].includes(status) || (this.report.status === 'failed' && status !== 'failed')) throw new Error('失败的验证不能改记为通过')
    this.report.status = status; this.report.finishedAt = new Date().toISOString(); this.save()
  }
}
