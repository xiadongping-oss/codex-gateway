// build-release.mjs — 组装发布版 staging 目录（零依赖，Node 18+）
//
// 用法：
//   node build-release.mjs                 组装 staging（内置运行时）
//   node build-release.mjs --no-runtime    不内置 node.exe（用户自装 Node）
//   node build-release.mjs --node=<path>   指定要内置的 node 可执行文件
//   node build-release.mjs --write-lock    把当前 node 的版本+哈希固化进锁文件
//   node build-release.mjs --verify-zip [--zip=<path>]    校验压缩包结构
//   node build-release.mjs --verify-build [--zip=<path>]  校验构建指纹（含 node 哈希）
//
// 白名单复制，绝不带入：账号凭据 / API Key / 调用日志 / 设备身份 / 开发脚本
//
// ---- 为什么要有锁文件 ----
// 早期版本直接内置「打这个包的那台机器上的 node.exe」。结果同一个版本号在两台
// 机器上打出来的二进制不一样（一次 98.3MB，一次 106MB），发版记录对不上号，
// 排查时分不清「行为差异」来自代码还是来自运行时。
// 现在把 node.exe 的**内容哈希**写进 node-runtime.lock.json：
//   · 哈希与锁一致 → 通过，且 BUILD-INFO.json 会如实记录这一版用的到底是哪个运行时；
//   · 哈希不一致   → 直接失败，要求显式 --write-lock 才认账（防止静默漂移）。
// 注意：BUILD-INFO.json 里**不记录 node 的绝对路径**——那会把打包者的用户名
// 带进分发包，正是 v1.2.0 栽过的坑。
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)))
const VER = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')).version
const NAME = `codex-gateway-v${VER}`
const STAGING = path.join(ROOT, 'release', 'staging', NAME)
const NO_RUNTIME = process.argv.includes('--no-runtime')
const VERIFY_ZIP = process.argv.includes('--verify-zip')
const VERIFY_BUILD = process.argv.includes('--verify-build')
const WRITE_LOCK = process.argv.includes('--write-lock')
const LOCK_PATH = path.join(ROOT, 'node-runtime.lock.json')

function argValue(prefix) {
  const hit = process.argv.find((a) => a.startsWith(prefix))
  return hit ? hit.slice(prefix.length) : ''
}
const ZIP_ARG = argValue('--zip=')
const NODE_ARG = argValue('--node=') || process.env.CGW_NODE_EXE || ''

// 压缩后校验：staging 自检看不到「压缩时选错根目录」——
// v1.1.0 就是这样产出了 73MB、解压出两个版本目录的坏包。
if (VERIFY_ZIP) {
  verifyZip()
  process.exit(0)
}
if (VERIFY_BUILD) {
  verifyBuild()
  process.exit(0)
}

// 内置运行时候选：优先「当前正在运行本脚本的 node」，避免硬编码某台机器的路径。
// 顺序固定，因此同一台机器重复执行的结果稳定；跨机器一致性由锁文件保证。
const NODE_CANDIDATES = [
  'C:/Program Files/nodejs/node.exe',
  '/usr/local/bin/node',
  '/usr/bin/node'
]

let files = 0
let bytes = 0
let eolFixed = 0

// ---------- 换行符规范化（可复现构建的最后一块）----------
// 只锁 node.exe 是不够的：`core.autocrlf=true` 的机器 checkout 出来是 CRLF，
// `false` 的机器是 LF，同一 commit 打出的 zip 字节就不同。实测本仓库就存在这种
// 混态——apikeys.mjs / assets.mjs / account-quota.mjs 在工作区是全 CRLF
// （git ls-files --eol 显示 i/lf w/crlf），而 launcher.mjs 是 LF。
// 靠 .gitattributes 只能稳定「git checkout」这条路，管不住「某人编辑器存成 CRLF」，
// 也管不住 vendored node_modules 里自带的 CRLF。所以构建时统一规范化：
// 产物字节只由源码内容决定，不由打包机器的 git 配置决定。
//
// 规则：Windows 脚本（.cmd/.bat/.vbs）必须 CRLF；其余文本一律 LF。
// 顺带修掉混合换行——先全归一成 LF 再按需加 CR，避免「一半 CRLF 一半 LF」。
const TEXT_EXT = new Set([
  '.mjs', '.js', '.cjs', '.mts', '.cts', '.ts', '.json', '.map',
  '.sh', '.cmd', '.bat', '.vbs', '.ps1',
  '.md', '.html', '.css', '.svg', '.txt', '.yml', '.yaml', '.vue'
])
const CRLF_REQUIRED = new Set(['.cmd', '.bat', '.vbs'])

