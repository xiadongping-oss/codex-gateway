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
import { loginTempRoot } from './storage-paths.mjs'

const SESSION_ID_RE = /^[0-9a-f]{16}$/
export const LOGIN_TIMEOUT_MS = 10 * 60 * 1000

// 默认 profile（~/.codex/auth.json）：桌面版客户端若不尊重 CODEX_HOME，
// 登录凭据会落到这里 —— 会话用「内容指纹变化」识别这次登录（见 resolveAuth）。
export function defaultCodexAuthPath() {
  return path.join(os.homedir(), '.codex', 'auth.json')
}
function readDefaultAuthText() {
  try {
    return fs.readFileSync(defaultCodexAuthPath(), 'utf-8')
  } catch {
    return null
  }
}
function digestText(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex')
}

export function tempLoginRootDir(dataRoot) {
  return loginTempRoot(dataRoot)
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
//
// defaultWatch（桌面客户端专属）：ChatGPT/Codex 桌面版是常驻单实例应用——
// 新拉起的进程只做激活交接就退出，登录发生在**已经在跑的那个实例**里，
// CODEX_HOME 传不进去。所以桌面客户端退出≠失败：改看默认 profile 的凭据变化
// （resolveAuth 已实现），一直等到超时。CLI 场景保留快速失败。
export function derivePhase(session, { now = Date.now(), pidRunning } = {}) {
  if (!session) return { phase: 'unknown', error: null, hasCredentials: false }
  if (session.phase === 'failed' || session.phase === 'cancelled') {
    return { phase: session.phase, error: session.error, hasCredentials: session.hasCredentials }
  }
  if (session.hasCredentials) {
    if (session.clientExited) return { phase: 'ready', error: null, hasCredentials: true }
    return { phase: 'logged-in', error: null, hasCredentials: true }
  }
  if (now - session.startedAt > LOGIN_TIMEOUT_MS) {
    const timeoutHint = session.defaultWatch
      ? '：登录信息没有写进临时目录，默认 Codex 凭据也没有变化。请确认已在官方客户端完成登录后重试'
      : ''
    return { phase: 'failed', error: '等待官方客户端登录超时（10 分钟）' + timeoutHint, hasCredentials: false }
  }
  const exited = session.clientExited || pidRunning === false
  if (exited && !session.defaultWatch) {
    return { phase: 'failed', error: '官方客户端已关闭，但没有读到登录信息', hasCredentials: false }
  }
  // 启动命令已发出即进入 launching，凭据轮询归入 waiting-login（前端按 elapsed 细分展示）
  return { phase: session.spawned ? 'waiting-login' : 'launching', error: null, hasCredentials: false }
}

// ---------- Store（MSIX）版客户端发现 ----------
//
// 背景（本机实测 OpenAI.Codex 26.x）：MSIX 包的 GUI 主程序**不注册**执行别名，
// %LOCALAPPDATA%\Microsoft\WindowsApps 里只会落包族目录（OpenAI.Codex_<family>）
// 和个别辅助别名（codex-chrome-native-host.exe / codex-core-command-runner.exe）。
// 所以「直接找 codex.exe」永远落空。可行路径：
//   1) 别名/包族目录里的 .exe 是 APPEXECLINK reparse point，readlinkSync 能读出
//      指向 C:\Program Files\WindowsApps\<包全名>\... 的目标 → 反推包安装根；
//   2) 安装根下的 AppxManifest.xml 是权威来源：<Application Executable="app\Codex.exe">；
//   3) 解析失败再按常见布局探测（app\Codex.exe、Codex.exe）。
// existsSync 在 WindowsApps 内可用（stat 走 traverse 权限），readlink/读清单同理。
function extractWindowsAppsRoot(target) {
  const m = /^(.+[\\/]WindowsApps[\\/][^\\/]+)/i.exec(String(target || ''))
  return m ? m[1] : null
}

function readManifestExecutable(manifestPath, readFile = fs.readFileSync) {
  try {
    const xml = readFile(manifestPath, 'utf-8')
    const m = /<Application\b[^>]*?\bExecutable\s*=\s*"([^"]+)"/i.exec(xml)
    return m ? m[1].trim() : null
  } catch {
    return null
  }
}

