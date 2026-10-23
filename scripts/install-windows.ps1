# Installs Cloud Pool as a DaVinci Resolve Studio Workflow Integration plugin (Windows).
# Run "Install Cloud Pool (Windows).cmd" or:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-windows.ps1
$ErrorActionPreference = 'Stop'

$Repo = Split-Path -Parent $PSScriptRoot
$Src = Join-Path $Repo 'plugin'
$Support = Join-Path $env:ProgramData 'Blackmagic Design\DaVinci Resolve\Support'
$DestRoot = Join-Path $Support 'Workflow Integration Plugins'
$Dest = Join-Path $DestRoot 'com.cloudpool.googlephotos'
$NodeSrc = Join-Path $Support 'Developer\Workflow Integrations\Examples\SamplePlugin\WorkflowIntegration.node'

Write-Host 'Cloud Pool — установка плагина для DaVinci Resolve Studio' -ForegroundColor Cyan
Write-Host ''

if (-not (Test-Path $NodeSrc)) {
  Write-Host "Не найден WorkflowIntegration.node:`n  $NodeSrc" -ForegroundColor Yellow
  Write-Host 'Он устанавливается вместе с DaVinci Resolve Studio (Workflow Integrations есть только в Studio).'
  Write-Host 'Для бесплатной версии используйте отдельное приложение: см. README, раздел «Бесплатная версия Resolve».'
  exit 1
}

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  return (New-Object Security.Principal.WindowsPrincipal $id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# ProgramData\Blackmagic Design is usually writable only by administrators.
$canWrite = $true
try {
  New-Item -ItemType Directory -Force -Path $Dest | Out-Null
  $probe = Join-Path $Dest '.write-test'
  Set-Content -Path $probe -Value 'ok'
  Remove-Item $probe -Force
} catch { $canWrite = $false }

if (-not $canWrite) {
  if (Test-Admin) { throw "Нет доступа к $Dest" }
  Write-Host 'Нужны права администратора — подтвердите запрос Windows…'
  $psArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
  $p = Start-Process powershell.exe -Verb RunAs -ArgumentList $psArgs -Wait -PassThru
  exit $p.ExitCode
}

$running = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path -like "*DaVinci Resolve*Electron*" }
if ($running) {
  Write-Host 'Закройте окно Cloud Pool в Resolve перед обновлением (файлы плагина заняты).' -ForegroundColor Yellow
}

# Mirror the plugin folder (keeping the native module and any bundled OAuth client).
robocopy $Src $Dest /MIR /XF WorkflowIntegration.node credentials.json /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "Копирование не удалось (robocopy $LASTEXITCODE)" }
Copy-Item $NodeSrc (Join-Path $Dest 'WorkflowIntegration.node') -Force

# A client_secret*.json placed in the repository folder is picked up automatically on first start.
$client = Get-ChildItem -Path $Repo -Filter 'client_secret*.json' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($client -and -not (Test-Path (Join-Path $Dest 'credentials.json'))) {
  Copy-Item $client.FullName (Join-Path $Dest 'credentials.json')
  Write-Host "OAuth-клиент Google скопирован из $($client.Name)."
}

Write-Host ''
Write-Host "Готово: $Dest" -ForegroundColor Green
Write-Host 'Перезапустите DaVinci Resolve Studio и откройте:'
Write-Host '  Workspace > Workflow Integrations > Cloud Pool (Google Photos)'
