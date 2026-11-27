# models/ — модели распознавания

Сюда кладутся веса whisper.cpp: `ggml-tiny.bin`, `ggml-base.bin`, `ggml-small.bin`,
`ggml-medium.bin`, `ggml-large-v3-turbo.bin` и квантованные варианты
(`ggml-tiny-q5_1.bin`, `ggml-base-q5_1.bin`, `ggml-small-q5_1.bin`,
`ggml-large-v3-turbo-q5_0.bin`, `ggml-large-v3-turbo-q8_0.bin`). Скачиваются в
приложении (настройки → модель распознавания) или вручную с
<https://huggingface.co/ggerganov/whisper.cpp/tree/main>.

Здесь же лежит модель определения речи **Silero VAD** — `ggml-silero-v6.2.0.bin`
(864 КБ). Без неё диктовка тоже работает, но движок тратит время на паузы:
с ней whisper-cli запускается с `--vad` и обрабатывает только речь.

- откуда: <https://huggingface.co/ggml-org/whisper-vad> (файл `ggml-silero-v6.2.0.bin`);
- если HuggingFace недоступен, файл собирается из пакета `silero-vad` (PyPI):
  `pip install --no-deps silero-vad numpy && python scripts/make-vad-model.py --out models/ggml-silero-v6.2.0.bin`;
- приложение подхватывает любой `*silero*.bin` в этой папке, в
  `%APPDATA%\ZSpeakly\models` и в `resources/models` установщика.

В репозиторий веса не коммитятся (`.gitignore` → `models/*`): папка нужна как точка
монтирования `extraResources`.
