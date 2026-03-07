$ErrorActionPreference = "Stop"

$Repo = "itlackey/agentikit"
$InstallDir = if ($env:AGENTIKIT_INSTALL_DIR) { $env:AGENTIKIT_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "agentikit" }

# Detect architecture
$Arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
switch ($Arch) {
    "X64"   { $Binary = "agentikit-windows-x64.exe" }
    "Arm64" { $Binary = "agentikit-windows-x64.exe"; Write-Warning "ARM64 detected; downloading x64 binary (runs via emulation)" }
    default { Write-Error "Unsupported architecture: $Arch"; exit 1 }
}

$Tag = if ($args.Count -gt 0) { $args[0] } else { "latest" }

if ($Tag -eq "latest") {
    $DownloadUrl = "https://github.com/$Repo/releases/latest/download/$Binary"
    $ChecksumUrl = "https://github.com/$Repo/releases/latest/download/checksums.txt"
} else {
    $DownloadUrl = "https://github.com/$Repo/releases/download/$Tag/$Binary"
    $ChecksumUrl = "https://github.com/$Repo/releases/download/$Tag/checksums.txt"
}

if (!(Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}

$OutFile = Join-Path $InstallDir "agentikit.exe"
$ChecksumFile = Join-Path $env:TEMP "agentikit-checksums.txt"

Write-Host "Downloading $Binary..."
Invoke-WebRequest -Uri $DownloadUrl -OutFile $OutFile -UseBasicParsing

Write-Host "Downloading checksums..."
Invoke-WebRequest -Uri $ChecksumUrl -OutFile $ChecksumFile -UseBasicParsing

$ExpectedHash = $null
foreach ($line in (Get-Content $ChecksumFile)) {
    if ($line -match "^(\S+)\s+$([regex]::Escape($Binary))$") {
        $ExpectedHash = $Matches[1]
        break
    }
}

Remove-Item $ChecksumFile -ErrorAction SilentlyContinue

if (-not $ExpectedHash) {
    Remove-Item $OutFile -ErrorAction SilentlyContinue
    Write-Error "Error: checksum not found for $Binary"
    exit 1
}

$ActualHash = (Get-FileHash -Path $OutFile -Algorithm SHA256).Hash.ToLower()

if ($ExpectedHash -ne $ActualHash) {
    Remove-Item $OutFile -ErrorAction SilentlyContinue
    Write-Error "Error: checksum verification failed for $Binary"
    exit 1
}

Write-Host "Checksum verified for $Binary."

# Add to user PATH if not already present
$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($UserPath -notlike "*$InstallDir*") {
    [Environment]::SetEnvironmentVariable("Path", "$UserPath;$InstallDir", "User")
    $env:Path = "$env:Path;$InstallDir"
    Write-Host "Added $InstallDir to your PATH (restart your shell to pick it up)."
}

Write-Host "agentikit installed to $OutFile"

Write-Host "Running agentikit init..."
& $OutFile init
