# models/ — модели whisper.cpp

Сюда кладутся `ggml-tiny.bin`, `ggml-small.bin`, `ggml-medium.bin` (75 МБ–1.5 ГБ).
Скачиваются скриптом `scripts\download-models.ps1` или вручную с
<https://huggingface.co/ggerganov/whisper.cpp/tree/main>.

В репозиторий веса не коммитятся: папка нужна как точка монтирования `extraResources`.
