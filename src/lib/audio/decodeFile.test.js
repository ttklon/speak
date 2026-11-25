import { describe, expect, it, vi } from 'vitest';
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

  it('отклоняет большой файл до чтения, а не после выделения буфера', async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(10));
    await expect(decodeAudioFile({ size: 11, arrayBuffer }, { maxBytes: 10 })).rejects.toThrow('too-big');
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('слишком длинный декодированный звук отказывает до создания моно и offline-буферов', async () => {
    const decoded = { length: 16000 * 7201, sampleRate: 16000, duration: 7201, numberOfChannels: 2, getChannelData: vi.fn() };
    const ctx = makeContext({ decoded }); ctx.createBuffer = vi.fn(ctx.createBuffer);
    const createOffline = vi.fn(makeOffline);
    await expect(decodeAudioFile(fakeFile(), { createContext: () => ctx, createOffline })).rejects.toThrow('too-long');
    expect(createOffline).not.toHaveBeenCalled(); expect(ctx.createBuffer).not.toHaveBeenCalled();
    expect(ctx.closed).toBe(true);
  });

  it('принимает точный предел длительности и отклоняет превышение даже на один сэмпл', async () => {
    const render = () => ({ ...makeOffline(), startRendering: async () => ({ sampleRate: 16000, getChannelData: () => new Float32Array(1600) }) });
    const exact = makeContext({ decoded: fakeDecoded({ length: 4410, rate: 44100 }) });
    await expect(decodeAudioFile(fakeFile(), { createContext: () => exact, createOffline: render, maxDurationMs: 100 })).resolves.toMatchObject({ durationMs: 100 });
    const over = makeContext({ decoded: fakeDecoded({ length: 4411, rate: 44100 }) });
    const offline = vi.fn(render);
    await expect(decodeAudioFile(fakeFile(), { createContext: () => over, createOffline: offline, maxDurationMs: 100 })).rejects.toThrow('too-long');
    expect(offline).not.toHaveBeenCalled(); expect(over.closed).toBe(true);
  });

  it('отклоняет неверные параметры декодированного буфера до выделения', async () => {
    const decoded = { length: Infinity, sampleRate: 16000, duration: 1, numberOfChannels: 1 };
    const ctx = makeContext({ decoded }); const offline = vi.fn(makeOffline);
    await expect(decodeAudioFile(fakeFile(), { createContext: () => ctx, createOffline: offline })).rejects.toThrow('decode');
    expect(offline).not.toHaveBeenCalled(); expect(ctx.closed).toBe(true);
  });

  it('проверяет длину по числу сэмплов, даже если поле длительности занижено', async () => {
    const decoded = { length: 16000 * 7201, sampleRate: 16000, duration: 1, numberOfChannels: 1, getChannelData: vi.fn() };
    const ctx = makeContext({ decoded }); const offline = vi.fn(makeOffline);
    await expect(decodeAudioFile(fakeFile(), { createContext: () => ctx, createOffline: offline })).rejects.toThrow('too-long');
    expect(offline).not.toHaveBeenCalled(); expect(ctx.closed).toBe(true);
  });

  it('закрывает контекст при недоступном offline-декодере и отказе рендеринга', async () => {
    const first = makeContext();
    await expect(decodeAudioFile(fakeFile(), { createContext: () => first, createOffline: () => null })).rejects.toThrow('no-decoder');
    expect(first.closed).toBe(true);
    const second = makeContext();
    await expect(decodeAudioFile(fakeFile(), { createContext: () => second, createOffline: () => ({ ...makeOffline(), startRendering: async () => { throw new Error('render'); } }) })).rejects.toThrow('render');
    expect(second.closed).toBe(true);
  });

  it('после отмены во время декодирования не создаёт большие буферы и закрывает контекст', async () => {
    const ctx = makeContext(); let finish;
    ctx.decodeAudioData = () => new Promise((resolve) => { finish = resolve; });
    const offline = vi.fn(makeOffline); let cancelled = false;
    const pending = decodeAudioFile(fakeFile(), { createContext: () => ctx, createOffline: offline, isCancelled: () => cancelled });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    cancelled = true; finish(fakeDecoded());
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(offline).not.toHaveBeenCalled(); expect(ctx.closed).toBe(true);
  });

  it('отменённый до чтения файл не выделяет буфер и не открывает устройство', async () => {
    const file = { arrayBuffer: vi.fn(async () => new ArrayBuffer(0)) };
    const createContext = vi.fn(makeContext);
    await expect(decodeAudioFile(file, { createContext, isCancelled: () => true })).rejects.toMatchObject({ name: 'AbortError' });
    expect(file.arrayBuffer).not.toHaveBeenCalled(); expect(createContext).not.toHaveBeenCalled();
  });

  it('проверяет фактические байты, если объявленный размер файла неверен', async () => {
    const file = { size: 3, arrayBuffer: vi.fn(async () => new ArrayBuffer(11)) };
    const createContext = vi.fn(makeContext);
    await expect(decodeAudioFile(file, { maxBytes: 10, createContext })).rejects.toThrow('too-big');
    expect(createContext).not.toHaveBeenCalled();
  });

  it('рассчитывает размер offline-буфера по реальным сэмплам, а не заниженной длительности', async () => {
    const decoded = fakeDecoded(); decoded.duration = 0.001;
    const ctx = makeContext({ decoded }); const offline = vi.fn(makeOffline);
    await decodeAudioFile(fakeFile(), { createContext: () => ctx, createOffline: offline });
    expect(offline).toHaveBeenCalledWith(1, 1600, 16000);
  });

  it('после отмены во время offline-рендеринга не создаёт Int16 PCM', async () => {
    const ctx = makeContext(); let finish; let cancelled = false;
    const output = { sampleRate: 16000, getChannelData: vi.fn(() => new Float32Array(1)) };
    const createOffline = () => ({ ...makeOffline(), startRendering: () => new Promise((resolve) => { finish = resolve; }) });
    const pending = decodeAudioFile(fakeFile(), { createContext: () => ctx, createOffline, isCancelled: () => cancelled });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    cancelled = true; finish(output);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(output.getChannelData).not.toHaveBeenCalled(); expect(ctx.closed).toBe(true);
  });

  it('ошибка закрытия аудиоконтекста не скрывает исходный отказ', async () => {
    const ctx = makeContext({ fail: true }); ctx.close = vi.fn(() => Promise.reject(new Error('close failed')));
    await expect(decodeAudioFile(fakeFile(), { createContext: () => ctx, createOffline: makeOffline })).rejects.toThrow('decode');
    expect(ctx.close).toHaveBeenCalledOnce();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('пустой декодированный файл не создаёт искусственный сэмпл', async () => {
    const ctx = makeContext({ decoded: { length: 0, sampleRate: 16000, duration: 0, numberOfChannels: 1, getChannelData: () => new Float32Array(0) } });
    const offline = vi.fn(makeOffline);
    const result = await decodeAudioFile(fakeFile(), { createContext: () => ctx, createOffline: offline });
    expect(result.pcm.length).toBe(0); expect(result.durationMs).toBe(0);
    expect(offline).not.toHaveBeenCalled(); expect(ctx.closed).toBe(true);
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
