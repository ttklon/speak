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

/** Модели, которые на слабой машине заведомо «думают» дольше, чем говорят. */
const FASTEST = 'tiny-q5_1';
const BALANCED = 'base-q5_1';
const QUALITY = 'small-q5_1';
const QUALITY_PLAIN = 'base';

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
      id: BALANCED,
      tier: 'low',
      why: `${cpus} ядра, ${ramGb} ГБ — квантованная base: качество base, но заметно быстрее`,
    };
  }
  if (cpus >= 8 && ramGb >= 16) {
    return {
      id: QUALITY,
      tier: 'high',
      why: `${cpus} ядер, ${ramGb} ГБ — small-q5_1: качество small при скорости base`,
    };
  }
  return {
    id: QUALITY_PLAIN,
    tier: 'mid',
    why: `${cpus} ядер, ${ramGb} ГБ — обычная base: лучший баланс`,
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
  if (!worthSwitching(p.current, pick.id)) return none;
  return { switchTo: pick.id, why: pick.why, pick };
}

/** Своё железо — тем же форматом, что ждёт pickModel. */
function thisMachine() {
  const os = require('node:os');
  return {
    cpus: (os.cpus() || []).length || 4,
    ramGb: Math.round(((os.totalmem() || 0) / 1024 ** 3) * 10) / 10,
  };
}

module.exports = { pickModel, plan, worthSwitching, weightOf, thisMachine, FASTEST, WEIGHTS: WEIGHT_MB };
