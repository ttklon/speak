/**
 * Отчёт «укладывается ли диктовка в пять секунд» — по фактическим замерам,
 * а не по обещаниям каталога моделей.
 *
 * Замеры уже есть в истории: `spokenMs` (сколько секунд человек говорил) и
 * `sttMs` (сколько секунд считал движок). Из них считается честный коэффициент
 * «во сколько раз быстрее реального времени» и делается вывод: успевает или нет.
 *
 * Правило простое и объяснимое: обещание звучит как «фраза на двадцать секунд
 * распознаётся максимум за пять». Значит счёт должен идти минимум вчетверо
 * быстрее речи (20 / 4 = 5) и уж точно не дольше пяти секунд на любую фразу.
 * Короткие записи (меньше восьми секунд) по коэффициенту не судим: там на
 * время счёта влияет запуск, а не работа движка — но пять секунд всё равно
 * остаются верхней границей.
 */

export const SPEED_TARGET_SECONDS = 5;
export const SPEED_OK_FACTOR = 4;
/** Короче этого запись не показательная: в ней больше запуска, чем счёта. */
export const SPEED_MIN_SPOKEN_MS = 800;

const round1 = (value) => Math.round(Number(value) * 10) / 10;

/**
 * @param {Array} entries история диктовок (новые первыми)
 * @param {{target?: number, limit?: number, minSpokenMs?: number}} opts
 * @returns {{samples: Array, verdict: 'ok'|'slow'|'unknown', medianFactor: number,
 *   worst: object|null, advice: string}}
 */
export function analyseSpeed(entries = [], opts = {}) {
  const { target = SPEED_TARGET_SECONDS, limit = 5, minSpokenMs = SPEED_MIN_SPOKEN_MS } = opts;
  const list = Array.isArray(entries) ? entries : [];
  const samples = list
    .filter((entry) => Number(entry?.sttMs) > 0 && Number(entry?.spokenMs) >= minSpokenMs)
    .slice(0, Math.max(1, limit))
    .map((entry) => {
      const spoken = Number(entry.spokenMs) / 1000;
      const compute = Number(entry.sttMs) / 1000;
      // Человек ждёт не «счёт движка», а всё время от отпускания клавиши до
      // готового текста: сюда входят чистка, словарь и вставка. Раньше отчёт
      // судил только по счёту и мог сказать «укладывается», пока ожидание
      // было заметно дольше пяти секунд. У записей без `waitMs` (старые
      // версии) считаем по счёту — как раньше.
      const wait = Number(entry.waitMs) > 0 ? Number(entry.waitMs) / 1000 : compute;
      const total = Math.max(compute, wait);
      const factor = total > 0 ? spoken / total : 0;
      const computeFactor = compute > 0 ? spoken / compute : 0;
      // Две границы: «не дольше пяти секунд» и «минимум вчетверо быстрее речи».
      const fits = total <= target && (spoken < 8 || factor >= SPEED_OK_FACTOR);
      return {
        at: Number(entry.createdAt) || 0,
        spoken: round1(spoken),
        compute: round1(compute),
        total: round1(total),
        factor: round1(factor),
        computeFactor: round1(computeFactor),
        // где именно потерялись секунды: в движке или после него
        tail: round1(Math.max(0, total - compute)),
        fits,
        mode: entry.sttMode === 'server' ? 'server' : entry.sttMode === 'cli' ? 'cli' : '',
        parts: Number(entry.sttParts) > 1 ? Number(entry.sttParts) : 1,
        // «считали, пока говорили»: куски, ушедшие в движок до остановки
        pre: Number(entry.sttPreParts) > 0 ? Number(entry.sttPreParts) : 0,
        model: entry.sttModel || '',
      };
    });

  if (!samples.length) {
    return {
      samples,
      verdict: 'unknown',
      medianFactor: 0,
      worst: null,
      advice:
        'Замеров пока нет. Скажите фразу длиннее пары секунд — здесь появятся секунды речи, секунды счёта и вывод.',
    };
  }

  const sorted = samples.map((s) => s.factor).sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const medianFactor = round1(
    sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
  );
  const worst = samples.reduce((bad, item) => (item.compute > bad.compute ? item : bad), samples[0]);
  const slow = samples.filter((s) => !s.fits);
  const twenty = medianFactor > 0 ? round1(20 / medianFactor) : 0;

  // Вердикт — по большинству, а не по одной неудачной фразе: первый проход
  // после смены модели всегда дороже (загрузка весов), и объявлять по нему
  // «всё медленно» значило бы врать в другую сторону. Худший случай при этом
  // не прячется — он назван отдельно.
  if (slow.length <= samples.length / 2) {
    return {
      samples,
      verdict: 'ok',
      medianFactor,
      worst,
      advice: slow.length
        ? `В среднем в ${medianFactor} раза быстрее реального времени (двадцать секунд речи ≈ ${twenty} с), ` +
          `но одна диктовка ждала ${worst.total} с. Если повторится, приложение перейдёт на режим легче само.`
        : `Укладывается: в среднем в ${medianFactor} раза быстрее реального времени — двадцать секунд речи примерно за ${twenty} с.`,
    };
  }

  // Разделяем две разные причины: движок считал долго — лечится режимом
  // легче; ожидание длинное при быстром счёте — виновата не модель, и менять
  // её было бы вредным советом.
  const computeBound = worst.compute >= worst.total * 0.6;

  return {
    samples,
    verdict: 'slow',
    computeBound,
    medianFactor,
    worst,
    advice: computeBound
      ? `Дольше пяти секунд: ${worst.spoken} с речи — ${worst.total} с ожидания, из них ${worst.compute} с считал движок. ` +
        'После двух таких диктовок приложение само перейдёт на режим легче; переключить сразу можно здесь же.'
      : `Дольше пяти секунд: ${worst.spoken} с речи — ${worst.total} с ожидания, хотя движок считал ${worst.compute} с. ` +
        'Секунды ушли не в распознавание: посмотрите «Умную полировку» и «Живую расшифровку» в «Настройки → Функции».',
  };
}

export default { analyseSpeed, SPEED_TARGET_SECONDS, SPEED_OK_FACTOR, SPEED_MIN_SPOKEN_MS };
