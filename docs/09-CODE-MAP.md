# 09 — Карта программы (что где лежит и как работает)

Документ для тех, кто открывает репозиторий с нуля: из чего состоит ZSpeakly,
как связаны слои, какие каналы IPC существуют и где что хранится. Полностью
соответствует коду на момент версии 1.4.5.

Оглавление:

1. [Слои](#1-слои)
2. [Файлы по папкам](#2-файлы-по-папкам)
3. [Поток диктовки](#3-поток-диктовки)
4. [Поток AI-инструкции](#4-поток-ai-инструкции)
5. [IPC: полный контракт](#5-ipc-полный-контракт)
6. [Хранение данных](#6-хранение-данных)
7. [Экраны и их состояние](#7-экраны-и-их-состояние)
8. [Горячие клавиши](#8-горячие-клавиши)
9. [Диагностика и приватность](#9-диагностика-и-приватность)
10. [Модели распознавания](#10-модели-распознавания)
11. [Сборка, CI и обновления](#11-сборка-ci-и-обновления)
12. [Проверки перед коммитом](#12-проверки-перед-коммитом)
13. [Известные ограничения](#13-известные-ограничения)

## 1. Слои

```
┌──────────────────────────────────────────────────────────────┐
│ Renderer: React 18 + Vite 5 (src/)                           │
│  • страницы: Главная, Словарь, Горячие клавиши, Буфер        │
│  • состояние: AppDataProvider (данные), DictationProvider     │
│  • мост: window.zspeakly (только из preload)                  │
└───────────────▲──────────────────────────────────────────────┘
                │ contextBridge allowlist (preload.cjs)
┌───────────────┴──────────────────────────────────────────────┐
│ Main: Electron 33 (electron/)                                 │
│  • окно без рамки, трей, глобальные хоткеи                    │
│  • store.cjs → profile.json, logger.cjs → logs/zspeakly.log   │
│  • whisper.cjs → whisper-cli.exe, models.cjs → скачивание     │
│  • вставка в чужое окно: PowerShell SendKeys                  │
└───────────────▲──────────────────────────────────────────────┘
                │ http (только локально)
┌───────────────┴──────────────────────────────────────────────┐
│ Внешние локальные процессы                                    │
│  • whisper.cpp (whisper-cli.exe + ggml-*.bin)                 │
│  • Ollama (необязательно): http://localhost:11434             │
└──────────────────────────────────────────────────────────────┘
```

Ключевое правило: наружу (в интернет) приложение не ходит, кроме двух
необязательных случаев — проверка обновлений на GitHub и отправка журналов
на свой приёмник (по умолчанию адреса нет).

## 2. Файлы по папкам

### `electron/`

| Файл | Что делает |
| --- | --- |
| `main.cjs` | Всё ядро: окно 1020×680 без рамки, трей и меню, `globalShortcut`, мониторинг буфера (900 мс), активное окно через PowerShell+C# (`GetForegroundWindow` + `GetWindowThreadProcessId`), вставка `^v` через `SendKeys`, чтение и замена выделения, скриншоты `desktopCapturer`, `setDisplayMediaRequestHandler` с loopback-звуком, регистрация всех IPC с учётом занятых сочетаний (`registerAccel` + `hotkey:conflict`), различение одиночного и двойного нажатия диктовки для «агента», инициализация журнала, тихая проверка обновлений |
| `preload.cjs` | `contextBridge.exposeInMainWorld('zspeakly', …)`: `store`, `window`, `native`, `clipboard`, подписки `onHotkey/onTextAction/onCommand/onClipboard/onClipboardAction/onModelProgress/onUpdateStatus/onHotkeyConflict`, `onNavigate`, `setZoom` |
| `store.cjs` | `JsonStore`: `%APPDATA%\ZSpeakly\profile.json`, кэш в памяти, `scheduleFlush` 180 мс, атомарная запись `.tmp` → `rename`, `sizeSync()` |
| `whisper.cjs` | Поиск `whisper-cli.exe` / `whisper.exe` / `main.exe` в `resources/bin` → `userData\bin` → `appPath\bin` → `PATH`; модели `ggml-{preferred,small,tiny,medium}.bin`; запуск с `-m -f -l --no-timestamps -nt -otxt -of`, `--prompt`, таймаут 120 с; разбор `.out.txt`, затем stdout/stderr с фильтром служебных строк |
| `models.cjs` | `modelStatus()` (что уже на диске), `downloadModel()` с Hugging Face и прогрессом, `downloadEngine()` — последний релиз `ggml-org/whisper.cpp` с `whisper-bin-x64.zip`, распаковка через `Expand-Archive`, `importModel()` — подхват файла и угадывание типа по размеру |
| `wav.cjs` | PCM Int16 16 кГц → RIFF/WAVE без зависимостей |
| `logger.cjs` | Журнал: буфер 400 событий, файл `logs/zspeakly.log` с обрезкой на 512 КБ, `redact()` (почта, `C:\Users\…`, `/home/…`, токены), `scrub()` (выбрасывает `text/transcript/pcm/audio/clipboard/word/prompt/selection`), отправка пачками по 40, `report()`, `ping()`, `sendNow()`, `installId` |
| `updater.cjs` | `createUpdater()`: electron-updater, каналы stable/beta, `autoDownload`, события в `update:status`, честный `unavailable` в dev и portable |

### `src/`

| Файл / папка | Что делает |
| --- | --- |
| `main.jsx` | Провайдеры `Toast → AppData → Dictation`, локальные шрифты, `installErrorHooks()` |
| `App.jsx` | Роутинг по hash, тема (`data-theme`), автозапуск, регистрация AI-инструкций и голосовых сочетаний в main, команды трея, тосты обновлений, модалки |
| `pages/HomePage.jsx` | Слоган, счётчики по реальной истории, живая диктовка, «Недавние» с поиском, сниппет (копировать/исправить/удалить/продиктовать ещё), эффект печати |
| `pages/DictionaryPage.jsx` | Список слов, вкладки «с произношением / без», добавление, удаление, тумблер применения |
| `pages/HotkeysPage.jsx` | Голосовые сочетания, рекомендуемые AI-пресеты, свои инструкции, запись сочетания, стиль письма |
| `pages/ClipboardPage.jsx` | Сетка/список, вкладки, поиск, закрепление, маскировка паролей с «Показать», скриншот, запись экрана |
| `state/AppDataProvider.jsx` | Единое состояние: настройки, диктовки, словарь, буфер, хоткеи, пресеты, инструкции, статистика, профиль; персист в `profile.json` / `localStorage`; синхронизация `zs:settings` и `zs:dictionary` в main; очистка по сроку хранения |
| `state/DictationProvider.jsx` | Движок диктовки: старт/стоп, живой текст, уровень, таймеры, ошибки, HUD, «режим агента», глобальные хоткеи, `Alt+D` в браузере |
| `state/ToastProvider.jsx` | Тосты с тоном, TTL, действием |
| `lib/recognition/engine.js` | Выбор движка: `whisper.cpp` → Web Speech → демо (демо только в браузере) |
| `lib/recognition/errors.js` | Человеческие тексты ошибок распознавания |
| `lib/audio/pcmRecorder.js` | `getUserMedia` → `ScriptProcessor` → ресемплинг в 16 кГц → `Int16Array` + RMS-уровень |
| `lib/audio/devices.js` | Список микрофонов, разрешение, анализатор уровня |
| `lib/ai/textops.js` | Офлайн-операции: `clean`, `formal`, `shorten`, `bullets`, `searchQuery`, `lowerTerms`, `summary`, `todos`; `llmRewrite()` через Ollama с бэкоффом 60 с (`llmIsDown`/`resetLlmBackoff`): после таймаута следующие запросы не ждут, инструкции идут офлайн |
| `lib/ai/vision.js` | Экранный контекст: `describeScreen()` шлёт скриншот в локальную модель (`images[]`), `mergePromptParts()` собирает подсказку (термины ≤300 симв. + словарь), различает «модель без картинок» (400) и «модели нет» (404) |
| `lib/ai/instructions.js` | Исполнитель инструкций: LLM, иначе офлайн-операция по промпту/названию |
| `lib/feedback.js` | Звуковые отклики старт/стоп/ошибка через WebAudio и «эффект печати» `typeOut()` (по словам, отменяется `AbortSignal`) |
| `lib/ai/style.js` | Профиль стиля по истории (длина фраз, «ты/вы», эмодзи, вводные) и подстройка текста |
| `lib/translate.js` | Перевод: Ollama, иначе словари ru↔en и пометка покрытия |
| `lib/dictionary/learn.js` | Обучение словаря по правкам (Левенштейн, стоп-слова, лимит 5) |
| `lib/hotkeys/useTextAction.js` | Забрать выделение → обработать → вернуть на место |
| `lib/clipboard.js` | Запись/чтение буфера: нативный мост → `window.zspeakly.clipboard` → `navigator.clipboard` → `execCommand` |
| `lib/storage.js` | Один API чтения/записи: Electron-мост или `localStorage` (`zs:` префикс) + размер данных |
| `lib/retention.js` | Срок хранения: `pruneByAge`, «бессрочно» = 3650 |
| `lib/seed.js` | Демо-данные из видео (тексты, «снимки», словарь) |
| `lib/media/recorder.js` | Запись экрана в WebM + постер из первого кадра |
| `lib/feedback.js` | WebAudio-бипы и эффект печати |
| `lib/router.js` | Hash-роутер (`#/page?param=`) |
| `lib/config.js` | Единая точка правды: `APP`, `NAV`, `LANGUAGES`, `DEFAULT_SETTINGS`, хоткеи, пресеты, модели, `STORAGE_KEYS` |
| `components/` | `layout/` (Sidebar, TitleBar), `ui/` (Controls, Modal, Toggle, Icon, DictationHUD), `modals/` (онбординг, профиль, правка, запись сочетания, инструкция), `settings/` (модалка + 7 секций + MicTester + ModelManager + UpdateRow + сгенерированный `settingsIndex.js`) |
| `styles/` | `base` (палитра из разбора видео + светлая тема), `layout`, `components`, `pages`, `extra` — всего ~4 300 строк. Темы: тёмная, светлая и «как в системе» (`html[data-theme]` + `style.colorScheme`); полупрозрачные рамки и заливки записаны как `rgba(var(--overlay-rgb), α)`, так что одна палитра работает в обеих темах |

### Служебное

| Путь | Назначение |
| --- | --- |
| `scripts/check-ipc.mjs` | Сверяет `invoke/send` из preload с `ipcMain.handle/on` |
| `scripts/smoke-main.mjs` | Грузит `main.cjs` с заглушкой Electron: 31 проверка — IPC, хоткеи, подсказка whisper (словарь + контекст экрана, ≤500), HTTP к локальной модели, снимок экрана, мониторинг буфера (новое копирование, своя вставка не дублируется, выключенный мониторинг молчит), двойное нажатие для «агента», сообщение о занятом сочетании, переключатель для своих сочетаний диктовки и screen-aware в E2E |
| `scripts/test-ui.mjs` + `scripts/e2e/mock-bridge.mjs` | E2E в Chromium: мок моста `window.zspeakly` с журналом вызовов, обход всех кнопок/полей на каждом экране, 45 сценариев / 111 проверок: обход, режимы диктовки (кнопка, хоткей, свободные руки, агент, диктовка с учётом экрана), вставка текста в активное окно, настройки и их связь с main, контраст и переполнение в обеих темах и в узком окне (1024/900 px), доступные имена кнопок и видимый фокус |
| `scripts/capture-screenshots.mjs` | 14 кадров интерфейса (тёмная и светлая темы) прямо из работающего Vite |
| `scripts/smoke-updater.mjs` | Канал stable/beta реально применяется |
| `scripts/build-settings-index.mjs` | Генерирует индекс строк настроек для поиска (`--check` для CI) |
| `scripts/dev-electron.mjs` | Vite + Electron с горячей перезагрузкой |
| `scripts/make-icons.mjs` | PNG/ICO/SVG без зависимостей (своя реализация deflate и ICO) |
| `scripts/download-models.ps1` | Ставит движок и модели в `%APPDATA%\ZSpeakly` |
| `server/worker.mjs` | Cloudflare Worker-приёмник журналов (Durable Object + SQLite, `/admin`, `/health`) |
| `.github/workflows/build.yml` | check (ubuntu) → package (windows) → release по тегу |
| `build/electron-builder.yml` | `publish: github`, `electronDist: dist-electron` |
| `analysis/groups.json` | 32 группы кадров исходного видео |

## 3. Поток диктовки

```
Ctrl+Alt+Space (глобальный хоткей)
  → main: globalShortcut → webContents.send('hotkey', {type:'down'})
  → DictationProvider.start(): состояние listening, HUD, бип
  → engine.createRecognizer(): native (whisper.cpp) → pcmRecorder
      getUserMedia → ScriptProcessor(4096) → Float32 → 16 кГц → Int16
  → отпустили клавишу: hotkey {type:'up'} → stop()
  → engine.stop(): recorder.stop() → { pcm, durationMs }
      проверки: пустая запись / короче 350 мс
  → invoke('stt:transcribe-pcm', { pcm, durationMs, lang, model, useDictionary })
  → main: WAV во temp → whisper.transcribe(wav, { prompt из словаря })
  → пришёл текст: applyDictionary (если тумблер включён)
      → postProcess → OPS.clean → история + статистика
      → invoke('text:insert') → clipboard.writeText + SendKeys ^v
      → окно возвращается, HUD закрывается через 2.2 с
```

Особенности:

- модель и движок ищутся при каждом вызове, поэтому скачанную модель не нужно
  перезапускать вручную;
- при отсутствии движка показывается честная ошибка с путём в настройки, а не
  выдуманный текст;
- «сторож» на 90 с не даёт плашке «Транскрибирую…» висеть вечно;
- в браузере (превью) работает Web Speech, а при его недоступности — демо-движок;
  в Electron демо-режима нет намеренно.

## 4. Поток AI-инструкции

```
Ctrl+Alt+E (или своя инструкция)
  → main: send('text-action', id)  ← сочетание зарегистрировано из App.jsx
  → Hook useTextAction.run(action)
  → native.readSelection(): blur окна → SendKeys ^c → чтение буфера
  → runInstruction(action, text, settings):
        Ollama (/api/generate) при включённом ИИ и непустом промпте,
        иначе офлайн: translate / formal / shorten / search / terms / bullets / summary / clean
  → applyStyle(), если включён «Стиль письма»
  → native.replaceSelection(): буфер + ^v на место выделения
```

## 5. IPC: полный контракт

Проверяется `npm run check:ipc` (сейчас 45 invoke-каналов, 46 обработчиков).

| Группа | Каналы |
| --- | --- |
| Хранилище | `store:get` (handle + sendSync), `store:set`, `store:remove`, `store:size` (sendSync) |
| Окно | `win:minimize`, `win:toggle-maximize`, `win:close`, `win:badge` |
| Распознавание | `stt:status`, `stt:transcribe`, `stt:transcribe-pcm` |
| Текст | `text:insert`, `text:paste`, `text:read-selection`, `text:replace-selection` |
| Буфер | `clipboard:read`, `clipboard:write`, `clipboard:screenshot`, `screen:capture` |
| Хоткеи | `hotkey:set` (строка-акселератор или `{dictationKey, textActions, voiceHotkeys}`) |
| Сеть (только локально) | `http:get`, `http:post` — allowlist: localhost, `*.local`, 10/8, 192.168/16, 172.16/12 |
| Диагностика | `diag:log`, `diag:status`, `diag:recent`, `diag:set-enabled`, `diag:set-endpoint`, `diag:save-report`, `diag:send-now`, `diag:ping`, `diag:clear` |
| Файлы и система | `app:open-data-folder`, `app:open-external` (белый список GitHub), `app:auto-launch`, `app:open-logs`, `app:save-file`, `app:notify`, `app:noop` |
| Модели | `models:status`, `models:download`, `models:download-engine`, `models:import` |
| Обновления | `update:check`, `update:channel`, `update:download`, `update:install` |

События main → renderer: `hotkey`, `text-action`, `command`, `navigate`,
`clipboard:item`, `clipboard:action`, `model:progress`, `update:status`,
`hotkey:conflict`.

## 6. Хранение данных

| Что | Где в Electron | Где в браузере |
| --- | --- | --- |
| Настройки | `profile.json` → `zs:settings` | `localStorage` → `zs:zs.settings` |
| Диктовки | `zs:dictations` | `zs:zs.dictations` |
| Словарь | `zs:dictionary` | `zs:zs.dictionary` |
| Буфер | `zs:clipboard` | `zs:zs.clipboard` |
| Хоткеи / пресеты / инструкции | `zs:hotkeys`, `zs:presets`, `zs:instructions` | те же ключи с префиксом |
| Статистика / профиль | `zs:stats`, `zs:profile` | те же |
| Идентификатор установки | `zs:installId` (uuid) | — |
| Журнал | `%APPDATA%\ZSpeakly\logs\zspeakly.log` | `zs.diagnostics.buffer` |
| Модели и движок | `%APPDATA%\ZSpeakly\models`, `\bin` | — |

Важно: `JsonStore` — единственный источник правды в Electron. Рендерер читает
его синхронно (`sendSync`) и пишет асинхронно. Настройки и словарь дополнительно
пушатся в main, потому что main читает их сам (трей, закрытие в трей, prompt
для whisper).

## 7. Экраны и их состояние

- **Главная** — приветствие с именем, счётчики (слова в истории, минуты речи),
  кнопка «Начать диктовку», плашка живой диктовки, последний результат с
  эффектом печати, список «Недавние» (поиск, «показать всё», сниппет).
- **Словарь** — вкладки «Все / С произношением / Без произношения», добавление
  пары «слово + произношение», удаление, тумблер «Применять словарь при
  диктовке» (влияет и на подсказку whisper, и на замену в готовом тексте).
- **Горячие клавиши** — три вкладки; голосовые сочетания реально
  регистрируются в main; у «с учётом экрана» есть подстрока «Стиль письма»;
  пресеты можно попробовать кнопкой «Попробовать»; свои инструкции создаются
  модалкой с записью сочетания.
- **Буфер обмена** — 4 быстрых действия (скриншот, запись экрана, заметка со
  скриншотом, открыть панель), вкладки, поиск, сетка/список, закрепление,
  маскировка паролей, лимит и срок хранения в подвале.
- **Настройки** — 7 разделов + поиск по строкам (индекс генерируется из секций).

## 8. Горячие клавиши

| Действие | По умолчанию |
| --- | --- |
| Диктовка (удержание) | `Ctrl + Alt + Space` |
| Режим агента (двойное нажатие) | то же сочетание, выключен |
| Свободные руки | `Ctrl + Alt + L`, выключен |
| Диктовка с учётом экрана | `Ctrl + Alt + S` |
| Перевести на английский | `Ctrl + Alt + E` |
| Сделать формально | `Ctrl + Alt + F` |
| Профессиональная переработка | `Ctrl + Alt + S` (выключена) |
| Режим поиска | `Ctrl + Alt + Q` (выключен) |
| Понизить термины | `Ctrl + Alt + T` (выключен) |
| Буфер обмена | `Ctrl + Shift + V` |
| Настройки | `Ctrl + ,` |
| Поиск по буферу | `Ctrl + K` |
| Скриншот / запись / заметка | `Shift + Ctrl + A` / `R` / `S` |
| Демо-диктовка в браузере | `Alt + D` |

Если сочетание занято другой программой, main присылает `hotkey:conflict`,
и интерфейс говорит об этом тостом, а не молчит.

## 9. Диагностика и приватность

- Журнал всегда пишется локально; отправка — только если указан адрес
  приёмника (по умолчанию пусто).
- Перед записью и отправкой строки проходят `redact()`, поля с содержимым
  речи/буфера/словаря выбрасываются `scrub()`; воркер повторяет вычистку.
- Кнопки: «Сохранить отчёт в файл» (Рабочий стол), «Скопировать ошибки»,
  «Отправить сейчас», «Проверить канал», «Открыть папку с логами», «Очистить».
- `server/` нужен только тем, кто сам собирает журналы с нескольких машин:
  `cd server && npx wrangler deploy`.

## 10. Модели распознавания

| Модель | Размер | RAM | Скорость | Качество |
| --- | --- | --- | --- | --- |
| tiny | 75 МБ | 300 МБ | 0.4× | 85% ru |
| small | 466 МБ | 600 МБ | 0.8× | 93% ru |
| medium | 1.5 ГБ | 1.5 ГБ | 1.5× | 96% ru |

Ставятся из приложения («Настройки → Функции → Модель распознавания») или
скриптом `scripts/download-models.ps1`. Хранятся в `%APPDATA%\ZSpeakly`,
в установщик не входят.

## 11. Сборка, CI и обновления

```
npm run dev            # только интерфейс, http://localhost:5173
npm run electron:dev   # Electron + Vite
npm run build          # dist/
npm run dist:win       # release\ZSpeakly-Setup-<версия>.exe + portable
```

CI (`.github/workflows/build.yml`): проверки на Ubuntu → сборка установщика на
Windows (с ретраями, кэшем Electron, фолбэком в ZIP, если NSIS недоступен) →
публикация релиза по тегу `v*`. Версия для апдейтера берётся из `latest.yml`,
который генерирует `build/electron-builder.yml` (`publish: github`).

## 12. Проверки перед коммитом

```bash
npm test                  # 102 теста (vitest + jsdom)
npm run test:main         # 31 смоук-проверка main-процесса
npm run test:ui           # E2E: обход кнопок, 40 сценариев, контраст/вёрстка
npm run check:ipc         # ни одного канала без обработчика
npm run test:updater      # каналы обновлений
npm run settings:index:check
npm run build
```

## 13. Известные ограничения

- «Диктовка с учётом экрана» снимает кадр и отдаёт его локальной модели
  (`src/lib/ai/vision.js` → `POST {endpoint}/api/generate` с `images[]`),
  а полученные термины (≤300 симв.) уходят в whisper через `--prompt` вместе
  со словарём. Если модель без поддержки изображений (HTTP 400) или её нет
  (404), распознавание работает без контекста — «Диагностика» так и пишет.
- Офлайн-перевод и офлайн-инструкции работают по словарю и правилам: слова вне
  словаря остаются как есть, приложение показывает покрытие перевода.
- Бейдж на иконке задачи Windows не поддерживается — обновляется подсказка трея.
- `store:get` намеренно существует и как `handle`, и как `on` (sendSync):
  синхронное чтение нужно до первого рендера.
