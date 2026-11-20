/**
 * Известные пары «как пишется / как звучит» для main-процесса.
 *
 * Тот же список, что у интерфейса (`src/lib/dictionary/aliases.js`): данные
 * лежат в `electron/dictionaryAliases.json`, потому что этот каталог попадает в
 * собранное приложение, а `src` — нет. Здесь только логика: без неё подсказка
 * движку получала написание, а человек говорил звучание.
 */

const PAIRS = require('./dictionaryAliases.json');

const norm = (value = '') =>
  String(value)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();

/** Обратная карта: «зум» → ['zoom']. */
const RU_TO_LATIN = (() => {
  const map = new Map();
  for (const [latin, sounds] of Object.entries(PAIRS)) {
    for (const sound of sounds || []) {
      const key = norm(sound);
      if (!key) continue;
      if (!map.has(key)) map.set(key, []);
      if (!map.get(key).includes(latin)) map.get(key).push(latin);
    }
  }
  return map;
})();

function aliasesFor(word = '') {
  const key = norm(word);
  if (!key) return [];
  const out = [];
  const push = (value) => {
    const v = norm(value);
    if (v && v !== key && !out.includes(v)) out.push(v);
  };
  for (const sound of PAIRS[key] || []) push(sound);
  for (const latin of RU_TO_LATIN.get(key) || []) {
    push(latin);
    for (const sound of PAIRS[latin] || []) push(sound);
  }
  return out;
}

module.exports = { aliasesFor, PAIRS };
