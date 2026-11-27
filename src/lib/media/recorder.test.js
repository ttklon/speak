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

  it('возвращает признак отсутствия звука, если источник не предоставил аудиодорожку', async () => {
    installMedia();
    installDisplay();
    const rec = await startScreenRecording({ audio: true });
    expect(rec.hasAudioTrack).toBe(false);
    rec.cancel();
  });

  it('сообщает о наличии запрошенной аудиодорожки', async () => {
    installMedia();
    const tracks = [{ kind: 'video', stop: vi.fn() }, { kind: 'audio', stop: vi.fn() }];
    vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia: async () => ({ getTracks: () => tracks }) } });
    const rec = await startScreenRecording({ audio: true });
    expect(rec.hasAudioTrack).toBe(true);
    rec.cancel();
  });

  it('при запросе без аудио не начинает запись, если источник неожиданно вернул звук', async () => {
    const { instances } = installMedia();
    const tracks = [{ kind: 'video', stop: vi.fn() }, { kind: 'audio', stop: vi.fn() }];
    vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia: async () => ({ getTracks: () => tracks }) } });
    await expect(startScreenRecording({ audio: false })).rejects.toThrow(/звук/i);
    expect(instances.length).toBe(0);
    expect(tracks.every((track) => track.stop.mock.calls.length > 0)).toBe(true);
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

  it('при 48 МиБ просит остановку и возвращает результат с пометкой лимита', async () => {
    vi.useFakeTimers();
    const { instances } = installMedia();
    const { tracks } = installDisplay();
    const rec = await startScreenRecording();
    const part = new Uint8Array(1024 * 1024);
    instances[0].ondataavailable({ data: new Blob(Array(48).fill(part), { type: 'video/webm' }) });
    expect(instances[0].state).toBe('inactive');
    await vi.runAllTimersAsync();
    const result = await rec.finished;
    expect(result.limitReason).toBe('size');
    expect(result.blob.size).toBe(49 * 1024 * 1024);
    expect(tracks[0].stop).toHaveBeenCalled();
  });

  it('при отказе автоматической остановки освобождает поток и сообщает ошибку', async () => {
    const { tracks } = installDisplay();
    let instance;
    class BrokenRecorder {
      static isTypeSupported() { return true; }
      constructor() { instance = this; this.state = 'inactive'; }
      start() { this.state = 'recording'; }
      stop() { throw new Error('stop failed'); }
    }
    vi.stubGlobal('MediaRecorder', BrokenRecorder);
    const rec = await startScreenRecording();
    const failure = expect(rec.finished).rejects.toThrow('Не удалось завершить запись');
    instance.ondataavailable({ data: { size: 48 * 1024 * 1024 } });
    await failure;
    expect(tracks[0].stop).toHaveBeenCalled();
  });

  it('отбрасывает результат, если один фрагмент превышает жёсткий предел 64 МиБ', async () => {
    vi.useFakeTimers();
    const { instances } = installMedia();
    installDisplay();
    const rec = await startScreenRecording();
    instances[0].ondataavailable({ data: { size: 64 * 1024 * 1024 + 1 } });
    expect(instances[0].state).toBe('inactive');
    await vi.runAllTimersAsync();
    const result = await rec.finished;
    expect(result.limitReason).toBe('overflow');
    expect(result.blob.size).toBe(0);
  });

  it('проверяет лимит также для последнего фрагмента при ручной остановке', async () => {
    const { instances } = installMedia();
    installDisplay();
    const rec = await startScreenRecording();
    instances[0].stop = () => {
      instances[0].state = 'inactive';
      instances[0].ondataavailable({ data: { size: 64 * 1024 * 1024 + 1 } });
      instances[0].onstop();
    };
    const result = await rec.stop();
    expect(result.limitReason).toBe('overflow');
    expect(result.blob.size).toBe(0);
  });

  it('ручная остановка отменяет таймер лимита и не останавливает повторно', async () => {
    vi.useFakeTimers();
    const { instances } = installMedia();
    installDisplay();
    const rec = await startScreenRecording();
    const stop = vi.spyOn(instances[0], 'stop');
    const result = rec.stop();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect((await result).limitReason).toBe('');
    expect(stop).toHaveBeenCalledOnce();
  });

  it('автоматически останавливает запись через десять минут', async () => {
    vi.useFakeTimers();
    const { instances } = installMedia();
    const { tracks } = installDisplay();
    const rec = await startScreenRecording();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(instances[0].state).toBe('inactive');
    await vi.runAllTimersAsync();
    expect((await rec.finished).limitReason).toBe('duration');
    expect(tracks[0].stop).toHaveBeenCalled();
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

  it('при отсутствии onstop ручная остановка освобождает захват и отклоняется, поздние события не сохраняются', async () => {
    vi.useFakeTimers();
    const { instances } = installMedia();
    const { tracks } = installDisplay();
    const rec = await startScreenRecording();
    const recorder = instances[0];
    recorder.stop = vi.fn(() => { recorder.state = 'inactive'; });
    const failure = expect(rec.stop()).rejects.toThrow('Не удалось завершить запись');
    recorder.ondataavailable({ data: new Blob(['часть']) });
    await vi.advanceTimersByTimeAsync(15000);
    await failure;
    expect(tracks[0].stop).toHaveBeenCalled();
    recorder.ondataavailable?.({ data: new Blob(['поздно']) });
    recorder.onstop?.();
    expect(recorder.stop).toHaveBeenCalledOnce();
  });

  it('если видеодорожка закончилась при уже неактивном рекордере без onstop, ожидание ограничено', async () => {
    vi.useFakeTimers();
    const { instances } = installMedia();
    let ended;
    const video = { kind: 'video', stop: vi.fn(), addEventListener: (_, cb) => { ended = cb; }, removeEventListener: vi.fn() };
    vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia: async () => ({ getTracks: () => [video] }) } });
    const rec = await startScreenRecording();
    const failure = expect(rec.finished).rejects.toThrow('Не удалось завершить запись');
    instances[0].state = 'inactive';
    ended();
    await vi.advanceTimersByTimeAsync(15000);
    await failure;
    expect(video.stop).toHaveBeenCalled();
    expect(video.removeEventListener).toHaveBeenCalled();
  });

  it('отмена без onstop немедленно завершает результат пустым и освобождает поток', async () => {
    const { instances } = installMedia();
    const { tracks } = installDisplay();
    const rec = await startScreenRecording();
    instances[0].stop = () => { instances[0].state = 'inactive'; };
    rec.cancel();
    expect((await rec.finished).blob.size).toBe(0);
    expect(tracks[0].stop).toHaveBeenCalled();
  });

  it('ожидает запоздавший onstop и очищает таймер, не запрашивая stop дважды', async () => {
    vi.useFakeTimers();
    const { instances } = installMedia();
    const { tracks } = installDisplay();
    const rec = await startScreenRecording();
    const recorder = instances[0];
    const stop = vi.fn(); // состояние задерживается, как в неисправном API
    recorder.stop = stop;
    const result = rec.stop();
    rec.stop();
    expect(stop).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(14000);
    recorder.state = 'inactive';
    recorder.ondataavailable({ data: new Blob(['ok']) });
    recorder.onstop();
    await vi.advanceTimersByTimeAsync(3000);
    expect((await result).blob.size).toBe(2);
    expect(tracks[0].stop).toHaveBeenCalled();
  });

  it('ошибка рекордера без события остановки также освобождает поток по таймауту', async () => {
    vi.useFakeTimers();
    const { instances } = installMedia();
    const { tracks } = installDisplay();
    const rec = await startScreenRecording();
    const failure = expect(rec.finished).rejects.toThrow('Не удалось завершить запись');
    instances[0].stop = () => { instances[0].state = 'inactive'; };
    instances[0].onerror();
    await vi.advanceTimersByTimeAsync(15000);
    await failure;
    expect(tracks[0].stop).toHaveBeenCalled();
  });

  it('отмена после запроса остановки не ждёт таймера и игнорирует поздние данные', async () => {
    vi.useFakeTimers();
    const { instances } = installMedia();
    installDisplay();
    const rec = await startScreenRecording();
    instances[0].stop = () => { instances[0].state = 'inactive'; };
    const pending = rec.stop();
    rec.cancel();
    await vi.advanceTimersByTimeAsync(15000);
    instances[0].ondataavailable?.({ data: new Blob(['late']) });
    instances[0].onstop?.();
    expect((await pending).blob.size).toBe(0);
  });

  it('ручной stop перед лимитом не переименовывается в остановку по времени во время ожидания onstop', async () => {
    vi.useFakeTimers();
    const { instances } = installMedia();
    installDisplay();
    const rec = await startScreenRecording();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 - 1000);
    const recorder = instances[0];
    recorder.stop = () => { recorder.state = 'inactive'; };
    const result = rec.stop();
    await vi.advanceTimersByTimeAsync(2000);
    recorder.ondataavailable({ data: new Blob(['ok']) });
    recorder.onstop();
    await vi.runAllTimersAsync();
    expect((await result).limitReason).toBe('');
  });

  it('отмена не вызывает stop повторно, если состояние рекордера не сменилось', async () => {
    const { instances } = installMedia();
    const { tracks } = installDisplay();
    const rec = await startScreenRecording();
    instances[0].stop = vi.fn();
    rec.stop();
    rec.cancel();
    expect(instances[0].stop).toHaveBeenCalledOnce();
    expect(tracks[0].stop).toHaveBeenCalled();
    expect((await rec.finished).blob.size).toBe(0);
  });

  it('если браузер не умеет ни один кодек — пишем без mimeType', async () => {
    installMedia({ supported: [] });
    installDisplay();
    const rec = await startScreenRecording({ audio: false });
    expect(rec.mimeType).toBe('');
    rec.cancel();
  });
});
