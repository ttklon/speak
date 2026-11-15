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
    expect(constraints).toMatchObject({ channelCount: 1, echoCancellation: true, noiseSuppression: true });
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
