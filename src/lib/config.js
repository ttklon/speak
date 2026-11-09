/**
 * ZSpeakly — единая точка правды по умолчанию.
 * Все значения соответствуют видео-разбору (docs/00-VIDEO-TEARDOWN.md),
 * кроме "платных" ограничений: ZSpeakly — бесплатный офлайн-клон, лимитов нет.
 */

export const APP = {
  name: 'ZSpeakly',
  tagline: 'Не печатай, просто ZSpeakly.',
  version: '1.4.0',
  build: '2026.11.09',
  repo: 'https://github.com/ttklon/speak',
  site: 'https://github.com/ttklon/speak#readme',
  freeNote: 'Всё локально: без облака, подписки и лимитов слов.',
  description:
    'Удерживайте клавишу для диктовки. Дважды нажмите клавишу, чтобы включить режим агента.',
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
  { id: 'file', label: 'Файл' },
  { id: 'password', label: 'Зашифрованные' },
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
    description: 'Удерживайте для речи, отпустите для транскрипции',
    keys: ['Ctrl', 'Alt', 'Space'],
    mode: 'hold',
    enabled: true,
    icon: 'mic',
    tone: 'blue',
  },
  {
    id: 'agent',
    title: 'Режим агента',
    description: 'Двойное нажатие — короткий вопрос локальному агенту (Ollama, без облака)',
    keys: ['Ctrl', 'Alt', 'Space'],
    double: true,
    enabled: false,
    icon: 'sparkles',
    tone: 'slate',
  },
  {
    id: 'hands-free',
    title: 'Режим свободных рук',
    description: 'Нажмите один раз для старта/остановки',
    keys: ['Ctrl', 'Alt', 'L'],
    mode: 'toggle',
    enabled: false,
    icon: 'waveform',
    tone: 'slate',
  },
  {
    id: 'screen-aware',
    title: 'Диктовка с учётом экрана',
    description:
      'Удерживайте, чтобы говорить. ZSpeakly использует содержимое экрана, чтобы отвечать на вопросы или писать ответы за вас.',
    keys: ['Ctrl', 'Alt', 'S'],
    mode: 'hold',
    enabled: true,
    icon: 'monitor',
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
  { id: 'shot-note', title: 'Скриншот с придумкой', keys: ['Shift', 'Ctrl', 'S'] },
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
  aiEndpoint: 'http://localhost:11434', // Ollama, опционально
  aiModel: 'qwen2.5:0.5b',
  clipboardMonitor: true,
  clipboardMaxItems: 10000,
  clipboardRetentionDays: 30,
  dictationRetentionDays: 30,
  whisperModel: 'small',
  audioDeviceId: 'default',
  autoLaunch: false,
  theme: 'dark',
  soundFeedback: true,
  typingEffect: false,
  showFloatingIndicator: true,
  notifications: true,
  telemetry: false,
  hidePasswords: true,
};

export const MODELS = [
  { id: 'tiny', label: 'Whisper tiny', size: '75 МБ', ram: '300 МБ', speed: '0.4×', quality: '85% ru' },
  { id: 'small', label: 'Whisper small', size: '466 МБ', ram: '600 МБ', speed: '0.8×', quality: '93% ru' },
  { id: 'medium', label: 'Whisper medium', size: '1.5 ГБ', ram: '1.5 ГБ', speed: '1.5×', quality: '96% ru' },
];

export const STORAGE_KEYS = {
  dictations: 'zs.dictations',
  clipboard: 'zs.clipboard',
  settings: 'zs.settings',
  dictionary: 'zs.dictionary',
  hotkeys: 'zs.hotkeys',
  presets: 'zs.presets',
  instructions: 'zs.instructions',
  stats: 'zs.stats',
  profile: 'zs.profile',
};

export default {
  APP,
  NAV,
  CLIPBOARD_TABS,
  LANGUAGES,
  DEFAULT_VOICE_HOTKEYS,
  DEFAULT_AI_PRESETS,
  CLIPBOARD_HOTKEYS,
  DEFAULT_SETTINGS,
  MODELS,
  STORAGE_KEYS,
};
