import { describe, expect, it } from 'vitest';
import { dictionaryConflicts, applyDictionaryReplacements } from './replacements.js';

describe('конфликты словаря', () => {
  it('показывает разные термины с одинаковым произношением с учётом ё/е и пробелов', () => {
    const entries = [{ word: 'Клара', pronunciation: 'клёра   тест' }, { word: 'Клэр', pronunciation: 'КЛЕРА тест' }];
    expect(dictionaryConflicts(entries)).toEqual([{ variant: 'клера тест', words: ['Клара', 'Клэр'] }]);
  });
  it('не считает повтор одной и той же цели конфликтом', () => {
    expect(dictionaryConflicts([{ word: 'Клара', pronunciation: 'клера' }, { word: 'Клара', pronunciation: 'клера' }])).toEqual([]);
  });
  it('отключает замены при слишком большом числе совпадений, не обрезая исходный текст', () => {
    const source = 'кот '.repeat(50001);
    expect(applyDictionaryReplacements(source, [{ word: 'кошка', pronunciation: 'кот' }])).toBe(source);
  });
});
