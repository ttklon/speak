/**
 * Миграции настроек между версиями.
 *
 * Умолчания 1.5.0 (модель small + живая расшифровка) на обычном ноутбуке
 * превращали 30-секундную диктовку в минуту ожидания: несколько проходов
 * whisper подряд, каждый с загрузкой модели. 1.5.1 переводит такие настройки
 * на быстрые — но только если человек их не менял сам (стоят ровно старые
 * умолчания). Осознанный выбор уважаем.
 */

export const SPEED_FIX_MARKER = 'speedFix151';

/**
 * @param {object} prev сохранённые настройки
 * @param {object} defaults актуальные умолчания
 * @returns {object} настройки после миграции (новая копия)
 */
export function migrateSettings(prev = {}, defaults = {}) {
  const next = { ...defaults, ...prev };
  if (prev?.[SPEED_FIX_MARKER]) return next;

  if (prev.whisperModel === 'small') next.whisperModel = 'base';
  if (prev.liveWhisper === true) next.liveWhisper = false;
  if (prev.keepModelLoaded === undefined) next.keepModelLoaded = true;
  next[SPEED_FIX_MARKER] = true;
  return next;
}
