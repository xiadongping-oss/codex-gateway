#!/usr/bin/env node
// 检查前端单文件产物 frontend/dist/index.html 是否与源码 frontend/src 同步。
//
// 做法：重新构建前端，再 `git diff --quiet HEAD -- frontend/dist/index.html`。
//   - 无差异 → 源码未改，或已重建并提交（同源码两遍构建字节一致，可确定性判定）。
//   - 有差异 → frontend/src 改过但没重建/重新提交 dist，退出 1。
//
// 可靠性依据：vite 产物由内容哈希决定、版本号来自 package.json（构建时定格），
// 无构建时间戳注入，因此同源码的两遍构建结果字节一致，diff 不会误报。
//
// 依赖：需要 frontend/node_modules 已安装（首次请 `npm --prefix frontend install`）。
import { execFileSync } from 'node:child_process'

const DIST = 'frontend/dist/index.html'

function git(args, allowFail = false) {
  try {
    return execFileSync('git', args, { encoding: 'utf-8', stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 })
  } catch {
    if (allowFail) return null
    throw new Error(`git ${args.join(' ')} 执行失败`)
  }
}

// 1) dist 是否已入库？未入库则跳过（首次发布前 build 并一起提交即可）。
if (git(['cat-file', '-e', `HEAD:${DIST}`], true) === null) {
  console.log(`ℹ ${DIST} 尚未入库，跳过漂移检查（首次发布前请 build 并一起提交）。`)
  process.exit(0)
}

// 2) 重建前端
console.log('→ 构建前端（npm --prefix frontend run build）...')
try {
  execFileSync('npm', ['--prefix', 'frontend', 'run', 'build'], { stdio: 'inherit' })
} catch {
  console.error('✗ 前端构建失败，无法验证 dist 漂移。若依赖未装，请先 `npm --prefix frontend install`。')
  process.exit(2)
}

// 3) 比对构建产物与已提交版本（working tree vs HEAD，忽略暂存区影响）
if (git(['diff', '--quiet', 'HEAD', '--', DIST], true) === null) {
  console.error(`✗ 前端产物漂移：${DIST} 与源码 frontend/src 不一致。`)
  console.error('   说明 frontend/src 改过但没重建/重新提交 dist。请执行：')
  console.error('     npm --prefix frontend run build')
  console.error('     git add frontend/dist/index.html && git commit -m "build: 重建前端单文件产物"')
  process.exit(1)
}

console.log('✓ 前端产物与源码同步（frontend/dist/index.html 已随前端源码重建）。')
process.exit(0)
