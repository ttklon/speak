# Архитектура .NET-клона Speakly (технический документ)

## Стек — 100% бесплатный, MIT/Apache-2.0, офлайн

| Задача | Библиотека | Лицензия | Зачем |
|---|---|---|---|
| UI | WPF + CommunityToolkit.Mvvm 8.2 | MIT | MVVM, окно 820×540, тёмная тема |
| Иконки | Segoe Fluent / Lucide | MIT | 7 иконок сайдбара |
| Трей | H.NotifyIcon.Wpf | MIT | иконка в трее, меню |
| Аудио | NAudio 2.2 | MIT | WASAPI захват микрофона + loopback |
| VAD | Silero VAD ONNX + OnnxRuntime | MIT | детекция речи, 2 МБ модель |
| STT | Whisper.NET 1.7 + Runtime | MIT | ggml tiny/small/medium, 99 языков |
| Хранение | Microsoft.Data.Sqlite 8 | MIT | SQLite, 1 файл |
| Логи | Serilog + File sink | Apache-2 | логи в %APPDATA% |
| QR | QRCoder 1.6 | MIT | QR для мобильной заглушки |
| Тесты | xUnit, FlaUI | MIT | юниты + UI |
| Инсталлятор | Inno Setup 6 | MIT | SpeakSetup.exe |
| Автообновление | Velopack | MIT | дельта-обновления с GitHub Releases |
| LLM опционально | LLamaSharp (llama.cpp) | MIT | локальная полировка текста |

## Диаграмма

```
┌─────────────┐
│  MainWindow │  WPF 820×540, NavigationView, 7 страниц
└──────┬──────┘
       │ MVVM bindings
┌──────▼──────────────────────────────────────────┐
│  Speak.Core                                     │
│  • SettingsService (JSON + SQLite)             │
│  • DictationHistoryService                      │
│  • DictionaryService                            │
│  • ClipboardHistoryService                      │
│  • SessionService (meetings/translate)         │
└──────┬──────────┬──────────┬──────────┬─────────┘
       │          │          │          │
   ┌───▼───┐  ┌──▼───┐  ┌───▼────┐ ┌───▼─────┐
   │ Audio │  │Hotkeys│ │Clipboard│ │  AI   │
   │ NAudio│  │Win32 │ │ Win32   │ │LLM/ONNX│
   │+VAD   │  │Hook │ │Listener │ │       │
   │+Whisper│ │    │ │         │ │       │
   └───────┘  └────┘ └────────┘ └───────┘
       │          │          │          │
       └──────────┴──────────┴──────────┘
                  SQLite
```

## Поток диктовки (главный сценарий)

1. Пользователь жмёт `CapsLock+Space` (или свой хоткей) → `GlobalHotkeyService` ловит `WM_HOTKEY`.
2. `AudioCaptureService.Start()` → WASAPI 16kHz mono → пишет в кольцевой буфер.
3. `VadService` каждые 100 мс проверяет речь → если тишина >700 мс → `FlushSegment()`.
4. `WhisperService.TranscribeAsync(wav)` → текст.
5. `TextPostProcessor` → капитализация, применение словаря.
6. `TextInjectionService.Inject(text)` → `Clipboard.SetText` + `SendInput(Ctrl+V)` → текст появляется в активном поле.
7. `DictationHistoryService.Add(timestamp, text, duration)` → UI «Недавнее» обновляется.

Задержка: <1 сек для tiny, <2 сек для small на современном i5.

## Хранение

Файл: `%APPDATA%\Speak\speak.db` (SQLite, WAL-mode)

```sql
CREATE TABLE Dictations(id TEXT PK, created_at DATETIME, text TEXT, duration_ms INT, words INT, audio_path TEXT);
CREATE TABLE ClipboardItems(id TEXT PK, created_at DATETIME, kind TEXT, text TEXT, image_path TEXT);
CREATE TABLE DictionaryWords(word TEXT PK, pronunciation TEXT);
CREATE TABLE Hotkeys(id TEXT PK, name TEXT, gesture TEXT, prompt TEXT, enabled BOOL);
CREATE TABLE Sessions(id TEXT PK, type TEXT, started_at DATETIME, transcript TEXT, summary TEXT);
```

Конфиг: `%APPDATA%\Speak\userSettings.json` — хоткеи, тема, лимиты.

## Безопасность и приватность

- Всё локально, никакого облака, аудио не уходит с диска.
- Автоудаление: job раз в день чистит `Dictations` старше N дней (настройка из видео: 36 дней / 1 месяц).
- Шифрование не нужно (локально), но можно DPAPI для токенов.

## Сборка

```powershell
dotnet build -c Release
dotnet test -c Release
dotnet publish src/Speak.App -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true
# результат: src/Speak.App/bin/Release/net8.0-windows/win-x64/publish/Speak.App.exe (~80 МБ с рантаймом)
```

## Альтернативы

- Вместо WPF можно **WinUI 3 / Avalonia** (кроссплатформенно), но WPF — минимум зависимостей на Windows 11.
- Вместо Whisper.NET можно **Vosk** (меньше, быстрее, но хуже качество) — пакет `Vosk.NET`.
- Вместо ONNX VAD можно простой пороговый детектор (энергия) — ноль ML.

---

*Эта архитектура покрывает все 32 состояния UI из теардауна.*
