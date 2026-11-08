/**
 * Резюмирование встреч — офлайн, без LLM.
 *
 * Делает частотный анализ по предложениям (TF по значимым словам + позиция),
 * выделяет тезисы, решения и задачи. Если в настройках включена локальная
 * модель Ollama — использует её; иначе остаётся детерминированный офлайн-алгоритм.
 */

import { OPS, llmRewrite } from './textops.js';

const STOP_WORDS = new Set([
  'и', 'в', 'во', 'не', 'что', 'он', 'на', 'я', 'с', 'со', 'как', 'а', 'то', 'все', 'она',
  'так', 'его', 'но', 'да', 'ты', 'к', 'у', 'же', 'вы', 'за', 'бы', 'по', 'только', 'ее',
  'мне', 'было', 'вот', 'от', 'меня', 'еще', 'нет', 'о', 'из', 'ему', 'теперь', 'когда',
  'даже', 'ну', 'вдруг', 'ли', 'если', 'уже', 'или', 'ни', 'быть', 'был', 'него', 'до',
  'вас', 'нибудь', 'опять', 'уж', 'вам', 'ведь', 'там', 'потом', 'себя', 'ничего', 'ей',
  'может', 'они', 'тут', 'где', 'есть', 'надо', 'ней', 'для', 'мы', 'тебя', 'их', 'чем',
  'была', 'сам', 'чтоб', 'без', 'будто', 'чего', 'раз', 'тоже', 'себе', 'под', 'будет',
  'ж', 'тогда', 'кто', 'этот', 'того', 'потому', 'этого', 'какой', 'совсем', 'ним', 'здесь',
  'этом', 'один', 'почти', 'мой', 'тем', 'чтобы', 'нее', 'сейчас', 'были', 'куда', 'зачем',
  'всех', 'никогда', 'можно', 'при', 'наконец', 'два', 'об', 'другой', 'хоть', 'после',
  'над', 'больше', 'тот', 'через', 'эти', 'нас', 'про', 'всего', 'них', 'какая', 'много',
  'разве', 'три', 'эту', 'моя', 'впрочем', 'хорошо', 'свою', 'этой', 'перед', 'иногда',
  'лучше', 'чуть', 'том', 'нельзя', 'такой', 'им', 'более', 'всегда', 'конечно', 'всю',
  'между',
]);

function sentences(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .split(/(?<=[.!?…])\s+|\n+/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 12);
}

function tokens(sentence) {
  return (sentence.toLowerCase().match(/[\p{L}\p{N}-]{3,}/gu) || []).filter(
    (w) => !STOP_WORDS.has(w),
  );
}

/** Ключевые предложения: частота терминов × позиция × длина. */
export function keySentences(text, max = 5) {
  const list = sentences(text);
  if (list.length <= max) return list;

  const freq = new Map();
  list.forEach((s) => {
    tokens(s).forEach((w) => freq.set(w, (freq.get(w) || 0) + 1));
  });

  const scored = list.map((s, i) => {
    const words = tokens(s);
    const score =
      words.reduce((sum, w) => sum + (freq.get(w) || 0), 0) / Math.sqrt(words.length || 1) +
      Math.max(0, 3 - i * 0.35) +
      Math.min(2, s.length / 90);
    return { s, i, score };
  });

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.s);
}

const DECISION_RE =
  /реш(или|ено|ение)|договор(ились|ено)|итог|утверд|согласовал|приняли|принято|перенес/i;

// Задачи — только будущие/инфинитивные формулировки, а не факты о прошлом.
const TASK_RE =
  /(^|\s)(нужно|надо|необходимо|следует|требуется)(?=[\s,.:;!?]|$)|(^|\s)(сделать|подготовить|отправить|проверить|позвонить|напомнить|написать|обновить|согласовать|запустить|собрать|создать|добавить|уточнить|выяснить|назначить)(?=[\s,.:;!?]|$)|до\s+(пятницы|понедельника|вторника|среды|четверга|конца)|завтра|послезавтра|дедлайн|к\s+понедельнику/i;

export function buildSummary(text) {
  const all = sentences(text);
  if (!all.length) return { summary: '', decisions: [], tasks: [] };

  const decisions = all.filter((s) => DECISION_RE.test(s)).slice(0, 4);
  const tasks = all
    .filter((s) => TASK_RE.test(s) && !DECISION_RE.test(s))
    .slice(0, 6)
    .map((s) => s.replace(/^[-•*]\s*/, '').replace(/\s+/g, ' '));

  // Тезисы не дублируют решения и задачи
  const used = new Set([...decisions, ...tasks]);
  const key = keySentences(
    all.filter((s) => !used.has(s)).join(' '),
    4,
  );

  const summary = [
    '**Кратко**',
    ...key.map((s) => `• ${s}`),
    decisions.length ? '\n**Решения**' : '',
    ...decisions.map((s) => `• ${s}`),
    tasks.length ? '\n**Задачи**' : '',
    ...tasks.map((s) => `☐ ${s}`),
  ]
    .filter(Boolean)
    .join('\n');

  return { summary, decisions, tasks };
}

/** Публичная точка: офлайн-резюме + опциональная локальная модель. */
export async function summarizeTranscript(text, settings) {
  if (!text || !text.trim()) return { summary: '', tasks: [], engine: 'offline' };

  if (settings?.aiProcessing && settings?.aiEndpoint) {
    const llm = await llmRewrite({
      endpoint: settings.aiEndpoint,
      model: settings.aiModel,
      system:
        'Сделай краткое резюме встречи: 3–4 тезиса, решения и задачи списком. Ответь только результатом.',
      text: text.slice(0, 6000),
      timeout: 15000,
    });
    if (llm) {
      return {
        summary: llm,
        tasks: buildSummary(text).tasks.map((t) => ({ text: t, done: false })),
        engine: 'llm',
      };
    }
  }

  const { summary, tasks } = buildSummary(text);
  return {
    summary,
    tasks: tasks.map((t) => ({ text: t, done: false })),
    engine: 'offline',
  };
}

export default { buildSummary, keySentences, summarizeTranscript, OPS };
