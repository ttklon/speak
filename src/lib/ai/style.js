/**
 * «Стиль письма» — обучение на ваших же текстах, полностью локально.
 *
 * Берём историю диктовок, считаем реальные признаки стиля (средняя длина
 * предложения, обращение на «ты»/«вы», эмодзи, восклицания, любимые вводные)
 * и строим профиль. Профиль подмешивается в промпт AI-инструкций и в
 * постобработку, чтобы ответы звучали как вы.
 */

const TONE_WORDS = {
  friendly: ['привет', 'спасибо', 'давай', 'окей', 'класс', 'супер', 'друзья', 'ребята'],
  formal: ['здравствуйте', 'коллеги', 'прошу', 'направляю', 'с уважением', 'необходимо'],
};

export function analyzeStyle(dictations = []) {
  const texts = dictations
    .map((d) => String(d.text || '').trim())
    .filter((t) => t.length > 12)
    .slice(0, 200);

  if (!texts.length) {
    return {
      samples: 0,
      avgSentence: 0,
      avgWords: 0,
      emoji: false,
      exclamations: 0,
      address: 'unknown',
      tone: 'neutral',
      openers: [],
    };
  }

  const joined = texts.join(' ');
  const sentences = joined.split(/(?<=[.!?…])\s+/).filter((s) => s.trim().length > 3);
  const words = joined.split(/\s+/).filter(Boolean);

  const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(joined);
  const exclamations = (joined.match(/!/g) || []).length / texts.length;
  // \b в JS не работает с кириллицей — используем явные границы
  const edge = (w) => new RegExp(`(?:^|[^\\p{L}])(${w})(?=[^\\p{L}]|$)`, 'giu');
  const tyCount = (joined.match(edge('ты|тебе|твой|твоя|тобой')) || []).length;
  const vyCount = (joined.match(edge('вы|вам|ваш|ваша|вами')) || []).length;
  const address = tyCount > vyCount * 1.5 ? 'ты' : vyCount > tyCount * 1.5 ? 'вы' : 'нейтрально';

  let friendly = 0;
  let formal = 0;
  const has = (w) => new RegExp(`(?:^|[^\\p{L}])${w}`, 'iu').test(joined);
  for (const w of TONE_WORDS.friendly) if (has(w)) friendly += 1;
  for (const w of TONE_WORDS.formal) if (has(w)) formal += 1;
  const tone = friendly > formal ? 'friendly' : formal > friendly ? 'formal' : 'neutral';

  // частые первые слова предложений — «вводные», по которым узнаётся автор
  const firstWords = sentences
    .map((s) => s.trim().split(/\s+/)[0]?.toLowerCase().replace(/[^\p{L}]/gu, ''))
    .filter((w) => w && w.length > 2);
  const freq = new Map();
  firstWords.forEach((w) => freq.set(w, (freq.get(w) || 0) + 1));
  const openers = [...freq.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([w, n]) => ({ word: w, count: n }));

  return {
    samples: texts.length,
    avgSentence: Math.round(words.length / Math.max(1, sentences.length)),
    avgWords: Math.round(words.length / texts.length),
    emoji,
    exclamations: Math.round(exclamations * 100) / 100,
    address,
    tone,
    openers,
  };
}

