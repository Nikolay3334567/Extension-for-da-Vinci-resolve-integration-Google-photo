# Installs Cloud Pool for DaVinci Resolve on Windows.
#  • Resolve Studio: as a Workflow Integration plugin (Workspace > Workflow Integrations > Cloud Pool).
#  • Free edition: as an app started from Workspace > Scripts > Cloud Pool, using the Electron
#    runtime that ships with Resolve (no Node.js needed when it is present).
# Run "Install Cloud Pool (Windows).cmd" or:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-windows.ps1
param([switch]$Standalone)
$ErrorActionPreference = 'Stop'

$Repo = Split-Path -Parent $PSScriptRoot
$Src = Join-Path $Repo 'plugin'
$Support = Join-Path $env:ProgramData 'Blackmagic Design\DaVinci Resolve\Support'
$Dest = Join-Path $Support 'Workflow Integration Plugins\com.cloudpool.googlephotos'
$NodeSrc = Join-Path $Support 'Developer\Workflow Integrations\Examples\SamplePlugin\WorkflowIntegration.node'
$ResolveElectron = Join-Path $env:ProgramFiles 'Blackmagic Design\DaVinci Resolve\Electron\electron.exe'
$Client = Get-ChildItem -Path $Repo -Filter 'client_secret*.json' -ErrorAction SilentlyContinue | Select-Object -First 1

Write-Host 'Cloud Pool — установка для DaVinci Resolve' -ForegroundColor Cyan
Write-Host ''

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  return (New-Object Security.Principal.WindowsPrincipal $id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Copy-Plugin($Target) {
  New-Item -ItemType Directory -Force -Path $Target | Out-Null
  robocopy $Src $Target /MIR /XF WorkflowIntegration.node credentials.json /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "Копирование не удалось (robocopy $LASTEXITCODE)" }
  if ($Client -and -not (Test-Path (Join-Path $Target 'credentials.json'))) {
    Copy-Item $Client.FullName (Join-Path $Target 'credentials.json')
    Write-Host "OAuth-клиент Google скопирован из $($Client.Name)."
  }
}

function Install-BridgeScript {
  $scripts = Join-Path $env:APPDATA 'Blackmagic Design\DaVinci Resolve\Support\Fusion\Scripts\Utility'
  New-Item -ItemType Directory -Force -Path $scripts | Out-Null
  Copy-Item (Join-Path $Src 'resolve\Cloud Pool.lua') (Join-Path $scripts 'Cloud Pool.lua') -Force
}

function Get-ShortPath($Path) {
  try { return (New-Object -ComObject Scripting.FileSystemObject).GetFolder($Path).ShortPath } catch { return $Path }
}

if ((Test-Path $NodeSrc) -and -not $Standalone) {
  # ── Resolve Studio: Workflow Integration plugin ────────────────────────────────
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
  $running = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path -like '*DaVinci Resolve*Electron*' }
  if ($running) { Write-Host 'Закройте окно Cloud Pool в Resolve перед обновлением (файлы плагина заняты).' -ForegroundColor Yellow }
  Copy-Plugin $Dest
  Copy-Item $NodeSrc (Join-Path $Dest 'WorkflowIntegration.node') -Force
  Write-Host ''
  Write-Host "Готово: $Dest" -ForegroundColor Green
  Write-Host 'Перезапустите DaVinci Resolve Studio и откройте:'
  Write-Host '  Workspace > Workflow Integrations > Cloud Pool (Google Photos)'
  exit 0
}

# ── Free edition (or -Standalone): app + bridge script ────────────────────────────
$AppDir = Join-Path $env:LOCALAPPDATA 'Programs\Cloud Pool'
Copy-Plugin $AppDir
Install-BridgeScript
$Mailbox = Join-Path $env:APPDATA 'Cloud Pool for Resolve\resolve-bridge'
New-Item -ItemType Directory -Force -Path $Mailbox | Out-Null

Write-Host ''
if (Test-Path $ResolveElectron) {
  # Lua uses the ANSI code page, so hand it ASCII-only (8.3) paths.
  $launch = @{ exe = $ResolveElectron; args = @((Get-ShortPath $AppDir)) } | ConvertTo-Json -Compress
  [IO.File]::WriteAllText((Join-Path $Mailbox 'launch.json'), $launch, (New-Object Text.UTF8Encoding $false))
  Write-Host "Готово: $AppDir" -ForegroundColor Green
  Write-Host 'Перезапустите DaVinci Resolve и выберите:'
  Write-Host '  Workspace > Scripts > Cloud Pool'
  Write-Host 'Скрипт откроет окно Cloud Pool и подключит его к Resolve.'
} else {
  Write-Host "Приложение скопировано в $AppDir, скрипт «Cloud Pool» установлен." -ForegroundColor Green
  Write-Host 'Встроенный в Resolve Electron не найден, поэтому запустите Cloud Pool один раз через'
  Write-Host '  «Start Cloud Pool (Windows).cmd» (нужен Node.js LTS: https://nodejs.org),'
  Write-Host 'после этого пункт Workspace > Scripts > Cloud Pool будет открывать его сам.'
}
