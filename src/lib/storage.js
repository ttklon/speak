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

/** Синхронное чтение (мост использует sendSync — данные уже в памяти main). */
export function read(key) {
  return readRaw(key);
}

/** Асинхронный вариант — если понадобится неблокирующий доступ. */
export function write(key, value) {
  try {
    const b = bridge();
    if (b) {
      b.set(key, value);
      return true;
    }
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch (err) {
    console.warn('[storage] write failed', key, err);
    // localStorage в браузере кончается на крупных картинках буфера: раньше
    // запись просто исчезала. Сообщаем интерфейсу — он покажет тост.
    try {
      window.dispatchEvent(
        new CustomEvent('zs:storage-error', { detail: { key, reason: String(err?.message || err) } }),
      );
    } catch {
      /* событие не обязательно */
    }
    return false;
  }
}

export function remove(key) {
  try {
    const b = bridge();
    if (b) {
      b.remove(key);
      return true;
    }
    localStorage.removeItem(PREFIX + key);
    return true;
  } catch {
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
  if (!bytes) return '0 Б';
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** i;
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1).replace('.0', '')} ${units[i]}`;
}
