/**
 * «Считать, пока говорите».
 *
 * Проблема, которую это решает: whisper не отдаёт текст по ходу речи, поэтому
 * раньше движок запускался только после остановки записи и считал всю фразу
 * целиком. Двадцать секунд речи — это секунды счёта уже после того, как человек
 * замолчал, и он всё это время ждёт.
 *
 * Теперь на паузах в речи уже сказанное можно отдать движку заранее: пока
 * человек думает или переводит дыхание, процессор считает первый кусок. После
 * остановки остаётся распознать только хвост после последней паузы — обычно
 * одно предложение вместо всей фразы.
 *
 * Границы режем серединой паузы (а не по громкости «здесь тихо началось»),
 * поэтому слово не распадается на два куска: whisper не умеет склеивать
 * половины слов, и «програм|му» превратилось бы в «програм му».
 *
 * Модуль чистый: ни микрофона, ни IPC — только числа. Поэтому его проверяют
 * юнит-тесты, а не «на слух».
 */

/** Короче этого куска резать нечего: накладные расходы съедят выигрыш. */
export const CHUNK_MIN_MS = 4500;
/** Пауза, по которой безопасно резать фразу. */
export const CHUNK_SILENCE_MS = 650;
/** Ниже этого уровня считается «тихо» (шкала recorder: 0…1, сглаженная). */
export const CHUNK_LEVEL = 0.08;
/**
 * Если человек говорит без пауз, ждать их бессмысленно — режем по времени.
 * Двадцатисекундная фраза без единой паузы иначе целиком уйдёт в хвост, и
 * ожидание после кнопки «стоп» снова будет как вся диктовка.
 *
 * Резать по таймеру безопасно только потому, что куски идут с перекрытием:
 * граница может попасть внутрь слова, но оно целиком есть в предыдущем куске,
 * а дубль снимается при склейке (`mergeOverlap`).
 */
export const CHUNK_MAX_MS = 6000;
/** Сколько звука отдаём повторно, чтобы ни одно слово не потерялось. */
export const CHUNK_OVERLAP_MS = 400;

/**
 * @param {{minChunkMs?: number, silenceMs?: number, level?: number}} opts
 */
/**
 * Стоит ли вообще резать запись заранее.
 *
 * Нарезка выгодна только на прогретом сервере: там каждый кусок считается без
 * загрузки весов. Если движок работает через `whisper-cli` (сервер не поднялся,
 * слабая машина, старый бинарник), то каждый кусок — это снова загрузка
 * модели с диска, и нарезка сделает диктовку МЕДЛЕННЕЕ, чем один проход по
 * всей записи. Поэтому режем только когда известно, что сервер отвечал.
 *
 * Прогретый сервер виден по итогу прошлой диктовки (`mode: 'server'`). На самой
 * первой диктовке после запуска это ещё неизвестно — тогда не режем: сэкономим
 * на первой фразе, выиграем на всех следующих.
 *
 * @param {string} mode чем считала прошлая диктовка: 'server' | 'cli' | ''
 */
export function shouldPreChunk(mode) {
  return mode === 'server';
}

export function createSpeechTracker(opts = {}) {
  const minChunkMs = Number(opts.minChunkMs) || CHUNK_MIN_MS;
  const silenceMs = Number(opts.silenceMs) || CHUNK_SILENCE_MS;
  const level = Number(opts.level) || CHUNK_LEVEL;
  const maxChunkMs = Number(opts.maxChunkMs) || CHUNK_MAX_MS;
  const overlapMs = Number(opts.overlapMs) || CHUNK_OVERLAP_MS;

  let quietFrom = null;
  let committedMs = 0;
  // Последние две секунды уровней: по ним выбирается место разреза, когда
  // человек говорит без пауз. Слово кончается там, где тише всего, — резать
  // «где пришлось» значит разрезать слово пополам.
  const recent = [];

  /**
   * Самое тихое место в недавнем прошлом — там заканчивается слово.
   * @returns {number|null} миллисекунда разреза или null, если резать негде
   */
  function quietestCut(atMs, fromMs) {
    const untilMs = atMs - 300;
    const sinceMs = Math.max(fromMs + 1000, atMs - 2000);
    let best = null;
    for (const point of recent) {
      if (point.atMs < sinceMs || point.atMs > untilMs) continue;
      // при равной громкости берём более позднее место: оно ближе к текущей
      // речи, а значит короче хвост после остановки
      if (!best || point.level <= best.level) best = point;
    }
    if (!best) return null;
    const cutAt = Math.round(best.atMs);
    return cutAt - fromMs >= 1500 ? cutAt : null;
  }

  return {
    /** До какого места записи звук уже отправлен в движок. */
    get committedMs() {
      return committedMs;
    },

    /**
     * Скормить уровень микрофона. Возвращает `{fromMs, atMs}` — кусок, который
     * можно отдать движку, либо null.
     *
     * @param {{level?: number, atMs?: number}} sample
     */
    feed(sample = {}) {
      const value = Number(sample.level) || 0;
      const atMs = Math.max(0, Math.round(Number(sample.atMs) || 0));
      recent.push({ atMs, level: value });
      while (recent.length > 40) recent.shift();
      // Говорит — значит никакой паузы нет.
      if (value > level) {
        quietFrom = null;
        // Речь без пауз: кусок уже слишком длинный — режем по времени. Место
        // разреза — самый тихий момент последних двух секунд, но не ближе
        // 300 мс к текущему: «сейчас» может быть серединой слова.
        if (atMs - committedMs >= maxChunkMs) {
          const fromMs = committedMs;
          const cutAt = quietestCut(atMs, fromMs);
          if (cutAt !== null) {
            committedMs = cutAt;
            return { fromMs, atMs: cutAt, timed: true };
          }
        }
        return null;
      }
      if (quietFrom === null) quietFrom = atMs;
      if (atMs - quietFrom < silenceMs) return null;
      // Куска ещё нет: резать нечего, ждём, пока наберётся минимум.
      if (atMs - committedMs < minChunkMs) return null;
      // Режем середину паузы: до неё человек уже закончил слово.
      const cutAt = Math.round(quietFrom + silenceMs / 2);
      const fromMs = committedMs;
      // Слишком короткий остаток отдавать движку незачем: дешевле дождаться
      // остановки, чем платить за проход.
      if (cutAt - fromMs < 1500) return null;
      committedMs = cutAt;
      // Пауза может продолжаться: следующая граница — не раньше новой паузы.
      quietFrom = atMs;
      return { fromMs, atMs: cutAt, timed: false };
    },

    /**
     * Проход не дал текста — возвращаем границу назад, иначе этот звук
     * потерялся бы: он уже не попадёт ни в кусок, ни в хвост.
     */
    rollback(fromMs = 0) {
      const back = Math.max(0, Math.round(Number(fromMs) || 0));
      if (back < committedMs) committedMs = back;
      quietFrom = null;
    },

    /** Сколько звука ещё не отправлено движку. */
    pendingMs(atMs = 0) {
      return Math.max(0, Math.round(Number(atMs) || 0) - committedMs);
    },

    /** Перекрытие: столько звука повторяется в соседних кусках. */
    get overlapMs() {
      return overlapMs;
    },
  };
}