export function discoverStoreCodexClient({
  localAppData,
  existsSync = fs.existsSync,
  readdirSync = fs.readdirSync,
  readlinkSync = fs.readlinkSync,
  readFile = fs.readFileSync
} = {}) {
  const waDir = path.join(localAppData, 'Microsoft', 'WindowsApps')
  let entries
  try {
    entries = readdirSync(waDir)
  } catch {
    return null
  }
  const roots = new Set()
  const addAlias = (rel) => {
    let target = ''
    try { target = readlinkSync(path.join(waDir, rel)) } catch { return }
    const root = extractWindowsAppsRoot(target)
    if (root && /codex/i.test(target)) roots.add(root)
  }
  // 包族目录（OpenAI.Codex_<family>）：目录内是本包注册的全部执行别名
  for (const e of entries) {
    if (/^OpenAI\./i.test(e) && /codex/i.test(e)) {
      let inner = []
      try { inner = readdirSync(path.join(waDir, e)) } catch { continue }
      for (const f of inner) {
        if (/\.exe$/i.test(f)) addAlias(path.join(e, f))
      }
    }
  }
  // 根级 codex* 别名兜底（覆盖包族目录缺失、或未来直接注册主程序别名的情况）
  for (const e of entries) {
    if (/^codex/i.test(e) && /\.exe$/i.test(e)) addAlias(e)
  }
  for (const root of [...roots].sort()) {
    const candidates = []
    const exec = readManifestExecutable(path.join(root, 'AppxManifest.xml'), readFile)
    if (exec) candidates.push(path.join(root, exec))
    candidates.push(path.join(root, 'app', 'Codex.exe'), path.join(root, 'Codex.exe'))
    for (const c of candidates) {
      if (c && existsSync(c)) return { path: c, kind: 'store' }
    }
  }
  return null
}

