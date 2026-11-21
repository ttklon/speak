/**
 * Разбор звукового файла в рендерере: любой формат, который понимает система
 * (WAV, MP3, M4A, OGG, FLAC, WEBM), → 16 кГц моно → 16-битные отсчёты.
 *
 * Нативный main принимает именно такой звук, поэтому декодирование живёт здесь:
 * в Chromium уже есть кодек, и приложению не нужен ни ffmpeg, ни новые 30 МБ
 * в установщике.
 *
 * Всё, что касается браузера, передаётся через параметры: тест проверяет
 * арифметику без AudioContext.
 */

import { SAMPLE_RATE } from '../recognition/audioFile.js';

/** Громкость в 16-битный отсчёт, с обрезкой перегрузки. */
export function floatToInt16(float) {
  const out = new Int16Array(float?.length || 0);
  for (let i = 0; i < out.length; i += 1) {
    const v = Math.max(-1, Math.min(1, Number(float[i]) || 0));
    out[i] = v < 0 ? Math.round(v * 0x8000) : Math.round(v * 0x7fff);
  }
  return out;
}

/** Среднее по каналам: речевой движок работает с одним каналом. */
export function mixToMono(buffer, createBuffer) {
  const channels = Math.max(1, buffer?.numberOfChannels || 1);
  const length = buffer?.length || 0;
  const mono = createBuffer(1, length, buffer?.sampleRate || SAMPLE_RATE);
  const target = mono.getChannelData(0);
  for (let ch = 0; ch < channels; ch += 1) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i += 1) target[i] += data[i] / channels;
  }
  return mono;
}

function browserContext() {
  if (typeof window === 'undefined') return null;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  return Ctx ? new Ctx() : null;
}

function browserOffline(channels, frames, rate) {
  if (typeof window === 'undefined') return null;
  const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  return Offline ? new Offline(channels, frames, rate) : null;
}

/**
 * Файл → { pcm, durationMs, sampleRate }.
 *
 * Пересэмплирование делает OfflineAudioContext: он умеет это быстро и без
 * наших коэффициентов. Если файл уже 16 кГц — всё равно прогоняем, лишний
 * проход на секунду звука дешевле, чем отдельная ветка с ошибками.
 */
export async function decodeAudioFile(file, opts = {}) {
  const targetRate = Number(opts.targetRate) || SAMPLE_RATE;
  const createContext = opts.createContext || browserContext;
  const createOffline = opts.createOffline || browserOffline;
  if (!file || typeof file.arrayBuffer !== 'function') throw new Error('no-file');
  const bytes = await file.arrayBuffer();
  const ctx = createContext();
  if (!ctx || typeof ctx.decodeAudioData !== 'function') throw new Error('no-decoder');

  let decoded;
  try {
    decoded = await ctx.decodeAudioData(bytes);
  } catch (err) {
    try {
      ctx.close?.();
    } catch {
      /* ignore */
    }
    throw new Error('decode');
  }
  const durationMs = Math.max(0, Math.round((decoded?.duration || 0) * 1000));
  const off = createOffline(1, Math.max(1, Math.round(((decoded?.duration || 0) * targetRate) || 1)), targetRate);
  if (!off) throw new Error('no-decoder');
  // mono-буфер живёт в том же контексте, что и исходный, иначе Chromium
  // отказывается связывать буферы разных контекстов
  const mono = mixToMono(decoded, (ch, len, rate) =>
    typeof ctx.createBuffer === 'function' ? ctx.createBuffer(ch, len, rate) : { getChannelData: () => new Float32Array(len) },
  );
  const source = off.createBufferSource();
  source.buffer = mono;
  source.connect(off.destination);
  source.start(0);
  const rendered = await off.startRendering();
  try {
    ctx.close?.();
  } catch {
    /* ignore */
  }
  const pcm = floatToInt16(rendered.getChannelData(0));
  const rate = rendered.sampleRate || targetRate;
  return {
    pcm,
    sampleRate: rate,
    // длительность считаем по готовому звуку: у VBR-файлов заголовок врёт
    durationMs: Math.round((pcm.length / rate) * 1000) || durationMs,
  };
}

export default decodeAudioFile;
