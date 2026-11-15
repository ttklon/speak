/**
 * Сколько ждать полировку моделью.
 *
 * Идея простая: ждать модель стоит только если она реально успевает. На слабом
 * ноутбуке маленькая модель отвечает 300 мс, а большая — три секунды; держать
 * вставку на бюджете 0,9 с каждый раз бессмысленно. Поэтому:
 *
 *  - сначала ждём обычный бюджет;
 *  - если модель не успела два раза подряд — больше не ждём вовсе: текст
 *    вставляется сразу, а доведённый вариант доходит в историю следом;
 *  - как только модель ответила в срок — снова ждём (она могла прогреться).
 *
 * Модуль чистый: никаких таймеров и window — только арифметика, чтобы это
 * можно было проверить тестами.
 */

export const DEFAULT_BUDGET_MS = 900;

/**
 * @param {object} opts
 * @param {number} opts.budgetMs обычное ожидание
 * @param {number} opts.window сколько последних попыток помнить
 */
export function createPolishGate({ budgetMs = DEFAULT_BUDGET_MS, window = 2 } = {}) {
  const attempts = [];
  const size = Math.max(1, window);

  const skip = () =>
    attempts.length >= size && attempts.slice(-size).every((a) => a.timedOut === true);

  return {
    /** Сколько миллисекунд ждать на этот раз (0 — не ждать вовсе). */
    get budget() {
      return skip() ? 0 : budgetMs;
    },
    /** true — модель стабильно не успевает, вставку не задерживаем. */
    get skipping() {
      return skip();
    },
    /** Записать результат попытки: успела модель или нет. */
    record({ timedOut, ms = 0 } = {}) {
      attempts.push({ timedOut: Boolean(timedOut), ms: Math.max(0, Number(ms) || 0) });
      if (attempts.length > 20) attempts.shift();
    },
    /** Модель сменили или она ответила быстро — начинаем заново. */
    reset() {
      attempts.length = 0;
    },
    /** Для диагностики и тестов. */
    get attempts() {
      return attempts.map((a) => ({ ...a }));
    },
    get budgetMs() {
      return budgetMs;
    },
  };
}

export default createPolishGate;
