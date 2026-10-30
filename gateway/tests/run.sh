#!/usr/bin/env bash
# Compatibility wrapper; the isolated runner itself works on Windows and Unix.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
NODE="${NODE:-node}"
if [ "${1:-}" = "--live" ]; then
  exec "$NODE" "$ROOT/audit.mjs" --readonly --base=http://127.0.0.1:4173
fi
exec "$NODE" "$ROOT/run-audit.mjs"
