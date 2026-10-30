import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { prepareDesktop, verifyDesktop } from '../prepare-desktop.mjs'

const desktop = path.dirname(fileURLToPath(import.meta.url)), root = path.dirname(desktop)
const target = `${process.platform}-${process.arch}`
if (!['win32-x64', 'darwin-arm64', 'darwin-x64'].includes(target)) throw new Error('Unsupported desktop build host')
const args = process.argv.slice(2), test = args.includes('--test'), release = args.includes('--release')
const generated = path.join(desktop, '.generated')
fs.mkdirSync(generated, { recursive: true })
// A fresh owned directory per build: never merge or silently delete older resources.
const outDir = path.join(generated, `${target}-${Date.now()}`)
await prepareDesktop({ root, target, outDir, offline: args.includes('--offline') })
verifyDesktop({ target, outDir })
const overlay = { bundle: { resources: { [path.relative(path.join(desktop, 'src-tauri'), outDir).replaceAll('\\', '/') + '/']: 'gateway-resources/' } } }
const env = { ...process.env, CARGO_TARGET_DIR: path.join(desktop, 'src-tauri/target'), CGW_BUILD_RESOURCES: outDir, TAURI_CONFIG: JSON.stringify(overlay) }
fs.writeFileSync(path.join(generated, 'last-build.json'), JSON.stringify({ target, outDir, overlay, release }, null, 2) + '\n')
const cmd = ['--manifest-path', path.join(desktop, 'src-tauri/Cargo.toml')]
const child = spawn('cargo', [test ? 'test' : 'build', ...cmd, '--features', 'custom-protocol', ...(release ? ['--release'] : []), ...(args.includes('--locked') ? ['--locked'] : []), ...(args.includes('--offline') ? ['--offline'] : [])], { cwd: root, env, windowsHide: true, stdio: 'inherit' })
child.on('error', error => { console.error(error.message); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 1 })
