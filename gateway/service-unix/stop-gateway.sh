#!/usr/bin/env bash
# 停止网关
#
# 顺序很重要：注册过开机自启的机器必须先交给 launchd / systemd 停，
# 否则守护进程会在 5 秒内把网关重新拉起来，用户看到的现象就是「点了停止没反应」。
set -u

. "$(cd "$(dirname "$0")" && pwd)/_common.sh"

STOPPED=0

# ---- 1) 先停掉守护（如果注册过） ----
if [ "$(uname -s)" = "Darwin" ] && command -v launchctl >/dev/null 2>&1; then
  if launchctl print "gui/$UID/$CGW_LABEL" >/dev/null 2>&1; then
    if launchctl bootout "gui/$UID/$CGW_LABEL" >/dev/null 2>&1; then
      echo "· 已从 launchd 卸载 $CGW_LABEL"
      STOPPED=1
    fi
  fi
fi

if command -v systemctl >/dev/null 2>&1; then
  if systemctl --user is-active --quiet codex-gateway.service 2>/dev/null; then
    if systemctl --user stop codex-gateway.service 2>/dev/null; then
      echo "· 已停止 systemd 用户服务 codex-gateway.service"
      STOPPED=1
    fi
  fi
fi

# ---- 2) pid 文件（run-gateway.sh 写的） ----
kill_if_ours() {
  local pid="$1" cmd
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  cmd="$(ps -o command= -p "$pid" 2>/dev/null || true)"
  # 只杀自己的 launcher，避免 pid 被回收后误伤别的进程
  case "$cmd" in
    *launcher.mjs*) ;;
    *) return 1 ;;
  esac
  kill "$pid" 2>/dev/null || return 1
  local i=0
  while [ "$i" -lt 25 ] && kill -0 "$pid" 2>/dev/null; do
    sleep 0.2
    i=$((i + 1))
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -9 "$pid" 2>/dev/null || true
  fi
  return 0
}

if [ -f "$CGW_PID_FILE" ]; then
  PID="$(tr -dc '0-9' < "$CGW_PID_FILE" 2>/dev/null || true)"
  if kill_if_ours "$PID"; then
    echo "· 已停止进程 $PID"
    STOPPED=1
  fi
  rm -f "$CGW_PID_FILE"
fi

# ---- 3) 兜底：占用启动器端口、且命令行确实是 launcher.mjs 的进程 ----
PORT="${LAUNCHER_PORT:-4173}"
if command -v lsof >/dev/null 2>&1; then
  for pid in $(lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null || true); do
    if kill_if_ours "$pid"; then
      echo "· 已停止监听 $PORT 的进程 $pid"
      STOPPED=1
    fi
  done
fi

if [ "$STOPPED" -eq 1 ]; then
  echo "✓ 网关已停止"
else
  echo "· 没有发现运行中的网关（端口 $PORT 无监听，也没有 pid 文件）"
fi
