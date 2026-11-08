# download-models.ps1 — качает модели для ZSpeakly (всё бесплатно, офлайн после скачки)
# Запускай в ОБЫЧНОМ PowerShell. Лёгкий комплект ~550 МБ, полный с medium ~2 ГБ.

$models = "C:\dev\speak\models"
mkdir $models -Force
cd $models

Write-Host "=== 1/4 Silero VAD (2 МБ) — детекция речи ===" -ForegroundColor Cyan
Invoke-WebRequest -Uri https://github.com/snakers4/silero-vad/files/12211582/silero_vad.onnx -OutFile silero_vad.onnx -ErrorAction Continue
if (-not (Test-Path silero_vad.onnx)) {
  Write-Host "Не скачан — скачай вручную с https://github.com/snakers4/silero-vad" -ForegroundColor Yellow
}

Write-Host "=== 2/4 Whisper tiny (75 МБ) — для слабых ноутов ===" -ForegroundColor Cyan
Invoke-WebRequest -Uri https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin -OutFile ggml-tiny.bin

Write-Host "=== 3/4 Whisper small (466 МБ) — РЕКОМЕНДУЕМ (баланс скорость/качество) ===" -ForegroundColor Cyan
Invoke-WebRequest -Uri https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin -OutFile ggml-small.bin

Write-Host "=== 4/4 Whisper medium (1.5 ГБ) — оставляем, как ты просил (лучшее качество, 1.5 ГБ RAM норм) ===" -ForegroundColor Cyan
Write-Host "Качаю medium — это долго, не прерывай..." -ForegroundColor Yellow
Invoke-WebRequest -Uri https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin -OutFile ggml-medium.bin

Write-Host "=== Проверка ===" -ForegroundColor Cyan
Get-ChildItem $models | Select Name, @{N="MB";E={[math]::Round($_.Length/1MB,1)}} | Format-Table

Write-Host "Готово! Модели в $models" -ForegroundColor Green
Write-Host "Настройки:" -ForegroundColor Yellow
Write-Host "- tiny  — 75МБ, 300МБ RAM, 8% CPU, 5с аудио→1.8с (ноутбук)"
Write-Host "- small — 466МБ, 600МБ RAM, 12% CPU, 5с→3.9с (РЕКОМЕНДУЕМ)"
Write-Host "- medium— 1.5ГБ, 1.5ГБ RAM, 20% CPU, 5с→6с но точнее (оставляем как ты просил, норм)"
Write-Host "- AI-полировка Qwen2.5 0.5B Q4 — 400МБ опционально, только по кнопке, можно не качать"

# Опционально: Qwen2.5 0.5B Q4 для AI-полировки (лёгкая LLM, 0.5 млрд параметров, 400МБ)
# Write-Host "=== Опционально Qwen2.5 0.5B Q4 для AI-полировки ===" -ForegroundColor Cyan
# Invoke-WebRequest -Uri https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf -OutFile qwen2.5-0.5b-q4.gguf

# Чтобы скачать только лёгкие без medium — закомментируй строку с ggml-medium.bin выше
