# Launch OMP Desktop from a source checkout on Windows (PowerShell).
# Builds anything missing, then starts Electron.
#   $env:PI_DESKTOP_OMP_BIN    full path to omp.exe / omp.cmd when it is not on PATH
#   $env:PI_DESKTOP_OMP_MODEL  optional default model for new chats (provider/model)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$extra = @(
  (Join-Path $env:USERPROFILE ".bun\bin"),
  (Join-Path $env:USERPROFILE ".cargo\bin")
)
if ($env:APPDATA) { $extra += (Join-Path $env:APPDATA "npm") }
$env:Path = (($extra | Where-Object { Test-Path $_ }) + $env:Path) -join ";"
if (-not $env:PI_DESKTOP_OMP_BIN -and -not (Get-Command omp -ErrorAction SilentlyContinue)) {
  Write-Warning "'omp' not found. Install: bun install -g @oh-my-pi/pi-coding-agent"
}
$hostBin = Join-Path $root "target\debug\pi-desktop-host-core.exe"
if (-not (Test-Path $hostBin)) { Push-Location $root; cargo build -p host-core; Pop-Location }
if (-not (Test-Path (Join-Path $root "packages\agent-runtime\dist\sidecar.js"))) { Push-Location $root; pnpm build:js; Pop-Location }
if (-not (Test-Path (Join-Path $root "apps\desktop\out\main\index.js"))) { Push-Location (Join-Path $root "apps\desktop"); pnpm build; Pop-Location }
$env:PI_DESKTOP_HOST_BIN = $hostBin
$env:ELECTRON_RENDERER_URL = ""
Set-Location (Join-Path $root "apps\desktop")
& (Join-Path $root "apps\desktop\node_modules\.bin\electron.cmd") . @args
