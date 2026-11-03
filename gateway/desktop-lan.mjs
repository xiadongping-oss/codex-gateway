import http from 'node:http'

export const DEFAULT_LAN_PORT = 4174
// Public client shells/downloads only. Their data APIs retain per-Key auth;
// desktop account/configuration/control routes remain loopback-only.
const CLIENT_GET_PATHS = new Set([
  '/setup', '/setup/', '/gallery', '/gallery/', '/client-setup.js', '/client-assets.json',
  '/lan-kit/setup-client.mjs', '/lan-kit/INSTALL.md', '/lan-kit/AGENT-PROMPT.md',
  '/lan-kit/skills/codex-gateway-image/SKILL.md',
])

function failure(code, message) { return Object.assign(new Error(message), { code }) }
function listenError(error, port) {
  if (error.code === 'EADDRINUSE') return failure('lan_port_in_use', `端口 ${port} 已被占用，请更换共享端口。`)
  if (error.code === 'EACCES') return failure('lan_port_permission', `无法使用端口 ${port}，请更换端口或检查系统权限。`)
  return failure('lan_listen_failed', '共享服务启动失败，请检查网络后重试。')
}

// Desktop management stays on loopback. Only this additional listener is shared.
export function createDesktopLan({ handler, consolePort, persist }) {
  let active = null, port = DEFAULT_LAN_PORT, configuredEnabled = false, error = '', stopped = false
  let queue = Promise.resolve()
  const snapshot = () => ({ enabled: !!active, configuredEnabled, port, listenHost: '0.0.0.0', manageable: true, error })
  function close(entry) {
    if (!entry) return Promise.resolve()
    return new Promise(resolve => {
      entry.server.close(() => resolve())
      for (const socket of entry.sockets) socket.destroy()
    })
  }
  async function open(nextPort) {
    const sockets = new Set()
    const server = http.createServer((req, res) => {
      res.on('error', () => {})
      let pathname
      try { pathname = new URL(req.url, 'http://localhost').pathname } catch {}
      const image = req.method === 'GET' && /^\/__gw\/gen-images\/[A-Za-z0-9_-]+\.(?:png|jpeg|webp)$/.test(pathname || '')
      const clientPage = req.method === 'GET' && CLIENT_GET_PATHS.has(pathname)
      if (!pathname || !(pathname.startsWith('/v1/') || pathname === '/health' || pathname === '/mcp' || image || clientPage)) {
        res.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        return res.end(JSON.stringify({ error: 'control_plane_local_only', message: '共享端口仅提供模型接口，管理功能请在本机使用。' }))
      }
      req.desktopLan = true
      handler(req, res)
    })
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
    server.on('clientError', (_err, socket) => socket.destroy())
    const entry = { server, sockets }
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen({ port: nextPort, host: '0.0.0.0', exclusive: true }, resolve)
      })
    } catch (e) { await close(entry); throw listenError(e, nextPort) }
    // Keep a listener after startup so a socket/server error cannot terminate the app.
    server.on('error', () => {})
    return entry
  }
  async function apply(input, save) {
    if (stopped) throw failure('lan_stopped', '网关正在退出，请重新打开应用后操作。')
    if (typeof input?.enabled !== 'boolean' || !Number.isInteger(input.port) || input.port < 1024 || input.port > 65535 || input.port === consolePort) {
      throw failure('invalid_lan_settings', `请输入 1024–65535 之间的端口，并避开本机管理端口 ${consolePort}。`)
    }
    const next = input.enabled && (!active || port !== input.port) ? await open(input.port) : active
    try {
      if (save && await persist({ desktopLanEnabled: input.enabled, desktopLanPort: input.port }) === false) {
        throw failure('lan_save_failed', '共享设置保存失败，请检查数据目录是否可写后重试。')
      }
    } catch (e) { if (next && next !== active) await close(next); throw e }
    const previous = active
    active = input.enabled ? next : null
    port = input.port; configuredEnabled = input.enabled; error = ''
    if (previous && previous !== active) await close(previous)
    return snapshot()
  }
  function enqueue(fn) {
    const result = queue.then(fn)
    queue = result.catch(() => {})
    return result
  }
  return {
    snapshot,
    configure: input => enqueue(() => apply(input, true)),
    restore: input => enqueue(async () => {
      try { return await apply(input, false) }
      catch (e) { configuredEnabled = !!input.enabled; port = input.port; error = e.message; return snapshot() }
    }),
    stop: () => { stopped = true; return enqueue(async () => { const previous = active; active = null; await close(previous) }) }
  }
}
