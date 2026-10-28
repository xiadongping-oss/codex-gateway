#!/usr/bin/env bash
# codex-gateway · 上线前安全审计 —— 一键运行（指南第三步）
#
# 一条命令完成：重置沙盒 → 起隔离实例 → 跑全套回归 → 汇总结果
#
#   bash run.sh              # 沙盒模式（默认，安全，可反复执行）
#   bash run.sh --live       # 只读模式打真实网关 127.0.0.1:4173
#
# 为什么必须沙盒：部分用例跨越权/删除/写操作，会改动数据。
# 沙盒是一份独立的数据目录 + 独立端口 + 独立 HOME，与真实凭据完全隔离。

set -uo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"        # gateway/tests
GATEWAY="$(cd "$ROOT/.." && pwd)"            # gateway —— 被测对象，唯一真源
SB="$ROOT/sandbox"
GEN="$SB/home/.chatgpt-bridge/gen-images"
NODE="${NODE:-node}"

LIVE=0
[ "${1:-}" = "--live" ] && LIVE=1

if [ "$LIVE" = "1" ]; then
  echo "▶ 只读模式：打真实网关 http://127.0.0.1:4173（不修改任何数据）"
  exec "$NODE" "$ROOT/audit.mjs" --readonly --base=http://127.0.0.1:4173
fi

PORT=4199
cleanup() { [ -n "${PID:-}" ] && kill "$PID" 2>/dev/null; }
trap cleanup EXIT

echo "▶ 准备沙盒目录"
# 必须显式创建：全新 clone 时 sandbox/ 不存在，后续 cp 会失败
mkdir -p "$SB"

echo "▶ 同步源码到沙盒（始终以 gateway/ 为唯一真源，避免「测的是旧代码」）"
for f in "$GATEWAY/"*.mjs "$GATEWAY/"*.html; do
  [ -f "$f" ] && cp "$f" "$SB/"
done
# 依赖只需复制一次（24MB），沙盒重建时复用
[ -d "$SB/node_modules" ] || cp -r "$GATEWAY/node_modules" "$SB/" 2>/dev/null
cd "$SB"

echo "▶ 重置沙盒数据（保留代码副本，清空凭据与素材）"
# 为什么不对 "$GEN" 用 rm -rf：反复重跑后图库会累积到 50+，递归删除会撞上
# 本机批量删除保护（单回合 50 条），整套测试直接失败。图库索引清空即对上层
# 不可见，物理图残留不影响任何断言。
rm -rf "$SB/accounts" 2>/dev/null
mkdir -p "$GEN" "$SB/data"
echo '{}'                              > "$GEN/index.json"
echo '{"activeId":null,"accounts":[]}' > "$SB/accounts.json"
echo '{"keys":[]}'                     > "$SB/api-keys.json"
echo '{"sources":[]}'                  > "$SB/data/asset-sources.json"
# 金丝雀配置：这个值只存在于沙盒。任何穿越/泄露路径读到它，测试必须报警。
cat > "$SB/.gw-config.json" <<JSON
{"mode":"bridge","strictAuth":false,"proxy":"",
 "openaiApiKey":"CANARY-SECRET-DO-NOT-LEAK",
 "authFilePath":"$SB/home/.chatgpt-bridge/auth.json"}
JSON

echo "▶ 启动隔离实例 :$PORT（LAN 模式 = 与线上一致的配置）"
cd "$SB"
USERPROFILE="$SB/home" HOME="$SB/home" LAUNCHER_PORT=$PORT BRIDGE_PORT=10999 DISABLE_AUTOSTART=1 \
  "$NODE" launcher.mjs --lan > "$ROOT/sandbox.log" 2>&1 &
PID=$!

for i in $(seq 1 40); do
  code=$(curl -s -m 2 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/health" 2>/dev/null || echo 0)
  # 任意 HTTP 响应即算起来：沙盒无账号时 /health 明确返回 503 bridge_not_running
  # （v1.3.0 起；502 是更早的语义）。只认 200 会白等到超时。
  # JS 侧的同一口径在 lib/health.mjs；这里是 bash，共享不了常量，改那边要同步这里。
  { [ "$code" = "200" ] || [ "$code" = "502" ] || [ "$code" = "503" ]; } && break
  sleep 0.25
done
[ "${code:-0}" = "0" ] && { echo "✗ 沙盒实例未起来，日志："; tail -20 "$ROOT/sandbox.log"; exit 1; }

echo "▶ 运行回归套件"
"$NODE" "$ROOT/audit.mjs" --base="http://127.0.0.1:$PORT" --gendir="$GEN" --tokenfile="$SB/admin-token.json"
rc=$?

echo
[ $rc -eq 0 ] && echo "✅ 全部通过" || echo "❌ 存在失败用例（退出码 $rc）"
exit $rc
