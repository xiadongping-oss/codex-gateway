// build-release.mjs — 组装发布版 staging 目录（零依赖，Node 18+）
//
// 用法：node build-release.mjs [--no-runtime]
//   产出：release/staging/codex-gateway-v<版本>/   （解压后的最终形态）
//   压缩：见 docs/RELEASE.md（用系统自带命令或 Python 一行）
//
// 白名单复制，绝不带入：账号凭据 / API Key / 调用日志 / 设备身份 / 开发脚本
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)))
const VER = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')).version
const NAME = `codex-gateway-v${VER}`
const STAGING = path.join(ROOT, 'release', 'staging', NAME)
const NO_RUNTIME = process.argv.includes('--no-runtime')

// node.exe 候选：打包机上的 managed node（release 必须内置运行时）。
// 优先用「当前正在运行本脚本的 node」，避免硬编码某台机器的路径。
const NODE_CANDIDATES = [
  process.execPath,
  'C:/Program Files/nodejs/node.exe',
  '/usr/local/bin/node',
  '/usr/bin/node'
]

let files = 0
let bytes = 0

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(src, dest)
  const s = fs.statSync(src).size
  files++
  bytes += s
}

// gateway/ 整目录递归，但剔除用户数据与机密
const GATEWAY_DENY = new Set([
  'accounts', 'accounts.json', 'api-keys.json', 'api-keys.json.tmp',
  'data', 'logs', 'launcher.log',
  // 管理令牌等同于控制台管理员口令：一旦打进发布包，所有下载者共享同一枚令牌。
  'admin-token.json',
  '.codex-client-identity', '.gw-config.json', '.gw-config.json.tmp',
  // 安全审计套件：终端用户用不上，且含攻击 payload 与沙盒逻辑，不分发
  'tests'
])

function copyTree(srcDir, destDir) {
  for (const name of fs.readdirSync(srcDir)) {
    if (GATEWAY_DENY.has(name)) continue
    const src = path.join(srcDir, name)
    const dest = path.join(destDir, name)
    const st = fs.statSync(src)
    if (st.isDirectory()) copyTree(src, dest)
    else copyFile(src, dest)
  }
}

// ---------- 组装 ----------
fs.rmSync(STAGING, { recursive: true, force: true })

copyTree(path.join(ROOT, 'gateway'), path.join(STAGING, 'gateway'))
copyTree(path.join(ROOT, 'frontend', 'dist'), path.join(STAGING, 'frontend', 'dist'))
copyTree(path.join(ROOT, 'docs', 'lan-kit'), path.join(STAGING, 'lan-kit'))
copyFile(path.join(ROOT, 'package.json'), path.join(STAGING, 'package.json'))
copyFile(path.join(ROOT, 'README.md'), path.join(STAGING, 'README.md'))
copyFile(path.join(ROOT, 'QUICK-START.md'), path.join(STAGING, 'QUICK-START.md'))

// service/ 已随 gateway/ 复制；内置运行时
if (!NO_RUNTIME) {
  const nodeExe = NODE_CANDIDATES.find((p) => fs.existsSync(p))
  if (!nodeExe) {
    console.error('✗ 找不到 node.exe，无法内置运行时。可加 --no-runtime 跳过（用户需自装 Node）。')
    process.exit(1)
  }
  copyFile(nodeExe, path.join(STAGING, 'gateway', 'service', 'node', 'node.exe'))
}

// ---------- 完整性校验 ----------
const REQUIRED = [
  'gateway/launcher.mjs',
  'gateway/gallery.html',
  'gateway/setup.html',
  'gateway/start-unix.sh',
  'gateway/service/start-gateway.vbs',
  'gateway/service/stop-gateway.vbs',
  'gateway/service/run-gateway.cmd',
  'gateway/node_modules/chatgpt-bridge/dist/cli.js',
  'gateway/patches',
  'frontend/dist/index.html',
  'lan-kit/INSTALL.md',
  'lan-kit/setup-client.mjs',
  'lan-kit/AGENT-PROMPT.md',
  'QUICK-START.md'
]
const missing = REQUIRED.filter((rel) => !fs.existsSync(path.join(STAGING, rel)))
if (missing.length) {
  console.error('✗ 发布包缺少关键文件：\n  ' + missing.join('\n  '))
  process.exit(1)
}

// 泄漏自检：机密文件绝不能出现在 staging
const SECRETS = ['accounts.json', 'api-keys.json', '.codex-client-identity', '.gw-config.json', 'admin-token.json', 'api-keys.json.tmp', '.gw-config.json.tmp']
const leaked = []
function scanSecrets(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    if (fs.statSync(p).isDirectory()) scanSecrets(p)
    else if (SECRETS.includes(name)) leaked.push(path.relative(STAGING, p))
  }
}
scanSecrets(STAGING)
if (leaked.length) {
  console.error('✗ 检测到机密文件混入发布包，立即中止：\n  ' + leaked.join('\n  '))
  process.exit(1)
}

const mb = (bytes / 1048576).toFixed(1)
console.log(`✓ staging 就绪：release/staging/${NAME}`)
console.log(`  文件 ${files} 个 / ${mb} MB（未压缩）`)
console.log(`  运行时：${NO_RUNTIME ? '未内置（--no-runtime）' : '已内置 node.exe'}`)
console.log(`  下一步：压缩 → release/${NAME}-win64.zip（命令见 docs/RELEASE.md）`)
