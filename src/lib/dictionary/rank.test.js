import { describe, expect, it } from 'vitest';
import { countDictionaryUsage, normalizeKey, rankDictionary } from './rank.js';

const word = (text, extra = {}) => ({ id: text, word: text, createdAt: 1, ...extra });

describe('порядок словаря', () => {
  it('закреплённое слово всегда выше незакреплённого', () => {
    const ranked = rankDictionary([
      word('частое', { hits: 40, createdAt: 500 }),
      word('важное', { pinned: true, hits: 0, createdAt: 1 }),
    ]);
    expect(ranked[0].word).toBe('важное');
  });

  it('при равном закреплении выше то, что чаще встречалось в тексте', () => {
    const ranked = rankDictionary([
      word('редкое', { hits: 1, createdAt: 900 }),
      word('частое', { hits: 7, createdAt: 100 }),
    ]);
    expect(ranked.map((w) => w.word)).toEqual(['частое', 'редкое']);
  });

  it('при равных попаданиях — свежее: сначала использованное, потом добавленное', () => {
    const ranked = rankDictionary([
      word('старое', { createdAt: 10 }),
      word('добавлено позже', { createdAt: 20 }),
      word('использовано', { createdAt: 1, lastUsedAt: 99 }),
    ]);
    expect(ranked.map((w) => w.word)).toEqual(['использовано', 'добавлено позже', 'старое']);
  });

  it('не перемешивает данные человека: исходный список остаётся как был', () => {
    const list = [word('б'), word('а')];
    rankDictionary(list);
    expect(list.map((w) => w.word)).toEqual(['б', 'а']);
  });

  it('пустой и битый список не ломают сортировку', () => {
    expect(rankDictionary([])).toEqual([]);
    expect(rankDictionary(null)).toEqual([]);
    expect(rankDictionary([null, word('а')])).toHaveLength(2);
  });
});

describe('подсчёт попаданий словаря', () => {
  it('считает слово, которое действительно прозвучало', () => {
    const { list, changed } = countDictionaryUsage([word('Гига Писарь'), word('Докер')], 'Поставил Гига Писарь на ноутбук');
    expect(changed).toEqual(['Гига Писарь']);
    expect(list[0].hits).toBe(1);
    expect(list[0].lastUsedAt).toBeGreaterThan(0);
    // второе слово в тексте не встречалось — его не трогаем
    expect(list[1].hits).toBeUndefined();
  });

  it('ищет по целым словам, а не по подстроке', () => {
    const { changed } = countDictionaryUsage([word('кот')], 'который час');
    expect(changed).toEqual([]);
  });

  it('не зависит от регистра и ё', () => {
    const { changed } = countDictionaryUsage([word('Еж')], 'ЁЖ и ёжик');
    expect(changed).toEqual(['Еж']);
  });

  it('многословный термин ищется последовательностью слов', () => {
    const { changed } = countDictionaryUsage([word('новая почта')], 'Открой новую почту');
    expect(changed).toEqual([]);
    const exact = countDictionaryUsage([word('новая почта')], 'Проверь новую  почту');
    expect(exact.changed).toEqual([]);
    const phrase = countDictionaryUsage([word('новая почта')], 'Настрой новая почта у себя');
    expect(phrase.changed).toEqual(['новая почта']);
  });

  it('пустой текст ничего не считает и не создаёт копий', () => {
    const list = [word('а')];
    const result = countDictionaryUsage(list, '');
    expect(result.changed).toEqual([]);
    expect(result.list).toBe(list);
  });

  it('нормализация сводит ё и убирает знаки', () => {
    expect(normalizeKey('  Ёлка, дом! ')).toBe('елка дом');
  });
});
