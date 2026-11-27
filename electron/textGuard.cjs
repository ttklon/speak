/**
 * Защита от «просто повторов».
 *
 * У whisper есть известная беда: на тишине, шуме, музыке или на длинной паузе он
 * зацикливается и выдаёт одну и ту же фразу несколько раз подряд
 * («Спасибо за просмотр. Спасибо за просмотр. Спасибо за просмотр.»). В чужом
 * окне это выглядит именно как «прислал неправильный текст, просто повторы».
 *
 * Что здесь делается:
 *  - повторяющийся кусок (1–8 слов), встретившийся три и более раз подряд,
 *    сворачивается в одно вхождение — человек говорил фразу один раз;
 *  - два подряд одинаковых предложения тоже сворачиваются (это уже не речь,
 *    а петля движка);
 *  - текст, который после сворачивания стал пустым или состоял из одной и той
 *    же фразы целиком, помечается как подозрительный: интерфейс может его не
 *    вставлять, а сказать «расслышать не удалось».
 *
 * Модуль чистый: только строки, поэтому проверяется тестами.
 */

/** Нормализация для сравнения: регистр, ё, знаки препинания, пробелы. */
function normalize(text = '') {
  return String(text || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Свернуть повторяющиеся подряд фрагменты.
 *
 * @param {string} text
 * @param {{minRepeats?: number, maxWords?: number}} [opts]
 * @returns {string}
 */
function collapseRepetition(text, opts = {}) {
  const minRepeats = Math.max(2, Number(opts.minRepeats) || 3);
  const maxWords = Math.max(2, Number(opts.maxWords) || 8);
  const source = String(text || '');
  if (!source.trim()) return source;

  const words = source.split(/\s+/).filter(Boolean);
  if (words.length < minRepeats) return source;

  const bare = words.map((word) => normalize(word));
  const keep = new Array(words.length).fill(true);

  // Идём по тексту и в каждой позиции ищем самый длинный повторяющийся блок.
  for (let size = Math.min(maxWords, Math.floor(words.length / minRepeats)); size >= 1; size -= 1) {
    for (let start = 0; start + size * minRepeats <= words.length; start += 1) {
      let repeats = 1;
      let cursor = start + size;
      while (cursor + size <= words.length) {
        let same = true;
        for (let i = 0; i < size; i += 1) {
          if (bare[start + i] !== bare[cursor + i]) {
            same = false;
            break;
          }
        }
        if (!same) break;
        repeats += 1;
        cursor += size;
      }
      if (repeats >= minRepeats) {
        // оставляем первое вхождение, остальные вычёркиваем
        for (let index = start + size; index < cursor; index += 1) keep[index] = false;
        start = cursor - 1;
      }
    }
  }

  const result = words.filter((_, index) => keep[index]).join(' ');
  return result.trim() ? result : words.slice(0, Math.min(words.length, maxWords)).join(' ');
}

/**
 * Похоже ли, что движок зациклился.
 *
 * @param {string} text
 * @returns {boolean}
 */
function looksLikeLoop(text) {
  const normalized = normalize(text);
  if (!normalized) return false;
  const words = normalized.split(' ');
  if (words.length < 6) return false;
  const collapsed = normalize(collapseRepetition(text));
  // Если после сворачивания осталось меньше трети — это была петля, а не речь.
  const before = words.length;
  const after = collapsed ? collapsed.split(' ').length : 0;
  return after > 0 && after <= Math.max(2, Math.floor(before / 3));
}

module.exports = { collapseRepetition, looksLikeLoop, normalize };
