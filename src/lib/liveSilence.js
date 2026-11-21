/**
 * «Микрофон молчит» — предупреждение во время записи, а не после.
 *
 * Зачем: сейчас приложение честно говорит «в записи тишина» только после
 * остановки — то есть человек уже проговорил минуту в неработающий микрофон и
 * узнал об этом из ошибки. Wispr Flow предупреждает в момент записи, и это
 * правильнее: молчание микрофона видно сразу, а не задним числом.
 *
 * Считаем не «один тихий кадр», а непрерывную тишину: вдох между фразами и
 * пауза на раздумье — это норма, а пять секунд ниже порога — уже повод сказать.
 * После предупреждения ждём: повторять каждые пять секунд — превращать помощь в
 * шум. Как только звук появился, счёт начинается заново.
 */

/** Уровень ниже этого считаем тишиной: у нас уровень микрофона 0…1. */
export const QUIET_LEVEL = 0.06;
/** Сколько непрерывной тишины терпим, прежде чем сказать. */
export const QUIET_NOTICE_MS = 5000;

export const QUIET_HINT = 'Микрофон молчит — проверьте устройство в «Настройки → Приложение».';

/**
 * Сторож непрерывной тишины.
 * @param {{ quietLevel?: number, afterMs?: number }} [opts]
 */
export function createQuietWatch(opts = {}) {
  const quietLevel = Number(opts.quietLevel ?? QUIET_LEVEL);
  const afterMs = Number(opts.afterMs ?? QUIET_NOTICE_MS);
  let since = 0;
  let warned = false;

  return {
    /**
     * @param {number} level уровень 0…1
     * @param {number} now время в мс
     * @returns {boolean} пора ли предупредить (один раз на участок тишины)
     */
    feed(level, now) {
      const value = Number(level);
      if (!Number.isFinite(value) || value >= quietLevel) {
        since = 0;
        warned = false;
        return false;
      }
      if (!since) {
        since = Number(now) || Date.now();
        return false;
      }
      if (!warned && Number(now) - since >= afterMs) {
        warned = true;
        return true;
      }
      return false;
    },
    /** Начать запись заново: старые секунды тишины не должны считаться. */
    reset() {
      since = 0;
      warned = false;
    },
  };
}
