import { describe, expect, it } from 'vitest';
import {
  applyDictionary,
  captureCombo,
  formatMinutes,
  keysLabel,
  plural,
  postProcess,
  searchScore,
  timeHM,
  toAccelerator,
  truncate,
  words,
} from './utils.js';

describe('words', () => {
  it('считает слова в русском тексте', () => {
    expect(words('Привет, как дела?')).toBe(3);
  });
  it('не считает знаки и цифры словами по отдельности', () => {
    expect(words('2026 год — 3 задачи')).toBe(4);
  });
  it('пустая строка — ноль', () => {
    expect(words('')).toBe(0);
  });
});

describe('plural', () => {
  it('русские формы', () => {
    expect(plural(1, 'слово', 'слова', 'слов')).toBe('слово');
    expect(plural(3, 'слово', 'слова', 'слов')).toBe('слова');
    expect(plural(11, 'слово', 'слова', 'слов')).toBe('слов');
    expect(plural(22, 'слово', 'слова', 'слов')).toBe('слова');
  });
});

describe('postProcess', () => {
  it('убирает пробел перед знаком и ставит заглавную', () => {
    expect(postProcess('привет , как дела')).toBe('Привет, как дела');
  });
  it('добавляет пробел после точки', () => {
    expect(postProcess('первое.второе')).toBe('Первое. Второе');
  });
  it('схлопывает пробелы', () => {
    expect(postProcess('  много    пробелов ')).toBe('Много пробелов');
  });
});

describe('applyDictionary', () => {
  const entries = [
    { word: 'ZSpeakly', pronunciation: 'зи спикли' },
    { word: 'Алтайтара' },
  ];

  it('исправляет произношение на правильное написание', () => {
    expect(applyDictionary('открой зи спикли', entries)).toBe('открой ZSpeakly');
  });
  it('регистронезависимо заменяет слово', () => {
    expect(applyDictionary('алтайтара и Алтайтара', entries)).toBe('Алтайтара и Алтайтара');
  });
  it('не трогает часть другого слова', () => {
    expect(applyDictionary('алтайтарак', entries)).toBe('алтайтарак');
  });
  it('пустой текст остаётся пустым', () => {
    expect(applyDictionary('', entries)).toBe('');
  });
});

describe('клавиши', () => {
  it('собирает accelerator для Electron', () => {
    expect(toAccelerator(['Ctrl', 'Alt', 'Space'])).toBe('Control+Alt+Space');
    expect(toAccelerator(['Shift', 'Ctrl', 'a'])).toBe('Shift+Control+A');
  });
  it('подписывает сочетание', () => {
    expect(keysLabel(['Ctrl', 'Alt', 'L'])).toBe('Ctrl + Alt + L');
  });
  it('фиксирует нажатие с модификаторами', () => {
    const e = { ctrlKey: true, altKey: true, shiftKey: false, metaKey: false, code: 'KeyK', key: 'k' };
    expect(captureCombo(e)).toEqual(['Ctrl', 'Alt', 'K']);
  });
});

describe('форматирование', () => {
  it('время в формате ЧЧ:ММ', () => {
    const d = new Date();
    d.setHours(9, 5, 0, 0);
    expect(timeHM(d)).toBe('09:05');
  });
  it('минуты и часы', () => {
    expect(formatMinutes(40)).toBe('40 мин');
    expect(formatMinutes(90)).toBe('1 ч 30 мин');
    expect(formatMinutes(120)).toBe('2 ч');
  });
  it('обрезка по длине', () => {
    expect(truncate('абвгдеёжз', 5)).toBe('абвг…');
    expect(truncate('коротко', 20)).toBe('коротко');
  });
});

describe('поиск', () => {
  it('находит подстроку', () => {
    expect(searchScore('Привет, как дела?', 'как дела')).toBeGreaterThan(50);
  });
  it('не находит несуществующее', () => {
    expect(searchScore('Привет', 'абракадабра')).toBe(0);
  });
  it('пустой запрос — ноль', () => {
    expect(searchScore('что угодно', '')).toBe(0);
  });
});
