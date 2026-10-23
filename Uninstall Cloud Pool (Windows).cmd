@echo off
setlocal
title Cloud Pool - uninstall
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\uninstall-windows.ps1"
echo.
pause
