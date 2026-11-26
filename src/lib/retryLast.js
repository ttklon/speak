/**
 * «Переспросить точно»: второй шанс для уже сказанной фразы.
 *
 * Зачем: ошибку видно сразу после вставки — но чтобы получить другой текст,
 * человеку приходилось стирать сказанное и диктовать заново, то есть платить
 * тем же временем. Приложение помнит последнюю запись, значит может прогнать её
 * ещё раз честным проходом (шире перебор, полное окно, перебор температур) —
 * это бесплатно по железу: тот же звук, только дороже по времени.
 *
 * Здесь живёт единственное решение: менять ли текст или оставить как было.
 * Честность важнее «улучшения ради улучшения»: если точный проход не дал
 * больше слов, текст не подменяется. Молча заменить фразу на другую, не лучше, —
 * худшее, что может сделать диктовка.
 */

import { words } from './utils.js';

const norm = (text = '') => String(text).trim().replace(/\s+/g, ' ').toLowerCase();
const endsSentence = (text = '') => /[.!?…:;]["»)]?$/.test(String(text).trim());

/**
 * Стоит ли заменить прежний текст результатом точного прохода.
 * @returns {{ replace: boolean, note: string }}
 */
export function shouldReplaceText(prev = '', next = '') {
  const before = String(prev || '').trim();
  const after = String(next || '').trim();
  if (!after) return { replace: false, note: 'точный проход не расслышал ничего' };
  if (norm(after) === norm(before)) {
    return { replace: false, note: 'точный проход услышал то же самое' };
  }
  const wordsBefore = words(before);
  const wordsAfter = words(after);
  if (wordsAfter > wordsBefore) {
    return { replace: true, note: `было ${wordsBefore} слов, стало ${wordsAfter}` };
  }
  if (wordsAfter === wordsBefore && !endsSentence(before) && endsSentence(after)) {
    return { replace: true, note: 'тот же текст, но со знаком в конце' };
  }
  if (wordsAfter < wordsBefore) {
    return { replace: false, note: `точный проход услышал меньше: ${wordsAfter} вместо ${wordsBefore}` };
  }
  return { replace: false, note: 'другие слова, но не больше — оставляем как было' };
}

/**
 * Можно ли вообще переспросить: нужны и запись, и распознавание в приложении.
 * В браузерном превью записи не остаётся — об этом честнее сказать словами.
 */
export function retryAvailability({ audio, native, isSnippet = false }) {
  if (isSnippet) {
    return { ok: false, reason: 'Это быстрый блок: в записи звучит только триггер, а не текст блока. Запись можно исправить вручную в истории, а сам блок — в словаре.' };
  }
  if (!native?.transcribePcm) {
    return { ok: false, reason: 'Переспросить можно в приложении: в браузере распознавания нет.' };
  }
  if (!audio?.pcm?.length) {
    return {
      ok: false,
      reason: 'Последняя запись уже отпущена — скажите фразу заново, и её можно будет уточнить.',
    };
  }
  return { ok: true, reason: '' };
}
