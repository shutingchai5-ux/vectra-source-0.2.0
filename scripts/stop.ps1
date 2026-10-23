#Requires -Version 5.1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $root
try { & bun run stop; exit $LASTEXITCODE } finally { Pop-Location }
