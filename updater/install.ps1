# Registers the CopyDocExt updater with Chrome and Edge for this Windows user.
# Run through install.bat; uninstall.bat passes -Uninstall.
param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'

# Must match UPDATE in src/lib/const.js.
$HostName = 'com.copydocext.updater'
$Repo = 'tranquanglam123/CopyDocsExtension'
$Asset = 'CopyDocExt.zip'

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$ExtensionDir = Split-Path -Parent $Here
# Outside the extension folder: an update rewrites that folder, and cmd reads
# a running .bat file as it goes.
$Target = Join-Path $env:LOCALAPPDATA 'CopyDocExt\updater'
$RegistryKeys = @(
    "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName",
    "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName"
)
# Chrome reads the host manifest as UTF-8 and rejects a byte-order mark.
$Utf8 = New-Object System.Text.UTF8Encoding $false

if ($Uninstall) {
    foreach ($key in $RegistryKeys) {
        if (Test-Path $key) { Remove-Item $key -Recurse -Force }
    }
    if (Test-Path -LiteralPath $Target) { Remove-Item -LiteralPath $Target -Recurse -Force }
    Write-Host 'CopyDocExt updater removed. / Da go bo trinh cap nhat.'
    return
}

$manifest = [IO.File]::ReadAllText((Join-Path $ExtensionDir 'manifest.json')) | ConvertFrom-Json
if (-not $manifest.key) { throw 'manifest.json has no "key", so the extension ID would differ on every PC.' }

# An unpacked extension's ID: SHA-256 of its key, first 16 bytes, each hex
# digit spelled a-p. The host answers that ID only.
$hash = [Security.Cryptography.SHA256]::Create().ComputeHash([Convert]::FromBase64String($manifest.key))
$id = -join ($hash[0..15] | ForEach-Object { [char](97 + ($_ -shr 4)); [char](97 + ($_ -band 15)) })

New-Item -ItemType Directory -Force -Path $Target | Out-Null
foreach ($file in 'host.bat', 'host.ps1') {
    Copy-Item -LiteralPath (Join-Path $Here $file) -Destination $Target -Force
}
Get-ChildItem -LiteralPath $Target | Unblock-File

$config = [ordered]@{ extensionDir = $ExtensionDir; repo = $Repo; asset = $Asset }
[IO.File]::WriteAllText((Join-Path $Target 'config.json'), (ConvertTo-Json $config), $Utf8)

$hostManifest = [ordered]@{
    name = $HostName
    description = 'Installs CopyDocExt updates from GitHub Releases'
    path = (Join-Path $Target 'host.bat')
    type = 'stdio'
    allowed_origins = @("chrome-extension://$id/")
}
$hostManifestPath = Join-Path $Target "$HostName.json"
[IO.File]::WriteAllText($hostManifestPath, (ConvertTo-Json $hostManifest), $Utf8)

foreach ($key in $RegistryKeys) {
    New-Item -Path $key -Force -Value $hostManifestPath | Out-Null
}

Write-Host ''
Write-Host "Extension folder: $ExtensionDir"
Write-Host "Extension ID:     $id"
Write-Host ''
Write-Host 'Done. Updates now install from the extension popup with one click.'
Write-Host 'Xong. Tu nay bam "Cap nhat" trong tien ich la duoc.'
