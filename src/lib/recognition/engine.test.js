/**
 * Движок распознавания: никаких выдуманных текстов.
 *
 * Приложение честно говорит, что распознавать нечем, если в браузере нет
 * Web Speech, а whisper.cpp доступен только в Electron-сборке.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRecognizer, engineName } from './engine.js';

afterEach(() => {
  delete window.SpeechRecognition;
  delete window.webkitSpeechRecognition;
  delete window.zspeakly;
  vi.resetModules();
});

describe('без движка распознавания', () => {
  it('имя движка не притворяется демо-режимом', () => {
    expect(engineName()).toBe('распознавание недоступно');
  });

  it('старт честно сообщает, что распознавание недоступно', async () => {
    const onError = vi.fn();
    const onEnd = vi.fn();
    const rec = createRecognizer({ lang: 'ru-RU', onError, onEnd });
    expect(rec.kind).toBe('unavailable');
    const err = rec.start();
    expect(err?.code).toBe('engine-missing');
    expect(err?.title).toBe('Распознавание недоступно');
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'engine-missing' }));
    // заглушки с придуманным текстом больше нет
    expect(rec.stop().text).toBe('');
    expect(rec.text).toBe('');
    await new Promise((r) => setTimeout(r, 340));
    expect(onEnd).toHaveBeenCalledWith({ text: '' });
  });

  it('в подсказке для браузера говорится, что офлайн — только в приложении', () => {
    const rec = createRecognizer({});
    const err = rec.start();
    expect(String(err.hint)).toMatch(/Web Speech/);
    expect(String(err.hint)).toMatch(/Windows/);
  });
});
