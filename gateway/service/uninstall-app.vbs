' Codex Gateway —— 卸载
'
' 从开始菜单「Codex Gateway 卸载」或 Windows「设置 - 应用」启动。
' 做五件事：
'   1. 停止正在运行的网关（含 bridge 子进程）
'   2. 取消开机自启的计划任务
'   3. 删除开始菜单快捷方式与卸载注册表项
'   4. 删除程序目录（含本脚本自己，最后一步延迟自删）
'   5. 数据目录（账号 / API Key / 日志）默认**保留**，确认后才删
'
' 数据目录里是你的 ChatGPT 登录凭据和 API Key —— 卸载软件不必删它们，
' 重装后原样恢复，不用重新登录。
Option Explicit

Dim sh, fso, dstDir, dataDir, q
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
q = """"
dstDir  = fso.GetParentFolderName(fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName)))
' 本脚本位于 <安装>\gateway\service\uninstall-app.vbs，向上三层就是安装根目录
dataDir = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\CodexGateway"

If MsgBox("确定卸载 Codex Gateway 吗？" & vbCrLf & vbCrLf & _
          "程序目录：" & dstDir & vbCrLf & _
          "账号 / API Key 等数据默认保留，最后会再问你。", _
          vbYesNo + vbQuestion, "卸载 Codex Gateway") <> vbYes Then
  WScript.Quit 0
End If

' ---------- 1) 停网关 ----------
If fso.FileExists(dstDir & "\gateway\service\stop-gateway.vbs") Then
  sh.Run "wscript.exe " & q & dstDir & "\gateway\service\stop-gateway.vbs" & q, 0, True
End If
WScript.Sleep 500

' ---------- 2) 取消开机自启（任务不存在时 schtasks 报错，忽略） ----------
On Error Resume Next
sh.Run "cmd /c schtasks /delete /tn CodexGateway /f > nul 2>&1", 0, True
On Error GoTo 0

' ---------- 3) 快捷方式与注册表 ----------
On Error Resume Next
Dim smDir, lnk
smDir = sh.ExpandEnvironmentStrings("%APPDATA%") & "\Microsoft\Windows\Start Menu\Programs"
If fso.FileExists(smDir & "\Codex Gateway.lnk") Then fso.DeleteFile smDir & "\Codex Gateway.lnk", True
If fso.FileExists(smDir & "\Codex Gateway 卸载.lnk") Then fso.DeleteFile smDir & "\Codex Gateway 卸载.lnk", True
sh.RegDelete "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexGateway\"
On Error GoTo 0

' ---------- 4) 数据目录：默认保留 ----------
Dim killData
killData = vbNo
If fso.FolderExists(dataDir) Then
  killData = MsgBox("要连同数据一起删除吗？" & vbCrLf & vbCrLf & _
                    dataDir & vbCrLf & vbCrLf & _
                    "里面有 ChatGPT 登录凭据与 API Key。" & vbCrLf & _
                    "选「否」= 保留数据，重装后免重新登录。", _
                    vbYesNo + vbExclamation, "卸载 Codex Gateway")
End If

' ---------- 5) 按选择删数据目录，然后删程序目录（延迟自删） ----------
If killData = vbYes Then
  On Error Resume Next
  Err.Clear
  fso.DeleteFolder dataDir, True
  If Err.Number <> 0 Then
    MsgBox "数据目录删除失败（可能有文件被占用）：" & vbCrLf & dataDir & vbCrLf & vbCrLf & _
           "程序目录仍会正常移除，请稍后手动删除上面这个文件夹。", 48, "卸载 Codex Gateway"
  End If
  On Error GoTo 0
End If

MsgBox "Codex Gateway 已卸载。" & vbCrLf & _
       IIf(killData = vbYes, "数据已删除。", "数据保留在：" & dataDir), _
       64, "卸载 Codex Gateway"
' 用户点完「完成」wscript 才会退出，ping 的 2 秒延迟只是保险，
' rd 删的是已无人占用的程序目录（本脚本内容早已读进内存，文件可删）。
sh.Run "cmd /c ping -n 3 127.0.0.1 > nul & rd /s /q " & q & dstDir & q, 0, False
