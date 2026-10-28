#!/usr/bin/env bash
# 受管运行器：由 launchd / systemd 调用，也可自己手动跑（会占住终端）
#
# 与 Windows 的 service/run-gateway.cmd 对齐：
#   · 上一轮日志留存为 service.log.1，不覆盖丢历史
#   · 以 --lan 启动（局域网内其它设备可接入）
#   · 不主动开浏览器（开机自启时开窗口是骚扰；手动用 start-gateway.sh）
set -u

. "$(cd "$(dirname "$0")" && pwd)/_common.sh"

NODE_BIN="$(cgw_find_node)"
if [ -z "$NODE_BIN" ]; then
  echo "[codex-gateway] 未找到 Node.js。请安装 Node 20+（https://nodejs.org），或用 CGW_NODE=/path/to/node 指定。" >&2
  exit 127
fi
cgw_check_node_version "$NODE_BIN"

mkdir -p "$CGW_LOG_DIR" || exit 1
if [ -f "$CGW_LOG_DIR/service.log" ]; then
  mv -f "$CGW_LOG_DIR/service.log" "$CGW_LOG_DIR/service.log.1"
fi

# 记下 pid 供 stop-gateway.sh 使用（exec 之后这里就是 node 进程本身）
echo $$ > "$CGW_PID_FILE"

cd "$CGW_GATEWAY_DIR" || exit 1
exec "$NODE_BIN" launcher.mjs --lan "$@" >> "$CGW_LOG_DIR/service.log" 2>&1
