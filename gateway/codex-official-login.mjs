// ===================================================================
// 官方客户端临时登录（Codex Official Temp Login）
//
// 交互流程对齐 cockpit-tools 的 tempLogin（功能复刻，代码自研）：
//   1) preparing   准备临时 CODEX_HOME 目录（空白 profile + 会话标记）
//   2) launching   以 CODEX_HOME=临时目录 启动官方 Codex 客户端（新窗口）
//   3) waiting-login  用户在官方客户端里完成登录（轮询 auth.json 凭据）
//   4) closing     用户关闭官方客户端（进程退出）
//   5) importing   读取最终凭据 → 注册为网关账号
//   6) cleaning    清理临时目录；失败则保留登记，下次启动恢复扫描重试
//
// 安全边界：
//   - 会话目录名必须是 16 位 hex，拼路径前校验，杜绝路径穿越
//   - 清理只动 tempLoginRoot 下的会话目录，绝不碰 ~/.codex 本体
//   - 等待登录 10 分钟超时（对齐 cockpit 的 LOGIN_TIMEOUT）
// ===================================================================
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import os from 'node:os'
import { spawn } from 'node:child_process'

const SESSION_ID_RE = /^[0-9a-f]{16}$/
export const LOGIN_TIMEOUT_MS = 10 * 60 * 1000

export function tempLoginRootDir(dataRoot) {
  return path.join(dataRoot, 'tmp', 'codex-temp-login')
}

export function profileDirFor(dataRoot, sessionId) {
  if (!SESSION_ID_RE.test(String(sessionId ?? ''))) {
    throw new Error('非法的会话 ID')
  }
  return path.join(tempLoginRootDir(dataRoot), sessionId)
}

// 低成本凭据探测（对齐 cockpit 的 auth_file_has_credentials）：
// 只检查 auth.json 是否解析得出来且带凭据字段，不做网络校验。
export function authFileHasCredentials(text) {
  try {
    const j = JSON.parse(text)
    const at = j?.tokens?.access_token || j?.access_token
    const key = j?.OPENAI_API_KEY || j?.api_key
    return Boolean((typeof at === 'string' && at.trim()) || (typeof key === 'string' && key.trim()))
  } catch {
    return false
  }
}

// 会话阶段推导：前端 6 步骤条只认这里的 phase 名。
//   preparing → launching → waiting-login → logged-in → ready → (finish) completed
//   failed / cancelled 终态。
export function derivePhase(session, { now = Date.now(), pidRunning } = {}) {
  if (!session) return { phase: 'unknown', error: null, hasCredentials: false }
  if (session.phase === 'failed' || session.phase === 'cancelled') {
    return { phase: session.phase, error: session.error, hasCredentials: session.hasCredentials }
  }
  if (session.hasCredentials) {
    if (session.clientExited) return { phase: 'ready', error: null, hasCredentials: true }
    return { phase: 'logged-in', error: null, hasCredentials: true }
  }
  if (session.clientExited) {
    return { phase: 'failed', error: '官方客户端已关闭，但没有读到登录信息', hasCredentials: false }
  }
  if (pidRunning === false) {
    return { phase: 'failed', error: '官方客户端已退出，但没有读到登录信息', hasCredentials: false }
  }
  if (now - session.startedAt > LOGIN_TIMEOUT_MS) {
    return { phase: 'failed', error: '等待官方客户端登录超时（10 分钟）', hasCredentials: false }
  }
  // 启动命令已发出即进入 launching，凭据轮询归入 waiting-login（前端按 elapsed 细分展示）
  return { phase: session.spawned ? 'waiting-login' : 'launching', error: null, hasCredentials: false }
}

