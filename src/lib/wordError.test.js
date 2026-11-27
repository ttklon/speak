import { expect, it } from 'vitest';
import { wordError } from '../../scripts/lib/word-error.mjs';

it('считает замены, пропуски и лишние слова без учёта регистра, ё и пунктуации', () => {
  expect(wordError('Ёж, идёт домой!', 'еж идет домой')).toEqual({ errors: 0, referenceWords: 3, wer: 0 });
  expect(wordError('раз два три', 'раз четыре три лишнее')).toEqual({ errors: 2, referenceWords: 3, wer: 2 / 3 });
  expect(wordError('раз два', '')).toEqual({ errors: 2, referenceWords: 2, wer: 1 });
  expect(() => wordError('', 'текст')).toThrow();
});

it('считает канонически эквивалентный Unicode одинаково', () => {
  expect(wordError('café', 'cafe\u0301').errors).toBe(0);
  expect(wordError('йога', 'и\u0306ога').errors).toBe(0);
});
