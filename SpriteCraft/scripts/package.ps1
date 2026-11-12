# Builds SpriteCraft alone and makes its public zip and installer, without rebuilding the other Craft apps:
#   Windows\SpriteCraft\   the ready-to-run folder
#   public\SpriteCraft-<version>-windows-x64.zip
#   public\SpriteCraft-<version>-setup.exe   (per-user installer with shortcuts and an uninstaller)
$ErrorActionPreference = 'Stop'
$here = Split-Path $PSScriptRoot -Parent
$root = Split-Path $here -Parent

Push-Location $here
npm run build
if ($LASTEXITCODE -ne 0) { throw 'Web build failed' }
Pop-Location

Push-Location $root
cargo build --release -p spritecraft
if ($LASTEXITCODE -ne 0) { throw 'cargo build failed' }
Pop-Location

$conf = Get-Content (Join-Path $here 'src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json
$name = "SpriteCraft-$($conf.version)-windows-x64"
$win = Join-Path $root 'Windows\SpriteCraft'
New-Item -ItemType Directory -Force $win | Out-Null
Copy-Item (Join-Path $root 'target\release\spritecraft.exe') (Join-Path $win 'SpriteCraft.exe') -Force
Copy-Item (Join-Path $root 'packaging\SpriteCraft\README.md') $win -Force
Copy-Item (Join-Path $here 'packaging\NOTICE.md') $win -Force
Copy-Item (Join-Path $here 'LICENSE-MIT') $win -Force
Copy-Item (Join-Path $here 'LICENSE-APACHE') $win -Force
# Demo projects to open with File > Open.
$demos = Join-Path $win 'Demos'
if (Test-Path $demos) { Remove-Item -Recurse -Force $demos }
Copy-Item (Join-Path $here 'packaging\demos') $demos -Recurse -Force

$stage = Join-Path $env:TEMP "spritecraft-package\$name"
if (Test-Path (Split-Path $stage)) { Remove-Item -Recurse -Force (Split-Path $stage) }
New-Item -ItemType Directory -Force $stage | Out-Null
Copy-Item (Join-Path $win '*') $stage -Recurse -Force
$zip = Join-Path $root "public\$name.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path $stage -DestinationPath $zip -CompressionLevel Optimal
Remove-Item -Recurse -Force (Split-Path $stage)
"{0}  {1:N1} MB" -f $zip, ((Get-Item $zip).Length / 1MB)

# The installer: the same files packed into installer\payload.bin ("SCPK1", then name length, name, data length,
# data per file), built into spritecraft-setup.exe.
$payload = Join-Path $here 'installer\payload.bin'
$fs = [IO.File]::Create($payload)
$bw = New-Object IO.BinaryWriter($fs)
$bw.Write([Text.Encoding]::ASCII.GetBytes('SCPK1'))
function Add-Entry([string]$name, [byte[]]$data) {
  $nb = [Text.Encoding]::UTF8.GetBytes($name)
  $bw.Write([UInt16]$nb.Length); $bw.Write($nb); $bw.Write([UInt32]$data.Length); $bw.Write($data)
}
Add-Entry '#version' ([Text.Encoding]::UTF8.GetBytes([string]$conf.version))
Get-ChildItem $win -Recurse -File | ForEach-Object {
  Add-Entry ($_.FullName.Substring($win.Length + 1)) ([IO.File]::ReadAllBytes($_.FullName))
}
$bw.Close()
Push-Location $root
cargo build --release --offline -p spritecraft-setup
$ok = $LASTEXITCODE
Pop-Location
Remove-Item $payload -Force
if ($ok -ne 0) { throw 'installer build failed' }
$setup = Join-Path $root "public\SpriteCraft-$($conf.version)-setup.exe"
Copy-Item (Join-Path $root 'target\release\spritecraft-setup.exe') $setup -Force
"{0}  {1:N1} MB" -f $setup, ((Get-Item $setup).Length / 1MB)
