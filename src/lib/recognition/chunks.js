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
export const CHUNK_MIN_MS = 6000;
/** Пауза, по которой безопасно резать фразу. */
export const CHUNK_SILENCE_MS = 650;
/** Ниже этого уровня считается «тихо» (шкала recorder: 0…1, сглаженная). */
export const CHUNK_LEVEL = 0.08;

/**
 * @param {{minChunkMs?: number, silenceMs?: number, level?: number}} opts
 */
export function createSpeechTracker(opts = {}) {
  const minChunkMs = Number(opts.minChunkMs) || CHUNK_MIN_MS;
  const silenceMs = Number(opts.silenceMs) || CHUNK_SILENCE_MS;
  const level = Number(opts.level) || CHUNK_LEVEL;

  let quietFrom = null;
  let committedMs = 0;

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
      // Говорит — значит никакой паузы нет.
      if (value > level) {
        quietFrom = null;
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
      return { fromMs, atMs: cutAt };
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

export default { createSpeechTracker, joinChunks, CHUNK_MIN_MS, CHUNK_SILENCE_MS, CHUNK_LEVEL };
