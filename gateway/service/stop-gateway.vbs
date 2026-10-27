' Codex 网关 · 服务停止器（只结束 launcher.mjs，不误伤同端口其它程序）
Option Explicit
Dim sh, found, killed
Set sh = CreateObject("WScript.Shell")
found = 0 : killed = 0

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
Set exec = sh.Exec("cmd /c netstat -ano | findstr "":4173"" | findstr /i ""LISTENING""")
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
  sh.Popup "4173 端口被其它程序占用，未做任何操作。", 6, "Codex 网关", 48
Else
  sh.Popup "网关未在运行。", 3, "Codex 网关", 64
End If
