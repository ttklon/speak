/**
 * ZSpeakly — единая точка правды по умолчанию.
 * Все значения соответствуют видео-разбору (docs/00-VIDEO-TEARDOWN.md),
 * кроме "платных" ограничений: ZSpeakly — бесплатный офлайн-клон, лимитов нет.
 */

import { MODEL_TIERS } from './modelTiers.js';

export const APP = {
  name: 'ZSpeakly',
  tagline: 'Не печатай, просто ZSpeakly.',
  version: '1.30.0',
  build: '2026.11.11',
  repo: 'https://github.com/ttklon/speak',
  site: 'https://github.com/ttklon/speak#readme',
  freeNote: 'Всё локально: без облака, подписки и лимитов слов.',
  description:
    'Нажмите клавишу — запись начнётся, нажмите ещё раз — текст вставится. Двойное нажатие открывает режим агента.',
};

/**
 * Одна строка правды на первом экране: чем мы отличаемся от встроенной
 * диктовки Windows. У Handy, SweetWhisper и OpenWhispr это написано прямо в
 * README, а у нас человек должен был догадаться сам.
 *
 * Коротко и проверяемо: бесплатность, офлайн и разница с Win+H. Формулировки
 * про Win+H совпадают с docs/13-LIMITATIONS.md — одно утверждение в одном виде.
 */
export const WHY_BETTER = {
  items: [
    'Бесплатно, без подписки и аккаунта',
    'Русский распознаётся на этом компьютере: звук не уходит в облако',
    'Встроенная диктовка Windows (Win+H) отправляет звук в Microsoft — для русского ей нужен интернет',
  ],
  /** Подробнее — в «О программе», но и здесь хватает одной строки. */
  more: 'История, словарь и быстрые блоки тоже лежат на диске, а не в чужом сервисе.',
};

export const NAV = [
  { id: 'home', label: 'Главная', icon: 'home' },
  { id: 'dictionary', label: 'Словарь', icon: 'book' },
  { id: 'hotkeys', label: 'Горячие клавиши', icon: 'keyboard' },
  { id: 'clipboard', label: 'Буфер обмена', icon: 'clipboard', badge: 'НОВОЕ' },
];

export const CLIPBOARD_TABS = [
  { id: 'text', label: 'Текст' },
  { id: 'format', label: 'Формат' },
  { id: 'image', label: 'Изображение' },
  // здесь только записи экрана: копирование файлов из проводника Windows
  // пока не перехватываем, поэтому и подпись честная
  { id: 'file', label: 'Видео' },
  { id: 'password', label: 'Пароли' },
];

export const LANGUAGES = [
  { id: 'ru', label: 'Русский', native: 'Русский' },
  { id: 'en', label: 'English', native: 'Английский' },
  { id: 'es', label: 'Español', native: 'Испанский' },
  { id: 'de', label: 'Deutsch', native: 'Немецкий' },
  { id: 'fr', label: 'Français', native: 'Французский' },
  { id: 'zh', label: '简体中文', native: 'Китайский (упрощённый)' },
  { id: 'ja', label: '日本語', native: 'Японский' },
  { id: 'tr', label: 'Türkçe', native: 'Турецкий' },
  { id: 'kk', label: 'Қазақша', native: 'Казахский' },
  { id: 'uk', label: 'Українська', native: 'Украинский' },
];

/** Значения из видео: раздел «Голосовые сочетания клавиш». */
export const DEFAULT_VOICE_HOTKEYS = [
  {
    id: 'dictation',
    title: 'Диктовка',
    description: 'Нажмите — запись начнётся, нажмите ещё раз — текст вставится в активное поле',
    keys: ['Ctrl', 'Alt', 'Space'],
    mode: 'hold',
    enabled: true,
    icon: 'mic',
    tone: 'blue',
  },
  {
    id: 'agent',
    title: 'Режим агента',
    description:
      'Двойное нажатие — вопрос локальной модели по выделенному тексту. Нужна Ollama; без неё приложение честно скажет, что модели нет.',
    keys: ['Ctrl', 'Alt', 'Space'],
    double: true,
    enabled: false,
    icon: 'sparkles',
    tone: 'slate',
  },
  {
    id: 'hands-free',
    title: 'Режим свободных рук',
    description: 'Нажали один раз — говорите, нажали ещё раз — текст распознан и вставлен.',
    keys: ['Ctrl', 'Alt', 'L'],
    mode: 'toggle',
    enabled: false,
    icon: 'waveform',
    tone: 'slate',
  },
  {
    id: 'screen-aware',
    title: 'Диктовка с учётом экрана',
    // Снимок идёт в память (на диск не пишется) и подсказывает распознаванию
    // имена и термины с экрана; локальная модель с картинками может ещё и
    // ответить по нему.
    description:
      'Снимок экрана (только в память) подсказывает распознаванию имена и термины с экрана — они точнее попадают в текст.',
    keys: ['Ctrl', 'Alt', 'S'],
    mode: 'hold',
    enabled: true,
    icon: 'monitor',
    tone: 'blue',
    isNew: true,
  },
  {
    id: 'voice-command',
    title: 'Команда голосом',
    // Не диктовка: сказанное — указание к уже написанному тексту. Выделение
    // читается на нажатии (пока оно ещё цело), а сказанное применяется к нему.
    description:
      'Выделите текст в любом приложении, нажмите и скажите, что с ним сделать: «сократи», «переведи на английский», «исправь ошибки». Готовый текст заменит выделение.',
    keys: ['Ctrl', 'Alt', 'C'],
    mode: 'toggle',
    enabled: true,
    icon: 'sparkles',
    tone: 'blue',
    isNew: true,
  },
];

