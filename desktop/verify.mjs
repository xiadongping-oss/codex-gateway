import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { inspectHost, cargoEnvironment, ValidationRun, NATIVE_SCENARIOS } from './validation.mjs'
import { verifyDesktop } from '../prepare-desktop.mjs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
for (const arg of args) if (!['--offline', '--preflight-only', '--native'].includes(arg) && !arg.startsWith('--expect-target=') && !arg.startsWith('--report-dir=')) throw new Error(`未知验证选项：${arg}`)
const option = name => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const reportDir = option('report-dir') || path.join(root, 'output/desktop-validation', `${Date.now()}-${crypto.randomUUID()}`)
const run = new ValidationRun(reportDir)
run.report.scope = args.includes('--native') ? 'build_core_and_native_checks' : 'build_and_core_tests'
const offline = args.includes('--offline') ? ['--offline'] : []
try {
  try {
    run.report.source = {
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 5000 }).trim(),
      hasUncommittedChanges: Boolean(execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 15000 }).trim())
    }
  } catch { run.report.source = { status: 'not_available' } }
  run.report.host = inspectHost(option('expect-target'))
  run.save()
  console.log(`验证 ${run.report.host.target}；记录：${run.directory}`)
  if (args.includes('--preflight-only')) { run.finish('preflight_passed'); process.exit(0) }
  // Frontend dependencies are installed explicitly by the developer/CI; the
  // gateway's versioned dependency tree is read as-is, never npm-installed here.
  await run.step('frontend', process.execPath, [path.join(root, 'frontend/node_modules/vite/bin/vite.js'), 'build'], { cwd: path.join(root, 'frontend') })
  await run.step('validation-tests', process.execPath, ['--test', 'desktop/validation.test.mjs'], { cwd: root })
  await run.step('gateway-core', process.execPath, ['--test', '--test-timeout=60000', 'gateway/tests/storage.test.mjs', 'gateway/tests/storage-integration.test.mjs', 'gateway/tests/desktop.test.mjs', 'gateway/tests/desktop-integration.test.mjs'], { cwd: root })
  await run.step('rust-tests', process.execPath, ['desktop/build.mjs', '--test', '--locked', ...offline], { cwd: root, timeout: 25 * 60_000, env: { ...process.env, ...(process.platform === 'darwin' ? { MACOSX_DEPLOYMENT_TARGET: '13.0' } : {}) } })
  if (process.platform === 'darwin') { run.report.acceptance.macLockRecovery = 'core_scenarios_passed'; run.save() }
  const build = JSON.parse(fs.readFileSync(path.join(root, 'desktop/.generated/last-build.json')))
  const env = cargoEnvironment(root, build)
  const manifest = verifyDesktop({ target: run.report.host.target, outDir: env.CGW_BUILD_RESOURCES })
  run.report.resources = { target: manifest.target, version: manifest.appVersion, nodeVersion: manifest.runtime.version, files: Object.keys(manifest.files).length,
    manifestSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(env.CGW_BUILD_RESOURCES, 'DESKTOP-RESOURCES.json'))).digest('hex') }
  const common = ['--manifest-path', 'desktop/src-tauri/Cargo.toml', '--features', 'custom-protocol', '--locked', ...offline]
  await run.step('rust-lint', 'cargo', ['clippy', ...common, '--all-targets', '--', '-D', 'warnings'], { cwd: root, env })
  await run.step('rust-build', 'cargo', ['build', ...common], { cwd: root, env })
  await run.step('bundled-gateway', process.execPath, ['gateway/tests/prepared-resources-smoke.mjs', `--resources=${env.CGW_BUILD_RESOURCES}`], { cwd: root, env })
  if (args.includes('--native')) {
    run.report.acceptance.nativeUi = 'running'
    run.report.acceptance.nativeScenarios = Object.fromEntries(Object.keys(NATIVE_SCENARIOS).map(scenario => [scenario, 'not_run']))
    for (const [scenario, deadline] of Object.entries(NATIVE_SCENARIOS)) {
      run.report.acceptance.nativeScenarios[scenario] = 'running'; run.save()
      try {
        await run.step(`window-${scenario}`, process.execPath, ['desktop/smoke.mjs', scenario === 'port-conflict' ? '--port-conflict' : `--case=${scenario}`], { cwd: root, timeout: deadline + 30_000 })
      } catch (error) {
        run.report.acceptance.nativeScenarios[scenario] = 'failed'
        run.report.acceptance.nativeUi = 'failed'
        throw error
      }
      run.report.acceptance.nativeScenarios[scenario] = 'passed'; run.save()
    }
    run.report.acceptance.nativeUi = 'automated_scenarios_passed'
  }
  run.finish()
  console.log('PASS: 所选构建与自动化检查完成；真实鼠标操作、系统登录自启动、OAuth/API 和安装签名仍需另行验收。')
} catch (error) {
  run.report.error = error.message
  run.finish('failed')
  console.error(`FAIL: ${error.message}\n记录：${run.directory}`)
  process.exitCode = 1
}
