# 03-clone.ps1 — клонирует репо и переключает на твою рабочую ветку
# Запускай в ОБЫЧНОМ PowerShell (не обязательно админ), по одной команде!

# 1) Авторизуйся в GitHub (откроет браузер):
gh auth login
# ответы:
#   What account do you want to log into? → GitHub.com
#   What is your preferred protocol? → HTTPS
#   Authenticate Git with your credentials? → Yes
#   How would you like to authenticate? → Login with a web browser
#   Скопируй одноразовый код → вставь в браузере → Authorize

# 2) Проверь что вошёл:
gh auth status

# 3) Создай папку и клонируй:
mkdir C:\dev -Force
cd C:\dev
git clone https://github.com/ttklon/speak.git
cd C:\dev\speak

# 4) Переключись на рабочую ветку (ВАЖНО — именно её использует Arena):
git fetch origin
git checkout arena/c0441a45-speak
git status

# 5) Тестовый пуш (проверка записи):
echo "test $(Get-Date)" >> test-connection.txt
git add test-connection.txt
git commit -m "test: проверка связи ПК ↔ GitHub"
git push origin arena/c0441a45-speak
# если без ошибок — связь работает

# 6) Удали тестовый файл:
git rm test-connection.txt
git commit -m "chore: убрать тест"
git push

# 7) Собери проект (когда появится код):
dotnet restore
dotnet build -c Release
