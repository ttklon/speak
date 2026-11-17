/**
 * Три режима распознавания — вместо каталога из десяти моделей.
 *
 * Жалоба человека звучала так: «ты накидала кучу моделей, непонятно, какая
 * лучше, какая хуже». Это правда: человеку, который хочет говорить и получать
 * текст, не нужен выбор между q5_1, q8_0 и fp16. Нужны три понятных варианта по
 * расходам на железо и один разумный по умолчанию.
 *
 * Поэтому в интерфейсе ровно три строки:
 *   «Быстро» — слабый ноутбук, самый маленький файл;
 *   «Сбалансированно» — то, что приложение ставит само;
 *   «Максимум качества» — мощный ПК.
 *
 * Каждому режиму соответствует конкретная модель whisper.cpp. «Всё лучшее
 * сразу» решается иначе: приложение ставит сбалансированный режим и само
 * переключается на более лёгкий, если замеры показывают, что выбранный не
 * успевает (см. main.cjs → maybeAutoTune). Человеку ничего настраивать не надо.
 *
 * Модуль чистый: его проверяют vitest и E2E.
 */

export const MODEL_TIERS = [
  {
    id: 'fast',
    label: 'Быстро',
    model: 'base-q5_1',
    size: '60 МБ',
    sizeMb: 60,
    ram: '≈300 МБ',
    speed: '≈8×',
    quality: 'хорошая',
    desc: 'Слабый ноутбук: 2–4 ядра или меньше 8 ГБ памяти.',
  },
  {
    id: 'balanced',
    label: 'Сбалансированно',
    model: 'small-q5_1',
    size: '190 МБ',
    sizeMb: 190,
    ram: '≈500 МБ',
    speed: '≈5×',
    quality: 'высокая',
    recommended: true,
    desc: 'Ставится сама: точнее на именах и терминах при той же скорости.',
  },
  {
    id: 'max',
    label: 'Максимум качества',
    model: 'large-v3-turbo-q5_0',
    size: '547 МБ',
    sizeMb: 547,
    ram: '≈900 МБ',
    speed: '≈3×',
    quality: 'максимальная',
    desc: 'Мощный ПК: 12+ ядер и 32 ГБ. Лучше всех на сложной речи.',
  },
];

/** Модели, которые вообще может выбрать интерфейс. */
export const TIER_MODELS = MODEL_TIERS.map((tier) => tier.model);

/** Старые профили: какая модель какому режиму соответствует. */
const LEGACY_TIER = {
  tiny: 'fast',
  'tiny-q5_1': 'fast',
  base: 'fast',
  'base-q5_1': 'fast',
  small: 'balanced',
  'small-q5_1': 'balanced',
  'large-v3-turbo-q5_0': 'max',
  'large-v3-turbo-q8_0': 'max',
  'large-v3-turbo': 'max',
  medium: 'max',
};

export function tierById(id) {
  return MODEL_TIERS.find((tier) => tier.id === id) || null;
}

/**
 * Какой режим соответствует модели из профиля. Неизвестная модель — это
 * «сбалансированно»: именно её приложение ставит по умолчанию.
 */
export function tierForModel(model) {
  const direct = MODEL_TIERS.find((tier) => tier.model === model);
  if (direct) return direct;
  return tierById(LEGACY_TIER[model] || 'balanced') || MODEL_TIERS[1];
}

/** Модель на ступень легче (для авто-переключения). Пусто — уже самая лёгкая. */
export function lighterModel(model) {
  const index = MODEL_TIERS.indexOf(tierForModel(model));
  const next = MODEL_TIERS[index - 1];
  return next && next.model !== model ? next.model : '';
}

/** Модель на ступень тяжелее. Пусто — уже самая тяжёлая. */
export function heavierModel(model) {
  const index = MODEL_TIERS.indexOf(tierForModel(model));
  const next = MODEL_TIERS[index + 1];
  return next && next.model !== model ? next.model : '';
}

/**
 * Режим по железу. Границы те же, что у `electron/hardware.cjs`: слабая
 * машина получает лёгкую модель, мощная — максимальное качество.
 */
export function pickTierForHardware({ cpus = 4, ramGb = 8 } = {}) {
  const cores = Math.max(1, Math.round(Number(cpus) || 4));
  const ram = Math.max(1, Number(ramGb) || 8);
  if (cores <= 3 || ram < 8) return tierById('fast');
  if (cores >= 12 && ram >= 32) return tierById('max');
  return tierById('balanced');
}

/**
 * Сколько секунд счёта даёт модель на секунду речи (примерно). Нужна, чтобы
 * показывать человеку «20 с речи → 4 с» и объяснять авто-переключение.
 */
export function realtimeFactor(model) {
  const match = /≈([\d.,]+)×/.exec(tierForModel(model).speed || '');
  const value = match ? Number(match[1].replace(',', '.')) : 3;
  return Number.isFinite(value) && value > 0 ? value : 3;
}

export default {
  MODEL_TIERS,
  TIER_MODELS,
  tierById,
  tierForModel,
  lighterModel,
  heavierModel,
  pickTierForHardware,
  realtimeFactor,
};
