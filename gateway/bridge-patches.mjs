// 运行时只读校验；补丁写入仅由 prepare-bridge.mjs 在构建/开发准备阶段执行。
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const BRIDGE_FILES = ['cli.js', 'index.js']
const DEFAULT_GATEWAY = path.dirname(fileURLToPath(import.meta.url))
export const bridgeSha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

function invalid(detail) {
  const error = new Error(`bridge 补丁校验失败：${detail}。请重新安装完整发行包；源码开发请运行 npm run prepare:bridge。`)
  error.code = 'BRIDGE_PATCH_INVALID'
  return error
}

export function readBridgeManifest(gatewayDir = DEFAULT_GATEWAY) {
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(gatewayDir, 'patches', 'manifest.json'), 'utf8'))
  } catch {
    throw invalid('补丁清单缺失或无法读取')
  }
  if (manifest?.schemaVersion !== 1 || manifest.package !== 'chatgpt-bridge' ||
      typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(manifest.version) ||
      !manifest.files || Object.keys(manifest.files).length !== BRIDGE_FILES.length ||
      !BRIDGE_FILES.every((name) => /^[a-f0-9]{64}$/.test(manifest.files[name]))) {
    throw invalid('补丁清单格式无效')
  }
  return manifest
}

export function verifyBridgeVersion(packageDir, manifest) {
  let pkg
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'))
  } catch {
    throw invalid('bridge package.json 缺失或无法读取')
  }
  if (pkg?.name !== manifest.package || pkg.version !== manifest.version) {
    throw invalid(`bridge 版本不匹配（要求 ${manifest.version}，实际 ${pkg?.version ?? '未知'}）`)
  }
}

export function verifyBridgePatched({ gatewayDir = DEFAULT_GATEWAY, bridgeCli, log = () => {} } = {}) {
  const manifest = readBridgeManifest(gatewayDir)
  // 校验实际将执行的入口，BRIDGE_CLI 覆盖也不能绕过检查。
  const cli = bridgeCli || path.join(gatewayDir, 'node_modules', 'chatgpt-bridge', 'dist', 'cli.js')
  const distDir = path.dirname(path.resolve(cli))
  verifyBridgeVersion(path.dirname(distDir), manifest)
  for (const name of BRIDGE_FILES) {
    const file = name === 'cli.js' ? cli : path.join(distDir, name)
    let content
    try { content = fs.readFileSync(file) } catch { throw invalid(`${name} 缺失或无法读取`) }
    if (bridgeSha256(content) !== manifest.files[name]) throw invalid(`${name} 内容不匹配`)
  }
  log('· bridge 补丁版本与完整性校验通过（只读）')
  return manifest
}
