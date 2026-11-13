/**
 * «Горячий микрофон»: поток открыт заранее, звук лежит в кольцевом буфере.
 *
 * Зачем: getUserMedia открывает устройство 150–300 мс, и слово, сказанное сразу
 * после хоткея, терялось. Здесь эти миллисекунды уже записаны и уходят в
 * распознавание вместе с записью.
 *
 * Настройка выключена по умолчанию: пока она включена, микрофон открыт всё
 * время работы приложения — это видно по индикатору системы и расходует батарею.
 */

import { createRingBuffer } from './ringBuffer.js';

const pickAudioContext = () =>
  (typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext)) || null;

/**
 * @param {object} opts
 * @param {string} opts.deviceId   id микрофона ('default' — системный)
 * @param {number} opts.prerollMs  сколько последних миллисекунд отдавать
 */
export function createMicWarm({ deviceId = 'default', prerollMs = 600 } = {}) {
  let stream = null;
  let ctx = null;
  let source = null;
  let processor = null;
  let silent = null;
  let ring = null;
  let sampleRate = 48000;
  let started = false;

  const cleanup = () => {
    try {
      processor?.disconnect();
      source?.disconnect();
      silent?.disconnect();
    } catch {
      /* ignore */
    }
    try {
      stream?.getTracks?.().forEach((t) => t.stop());
    } catch {
      /* ignore */
    }
    try {
      ctx?.close?.().catch(() => {});
    } catch {
      /* ignore */
    }
    stream = null;
    ctx = null;
    source = null;
    processor = null;
    silent = null;
    started = false;
  };

  return {
    get opened() {
      return started;
    },
    /** Открыть микрофон и начать копить последние prerollMs. */
    async open() {
      if (started) return true;
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
      let media;
      try {
        media = await navigator.mediaDevices.getUserMedia(constraints);
      } catch (err) {
        // выбранный микрофон пропал — пробуем системный, как и в самой записи
        const missing =
          deviceId &&
          deviceId !== 'default' &&
          ['OverconstrainedError', 'NotFoundError', 'DevicesNotFoundError'].includes(err?.name);
        if (!missing) throw err;
        media = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
        });
      }
      stream = media;
      ctx = new Ctx();
      sampleRate = ctx.sampleRate || 48000;
      ring = createRingBuffer(Math.round((sampleRate * Math.max(200, prerollMs)) / 1000));
      source = ctx.createMediaStreamSource(stream);
      processor = ctx.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (event) => {
        try {
          ring.push(event.inputBuffer.getChannelData(0));
        } catch {
          /* ignore */
        }
      };
      silent = ctx.createGain();
      silent.gain.value = 0;
      source.connect(processor);
      processor.connect(silent);
      silent.connect(ctx.destination);
      started = true;
      return true;
    },
    /** Забрать накопленный предролл (один раз на запись). */
    take() {
      if (!started || !ring) return null;
      const count = Math.round((sampleRate * prerollMs) / 1000);
      const samples = ring.tail(count);
      ring.clear();
      if (!samples.length) return null;
      return { samples, sampleRate };
    },
    close() {
      cleanup();
      ring = null;
    },
  };
}

export default createMicWarm;
