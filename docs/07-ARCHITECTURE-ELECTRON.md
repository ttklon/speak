# ZSpeakly — архитектура приложения

Документ описывает, как устроена **реализованная** версия (Electron + React).
Альтернативный .NET-план остался в [06-ARCHITECTURE-NET.md](06-ARCHITECTURE-NET.md) — он не отменён,
но этот репозиторий теперь собирает Electron-приложение.

## Почему Electron, а не WPF

| Критерий | Electron (выбрано) | WPF + Whisper.NET |
|---|---|---|
| Скорость выхода MVP | UI из видео воспроизводится 1:1 на CSS за дни | XAML-стилизация каждого контрола |
| Кроссплатформенность | Windows/macOS/Linux одним кодом | только Windows |
| Web Speech / Media API | встроены (микрофон, WebAudio, VAD-уровень) | нужен NAudio + Silero ONNX |
| Офлайн-STT | whisper.cpp отдельным бинарником | Whisper.NET (проще) |
| Размер дистрибутива | ~85 МБ (NSIS) | ~25 МБ framework-dependent |
| Экосистема для UI | React, lucide, CSS-переменные | ограничена |

Итог: Electron выбран за скорость воспроизведения интерфейса и переиспользование веба,
при этом распознавание остаётся локальным (whisper.cpp) — никакой сети в рантайме.

## Слои

```
electron/                     привилегированный процесс
  main.cjs      окно, трей, глобальные хоткеи, буфер, IPC, вставка текста
  preload.cjs   allowlist-мост window.zspeakly (contextIsolation: true)
  store.cjs     JSON-хранилище профиля (атомарная запись, flush по таймеру)
  whisper.cjs   поиск whisper-cli + ggml-модели, транскрипция wav

src/                          renderer (React 18 + Vite)
  state/
    AppDataProvider      настройки, диктовки, словарь, буфер, пресеты, сессии, заметки, статистика
    DictationProvider    сессия диктовки, уровень, таймер, HUD, глобальный хоткей
    ToastProvider        уведомления
  lib/
    recognition/engine   три движка STT с прозрачным фолбэком
    ai/textops           офлайн-операции: clean / formal / shorten / bullets / terms
    ai/summarizer        резюме встреч: TF по предложениям, решения, задачи
    translate            офлайн-словарь + правила, опционально Ollama
    storage              localStorage ↔ IPC-мост (один API)
    utils                склонения, время, хоткеи, словарь, постобработка
    router               hash-роутинг, работает на file://
  components/  layout, ui (Modal/Toggle/Controls/HUD), modals, settings/sections
  pages/       Home, Dictionary, Hotkeys, Meetings, Translate, Clipboard
```

## Поток диктовки

1. **Старт.** Глобальный хоткей `Ctrl+Alt+Space` ловится в main (`globalShortcut`) →
   `webContents.send('hotkey', {type:'down'})`. В браузере — `Alt+D` или кнопка «Начать диктовку».
2. **Запись.** `createRecognizer()` выбирает движок:
   - native whisper.cpp (если main нашёл бинарник и модель),
   - Web Speech API,
   - демо-движок (если Web Speech не поднялся за 2 с — сторож `watchdog`).
3. **Живой текст.** `onPartial` обновляет HUD и блок «Живая диктовка».
4. **Финиш.** `onEnd` → `finish()`: словарь → постобработка → запись в историю → статистика.
5. **Вставка.** В Electron `native.insertText(text)` кладёт текст в буфер и отправляет `Ctrl+V`
   активному окну через PowerShell SendKeys (main размывает окно на 90 мс).

Защита от двойного финиша: флаг `finishing` в `DictationProvider` и `ended` в web-движке.

## Хранение

| Среда | Где |
|---|---|
| Electron | `%APPDATA%\ZSpeakly\profile.json` (ключи `zs:*`) |
| Браузер (preview) | `localStorage` с теми же ключами |

