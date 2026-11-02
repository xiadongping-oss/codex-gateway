// Rebuild web, native and installer artwork from the ImageGen master image.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'
import { writeIco } from './ico.mjs'
import { readIcns, writeIcns, replaceChunk, TYPE_SIZES } from './icns.mjs'

const desktop = dirname(fileURLToPath(import.meta.url))
const repository = resolve(desktop, '..')
const icons = join(desktop, 'src-tauri', 'icons')
const source = readFileSync(join(desktop, 'brand-master.png'))
// Apply a consistent rounded export boundary to exclude generation fringes.
// The artwork inside the tile remains the generated bitmap at every size.
const raster = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><defs><clipPath id="tile"><rect x="72" y="72" width="880" height="880" rx="236"/></clipPath></defs><image clip-path="url(#tile)" width="1024" height="1024" href="data:image/png;base64,${source.toString('base64')}"/></svg>`
const png = size => Buffer.from(new Resvg(raster, { fitTo: { mode: 'width', value: size } }).render().asPng())
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

源文件：\`desktop/brand-master.png\`，使用内置 ImageGen 以 Codex 云形轮廓为基础改绘的网关图案；提示词见 \`desktop/branding-prompt.txt\`。

- \`icon-master.png\`：1024px，圆角外透明。
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
