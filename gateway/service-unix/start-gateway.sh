#!/usr/bin/env bash
# 手动启动（前台运行，Ctrl+C 停止，会打开控制台）
# 等价于 Windows 的 service/start-gateway.vbs —— 默认带 --lan。
#
#   ./start-gateway.sh            局域网模式 + 打开浏览器
#   ./start-gateway.sh --local    只监听 127.0.0.1
set -u

. "$(cd "$(dirname "$0")" && pwd)/_common.sh"

NODE_BIN="$(cgw_find_node)"
if [ -z "$NODE_BIN" ]; then
  echo "[codex-gateway] 未找到 Node.js。请安装 Node 20+，或用 CGW_NODE=/path/to/node 指定。" >&2
  exit 127
fi
cgw_check_node_version "$NODE_BIN"

ARGS="$*"
if [ -z "$ARGS" ]; then
  set -- --lan --open
elif [ "$1" = "--local" ]; then
  shift
  set -- --open "$@"
fi

cd "$CGW_GATEWAY_DIR" || exit 1
exec "$NODE_BIN" launcher.mjs "$@"
