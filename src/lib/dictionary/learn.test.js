import { describe, expect, it } from 'vitest';
import { learnFromEdit, distance, normalize } from './learn.js';

describe('обучение словаря по правкам', () => {
  it('нормализует ё и пунктуацию', () => {
    expect(normalize('Зелёнка, «яблоко»!')).toBe('зеленка яблоко');
  });

  it('считает расстояние между словами', () => {
    expect(distance('зеленка', 'зелёнка')).toBe(1);
    expect(distance('кот', 'кот')).toBe(0);
  });

  it('ловит исправленное пользователем слово', () => {
    const out = learnFromEdit('купи зелинку и хлеб', 'купи зелёнку и хлеб');
    expect(out).toHaveLength(1);
    expect(out[0].word).toBe('зелёнку');
    expect(out[0].pronunciation).toBe('зелинку');
  });

  it('не предлагает слова, которые уже в словаре, и не учит мусор', () => {
    expect(learnFromEdit('зи спикли', 'ZSpeakly', [{ word: 'zspeakly' }])).toEqual([]);
    expect(learnFromEdit('привет', 'совершенно другой текст')).toEqual([]);
  });

  it('сохраняет написание человека, регистр, диакритики и ё', () => {
    expect(learnFromEdit('купи зелинку', 'купи Зелёнку')).toEqual([{ word: 'Зелёнку', pronunciation: 'зелинку' }]);
    expect(learnFromEdit('иду в cafe', 'иду в café')).toEqual([{ word: 'café', pronunciation: 'cafe' }]);
    expect(learnFromEdit('ели суп', 'ёли суп')).toEqual([{ word: 'ёли', pronunciation: 'ели' }]);
  });
  it('не предлагает ложные пары после вставки или удаления слов', () => {
    expect(learnFromEdit('купи зелинку', 'срочно купи зелёнку')).toEqual([]);
    expect(learnFromEdit('купи зелинку сейчас', 'купи зелёнку')).toEqual([]);
  });
  it('не предлагает часть email, пути или домена вместо слова', () => {
    expect(learnFromEdit('адрес user@exampl.com', 'адрес user@example.com')).toEqual([]);
    expect(learnFromEdit('путь /tmp/testa.txt', 'путь /tmp/testb.txt')).toEqual([]);
  });
  it('не запускает квадратичное расстояние для слишком длинных токенов', () => {
    expect(learnFromEdit('a'.repeat(10000), 'a'.repeat(9999) + 'b')).toEqual([]);
  });

  it('не учит неоднозначное повторение и сохраняет каноническое написание', () => {
    expect(learnFromEdit('елка и елка', 'ёлка и елка')).toEqual([]);
    expect(learnFromEdit('купил cafe', 'купил cafe\u0301')).toEqual([{ word: 'cafe\u0301', pronunciation: 'cafe' }]);
    expect(learnFromEdit('купил cafe', 'купил cafe\u0301', [{ word: 'café' }])).toEqual([]);
  });

  it('ограничивает объём анализа без изменения исходного текста', () => {
    const many = Array.from({ length: 2001 }, (_, i) => `слово${i}`).join(' ');
    expect(learnFromEdit(many, many.replace('слово0', 'слова0'))).toEqual([]);
    const long = 'x'.repeat(200001);
    expect(learnFromEdit(long, long.slice(0, -1) + 'y')).toEqual([]);
  });

});