/** Раздел «Рекомендуемые горячие клавиши» — AI-пресеты из видео. */
export const DEFAULT_AI_PRESETS = [
  {
    id: 'to-english',
    title: 'Перевести на английский',
    description: 'Переводит выделенный текст на английский язык',
    prompt: 'Переведи текст на английский язык, сохранив смысл и стиль.',
    keys: ['Ctrl', 'Alt', 'E'],
    enabled: true,
  },
  {
    id: 'formal',
    title: 'Сделать формально',
    description: 'Переписывает текст в деловом тоне',
    prompt: 'Перепиши текст в официально-деловом стиле, без канцелярита.',
    keys: ['Ctrl', 'Alt', 'F'],
    enabled: false,
  },
  {
    id: 'shorten',
    title: 'Профессиональная переработка',
    description: 'Сокращает и делает текст чище',
    prompt: 'Сократи текст на 30%, убери слова-паразиты и повторы.',
    keys: ['Ctrl', 'Alt', 'S'],
    enabled: false,
  },
  {
    id: 'search-mode',
    title: 'Режим поиска',
    description: 'Формулирует поисковый запрос из сказанного',
    prompt: 'Преврати текст в короткий поисковый запрос.',
    keys: ['Ctrl', 'Alt', 'Q'],
    enabled: false,
  },
  {
    id: 'low-terms',
    title: 'Понизить термины',
    description: 'Заменяет сложные термины на простые слова',
    prompt: 'Объясни сложные термины простыми словами, сохранив факты.',
    keys: ['Ctrl', 'Alt', 'T'],
    enabled: false,
  },
];

/** Раздел «Мои горячие клавиши» — пустой в видео, заполняется пользователем. */
export const DEFAULT_CUSTOM_INSTRUCTIONS = [];

export const CLIPBOARD_HOTKEYS = [
  { id: 'screenshot', title: 'Скриншот', keys: ['Shift', 'Ctrl', 'A'] },
  { id: 'record', title: 'Запись экрана', keys: ['Shift', 'Ctrl', 'R'] },
  { id: 'shot-note', title: 'Скриншот-заметка', keys: ['Shift', 'Ctrl', 'S'] },
  { id: 'panel', title: 'Открыть панель', keys: ['Shift', 'Ctrl', 'V'] },
];

