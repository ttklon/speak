import { describe, expect, it } from 'vitest';
import {
  MODEL_TIERS,
  TIER_MODELS,
  heavierModel,
  lighterModel,
  pickTierForHardware,
  realtimeFactor,
  tierById,
  tierForModel,
} from './modelTiers.js';

describe('три режима распознавания', () => {
  it('ровно три варианта, и у каждого есть размер, скорость и качество', () => {
    expect(MODEL_TIERS).toHaveLength(3);
    for (const tier of MODEL_TIERS) {
      expect(tier.label).toBeTruthy();
      expect(tier.model).toMatch(/-q5_/);
      expect(tier.sizeMb).toBeGreaterThan(0);
      expect(tier.desc.length).toBeGreaterThan(20);
    }
  });

  it('рекомендован ровно один — сбалансированный', () => {
    const recommended = MODEL_TIERS.filter((t) => t.recommended);
    expect(recommended).toHaveLength(1);
    expect(recommended[0].id).toBe('balanced');
  });

  it('модели не повторяются и идут от лёгкой к тяжёлой', () => {
    expect(new Set(TIER_MODELS).size).toBe(3);
    const sizes = MODEL_TIERS.map((t) => t.sizeMb);
    expect(sizes).toEqual([...sizes].sort((a, b) => a - b));
  });

  it('модель из профиля находит свой режим', () => {
    expect(tierForModel('base-q5_1').id).toBe('fast');
    expect(tierForModel('small-q5_1').id).toBe('balanced');
    expect(tierForModel('large-v3-turbo-q5_0').id).toBe('max');
  });

  it('старые модели из чужих профилей тоже узнаются', () => {
    expect(tierForModel('tiny').id).toBe('fast');
    expect(tierForModel('base').id).toBe('fast');
    expect(tierForModel('small').id).toBe('balanced');
    expect(tierForModel('large-v3-turbo').id).toBe('max');
    expect(tierForModel('medium').id).toBe('max');
  });

  it('неизвестная модель — сбалансированный режим, а не пустота', () => {
    expect(tierForModel('какая-то-новая').id).toBe('balanced');
    expect(tierForModel('').id).toBe('balanced');
    expect(tierForModel(undefined).id).toBe('balanced');
  });

  it('ступень легче и тяжелее', () => {
    expect(lighterModel('large-v3-turbo-q5_0')).toBe('small-q5_1');
    expect(lighterModel('small-q5_1')).toBe('base-q5_1');
    expect(lighterModel('base-q5_1')).toBe(''); // легче некуда
    expect(heavierModel('base-q5_1')).toBe('small-q5_1');
    expect(heavierModel('large-v3-turbo-q5_0')).toBe(''); // тяжелее некуда
  });

  it('слабая машина получает быстрый режим, мощная — максимум', () => {
    expect(pickTierForHardware({ cpus: 2, ramGb: 4 }).id).toBe('fast');
    expect(pickTierForHardware({ cpus: 16, ramGb: 6 }).id).toBe('fast');
    expect(pickTierForHardware({ cpus: 4, ramGb: 8 }).id).toBe('balanced');
    expect(pickTierForHardware({ cpus: 8, ramGb: 16 }).id).toBe('balanced');
    expect(pickTierForHardware({ cpus: 12, ramGb: 32 }).id).toBe('max');
    // без данных не падаем и не выбираем максимум наугад
    expect(pickTierForHardware().id).toBe('balanced');
  });

  it('скорость в «разах реального времени» убывает с тяжестью', () => {
    const fast = realtimeFactor('base-q5_1');
    const balanced = realtimeFactor('small-q5_1');
    const max = realtimeFactor('large-v3-turbo-q5_0');
    expect(fast).toBeGreaterThan(balanced);
    expect(balanced).toBeGreaterThan(max);
    // 20 секунд речи в быстром режиме — меньше 4 секунд счёта
    expect(20 / fast).toBeLessThan(4);
    // у сбалансированного — не больше пяти
    expect(20 / balanced).toBeLessThanOrEqual(5);
  });

  it('tierById отдаёт null на мусор', () => {
    expect(tierById('nope')).toBeNull();
    expect(tierById('max').model).toBe('large-v3-turbo-q5_0');
  });
});
