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
  { id: 'account', label: 'Аккаунт' },
  { id: 'app', label: 'Приложение' },
  { id: 'features', label: 'Функции' },
  { id: 'data', label: 'Данные и разрешения' },
  { id: 'diagnostics', label: 'Диагностика' },
  { id: 'network', label: 'Сеть' },
  { id: 'about', label: 'О программе' },
];

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

export default { SETTINGS_SECTIONS, SETTINGS_SECTION_LABELS, hintSections };
