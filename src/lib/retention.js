/**
 * Срок хранения записей («Хранить» в настройках данных).
 *
 * Раньше значение сохранялось в настройках и больше ничего не делало.
 * Теперь это чистая функция, которую используют и провайдер данных,
 * и тесты: 3650 дней = «Бессрочно», 0 = «Не хранить».
 */

export const FOREVER_DAYS = 3650;

/** Бессрочно или значение не задано/некорректно. */
export function isForever(days) {
  const n = Number(days);
  return !Number.isFinite(n) || n >= FOREVER_DAYS;
}

/**
 * Отбрасывает записи старше `days` дней.
 * @param {Array<{createdAt?: number, pinned?: boolean}>} items
 * @param {number} days  0 — не хранить ничего, 3650 — бессрочно
 * @param {{keepPinned?: boolean, now?: number}} opts
 */
export function pruneByAge(items, days, { keepPinned = false, now = Date.now() } = {}) {
  if (!Array.isArray(items) || items.length === 0) return [];
  if (isForever(days)) return items;
  const limit = Number(days) <= 0 ? Infinity : now - Number(days) * 86400000;
  const next = items.filter((it) => (keepPinned && it?.pinned) || Number(it?.createdAt || 0) >= limit);
  // сохраняем ту же ссылку, если ничего не удалили — React не будет лишний раз рендерить
  return next.length === items.length ? items : next;
}

export default { FOREVER_DAYS, isForever, pruneByAge };
