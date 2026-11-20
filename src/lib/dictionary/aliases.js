/**
 * Как звучит слово, написанное латиницей.
 *
 * Проблема, которую это решает: человек говорит «зум», «телеграм», «докер», а в
 * словаре у него записано `Zoom`, `Telegram`, `Docker`. Движок честно пишет то,
 * что услышал, — кириллицей; замена по словарю не срабатывала, потому что
 * `Зум` и `Zoom` — разные строки. Раньше это лечилось только вручную: указать
 * произношение у каждого слова.
 *
 * Здесь — известные пары «как пишется / как звучит по-русски». Список короткий и
 * ручной намеренно: машинная транслитерация даёт «зоом» и «доккер», то есть
 * делает вид, что знает произношение, которого не знает. Лучше 60 верных пар и
 * честное «произношение можно указать самому», чем тысяча выдуманных.
 *
 * Латиница ↔ кириллица работает в обе стороны: слово из словаря может быть
 * записано и так, и так.
 */

/**
 * Известные пары «как пишется / как звучит». Живут в JSON, а не здесь, потому
 * что тот же список нужен main-процессу: он собирает подсказку движку
 * (`--prompt`), и пара «Zoom, зум» должна попадать туда до распознавания, а не
 * только в готовый текст. Один список на двоих — один источник правды.
 */
import PAIRS from '../../../electron/dictionaryAliases.json' with { type: 'json' };

const LATIN_TO_RU = PAIRS;


const norm = (value = '') =>
  String(value)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();

/** Обратная карта: «зум» → [zoom]. Собирается один раз. */
const RU_TO_LATIN = (() => {
  const map = new Map();
  for (const [latin, sounds] of Object.entries(LATIN_TO_RU)) {
    for (const sound of sounds) {
      const key = norm(sound);
      if (!map.has(key)) map.set(key, []);
      if (!map.get(key).includes(latin)) map.get(key).push(latin);
    }
  }
  return map;
})();

/** Все известные написания слова: латиница, кириллица и обратное направление. */
export function aliasesFor(word = '') {
  const key = norm(word);
  if (!key) return [];
  const out = [];
  const push = (value) => {
    const v = norm(value);
    if (v && v !== key && !out.includes(v)) out.push(v);
  };
  for (const sound of LATIN_TO_RU[key] || []) push(sound);
  for (const latin of RU_TO_LATIN.get(key) || []) {
    push(latin);
    for (const sound of LATIN_TO_RU[latin] || []) push(sound);
  }
  return out;
}

/** Знает ли приложение, как это слово звучит. Нужно для подсказки в словаре. */
export function knownAliases(word = '') {
  return aliasesFor(word);
}

/**
 * Все написания, которые считаются этим словом при замене и при подсчёте
 * попаданий: сам термин, указанное произношение и известные пары.
 * Порядок важен: сначала то, что написал человек.
 */
export function termVariants(entry) {
  const word = typeof entry === 'object' && entry ? String(entry.word || '').trim() : String(entry || '').trim();
  const pronunciation =
    typeof entry === 'object' && entry ? String(entry.pronunciation || '').trim() : '';
  const out = [];
  const push = (value) => {
    const v = String(value || '').trim();
    const key = norm(v);
    if (!key) return;
    if (out.some((existing) => norm(existing) === key)) return;
    out.push(v);
  };
  push(word);
  push(pronunciation);
  for (const alias of aliasesFor(word)) push(alias);
  return out;
}
