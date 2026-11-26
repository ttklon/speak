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
import { saneRewrite } from './ai/textops.js';

const norm = (text = '') => String(text).trim().replace(/\s+/g, ' ').toLowerCase();
const endsSentence = (text = '') => /[.!?…:;]["»)]?$/.test(String(text).trim());

// Буквальная защита — не понимание смысла: не теряем исходные слова в
// порядке и не меняем выбранные маркеры отрицания и цифровые выражения.
const NEGATION = new Set(['не', 'ни', 'нет', 'нельзя', 'без', 'никогда', 'ничего', 'никто', 'никак', 'нигде',
  'no', 'not', 'never', 'without', "can't", "cannot", "don't", "doesn't", "didn't", "won't"]);
const tokenize = (text) => [...text.matchAll(/[\p{L}\p{N}\p{M}]+(?:[’'-][\p{L}\p{N}\p{M}]+)*/gu)]
  .map((match) => ({ value: match[0].toLowerCase().replace(/’/gu, "'"), start: match.index, end: match.index + match[0].length }));
const isNegation = (token) => NEGATION.has(token) || token.endsWith("n't");
const numeric = (text) => (text.match(/[-+−]?\p{N}+(?:[.,:/-]\p{N}+)*(?:\s*[%‰])?/gu) || [])
  .map((part) => part.replace(/\s+/gu, ''));
const symbols = (text) => text.match(/[%‰$€£₽¥₹₴=<>×÷]/gu) || [];
const marks = (text) => text.match(/[^\p{L}\p{N}\p{M}\s]/gu) || [];
const same = (a, b) => a.length === b.length && a.every((item, i) => item === b[i]);
const subsequence = (a, b) => {
  let i = 0;
  for (const item of b) if (item === a[i]) i += 1;
  return i === a.length;
};
function literalPreserved(before, after) {
  const source = before.normalize('NFC'), target = after.normalize('NFC');
  const a = tokenize(source), b = tokenize(target);
  const aligned = [];
  let j = 0;
  for (const word of a) {
    while (j < b.length && b[j].value !== word.value) j += 1;
    if (j === b.length) return false;
    aligned.push(b[j++]);
  }
  const aw = a.map((word) => word.value), bw = b.map((word) => word.value);
  if (!same(aw.filter(isNegation), bw.filter(isNegation)) || !same(numeric(source), numeric(target)) ||
      !same(symbols(source), symbols(target))) return false;
  // Уже имеющиеся знаки должны остаться между теми же исходными словами.
  // Новые знаки и вставленные слова всё равно могут изменить смысл.
  for (let i = 0; i <= a.length; i += 1) {
    const oldGap = source.slice(i ? a[i - 1].end : 0, i < a.length ? a[i].start : source.length);
    const newGap = target.slice(i ? aligned[i - 1].end : 0, i < a.length ? aligned[i].start : target.length);
    const oldMarks = marks(oldGap);
    if (!subsequence(oldMarks, marks(newGap))) return false;
    if (i > 0 && i < a.length && oldMarks.length && !/\s/u.test(oldGap) && /\s/u.test(newGap)) return false;
  }
  return true;
}

/**
 * Стоит ли заменить прежний текст результатом точного прохода.
 * @returns {{ replace: boolean, note: string, manualReview?: boolean }}
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
  if (!literalPreserved(before, after)) {
    const note = wordsAfter < wordsBefore ? 'точный проход услышал меньше или изменил слова'
      : wordsAfter === wordsBefore ? 'другие слова, но не больше — нужна ручная проверка'
        : 'изменены исходные слова, числа или знаки';
    return { replace: false, manualReview: true, note };
  }
  if (wordsAfter > wordsBefore) {
    return { replace: true, note: `было ${wordsBefore} слов, стало ${wordsAfter}` };
  }
  if (wordsAfter === wordsBefore && !endsSentence(before) && endsSentence(after)) {
    if (saneRewrite(before, after) !== after) {
      return { replace: false, manualReview: true, note: 'изменилась пунктуация или часть текста' };
    }
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
