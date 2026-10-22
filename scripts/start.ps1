#Requires -Version 5.1
param(
    [string]$Python = 'python',
    [ValidateRange(1, 65535)][int]$Port
)
$ErrorActionPreference = 'Stop'
$env:PYTHONIOENCODING = 'utf-8'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$launcher = Join-Path (Split-Path -Parent $PSScriptRoot) 'run.py'
$launcherArguments = @($launcher, 'start')
if ($PSBoundParameters.ContainsKey('Port')) { $launcherArguments += @('--port', "$Port") }
& $Python @launcherArguments
exit $LASTEXITCODE
