#!/usr/bin/env bash
# 注册开机自启（macOS = launchd，Linux = systemd --user）
#
# 幂等：重复执行只会覆盖旧配置并重新加载，不会装出两份。
# 等价于 Windows 的 service/install-autostart.vbs。
set -u

. "$(cd "$(dirname "$0")" && pwd)/_common.sh"

# 端口：--port N > 4173。非默认端口会写进 logs/port.txt（stop-gateway.sh 也读它），
# 并固化进 launchd/systemd 的启动参数——否则自启会用 4173 再起一个「另一个网关」。
PORT=4173
while [ $# -gt 0 ]; do
  case "$1" in
    --port)   PORT="${2:-}"; shift 2 || true ;;   # 显式给了 --port 却没值 → 走下面的校验报错，不静默回落默认
    --port=*) PORT="${1#*=}"; shift ;;
    *) shift ;;
  esac
done
case "$PORT" in
  ''|*[!0-9]*) echo "✗ --port 必须是数字（收到 \"$PORT\"）" >&2; exit 1 ;;
esac
if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  echo "✗ --port 超出范围 1-65535（收到 $PORT）" >&2
  exit 1
fi

NODE_BIN="$(cgw_find_node)"
if [ -z "$NODE_BIN" ]; then
  echo "[codex-gateway] 未找到 Node.js：自启会装好但一启动就失败。" >&2
  echo "                请先安装 Node 20+（或用 CGW_NODE 指定），再重新执行本脚本。" >&2
fi
cgw_check_node_version "$NODE_BIN"

# .sh 从 zip 解压后可能丢失可执行位，这里补齐（执行时用的是 bash，其实不依赖 x 位）
chmod +x "$CGW_SERVICE_DIR"/*.sh 2>/dev/null || true
mkdir -p "$CGW_LOG_DIR" || exit 1

# 端口状态文件与 Windows 侧同名同格式（logs/port.txt 一行数字）：
#   stop-gateway.sh 靠它找端口，用户也能一眼看到"当前自启用的是哪个端口"。
if [ "$PORT" = "4173" ]; then
  rm -f "$CGW_LOG_DIR/port.txt"
else
  printf '%s\n' "$PORT" > "$CGW_LOG_DIR/port.txt" || exit 1
fi

RUNNER="$CGW_SERVICE_DIR/run-gateway.sh"
NODE_DIR="$(dirname "${NODE_BIN:-/usr/bin/node}")"

# 两种格式各准备一份：plist 是数组（每项一对 <string>），systemd 是单行参数
if [ "$PORT" = "4173" ]; then
  PORT_XML=""
  PORT_ARG=""
else
  PORT_XML='
    <string>--port</string>'
  PORT_XML="$PORT_XML
    <string>$PORT</string>"
  PORT_ARG=" --port $PORT"
fi

OS="$(uname -s)"
case "$OS" in
  Darwin)
    PLIST="$HOME/Library/LaunchAgents/$CGW_LABEL.plist"
    mkdir -p "$(dirname "$PLIST")" || exit 1
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$CGW_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$RUNNER</string>$PORT_XML
  </array>
  <key>WorkingDirectory</key>
  <string>$CGW_GATEWAY_DIR</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$CGW_LOG_DIR/launchd.out.log</string>
  <key>StandardErrorPath</key>
  <string>$CGW_LOG_DIR/launchd.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$NODE_DIR:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
EOF
    if [ ! -f "$PLIST" ]; then
      echo "✗ 写入 $PLIST 失败" >&2
      exit 1
    fi
    # 先卸载旧的（忽略"本来就没装"），再加载新的
    launchctl bootout "gui/$UID/$CGW_LABEL" >/dev/null 2>&1 || true
    if launchctl bootstrap "gui/$UID" "$PLIST" >/dev/null 2>&1; then
      :
    elif launchctl load -w "$PLIST" >/dev/null 2>&1; then
      :
    else
      echo "✗ launchctl 加载失败：$PLIST" >&2
      echo "  可手动排查：launchctl print gui/$UID/$CGW_LABEL" >&2
      exit 1
    fi
    echo "✓ 已注册开机自启（launchd）"
    echo "  plist : $PLIST"
    echo "  日志  : $CGW_LOG_DIR/service.log"
    echo "  取消  : $CGW_SERVICE_DIR/uninstall-autostart.sh"
    echo "  立即停: $CGW_SERVICE_DIR/stop-gateway.sh"
    ;;

  Linux)
    if ! command -v systemctl >/dev/null 2>&1; then
      echo "✗ 未找到 systemctl：这个系统不支持 systemd 用户服务。" >&2
      echo "  可直接用 $CGW_SERVICE_DIR/run-gateway.sh 自行托管（或写进 crontab @reboot）。" >&2
      exit 1
    fi
    UNIT_DIR="$HOME/.config/systemd/user"
    UNIT="$UNIT_DIR/codex-gateway.service"
    mkdir -p "$UNIT_DIR" || exit 1
    # ExecStart 里路径带引号，systemd 支持；不要在这里写死 PATH 覆盖，
    # 用户装的 node 常在 nvm / asdf 的路径下，PATH 交给 run-gateway.sh 探测。
    cat > "$UNIT" <<EOF
[Unit]
Description=Codex Gateway (local OpenAI-compatible API)
Documentation=file://$CGW_HOME_DIR/README.md
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$CGW_GATEWAY_DIR
ExecStart=/bin/bash "$RUNNER"$PORT_ARG
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
    if [ ! -f "$UNIT" ]; then
      echo "✗ 写入 $UNIT 失败" >&2
      exit 1
    fi
    systemctl --user daemon-reload || exit 1
    systemctl --user enable codex-gateway.service || exit 1
    systemctl --user restart codex-gateway.service || exit 1
    echo "✓ 已注册开机自启（systemd --user）"
    echo "  单元  : $UNIT"
    echo "  状态  : systemctl --user status codex-gateway.service"
    echo "  日志  : journalctl --user -u codex-gateway -f   （或 $CGW_LOG_DIR/service.log）"
    echo "  取消  : $CGW_SERVICE_DIR/uninstall-autostart.sh"

    # 没开 linger 的话，注销登录后用户服务会被一并停掉——这是最常见的「自启没生效」
    LINGER="$(loginctl show-user "$USER" -p Linger 2>/dev/null | cut -d= -f2 || true)"
    if [ "$LINGER" != "yes" ]; then
      echo
      echo "提示：当前用户未开启 linger，注销登录后网关会停。需要一直挂着就执行："
      echo "      sudo loginctl enable-linger $USER"
    fi
    ;;

  *)
    echo "✗ 不支持的平台：$OS（本脚本只处理 macOS / Linux）" >&2
    exit 1
    ;;
esac
