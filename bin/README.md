# bin/ — локальный движок распознавания

Сюда кладётся `whisper-cli.exe`, `whisper-server.exe` (и их `.dll`) из релизов
[ggml-org/whisper.cpp](https://github.com/ggml-org/whisper.cpp/releases) — файл `whisper-bin-x64.zip`.

`whisper-server.exe` нужен не «на всякий случай»: он держит веса модели в памяти, а приложение
прогревает его в момент начала записи. Без сервера каждая диктовка начинается с загрузки модели,
и фраза на двадцать секунд считается заметно дольше.

Автоматически это делает скрипт:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\download-models.ps1
```

Он же кладёт модели в `models/`. Бинарники в Git не попадают (см. `.gitignore`), но папки
существуют, чтобы electron-builder мог собрать `extraResources`.
