#!/bin/bash
# Removes the Cloud Pool Workflow Integration plugin and the bridge script (macOS).
# Your downloaded media and settings are kept (~/Movies/Cloud Pool, ~/Library/Application Support/Cloud Pool for Resolve).
set -euo pipefail

DEST="/Library/Application Support/Blackmagic Design/DaVinci Resolve/Workflow Integration Plugins/com.cloudpool.googlephotos"
SCRIPT="$HOME/Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Utility/Cloud Pool.lua"

if [ -d "$DEST" ]; then
  if [ -w "$(dirname "$DEST")" ]; then rm -rf "$DEST"; else sudo rm -rf "$DEST"; fi
  echo "Плагин удалён."
fi
rm -f "$SCRIPT" && echo "Скрипт-мост удалён (если был установлен)."
echo "Скачанные файлы и настройки сохранены."
