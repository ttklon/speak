# Приёмник журналов ZSpeakly

Один Cloudflare Worker. Приложение отправляет сюда служебные события
(`POST /v1/events`), воркер вычищает персональные данные и складывает файл
в приватный репозиторий: `events/ГГГГ-ММ-ДД/<installId>-<суффикс>.json`.

## Что приходит

Только то, что нужно для починки:

| Поле | Пример |
| --- | --- |
| `level` | `error`, `warn`, `info` |
| `scope` | `stt`, `dictation`, `renderer`, `main` |
| `message` | `Распознавание не удалось` |
| `data` | `{ bytes: 96_000, model: "small", ms: 4200 }` |
| `stack` | первые строки стека |
| `app` | `{ version, platform, arch }` |
| `installId` | случайный uuid, не связан с человеком |

Никогда не отправляется: текст диктовки, содержимое буфера обмена, аудио,
выделенный текст, промпты, имена файлов. Почта, домашние пути и токены
заменяются на `<email>`, `<home>`, `<token>` — на стороне приложения,
и повторно здесь.

## Развернуть

```bash
cd server
npx wrangler deploy
npx wrangler secret put GITHUB_TOKEN   # fine-grained: Contents RW в ttklon/speak-logs
npx wrangler secret put LOGS_SECRET    # необязательно, общий секрет
```

Нужен приватный репозиторий `ttklon/speak-logs`. Ветка и репозиторий
меняются в `wrangler.toml` (`LOGS_REPO`, `LOGS_BRANCH`).

Адрес воркера должен совпадать с адресом в `electron/logger.cjs`
(`https://zspeakly-logs.ttklon.workers.dev/v1/events`) или задаваться
переменной окружения `ZSPEAKLY_LOG_ENDPOINT`.

## Проверить

```bash
curl -s https://zspeakly-logs.ttklon.workers.dev/health
curl -s -X POST https://zspeakly-logs.ttklon.workers.dev/v1/events \
  -H 'content-type: application/json' \
  -d '{"installId":"test","app":{"version":"1.4.1"},"events":[{"level":"error","scope":"stt","message":"проверка канала"}]}'
```

Ответ `{"ok":true,"stored":1}` означает, что событие легло в репозиторий.
Если канал не настроен, приложение всё равно работает: события лежат в
`%APPDATA%\ZSpeakly\logs\zspeakly.log` и их можно забрать кнопкой
«Диагностика → Скопировать ошибки».
