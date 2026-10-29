# download-models.ps1 — качает ЛЁГКИЕ модели для ZSpeakly (быстро, мало RAM/CPU)
# Запускай в ОБЫЧНОМ PowerShell. Всё бесплатно, офлайн после скачки.
# Итого ~550 МБ на диске, RAM <800 МБ, CPU <15% — не нагружает систему.

$models = "C:\dev\speak\models"
mkdir $models -Force
cd $models

Write-Host "=== 1/3 Silero VAD (2 МБ) — детекция речи ===" -ForegroundColor Cyan
Invoke-WebRequest -Uri https://github.com/snakers4/silero-vad/files/12211582/silero_vad.onnx -OutFile silero_vad.onnx -ErrorAction Continue
if (-not (Test-Path silero_vad.onnx)) {
  Write-Host "Не скачан — скачай вручную с https://github.com/snakers4/silero-vad" -ForegroundColor Yellow
}

Write-Host "=== 2/3 Whisper tiny (75 МБ) — быстрый STT для теста ===" -ForegroundColor Cyan
Invoke-WebRequest -Uri https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin -OutFile ggml-tiny.bin
Write-Host "=== Whisper small (466 МБ) — РЕКОМЕНДУЕМ для ZSpeakly (баланс скорость/качество) ===" -ForegroundColor Cyan
Invoke-WebRequest -Uri https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin -OutFile ggml-small.bin
# medium (1.5 ГБ) НЕ качаем по умолчанию — тяжёлый. Если нужно: раскомментируй
# Invoke-WebRequest -Uri https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin -OutFile ggml-medium.bin

Write-Host "=== 3/3 Проверка ===" -ForegroundColor Cyan
Get-ChildItem $models | Select Name, @{N="MB";E={[math]::Round($_.Length/1MB,1)}} | Format-Table

Write-Host "Готово! Модели в $models" -ForegroundColor Green
Write-Host "Лёгкие настройки для слабых ПК:" -ForegroundColor Yellow
Write-Host "- Используй ggml-tiny.bin — 75МБ, ~0.4x realtime, 300МБ RAM, идеально для ноутбуков"
Write-Host "- Используй ggml-small.bin — 466МБ, ~0.8x realtime, 600МБ RAM, РЕКОМЕНДУЕМ"
Write-Host "- AI-полировку (Qwen2 0.5B Q4) качай отдельно — 400МБ, опционально, не включай если ПК слабый"

# Опционально: Qwen2.5 0.5B Q4 для AI-полировки (лёгкая LLM, 0.5 млрд параметров, 400МБ)
# Write-Host "=== Опционально Qwen2.5 0.5B Q4 для AI-полировки ===" -ForegroundColor Cyan
# Invoke-WebRequest -Uri https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf -OutFile qwen2.5-0.5b-q4.gguf
