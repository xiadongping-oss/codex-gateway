// Internal unsigned preview only. Build from current source; never package a stale executable.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { prepareDesktop, verifyDesktop } from '../prepare-desktop.mjs'
import { releaseRustEnvironment } from './rust-environment.mjs'
import { inspectDistributionPaths } from './distribution-paths.mjs'

const desktop = path.dirname(fileURLToPath(import.meta.url)), root = path.dirname(desktop)
const args = process.argv.slice(2)
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Windows x64 host required')
if (args.some(arg => arg !== '--offline')) throw new Error('Supported option: --offline (Cargo and Node cache only; NSIS/WebView downloads may still require network)')
if (process.env.CARGO_BUILD_TARGET) throw new Error('Cross compilation is not supported by this entry point')
const cli = path.join(desktop, 'node_modules/@tauri-apps/cli/tauri.js')
if (!fs.existsSync(cli)) throw new Error('Run npm ci --prefix desktop --ignore-scripts first')
const target = 'win32-x64', run = `${target}-${Date.now()}`
const destination = path.join(root, 'release/desktop-preview', run)
const outDir = path.join(desktop, '.generated', run)
fs.mkdirSync(destination, { recursive: true })
const report = { status: 'running', channel: 'internal-unsigned-preview', target, startedAt: new Date().toISOString(), stages: [], signed: false, installed: false, cleanMachineTest: 'not_run' }
const save = () => fs.writeFileSync(path.join(destination, 'report.json'), JSON.stringify(report, null, 2) + '\n')
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
async function runCommand(name, command, argv, cwd, env = process.env) {
  const stage = { name, status: 'running', startedAt: new Date().toISOString() }
  report.stages.push(stage); save()
  const log = fs.createWriteStream(path.join(destination, `${name}.log`), { flags: 'wx' })
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(command, argv, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      child.stdout.on('data', chunk => { log.write(chunk); process.stdout.write(chunk) })
      child.stderr.on('data', chunk => { log.write(chunk); process.stderr.write(chunk) })
      child.on('error', reject)
      child.on('close', code => code === 0 ? resolve() : reject(new Error(`${name} exited ${code}`)))
    })
    stage.status = 'passed'
  } catch (error) { stage.status = 'failed'; throw error }
  finally { await new Promise(resolve => log.end(resolve)); stage.finishedAt = new Date().toISOString(); save() }
}
try {
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version
  if (version !== JSON.parse(fs.readFileSync(path.join(desktop, 'src-tauri/tauri.conf.json'))).version) throw new Error('Desktop / gateway version mismatch')
  report.version = version
  await runCommand('frontend', process.execPath, [path.join(root, 'frontend/node_modules/vite/bin/vite.js'), 'build'], path.join(root, 'frontend'))
  await prepareDesktop({ root, target, outDir, offline: args.includes('--offline') })
  verifyDesktop({ target, outDir })
  report.resourceManifestSha256 = hash(path.join(outDir, 'DESKTOP-RESOURCES.json'))
  const overlay = JSON.parse(fs.readFileSync(path.join(desktop, 'windows-bundle.json')))
  overlay.bundle.resources = { [path.relative(path.join(desktop, 'src-tauri'), outDir).replaceAll('\\', '/') + '/']: 'gateway-resources/' }
  overlay.bundle.resources['installer/TAURI-LICENSE-MIT.txt'] = 'TAURI-LICENSE-MIT.txt'
  const config = path.join(destination, 'bundle-config.json')
  fs.writeFileSync(config, JSON.stringify(overlay, null, 2) + '\n')
  // Dedicated release cache; timestamp validation below rejects any stale installer.
  const cargoTarget = path.join(desktop, 'src-tauri/target/windows-package')
  const env = { ...releaseRustEnvironment(root), CARGO_TARGET_DIR: cargoTarget, CGW_BUILD_RESOURCES: outDir }
  await runCommand('tauri-build', process.execPath, [cli, 'build', '--ci', '--no-sign', '--no-bundle', '--config', config, '--', '--locked', ...(args.includes('--offline') ? ['--offline'] : [])], desktop, env)
  const binary = path.join(cargoTarget, 'release/codex-gateway-desktop.exe')
  report.binaryPaths = inspectDistributionPaths(binary, root)
  save()
  if (report.binaryPaths.status !== 'passed') throw new Error('Distribution binary contains local build paths; see binaryPaths report')
  const builtResources = path.join(cargoTarget, 'release/gateway-resources')
  verifyDesktop({ target, outDir: builtResources })
  if (hash(path.join(builtResources, 'DESKTOP-RESOURCES.json')) !== report.resourceManifestSha256) throw new Error('Compiled resources mismatch')
  await runCommand('bundled-gateway', process.execPath, ['gateway/tests/prepared-resources-smoke.mjs', `--resources=${builtResources}`], root)
  const stem = `Codex-Gateway-${version}-windows-x64-preview`
  const portable = path.join(destination, stem)
  fs.mkdirSync(portable)
  fs.copyFileSync(binary, path.join(portable, path.basename(binary)), fs.constants.COPYFILE_EXCL)
  fs.copyFileSync(path.join(desktop, 'src-tauri/installer/TAURI-LICENSE-MIT.txt'), path.join(portable, 'TAURI-LICENSE-MIT.txt'), fs.constants.COPYFILE_EXCL)
  fs.cpSync(builtResources, path.join(portable, 'gateway-resources'), { recursive: true, errorOnExist: true, force: false })
  fs.writeFileSync(path.join(portable, '使用说明.txt'), '\uFEFFCodex Gateway 桌面内部预览版（未签名）\r\n\r\n解压整个目录后运行 codex-gateway-desktop.exe；无需安装 Node。\r\n需要 Windows x64 和 Microsoft Edge WebView2 运行时；缺少运行时请使用 Setup 安装包联网安装。\r\n账号、配置和图片默认位于 %LOCALAPPDATA%\\CodexGateway。\r\n窗口缓存和桌面日志位于 %LOCALAPPDATA%\\CodexGatewayDesktop。\r\n本 ZIP 免安装，但不是数据随身模式；移动或删除程序目录不会删除账号。\r\n关闭窗口会继续后台运行；在桌面管理页或托盘菜单选择退出应用。\r\n升级、移动、卸载前请先退出应用；当前版本尚未完成正式发行验收。\r\n')
  verifyDesktop({ target, outDir: path.join(portable, 'gateway-resources') })
  const zip = path.join(destination, `${stem}.zip`)
  await runCommand('zip-verify', 'powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(desktop, 'archive-windows.ps1'), '-Source', portable, '-Destination', zip], root)
  report.artifacts = [{ file: path.basename(zip), bytes: fs.statSync(zip).size, sha256: hash(zip) }]
  save()
  // ZIP stays usable if installer tool downloads fail. No updater is shipped, so
  // avoid mutating the verified executable with an NSIS-only bundle marker.
  await runCommand('tauri-bundle', process.execPath, [cli, 'bundle', '--ci', '--no-sign', '--no-binary-patching', '--bundles', 'nsis', '--config', config], desktop, env)
  const bundleDir = path.join(cargoTarget, 'release/bundle/nsis')
  const installers = fs.readdirSync(bundleDir).filter(name => name.endsWith('-setup.exe') && fs.statSync(path.join(bundleDir, name)).mtimeMs >= Date.parse(report.startedAt))
  if (installers.length !== 1) throw new Error('Expected exactly one fresh NSIS installer')
  const installer = path.join(destination, `${stem}-Setup.exe`)
  fs.copyFileSync(path.join(bundleDir, installers[0]), installer, fs.constants.COPYFILE_EXCL)
  report.artifacts.push({ file: path.basename(installer), bytes: fs.statSync(installer).size, sha256: hash(installer) })
  if (hash(binary) !== hash(path.join(portable, path.basename(binary)))) throw new Error('Bundling changed verified executable')
  report.status = 'packaged'
} catch (error) { report.status = 'failed'; report.error = error.message; process.exitCode = 1 }
finally {
  if (report.artifacts?.length) fs.writeFileSync(path.join(destination, 'SHA256SUMS.txt'), report.artifacts.map(item => `${item.sha256}  ${item.file}`).join('\n') + '\n')
  report.finishedAt = new Date().toISOString(); save(); console.log(`Packaging report: ${path.join(destination, 'report.json')}`)
}
