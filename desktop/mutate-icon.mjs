#!/usr/bin/env node
// mutate-icon.mjs — 证明 icon-compact.test.mjs 不是假测试
//
// 这块逻辑写错时不会有任何报错：构建成功、安装包照样发出去，只是用户在任务栏
// 看到一个 X 而不是 <>，或者托盘图标边缘一圈毛边。所以它必须被变异测试按住。
//
// 变异体全部取材于真实会犯的错 —— 其中 MI1 就是本模块第一版实际犯过的错。
//
//   node desktop/mutate-icon.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const DESKTOP = path.dirname(fileURLToPath(import.meta.url))
const C = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' }

// 被测文件零外部依赖：把 desktop 下这几个纯函数模块连同测试复制过去即可。
const FILES = ['icon-compact.test.mjs', 'icon-compact.mjs', 'ico.mjs', 'icns.mjs', 'png.mjs']
const TEST = 'icon-compact.test.mjs'

const MUTANTS = [
  {
    id: 'MI1', file: 'icon-compact.mjs',
    desc: '小尺寸 Variant 的中缝被收窄到等于笔画宽度（⟨⟩ 退化成 X —— 第一版真实踩过）',
    from: '    halfWidth: 0.200,\n    halfHeight: 0.215,\n    stroke: 0.090,\n    gap: 0.220',
    to: '    halfWidth: 0.200,\n    halfHeight: 0.215,\n    stroke: 0.090,\n    gap: 0.090'
  },
  {
    id: 'MI2', file: 'icon-compact.mjs',
    desc: '常规 Variant 的中缝被收窄到等于笔画宽度（32/64px 也会糊成 X）',
    from: '    halfWidth: 0.160,\n    halfHeight: 0.275,\n    stroke: 0.085,\n    gap: 0.185',
    to: '    halfWidth: 0.160,\n    halfHeight: 0.275,\n    stroke: 0.085,\n    gap: 0.085'
  },
  {
    id: 'MI3', file: 'icon-compact.mjs',
    desc: '小尺寸 Variant 的选择边界写成 <（24px 拿到错误的笔画）',
    from: '  return size <= SMALL_MAX_SIZE',
    to: '  return size < SMALL_MAX_SIZE'
  },
  {
    id: 'MI4', file: 'icon-compact.mjs',
    desc: 'alpha 不再由 coverage 决定，一律写死 255（轮廓外的圆角变方块）',
    from: '      rgba[at + 3] = Math.round(clamp01(alpha) * 255)',
    to: '      rgba[at + 3] = 255'
  },
  {
    id: 'MI5', file: 'icon-compact.mjs',
    desc: '小尺寸边缘锐化失效（16px 笔画重新变成一摊半透明像素）',
    from: 'export const SMALL_EDGE_SHARPEN = 1.5',
    to: 'export const SMALL_EDGE_SHARPEN = 1'
  },
  {
    id: 'MI6', file: 'icon-compact.mjs',
    desc: 'coverage 不做缩放直接返回原图 alpha（长度不对，等长检查失效）',
    from: '  const scaled = resize(master, size)',
    to: '  const scaled = master'
  },
  {
    id: 'MI7', file: 'icon-compact.mjs',
    desc: '忽略显式指定的 Variant（大小两套几何再也没区别）',
    from: "  const glyph = typeof variantName === 'object' ? variantName : VARIANTS[variantName]",
    to: "  const glyph = VARIANTS['brackets']"
  },
  {
    id: 'MI8', file: 'ico.mjs',
    desc: 'ICO 把一字节尺寸 0 解成字面 0（256px 条目读成 0px）',
    from: 'const decodeSize = byte => (byte === 0 ? 256 : byte)',
    to: 'const decodeSize = byte => byte'
  },
  {
    id: 'MI9', file: 'ico.mjs',
    desc: 'ICO 不再校验条目载荷是不是 PNG（DIB 条目会被静默吞掉）',
    from: 'if (png.length !== length || png.length < 8 || png.readUInt32BE(0) !== 0x89504e47) {',
    to: 'if (false) {'
  },
  {
    id: 'MI10', file: 'icns.mjs',
    desc: 'ICNS 分块长度漏掉头部 8 字节（写出来的容器解析不出来）',
    from: '    head.writeUInt32BE(payload.length + 8, 4)',
    to: '    head.writeUInt32BE(payload.length, 4)'
  },
  {
    id: 'MI11', file: 'icns.mjs',
    desc: 'ICNS 替换缺失分块时静默通过（拼错类型名也不会报错）',
    from: '  if (replaced !== 1) throw new Error(`ICNS_CHUNK_COUNT:${type}=${replaced}`)',
    to: '  if (replaced < 0) throw new Error(`ICNS_CHUNK_COUNT:${type}=${replaced}`)'
  }
]

function makeCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-mut-icon-'))
  for (const file of FILES) fs.copyFileSync(path.join(DESKTOP, file), path.join(dir, file))
  return dir
}

function runTest(dir) {
  try {
    execFileSync(process.execPath, ['--test', '--test-timeout=30000', path.join(dir, TEST)], {
      cwd: dir,
      stdio: 'ignore',
      timeout: 120000
    })
    return true
  } catch {
    return false
  }
}

// 语法预检：变异把文件改出语法错误时测试也会「失败」，那是假杀死
function syntaxOk(file) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

console.log(`${C.b}变异测试 · 验证小尺寸图标几何与容器读写的用例是否真能抓到缺陷${C.x}`)
console.log(`${C.d}被测对象：desktop/{icon-compact,ico,icns,png}.mjs · 变异体 ${MUTANTS.length} 个${C.x}\n`)

const baseline = makeCopy()
const baseOk = runTest(baseline)
fs.rmSync(baseline, { recursive: true, force: true })
if (!baseOk) {
  console.error(`${C.r}✗ 基线失败：未变异的源码就过不了测试${C.x}`)
  console.error(`${C.d}  先单独跑：node --test desktop/icon-compact.test.mjs${C.x}`)
  process.exit(1)
}
console.log(`${C.g}✓ 基线通过${C.x}\n`)

const rows = []
for (const m of MUTANTS) {
  const dir = makeCopy()
  try {
    const target = path.join(dir, m.file)
    const src = fs.readFileSync(target, 'utf8')
    const hit = src.indexOf(m.from)
    if (hit < 0) {
      rows.push({ ...m, result: 'anchor-missing' })
      console.log(`${C.y}! ${m.id} 锚点失效${C.x}  ${m.desc}`)
      continue
    }
    if (src.indexOf(m.from, hit + 1) >= 0) {
      rows.push({ ...m, result: 'anchor-ambiguous' })
      console.log(`${C.y}! ${m.id} 锚点不唯一${C.x}  ${m.desc}`)
      continue
    }
    fs.writeFileSync(target, src.replace(m.from, m.to))
    if (!syntaxOk(target)) {
      rows.push({ ...m, result: 'syntax' })
      console.log(`${C.y}! ${m.id} 变异体本身语法错误（假杀死，不计入）${C.x}  ${m.desc}`)
      continue
    }
    const passed = runTest(dir)
    rows.push({ ...m, result: passed ? 'survived' : 'killed' })
    if (passed) console.log(`${C.r}✗ ${m.id} 存活${C.x}  ${m.desc}`)
    else console.log(`${C.g}✓ ${m.id} 被杀死${C.x}  ${m.desc}`)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const killed = rows.filter(r => r.result === 'killed').length
const survived = rows.filter(r => r.result === 'survived')
const broken = rows.filter(r => ['anchor-missing', 'anchor-ambiguous', 'syntax'].includes(r.result))

console.log('\n' + '─'.repeat(70))
console.log(`  变异体 ${rows.length} 个 · 杀死 ${killed} · 存活 ${survived.length} · 无效 ${broken.length}`)
console.log('─'.repeat(70))

if (survived.length || broken.length) {
  if (survived.length) console.error(`${C.r}✗ 存在盲区${C.x}：${survived.map(r => r.id).join(', ')}`)
  if (broken.length) console.error(`${C.y}! 无效变异体${C.x}：${broken.map(r => r.id).join(', ')}（改了源码请同步更新锚点）`)
  process.exit(1)
}
console.log(`${C.g}✅ 全部变异体被杀死，零盲区${C.x}`)
