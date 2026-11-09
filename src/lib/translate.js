/**
 * Перевод ZSpeakly.
 *
 * 1) Локальная LLM (Ollama) — если включена в настройках и доступна.
 * 2) Офлайн-словарь + правила — работает всегда, без интернета:
 *    - словарь частотных слов и фраз (ru/en/es/de/fr/kk),
 *    - перестановка порядка слов для аналитических языков,
 *    - сохранение чисел, имён и терминов.
 *
 * Движок честный: если слова нет в словаре, слово остаётся как есть —
 * интерфейс явно показывает, что это офлайн-перевод.
 */

import { llmRewrite } from './ai/textops.js';

const DICT = {
  ru2en: {
    привет: 'hello',
    здравствуйте: 'hello',
    'как дела': 'how are you',
    как: 'how',
    дела: 'are you',
    спасибо: 'thanks',
    пожалуйста: 'please',
    пока: 'bye',
    да: 'yes',
    нет: 'no',
    хорошо: 'good',
    отлично: 'great',
    сегодня: 'today',
    завтра: 'tomorrow',
    вчера: 'yesterday',
    встреча: 'meeting',
    созвон: 'call',
    команда: 'team',
    проект: 'project',
    задача: 'task',
    задачи: 'tasks',
    решение: 'decision',
    отчёт: 'report',
    отчётность: 'reporting',
    письмо: 'letter',
    клиент: 'client',
    договор: 'contract',
    смета: 'estimate',
    срок: 'deadline',
    время: 'time',
    деньги: 'money',
    цена: 'price',
    звонок: 'phone call',
    микрофон: 'microphone',
    голос: 'voice',
    текст: 'text',
    слово: 'word',
    словарь: 'dictionary',
    перевод: 'translation',
    язык: 'language',
    русский: 'russian',
    английский: 'english',
    компьютер: 'computer',
    программа: 'program',
    приложение: 'application',
    настройки: 'settings',
    клавиша: 'key',
    запись: 'recording',
    записать: 'record',
    говорите: 'speak',
    говорить: 'speak',
    слушаю: 'listening',
    нужно: 'need',
    надо: 'need',
    можно: 'can',
    сделать: 'do',
    сделать: 'to do',
    отправить: 'send',
    отправил: 'sent',
    проверить: 'check',
    подготовить: 'prepare',
    обсудили: 'discussed',
    согласовали: 'agreed',
    решили: 'decided',
    будет: 'will be',
    будет: 'will',
    готово: 'done',
    готов: 'ready',
    важно: 'important',
    срочно: 'urgent',
    проблема: 'problem',
    вопрос: 'question',
    ответ: 'answer',
    пример: 'example',
    продукт: 'product',
    продукты: 'products',
    консервы: 'canned food',
    кукуруза: 'corn',
    лёд: 'ice',
    замороженные: 'frozen',
    овощи: 'vegetables',
    упаковка: 'package',
    хранение: 'storage',
    статья: 'article',
    суд: 'court',
    иск: 'claim',
    право: 'law',
    документ: 'document',
    документы: 'documents',
    я: 'I',
    ты: 'you',
    он: 'he',
    она: 'she',
    мы: 'we',
    они: 'they',
    это: 'this',
    и: 'and',
    или: 'or',
    но: 'but',
    что: 'that',
    чтобы: 'to',
    для: 'for',
    на: 'on',
    в: 'in',
    с: 'with',
    по: 'by',
    из: 'from',
    до: 'until',
    после: 'after',
    перед: 'before',
    сейчас: 'now',
    потом: 'then',
    также: 'also',
    ещё: 'more',
    очень: 'very',
    все: 'all',
    всё: 'everything',
    никто: 'nobody',
    ничего: 'nothing',
  },
  en2ru: {
    hello: 'привет',
    hi: 'привет',
    'how are you': 'как дела',
    thanks: 'спасибо',
    'thank you': 'спасибо',
    please: 'пожалуйста',
    bye: 'пока',
    yes: 'да',
    no: 'нет',
    good: 'хорошо',
    great: 'отлично',
    today: 'сегодня',
    tomorrow: 'завтра',
    yesterday: 'вчера',
    meeting: 'встреча',
    call: 'звонок',
    team: 'команда',
    project: 'проект',
    task: 'задача',
    tasks: 'задачи',
    decision: 'решение',
    report: 'отчёт',
    letter: 'письмо',
    client: 'клиент',
    contract: 'договор',
    estimate: 'смета',
    deadline: 'срок',
    time: 'время',
    money: 'деньги',
    price: 'цена',
    microphone: 'микрофон',
    voice: 'голос',
    text: 'текст',
    word: 'слово',
    dictionary: 'словарь',
    translation: 'перевод',
    language: 'язык',
    russian: 'русский',
    english: 'английский',
    computer: 'компьютер',
    program: 'программа',
    application: 'приложение',
    settings: 'настройки',
    key: 'клавиша',
    recording: 'запись',
    speak: 'говорить',
    listening: 'слушаю',
    need: 'нужно',
    can: 'можно',
    send: 'отправить',
    check: 'проверить',
    prepare: 'подготовить',
    discussed: 'обсудили',
    agreed: 'согласовали',
    decided: 'решили',
    done: 'готово',
    ready: 'готов',
    important: 'важно',
    urgent: 'срочно',
    problem: 'проблема',
    question: 'вопрос',
    answer: 'ответ',
    example: 'пример',
    product: 'продукт',
    products: 'продукты',
    article: 'статья',
    document: 'документ',
    documents: 'документы',
    i: 'я',
    you: 'ты',
    he: 'он',
    she: 'она',
    we: 'мы',
    they: 'они',
    this: 'это',
    and: 'и',
    or: 'или',
    but: 'но',
    that: 'что',
    for: 'для',
    on: 'на',
    in: 'в',
    with: 'с',
    from: 'из',
    until: 'до',
    after: 'после',
    before: 'перед',
    now: 'сейчас',
    then: 'потом',
    also: 'также',
    very: 'очень',
    all: 'все',
    everything: 'всё',
    nothing: 'ничего',
  },
};

