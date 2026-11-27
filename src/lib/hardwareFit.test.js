import { describe, expect, it } from 'vitest';
import { MEMORY_LOW_GB, MEMORY_MID_GB, fitVerdict, recommendTier } from './hardwareFit.js';

describe('recommendTier', () => {
  it('без данных о железе ничего не советует', () => {
    const res = recommendTier({});
    expect(res.tier).toBeNull();
    expect(res.why).toMatch(/не знает/);
  });

  it('4 ГБ или два ядра — «Быстро»', () => {
    expect(recommendTier({ ramGb: 4, cpus: 8 }).tier.id).toBe('fast');
    expect(recommendTier({ ramGb: 16, cpus: 2 }).tier.id).toBe('fast');
  });

  it('8 ГБ или четыре ядра — «Сбалансированно»', () => {
    expect(recommendTier({ ramGb: 8, cpus: 8 }).tier.id).toBe('balanced');
    expect(recommendTier({ ramGb: 16, cpus: 4 }).tier.id).toBe('balanced');
  });

  it('сильная машина — «Максимум качества»', () => {
    expect(recommendTier({ ramGb: 32, cpus: 16 }).tier.id).toBe('max');
  });

  it('объяснение содержит железо словами', () => {
    const why = recommendTier({ ramGb: 4, cpus: 2 }).why;
    expect(why).toContain('4 ГБ памяти');
    expect(why).toContain('2 ядра');
  });

  it('границы списка — константы, а не магические числа', () => {
    expect(recommendTier({ ramGb: MEMORY_LOW_GB - 0.1, cpus: 8 }).tier.id).toBe('fast');
    expect(recommendTier({ ramGb: MEMORY_MID_GB - 0.1, cpus: 8 }).tier.id).toBe('balanced');
  });
});

describe('fitVerdict', () => {
  it('модель совпала с рекомендацией — «в порядке»', () => {
    const res = fitVerdict({ current: 'small-q5_1', ramGb: 8, cpus: 8 });
    expect(res.level).toBe('ok');
    expect(res.switchTo).toBe('');
  });

  it('модель тяжелее машины — предупреждение и кнопка', () => {
    const res = fitVerdict({ current: 'large-v3-turbo-q5_0', ramGb: 4, cpus: 2, downloaded: true });
    expect(res.level).toBe('warn');
    expect(res.switchTo).toBe('base-q5_1');
    expect(res.switchLabel).toMatch(/Переключить на «Быстро»/);
    expect(res.hint).toContain('Максимум качества');
  });

  it('если нужной модели нет на диске — не обещаем переключение', () => {
    const res = fitVerdict({ current: 'large-v3-turbo-q5_0', ramGb: 4, cpus: 2, downloaded: false });
    expect(res.switchTo).toBe('base-q5_1');
    expect(res.switchLabel).toMatch(/ещё не скачана/);
  });

  it('модель легче рекомендации — не тянем вверх против воли', () => {
    const res = fitVerdict({ current: 'base-q5_1', ramGb: 16, cpus: 8 });
    expect(res.level).toBe('ok');
    expect(res.switchTo).toBe('');
    expect(res.hint).toMatch(/можно попробовать/);
  });

  it('без данных о железе — честное «не знаю»', () => {
    const res = fitVerdict({ current: 'small-q5_1' });
    expect(res.level).toBe('unknown');
    expect(res.switchTo).toBe('');
  });
});