// ---------- 官方客户端发现 ----------
// 顺序：显式环境变量 > Windows 执行别名 > where/which > 常见安装位 > Store 应用扫描。
// 全部落空返回 null，由上层给出可操作的报错文案。
export function discoverCodexClient({
  env = process.env,
  platform = process.platform,
  existsSync = fs.existsSync,
  execSync,
  readdirSync = fs.readdirSync,
  readlinkSync = fs.readlinkSync,
  readFile = fs.readFileSync
} = {}) {
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
    const store = discoverStoreCodexClient({ localAppData: la, existsSync, readdirSync, readlinkSync, readFile })
    if (store) return store
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
// ChildProcess objects are the only process authority. Persisted PIDs are diagnostic data.
export function createOfficialLoginManager({ dataRoot, spawnImpl = spawn, discoverImpl = discoverCodexClient, pidAliveImpl, trackChild = () => {}, defaultAuthText = readDefaultAuthText } = {}) {
  const root = tempLoginRootDir(dataRoot)
  // sessionId -> { sessionId, profileDir, pid, clientPath, startedAt, hasCredentials, clientExited, phase, error }
  const sessions = new Map()
  const children = new Set()
  function own(child, session) {
    session.child = child
    if (typeof child.once !== 'function') return // injected test doubles only
    children.add(child)
    trackChild(child)
    child.once('exit', () => { children.delete(child); session.clientExited = true })
    child.once('error', () => {
      if (!child.pid) { children.delete(child); session.clientExited = true }
      session.phase = 'failed'; session.error = '启动官方客户端失败，请使用浏览器授权重试'
    })
  }
  async function stopAndWait(ms = 3000) {
    const owned = [...children]
    if (!owned.length) return true
    return new Promise(resolve => {
      let timer
      const check = () => { if (owned.every(c => !children.has(c))) done(true) }
      const done = ok => { clearTimeout(timer); for (const c of owned) { c.removeListener('exit', check); c.removeListener('error', check) }; resolve(ok) }
      timer = setTimeout(() => done(false), ms)
      for (const c of owned) {
        c.once('exit', check); c.once('error', check)
        try { c.kill('SIGKILL') } catch {}
      }
      check()
    })
  }

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

  // 凭据解析：临时 profile 优先；其次默认 profile —— 但只有内容相对「会话开始时
  // 的指纹」发生变化才采纳。不然用户早就登录过的旧凭据会被误当成这次的新登录。
  function resolveAuth(session) {
    const tempText = readAuthText(session.profileDir)
    if (tempText && authFileHasCredentials(tempText)) return { text: tempText, source: 'temp-profile' }
    const defText = defaultAuthText()
    if (defText && authFileHasCredentials(defText) && digestText(defText) !== session.defaultAuthDigest) {
      return { text: defText, source: 'default-profile' }
    }
    return null
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
      throw new Error('未找到官方 Codex 客户端。可安装 Codex 桌面版（Microsoft Store）或 CLI（npm i -g @openai/codex）后重试，或改用浏览器授权。')
    }
    const sessionId = crypto.randomBytes(8).toString('hex')
    const profileDir = profileDirFor(dataRoot, sessionId)
    writeMarker(profileDir, { sessionId, createdAt: new Date().toISOString(), clientPath: client.path })
    const defaultText = defaultAuthText()
    const session = {
      sessionId, profileDir, clientPath: client.path, clientKind: client.kind,
      pid: null, startedAt: Date.now(),
      // 会话开始时的默认 profile 指纹（null=当时没有凭据文件）
      defaultAuthDigest: defaultText ? digestText(defaultText) : null,
      // 桌面客户端（store/app）是常驻单实例：退出≠失败，转看默认 profile 变化
      defaultWatch: client.kind === 'store' || client.kind === 'app',
      credSource: null,
      hasCredentials: false, clientExited: false, phase: 'launching', error: null
    }
    sessions.set(sessionId, session)

    try {
      if (process.platform === 'win32') {
        // start "" /WAIT：新控制台/GUI 窗口跑官方客户端；cmd 壳挂着等它退出，
        // pid 即壳进程 —— 检测壳存活 + 凭据文件，两路信号互为兜底。
        // CLI 形态补 login 子命令（浏览器授权 + 本地回调，完成后进程退出）；
        // 桌面 GUI 不带参数，直接开窗口。
        const cliArgs = client.kind === 'cli' ? ' login' : ''
        const child = spawnImpl(`start "" /WAIT "${client.path}"${cliArgs}`, {
          shell: true, stdio: 'ignore',
          env: { ...process.env, CODEX_HOME: profileDir }
        })
        session.pid = child.pid || null
        own(child, session)
        child.unref?.()
      } else if (process.platform === 'darwin' && client.kind === 'app') {
        // macOS GUI 应用走 open（--env 需要 macOS 13+）。open 立即返回，
        // pid 不可靠 —— posix 侧以凭据轮询为准，用户在界面上点「完成导入」。
        const child = spawnImpl(`open -n "${client.path}" --env "CODEX_HOME=${profileDir}"`, {
          shell: true, stdio: 'ignore',
          env: { ...process.env, CODEX_HOME: profileDir }
        })
        session.pid = null // open 的壳进程不可作存活信号
        own(child, session)
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
    const info = resolveAuth(s)
    s.hasCredentials = !!info
    s.credSource = info ? info.source : null
    const alive = pidAliveImpl ? pidAlive(s.pid) : !!s.child && !s.clientExited
    if (pidAliveImpl) s.clientExited = s.pid != null && !alive
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
      credSource: s.credSource,
      clientExited: s.clientExited,
      // 桌面客户端交接退出后的观察模式：UI 据此提示「去已打开的客户端里登录」
      watchDefaultProfile: !!(s.defaultWatch && !s.hasCredentials),
      elapsedSec: Math.floor((Date.now() - s.startedAt) / 1000)
    }
  }

  // 导入 + 清理：返回 auth.json 原文交由上层注册账号；清理失败不影响导入。
  async function finish(sessionId) {
    const s = sessions.get(sessionId)
    if (!s) throw new Error('会话不存在或已过期')
    const info = resolveAuth(s)
    if (!info) {
      throw new Error('还没读到本次登录的凭据：临时目录为空，默认 Codex 凭据也没有变化。请先在官方客户端完成登录')
    }
    // Import never kills a GUI that may have handed off to an existing instance.
    const marker = readMarker(s.profileDir)
    const result = { authJson: JSON.parse(info.text), credSource: info.source, clientPath: s.clientPath, marker }
    const cleaned = !s.recovered && s.clientExited && !s.defaultWatch && destroyProfile(s.profileDir)
    sessions.delete(sessionId)
    return { ...result, cleaned }
  }

  async function cancel(sessionId) {
    const s = sessions.get(sessionId)
    if (!s) return { ok: true }
    // Cancelling stops watching/importing. Keep a profile while a client may still
    // write to it; the shell owns new descendants and cleans them on application exit.
    if (!s.recovered && s.clientExited && !s.defaultWatch) destroyProfile(s.profileDir)
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
          pid: null,
          startedAt: marker?.createdAt ? Date.parse(marker.createdAt) : Date.now(),
          hasCredentials: true, clientExited: true,
          phase: 'ready', error: null, recovered: true
        })
        kept += 1
      } else {
        // A stale PID can now belong to an unrelated process. Never signal it,
        // and do not remove a profile whose previous writer cannot be verified.
        if (marker?.pid || marker?.clientPath) { kept += 1; continue }
        if (destroyProfile(dir)) removed += 1
      }
    }
    return { kept, removed }
  }

  return { start, status, finish, cancel, recover, destroyProfile, stopAndWait }
}
