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
  });

  it('если браузер не умеет ни один кодек — пишем без mimeType', async () => {
    installMedia({ supported: [] });
    installDisplay();
    const rec = await startScreenRecording({ audio: false });
    expect(rec.mimeType).toBe('');
    rec.cancel();
  });
});
