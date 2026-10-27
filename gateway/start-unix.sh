#!/usr/bin/env bash
# start-unix.sh — macOS / Linux 下直接启动 codex-gateway（Windows 用户请用 service/ 下的脚本）
# 用法：
#   ./start-unix.sh          本机模式（仅 127.0.0.1）
#   ./start-unix.sh --lan    局域网模式（同事可通过 /setup 接入）
# 前提：本机已安装 Node.js 18+（node -v 查看）
cd "$(dirname "$0")" || exit 1
exec node launcher.mjs "$@"
