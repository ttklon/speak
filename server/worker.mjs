/**
 * Приёмник журналов ZSpeakly (Cloudflare Worker).
 *
 * Приложение отправляет сюда только служебные события: уровень, область,
 * сообщение, стек, версию, ОС. Текст диктовки, содержимое буфера обмена,
 * аудио и почта вычищаются ещё на стороне приложения (electron/logger.cjs),
 * а здесь проверяются повторно — на всякий случай.
 *
 * Хранилище — собственное, внутри воркера (Durable Object + SQLite).
 * Отдельный репозиторий, база и аккаунт НЕ нужны: `npx wrangler deploy`
 * и всё. Читать журналы можно двумя способами:
 *   • GET /admin?key=<LOGS_SECRET> — страница со списком событий;
 *   • GET /v1/events?key=<LOGS_SECRET> — те же данные как JSON.
 *
 * Если задать секрет GITHUB_TOKEN, копия дополнительно уйдёт в репозиторий
 * (для тех, кто уже так делает) — но это полностью необязательно.
 */

const ENDPOINT = '/v1/events';
const MAX_BATCH = 200; // событий за один запрос
const MAX_BYTES = 256 * 1024; // размер тела
const KEEP_DAYS = 30; // сколько храним события
const KEEP_ROWS = 20000; // жёсткий потолок, чтобы хранилище не росло вечно

// Поля, которых в журнале быть не должно ни при каких условиях.
const FORBIDDEN = /^(text|transcript|pcm|audio|clipboard|word|prompt|selection|content|body|message_text)$/i;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type, x-zs-secret',
  'access-control-allow-methods': 'POST, GET, OPTIONS',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS, 'cache-control': 'no-store' },
  });
}

/** Убирает персональные данные из строки: почта, домашние пути, токены. */
export function scrubString(value) {
  return String(value ?? '')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')
    .replace(/[A-Za-z]:\\Users\\[^\\/\s]+/gi, '<home>')
    .replace(/\/home\/[^/\s]+/g, '<home>')
    .replace(/\/Users\/[^/\s]+/g, '<home>')
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/g, '<token>')
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, '<hex>');
}

function scrub(value, depth = 0) {
  if (depth > 4) return null;
  if (value === null || value === undefined) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return scrubString(value).slice(0, 2000);
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => scrub(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      if (FORBIDDEN.test(key)) continue;
      out[key] = scrub(val, depth + 1);
    }
    return out;
  }
  return null;
}

export function normaliseEvent(raw = {}) {
  const level = ['debug', 'info', 'warn', 'error'].includes(raw.level) ? raw.level : 'info';
  return {
    at: typeof raw.at === 'number' ? raw.at : Date.now(),
    level,
    scope: scrubString(raw.scope || 'app').slice(0, 40),
    message: scrubString(raw.message || '').slice(0, 1000),
    data: raw.data ? scrub(raw.data) : undefined,
    stack: raw.stack ? scrubString(raw.stack).slice(0, 4000) : undefined,
  };
}

/** Тело запроса → массив проверенных событий. */
export function parseBatch(payload) {
  const list = Array.isArray(payload?.events) ? payload.events : [];
  return list.slice(0, MAX_BATCH).map(normaliseEvent).filter((e) => e.message || e.stack);
}

/* ─────────────────────────── хранилище ─────────────────────────── */

/**
 * Журнал в Durable Object с SQLite-хранилищем: одна «комната» на установку.
 * Так данные лежат у самого воркера — ни репозитория, ни внешней базы.
 */
