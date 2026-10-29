# Self-hosted runner на твоём Windows-ПК — подробно

## Зачем тебе именно self-hosted

- **Бесплатно без лимитов:** GitHub не считает минуты self-hosted runner против твоего лимита (2000 мин/мес на hosted). Платишь только электричеством.
- **Твоё железо:** нужен микрофон/звук для тестов Speak — на hosted runner этого нет.
- **Быстрее:** нет очереди, кэш NuGet на твоём диске.

## Официальные лимиты (даже на self-hosted — ограничения Actions остаются)

- Один job ≤ **5 дней** выполнения (практически — твои сборки 3–5 мин, запас огромный).
- Workflow в очереди ≤ **24 часа** — если ПК выключен сутки, job отменится (не страшно, запушишь снова).
- Полный workflow (все jobs цепочкой) ≤ **35 дней**.
- Логи 1 МБ × N, артефакты 500 МБ, кэш 10 ГБ.

Источник: https://docs.github.com/en/actions/reference/limits + https://docs.github.com/actions/hosting-your-own-runners

## Установка за 5 минут (повтор кратко)

```powershell
mkdir C:\actions-runner -Force
cd C:\actions-runner
# ссылку бери из репо → Settings → Actions → Runners → New self-hosted runner → Windows
Invoke-WebRequest -Uri https://github.com/actions/runner/releases/download/v2.321.0/actions-runner-win-x64-2.321.0.zip -OutFile runner.zip
Expand-Archive runner.zip -DestinationPath . -Force
./config.cmd --url https://github.com/ttklon/speak --token YOUR_TOKEN
./svc.cmd install
./svc.cmd start
```

Метки: `speak, windows, dotnet, gpu` — чтобы в workflow писать `runs-on: [self-hosted, speak]`.

## Как обновлять runner

```powershell
cd C:\actions-runner
./svc.cmd stop
# скачай новый zip, распакуй поверх
./svc.cmd start
```

GitHub иногда требует обновить runner — в Actions появится жёлтый баннер.

## Сценарий «выключил на несколько дней»

1. Выключил ПК → все запущенные jobs отменятся через 24 ч, новые пуши копятся в очереди 24 ч.
2. Включил → runner сам стартует (служба), забирает первый job из очереди, выполняет.
3. Если очередь просрочена → в GitHub Actions будет красный крестик «Queued timeout» — просто сделай любой пуш `git commit --allow-empty -m "retrigger" && git push`.

## Безопасность (важно, т.к. это твой ПК)

- Runner запускается от твоего пользователя — не от админа (если ставишь как сервис, укажи обычного пользователя).
- Не запускай недоверенные fork-PR на self-hosted (включи в Settings → Actions → Fork PRs: Require approval).
- Добавь в `.gitignore` всё лишнее: `models/*.bin`, `bin/`, `obj/`, `_work/`.

## Пример workflow для твоего проекта

`.github/workflows/build.yml`:
```yaml
name: Build Speak
on: [push, pull_request]
jobs:
  build:
    runs-on: [self-hosted, Windows, X64]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-dotnet@v4
        with: { dotnet-version: '8.0.x' }
      - run: dotnet restore
      - run: dotnet build --no-restore -c Release
      - run: dotnet test --no-build -c Release
      - run: dotnet publish src/Speak.App -c Release -r win-x64 --self-contained false
      - uses: actions/upload-artifact@v4
        with: { name: Speak-win-x64, path: src/Speak.App/bin/Release/*/publish/ }
```

## Когда использовать hosted вместо self-hosted

- Если ПК выключен надолго и нужно срочно проверить PR — добавь второй job с `runs-on: windows-latest` как fallback.

## Проверка что всё ок

```powershell
cd C:\actions-runner
./Run.cmd --check
Get-Service actions.runner.ttklon.speak.*
# в GitHub: Settings → Actions → Runners → зелёный Idle
gh api repos/ttklon/speak/actions/runners | ConvertFrom-Json | select name,status
```

---

*Далее — `04-AFTER-REBOOT.md`: чек-лист «вернулся после недели отсутствия».*
