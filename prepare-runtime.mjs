import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { TARGETS, readRuntimeLock, selectRuntime, sha256, verifyRuntimeBytes, runtimeError } from './runtime-lock.mjs'
import { readArchiveMembers } from './runtime-archive.mjs'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
function checkArtifact(bytes, entry) {
  if (bytes.length !== entry.artifact.bytes || sha256(bytes) !== entry.artifact.sha256) {
    throw runtimeError('RUNTIME_ARCHIVE_HASH_MISMATCH', '运行时下载包大小或 SHA-256 与锁不一致；没有解包或更新锁')
  }
}
async function acquireArtifact(entry, { artifactPath, cacheDir, offline }) {
  const read = file => {
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.size !== entry.artifact.bytes) throw runtimeError('RUNTIME_ARCHIVE_HASH_MISMATCH', '运行时下载包文件类型或长度不匹配')
    const bytes = fs.readFileSync(file)
    checkArtifact(bytes, entry)
    return bytes
  }
  if (artifactPath) {
    return read(artifactPath)
  }
  const cached = path.join(cacheDir, entry.artifact.filename)
  if (fs.existsSync(cached)) {
    return read(cached) // Corrupt cache is a failure, never silently blessed/replaced.
  }
  if (offline) throw runtimeError('RUNTIME_CACHE_MISSING', '离线缓存中没有这个目标的运行时下载包')
  const response = await fetch(entry.artifact.url, { redirect: 'error', signal: AbortSignal.timeout(120_000) })
  if (!response.ok || !response.body) throw runtimeError('RUNTIME_DOWNLOAD_FAILED', `Node 官方下载失败：HTTP ${response.status}`)
  const chunks = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > entry.artifact.bytes) throw runtimeError('RUNTIME_ARCHIVE_HASH_MISMATCH', '下载包超过锁定长度')
    chunks.push(chunk)
  }
  const bytes = Buffer.concat(chunks, size)
  checkArtifact(bytes, entry)
  fs.mkdirSync(cacheDir, { recursive: true })
  const temporary = path.join(cacheDir, `.node-${crypto.randomUUID()}.part`)
  try {
    fs.writeFileSync(temporary, bytes, { flag: 'wx' })
    // Exclusive publish. Concurrent matching downloads are harmless; no cache overwrite.
    try { fs.linkSync(temporary, cached) } catch (error) { if (error.code !== 'EEXIST') throw error; checkArtifact(fs.readFileSync(cached), entry) }
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary) }
  return bytes
}

export async function prepareRuntime({ target, outDir, lockPath = path.join(ROOT, 'node-runtime.lock.json'),
  artifactPath, cacheDir = path.join(ROOT, 'release/runtime-cache'), offline = false }) {
  const entry = selectRuntime(readRuntimeLock(lockPath), target, { artifact: true })
  if (!outDir || fs.existsSync(outDir)) throw runtimeError('OUTPUT_EXISTS', '运行时输出目录必须是新的目录；已有产物请使用 --verify 校验')
  const archive = await acquireArtifact(entry, { artifactPath, cacheDir, offline })
  const members = readArchiveMembers(archive, entry.artifact.format, [entry.artifact.executable, entry.artifact.license])
  const binary = members.get(entry.artifact.executable), license = members.get(entry.artifact.license)
  verifyRuntimeBytes(binary, entry, target)
  if (license.length !== entry.artifact.licenseBytes || sha256(license) !== entry.artifact.licenseSha256) throw runtimeError('RUNTIME_LICENSE_MISMATCH', 'Node 许可证与锁不一致')
  fs.mkdirSync(path.dirname(path.resolve(outDir)), { recursive: true })
  fs.mkdirSync(outDir) // exclusive; never merge into an existing directory
  try {
    const executable = TARGETS[target].executable
    fs.writeFileSync(path.join(outDir, executable), binary, { flag: 'wx', mode: 0o755 })
    fs.chmodSync(path.join(outDir, executable), 0o755)
    fs.writeFileSync(path.join(outDir, 'LICENSE'), license, { flag: 'wx', mode: 0o644 })
    const info = { schemaVersion: 1, target, version: entry.version, executable, sha256: entry.sha256, bytes: entry.bytes,
      artifactSha256: entry.artifact.sha256, licenseSha256: entry.artifact.licenseSha256 }
    fs.writeFileSync(path.join(outDir, 'runtime.json'), JSON.stringify(info, null, 2) + '\n', { flag: 'wx' })
    return info
  } catch (error) {
    fs.rmSync(outDir, { recursive: true, force: true }) // only the directory just exclusively created
    throw error
  }
}
export function verifyPreparedRuntime({ target, outDir, lockPath = path.join(ROOT, 'node-runtime.lock.json') }) {
  const entry = selectRuntime(readRuntimeLock(lockPath), target, { artifact: true })
  if (!fs.lstatSync(outDir).isDirectory()) throw runtimeError('RESOURCE_INVALID', '运行时根目录不能是链接')
  for (const name of [TARGETS[target].executable, 'LICENSE', 'runtime.json']) {
    if (!fs.lstatSync(path.join(outDir, name)).isFile()) throw runtimeError('RUNTIME_ARCH_INVALID', '运行时产物必须是普通文件')
  }
  verifyRuntimeBytes(fs.readFileSync(path.join(outDir, TARGETS[target].executable)), entry, target)
  const license = fs.readFileSync(path.join(outDir, 'LICENSE'))
  if (license.length !== entry.artifact.licenseBytes || sha256(license) !== entry.artifact.licenseSha256) throw runtimeError('RUNTIME_LICENSE_MISMATCH', 'Node 许可证已改变')
  const info = JSON.parse(fs.readFileSync(path.join(outDir, 'runtime.json')))
  if (info.schemaVersion !== 1 || info.target !== target || info.version !== entry.version || info.executable !== TARGETS[target].executable ||
      info.sha256 !== entry.sha256 || info.bytes !== entry.bytes || info.artifactSha256 !== entry.artifact.sha256 || info.licenseSha256 !== entry.artifact.licenseSha256) throw runtimeError('RUNTIME_LOCK_INVALID', '运行时产物记录与锁不一致')
  if (process.platform !== 'win32' && !(fs.statSync(path.join(outDir, TARGETS[target].executable)).mode & 0o111)) throw runtimeError('RUNTIME_ARCH_INVALID', 'Node 缺少可执行权限')
  return info
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = name => process.argv.slice(2).find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3)
  try {
    const target = arg('target')
    const options = { target, outDir: path.resolve(arg('out') || path.join(ROOT, 'release/runtimes', target || 'unknown')),
      artifactPath: arg('artifact'), cacheDir: arg('cache') || path.join(ROOT, 'release/runtime-cache'), offline: process.argv.includes('--offline') }
    const info = process.argv.includes('--verify') ? verifyPreparedRuntime(options) : await prepareRuntime(options)
    console.log(`✓ ${info.target} ${info.version}：${info.sha256}（资源校验通过；不代表目标系统运行测试）`)
  } catch (error) { console.error(`✗ ${error.code || 'RUNTIME_PREPARE_FAILED'}：${error.message}`); process.exitCode = 1 }
}
