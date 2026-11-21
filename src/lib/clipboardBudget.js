/**
 * Бюджет истории буфера обмена.
 *
 * Проблема была не в количестве записей, а в их весе. Пять тысяч картинок в
 * base64 — это десятки мегабайт JSON, который main-процесс разбирал синхронно
 * при запуске, а рендерер читал через синхронный IPC: окно открывалось секунды.
 * Поэтому история ограничена и по размеру, а не только по числу записей.
 */

/** Сколько всего занимает история: 24 МБ — это ≈60 скриншотов или десятки тысяч строк. */
export const CLIPBOARD_MAX_BYTES = 24 * 1024 * 1024;

/**
 * Примерный вес записи в сохранённом виде (JSON + UTF-16 в localStorage).
 * Считать точно не нужно: важно не дать картинкам вырасти в сотню мегабайт.
 */
export function itemBytes(item) {
  if (!item || typeof item !== 'object') return 0;
  const part = (value) => (typeof value === 'string' ? value.length : 0);
  // 120 символов — заголовки, id, даты и кавычки JSON
  return (part(item.image) + part(item.text) + part(item.cipher) + 120) * 2;
}

/**
 * Оставить самые свежие записи в пределах бюджета. Закреплённое не выбрасывается
 * никогда: человек закрепил запись именно для того, чтобы она осталась.
 *
 * @param {Array} items записи, новые первыми
 * @param {number} maxBytes бюджет
 * @returns {Array} тот же массив, если обрезать нечего
 */
export function trimByBytes(items, maxBytes = CLIPBOARD_MAX_BYTES) {
  if (!Array.isArray(items) || !items.length) return items;
  let total = 0;
  const kept = [];
  let dropped = false;
  for (const item of items) {
    const size = itemBytes(item);
    if (item?.pinned) {
      kept.push(item);
      total += size;
      continue;
    }
    if (total + size > maxBytes) {
      dropped = true;
      continue;
    }
    kept.push(item);
    total += size;
  }
  return dropped ? kept : items;
}

/** Сколько занято (для настроек «Занято места»). */
export function totalBytes(items) {
  return (Array.isArray(items) ? items : []).reduce((sum, item) => sum + itemBytes(item), 0);
}

export default { CLIPBOARD_MAX_BYTES, itemBytes, trimByBytes, totalBytes };
