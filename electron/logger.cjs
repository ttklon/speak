/**
 * Логи и диагностика ZSpeakly.
 *
 * Идея: приложение офлайн, но ошибки надо как-то видеть. Поэтому есть
 * обычный локальный журнал (файл + кольцевой буфер в памяти) и НЕОБЯЗАТЕЛЬНАЯ
 * отправка в приёмник — по умолчанию включена, выключается одним тумблером.
 *
 * Что уходит наружу:
 *  • уровень и текст события (сообщение об ошибке, стек),
 *  • версия приложения, канал обновлений, платформа, состояние движка
 *    распознавания (есть/нет bin и модели),
 *  • случайный идентификатор установки (не аккаунт, генерируется локально).
 *
 * Что НЕ уходит никогда:
 *  • распознанный текст, содержимое буфера обмена, словарь,
 *  • имя пользователя, пути к домашней папке, содержимое аудио.
 *
 * Все строки перед записью и отправкой проходят через `redact()`.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

// Куда отправлять журналы. Меняется из «Настройки → Диагностика»,
// переменной окружения ZSPEAKLY_LOG_ENDPOINT или остаётся по умолчанию.
const DEFAULT_ENDPOINT = 'https://zspeakly-logs.ttklon.workers.dev/v1/events';

const MAX_MEMORY = 400; // событий в памяти
const MAX_FILE_BYTES = 512 * 1024; // на диске держим не больше полумегабайта
const FLUSH_DELAY = 1500; // мс: копим события и отправляем пачкой
const MAX_BATCH = 40;

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

// временный резерв: события, пришедшие до init() (например, ошибка загрузки)
let pending = [];
let buffered = [];
let flushTimer = null;
let filePath = null;
let enabled = true;
// Адрес приёмника можно переопределить переменной окружения (например, на свой
// self-hosted коллектор). Пустая строка = отправка выключена принудительно.
let endpoint = process.env.ZSPEAKLY_LOG_ENDPOINT ?? DEFAULT_ENDPOINT;
let installId = 'local';
let context = {}; // версия, платформа и т.п.
let sending = false;
let lastSend = null; // { at, ok, count, reason }
let silent = false; // вывод в консоль (в тестах выключаем)
let initialised = false;

/* ────────────────────────────── редакция ───────────────────────────── */

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.]{2,}/g;
const WIN_USER_RE = /([A-Za-z]:\\Users\\)[^\\\s"']+/gi;
const POSIX_HOME_RE = /(\/home\/|\/Users\/)[^/\s"']+/g;
const TOKEN_RE = /\b(sk-[A-Za-z0-9]{10,}|ghp_[A-Za-z0-9]{10,}|Bearer\s+[A-Za-z0-9._-]{10,})\b/g;

function redact(value) {
  let s = typeof value === 'string' ? value : String(value ?? '');
  s = s.replace(EMAIL_RE, '[почта]');
  s = s.replace(WIN_USER_RE, '$1[пользователь]');
  s = s.replace(POSIX_HOME_RE, '$1[пользователь]');
  s = s.replace(TOKEN_RE, '[секрет]');
  return s;
}

/** Убирает из payload всё, что похоже на содержимое диктовки. */
function scrub(payload) {
  if (!payload || typeof payload !== 'object') return {};
  const out = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined || value === null) continue;
    const k = String(key).toLowerCase();
    // содержимое речи/буфера/словаря и аудио не отправляем и не пишем
    if (/^(text|transcript|pcm|audio|clipboard|word|prompt|selection)$/.test(k)) continue;
    if (typeof value === 'string') out[key] = redact(value).slice(0, 2000);
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = value;
    else out[key] = redact(JSON.stringify(value)).slice(0, 2000);
  }
  return out;
}

/* ───────────────────────────── хранилище ───────────────────────────── */

function fileLine(entry) {
  return `${new Date(entry.at).toISOString()} ${String(entry.level || 'info').toUpperCase()} ${
    entry.scope || 'app'
  } ${entry.message}${entry.data && Object.keys(entry.data).length ? ' ' + JSON.stringify(entry.data) : ''}\n`;
}

function trimFile() {
  if (!filePath) return;
  try {
    const stat = fs.statSync(filePath);
    if (stat.size <= MAX_FILE_BYTES) return;
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    const keep = lines.slice(Math.floor(lines.length / 2));
    fs.writeFileSync(filePath, keep.join('\n') + '\n');
  } catch {
    /* файла нет — не страшно */
  }
}

function remember(entry) {
  buffered.push(entry);
  if (buffered.length > MAX_MEMORY) buffered = buffered.slice(-MAX_MEMORY);
}

function writeFile(entry) {
  if (!filePath) return;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, fileLine(entry));
    trimFile();
  } catch {
    /* диск недоступен — работаем без файла */
  }
}

/* ────────────────────────────── отправка ───────────────────────────── */

function canSend() {
  return enabled && Boolean(endpoint) && installId !== 'local';
}

function queueSend() {
  if (!canSend()) return;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    send().catch(() => {});
  }, FLUSH_DELAY);
  if (typeof flushTimer.unref === 'function') flushTimer.unref();
}

