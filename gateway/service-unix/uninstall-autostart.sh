#!/usr/bin/env bash
# 取消开机自启（只删自启注册，不动账号/Key/日志等数据）
# 等价于 Windows 的 service/uninstall-autostart.vbs。
set -u

. "$(cd "$(dirname "$0")" && pwd)/_common.sh"

OS="$(uname -s)"
REMOVED=0

case "$OS" in
  Darwin)
    PLIST="$HOME/Library/LaunchAgents/$CGW_LABEL.plist"
    launchctl bootout "gui/$UID/$CGW_LABEL" >/dev/null 2>&1 && REMOVED=1
    if [ -f "$PLIST" ]; then
      rm -f "$PLIST" && { echo "· 已删除 $PLIST"; REMOVED=1; }
    fi
    ;;

  Linux)
    if command -v systemctl >/dev/null 2>&1; then
      systemctl --user stop codex-gateway.service >/dev/null 2>&1 && REMOVED=1
      systemctl --user disable codex-gateway.service >/dev/null 2>&1 && REMOVED=1
      UNIT="$HOME/.config/systemd/user/codex-gateway.service"
      if [ -f "$UNIT" ]; then
        rm -f "$UNIT" && { echo "· 已删除 $UNIT"; REMOVED=1; }
      fi
      systemctl --user daemon-reload >/dev/null 2>&1 || true
    fi
    ;;

  *)
    echo "✗ 不支持的平台：$OS（本脚本只处理 macOS / Linux）" >&2
    exit 1
    ;;
esac

# 自启停了但进程可能还活着（bootstrap 失败时的残留）
if [ -f "$CGW_PID_FILE" ]; then
  PID="$(tr -dc '0-9' < "$CGW_PID_FILE" 2>/dev/null || true)"
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    cmd="$(ps -o command= -p "$PID" 2>/dev/null || true)"
    case "$cmd" in
      *launcher.mjs*) kill "$PID" 2>/dev/null && echo "· 已停止仍在运行的进程 $PID" ;;
    esac
  fi
  rm -f "$CGW_PID_FILE"
fi

if [ "$REMOVED" -eq 1 ]; then
  echo "✓ 开机自启已取消（当前若在运行请执行 stop-gateway.sh）"
else
  echo "· 没有找到已注册的开机自启，无需处理"
fi
