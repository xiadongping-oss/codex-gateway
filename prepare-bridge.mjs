// 显式构建步骤：受版本和哈希约束的快照 → 目标资源目录。禁止从运行时调用。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BRIDGE_FILES, bridgeSha256, readBridgeManifest, verifyBridgeVersion, verifyBridgePatched } from './gateway/bridge-patches.mjs'

const DEFAULT_GATEWAY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'gateway')

export function prepareBridge(targetGatewayDir, sourceGatewayDir = DEFAULT_GATEWAY) {
  const manifest = readBridgeManifest(sourceGatewayDir)
  const packageDir = path.join(targetGatewayDir, 'node_modules', 'chatgpt-bridge')
  verifyBridgeVersion(packageDir, manifest)
  // 先检查全部快照，任何一个缺失/损坏都不得开始写入。
  const prepared = BRIDGE_FILES.map((name) => {
    const snapshot = path.join(sourceGatewayDir, 'patches', name.replace(/\.js$/, '.patched.js'))
    let bytes
    try { bytes = fs.readFileSync(snapshot) } catch { throw new Error(`bridge 补丁快照缺失或无法读取：${name}`) }
    bytes = Buffer.from(bytes.toString('latin1').replace(/\r\n/g, '\n'), 'latin1')
    if (bytes.includes(0x0d) || bridgeSha256(bytes) !== manifest.files[name]) {
      throw new Error(`bridge 补丁快照内容不匹配：${name}；请审核补丁并更新 manifest.json，禁止自动接受新哈希`)
    }
    return [path.join(packageDir, 'dist', name), bytes]
  })
  prepared.push([path.join(targetGatewayDir, 'patches', 'manifest.json'), Buffer.from(JSON.stringify(manifest, null, 2) + '\n')])
  let addedFiles = 0
  let bytesDelta = 0
  for (const [file, bytes] of prepared) {
    const exists = fs.existsSync(file)
    bytesDelta += bytes.length - (exists ? fs.statSync(file).size : 0)
    if (!exists) addedFiles++
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, bytes)
  }
  verifyBridgePatched({ gatewayDir: targetGatewayDir })
  return { manifest, addedFiles, bytesDelta }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = prepareBridge(DEFAULT_GATEWAY)
    console.log(`bridge ${result.manifest.version} 补丁已准备并通过完整性校验`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
