# Builds SpriteCraft from this repository and writes:
#   Windows\SpriteCraft\   the ready-to-run folder
#   public\SpriteCraft-<version>-windows-x64.zip
# Needs Node.js 20+ and Rust (stable). Usage: powershell -ExecutionPolicy Bypass -File build.ps1
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
Set-Location $root

# SpriteCraft's own script builds the interface and program, then writes the zip and its setup
# (public\SpriteCraft-<version>-setup.exe, from the installer\ crate).
Push-Location (Join-Path $root 'SpriteCraft')
try { if (-not (Test-Path 'node_modules')) { npm ci; if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' } } } finally { Pop-Location }
& (Join-Path $root 'SpriteCraft\scripts\package.ps1')
