# 04a-fix-runner-version.ps1 — ЧИНИТ ошибку "runner version is out of date (need 2.329.0)" и 404
# Запускай в PowerShell ОТ ИМЕНИ АДМИНИСТРАТОРА, по одной команде сверху вниз!
# Ошибка была из-за старой версии 2.321.0 — GitHub с февраля 2026 не принимает её.

# 0) Иди в папку runner:
cd C:\actions-runner

# 1) Останови службу если она уже стоит:
./svc.cmd stop

# 2) Удали службу:
./svc.cmd uninstall

# 3) Удали старую конфигурацию (если раньше делал config, вставь СТАРЫЙ токен если спросит, иначе просто Enter):
./config.cmd remove --token AAAAAA

# 4) Удали старые файлы (оставляем только папку):
Remove-Item -Force -Recurse _work -ErrorAction SilentlyContinue
Remove-Item -Force actions-runner-win-x64.zip -ErrorAction SilentlyContinue
Remove-Item -Force -Recurse bin, externals -ErrorAction SilentlyContinue
Remove-Item -Force config.cmd, run.cmd, svc.cmd, Run.cmd -ErrorAction SilentlyContinue
# Проще — удали всё кроме .credentials если хочешь чистую установку:
# Remove-Item -Force -Recurse C:\actions-runner\* -ErrorAction SilentlyContinue

# 5) Скачай НОВЫЙ runner 2.338.2 (минимум 2.329.0):
Invoke-WebRequest -Uri https://github.com/actions/runner/releases/download/v2.338.2/actions-runner-win-x64-2.338.2.zip -OutFile actions-runner-win-x64.zip

# 6) Распакуй:
Expand-Archive -Path actions-runner-win-x64.zip -DestinationPath . -Force

# 7) Сгенерируй НОВЫЙ токен: https://github.com/ttklon/speak → Settings → Actions → Runners → New self-hosted runner → Windows → скопируй токен

# 8) Настрой заново (ВСТАВЬ НОВЫЙ ТОКЕН):
./config.cmd --url https://github.com/ttklon/speak --token AAAAAA
#   Runner group → Enter (Default)
#   Runner name  → Enter или ZSpeakly-PC
#   Labels       → speak,windows,dotnet → Enter
#   Work folder  → Enter (_work)

# 9) Установи службу:
./svc.cmd install

# 10) Запусти:
./svc.cmd start

# 11) Проверь:
Get-Service actions.runner.*
./Run.cmd --check
gh api repos/ttklon/speak/actions/runners --jq '.runners[] | {name:.name, status:.status, busy:.busy, version:.version}'
# должен показать status=online, busy=false, version=2.338.2
