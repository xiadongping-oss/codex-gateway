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
