import { dictionaryWordKey } from './identity.js';

/**
 * Обучение словаря по правкам пользователя.
 *
 * Автор видео: «сказал “зеленка” — распознало через Е; добавил слово в словарь —
 * и дальше он пишет правильно». Чтобы не добавлять вручную каждый раз, ZSpeakly
 * сравнивает исходную расшифровку с тем, что вы исправили, и предлагает слова.
 */

const STOP = new Set([
  'и', 'в', 'на', 'не', 'что', 'это', 'как', 'по', 'из', 'к', 'у', 'же', 'ли',
  'а', 'но', 'или', 'для', 'с', 'о', 'об', 'при', 'до', 'от', 'то', 'так',
  'the', 'a', 'an', 'of', 'to', 'and', 'is', 'it', 'in', 'on',
]);

/** Нормализация для сравнения: регистр, ё→е, лишние пробелы. */
export function normalize(text = '') {
  return String(text)
    .normalize('NFC')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}\p{M}\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Точные фрагменты исходной строки нужны для предлагаемых слов, а не только
// нормализованная форма. Технические блоки не учим как отдельные слова.
function tokens(text) {
  const out = [];
  for (const part of String(text).matchAll(/\S+/gu)) {
    const chunk = part[0];
    const technical = /[\\/@_]/u.test(chunk) || /[\p{L}\p{N}_-]+\.[\p{L}\p{N}_-]+/u.test(chunk);
    for (const token of chunk.matchAll(/[\p{L}\p{M}\p{N}]+(?:-[\p{L}\p{M}\p{N}]+)*/gu)) {
      out.push({ value: token[0], technical });
      if (out.length > 2000) return null;
    }
  }
  return out;
}

/** Расстояние Левенштейна — чтобы ловить «зелёнка» → «зеленка». */
export function distance(a = '', b = '') {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length];
}

/**
 * Кандидаты в словарь: слова, которые пользователь поправил руками.
 *
 * @param {string} before  исходная расшифровка
 * @param {string} after   текст после правки
 * @param {Array}  known   уже известные слова словаря
 * @returns {Array<{word: string, pronunciation: string}>}
 */
export function learnFromEdit(before = '', after = '', known = []) {
  // Не позволяем одному длинному слову заморозить UI квадратичным алгоритмом.
  if (typeof before !== 'string' || typeof after !== 'string' || before.length > 200000 || after.length > 200000) return [];
  const src = tokens(before);
  const dst = tokens(after);
  // При вставке или удалении позиционное сопоставление неоднозначно.
  if (!src?.length || !dst?.length || src.length !== dst.length) return [];
  const knownWords = new Set((Array.isArray(known) ? known : []).map((k) => dictionaryWordKey(k?.word)).filter(Boolean));
  const out = [];
  const used = new Set();
  const mappings = new Map();
  for (let i = 0; i < src.length; i += 1) {
    if (src[i].technical || dst[i].technical || src[i].value.length > 96 || dst[i].value.length > 96) continue;
    const source = dictionaryWordKey(src[i].value);
    if (!mappings.has(source)) mappings.set(source, new Set());
    mappings.get(source).add(dictionaryWordKey(dst[i].value));
  }

  for (let i = 0; i < src.length; i += 1) {
    const source = src[i];
    const target = dst[i];
    if (source.technical || target.technical || source.value.length > 96 || target.value.length > 96) continue;
    const a = dictionaryWordKey(source.value);
    const b = dictionaryWordKey(target.value);
    if (a === b || mappings.get(a)?.size !== 1) continue;
    if (STOP.has(normalize(a)) || STOP.has(normalize(b))) continue;
    if (b.length < 3 || used.has(b) || knownWords.has(b)) continue;
    const d = distance(a, b);
    if (d > Math.max(2, Math.round(b.length * 0.4))) continue;
    used.add(b);
    out.push({ word: target.value, pronunciation: source.value });
    if (out.length >= 5) break;
  }
  return out;
}

export default learnFromEdit;