/**
 * Склейка кусков в один текст.
 *
 * whisper отдаёт каждый кусок самостоятельным предложением: со своей заглавной
 * буквой и без ведущего пробела. Склеивать их через слепой пробел нельзя —
 * получились бы «Привет , как дела». Здесь только то, что не портит текст:
 * лишние пробелы убираются, знак препинания прижимается к слову, а дефис в
 * конце куска (человек назвал слово по буквам) остаётся без пробела.
 */
export function joinChunks(parts = []) {
  const list = (Array.isArray(parts) ? parts : [])
    .map((part) => String(part || '').replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean);
  if (!list.length) return '';

  let out = list[0];
  for (let i = 1; i < list.length; i += 1) {
    const next = list[i];
    if (/[([{«"—–/-]$/.test(out)) out += next;
    else if (/^[,.;:!?%)\]»]/.test(next)) out += next;
    else out += ` ${next}`;
  }
  return out.replace(/[ \t]+/g, ' ').replace(/[ \t]+([,.;:!?])/g, '$1').trim();
}

const words = (text = '') => String(text || '').split(/\s+/).filter(Boolean);
const bare = (word = '') => String(word).toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

/**
 * Склейка кусков, которые шли с перекрытием.
 *
 * Перекрытие нужно, чтобы граница могла проходить где угодно: слово, разрезанное
 * пополам, целиком есть в предыдущем куске. Плата — дубль на стыке, и его надо
 * снять. Три случая:
 *
 *  1. Последние слова предыдущего куска совпадают с первыми словами нового —
 *     это тот же текст, второй раз его не пишем.
 *  2. Первое слово нового куска — обрывок последнего слова предыдущего
 *     («программу» → «му»): обрывок выбрасываем.
 *  3. Перекрытия нет — обычная склейка через `joinChunks`.
 *
 * Снимаем не больше трёх слов: если человек действительно повторил «да, да»,
 * это его слова, а не дубль распознавания.
 */
export function mergeOverlap(previous = '', next = '') {
  const left = String(previous || '').trim();
  const right = String(next || '').trim();
  if (!left) return right;
  if (!right) return left;

  const leftWords = words(left);
  const rightWords = words(right);
  const max = Math.min(3, leftWords.length, rightWords.length);

  // 1) точное совпадение хвоста и начала
  for (let k = max; k >= 1; k -= 1) {
    const tail = leftWords.slice(-k).map(bare).join(' ');
    const head = rightWords.slice(0, k).map(bare).join(' ');
    if (tail && tail === head) {
      const rest = rightWords.slice(k).join(' ');
      return joinChunks([left, rest]);
    }
  }

  // 2) обрывок последнего слова на стыке
  const lastLeft = bare(leftWords[leftWords.length - 1]);
  const firstRight = bare(rightWords[0]);
  if (
    lastLeft &&
    firstRight &&
    firstRight !== lastLeft &&
    lastLeft.length > firstRight.length &&
    lastLeft.endsWith(firstRight)
  ) {
    const rest = rightWords.slice(1).join(' ');
    return joinChunks([left, rest]);
  }

  return joinChunks([left, right]);
}

export default {
  createSpeechTracker,
  shouldPreChunk,
  joinChunks,
  mergeOverlap,
  CHUNK_MIN_MS,
  CHUNK_SILENCE_MS,
  CHUNK_LEVEL,
  CHUNK_MAX_MS,
  CHUNK_OVERLAP_MS,
};
