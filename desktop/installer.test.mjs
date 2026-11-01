import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const desktop = path.dirname(fileURLToPath(import.meta.url))
test('compiled NSIS cleanup removes only owned startup entries and preserves updates', { skip: process.platform !== 'win32' }, () => {
  const compiler = path.join(process.env.LOCALAPPDATA, 'tauri/NSIS/makensis.exe')
  assert.ok(fs.existsSync(compiler), 'Prepare the pinned NSIS toolchain with a packaging run first')
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-installer-hook-'))
  const ownedRoot = fs.realpathSync(temp)
  const key = `Software\\CodexGatewayInstallerTest\\${path.basename(temp)}`
  const escaped = value => value.replaceAll('$', '$$').replaceAll('"', '$\\"')
  const executable = path.join(temp, 'hook-test.exe')
  const script = `Unicode true
!include LogicLib.nsh
!include "${escaped(path.join(desktop, 'src-tauri/installer/hooks.nsh'))}"
Name "CGW isolated installer hook test"
OutFile "${escaped(executable)}"
RequestExecutionLevel user
SilentInstall silent
AutoCloseWindow true
Var UpdateMode
Section
  StrCpy $INSTDIR "C:\\CGW-owned-fixture"
  StrCpy $UpdateMode 0
  WriteRegStr HKCU "${key}\\Run" "Fixture" '$\\"$INSTDIR\\codex-gateway-desktop.exe$\\" $\\"--from-autostart$\\"'
  WriteRegStr HKCU "${key}\\Approved" "Fixture" "owned"
  !insertmacro CGW_REMOVE_OWNED_AUTOSTART "${key}\\Run" "${key}\\Approved" "Fixture"
  ClearErrors
  ReadRegStr $1 HKCU "${key}\\Run" "Fixture"
  IfErrors +3 0
    SetErrorLevel 1
    Goto cleanup
  ClearErrors
  ReadRegStr $1 HKCU "${key}\\Approved" "Fixture"
  IfErrors +3 0
    SetErrorLevel 2
    Goto cleanup
  WriteRegStr HKCU "${key}\\Run" "Fixture" "other-installation"
  WriteRegStr HKCU "${key}\\Approved" "Fixture" "other-approved"
  !insertmacro CGW_REMOVE_OWNED_AUTOSTART "${key}\\Run" "${key}\\Approved" "Fixture"
  ReadRegStr $1 HKCU "${key}\\Run" "Fixture"
  StrCmp $1 "other-installation" +3 0
    SetErrorLevel 3
    Goto cleanup
  ReadRegStr $1 HKCU "${key}\\Approved" "Fixture"
  StrCmp $1 "other-approved" +3 0
    SetErrorLevel 4
    Goto cleanup
  StrCpy $UpdateMode 1
  WriteRegStr HKCU "${key}\\Run" "Fixture" '$\\"$INSTDIR\\codex-gateway-desktop.exe$\\" $\\"--from-autostart$\\"'
  !insertmacro CGW_REMOVE_OWNED_AUTOSTART "${key}\\Run" "${key}\\Approved" "Fixture"
  ReadRegStr $1 HKCU "${key}\\Run" "Fixture"
  StrCmp $1 '$\\"$INSTDIR\\codex-gateway-desktop.exe$\\" $\\"--from-autostart$\\"' +3 0
    SetErrorLevel 5
    Goto cleanup
  ReadRegStr $1 HKCU "${key}\\Approved" "Fixture"
  StrCmp $1 "other-approved" +3 0
    SetErrorLevel 6
    Goto cleanup
  SetErrorLevel 0
cleanup:
  DeleteRegKey HKCU "${key}"
  DeleteRegKey /ifempty HKCU "Software\\CodexGatewayInstallerTest"
SectionEnd
`
  try {
    const input = path.join(temp, 'hook-test.nsi')
    fs.writeFileSync(input, script)
    const compiled = spawnSync(compiler, ['/INPUTCHARSET', 'UTF8', '/V2', input], { encoding: 'utf8', windowsHide: true, timeout: 60_000 })
    assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout)
    const result = spawnSync(executable, [], { windowsHide: true, timeout: 30_000 })
    assert.equal(result.status, 0, `Hook ownership/update assertion ${result.status}: ${result.error?.message || ''}`)
  } finally {
    // Owned temporary build directory only; no production Run keys or app data used.
    assert.equal(fs.realpathSync(temp), ownedRoot, 'Temporary directory identity changed')
    assert.equal(path.dirname(ownedRoot), fs.realpathSync(os.tmpdir()), 'Cleanup escaped the temporary directory')
    fs.rmSync(ownedRoot, { recursive: true, force: true })
  }
})
