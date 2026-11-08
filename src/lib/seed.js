/**
 * Демо-данные ZSpeakly.
 * Свежие записи повторяют то, что видно в видео (кадр 148s):
 *   23:15 «Привет, как дела?», 23:14 «Вот, видишь, я сейчас записываю свой голос…»,
 *   18:14 / 15:05 / 15:02 / 15:01 — записи с рабочими формулировками.
 */

import { words } from './utils.js';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function at(daysAgo, hours, minutes, now = new Date()) {
  const d = new Date(now.getTime() - daysAgo * DAY);
  d.setHours(hours, minutes, 0, 0);
  return d.getTime();
}

const RECENT_TEXTS = [
  'Привет, как дела?',
  'Вот, видишь, я сейчас записываю свой голос, и он транскрибируется быстро в текст. И я могу это все использовать.',
  'Сегодня созвон с командой в 15:00, нужно подготовить короткое резюме по кварталу и отправить Ане до обеда.',
  'Также у некоторых продуктов, например консервы (например, консервы с кукурузой), срок хранения может быть больше года.',
  'Учитывая, что в некоторых продуктах может быть лёд (например, если какие-нибудь замороженные овощи), важно проверять упаковку.',
  'Напомни, что завтра нужно продлить аренду склада и проверить счёт за электричество.',
];

const OLDER_TEXTS = [
  'Решение задач по гражданскому процессуальному праву Российской Федерации требует внимательного анализа норм ГПК.',
  'Используя агентов поиска, находим источники, в том числе самые актуальные ППК РФ, и проверяем их на противоречия.',
  'Содержание задачи и формулировка искового заявления должны соответствовать требованиям статьи 131 ГПК РФ.',
  'Подготовь краткий пересказ встречи: обсудили сроки релиза, риски по интеграции и ответственных по задачам.',
  'Черновик письма клиенту: спасибо за встречу, направляем смету и план работ, ждём обратную связь до пятницы.',
  'Идея для поста: как офлайн-диктовка экономит два часа в день и почему данные не должны уходить в облако.',
  'Список покупок: молоко, хлеб, кофе в зёрнах, батарейки AA, средство для мытья посуды.',
  'Тезисы выступления: голос быстрее клавиатуры в три раза, а точность распознавания на русском уже достаточная.',
  'Проверить, что бэкап базы SQLite делается ежедневно и лежит в отдельной папке на другом диске.',
  'Перевод фразы для письма: «Мы готовы начать работу с понедельника, если условия согласованы».',
  'Заметка по книгам: дочитать главу про внимание, выписать три практики и попробовать их на неделе.',
  'Резюме звонка с поставщиком: цены выросли на восемь процентов, обсуждаем фиксацию на квартал.',
  'Сформулируй три варианта заголовка для лендинга ZSpeakly, каждый до семи слов.',
  'Что нужно сделать перед релизом: прогнать тесты, обновить changelog, собрать installers и проверить подписи.',
  'Сделай формально: «Привет, скинь плиз документы, которые обещал вчера».',
];

export function buildSeedDictations(now = new Date()) {
  const items = [];

  const recentTimes = [
    [0, 23, 15], [0, 23, 14], [0, 18, 14], [0, 15, 5], [0, 15, 2], [0, 15, 1],
  ];
  RECENT_TEXTS.forEach((text, i) => {
    const [d, h, m] = recentTimes[i];
    const durationMs = Math.round(words(text) * 420 + 900);
    items.push({
      id: `seed_recent_${i}`,
      text,
      createdAt: at(d, h, m, now),
      durationMs,
      words: words(text),
      language: 'ru',
      source: 'dictation',
    });
  });

  OLDER_TEXTS.forEach((text, i) => {
    const daysAgo = 1 + Math.floor(i / 2);
    const h = 9 + ((i * 3) % 9);
    const m = (i * 17) % 60;
    items.push({
      id: `seed_old_${i}`,
      text,
      createdAt: at(daysAgo, h, m, now),
      durationMs: Math.round(words(text) * 430 + 800),
      words: words(text),
      language: 'ru',
      source: i % 4 === 0 ? 'hotkey' : 'dictation',
    });
  });

  return items.sort((a, b) => b.createdAt - a.createdAt);
}