// 用 latin1 做字节级往返：UTF-8 多字节字符映射为单字节序列，替换后再写回，
// 不会误改内容，BOM 也原样保留。
//
// 只处理 CRLF。遇到**孤立 CR**（不跟在 CRLF 里的 CR）时原样放行、交给自检报错，
// 不做"修复"——因为把孤立 CR 当换行会把 `\r\r\n` 变成 `\n\n`，凭空多出一个空行，
// 静默改变文件内容。这类文件通常是被某个工具二次转换过，属于需要人看的情况，
// 打包器不该替它猜。宁可构建失败，也不要发出一个内容被悄悄改过的包。
function toCRLF(buf) {
  return Buffer.from(buf.toString('latin1').replace(/\n/g, '\r\n'), 'latin1')
}

function normalizeEol(buf, ext) {
  const wantCRLF = CRLF_REQUIRED.has(ext)
  if (!buf.includes(0x0d)) return wantCRLF ? toCRLF(buf) : buf
  const lf = Buffer.from(buf.toString('latin1').replace(/\r\n/g, '\n'), 'latin1')
  if (lf.includes(0x0d)) return buf
  return wantCRLF ? toCRLF(lf) : lf
}

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const ext = path.extname(src).toLowerCase()
  let buf = fs.readFileSync(src)
  if (TEXT_EXT.has(ext)) {
    const fixed = normalizeEol(buf, ext)
    if (!fixed.equals(buf)) eolFixed++
    buf = fixed
  }
  fs.writeFileSync(dest, buf)
  // 按写出后的尺寸计数：规范化会让 CRLF 文件略小，用源文件大小会对不上 zip
  files++
  bytes += buf.length
}

// ---------- 分块算 sha256 ----------
// node.exe 有 100MB 上下，一次性 readFileSync 会白占一份内存，这里按 1MB 流式吃。
function sha256File(file) {
  const h = createHash('sha256')
  const fd = fs.openSync(file, 'r')
  const buf = Buffer.allocUnsafe(1 << 20)
  try {
    let n
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n))
  } finally {
    fs.closeSync(fd)
  }
  return h.digest('hex')
}

function nodeVersionOf(exe) {
  try {
    return execFileSync(exe, ['-v'], { encoding: 'utf-8' }).trim()
  } catch {
    return null
  }
}

