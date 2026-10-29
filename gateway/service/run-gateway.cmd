@echo off
rem Codex Gateway service runner - called by start-gateway.vbs (hidden window)
rem
rem Usage: run-gateway.cmd [port]
rem   端口省略时用 launcher 的默认值（4173）。给端口是为了避开「4173 被 vite preview 占用」。
rem
rem Log: gateway\logs\service.log      本轮日志（上一轮留存为 service.log.1）
rem      gateway\logs\last-exit.txt    launcher 的退出码，供 start-gateway.vbs 判断失败原因
rem                                   （2=端口被占 3=无权限 1=其它）
setlocal
set "DIR=%~dp0"
cd /d "%DIR%.."

rem ---- 安装布局（install-app.vbs 写入 installed.env）----
rem 有这个文件时把数据目录指到 %LOCALAPPDATA%\CodexGateway：
rem 账号/Key/日志与程序分离，卸载升级不再连数据一起删。
rem 绿色版没有此文件，一切照旧（数据长在程序目录里）。
rem for /f 的 eol=; 跳过注释行；delims== 按第一个 = 切 key/value，值可含空格。
if exist "%DIR%installed.env" (
  for /f "usebackq eol=; tokens=1,* delims==" %%a in ("%DIR%installed.env") do set "%%a=%%b"
)

if not exist "logs" mkdir "logs"
if exist "logs\service.log" move /y "logs\service.log" "logs\service.log.1" >nul
set "NODE_EXE=%DIR%node\node.exe"
rem 发布包内置运行时；缺失时退回 PATH 里的 node（不要写死开发机路径）
if not exist "%NODE_EXE%" set "NODE_EXE=node"

rem 只在明确给了端口时才追加参数，避免传成 --port ""
set "PORT_ARG="
if not "%~1"=="" set "PORT_ARG=--port %~1"

"%NODE_EXE%" launcher.mjs --lan --open %PORT_ARG% >> "logs\service.log" 2>&1
rem 先存退出码再重定向：重定向本身会改写 ERRORLEVEL
set "RC=%ERRORLEVEL%"
>"logs\last-exit.txt" echo %RC%
endlocal