const CLIPBOARD_TEXTS = [
  {
    text: 'Вот, видишь, я сейчас записываю свой голос, и он транскрибируется быстро в текст. И я могу это все использовать.',
    source: 'Program Manager',
    kind: 'text',
    minutesAgo: 4,
  },
  {
    text: '**Решение задач по гражданскому процессуальному праву Российской Федерации\n\nЗадача 1. Судья отказал в принятии искового заявления, сославшись на несоблюдение досудебного порядка.',
    source: 'Genspark – Решение задач по граж…',
    kind: 'format',
    minutesAgo: 12,
  },
  {
    text: '**Нюанс — развёрнутый конспект для устного ответа: семья, история, короткая ссылка на вывод о праве.',
    source: 'Genspark – import_agent + ещё 3…',
    kind: 'format',
    minutesAgo: 19,
  },
  {
    text: 'родители. В повестку дня входит вопрос о подведении учащихся школы за…',
    source: 'Курс: Гражданское процессуальное право',
    kind: 'text',
    minutesAgo: 26,
  },
  {
    text: '— «По слухам на предприятии «Алтайтара» в обход налогового и трудового…',
    source: 'Курс: Гражданское процессуальное право',
    kind: 'text',
    minutesAgo: 41,
  },
  {
    text: '1. Саранина предъявила к Медерских иск о разделе дома. В связи с тем, что исковое заявление не…',
    source: 'Курс: Гражданское процессуальное право',
    kind: 'text',
    minutesAgo: 55,
  },
  {
    text: '**Ответ об объёме проверки:** ниже — подробный ответ по проверенным текстам ППК.',
    source: 'Запрос на подробный разбор внут…',
    kind: 'format',
    minutesAgo: 73,
  },
  {
    text: '1. Лазарев А.В. является директором ООО «Алтайтара», о нём в статье указано, что он…',
    source: 'Курс: Гражданское процессуальное право',
    kind: 'text',
    minutesAgo: 96,
  },
  {
    text: 'Ссылка на репозиторий: https://github.com/ttklon/speak — MIT, бесплатно навсегда.',
    source: 'Браузер',
    kind: 'text',
    minutesAgo: 120,
  },
  {
    text: 'Смета на разработку: 1) дизайн — 40 ч, 2) бэкенд — 60 ч, 3) сборка установщика — 8 ч.',
    source: 'Spreadsheet',
    kind: 'format',
    minutesAgo: 150,
  },
  {
    text: 'Пароль от гостевого Wi-Fi: almaty-2026 (ключ хранится локально).',
    source: 'Заметки',
    kind: 'password',
    minutesAgo: 200,
  },
  {
    text: 'Список файлов проекта: ZSpeakly.sln, electron/main.cjs, src/App.jsx, docs/00-VIDEO-TEARDOWN.md',
    source: 'File Explorer',
    kind: 'file',
    minutesAgo: 240,
  },
];

/** Тонкие SVG-превью документов, скриншотов и фото — как плитки из видео. */
const DOC_PREVIEW = (seed, dark = false) => {
  const bg = dark ? '#111318' : '#f7f7f5';
  const line = dark ? '#2b3240' : '#d7d9dd';
  const accent = ['#7aa2f7', '#e5534b', '#c9a227', '#5fd08a'][seed % 4];
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200">
      <rect width="320" height="200" fill="${bg}"/>
      ${dark
        ? `<rect x="0" y="0" width="320" height="18" fill="#1b2029"/>
           <rect x="12" y="30" width="120" height="6" rx="3" fill="${accent}"/>
           ${Array.from({ length: 9 }, (_, i) => `<rect x="12" y="${48 + i * 14}" width="${180 + ((i * 37) % 100)}" height="5" rx="2.5" fill="${line}"/>`).join('')}
           ${Array.from({ length: 7 }, (_, i) => `<rect x="40" y="${52 + i * 17}" width="${100 + ((i * 53) % 120)}" height="4" rx="2" fill="#7b8494"/>`).join('')}`
        : `<rect x="18" y="16" width="284" height="8" rx="3" fill="#c9ccd2"/>
           <rect x="18" y="34" width="150" height="6" rx="3" fill="${accent}" opacity="0.7"/>
           ${Array.from({ length: 10 }, (_, i) => `<rect x="18" y="${52 + i * 13}" width="${120 + ((i * 47) % 150)}" height="4" rx="2" fill="${line}"/>`).join('')}
           <rect x="18" y="182" width="130" height="4" rx="2" fill="#e4e6e9"/>`}
    </svg>`,
  )}`;
};

const PHOTO_PREVIEW = (hue) =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="hsl(${hue} 26% 34%)"/><stop offset="100%" stop-color="hsl(${(hue + 40) % 360} 18% 16%)"/>
      </linearGradient></defs>
      <rect width="320" height="200" fill="url(#g)"/>
      <circle cx="160" cy="86" r="34" fill="hsl(${hue} 20% 26%)"/>
      <path d="M96 200c0-38 29-62 64-62s64 24 64 62z" fill="hsl(${hue} 16% 22%)"/>
    </svg>`,
  )}`;

