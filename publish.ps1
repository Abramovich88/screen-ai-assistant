# Публикация на GitHub одним запуском (Windows)
# Запуск: двойной клик по PUBLISH.bat (рядом)
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Write-Host "=== Публикация AI Screen Assistant на GitHub ===" -ForegroundColor Cyan
$token = Read-Host "Вставь СВЕЖИЙ GitHub-токен (ghp_...)"
if (-not $token) { Write-Host "Токен не введён!" -ForegroundColor Red; pause; exit 1 }

$headers = @{ Authorization = "token $token"; "User-Agent" = "screen-ai-assistant" }

try {
    $me = Invoke-RestMethod -Headers $headers -Uri "https://api.github.com/user"
} catch {
    Write-Host "Токен не работает ($($_.Exception.Message)). Создай новый: GitHub -> Settings -> Developer settings -> Personal access tokens (classic) -> scopes: repo и workflow" -ForegroundColor Red
    pause; exit 1
}
$user = $me.login
Write-Host "Аккаунт: $user" -ForegroundColor Green

$repo = "screen-ai-assistant"
try {
    Invoke-RestMethod -Headers $headers -Uri "https://api.github.com/repos/$user/$repo" | Out-Null
    Write-Host "Репозиторий $user/$repo уже существует"
} catch {
    $body = @{ name = $repo; description = "AI-assistent dlya Windows: vidit ekran i otvechaet golosom po-russki"; private = $false; auto_init = $false } | ConvertTo-Json
    Invoke-RestMethod -Method Post -Headers $headers -Uri "https://api.github.com/user/repos" -Body $body -ContentType "application/json" | Out-Null
    Write-Host "Репозиторий $user/$repo создан" -ForegroundColor Green
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host "Git не установлен! Скачай: https://git-scm.com/download/win" -ForegroundColor Red
    pause; exit 1
}

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $dir
git init 2>$null | Out-Null
git config user.name $user
git config user.email "$user@users.noreply.github.com"
git add -A
$null = git commit -m "AI Screen Assistant v1.0.0" 2>$null
git branch -M main 2>$null | Out-Null
git tag -f v1.0.0 2>$null | Out-Null
git remote remove origin 2>$null | Out-Null
git remote add origin "https://x-access-token:$token@github.com/$user/$repo.git"

Write-Host "Отправляю код на GitHub..."
git push -u origin main --force
if ($LASTEXITCODE -ne 0) { Write-Host "Ошибка push (нужны scopes: repo И workflow)" -ForegroundColor Red; pause; exit 1 }
git push origin v1.0.0 --force
if ($LASTEXITCODE -ne 0) { Write-Host "Ошибка push тега (нужен scope workflow)" -ForegroundColor Red; pause; exit 1 }

Write-Host ""
Write-Host "ГОТОВО! Код отправлен, сборка .exe уже началась:" -ForegroundColor Green
Write-Host "  https://github.com/$user/$repo/actions"
Write-Host "Через ~5-10 минут exe появится в разделе:" -ForegroundColor Green
Write-Host "  https://github.com/$user/$repo/releases/tag/v1.0.0"
pause
