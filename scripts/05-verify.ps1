# 05-verify.ps1 — финальная проверка что всё работает

# 1) Версии:
dotnet --info
gh auth status
git --version

# 2) Репо и ветка:
cd C:\dev\speak
git status
git branch --show-current
git log --oneline -3

# 3) Сборка:
dotnet restore
dotnet build -c Release -v minimal

# 4) Runner:
Get-Service actions.runner.*
cd C:\actions-runner
./Run.cmd --check

# 5) Проверь GitHub Actions:
gh api repos/ttklon/speak/actions/runners | ConvertFrom-Json | Select-Object name, status, busy
# должен показать busy=false, status=online

# 6) Сделай пустой коммит чтобы проверить что Actions запустится на твоём ПК:
cd C:\dev\speak
git commit --allow-empty -m "chore: verify runner"
git push origin arena/c0441a45-speak
# иди на https://github.com/ttklon/speak/actions → должен появиться зелёный Build ZSpeakly на self-hosted
