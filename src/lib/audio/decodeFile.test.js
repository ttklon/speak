import { describe, expect, it, vi } from 'vitest';
import { decodeAudioFile, floatToInt16, mixToMono, pcmWavDurationMs } from './decodeFile.js';

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

// Заголовок отдельный: имитируем большой файл, не выделяя мегабайты в тесте.
function wavHeader({ seconds = 1, rate = 16000, channels = 1, bits = 16, format = 1, trailing = 0 } = {}) {
  const align = channels * bits / 8;
  const bytes = seconds * rate * align;
  const header = new Uint8Array(44);
  const v = new DataView(header.buffer);
  const tag = (offset, text) => [...text].forEach((c, i) => { header[offset + i] = c.charCodeAt(0); });
  tag(0, 'RIFF'); v.setUint32(4, 36 + bytes + trailing, true); tag(8, 'WAVE'); tag(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, format, true); v.setUint16(22, channels, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * align, true); v.setUint16(32, align, true);
  v.setUint16(34, bits, true); tag(36, 'data'); v.setUint32(40, bytes, true);
  return { header, size: 44 + bytes + trailing };
}

describe('ограниченный заголовок WAV', () => {
  it('читает только достоверно согласованный формат и игнорирует неподдерживаемые данные', () => {
    const good = wavHeader({ seconds: 7200, channels: 2, rate: 8000 });
    expect(pcmWavDurationMs(good.header.buffer, good.size)).toBe(7_200_000);
    expect(pcmWavDurationMs(good.header.buffer, good.size - 1)).toBeNull();
    expect(pcmWavDurationMs(new ArrayBuffer(5), 5)).toBeNull();
    new DataView(good.header.buffer).setUint16(32, 1, true); // некорректный block align
    expect(pcmWavDurationMs(good.header.buffer, good.size)).toBeNull();
  });
  it('понимает нечётный дополнительный chunk с паддингом', () => {
    const { header, size } = wavHeader({ seconds: 1 });
    const extra = new Uint8Array(54); extra.set(header.subarray(0, 12));
    extra.set([74, 85, 78, 75, 1, 0, 0, 0, 42, 0], 12); extra.set(header.subarray(12), 22);
    new DataView(extra.buffer).setUint32(4, size + 2, true);
    expect(pcmWavDurationMs(extra.buffer, size + 10)).toBe(1000);
  });
});

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

  it('проверяет длительность обычного WAV по ограниченному заголовку до полного чтения и декодирования', async () => {
    const { header, size } = wavHeader({ seconds: 7201 });
    const read = vi.fn(async () => new ArrayBuffer(0));
    const slice = vi.fn(() => ({ arrayBuffer: async () => header.buffer }));
    const ctx = vi.fn(makeContext);
    await expect(decodeAudioFile({ size, slice, arrayBuffer: read }, { createContext: ctx })).rejects.toThrow('too-long');
    expect(slice).toHaveBeenCalledWith(0, Math.min(size, 65536));
    expect(read).not.toHaveBeenCalled(); expect(ctx).not.toHaveBeenCalled();
  });

  it('обычный WAV с большой оценкой буферов отклоняется до полного чтения и decodeAudioData', async () => {
    const { header, size } = wavHeader({ seconds: 1200, rate: 16000, channels: 2 });
    const file = { size, slice: () => ({ arrayBuffer: async () => header.buffer }), arrayBuffer: vi.fn(async () => new ArrayBuffer(1)) };
    const ctx = makeContext(); ctx.sampleRate = 48000; ctx.decodeAudioData = vi.fn(ctx.decodeAudioData);
    await expect(decodeAudioFile(file, { createContext: () => ctx })).rejects.toThrow('too-much-memory');
    expect(file.arrayBuffer).not.toHaveBeenCalled(); expect(ctx.decodeAudioData).not.toHaveBeenCalled(); expect(ctx.closed).toBe(true);
  });

  it('закрывает заранее созданный контекст при ошибке полного чтения WAV', async () => {
    const { header, size } = wavHeader({ seconds: 1 });
    const file = { size, slice: () => ({ arrayBuffer: async () => header.buffer }), arrayBuffer: async () => { throw new Error('disk error'); } };
    const ctx = makeContext(); ctx.sampleRate = 48000; ctx.decodeAudioData = vi.fn(ctx.decodeAudioData);
    await expect(decodeAudioFile(file, { createContext: () => ctx })).rejects.toThrow('disk error');
    expect(ctx.closed).toBe(true); expect(ctx.decodeAudioData).not.toHaveBeenCalled();
  });

  it('не доверяет неизвестному формату WAV или обрезанным данным и оставляет решение декодеру', async () => {
    for (const type of ['unsupported', 'truncated']) {
      const { header, size } = wavHeader({ seconds: 7201, format: type === 'unsupported' ? 6 : 1 });
      const file = { size: type === 'truncated' ? size - 1 : size,
        slice: () => ({ arrayBuffer: async () => header.buffer }), arrayBuffer: vi.fn(async () => new ArrayBuffer(3)) };
      const ctx = makeContext({ fail: true });
      await expect(decodeAudioFile(file, { createContext: () => ctx })).rejects.toThrow('decode');
      expect(file.arrayBuffer).toHaveBeenCalledOnce();
    }
  });

  it('отмена во время чтения заголовка не вызывает полное чтение и декодер', async () => {
    let finish; let cancelled = false;
    const file = { size: 1000, slice: () => ({ arrayBuffer: () => new Promise((resolve) => { finish = resolve; }) }),
      arrayBuffer: vi.fn(async () => new ArrayBuffer(0)) };
    const ctx = vi.fn(makeContext);
    const pending = decodeAudioFile(file, { createContext: ctx, isCancelled: () => cancelled });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    cancelled = true; finish(new ArrayBuffer(0));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(file.arrayBuffer).not.toHaveBeenCalled(); expect(ctx).not.toHaveBeenCalled();
  });

  it('отклоняет расчётный объём звука до дополнительных моно и offline буферов', async () => {
    const decoded = { length: 1_000_000, sampleRate: 48000, duration: 1_000_000 / 48000,
      numberOfChannels: 2, getChannelData: vi.fn() };
    const ctx = makeContext({ decoded }); ctx.createBuffer = vi.fn(ctx.createBuffer);
    const offline = vi.fn(makeOffline);
    await expect(decodeAudioFile(fakeFile(), { createContext: () => ctx, createOffline: offline, maxWorkingBytes: 9_000_000 })).rejects.toThrow('too-much-memory');
    expect(ctx.createBuffer).not.toHaveBeenCalled(); expect(offline).not.toHaveBeenCalled(); expect(ctx.closed).toBe(true);
  });

  it('оценочный лимит буферов принимает границу и отклоняет превышение на байт', async () => {
    const exact = 3 + 4410 * 2 * 4 + 4410 * 4 + 1600 * 6;
    const ctx = makeContext();
    await expect(decodeAudioFile(fakeFile(), { createContext: () => ctx, createOffline: makeOffline, maxWorkingBytes: exact })).resolves.toMatchObject({ sampleRate: 16000 });
    const second = makeContext(); const offline = vi.fn(makeOffline);
    await expect(decodeAudioFile(fakeFile(), { createContext: () => second, createOffline: offline, maxWorkingBytes: exact - 1 })).rejects.toThrow('too-much-memory');
    expect(offline).not.toHaveBeenCalled(); expect(second.closed).toBe(true);
  });

  it('использует моно буфер напрямую вместо дополнительной копии', async () => {
    const decoded = fakeDecoded({ channels: 1 });
    const ctx = makeContext({ decoded }); ctx.createBuffer = vi.fn(ctx.createBuffer);
    let source;
    const offline = () => ({ ...makeOffline(), createBufferSource: () => (source = { connect() {}, start() {} }) });
    await decodeAudioFile(fakeFile(), { createContext: () => ctx, createOffline: offline });
    expect(ctx.createBuffer).not.toHaveBeenCalled(); expect(source.buffer).toBe(decoded);
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
