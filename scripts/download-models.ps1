# download-models.ps1 — готовит ZSpeakly к полностью офлайн-диктовке.
#
# Что делает:
#   1) качает whisper.cpp (whisper-cli.exe) в %APPDATA%\ZSpeakly\bin
#   2) качает модели ggml-*.bin в %APPDATA%\ZSpeakly\models
#   3) проверяет, что приложение их видит
#
# Запуск — в обычном PowerShell (не от админа):
#   powershell -ExecutionPolicy Bypass -File .\scripts\download-models.ps1
# Лёгкий комплект ~160 МБ (tiny), рабочий ~620 МБ (tiny + turbo q5_0), полный ~2,1 ГБ.

$ErrorActionPreference = 'Continue'
$root    = Join-Path $env:APPDATA 'ZSpeakly'
$binDir  = Join-Path $root 'bin'
$models  = Join-Path $root 'models'
New-Item -ItemType Directory -Force -Path $binDir, $models | Out-Null

Write-Host "`n=== 1/4 whisper.cpp (whisper-cli.exe) ===" -ForegroundColor Cyan
# Берём последний релиз ggml-org/whisper.cpp: whisper-bin-x64.zip
try {
  # свежие релизы whisper.cpp бывают без бинарников — ищем первый, где архив есть
  $rels = Invoke-RestMethod -Uri 'https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=30' -Headers @{ 'User-Agent' = 'zspeakly' }
  $asset = $null
  foreach ($rel in $rels) {
    $hit = $rel.assets | Where-Object { $_.name -eq 'whisper-bin-x64.zip' } | Select-Object -First 1
    if ($hit) { $asset = $hit; break }
  }
  if (-not $asset) {
    foreach ($rel in $rels) {
      $hit = $rel.assets | Where-Object { $_.name -like '*Win32*.zip' } | Select-Object -First 1
      if ($hit) { $asset = $hit; break }
    }
  }
  if ($asset) {
    $zip = Join-Path $env:TEMP 'whisper-bin-x64.zip'
    Write-Host "Качаю $($asset.name) ($([math]::Round($asset.size/1MB,1)) МБ)..."
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zip -UseBasicParsing
    $tmp = Join-Path $env:TEMP 'whisper-bin-x64'
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    # в архиве есть подпапка Release — забираем exe и dll
    Get-ChildItem -Path $tmp -Recurse -Include *.exe, *.dll | ForEach-Object {
      Copy-Item $_.FullName -Destination $binDir -Force
    }
    Remove-Item $zip -Force -ErrorAction SilentlyContinue
  } else {
    Write-Host "В релизе нет zip для x64 — скачай вручную: https://github.com/ggml-org/whisper.cpp/releases" -ForegroundColor Yellow
  }
} catch {
  Write-Host "Не удалось скачать whisper.cpp: $($_.Exception.Message)" -ForegroundColor Yellow
  Write-Host "Скачай whisper-bin-x64.zip вручную и распакуй .exe/.dll в $binDir" -ForegroundColor Yellow
}

Write-Host "`n=== 2/4 Whisper tiny (75 МБ) — быстрая проверка, что всё работает ===" -ForegroundColor Cyan
$tiny = Join-Path $models 'ggml-tiny.bin'
if (-not (Test-Path $tiny)) {
  Invoke-WebRequest -Uri 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin' -OutFile $tiny -UseBasicParsing
}

Write-Host "`n=== 3/4 Whisper large-v3-turbo q5_0 (547 МБ) — рекомендуем для диктовки ===" -ForegroundColor Cyan
Write-Host "Тот же large-v3-turbo, но квантованный: почти как large-v3 и вдвое меньше памяти."
$turbo = Join-Path $models 'ggml-large-v3-turbo-q5_0.bin'
if (-not (Test-Path $turbo)) {
  Invoke-WebRequest -Uri 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin' -OutFile $turbo -UseBasicParsing
}

Write-Host "`n=== 4/4 Whisper large-v3-turbo (1.5 ГБ) — максимум качества ===" -ForegroundColor Yellow
Write-Host "Не нужен? Закомментируй блок ниже — q5_0 из шага 3 уже достаточно."
# $full = Join-Path $models 'ggml-large-v3-turbo.bin'
# if (-not (Test-Path $full)) {
#   Invoke-WebRequest -Uri 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin' -OutFile $full -UseBasicParsing
# }

Write-Host "`n=== Проверка ===" -ForegroundColor Cyan
Get-ChildItem $binDir -Filter *.exe -ErrorAction SilentlyContinue | Select-Object Name, @{N = 'МБ'; E = { [math]::Round($_.Length / 1MB, 1) } } | Format-Table
Get-ChildItem $models -Filter *.bin -ErrorAction SilentlyContinue | Select-Object Name, @{N = 'МБ'; E = { [math]::Round($_.Length / 1MB, 1) } } | Format-Table

$cli = Get-ChildItem $binDir -Filter 'whisper-cli.exe' -ErrorAction SilentlyContinue
if ($cli -and ((Test-Path $turbo) -or (Test-Path $tiny))) {
  Write-Host "Всё на месте — запускай ZSpeakly, движок будет 'whisper.cpp (офлайн)'." -ForegroundColor Green
  Write-Host "Проверка версии: & '$($cli.FullName)' --help" -ForegroundColor DarkGray
} else {
  Write-Host "Чего-то не хватает: нужен whisper-cli.exe в $binDir и ggml-*.bin в $models." -ForegroundColor Yellow
}
Write-Host "`nПапки:" -ForegroundColor DarkGray
Write-Host "  $binDir"
Write-Host "  $models"
