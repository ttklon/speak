/**
 * Приёмник журналов ZSpeakly (Cloudflare Worker).
 *
 * Приложение отправляет сюда только служебные события: уровень, область,
 * сообщение, стек, версия, ОС. Текст диктовки, буфер обмена, имена файлов и
 * почта вычищаются ещё на стороне приложения (electron/logger.cjs),
 * а здесь повторно проверяются — на всякий случай.
 *
 * Хранилище — приватный репозиторий на GitHub, по одному файлу в сутки:
 *   events/YYYY-MM-DD/<installId>-<случайный суффикс>.json
 * Так логи можно читать сразу через веб-интерфейс, без своей базы.
 */

const ENDPOINT = '/v1/events';
const MAX_BATCH = 200; // событий за один запрос
const MAX_BYTES = 256 * 1024; // размер тела

// Поля, которых в журнале быть не должно ни при каких условиях.
const FORBIDDEN = /^(text|transcript|pcm|audio|clipboard|word|prompt|selection|content|body|message_text)$/i;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // приложение шлёт запрос с file:// и app:// — нужен CORS
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type, x-zs-secret',
      'access-control-allow-methods': 'POST, OPTIONS',
      'cache-control': 'no-store',
    },
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

function fileName(installId) {
  const safe = String(installId || 'unknown').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 40) || 'unknown';
  const stamp = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 6);
  return `${safe}-${stamp}-${rnd}.json`;
}

/** Кладёт батч в приватный репозиторий по одному файлу. */
async function storeToGitHub(env, batch) {
  const repo = env.LOGS_REPO;
  const token = env.GITHUB_TOKEN;
  if (!repo || !token) return { ok: false, reason: 'хранилище не настроено' };
  const day = new Date().toISOString().slice(0, 10);
  const path = `events/${day}/${fileName(batch.installId)}`;
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return json({ ok: true });
    if (url.pathname !== ENDPOINT) {
      if (url.pathname === '/' || url.pathname === '/health') {
        return json({ ok: true, service: 'zspeakly-logs', endpoint: ENDPOINT });
      }
      return json({ ok: false, error: 'не найдено' }, 404);
    }
    if (request.method !== 'POST') return json({ ok: false, error: 'только POST' }, 405);

    // Необязательный общий секрет: если он задан, приложение должно его прислать.
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

    const stored = await storeToGitHub(env, batch);
    return json(
      { ok: stored.ok, stored: stored.ok ? events.length : 0, reason: stored.reason },
      stored.ok ? 200 : 503,
    );
  },
};
