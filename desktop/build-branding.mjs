// Rebuild web, native and installer artwork from the ImageGen master image.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'
import { decodePng } from './png.mjs'
import { writeIco } from './ico.mjs'
import { readIcns, writeIcns, replaceChunk, TYPE_SIZES } from './icns.mjs'

const desktop = dirname(fileURLToPath(import.meta.url))
const repository = resolve(desktop, '..')
const icons = join(desktop, 'src-tauri', 'icons')
const source = readFileSync(join(desktop, 'brand-master.png'))
// Find the centered tile's solid horizontal/vertical spans, ignoring isolated
// transparent-edge speckles. Normalize its bounds instead of retaining the
// generator's padding: the exported tile occupies 97% of EVERY icon size.
const master = decodePng(join(desktop, 'brand-master.png'))
const { width, height, rgba } = master
const cx = Math.floor(width / 2), cy = Math.floor(height / 2)
const opaque = (x, y) => rgba[(y * width + x) * 4 + 3] >= 200
if (!opaque(cx, cy)) throw new Error('Brand master must have a solid center')
let left = cx, right = cx, top = cy, bottom = cy
while (left > 0 && opaque(left - 1, cy)) left--
while (right < width - 1 && opaque(right + 1, cy)) right++
while (top > 0 && opaque(cx, top - 1)) top--
while (bottom < height - 1 && opaque(cx, bottom + 1)) bottom++
const cropWidth = right - left + 1, cropHeight = bottom - top + 1
if (Math.min(cropWidth / width, cropHeight / height) < 0.6) throw new Error('Brand tile is too small or has transparent holes')
const raster = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><defs><clipPath id="tile"><rect x="16" y="16" width="992" height="992" rx="248"/></clipPath></defs><g clip-path="url(#tile)"><svg x="16" y="16" width="992" height="992" viewBox="${left} ${top} ${cropWidth} ${cropHeight}" preserveAspectRatio="none"><image width="${width}" height="${height}" href="data:image/png;base64,${source.toString('base64')}"/></svg></g></svg>`
const png = size => {
  const rendered = new Resvg(raster, { fitTo: { mode: 'width', value: size } }).render()
  if (size <= 64) {
    const pixels = rendered.pixels, center = Math.floor(size / 2)
    // Enforce the size of shipped taskbar/title-bar representations, not just
    // the 1024px artwork. At most one blank pixel per side after rasterization.
    for (const vertical of [false, true]) {
      let first = size, last = -1
      for (let i = 0; i < size; i++) {
        const index = vertical ? i * size + center : center * size + i
        if (pixels[index * 4 + 3] >= 128) { first = Math.min(first, i); last = i }
      }
      if (last - first + 1 < size - 2) throw new Error(`Brand icon has excessive padding at ${size}px`)
    }
  }
  return Buffer.from(rendered.asPng())
}
const output = join(repository, 'output', 'branding')
mkdirSync(output, { recursive: true })
const generated = mkdtempSync(join(output, 'native-'))
const run = args => {
  const result = spawnSync(process.execPath, args, { cwd: repository, stdio: 'inherit', windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Brand asset generation failed: ${result.status}`)
}

writeFileSync(join(icons, 'icon-master.png'), png(1024))
run([join(desktop, 'node_modules', '@tauri-apps', 'cli', 'tauri.js'), 'icon', join(icons, 'icon-master.png'), '--output', generated])
// Resample each Windows size from the master, including intermediate DPI sizes.
const sizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
writeFileSync(join(icons, 'icon.ico'), writeIco(sizes.map(size => ({ size, png: png(size) }))))
writeFileSync(join(icons, 'icon.png'), png(512))
writeFileSync(join(icons, 'tray.png'), png(64))
// Keep the CLI's legacy PackBits entries; refresh every modern PNG representation.
let chunks = readIcns(readFileSync(join(generated, 'icon.icns')))
for (const [type, size] of Object.entries(TYPE_SIZES)) {
  if (chunks.some(chunk => chunk.type === type)) chunks = replaceChunk(chunks, type, png(size))
}
writeFileSync(join(icons, 'icon.icns'), writeIcns(chunks))

const assets = join(repository, 'frontend', 'src', 'assets')
mkdirSync(assets, { recursive: true })
writeFileSync(join(assets, 'brand.png'), png(256))
writeFileSync(join(desktop, 'ui', 'brand.png'), png(128))
// The web console ships as one HTML file, so its favicon stays embedded.
const indexFile = join(repository, 'frontend', 'index.html')
const favicon = `data:image/png;base64,${png(64).toString('base64')}`
writeFileSync(indexFile, readFileSync(indexFile, 'utf8').replace(/^\s*<link rel="icon".*$/m, `    <link rel="icon" type="image/png" href="${favicon}" />`))

writeFileSync(join(icons, 'README.md'), `# 图标资产

源文件：\`desktop/brand-master.png\`，使用内置 ImageGen 独立设计的折带回环标识：石墨紫底、珍珠白与浅玉绿带面表达连接和信息流转；提示词见 \`desktop/branding-prompt.txt\`。

- \`icon-master.png\`：1024px，圆角外透明；底板有效宽高约占画布 97%，避免任务栏图标偏小。
- \`icon.png\`：512px，原生窗口默认图标。
- \`icon.ico\`：${sizes.join(' / ')}px，覆盖标题栏、任务栏、桌面快捷方式和安装器。
- \`icon.icns\`：macOS 图标；现代 PNG 条目从同一原稿生成。
- \`tray.png\`：64px，系统托盘。
- \`frontend/src/assets/brand.png\`、\`desktop/ui/brand.png\` 和网页 favicon：从同一源文件生成。
- \`installer/sidebar.bmp\`、\`installer/header.bmp\`：安装器配套图。

重新生成：\`npm run desktop:branding\`，随后 \`npm run build\` 更新控制台产物。请替换图像原稿，不要手改生成资源。
历史的 \`icon-compact.mjs\` 是旧版括号图案的独立工具，新品牌构建不再使用。
`)
run([join(desktop, 'installer-art.mjs')])
console.log(`Brand assets rebuilt from brand-master.png; native intermediates: ${generated}`)
