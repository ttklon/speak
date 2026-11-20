import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { aliasesFor, knownAliases, termVariants } from './aliases.js';

describe('aliasesFor', () => {
  it('знает, как звучит латиница по-русски', () => {
    expect(aliasesFor('Zoom')).toEqual(['зум']);
    expect(aliasesFor('Telegram')).toContain('телеграм');
    expect(aliasesFor('Docker')).toEqual(['докер']);
  });

  it('работает в обратную сторону: кириллица → латиница', () => {
    expect(aliasesFor('зум')).toEqual(['zoom']);
    expect(aliasesFor('Телеграм')).toContain('telegram');
  });

  it('регистр и ё не важны', () => {
    expect(aliasesFor('ZOOM')).toEqual(['зум']);
    expect(aliasesFor('твиттэр')).toEqual([]);
  });

  it('незнакомое слово не выдумывает произношение', () => {
    // Транслитерация «на глаз» дала бы «доккер» и «зоом» — лучше ничего.
    expect(aliasesFor('ZSpeakly')).toEqual([]);
    expect(aliasesFor('')).toEqual([]);
  });
});

describe('termVariants', () => {
  it('сначала термин, потом произношение, потом известные пары', () => {
    expect(termVariants({ word: 'Zoom', pronunciation: 'зумчик' })).toEqual(['Zoom', 'зумчик', 'зум']);
  });

  it('без повторов', () => {
    const variants = termVariants({ word: 'Zoom', pronunciation: 'зум' });
    expect(variants).toEqual(['Zoom', 'зум']);
  });

  it('принимает строку, а не только объект', () => {
    expect(termVariants('Telegram')).toEqual(['Telegram', 'телеграм', 'телеграмм']);
  });

  it('незнакомое слово — это только оно само', () => {
    expect(termVariants({ word: 'Алтайтара' })).toEqual(['Алтайтара']);
  });
});

describe('knownAliases', () => {
  it('нужен интерфейсу, чтобы подсказать произношение до диктовки', () => {
    expect(knownAliases('GitHub')).toContain('гитхаб');
  });
});

describe('один список на интерфейс и main', () => {
  // Подсказку движку собирает main (CommonJS), замену в тексте — интерфейс
  // (ESM). Если списки разойдутся, «зум» будет узнаваться по-разному до и после
  // распознавания — это худший вид расхождения: незаметный.
  const require = createRequire(import.meta.url);
  const cjs = require('../../../electron/dictionaryAliases.cjs');

  it('оба модуля читают один и тот же файл пар', () => {
    expect(cjs.PAIRS).toEqual(
      expect.objectContaining({ zoom: ['зум'], telegram: expect.arrayContaining(['телеграм']) }),
    );
  });

  it('для известных слов ответы совпадают', () => {
    for (const word of ['Zoom', 'зум', 'Telegram', 'Docker', 'докер', 'GitHub', 'ZSpeakly']) {
      expect(cjs.aliasesFor(word)).toEqual(aliasesFor(word));
    }
  });
});
