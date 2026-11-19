import { describe, expect, it } from 'vitest';
import { diffWords, hasRawText, rawTextFor, RAW_TEXT_LIMIT } from './historyRaw.js';

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

describe('разница по словам', () => {
  const text = (segs) => segs.map((s) => s.text).join('');
  const changed = (segs) => segs.filter((s) => s.changed).map((s) => s.text.trim());

  it('подсвечивает только заменённое приложением слово', () => {
    const segs = diffWords('поставь зи спикли', 'Поставь ZSpeakly.');
    expect(text(segs)).toBe('Поставь ZSpeakly.');
    expect(changed(segs)).toEqual(['ZSpeakly']);
  });

  it('заглавная и знаки — не правка смысла', () => {
    const segs = diffWords('привет как дела', 'Привет, как дела.');
    expect(changed(segs)).toEqual([]);
    expect(text(segs)).toBe('Привет, как дела.');
  });

  it('выброшенные слова не подсвечиваются, добавленные — подсвечиваются', () => {
    const segs = diffWords('ну это как бы нормально', 'Нормально.');
    expect(changed(segs)).toEqual([]);
    const added = diffWords('срок три дня', 'Срок — три рабочих дня.');
    expect(changed(added)).toEqual(['рабочих']);
  });

  it('ё и регистр не считаются разницей', () => {
    expect(changed(diffWords('ёлка стоит', 'Елка стоит'))).toEqual([]);
  });

  it('текст восстанавливается один в один', () => {
    const cases = [
      ['привет мир', 'Привет, мир!'],
      ['a b c', 'a c'],
      ['', 'текст'],
      ['x', 'x'],
    ];
    for (const [raw, final] of cases) expect(text(diffWords(raw, final))).toBe(final);
  });

  it('длинный текст не диффим и не ломаем', () => {
    const long = `${'слово '.repeat(500)}конец`;
    const segs = diffWords(long, long);
    expect(segs).toHaveLength(1);
    expect(segs[0].changed).toBe(false);
    expect(text(segs)).toBe(long);
  });

  it('пустой готовый текст — пустой список', () => {
    expect(diffWords('что-то', '')).toEqual([]);
    expect(diffWords('', '')).toEqual([]);
  });
});
