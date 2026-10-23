#!/bin/bash
# Installs Cloud Pool for DaVinci Resolve on macOS.
#  • Resolve Studio: as a Workflow Integration plugin (Workspace ▸ Workflow Integrations ▸ Cloud Pool).
#  • Free edition (or --standalone): as an app started from Workspace ▸ Scripts ▸ Cloud Pool, using the
#    Electron runtime that ships inside DaVinci Resolve.app (no Node.js needed when it is present).
# Usage: bash scripts/install-macos.sh [--standalone]
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$HERE/plugin"
SUPPORT="/Library/Application Support/Blackmagic Design/DaVinci Resolve"
DEST="$SUPPORT/Workflow Integration Plugins/com.cloudpool.googlephotos"
NODE_SRC="$SUPPORT/Developer/Workflow Integrations/Examples/SamplePlugin/WorkflowIntegration.node"
RESOLVE_APP="/Applications/DaVinci Resolve/DaVinci Resolve.app"
CLIENT_JSON="$(ls "$HERE"/client_secret*.json 2>/dev/null | head -n 1 || true)"
STANDALONE=0
[ "${1:-}" = "--standalone" ] && STANDALONE=1

echo "Cloud Pool — установка для DaVinci Resolve"
echo

copy_plugin() { # $1 = target, $2 = optional "sudo"
  local target="$1" sudo="${2:-}"
  $sudo mkdir -p "$target"
  $sudo rsync -a --delete \
    --exclude 'WorkflowIntegration.node' --exclude 'credentials.json' --exclude '.DS_Store' \
    "$SRC/" "$target/"
  if [ -n "$CLIENT_JSON" ] && [ ! -f "$target/credentials.json" ]; then
    $sudo cp "$CLIENT_JSON" "$target/credentials.json"
    echo "OAuth-клиент Google скопирован из $(basename "$CLIENT_JSON")."
  fi
  $sudo xattr -dr com.apple.quarantine "$target" 2>/dev/null || true
}

json_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

if [ -f "$NODE_SRC" ] && [ "$STANDALONE" = 0 ]; then
  # ── Resolve Studio: Workflow Integration plugin ──────────────────────────────
  SUDO=""
  if ! mkdir -p "$DEST" 2>/dev/null || [ ! -w "$DEST" ]; then
    echo "Нужны права администратора для записи в /Library/Application Support…"
    SUDO="sudo"
  fi
  copy_plugin "$DEST" "$SUDO"
  $SUDO cp "$NODE_SRC" "$DEST/WorkflowIntegration.node"
  echo
  echo "Готово: $DEST"
  echo "Перезапустите DaVinci Resolve Studio и откройте:"
  echo "  Workspace ▸ Workflow Integrations ▸ Cloud Pool (Google Photos)"
  exit 0
fi

# ── Free edition (or --standalone): app + bridge script ─────────────────────────
DATA="$HOME/Library/Application Support/Cloud Pool for Resolve"
APP_DIR="$DATA/app"
SCRIPTS="$HOME/Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Utility"
copy_plugin "$APP_DIR"
mkdir -p "$SCRIPTS" "$DATA/resolve-bridge"
cp "$SRC/resolve/Cloud Pool.lua" "$SCRIPTS/Cloud Pool.lua"

ELECTRON=""
for candidate in \
  "$RESOLVE_APP/Contents/Applications/.hidden/Electron.app/Contents/MacOS/Electron" \
  "$RESOLVE_APP/Contents/Applications/Electron.app/Contents/MacOS/Electron"; do
  if [ -x "$candidate" ]; then ELECTRON="$candidate"; break; fi
done

echo
if [ -n "$ELECTRON" ]; then
  printf '{"exe":"%s","args":["%s"]}' "$(json_escape "$ELECTRON")" "$(json_escape "$APP_DIR")" > "$DATA/resolve-bridge/launch.json"
  echo "Готово: $APP_DIR"
  echo "Перезапустите DaVinci Resolve и выберите:"
  echo "  Workspace ▸ Scripts ▸ Cloud Pool"
  echo "Скрипт откроет окно Cloud Pool и подключит его к Resolve."
else
  echo "Приложение скопировано в $APP_DIR, скрипт «Cloud Pool» установлен."
  echo "Встроенный в Resolve Electron не найден, поэтому один раз запустите ./start-cloud-pool.command"
  echo "(нужен Node.js LTS: https://nodejs.org); после этого Workspace ▸ Scripts ▸ Cloud Pool будет открывать его сам."
fi
