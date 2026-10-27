' Codex 网关 · 服务启动器（双击运行；已运行则提示后自动消失）
Option Explicit
Dim sh, fso, dir, base, q
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir  = fso.GetParentFolderName(WScript.ScriptFullName)
base = "http://127.0.0.1:4173"
q    = """"

Function HealthOk()
  On Error Resume Next
  HealthOk = False
  Dim http
  Set http = CreateObject("WinHttp.WinHttpRequest.5.1")
  http.SetProxy 0
  http.SetTimeouts 2500, 2500, 2500, 2500
  http.Open "GET", base & "/health", False
  http.Send
  If Err.Number <> 0 Then Err.Clear : Exit Function
  HealthOk = (http.Status = 200)
End Function

If HealthOk() Then
  sh.Popup "网关已在运行中，无需重复启动。" & vbCrLf & "后台地址：" & base, 3, "Codex 网关", 64
  WScript.Quit
End If

sh.Run q & dir & "\run-gateway.cmd" & q, 0, False

Dim i, ok : ok = False
For i = 1 To 16
  WScript.Sleep 500
  If HealthOk() Then ok = True : Exit For
Next

If ok Then
  sh.Popup "网关已启动。后台地址：" & base, 3, "Codex 网关", 64
Else
  sh.Popup "启动命令已发出，但 8 秒内未通过健康检查。" & vbCrLf & "详情：gateway\logs\service.log", 8, "Codex 网关", 48
End If
