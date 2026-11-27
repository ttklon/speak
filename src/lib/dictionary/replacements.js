/** Безопасное применение словаря к исходному распознанному тексту. */
import { termVariants } from './aliases.js';

// Пробелы в произношении сравниваем только внутри строки. Новую строку как
// часть произношения не используем: она может разделять разные мысли.
function keyOf(value) {
  return String(value || '').normalize('NFC').toLowerCase().replace(/ё/gu, 'е').replace(/[ \t]+/gu, ' ').trim();
}

function groupsFor(entries) {
  const groups = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (typeof entry?.word !== 'string') continue;
    const word = entry.word.trim();
    if (!word) continue;
    for (const variant of termVariants(entry)) {
      const key = keyOf(variant);
      if (!key || /[\r\n]/u.test(key)) continue;
      if (!groups.has(key)) groups.set(key, new Set());
      groups.get(key).add(word);
    }
  }
  return groups;
}

/** Неоднозначные написания и произношения для предупреждения в словаре. */
export function dictionaryConflicts(entries) {
  return [...groupsFor(entries)].filter(([, words]) => words.size > 1)
    .map(([variant, words]) => ({ variant, words: [...words] }));
}

function patternFor(key) {
  return [...key].map((ch) => {
    if (ch === ' ') return '[ \\t]+';
    if (ch === 'е') return '[её]';
    return ch.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  }).join('');
}

// Преднамеренно узкая защита технических фрагментов, не полноценный парсер
// кода. Работает на непустых блоках без пробелов, включая окружающие кавычки.
function technicalSpans(text) {
  const out = [];
  for (const match of text.matchAll(/\S+/gu)) {
    const token = match[0];
    if (/[\\/@_]/u.test(token) || /[\p{L}\p{N}_-]+\.[\p{L}\p{N}_-]+/u.test(token)) {
      out.push({ start: match.index, end: match.index + token.length });
    }
  }
  return out;
}

// При чрезмерном числе совпадений безопаснее оставить исходный текст целиком,
// чем раздувать память списком кандидатов и зависнуть или потерять диктовку.
const MAX_MATCHES = 50000;

export function applyDictionaryReplacements(text, entries) {
  if (!text || typeof text !== 'string') return text;
  const groups = groupsFor(entries);
  if (!groups.size) return text;
  const candidates = [];
  for (const [key, targets] of groups) {
    if (key.length > text.length) continue;
    // Знаки Unicode, подчёркивание и дефис могут быть частью слова/имени.
    const re = new RegExp(`(?<![\\p{L}\\p{N}\\p{M}_\\-])${patternFor(key)}(?![\\p{L}\\p{N}\\p{M}_\\-])`, 'giu');
    for (const match of text.matchAll(re)) {
      candidates.push({ start: match.index, end: match.index + match[0].length, targets, hit: match[0] });
      if (candidates.length > MAX_MATCHES) return text;
    }
  }
  candidates.sort((a, b) => a.start - b.start || b.end - a.end);
  const protectedSpans = technicalSpans(text);
  let protectedIndex = 0;
  let cursor = 0;
  let out = '';
  for (let i = 0; i < candidates.length;) {
    const candidate = candidates[i];
    const targets = new Set(candidate.targets);
    i += 1;
    // Разные шаблоны могут совпадать в одном диапазоне (в том числе из-за
    // Unicode case folding). Проверяем все цели, а не первую по порядку.
    while (i < candidates.length && candidates[i].start === candidate.start && candidates[i].end === candidate.end) {
      for (const target of candidates[i].targets) targets.add(target);
      i += 1;
    }
    if (candidate.start < cursor) continue;
    while (protectedIndex < protectedSpans.length && protectedSpans[protectedIndex].end <= candidate.start) protectedIndex += 1;
    const blocked = protectedSpans[protectedIndex];
    const technical = blocked && blocked.start < candidate.end && blocked.end > candidate.start;
    out += text.slice(cursor, candidate.start);
    if (targets.size !== 1 || technical) {
      out += candidate.hit;
    } else {
      const word = targets.values().next().value;
      let previous = candidate.start - 1;
      while (previous >= 0 && /\s/u.test(text[previous])) previous -= 1;
      const startsSentence = candidate.start === 0 || (previous >= 0 && /[.!?…]/u.test(text[previous]));
      const capitalizedInText = /[A-ZА-ЯЁ]/u.test(candidate.hit[0]);
      out += startsSentence && capitalizedInText ? word[0].toUpperCase() + word.slice(1) : word;
    }
    cursor = candidate.end;
  }
  return out + text.slice(cursor);
}
