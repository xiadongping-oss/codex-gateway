import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { assertSeparateRoots, storageError, managedExternalPath } from './storage-paths.mjs'

export function validateExternalPath(value, paths, label) {
  managedExternalPath(value, paths, label)
  if (paths.managed) managedExternalPath(realLocation(value), { ...paths, resourceRoot: realLocation(paths.resourceRoot) }, label)
  return value
}

// 按最近已存在的祖先解析真实路径，创建前也能发现经 junction 指入程序的路径。
export function realLocation(file) {
  try { return fs.realpathSync(file) } catch (error) {
    if (error.code !== 'ENOENT') throw error
    const parent = path.dirname(file)
    if (parent === file) throw error
    return path.join(realLocation(parent), path.basename(file))
  }
}
export function assertStorageTree(root) {
  const visit = (file) => {
    const st = fs.lstatSync(file)
    if (st.isSymbolicLink() || (!st.isDirectory() && (!st.isFile() || st.nlink > 1))) {
      throw storageError('DATA_DIR_INVALID', '自有数据目录不允许符号链接、junction、硬链接或特殊文件')
    }
    if (st.isDirectory()) for (const name of fs.readdirSync(file)) visit(path.join(file, name))
  }
  visit(root)
}

export function validateStorageReader(paths) {
  if (!paths?.managed) return
  assertSeparateRoots(realLocation(paths.root), realLocation(paths.resourceRoot))
  assertStorageTree(paths.root)
  let layout
  try { layout = JSON.parse(fs.readFileSync(paths.layout, 'utf8')) } catch {}
  if (layout?.schemaVersion !== 1) throw storageError('DATA_VERSION_UNSUPPORTED', '本机 MCP 需要已经初始化的 v1 数据目录')
}

// managed 不能沿用“尽力收紧”语义；失败必须阻止业务模块加载。
export function protectStorageTree(root) {
  if (process.platform === 'win32') {
    const script = `
$ErrorActionPreference = 'Stop'
$PSModuleAutoLoadingPreference = 'None'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$root = [IO.DirectoryInfo]::new($env:CGW_PERMISSION_TARGET)
$items = @($root) + @($root.GetFileSystemInfos('*', [IO.SearchOption]::AllDirectories))
foreach ($item in $items) {
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse point refused' }
  $isDir = $item -is [IO.DirectoryInfo]
  $acl = if ($isDir) { [IO.Directory]::GetAccessControl($item.FullName) } else { [IO.File]::GetAccessControl($item.FullName) }
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($rule) }
  $inherit = if ($isDir) { [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' } else { [Security.AccessControl.InheritanceFlags]::None }
  foreach ($who in @($sid, $system)) {
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($who, 'FullControl', $inherit, 'None', 'Allow')
    $acl.AddAccessRule($rule)
  }
  $acl.SetOwner($sid)
  if ($isDir) { [IO.Directory]::SetAccessControl($item.FullName, $acl) } else { [IO.File]::SetAccessControl($item.FullName, $acl) }
}`
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      windowsHide: true, timeout: 30000, stdio: 'pipe', env: { ...process.env, CGW_PERMISSION_TARGET: root }
    })
  } else {
    const visit = (file) => {
      const st = fs.lstatSync(file)
      if (st.isSymbolicLink()) throw storageError('DATA_DIR_INVALID', '拒绝链接数据路径')
      const mode = st.isDirectory() ? 0o700 : 0o600
      fs.chmodSync(file, mode)
      if ((fs.statSync(file).mode & 0o777) !== mode) throw new Error('权限设置未生效')
      if (st.isDirectory()) for (const name of fs.readdirSync(file)) visit(path.join(file, name))
    }
    visit(root)
  }
}

