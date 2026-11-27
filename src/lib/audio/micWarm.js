import { micConstraints } from './micConstraints.js';

/**
 * «Горячий микрофон»: поток открыт заранее, звук лежит в кольцевом буфере.
 *
 * Зачем: getUserMedia открывает устройство 150–300 мс, и слово, сказанное сразу
 * после хоткея, терялось. Здесь эти миллисекунды уже записаны и уходят в
 * распознавание вместе с записью.
 *
 * Пока настройка включена, микрофон может быть открыт всё
 * время работы приложения — это видно по индикатору системы и расходует батарею.
 */

import { createRingBuffer } from './ringBuffer.js';
import { createAudioContext } from './context.js';

const pickAudioContext = () =>
  (typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext)) || null;

/**
 * @param {object} opts
 * @param {string} opts.deviceId   id микрофона ('default' — системный)
 * @param {number} opts.prerollMs  сколько последних миллисекунд отдавать
 * @param {()=>void} [opts.onInterrupted] предролл остановлен после завершения дорожки
 */
export function createMicWarm({ deviceId = 'default', prerollMs = 600, cleanupAudio = false, onInterrupted } = {}) {
  // Каждое открытие владеет только своими ресурсами: поздний getUserMedia
  // не должен оживить закрытую настройку или закрыть более новый поток.
  let generation = 0;
  let active = null;
  let pending = null;
  const cancelled = () => Object.assign(new Error('Открытие микрофона отменено'), { name: 'AbortError' });

  function cleanup(resource) {
    if (!resource || resource.cleaned) return;
    resource.cleaned = true;
    for (const track of resource.tracks || []) {
      try { track.removeEventListener?.('ended', resource.onEnded); } catch { /* освободить остальные ресурсы */ }
    }
    for (const node of [resource.processor, resource.source, resource.silent]) {
      try { node?.disconnect(); } catch { /* освободить остальные узлы */ }
    }
    try {
      for (const track of resource.stream?.getTracks?.() || []) {
        try { track.stop(); } catch { /* освободить остальные дорожки */ }
      }
    } catch { /* поток уже закрыт */ }
    try { Promise.resolve(resource.ctx?.close?.()).catch(() => {}); } catch { /* контекст уже закрыт */ }
    resource.ring = null;
  }

  function interrupt(resource) {
    if (active !== resource || resource.cleaned) return;
    active = null;
    cleanup(resource);
    onInterrupted?.();
  }
  const hasEnded = (resource) => resource.tracks.some((track) => track.readyState === 'ended');

  function open() {
    if (active) {
      if (hasEnded(active)) {
        interrupt(active);
        return Promise.reject(new Error('Аудиодорожка микрофона завершилась'));
      }
      return Promise.resolve(true);
    }
    if (pending) return pending.promise;
    const Ctx = pickAudioContext();
    if (!Ctx || !navigator.mediaDevices?.getUserMedia) {
      return Promise.reject(new Error('Микрофон недоступен в этом окружении'));
    }
    const op = { generation, promise: null };
    pending = op;
    const stale = () => op.generation !== generation;
    op.promise = (async () => {
      const resource = { stream: null, ctx: null, source: null, processor: null, silent: null, ring: null, tracks: [], onEnded: null, cleaned: false };
      try {
        try {
          resource.stream = await navigator.mediaDevices.getUserMedia(micConstraints({ deviceId, cleanup: cleanupAudio }));
        } catch (err) {
          if (stale()) throw cancelled();
          const missing = deviceId && deviceId !== 'default' &&
            ['OverconstrainedError', 'NotFoundError', 'DevicesNotFoundError'].includes(err?.name);
          if (!missing) throw err;
          resource.stream = await navigator.mediaDevices.getUserMedia(micConstraints({ cleanup: cleanupAudio }));
        }
        if (stale()) throw cancelled();
        resource.tracks = (resource.stream?.getTracks?.() || []).filter((track) => track && (!track.kind || track.kind === 'audio'));
        if (!resource.tracks.length || hasEnded(resource)) throw new Error('Микрофон не передал живую аудиодорожку');
        resource.ctx = createAudioContext(Ctx).ctx;
        if (!resource.ctx) throw new Error('Микрофон недоступен в этом окружении');
        resource.sampleRate = resource.ctx.sampleRate || 48000;
        resource.ring = createRingBuffer(Math.round((resource.sampleRate * Math.max(200, prerollMs)) / 1000));
        resource.source = resource.ctx.createMediaStreamSource(resource.stream);
        resource.processor = resource.ctx.createScriptProcessor(1024, 1, 1);
        resource.processor.onaudioprocess = (event) => {
          if (active !== resource || resource.cleaned) return;
          try { resource.ring.push(event.inputBuffer.getChannelData(0)); } catch { /* граф может закрыться */ }
        };
        resource.silent = resource.ctx.createGain();
        resource.silent.gain.value = 0;
        resource.source.connect(resource.processor);
        resource.processor.connect(resource.silent);
        resource.silent.connect(resource.ctx.destination);
        active = resource;
        resource.onEnded = () => interrupt(resource);
        for (const track of resource.tracks) {
          if (resource.cleaned) break;
          track.addEventListener?.('ended', resource.onEnded);
        }
        // Событие могло закончиться между получением потока и подпиской.
        if (hasEnded(resource)) interrupt(resource);
        if (resource.cleaned) throw new Error('Аудиодорожка микрофона завершилась');
        return true;
      } catch (err) {
        if (active === resource) active = null;
        cleanup(resource);
        // Включая отказ второго getUserMedia после отмены.
        if (stale()) throw cancelled();
        throw err;
      }
    })().finally(() => {
      if (pending === op) pending = null;
    });
    return op.promise;
  }

  return {
    get opened() { return Boolean(active); },
    open,
    /** Забрать накопленный предролл (один раз на запись). */
    take() {
      const resource = active;
      if (!resource?.ring) return null;
      if (hasEnded(resource)) { interrupt(resource); return null; }
      const count = Math.round((resource.sampleRate * prerollMs) / 1000);
      const samples = resource.ring.tail(count);
      resource.ring.clear();
      if (!samples.length) return null;
      return { samples, sampleRate: resource.sampleRate };
    },
    close() {
      generation += 1;
      pending = null;
      const resource = active;
      active = null;
      cleanup(resource);
    },
  };
}

export default createMicWarm;