// ---------- 官方客户端发现 ----------
// 顺序：显式环境变量 > Windows 执行别名 > where/which > 常见安装位 > Store 应用扫描。
// 全部落空返回 null，由上层给出可操作的报错文案。
export function discoverCodexClient({ env = process.env, platform = process.platform, existsSync = fs.existsSync, execSync } = {}) {
  const explicit = String(env.CODEX_CLIENT_PATH || '').trim()
  if (explicit && existsSync(explicit)) return { path: explicit, kind: 'explicit' }

  if (platform === 'win32') {
    const la = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
    const candidates = [
      path.join(la, 'Microsoft', 'WindowsApps', 'codex.exe'),
      path.join(la, 'Programs', 'Codex', 'Codex.exe'),
      path.join(la, 'Programs', 'ChatGPT', 'ChatGPT.exe')
    ]
    for (const p of candidates) {
      if (existsSync(p)) return { path: p, kind: 'app' }
    }
    if (execSync) {
      try {
        const out = execSync('where codex', { encoding: 'utf-8', timeout: 5000 })
        const first = String(out).split(/\r?\n/).map((s) => s.trim()).find(Boolean)
        if (first && existsSync(first)) return { path: first, kind: 'cli' }
      } catch { /* where 没命中，继续往下 */ }
    }
    return null
  }
  if (execSync) {
    try {
      const out = execSync('which codex', { encoding: 'utf-8', timeout: 5000 })
      const first = String(out).split(/\r?\n/).map((s) => s.trim()).find(Boolean)
      if (first && existsSync(first)) return { path: first, kind: 'cli' }
    } catch { /* 继续 */ }
  }
  return null
}

