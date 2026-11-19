import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

// Модуль живёт в main-процессе (CommonJS): там же его читает main.cjs.
const require = createRequire(import.meta.url);
const {
  ADAPTIVE_WINDOW,
  SLOW_FACTOR,
  THOROUGH_FACTOR,
  averageFactor,
  decodePlan,
  realtimeFactor,
} = require('../../electron/adaptiveDecode.cjs');

describe('realtimeFactor', () => {
  it('считает, во сколько раз проход дольше записи', () => {
    expect(realtimeFactor(2000, 4)).toBe(0.5);
    expect(realtimeFactor(8000, 4)).toBe(2);
  });

  it('на мусоре возвращает null, а не NaN', () => {
    expect(realtimeFactor(0, 4)).toBe(null);
    expect(realtimeFactor(1000, 0)).toBe(null);
    expect(realtimeFactor(undefined, undefined)).toBe(null);
  });
});

describe('averageFactor', () => {
  it('усредняет только последние проходы', () => {
    const passes = [
      { ms: 30000, seconds: 1 }, // старый, медленный — не должен влиять
      ...Array.from({ length: ADAPTIVE_WINDOW }, () => ({ ms: 500, seconds: 1 })),
    ];
    expect(averageFactor(passes)).toBe(0.5);
  });

  it('без валидных замеров — null', () => {
    expect(averageFactor([])).toBe(null);
    expect(averageFactor([{ ms: 0, seconds: 3 }])).toBe(null);
  });
});

describe('decodePlan', () => {
  it('первый раз в сессии не рискует временем', () => {
    const plan = decodePlan([], { seconds: 5 });
    expect(plan.thorough).toBe(false);
    expect(plan.reason).toMatch(/нет замеров/);
  });

  it('на быстрой машине сразу считает честно', () => {
    const passes = [
      { ms: 1500, seconds: 5 },
      { ms: 1200, seconds: 4 },
    ];
    const plan = decodePlan(passes, { seconds: 6 });
    expect(plan.thorough).toBe(true);
    expect(plan.factor).toBeLessThanOrEqual(THOROUGH_FACTOR);
    expect(plan.reason).toMatch(/успевает/);
  });

  it('на слабой машине остаётся быстрый путь', () => {
    const passes = [
      { ms: 9000, seconds: 10 },
      { ms: 8000, seconds: 9 },
    ];
    const plan = decodePlan(passes, { seconds: 6 });
    expect(plan.thorough).toBe(false);
    expect(plan.slow).toBe(false); // 0,9 с на секунду речи — успевает, но впритык
  });

  it('на пределе честно говорит, что движку тяжело', () => {
    const passes = [
      { ms: 12000, seconds: 4 },
      { ms: 10000, seconds: 4 },
    ];
    const plan = decodePlan(passes, { seconds: 5 });
    expect(plan.slow).toBe(true);
    expect(plan.factor).toBeGreaterThan(SLOW_FACTOR);
    expect(plan.reason).toMatch(/второй — только/);
  });

  it('одного замера мало: ждём второй', () => {
    expect(decodePlan([{ ms: 500, seconds: 5 }], { seconds: 3 }).thorough).toBe(false);
  });

  it('«Точно» сильнее замеров: честный проход даже на медленной машине', () => {
    const passes = [
      { ms: 4000, seconds: 2 },
      { ms: 4200, seconds: 2 },
    ];
    const plan = decodePlan(passes, { seconds: 2, mode: 'accurate' });
    expect(plan.thorough).toBe(true);
    expect(plan.mode).toBe('accurate');
    expect(plan.reason).toMatch(/Точно/);
    // замеры никуда не деваются: их всё ещё показываем в интерфейсе
    expect(plan.factor).toBeGreaterThan(1.9);
  });

  it('«Точно» не платит за замеры, даже когда их нет', () => {
    expect(decodePlan([], { seconds: 3, mode: 'accurate' }).thorough).toBe(true);
  });

  it('«Быстро» не делает честный проход, даже если машина быстрая', () => {
    const passes = [
      { ms: 500, seconds: 4 },
      { ms: 600, seconds: 4 },
    ];
    const plan = decodePlan(passes, { seconds: 3, mode: 'fast' });
    expect(plan.thorough).toBe(false);
    expect(plan.skipRetry).toBe(true);
    expect(plan.reason).toMatch(/Быстро/);
  });

  it('«Авто» остаётся прежним: решают замеры', () => {
    const passes = [
      { ms: 500, seconds: 4 },
      { ms: 600, seconds: 4 },
    ];
    const plan = decodePlan(passes, { seconds: 3, mode: 'auto' });
    expect(plan.mode).toBe('auto');
    expect(plan.thorough).toBe(true);
    expect(plan.skipRetry).toBe(false);
  });

  it('незнакомый режим — это «Авто», а не поломка', () => {
    expect(decodePlan([{ ms: 500, seconds: 4 }], { seconds: 3, mode: 'турбо' }).mode).toBe('auto');
  });

  it('короткие записи не ломают расчёт', () => {
    const passes = [
      { ms: 500, seconds: 0 }, // запись без длительности — мимо
      { ms: 700, seconds: 2 },
    ];
    const plan = decodePlan(passes, { seconds: 1 });
    expect(plan.factor).toBeCloseTo(0.35, 2);
    // одного валидного замера мало — остаёмся на быстром проходе
    expect(plan.thorough).toBe(false);
  });
});