async function send({ force = false, filter = null } = {}) {
  if (sending) return { ok: false, reason: 'уже отправляю' };
  if (!enabled && !force) return { ok: false, reason: 'отправка выключена' };
  if (!endpoint) return { ok: false, reason: 'приёмник не настроен' };
  const source = filter ? buffered.filter(filter) : buffered;
  const batch = source.slice(-MAX_BATCH);
  if (!batch.length) return { ok: false, reason: 'нечего отправлять' };

  sending = true;
  const body = {
    installId,
    app: {
      version: context.version || '',
      channel: context.channel || 'stable',
      platform: context.platform || process.platform,
      arch: context.arch || process.arch,
      electron: context.electron || '',
      engine: context.engine || '',
    },
    sentAt: Date.now(),
    events: batch.map((e) => ({
      level: e.level || 'info',
      scope: e.scope || 'app',
      message: e.message,
      at: e.at,
      data: e.data || {},
    })),
  };
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    const ok = res.ok;
    lastSend = { at: Date.now(), ok, count: batch.length, reason: ok ? '' : `HTTP ${res.status}` };
    return { ok, count: batch.length, reason: ok ? '' : `HTTP ${res.status}` };
  } catch (err) {
    lastSend = { at: Date.now(), ok: false, count: batch.length, reason: String(err.message || err) };
    return { ok: false, count: batch.length, reason: lastSend.reason };
  } finally {
    sending = false;
  }
}

/* ─────────────────────────────── API ──────────────────────────────── */

/**
 * @param {object} opts
 * @param {string} opts.dir            папка для log-файла (обычно userData)
 * @param {object} opts.context        версия/канал/движок
 * @param {boolean} opts.enabled       включать ли отправку
 * @param {string} opts.endpoint       переопределить приёмник ('' = никогда)
 */
function init(opts = {}) {
  if (opts.dir) filePath = path.join(opts.dir, 'logs', 'zspeakly.log');
  if (opts.endpoint !== undefined) endpoint = opts.endpoint || '';
  if (opts.enabled !== undefined) enabled = Boolean(opts.enabled);
  context = { ...context, ...(opts.context || {}) };
  if (!filePath) {
    try {
      filePath = path.join(os.tmpdir(), 'zspeakly', 'zspeakly.log');
    } catch {
      filePath = null;
    }
  }
  initialised = true;
  if (pending.length) {
    const early = pending;
    pending = [];
    for (const entry of early) {
      remember(entry);
      writeFile(entry);
    }
  }
  return { filePath, enabled, endpoint: endpoint ? 'настроен' : '' };
}

/**
 * Свой адрес приёмника из «Настройки → Диагностика».
 * Пустая строка = не отправлять никуда (только локальный журнал).
 */
function setEndpoint(url) {
  const value = String(url || '').trim();
  if (!value) {
    endpoint = '';
    return { ok: true, endpoint: '' };
  }
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { ok: false, reason: 'адрес должен начинаться с http:// или https://' };
    }
    endpoint = parsed.toString();
    return { ok: true, endpoint };
  } catch {
    return { ok: false, reason: 'некорректный адрес' };
  }
}

function setContext(patch = {}) {
  context = { ...context, ...patch };
}

function setInstallId(id) {
  if (id && typeof id === 'string') installId = id;
}

function setEnabled(next) {
  enabled = Boolean(next);
  if (enabled) queueSend();
  return enabled;
}

function isEnabled() {
  return enabled;
}

function setSilent(v) {
  silent = Boolean(v);
}

/** Основная точка входа. Никогда не бросает — логировать можно откуда угодно. */
function log(level, scope, message, data) {
  try {
    const entry = {
      at: Date.now(),
      level: LEVELS[level] ? level : 'info',
      scope: redact(scope || 'app').slice(0, 40),
      message: redact(message).slice(0, 1000),
      data: scrub(data),
    };
    const persist = entry.level === 'error' || entry.level === 'warn' || data?.keep === true;
    if (!initialised && persist) {
      // журнал ещё не сконфигурирован — не теряем событие
      pending.push(entry);
      if (pending.length > 50) pending = pending.slice(-50);
    } else {
      remember(entry);
      // на диске держим только warn/error и явные info-события с флагом
      if (persist) writeFile(entry);
    }
    if (entry.level === 'error') queueSend();
    if (!silent) {
      const line = fileLine(entry).trim();
      if (entry.level === 'error') console.error(line);
      else if (entry.level === 'warn') console.warn(line);
    }
    return entry;
  } catch {
    return null;
  }
}

const logger = {
  debug: (scope, message, data) => log('debug', scope, message, data),
  info: (scope, message, data) => log('info', scope, message, data),
  warn: (scope, message, data) => log('warn', scope, message, data),
  error: (scope, message, data) => log('error', scope, message, data),
  log,
  init,
  setContext,
  setEndpoint,
  setInstallId,
  setEnabled,
  isEnabled,
  setSilent,
  send,
  redact,
  scrub,
  /** Последние события для показа в интерфейсе (без содержимого речи). */
  recent(limit = 100) {
    return buffered.slice(-Math.max(1, Math.min(MAX_MEMORY, Number(limit) || 100)));
  },
  status() {
    return {
      enabled,
      endpoint,
      endpointConfigured: Boolean(endpoint),
      installId,
      file: filePath,
      buffered: buffered.length,
      lastSend,
      context,
    };
  },
  async clear() {
    buffered = [];
    lastSend = null;
    try {
      if (filePath) fs.rmSync(filePath, { force: true });
    } catch {
      /* ignore */
    }
    return true;
  },
  /** Ручная отправка: кнопка «Отправить логи сейчас». */
  async sendNow() {
    // force — только для ручной кнопки, но выключенный тумблер уважаем:
    // «выключено» должно значить «наружу не уходит ничего»
    if (!enabled) return { ok: false, count: 0, reason: 'отправка выключена' };
    return send({ force: true });
  },
  /** Тестовое событие — чтобы человек видел, что канал действительно работает. */
  async ping() {
    logger.info('diagnostics', 'Проверка канала диагностики', { keep: true, manual: true });
    return send({ force: true });
  },
  newInstallId() {
    return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
  },
};

module.exports = { logger, redact, scrub };
