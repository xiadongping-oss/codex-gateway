import fs from 'node:fs'
import crypto from 'node:crypto'

export const TARGETS = Object.freeze({
  'win32-x64': { platform: 'win32', arch: 'x64', executable: 'node.exe' },
  'darwin-arm64': { platform: 'darwin', arch: 'arm64', executable: 'node' },
  'darwin-x64': { platform: 'darwin', arch: 'x64', executable: 'node' }
})
export const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
export function runtimeError(code, message) { return Object.assign(new Error(message), { code }) }
const invalid = message => runtimeError('RUNTIME_LOCK_INVALID', message)
const hashOK = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)

export function readRuntimeLock(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { throw invalid('运行时锁文件缺失或无法解析') }
}
export function selectRuntime(lock, target, { artifact = false, legacy = false } = {}) {
  if (!TARGETS[target]) throw runtimeError('TARGET_UNSUPPORTED', `不支持的运行时目标：${target}`)
  if (!lock || typeof lock !== 'object') throw invalid('运行时锁文件缺失')
  let entry
  if (lock.schemaVersion === 2) entry = lock.targets?.[target]
  else if (legacy && lock.schemaVersion === undefined && `${lock.platform}-${lock.arch}` === target) entry = lock
  else throw invalid('运行时锁格式或目标不匹配；需要 schemaVersion 2')
  if (!entry) throw invalid(`运行时锁缺少目标：${target}`)
  const expected = TARGETS[target]
  if (entry.platform !== expected.platform || entry.arch !== expected.arch ||
      !/^v\d+\.\d+\.\d+$/.test(entry.version || '') || Number(entry.version.slice(1).split('.')[0]) < 22 ||
      !hashOK(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0) throw invalid(`目标 ${target} 的运行时记录无效`)
  if (artifact) {
    const a = entry.artifact, ext = entry.platform === 'win32' ? 'zip' : 'tar.gz'
    const prefix = `node-${entry.version}-${entry.platform === 'win32' ? 'win' : 'darwin'}-${entry.arch}`
    const filename = `${prefix}.${ext}`
    if (!a || a.filename !== filename || a.format !== ext ||
        a.url !== `https://nodejs.org/dist/${entry.version}/${filename}` || !hashOK(a.sha256) ||
        !Number.isSafeInteger(a.bytes) || a.bytes <= 0 || a.bytes > 256 * 1024 * 1024 ||
        a.executable !== `${prefix}/${entry.platform === 'win32' ? 'node.exe' : 'bin/node'}` ||
        a.license !== `${prefix}/LICENSE` || !hashOK(a.licenseSha256) || !Number.isSafeInteger(a.licenseBytes) || a.licenseBytes <= 0) throw invalid(`目标 ${target} 缺少完整且固定的官方发行文件记录`)
  }
  return entry
}

// Inspect headers, never execute a foreign or unverified runtime to identify it.
export function executableTarget(bytes) {
  const bad = () => { throw runtimeError('RUNTIME_ARCH_INVALID', '不是受支持的 Windows x64 或 macOS 单架构可执行文件') }
  if (bytes.length < 64) return bad()
  if (bytes.readUInt16LE(0) === 0x5a4d) {
    const pe = bytes.readUInt32LE(0x3c)
    if (pe > bytes.length - 26 || bytes.readUInt32LE(pe) !== 0x4550 ||
        bytes.readUInt16LE(pe + 4) !== 0x8664 || bytes.readUInt16LE(pe + 24) !== 0x20b) return bad()
    return 'win32-x64'
  }
  if (bytes.readUInt32LE(0) === 0xfeedfacf && bytes.readUInt32LE(12) === 2) {
    const cpu = bytes.readUInt32LE(4)
    if (cpu === 0x01000007) return 'darwin-x64'
    if (cpu === 0x0100000c) return 'darwin-arm64'
  }
  return bad()
}
export function verifyRuntimeBytes(bytes, entry, target) {
  if (executableTarget(bytes) !== target) throw runtimeError('RUNTIME_ARCH_INVALID', `可执行文件架构不匹配：要求 ${target}`)
  if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) throw runtimeError('RUNTIME_HASH_MISMATCH', '运行时大小或 SHA-256 与锁不一致')
}
