import { describe, it, expect } from 'vitest';
import { createPolishGate, DEFAULT_BUDGET_MS } from './polishGate.js';

describe('бюджет ожидания полировки', () => {
  it('в начале ждём обычный бюджет', () => {
    const gate = createPolishGate();
    expect(gate.budget).toBe(DEFAULT_BUDGET_MS);
    expect(gate.skipping).toBe(false);
  });

  it('одна неудача — ещё ждём: модель могла просто не успеть один раз', () => {
    const gate = createPolishGate({ budgetMs: 500 });
    gate.record({ timedOut: true, ms: 500 });
    expect(gate.budget).toBe(500);
  });

  it('две неудачи подряд — больше не ждём, текст вставляется сразу', () => {
    const gate = createPolishGate({ budgetMs: 500 });
    gate.record({ timedOut: true });
    gate.record({ timedOut: true });
    expect(gate.skipping).toBe(true);
    expect(gate.budget).toBe(0);
  });

  it('успешный ответ возвращает ожидание', () => {
    const gate = createPolishGate({ budgetMs: 500 });
    gate.record({ timedOut: true });
    gate.record({ timedOut: true });
    gate.record({ timedOut: false, ms: 120 });
    expect(gate.skipping).toBe(false);
    expect(gate.budget).toBe(500);
  });

  it('после reset снова ждём (модель сменили)', () => {
    const gate = createPolishGate();
    gate.record({ timedOut: true });
    gate.record({ timedOut: true });
    gate.reset();
    expect(gate.budget).toBe(DEFAULT_BUDGET_MS);
  });

  it('помнит попытки для диагностики, но не растёт бесконечно', () => {
    const gate = createPolishGate({ window: 2 });
    for (let i = 0; i < 50; i += 1) gate.record({ timedOut: false, ms: i });
    expect(gate.attempts.length).toBeLessThanOrEqual(20);
    expect(gate.attempts.at(-1)).toEqual({ timedOut: false, ms: 49 });
  });

  it('мусор в аргументах не роняет', () => {
    const gate = createPolishGate({ budgetMs: 0, window: 0 });
    gate.record();
    gate.record({ timedOut: 'да', ms: -5 });
    expect(gate.attempts[1]).toEqual({ timedOut: true, ms: 0 });
    expect(gate.budget).toBe(0);
  });
});
