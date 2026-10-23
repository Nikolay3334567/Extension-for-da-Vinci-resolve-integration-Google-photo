# Removes the Cloud Pool Workflow Integration plugin and the bridge script (Windows).
# Downloaded media and settings are kept.
$ErrorActionPreference = 'Stop'
$Dest = Join-Path $env:ProgramData 'Blackmagic Design\DaVinci Resolve\Support\Workflow Integration Plugins\com.cloudpool.googlephotos'
$Script = Join-Path $env:APPDATA 'Blackmagic Design\DaVinci Resolve\Support\Fusion\Scripts\Utility\Cloud Pool.lua'

if (Test-Path $Dest) {
  try { Remove-Item $Dest -Recurse -Force }
  catch {
    $psArgs = "-NoProfile -ExecutionPolicy Bypass -Command `"Remove-Item -LiteralPath '$Dest' -Recurse -Force`""
    Start-Process powershell.exe -Verb RunAs -ArgumentList $psArgs -Wait
  }
  Write-Host 'Плагин удалён.'
}
if (Test-Path $Script) { Remove-Item $Script -Force; Write-Host 'Скрипт-мост удалён.' }
Write-Host 'Скачанные файлы и настройки сохранены.'
