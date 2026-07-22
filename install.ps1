#Requires -Version 5.1
# install.ps1 requires Windows PowerShell 5.1 (Windows 10 default) or newer.
# Earlier versions lack `Get-FileHash -Algorithm SHA256` and the
# `Invoke-WebRequest -UseBasicParsing` semantics this script relies on.

$ErrorActionPreference = "Stop"

# SmartScreen and ExecutionPolicy notes (#477): a one-shot `irm | iex` install
# runs in the current PowerShell session. If you see a SmartScreen prompt or
# ExecutionPolicy error, run PowerShell as the current user (not Admin) and
# execute the install in a fresh session with:
#   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
# or download install.ps1 manually from the release assets and unblock it:
#   Unblock-File .\install.ps1; .\install.ps1
# See docs/guides/getting-started.md#windows-installation-notes for full guidance.

$Repo = "itlackey/akm"
$InstallDir = if ($env:AKM_INSTALL_DIR) { $env:AKM_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "akm" }

# Detect architecture. Windows ARM64 has no native binary today; the x64 binary
# runs via Windows' built-in x86_64 emulation. This is functional but slower —
# native ARM64 support is planned. Track the gap at https://github.com/itlackey/akm/issues
switch ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture) {
    "X64"   { $Binary = "akm-windows-x64.exe" }
    "Arm64" {
        $Binary = "akm-windows-x64.exe"
        Write-Warning "ARM64 detected: no native ARM64 binary yet — installing the x64 binary, which Windows will run via x86_64 emulation. Performance will be lower than a native build."
    }
    default { Write-Error "Unsupported architecture: $([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture)"; exit 1 }
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

$TempFile = Join-Path $env:TEMP "akm-download.exe"
$OutFile = Join-Path $InstallDir "akm.exe"
$ChecksumFile = Join-Path $env:TEMP "akm-checksums.txt"

Write-Host "Downloading $Binary..."
Invoke-WebRequest -Uri $DownloadUrl -OutFile $TempFile -UseBasicParsing

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
    Remove-Item $TempFile -ErrorAction SilentlyContinue
    Write-Error "Error: checksum not found for $Binary"
    exit 1
}

$ActualHash = (Get-FileHash -Path $TempFile -Algorithm SHA256).Hash.ToLower()

if ($ExpectedHash -ne $ActualHash) {
    Remove-Item $TempFile -ErrorAction SilentlyContinue
    Write-Error "Error: checksum verification failed for $Binary"
    exit 1
}

Write-Host "Checksum verified for $Binary."

Move-Item -Path $TempFile -Destination $OutFile -Force

# Add to user PATH if not already present
$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($UserPath -notlike "*$InstallDir*") {
    [Environment]::SetEnvironmentVariable("Path", "$UserPath;$InstallDir", "User")
    $env:Path = "$env:Path;$InstallDir"
    Write-Host "Added $InstallDir to your PATH (restart your shell to pick it up)."
}

Write-Host "akm installed to $OutFile"

Write-Host ""
Write-Host "To get started, run:"
Write-Host "  akm setup"