export function initializeStorage(paths, { protect = protectStorageTree } = {}) {
  if (!paths.managed) return null
  let fd
  let guardFd
  let owner
  const created = []
  const lock = path.join(paths.runtime, 'owner.lock')
  const children = new Set()
  const release = () => {
    if (fd === undefined || children.size) return false
    const heldFd = fd
    fd = undefined
    try {
      const current = JSON.parse(fs.readFileSync(lock, 'utf8'))
      if (current.ownerId !== owner?.ownerId) return false
      fs.closeSync(heldFd)
      fs.unlinkSync(lock)
      return true
    } finally {
      try { fs.closeSync(heldFd) } catch {}
      if (guardFd !== undefined) { fs.closeSync(guardFd); guardFd = undefined }
    }
  }
  try {
    assertSeparateRoots(realLocation(paths.root), realLocation(paths.resourceRoot))
    fs.mkdirSync(paths.root, { recursive: true, mode: 0o700 })
    // Claim ownership before inspecting mutable files or applying permissions. A second
    // starter must not race the first one's probes, layout marker or runtime directory.
    if (fs.lstatSync(paths.root).isSymbolicLink()) throw storageError('DATA_DIR_INVALID', '拒绝链接数据路径')
    try { fs.mkdirSync(paths.runtime, { mode: 0o700 }); created.push(paths.runtime) } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
    const runtimeStat = fs.lstatSync(paths.runtime)
    if (runtimeStat.isSymbolicLink() || !runtimeStat.isDirectory()) throw storageError('DATA_DIR_INVALID', '拒绝无效运行目录')
    if (process.platform === 'darwin') {
      // Darwin O_EXLOCK (sys/fcntl.h): libuv passes numeric flags to open(2).
      // Keep this empty file permanently: unlinking an advisory lock splits its
      // identity and could allow a second writer. Rust recovery uses the same lock.
      const guard = path.join(paths.runtime, 'owner.guard')
      const flags = fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW | 0x20
      try { guardFd = fs.openSync(guard, flags, 0o600) } catch (error) {
        if (['EAGAIN', 'EWOULDBLOCK'].includes(error.code)) throw storageError('DATA_IN_USE', '数据目录正在使用或恢复中')
        throw error
      }
      const held = fs.fstatSync(guardFd), current = fs.lstatSync(guard)
      if (!held.isFile() || held.nlink !== 1 || held.size !== 0 || held.uid !== process.getuid() ||
          (held.mode & 0o022) || current.isSymbolicLink() || held.dev !== current.dev || held.ino !== current.ino) {
        throw storageError('DATA_DIR_INVALID', '数据目录互斥文件无效')
      }
    }
    try { fd = fs.openSync(lock, 'wx', 0o600) } catch (error) {
      if (error.code === 'EEXIST') throw storageError('DATA_IN_USE', '数据目录已有所有权记录；请停止原实例，异常退出记录需人工确认后恢复')
      throw error
    }
    owner = { ownerId: crypto.randomUUID(), pid: process.pid, processStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString() }
    fs.writeFileSync(fd, JSON.stringify(owner) + '\n')
    fs.fsyncSync(fd)
    assertStorageTree(paths.root)
    const existing = fs.readdirSync(paths.root).filter(name => name !== 'runtime')
    existing.push(...fs.readdirSync(paths.runtime).filter(name => name !== 'owner.lock' && !(guardFd !== undefined && name === 'owner.guard')))
    if (existing.length && !fs.existsSync(paths.layout)) {
      throw storageError('DATA_MIGRATION_REQUIRED', '旧数据目录需要显式迁移，未更改原有文件')
    }
    if (fs.existsSync(paths.layout)) {
      let layout
      try { layout = JSON.parse(fs.readFileSync(paths.layout, 'utf8')) } catch {}
      if (layout?.schemaVersion !== 1) throw storageError('DATA_VERSION_UNSUPPORTED', '数据布局版本不支持或标记损坏')
    }
    protect(paths.root)
    assertSeparateRoots(fs.realpathSync(paths.root), realLocation(paths.resourceRoot))
    const probe = path.join(paths.root, `.write-probe-${crypto.randomUUID()}`)
    const probeFd = fs.openSync(probe, 'wx', 0o600)
    try { fs.writeFileSync(probeFd, 'probe'); fs.fsyncSync(probeFd) } finally { fs.closeSync(probeFd); fs.unlinkSync(probe) }
    for (const name of ['accounts', 'data', 'gen-images', 'references', 'logs', 'cache', 'tmp']) {
      const dir = path.join(paths.root, name)
      if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { mode: 0o700 }); created.push(dir) }
    }
    if (!fs.existsSync(paths.layout)) fs.writeFileSync(paths.layout, '{"schemaVersion":1}\n', { flag: 'wx', mode: 0o600 })
    return Object.freeze({ paths, owner, release,
      trackChild(child) {
        children.add(child)
        child.once('exit', () => children.delete(child))
        child.once('error', () => { if (!child.pid) children.delete(child) })
      }
    })
  } catch (error) {
    try { if (fd !== undefined) release() } catch {}
    if (guardFd !== undefined) { try { fs.closeSync(guardFd) } catch {}; guardFd = undefined }
    for (const dir of created.reverse()) { try { fs.rmdirSync(dir) } catch {} }
    if (error.code?.startsWith('DATA_')) throw error
    throw storageError('DATA_DIR_UNWRITABLE', `无法准备数据目录：${error.code || '权限或写入失败'}`)
  }
}
