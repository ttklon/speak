# build/bin — движок распознавания для установщика

Сюда CI (job `package`) кладёт `whisper-cli.exe`, `whisper-server.exe` и DLL из
`whisper-bin-x64.zip` (релизы ggml-org/whisper.cpp). `extraResources` отдаёт папку
в `resources/bin`, и приложение находит движок без скачивания.

Локально папка может быть пустой: тогда приложение докачает движок само при
первом запуске (`models:prepare`). Файлы движка в Git не коммитятся.
