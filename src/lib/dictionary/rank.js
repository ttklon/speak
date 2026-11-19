/**
 * Порядок словаря и подсчёт, какие слова действительно пригодились.
 *
 * Зачем: словарь — это подсказка движку, а подсказка короткая (≈100 коротких
 * терминов). Когда слов становится больше, порядок начинает решать: в подсказку
 * попадут первые, остальные — нет. Поэтому важное человек закрепляет сам
 * (звёздочка), а остальное сортируется по тому, как часто слово встречается в
 * готовом тексте: то, что реально диктуют, оказывается выше.
 *
 * Правила простые и без настроек:
 *  • закреплённые слова всегда выше незакреплённых;
 *  • дальше — по числу попаданий в распознанный текст;
 *  • при равенстве — то, что использовали позже, потом то, что добавили позже.
 */

/** Нормализация для сравнения: регистр, ё→е. Хранится как есть, сравнивается так. */
export function normalizeKey(text = '') {
  return String(text)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}\s-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Словарь в порядке подсказки: закреплённое, частое, свежее.
 * Возвращает копию: исходный список — данные человека, его нельзя перемешивать
 * побочным эффектом сортировки.
 */
export function rankDictionary(list = []) {
  return [...(Array.isArray(list) ? list : [])].sort(
    (a, b) =>
      Number(Boolean(b?.pinned)) - Number(Boolean(a?.pinned)) ||
      Number(b?.hits || 0) - Number(a?.hits || 0) ||
      Number(b?.lastUsedAt || 0) - Number(a?.lastUsedAt || 0) ||
      Number(b?.createdAt || 0) - Number(a?.createdAt || 0),
  );
}

/**
 * Отметить, какие слова словаря встретились в тексте.
 *
 * Сравнение по целым словам, а не по подстроке: «кот» не должен «находиться» в
 * «который». Многословные термины («Гига Писарь») ищутся как последовательность
 * слов.
 *
 * @returns {{ list: Array, changed: string[] }} новый список и слова, которые посчитались
 */
export function countDictionaryUsage(list = [], text = '') {
  const items = Array.isArray(list) ? list : [];
  const haystack = ` ${normalizeKey(text)} `;
  if (!items.length || haystack.trim() === '') return { list: items, changed: [] };
  const now = Date.now();
  const changed = [];
  const next = items.map((item) => {
    const key = normalizeKey(item?.word);
    if (!key) return item;
    if (!haystack.includes(` ${key} `)) return item;
    changed.push(item.word);
    return { ...item, hits: Number(item.hits || 0) + 1, lastUsedAt: now };
  });
  return changed.length ? { list: next, changed } : { list: items, changed: [] };
}
