import { beforeEach, describe, expect, it, vi } from 'vitest';

// Запись заменяем управляемой заглушкой: тест про логику самопроверки,
// а сам микрофон проверяется живым E2E с фейковым устройством Chromium.
const recording = { pcm: null, sampleRate: 16000, durationMs: 2000 };
let startError = null;
vi.mock('./audio/pcmRecorder.js', () => ({
  startPcmRecording: vi.fn(async () => {
    if (startError) throw startError;
    return {
      stop: () => ({ ...recording }),
      sampleRate: 16000,
      abort: () => {},
    };
  }),
}));

const { runDictationSelfTest, analysePcm, describeSelfTest } = await import('./selftest.js');

const loudPcm = (n = 16000) => {
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i += 1) pcm[i] = Math.round(6000 * Math.sin((2 * Math.PI * 220 * i) / 16000));
  return pcm;
};

beforeEach(() => {
  startError = null;
  recording.pcm = loudPcm();
  recording.sampleRate = 16000;
  recording.durationMs = 2000;
  globalThis.window = {
    zspeakly: { native: { transcribePcm: vi.fn(async () => ({ ok: true, text: 'привет мир' })) } },
  };
});

describe('самопроверка диктовки', () => {
  it('возвращает текст, если запись и движок в порядке', async () => {
    const res = await runDictationSelfTest({ seconds: 0.4 });
    expect(res.ok).toBe(true);
    expect(res.text).toBe('привет мир');
    expect(res.seconds).toBeGreaterThan(0.9);
    expect(typeof res.sttMs).toBe('number');
    expect(describeSelfTest(res)).toMatch(/Записано .* распознано за .* с: «привет мир»/);
  });

  it('тишину в микрофоне называет тишиной, а не «ничего не произошло»', async () => {
    recording.pcm = new Int16Array(16000);
    const res = await runDictationSelfTest({ seconds: 0.4 });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/молчит/i);
    expect(window.zspeakly.native.transcribePcm).not.toHaveBeenCalled();
  });

  it('объясняет, если микрофон не открылся', async () => {
    startError = Object.assign(new Error('нет доступа'), { name: 'NotAllowedError' });
    const res = await runDictationSelfTest({ seconds: 0.4 });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/Конфиденциальность/);
  });

  it('без движка честно говорит, что проверка только в приложении', async () => {
    globalThis.window = { zspeakly: {} };
    const res = await runDictationSelfTest({ seconds: 0.4 });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/только в приложении|недоступен/i);
  });

  it('уровень сигнала считается по тем же порогам, что в main', () => {
    const silence = analysePcm(new Int16Array(32000));
    expect(silence.rms).toBe(0);
    expect(silence.peak).toBe(0);
    const loud = analysePcm(loudPcm());
    expect(loud.rms).toBeGreaterThan(40);
    expect(loud.peak).toBeGreaterThan(250);
    expect(analysePcm(null).samples).toBe(0);
  });
});
