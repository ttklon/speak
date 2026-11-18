import { beforeEach, describe, expect, it, vi } from 'vitest';

// Запись заменяем управляемой заглушкой: тест про логику самопроверки,
// а сам микрофон проверяется живым E2E с фейковым устройством Chromium.
const recording = { pcm: null, sampleRate: 16000, durationMs: 2000 };
let startError = null;
// сколько первых попыток отдать «пустую» запись: так проверяется повтор, когда
// микрофон не успел открыться на загруженной машине
let emptyRecordings = 0;
// первые N записей не отдают ни одного отсчёта: имитация «микрофон ещё
// открывается», а не «в комнате тихо»
let silentOpenings = 0;
// «микрофон просыпается»: столько миллисекунд устройство отдаёт нули, прежде
// чем появится звук — так ведут себя Bluetooth-гарнитуры и загруженная машина
let wakeUpMs = 0;
const startPcmRecording = vi.fn(async ({ onLevel } = {}) => {
  if (startError) throw startError;
  const useEmpty = emptyRecordings > 0;
  if (useEmpty) emptyRecordings -= 1;
  const lateOpen = silentOpenings > 0;
  if (lateOpen) silentOpenings -= 1;
  let ticks = 0;
  let elapsed = 0;
  const timer = setInterval(() => {
    elapsed += 40;
    // до «пробуждения» уровень нулевой — ровно то, из-за чего проверка раньше
    // записывала тишину и врала про мёртвый микрофон
    onLevel?.(elapsed >= wakeUpMs ? 0.4 : 0);
    ticks += 1;
  }, 40);
  timer.unref?.();
  return {
    get frames() {
      if (!lateOpen) return 16000;
      ticks += 1;
      return ticks > 2 ? 16000 : 0;
    },
    stop: () => {
      clearInterval(timer);
      return useEmpty ? { pcm: new Int16Array(0), sampleRate: 16000 } : { ...recording };
    },
    sampleRate: 16000,
    abort: () => clearInterval(timer),
  };
});
vi.mock('./audio/pcmRecorder.js', () => ({ startPcmRecording }));

const { runDictationSelfTest, analysePcm, describeSelfTest } = await import('./selftest.js');

const loudPcm = (n = 16000) => {
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i += 1) pcm[i] = Math.round(6000 * Math.sin((2 * Math.PI * 220 * i) / 16000));
  return pcm;
};

beforeEach(() => {
  startError = null;
  emptyRecordings = 0;
  silentOpenings = 0;
  wakeUpMs = 0;
  startPcmRecording.mockClear();
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

  it('если запись не началась — повторяет один раз и не врёт про тишину', async () => {
    emptyRecordings = 1;
    const res = await runDictationSelfTest({ seconds: 0.1 });
    expect(startPcmRecording).toHaveBeenCalledTimes(2);
    expect(res.ok).toBe(true);
    expect(res.text).toBe('привет мир');
  });

  it('если запись не началась дважды — говорит именно это', async () => {
    emptyRecordings = 5;
    const res = await runDictationSelfTest({ seconds: 0.1 });
    expect(startPcmRecording).toHaveBeenCalledTimes(2);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/не успел открыться|ни одного отсчёта/);
    // «молчит» — это про тишину в комнате; пустая запись — другая причина
    expect(res.reason).not.toMatch(/уровень почти нулевой/);
  });

  it('не считает «две секунды записи», пока микрофон не начал отдавать звук', async () => {
    // 400 мс устройство отдаёт нули: без ожидания проверка записала бы тишину
    wakeUpMs = 400;
    const started = Date.now();
    const res = await runDictationSelfTest({ seconds: 0.1, micOpenTimeoutMs: 2000 });
    const spent = Date.now() - started;
    expect(res.ok).toBe(true);
    expect(startPcmRecording).toHaveBeenCalledTimes(1);
    // ждали пробуждения, а не «сколько получится»
    expect(spent).toBeGreaterThanOrEqual(380);
  });

  it('если микрофон так и не проснулся — честно говорит про тишину', async () => {
    wakeUpMs = 10_000; // звук не появится вовсе
    recording.pcm = new Int16Array(16000); // и в запись попадут нули
    const res = await runDictationSelfTest({ seconds: 0.1, micOpenTimeoutMs: 150 });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/молчит/i);
  });

  it('если звук так и не пошёл — повторяет запись, а не врёт про тишину', async () => {
    emptyRecordings = 1;
    const res = await runDictationSelfTest({ seconds: 0.1, micOpenTimeoutMs: 30 });
    expect(startPcmRecording).toHaveBeenCalledTimes(2);
    expect(res.ok).toBe(true);
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
