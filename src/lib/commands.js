/**
 * Команды приложения и их поиск.
 *
 * Зачем: в ZSpeakly полтора десятка экранов, семь разделов настроек и десяток
 * действий («начать диктовку», «скопировать последнюю фразу», «очистить
 * буфер»). Человек, который хочет что-то сделать, вынужден помнить, где это
 * лежит: настройки — в модалке, буфер — на отдельной странице, модель — в
 * «Функциях». Одна строка поиска по всему этому (Ctrl+K) убирает
 * необходимость помнить структуру.
 *
 * Модуль чистый: список команд собирается отдельно, поиск — отдельно. Поэтому
 * ранжирование проверяется юнит-тестами, а не «на глаз».
 */

/** Сколько результатов показывать: больше — это уже не подсказка, а список. */
export const COMMAND_LIMIT = 8;

/**
 * Собрать команды из данных приложения.
 *
 * @param {object} ctx
 * @param {Array<{id: string, label: string}>} ctx.pages страницы
 * @param {Array<{id: string, label: string}>} ctx.settingsSections разделы настроек
 * @param {Array<object>} ctx.actions действия `{id, label, hint, group}`
 * @param {Array<{id: string, title: string}>} [ctx.presets] AI-инструкции
 * @returns {Array<object>}
 */
export function buildCommands({ pages = [], settingsSections = [], actions = [], presets = [] } = {}) {
  const commands = [];

  for (const page of pages) {
    commands.push({
      id: `page:${page.id}`,
      group: 'Страницы',
      label: page.label,
      target: { kind: 'page', id: page.id },
    });
  }

  for (const section of settingsSections) {
    commands.push({
      id: `settings:${section.id}`,
      group: 'Настройки',
      label: section.label,
      hint: 'Настройки',
      target: { kind: 'settings', id: section.id },
    });
  }

  for (const action of actions) {
    commands.push({
      id: `action:${action.id}`,
      group: action.group || 'Действия',
      label: action.label,
      hint: action.hint || '',
      target: { kind: 'action', id: action.id },
    });
  }

  for (const preset of presets) {
    commands.push({
      id: `preset:${preset.id}`,
      group: 'AI-инструкции',
      label: preset.title,
      hint: 'Выдели текст и нажми сочетание',
      target: { kind: 'preset', id: preset.id },
    });
  }

  return commands;
}

const normalize = (text = '') =>
  String(text || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Насколько команда подходит под запрос. Больше — лучше, 0 — не подходит.
 *
 * Правила простые и объяснимые: начало названия важнее начала слова, начало
 * слова важнее совпадения в середине, а подсказка (где это лежит) весит меньше
 * самого названия — иначе «настройки» вытаскивало бы все разделы сразу.
 */
export function scoreCommand(command = {}, query = '') {
  const q = normalize(query);
  if (!q) return 1;
  const label = normalize(command.label);
  const hint = normalize(command.hint);
  if (!label) return 0;

  if (label === q) return 100;
  if (label.startsWith(q)) return 80;
  // начало любого слова: «гор» → «Горячие клавиши»
  if (label.split(' ').some((word) => word.startsWith(q))) return 60;
  if (label.includes(q)) return 40;
  if (hint && (hint.startsWith(q) || hint.includes(q))) return 15;
  return 0;
}

/**
 * Отфильтровать и отсортировать команды под запрос.
 *
 * @param {Array<object>} commands
 * @param {string} query
 * @param {{limit?: number}} [opts]
 * @returns {Array<object>}
 */
export function searchCommands(commands = [], query = '', { limit = COMMAND_LIMIT } = {}) {
  const list = Array.isArray(commands) ? commands : [];
  const q = normalize(query);
  if (!q) return list.slice(0, Math.max(1, limit));

  const scored = [];
  list.forEach((command, index) => {
    const score = scoreCommand(command, q);
    if (score > 0) scored.push({ command, score, index });
  });
  // При равном счёте порядок исходного списка решает: страницы и действия
  // должны быть предсказуемы, а не «как повезло сортировке».
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.slice(0, Math.max(1, limit)).map((item) => item.command);
}

/**
 * Перемещение выбора стрелками с заворотом: список короткий, и «упереться в
 * край» раздражает больше, чем переход по кругу.
 */
export function moveSelection(index, delta, length) {
  const size = Math.max(0, Number(length) || 0);
  if (!size) return 0;
  const from = Math.min(size - 1, Math.max(0, Number(index) || 0));
  return (from + (Number(delta) || 0) + size * 2) % size;
}

export default { buildCommands, searchCommands, scoreCommand, moveSelection, COMMAND_LIMIT };
