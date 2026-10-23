@echo off
setlocal
title Cloud Pool
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  where npm >nul 2>nul || (echo Node.js LTS is required: https://nodejs.org & pause & exit /b 1)
  echo Installing Electron, one time...
  call npm install --no-audit --no-fund || (pause & exit /b 1)
)
start "" "node_modules\electron\dist\electron.exe" plugin
