import { describe, expect, it, vi, afterEach } from 'vitest';
import { MAX_CONTEXT_CHARS, describeScreen, mergePromptParts } from './vision.js';

afterEach(() => {
  vi.unstubAllGlobals();
  delete globalThis.window;
});

describe('контекст экрана', () => {
  it('склеивает подсказки без дублей и сохраняет порядок', () => {
    expect(mergePromptParts('Алтайтара, ZSpeakly', 'ZSpeakly, whisper', '')).toBe(
      'Алтайтара, ZSpeakly, whisper',
    );
  });

  it('не раздувает подсказку сверх лимита', () => {
    const long = Array.from({ length: 80 }, (_, i) => `термин-${i}`).join(', ');
    expect(mergePromptParts(long).length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS + 200);
  });

  it('без моста в браузере честно говорит, что модель недоступна', async () => {
    globalThis.window = {};
    const res = await describeScreen('data:image/png;base64,AAA', { endpoint: 'http://localhost:11434' });
    expect(res.ok).toBe(false);
    expect(res.terms).toBe('');
    expect(res.reason).toMatch(/приложении/i);
  });

  it('без адреса модели кадр не отправляется', async () => {
    const httpPost = vi.fn();
    globalThis.window = { zspeakly: { native: { httpPost } } };
    const res = await describeScreen('data:image/png;base64,AAA', {});
    expect(res.ok).toBe(false);
    expect(httpPost).not.toHaveBeenCalled();
  });

  it('разбирает ответ модели в список терминов', async () => {
    globalThis.window = {
      zspeakly: {
        native: {
          httpPost: async () => ({ ok: true, status: 200, data: { response: 'Алтайтара, whisper.cpp\nООО «Ромашка»' } }),
        },
      },
    };
    const res = await describeScreen('data:image/png;base64,AAA', {
      endpoint: 'http://localhost:11434/',
      model: 'llava',
    });
    expect(res.ok).toBe(true);
    expect(res.terms).toContain('Алтайтара');
    expect(res.terms).toContain('whisper.cpp');
  });

  it('модель без поддержки изображений — это не сбой диктовки', async () => {
    globalThis.window = {
      zspeakly: { native: { httpPost: async () => ({ ok: false, status: 400 }) } },
    };
    const res = await describeScreen('data:image/png;base64,AAA', {
      endpoint: 'http://localhost:11434',
      model: 'qwen2.5:0.5b',
    });
    expect(res.ok).toBe(false);
    expect(res.recommendedNothing).toBeUndefined();
    expect(res.reason).toMatch(/не принимает изображения/);
  });
});