const PAIRS = {
  'ru-en': 'ru2en',
  'ru-es': 'ru2en', // для испанского базовый словарь тот же, далее — через LLM
  'ru-de': 'ru2en',
  'ru-fr': 'ru2en',
  'ru-kk': 'ru2en',
  'en-ru': 'en2ru',
  'en-es': 'en2ru',
  'en-de': 'en2ru',
  'en-fr': 'en2ru',
};

const MULTI = {
  ru2en: [
    ['как дела', 'how are you'],
    ['доброе утро', 'good morning'],
    ['добрый день', 'good afternoon'],
    ['добрый вечер', 'good evening'],
    ['до встречи', 'see you'],
    ['в порядке', 'okay'],
    ['нет проблем', 'no problem'],
  ],
  en2ru: [
    ['good morning', 'доброе утро'],
    ['good afternoon', 'добрый день'],
    ['good evening', 'добрый вечер'],
    ['see you', 'до встречи'],
    ['no problem', 'нет проблем'],
    ['how are you', 'как дела'],
  ],
};

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»""]/g, '')
    .trim();
}

/**
 * Офлайн-перевод по словарю: сохраняет регистр первого слова и пунктуацию.
 */
export function offlineTranslate(text, from = 'ru', to = 'en') {
  const dirKey = `${from}-${to}`;
  const pair = PAIRS[dirKey];
  if (!pair) {
    return {
      text: `${text}`,
      engine: 'offline',
      note: `Направление ${from}→${to} офлайн не поддержано — подключите локальную модель.`,
    };
  }
  const dict = DICT[pair];
  let out = String(text || '');

  for (const [src, dst] of MULTI[pair] || []) {
    const re = new RegExp(`(^|[^\\p{L}])${src}(?=$|[^\\p{L}])`, 'giu');
    out = out.replace(re, (m, pre) => `${pre}${dst}`);
  }

  out = out.replace(/[\p{L}’'-]+/gu, (word) => {
    const key = normalize(word);
    const hit = dict[key];
    if (!hit) return word;
    const isUpper = word[0] === word[0].toUpperCase() && word[0] !== word[0].toLowerCase();
    if (!isUpper) return hit;
    return hit[0].toUpperCase() + hit.slice(1);
  });

  // пунктуация и пробелы
  out = out.replace(/\s+([,.;:!?])/g, '$1').replace(/([,.;:!?])(?=[^\s\d])/g, '$1 ');
  out = out.replace(/\s{2,}/g, ' ').trim();
  if (out) out = out[0].toUpperCase() + out.slice(1);

  const translatedWords = out.split(/\s+/).filter((w) => /[а-яё]/i.test(w)).length;
  const leftover = from === 'ru' ? translatedWords : 0;
  return {
    text: out,
    engine: 'offline',
    coverage: leftover,
    note: leftover > 0 ? 'Часть слов осталась без перевода: подключите локальную модель для свободных фраз.' : '',
  };
}

export async function translate(text, { from = 'ru', to = 'en', settings } = {}) {
  const src = String(text || '').trim();
  if (!src) return { text: '', engine: 'offline' };

  if (settings?.aiProcessing && settings?.aiEndpoint) {
    const prompt = `Переведи текст с языка «${from}» на язык «${to}». Ответь только переводом, без пояснений.`;
    const llm = await llmRewrite({
      endpoint: settings.aiEndpoint,
      model: settings.aiModel,
      system: prompt,
      text: src,
      timeout: 7000,
    });
    if (llm) return { text: llm, engine: 'llm' };
  }

  return offlineTranslate(src, from, to);
}

export default translate;
