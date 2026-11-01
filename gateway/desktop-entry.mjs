#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Console } from 'node:console'
import { createControlChannel } from './desktop-protocol.mjs'
import { createDesktopTickets } from './desktop-ticket.mjs'
import { createShutdownManager } from './shutdown-manager.mjs'

globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr })
const gatewayDir = fs.realpathSync(path.dirname(fileURLToPath(import.meta.url)))
const resourceRoot = fs.realpathSync(path.join(gatewayDir, '..'))
const pkg = JSON.parse(fs.readFileSync(path.join(resourceRoot, 'package.json'), 'utf8'))
let state = 'awaiting-initialize', runtime, ready, manager, tickets, lease
let startup, faulted = false, ending = false
let deadline = setTimeout(() => fatal('CONTROL_CHANNEL_LOST'), 5000)
const messages = {
  FRAME_INVALID: '桌面控制消息格式无效', PROTOCOL_UNSUPPORTED: '桌面控制协议版本不支持',
  IDENTITY_MISMATCH: '桌面启动身份不匹配', CONTROL_CHANNEL_LOST: '桌面控制通道断开或超时',
  PORT_IN_USE: '网关端口已被占用', PORT_PERMISSION: '没有权限监听网关端口',
  BRIDGE_PATCH_INVALID: '网关资源校验失败，请重新安装',
  INVALID_ARGUMENT: '启动参数无效', INTERNAL_ERROR: '网关无法完成操作',
  DATA_DIR_INVALID: '数据目录配置无效', DATA_DIR_UNWRITABLE: '数据目录不可写',
  DATA_IN_USE: '数据目录已有所有权记录', DATA_VERSION_UNSUPPORTED: '数据目录版本不兼容',
  DATA_MIGRATION_REQUIRED: '旧数据目录需要显式迁移',
  DATA_MIGRATION_PENDING: '数据迁移尚未完成，请先恢复或取消迁移'
}
const errorInfo = code => ({ code, message: messages[code] || '网关操作失败', retryable: false })
// Windows process.stdout pipe writes are synchronous: a non-reading shell would
// block the event loop before queue limits or shutdown timers can run. Use async
// descriptor writes there; keep POSIX's native asynchronous pipe stream.
const controlOutput = process.platform === 'win32' ? fs.createWriteStream(null, { fd: 1, autoClose: false }) : process.stdout
const channel = createControlChannel({ input: process.stdin, output: controlOutput, onRequest: request, onFault: fatal })
function terminate(exitCode, force = false) {
  // A pending Windows CRT pipe write can also block process.exit(). After a
  // failed flush (or the hard deadline), terminate only this owned process.
  // Windows reports 1 for SIGKILL; the shell must treat it as an abnormal exit.
  if (force && process.platform === 'win32') process.kill(process.pid, 'SIGKILL')
  else process.exit(exitCode)
}
async function exit(result) {
  if (ending) return
  ending = true
  clearTimeout(deadline)
  tickets?.invalidate()
  const flushed = await channel.flush()
  terminate(flushed ? result.exitCode : 5, !flushed)
}
function setupManager() {
  if (manager) return manager
  manager = createShutdownManager({ runtime, emit: (type, payload) => channel.event(type, payload), finish: exit })
  return manager
}
function fatal(code = 'INTERNAL_ERROR') {
  if (faulted || ending) return
  faulted = true
  clearTimeout(deadline)
  tickets?.invalidate()
  channel.event('fatal', errorInfo(code))
  const exitCode = code === 'PORT_IN_USE' ? 2 : code === 'PORT_PERMISSION' ? 3 :
    ['FRAME_INVALID', 'PROTOCOL_UNSUPPORTED', 'IDENTITY_MISMATCH', 'CONTROL_CHANNEL_LOST'].includes(code) ? 5 : 1
  // Startup may still be importing. Never start serving after the owning pipe disappears.
  const hardDeadline = setTimeout(() => terminate(exitCode, true), 5000)
  void Promise.resolve(startup).catch(() => {}).then(() => {
    if (runtime) setupManager().begin({ urgent: true, exitCode })
    else {
      clearTimeout(hardDeadline)
      let released = true
      try { released = lease?.release() !== false } catch { released = false }
      channel.event('stopped', { state: 'stopped', outcome: 'failed', persisted: false, childrenExited: released, exitCode })
      void exit({ exitCode })
    }
  })
}
async function start() {
  process.env.CGW_DESKTOP = '1'
  process.env.CGW_STORAGE_MODE = 'managed'
  process.env.CGW_ADMIN_AUTH = '1'
  process.env.CGW_OPEN_BROWSER = '0'
  // The shell launches the bundled Node. Children use that same runtime and fixed resources.
  process.env.BRIDGE_NODE = process.execPath
  process.env.BRIDGE_CLI = path.join(gatewayDir, 'node_modules/chatgpt-bridge/dist/cli.js')
  process.env.BRIDGE_ARGS = 'serve'
  delete process.env.NODE_OPTIONS
  delete process.env.NODE_PATH
  const { verifyBridgePatched } = await import('./bridge-patches.mjs')
  verifyBridgePatched()
  if (faulted) return
  const { parsePort, DEFAULT_LAUNCHER_PORT, DEFAULT_BRIDGE_PORT } = await import('./port-util.mjs')
  if (parsePort(process.env.LAUNCHER_PORT, DEFAULT_LAUNCHER_PORT).error || parsePort(process.env.BRIDGE_PORT, DEFAULT_BRIDGE_PORT).error) {
    throw Object.assign(new Error('端口配置无效'), { code: 'INVALID_ARGUMENT' })
  }
  lease = (await import('./storage-bootstrap.mjs')).storageLease
  if (faulted) return
  const module = await import('./launcher.mjs')
  runtime = module.gatewayRuntime
  runtime.setTickets(tickets)
  runtime.onExit(code => code ? fatal('INTERNAL_ERROR') : setupManager().begin({ urgent: true }))
  ready = await module.gatewayReady
  if (faulted) return
  clearTimeout(deadline)
  state = 'ready'
  channel.event('ready', ready)
}
function request(msg) {
  if (faulted || ending) return
  const reject = code => channel.respond(msg, {}, { code, message: code === 'INVALID_STATE' ? '当前状态不允许此操作' : '控制命令或参数无效', retryable: false })
  const current = manager?.status().state || state
  if (msg.type === 'initialize') {
    if (current !== 'awaiting-initialize') return reject('INVALID_STATE')
    if (!/^[a-f0-9]{64}$/.test(msg.payload.challenge || '')) return fatal('IDENTITY_MISMATCH')
    clearTimeout(deadline)
    state = 'initialized'
    tickets = createDesktopTickets(msg.launchId)
    channel.respond(msg, { state, challenge: msg.payload.challenge, pid: process.pid, appVersion: pkg.version, resourceRoot })
    deadline = setTimeout(() => fatal('CONTROL_CHANNEL_LOST'), 5000)
  } else if (msg.type === 'start') {
    if (current !== 'initialized') return reject('INVALID_STATE')
    clearTimeout(deadline)
    state = 'starting'
    channel.respond(msg, { state })
    if (faulted) return
    deadline = setTimeout(() => fatal('CONTROL_CHANNEL_LOST'), 30_000)
    startup = start()
    startup.catch(error => fatal(messages[error.code] ? error.code : 'INTERNAL_ERROR'))
  } else if (msg.type === 'status') {
    if (current === 'awaiting-initialize' || current === 'stopped') return reject('INVALID_STATE')
    channel.respond(msg, manager?.status() || { state, phase: null, waiting: false, ...(runtime?.counts() || { activeRequests: 0, backgroundTasks: 0, bridgeCount: 0 }) })
  } else if (msg.type === 'bootstrap') {
    if (current !== 'ready') return reject('INVALID_STATE')
    const { ticket, expiresAt } = tickets.issue()
    channel.respond(msg, { url: `${ready.origin}/?_cgw_bootstrap=${encodeURIComponent(ticket)}`, expiresAt })
  } else if (msg.type === 'shutdown') {
    if (!['ready', 'draining'].includes(current)) return reject('INVALID_STATE')
    if (!['user_exit', 'update', 'system_shutdown'].includes(msg.payload.reason)) return reject('INVALID_ARGUMENT')
    setupManager().begin({ urgent: msg.payload.reason === 'system_shutdown' })
    tickets.invalidate()
    channel.respond(msg, { state: 'draining' })
  } else if (msg.type === 'shutdown.continue' || msg.type === 'shutdown.force') {
    if (current !== 'draining' || !manager.status().waiting) return reject('INVALID_STATE')
    if (msg.type === 'shutdown.continue' && msg.payload.waitMs !== 30_000) return reject('INVALID_ARGUMENT')
    if (msg.type === 'shutdown.continue') manager.continue()
    else manager.force()
    channel.respond(msg, { state: 'draining' })
  } else reject('UNKNOWN_COMMAND')
}
process.on('SIGINT', () => fatal('CONTROL_CHANNEL_LOST'))
process.on('SIGTERM', () => fatal('CONTROL_CHANNEL_LOST'))
