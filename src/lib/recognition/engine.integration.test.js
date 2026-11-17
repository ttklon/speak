import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Сквозной тест нативного распознавателя: микрофон и движок подменены, поэтому
 * видно ровно то, что получает человек — итоговый текст и число вставок.
 *
 * Зачем такие тесты. В 1.6.7–1.6.9 появилась нарезка записи на куски, и ошибка
 * в склейке даёт «просто повторы» — текст вставляется, но трижды. Юнит-тесты
 * склейки этого не видят: они проверяют функцию, а не то, какие куски движок
 * реально получает. Здесь проверяется весь путь.
 */

const RATE = 16000;

// Микрофон: отдаёт PCM нужной длины и умеет «говорить» и «молчать».
const recorderState = {
  durationMs: 0,
  level: 0,
  paused: false,
  onLevel: null,
};

const fakeRecorder = {
  get frames() {
    return Math.round((recorderState.durationMs / 1000) * RATE);
  },
  get sampleRate() {
    return RATE;
  },
  get paused() {
    return recorderState.paused;
  },
  snapshot: ({ fromMs = 0, toMs = 0 } = {}) => {
    const end = toMs > 0 ? Math.min(recorderState.durationMs, toMs) : recorderState.durationMs;
    const durationMs = Math.max(0, end - fromMs);
    return {
      pcm: new Int16Array(Math.round((durationMs / 1000) * RATE)),
      durationMs,
      truncated: false,
    };
  },
  pause() {
    recorderState.paused = true;
  },
  resume() {
    recorderState.paused = false;
  },
  stop() {
    const durationMs = recorderState.durationMs;
    return { pcm: new Int16Array(Math.round((durationMs / 1000) * RATE)), sampleRate: RATE, durationMs };
  },
  abort() {},
};

vi.mock('../audio/pcmRecorder.js', () => ({
  startPcmRecording: async ({ onLevel }) => {
    recorderState.onLevel = onLevel;
    return fakeRecorder;
  },
  default: async () => fakeRecorder,
}));

const calls = [];
let answers = [];

const native = {
  transcribePcm: vi.fn(async (payload) => {
    calls.push(payload);
    const next = answers.shift() || { ok: true, text: '', ms: 10 };
    return { ...next, mode: next.mode || 'server' };
  }),
  cancelTranscribe: vi.fn(async () => true),
  modelsWarm: vi.fn(async () => ({ ok: true })),
};

window.zspeakly = { isElectron: true, native };

const { createRecognizer } = await import('./engine.js');

/**
 * Проиграть речь: level держится, время идёт по 100 мс.
 *
 * Между «отсчётами» отдаём очередь микрозадач — как в жизни: уровни приходят из
 * звукового колбэка, а между ними успевают выполниться промисы движка. Без этого
 * тест проверял бы несуществующую ситуацию, где всё происходит одним куском.
 */
const speak = async (fromMs, toMs, level = 0.5) => {
  for (let t = fromMs; t < toMs; t += 100) {
    recorderState.durationMs = t;
    recorderState.onLevel?.(level);
    await Promise.resolve();
  }
  recorderState.durationMs = toMs;
};

const silence = (fromMs, toMs) => speak(fromMs, toMs, 0);

beforeEach(() => {
  calls.length = 0;
  answers = [];
  recorderState.durationMs = 0;
  recorderState.level = 0;
  recorderState.paused = false;
  native.transcribePcm.mockClear();
});

describe('диктовка целиком: что получает человек', () => {
  it('длинная фраза с паузами не повторяет текст', async () => {
    answers = [
      // первый (разогревающий) проход: учит движок, что сервер прогрет
      { ok: true, text: 'Раз.', ms: 100 },
      // куски и хвост второй диктовки — у каждого свой текст, как в жизни
      { ok: true, text: 'Смотри, мне нужно.', ms: 200 },
      { ok: true, text: 'Сделай программу.', ms: 200 },
      { ok: true, text: 'Всё в автоматическом режиме.', ms: 200 },
    ];

    // первая короткая диктовка: только чтобы запомнить режим «server»
    let recognizer = createRecognizer({ lang: 'ru', onEnd: () => {} });
    await recognizer.start();
    await speak(0, 2000);
    await recognizer.stop();

    // вторая: 14 секунд речи с паузой на 7-й секунде
    const ends = [];
    recognizer = createRecognizer({ lang: 'ru', onEnd: (info) => ends.push(info) });
    await recognizer.start();
    await speak(0, 7000);
    await silence(7000, 8000);
    await speak(8000, 14000);
    await recognizer.stop();
    await new Promise((r) => setTimeout(r, 50));

    expect(ends).toHaveLength(1);
    const text = ends[0].text;
    // Каждое предложение ровно один раз: повтор — это баг, который человек
    // видит в чужом окне как «просто повторы».
    for (const part of ['Смотри, мне нужно.', 'Сделай программу.', 'Всё в автоматическом режиме.']) {
      const count = text.split(part).length - 1;
      expect(count, `«${part}» встречается ${count} раз в «${text}»`).toBe(1);
    }
    // и вставляется один раз — одна запись в истории, одна вставка
    expect(ends[0].spoken).toBeCloseTo(14, 0);
  });

  it('на холодном движке (whisper-cli) запись не режется — иначе загрузка весов на каждый кусок', async () => {
    answers = [{ ok: true, text: 'Раз.', ms: 100, mode: 'cli' }, { ok: true, text: 'Два.', ms: 100, mode: 'cli' }];
    let recognizer = createRecognizer({ lang: 'ru', onEnd: () => {} });
    await recognizer.start();
    await speak(0, 2000);
    await recognizer.stop();
    expect(native.transcribePcm).toHaveBeenCalledTimes(1);

    const ends = [];
    recognizer = createRecognizer({ lang: 'ru', onEnd: (info) => ends.push(info) });
    await recognizer.start();
    await speak(2000, 16000);
    await silence(16000, 17000);
    await recognizer.stop();
    await new Promise((r) => setTimeout(r, 50));

    // один проход по всей записи: никаких предварительных кусков
    expect(native.transcribePcm).toHaveBeenCalledTimes(2);
    expect(ends[0].text).toBe('Два.');
  });

  it('очень короткая запись не уходит в движок вовсе', async () => {
    const errors = [];
    const ends = [];
    const recognizer = createRecognizer({
      lang: 'ru',
      onError: (e) => errors.push(e),
      onEnd: (info) => ends.push(info),
    });
    await recognizer.start();
    await speak(0, 200);
    await recognizer.stop();
    expect(native.transcribePcm).not.toHaveBeenCalled();
    expect(errors[0]?.code).toBe('too-short');
    expect(ends[0].text).toBe('');
  });
});
