' Codex 网关 · 移除登录自启（计划任务 CodexGateway）
Option Explicit
Dim sh, r
Set sh = CreateObject("WScript.Shell")
r = sh.Run("schtasks /delete /tn ""CodexGateway"" /f", 0, True)
If r = 0 Then
  sh.Popup "已移除登录自启。", 3, "Codex 网关", 64
Else
  sh.Popup "未找到计划任务 CodexGateway（可能本来就没注册）。", 4, "Codex 网关", 64
End If