Ключи: `zs:settings`, `zs:dictations`, `zs:clipboard`, `zs:dictionary`, `zs:hotkeys`,
`zs:presets`, `zs:instructions`, `zs:sessions`, `zs:meetingNotes`, `zs:stats`, `zs:profile`.

Запись в профиль дебаунсится (180 мс), файл пишется через `.tmp` + `renameSync`.
**Чтение синхронное** (`sendSync` → данные уже в памяти main) — это важно: асинхронное чтение
при первом рендере раньше отдавало `null` и история терялась.

## Распознавание речи

```
renderer ──start──▶ main ──spawn──▶ whisper-cli -m ggml-small.bin -f rec.wav -l ru -otxt
        ◀──line─── main ◀──stdout/файл .txt
```

Поиск бинарника: `resources/bin`, `%APPDATA%\ZSpeakly\bin`, `PATH`.
Модели: `resources/models`, `%APPDATA%\ZSpeakly\models`, `models/` (игнорируется в Git).

Статус доступен через `native.sttStatus(model)` — интерфейс показывает движок в
Настройки → Функции → «Модель распознавания».

## Офлайн-обработка текста

- `OPS.clean` — слова-паразиты, пунктуация, заглавные;
- `OPS.formal` — замены в деловом тоне (корректная замена по кириллическим границам слов:
  JS `\b` не работает с кириллицей);
- `OPS.shorten` / `bullets` / `searchQuery` / `lowerTerms`;
- `buildSummary` — частотный анализ предложений, выделение решений (`Решили`, `Согласовали`)
  и задач (инфинитивы, `Нужно`, сроки), без дублей между блоками.

Все операции детерминированы и покрыты тестами (45 тестов). Если в настройках включён Ollama
(`http://localhost:11434`), те же операции пробуют локальную модель и молча возвращаются
к правилам при недоступности.

## Безопасность и приватность

- `contextIsolation: true`, `nodeIntegration: false`, IPC-allowlist в preload.
- Нет сетевых запросов в рантайме, кроме опционального `http://localhost:11434`.
- CSP в `index.html` запрещает внешние скрипты и соединения.
- Пароли в буфере можно не сохранять (`hidePasswords`).

## Никакого Python

Приложение полностью на Electron: main-процесс — Node.js (`electron/main.cjs`), рендерер — React.
Ни в сборке, ни в рантайме нет `python.exe`, PyInstaller, `child_process` на python, сокет-моста
или питон-зависимостей. Внешних процессов ровно три, и все опциональны:

| Процесс | Зачем | Если нет |
|---|---|---|
| `whisper-cli.exe` (C++ из whisper.cpp) | офлайн-распознавание | Web Speech или демо-движок |
| `powershell.exe` (SendKeys) | вставка текста в чужое окно на Windows | текст остаётся в буфере |
| `tasklist.exe` | имя приложения-источника для буфера | источник = «Системный буфер» |

Всё остальное — Node API: `fs`, `path`, `child_process`, `electron` (clipboard, globalShortcut,
desktopCapturer, Tray, session).

## Тесты

```
npm test           # vitest: utils (20), textops (12), dictionary learn (5), App render (8) = 45
npm run test:main  # смоук main: IPC-каналы, хоткеи, замена выделения (6 проверок)
```

`App.test.jsx` рендерит каждую страницу через `renderToString` — ловит падения компонентов,
отсутствующие импорты и ошибки состояния без браузера.

## Сборка

```
npm run build      # renderer → dist/
npm run dist:win   # NSIS + portable → release/
```

electron-builder упаковывает `dist/`, `electron/`, `icons/` в asar, а `models/` и `bin/`
кладёт в `extraResources` (и распаковывает из asar), чтобы `whisper-cli.exe` можно было запускать; иконка `icons/icon.ico`
генерируется скриптом `scripts/make-icons.mjs` (PNG + ICO без внешних зависимостей).
