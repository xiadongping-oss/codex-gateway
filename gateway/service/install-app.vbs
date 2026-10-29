' Codex Gateway —— 一键安装
'
' 双击本文件即可（也可以在终端里 cscript install-app.vbs）：
'   1. 程序装到  %LOCALAPPDATA%\Programs\CodexGateway
'   2. 数据住到  %LOCALAPPDATA%\CodexGateway —— 账号 / API Key / 日志与程序分离，
'      卸载、升级、重装都不会再动用户数据
'   3. 创建开始菜单快捷方式，并在 Windows「设置 - 应用」里出现正常卸载入口
'
' 已装过时再次运行 = 升级：先停网关，覆盖程序文件，数据原样保留。
' 之前以绿色版（解压直跑）用过的，脚本会把旧数据原样搬进数据目录。
'
' 为什么数据目录里还留着一层 gateway\：与绿色版布局完全一致，
' 迁移就是「原样拷贝」，不需要任何格式转换，两套布局可以随时互换。
Option Explicit

Dim sh, fso, srcDir, dstDir, dataDir, q
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
q = """"
srcDir  = fso.GetParentFolderName(WScript.ScriptFullName)
dstDir  = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Programs\CodexGateway"
dataDir = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\CodexGateway"

' 本脚本同时存在于包根（install.vbs 入口）与 gateway\service\（安装后副本），
' 以「自身父目录」或「再上一级」定位包根——两种位置都能直接双击运行。
If Not fso.FolderExists(srcDir & "\gateway") Then
  Dim up1
  up1 = fso.GetParentFolderName(srcDir)
  If fso.FolderExists(up1 & "\gateway") Then srcDir = up1
End If

If Not fso.FolderExists(srcDir & "\gateway") Then
  MsgBox "请在解压后的安装包文件夹里运行 install.vbs（包根目录）。" & vbCrLf & _
         "当前文件夹里没有 gateway 子目录：" & vbCrLf & srcDir, 48, "Codex Gateway 安装"
  WScript.Quit 1
End If

' ---------- 0) 先停掉可能在跑的实例（升级 / 绿色版并存都要停，避免文件占用与端口冲突） ----------
Dim stopCmd
If fso.FileExists(dstDir & "\gateway\service\stop-gateway.vbs") Then
  stopCmd = "wscript.exe " & q & dstDir & "\gateway\service\stop-gateway.vbs" & q
  sh.Run stopCmd, 0, True
End If
If srcDir <> dstDir Then
  If fso.FileExists(srcDir & "\gateway\service\stop-gateway.vbs") Then
    stopCmd = "wscript.exe " & q & srcDir & "\gateway\service\stop-gateway.vbs" & q
    sh.Run stopCmd, 0, True
  End If
End If
WScript.Sleep 800

' ---------- 1) 数据迁移（绿色版 -> 安装版；升级时旧数据已在数据目录则跳过） ----------
' 迁移明细与 resolveDataRoot / auth-core 的布局一一对应，漏一项就是「登录态凭空消失」。
CopyDataFile "accounts.json"
CopyDataFolder "accounts"
CopyDataFile "auth.json"
CopyDataFile ".gw-config.json"
CopyDataFile ".codex-client-identity"
CopyDataFile "api-keys.json"
CopyDataFile "admin-token.json"
CopyDataFolder "data"
CopyDataFolder "references"

' ---------- 2) 覆盖程序文件 ----------
On Error Resume Next
Err.Clear
If Not fso.FolderExists(sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Programs") Then
  fso.CreateFolder sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Programs"
End If
If Err.Number <> 0 Then Err.Clear
If Not fso.FolderExists(dstDir) Then
  fso.CreateFolder dstDir
  If Err.Number <> 0 Then
    MsgBox "无法创建安装目录：" & dstDir & vbCrLf & "请检查杀毒软件或磁盘权限后重试。", 48, "Codex Gateway 安装"
    WScript.Quit 1
  End If
End If
On Error GoTo 0

ReplaceTree "gateway"
ReplaceTree "frontend"
ReplaceTree "lan-kit"
ReplaceTree "README.md"
ReplaceTree "QUICK-START.md"
ReplaceTree "package.json"
ReplaceTree "BUILD-INFO.json"
' 包根一键入口：release 包里构建时生成，随升级一起进安装目录根
' （源码树里没有这两个文件，ReplaceTree 对不存在的源直接跳过）
ReplaceTree "install.vbs"
ReplaceTree "uninstall.vbs"

' ---------- 3) 写 installed.env：run-gateway.cmd 读它注入 CGW_DATA_DIR ----------
' 用系统 ANSI 编码（CreateTextFile 默认），cmd 的 for /f 读的也是 ANSI，
' 含中文的用户名路径不会乱码；下次安装会整个重写，手工改动不保留。
On Error Resume Next
Dim envPath, ts
envPath = dstDir & "\gateway\service\installed.env"
Set ts = fso.CreateTextFile(envPath, True)
If Err.Number <> 0 Then
  MsgBox "无法写入 installed.env（" & envPath & "）：" & vbCrLf & Err.Description, 48, "Codex Gateway 安装"
  WScript.Quit 1
End If
ts.WriteLine "; Codex Gateway installation data dir (written by install-app.vbs)"
ts.WriteLine "CGW_DATA_DIR=" & dataDir
ts.Close
On Error GoTo 0

' ---------- 4) 开始菜单快捷方式 ----------
Dim smDir, lnk
smDir = sh.ExpandEnvironmentStrings("%APPDATA%") & "\Microsoft\Windows\Start Menu\Programs"
Set lnk = sh.CreateShortcut(smDir & "\Codex Gateway.lnk")
lnk.TargetPath = dstDir & "\gateway\service\start-gateway.vbs"
lnk.WorkingDirectory = dstDir & "\gateway\service"
lnk.Description = "Codex Gateway - 启动网关并打开控制台"
lnk.Save
Set lnk = sh.CreateShortcut(smDir & "\Codex Gateway 卸载.lnk")
lnk.TargetPath = dstDir & "\gateway\service\uninstall-app.vbs"
lnk.WorkingDirectory = dstDir & "\gateway\service"
lnk.Description = "卸载 Codex Gateway"
lnk.Save

' ---------- 5) 注册卸载信息：设置 - 应用 里能正常卸载 ----------
Dim rk, ver, txt
rk = "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexGateway\"
ver = "unknown"
If fso.FileExists(dstDir & "\BUILD-INFO.json") Then
  Set ts = fso.OpenTextFile(dstDir & "\BUILD-INFO.json", 1)
  txt = ts.ReadAll
  ts.Close
  Dim re, matches
  Set re = New RegExp
  re.Pattern = """version""\s*:\s*""([^""]+)"""
  If re.Test(txt) Then
    Set matches = re.Execute(txt)
    ver = matches(0).SubMatches(0)
  End If
End If
sh.RegWrite rk & "DisplayName", "Codex Gateway", "REG_SZ"
sh.RegWrite rk & "DisplayVersion", ver, "REG_SZ"
sh.RegWrite rk & "Publisher", "codex-gateway (MIT)", "REG_SZ"
sh.RegWrite rk & "InstallLocation", dstDir, "REG_SZ"
sh.RegWrite rk & "DisplayIcon", dstDir & "\gateway\service\node\node.exe,0", "REG_SZ"
sh.RegWrite rk & "UninstallString", "wscript.exe " & q & dstDir & "\gateway\service\uninstall-app.vbs" & q, "REG_SZ"
sh.RegWrite rk & "NoModify", 1, "REG_DWORD"
sh.RegWrite rk & "NoRepair", 1, "REG_DWORD"

' ---------- 6) 收尾：静默启动 + 单次总结 ----------
' 不再连环问「现在启动吗」「注册自启吗」（用户实测嫌烦）：启动是安装的
' 自然收尾，静默执行；自启不默认注册（尊重用户选择），总结里给一行指引。
' start-gateway.vbs /quiet 全程无弹窗，退出码 0 = 已就绪 / 1 = 未就绪。
Dim portGw, rcStart, sPort, tsPort
portGw = 4173
If fso.FileExists(dstDir & "\gateway\logs\port.txt") Then
  On Error Resume Next
  Set tsPort = fso.OpenTextFile(dstDir & "\gateway\logs\port.txt", 1)
  If Err.Number = 0 Then
    sPort = Trim(tsPort.ReadLine)
    tsPort.Close
    If IsNumeric(sPort) Then
      If CLng(sPort) >= 1 And CLng(sPort) <= 65535 Then portGw = CLng(sPort)
    End If
  End If
  Err.Clear
  On Error GoTo 0
End If
rcStart = sh.Run("wscript.exe " & q & dstDir & "\gateway\service\start-gateway.vbs" & q & " /quiet", 0, True)

Dim summary
If rcStart = 0 Then
  summary = "Codex Gateway 安装完成，网关已就绪。" & vbCrLf & vbCrLf & _
            "控制台：" & "http://127.0.0.1:" & portGw & vbCrLf & _
            "程序：" & dstDir & vbCrLf & _
            "数据：" & dataDir & vbCrLf & vbCrLf & _
            "开机自启未注册 —— 需要的话双击安装目录里的 gateway\service\install-autostart.vbs"
  sh.Popup summary, 10, "Codex Gateway", 64
Else
  summary = "安装完成，但网关在 36 秒内未就绪。" & vbCrLf & vbCrLf & _
            "先打开控制台试试（慢启动多半已经就绪）：" & "http://127.0.0.1:" & portGw & vbCrLf & _
            "仍打不开就看日志：" & dstDir & "\gateway\logs\service.log"
  sh.Popup summary, 0, "Codex Gateway", 48
End If

' ---------- helpers ----------
Sub CopyDataFile(name)
  Dim s, d
  s = srcDir & "\gateway\" & name
  d = dataDir & "\" & name
  If fso.FileExists(s) And Not fso.FileExists(d) Then
    EnsureDataDir
    fso.CopyFile s, d, True
  End If
End Sub

Sub CopyDataFolder(name)
  Dim s, d
  s = srcDir & "\gateway\" & name
  d = dataDir & "\" & name
  If fso.FolderExists(s) And Not fso.FolderExists(d) Then
    EnsureDataDir
    fso.CopyFolder s, d, True
  End If
End Sub

Sub EnsureDataDir
  If Not fso.FolderExists(dataDir) Then fso.CreateFolder dataDir
End Sub

' 覆盖式复制：目标里的同名目录/文件先删再拷，保证升级是干净的整树替换。
' 路径都是本安装器自己拼的固定位置，DeleteFolder 不会碰到程序目录之外。
' 删除失败最常见原因是网关还在跑（文件被占用）——如实报错退出，绝不半装。
Sub ReplaceTree(name)
  Dim s, d
  s = srcDir & "\" & name
  d = dstDir & "\" & name
  If Not fso.FolderExists(s) And Not fso.FileExists(s) Then Exit Sub
  On Error Resume Next
  Err.Clear
  If fso.FolderExists(d) Then fso.DeleteFolder d, True
  If fso.FileExists(d) Then fso.DeleteFile d, True
  If Err.Number <> 0 Then
    MsgBox "无法替换旧文件：" & d & vbCrLf & vbCrLf & _
           "网关可能还在运行，请等几秒后重新运行本安装器。", 48, "Codex Gateway 安装"
    WScript.Quit 1
  End If
  On Error GoTo 0
  If fso.FolderExists(s) Then
    fso.CopyFolder s, d, True
  Else
    fso.CopyFile s, d, True
  End If
End Sub
