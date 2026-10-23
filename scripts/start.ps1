#Requires -Version 5.1
param([ValidateRange(1024,65535)][int]$Port, [switch]$Dev)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $root
try {
    if ($PSBoundParameters.ContainsKey('Port')) { $env:VECTRA_PORT = [string]$Port }
    if ($Dev) { & bun run dev } else { & bun run start }
    exit $LASTEXITCODE
} finally { Pop-Location }
