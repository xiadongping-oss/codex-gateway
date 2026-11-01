// Rebuild every native brand asset from the committed master icon.
//
// Source of truth: src-tauri/icons/icon-master.png (our own artwork, kept in
// the repository). The Tauri CLI is already a locked dev dependency here, so
// every platform variant still comes from the same toolchain the build uses.
//
// The second half of this script substitutes the *small* representations with
// icon-compact.mjs output. `tauri icon` can only downscale one master, and a
// single downscale is exactly what loses the glyph — see the notes in
// icon-compact.mjs for why the outline has to change with size.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, copyFileSync, writeFileSync, readFileSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodePng, encodePng, encodePngBuffer } from './png.mjs'
import { readIco, writeIco } from './ico.mjs'
import { readIcns, writeIcns, replaceChunk, TYPE_SIZES } from './icns.mjs'
import { renderCompact, coverageFromMaster, COMPACT_MAX_SIZE } from './icon-compact.mjs'

const desktop = dirname(fileURLToPath(import.meta.url))
const repository = resolve(desktop, '..')
const icons = join(desktop, 'src-tauri', 'icons')
const masterFile = join(icons, 'icon-master.png')
const output = join(repository, 'output', 'branding')
mkdirSync(output, { recursive: true })
const generated = mkdtempSync(join(output, 'native-'))
const run = args => {
  const result = spawnSync(process.execPath, args, { cwd: repository, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Brand asset generation failed: ${result.status}`)
}
run([join(desktop, 'node_modules', '@tauri-apps', 'cli', 'tauri.js'), 'icon', masterFile, '--output', generated])
for (const name of ['icon.png', 'icon.ico', 'icon.icns']) copyFileSync(join(generated, name), join(icons, name))

// ---- small-size substitution -------------------------------------------------
const master = decodePng(masterFile)
const variantsGenerated = []
const compactPng = size => {
  const image = renderCompact(size, coverageFromMaster(master, size))
  variantsGenerated.push(size)
  return encodePngBuffer(image)
}

const icoEntries = readIco(readFileSync(join(icons, 'icon.ico')))
const patchedIco = icoEntries.map(entry =>
  entry.size <= COMPACT_MAX_SIZE ? { size: entry.size, png: compactPng(entry.size) } : entry
)
writeFileSync(join(icons, 'icon.ico'), writeIco(patchedIco))

// Only the PNG chunks are rewritten. The container also carries legacy PackBits
// representations (is32/il32 and their masks) which some very old macOS APIs
// still consult; re-encoding those would mean shipping a hand-written RLE
// encoder that cannot be verified from this machine, so they keep the master's
// art. Modern macOS reads ic11/ic12/ic07.
let icnsChunks = readIcns(readFileSync(join(icons, 'icon.icns')))
for (const [type, size] of Object.entries(TYPE_SIZES)) {
  if (size > COMPACT_MAX_SIZE) continue
  if (!icnsChunks.some(chunk => chunk.type === type)) continue
  icnsChunks = replaceChunk(icnsChunks, type, compactPng(size))
}
writeFileSync(join(icons, 'icon.icns'), writeIcns(icnsChunks))

// The tray icon is compiled into the binary. Embedding the 512px masterpiece
// would cost a quarter megabyte to draw a 24px menu image, and the tray is the
// one place the glyph always renders small.
encodePng(join(icons, 'tray.png'), renderCompact(64, coverageFromMaster(master, 64)))

const needsCompact = variantsGenerated.filter((size, index, all) => all.indexOf(size) === index).sort((a, b) => a - b)
console.log(`Compact artwork substituted at ${needsCompact.join(', ')}px (<= ${COMPACT_MAX_SIZE})`)

writeFileSync(join(icons, 'README.md'), `# 图标资产

- \`icon-master.png\` —— 唯一源图（本项目自行生成的作品，1024×1024，圆角外透明）。
- \`icon.png\` / \`icon.ico\` / \`icon.icns\` —— \`tauri icon\` 从源图生成，**不要手改**。
  - 其中 \`<= ${COMPACT_MAX_SIZE}px\` 的条目由 \`icon-compact.mjs\` 替换为简化的无宝石版本，理由见该文件头部注释。
  - \`icon.icns\` 里的历史 PackBits 条目（\`is32\` / \`il32\` / \`s8mk\` / \`l8mk\`）保持原图未改。
- \`tray.png\` —— 托盘图标，64×64 简化版本，编译期嵌入二进制。
- 安装器横幅 \`installer/sidebar.bmp\`、\`installer/header.bmp\` —— \`installer-art.mjs\` 从同一张源图绘制。

重新生成全部资产：

\`\`\`bash
node desktop/build-branding.mjs
\`\`\`
`)
run([join(desktop, 'installer-art.mjs')])
console.log(`Brand assets rebuilt from icon-master.png; variants retained at ${generated}`)
