/**
 * Запись микрофона в PCM 16 кГц моно — тот формат, который ждёт whisper.cpp.
 *
 * Работает в Electron и в браузере: getUserMedia → AudioContext → Int16.
 * Уровень сигнала считаем тут же (RMS), чтобы HUD пульсировал без опроса main.
 */

const TARGET_RATE = 16000;

function pickAudioContext() {
  const Ctx = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
  return Ctx || null;
}

/** Простой ресемплер: линейная интерполяция из одной частоты в другую. */
function resampleLinear(float32, inputRate, outputRate) {
  if (inputRate === outputRate || !float32?.length) return float32;
  const ratio = inputRate / outputRate;
  const length = Math.floor(float32.length / ratio);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(float32.length - 1, i0 + 1);
    const frac = pos - i0;
    out[i] = float32[i0] * (1 - frac) + float32[i1] * frac;
  }
  return out;
}

/** Простой ресемплер: линейная интерполяция к 16 кГц. */
function resampleTo16k(float32, inputRate) {
  if (inputRate === TARGET_RATE) return float32;
  const ratio = inputRate / TARGET_RATE;
  const length = Math.floor(float32.length / ratio);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(float32.length - 1, i0 + 1);
    const frac = pos - i0;
    out[i] = float32[i0] * (1 - frac) + float32[i1] * frac;
  }
  return out;
}

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
export async function startPcmRecording({ deviceId = 'default', onLevel, preroll = null } = {}) {
  const Ctx = pickAudioContext();
  if (!Ctx || !navigator.mediaDevices?.getUserMedia) {
    throw new Error('Микрофон недоступен в этом окружении');
  }

  const constraints = {
    audio:
      deviceId && deviceId !== 'default'
        ? { deviceId: { exact: deviceId }, channelCount: 1, echoCancellation: true, noiseSuppression: true }
        : { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  };

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
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    fellBack = true;
  }
  const ctx = new Ctx();
  // некоторые системы не дают 16 кГц — тогда пишем в родной частоте и ресемплим
  const source = ctx.createMediaStreamSource(stream);
  const processor = ctx.createScriptProcessor(4096, 1, 1);

  const chunks = [];
  let frames = 0;
  let aborted = false;
  let smoothLevel = 0;

  // Предролл: первые сотни миллисекунд уже записаны до старта — кладём их
  // первыми, иначе начало фразы пропадает на открытии устройства.
  if (preroll?.samples?.length) {
    const prepared = resampleLinear(preroll.samples, preroll.sampleRate || ctx.sampleRate, ctx.sampleRate);
    if (prepared.length) {
      chunks.push(prepared);
      frames += prepared.length;
    }
  }

  processor.onaudioprocess = (event) => {
    if (aborted) return;
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

  return {
    /** true, если запись идёт не с выбранного микрофона, а с системного */
    fellBack,
    get sampleRate() {
      return ctx.sampleRate;
    },
    get frames() {
      return frames;
    },
    stop() {
      cleanup();
      const merged = new Float32Array(frames);
      let offset = 0;
      for (const c of chunks) {
        merged.set(c, offset);
        offset += c.length;
      }
      const pcm = toInt16(resampleTo16k(merged, ctx.sampleRate));
      return { pcm, sampleRate: TARGET_RATE, durationMs: Math.round((frames / ctx.sampleRate) * 1000) };
    },
    abort() {
      aborted = true;
      cleanup();
    },
  };
}

export default startPcmRecording;
