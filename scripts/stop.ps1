#Requires -Version 5.1
param(
    [string]$Python = 'python',
    [ValidateRange(1, 600)][int]$Timeout = 60
)
$ErrorActionPreference = 'Stop'
$env:PYTHONIOENCODING = 'utf-8'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$launcher = Join-Path (Split-Path -Parent $PSScriptRoot) 'run.py'
& $Python $launcher stop --timeout $Timeout
exit $LASTEXITCODE
