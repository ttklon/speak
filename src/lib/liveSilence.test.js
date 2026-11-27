import { describe, expect, it } from 'vitest';
import { createQuietWatch, QUIET_HINT, QUIET_LEVEL, QUIET_NOTICE_MS } from './liveSilence.js';

describe('предупреждение «микрофон молчит»', () => {
  it('короткая пауза между фразами не тревожит', () => {
    const watch = createQuietWatch();
    expect(watch.feed(0, 1000)).toBe(false);
    expect(watch.feed(0, 3000)).toBe(false);
    expect(watch.feed(0.4, 3500)).toBe(false); // человек заговорил
    expect(watch.feed(0, 9000)).toBe(false);
  });

  it('пять секунд непрерывной тишины — предупреждение ровно один раз', () => {
    const watch = createQuietWatch();
    expect(watch.feed(0.01, 1000)).toBe(false);
    expect(watch.feed(0.01, 5000)).toBe(false);
    expect(watch.feed(0.01, 6000)).toBe(true);
    expect(watch.feed(0.01, 7000)).toBe(false);
    expect(watch.feed(0.01, 20000)).toBe(false);
  });

  it('после звука счёт начинается заново', () => {
    const watch = createQuietWatch();
    expect(watch.feed(0, 1000)).toBe(false);
    expect(watch.feed(0, 6000)).toBe(true);
    watch.feed(0.3, 6100);
    expect(watch.feed(0, 6200)).toBe(false);
    expect(watch.feed(0, 10000)).toBe(false);
    expect(watch.feed(0, 11200)).toBe(true);
  });

  it('reset забывает предыдущую тишину', () => {
    const watch = createQuietWatch();
    watch.feed(0, 1000);
    watch.feed(0, 6000);
    watch.reset();
    expect(watch.feed(0, 6500)).toBe(false);
  });

  it('порог и задержку можно задать', () => {
    const watch = createQuietWatch({ quietLevel: 0.2, afterMs: 1000 });
    expect(watch.feed(0.15, 1000)).toBe(false);
    expect(watch.feed(0.15, 2100)).toBe(true);
    expect(QUIET_LEVEL).toBe(0.06);
    expect(QUIET_NOTICE_MS).toBe(5000);
  });

  it('битые значения не считаются тишиной', () => {
    const watch = createQuietWatch();
    expect(watch.feed(NaN, 1000)).toBe(false);
    expect(watch.feed(undefined, 6000)).toBe(false);
    expect(watch.feed(-1, 7000)).toBe(false);
  });

  it('подсказка звучит словами человека и не обещает лишнего', () => {
    expect(QUIET_HINT).toMatch(/Микрофон молчит/);
    expect(QUIET_HINT).toContain('Настройки');
  });
});
