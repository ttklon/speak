import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMicWarm } from './micWarm.js';

/** Минимальный двойник AudioContext: только то, что использует micWarm. */
function fakeAudio({ sampleRate = 8000 } = {}) {
  const created = [];
  let lastProcessor = null;
  class Ctx {
    constructor() {
      this.sampleRate = sampleRate;
      this.destination = { id: 'destination' };
      this.closed = false;
    }
    createMediaStreamSource() {
      const node = { id: 'source', connect: vi.fn(), disconnect: vi.fn() };
      created.push(node);
      return node;
    }
    createScriptProcessor() {
      const node = { id: 'processor', connect: vi.fn(), disconnect: vi.fn(), onaudioprocess: null };
      created.push(node);
      lastProcessor = node;
      return node;
    }
    createGain() {
      const node = { id: 'gain', connect: vi.fn(), disconnect: vi.fn(), gain: { value: 1 } };
      created.push(node);
      return node;
    }
    close() {
      this.closed = true;
      return Promise.resolve();
    }
  }
  return {
    Ctx,
    created,
    /** Прогнать звук через обработчик, как это делает браузер. */
    feed: (samples) => {
      const buffer = Float32Array.from(samples);
      lastProcessor?.onaudioprocess({ inputBuffer: { getChannelData: () => buffer } });
    },
    processor: () => lastProcessor,
  };
}

const fakeStream = () => {
  const track = { stop: vi.fn(), kind: 'audio' };
  return { getTracks: () => [track] };
};

