/**
 * Нарезка длинной записи на куски и склейка обратно — общая для всех движков.
 *
 * Правило не зависит от языка и модели: модели обучали на коротких фразах,
 * после двадцати секунд качество падает, а память энкодера растёт квадратично
 * по кадрам. Поэтому длинная диктовка режется в самом тихом месте около
 * ровной середины — не «по счётчику», а по звуку:
 * разрез посреди слова стоил бы обрезанного слова, а разрез в паузе — ничего.
 *
 * Почему не наш `splitBySilence` из whisper.cjs: тот режет по порогу тишины и
 * может не найти подходящего места вовсе. Здесь другая задача — гарантированно
 * получить куски не длиннее предела, а тишину искать только внутри допустимого
 * окна. Так делает и референсная реализация на C# (TypeWhisper), и маковский
 * плагин Гига Писаря.
 */

const DEFAULT_MAX_SECONDS = 20;
const SAMPLE_RATE = 16000;
// 20 мс на кадр энергии, тишина ищется полосой 200 мс.
const FRAME_LENGTH = SAMPLE_RATE / 50;
const QUIET_STRETCH_FRAMES = 10;
const SENTENCE_ENDS = '.!?…';

/**
 * @param {Float32Array} samples звук 16 кГц моно, −1…1
 * @param {number} [maxSamples] предел одного куска
 * @returns {Array<{ offset: number, count: number }>}
 */
function chunkRanges(samples, maxSamples = DEFAULT_MAX_SECONDS * SAMPLE_RATE) {
  const count = samples.length;
  if (maxSamples <= 0 || count <= maxSamples) return [{ offset: 0, count }];

  const searchRadius = Math.floor(maxSamples / 20);
  const ranges = [];
  let start = 0;
  while (count - start > maxSamples) {
    const remaining = count - start;
    const chunkCount = Math.ceil(remaining / maxSamples);
    const evenCut = start + Math.floor(remaining / chunkCount);
    // Раньше этого резать нельзя: остаток перестанет влезать в оставшиеся куски.
    const earliestCut = count - (chunkCount - 1) * maxSamples;
    const searchStart = Math.max(evenCut - searchRadius, earliestCut);
    const searchEnd = Math.min(evenCut + searchRadius, start + maxSamples);
    const cut = searchStart >= searchEnd ? evenCut : quietestPoint(samples, searchStart, searchEnd);
    ranges.push({ offset: start, count: cut - start });
    start = cut;
  }
  ranges.push({ offset: start, count: count - start });
  return ranges;
}

/**
 * Середина самой тихой полосы 200 мс между `start` и `end`.
 * @returns {number} позиция разреза в отсчётах
 */
function quietestPoint(samples, start, end) {
  const frameCount = Math.floor((end - start) / FRAME_LENGTH);
  if (frameCount <= 0) return start + Math.floor((end - start) / 2);

  const energies = new Float64Array(frameCount);
  for (let frame = 0; frame < frameCount; frame++) {
    let energy = 0;
    const from = start + frame * FRAME_LENGTH;
    for (let i = 0; i < FRAME_LENGTH; i++) {
      const value = samples[from + i] || 0;
      energy += value * value;
    }
    energies[frame] = energy;
  }

  const stretch = Math.min(QUIET_STRETCH_FRAMES, frameCount);
  let window = 0;
  for (let frame = 0; frame < stretch; frame++) window += energies[frame];
  let quietestEnergy = window;
  let quietestStart = 0;
  for (let frame = stretch; frame < frameCount; frame++) {
    window += energies[frame] - energies[frame - stretch];
    if (window < quietestEnergy) {
      quietestEnergy = window;
      quietestStart = frame - stretch + 1;
    }
  }
  return start + quietestStart * FRAME_LENGTH + Math.floor((stretch * FRAME_LENGTH) / 2);
}

/**
 * Первое слово куска модель всегда пишет с заглавной. Если предыдущий кусок
 * кончился без точки, разрез пришёлся на середину фразы — и заглавная там
 * ложная. Аббревиатуры («США», «МГУ») не трогаем: у них вторая буква заглавная.
 */
function continuing(transcript, text) {
  if (!transcript || SENTENCE_ENDS.includes(transcript[transcript.length - 1])) return text;
  if (text.length < 2) return text;
  const first = text[0];
  const second = text[1];
  const upper = first.toUpperCase() === first && first.toLowerCase() !== first;
  const lower = second.toLowerCase() === second && second.toUpperCase() !== second;
  if (!upper || !lower) return text;
  return first.toLowerCase() + text.slice(1);
}

/** Добавить кусок к расшифровке через один пробел. */
function append(transcript, text) {
  const clean = String(text || '').trim();
  if (!clean) return transcript;
  return transcript ? `${transcript} ${clean}` : clean;
}

module.exports = {
  DEFAULT_MAX_SECONDS,
  SAMPLE_RATE,
  append,
  chunkRanges,
  continuing,
  quietestPoint,
};
