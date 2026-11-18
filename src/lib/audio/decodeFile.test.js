import { describe, expect, it } from 'vitest';
import { decodeAudioFile, floatToInt16, mixToMono } from './decodeFile.js';

function fakeFile(bytes = [1, 2, 3]) {
  return {
    name: 'запись.wav',
    arrayBuffer: async () => Uint8Array.from(bytes).buffer,
  };
}

/** Двухканальный буфер 44,1 кГц на четверть секунды. */
function fakeDecoded({ channels = 2, length = 4410, rate = 44100 } = {}) {
  const data = Array.from({ length: channels }, (_, ch) =>
    Float32Array.from({ length }, (_, i) => (ch === 0 ? 0.5 : -0.5) + (i % 2) * 0.001),
  );
  return {
    numberOfChannels: channels,
    length,
    sampleRate: rate,
    duration: length / rate,
    getChannelData: (ch) => data[ch],
  };
}

function makeContext({ decoded = fakeDecoded(), fail = false } = {}) {
  const ctx = {
    closed: false,
    decodeAudioData: async () => {
      if (fail) throw new Error('EncodingError');
      return decoded;
    },
    createBuffer: (ch, len, rate) => ({
      numberOfChannels: ch,
      length: len,
      sampleRate: rate,
      getChannelData: () => new Float32Array(len),
    }),
    close: async () => {
      ctx.closed = true;
    },
  };
  return ctx;
}

function makeOffline() {
  return {
    createBufferSource: () => ({ buffer: null, connect() {}, start() {} }),
    destination: {},
    startRendering: async () => ({
      sampleRate: 16000,
      getChannelData: () => Float32Array.from({ length: 4000 }, (_, i) => (i % 3 === 0 ? 0.25 : -0.25)),
    }),
  };
}

describe('decodeAudioFile', () => {
  it('отдаёт 16-битный звук и длительность по готовому звуку', async () => {
    const ctx = makeContext();
    const res = await decodeAudioFile(fakeFile(), { createContext: () => ctx, createOffline: makeOffline });
    expect(res.sampleRate).toBe(16000);
    expect(res.pcm).toBeInstanceOf(Int16Array);
    expect(res.pcm.length).toBe(4000);
    expect(res.pcm[0]).toBe(Math.round(0.25 * 0x7fff));
    expect(res.durationMs).toBe(250);
    // контекст закрывается: иначе Chromium держит звуковое устройство
    expect(ctx.closed).toBe(true);
  });

  it('битый файл — понятная ошибка decode, а не исключение кодека', async () => {
    const ctx = makeContext({ fail: true });
    await expect(
      decodeAudioFile(fakeFile(), { createContext: () => ctx, createOffline: makeOffline }),
    ).rejects.toThrow('decode');
    expect(ctx.closed).toBe(true);
  });

  it('без браузерного декодера — отказ no-decoder', async () => {
    await expect(
      decodeAudioFile(fakeFile(), { createContext: () => null, createOffline: makeOffline }),
    ).rejects.toThrow('no-decoder');
  });

  it('файл без arrayBuffer — отказ no-file', async () => {
    await expect(decodeAudioFile({ name: 'x' }, { createContext: makeContext })).rejects.toThrow('no-file');
  });
});

describe('floatToInt16 / mixToMono', () => {
  it('перегрузка обрезается, а не заворачивается в треск', () => {
    const pcm = floatToInt16(Float32Array.from([2, -2, 0]));
    expect(pcm[0]).toBe(0x7fff);
    expect(pcm[1]).toBe(-0x8000);
    expect(pcm[2]).toBe(0);
  });

  it('каналы смешиваются в моно', () => {
    const buffer = fakeDecoded({ channels: 2, length: 4 });
    const mono = mixToMono(buffer, (ch, len, rate) => ({
      sampleRate: rate,
      getChannelData: () => new Float32Array(len),
    }));
    const data = mono.getChannelData(0);
    expect(data.length).toBe(4);
    // 0,5 и -0,5 в среднем дают ноль (плюс микроскопическая разница от i % 2 в обоих каналах)
    expect(Math.abs(data[0])).toBeLessThan(1e-6);
  });
});
