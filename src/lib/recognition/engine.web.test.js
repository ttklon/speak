import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let speech;
let createRecognizer;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  delete window.zspeakly;
  window.SpeechRecognition = class {
    constructor() { speech = this; }
    start = vi.fn();
    stop = vi.fn();
    abort = vi.fn();
  };
  ({ createRecognizer } = await import('./engine.js'));
});

afterEach(() => {
  delete window.SpeechRecognition;
  delete window.zspeakly;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
});

function result(text, isFinal) {
  return { resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal })] };
}

describe('браузерный Web Speech: завершение и отмена', () => {
  it('ждёт финального текста после stop, не сообщает о тишине преждевременно и завершает один раз', async () => {
    const onEnd = vi.fn(), onError = vi.fn(), onFinal = vi.fn();
    const rec = createRecognizer({ onEnd, onError, onFinal });
    rec.start(); speech.onstart();
    speech.onresult(result('предварительный текст', false));
    const stopped = rec.stop();
    expect(stopped).toBeInstanceOf(Promise);
    expect(rec.stop()).toBe(stopped);
    expect(speech.stop).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(onEnd).not.toHaveBeenCalled();
    speech.onresult(result('готовый текст', true));
    speech.onend();
    expect(await stopped).toMatchObject({ text: 'готовый текст' });
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledWith({ text: 'готовый текст' });
    speech.onresult(result('слишком поздно', true)); speech.onend();
    expect(onFinal).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('молчание сообщает об отсутствии речи после onend, а не до него', async () => {
    const onError = vi.fn(), onEnd = vi.fn();
    const rec = createRecognizer({ onError, onEnd });
    rec.start(); speech.onstart();
    const stopped = rec.stop();
    expect(onError).not.toHaveBeenCalled();
    speech.onend();
    expect(await stopped).toMatchObject({ text: '' });
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'no-speech' }));
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('отмена при ожидании результата закрывает таймеры и игнорирует поздние события', async () => {
    const onError = vi.fn(), onEnd = vi.fn(), onFinal = vi.fn();
    const rec = createRecognizer({ onError, onEnd, onFinal });
    rec.start(); speech.onstart();
    const stopped = rec.stop();
    rec.abort();
    expect(await stopped).toMatchObject({ code: 'cancelled', text: '' });
    speech.onresult(result('не вставлять', true)); speech.onend(); speech.onerror({ error: 'network' });
    await vi.advanceTimersByTimeAsync(10000);
    expect(speech.abort).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled(); expect(onEnd).not.toHaveBeenCalled(); expect(onFinal).not.toHaveBeenCalled();
  });

  it('отмена до onstart не запускает сторож и не выдаёт ошибку сети', async () => {
    const onError = vi.fn(), onEnd = vi.fn(), onStart = vi.fn();
    const rec = createRecognizer({ onError, onEnd, onStart });
    rec.start(); rec.abort();
    speech.onstart(); speech.onend();
    await vi.advanceTimersByTimeAsync(10000);
    expect(onError).not.toHaveBeenCalled(); expect(onEnd).not.toHaveBeenCalled(); expect(onStart).not.toHaveBeenCalled();
  });

  it('если браузер остановился и не может перезапуститься, не оставляет запись висеть', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onError = vi.fn(), onEnd = vi.fn();
    const rec = createRecognizer({ onError, onEnd });
    rec.start(); speech.onstart();
    speech.start.mockImplementationOnce(() => { throw new Error('not available'); });
    speech.onend();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'web-unavailable' }));
    expect(onEnd).toHaveBeenCalledWith({ text: '' });
  });

  it('если stop выбрасывает ошибку при запуске, закрывает движок сразу', async () => {
    const onError = vi.fn(), onEnd = vi.fn();
    const rec = createRecognizer({ onError, onEnd });
    rec.start();
    speech.stop.mockImplementationOnce(() => { throw new Error('invalid state'); });
    const stopped = rec.stop();
    expect(await stopped).toMatchObject({ text: '' });
    expect(speech.abort).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'web-stop-failed' }));
    expect(onEnd).toHaveBeenCalledWith({ text: '' });
    speech.onstart(); speech.onresult(result('поздно', true)); speech.onend();
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('таймаут без финала сообщает о сбое, но не сохраняет черновик', async () => {
    const onError = vi.fn(), onEnd = vi.fn();
    const rec = createRecognizer({ onError, onEnd });
    rec.start(); speech.onstart();
    speech.onresult(result('черновик', false));
    const stopped = rec.stop();
    await vi.advanceTimersByTimeAsync(5001);
    expect(await stopped).toMatchObject({ text: '' });
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'web-stop-timeout' }));
    expect(onEnd).toHaveBeenCalledWith({ text: '' });
    expect(speech.abort).toHaveBeenCalledTimes(1);
  });

  it('если onend не приходит, ограничивает ожидание и сохраняет только подтверждённые слова', async () => {
    const onError = vi.fn(), onEnd = vi.fn(), onNotice = vi.fn();
    const rec = createRecognizer({ onError, onEnd, onNotice });
    rec.start(); speech.onstart();
    speech.onresult(result('подтверждено', true));
    speech.onresult(result('не подтверждено', false));
    const stopped = rec.stop();
    await vi.advanceTimersByTimeAsync(5001);
    expect(await stopped).toMatchObject({ text: 'подтверждено' });
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onNotice).toHaveBeenCalledWith(expect.objectContaining({ title: 'Браузер не завершил распознавание' }));
    expect(onError).not.toHaveBeenCalled();
    expect(speech.abort).toHaveBeenCalledTimes(1);
    speech.onresult(result('поздно', true)); speech.onend();
    expect(onEnd).toHaveBeenCalledTimes(1);
  });
});
