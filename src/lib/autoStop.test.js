import { describe, expect, it } from 'vitest';
import {
  AUTO_STOP_IDLE_MS,
  AUTO_STOP_LEVEL,
  autoStopNotice,
  createSilenceWatch,
} from './autoStop.js';

describe('авто-стоп по тишине', () => {
  it('двадцать секунд тишины — стоп, девятнадцать — ещё нет', () => {
    const w = createSilenceWatch({ now: 0 });
    expect(w.feed(0, 19000)).toBe(false);
    expect(w.feed(0, 20000)).toBe(true);
  });

  it('речь сбрасывает отсчёт: пауза между фразами не завершает диктовку', () => {
    const w = createSilenceWatch({ now: 0 });
    expect(w.feed(0.4, 15000)).toBe(false);
    expect(w.feed(0, 30000)).toBe(false); // 15 с тишины после речи
    expect(w.feed(0, 34999)).toBe(false);
    expect(w.feed(0, 35000)).toBe(true);
  });

  it('шёпот и «громкая» комната различаются порогом', () => {
    expect(AUTO_STOP_LEVEL).toBeGreaterThan(0);
    const w = createSilenceWatch({ now: 0 });
    // чуть выше порога — это ещё речь
    expect(w.feed(AUTO_STOP_LEVEL + 0.001, 25000)).toBe(false);
    expect(w.silentFor(25000)).toBe(0);
  });

  it('пауза записи не считается тишиной: сброс после resume', () => {
    const w = createSilenceWatch({ now: 0 });
    expect(w.feed(0, 19000)).toBe(false);
    w.reset(60000); // человек снял с паузы
    expect(w.feed(0, 70000)).toBe(false);
    expect(w.feed(0, 80000)).toBe(true);
  });

  it('без времени не падает и не останавливает', () => {
    const w = createSilenceWatch({ now: 0 });
    expect(w.feed(0, undefined)).toBe(false);
    expect(w.feed(0, NaN)).toBe(false);
  });

  it('порог и задержка настраиваются, по умолчанию — двадцать секунд', () => {
    expect(AUTO_STOP_IDLE_MS).toBe(20000);
    const w = createSilenceWatch({ idleMs: 1000, threshold: 0.5, now: 0 });
    expect(w.feed(0.2, 1200)).toBe(true);
    expect(w.feed(0.9, 5000)).toBe(false);
  });

  it('сообщение объясняет, что случилось, а не молчит', () => {
    expect(autoStopNotice()).toMatch(/20 секунд тишины/);
    expect(autoStopNotice(5000)).toMatch(/5 секунд тишины/);
    expect(autoStopNotice()).toMatch(/уже расшифровано/);
  });
});
