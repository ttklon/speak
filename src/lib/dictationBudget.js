/**
 * Бюджет истории диктовок.
 *
 * У буфера обмена история ограничена по весу (24 МБ), а у диктовок —
 * только по числу записей и по сроку. Этого мало: длинные расшифровки
 * (встречи, лекции) — по 10–20 тысяч знаков каждая, и несколько сотен таких
 * записей дают мегабайты JSON. Профиль пишется целиком на каждую диктовку и
 * читается целиком при запуске — именно так «приложение долго открывается»
 * и «после вставки всё подвисает».
 *
 * Поэтому у истории те же правила, что у буфера: 2000 записей и 8 МБ текста,
 * новые записи приоритетнее старых.
 */

/** Сколько записей храним максимум. */
export const DICTATION_MAX_ITEMS = 2000;
/** Сколько всего текста храним: 8 МБ — это ≈400 длинных расшифровок. */
export const DICTATION_MAX_BYTES = 8 * 1024 * 1024;

/** Примерный вес записи в сохранённом виде (JSON + UTF-16). */
export function dictationBytes(item) {
  if (!item || typeof item !== 'object') return 0;
  const text = typeof item.text === 'string' ? item.text : '';
  // 80 символов — id, дата, язык, кавычки и прочие поля JSON
  return (text.length + 80) * 2;
}

/** Сколько занимает вся история (для «Занято места» в настройках). */
export function dictationsBytes(items) {
  return (Array.isArray(items) ? items : []).reduce((sum, item) => sum + dictationBytes(item), 0);
}

/**
 * Оставить самые свежие записи в пределах бюджета.
 *
 * @param {Array} items записи, новые первыми
 * @param {{maxItems?: number, maxBytes?: number}} [limits]
 * @returns {Array} тот же массив, если обрезать нечего
 */
export function trimDictations(items, { maxItems = DICTATION_MAX_ITEMS, maxBytes = DICTATION_MAX_BYTES } = {}) {
  if (!Array.isArray(items) || !items.length) return items;
  let total = 0;
  const kept = [];
  for (const item of items) {
    if (kept.length >= maxItems) break;
    const size = dictationBytes(item);
    if (total + size > maxBytes) break; // старые записи дальше — тем более лишние
    kept.push(item);
    total += size;
  }
  return kept.length === items.length ? items : kept;
}

export default { DICTATION_MAX_ITEMS, DICTATION_MAX_BYTES, dictationBytes, dictationsBytes, trimDictations };
