/**
 * Командный режим: выделил текст — сказал голосом, что с ним сделать.
 *
 * Это не диктовка: сказанное («сократи вдвое», «переведи на английский»,
 * «сделай официальным») — указание к уже написанному тексту, а не новые слова
 * для вставки. Режим есть у Wispr Flow (Command Mode) и FluidVoice, и человек
 * ждёт его от любой диктовки, которая умеет работать с выделением.
 *
 * Здесь только правила: что считать командой и как её назвать. Сама работа с
 * текстом — `lib/ai/instructions.js`, вставка — `lib/hotkeys/selection.js`.
 */

/** Длиннее — это уже не команда, а пересказ: такую не отправляем модели. */
export const COMMAND_LIMITS = { chars: 240 };

/**
 * Превратить сказанное в инструкцию для движка.
 * null — пустая или слишком длинная фраза: лучше честно промолчать, чем
 * отправить в модель случайный шум и испортить текст в чужом окне.
 */
export function commandInstruction(spoken = '') {
  const text = String(spoken || '').trim();
  if (text.length < 2) return null;
  if (text.length > COMMAND_LIMITS.chars) return null;
  return {
    id: 'voice-command',
    title: 'Команда голосом',
    // Промпт — ровно сказанное: человек формулирует, что ему нужно, своими
    // словами. Офлайн-правила (`lib/ai/instructions.js`) понимают частые
    // глаголы, а модель — любые.
    prompt: text,
  };
}

const KINDS = [
  [/сократ|короч|коротк|сжат|укорот|вкратц|кратко/i, 'сократить'],
  [/перев|английск|english|translate/i, 'перевести'],
  [/официальн|формальн|делов|строг|formal/i, 'сделать официальным'],
  [/пункт|список|тезис|bullet/i, 'разбить на пункты'],
  [/исправ|ошибк|опечат|запят|орфограф|пунктуац/i, 'исправить ошибки'],
  [/прост|понятн|объясн|человеческ/i, 'объяснить проще'],
  [/вежлив|мягч|дружелюб/i, 'сделать вежливее'],
];

/** Человеческое название того, что попросили: «сократить», «перевести». */
export function describeCommand(spoken = '') {
  const text = String(spoken || '').trim();
  if (!text) return '';
  for (const [re, label] of KINDS) {
    if (re.test(text)) return label;
  }
  return '';
}

/** Заголовок для тоста: «Команда: сократить» или сама фраза, если не узнали. */
export function commandTitle(spoken = '', limit = 48) {
  const text = String(spoken || '').trim();
  const known = describeCommand(text);
  const label = known || text;
  return label.length > limit ? `${label.slice(0, limit - 1)}…` : label;
}

/** Почему команда не выполнилась — и что сделать человеку. */
export const COMMAND_ERRORS = {
  'no-selection': {
    title: 'Нет выделенного текста',
    message:
      'Команда работает по выделению: выделите текст в любом приложении и нажмите сочетание ещё раз.',
  },
  'empty-command': {
    title: 'Команда не расслышана',
    description: 'Скажите коротко, что сделать: «сократи», «переведи», «исправь ошибки».',
  },
  'no-change': {
    title: 'Изменений нет',
    description: 'Команда не нашла, что поправить в этом тексте.',
  },
  failed: {
    title: 'Команда не выполнилась',
    description: 'Текст остался прежним. Попробуйте ещё раз — выделение никуда не денется.',
  },
};

export default {
  COMMAND_LIMITS,
  commandInstruction,
  describeCommand,
  commandTitle,
  COMMAND_ERRORS,
};
