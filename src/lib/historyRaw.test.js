import { describe, expect, it } from 'vitest';
import { hasRawText, rawTextFor, RAW_TEXT_LIMIT } from './historyRaw.js';

describe('«как распозналось»', () => {
  it('хранит сырой текст, только если приложение его изменило', () => {
    expect(rawTextFor('привет как дела', 'Привет, как дела.')).toBe('привет как дела');
    expect(rawTextFor('Привет, как дела.', 'Привет, как дела.')).toBeUndefined();
  });

  it('не хранит пустое и разницу в пробелах по краям', () => {
    expect(rawTextFor('', 'текст')).toBeUndefined();
    expect(rawTextFor('   ', 'текст')).toBeUndefined();
    expect(rawTextFor('текст', '')).toBeUndefined();
    expect(rawTextFor(' текст ', 'текст')).toBeUndefined();
  });

  it('длинную расшифровку не дублирует в профиле', () => {
    const long = 'слово '.repeat(500).trim();
    expect(long.length).toBeGreaterThan(RAW_TEXT_LIMIT);
    expect(rawTextFor(long, 'короткий текст')).toBeUndefined();
  });

  it('показывать есть что только при реальной разнице', () => {
    expect(hasRawText({ text: 'готово', rawText: 'готово ' })).toBe(false);
    expect(hasRawText({ text: 'Привет.', rawText: 'привет' })).toBe(true);
    expect(hasRawText({ text: 'готово' })).toBe(false);
    expect(hasRawText(null)).toBe(false);
  });
});
