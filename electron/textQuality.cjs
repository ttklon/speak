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

/**
 * Хвост прошлой фразы как подсказка движку.
 *
 * Зачем: маленькая модель не помнит, как человек называл вещи в прошлой фразе,
 * и пишет «зум» вместо «Zoom», «телеграм» вместо «Telegram». Подсказка из
 * предыдущего текста возвращает эти слова без всякой нейросети и без трат CPU.
 *
 * Берём только конец — он ближе к тому, что человек скажет дальше, — и режем по
 * границе слова. Пунктуацию убираем: модель иначе повторяет её в начале.
 */
function tailForPrompt(text, limit = 80) {
  const clean = String(text || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return '';
  const max = Math.max(20, Number(limit) || 80);
  let tail = clean.slice(-max);
  if (tail.length === max) {
    // обрезали посреди слова — начинаем со следующего
    const space = tail.indexOf(' ');
    if (space >= 0) tail = tail.slice(space + 1);
  }
  return tail.replace(/[.,!?;:…]+$/g, '').trim();
}

/**
 * Движок иногда повторяет подсказку в начале ответа — целиком или её хвостом.
 * Вырезаем повтор, иначе человек увидит в тексте дважды одну и ту же фразу.
 */
function stripPromptEcho(text, tail) {
  const value = String(text || '');
  const hint = String(tail || '').trim();
  if (!value || !hint) return value;
  if (value.trimStart().toLowerCase().startsWith(hint.toLowerCase())) {
    return value.trimStart().slice(hint.length).replace(/^[\s.,!?;:—-]+/, '');
  }
  // частичное совпадение по словам: ищем самый длинный хвост подсказки,
  // с которого начинается ответ (минимум три слова — иначе это совпадение)
  const hintWords = hint.toLowerCase().split(/\s+/).filter(Boolean);
  const outWords = value.trimStart().split(/\s+/).filter(Boolean);
  const norm = (w) => w.toLowerCase().replace(/[.,!?;:…]/g, '');
  for (let take = Math.min(hintWords.length, outWords.length); take >= 3; take -= 1) {
    const part = hintWords.slice(-take).map((w) => w.replace(/[.,!?;:…]/g, ''));
    const head = outWords.slice(0, take).map(norm);
    if (part.every((w, i) => w === head[i])) {
      return outWords.slice(take).join(' ');
    }
  }
  return value;
}

/**
 * Нужен ли второй проход — решение в одном месте, чтобы его можно было
 * проверить без движка и без Windows.
 *
 * Повтор оправдан только когда первый проход был быстрым (у него не было
 * перебора температур) и результат вышел подозрительным. Если машина уже
 * считала «честно» с первого раза, тот же проход второй раз даст тот же текст.
 */
function shouldRetry({ judge = {}, plan = {}, partial = false, seconds = 0, code = '' } = {}) {
  if (partial) return false;
  if (code) return false;
  if (!judge || judge.unsure !== true) return false;
  if (Number(seconds) < 1.2) return false;
  if (plan && plan.thorough === true) return false;
  return true;
}

module.exports = {
  judgeText,
  betterText,
  stripPromptEcho,
  tailForPrompt,
  shouldRetry,
  FILLERS,
};
