# 04-runner-install.ps1 — ставит self-hosted runner (сборки на ТВОЁМ ПК, ∞ минут бесплатно)
# Запускай в PowerShell ОТ ИМЕНИ АДМИНИСТРАТОРА, по одной команде!
# Токен бери из: https://github.com/ttklon/speak → Settings → Actions → Runners → New self-hosted runner → Windows
# На той странице GitHub покажет ТВОЙ токен (начинается на AXXXX). Скопируй его.

# 1) Создай папку runner:
mkdir C:\actions-runner -Force
cd C:\actions-runner

# 2) Скачай runner (версия 2.321.0 — актуальна на окт 2026; если на странице другая — замени цифру):
Invoke-WebRequest -Uri https://github.com/actions/runner/releases/download/v2.321.0/actions-runner-win-x64-2.321.0.zip -OutFile actions-runner-win-x64.zip

# 3) Распакуй:
Expand-Archive -Path actions-runner-win-x64.zip -DestinationPath . -Force

# 4) Настрой (ВСТАВЬ СВОЙ ТОКЕН вместо AAAAAA):
./config.cmd --url https://github.com/ttklon/speak --token AAAAAA
# ответы:
#   Enter the name of the runner group → жми Enter (Default)
#   Enter the name of runner → жми Enter (имя ПК) или впиши ZSpeakly-PC
#   Enter any additional labels → впиши: speak,windows,dotnet  → Enter
#   Enter name of work folder → жми Enter (_work)

# 5) Установи как службу (автозапуск после перезагрузки):
./svc.cmd install

# 6) Запусти службу:
./svc.cmd start

# 7) Проверь:
Get-Service actions.runner.*
./Run.cmd --check
# В GitHub: Settings → Actions → Runners → должен быть зелёный Idle

# --- Как удалить/переустановить (если нужно) ---
# cd C:\actions-runner
# ./svc.cmd stop
# ./svc.cmd uninstall
# ./config.cmd remove --token СТАРЫЙ_ТОКЕН

# --- Как обновить токен (истекает через ~час после генерации) ---
# Просто заново сгенерируй на странице Runners и повтори шаг 4
