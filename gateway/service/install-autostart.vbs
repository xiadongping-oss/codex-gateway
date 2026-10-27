' Codex 网关 · 注册登录自启（计划任务 CodexGateway）
Option Explicit
Dim sh, fso, dir, q, vbs, cmd, r
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
q   = """"
vbs = dir & "\start-gateway.vbs"
cmd = "schtasks /create /tn ""CodexGateway"" /tr " & q & vbs & q & " /sc onlogon /rl limited /f"
r = sh.Run(cmd, 0, True)
If r = 0 Then
  sh.Popup "已注册登录自启（计划任务 CodexGateway）。" & vbCrLf & "取消自启：双击 uninstall-autostart.vbs", 4, "Codex 网关", 64
Else
  sh.Popup "注册失败（exit " & r & "）。若提示拒绝访问，请以管理员身份重试。", 8, "Codex 网关", 48
End If
