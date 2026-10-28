#!/usr/bin/env bash
# Codex Gateway · macOS / Linux 公共片段（被同目录其它脚本 source）
#
# Windows 那套是 .vbs + schtasks（隐藏窗口）。macOS/Linux 没有等价物，
# 各自用系统原生的守护方式：launchd（macOS）/ systemd --user（Linux）。
# 这里只放三个脚本都要用的路径解析与 node 探测，避免复制三份后各自漂移。

CGW_SERVICE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CGW_GATEWAY_DIR="$(cd "$CGW_SERVICE_DIR/.." && pwd)"      # …/gateway
CGW_HOME_DIR="$(cd "$CGW_GATEWAY_DIR/.." && pwd)"         # 解压后的根目录
CGW_LOG_DIR="$CGW_GATEWAY_DIR/logs"
CGW_PID_FILE="$CGW_LOG_DIR/service.pid"
CGW_LABEL="com.codex-gateway.gateway"

# node 探测顺序：显式指定 > 发布包内置运行时 > PATH
# 发布包目前只在 Windows 里内置 node.exe，所以 macOS/Linux 用户多数走 PATH。
cgw_find_node() {
  if [ -n "${CGW_NODE:-}" ]; then
    printf '%s\n' "$CGW_NODE"
    return 0
  fi
  for c in "$CGW_SERVICE_DIR/node/bin/node" "$CGW_GATEWAY_DIR/runtime/bin/node"; do
    if [ -x "$c" ]; then
      printf '%s\n' "$c"
      return 0
    fi
  done
  command -v node 2>/dev/null || true
}

# 只打印警告，不阻断：低于建议版本时用户自己承担（会报语法/API 缺失）
cgw_check_node_version() {
  local bin="$1" major ver
  [ -n "$bin" ] || return 0
  major="$("$bin" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  ver="$("$bin" -p 'process.versions.node' 2>/dev/null || echo '?')"
  case "$major" in
    ''|*[!0-9]*) return 0 ;;
  esac
  if [ "$major" -lt 20 ]; then
    echo "[codex-gateway] 警告：当前 Node $ver 低于建议的 20，若启动报语法错误请先升级。" >&2
  fi
}
