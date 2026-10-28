' Codex 网关 · 注册登录时自动启动计划任务（CodexGateway）
'
' 端口：命令行第 1 个参数 > 4173
'   带上端口重新注册一次，会把端口写进 logs\port.txt，之后双击启动/停止都用这个端口。
'   例：cscript install-autostart.vbs 4174
'   想回到默认 4173：cscript install-autostart.vbs 4173（会删掉 port.txt）
'
' 端口不塞进计划任务的 /tr 参数里：那需要在 schtasks 参数里再嵌带引号的脚本路径，
' 转义层级深、又没法在本机实测（schtasks 被安全策略拉黑）。用一行文本文件传最稳。
Option Explicit
Dim sh, fso, dir, q, vbs, cmd, r, port, pfile, ts
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir   = fso.GetParentFolderName(WScript.ScriptFullName)
q     = """"
pfile = dir & "\..\logs\port.txt"
port  = ResolvePort()
vbs   = dir & "\start-gateway.vbs"

Function ResolvePort()
  Dim v, n
  ResolvePort = 4173
  If WScript.Arguments.Count = 0 Then Exit Function
  v = Trim(WScript.Arguments(0))
  If v = "" Or Not IsNumeric(v) Then Exit Function
  n = CLng(v)
  If n < 1 Or n > 65535 Then Exit Function
  ResolvePort = n
End Function

On Error Resume Next
If port = 4173 Then
  ' 回到默认端口时把状态文件删掉，避免留下「看起来设置了但其实没生效」的残留
  If fso.FileExists(pfile) Then fso.DeleteFile pfile, True
Else
  If Not fso.FileExists(fso.GetParentFolderName(pfile)) Then fso.CreateFolder fso.GetParentFolderName(pfile)

  Set ts = fso.CreateTextFile(pfile, True)
  ts.WriteLine CStr(port)
  ts.Close
End If
On Error GoTo 0

cmd = "schtasks /create /tn ""CodexGateway"" /tr " & q & vbs & q & " /sc onlogon /rl limited /f"
r = sh.Run(cmd, 0, True)
If r = 0 Then
  sh.Popup "已注册登录时自动启动（计划任务 CodexGateway）。" & vbCrLf & _
           "端口：" & port & vbCrLf & _
           "取消自启：双击 uninstall-autostart.vbs", 4, "Codex 网关", 64
Else
  sh.Popup "注册失败（exit " & r & "），可能是权限被拒绝，可以管理员身份再试。", 8, "Codex 网关", 48
End If
