#Requires -Version 5.1
param(
    [string]$Python = 'python',
    [switch]$Test,
    [switch]$Recreate,
    [switch]$NoInit
)
$ErrorActionPreference = 'Stop'
$env:PYTHONIOENCODING = 'utf-8'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$launcher = Join-Path (Split-Path -Parent $PSScriptRoot) 'run.py'
$launcherArguments = @($launcher, 'setup')
if ($Test) { $launcherArguments += '--test' }
if ($Recreate) { $launcherArguments += '--recreate' }
if ($NoInit) { $launcherArguments += '--no-init' }
& $Python @launcherArguments
exit $LASTEXITCODE