export const DEFAULT_SETTINGS = {
  onboarded: false, // первый запуск: спросить имя
  userName: '',
  language: 'ru', // язык интерфейса и распознавания
  readAloud: false, // предпросмотр диктовки голосом
  useWritingStyle: false, // подмешивать ваш стиль в AI-инструкции
  readAloudVoice: '',
  dictationKeys: ['Ctrl', 'Alt', 'Space'],
  dictationKey: 'Control+Alt+Space',
  translateTarget: 'en',
  aiProcessing: true,
  // «Не трогать мой текст»: приложение не чистит, не оформляет под окно и не
  // переписывает моделью. Словарь, голосовые команды и быстрые блоки остаются:
  // это прямые указания человека, а не догадки приложения.
  preserveText: false,
  // Правила «в этом приложении диктуем на этом языке»: [{ id, match, language }].
  // Пусто — один общий язык, как раньше.
  appProfiles: [],
  // Шумоподавление Windows (эхоподавление + AGC браузера). Выключено: для
  // диктовки обработка «для звонков» срезает окончания слов, а громкость
  // приложение выравнивает само. Включают, когда вокруг шумно.
  micCleanup: false,
  // «Отмени» голосом убирает последнюю вставку (две минуты, то же окно).
  // Выключатель нужен, если человек диктует слово «отмени» как текст.
  undoCommand: true,
  aiEndpoint: 'http://localhost:11434', // Ollama, опционально
  // вторая стадия чистки диктовки моделью: 1.6.0 — включена по умолчанию
  // (ждём её не дольше aiPolishBudgetMs, дальше текст вставляется без неё)
  aiDictationRewrite: true,
  // сколько ждать полировку моделью, прежде чем вставить текст после
  // офлайн-правил: диктовка не должна ждать локальную модель секундами
  aiPolishBudgetMs: 1500,
  aiModel: 'qwen2.5:0.5b',
  clipboardMonitor: true,
  clipboardMaxItems: 10000,
  clipboardRetentionDays: 30,
  dictationRetentionDays: 30,
  // Сбалансированный режим: small-q5_1 — качество small при скорости base.
  // Приложение ставит его само и переключается на более лёгкий, если замеры
  // показывают, что этот не успевает (см. main.cjs → maybeAutoTune).
  whisperModel: 'small-q5_1',
  // Держать модель в памяти (whisper-server): модель грузится один раз, а не
  // на каждый фрагмент и не на каждый живой проход. Иначе каждая диктовка
  // заново читала с диска сотни мегабайт.
  keepModelLoaded: true,
  // VAD (Silero): тишина и паузы не отправляются в whisper. Включает «--vad»
  // и заметно ускоряет ответ на обычной диктовке с паузами.
  vadEnabled: true,
  // Автоподбор модели: если проход по короткой записи оказался долгим
  // (например, small на слабом CPU — 12 секунд на две фразы), приложение само
  // переключается на быструю модель и говорит об этом. Человеку не нужно
  // разбираться в каталоге моделей, чтобы диктовка перестала тормозить.
  autoOptimize: true,
  // Скорость против точности: 'auto' — решают замеры (electron/adaptiveDecode.cjs),
  // 'fast' — только быстрый проход, 'accurate' — честный проход всегда.
  // Явный выбор человека сильнее замеров: иначе кнопка «Точно» на медленной
  // машине молча превращалась бы в «Быстро».
  decodeMode: 'auto',
  audioDeviceId: 'default',
  // «горячий микрофон»: поток открыт заранее, чтобы не терять первое слово.
  // 1.6.0: включён по умолчанию — скорость важнее, тумблер остался в «Функциях →
  // Микрофон» для тех, кому мешает горящий индикатор микрофона.
  micPreroll: true,
  // Живая расшифровка: 'auto' — решает приложение (lib/liveDraftPolicy.js).
  // Черновик по ходу речи — это дополнительный проход движка каждые 2,5 с: на
  // «Быстро» он почти бесплатен, на «Сбалансированно» и «Максимуме» отбирает
  // процессор у готового текста. true/false — ручной выбор из старых версий,
  // он уважается.
  liveWhisper: 'auto',
  // способ вставки: 'clipboard' — буфер + Ctrl+V, 'sendinput' — без буфера
  insertMethod: 'clipboard',
  autoLaunch: false,
  theme: 'dark',
  soundFeedback: true,
  typingEffect: false,
  showFloatingIndicator: true,
  seenClipboard: false, // плашка «НОВОЕ» гаснет после первого захода в буфер
  notifications: true,
  // отправка ошибок и служебных логов (без текста диктовки); по умолчанию включена
  diagnostics: true,
  hidePasswords: true,
  // закрытие окна сворачивает в трей, а не выходит из приложения
  closeToTray: true,
  // проверять обновления при запуске (наружу уходит только номер версии)
  checkUpdates: true,
  updateChannel: 'stable', // stable | beta
  // применять словарь при диктовке: и подсказкой whisper, и заменой в тексте
  dictionaryEnabled: true,
};

/**
 * Приёмник журналов. Пустая строка по умолчанию: приложению не нужен ни сервер,
 * ни аккаунт — журнал лежит на компьютере, отчёт сохраняется одной кнопкой.
 * Если у пользователя есть свой приёмник (см. server/), он вписывает адрес сам.
 */
export const LOG_ENDPOINT = '';

/**
 * Модели распознавания — ровно три режима (см. lib/modelTiers.js).
 *
 * Раньше здесь лежал каталог из десяти моделей: tiny/base/small/medium/turbo
 * в трёх квантованиях. Человеку этот выбор ничего не давал — он не знает, чем
 * q5_1 отличается от q8_0, и не может сравнить скорость, не скачав всё.
 * Теперь три варианта по расходам на железо: «Быстро», «Сбалансированно»
 * (ставится само) и «Максимум качества».
 */
export const MODELS = MODEL_TIERS.map((tier) => ({
  id: tier.model,
  tier: tier.id,
  label: `Whisper ${tier.label.toLowerCase()}`,
  size: tier.size,
  ram: tier.ram,
  speed: tier.speed,
  speedText: tier.speedText,
  quality: tier.quality,
  desc: tier.desc,
  recommended: tier.recommended === true,
}));

export const STORAGE_KEYS = {
  dictations: 'zs.dictations',
  clipboard: 'zs.clipboard',
  settings: 'zs.settings',
  dictionary: 'zs.dictionary',
  hotkeys: 'zs.hotkeys',
  presets: 'zs.presets',
  instructions: 'zs.instructions',
  snippets: 'zs.snippets',
  stats: 'zs.stats',
  profile: 'zs.profile',
};

export default {
  APP,
  NAV,
  CLIPBOARD_TABS,
  LANGUAGES,
  LOG_ENDPOINT,
  WHY_BETTER,
  DEFAULT_VOICE_HOTKEYS,
  DEFAULT_AI_PRESETS,
  CLIPBOARD_HOTKEYS,
  DEFAULT_SETTINGS,
  MODELS,
  STORAGE_KEYS,
};