// ---------- 会话管理器 ----------
// spawnImpl / discoverImpl / pidAliveImpl / killTree 可注入：单测不真启进程、不真探 pid。
export function createOfficialLoginManager({ dataRoot, spawnImpl = spawn, discoverImpl = discoverCodexClient, pidAliveImpl, killTree } = {}) {
  const root = tempLoginRootDir(dataRoot)
  // sessionId -> { sessionId, profileDir, pid, clientPath, startedAt, hasCredentials, clientExited, phase, error }
  const sessions = new Map()

  function readMarker(profileDir) {
    try {
      return JSON.parse(fs.readFileSync(path.join(profileDir, 'session-marker.json'), 'utf-8'))
    } catch {
      return null
    }
  }
  function writeMarker(profileDir, marker) {
    try {
      fs.mkdirSync(profileDir, { recursive: true })
      fs.writeFileSync(path.join(profileDir, 'session-marker.json'), JSON.stringify(marker, null, 2))
    } catch { /* 尽力而为 */ }
  }
  function readAuthText(profileDir) {
    try {
      return fs.readFileSync(path.join(profileDir, 'auth.json'), 'utf-8')
    } catch {
      return null
    }
  }
  function pidAlive(pid) {
    if (!pid) return false
    if (pidAliveImpl) return pidAliveImpl(pid)
    try {
      process.kill(pid, 0)
      return true
    } catch (e) {
      return e.code === 'EPERM'
    }
  }
  function destroyProfile(profileDir) {
    // 只删本模块命名空间下的会话目录：双重校验（根前缀 + 目录名 hex）
    const rel = path.relative(root, profileDir)
    if (rel.startsWith('..') || path.isAbsolute(rel) || !SESSION_ID_RE.test(rel)) return false
    try {
      fs.rmSync(profileDir, { recursive: true, force: true })
      return true
    } catch {
      return false
    }
  }

  // 启动：发现客户端 → 造临时 profile → 新窗口拉起官方客户端
  async function start() {
    const client = discoverImpl({ env: process.env, platform: process.platform })
    if (!client) {
      throw new Error('未找到官方 Codex 客户端。可安装 Codex CLI（npm i -g @openai/codex）后重试，或改用浏览器授权。')
    }
    const sessionId = crypto.randomBytes(8).toString('hex')
    const profileDir = profileDirFor(dataRoot, sessionId)
    writeMarker(profileDir, { sessionId, createdAt: new Date().toISOString(), clientPath: client.path })
    const session = {
      sessionId, profileDir, clientPath: client.path, clientKind: client.kind,
      pid: null, startedAt: Date.now(),
      hasCredentials: false, clientExited: false, phase: 'launching', error: null
    }
    sessions.set(sessionId, session)

    try {
      if (process.platform === 'win32') {
        // start "" /WAIT：新控制台/GUI 窗口跑官方客户端；cmd 壳挂着等它退出，
        // pid 即壳进程 —— 检测壳存活 + 凭据文件，两路信号互为兜底。
        // spawnImpl 统一 shell 字符串签名（cmd /c、sh -c），便于测试注入。
        const child = spawnImpl(`start "" /WAIT "${client.path}"`, {
          shell: true, stdio: 'ignore',
          env: { ...process.env, CODEX_HOME: profileDir }
        })
        session.pid = child.pid || null
        child.unref?.()
      } else if (process.platform === 'darwin' && client.kind === 'app') {
        // macOS GUI 应用走 open（--env 需要 macOS 13+）。open 立即返回，
        // pid 不可靠 —— posix 侧以凭据轮询为准，用户在界面上点「完成导入」。
        const child = spawnImpl(`open -n "${client.path}" --env "CODEX_HOME=${profileDir}"`, {
          shell: true, stdio: 'ignore',
          env: { ...process.env, CODEX_HOME: profileDir }
        })
        session.pid = null // open 的壳进程不可作存活信号
        child.unref?.()
      } else {
        throw new Error('posix 平台暂不支持 CLI 形态的官方登录（TUI 需要交互终端），请使用浏览器授权。')
      }
      session.spawned = true
    } catch (e) {
      session.phase = 'failed'
      session.error = '启动官方客户端失败：' + e.message
      destroyProfile(profileDir)
      sessions.delete(sessionId)
      throw new Error(session.error)
    }
    writeMarker(profileDir, { sessionId, createdAt: new Date().toISOString(), clientPath: client.path, pid: session.pid })
    return { sessionId, profileDir, clientPath: client.path, clientKind: client.kind }
  }

  // 轮询：刷新凭据/进程状态并推导 phase
  async function status(sessionId) {
    const s = sessions.get(sessionId)
    if (!s) return { sessionId, phase: 'unknown', error: '会话不存在或已过期', hasCredentials: false }
    const authText = readAuthText(s.profileDir)
    s.hasCredentials = authText ? authFileHasCredentials(authText) : false
    const alive = pidAlive(s.pid)
    s.clientExited = s.pid != null && !alive
    const d = derivePhase(s, { now: Date.now(), pidRunning: alive })
    if (d.phase === 'failed') {
      s.phase = 'failed'
      s.error = d.error
    } else {
      s.phase = d.phase
    }
    return {
      sessionId,
      phase: s.phase,
      error: s.error,
      hasCredentials: s.hasCredentials,
      clientExited: s.clientExited,
      elapsedSec: Math.floor((Date.now() - s.startedAt) / 1000)
    }
  }

  // 导入 + 清理：返回 auth.json 原文交由上层注册账号；清理失败不影响导入。
  async function finish(sessionId) {
    const s = sessions.get(sessionId)
    if (!s) throw new Error('会话不存在或已过期')
    const authText = readAuthText(s.profileDir)
    if (!authText || !authFileHasCredentials(authText)) {
      throw new Error('临时目录里还没有可用凭据，请先在官方客户端完成登录')
    }
    // 关掉仍在运行的客户端（用户可能登录完没关）
    if (!s.clientExited && s.pid && pidAlive(s.pid) && killTree) {
      try { await killTree(s.pid) } catch { /* 关不掉也不影响读凭据 */ }
    }
    const marker = readMarker(s.profileDir)
    const result = { authJson: JSON.parse(authText), clientPath: s.clientPath, marker }
    const cleaned = destroyProfile(s.profileDir)
    sessions.delete(sessionId)
    return { ...result, cleaned }
  }

  async function cancel(sessionId) {
    const s = sessions.get(sessionId)
    if (!s) return { ok: true }
    if (s.pid && pidAlive(s.pid) && killTree) {
      try { await killTree(s.pid) } catch { /* 尽力而为 */ }
    }
    destroyProfile(s.profileDir)
    sessions.delete(sessionId)
    return { ok: true }
  }

  // 启动恢复：上次没走完的会话——有凭据的保留待导入，没有的清理掉
  function recover() {
    let kept = 0
    let removed = 0
    let entries = []
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      return { kept, removed }
    }
    for (const ent of entries) {
      if (!ent.isDirectory() || !SESSION_ID_RE.test(ent.name)) continue
      const dir = path.join(root, ent.name)
      const marker = readMarker(dir)
      const authText = readAuthText(dir)
      if (authText && authFileHasCredentials(authText)) {
        // 有凭据：登记成可恢复会话（用户重跑 finish 就能导入，不必再登录一遍）
        sessions.set(ent.name, {
          sessionId: ent.name, profileDir: dir,
          clientPath: marker?.clientPath || null,
          pid: marker?.pid || null,
          startedAt: marker?.createdAt ? Date.parse(marker.createdAt) : Date.now(),
          hasCredentials: true, clientExited: true,
          phase: 'ready', error: null, recovered: true
        })
        kept += 1
      } else {
        if (marker?.pid && pidAlive(marker.pid) && killTree) {
          try { killTree(marker.pid) } catch { /* 尽力而为 */ }
        }
        destroyProfile(dir)
        removed += 1
      }
    }
    return { kept, removed }
  }

  return { start, status, finish, cancel, recover, destroyProfile }
}
