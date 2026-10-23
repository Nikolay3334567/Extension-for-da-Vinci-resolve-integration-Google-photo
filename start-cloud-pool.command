#!/bin/bash
# Starts Cloud Pool as a standalone app (any Resolve edition, macOS/Linux). Requires Node.js.
cd "$(dirname "$0")"
command -v npm >/dev/null || { echo "Node.js is required: https://nodejs.org"; exit 1; }
[ -d node_modules/electron ] || npm install --no-audit --no-fund
exec npx electron plugin
