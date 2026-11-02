; Only remove the startup command belonging to this installation.
; Account data, logs and WebView data are deliberately retained.
!macro CGW_REMOVE_OWNED_AUTOSTART RUNKEY APPROVEDKEY VALUENAME
  ${If} $UpdateMode <> 1
    ReadRegStr $0 HKCU "${RUNKEY}" "${VALUENAME}"
    StrCmp $0 '$\"$INSTDIR\codex-gateway-desktop.exe$\" $\"--from-autostart$\"' 0 +3
      DeleteRegValue HKCU "${RUNKEY}" "${VALUENAME}"
      DeleteRegValue HKCU "${APPROVEDKEY}" "${VALUENAME}"
  ${EndIf}
!macroend

; Refresh Explorer's cached executable/shortcut artwork after a branding update.
!macro NSIS_HOOK_POSTINSTALL
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro CGW_REMOVE_OWNED_AUTOSTART "Software\Microsoft\Windows\CurrentVersion\Run" "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "Codex Gateway Desktop"
!macroend
