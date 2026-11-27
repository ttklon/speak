/**
 * «Сравнить модели на моей записи».
 *
 * Зачем: человеку не нужно верить подписям «точнее» и «быстрее». Он говорит одну
 * фразу, приложение прогоняет её через скачанные модели и показывает рядом: текст,
 * время счёта и сколько терминов из словаря каждая модель услышала. Дальше решает
 * он сам — это и есть честно: приложение не знает, что человек сказал, и не может
 * объявить победителя.
 *
 * Совпадение со словарём не доказывает, что слово было произнесено: без
 * эталона нельзя объявлять модель точнее или выбирать победителя.
 */

import { startPcmRecording } from './audio/pcmRecorder.js';
import { termVariants } from './dictionary/aliases.js';

/** Вариант может быть из нескольких слов («эс кью эл») — тогда ищем фразу целиком. */
function matchesVariant(variant, tokens, haystack) {
  if (variant.includes(' ')) return ` ${haystack} `.includes(` ${variant} `);
  return tokens.has(variant);
}
import { tierForModel } from './modelTiers.js';

/** Больше трёх моделей сравнивать бессмысленно: это минуты счёта на слабом CPU. */
export const COMPARE_LIMIT = 3;

/** Сколько секунд пишем. Пять — хватает на фразу с терминами. */
export const COMPARE_SECONDS = 5;

const norm = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Какие модели сравнивать: только уже скачанные, текущая — первой, остальные по
 * порядку «режимов» (быстро → сбалансированно → максимум). Не скачанные не
 * предлагаем: сравнение не должно требовать загрузки гигабайтов.
 */
export function pickCompareModels({ downloaded = [], current = '', order = [] } = {}) {
  const have = Array.from(new Set((downloaded || []).map(String).filter(Boolean)));
  if (!have.length) return [];
  const ranked = [];
  if (current && have.includes(current)) ranked.push(current);
  for (const id of order || []) {
    if (have.includes(id) && !ranked.includes(id)) ranked.push(id);
  }
  for (const id of have) {
    if (!ranked.includes(id)) ranked.push(id);
  }
  return ranked.slice(0, COMPARE_LIMIT);
}

/** Сколько слов из словаря реально попало в текст (по целым словам). */
export function scoreTerms(text, words = []) {
  const haystack = norm(text);
  const tokens = new Set(haystack.split(' ').filter(Boolean));
  const seen = new Set();
  const matched = [];
  for (const raw of words || []) {
    const word = norm(typeof raw === 'object' && raw ? raw.word : raw);
    if (!word || seen.has(word)) continue;
    seen.add(word);
    // Считаем попаданием любое известное написание: модель услышала «зум»,
    // а в словаре записано Zoom — это попадание, а не промах. Иначе сравнение
    // моделей штрафовало бы их за то, что они пишут кириллицей.
    const variants = termVariants(raw).map(norm).filter(Boolean);
    // только целое слово: «зуммер» — это не «зум», иначе счёт врал бы в плюс
    if (variants.some((variant) => matchesVariant(variant, tokens, haystack))) matched.push(word);
  }
  const total = seen.size;
  return { matched, total, ratio: total ? matched.length / total : 0 };
}

/**
 * Итог сравнения словами без автоматического выбора победителя.
 */
export function describeComparison(rows = []) {
  const ok = (rows || []).filter((row) => row && row.ok && row.text);
  if (ok.length < 2) return { winner: '', summary: 'Сравнивать нечего: текст дала только одна модель.' };
  const scored = ok.map((row) => ({ ...row, score: scoreTerms(row.text, row.words || []) }));
  const withTerms = scored.filter((row) => row.score.total > 0);
  return {
    winner: '',
    summary: withTerms.length
      ? 'Показаны совпадения со словарём в результатах. Это не оценка точности: приложение не знает, что вы сказали. Сравните тексты вручную.'
      : 'Словарь для сравнения пуст. Приложение не знает, что вы сказали: сравните тексты вручную.',
    rows: scored,
  };
}

/** Записать фразу один раз и прогнать через выбранные модели. */
export async function runModelComparison({
  models = [],
  lang = 'ru',
  words = [],
  seconds = COMPARE_SECONDS,
  onLevel,
  onStage,
} = {}) {
  const native = typeof window !== 'undefined' ? window.zspeakly?.native : null;
  if (!native?.compareModels) {
    return { ok: false, reason: 'сравнение работает только в приложении для Windows' };
  }
  if (!models.length) return { ok: false, reason: 'нет скачанных моделей для сравнения' };

  let rec = null;
  try {
    rec = await startPcmRecording({ onLevel });
  } catch (err) {
    return { ok: false, reason: `микрофон не открылся: ${String(err?.message || err)}` };
  }
  onStage?.('record');
  await new Promise((resolve) => setTimeout(resolve, Math.max(1500, seconds * 1000)));
  let stopped;
  try {
    stopped = rec.stop();
  } catch (err) {
    return { ok: false, reason: `запись сорвалась: ${String(err?.message || err)}` };
  }
  if (!stopped?.pcm?.length) {
    return { ok: false, reason: 'микрофон не отдал звук — запись не началась' };
  }
  onStage?.('compare');
  let res = null;
  try {
    res = await native.compareModels({
      pcm: stopped.pcm,
      sampleRate: stopped.sampleRate || 16000,
      lang,
      models,
    });
  } catch (err) {
    return { ok: false, reason: `движок не ответил: ${String(err?.message || err)}` };
  }
  if (!res || res.ok === false) {
    return { ok: false, reason: res?.reason || 'сравнение не удалось' };
  }
  // label — человеческое название режима: «Быстро», «Сбалансированно».
  // Внутренние id моделей человеку ничего не говорят.
  const rows = (res.rows || []).map((row) => ({
    ...row,
    words,
    label: tierForModel(row.model)?.label || row.model,
  }));
  const verdict = describeComparison(rows);
  return {
    ok: true,
    rows: verdict.rows || rows,
    summary: verdict.summary,
    winner: verdict.winner,
    seconds: res.seconds || 0,
  };
}

export default runModelComparison;
