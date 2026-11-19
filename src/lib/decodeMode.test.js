import { describe, expect, it } from 'vitest';
import { DECODE_MODES, decodeModeLabel, describeMeasured, normalizeDecodeMode } from './decodeMode.js';

describe('normalizeDecodeMode', () => {
  it('знает три режима', () => {
    expect(DECODE_MODES.map((m) => m.id)).toEqual(['auto', 'fast', 'accurate']);
  });

  it('чужое значение не ломает поведение — это «Авто»', () => {
    expect(normalizeDecodeMode('турбо')).toBe('auto');
    expect(normalizeDecodeMode(undefined)).toBe('auto');
    expect(normalizeDecodeMode('  FAST ')).toBe('fast');
  });

  it('подписи по-русски', () => {
    expect(decodeModeLabel('accurate')).toBe('Точно');
    expect(decodeModeLabel('nonsense')).toBe('Авто');
  });
});

describe('describeMeasured', () => {
  it('без замеров честно говорит, что первая диктовка будет быстрой', () => {
    expect(describeMeasured({ factor: null, samples: 0 })).toMatch(/Замеров пока нет/);
  });

  it('на быстрой машине объясняет честный проход', () => {
    const text = describeMeasured({ factor: 0.42, samples: 3, thorough: true });
    expect(text).toContain('42 %');
    expect(text).toContain('честно с первого раза');
    expect(text).toContain('3 проходам');
  });

  it('на медленной машине говорит прямо, что движку тяжело', () => {
    const text = describeMeasured({ factor: 1.8, samples: 2 });
    expect(text).toContain('180 %');
    expect(text).toMatch(/тяжело/);
  });

  it('в режиме «Точно» замеры не важны', () => {
    expect(describeMeasured({ factor: 3, samples: 9, mode: 'accurate' })).toMatch(/независимо от замеров/);
  });

  it('в режиме «Быстро» замеры не важны', () => {
    expect(describeMeasured({ factor: 0.1, samples: 9, mode: 'fast' })).toMatch(/только быстрый проход/);
  });

  it('склоняет один проход правильно', () => {
    expect(describeMeasured({ factor: 0.5, samples: 1, thorough: true })).toContain('1 проходу');
  });
});
