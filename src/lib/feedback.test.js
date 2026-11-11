import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { playCue, typeOut } from './feedback.js';

/** Поддельный WebAudio: считаем, какие сигналы и с какой частотой запросили. */
function installAudioMock() {
  const started = [];
  const ctx = {
    state: 'running',
    currentTime: 0,
    destination: { name: 'destination' },
    resume: vi.fn(() => Promise.resolve()),
    createOscillator: () => {
      const osc = {
        type: 'sine',
        frequency: {
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn(),
        },
        connect: () => ({ connect: () => {} }),
        start: () => started.push(osc.frequency.setValueAtTime.mock.calls[0][0]),
        stop: vi.fn(),
      };
      return osc;
    },
    createGain: () => ({
      gain: {
        setValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
      },
      connect: () => ({ connect: () => {} }),
    }),
  };
  window.AudioContext = function AudioContext() {
    return ctx;
  };
  return started;
}

describe('звуковой отклик', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    delete window.AudioContext;
  });

  it('старт и остановка звучат по-разному', async () => {
    const started = installAudioMock();
    const { playCue: cue } = await import('./feedback.js');
    cue('start');
    cue('stop');
    cue('error');
    expect(started).toEqual([660, 440, 220]);
  });

  it('без WebAudio молчит, а не падает', async () => {
    delete window.AudioContext;
    const { playCue: cue } = await import('./feedback.js');
    expect(() => cue('start')).not.toThrow();
  });
});

describe('эффект печати', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('допечатывает текст по частям и заканчивается полным', async () => {
    const seen = [];
    const promise = typeOut('раз два три четыре', (part) => seen.push(part), { stepMs: 10 });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe('раз два три четыре');
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.at(-1)).toBe('раз два три четыре');
    expect(seen[0].trim()).toBe('раз два');
  });

  it('отмена возвращает полный текст и больше не зовёт onTick', async () => {
    const controller = new AbortController();
    const ticks = [];
    const promise = typeOut('раз два три четыре пять', (p) => {
      ticks.push(p);
      controller.abort();
    }, { stepMs: 10, signal: controller.signal });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe('раз два три четыре пять');
    // после отмены печать прекращается, но текст отдаётся целиком
    expect(ticks.length).toBe(1);
  });

  it('пустой текст не печатает ничего', async () => {
    const ticks = [];
    await expect(typeOut('   ', (p) => ticks.push(p))).resolves.toBe('   ');
    expect(ticks).toEqual([]);
  });
});