export class LogStore {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sql = null;
  }

  async db() {
    if (this.sql) return this.sql;
    // sql.exec доступен в новых рантаймах; на старых падаем в обычное KV
    try {
      this.sql = this.state.storage.sql;
      this.sql.exec(
        `CREATE TABLE IF NOT EXISTS events (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           at INTEGER NOT NULL,
           level TEXT NOT NULL,
           scope TEXT NOT NULL,
           message TEXT NOT NULL,
           data TEXT,
           stack TEXT,
           install TEXT,
           version TEXT
         )`,
      );
      this.sql.exec('CREATE INDEX IF NOT EXISTS idx_events_at ON events (at)');
    } catch {
      this.sql = null;
    }
    return this.sql;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const action = url.pathname.replace(/^\/+/, '') || 'list';

    if (request.method === 'POST' && action === 'append') {
      const batch = await request.json();
      const sql = await this.db();
      if (!sql) {
        // без SQLite: держим последние 2000 записей в обычном хранилище
        const prev = (await this.state.storage.get('events')) || [];
        const next = [...batch.events.map((e) => ({ ...e, install: batch.installId, version: batch.app?.version })), ...prev]
          .slice(0, 2000);
        await this.state.storage.put('events', next);
        return json({ ok: true, stored: batch.events.length, backend: 'kv' });
      }
      for (const e of batch.events) {
        sql.exec(
          'INSERT INTO events (at, level, scope, message, data, stack, install, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          e.at,
          e.level,
          e.scope,
          e.message,
          e.data ? JSON.stringify(e.data) : null,
          e.stack || null,
          batch.installId,
          batch.app?.version || '',
        );
      }
      // Чистка: старше KEEP_DAYS и всё, что выше потолка
      const cutoff = Date.now() - KEEP_DAYS * 86400000;
      sql.exec('DELETE FROM events WHERE at < ?', cutoff);
      sql.exec(
        'DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT ?)',
        KEEP_ROWS,
      );
      return json({ ok: true, stored: batch.events.length, backend: 'sqlite' });
    }

    if (request.method === 'GET' && action === 'list') {
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 100, 1), 500);
      const onlyErrors = url.searchParams.get('level') === 'error';
      const sql = await this.db();
      if (!sql) {
        const prev = (await this.state.storage.get('events')) || [];
        const rows = onlyErrors ? prev.filter((e) => e.level === 'error') : prev;
        return json({ ok: true, backend: 'kv', events: rows.slice(0, limit) });
      }
      const rows = onlyErrors
        ? sql.exec('SELECT * FROM events WHERE level = ? ORDER BY id DESC LIMIT ?', 'error', limit).toArray()
        : sql.exec('SELECT * FROM events ORDER BY id DESC LIMIT ?', limit).toArray();
      return json({
        ok: true,
        backend: 'sqlite',
        events: rows.map((r) => ({
          at: r.at,
          level: r.level,
          scope: r.scope,
          message: r.message,
          data: r.data ? safeJson(r.data) : undefined,
          stack: r.stack || undefined,
          install: r.install,
          version: r.version,
        })),
      });
    }

    if (request.method === 'POST' && action === 'clear') {
      const sql = await this.db();
      if (sql) sql.exec('DELETE FROM events');
      else await this.state.storage.put('events', []);
      return json({ ok: true });
    }

    return json({ ok: false, error: 'неизвестное действие' }, 404);
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/* ─────────────────── необязательная копия в GitHub ─────────────────── */

async function storeToGitHub(env, batch) {
  const repo = env.LOGS_REPO;
  const token = env.GITHUB_TOKEN;
  if (!repo || !token) return { ok: false, skipped: true };
  const day = new Date().toISOString().slice(0, 10);
  const safe = String(batch.installId || 'unknown').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 40) || 'unknown';
  const path = `events/${day}/${safe}-${Date.now().toString(36)}.json`;
  const body = JSON.stringify(batch, null, 2);
  const res = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'zspeakly-logs',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      message: `logs: ${batch.events.length} events from ${batch.app?.version || '?'}`,
      content: btoa(unescape(encodeURIComponent(body))),
      branch: env.LOGS_BRANCH || 'main',
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, reason: `github ${res.status}: ${text.slice(0, 160)}` };
  }
  return { ok: true, path };
}

/* ───────────────────────── служебные страницы ───────────────────────── */

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

