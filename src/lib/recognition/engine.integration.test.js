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
  startGate: null,
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
  abort: vi.fn(),
};

vi.mock('../audio/pcmRecorder.js', () => ({
  startPcmRecording: async ({ onLevel }) => {
    recorderState.onLevel = onLevel;
    if (recorderState.startGate) await recorderState.startGate;
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

const { createRecognizer, lastRecordedAudio } = await import('./engine.js');

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
  recorderState.startGate = null;
  fakeRecorder.abort.mockClear();
  native.transcribePcm.mockClear();
  native.cancelTranscribe.mockClear();
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

  it('граница предварительного куска не удаляет отрицание из следующего', async () => {
    answers = [{ ok: true, text: 'Прогрев.', mode: 'server' }];
    const warm = createRecognizer(); await warm.start(); await speak(0, 2000); await warm.stop();
    calls.length = 0;
    answers = [{ ok: true, text: 'Кнопка на машине', mode: 'server' }, { ok: true, text: 'не нажимайте', mode: 'server' }];
    const end = vi.fn(); const recognizer = createRecognizer({ onEnd: end });
    await recognizer.start(); await speak(0, 7000); await silence(7000, 8000);
    await speak(8000, 9000); await recognizer.stop();
    expect(calls.some((call) => call.pre === true)).toBe(true);
    expect(end).toHaveBeenCalledWith(expect.objectContaining({ text: 'Кнопка на машине не нажимайте' }));
  });

  it('режим сохранения текста не вырезает длинное совпадение при склейке куска и хвоста', async () => {
    answers = [{ ok: true, text: 'Прогрев.', mode: 'server' }];
    const warm = createRecognizer(); await warm.start(); await speak(0, 2000); await warm.stop();
    calls.length = 0;
    answers = [{ ok: true, text: 'проверка один два три', mode: 'server' }, { ok: true, text: 'один два три готово', mode: 'server' }];
    const end = vi.fn(); const recognizer = createRecognizer({ preserveText: true, onEnd: end });
    await recognizer.start(); await speak(0, 7000); await silence(7000, 8000);
    await speak(8000, 9000); await recognizer.stop();
    expect(calls.some((call) => call.pre === true)).toBe(true);
    expect(end).toHaveBeenCalledWith(expect.objectContaining({ text: 'проверка один два три один два три готово' }));
  });

  it('язык берётся из активного окна один раз и не меняется посреди фразы', async () => {
    // Окно узнаётся через доли секунды после старта, а первый проход движка
    // бывает позже. Язык решается при первом обращении — и дальше заморожен:
    // иначе куски одной фразы ушли бы в движок на разных языках.
    answers = [{ ok: true, text: 'Раз.', ms: 50 }];
    const getLang = vi.fn(() => 'en');
    const recognizer = createRecognizer({ lang: 'ru', getLang, onEnd: () => {} });
    await recognizer.start();
    await speak(0, 2000);
    await recognizer.stop();
    expect(getLang).toHaveBeenCalledTimes(1);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.lang === 'en')).toBe(true);
  });

  it('если правило языка сломалось, остаётся общий язык настроек', async () => {
    answers = [{ ok: true, text: 'Раз.', ms: 50 }];
    const recognizer = createRecognizer({
      lang: 'ru',
      getLang: () => {
        throw new Error('окно не ответило');
      },
      onEnd: () => {},
    });
    await recognizer.start();
    await speak(0, 2000);
    await recognizer.stop();
    expect(calls.every((c) => c.lang === 'ru')).toBe(true);
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

  it('ошибка предварительного куска не пропускает звук, пока второй кусок ждёт очередь', async () => {
    answers = [{ ok: true, text: 'Прогрев.', mode: 'server' }];
    const warm = createRecognizer(); await warm.start(); await speak(0, 2000); await warm.stop();
    calls.length = 0;
    let rejectFirst;
    native.transcribePcm.mockImplementationOnce((payload) => { calls.push(payload); return new Promise((_, reject) => { rejectFirst = reject; }); });
    answers = [{ ok: true, text: 'Вся исходная запись.', mode: 'server' }];
    const end = vi.fn(); const recognizer = createRecognizer({ onEnd: end });
    await recognizer.start(); await speak(0, 7000); await silence(7000, 8000);
    await speak(8000, 15000); await silence(15000, 16000);
    expect(calls).toHaveLength(1);
    rejectFirst(new Error('движок сломался'));
    for (let i = 0; i < 15; i++) await Promise.resolve();
    expect(calls).toHaveLength(1);
    await recognizer.stop();
    expect(calls).toHaveLength(2);
    expect(calls[1].pre).toBeUndefined();
    expect(calls[1].pcm.length).toBe(16000 * 16);
    expect(end).toHaveBeenCalledWith(expect.objectContaining({ text: 'Вся исходная запись.' }));
  });

  it('таймаут предварительного куска отправляет весь неподтверждённый звук в финал', async () => {
    answers = [{ ok: true, text: 'Прогрев.', mode: 'server' }];
    const warm = createRecognizer(); await warm.start(); await speak(0, 2000); await warm.stop();
    calls.length = 0;
    let resolvePre;
    native.transcribePcm.mockImplementationOnce((payload) => { calls.push(payload); return new Promise((resolve) => { resolvePre = resolve; }); });
    answers = [{ ok: true, text: 'Полный итог.', mode: 'server' }];
    const end = vi.fn(); const recognizer = createRecognizer({ onEnd: end });
    await recognizer.start(); await speak(0, 7000); await silence(7000, 8000); await speak(8000, 11000);
    expect(resolvePre).toBeTypeOf('function');
    vi.useFakeTimers();
    try {
      const stopping = recognizer.stop();
      await vi.advanceTimersByTimeAsync(6001);
      expect(await stopping).toMatchObject({ text: 'Полный итог.' });
      expect(calls).toHaveLength(2);
      expect(calls[1].pcm.length).toBe(16000 * 11);
      resolvePre({ ok: true, text: 'слишком поздний результат', mode: 'server' });
      await Promise.resolve(); await Promise.resolve();
      expect(end).toHaveBeenCalledTimes(1);
      expect(end).toHaveBeenCalledWith(expect.objectContaining({ text: 'Полный итог.' }));
    } finally { vi.useRealTimers(); }
  });

  it('при таймауте второго куска сохраняет первый и досчитывает хвост с перекрытием', async () => {
    answers = [{ ok: true, text: 'Прогрев.', mode: 'server' }];
    const warm = createRecognizer(); await warm.start(); await speak(0, 2000); await warm.stop();
    calls.length = 0;
    let resolveSecond;
    native.transcribePcm
      .mockImplementationOnce(async (payload) => { calls.push(payload); return { ok: true, text: 'Начало.', mode: 'server' }; })
      .mockImplementationOnce((payload) => { calls.push(payload); return new Promise((resolve) => { resolveSecond = resolve; }); });
    answers = [{ ok: true, text: 'Продолжение.', mode: 'server' }];
    const recognizer = createRecognizer(); await recognizer.start();
    await speak(0, 7000); await silence(7000, 8000); await speak(8000, 15000); await silence(15000, 16000);
    expect(resolveSecond).toBeTypeOf('function');
    vi.useFakeTimers();
    try {
      const stopping = recognizer.stop(); await vi.advanceTimersByTimeAsync(6001);
      expect(await stopping).toMatchObject({ text: 'Начало. Продолжение.' });
      const expectedMs = 16000 - Math.max(0, calls[0].durationMs - 400);
      expect(calls[2].pcm.length).toBe(Math.round(expectedMs * 16));
      resolveSecond({ ok: true, text: 'слишком поздно' });
      await Promise.resolve();
    } finally { vi.useRealTimers(); }
  });

  it('стоп во время открытия микрофона сразу завершает запись и закрывает поздний поток', async () => {
    let allow;
    recorderState.startGate = new Promise((resolve) => { allow = resolve; });
    const started = vi.fn(), error = vi.fn(), end = vi.fn();
    const recognizer = createRecognizer({ onStart: started, onError: error, onEnd: end });
    const opening = recognizer.start();
    expect(await recognizer.stop()).toMatchObject({ text: '' });
    await recognizer.stop();
    allow();
    await opening;
    expect(fakeRecorder.abort).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ code: 'mic-not-ready' }));
    expect(started).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
    expect(native.transcribePcm).not.toHaveBeenCalled();
  });

  it('ошибка разрешения после стопа не показывает устаревшую ошибку', async () => {
    let reject;
    recorderState.startGate = new Promise((_, fail) => { reject = fail; });
    const error = vi.fn();
    const recognizer = createRecognizer({ onError: error });
    const opening = recognizer.start();
    await recognizer.stop();
    const denial = new Error('access denied');
    denial.name = 'NotAllowedError';
    reject(denial);
    await opening;
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ code: 'mic-not-ready' }));
  });

  it('отмена во время запроса микрофона закрывает полученный позже рекордер', async () => {
    let allow; recorderState.startGate = new Promise((resolve) => { allow = resolve; });
    const started = vi.fn(), error = vi.fn();
    const recognizer = createRecognizer({ onStart: started, onError: error });
    const opening = recognizer.start(); recognizer.abort(); allow(); await opening;
    expect(fakeRecorder.abort).toHaveBeenCalledTimes(1);
    expect(started).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
  });

  it('не добавляет звук после остановки во время ожидания отмены движка', async () => {
    let finishCancel;
    native.cancelTranscribe.mockImplementationOnce(() => new Promise((resolve) => { finishCancel = resolve; }));
    answers = [{ ok: true, text: 'До остановки.', mode: 'cli' }];
    const recognizer = createRecognizer();
    await recognizer.start(); await speak(0, 2000);
    const stopping = recognizer.stop();
    for (let i = 0; i < 10 && !finishCancel; i++) await Promise.resolve();
    expect(finishCancel).toBeTypeOf('function');
    await speak(2000, 5000);
    finishCancel(true);
    expect(await stopping).toMatchObject({ text: 'До остановки.' });
    expect(calls).toHaveLength(1);
    expect(calls[0].pcm.length).toBe(16000 * 2);
    expect(calls[0].durationMs).toBe(2000);
  });

  it('не добавляет звук после остановки во время ожидания предварительного куска', async () => {
    answers = [{ ok: true, text: 'Прогрев.', mode: 'server' }];
    const warm = createRecognizer(); await warm.start(); await speak(0, 2000); await warm.stop();
    calls.length = 0;
    let finishPre;
    native.transcribePcm.mockImplementationOnce((payload) => { calls.push(payload); return new Promise((resolve) => { finishPre = resolve; }); });
    answers = [{ ok: true, text: 'Остаток.', mode: 'server' }];
    const recognizer = createRecognizer();
    await recognizer.start(); await speak(0, 7000); await silence(7000, 8000);
    expect(finishPre).toBeTypeOf('function');
    const stopping = recognizer.stop();
    await speak(8000, 11000);
    finishPre({ ok: true, text: 'Начало.', mode: 'server' });
    await stopping;
    expect(calls).toHaveLength(2);
    const expectedMs = 8000 - Math.max(0, calls[0].durationMs - 400);
    expect(calls[1].pcm.length).toBe(Math.round(expectedMs * 16));
  });

  it('отмена при ожидании предварительного куска не запускает итоговый проход', async () => {
    answers = [{ ok: true, text: 'Прогрев.', mode: 'server' }];
    const warm = createRecognizer(); await warm.start(); await speak(0, 2000); await warm.stop();
    calls.length = 0;
    let finishPre;
    native.transcribePcm.mockImplementationOnce((payload) => { calls.push(payload); return new Promise((resolve) => { finishPre = resolve; }); });
    const final = vi.fn(), end = vi.fn(); const recognizer = createRecognizer({ onFinal: final, onEnd: end });
    await recognizer.start(); await speak(0, 7000); await silence(7000, 8000);
    expect(finishPre).toBeTypeOf('function');
    const stopping = recognizer.stop(); recognizer.abort();
    let timer;
    const result = await Promise.race([stopping, new Promise((resolve) => { timer = setTimeout(() => resolve({ code: 'stuck' }), 500); })]);
    clearTimeout(timer);
    expect(result).toMatchObject({ text: '', code: 'cancelled' });
    finishPre({ ok: true, text: 'отменено' });
    await Promise.resolve();
    expect(calls).toHaveLength(1); expect(final).not.toHaveBeenCalled(); expect(end).not.toHaveBeenCalled();
  });

  it('после отмены ожидающий итоговый ответ не вызывает onFinal и onEnd', async () => {
    const previousAudio = lastRecordedAudio();
    let resolveFinal;
    native.transcribePcm.mockImplementationOnce((payload) => { calls.push(payload); return new Promise((resolve) => { resolveFinal = resolve; }); });
    const end = vi.fn(), final = vi.fn(), error = vi.fn();
    const recognizer = createRecognizer({ onEnd: end, onFinal: final, onError: error });
    await recognizer.start(); await speak(0, 2000);
    const stopping = recognizer.stop();
    for (let i = 0; i < 10 && !resolveFinal; i++) await Promise.resolve();
    expect(resolveFinal).toBeTypeOf('function');
    recognizer.abort();
    let timer;
    const result = await Promise.race([stopping, new Promise((resolve) => { timer = setTimeout(() => resolve({ code: 'stuck' }), 500); })]);
    clearTimeout(timer);
    expect(result).toMatchObject({ text: '', code: 'cancelled' });
    resolveFinal({ ok: true, text: 'не вставлять', mode: 'server' });
    await Promise.resolve();
    expect(final).not.toHaveBeenCalled(); expect(end).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
    expect(lastRecordedAudio()).toBe(previousAudio);
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
