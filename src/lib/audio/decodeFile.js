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

import { FILE_LIMITS, SAMPLE_RATE } from '../recognition/audioFile.js';

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
  const maxBytes = opts.maxBytes ?? FILE_LIMITS.bytes;
  const maxDurationMs = opts.maxDurationMs ?? FILE_LIMITS.durationMs;
  const createContext = opts.createContext || browserContext;
  const createOffline = opts.createOffline || browserOffline;
  const isCancelled = opts.isCancelled || (() => false);
  const checkCancelled = () => {
    if (isCancelled()) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
  };
  if (!file || typeof file.arrayBuffer !== 'function') throw new Error('no-file');
  if (!Number.isFinite(targetRate) || targetRate <= 0 || targetRate > 192000 ||
      !Number.isFinite(maxBytes) || maxBytes <= 0 || !Number.isFinite(maxDurationMs) || maxDurationMs <= 0) throw new Error('invalid-limits');
  checkCancelled();
  // File.size is available without reading the compressed file into memory.
  if (Number(file.size) > maxBytes) throw new Error('too-big');
  const bytes = await file.arrayBuffer();
  checkCancelled();
  if (!bytes || !Number.isSafeInteger(bytes.byteLength) || bytes.byteLength > maxBytes) throw new Error('too-big');
  const ctx = createContext();
  try {
    if (!ctx || typeof ctx.decodeAudioData !== 'function') throw new Error('no-decoder');
    let decoded;
    try {
      decoded = await ctx.decodeAudioData(bytes);
    } catch {
      checkCancelled();
      throw new Error('decode');
    }
    checkCancelled();
    const length = decoded?.length;
    const inputRate = decoded?.sampleRate;
    const duration = decoded?.duration;
    if (!Number.isSafeInteger(length) || length < 0 || !Number.isFinite(inputRate) || inputRate <= 0 ||
        !Number.isFinite(duration) || duration < 0 || !Number.isInteger(decoded?.numberOfChannels) || decoded.numberOfChannels < 1 || decoded.numberOfChannels > 32) throw new Error('decode');
    // decodeAudioData already allocated its AudioBuffer; reject before the next
    // large allocations (mono, OfflineAudioContext and final Int16 PCM).
    if (length / inputRate * 1000 > maxDurationMs || duration * 1000 > maxDurationMs) throw new Error('too-long');
    if (!length) return { pcm: new Int16Array(0), sampleRate: targetRate, durationMs: 0 };
    const frames = Math.max(1, Math.round((length / inputRate) * targetRate));
    const off = createOffline(1, frames, targetRate);
    if (!off) throw new Error('no-decoder');
    const mono = mixToMono(decoded, (ch, len, rate) =>
      typeof ctx.createBuffer === 'function' ? ctx.createBuffer(ch, len, rate) : { getChannelData: () => new Float32Array(len) },
    );
    checkCancelled();
    const source = off.createBufferSource();
    source.buffer = mono;
    source.connect(off.destination);
    source.start(0);
    const rendered = await off.startRendering();
    checkCancelled();
    const samples = rendered.getChannelData(0);
    const rate = rendered.sampleRate || targetRate;
    if (!Number.isFinite(rate) || rate <= 0 || samples.length / rate * 1000 > maxDurationMs) throw new Error('too-long');
    const pcm = floatToInt16(samples);
    return { pcm, sampleRate: rate, durationMs: Math.round((pcm.length / rate) * 1000) };
  } finally {
    // close can throw or reject asynchronously; neither should hide the result
    // or turn a rejected decode into an unhandled rejection.
    try { Promise.resolve(ctx?.close?.()).catch(() => {}); } catch { /* already closed */ }
  }
}

export default decodeAudioFile;
