import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

// Restrict permission changes to an explicitly owned temporary fixture, never the checkout.
export function fixturePermissions(fixtureRoot, target, readonly) {
  const root = fs.realpathSync(fixtureRoot), actual = fs.realpathSync(target)
  const rel = path.relative(root, actual)
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('Permission target must be inside the owned fixture')
  const entries = []
  function walk(file) {
    const stat = fs.lstatSync(file)
    if (stat.isSymbolicLink()) throw new Error('Permission fixture cannot contain links')
    entries.push({ file, stat })
    if (stat.isDirectory()) for (const name of fs.readdirSync(file)) walk(path.join(file, name))
  }
  walk(actual)
  if (process.platform === 'win32') {
    const script = `
$ErrorActionPreference = 'Stop'
$PSModuleAutoLoadingPreference = 'None'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$root = [IO.DirectoryInfo]::new($env:CGW_TEST_PERMISSION_TARGET)
$items = @($root) + @($root.GetFileSystemInfos('*', [IO.SearchOption]::AllDirectories))
foreach ($item in $items) {
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'link refused' }
  $isDir = $item -is [IO.DirectoryInfo]
  $acl = if ($isDir) { [IO.Directory]::GetAccessControl($item.FullName) } else { [IO.File]::GetAccessControl($item.FullName) }
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($rule) }
  $inherit = if ($isDir) { [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' } else { [Security.AccessControl.InheritanceFlags]::None }
  $rights = if ($env:CGW_TEST_PERMISSION_READONLY -eq '1') { 'ReadAndExecute, Synchronize' } else { 'FullControl' }
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, $rights, $inherit, 'None', 'Allow'))
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($system, 'FullControl', $inherit, 'None', 'Allow'))
  if ($isDir) { [IO.Directory]::SetAccessControl($item.FullName, $acl) } else { [IO.File]::SetAccessControl($item.FullName, $acl) }
}`
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      env: { ...process.env, CGW_TEST_PERMISSION_TARGET: actual, CGW_TEST_PERMISSION_READONLY: readonly ? '1' : '0' },
      windowsHide: true, timeout: 30_000, stdio: 'pipe'
    })
  } else {
    for (const { file, stat } of entries) fs.chmodSync(file, stat.isDirectory() || (stat.mode & 0o111) ? (readonly ? 0o555 : 0o755) : (readonly ? 0o444 : 0o644))
  }
}