/** Страница для чтения журналов: /admin?key=<LOGS_SECRET>. */
function adminPage(key, events, error) {
  const rows = events
    .map(
      (e) => `<tr class="lvl-${escapeHtml(e.level)}">
        <td class="t">${escapeHtml(new Date(e.at).toLocaleString('ru-RU'))}</td>
        <td>${escapeHtml(e.level)}</td>
        <td class="s">${escapeHtml(e.scope)}</td>
        <td><b>${escapeHtml(e.message)}</b>${
          e.data ? `<div class="d">${escapeHtml(JSON.stringify(e.data))}</div>` : ''
        }${e.stack ? `<pre>${escapeHtml(e.stack)}</pre>` : ''}</td>
        <td class="s">${escapeHtml(e.version || '')}<br />${escapeHtml((e.install || '').slice(0, 8))}</td>
      </tr>`,
    )
    .join('');
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8" />
<title>Журналы ZSpeakly</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; padding:20px; background:#15161a; color:#e7e8ec;
         font:13px/1.5 system-ui, "Segoe UI", sans-serif; }
  h1 { font-size:17px; margin:0 0 4px; }
  p.sub { color:#9a9ba5; margin:0 0 16px; font-size:12px; }
  form { margin:0 0 14px; }
  input { background:#22242a; border:1px solid #33363e; color:#e7e8ec;
          padding:7px 10px; border-radius:7px; width:260px; }
  button { background:#3d6fd4; border:0; color:#fff; padding:7px 12px;
           border-radius:7px; cursor:pointer; }
  table { width:100%; border-collapse:collapse; font-size:12px; }
  th, td { text-align:left; padding:7px 8px; border-bottom:1px solid #262830; vertical-align:top; }
  th { color:#9a9ba5; font-weight:500; }
  td.t { white-space:nowrap; color:#9a9ba5; font-variant-numeric:tabular-nums; }
  td.s { color:#7f8698; white-space:nowrap; }
  .d { color:#8f93a3; font-size:11px; margin-top:2px; }
  pre { margin:4px 0 0; color:#a4a8b6; font-size:11px; white-space:pre-wrap; max-height:120px; overflow:auto; }
  tr.lvl-error { background:rgba(229,72,77,.12); }
  tr.lvl-warn { background:rgba(217,163,58,.09); }
  .empty, .err { padding:24px; text-align:center; color:#9a9ba5; }
  .err { color:#e5484d; }
</style></head><body>
<h1>Журналы ZSpeakly</h1>
<p class="sub">Только служебные события: ошибки, предупреждения, версия и состояние движка. Текста диктовки и личных данных здесь нет.</p>
<form method="get" action="/admin">
  <input name="key" type="password" placeholder="ключ доступа" value="${escapeHtml(key || '')}" />
  <input name="level" type="hidden" value="" />
  <button type="submit">Показать</button>
</form>
${error ? `<div class="err">${escapeHtml(error)}</div>` : ''}
${
  events.length
    ? `<table><thead><tr><th>когда</th><th>уровень</th><th>область</th><th>событие</th><th>версия</th></tr></thead><tbody>${rows}</tbody></table>`
    : error
      ? ''
      : '<div class="empty">Событий пока нет.</div>'
}
</body></html>`;
}

/* ───────────────────────────── маршруты ───────────────────────────── */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    // ключ читателя: LOGS_SECRET (если задан). Без него страница открыта —
    // при первом развёртывании так проще, но лучше задать.
    const keyFromRequest = url.searchParams.get('key') || request.headers.get('x-zs-secret') || '';
    const readerOk = !env.LOGS_SECRET || keyFromRequest === env.LOGS_SECRET;

    if (url.pathname === '/' || url.pathname === '/health') {
      return json({
        ok: true,
        service: 'zspeakly-logs',
        endpoint: ENDPOINT,
        storage: env.LOGS ? 'durable-object' : 'none',
        readerKey: Boolean(env.LOGS_SECRET),
      });
    }

    if (url.pathname === '/admin') {
      if (!readerOk) {
        return new Response(adminPage('', [], 'Неверный ключ доступа.'), {
          status: 401,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
      if (!env.LOGS) {
        return new Response(adminPage('', [], 'Хранилище не подключено: нужен биндинг LOGS в wrangler.toml.') , {
          status: 500,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
      try {
        const room = env.LOGS.get(env.LOGS.idFromName('journal'));
        const res = await room.fetch('https://log-store/list?limit=200');
        const data = await res.json();
        return new Response(adminPage(keyFromRequest, data.events || [], ''), {
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
        });
      } catch (err) {
        return new Response(adminPage(keyFromRequest, [], `Ошибка хранилища: ${String(err?.message || err)}`), {
          status: 500,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
    }

    if (url.pathname !== ENDPOINT) return json({ ok: false, error: 'не найдено' }, 404);

    // Приём: необязательный секрет (если задан — приложение должно его прислать)
    if (request.method === 'POST') {
      if (env.LOGS_SECRET && request.headers.get('x-zs-secret') !== env.LOGS_SECRET) {
        return json({ ok: false, error: 'нет доступа' }, 401);
      }

      const raw = await request.text();
      if (raw.length > MAX_BYTES) return json({ ok: false, error: 'слишком большой пакет' }, 413);

      let payload;
      try {
        payload = JSON.parse(raw);
      } catch {
        return json({ ok: false, error: 'некорректный JSON' }, 400);
      }

      const events = parseBatch(payload);
      if (!events.length) return json({ ok: true, stored: 0 });

      const batch = {
        receivedAt: new Date().toISOString(),
        installId: scrubString(payload?.installId || 'unknown').slice(0, 40),
        app: scrub(payload?.app || {}),
        events,
      };

      let stored = { ok: false, reason: 'хранилище не подключено' };
      if (env.LOGS) {
        try {
          const room = env.LOGS.get(env.LOGS.idFromName('journal'));
          const res = await room.fetch('https://log-store/append', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(batch),
          });
          stored = await res.json();
        } catch (err) {
          stored = { ok: false, reason: String(err?.message || err) };
        }
      }

      // Копия в репозиторий — только если явно настроена
      const mirror = await storeToGitHub(env, batch).catch(() => ({ ok: false }));

      const ok = Boolean(stored.ok || mirror.ok);
      return json(
        {
          ok,
          stored: stored.ok ? events.length : 0,
          backend: stored.backend || '',
          mirrored: Boolean(mirror.ok),
          reason: ok ? '' : stored.reason || mirror.reason || '',
        },
        ok ? 200 : 503,
      );
    }

    // Чтение как JSON (для себя и для скриптов)
    if (request.method === 'GET') {
      if (!readerOk) return json({ ok: false, error: 'нет доступа' }, 401);
      if (!env.LOGS) return json({ ok: false, error: 'хранилище не подключено' }, 500);
      const room = env.LOGS.get(env.LOGS.idFromName('journal'));
      const res = await room.fetch(`https://log-store/list?limit=${url.searchParams.get('limit') || 100}`);
      return new Response(res.body, {
        status: res.status,
        headers: { 'content-type': 'application/json; charset=utf-8', ...CORS, 'cache-control': 'no-store' },
      });
    }

    return json({ ok: false, error: 'только POST и GET' }, 405);
  },
};
