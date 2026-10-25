param([string]$Python = 'python')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
if (-not (Test-Path -LiteralPath '.venv\Scripts\python.exe')) {
    & $Python -m venv .venv
    if ($LASTEXITCODE -ne 0) { throw 'Не удалось создать Python venv.' }
}
& '.\.venv\Scripts\python.exe' -m pip install -r backend/requirements.lock.txt
if ($LASTEXITCODE -ne 0) { throw 'Ошибка установки Python-зависимостей.' }
& npm.cmd ci
if ($LASTEXITCODE -ne 0) { throw 'Ошибка npm ci.' }
& npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw 'Ошибка сборки интерфейса.' }
Write-Host 'Готово. Запуск: powershell -ExecutionPolicy Bypass -File scripts/start.ps1'
