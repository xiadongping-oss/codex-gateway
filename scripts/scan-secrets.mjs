#!/usr/bin/env node
// codex-gateway 提交守卫：拦截活凭据与个人绝对路径入库（对应安全评审 B1）。
//
// 仓库已用 .gitignore 排除 gateway/accounts、admin-token.json、个人绝对路径；但
// `git add -f` 或拷贝整树的工具仍能把活凭据带走。本脚本在 pre-commit 阶段再拦一道：
// 只要被 staged 的文件里出现下列形状，提交直接失败。
//
// 精确性优先：测试/样例/文档里的「假密钥」和「示例路径」一律跳过，否则会误伤正常提交。
//   - 真泄漏（Google OAuth refresh_token rt.1.、cgwadm-/cgw-/sk- 真密钥）几乎只存在于
//     gitignored 的文件里，正常提交碰不到；一旦被 force-add 即被本守卫捕获。
//   - 个人绝对路径只在「真源码/配置」扩展名上检查，文档(.md)/编排(.yml)里的示例路径不计。
//
// 用法：
//   node scripts/scan-secrets.mjs            # 扫描整个工作树（遵守 .gitignore）
//   node scripts/scan-secrets.mjs --staged   # 只扫描 git 暂存区（pre-commit 用）
//
// 退出码：0 = 干净；1 = 发现疑似泄漏（提交应被拦截）。
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const ROOT = process.cwd()

// 高置信密钥形状（命中即失败）。
const SECRET_PATTERNS = [
  { name: 'Google OAuth refresh_token', re: /rt\.1\.[A-Za-z0-9._-]{20,}/ },
  { name: 'codex-gateway 管理令牌', re: /cgwadm-[A-Za-z0-9._-]{10,}/ },
  { name: 'codex-gateway API Key', re: /\bcgw-[A-Za-z0-9._-]{20,}/ },
  { name: 'OpenAI API Key', re: /\bsk-[A-Za-z0-9]{32,}/ },
]

// 个人绝对路径形状（只在真源码/配置扩展名上检查，避免文档/编排里的示例路径误报）。
const HOME_PATTERNS = [
  /C:\\Users\\[^\\/]+/,
  /\/Users\/[^/]+/,
  /\/home\/[^/]+/,
]
const HOME_EXT = new Set(['.mjs', '.js', '.ts', '.cjs', '.json', '.jsonc'])

// 这些目录片段整体跳过（依赖、产物、日志、文档、版本控制、生成物、测试/样例）。
const EXCLUDED_DIR_SEGMENTS = new Set([
  'node_modules', '.git', 'release', 'output', 'dist', 'coverage', 'target',
  '.husky', '.verify', '.playwright-cli', '.generated', '.gen', '.turbo', '.next',
  'vendor', 'tests', 'test', 'fixture', 'fixtures', 'sandbox', 'examples', 'example', 'docs', 'doc'
])
// 这些文件名/形态跳过：守卫脚本自身、测试/冒烟/样例文件。
const EXCLUDED_FILE_PATTERNS = [
  /^scan-secrets\.mjs$/, /^pre-commit(\.sh)?$/, /^build-release\.mjs$/,
  /\.(test|spec)\.[mc]?js$/, /smoke\.[mc]?js$/, /fixture|mock|sample/i
]

function isExcluded(rel) {
  const segs = rel.split('/')
  if (segs.some(s => EXCLUDED_DIR_SEGMENTS.has(s))) return true
  const base = path.basename(rel)
  return EXCLUDED_FILE_PATTERNS.some(re => re.test(base))
}

function listStagedFiles() {
  const out = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], { encoding: 'utf-8' })
  return out.split('\n').map(s => s.trim()).filter(Boolean)
}

function ignoredAmong(rels) {
  if (!rels.length) return new Set()
  try {
    const out = execFileSync('git', ['check-ignore', '--stdin'],
      { input: rels.join('\n'), encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 })
    return new Set(out.split('\n').map(s => s.trim()).filter(Boolean))
  } catch {
    // git check-ignore 在没有命中时退出码为 1 —— 视为「无忽略」，返回空集。
    return new Set()
  }
}

function listTreeFiles(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDED_DIR_SEGMENTS.has(entry.name) || entry.name === '.git') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) { listTreeFiles(full, acc); continue }
    acc.push(full)
  }
  return acc
}

function isText(buf) {
  return !buf.includes(0x00)
}

function scanFile(file) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/')
  if (isExcluded(rel)) return []
  let buf
  try { buf = fs.readFileSync(file) } catch { return [] }
  if (!isText(buf)) return []
  const text = buf.toString('latin1')

  const hits = []
  for (const p of SECRET_PATTERNS) {
    p.re.lastIndex = 0
    if (p.re.test(text)) hits.push(`  · 疑似${p.name}`)
  }
  const ext = path.extname(rel).toLowerCase()
  if (HOME_EXT.has(ext)) {
    for (const hp of HOME_PATTERNS) {
      hp.lastIndex = 0
      if (hp.test(text)) { hits.push(`  · 疑似个人绝对路径（${rel}）`); break }
    }
  }
  return hits.length ? [{ rel, hits }] : []
}

function main() {
  const staged = process.argv.includes('--staged')
  const files = staged
    ? listStagedFiles().map(f => path.join(ROOT, f))
    : listTreeFiles(ROOT)

  // 全树扫描遵守 .gitignore（被忽略的文件不算泄漏）；暂存扫描不遵守，以捕获 `git add -f`。
  let ignored = new Set()
  if (!staged) ignored = ignoredAmong(files.map(f => path.relative(ROOT, f).split(path.sep).join('/')))

  const report = []
  for (const f of files) {
    const rel = path.relative(ROOT, f).split(path.sep).join('/')
    if (!staged && ignored.has(rel)) continue
    const r = scanFile(f)
    if (r.length) report.push(...r)
  }

  if (!report.length) {
    console.log(staged ? '✓ 暂存区未发现密钥或个人绝对路径' : '✓ 工作树未发现密钥或个人绝对路径')
    process.exit(0)
  }

  console.error('✗ 发现疑似密钥或个人绝对路径，已阻止提交：\n')
  for (const { rel, hits } of report) {
    console.error(`  ${rel}`)
    for (const h of hits) console.error(h)
  }
  console.error(`\n共 ${report.reduce((n, r) => n + r.hits.length, 0)} 处。若确认是误报且必须提交，可用 \`git commit --no-verify\` 跳过本守卫（不推荐）。`)
  process.exit(1)
}

main()
