' Codex 网关 · 服务启动器（双击运行；已运行则提示后自动消失）
'
' 端口优先级：命令行第 1 个参数 > logs\port.txt > 4173
'   cscript start-gateway.vbs 4174      临时换端口
'   cscript install-autostart.vbs 4174  换端口并记住（写 port.txt），之后双击就用它
'
' 为什么端口放 port.txt 而不是塞进计划任务参数：
'   schtasks 的 /tr 值里再嵌带引号的脚本路径 + 参数，转义层级很深、又没法在本机实测
'   （schtasks 被安全策略拉黑）。用一行文本文件传，三个脚本读同一份，改端口只有一处。
'
' 启动失败时不再只说「8 秒内健康检查未通过」，而是按 launcher 的退出码给可操作的原因：
'   2 = 端口被占用（最常见：网关已在跑，或 4173 被 vite preview 占了）
'   3 = 无权限绑定（用了 1024 以下的特权端口）
'   其它 = 弹日志尾部，让人不用去翻文件
Option Explicit
Dim sh, fso, dir, port, base, q, logPath, exitPath, portFile, cmd
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir      = fso.GetParentFolderName(WScript.ScriptFullName)
logPath  = dir & "\..\logs\service.log"
exitPath = dir & "\..\logs\last-exit.txt"
portFile = dir & "\..\logs\port.txt"
port = ResolvePort()
base = "http://127.0.0.1:" & port
q    = """"

' /quiet：一键安装器在收尾时以本模式调用 —— 全程不弹窗，
' 结果用退出码表达（0 = 已就绪，1 = 未就绪），由安装器统一弹一次总结。
' 退出码是契约：install-app.vbs 的总结弹窗靠它区分「已就绪 / 仍在启动」。
Dim quiet : quiet = False
If WScript.Arguments.Named.Exists("quiet") Then quiet = True

Function ReadPortFile()
  Dim ts, s, n
  ReadPortFile = 0
  On Error Resume Next
  If Not fso.FileExists(portFile) Then Exit Function
  Set ts = fso.OpenTextFile(portFile, 1)
  If Err.Number <> 0 Then Err.Clear : Exit Function
  s = Trim(ts.ReadLine)
  ts.Close
  If s = "" Or Not IsNumeric(s) Then Exit Function
  n = CLng(s)
  If n >= 1 And n <= 65535 Then ReadPortFile = n
End Function

Function ResolvePort()
  Dim v, n, i
  ResolvePort = 0
  ' 只认位置参数（Unnamed）：/quiet 这类命名参数不能被当成端口号
  For i = 0 To WScript.Arguments.Unnamed.Count - 1
    v = Trim(WScript.Arguments.Unnamed(i))
    If v <> "" And IsNumeric(v) Then
      n = CLng(v)
      If n >= 1 And n <= 65535 Then
        ResolvePort = n
        Exit Function
      End If
    End If
  Next
  n = ReadPortFile()
  If n > 0 Then
    ResolvePort = n
  Else
    ResolvePort = 4173
  End If
End Function

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
  ' 任意 HTTP 响应都算「已经有进程在监听这个端口」：
  ' 网关在还没添加账号时 /health 返回 503，只认 200 会把「正常启动但未登录」误报成失败。
  HealthOk = (http.Status >= 200 And http.Status < 600)
End Function

Function ReadExitCode()
  ReadExitCode = -1
  On Error Resume Next
  If Not fso.FileExists(exitPath) Then Exit Function
  Dim ts, s
  Set ts = fso.OpenTextFile(exitPath, 1)
  If Err.Number <> 0 Then Err.Clear : Exit Function
  s = Trim(ts.ReadLine)
  ts.Close
  If IsNumeric(s) Then ReadExitCode = CLng(s)
End Function

' 日志尾部（弹窗放不下整份日志，取最后十几行够定位）
Function TailLog()
  Dim ts, all, arr, i, startLine, out
  TailLog = "（日志为空）"
  On Error Resume Next
  If Not fso.FileExists(logPath) Then Exit Function
  Set ts = fso.OpenTextFile(logPath, 1)
  If Err.Number <> 0 Then Err.Clear : Exit Function
  all = ts.ReadAll
  ts.Close
  If Trim(all) = "" Then Exit Function
  arr = Split(all, vbLf)
  startLine = UBound(arr) - 14
  If startLine < 0 Then startLine = 0
  out = ""
  For i = startLine To UBound(arr)
    out = out & Replace(arr(i), vbCr, "") & vbCrLf
  Next
  If Trim(out) <> "" Then TailLog = Trim(out)
End Function

If HealthOk() Then
  If Not quiet Then sh.Popup "网关已经在运行，不必重复启动。" & vbCrLf & "控制台地址：" & base, 3, "Codex 网关", 64
  WScript.Quit 0
End If

' 清掉上一次的退出码，否则会把旧结果当成这次失败的原因
On Error Resume Next
If fso.FileExists(exitPath) Then fso.DeleteFile exitPath, True
On Error GoTo 0

cmd = q & dir & "\run-gateway.cmd" & q & " " & port
sh.Run cmd, 0, False

Dim i, ok : ok = False
' 快速路径：热启动 2-4 秒就绪，500ms 步进保证秒级反馈。
For i = 1 To 16
  WScript.Sleep 500
  If HealthOk() Then ok = True : Exit For
Next
' 慢路径：首次运行时 Windows Defender 要先扫完内置 node.exe（83MB）才放行，
' 冷启动 30 秒以上并不罕见。只等 8 秒就弹「失败」、而网关几秒后自己起来，
' 是 v1.9.1 实测踩过的误报（日志还是 0 字节：stdout 块缓冲，进程退出才落盘）。
If Not ok Then
  For i = 1 To 28
    WScript.Sleep 1000
    If HealthOk() Then ok = True : Exit For
  Next
End If

Dim rc, msg
If ok Then
  If Not quiet Then sh.Popup "网关已启动，控制台地址：" & base, 3, "Codex 网关", 64
  WScript.Quit 0
Else
  rc = ReadExitCode()
  If rc = 2 Then
    msg = "网关启动失败：端口 " & port & " 已被占用。" & vbCrLf & vbCrLf & _
          "· 如果网关其实已经在跑，直接打开 " & base & " 即可" & vbCrLf & _
          "· 要换端口：双击运行 install-autostart.vbs 时带上端口号，" & vbCrLf & _
          "  或在命令行执行 run-gateway.cmd " & (port + 1) & "（仅本次）"
  ElseIf rc = 3 Then
    msg = "网关启动失败：没有权限监听端口 " & port & "。" & vbCrLf & vbCrLf & _
          "1024 以下属于特权端口，普通用户绑不上。请改用 4173 这类高位端口：" & vbCrLf & _
          "  run-gateway.cmd 4173"
  Else
    msg = "网关在 36 秒内没有就绪。" & vbCrLf & vbCrLf & _
          "先直接打开控制台试试——启动慢的场景现在多半已经就绪：" & vbCrLf & _
          base & vbCrLf & vbCrLf & _
          "仍打不开再看日志尾部：" & vbCrLf & TailLog() & vbCrLf & vbCrLf & _
          "完整日志：gateway\logs\service.log（日志暂时为空 = 进程还在启动中）"
  End If
  If Not quiet Then sh.Popup msg, 20, "Codex 网关", 48
  ' 静默模式下安装器靠这个退出码区分「已就绪 / 未就绪」，别改语义
  WScript.Quit 1
End If
