import { describe, expect, it } from 'vitest';
import {
  COMPARE_LIMIT,
  describeComparison,
  pickCompareModels,
  scoreTerms,
} from './modelCompare.js';

describe('pickCompareModels', () => {
  it('текущая модель идёт первой, дальше по порядку режимов', () => {
    expect(
      pickCompareModels({
        downloaded: ['large-v3-turbo-q5_0', 'base-q5_1', 'small-q5_1'],
        current: 'small-q5_1',
        order: ['base-q5_1', 'small-q5_1', 'large-v3-turbo-q5_0'],
      }),
    ).toEqual(['small-q5_1', 'base-q5_1', 'large-v3-turbo-q5_0']);
  });

  it('не предлагает не скачанные модели', () => {
    expect(
      pickCompareModels({ downloaded: ['base-q5_1'], current: 'small-q5_1', order: ['base-q5_1', 'small-q5_1'] }),
    ).toEqual(['base-q5_1']);
  });

  it('не больше трёх: сравнение не должно занимать минуты', () => {
    const list = pickCompareModels({
      downloaded: ['a', 'b', 'c', 'd'],
      current: 'a',
      order: ['a', 'b', 'c', 'd'],
    });
    expect(list.length).toBe(COMPARE_LIMIT);
  });

  it('без скачанных моделей — пусто', () => {
    expect(pickCompareModels({ downloaded: [], current: 'small-q5_1' })).toEqual([]);
  });

  it('дубликаты не удваивают список', () => {
    expect(pickCompareModels({ downloaded: ['a', 'a', 'b'], current: 'a', order: ['a'] })).toEqual(['a', 'b']);
  });
});

describe('scoreTerms', () => {
  it('считает попадания без учёта регистра, ё и знаков', () => {
    const res = scoreTerms('Я сказал Зум и Telegram, а ещё Docker.', ['Зум', 'telegram', 'Docker', 'ёлка']);
    expect(res.matched).toEqual(['зум', 'telegram', 'docker']);
    expect(res.total).toBe(4);
    expect(res.ratio).toBeCloseTo(0.75, 2);
  });

  it('не считает частью слова', () => {
    // «зуммер» — не «зум»
    expect(scoreTerms('включи зуммер', ['зум']).matched).toEqual([]);
  });

  it('принимает объекты словаря', () => {
    expect(scoreTerms('открой Docker', [{ word: 'Docker' }]).matched).toEqual(['docker']);
  });

  it('без словаря ничего не выдумывает', () => {
    expect(scoreTerms('любой текст', []).total).toBe(0);
  });
});

describe('describeComparison', () => {
  const rows = (a, b) => [
    { model: 'base', ok: true, text: a, ms: 900 },
    { model: 'small', ok: true, text: b, ms: 1600 },
  ];

  it('победителя по терминам называет, только если есть слова словаря', () => {
    const res = describeComparison(rows('включи зум', 'включи Zoom и Telegram'));
    // без words в строках слов нет — значит «смотрите глазами»
    expect(res.winner).toBe('');
    const withWords = describeComparison([
      { model: 'base', ok: true, text: 'включи зум', words: ['Zoom', 'Telegram'] },
      { model: 'small', ok: true, text: 'включи Zoom и Telegram', words: ['Zoom', 'Telegram'] },
    ]);
    expect(withWords.winner).toBe('small');
    expect(withWords.summary).toMatch(/2 из 2/);
  });

  it('при равенстве терминов победителя не объявляет', () => {
    const res = describeComparison([
      { model: 'base', ok: true, text: 'включи Zoom', words: ['Zoom'] },
      { model: 'small', ok: true, text: 'включи Zoom', words: ['Zoom'] },
    ]);
    expect(res.winner).toBe('');
    expect(res.summary).toMatch(/одинаково/);
  });

  it('если текст дала одна модель — сравнивать нечего', () => {
    const res = describeComparison([{ model: 'base', ok: true, text: 'привет' }, { model: 'small', ok: false }]);
    expect(res.summary).toMatch(/нечего/);
  });
});
