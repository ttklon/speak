/**
 * Хранилище ZSpeakly.
 *
 * В Electron данные пишутся в JSON-файл профиля через IPC (main-процесс),
 * в браузере (dev-preview) — в localStorage. Наружу отдаётся один и тот же API,
 * поэтому весь UI работает одинаково в обоих режимах.
 */

const PREFIX = 'zs:';

export const isElectron = () =>
  typeof window !== 'undefined' && Boolean(window.zspeakly?.isElectron);

function bridge() {
  return isElectron() ? window.zspeakly.store : null;
}

export function readRaw(key) {
  try {
    const b = bridge();
    if (b) return b.getSync(key);
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.warn('[storage] read failed', key, err);
    return null;
  }
}

/** Не начинать разрушительное восстановление, если main уже знает о сбое.
 * ok не подтверждает запись будущих изменений и не делает импорт транзакцией. */
export function assertBackupImportAllowed() {
  if (!isElectron()) return; // У localStorage нет статуса будущих записей.
  let ok = false;
  try { ok = bridge()?.statusSync?.()?.ok === true; } catch { /* безопасный отказ */ }
  if (!ok) throw new Error('Профиль защищён, не сохранён или его статус недоступен. Исправьте проблему записи перед восстановлением. Текущие данные не изменены.');
}

/** Синхронное чтение (мост использует sendSync — данные уже в памяти main). */
export function read(key) {
  return readRaw(key);
}

function reportStorageError(key, err, source) {
  try {
    window.dispatchEvent(new CustomEvent('zs:storage-error', {
      detail: { key, reason: String(err?.message || err || 'ошибка записи'), source },
    }));
  } catch { /* событие не обязательно */ }
}

/** true означает принятие запроса, а не гарантию записи на диск. */
export function write(key, value) {
  try {
    const b = bridge();
    if (b) {
      const pending = b.set(key, value);
      if (pending === false) throw new Error('мост отклонил запись');
      if (pending?.then) Promise.resolve(pending).then((ok) => {
        if (ok === false) reportStorageError(key, 'мост отклонил запись', 'electron');
      }, (err) => reportStorageError(key, err, 'electron'));
      return true;
    }
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch (err) {
    console.warn('[storage] write failed', key, err);
    reportStorageError(key, err, isElectron() ? 'electron' : 'browser');
    return false;
  }
}

export function remove(key) {
  try {
    const b = bridge();
    if (b) {
      const pending = b.remove(key);
      if (pending === false) throw new Error('мост отклонил удаление');
      if (pending?.then) Promise.resolve(pending).then((ok) => {
        if (ok === false) reportStorageError(key, 'мост отклонил удаление', 'electron');
      }, (err) => reportStorageError(key, err, 'electron'));
      return true;
    }
    localStorage.removeItem(PREFIX + key);
    return true;
  } catch (err) {
    reportStorageError(key, err, isElectron() ? 'electron' : 'browser');
    return false;
  }
}

/** Сколько байт занимают сохранённые данные (для настроек «Занято места»). */
export function storageBytes() {
  try {
    const b = bridge();
    if (b) return b.sizeSync?.() ?? 0;
    let total = 0;
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(PREFIX)) continue;
      total += k.length + (localStorage.getItem(k)?.length || 0);
    }
    return total * 2; // UTF-16
  } catch {
    return 0;
  }
}

export function formatBytes(bytes = 0) {
  // Отрицательное или нечисловое значение (битый размер от моста) раньше
  // превращалось в «NaN undefined» прямо в настройках.
  const size = Number(bytes);
  if (!Number.isFinite(size) || size <= 0) return '0 Б';
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(size) / Math.log(1024)));
  const value = size / 1024 ** i;
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1).replace('.0', '')} ${units[i]}`;
}
