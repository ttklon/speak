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
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(text) {
  return normalize(text).split(' ').filter(Boolean);
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
  const src = tokens(before);
  const dst = tokens(after);
  if (!src.length || !dst.length) return [];
  const knownWords = new Set(known.map((k) => normalize(k.word || '')).filter(Boolean));
  const out = [];
  const used = new Set();

  // Жадное сопоставление: одинаковые слова пропускаем, изменённые — кандидаты
  const limit = Math.min(src.length, dst.length);
  for (let i = 0; i < limit; i += 1) {
    const a = src[i];
    const b = dst[i];
    if (a === b) continue;
    if (STOP.has(a) || STOP.has(b)) continue;
    if (b.length < 3 || used.has(b) || knownWords.has(b)) continue;
    // Имеет смысл учить только близкие замены (опечатка/распознавание), не новый смысл
    const d = distance(a, b);
    if (d > Math.max(2, Math.round(b.length * 0.4))) continue;
    used.add(b);
    out.push({ word: b, pronunciation: a });
    if (out.length >= 5) break;
  }
  return out;
}

/** Учёт уже добавленного слова: увеличивает счётчик «сколько раз пригодилось». */
export function bumpUsage(entries = [], id) {
  return entries.map((e) => (e.id === id ? { ...e, hits: (e.hits || 0) + 1 } : e));
}

export default learnFromEdit;
