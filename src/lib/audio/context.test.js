import { describe, it, expect, vi } from 'vitest';
import { TARGET_RATE, resampleAudio, createAudioContext } from './context.js';

/** Синус заданной частоты: 1 секунда при rate. */
function tone(freq, rate, seconds = 1, amp = 0.5) {
  const out = new Float32Array(Math.round(rate * seconds));
  for (let i = 0; i < out.length; i += 1) {
    out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  }
  return out;
}

function peak(float32) {
  let max = 0;
  for (let i = 0; i < float32.length; i += 1) max = Math.max(max, Math.abs(float32[i]));
  return max;
}

describe('ресемплинг звука для whisper', () => {
  it('48 кГц → 16 кГц меняет длину ровно втрое', () => {
    const input = tone(300, 48000, 1);
    const out = resampleAudio(input, 48000, TARGET_RATE);
    expect(out.length).toBe(Math.floor(input.length / 3));
  });

  it('речь в полосе 300–3000 Гц проходит без потерь', () => {
    for (const freq of [300, 1000, 3000]) {
      const out = resampleAudio(tone(freq, 48000, 1), 48000, TARGET_RATE);
      // амплитуда сохраняется: 0.5 на входе, не меньше 0.4 на выходе
      expect(peak(out.slice(200, out.length - 200))).toBeGreaterThan(0.4);
    }
  });

  it('частоты выше новой половины Найквиста гасятся, а не отражаются в речь', () => {
    // 12 кГц при 16 кГц не существует: без фильтра оно «сложится» в 4 кГц
    // с полной амплитудой — это и есть тот шум, от которого текст становится
    // кашей. С фильтром остаётся меньше десятой части.
    const out = resampleAudio(tone(12000, 48000, 1), 48000, TARGET_RATE);
    expect(peak(out.slice(500, out.length - 500))).toBeLessThan(0.05);
  });

  it('тишина остаётся тишиной, а мусор не ломает расчёт', () => {
    expect(peak(resampleAudio(new Float32Array(4800), 48000, TARGET_RATE))).toBe(0);
    expect(resampleAudio(null, 48000, TARGET_RATE)).toBe(null);
    expect(resampleAudio(new Float32Array(0), 48000, TARGET_RATE)).toBeInstanceOf(Float32Array);
  });

  it('одинаковая частота — тот же массив, без лишней работы', () => {
    const input = tone(440, 16000, 0.5);
    expect(resampleAudio(input, 16000, 16000)).toBe(input);
  });
});

describe('выбор частоты микрофона', () => {
  it('если браузер даёт 16 кГц — берём его, ресемплить не нужно', () => {
    const close = vi.fn();
    class Ctx {
      constructor(opts) {
        this.sampleRate = opts?.sampleRate || 48000;
      }
      close() {
        close();
      }
    }
    const { ctx, native } = createAudioContext(Ctx);
    expect(native).toBe(true);
    expect(ctx.sampleRate).toBe(TARGET_RATE);
    expect(close).not.toHaveBeenCalled();
  });

  it('если 16 кГц не дали — открываем обычную и ресемплим сами', () => {
    class Ctx {
      constructor() {
        this.sampleRate = 48000;
      }
      close() {}
    }
    const { ctx, native } = createAudioContext(Ctx);
    expect(native).toBe(false);
    expect(ctx.sampleRate).toBe(48000);
  });

  it('при неподдержанной частоте обрабатывает асинхронный отказ закрытия первого контекста', async () => {
    const closed = Promise.reject(new Error('закрытие не удалось'));
    const caught = vi.spyOn(closed, 'catch');
    class Ctx {
      constructor() { this.sampleRate = 48000; }
      close() { return closed; }
    }
    const result = createAudioContext(Ctx);
    expect(result.native).toBe(false);
    expect(caught).toHaveBeenCalledTimes(1);
    await expect(closed).rejects.toThrow('закрытие не удалось');
  });

  it('без AudioContext ничего не падает', () => {
    expect(createAudioContext(null)).toEqual({ ctx: null, native: false });
  });
});
