<#
.SYNOPSIS
  Install Smart Mess System and its toolchain on Windows 10/11.

.DESCRIPTION
  Installs (only if missing): Node.js 22 LTS, pnpm, Git, Supabase CLI (via Scoop),
  Docker Desktop. Then runs `pnpm install`, creates .env and type-checks the workspace.
  Safe to re-run: every step checks before it changes anything.

  Easiest way to run it: double-click scripts\install-windows.cmd, or from a terminal:
    powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1 [-LocalDb] [-SkipDocker] [-Start]

.PARAMETER LocalDb
  Also start a local Supabase stack, apply all migrations, run the database tests and
  write the local URL and keys into .env. Needs Docker Desktop running.

.PARAMETER SkipDocker
  Don't install Docker Desktop (use this when you only connect to a cloud Supabase project).

.PARAMETER Start
  Start the web app when installation finishes.
#>
param(
  [switch]$LocalDb,
  [switch]$SkipDocker,
  [switch]$Start
)

$ErrorActionPreference = 'Stop'
$RootDir = Split-Path -Parent $PSScriptRoot
Set-Location $RootDir

function Info($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Ok($msg) { Write-Host $msg -ForegroundColor Green }
function Fail($msg) { Write-Host $msg -ForegroundColor Red; exit 1 }
function Have($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

# Pick up PATH changes made by installers in this same session.
function Refresh-Path {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machine;$user"
}

# Run a native command and stop if it fails (PowerShell 5 does not do this on its own).
function Run($exe, [string[]]$argList) {
  & $exe @argList
  if ($LASTEXITCODE -ne 0) { Fail "Command failed: $exe $($argList -join ' ')" }
}

function Winget-Install($id, $name) {
  if (-not (Have 'winget')) {
    Fail "winget is not available. Install '$name' manually, or install 'App Installer' from the Microsoft Store, then re-run."
  }
  Info "Installing $name"
  winget install --id $id --exact --silent --accept-package-agreements --accept-source-agreements
  Refresh-Path
}

# 1. Git (Scoop needs it, and `pnpm db:migrate` runs through Git Bash)
if (-not (Have 'git')) { Winget-Install 'Git.Git' 'Git' } else { Info 'Git found' }

# 2. Node.js >= 20
$nodeOk = $false
if (Have 'node') {
  $major = [int]((node -p "process.versions.node.split('.')[0]") 2>$null)
  $nodeOk = $major -ge 20
}
if (-not $nodeOk) { Winget-Install 'OpenJS.NodeJS.LTS' 'Node.js LTS' } else { Info "Node.js $(node -v) found" }
if (-not (Have 'node')) { Fail 'Node.js is installed but not on PATH yet. Open a new terminal and re-run this script.' }

# 3. pnpm
if (-not (Have 'pnpm')) {
  Info 'Installing pnpm'
  Run 'npm' @('install', '-g', 'pnpm')
  Refresh-Path
} else {
  Info "pnpm $(pnpm -v) found"
}

# 4. Supabase CLI (official Windows channel is Scoop)
if (-not (Have 'supabase')) {
  if (-not (Have 'scoop')) {
    Info 'Installing Scoop (user-level package manager)'
    Invoke-RestMethod -Uri 'https://get.scoop.sh' | Invoke-Expression
    Refresh-Path
    $env:Path = "$env:USERPROFILE\scoop\shims;$env:Path"
  }
  Info 'Installing Supabase CLI'
  Run 'scoop' @('bucket', 'add', 'supabase', 'https://github.com/supabase/scoop-bucket.git')
  Run 'scoop' @('install', 'supabase')
} else {
  Info "Supabase CLI $(supabase --version) found"
}

# 5. Docker Desktop (needed only for a local Supabase stack)
if (-not $SkipDocker) {
  if (-not (Have 'docker')) {
    Winget-Install 'Docker.DockerDesktop' 'Docker Desktop'
    Write-Host 'Start Docker Desktop once to finish its setup (it may ask to enable WSL 2), then re-run with -LocalDb.'
  } else {
    Info 'Docker found'
  }
}

# 6. JavaScript dependencies
Info 'Installing project dependencies (pnpm install)'
Run 'pnpm' @('install')

# 7. Environment file
if (-not (Test-Path '.env')) {
  Info 'Creating .env from .env.example'
  Copy-Item '.env.example' '.env'
} else {
  Info '.env already exists, leaving it as is'
}

function Set-EnvValue($key, $value) {
  $lines = @(Get-Content '.env')
  $found = $false
  $lines = $lines | ForEach-Object {
    if ($_ -match "^$key=") { $found = $true; "$key=$value" } else { $_ }
  }
  if (-not $found) { $lines += "$key=$value" }
  Set-Content -Path '.env' -Value $lines -Encoding UTF8
}

# 8. Optional local database
if ($LocalDb) {
  docker info *> $null
  if ($LASTEXITCODE -ne 0) { Fail 'Docker is not running. Start Docker Desktop, then re-run with -LocalDb.' }

  supabase status *> $null
  if ($LASTEXITCODE -ne 0) {
    Info 'Starting local Supabase stack'
    Run 'supabase' @('start')
  }
  Info 'Resetting local database and applying all migrations'
  Run 'supabase' @('db', 'reset', '--local')
  Info 'Running pgTAP database tests'
  Run 'supabase' @('test', 'db')

  Info 'Writing local Supabase URL and keys to .env'
  $status = supabase status -o env 2>$null
  foreach ($line in $status) {
    if ($line -match '^(API_URL|ANON_KEY|SERVICE_ROLE_KEY)="?([^"]*)"?$') {
      switch ($Matches[1]) {
        'API_URL' { Set-EnvValue 'EXPO_PUBLIC_SUPABASE_URL' $Matches[2] }
        'ANON_KEY' { Set-EnvValue 'EXPO_PUBLIC_SUPABASE_KEY' $Matches[2] }
        'SERVICE_ROLE_KEY' { Set-EnvValue 'SUPABASE_SERVICE_ROLE_KEY' $Matches[2] }
      }
    }
  }
}

# 9. Sanity check
Info 'Type-checking the workspace'
Run 'pnpm' @('typecheck')

Ok 'Smart Mess System is installed.'
Write-Host ''
Write-Host 'Next steps:'
if (-not $LocalDb) {
  Write-Host '  - Fill in EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_KEY in .env'
  Write-Host '    (or re-run with -LocalDb to use a local Supabase stack).'
}
Write-Host '  - Create the first Administrator: see "First Administrator" in README.md.'
Write-Host '  - Start the app: pnpm web'
Write-Host ''

if ($Start) { Run 'pnpm' @('web') }
