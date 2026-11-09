# bin/ — локальный движок распознавания

Сюда кладётся `whisper-cli.exe` (и его `.dll`) из релизов
[ggml-org/whisper.cpp](https://github.com/ggml-org/whisper.cpp/releases) — файл `whisper-bin-x64.zip`.

Автоматически это делает скрипт:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\download-models.ps1
```

Он же кладёт модели в `models/`. Бинарники в Git не попадают (см. `.gitignore`), но папки
существуют, чтобы electron-builder мог собрать `extraResources`.
