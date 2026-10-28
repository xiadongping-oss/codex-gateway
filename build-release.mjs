// build-release.mjs — 组装发布版 staging 目录（零依赖，Node 18+）
//
// 用法：node build-release.mjs [--no-runtime]
//   产出：release/staging/codex-gateway-v<版本>/   （解压后的最终形态）
//   压缩：见 docs/RELEASE.md（用系统自带命令或 Python 一行）
//
// 白名单复制，绝不带入：账号凭据 / API Key / 调用日志 / 设备身份 / 开发脚本
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)))
const VER = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')).version
const NAME = `codex-gateway-v${VER}`
const STAGING = path.join(ROOT, 'release', 'staging', NAME)
const NO_RUNTIME = process.argv.includes('--no-runtime')
const VERIFY_ZIP = process.argv.includes('--verify-zip')

// 压缩后校验：staging 自检看不到「压缩时选错根目录」——
// v1.1.0 就是这样产出了 73MB、解压出两个版本目录的坏包。
if (VERIFY_ZIP) {
  verifyZip()
  process.exit(0)
}

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

// ---------- 结构自检：发布会翻车的三类问题 ----------
// 动机（都是真实踩过的坑，不是假想）：
//   1. v1.1.0 压缩时以 release/staging 为根，产出 73MB、解压出两个版本目录的坏包；
//   2. gateway/service/run-gateway.cmd 曾硬编码开发机绝对路径，别人拿到跑不起来；
//   3. core.autocrlf=true 环境下 .sh 被 check 成 CRLF，bash 报
//      `set: $'\r': invalid option`，入库等于不可用。
// 这三类都不影响线上权限，却会让「发给别人的唯一凭证」直接作废，
// 所以必须在打包阶段断言，而不是靠人工 unzip 抽查。
const problems = []

// 1) 目录级黑名单：按「整类」拦，不只盯个别文件名。
//    上面的 SECRETS 扫的是文件名，一旦数据目录改个名就漏网；这里兜第二层。
const DIR_DENY = [
  'gateway/data',          // 调用日志 / 账号配额 / 素材源（含个人绝对路径）
  'gateway/tests',         // 安全审计套件（含攻击 payload）
  'gateway/accounts',
  'gateway/logs',
  'frontend/src',
  'frontend/node_modules'
]
for (const rel of DIR_DENY) {
  if (fs.existsSync(path.join(STAGING, rel))) problems.push(`整类目录不应存在：${rel}`)
}

// 2) 个人绝对路径：盘符 + Users + ASCII 用户名。
//    限制为 ASCII 用户名是刻意的——文档里的占位符（<你的用户名>）不会被误判，
//    宁可漏检也不制造噪音，否则自检很快就会被当成狼来了。
const WIN_HOME_RE = /[A-Za-z]:[\\/]+Users[\\/]+[A-Za-z0-9._-]+/g
// 文档里 `C:\Users\me` 这类示例用户名不算泄露——误报会让自检被当成狼来了。
const PLACEHOLDER_USERS = new Set(['me', 'you', 'user', 'username', 'yourname', 'your-name', 'xxx', 'example', 'name', 'someone'])
function isPlaceholderUser(absPath) {
  const user = absPath.split(/[\\/]+/).filter(Boolean).pop() || ''
  return PLACEHOLDER_USERS.has(user.toLowerCase())
}
const TEXT_EXT = new Set(['.mjs', '.js', '.cjs', '.json', '.cmd', '.bat', '.sh', '.vbs', '.md', '.html', '.txt', '.yml', '.yaml'])
const LEAK_HITS = []
const EOL_HITS = []

function walkStaging(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    const st = fs.statSync(p)
    if (st.isDirectory()) {
      // node_modules 是第三方依赖，其中的绝对路径属正常内容，跳过以免误报
      if (name === 'node_modules') continue
      walkStaging(p)
      continue
    }
    const rel = path.relative(STAGING, p).split(path.sep).join('/')
    const ext = path.extname(name).toLowerCase()

    if (TEXT_EXT.has(ext)) {
      const text = fs.readFileSync(p, 'utf-8')
      WIN_HOME_RE.lastIndex = 0
      const raw = text.match(WIN_HOME_RE)
      if (raw) {
        const real = [...new Set(raw)].filter((s) => !isPlaceholderUser(s))
        if (real.length) LEAK_HITS.push(`${rel} → ${real.join(', ')}`)
      }
    }

    // 3) 换行符：.sh 必须 LF（bash 遇 CRLF 直接报错），.cmd/.bat 必须 CRLF（cmd 对 LF 不稳）
    if (ext === '.sh' || ext === '.cmd' || ext === '.bat') {
      const buf = fs.readFileSync(p)
      const hasCR = buf.includes(0x0d)
      const hasLF = buf.includes(0x0a)
      if (hasLF) {
        if (ext === '.sh' && hasCR) EOL_HITS.push(`${rel} 应为 LF，实际含 CRLF`)
        if (ext !== '.sh' && !hasCR) EOL_HITS.push(`${rel} 应为 CRLF，实际为 LF`)
      }
    }
  }
}
walkStaging(STAGING)

