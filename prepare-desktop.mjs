// Pre-signing resource preparation only. No Tauri compiler, installer, or user data access.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareRuntime, verifyPreparedRuntime } from './prepare-runtime.mjs'
import { prepareBridge } from './prepare-bridge.mjs'
import { excludeDependencyResource } from './dependency-resources.mjs'
import { verifyBridgePatched } from './gateway/bridge-patches.mjs'
import { TARGETS, sha256, runtimeError, readRuntimeLock, selectRuntime } from './runtime-lock.mjs'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
export const DESKTOP_TOOLS = Object.freeze(['migration.mjs', 'migration-service.mjs'])
export const GATEWAY_FILES = Object.freeze([
  'account-quota.mjs', 'admin-auth.mjs', 'api-providers.mjs', 'apikeys.mjs', 'assets.mjs', 'atomic-write.mjs',
  'auth-core.mjs', 'bridge-patches.mjs', 'bridge-pool.mjs', 'call-logs.mjs', 'chat-tools.mjs', 'codex-official-login.mjs',
  'data-root.mjs', 'desktop-entry.mjs', 'desktop-protocol.mjs', 'desktop-ticket.mjs', 'failover.mjs', 'gallery.html',
  'image-size.mjs', 'lan-addr.mjs', 'launcher.mjs', 'mcp-server.mjs', 'model-catalog.mjs', 'package.json', 'port-util.mjs',
  'proxy-preload.mjs', 'proxy.mjs', 'ref-roots.mjs', 'secret-perms.mjs', 'setup.html', 'shutdown-manager.mjs',
  'storage-bootstrap.mjs', 'storage-init.mjs', 'storage-paths.mjs', 'work-tracker.mjs'
])
const TEXT = new Set(['.mjs', '.js', '.cjs', '.json', '.map', '.ts', '.html', '.css', '.svg', '.md', '.txt', '.yml', '.yaml'])
const DENY = new Set(['.bin', '.git', '.DS_Store', 'Thumbs.db', 'tests', 'test', '__tests__'])
function safeSource(file) {
  const stat = fs.lstatSync(file)
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw runtimeError('RESOURCE_INVALID', '资源树不允许链接或特殊文件')
  if (/\.(node|exe|dll|dylib|so)$/i.test(file)) throw runtimeError('RESOURCE_NATIVE_DEPENDENCY', '网关依赖中出现原生二进制，需要为目标平台单独准备')
  return stat
}
function copyFile(source, destination) {
  if (!safeSource(source).isFile()) throw runtimeError('RESOURCE_INVALID', '必需资源不是普通文件')
  let bytes = fs.readFileSync(source)
  if (TEXT.has(path.extname(source).toLowerCase()) || path.basename(source) === 'LICENSE') {
    bytes = Buffer.from(bytes.toString('latin1').replace(/\r\n/g, '\n'), 'latin1')
    if (bytes.includes(13)) throw runtimeError('RESOURCE_INVALID', '文本资源含孤立 CR')
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.writeFileSync(destination, bytes, { flag: 'wx', mode: 0o644 })
}
function copyTree(source, destination, dependencyRoot) {
  if (!safeSource(source).isDirectory()) throw runtimeError('RESOURCE_INVALID', '资源目录不存在')
  for (const name of fs.readdirSync(source).sort()) {
    if (DENY.has(name)) continue
    const file = path.join(source, name), out = path.join(destination, name)
    if (dependencyRoot && excludeDependencyResource(path.relative(dependencyRoot, file))) continue
    if (safeSource(file).isDirectory()) copyTree(file, out, dependencyRoot)
    else copyFile(file, out)
  }
}
function inventory(root) {
  const files = {}
  function walk(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name), rel = path.relative(root, file).split(path.sep).join('/')
      if (rel === 'DESKTOP-RESOURCES.json') continue
      const st = fs.lstatSync(file)
      if (st.isSymbolicLink()) throw runtimeError('RESOURCE_INVALID', '资源产物不能包含符号链接')
      if (st.isDirectory()) walk(file)
      else if (st.isFile()) { const bytes = fs.readFileSync(file); files[rel] = { bytes: bytes.length, sha256: sha256(bytes) } }
      else throw runtimeError('RESOURCE_INVALID', '资源产物不能包含特殊文件')
    }
  }
  walk(root)
  return files
}
export async function prepareDesktop({ target, outDir, root = ROOT, cacheDir = path.join(ROOT, 'release/runtime-cache'), artifactPath, offline = false }) {
  const lockPath = path.join(root, 'node-runtime.lock.json')
  selectRuntime(readRuntimeLock(lockPath), target, { artifact: true })
  if (!outDir || fs.existsSync(outDir)) throw runtimeError('OUTPUT_EXISTS', '桌面资源输出目录必须是新的目录；已有产物请使用 --verify')
  const destination = path.resolve(outDir)
  // Never merge build artifacts into source trees, including through parent links.
  let ancestor = path.dirname(destination)
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor)
  const resolved = path.resolve(fs.realpathSync(ancestor), path.relative(ancestor, destination))
  for (const name of ['gateway', 'frontend', 'docs']) {
    const input = fs.realpathSync(path.join(root, name)), rel = path.relative(input, resolved)
    if (!rel || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel))) throw runtimeError('RESOURCE_INVALID', '输出不能位于输入资源目录内')
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.mkdirSync(destination)
  try {
    const runtime = await prepareRuntime({ target, outDir: path.join(destination, 'runtime'), lockPath, cacheDir, artifactPath, offline })
    for (const file of GATEWAY_FILES) copyFile(path.join(root, 'gateway', file), path.join(destination, 'gateway', file))
    for (const file of DESKTOP_TOOLS) copyFile(path.join(root, 'desktop', file), path.join(destination, 'desktop', file))
    const dependencyRoot = path.join(root, 'gateway/node_modules')
    copyTree(dependencyRoot, path.join(destination, 'gateway/node_modules'), dependencyRoot)
    const bridge = prepareBridge(path.join(destination, 'gateway'), path.join(root, 'gateway')).manifest
    copyTree(path.join(root, 'frontend/dist'), path.join(destination, 'frontend/dist'))
    if (!fs.existsSync(path.join(destination, 'frontend/dist/index.html'))) throw runtimeError('RESOURCE_INVALID', '缺少已构建的前端 index.html')
    copyTree(path.join(root, 'docs/lan-kit'), path.join(destination, 'lan-kit'))
    copyFile(path.join(root, 'package.json'), path.join(destination, 'package.json'))
    const pkg = JSON.parse(fs.readFileSync(path.join(destination, 'package.json')))
    const manifest = { schemaVersion: 1, target, appVersion: pkg.version, phase: 'pre-signing',
      entry: 'gateway/desktop-entry.mjs', node: `runtime/${TARGETS[target].executable}`, runtime, bridge, files: inventory(destination) }
    fs.writeFileSync(path.join(destination, 'DESKTOP-RESOURCES.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
    verifyDesktop({ target, outDir: destination, lockPath })
    return manifest
  } catch (error) { fs.rmSync(destination, { recursive: true, force: true }); throw error }
}
export function verifyDesktop({ target, outDir, lockPath = path.join(ROOT, 'node-runtime.lock.json') }) {
  if (!fs.lstatSync(outDir).isDirectory()) throw runtimeError('RESOURCE_INVALID', '资源根目录不能是链接')
  const infoFile = path.join(outDir, 'DESKTOP-RESOURCES.json')
  if (!fs.lstatSync(infoFile).isFile()) throw runtimeError('RESOURCE_INVALID', '资源清单必须是普通文件')
  const manifest = JSON.parse(fs.readFileSync(infoFile))
  if (!TARGETS[target] || manifest.schemaVersion !== 1 || manifest.target !== target || manifest.phase !== 'pre-signing' ||
      manifest.entry !== 'gateway/desktop-entry.mjs' || manifest.node !== `runtime/${TARGETS[target].executable}`) throw runtimeError('RESOURCE_INVALID', '资源目标或入口不匹配')
  const actual = inventory(outDir)
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) throw runtimeError('RESOURCE_HASH_MISMATCH', '资源内容、文件列表或哈希与清单不一致')
  const runtime = verifyPreparedRuntime({ target, outDir: path.join(outDir, 'runtime'), lockPath })
  const bridge = verifyBridgePatched({ gatewayDir: path.join(outDir, 'gateway') })
  if (JSON.stringify(runtime) !== JSON.stringify(manifest.runtime) || JSON.stringify(bridge) !== JSON.stringify(manifest.bridge) ||
      JSON.parse(fs.readFileSync(path.join(outDir, 'package.json'))).version !== manifest.appVersion) throw runtimeError('RESOURCE_INVALID', '资源元信息不匹配')
  return manifest
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = name => process.argv.slice(2).find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3)
  try {
    const target = arg('target')
    const options = { target, outDir: path.resolve(arg('out') || path.join(ROOT, 'release/desktop', target || 'unknown')),
      cacheDir: arg('cache') || path.join(ROOT, 'release/runtime-cache'), artifactPath: arg('artifact'), offline: process.argv.includes('--offline') }
    const info = process.argv.includes('--verify') ? verifyDesktop(options) : await prepareDesktop(options)
    console.log(`✓ ${info.target} 桌面资源 ${info.appVersion}：${Object.keys(info.files).length} 个文件；已固定 bridge 补丁，尚未签名或生成安装器`)
  } catch (error) { console.error(`✗ ${error.code || 'DESKTOP_PREPARE_FAILED'}：${error.message}`); process.exitCode = 1 }
}
