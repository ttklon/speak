/**
 * Оформление текста под место вставки.
 *
 * Зачем: одна и та же фраза в разных окнах выглядит по-разному. В мессенджере
 * в чате часто не нужна конечная точка, а в редакторе кода изменение регистра,
 * пунктуации или отступов может сломать выражение. В письме часто нужна
 * заглавная буква и конечная точка.
 *
 * Здесь только то, что можно решить без человека и без модели: знаки в конце,
 * заглавная в начале, лишние пробелы. Никакого переписывания слов: за стиль
 * отвечает человек, а за пунктуацию — движок.
 *
 * Правила намеренно скромные. «Умное» форматирование, которое меняет слова,
 * в диктовке страшнее, чем его отсутствие: человек диктует, чтобы получить
 * ровно то, что сказал.
 */

/**
 * Известные окна. Сравнение — по подстроке в имени программы или заголовке:
 * «Telegram Desktop», «WhatsApp», «Slack | general» — всё это чат.
 * Список не претендует на полноту: незнакомое окно получает `neutral`, и это
 * нормальное поведение, а не ошибка.
 */
const MATCHERS = [
  {
    style: 'chat',
    // мессенджеры: здесь фраза живёт без точки и без официоза
    names: [
      'telegram',
      'whatsapp',
      'slack',
      'discord',
      'viber',
      'signal',
      'element',
      'skype',
      'messenger',
      'teams',
      'mattermost',
      'rocket.chat',
      'zoom chat',
      'телеграм',
    ],
  },
  {
    style: 'code',
    // редакторы и терминалы: не угадываем регистр и пунктуацию
    names: [
      'visual studio code',
      'vscode',
      'cursor',
      'windsurf',
      'sublime text',
      'notepad++',
      'webstorm',
      'intellij',
      'pycharm',
      'goland',
      'clion',
      'rider',
      'android studio',
      'xcode',
      'neovim',
      'vim',
      'emacs',
      'windows terminal',
      'powershell',
      'cmd.exe',
      'command prompt',
      'git bash',
      'wsl',
      'zsh',
      'bash',
      'postman',
      'insomnia',
      'dbeaver',
      'ssms',
      'github desktop',
    ],
  },
  {
    style: 'mail',
    names: ['outlook', 'thunderbird', 'spark', 'postbox', 'em client', 'почта', 'mail', 'superhuman'],
  },
  {
    style: 'doc',
    names: ['winword', 'microsoft word', 'notion', 'obsidian', 'onenote', 'libreoffice', 'writer', 'google docs', 'confluence', 'coda', 'ulysses', 'bear'],
  },
];

/**
 * Определить стиль окна.
 * @param {{ app?: string, title?: string }} [target] что вернул `text:target`
 * @returns {{ style: string, label: string, why: string }}
 */
export function resolveAppStyle(target = {}) {
  const haystack = `${target.app || ''} ${target.title || ''}`.toLowerCase();
  if (!haystack.trim()) {
    return { style: 'neutral', label: 'как есть', why: 'окно не определено' };
  }
  for (const matcher of MATCHERS) {
    const hit = matcher.names.find((name) => haystack.includes(name));
    if (hit) {
      return {
        style: matcher.style,
        label: STYLE_LABELS[matcher.style],
        why: hit,
      };
    }
  }
  return { style: 'neutral', label: 'как есть', why: 'незнакомое окно' };
}

const STYLE_LABELS = {
  chat: 'без точки в конце',
  code: 'без дополнительного оформления',
  mail: 'с заглавной и точкой',
  doc: 'с заглавной',
  neutral: 'как есть',
};

function firstLetterUpper(text) {
  const head = text[0];
  if (head.toUpperCase() === head) return text;
  return head.toUpperCase() + text.slice(1);
}

/** Единственная точка в самом конце — и ничего после. */
function withoutTrailingPeriod(text) {
  return text.replace(/\.$/u, '');
}

/**
 * Привести текст к стилю окна.
 *
 * @param {string} text готовый текст диктовки
 * @param {string} style из `resolveAppStyle`
 * @returns {string}
 */
export function formatForApp(text, style = 'neutral') {
  const source = String(text ?? '');
  // A capital letter, final period or indentation may be code, not prose.
  if (style === 'code') return source.trim() ? source : '';
  let out = source
    .replace(/[ \t]+/gu, ' ')
    .replace(/ ?\n ?/gu, '\n')
    .trim();
  if (!out) return out;
  switch (style) {
    case 'chat':
      // Многострочное сообщение точку в конце всё равно не заслуживает: люди
      // так не пишут. Вопросительный и восклицательный не трогаем.
      return withoutTrailingPeriod(out);
    case 'mail':
      return ensureSentence(out);
    case 'doc':
      return firstLetterUpper(out);
    default:
      return out;
  }
}

/** Письмо: заглавная в начале, точка в конце — если текст не кончается знаком. */
function ensureSentence(text) {
  const upper = firstLetterUpper(text);
  return /[.!?…:;»)]$/u.test(upper) ? upper : `${upper}.`;
}

/**
 * Что человек увидит в диагностике: «Telegram — без точки в конце».
 * @param {{ app?: string, title?: string }} target
 */
export function describeTarget(target = {}) {
  const { style, label } = resolveAppStyle(target);
  return { style, label, app: String(target.app || target.title || '').trim() };
}