for (const h of LEAK_HITS) problems.push(`发现个人绝对路径（应改为相对路径或运行时推导）：${h}`)
for (const h of EOL_HITS) problems.push(`换行符不符：${h}`)

if (problems.length) {
  console.error('✗ 发布包结构自检未通过，禁止分发：\n  ' + problems.join('\n  '))
  console.error('\n  修好后再跑一次；不要直接压缩这份 staging。')
  process.exit(1)
}

const mb = (bytes / 1048576).toFixed(1)
console.log(`✓ staging 就绪：release/staging/${NAME}`)
console.log(`  文件 ${files} 个 / ${mb} MB（未压缩）`)
console.log(`  运行时：${NO_RUNTIME ? '未内置（--no-runtime）' : '已内置 node.exe'}`)
console.log(`  自检：机密文件 0 · 禁止目录 0 · 个人绝对路径 0 · 换行符合规`)
console.log(`  下一步：压缩 → release/${NAME}-win64.zip（命令见 docs/RELEASE.md）`)
console.log(`  压缩后务必再跑：node build-release.mjs --verify-zip`)

// ---------- zip 层校验（--verify-zip） ----------
// staging 自检管不到「压缩时选错根目录」：v1.1.0 就是遍历了整个 release/staging，
// 把历史版本一起打进 zip，产出 73MB、解压出两个版本目录的坏包。
function verifyZip() {
  // 支持 --zip=<path> 校验任意包（便于回归测试与复核历史产物）
  const zipArg = process.argv.find((a) => a.startsWith('--zip='))
  const zipPath = zipArg
    ? path.resolve(ROOT, zipArg.slice('--zip='.length))
    : path.join(ROOT, 'release', `${NAME}-win64.zip`)
  if (!fs.existsSync(zipPath)) {
    console.error(`✗ 找不到 ${path.relative(ROOT, zipPath)} —— 先按 docs/RELEASE.md 完成压缩`)
    process.exit(1)
  }

  const names = listZipEntries(zipPath)
  const bad = []

  // 1) 顶层必须恰好一个目录，且与当前版本同名
  const tops = [...new Set(names.map((n) => n.split('/')[0]))]
  if (tops.length !== 1) {
    bad.push(`顶层应恰好 1 个目录，实际 ${tops.length} 个：${tops.join(', ')}`)
  } else if (tops[0] !== NAME) {
    bad.push(`顶层目录应为 ${NAME}，实际为 ${tops[0]}`)
  }

  // 2) 禁止内容：数据/测试目录按整类判断，不只看文件名
  const FORBIDDEN = [
    '/gateway/data/',
    '/gateway/tests/',
    '/gateway/accounts/',
    '/gateway/logs/',
    '/admin-token.json',
    '/api-keys.json',
    '/accounts.json',
    '/.gw-config.json',
    '/.codex-client-identity'
  ]
  for (const n of names) {
    for (const f of FORBIDDEN) {
      if (n.includes(f)) bad.push(`禁止内容：${n}`)
    }
  }

  // 3) 压缩后 .sh 仍须为 LF：zip 原样存字节，源文件若是 CRLF 会一路带进去
  const shEntries = names.filter((n) => n.endsWith('.sh'))
  for (const n of shEntries) {
    if (readZipEntry(zipPath, n).includes(0x0d)) {
      bad.push(`换行符：${n} 含 CRLF，bash 会报 set: $'\r': invalid option`)
    }
  }

  const sizeMb = (fs.statSync(zipPath).size / 1048576).toFixed(1)
  if (bad.length) {
    console.error(`✗ zip 校验未通过（${path.relative(ROOT, zipPath)}）：\n  ` + bad.join('\n  '))
    process.exit(1)
  }
  console.log(`✓ zip 校验通过：release/${NAME}-win64.zip`)
  console.log(`  顶层目录：${tops[0]}`)
  console.log(`  条目 ${names.length} 个 / ${sizeMb} MB`)
  console.log(`  禁止内容 0 项 · .sh 换行符 ${shEntries.length} 个均为 LF`)
}

function listZipEntries(zipPath) {
  const opts = { encoding: 'utf-8', maxBuffer: 128 * 1024 * 1024 }
  try {
    return execFileSync('unzip', ['-Z1', zipPath], opts).split(/\r?\n/).filter(Boolean)
  } catch {}
  try {
    const code = 'import zipfile,sys;print("\\n".join(zipfile.ZipFile(sys.argv[1]).namelist()))'
    return execFileSync('python', ['-c', code, zipPath], opts).split(/\r?\n/).filter(Boolean)
  } catch {}
  console.error('✗ 未找到 unzip 或 python，读不了 zip。请手工执行 docs/RELEASE.md 第 3.1 段的结构校验。')
  process.exit(1)
}

function readZipEntry(zipPath, entry) {
  const opts = { maxBuffer: 32 * 1024 * 1024 }
  try {
    return execFileSync('unzip', ['-p', zipPath, entry], opts)
  } catch {}
  try {
    const code = 'import zipfile,sys;sys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]))'
    return execFileSync('python', ['-c', code, zipPath, entry], opts)
  } catch {
    return Buffer.alloc(0)
  }
}

