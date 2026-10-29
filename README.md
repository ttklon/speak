# speak — бесплатный офлайн-клон Speakly на .NET для Windows 11

> **Не печатай, просто Speakly.** — голосовой помощник: диктовка в любом поле, буфер обмена, живой перевод, заметки встреч, словарь, горячие клавиши. Всё локально, бесплатно, без облака.

Это репозиторий для сборки клона по видео `vsdc-sr 2026-10-22 23-13-29_compross.mp4` (6:49, 1280×720) — полный теардаун и план внутри.

## Быстрый старт (Windows 11)

```powershell
winget install Microsoft.DotNet.SDK.8 Git.Git GitHub.cli
gh auth login
git clone https://github.com/ttklon/speak.git C:\dev\speak
cd C:\dev\speak
git checkout arena/c0441a45-speak
dotnet build
```

Далее: [docs/01-MASTER-PLAN.md](docs/01-MASTER-PLAN.md) — 12 стадий, 85 шагов; [docs/02-WINDOWS-SETUP.md](docs/02-WINDOWS-SETUP.md) — PowerShell команды; [docs/03-SELF-HOSTED-RUNNER.md](docs/03-SELF-HOSTED-RUNNER.md) — runner на твоём ПК.

## Документация

| Документ | Что внутри |
|---|---|
| [00-VIDEO-TEARDOWN.md](docs/00-VIDEO-TEARDOWN.md) | Покадровый разбор 409 кадров → 32 состояния, размеры, палитра, аудио-реконструкция |
| [01-MASTER-PLAN.md](docs/01-MASTER-PLAN.md) | План из 12 стадий / 85 шагов с командами и критериями |
| [02-WINDOWS-SETUP.md](docs/02-WINDOWS-SETUP.md) | Подключение Windows-ПК к GitHub в PowerShell |
| [03-SELF-HOSTED-RUNNER.md](docs/03-SELF-HOSTED-RUNNER.md) | Runner: установка, лимиты (5дн/24ч/35дн), сервис |
| [04-AFTER-REBOOT.md](docs/04-AFTER-REBOOT.md) | Чек-лист «выключил на неделю — что делать» |
| [05-CONNECTORS.md](docs/05-CONNECTORS.md) | Нужен только GitHub, остальные опциональны |
| [06-ARCHITECTURE-NET.md](docs/06-ARCHITECTURE-NET.md) | Стек .NET 8 WPF + NAudio + Whisper.NET + SQLite |

## Скриншоты из видео

- `docs/sheet_00.jpg` … `docs/sheet_03.jpg` — контактные листы всех 32 состояний
- `analysis/groups.json` — таймлайн групп

## Стек (всё MIT, бесплатно)

WPF + CommunityToolkit.Mvvm + NAudio + Whisper.NET (ggml) + Silero VAD ONNX + SQLite + Serilog. Модели качаются скриптом `download-models.ps1` (не в Git).

## Лицензия

MIT — делай что хочешь, бесплатно навсегда.

## Статус

Ветка `arena/c0441a45-speak` — активная разработка. MVP за 1 неделю (диктовка+вставка+история), полный клон за 2–3 недели по плану.