export function buildSeedClipboard(now = new Date()) {
  const texts = CLIPBOARD_TEXTS.map((item, i) => ({
    id: `seed_clip_${i}`,
    kind: item.kind,
    text: item.text,
    source: item.source,
    createdAt: now.getTime() - item.minutesAgo * MIN,
    pinned: false,
  }));

  const images = [
    { source: 'Scroll Capture…', seed: 0, dark: false },
    { source: 'Arena | Веб-интерф', seed: 1, dark: false },
    { source: 'Scroll Capture…', seed: 2, dark: false },
    { source: 'Arena | Веб-интерф', seed: 3, dark: false },
    { source: 'Scroll Capture…', seed: 4, dark: true },
    { source: 'Scroll Capture…', seed: 5, dark: true },
    { source: 'Scroll Capture…', seed: 6, dark: true },
    { source: 'Scroll Capture…', seed: 7, dark: true },
  ].map((item, i) => ({
    id: `seed_img_${i}`,
    kind: 'image',
    text: '',
    image: DOC_PREVIEW(item.seed, item.dark),
    source: item.source,
    createdAt: now.getTime() - (140 + i * 23) * MIN,
    pinned: false,
  }));

  const photos = [
    { source: 'Собеседование: фото кандидата', hue: 210 },
    { source: 'Собеседование: фото кандидата', hue: 188 },
    { source: 'Собеседование: фото кандидата', hue: 12 },
    { source: 'Цветовая палитра для сайта', hue: 205 },
  ].map((item, i) => ({
    id: `seed_photo_${i}`,
    kind: 'image',
    text: '',
    image: PHOTO_PREVIEW(item.hue),
    source: item.source,
    createdAt: now.getTime() - (300 + i * 31) * MIN,
    pinned: false,
  }));

  return [...texts, ...images, ...photos].sort((a, b) => b.createdAt - a.createdAt);
}

export const SEED_DICTIONARY = [
  { id: 'dict_1', word: 'ZSpeakly', pronunciation: 'зи-спикли', createdAt: Date.now() - 5 * DAY },
  { id: 'dict_2', word: 'Whisper', pronunciation: 'виспер', createdAt: Date.now() - 4 * DAY },
  { id: 'dict_3', word: 'Алтайтара', pronunciation: 'алтай-тара', createdAt: Date.now() - 2 * DAY },
];

export function buildSeedSessions(now = new Date()) {
  return [
    {
      id: 'seed_sess_1',
      mode: 'transcript',
      source: 'mic',
      from: 'ru',
      to: 'en',
      startedAt: now.getTime() - 3 * HOUR - 20 * MIN,
      durationMs: 11 * MIN,
      lines: [
        {
          id: 'ln1',
          at: now.getTime() - 3 * HOUR - 20 * MIN,
          src: 'Привет, как дела? Начнём со статуса по проекту.',
          dst: 'Hello, how are you? Let us start with the project status.',
        },
        {
          id: 'ln2',
          at: now.getTime() - 3 * HOUR - 18 * MIN,
          src: 'Команда подготовила смету, нужно проверить сроки до пятницы.',
          dst: 'The team has prepared the estimate, we need to check the deadline before Friday.',
        },
        {
          id: 'ln3',
          at: now.getTime() - 3 * HOUR - 15 * MIN,
          src: 'Спасибо, отправлю письмо клиенту сегодня.',
          dst: 'Thank you, I will send the letter to the client today.',
        },
      ],
    },
    {
      id: 'seed_sess_2',
      mode: 'subtitles',
      source: 'both',
      from: 'en',
      to: 'ru',
      startedAt: now.getTime() - 26 * HOUR,
      durationMs: 24 * MIN,
      lines: [
        {
          id: 'ln4',
          at: now.getTime() - 26 * HOUR,
          src: 'Good morning, team. Today we discuss the release plan.',
          dst: 'Доброе утро, команда. Сегодня мы обсуждаем план релиза.',
        },
        {
          id: 'ln5',
          at: now.getTime() - 26 * HOUR + 4 * MIN,
          src: 'The important thing is to check every scenario before the demo.',
          dst: 'Важно проверить каждый сценарий перед демонстрацией.',
        },
      ],
    },
  ];
}

export const SEED_SESSIONS = [];

export const SEED_MEETINGS = [];
