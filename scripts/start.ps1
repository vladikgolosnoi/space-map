param([int]$Port = 8000)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
if (-not (Test-Path -LiteralPath '.venv\Scripts\python.exe')) { throw 'Сначала выполните scripts/setup.ps1.' }
if (-not (Test-Path -LiteralPath 'dist\index.html')) { throw 'Нет сборки. Выполните npm run build.' }
Write-Host "Карта: http://127.0.0.1:$Port/map/demo"
Write-Host 'Пароль организатора находится в backend/data/admin-password.txt (если не задан SPACE_ADMIN_PASSWORD).'
Write-Host 'Остановка: Ctrl+C.'
& '.\.venv\Scripts\python.exe' -m uvicorn backend.app.main:app --host 127.0.0.1 --port $Port
if ($LASTEXITCODE -ne 0) { throw 'Сервер завершился с ошибкой. Проверьте, свободен ли порт.' }
