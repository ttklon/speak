/**
 * Запись микрофона в PCM 16 кГц моно — тот формат, который ждёт whisper.cpp.
 *
 * Работает в Electron и в браузере: getUserMedia → AudioContext → Int16.
 * Уровень сигнала считаем тут же (RMS), чтобы HUD пульсировал без опроса main.
 */

import { TARGET_RATE, createAudioContext, resampleAudio } from './context.js';
import { micConstraints } from './micConstraints.js';

const pickAudioContext = () =>
  (typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext)) || null;

function toInt16(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i += 1) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/**
 * @param {object} opts
 * @param {string} opts.deviceId  id микрофона ('default' — системный)
 * @param {(level:number)=>void} opts.onLevel
 * @param {{samples: Float32Array, sampleRate: number}} [opts.preroll]
 *   звук, записанный «горячим микрофоном» до нажатия хоткея
 */
export async function startPcmRecording({ deviceId = 'default', onLevel, preroll = null, cleanupAudio = false } = {}) {
  const Ctx = pickAudioContext();
  if (!Ctx || !navigator.mediaDevices?.getUserMedia) {
    throw new Error('Микрофон недоступен в этом окружении');
  }

  const constraints = micConstraints({ deviceId, cleanup: cleanupAudio });

  // Микрофон из настроек мог исчезнуть (наушники отключили, USB выдернули).
  // Тогда getUserMedia падает с OverconstrainedError, и диктовка «не работает»
  // без объяснений. Пишем с системного и говорим об этом человеку.
  let stream;
  let fellBack = false;
  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    const missingDevice =
      deviceId &&
      deviceId !== 'default' &&
      ['OverconstrainedError', 'NotFoundError', 'DevicesNotFoundError'].includes(err?.name);
    if (!missingDevice) throw err;
    stream = await navigator.mediaDevices.getUserMedia(micConstraints({ cleanup: cleanupAudio }));
    fellBack = true;
  }
  // Просим 16 кГц сразу: тогда ресемплинг делает движок с фильтром. Если
  // система не даёт — пишем в родной частоте и ресемплим сами (с low-pass).
  const { ctx, native } = createAudioContext(Ctx);
  if (!ctx) throw new Error('Микрофон недоступен в этом окружении');
  const source = ctx.createMediaStreamSource(stream);
  // Окно 1024 отсчёта: при 16 кГц это 64 мс. Раньше стояло 4096, и на 16 кГц
  // это 256 мс — столько звука в конце фразы могло не дойти до движка (буфер,
  // не набравшийся к отпусканию клавиши, терялся), а в начале — уйти на разгон.
  const processor = ctx.createScriptProcessor(1024, 1, 1);

  const chunks = [];
  let frames = 0;
  let aborted = false;
  // Пауза: микрофон остаётся открытым, но звук не копится. Так человек может
  // собраться с мыслью, не начиная диктовку заново.
  let paused = false;
  let smoothLevel = 0;

  // Предролл: первые сотни миллисекунд уже записаны до старта — кладём их
  // первыми, иначе начало фразы пропадает на открытии устройства.
  if (preroll?.samples?.length) {
    const prepared = resampleAudio(preroll.samples, preroll.sampleRate || ctx.sampleRate, ctx.sampleRate);
    if (prepared.length) {
      chunks.push(prepared);
      frames += prepared.length;
    }
  }

  processor.onaudioprocess = (event) => {
    if (aborted) return;
    if (paused) {
      if (smoothLevel !== 0) {
        smoothLevel = 0;
        onLevel?.(0);
      }
      return;
    }
    const input = event.inputBuffer.getChannelData(0);
    const copy = new Float32Array(input.length);
    copy.set(input);
    chunks.push(copy);
    frames += copy.length;

    let sum = 0;
    for (let i = 0; i < copy.length; i += 1) sum += copy[i] * copy[i];
    const rms = Math.sqrt(sum / copy.length);
    smoothLevel = smoothLevel * 0.7 + Math.min(1, rms * 4) * 0.3;
    onLevel?.(smoothLevel);
  };

  // ScriptProcessor требует подключения к destination, иначе не вызывается
  const silent = ctx.createGain();
  silent.gain.value = 0;
  source.connect(processor);
  processor.connect(silent);
  silent.connect(ctx.destination);

  const cleanup = () => {
    try {
      processor.disconnect();
      source.disconnect();
      silent.disconnect();
    } catch {
      /* ignore */
    }
    stream.getTracks().forEach((t) => t.stop());
    ctx.close().catch(() => {});
  };

  // Склеивает уже записанное в PCM 16 кГц — для промежуточной расшифровки,
  // не останавливая микрофон. Хвост длиннее maxSeconds отбрасываем: whisper
  // на минуте речи работает заметно дольше, чем длится сама диктовка.
  const snapshot = ({ maxSeconds = 30, fromMs = 0, toMs = 0 } = {}) => {
    let from = 0;
    let count = frames;
    // Кусок записи [fromMs, toMs): им пользуется «считать, пока говорите» —
    // уже сказанное уходит в движок, не останавливая микрофон.
    if (fromMs > 0 || toMs > 0) {
      from = Math.min(frames, Math.max(0, Math.floor((Number(fromMs) / 1000) * ctx.sampleRate)));
      const end = toMs > 0 ? Math.min(frames, Math.ceil((Number(toMs) / 1000) * ctx.sampleRate)) : frames;
      count = Math.max(0, end - from);
    }
    const limit = Math.floor(maxSeconds * ctx.sampleRate);
    if (limit > 0 && count > limit) {
      // Ограничение длины действует только на «всю запись». Явно заданный
      // кусок режется по своим границам: сдвиг молча потерял бы начало.
      if (!(fromMs > 0 || toMs > 0)) from = frames - limit;
      count = limit;
    }
    const part = new Float32Array(count);
    let offset = 0;
    let start = 0;
    for (const c of chunks) {
      const end = start + c.length;
      // окно [from, from+count) может начинаться внутри чанка
      const a = Math.max(start, from);
      const b = Math.min(end, from + count);
      if (b > a) {
        part.set(c.subarray(a - start, b - start), offset);
        offset += b - a;
      }
      start = end;
      if (start >= from + count) break;
    }
    return {
      pcm: toInt16(resampleAudio(part, ctx.sampleRate, TARGET_RATE)),
      durationMs: Math.round((count / ctx.sampleRate) * 1000),
      truncated: from > 0,
    };
  };

  return {
    /** true, если запись идёт не с выбранного микрофона, а с системного */
    fellBack,
    /** частота исходной записи и признак «писали сразу в 16 кГц» */
    captureRate: ctx.sampleRate,
    nativeRate: native,
    /** накопленный звук без остановки записи (для живой расшифровки) */
    snapshot,
    get sampleRate() {
      return ctx.sampleRate;
    },
    get frames() {
      return frames;
    },
    get paused() {
      return paused;
    },
    /** Приостановить накопление звука (микрофон не закрывается). */
    pause() {
      paused = true;
      smoothLevel = 0;
      onLevel?.(0);
    },
    /** Продолжить запись после паузы. */
    resume() {
      paused = false;
    },
    stop() {
      cleanup();
      const merged = new Float32Array(frames);
      let offset = 0;
      for (const c of chunks) {
        merged.set(c, offset);
        offset += c.length;
      }
      const pcm = toInt16(resampleAudio(merged, ctx.sampleRate, TARGET_RATE));
      return {
        pcm,
        sampleRate: TARGET_RATE,
        durationMs: Math.round((frames / ctx.sampleRate) * 1000),
        // для диагностики: писали сразу в 16 кГц (native) или ресемплили сами
        captureRate: ctx.sampleRate,
        nativeRate: native,
      };
    },
    abort() {
      aborted = true;
      cleanup();
    },
  };
}

export default startPcmRecording;
