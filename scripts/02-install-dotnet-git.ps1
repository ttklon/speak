# 02-install-dotnet-git.ps1 — ставит .NET SDK 8, Git, GitHub CLI
# Запускай в PowerShell ОТ ИМЕНИ АДМИНИСТРАТОРА, по одной строке!

winget --version
winget install Microsoft.DotNet.SDK.8 --silent --accept-package-agreements
winget install Git.Git --silent --accept-package-agreements
winget install GitHub.cli --silent --accept-package-agreements

# --- ПЕРЕЗАПУСТИ PowerShell и проверь ---
dotnet --version
git --version
gh --version

# --- Настрой Git (замени почту!) ---
git config --global user.name "ttklon"
git config --global user.email "твоя-почта@example.com"
git config --global init.defaultBranch main
git config --global pull.rebase false
git config --list --show-origin
