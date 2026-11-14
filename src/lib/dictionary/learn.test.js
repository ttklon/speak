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
    expect(out[0].word).toBe('зеленку');
    expect(out[0].pronunciation).toBe('зелинку');
  });

  it('не предлагает слова, которые уже в словаре, и не учит мусор', () => {
    expect(learnFromEdit('зи спикли', 'ZSpeakly', [{ word: 'zspeakly' }])).toEqual([]);
    expect(learnFromEdit('привет', 'совершенно другой текст')).toEqual([]);
  });

});
