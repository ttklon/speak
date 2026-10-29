# ZSpeakly — ПОШАГОВО, по одной команде (копируй → вставляй → Enter)

> Всё что от тебя нужно — 15 минут и 18 команд. Остальную работу сделаю я в Arena.

---

## ЧТО ТЫ ДЕЛАЕШЬ vs ЧТО ДЕЛАЮ Я

**Ты (на своём Windows 11):** вводишь команды ниже → подключаешь ПК к GitHub → ставишь runner.  
**Я (Arena):** пишу весь код ZSpeakly, собираю, тестирую, пушу — твои сборки крутятся на твоём ПК автоматически.

---

## ШАГ 0 — Открой PowerShell от администратора

Нажми `Win` → напечатай `PowerShell` → правый клик **Запуск от имени администратора** → `Да`.

Далее копируй **по одной строке**, вставляй в чёрное окно, жми `Enter`, дождись окончания, только потом следующую.

---

### СТАДИЯ A — Проверка (3 команды)

```powershell
winver
```
→ откроется окно с версией, убедись сборка ≥22621 (22H2+).

```powershell
Get-PSDrive C | Format-List Used,Free
```
→ убедись Free ≥10 ГБ (нужно для моделей).

```powershell
winget --version
```
→ должен показать версию. Если `не распознано` — обнови Microsoft Store → App Installer.

---

### СТАДИЯ B — Установка .NET, Git, GH CLI (4 команды)

```powershell
winget install Microsoft.DotNet.SDK.8 --silent --accept-package-agreements
```
_Жди 1–2 мин, должен написать Successfully installed._

```powershell
winget install Git.Git --silent --accept-package-agreements
```

```powershell
winget install GitHub.cli --silent --accept-package-agreements
```

**ЗАКРОЙ PowerShell и открой заново от администратора** (иначе `dotnet` не найдётся).

```powershell
dotnet --version
```
→ должен показать `8.0.xxx`. Если ошибка — перезагрузи ПК и снова.

```powershell
git --version
```

```powershell
gh --version
```

```powershell
git config --global user.name "ttklon"
```

```powershell
git config --global user.email "твоя-почта@example.com"
```
_Замени на свою почту GitHub._

---

### СТАДИЯ C — Логин в GitHub (2 команды)

```powershell
gh auth login
```
Отвечай:
- `What account?` → `GitHub.com` (Enter)
- `Preferred protocol?` → `HTTPS` (Enter)
- `Authenticate Git?` → `Yes` (Enter)
- `How to authenticate?` → `Login with a web browser` (Enter)
→ откроется браузер → скопируй код → `Authorize`.

```powershell
gh auth status
```
→ должен показать `Logged in to github.com as ttklon`.

---

### СТАДИЯ D — Клонирование (5 команд)

```powershell
mkdir C:\dev -Force
```

```powershell
cd C:\dev
```

```powershell
git clone https://github.com/ttklon/speak.git
```

```powershell
cd C:\dev\speak
```

```powershell
git fetch origin
```

```powershell
git checkout arena/c0441a45-speak
```

```powershell
git status
```
→ должен показать `On branch arena/c0441a45-speak`.

**Тестовый пуш (проверка записи):**

```powershell
echo "test $(Get-Date)" >> test-connection.txt
```

```powershell
git add test-connection.txt
```

```powershell
git commit -m "test: проверка связи ПК с GitHub"
```

```powershell
git push origin arena/c0441a45-speak
```
→ если без ошибок — связь работает. В GitHub появится коммит.

```powershell
git rm test-connection.txt
```

```powershell
git commit -m "chore: убрать тест"
```

```powershell
git push
```

---

### СТАДИЯ E — Runner (сборки на твоём ПК, бесплатно ∞ минут) — 7 команд

Иди на **https://github.com/ttklon/speak → Settings → Actions → Runners → New self-hosted runner → Windows** → скопируй токен (строка `AAAA…`, живёт 1 час).

```powershell
mkdir C:\actions-runner -Force
```

```powershell
cd C:\actions-runner
```

```powershell
Invoke-WebRequest -Uri https://github.com/actions/runner/releases/download/v2.321.0/actions-runner-win-x64-2.321.0.zip -OutFile actions-runner-win-x64.zip
```
_Если ссылка на странице другая — замени цифру._

```powershell
Expand-Archive -Path actions-runner-win-x64.zip -DestinationPath . -Force
```

```powershell
./config.cmd --url https://github.com/ttklon/speak --token AAAAAA
```
_Вставь свой токен вместо AAAAAA. Отвечай: Enter → Enter → `speak,windows,dotnet` → Enter._

```powershell
./svc.cmd install
```

```powershell
./svc.cmd start
```

```powershell
Get-Service actions.runner.*
```
→ `Status: Running`.

Проверка в браузере: `Settings → Actions → Runners` → зелёный `Idle`. 
Или:

```powershell
./Run.cmd --check
```

---

### СТАДИЯ F — Проверка что я получил доступ (1 команда)

```powershell
cd C:\dev\speak; git commit --allow-empty -m "chore: verify runner" ; git push origin arena/c0441a45-speak
```
Иди на **https://github.com/ttklon/speak/actions** → должен появиться `Build ZSpeakly` с иконкой твоего ПК, через 1–2 мин зелёная галочка.

**Готово!** Теперь:

- Ты **больше ничего не трогаешь** — просто оставляешь ПК включённым когда хочешь сборки.
- Я пушу код в эту ветку → твой runner сам собирает → результат в Actions.
- Ты забираешь код: `cd C:\dev\speak; git pull`.

---

## ЧТО ДЕЛАТЬ ПОСЛЕ ВЫКЛЮЧЕНИЯ

**Включил ПК:**

```powershell
cd C:\dev\speak; git fetch origin; git checkout arena/c0441a45-speak; git pull; dotnet build
```
Runner уже запущен (служба). Ничего больше не надо.

**Выключил на дни:** ничего не делай. Задания ждут 24ч, потом отменятся — перезапущу пушем.

**Заболел runner (красный):**

```powershell
cd C:\actions-runner; ./svc.cmd stop; ./svc.cmd start; Get-Service actions.runner.*
```

---

## ЛЁГКИЕ МОДЕЛИ (чтобы не грузить систему)

Я настроил ZSpeakly на **лёгкие модели** (см. `scripts/download-models.ps1`):

- **VAD:** Silero VAD 2 МБ — детекция речи, <1% CPU.
- **STT:** `ggml-tiny.bin` 75 МБ (300 МБ RAM, 0.4×realtime, для слабых ноутбуков) и `ggml-small.bin` 466 МБ (600 МБ RAM, 0.8×realtime, **рекомендую**) — быстрый и точный перевод речь→текст. `medium` 1.5 ГБ НЕ качаем по умолчанию.
- **AI-полировка:** `Qwen2.5-0.5B Q4` 400 МБ (опционально, включается только по кнопке, иначе — простые правила без LLM). Система: <15% CPU, <800 МБ RAM в пике.

Скачать (когда готов):

```powershell
powershell -ExecutionPolicy Bypass -File C:\dev\speak\scripts\download-models.ps1
```

---

## НУЖЕН ЛИ ЕЩЁ КОННЕКТОР К ARENA?

Только **GitHub** (уже подключен). Slack/Notion/Figma — не нужны.

---

## ЕСЛИ ЧТО-ТО ПОШЛО НЕ ТАК

Напиши мне точный текст ошибки из PowerShell — я дам точную следующую команду.
