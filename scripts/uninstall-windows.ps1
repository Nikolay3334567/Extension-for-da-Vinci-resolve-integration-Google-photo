# Removes Cloud Pool (plugin, app copy and bridge script) on Windows.
# Downloaded media and settings are kept.
$ErrorActionPreference = 'Stop'
$Dest = Join-Path $env:ProgramData 'Blackmagic Design\DaVinci Resolve\Support\Workflow Integration Plugins\com.cloudpool.googlephotos'
$AppDir = Join-Path $env:LOCALAPPDATA 'Programs\Cloud Pool'
$Script = Join-Path $env:APPDATA 'Blackmagic Design\DaVinci Resolve\Support\Fusion\Scripts\Utility\Cloud Pool.lua'
$Launch = Join-Path $env:APPDATA 'Cloud Pool for Resolve\resolve-bridge\launch.json'

if (Test-Path $Dest) {
  try { Remove-Item $Dest -Recurse -Force }
  catch {
    $psArgs = "-NoProfile -ExecutionPolicy Bypass -Command `"Remove-Item -LiteralPath '$Dest' -Recurse -Force`""
    Start-Process powershell.exe -Verb RunAs -ArgumentList $psArgs -Wait
  }
  Write-Host 'Плагин удалён.'
}
if (Test-Path $AppDir) { Remove-Item $AppDir -Recurse -Force; Write-Host 'Приложение удалено.' }
if (Test-Path $Script) { Remove-Item $Script -Force; Write-Host 'Скрипт-мост удалён.' }
if (Test-Path $Launch) { Remove-Item $Launch -Force }
Write-Host 'Скачанные файлы и настройки сохранены.'
