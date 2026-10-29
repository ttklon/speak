# Что делать после включения ПК / после перерыва (шпаргалка)

## Если выключил на 1–2 дня

1. Включи ПК, дождись загрузки (runner стартует сам как служба).
2. Открой PowerShell:
```powershell
cd C:\dev\speak
git fetch origin
git checkout arena/c0441a45-speak
git pull
dotnet build
```
3. Открой GitHub → Actions → проверь что последний коммит зелёный. Если красный «Queued timeout» — перезапусти:
```powershell
git commit --allow-empty -m "chore: retrigger after downtime"
git push origin arena/c0441a45-speak
```

## Если выключил на неделю+

Дополнительно:
```powershell
# обнови .NET и runner
winget upgrade Microsoft.DotNet.SDK.8
cd C:\actions-runner
./svc.cmd stop
# скачай свежую версию runner если GitHub просит
./svc.cmd start
dotnet restore
dotnet build
```

## Если Arena пушила пока ты спал

```powershell
git stash   # если у тебя были незакоммиченные изменения
git pull --rebase origin arena/c0441a45-speak
git stash pop
# разреши конфликты если есть, затем:
dotnet build
git push
```

## Если GitHub просит переавторизацию

```powershell
gh auth status
gh auth login   # заново
gh auth setup-git
```

## Если нужно заново клонировать

```powershell
cd C:\dev
Remove-Item -Recurse -Force speak   # только если уверен
gh repo clone ttklon/speak
cd speak
git checkout arena/c0441a45-speak
dotnet restore
```

---

*Всегда держи runner в автозапуске: `services.msc` → `Actions Runner ...` → Startup type: Automatic.*
