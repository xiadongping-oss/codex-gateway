' Codex 网关 · 服务停止器（只结束 launcher.mjs，不误伤同端口其它程序）
'
' 端口优先级：命令行第 1 个参数 > logs\port.txt > 4173（与 start-gateway.vbs 一致）
'   cscript stop-gateway.vbs 4174
'
' 三种结果分开说，避免把「网关没开」和「端口被别的程序占着」混成一句话——
' 以前两种情况都提示「未在运行」，用户会一直重启，却永远起不来。
Option Explicit
Dim sh, fso, dir, found, killed, port, portFile
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
portFile = dir & "\..\logs\port.txt"
found = 0 : killed = 0
port = ResolvePort()

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
  Dim v, n
  ResolvePort = 0
  If WScript.Arguments.Count > 0 Then
    v = Trim(WScript.Arguments(0))
    If v <> "" And IsNumeric(v) Then
      n = CLng(v)
      If n >= 1 And n <= 65535 Then
        ResolvePort = n
        Exit Function
      End If
    End If
  End If
  n = ReadPortFile()
  If n > 0 Then
    ResolvePort = n
  Else
    ResolvePort = 4173
  End If
End Function

Function IsLauncher(pid)
  On Error Resume Next
  IsLauncher = False
  Dim wmi, items, it
  Set wmi = GetObject("winmgmts:\\.\root\cimv2")
  Set items = wmi.ExecQuery("Select * From Win32_Process Where ProcessId=" & pid)
  For Each it In items
    If InStr(LCase(it.CommandLine & ""), "launcher.mjs") > 0 Then IsLauncher = True
  Next
End Function

Dim exec, line, parts, i, pid
' findstr 的搜索串不含空格时不需要引号，动态拼接端口时省掉引号能避开 VBScript 的引号转义地狱
Set exec = sh.Exec("cmd /c netstat -ano | findstr :" & port & " | findstr /i LISTENING")
Do While Not exec.StdOut.AtEndOfStream
  line = Replace(Trim(exec.StdOut.ReadLine()), vbTab, " ")
  Do While InStr(line, "  ") > 0 : line = Replace(line, "  ", " ") : Loop
  parts = Split(line, " ")
  For i = 0 To UBound(parts) - 1
    If UCase(parts(i)) = "LISTENING" Then
      pid = parts(i + 1)
      found = found + 1
      If IsLauncher(pid) Then
        sh.Run "cmd /c taskkill /PID " & pid & " /T /F", 0, True
        killed = killed + 1
      End If
    End If
  Next
Loop

If killed > 0 Then
  sh.Popup "网关已停止（含 bridge 子进程）。", 3, "Codex 网关", 64
ElseIf found > 0 Then
  sh.Popup "端口 " & port & " 被其它程序占用（不是本网关），未做任何操作。" & vbCrLf & vbCrLf & _
           "要查是谁：netstat -ano | findstr :" & port, 8, "Codex 网关", 48
Else
  sh.Popup "网关未在运行（端口 " & port & " 没有监听）。", 3, "Codex 网关", 64
End If
