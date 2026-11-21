/**
 * Сколько точности можно позволить за счёт скорости.
 *
 * Слабая машина и большая модель — разные вещи, но решает их одно число:
 * сколько времени движок тратит на секунду речи. Если он успевает в 0,4 от
 * длительности записи, у нас есть запас — можно считать сразу «честным»
 * проходом (перебор вариантов, полное окно энкодера) и не тратить время на
 * второй заход. Если же он еле успевает, честный проход сделает диктовку
 * невыносимой: остаётся быстрый путь и второй проход только по нужде.
 *
 * Замеры берём из прошлых фраз этой сессии: они точнее любого «железо-детекта»,
 * потому что учитывают и модель, и загруженность машины, и длину записи.
 */

/** Сколько последних проходов помним. Больше — уже не «сейчас», а история. */
const ADAPTIVE_WINDOW = 5;

/** Быстрее 0,6 от длительности записи — есть запас на честный проход. */
const THOROUGH_FACTOR = 0.6;

/** Медленнее 1,25 — машина на пределе, пора честно предложить модель легче. */
const SLOW_FACTOR = 1.25;

/** Во сколько раз проход дольше записи. */
function realtimeFactor(ms, seconds) {
  const time = Number(ms) || 0;
  const span = Number(seconds) || 0;
  if (!(time > 0) || !(span > 0)) return null;
  return time / 1000 / span;
}

/** Средний коэффициент по последним проходам (только валидные). */
function averageFactor(passes = []) {
  const list = (Array.isArray(passes) ? passes : [])
    .slice(-ADAPTIVE_WINDOW)
    .map((p) => realtimeFactor(p?.ms, p?.seconds))
    .filter((v) => v !== null);
  if (!list.length) return null;
  return list.reduce((a, b) => a + b, 0) / list.length;
}

/**
 * Режимы, которые человек может выбрать сам:
 *  - auto — решают замеры (поведение по умолчанию);
 *  - fast — только быстрый проход, второй лишь когда текста нет совсем;
 *  - accurate — честный проход всегда.
 */
const DECODE_MODES = ['auto', 'fast', 'accurate'];

const normalizeMode = (mode) => (DECODE_MODES.includes(mode) ? mode : 'auto');

/**
 * @param {Array<{ms:number, seconds:number}>} passes прошлые проходы
 * @param {{seconds?: number, mode?: 'auto'|'fast'|'accurate'}} opts запись и выбор человека
 * @returns {{thorough: boolean, factor: number|null, reason: string, slow: boolean, mode: string, skipRetry: boolean}}
 */
function decodePlan(passes = [], { seconds = 0, mode = 'auto' } = {}) {
  const valid = (Array.isArray(passes) ? passes : []).filter(
    (p) => realtimeFactor(p?.ms, p?.seconds) !== null,
  );
  const factor = averageFactor(valid);
  const chosen = normalizeMode(mode);
  // Явный выбор человека сильнее замеров: «Точно» не должно «оптимизироваться»
  // до быстрого прохода на медленной машине, иначе человек не поверит кнопке.
  if (chosen === 'accurate') {
    return {
      thorough: true,
      factor,
      reason: 'выбран режим «Точно» — честный проход всегда',
      slow: false,
      mode: chosen,
      skipRetry: false,
    };
  }
  if (chosen === 'fast') {
    return {
      thorough: false,
      factor,
      reason: 'выбран режим «Быстро» — только быстрый проход',
      slow: false,
      mode: chosen,
      // «Быстро» — это обещание скорости: второй проход только когда текста
      // не получилось совсем (это решает main, а не этот модуль).
      skipRetry: true,
    };
  }
  if (factor === null || valid.length < 2) {
    return {
      thorough: false,
      factor,
      reason: 'нет замеров — начинаем с быстрого прохода',
      slow: false,
      mode: chosen,
      skipRetry: false,
    };
  }
  // Совсем короткая запись: полное окно энкодера всё равно стоит столько же,
  // сколько быстрый путь с урезанным, — выигрыша в скорости нет.
  if (factor <= THOROUGH_FACTOR) {
    return {
      thorough: true,
      factor,
      reason: `движок успевает (${Math.round(factor * 100)} % от длительности записи) — считаем честно с первого раза`,
      slow: false,
      mode: chosen,
      skipRetry: false,
    };
  }
  return {
    thorough: false,
    factor,
    reason:
      factor > SLOW_FACTOR
        ? `движку тяжело (${Math.round(factor * 100)} %): быстрый проход, второй — только если текст подозрительный`
        : `запас небольшой (${Math.round(factor * 100)} %): быстрый проход`,
    slow: factor > SLOW_FACTOR,
    mode: chosen,
    skipRetry: false,
  };
}

module.exports = {
  ADAPTIVE_WINDOW,
  DECODE_MODES,
  THOROUGH_FACTOR,
  SLOW_FACTOR,
  realtimeFactor,
  averageFactor,
  decodePlan,
};
