# Подключение твоего Windows-ПК к GitHub и к Arena (пошагово в PowerShell)

> Цель: чтобы ты писал код в Arena (в браузере), а собирался и тестировался он у тебя на Windows 11 дома. И чтобы после выключения на неделю всё вернулось одной командой.

---

## 1. Что нужно один раз приготовить (15 минут)

### 1.1 Открой PowerShell от имени администратора

Нажми `Win` → напечатай `PowerShell` → правый клик «Запуск от имени администратора».

Проверка Windows 11:
```powershell
winver
systeminfo | findstr /C:"OS Version"
Get-ComputerInfo | select WindowsProductName, WindowsVersion, OsHardwareAbstractionLayer
```

### 1.2 Установи базовые инструменты (всё бесплатно)

```powershell
# winget уже есть в Windows 11. Обнови его:
winget --version

# .NET SDK 8.0 LTS (обязателен для сборки)
winget install Microsoft.DotNet.SDK.8 --silent --accept-package-agreements

# Git + GitHub CLI
winget install Git.Git --silent
winget install GitHub.cli --silent

# VS Code (или Visual Studio Community — выбери одно)
winget install Microsoft.VisualStudioCode --silent

# Перезапусти PowerShell и проверь:
dotnet --version        # должно показать 8.0.xxx
git --version
gh --version
code --version
```

### 1.3 Настрой Git (один раз)

```powershell
git config --global user.name "ttklon"
git config --global user.email "твоя-почта@example.com"
git config --global init.defaultBranch main
git config --global pull.rebase false
```

---

## 2. Подключи GitHub к этому ПК (2 минуты)

### Вариант A — через GitHub CLI (рекомендуется, самый лёгкий):

```powershell
gh auth login
# Ответы:
# ? What account do you want to log into?  → GitHub.com
# ? What is your preferred protocol?        → HTTPS
# ? Authenticate Git with your GitHub credentials? → Yes
# ? How would you like to authenticate?     → Login with a web browser
# Откроется браузер → вставь одноразовый код → Authorize
```

Проверка:
```powershell
gh auth status
gh repo view ttklon/speak --web   # откроет репо в браузере
```

### Вариант B — через PAT (если CLI не пускает):

1. Зайди на https://github.com/settings/tokens → Generate new token (classic) → выбери `repo`, `workflow`, `read:org` → Generate → скопируй `ghp_xxxx`.
2. В PowerShell:
```powershell
git clone https://github.com/ttklon/speak.git C:\dev\speak
cd C:\dev\speak
# при первом push Git спросит логин/пароль → вставь PAT как пароль
```

### Клонируй репо:

```powershell
mkdir C:\dev -Force
cd C:\dev
git clone https://github.com/ttklon/speak.git
cd C:\dev\speak
git remote -v                      # должен показать origin ttklon/speak
git checkout arena/c0441a45-speak  # твоя рабочая ветка
git status
```

### Первый тестовый пуш:

```powershell
echo "test $(Get-Date)" >> test.txt
git add test.txt
git commit -m "test: проверка подключения"
git push origin arena/c0441a45-speak
# если прошло без ошибок — подключение работает
git rm test.txt
git commit -m "chore: убрать тест"
git push
```

---

## 3. Подключи Arena к GitHub (чтобы Arena могла пушить)

Ты уже на ветке `arena/c0441a45-speak` — Arena меняет код прямо в GitHub.

1. В Arena: Connect → GitHub → Authorize → выбери `ttklon/speak` → дай доступ.
2. В репо на GitHub: Settings → Branches → поставь защиту на `main` (Require PR) — чтобы случайно не сломать.
3. Работай так: Arena пушит в `arena/c0441a45-speak` → ты на ПК делаешь `git pull` → собираешь → пушишь → Arena видит.

