; Automatic NSIS upgrades run the registered old uninstaller before copying
; new files. The old uninstaller knows its own file list; do not recursively
; delete the application directory or touch any user-data directory.
!ifndef CGW_AUTOMATIC_UPGRADE_INCLUDED
!define CGW_AUTOMATIC_UPGRADE_INCLUDED

!macro CGW_DECLARE_AUTOMATIC_UPGRADE
Var CgwOldInstallDir
Var CgwOldUninstaller
Var CgwUninstallResult
Var CgwNormalizedOldDir
Var CgwOldRoot

Function CgwPrepareAutomaticUpgrade
  ${If} $UpdateMode != 1
  ${AndIf} $PassiveMode != 1
  ${AndIfNot} ${Silent}
    Return
  ${EndIf}

  ClearErrors
  ReadRegStr $CgwOldUninstaller SHCTX "${UNINSTKEY}" "UninstallString"
  ${If} ${Errors}
    ReadRegStr $CgwUninstallResult SHCTX "${UNINSTKEY}" "DisplayVersion"
    ${If} $CgwUninstallResult != ""
      Goto cgw_upgrade_failed
    ${EndIf}
    ; A normal uninstall retains the preferred install location, not an
    ; installation. Do not treat those retained settings as a broken app.
    ClearErrors
    Return
  ${EndIf}
  ReadRegStr $CgwOldInstallDir SHCTX "${MANUPRODUCTKEY}" ""
  ${If} $CgwOldInstallDir == ""
  ${OrIf} $CgwOldUninstaller == ""
    Goto cgw_upgrade_failed
  ${EndIf}
  GetFullPathName $CgwNormalizedOldDir "$CgwOldInstallDir"
  ${GetRoot} "$CgwOldInstallDir" $CgwOldRoot
  ${If} $CgwOldInstallDir != $CgwNormalizedOldDir
  ${OrIf} $CgwOldInstallDir == $CgwOldRoot
  ${OrIf} $CgwOldInstallDir == "$CgwOldRoot\"
    Goto cgw_upgrade_failed
  ${EndIf}
  ; Only invoke the fixed uninstaller in the registered installation directory.
  ; Never execute a registry string with arbitrary additional arguments.
  ${IfNot} ${FileExists} "$CgwOldInstallDir\uninstall.exe"
    Goto cgw_upgrade_failed
  ${EndIf}

  ClearErrors
  ; The new installer owns the progress UI. /P can still show an old
  ; uninstaller's language selector before it parses passive arguments.
  ; /S suppresses that selector as well as the redundant old wizard.
  ExecWait '"$CgwOldInstallDir\uninstall.exe" /UPDATE /S _?=$CgwOldInstallDir' $CgwUninstallResult
  ${If} ${Errors}
  ${OrIf} $CgwUninstallResult != 0
  ${OrIf} ${FileExists} "$CgwOldInstallDir\${MAINBINARYNAME}.exe"
    Goto cgw_upgrade_failed
  ${EndIf}
  ReadRegStr $CgwOldUninstaller SHCTX "${UNINSTKEY}" "UninstallString"
  ${If} $CgwOldUninstaller != ""
    Goto cgw_upgrade_failed
  ${EndIf}
  ; _?= keeps the old uninstaller in place. Remove that exact file only;
  ; RMDir without /r leaves any unrecognised/user-added files untouched.
  Delete "$CgwOldInstallDir\uninstall.exe"
  ${If} ${FileExists} "$CgwOldInstallDir\uninstall.exe"
    Goto cgw_upgrade_failed
  ${EndIf}
  RMDir "$CgwOldInstallDir"
  ClearErrors
  Return

  cgw_upgrade_failed:
    SetErrorLevel 2
    DetailPrint "$(CGW_UpgradeCleanupFailed)"
    IfSilent +2 0
      MessageBox MB_ICONSTOP|MB_OK "$(CGW_UpgradeCleanupFailed)"
    Abort "$(CGW_UpgradeCleanupFailed)"
FunctionEnd
!macroend
!endif
