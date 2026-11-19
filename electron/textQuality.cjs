/**
 * Стоит ли переспросить движок.
 *
 * Whitepaper-факт: whisper с включённым fallback (перебор температур) заметно
 * точнее, но каждый повтор — это ещё один проход по 30 секундам звука. Мы
 * держим быстрый проход без повторов (`-nf`) и делаем второй, честный, только
 * когда первый вышел подозрительным. Это и есть компромисс «быстро как у всех,
 * точно как у облака»: платим временем только за те фразы, где оно нужно.
 *
 * Подозрительное — это не «мне не нравится», а измеримые вещи:
 *   • пусто или два слова на десять секунд речи;
 *   • текст-заглушка, которым whisper закрывает тишину и шум;
 *   • одно слово подряд много раз (зацикливание декодера).
 */

/** Заглушки, которые whisper выдаёт на тишине и музыке. */
const FILLERS = [
  /продолжение следует/i,
  /субтитры (сделал|делал|подготовил)/i,
  /спасибо за (просмотр|внимание)/i,
  /подписывайтесь на канал/i,
  /ставьте лайки/i,
  /thanks for watching/i,
  /subtitles by/i,
  /please subscribe/i,
];

const words = (text) => String(text || '').trim().split(/\s+/).filter(Boolean);

/**
 * @param {string} text что вернул движок
 * @param {{seconds?: number}} opts сколько длилась речь
 * @returns {{unsure: boolean, why: string}}
 */
function judgeText(text, { seconds = 0 } = {}) {
  const value = String(text || '').trim();
  if (!value) return { unsure: true, why: 'пусто' };

  const list = words(value);
  const chars = value.replace(/\s+/g, ' ').length;
  const span = Math.max(0, Number(seconds) || 0);

  // Заглушки проверяем раньше длины: «Продолжение следует» — это тоже «мало
  // слов», но причина другая, и в журнале должно быть видно настоящую.
  if (list.length <= 8) {
    for (const pattern of FILLERS) {
      if (pattern.test(value)) return { unsure: true, why: 'фраза-заглушка' };
    }
  }

  // «Один-два слова на длинную запись» — модель потеряла речь, а не человек
  // сказал одно слово: живая речь на пять секунд — это не «да».
  if (span >= 4 && list.length <= 2) return { unsure: true, why: 'слишком мало слов' };

  // меньше двух символов в секунду — тоже потеря. Осторожно: медленная речь с
  // паузами бывает и нормальной, поэтому порог низкий и только на длинном.
  if (span >= 5 && chars / span < 2) return { unsure: true, why: 'мало текста на длинную запись' };

  // Зацикливание: одно и то же слово подряд четыре и больше раз
  let streak = 1;
  for (let i = 1; i < list.length; i += 1) {
    const same = list[i].toLowerCase() === list[i - 1].toLowerCase();
    streak = same ? streak + 1 : 1;
    if (streak >= 4) return { unsure: true, why: 'зацикливание' };
  }

  return { unsure: false, why: '' };
}

/** Похоже ли, что второй проход вернул больше (не потеряв смысл). */
function betterText(first, second) {
  const a = words(first).length;
  const b = words(second).length;
  if (!b) return false;
  if (!a) return true;
  // Второй проход должен дать заметно больше слов, а не «другие» слова.
  return b >= Math.max(a + 2, Math.round(a * 1.3));
}

module.exports = { judgeText, betterText, FILLERS };
