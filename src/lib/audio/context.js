/**
 * Аудио для распознавания: одна частота и один ресемплер на всё приложение.
 *
 * Зачем отдельным модулем: whisper.cpp ждёт 16 кГц моно, а микрофон в Windows
 * отдаёт 48 кГц. Раньше звук «прореживали» линейной интерполяцией — это самая
 * простая, но и самая грязная схема: всё, что выше 8 кГц, складывается обратно
 * в речевой диапазон (алиасинг) и превращает шипящие в шум. Большая модель это
 * переживает, маленькая — нет: именно на ней текст выходил «кашей».
 *
 * Поэтому:
 *  1) пробуем открыть микрофон сразу в 16 кГц — тогда ресемплинг делает движок
 *     браузера с настоящим фильтром, и нам ничего не нужно;
 *  2) если система не даёт 16 кГц — ресемплим сами, но с фильтром-low-pass
 *     перед прореживанием (см. resampleAudio).
 */

export const TARGET_RATE = 16000;

const pickAudioContext = () =>
  (typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext)) || null;

/**
 * AudioContext на 16 кГц, если браузер это умеет.
 *
 * @returns {{ctx: object|null, native: boolean}} native=true — ресемплинг уже сделан движком
 */
export function createAudioContext(Ctx = pickAudioContext()) {
  if (!Ctx) return { ctx: null, native: false };
  try {
    const ctx = new Ctx({ sampleRate: TARGET_RATE });
    if (Math.round(ctx.sampleRate) === TARGET_RATE) return { ctx, native: true };
    // Частоту не дали — закрываем и открываем обычную, ресемплить будем сами
    try {
      ctx.close?.();
    } catch {
      /* ignore */
    }
  } catch {
    /* старый браузер не знает опций конструктора */
  }
  return { ctx: new Ctx(), native: false };
}

/**
 * Фильтр-low-pass (окно Хэмминга, sinc) — чтобы перед прореживанием убрать
 * частоты выше новой половины Найквиста. Без него они «отражаются» в речевой
 * диапазон.
 */
function lowPass(input, cutoff) {
  if (!(cutoff > 0) || cutoff >= 0.5 || !input?.length) return input;
  const taps = 31;
  const middle = (taps - 1) / 2;
  const kernel = new Float32Array(taps);
  let sum = 0;
  for (let i = 0; i < taps; i += 1) {
    const n = i - middle;
    const sinc = n === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * n) / (Math.PI * n);
    const window = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (taps - 1));
    kernel[i] = sinc * window;
    sum += kernel[i];
  }
  // нормируем: без этого фильтр меняет громкость
  if (sum) for (let i = 0; i < taps; i += 1) kernel[i] /= sum;

  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    let acc = 0;
    for (let k = 0; k < taps; k += 1) {
      const idx = i + k - middle;
      if (idx >= 0 && idx < input.length) acc += input[idx] * kernel[k];
    }
    out[i] = acc;
  }
  return out;
}

/**
 * Привести звук к 16 кГц.
 *
 * При понижении частоты сначала ставим low-pass, потом линейную интерполяцию:
 * так дёшево и без алиасинга. При повышении фильтр не нужен.
 */
export function resampleAudio(float32, inputRate, outputRate = TARGET_RATE) {
  if (!float32?.length) return float32;
  const from = Number(inputRate) || outputRate;
  const to = Number(outputRate) || TARGET_RATE;
  if (from === to) return float32;
  const ratio = from / to;
  // Отфильтровать надо всё выше половины новой частоты: в долях от исходной это
  // 0.5 / ratio. Берём 0.45 — с запасом, чтобы не срезать полезные 7 кГц.
  const filtered = ratio > 1.2 ? lowPass(float32, 0.45 / ratio) : float32;
  const length = Math.max(0, Math.floor(filtered.length / ratio));
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(filtered.length - 1, i0 + 1);
    const frac = pos - i0;
    out[i] = filtered[i0] * (1 - frac) + filtered[i1] * frac;
  }
  return out;
}

export default { TARGET_RATE, createAudioContext, resampleAudio };
