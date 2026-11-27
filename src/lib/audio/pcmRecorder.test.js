import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startPcmRecording } from './pcmRecorder.js';

function fakeAudio({ sampleRate = 48000 } = {}) {
  let lastProcessor = null;
  const tracks = [{ stop: vi.fn(), kind: 'audio' }];
  class Ctx {
    constructor() {
      this.sampleRate = sampleRate;
      this.destination = { id: 'destination' };
      this.closed = false;
    }
    createMediaStreamSource() {
      return { connect: vi.fn(), disconnect: vi.fn() };
    }
    createScriptProcessor() {
      const node = { connect: vi.fn(), disconnect: vi.fn(), onaudioprocess: null };
      lastProcessor = node;
      return node;
    }
    createGain() {
      return { connect: vi.fn(), disconnect: vi.fn(), gain: { value: 1 } };
    }
    close() {
      this.closed = true;
      return Promise.resolve();
    }
  }
  return {
    Ctx,
    tracks,
    stream: () => ({ getTracks: () => tracks }),
    /** Отдать «звук» длиной size сэмплов. */
    feed: (size = 4800, value = 0.5) => {
      const buffer = new Float32Array(size).fill(value);
      lastProcessor.onaudioprocess({ inputBuffer: { getChannelData: () => buffer } });
    },
  };
}

