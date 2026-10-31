// Rebuild native brand assets using the existing, locked Tauri CLI dependency.
// Source of truth: src-tauri/icons/icon.svg; installer geometry: installer-art.mjs.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, copyFileSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktop = dirname(fileURLToPath(import.meta.url))
const repository = resolve(desktop, '..')
const output = join(repository, 'output', 'branding')
mkdirSync(output, { recursive: true })
const generated = mkdtempSync(join(output, 'native-'))
const run = args => {
  const result = spawnSync(process.execPath, args, { cwd: repository, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Brand asset generation failed: ${result.status}`)
}
run([join(desktop, 'node_modules', '@tauri-apps', 'cli', 'tauri.js'), 'icon', join(desktop, 'src-tauri', 'icons', 'icon.svg'), '--output', generated])
for (const name of ['icon.png', 'icon.ico', 'icon.icns']) copyFileSync(join(generated, name), join(desktop, 'src-tauri', 'icons', name))
run([join(desktop, 'installer-art.mjs')])
console.log(`Brand assets rebuilt; generated variants retained at ${generated}`)
