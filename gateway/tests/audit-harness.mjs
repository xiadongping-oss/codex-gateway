// Cross-platform, offline audit fixture. Own every process; never kill a port owner.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'

const GW = fileURLToPath(new URL('..', import.meta.url))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function unusedPort() {
  const server = net.createServer()
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}
export async function createAuditHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-audit-'))
  const sandbox = path.join(root, 'gateway')
  const home = path.join(sandbox, 'home')
  const generated = path.join(home, '.chatgpt-bridge', 'gen-images')
  const port = await unusedPort()
  fs.mkdirSync(sandbox); fs.mkdirSync(generated, { recursive: true })
  for (const name of fs.readdirSync(GW)) {
    if (/\.(mjs|html)$/.test(name)) fs.copyFileSync(path.join(GW, name), path.join(sandbox, name))
  }
  fs.copyFileSync(path.join(GW, '../package.json'), path.join(root, 'package.json'))
  fs.cpSync(path.join(GW, '../docs/lan-kit'), path.join(sandbox, 'lan-kit'), { recursive: true })
  fs.cpSync(path.join(GW, 'node_modules'), path.join(sandbox, 'node_modules'), { recursive: true })
  // Audit tests gateway auth/isolation/pool ownership, never provider behavior.
  // Pin this fixture in its isolated manifest; production hash checks remain enabled.
  const bridge = path.join(sandbox, 'node_modules/chatgpt-bridge')
  const fake = `import http from 'node:http';
    http.createServer((req,res)=>{req.resume();res.writeHead(503,{'Content-Type':'application/json'});res.end('{"error":"offline_audit_fixture"}');}).listen(Number(process.env.CHATGPT_BRIDGE_PORT),'127.0.0.1');`
  fs.writeFileSync(path.join(bridge, 'dist/cli.js'), fake)
  fs.writeFileSync(path.join(bridge, 'dist/index.js'), 'export {}\n')
  const manifest = JSON.parse(fs.readFileSync(path.join(GW, 'patches/manifest.json')))
  for (const name of ['cli.js', 'index.js']) {
    const bytes = fs.readFileSync(path.join(bridge, 'dist', name))
    manifest.files[name] = crypto.createHash('sha256').update(bytes).digest('hex')
  }
  fs.mkdirSync(path.join(sandbox, 'patches'))
  fs.writeFileSync(path.join(sandbox, 'patches/manifest.json'), JSON.stringify(manifest))
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
    CGW_DATA_DIR: sandbox, CGW_STORAGE_MODE: 'legacy', CGW_DESKTOP: '0', LAUNCHER_PORT: String(port),
    BRIDGE_PORT: String(await unusedPort()), DISABLE_AUTOSTART: '1', CGW_OPEN_BROWSER: '0' }
  for (const name of ['CGW_ALLOWED_HOSTS', 'CGW_LAN_HOST', 'FRONTEND_DIR', 'CGW_ADMIN_AUTH', 'CGW_ADMIN_TOKEN', 'CGW_QUOTA_FILE', 'API_PROVIDERS_STORE_PATH', 'ASSETS_STORE_PATH', 'BRIDGE_CLI', 'BRIDGE_NODE', 'BRIDGE_ARGS', 'CODEX_HOME', 'CHATGPT_BRIDGE_HOME', 'CHATGPT_BRIDGE_DATA_DIR', 'NODE_OPTIONS', 'NODE_PATH']) delete env[name]
  const base = `http://127.0.0.1:${port}`
  const tokenFile = path.join(sandbox, 'admin-token.json')
  const children = new Set()
  function reset() {
    fs.mkdirSync(path.join(sandbox, 'data'), { recursive: true })
    for (const [name, obj] of Object.entries({ 'accounts.json': { activeId: null, accounts: [] }, 'api-keys.json': { keys: [] }, 'data/asset-sources.json': { sources: [] }, '.gw-config.json': { mode: 'bridge', strictAuth: false, proxy: '', openaiApiKey: 'CANARY-SECRET-DO-NOT-LEAK', authFilePath: path.join(home, '.chatgpt-bridge/auth.json') } })) {
      fs.writeFileSync(path.join(sandbox, name), JSON.stringify(obj))
    }
    for (const name of fs.readdirSync(generated)) fs.unlinkSync(path.join(generated, name))
    fs.writeFileSync(path.join(generated, 'index.json'), '{}')
  }
  async function start() {
    const child = spawn(process.execPath, ['launcher.mjs', '--lan'], { cwd: sandbox, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    children.add(child)
    child.completion = once(child, 'exit')
    child.once('exit', () => children.delete(child))
    child.stdin.on('error', () => {})
    let stderr = ''
    child.stderr.on('data', b => { stderr = (stderr + b).slice(-2000) })
    child.stdout.resume()
    // Test-owned stdin triggers the ordinary graceful shutdown path on Windows too.
    for (let i = 0; i < 100 && child.exitCode === null; i++) {
      if (fs.existsSync(tokenFile)) {
        const token = JSON.parse(fs.readFileSync(tokenFile)).token
        try {
          const result = await fetch(base + '/__gw/status', { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(500) })
          if (result.ok && child.exitCode === null) { await result.arrayBuffer(); return child }
        } catch {}
      }
      await sleep(30)
    }
    await stop(child)
    throw new Error('Isolated audit gateway failed to start: ' + stderr)
  }
  async function stop(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    child.stdin.end('stop')
    for (let i = 0; i < 120 && child.exitCode === null && child.signalCode === null; i++) await sleep(50)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await child.completion
  }
  // Keep the test hook outside production source and protocol.
  const launcher = path.join(sandbox, 'launcher.mjs')
  fs.appendFileSync(launcher, "\nprocess.stdin.resume();process.stdin.once('data',()=>process.emit('SIGTERM'));\n")
  async function audit() {
    const child = spawn(process.execPath, [path.join(GW, 'tests/audit.mjs'), '--base=' + base, '--gendir=' + generated, '--tokenfile=' + tokenFile, '--lankit=' + path.join(sandbox, 'lan-kit')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', b => { out += b }); child.stderr.on('data', b => { out += b })
    const [code] = await once(child, 'exit')
    return { code, out }
  }
  async function close() {
    for (const child of children) await stop(child)
    fs.rmSync(root, { recursive: true, force: true }) // own mkdtemp root only
  }
  return { sandbox, reset, start, stop, audit, close }
}
