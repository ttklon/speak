/**
 * Подготовка звука перед распознаванием.
 *
 * Облачные сервисы (Wispr Flow, Genspark) звучат «идеально» не только из-за
 * больших моделей: они сначала приводят звук к удобному виду — убирают гул и
 * постоянную составляющую, выравнивают громкость. Whisper обучен на нормально
 * записанной речи; тихий микрофон с гулом вентилятора для него — шум.
 *
 * Здесь две дешёвые операции, обе без нейросетей и без задержек:
 *   1) фильтр высоких частот 80 Гц — убирает DC-смещение, гул стола и «бубнёж»
 *      ниже голоса; речь начинается примерно с 100 Гц, так что она не страдает;
 *   2) выравнивание громкости до −18 dBFS с запасом до потолка — тихая запись
 *      перестаёт быть «шёпотом», громкая не клиппует.
 *
 * Всё живёт в main-процессе: рендерер отдаёт сырой PCM и не тратит CPU.
 */

/** Целевая громкость речи: −18 dBFS — привычная точка для распознавания. */
const TARGET_DBFS = -18;
/** Больше 24 дБ не усиливаем: иначе поднимаем вместе с речью шум микрофона. */
const MAX_GAIN_DB = 24;
/** Потолок сэмпла: 0,97 от максимума — клиппинг слышен модели как щелчок. */
const PEAK_CEIL = 0.97;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** RMS и пик сигнала в Int16, в тех же единицах, что и analysePcm. */
function measurePcm(pcm) {
  const total = Math.floor((pcm?.length || 0) / 2);
  if (!total) return { samples: 0, rms: 0, peak: 0, dbfs: -Infinity };
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < total; i += 1) {
    const v = pcm.readInt16LE(i * 2);
    sum += v * v;
    const abs = Math.abs(v);
    if (abs > peak) peak = abs;
  }
  const rms = Math.sqrt(sum / total);
  // −∞ для тишины: 20·log10(0) не определён, а сравнивать надо числа
  const dbfs = rms > 0 ? 20 * Math.log10(rms / 32768) : -Infinity;
  return { samples: total, rms: Math.round(rms), peak, dbfs };
}

/**
 * Фильтр высоких частот (баттерворт 2-го порядка) прямо по Int16.
 * Возвращает новый буфер: исходный может ещё понадобиться для отчёта.
 */
function highPass(pcm, { sampleRate = 16000, hz = 80 } = {}) {
  const total = Math.floor((pcm?.length || 0) / 2);
  if (!total) return pcm;
  const freq = clamp(Number(hz) || 80, 20, 300);
  const w0 = (2 * Math.PI * freq) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2); // Q = 0,707 — баттерворт
  const b0 = (1 + cos) / 2;
  const b1 = -(1 + cos);
  const b2 = (1 + cos) / 2;
  const a0 = 1 + alpha;
  const a1 = -2 * cos;
  const a2 = 1 - alpha;
  const out = Buffer.allocUnsafe(total * 2);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < total; i += 1) {
    const x = pcm.readInt16LE(i * 2);
    const y = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    out.writeInt16LE(clamp(Math.round(y), -32768, 32767), i * 2);
  }
  return out;
}

/**
 * Выравнивание громкости. Усиливаем тихое, громкое не режем — только
 * ограничиваем пик, чтобы не появился клиппинг.
 */
function normalize(pcm, { targetDbfs = TARGET_DBFS, maxGainDb = MAX_GAIN_DB, peakCeil = PEAK_CEIL } = {}) {
  const stats = measurePcm(pcm);
  if (!stats.samples || !stats.rms) return { pcm, gainDb: 0, before: stats, after: stats };
  const wanted = Math.pow(10, (targetDbfs - stats.dbfs) / 20);
  // потолок по пику: усиливать можно ровно настолько, чтобы пик не упёрся
  const byPeak = stats.peak > 0 ? (peakCeil * 32767) / stats.peak : Infinity;
  const gain = clamp(Math.min(wanted, byPeak), 1, Math.pow(10, maxGainDb / 20));
  if (gain <= 1.0001) return { pcm, gainDb: 0, before: stats, after: stats };
  const out = Buffer.allocUnsafe(stats.samples * 2);
  for (let i = 0; i < stats.samples; i += 1) {
    out.writeInt16LE(clamp(Math.round(pcm.readInt16LE(i * 2) * gain), -32768, 32767), i * 2);
  }
  return {
    pcm: out,
    gainDb: Math.round(20 * Math.log10(gain) * 10) / 10,
    before: stats,
    after: measurePcm(out),
  };
}

/**
 * Полная подготовка: убрать гул, выровнять громкость.
 * Тишину не трогаем вовсе — её отсекает analysePcm до нас, а усиление шума
 * только добавило бы модели работы.
 */
function preparePcm(pcm, { sampleRate = 16000, silentRms = 40 } = {}) {
  const before = measurePcm(pcm);
  if (!before.samples || before.rms < silentRms) {
    return { pcm, gainDb: 0, before, after: before, skipped: 'тишина' };
  }
  const filtered = highPass(pcm, { sampleRate });
  const { pcm: leveled, gainDb, after } = normalize(filtered, {});
  return { pcm: leveled, gainDb, before, after, skipped: '' };
}

module.exports = {
  TARGET_DBFS,
  MAX_GAIN_DB,
  measurePcm,
  highPass,
  normalize,
  preparePcm,
};
