/**
 * Разделы настроек — один список на всё приложение.
 *
 * Зачем отдельным модулем: подсказки в ошибках и тостах говорят человеку
 * «Настройки → Такой-то раздел». Раньше эти названия были написаны руками в
 * десятке мест и успели разойтись с действительностью: приложение отправляло
 * за микрофоном в «Функции», а микрофон — в «Данные и разрешения». Теперь
 * названия берутся отсюда, а тест проверяет, что каждая подсказка ведёт в
 * существующий раздел.
 */
export const SETTINGS_SECTIONS = [
  {
    id: 'dictation',
    label: 'Диктовка',
    desc: 'Язык, полировка и качество распознавания.',
  },
  {
    id: 'app',
    label: 'Приложение',
    desc: 'Имя, внешний вид, звук и версия. Всё применяется сразу.',
  },
  {
    id: 'data',
    label: 'Данные',
    desc: 'Сколько хранить продиктованное и буфер. Всё лежит на этом компьютере.',
  },
  {
    id: 'diagnostics',
    label: 'Диагностика',
    desc: 'Что происходит с диктовкой и вставкой сейчас. Журнал никуда не уходит сам.',
  },
];

/**
 * Куда переехали прежние разделы.
 *
 * Настроек было семь вкладок, и человек не понимал, где что: «Аккаунт» рядом с
 * «Функциями», «Сеть» отдельно от модели, «О программе» отдельно от
 * «Приложения». Теперь разделов четыре, а старые названия продолжают работать —
 * по ним приходят подсказки из прошлых версий и прямые ссылки.
 */
export const SECTION_ALIASES = {
  account: 'app',
  features: 'dictation',
  network: 'dictation',
  about: 'app',
  'data-and-permissions': 'data',
};

/** Привести любой известный id к нынешнему разделу. */
export function resolveSection(id) {
  const value = String(id || '');
  if (SETTINGS_SECTIONS.some((s) => s.id === value)) return value;
  return SECTION_ALIASES[value] || SETTINGS_SECTIONS[0].id;
}

/** Названия разделов для проверок подсказок. */
export const SETTINGS_SECTION_LABELS = SETTINGS_SECTIONS.map((s) => s.label);

/**
 * Найти упоминания «Настройки → Раздел» в тексте подсказки.
 * @returns {string[]} названия разделов, которые упомянуты
 */
export function hintSections(text) {
  const found = [];
  const re = /Настройк\p{L}*\s*→\s*([^«».,;:!?()]+)/gu;
  let m = re.exec(String(text || ''));
  while (m) {
    // «Функции → Модель распознавания» — берём только первый раздел
    const label = m[1].split('→')[0].trim();
    if (label) found.push(label);
    m = re.exec(String(text || ''));
  }
  return found;
}

export default { SETTINGS_SECTIONS, SETTINGS_SECTION_LABELS, SECTION_ALIASES, resolveSection, hintSections };
