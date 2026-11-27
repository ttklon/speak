import { describe, expect, it } from 'vitest';
import { LIVE_DRAFT_MIN_FACTOR, resolveLiveDraft } from './liveDraftPolicy.js';

describe('живая расшифровка: решает приложение, человек может переопределить', () => {
  it('на «Быстро» черновик включается сам: движок успевает', () => {
    const auto = resolveLiveDraft({ setting: 'auto', model: 'base-q5_1' });
    expect(auto.enabled).toBe(true);
    expect(auto.explicit).toBe(false);
    expect(auto.why).toMatch(/включена сама/);
  });

  it('на «Сбалансированно» и «Максимуме» — сам выключается', () => {
    for (const model of ['small-q5_1', 'large-v3-turbo-q5_0']) {
      const auto = resolveLiveDraft({ setting: 'auto', model });
      expect(auto.enabled, model).toBe(false);
      expect(auto.why).toBeTruthy();
    }
  });

  it('старое значение «включено»/«выключено» уважается', () => {
    expect(resolveLiveDraft({ setting: true, model: 'small-q5_1' }).enabled).toBe(true);
    expect(resolveLiveDraft({ setting: true, model: 'small-q5_1' }).explicit).toBe(true);
    expect(resolveLiveDraft({ setting: false, model: 'base-q5_1' }).enabled).toBe(false);
    expect(resolveLiveDraft({ setting: false, model: 'base-q5_1' }).why).toMatch(/вручную/);
  });

  it('замер важнее каталога: медленный факт выключает черновик даже на «Быстро»', () => {
    const slow = resolveLiveDraft({ setting: 'auto', model: 'base-q5_1', factor: 2.5 });
    expect(slow.enabled).toBe(false);
    const fast = resolveLiveDraft({ setting: 'auto', model: 'small-q5_1', factor: 9 });
    expect(fast.enabled).toBe(true);
  });

  it('в браузере черновика не бывает: там нечего пересчитывать', () => {
    const web = resolveLiveDraft({ setting: true, model: 'base-q5_1', hasNative: false });
    expect(web.enabled).toBe(false);
    expect(web.why).toMatch(/локальным движком/);
  });

  it('порог назван числом, а не «на глаз»', () => {
    expect(LIVE_DRAFT_MIN_FACTOR).toBe(6);
    expect(resolveLiveDraft({ setting: 'auto', factor: LIVE_DRAFT_MIN_FACTOR }).enabled).toBe(true);
    expect(resolveLiveDraft({ setting: 'auto', factor: LIVE_DRAFT_MIN_FACTOR - 0.1 }).enabled).toBe(false);
  });
});
