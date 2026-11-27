import { describe, it, expect, vi } from 'vitest';
import { typeOut, playCue } from './feedback.js';

describe('эффект печати', () => {
  it('выдаёт текст по частям и заканчивает полным текстом', async () => {
    vi.useFakeTimers();
    const seen = [];
    const promise = typeOut('раз два три четыре', (partial) => seen.push(partial), { stepMs: 5 });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe('раз два три четыре');
    expect(seen.at(-1)).toBe('раз два три четыре');
    expect(seen.length).toBeGreaterThan(1);
    expect(seen[0]).not.toBe('раз два три четыре');
    vi.useRealTimers();
  });

  it('пустой текст — сразу готово, без тиков', async () => {
    const onTick = vi.fn();
    await expect(typeOut('', onTick)).resolves.toBe('');
    await expect(typeOut('   ', onTick)).resolves.toBe('   ');
    expect(onTick).not.toHaveBeenCalled();
  });

  it('отмена возвращает полный текст, а не обрывок', async () => {
    vi.useFakeTimers();
    const seen = [];
    const controller = new AbortController();
    const promise = typeOut('альфа бета гамма дельта', (p) => {
      seen.push(p);
      controller.abort();
    }, { stepMs: 5, signal: controller.signal });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe('альфа бета гамма дельта');
    expect(seen).toHaveLength(1);
    vi.useRealTimers();
  });
});

describe('звуковой отклик', () => {
  it('без WebAudio не падает (тихий пропуск)', () => {
    expect(() => playCue('start')).not.toThrow();
    expect(() => playCue('stop')).not.toThrow();
    expect(() => playCue('error')).not.toThrow();
    expect(() => playCue()).not.toThrow();
  });
});
