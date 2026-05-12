#requires -Version 5.1
<#
.SYNOPSIS
  Install or update Mira CLI from GitHub: dependencies, Chromium (Playwright), build, and PATH shims.

.NOTES
  Review this script before running: irm ... | iex
  Default install: %LOCALAPPDATA%\mira-cli  and shims in  %LOCALAPPDATA%\mira-cli\bin

.EXAMPLE
  irm https://raw.githubusercontent.com/KiwiGeek/mira-cli/master/scripts/install.ps1 | iex
#>
param(
  [string] $RepoUrl = $env:MIRA_INSTALL_REPO,
  [string] $Branch = $env:MIRA_INSTALL_BRANCH,
  [string] $InstallDir = $env:MIRA_INSTALL_DIR
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-Step([string] $Message) {
  Write-Host "▸ " -ForegroundColor Cyan -NoNewline
  Write-Host $Message
}

function Add-UserPath([string] $Directory) {
  $Directory = [System.IO.Path]::GetFullPath($Directory)
  $key = "Path"
  $scope = "User"
  $current = [Environment]::GetEnvironmentVariable($key, $scope)
  if (-not $current) { $current = "" }
  $parts = $current -split ";" | Where-Object { $_ -and $_.Trim().Length -gt 0 }
  foreach ($p in $parts) {
    if ([System.IO.Path]::GetFullPath($p) -eq $Directory) {
      Write-Step "PATH already contains: $Directory"
      return
    }
  }
  $updated = ($current.TrimEnd(";") + ";" + $Directory).Trim(";")
  [Environment]::SetEnvironmentVariable($key, $updated, $scope)
  Write-Step "Added to user PATH: $Directory"
  Write-Host "  Open a new terminal (or refresh PATH) before running mira / mira-cli." -ForegroundColor Yellow
}

function Test-NodeVersionOk {
  try {
    $raw = (& node -v 2>$null).Trim()
    if (-not $raw) { return $false }
    if ($raw -match "^v(\d+)") { return [int]$Matches[1] -ge 20 }
  } catch { return $false }
  return $false
}

function Ensure-Node {
  if (Test-NodeVersionOk) {
    Write-Step ("Using Node " + (node -v).Trim())
    return
  }
  Write-Step "Node.js 20+ not found (or too old)."
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Step "Installing Node.js LTS via winget (you may need to approve prompts)..."
    winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
    $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $user = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$machine;$user"
    if (-not (Test-NodeVersionOk)) {
      throw "Node.js is still not on PATH. Close this window, open a new PowerShell, and re-run the installer."
    }
  } else {
    throw "Install Node.js 20+ from https://nodejs.org/ and re-run this script (winget not available)."
  }
}

function Ensure-Git {
  if (Get-Command git -ErrorAction SilentlyContinue) {
    Write-Step ("Using Git " + (git --version))
    return
  }
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Step "Installing Git via winget..."
    winget install Git.Git --accept-package-agreements --accept-source-agreements
    $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $user = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$machine;$user"
  }
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw "Git is required. Install from https://git-scm.com/ and re-run."
  }
}

if (-not $RepoUrl) { $RepoUrl = "https://github.com/KiwiGeek/mira-cli.git" }
if (-not $Branch) { $Branch = "master" }
if (-not $InstallDir) { $InstallDir = Join-Path $env:LOCALAPPDATA "mira-cli" }

$InstallDir = [System.IO.Path]::GetFullPath($InstallDir)
$BinDir = Join-Path $InstallDir "bin"

Write-Host ""
Write-Host "Mira CLI installer" -ForegroundColor Green
Write-Host "  Repo:    $RepoUrl"
Write-Host "  Branch:  $Branch"
Write-Host "  Install: $InstallDir"
Write-Host ""

Ensure-Git
Ensure-Node

if (Test-Path (Join-Path $InstallDir ".git")) {
  Write-Step "Updating existing clone..."
  Push-Location $InstallDir
  try {
    git fetch origin --prune
    git checkout $Branch
    git pull origin $Branch
  } finally {
    Pop-Location
  }
} elseif (Test-Path $InstallDir) {
  throw "Directory exists but is not a git repo: $InstallDir`nRemove it or set MIRA_INSTALL_DIR to a different path."
} else {
  Write-Step "Cloning repository..."
  New-Item -ItemType Directory -Path (Split-Path -Parent $InstallDir) -Force | Out-Null
  git clone --depth 1 --branch $Branch $RepoUrl $InstallDir
  if ($LASTEXITCODE -ne 0) {
    throw "git clone failed. Check the branch name (try main vs master) or network."
  }
}

Push-Location $InstallDir
try {
  Write-Step "npm install..."
  npm install
  Write-Step "npm run build..."
  npm run build
  Write-Step "Playwright Chromium download (one-time, can take a minute)..."
  npx --yes playwright install chromium
} finally {
  Pop-Location
}

Write-Step "Creating command shims in $BinDir..."
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null

$shimMira = Join-Path $BinDir "mira.cmd"
$shimMiraCli = Join-Path $BinDir "mira-cli.cmd"
@"
@echo off
setlocal
pushd "%~dp0.."
node "dist\cli.js" %*
set ERR=%ERRORLEVEL%
popd
exit /b %ERR%
"@ | Set-Content -Path $shimMira -Encoding ascii

$shimMiraCliBody = (Get-Content -Path $shimMira -Raw)
Set-Content -Path $shimMiraCli -Value $shimMiraCliBody -Encoding ascii

Write-Step "Playwright uses its own browser under your profile; no extra PATH entry needed for that."

Add-UserPath $BinDir

Write-Host ""
Write-Host "Done. Next:" -ForegroundColor Green
Write-Host "  1. Open a new terminal."
Write-Host "  2. Run:  mira login   (first-time ChatGPT browser login)"
Write-Host "  3. Run:  mira         (or mira-cli)"
Write-Host ""
