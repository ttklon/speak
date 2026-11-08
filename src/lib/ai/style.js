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

/** Короткое человеческое описание профиля для интерфейса. */
export function describeStyle(style) {
  if (!style || !style.samples) return 'Пока нечего анализировать: продиктуйте пару фраз.';
  const parts = [
    `${style.samples} текстов`,
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
