#!/bin/bash
# Installs Cloud Pool as a DaVinci Resolve Studio Workflow Integration plugin (macOS).
# Usage: bash scripts/install-macos.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$HERE/plugin"
SUPPORT="/Library/Application Support/Blackmagic Design/DaVinci Resolve"
DEST="$SUPPORT/Workflow Integration Plugins/com.cloudpool.googlephotos"
NODE_SRC="$SUPPORT/Developer/Workflow Integrations/Examples/SamplePlugin/WorkflowIntegration.node"

echo "Cloud Pool — установка плагина для DaVinci Resolve Studio"
echo

if [ ! -f "$NODE_SRC" ]; then
  echo "Не найден WorkflowIntegration.node:"
  echo "  $NODE_SRC"
  echo "Он устанавливается вместе с DaVinci Resolve Studio (Workflow Integrations есть только в Studio)."
  echo "Для бесплатной версии используйте отдельное приложение: см. README, раздел «Бесплатная версия Resolve»."
  exit 1
fi

SUDO=""
if ! mkdir -p "$DEST" 2>/dev/null || [ ! -w "$DEST" ]; then
  echo "Нужны права администратора для записи в /Library/Application Support…"
  SUDO="sudo"
fi

$SUDO mkdir -p "$DEST"
$SUDO rsync -a --delete \
  --exclude 'WorkflowIntegration.node' --exclude 'credentials.json' --exclude '.DS_Store' \
  "$SRC/" "$DEST/"
$SUDO cp "$NODE_SRC" "$DEST/WorkflowIntegration.node"

# A client_secret*.json placed next to this repo is picked up automatically on first start.
CLIENT_JSON="$(ls "$HERE"/client_secret*.json 2>/dev/null | head -n 1 || true)"
if [ -n "$CLIENT_JSON" ] && [ ! -f "$DEST/credentials.json" ]; then
  $SUDO cp "$CLIENT_JSON" "$DEST/credentials.json"
  echo "OAuth-клиент Google скопирован из $(basename "$CLIENT_JSON")."
fi

$SUDO xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true

echo
echo "Готово: $DEST"
echo "Перезапустите DaVinci Resolve Studio и откройте:"
echo "  Workspace ▸ Workflow Integrations ▸ Cloud Pool (Google Photos)"
