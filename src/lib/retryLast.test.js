import { describe, expect, it } from 'vitest';
import { retryAvailability, shouldReplaceText } from './retryLast.js';

describe('shouldReplaceText', () => {
  it('заменяет, когда точный проход услышал больше слов', () => {
    const res = shouldReplaceText('проверка диктовки раз два', 'проверка диктовки раз два три');
    expect(res.replace).toBe(true);
    expect(res.note).toContain('стало 5');
  });

  it('не подменяет текст на тот же самый', () => {
    expect(shouldReplaceText('Привет, мир.', 'привет,  мир.').replace).toBe(false);
  });

  it('не подменяет на пустоту', () => {
    expect(shouldReplaceText('Привет, мир.', '   ').replace).toBe(false);
  });

  it('не подменяет, когда слов стало меньше', () => {
    const res = shouldReplaceText('раз два три четыре', 'раз два');
    expect(res.replace).toBe(false);
    expect(res.note).toContain('меньше');
  });

  it('при равном числе слов разные слова не считаются улучшением', () => {
    const res = shouldReplaceText('пойдём в кино', 'пойдём на каток');
    expect(res.replace).toBe(false);
    expect(res.note).toContain('не больше');
  });

  it('при равном числе слов знак в конце — улучшение', () => {
    expect(shouldReplaceText('привет как дела', 'Привет, как дела?').replace).toBe(true);
  });

  it('считает слова, а не символы: длинный мусор не выигрывает', () => {
    expect(shouldReplaceText('раз два три', 'раз два три раз два три раз два три').replace).toBe(true);
    expect(shouldReplaceText('раз два три четыре пять', 'раза два').replace).toBe(false);
  });
});

describe('retryAvailability', () => {
  it('без распознавания в приложении объясняет это словами', () => {
    const res = retryAvailability({ audio: { pcm: [1, 2] }, native: null });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/в приложении/);
  });

  it('без сохранённой записи просит сказать ещё раз', () => {
    const res = retryAvailability({ audio: null, native: { transcribePcm: () => {} } });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/заново/);
  });

  it('с записью и движком разрешает переспросить', () => {
    expect(retryAvailability({ audio: { pcm: [1] }, native: { transcribePcm: () => {} } }).ok).toBe(true);
  });
});
