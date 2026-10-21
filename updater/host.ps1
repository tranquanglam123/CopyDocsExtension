# Native messaging host for CopyDocExt: answers 'ping', and on 'update'
# installs the latest GitHub release over the extension folder.
# Each message is a 4-byte little-endian length, then UTF-8 JSON. Nothing else
# may reach stdout, or Chrome drops the connection.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$LogPath = Join-Path $Here 'updater.log'
$Headers = @{ 'User-Agent' = 'CopyDocExt-updater' }

function Write-Log([string]$text) {
    try { Add-Content -LiteralPath $LogPath -Value ('{0:u} {1}' -f (Get-Date), $text) } catch { }
}

function Read-Exactly([IO.Stream]$stream, [int]$count) {
    $buffer = New-Object byte[] $count
    $read = 0
    while ($read -lt $count) {
        $n = $stream.Read($buffer, $read, $count - $read)
        if ($n -le 0) { throw 'Chrome closed the connection' }
        $read += $n
    }
    return , $buffer
}

function Read-Message {
    $stdin = [Console]::OpenStandardInput()
    $length = [BitConverter]::ToInt32((Read-Exactly $stdin 4), 0)
    return [Text.Encoding]::UTF8.GetString((Read-Exactly $stdin $length)) | ConvertFrom-Json
}

function Write-Message($reply) {
    $bytes = [Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $reply -Compress))
    $stdout = [Console]::OpenStandardOutput()
    $stdout.Write([BitConverter]::GetBytes([int32]$bytes.Length), 0, 4)
    $stdout.Write($bytes, 0, $bytes.Length)
    $stdout.Flush()
}

# /MIR makes the folder match exactly; robocopy exit codes from 8 up are failures.
function Sync-Folder([string]$from, [string]$to) {
    robocopy $from $to /MIR /R:2 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "Could not copy into $to (robocopy $LASTEXITCODE)" }
}

function Copy-Entries([string]$from, [string]$to) {
    foreach ($item in Get-ChildItem -LiteralPath $from -Force) {
        $dest = Join-Path $to $item.Name
        if ($item.PSIsContainer) { Sync-Folder $item.FullName $dest }
        else { Copy-Item -LiteralPath $item.FullName -Destination $dest -Force }
    }
}

function Install-Latest($config) {
    $extensionDir = $config.extensionDir
    # A developer's checkout is updated with git; a release mirrored over it would discard work.
    if (Test-Path -LiteralPath (Join-Path $extensionDir '.git')) {
        throw 'This copy is a git checkout - update it with git pull.'
    }

    try {
        $release = Invoke-RestMethod -UseBasicParsing -Headers $Headers -TimeoutSec 60 `
            -Uri "https://api.github.com/repos/$($config.repo)/releases/latest"
    } catch {
        throw "No release found on GitHub ($($_.Exception.Message))"
    }
    $asset = @($release.assets | Where-Object { $_.name -eq $config.asset })[0]
    if (-not $asset) { throw "Release $($release.tag_name) has no $($config.asset)" }
    $url = [string]$asset.browser_download_url
    if (-not $url.StartsWith("https://github.com/$($config.repo)/")) { throw "Unexpected download address: $url" }

    $work = Join-Path ([IO.Path]::GetTempPath()) ('copydocext-' + [guid]::NewGuid().ToString('N'))
    $staged = Join-Path $work 'new'
    $backup = Join-Path $work 'old'
    New-Item -ItemType Directory -Path $backup | Out-Null
    try {
        $zip = Join-Path $work $config.asset
        Invoke-WebRequest -UseBasicParsing -Headers $Headers -TimeoutSec 300 -Uri $url -OutFile $zip
        Expand-Archive -LiteralPath $zip -DestinationPath $staged
        $manifest = [IO.File]::ReadAllText((Join-Path $staged 'manifest.json')) | ConvertFrom-Json
        if ($manifest.name -ne 'CopyDocExt') { throw 'The downloaded release is not CopyDocExt' }

        # What the release replaces is kept first, so a failed copy can be put back.
        foreach ($item in Get-ChildItem -LiteralPath $staged -Force) {
            $current = Join-Path $extensionDir $item.Name
            if (-not (Test-Path -LiteralPath $current)) { continue }
            if ($item.PSIsContainer) { Sync-Folder $current (Join-Path $backup $item.Name) }
            else { Copy-Item -LiteralPath $current -Destination $backup -Force }
        }
        try {
            Copy-Entries $staged $extensionDir
        } catch {
            Write-Log "copy failed, restoring: $($_.Exception.Message)"
            Copy-Entries $backup $extensionDir
            throw
        }

        # A newer host script runs from the next call; host.bat stays as it is.
        $newHost = Join-Path $staged 'updater\host.ps1'
        if (Test-Path -LiteralPath $newHost) {
            Copy-Item -LiteralPath $newHost -Destination (Join-Path $Here 'host.ps1') -Force
        }
        return @{ ok = $true; version = [string]$manifest.version }
    } finally {
        Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    }
}

try {
    $message = Read-Message
    $config = [IO.File]::ReadAllText((Join-Path $Here 'config.json')) | ConvertFrom-Json
    switch ($message.cmd) {
        'ping' { $reply = @{ ok = $true } }
        'update' {
            Write-Log 'update started'
            $reply = Install-Latest $config
            Write-Log "installed $($reply.version)"
        }
        default { $reply = @{ ok = $false; error = "Unknown command: $($message.cmd)" } }
    }
} catch {
    Write-Log "error: $($_.Exception.Message)"
    $reply = @{ ok = $false; error = $_.Exception.Message }
}

try { Write-Message $reply } catch { Write-Log "reply failed: $($_.Exception.Message)" }
