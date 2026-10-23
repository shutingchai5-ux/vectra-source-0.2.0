#Requires -Version 5.1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $root
try {
    & bun install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & bun run build
    exit $LASTEXITCODE
} finally { Pop-Location }
