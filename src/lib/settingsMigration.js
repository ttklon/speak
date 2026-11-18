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
 * 1.6.5: в каталоге осталось три режима (`base-q5_1`, `small-q5_1`,
 * `large-v3-turbo-q5_0`), а в сохранённых настройках старых версий лежат имена
 * моделей, которых больше нет (`base`, `small`, `medium`). С таким именем
 * приложение пыталось скачать несуществующий файл и молчало о том, что модели
 * нет. Переводим один раз, ближайшим по весу режимом.
 */
export const MODEL_TIER_FIX_MARKER = 'modelTiers165';

const LEGACY_MODEL_TO_TIER = {
  tiny: 'base-q5_1',
  'tiny-q5_1': 'base-q5_1',
  base: 'base-q5_1',
  'base-q5_1': 'base-q5_1',
  small: 'small-q5_1',
  'small-q5_1': 'small-q5_1',
  medium: 'large-v3-turbo-q5_0',
  'medium-q5_0': 'large-v3-turbo-q5_0',
  large: 'large-v3-turbo-q5_0',
  'large-v3-turbo-q5_0': 'large-v3-turbo-q5_0',
};


/**
 * @param {object} prev сохранённые настройки
 * @param {object} defaults актуальные умолчания
 * @returns {object} настройки после миграции (новая копия)
 */
export function migrateSettings(prev = {}, defaults = {}) {
  const next = { ...defaults, ...prev };
  if (!prev?.[SPEED_FIX_MARKER]) {
    if (prev.whisperModel === 'small') next.whisperModel = 'base';
    // Раньше здесь было жёсткое «включено → выключено»: живой проход на
    // медленной модели превращал полминуты записи в минуту ожидания. Теперь
    // решение принимает lib/liveDraftPolicy.js по режиму и замерам, поэтому
    // старый выбор человека не выключаем навсегда — переводим в «сама».
    if (prev.liveWhisper === true) next.liveWhisper = 'auto';
    if (prev.keepModelLoaded === undefined) next.keepModelLoaded = true;
    next[SPEED_FIX_MARKER] = true;
  }

  // Каталог моделей идёт последним: он должен перевести и имена, которые
  // только что поставила правка скорости (`small` → `base`), и совсем
  // старые записи. Незнакомое имя не оставляем — иначе приложение будет
  // искать на диске файл, которого нет.
  if (!prev?.[MODEL_TIER_FIX_MARKER]) {
    const stored = next.whisperModel;
    const model = LEGACY_MODEL_TO_TIER[stored];
    if (model) next.whisperModel = model;
    else if (stored) next.whisperModel = defaults.whisperModel;
    next[MODEL_TIER_FIX_MARKER] = true;
  }
  return next;
}