/** Русское склонение: 1 текст, 2 текста, 5 текстов. */
export function plural(n, one, few, many) {
  const abs = Math.abs(Number(n) || 0) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

/**
 * Подстроить текст под стиль без LLM.
 *
 * Правила намеренно консервативные: меняем только то, что не ломает
 * грамматику — эмодзи, канцелярит, длину фраз и частые формы «вы» → «ты»
 * (только там, где форма глагола известна). Всё остальное делает LLM,
 * если она включена: в промпт уходит stylePrompt().
 */
/** Границы слова для кириллицы: \b в JS с ней не работает. */
const W = (body, flags = 'g') =>
  new RegExp(`(?<![\\p{L}\\p{N}])(${body})(?![\\p{L}\\p{N}])`, `${flags}u`);

/** Пары «вы» → «ты» по точным словоформам: падежи не ломаем. */
const VY_TO_TY = [
  ['Вы можете', 'Ты можешь'],
  ['вы можете', 'ты можешь'],
  ['Вы должны', 'Ты должен'],
  ['вы должны', 'ты должен'],
  ['Вы хотите', 'Ты хочешь'],
  ['вы хотите', 'ты хочешь'],
  ['Вы знаете', 'Ты знаешь'],
  ['вы знаете', 'ты знаешь'],
  ['Вы сделали', 'Ты сделал'],
  ['вы сделали', 'ты сделал'],
  ['Вы говорите', 'Ты говоришь'],
  ['вы говорите', 'ты говоришь'],
  ['Вам', 'Тебе'],
  ['вам', 'тебе'],
  ['Вас', 'Тебя'],
  ['вас', 'тебя'],
  ['Ваша', 'Твоя'],
  ['ваша', 'твоя'],
  ['Ваше', 'Твоё'],
  ['ваше', 'твоё'],
  ['Ваши', 'Твои'],
  ['ваши', 'твои'],
  ['Вашего', 'Твоего'],
  ['вашего', 'твоего'],
  ['Вашему', 'Твоему'],
  ['вашему', 'твоему'],
  ['Вашим', 'Твоим'],
  ['вашим', 'твоим'],
  ['Ваших', 'Твоих'],
  ['ваших', 'твоих'],
  ['Вашей', 'Твоей'],
  ['вашей', 'твоей'],
  ['Ваш', 'Твой'],
  ['ваш', 'твой'],
];

const OFFICIAL = [
  ['осуществляем', 'делаем'],
  ['осуществляете', 'делаете'],
  ['осуществляется', 'делается'],
  ['осуществлять', 'делать'],
  ['осуществляет', 'делает'],
  ['осуществить', 'сделать'],
  ['осуществим', 'сделаем'],
  ['в целях', 'чтобы'],
  ['на сегодняшний день', 'сейчас'],
  ['в настоящее время', 'сейчас'],
  ['необходимо', 'нужно'],
];

export function applyStyle(text, style) {
  let out = String(text || '');
  if (!out.trim() || !style?.samples) return out;

  if (style.address === 'ты') {
    // длинные формы первыми, иначе «Ваш» съест «Ваша»
    for (const [from, to] of VY_TO_TY) out = out.replace(W(from, 'g'), to);
  }

  // человек почти не ставит эмодзи — вычищаем их из результата
  if (style.emoji === false) {
    out = out.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '');
  }

  for (const [from, to] of OFFICIAL) out = out.replace(W(from, 'gi'), to);

  // короткие фразы: длинное предложение без точек режем по запятым
  if (style.avgSentence && style.avgSentence < 12) {
    out = out.replace(/([^.!?…\n]{100,}?),\s+/g, '$1. ');
  }

  return out.replace(/[ \t]{2,}/g, ' ').replace(/\s+([,.!?…])/g, '$1').trim();
}

/** Короткое человеческое описание профиля для интерфейса. */
export function describeStyle(style) {
  if (!style || !style.samples) return 'Пока нечего анализировать: продиктуйте пару фраз.';
  const parts = [
    `${style.samples} ${plural(style.samples, 'текст', 'текста', 'текстов')}`,
    `≈${style.avgSentence} слов в предложении`,
    style.address === 'ты' ? 'на «ты»' : style.address === 'вы' ? 'на «вы»' : 'нейтрально',
    style.tone === 'friendly' ? 'дружелюбно' : style.tone === 'formal' ? 'по-деловому' : 'без выраженного тона',
  ];
  if (style.exclamations > 0.8) parts.push('с восклицаниями');
  if (style.emoji) parts.push('иногда эмодзи');
  return parts.join(' · ');
}

/** Системная подсказка для локальной LLM — чтобы ответ звучал как автор. */
export function stylePrompt(style) {
  if (!style?.samples) return '';
  const lines = [
    `Пиши в стиле автора: ${describeStyle(style)}.`,
    style.address === 'ты' ? 'Обращайся на «ты».' : style.address === 'вы' ? 'Обращайся на «вы».' : '',
    style.emoji ? 'Уместны редкие эмодзи.' : 'Без эмодзи.',
    style.avgSentence ? `Держи длину предложения около ${style.avgSentence} слов.` : '',
  ];
  return lines.filter(Boolean).join(' ');
}

export default analyzeStyle;
