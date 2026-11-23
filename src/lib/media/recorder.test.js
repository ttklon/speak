import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isRecordingSupported, startScreenRecording } from './recorder.js';

function installMedia({ supported = ['video/webm;codecs=vp9'] } = {}) {
  const instances = [];
  class FakeMediaRecorder {
    static isTypeSupported = (m) => supported.includes(m);
    constructor(stream, opts = {}) {
      this.stream = stream;
      this.mimeType = opts.mimeType || '';
      this.state = 'inactive';
      this.ondataavailable = null;
      this.onstop = null;
      instances.push(this);
    }
    start() {
      this.state = 'recording';
    }
    stop() {
      this.state = 'inactive';
      // настоящий MediaRecorder отдаёт Blob, а не сырые байты
      this.ondataavailable?.({ data: new Blob([new Uint8Array(1024 * 1024)], { type: 'video/webm' }) });
      this.onstop?.();
    }
  }
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
  return { instances };
}

function installDisplay() {
  const tracks = [{ stop: vi.fn(), kind: 'video' }];
  const getDisplayMedia = vi.fn(async () => ({ getTracks: () => tracks }));
  vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia } });
  return { getDisplayMedia, tracks };
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('запись экрана', () => {
  it('без поддержки в окружении честно говорит «нельзя»', () => {
    vi.stubGlobal('navigator', { mediaDevices: {} });
    expect(isRecordingSupported()).toBe(false);
  });

  it('при наличии API считает запись доступной', () => {
    installMedia();
    installDisplay();
    expect(isRecordingSupported()).toBe(true);
  });

  it('в неподдерживаемом окружении не начинает запись', async () => {
    vi.stubGlobal('navigator', { mediaDevices: {} });
    await expect(startScreenRecording()).rejects.toThrow(/не поддерживается/);
  });

  it('берёт лучший кодек и отдаёт видео с постером', async () => {
    vi.useFakeTimers();
    const { instances } = installMedia();
    const { getDisplayMedia, tracks } = installDisplay();
    const ticks = [];
    const rec = await startScreenRecording({ audio: true, onTick: (ms) => ticks.push(ms) });
    expect(getDisplayMedia).toHaveBeenCalledWith(
      expect.objectContaining({ video: { frameRate: 30 }, audio: expect.any(Object) }),
    );
    expect(instances[0].mimeType).toBe('video/webm;codecs=vp9');
    expect(rec.mimeType).toBe('video/webm;codecs=vp9');

    await vi.advanceTimersByTimeAsync(2500);
    expect(ticks.length).toBeGreaterThanOrEqual(2);

    const done = rec.stop();
    await vi.runAllTimersAsync();
    const result = await done;
    expect(result.blob.size).toBe(1024 * 1024);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.sizeMb).toBe(1);
    expect(typeof result.poster).toBe('string');
    expect(tracks[0].stop).toHaveBeenCalled();
  });

  it('без звука запрашивает только видео', async () => {
    const { getDisplayMedia } = installDisplay();
    installMedia();
    const rec = await startScreenRecording({ audio: false });
    expect(getDisplayMedia.mock.calls[0][0].audio).toBe(false);
    rec.cancel();
  });

  it('отмена останавливает дорожки и не отдаёт данные', async () => {
    vi.useFakeTimers();
    installMedia();
    const { tracks } = installDisplay();
    const rec = await startScreenRecording({ audio: false });
    rec.cancel();
    expect(tracks[0].stop).toHaveBeenCalled();
    await vi.runAllTimersAsync();
    const result = await rec.finished;
    expect(result.blob.size).toBe(0);
    expect(result.poster).toBe('');
  });

  it('освобождает захват, если конструктор MediaRecorder выбросил ошибку', async () => {
    const { tracks } = installDisplay();
    class BrokenRecorder {
      static isTypeSupported() { return true; }
      constructor() { throw new Error('constructor failed'); }
    }
    vi.stubGlobal('MediaRecorder', BrokenRecorder);
    await expect(startScreenRecording()).rejects.toThrow('constructor failed');
    expect(tracks[0].stop).toHaveBeenCalled();
  });

  it('освобождает захват и таймер, если старт MediaRecorder выбросил ошибку', async () => {
    vi.useFakeTimers();
    const { tracks } = installDisplay();
    class BrokenRecorder {
      static isTypeSupported() { return true; }
      start() { throw new Error('start failed'); }
    }
    vi.stubGlobal('MediaRecorder', BrokenRecorder);
    const ticks = vi.fn();
    await expect(startScreenRecording({ onTick: ticks })).rejects.toThrow('start failed');
    expect(tracks[0].stop).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3000);
    expect(ticks).not.toHaveBeenCalled();
  });

  it('завершает запись при окончании видеодорожки, даже если звуковая ещё активна', async () => {
    vi.useFakeTimers();
    const { instances } = installMedia();
    let ended;
    const video = { kind: 'video', stop: vi.fn(), addEventListener: vi.fn((type, cb) => { if (type === 'ended') ended = cb; }), removeEventListener: vi.fn() };
    const audio = { kind: 'audio', stop: vi.fn() };
    vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia: async () => ({ getTracks: () => [video, audio] }) } });
    const rec = await startScreenRecording();
    expect(ended).toBeTypeOf('function');
    ended();
    expect(instances[0].state).toBe('inactive');
    await vi.runAllTimersAsync();
    expect((await rec.finished).blob.size).toBe(1024 * 1024);
    expect(audio.stop).toHaveBeenCalled();
    expect(video.removeEventListener).toHaveBeenCalledWith('ended', ended);
  });

  it('ошибка остановки по завершению видеодорожки освобождает все дорожки и отклоняет результат', async () => {
    let ended;
    const video = { kind: 'video', stop: vi.fn(), addEventListener: (_, cb) => { ended = cb; }, removeEventListener: vi.fn() };
    const audio = { kind: 'audio', stop: vi.fn() };
    vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia: async () => ({ getTracks: () => [video, audio] }) } });
    class BrokenRecorder {
      static isTypeSupported() { return true; }
      constructor() { this.state = 'inactive'; }
      start() { this.state = 'recording'; }
      stop() { throw new Error('stop failed'); }
    }
    vi.stubGlobal('MediaRecorder', BrokenRecorder);
    const rec = await startScreenRecording();
    const failure = expect(rec.finished).rejects.toThrow('Не удалось завершить запись');
    ended();
    await failure;
    expect(video.stop).toHaveBeenCalled();
    expect(audio.stop).toHaveBeenCalled();
    expect(video.removeEventListener).toHaveBeenCalled();
  });

  it('при ошибке сборки Blob отклоняет результат вместо зависания', async () => {
    const { tracks } = installDisplay();
    class Recorder {
      static isTypeSupported() { return true; }
      constructor() { this.state = 'inactive'; }
      start() { this.state = 'recording'; }
      stop() { this.state = 'inactive'; this.onstop(); }
    }
    vi.stubGlobal('MediaRecorder', Recorder);
    const rec = await startScreenRecording();
    vi.stubGlobal('Blob', class { constructor() { throw new Error('allocation failed'); } });
    await expect(rec.stop()).rejects.toThrow('Не удалось обработать запись');
    expect(tracks[0].stop).toHaveBeenCalled();
  });

  it('помечает частичный результат, если MediaRecorder сообщил об ошибке', async () => {
    vi.useFakeTimers();
    const { instances } = installMedia();
    installDisplay();
    const rec = await startScreenRecording();
    instances[0].onerror?.({ error: new Error('capture error') });
    const done = rec.stop();
    await vi.runAllTimersAsync();
    expect((await done).interrupted).toBe(true);
  });

  it('после отмены игнорирует поздний dataavailable перед onstop', async () => {
    const { tracks } = installDisplay();
    let instance;
    class AsyncRecorder {
      static isTypeSupported() { return true; }
      constructor() { instance = this; this.state = 'inactive'; }
      start() { this.state = 'recording'; }
      stop() { this.state = 'inactive'; }
    }
    vi.stubGlobal('MediaRecorder', AsyncRecorder);
    const rec = await startScreenRecording();
    instance.ondataavailable({ data: new Blob(['до отмены']) });
    rec.cancel();
    instance.ondataavailable({ data: new Blob(['после отмены']) });
    await instance.onstop();
    const result = await rec.finished;
    expect(result.blob.size).toBe(0);
    expect(result.poster).toBe('');
    expect(tracks[0].stop).toHaveBeenCalled();
  });

  it('отмена во время создания постера не возвращает полученное видео', async () => {
    installMedia();
    installDisplay();
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:pending', revokeObjectURL });
    let video;
    vi.stubGlobal('document', { createElement: () => (video = { src: '', muted: false, set currentTime(_) { throw new Error('seek failed'); } }) });
    const rec = await startScreenRecording();
    const result = rec.stop();
    rec.cancel();
    video.onloadeddata();
    expect((await result).blob.size).toBe(0);
    expect((await result).poster).toBe('');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:pending');
  });

  it('освобождает временный URL видео, даже если создание постера завершилось ошибкой', async () => {
    installMedia();
    installDisplay();
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:test-recording', revokeObjectURL });
    const video = {
      set src(value) { this.url = value; queueMicrotask(() => this.onloadeddata()); },
      set currentTime(_) { throw new Error('seek failed'); },
    };
    vi.stubGlobal('document', { createElement: () => video });
    const rec = await startScreenRecording();
    const result = await rec.stop();
    expect(result.poster).toBe('');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:test-recording');
  });

  it('если браузер не умеет ни один кодек — пишем без mimeType', async () => {
    installMedia({ supported: [] });
    installDisplay();
    const rec = await startScreenRecording({ audio: false });
    expect(rec.mimeType).toBe('');
    rec.cancel();
  });
});