Двусторонняя синхронизация:
```powershell
# На ПК, чтобы забрать изменения из Arena:
cd C:\dev\speak
git fetch origin
git checkout arena/c0441a45-speak
git pull origin arena/c0441a45-speak

# Чтобы отправить свои изменения в Arena:
git add .
git commit -m "feat: добавил ..."
git push origin arena/c0441a45-speak
```

---

## 4. Установи self-hosted runner (чтобы GitHub собирал на твоём ПК бесплатно)

**Зачем:** GitHub Actions на твоём ПК = ∞ минут, доступ к микрофону/звуку, сборка без очереди. Выключаешь ПК — задания копятся 24 часа в очереди, потом отменяются (не страшно).

**Где взять:** репо → Settings → Actions → Runners → New self-hosted runner → Windows → покажет команды с токеном. Делай так:

```powershell
# 1. Создай папку для runner
mkdir C:\actions-runner -Force
cd C:\actions-runner

# 2. Скачай runner (ссылка из GitHub — пример, замени на свою!)
Invoke-WebRequest -Uri https://github.com/actions/runner/releases/download/v2.321.0/actions-runner-win-x64-2.321.0.zip -OutFile actions-runner-win-x64.zip
Expand-Archive -Path actions-runner-win-x64.zip -DestinationPath . -Force

# 3. Настрой (токен скопируй из GitHub Settings → Runners → New runner)
./config.cmd --url https://github.com/ttklon/speak --token AAAAAA

# Ответы:
# ? Enter the name of the runner group → [Enter] (Default)
# ? Enter the name of runner → [Enter] (имя ПК) или Speak-PC
# ? Enter any additional labels → speak,windows,dotnet
# ? Enter name of work folder → [Enter] (_work)

# 4. Запусти как сервис (чтобы работал после перезагрузки)
./svc.sh install   # или .\svc.cmd install
./svc.sh start     # или .\svc.cmd start
# Проверка: services.msc → Actions Runner ... → Running
```

**Проверка:**
```powershell
# В GitHub: Settings → Actions → Runners → должен быть зелёный Idle
# Локально:
Get-Service actions.runner.*
cd C:\actions-runner
./Run.cmd --check   # диагностика
```

**Использование в workflow:** в `.github/workflows/build.yml` укажи:
```yaml
runs-on: self-hosted  # вместо windows-latest
# или
runs-on: [self-hosted, Windows, X64]
```

Теперь каждый `git push` будет собираться на твоём ПК. Логи смотришь в GitHub → Actions.

---

## 5. Горячие команды на каждый день

**Утром включил ПК:**
```powershell
cd C:\dev\speak
git fetch --all
git checkout arena/c0441a45-speak
git pull
dotnet build
# runner уже запущен как сервис — ничего делать не надо
```

**Вечером выключил ПК:** ничего не делай. Задания в GitHub подождут 24 часа, потом отменятся — просто запушишь снова утром.

**Arena что-то поменяла, пока ты спал:**
```powershell
git pull   # заберёт её коммиты
dotnet build
```

**Ты что-то поменял локально:**
```powershell
git add .
git commit -m "feat: ..."
git push origin arena/c0441a45-speak
# Arena увидит пуш через 10–30 секунд
```

---

## 6. Частые проблемы

| Проблема | Решение |
|---|---|
| `dotnet: command not found` | Перезапусти PowerShell, проверь PATH: `where dotnet` |
| `gh auth login` не открывает браузер | Используй PAT-вариант (раздел 2B) |
| Runner оффлайн (красный) | `cd C:\actions-runner; ./svc.sh status; ./svc.sh start` |
| `git push` просит пароль | `gh auth setup-git` или вставь PAT заново |
| Брандмауэр блокирует runner | Разреши `C:\actions-runner\run.cmd` в Windows Firewall |
| После обновления Windows runner не стартует | `cd C:\actions-runner; ./svc.sh stop; ./svc.sh start` |

---

*Следующий документ — `03-SELF-HOSTED-RUNNER.md` с продвинутыми настройками и лимитами GitHub Actions.*
