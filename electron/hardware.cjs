/**
 * Подбор модели распознавания под конкретную машину.
 *
 * Зачем: «одна модель для всех» — это либо медленно на слабом ноутбуке, либо
 * хуже качество на мощном ПК. Владелец не должен разбираться в квантовании:
 * приложение само смотрит, сколько ядер и памяти, и берёт модель, которая на
 * этом железе укладывается в секунды (ориентир из быстрых диктовочных
 * приложений: пара слов — 2–3 секунды, а не 10).
 *
 * Отправная точка — замеры whisper.cpp на 2 ядрах: base ≈ 6× realtime,
 * base-q5_1 ≈ 8×, small ≈ 3×, small-q5_1 ≈ 5×. Скорость растёт почти линейно
 * по ядрам, поэтому на 8 ядрах small-q5_1 даёт те же секунды, что base на 2.
 *
 * Функции чистые (на вход — числа), их проверяет смоук-тест.
 */

/** Вес модели в мегабайтах — грубая, но честная мера «тяжести». */
const WEIGHT_MB = {
  tiny: 75,
  'tiny-q5_1': 32,
  base: 142,
  'base-q5_1': 60,
  small: 466,
  'small-q5_1': 190,
  'large-v3-turbo-q5_0': 547,
  'large-v3-turbo-q8_0': 874,
  'large-v3-turbo': 1549,
  medium: 1530,
};

/**
 * Три режима из интерфейса (см. src/lib/modelTiers.js) — те же модели, чтобы
 * «Быстро / Сбалансированно / Максимум» и автоподбор говорили об одном и том
 * же. Порядок от лёгкой к тяжёлой: fast → balanced → max.
 */
const FAST_TIER = 'base-q5_1';
const BALANCED_TIER = 'small-q5_1';
const MAX_TIER = 'large-v3-turbo-q5_0';
const FASTEST = 'tiny-q5_1';
// Старые профили: на ступень легче. Только соседние режимы — «прыжок через
// две ступени» менял бы качество слишком резко.
const LIGHTER = {
  'large-v3-turbo-q5_0': BALANCED_TIER,
  'large-v3-turbo-q8_0': BALANCED_TIER,
  'large-v3-turbo': BALANCED_TIER,
  medium: BALANCED_TIER,
  small: FAST_TIER,
  'small-q5_1': FAST_TIER,
  base: '',
  'base-q5_1': '',
};

/** Модель на ступень легче (для авто-переключения по факту замеров). */
function lighterModel(id) {
  return LIGHTER[id] || '';
}

/**
 * Какую модель качать и ставить по умолчанию на этой машине.
 * @param {{cpus?: number, ramGb?: number}} hw
 * @returns {{id: string, tier: string, why: string}}
 */
function pickModel(hw = {}) {
  const cpus = Math.max(1, Math.round(Number(hw.cpus) || 4));
  const ramGb = Math.max(1, Number(hw.ramGb) || 8);
  if (cpus <= 3 || ramGb < 8) {
    return {
      id: FAST_TIER,
      tier: 'fast',
      why: `${cpus} ядра, ${ramGb} ГБ — режим «Быстро»: base-q5_1 считает в разы быстрее реального времени`,
    };
  }
  if (cpus >= 12 && ramGb >= 32) {
    return {
      id: MAX_TIER,
      tier: 'max',
      why: `${cpus} ядер, ${ramGb} ГБ — режим «Максимум качества»: large-v3-turbo-q5_0 помещается и успевает`,
    };
  }
  return {
    id: BALANCED_TIER,
    tier: 'balanced',
    why: `${cpus} ядер, ${ramGb} ГБ — режим «Сбалансированно»: small-q5_1, точнее base при той же скорости`,
  };
}

/** Вес модели в МБ; неизвестное имя — 0 (сравнивать нечего). */
function weightOf(id) {
  return WEIGHT_MB[id] || 0;
}

/**
 * Стоит ли уходить с текущей модели на рекомендованную: только когда текущая
 * ощутимо тяжелее (иначе дёргали бы настройку без пользы).
 * @param {string} current
 * @param {string} recommended
 */
function worthSwitching(current, recommended) {
  if (!current || !recommended || current === recommended) return false;
  const cur = weightOf(current);
  const rec = weightOf(recommended);
  if (!cur || !rec) return false;
  // 1,6× по весу — это уже другая скорость счёта, а не шум
  return cur >= rec * 1.6;
}

/**
 * Стоит ли поднимать качество: человек сидит на самой лёгкой ступени, но
 * железо по нашим же меркам тянет «Сбалансированно».
 *
 * Зачем: автоподбор умеет только спускаться. Если он когда-то сполз на base
 * (например, из-за старых версий, где короткие фразы считались медленными),
 * человек остаётся с моделью, которая путает слова, и никогда об этом не
 * узнает — «Быстро» выглядит как его собственный выбор. Одну ступень вверх
 * поднимаем сами, но только если приложение само же и спустилось
 * (downgradedByApp) — иначе это была бы ручная настройка.
 */
function worthUpgrading(p = {}) {
  if (p.downgradedByApp === true) return false;
  if (p.current !== FAST_TIER) return false;
  const pick = pickModel({ cpus: p.cpus, ramGb: p.ramGb });
  // Слабая машина: её собственный выбор — «Быстро», поднимать некуда
  if (pick.tier === 'fast') return false;
  if (!Array.isArray(p.downloaded) || !p.downloaded.includes(pick.id)) return false;
  return pick;
}

/**
 * Стоит ли переключаться на другую модель прямо сейчас (при запуске).
 * Чистая функция: и решение, и его причина проверяются тестом.
 * @param {{cpus?: number, ramGb?: number, current?: string, downloaded?: string[],
 *          pinned?: boolean, autoOptimize?: boolean}} p
 * @returns {{switchTo: string, why: string, pick: object}}
 */
function plan(p = {}) {
  const pick = pickModel({ cpus: p.cpus, ramGb: p.ramGb });
  const none = { switchTo: '', why: '', pick };
  if (p.autoOptimize === false) return none;
  if (p.pinned === true) return none;
  const downloaded = Array.isArray(p.downloaded) ? p.downloaded : [];
  if (!downloaded.includes(pick.id)) return none;
  if (worthSwitching(p.current, pick.id)) return { switchTo: pick.id, why: pick.why, pick, up: false };
  const better = worthUpgrading({ ...p, downloaded });
  if (better) {
    return {
      switchTo: better.id,
      why: `${better.why}. Прошлый режим был самым лёгким — текст на нём путается`,
      pick: better,
      up: true,
    };
  }
  return none;
}

/** Своё железо — тем же форматом, что ждёт pickModel. */
function thisMachine() {
  const os = require('node:os');
  return {
    cpus: (os.cpus() || []).length || 4,
    ramGb: Math.round(((os.totalmem() || 0) / 1024 ** 3) * 10) / 10,
  };
}

module.exports = {
  pickModel,
  worthUpgrading,
  plan,
  worthSwitching,
  weightOf,
  thisMachine,
  lighterModel,
  FASTEST,
  TIERS: { fast: FAST_TIER, balanced: BALANCED_TIER, max: MAX_TIER },
  WEIGHTS: WEIGHT_MB,
};
