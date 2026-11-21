/**
 * Правило автоподбора модели по факту, а не по обещаниям каталога.
 *
 * Человек ругается не на «модель small», а на «сказал двадцать секунд — ждал
 * двадцать секунд». Поэтому приложение меряет реальность: сколько секунд речи
 * и сколько секунд счёта, и переходит на ступень легче, если движок не успевает.
 *
 * Правило вынесено в отдельный модуль, потому что оно решает продуктовое
 * обещание «пять секунд максимум». Здесь его можно проверить тестом, а не
 * надеяться, что «в бою сработает»:
 *
 *  - «успевает» = минимум вчетверо быстрее реального времени: именно отсюда
 *    берётся обещанные пять секунд на двадцатисекундную фразу (20 / 4 = 5);
 *  - короткие фразы не судим: на трёх секундах речи секунда уходит на запуск
 *    движка, и «в 1,5 раза быстрее реального времени» — это про разгон, а не
 *    про мощность машины. Раньше из-за этого приложение сползало на самую
 *    лёгкую модель по двум коротким фразам и потом выдавало кашу;
 *  - одна медленная фраза — ещё не повод: нужны две подряд;
 *  - быстрая фраза сбрасывает счётчик;
 *  - ручной выбор человека и выключенный автоподбор не трогаем;
 *  - легче самой лёгкой ступени некуда, нескачанную модель не предлагаем;
 *  - за сессию не больше двух переключений, чтобы приложение не «передумывало».
 */

const REALTIME_OK = 4;
const SLOW_STRIKES = 2;
const MAX_SWITCHES = 2;
/** Обещанный максимум ожидания на длинную фразу, мс (см. «двадцать за пять»). */
const PROMISE_MS = 5000;
/** Короче этого речь не судим по скорости: разгон движка перевешивает. */
const MIN_SECONDS = 6;

/**
 * @returns {{switchTo: string, strikes: number, realtime: number, reason: string}}
 *   switchTo — модель, на которую надо перейти (пусто — не переходим);
 *   strikes — новое значение счётчика медленных фраз;
 *   reason — почему так: fast | slow | slow-once | off | unknown | cap | floor | missing
 */
function decide({
  ms = 0,
  seconds = 0,
  model = '',
  autoOptimize = true,
  pinned = false,
  downloaded = [],
  strikes = 0,
  switches = 0,
} = {}) {
  const realtime = ms > 0 && seconds > 0 ? (seconds * 1000) / ms : 0;
  if (autoOptimize === false || pinned === true) {
    return { switchTo: '', strikes: 0, realtime, reason: 'off' };
  }
  if (!realtime) return { switchTo: '', strikes, realtime: 0, reason: 'unknown' };
  // Короткая фраза: соотношение «речь / счёт» обманчиво, потому что запуск
  // движка — фиксированная плата. Судим её только по обещанию «пять секунд»,
  // иначе две быстрые короткие фразы утаскивают человека на слабую модель.
  if (seconds < MIN_SECONDS && ms <= PROMISE_MS) {
    return { switchTo: '', strikes: 0, realtime, reason: 'short' };
  }
  if (realtime >= REALTIME_OK) return { switchTo: '', strikes: 0, realtime, reason: 'fast' };

  const next = strikes + 1;
  if (next < SLOW_STRIKES) return { switchTo: '', strikes: next, realtime, reason: 'slow-once' };
  if (switches >= MAX_SWITCHES) return { switchTo: '', strikes: next, realtime, reason: 'cap' };

  const hardware = require('./hardware.cjs');
  const lighter = hardware.lighterModel(model);
  if (!lighter) return { switchTo: '', strikes: next, realtime, reason: 'floor' };
  if (!Array.isArray(downloaded) || !downloaded.includes(lighter)) {
    return { switchTo: '', strikes: next, realtime, reason: 'missing' };
  }
  return { switchTo: lighter, strikes: 0, realtime, reason: 'slow' };
}

module.exports = { decide, REALTIME_OK, SLOW_STRIKES, MAX_SWITCHES, PROMISE_MS, MIN_SECONDS };
