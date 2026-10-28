@echo off
rem Codex Gateway service runner - called by start-gateway.vbs (hidden window)
rem Log: gateway\logs\service.log (previous run kept as service.log.1)
setlocal
set "DIR=%~dp0"
cd /d "%DIR%.."
if not exist "logs" mkdir "logs"
if exist "logs\service.log" move /y "logs\service.log" "logs\service.log.1" >nul
set "NODE_EXE=%DIR%node\node.exe"
rem 发布包内置运行时；缺失时退回 PATH 里的 node（不要写死开发机路径）
if not exist "%NODE_EXE%" set "NODE_EXE=node"
"%NODE_EXE%" launcher.mjs --lan --open >> "logs\service.log" 2>&1
endlocal