function pickNodeExe() {
  if (NODE_ARG) {
    const p = path.resolve(NODE_ARG)
    if (!fs.existsSync(p)) {
      console.error(`✗ --node 指定的文件不存在：${p}`)
      process.exit(1)
    }
    return { exe: p, source: '--node/env' }
  }
  if (fs.existsSync(process.execPath)) return { exe: process.execPath, source: 'process.execPath' }
  const hit = NODE_CANDIDATES.find((p) => fs.existsSync(p))
  return hit ? { exe: hit, source: 'fallback-path' } : null
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

function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf-8' }).trim()
  } catch {
    return null
  }
}
function gitDirty() {
  try {
    return execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf-8' }).trim().length > 0
  } catch {
    return null
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
let nodeInfo = null
if (!NO_RUNTIME) {
  const picked = pickNodeExe()
  if (!picked) {
    console.error('✗ 找不到 node 可执行文件，无法内置运行时。可用 --node=<path> 指定，或加 --no-runtime 跳过（用户需自装 Node）。')
    process.exit(1)
  }
  const ver = nodeVersionOf(picked.exe)
  const major = Number(String(ver || '').replace(/^v/, '').split('.')[0])
  if (!Number.isFinite(major) || major < 22) {
    // bridge 的 package.json 要求 >=22；打进低于此版本的内置运行时会一路报奇怪的语法错误
    console.error(`✗ 选中运行时的版本为 ${ver || '未知'}，低于最低要求 v22。请用 --node=<path> 指定。`)
    process.exit(1)
  }
  const digest = sha256File(picked.exe)
  const size = fs.statSync(picked.exe).size
  nodeInfo = { version: ver, sha256: digest, bytes: size, source: picked.source }

  // ---- 锁文件校验：同版本号不得产出不同二进制 ----
  const lock = fs.existsSync(LOCK_PATH) ? JSON.parse(fs.readFileSync(LOCK_PATH, 'utf-8')) : null
  // 锁文件按平台区分：在 Linux/macOS 上打 win64 包时 node.exe 必然不同，
  // 那不是「漂移」而是正常的跨平台差异，跳过哈希比对但要提示。
  const lockApplies = lock && (!lock.platform || lock.platform === process.platform)
  if (WRITE_LOCK) {
    fs.writeFileSync(
      LOCK_PATH,
      JSON.stringify(
        {
          version: ver,
          sha256: digest,
          bytes: size,
          platform: process.platform,
          arch: process.arch,
          note: '内置 node.exe 的锁定指纹；换运行时请显式 --write-lock'
        },
        null,
        2
      ) + '\n',
      'utf-8'
    )
    console.log(`✓ 已写入运行时锁：node-runtime.lock.json（${ver} / ${digest.slice(0, 12)}…）`)
  } else if (lock && !lockApplies) {
    console.log(`· 锁文件记录的是 ${lock.platform} 平台，当前为 ${process.platform}，跳过哈希比对`)
  } else if (lock && lock.sha256 !== digest) {
    console.error('✗ 内置运行时与锁文件不一致，构建中止：\n')
    console.error(`  锁文件：${lock.version} / sha256=${lock.sha256} / ${lock.bytes} bytes`)
    console.error(`  当前  ：${ver} / sha256=${digest} / ${size} bytes\n`)
    console.error('  同一个版本号产出不同二进制，会让发版记录对不上号。二选一：')
    console.error('    · 用 --node=<path> 指向锁文件里那枚 node（推荐，保证可复现）')
    console.error('    · 确认要换运行时，用 --write-lock 更新锁文件（会让新旧包不可比）')
    process.exit(1)
  } else if (!lock) {
    console.log('· 尚无运行时锁文件；本次构建的指纹会写进 BUILD-INFO.json。')
    console.log('  要固化可复现构建，先确认这枚 node 是你要长期用的，再跑一次 --write-lock。')
  }

  copyFile(picked.exe, path.join(STAGING, 'gateway', 'service', 'node', 'node.exe'))
}

// ---------- 构建指纹 ----------
// 写进发布包，让「这包到底是哪套源码 + 哪个运行时」可事后核对，
// 不必再靠发版人回忆。刻意不记录绝对路径与主机名。
// builtAt 默认取当前时间，但可用 SOURCE_DATE_EPOCH（Unix 秒）固定。
// 没有它就无法验证「同源码 → 同字节」：每次构建时间不同，BUILD-INFO 必然不同，
// 于是任何两次构建都无法比对。这是 reproducible-builds 的通行做法，
// 也让测试能真正断言「两次构建产物一致」而非只断言结构。
function buildTimestamp() {
  const raw = process.env.SOURCE_DATE_EPOCH
  if (!raw) return new Date().toISOString()
  const sec = Number(raw)
  if (!Number.isFinite(sec) || sec <= 0) {
    console.error(`✗ SOURCE_DATE_EPOCH 不是合法的 Unix 秒：${raw}`)
    process.exit(1)
  }
  return new Date(sec * 1000).toISOString()
}

const buildInfo = {
  app: 'codex-gateway',
  version: VER,
  builtAt: buildTimestamp(),
  git: { commit: gitCommit(), dirty: gitDirty() },
  node: nodeInfo,
  // 统计口径：不含 BUILD-INFO.json 自身（它的大小随 totals 变，写进去会自相矛盾）
  totalsExcludingSelf: { files, bytes }
}
fs.writeFileSync(path.join(STAGING, 'BUILD-INFO.json'), JSON.stringify(buildInfo, null, 2) + '\n', 'utf-8')
files += 1

// ---------- 完整性校验 ----------
const REQUIRED = [
  'gateway/launcher.mjs',
  'gateway/bridge-pool.mjs',
  'gateway/gallery.html',
  'gateway/setup.html',
  'gateway/start-unix.sh',
  'gateway/service/start-gateway.vbs',
  'gateway/service/stop-gateway.vbs',
  'gateway/service/run-gateway.cmd',
  // 一键安装 / 卸载（普通用户的推荐入口；缺了它们发布包就退化成纯绿色版）
  'gateway/service/install-app.vbs',
  'gateway/service/uninstall-app.vbs',
  // macOS / Linux 的启动与自启（launchd / systemd --user）
  'gateway/service-unix/_common.sh',
  'gateway/service-unix/start-gateway.sh',
  'gateway/service-unix/run-gateway.sh',
  'gateway/service-unix/stop-gateway.sh',
  'gateway/service-unix/install-autostart.sh',
  'gateway/service-unix/uninstall-autostart.sh',
  'gateway/node_modules/chatgpt-bridge/dist/cli.js',
  'gateway/patches',
  'frontend/dist/index.html',
  'lan-kit/INSTALL.md',
  'lan-kit/setup-client.mjs',
  'lan-kit/AGENT-PROMPT.md',
  'BUILD-INFO.json',
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
const LEAK_HITS = []
const EOL_HITS = []

function walkStaging(dir, { scanPaths = true } = {}) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    const st = fs.statSync(p)
    if (st.isDirectory()) {
      // node_modules 是第三方依赖：其中的绝对路径属正常内容，跳过路径扫描以免误报；
      // 但**换行符仍要检查**——vendored 包自带的 CRLF（实测 json-schema-typed 有）
      // 一样会进产物字节，而「同版本不同字节」正是要堵的东西。
      walkStaging(p, { scanPaths: scanPaths && name !== 'node_modules' })
      continue
    }
    const rel = path.relative(STAGING, p).split(path.sep).join('/')
    const ext = path.extname(name).toLowerCase()

    if (scanPaths && TEXT_EXT.has(ext)) {
      const text = fs.readFileSync(p, 'utf-8')
      WIN_HOME_RE.lastIndex = 0
      const raw = text.match(WIN_HOME_RE)
      if (raw) {
        const real = [...new Set(raw)].filter((s) => !isPlaceholderUser(s))
        if (real.length) LEAK_HITS.push(`${rel} → ${real.join(', ')}`)
      }
    }

    // 3) 换行符：Windows 脚本必须 CRLF（cmd 对 LF 不稳），其余文本一律 LF
    //    （bash 遇 CRLF 的 .sh 直接报 `set: $'\r': invalid option`）。
    //    复制阶段已规范化，这里是**第二层断言**：确认规范化真的生效了。
    //    没有换行的单行文件（如极简 .cmd）不参与判断，否则只会制造噪音。
    if (TEXT_EXT.has(ext)) {
      const buf = fs.readFileSync(p)
      const hasLF = buf.includes(0x0a)
      const hasCR = buf.includes(0x0d)
      if (hasLF) {
        const wantCRLF = CRLF_REQUIRED.has(ext)
        if (wantCRLF && !hasCR) EOL_HITS.push(`${rel} 应为 CRLF（Windows 脚本），实际为 LF`)
        if (!wantCRLF && hasCR) EOL_HITS.push(`${rel} 应为 LF，实际含 CRLF`)
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
if (eolFixed) console.log(`  换行符规范化：修正 ${eolFixed} 个文件（CRLF 工作区打出的包与 LF 工作区一致）`)
if (nodeInfo) {
  console.log(`  运行时：${nodeInfo.version} · sha256 ${nodeInfo.sha256.slice(0, 16)}… · ${(nodeInfo.bytes / 1048576).toFixed(1)} MB`)
} else {
  console.log('  运行时：未内置（--no-runtime）')
}
console.log(`  自检：机密文件 0 · 禁止目录 0 · 个人绝对路径 0 · 换行符合规`)
console.log(`  指纹：BUILD-INFO.json（版本 / git commit / 运行时哈希）`)
console.log(`  下一步：压缩 → release/${NAME}-win64.zip（命令见 docs/RELEASE.md）`)
console.log(`  压缩后务必再跑：node build-release.mjs --verify-zip && node build-release.mjs --verify-build`)

// ---------- zip 层校验（--verify-zip） ----------
// staging 自检管不到「压缩时选错根目录」：v1.1.0 就是遍历了整个 release/staging，
// 把历史版本一起打进 zip，产出 73MB、解压出两个版本目录的坏包。
function resolveZipPath() {
  return ZIP_ARG ? path.resolve(ROOT, ZIP_ARG) : path.join(ROOT, 'release', `${NAME}-win64.zip`)
}

function verifyZip() {
  const zipPath = resolveZipPath()
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
  console.log(`✓ zip 校验通过：${path.relative(ROOT, zipPath).split(path.sep).join('/')}`)
  console.log(`  顶层目录：${tops[0]}`)
  console.log(`  条目 ${names.length} 个 / ${sizeMb} MB`)
  console.log(`  禁止内容 0 项 · .sh 换行符 ${shEntries.length} 个均为 LF`)
}

// ---------- 构建指纹校验（--verify-build） ----------
// 回答一个具体问题：「这个包里的 node.exe 到底是哪一枚？」
// 校验三件事：BUILD-INFO 存在、内嵌运行时哈希与包内声明一致、与锁文件一致。
function verifyBuild() {
  const zipPath = resolveZipPath()
  // 默认校验 staging（刚构建出来的那份），只有显式给 --zip 或 staging 不存在时才看 zip。
  // 反过来会在「刚打完包但 zip 还是上一版」时验到旧产物，得出错误的通过结论。
  const stagingInfo = path.join(STAGING, 'BUILD-INFO.json')
  const useZip = !!ZIP_ARG || !fs.existsSync(stagingInfo)
  let info = null
  let topDir = null

  if (useZip) {
    const names = listZipEntries(zipPath)
    const tops = [...new Set(names.map((n) => n.split('/')[0]))]
    topDir = tops[0]
    const entry = `${topDir}/BUILD-INFO.json`
    if (!names.includes(entry)) {
      console.error(`✗ 包内没有 ${entry}：该包早于「构建指纹」改造，无法核对运行时。`)
      process.exit(1)
    }
    info = JSON.parse(readZipEntry(zipPath, entry).toString('utf-8'))
  } else if (fs.existsSync(path.join(STAGING, 'BUILD-INFO.json'))) {
    topDir = NAME
    info = JSON.parse(fs.readFileSync(path.join(STAGING, 'BUILD-INFO.json'), 'utf-8'))
  } else {
    console.error('✗ 既没有可校验的 zip，也没有 staging/BUILD-INFO.json。先跑一次 node build-release.mjs')
    process.exit(1)
  }

  const bad = []
  if (!info.node) {
    bad.push('BUILD-INFO 里没有运行时信息（--no-runtime 构建？）')
  } else {
    // 1) 与锁文件比对（跨平台产物不具可比性，锁文件只约束它记录的那个平台）
    if (fs.existsSync(LOCK_PATH)) {
      const lock = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf-8'))
      if (lock.platform && lock.platform !== process.platform) {
        console.log(`· 锁文件记录的是 ${lock.platform} 平台，当前 ${process.platform}，跳过锁比对`)
      } else if (lock.sha256 !== info.node.sha256) {
        bad.push(`运行时哈希与锁文件不一致：锁 ${lock.sha256.slice(0, 16)}… / 包 ${String(info.node.sha256).slice(0, 16)}…`)
      }
    }
    // 2) 实际内嵌的 node.exe 是否真是声明的那个
    const entryName = `${topDir}/gateway/service/node/node.exe`
    let actual
    if (useZip) {
      const buf = readZipEntry(zipPath, entryName, 512 * 1024 * 1024)
      if (!buf.length) bad.push(`包内缺少 ${entryName}`)
      else actual = createHash('sha256').update(buf).digest('hex')
    } else {
      const p = path.join(STAGING, 'gateway', 'service', 'node', 'node.exe')
      if (!fs.existsSync(p)) bad.push(`staging 缺少 ${entryName}`)
      else actual = sha256File(p)
    }
    if (actual && actual !== info.node.sha256) {
      bad.push(`内嵌 node.exe 哈希与声明不符：声明 ${String(info.node.sha256).slice(0, 16)}… / 实际 ${actual.slice(0, 16)}…`)
    }
  }

  if (bad.length) {
    console.error('✗ 构建指纹校验未通过：\n  ' + bad.join('\n  '))
    process.exit(1)
  }
  console.log(`✓ 构建指纹校验通过（${useZip ? path.relative(ROOT, zipPath).split(path.sep).join('/') : 'release/staging/' + NAME}）`)
  console.log(`  版本：${info.version} · git ${info.git?.commit ? info.git.commit.slice(0, 7) : '—'}${info.git?.dirty ? ' (dirty)' : ''}`)
  console.log(`  运行时：${info.node.version} · sha256 ${info.node.sha256} · ${(info.node.bytes / 1048576).toFixed(1)} MB`)
  console.log(`  构建时间：${info.builtAt}`)
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

function readZipEntry(zipPath, entry, maxBuffer = 32 * 1024 * 1024) {
  const opts = { maxBuffer }
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
