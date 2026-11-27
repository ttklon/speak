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

// Предварительная оценка только для обычного несжатого RIFF/WAVE с полным,
// согласованным fmt и data в начале файла. Заголовок недоверенный: если он
// сомнителен, это не доказательство безопасности и решение остаётся кодеку.
function pcmWavInfo(buffer, fileSize) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 12 || !Number.isSafeInteger(fileSize)) return null;
  const v = new DataView(buffer, 0, Math.min(buffer.byteLength, 65536));
  const tag = (at, text) => at + text.length <= v.byteLength && [...text].every((c, i) => v.getUint8(at + i) === c.charCodeAt(0));
  if (!tag(0, 'RIFF') || !tag(8, 'WAVE')) return null;
  const end = v.getUint32(4, true) + 8;
  if (end > fileSize || end < 12) return null;
  let pos = 12; let fmt = null;
  while (pos + 8 <= v.byteLength && pos + 8 <= end) {
    const size = v.getUint32(pos + 4, true);
    const body = pos + 8;
    if (body + size > end) return null;
    if (tag(pos, 'fmt ')) {
      if (size < 16 || body + 16 > v.byteLength || fmt) return null;
      const format = v.getUint16(body, true); const channels = v.getUint16(body + 2, true);
      const rate = v.getUint32(body + 4, true); const bytesPerSecond = v.getUint32(body + 8, true);
      const align = v.getUint16(body + 12, true); const bits = v.getUint16(body + 14, true);
      if (!channels || channels > 32 || !rate || !align || align !== channels * bits / 8 ||
          bytesPerSecond !== rate * align || !((format === 1 && [8, 16, 24, 32].includes(bits)) || (format === 3 && [32, 64].includes(bits)))) return null;
      fmt = { rate, align, channels };
    } else if (tag(pos, 'data')) {
      if (!fmt || size % fmt.align !== 0) return null;
      return { durationMs: size / fmt.align / fmt.rate * 1000, channels: fmt.channels };
    }
    const next = body + size + (size % 2);
    if (next > end || next <= pos) return null;
    pos = next;
  }
  return null;
}

export function pcmWavDurationMs(buffer, fileSize) {
  return pcmWavInfo(buffer, fileSize)?.durationMs ?? null;
}

function estimatedBytes(encodedBytes, length, channels, outputFrames) {
  return encodedBytes + length * channels * 4 + (channels > 1 ? length * 4 : 0) + outputFrames * 6;
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
  const maxWorkingBytes = opts.maxWorkingBytes ?? FILE_LIMITS.workingBytes;
  const createContext = opts.createContext || browserContext;
  const createOffline = opts.createOffline || browserOffline;
  const isCancelled = opts.isCancelled || (() => false);
  const checkCancelled = () => {
    if (isCancelled()) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
  };
  if (!file || typeof file.arrayBuffer !== 'function') throw new Error('no-file');
  if (!Number.isFinite(targetRate) || targetRate <= 0 || targetRate > 192000 ||
      !Number.isFinite(maxBytes) || maxBytes <= 0 || !Number.isFinite(maxDurationMs) || maxDurationMs <= 0 ||
      !Number.isFinite(maxWorkingBytes) || maxWorkingBytes <= 0) throw new Error('invalid-limits');
  checkCancelled();
  // File.size is available without reading the compressed file into memory.
  if (Number(file.size) > maxBytes) throw new Error('too-big');
  let wav = null;
  if (typeof file.slice === 'function' && Number.isSafeInteger(file.size) && file.size >= 12) {
    let header = null;
    try { header = await file.slice(0, Math.min(file.size, 65536)).arrayBuffer(); } catch { /* обычное чтение покажет ошибку */ }
    checkCancelled();
    wav = pcmWavInfo(header, file.size);
    if (wav && wav.durationMs > maxDurationMs) throw new Error('too-long');
  }
  let ctx = null;
  try {
    // Для понятного WAV AudioContext сообщает частоту, к которой Chromium
    // приводит decodeAudioData. Это оценка, а не проверка содержимого файла.
    if (wav) {
      ctx = createContext();
      if (!ctx || typeof ctx.decodeAudioData !== 'function') throw new Error('no-decoder');
      if (Number.isFinite(ctx.sampleRate) && ctx.sampleRate > 0 && ctx.sampleRate <= 192000) {
        const length = Math.ceil(wav.durationMs / 1000 * ctx.sampleRate);
        const frames = Math.ceil(wav.durationMs / 1000 * targetRate);
        const estimate = estimatedBytes(file.size, length, wav.channels, frames);
        if (!Number.isSafeInteger(estimate) || estimate > maxWorkingBytes) throw new Error('too-much-memory');
      }
    }
    const bytes = await file.arrayBuffer();
    checkCancelled();
    if (!bytes || !Number.isSafeInteger(bytes.byteLength) || bytes.byteLength > maxBytes) throw new Error('too-big');
    const encodedBytes = bytes.byteLength; // decodeAudioData может отсоединить ArrayBuffer
    if (!ctx) ctx = createContext();
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
    // Учитываем известные большие буферы, но не внутренние копии кодека,
    // движок STT, прочую память процесса или физически доступную память.
    const estimate = estimatedBytes(encodedBytes, length, decoded.numberOfChannels, frames);
    if (!Number.isSafeInteger(frames) || !Number.isSafeInteger(estimate) || estimate > maxWorkingBytes) throw new Error('too-much-memory');
    const off = createOffline(1, frames, targetRate);
    if (!off) throw new Error('no-decoder');
    const mono = decoded.numberOfChannels === 1 ? decoded : mixToMono(decoded, (ch, len, rate) =>
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