async function record(overrides = {}, opts = {}) {
  const audio = fakeAudio(opts);
  window.AudioContext = audio.Ctx;
  const getUserMedia = opts.getUserMedia || vi.fn(async () => audio.stream());
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  const onLevel = vi.fn();
  const rec = await startPcmRecording({ onLevel, ...overrides });
  return { rec, audio, onLevel, getUserMedia };
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  delete window.AudioContext;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('запись в PCM для whisper', () => {
  it('без AudioContext говорит прямо, что микрофона нет', async () => {
    await expect(startPcmRecording()).rejects.toThrow(/недоступен/);
  });

  it.each(['constructor', 'source', 'processor', 'gain', 'source.connect', 'processor.connect', 'gain.connect'])(
    'освобождает микрофон и созданные узлы при ошибке %s', async (stage) => {
      const track = { stop: vi.fn() };
      const nodes = [];
      const close = vi.fn(async () => {});
      const node = (name) => {
        const n = { gain: { value: 1 }, connect: vi.fn(() => { if (stage === `${name}.connect`) throw new Error(stage); }), disconnect: vi.fn() };
        nodes.push(n);
        return n;
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
      await expect(startPcmRecording()).rejects.toThrow(stage);
      expect(track.stop).toHaveBeenCalledTimes(1);
      if (stage !== 'constructor') expect(close).toHaveBeenCalledTimes(1);
      for (const n of nodes) expect(n.disconnect).toHaveBeenCalledTimes(1);
    },
  );

  it('отмена при ожидании разрешения закрывает поздний поток до создания аудиоконтекста', async () => {
    const audio = fakeAudio();
    const created = vi.fn();
    window.AudioContext = class extends audio.Ctx { constructor(options) { super(options); created(); } };
    let allow;
    const getUserMedia = vi.fn(() => new Promise((resolve) => { allow = resolve; }));
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    let cancelled = false;
    const opening = startPcmRecording({ isCancelled: () => cancelled });
    cancelled = true;
    allow(audio.stream());
    await expect(opening).rejects.toMatchObject({ name: 'AbortError' });
    expect(audio.tracks[0].stop).toHaveBeenCalledTimes(1);
    expect(created).not.toHaveBeenCalled();
  });

  it('после отмены не открывает системный микрофон вместо пропавшего', async () => {
    const audio = fakeAudio();
    window.AudioContext = audio.Ctx;
    let reject;
    const getUserMedia = vi.fn()
      .mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }))
      .mockResolvedValue(audio.stream());
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    let cancelled = false;
    const opening = startPcmRecording({ deviceId: 'usb', isCancelled: () => cancelled });
    cancelled = true;
    reject(Object.assign(new Error('пропал'), { name: 'OverconstrainedError' }));
    await expect(opening).rejects.toMatchObject({ name: 'AbortError' });
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('пишет 16 кГц моно и считает длительность по реальной частоте', async () => {
    const { rec, audio } = await record();
    expect(rec.sampleRate).toBe(48000);
    audio.feed(4800); // 100 мс при 48 кГц
    audio.feed(4800);
    expect(rec.frames).toBe(9600);
    const result = rec.stop();
    expect(result.sampleRate).toBe(16000);
    expect(result.durationMs).toBe(200);
    expect(result.pcm.length).toBe(3200); // 9600 / 3
    expect(result.pcm).toBeInstanceOf(Int16Array);
    expect(audio.tracks[0].stop).toHaveBeenCalled();
  });

  it('уровень сигнала доходит до индикатора и гаснет на паузе', async () => {
    const { rec, audio, onLevel } = await record();
    audio.feed(4800, 0.5);
    expect(onLevel).toHaveBeenCalled();
    expect(onLevel.mock.calls.at(-1)[0]).toBeGreaterThan(0);
    expect(onLevel.mock.calls.at(-1)[0]).toBeLessThanOrEqual(1);
    rec.pause();
    expect(rec.paused).toBe(true);
    const before = rec.frames;
    onLevel.mockClear();
    audio.feed(4800, 0.9); // на паузе звук не копится
    expect(rec.frames).toBe(before);
    rec.resume();
    audio.feed(4800, 0.9);
    expect(rec.frames).toBeGreaterThan(before);
  });

  it('предролл попадает в начало записи — первое слово не теряется', async () => {
    const { rec, audio } = await record({
      preroll: { samples: new Float32Array(4800).fill(0.2), sampleRate: 48000 },
    });
    expect(rec.frames).toBe(4800);
    audio.feed(4800, 0.2);
    expect(rec.frames).toBe(9600);
    expect(rec.stop().durationMs).toBe(200);
  });

  it('промежуточный снимок не останавливает запись и режет хвост по лимиту', async () => {
    const { rec, audio } = await record();
    for (let i = 0; i < 10; i += 1) audio.feed(48000, 0.1); // 10 секунд
    const snap = rec.snapshot({ maxSeconds: 3 });
    expect(snap.truncated).toBe(true);
    expect(snap.durationMs).toBe(3000);
    expect(snap.pcm.length).toBe(48000); // 3 с × 16 кГц
    expect(rec.frames).toBe(480000); // запись продолжается
    const full = rec.snapshot({ maxSeconds: 60 });
    expect(full.truncated).toBe(false);
    expect(full.durationMs).toBe(10000);
    expect(rec.frames).toBe(480000);
  });

  it('громкий звук обрезается по границам Int16, а не заворачивается', async () => {
    const { rec, audio } = await record();
    audio.feed(4800, 5); // громче единицы
    audio.feed(4800, -5);
    const { pcm } = rec.stop();
    expect(pcm[0]).toBe(32767);
    expect(Math.min(...pcm)).toBe(-32768);
    expect(Math.max(...pcm)).toBe(32767);
  });

  it('выбранный микрофон пропал — пишем с системного и помечаем это', async () => {
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('нет'), { name: 'OverconstrainedError' }))
      .mockImplementationOnce(async () => fakeAudio().stream());
    const { rec } = await record({ deviceId: 'usb' }, { getUserMedia });
    expect(rec.fellBack).toBe(true);
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    rec.abort();
  });

  it('отключение дорожки останавливает захват и помечает неполный звук один раз', async () => {
    const audio = fakeAudio({ sampleRate: 16000 });
    const track = new EventTarget(); track.kind = 'audio'; track.stop = vi.fn();
    window.AudioContext = audio.Ctx;
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })) } });
    const onInterrupted = vi.fn(); const onLevel = vi.fn();
    const rec = await startPcmRecording({ onInterrupted, onLevel });
    audio.feed(1600, 0.5);
    track.dispatchEvent(new Event('ended'));
    track.dispatchEvent(new Event('ended'));
    expect(onInterrupted).toHaveBeenCalledTimes(1);
    expect(track.stop).toHaveBeenCalledTimes(1);
    const atEnd = rec.frames; const levels = onLevel.mock.calls.length;
    audio.feed(1600, 0.9);
    expect(rec.frames).toBe(atEnd);
    expect(onLevel).toHaveBeenCalledTimes(levels);
    const result = rec.stop();
    expect(result).toMatchObject({ interrupted: true, durationMs: 100 });
    expect(result.pcm).toHaveLength(1600);
    expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it('дорожка, завершившаяся до создания графа, не начинает запись как нормальную', async () => {
    const audio = fakeAudio({ sampleRate: 16000 }); const track = new EventTarget();
    track.kind = 'audio'; track.readyState = 'ended'; track.stop = vi.fn();
    window.AudioContext = audio.Ctx;
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })) } });
    const onInterrupted = vi.fn(); const rec = await startPcmRecording({ onInterrupted });
    expect(onInterrupted).toHaveBeenCalledTimes(1);
    expect(rec.interrupted).toBe(true);
    expect(track.stop).toHaveBeenCalledTimes(1);
    audio.feed(1600);
    expect(rec.frames).toBe(0);
    expect(rec.stop()).toMatchObject({ interrupted: true, durationMs: 0 });
  });

  it('ended, обнаруженный до доставки события при стопе, не выдаётся за полный звук', async () => {
    const audio = fakeAudio({ sampleRate: 16000 }); const track = new EventTarget();
    track.kind = 'audio'; track.readyState = 'live'; track.stop = vi.fn();
    window.AudioContext = audio.Ctx;
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })) } });
    const onInterrupted = vi.fn(); const rec = await startPcmRecording({ onInterrupted });
    audio.feed(1600); track.readyState = 'ended';
    expect(rec.stop()).toMatchObject({ interrupted: true });
    expect(onInterrupted).not.toHaveBeenCalled();
    track.dispatchEvent(new Event('ended'));
    expect(onInterrupted).not.toHaveBeenCalled();
  });

  it('обычный stop и abort не считаются отключением, поздний колбэк не добавляет PCM', async () => {
    for (const method of ['stop', 'abort']) {
      const audio = fakeAudio({ sampleRate: 16000 }); const track = new EventTarget();
      track.kind = 'audio'; track.readyState = 'live'; track.stop = vi.fn();
      window.AudioContext = audio.Ctx;
      vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })) } });
      const onInterrupted = vi.fn(); const rec = await startPcmRecording({ onInterrupted });
      audio.feed(1600); const result = rec[method]();
      if (method === 'stop') expect(result.interrupted).toBe(false);
      track.dispatchEvent(new Event('ended')); audio.feed(1600);
      expect(rec.frames).toBe(1600);
      expect(onInterrupted).not.toHaveBeenCalled();
    }
  });

  it('после abort звук больше не копится', async () => {
    const { rec, audio } = await record();
    audio.feed(4800);
    rec.abort();
    const before = rec.frames;
    audio.feed(4800);
    expect(rec.frames).toBe(before);
    expect(audio.tracks[0].stop).toHaveBeenCalled();
  });

  it('повторная отмена не закрывает микрофон дважды', async () => {
    const { rec, audio } = await record();
    rec.abort();
    rec.abort();
    expect(audio.tracks[0].stop).toHaveBeenCalledTimes(1);
  });

  it('пустая запись не даёт мусорных сэмплов', async () => {
    const { rec } = await record();
    const result = rec.stop();
    expect(result.durationMs).toBe(0);
    expect(result.pcm.length).toBe(0);
  });
});