function setup({ audio = fakeAudio(), getUserMedia } = {}) {
  window.AudioContext = audio.Ctx;
  const gum = getUserMedia || vi.fn(async () => fakeStream());
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: gum } });
  return { audio, getUserMedia: gum };
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  delete window.AudioContext;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('горячий микрофон', () => {
  it('без AudioContext честно отказывает, а не висит', async () => {
    const warm = createMicWarm();
    await expect(warm.open()).rejects.toThrow(/недоступен/);
    expect(warm.opened).toBe(false);
  });

  it('открывает поток один раз и не дёргает разрешение повторно', async () => {
    const { getUserMedia } = setup();
    const warm = createMicWarm({ prerollMs: 500 });
    await warm.open();
    expect(warm.opened).toBe(true);
    await warm.open();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    const constraints = getUserMedia.mock.calls[0][0].audio;
    // Сырой звук по умолчанию: обработка «для звонков» срезает окончания слов
    expect(constraints).toMatchObject({
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    });
    expect(constraints.deviceId).toBeUndefined();
    warm.close();
    expect(warm.opened).toBe(false);
  });

  it('close останавливает дорожку микрофона', async () => {
    const track = { stop: vi.fn(), kind: 'audio' };
    setup({ getUserMedia: async () => ({ getTracks: () => [track] }) });
    const warm = createMicWarm();
    await warm.open();
    warm.close();
    expect(track.stop).toHaveBeenCalled();
    expect(warm.take()).toBeNull();
  });

  it('отключение до разрешения закрывает поздний поток и не создаёт аудиограф', async () => {
    const track = { stop: vi.fn() };
    let allow;
    const audio = fakeAudio();
    const created = vi.fn();
    audio.Ctx = class extends audio.Ctx { constructor(...args) { super(...args); created(); } };
    setup({ audio, getUserMedia: vi.fn(() => new Promise((resolve) => { allow = resolve; })) });
    const warm = createMicWarm();
    const opening = warm.open();
    warm.close();
    allow({ getTracks: () => [track] });
    await expect(opening).rejects.toMatchObject({ name: 'AbortError' });
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(created).not.toHaveBeenCalled();
    expect(warm.opened).toBe(false);
    expect(warm.take()).toBeNull();
  });

  it('отмена при пропавшем устройстве не открывает системный микрофон', async () => {
    let reject;
    const gum = vi.fn(() => new Promise((_, fail) => { reject = fail; }));
    setup({ getUserMedia: gum });
    const warm = createMicWarm({ deviceId: 'usb-mic' });
    const opening = warm.open();
    warm.close();
    reject(Object.assign(new Error('нет устройства'), { name: 'NotFoundError' }));
    await expect(opening).rejects.toMatchObject({ name: 'AbortError' });
    expect(gum).toHaveBeenCalledTimes(1);
  });

  it('закрытый старый запрос не заменяет новый поток и не закрывает его', async () => {
    let allowOld, allowNew;
    const oldTrack = { stop: vi.fn() }, newTrack = { stop: vi.fn() };
    const gum = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { allowOld = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { allowNew = resolve; }));
    setup({ getUserMedia: gum });
    const warm = createMicWarm();
    const old = warm.open();
    warm.close();
    const newer = warm.open();
    allowNew({ getTracks: () => [newTrack] });
    await expect(newer).resolves.toBe(true);
    allowOld({ getTracks: () => [oldTrack] });
    await expect(old).rejects.toMatchObject({ name: 'AbortError' });
    expect(oldTrack.stop).toHaveBeenCalledTimes(1);
    expect(newTrack.stop).not.toHaveBeenCalled();
    expect(warm.opened).toBe(true);
    warm.close();
    expect(newTrack.stop).toHaveBeenCalledTimes(1);
  });

  it('поздний системный fallback после закрытия тоже освобождает поток', async () => {
    let allow;
    const track = { stop: vi.fn() };
    const gum = vi.fn().mockRejectedValueOnce(Object.assign(new Error('нет'), { name: 'NotFoundError' }))
      .mockImplementationOnce(() => new Promise((resolve) => { allow = resolve; }));
    setup({ getUserMedia: gum });
    const warm = createMicWarm({ deviceId: 'usb-mic' });
    const opening = warm.open();
    await vi.waitFor(() => expect(allow).toBeTypeOf('function'));
    warm.close();
    allow({ getTracks: () => [track] });
    await expect(opening).rejects.toMatchObject({ name: 'AbortError' });
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(warm.opened).toBe(false);
  });

  it('поздний обработчик старого графа не записывает звук в новый предролл', async () => {
    const audio = fakeAudio(); setup({ audio });
    const warm = createMicWarm({ prerollMs: 250 });
    await warm.open();
    const old = audio.processor();
    warm.close();
    await warm.open();
    old.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(100).fill(0.9) } });
    expect(warm.take()).toBeNull();
    audio.feed([0.2, 0.4]);
    expect(Array.from(warm.take().samples)).toEqual(Array.from(new Float32Array([0.2, 0.4])));
    warm.close();
  });

  it('два одновременных открытия используют один запрос', async () => {
    let allow;
    const gum = vi.fn(() => new Promise((resolve) => { allow = resolve; }));
    setup({ getUserMedia: gum });
    const warm = createMicWarm();
    const first = warm.open(), second = warm.open();
    expect(gum).toHaveBeenCalledTimes(1);
    allow(fakeStream());
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    warm.close();
  });

  it.each(['constructor', 'source', 'processor', 'gain', 'source.connect', 'processor.connect', 'gain.connect'])(
    'освобождает все доступные ресурсы при ошибке %s', async (stage) => {
      const track = { stop: vi.fn() }, nodes = [];
      const close = vi.fn(async () => {});
      const node = (name) => {
        const n = { gain: { value: 1 }, connect: vi.fn(() => { if (stage === `${name}.connect`) throw new Error(stage); }), disconnect: vi.fn() };
        nodes.push(n); return n;
      };
      class Ctx {
        constructor() { if (stage === 'constructor') throw new Error(stage); this.sampleRate = 16000; this.destination = {}; }
        createMediaStreamSource() { if (stage === 'source') throw new Error(stage); return node('source'); }
        createScriptProcessor() { if (stage === 'processor') throw new Error(stage); return node('processor'); }
        createGain() { if (stage === 'gain') throw new Error(stage); return node('gain'); }
        close = close;
      }
      window.AudioContext = Ctx;
      vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })) } });
      const warm = createMicWarm();
      await expect(warm.open()).rejects.toThrow(stage);
      expect(track.stop).toHaveBeenCalledTimes(1);
      if (stage !== 'constructor') expect(close).toHaveBeenCalledTimes(1);
      for (const n of nodes) expect(n.disconnect).toHaveBeenCalledTimes(1);
      expect(warm.opened).toBe(false);
      warm.close();
      expect(track.stop).toHaveBeenCalledTimes(1);
    },
  );

  it('после ошибки создания графа повторное открытие получает новый поток', async () => {
    const tracks = [{ stop: vi.fn() }, { stop: vi.fn() }];
    let fail = true, index = 0;
    class Ctx {
      constructor() { this.sampleRate = 16000; this.destination = {}; }
      createMediaStreamSource() { if (fail) { fail = false; throw new Error('source failed'); } return { connect() {}, disconnect() {} }; }
      createScriptProcessor() { return { connect() {}, disconnect() {} }; }
      createGain() { return { gain: { value: 0 }, connect() {}, disconnect() {} }; }
      close() { return Promise.resolve(); }
    }
    window.AudioContext = Ctx;
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [tracks[index++]] })) } });
    const warm = createMicWarm();
    await expect(warm.open()).rejects.toThrow('source failed');
    expect(tracks[0].stop).toHaveBeenCalledTimes(1);
    await expect(warm.open()).resolves.toBe(true);
    expect(warm.opened).toBe(true);
    expect(tracks[1].stop).not.toHaveBeenCalled();
    warm.close();
    expect(tracks[1].stop).toHaveBeenCalledTimes(1);
  });

  it('ошибки отключения одного узла или дорожки не мешают освободить остальные', async () => {
    const audio = fakeAudio();
    const tracks = [{ stop: vi.fn(() => { throw new Error('one'); }) }, { stop: vi.fn() }];
    setup({ audio, getUserMedia: async () => ({ getTracks: () => tracks }) });
    const warm = createMicWarm(); await warm.open();
    audio.created[1].disconnect.mockImplementation(() => { throw new Error('disconnect'); });
    warm.close();
    expect(tracks[0].stop).toHaveBeenCalledTimes(1);
    expect(tracks[1].stop).toHaveBeenCalledTimes(1);
    for (const node of audio.created) expect(node.disconnect).toHaveBeenCalledTimes(1);
  });

  it('выбранный микрофон пропал — берём системный', async () => {
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('нет устройства'), { name: 'NotFoundError' }))
      .mockResolvedValueOnce(fakeStream());
    setup({ getUserMedia });
    const warm = createMicWarm({ deviceId: 'usb-mic', prerollMs: 300 });
    await warm.open();
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(getUserMedia.mock.calls[0][0].audio.deviceId).toEqual({ exact: 'usb-mic' });
    expect(getUserMedia.mock.calls[1][0].audio.deviceId).toBeUndefined();
    warm.close();
  });

  it('запрет доступа не подменяется другим устройством', async () => {
    const getUserMedia = vi.fn(async () => {
      throw Object.assign(new Error('нет разрешения'), { name: 'NotAllowedError' });
    });
    setup({ getUserMedia });
    const warm = createMicWarm({ deviceId: 'usb-mic' });
    await expect(warm.open()).rejects.toThrow(/разрешения/);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(warm.opened).toBe(false);
  });

  it('предролл: отдаёт последние миллисекунды и только один раз', async () => {
    const audio = fakeAudio({ sampleRate: 8000 });
    setup({ audio });
    const warm = createMicWarm({ prerollMs: 250 }); // 250 мс при 8 кГц = 2000 сэмплов
    expect(warm.take()).toBeNull();
    await warm.open();
    expect(warm.take()).toBeNull(); // ещё тишина

    audio.feed(Array.from({ length: 5000 }, (_, i) => i / 5000));
    const preroll = warm.take();
    expect(preroll).not.toBeNull();
    expect(preroll.sampleRate).toBe(8000);
    expect(preroll.samples.length).toBe(2000);
    expect(preroll.samples.at(-1)).toBeCloseTo(4999 / 5000, 6); // самый свежий звук
    expect(warm.take()).toBeNull(); // буфер очищен — дважды не отдаём
    warm.close();
  });

  it('молчащий обработчик не роняет при закрытом контексте', async () => {
    const audio = fakeAudio();
    setup({ audio });
    const warm = createMicWarm();
    await warm.open();
    const proc = audio.processor();
    warm.close();
    expect(() => proc.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(4) } })).not.toThrow();
  });
});
