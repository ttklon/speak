import { describe, expect, it } from 'vitest';
import {
  applyDictionary,
  captureCombo,
  dayLabel,
  keysLabel,
  plural,
  postProcess,
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

  // Раньше словарь работал только на бумаге: человек говорит «зум», движок
  // пишет «зум», а в словаре записано Zoom — замена не срабатывала.
  it('узнаёт известное русское произношение латинского слова', () => {
    expect(applyDictionary('открой зум и телеграм', [{ word: 'Zoom' }, { word: 'Telegram' }])).toBe(
      'открой Zoom и Telegram',
    );
  });

  it('работает и в обратную сторону: в словаре кириллица', () => {
    expect(applyDictionary('созвонились в Zoom', [{ word: 'зум' }])).toBe('созвонились в зум');
  });

  it('не выдумывает произношение для незнакомых слов', () => {
    expect(applyDictionary('открой зспикли', [{ word: 'ZSpeakly' }])).toBe('открой зспикли');
  });

  it('не подменяет слово, в котором произношение лишь часть', () => {
    expect(applyDictionary('зуммер включился', [{ word: 'Zoom' }])).toBe('зуммер включился');
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
  it('обрезка по длине', () => {
    expect(truncate('абвгдеёжз', 5)).toBe('абвг…');
    expect(truncate('коротко', 20)).toBe('коротко');
  });
});

describe('dayLabel', () => {
  const now = new Date(2026, 10, 11, 12, 0, 0);

  it('сегодня и вчера — словами', () => {
    expect(dayLabel(new Date(2026, 10, 11, 8, 0), now)).toBe('Сегодня');
    expect(dayLabel(new Date(2026, 10, 10, 23, 0), now)).toBe('Вчера');
  });

  it('называет число дней, а не только «дня назад»', () => {
    expect(dayLabel(new Date(2026, 10, 9, 12, 0), now)).toBe('2 дня назад');
    expect(dayLabel(new Date(2026, 10, 6, 12, 0), now)).toBe('5 дней назад');
  });

  it('старше недели — дата', () => {
    expect(dayLabel(new Date(2026, 9, 1, 12, 0), now)).toMatch(/^0?1 /);
  });
});

describe('словарь: безопасность замены', () => {
  it('не выбирает произвольно разные термины с одним произношением, независимо от порядка', () => {
    const entries = [{ word: 'Клара', pronunciation: 'клера' }, { word: 'Клэр', pronunciation: 'клера' }];
    expect(applyDictionary('звони клера', entries)).toBe('звони клера');
    expect(applyDictionary('звони клера', [...entries].reverse())).toBe('звони клера');
  });
  it('не выполняет цепочку замен и не зависит от порядка словаря', () => {
    const entries = [{ word: 'курс', pronunciation: 'доллар' }, { word: 'рубль', pronunciation: 'курс' }];
    expect(applyDictionary('доллар', entries)).toBe('курс');
    expect(applyDictionary('доллар', [...entries].reverse())).toBe('курс');
  });
  it('сначала сопоставляет самое длинное выражение', () => {
    const entries = [{ word: 'А', pronunciation: 'старый' }, { word: 'Б', pronunciation: 'старый термин' }];
    expect(applyDictionary('старый термин', entries)).toBe('Б');
    expect(applyDictionary('старый термин', [...entries].reverse())).toBe('Б');
  });
  it('не подменяет часть URL, электронной почты, путей и идентификаторов', () => {
    const entries = [{ word: 'Зум', pronunciation: 'zoom' }];
    const source = 'Пиши zoom@example.com https://zoom.com/zoom /home/zoom C:\\zoom\\file zoom_id и zoom';
    expect(applyDictionary(source, entries)).toBe('Пиши zoom@example.com https://zoom.com/zoom /home/zoom C:\\zoom\\file zoom_id и Зум');
  });
  it('не считает диакритические знаки и дефисы границей слова', () => {
    expect(applyDictionary('cafe\u0301 зум-конференция', [{ word: 'CAFÉ', pronunciation: 'cafe' }, { word: 'Zoom' }])).toBe('cafe\u0301 зум-конференция');
  });
  it('не заменяет совпавшую часть более длинной конфликтующей фразы', () => {
    const entries = [
      { word: 'короткая', pronunciation: 'тест' },
      { word: 'вариант А', pronunciation: 'тест один' },
      { word: 'вариант Б', pronunciation: 'тест один' },
    ];
    expect(applyDictionary('тест один тест', entries)).toBe('тест один короткая');
  });
});

describe('словарь: разные формы и конфликты', () => {
  it('учитывает ё/е, пробелы и регистр в неоднозначных произношениях', () => {
    const entries = [{ word: 'Один', pronunciation: 'клёра  тест' }, { word: 'Два', pronunciation: 'КЛЕРА тест' }];
    expect(applyDictionary('клёра тест и клера   тест', entries)).toBe('клёра тест и клера   тест');
    expect(applyDictionary('ёлка', [{ word: 'Ёлка' }])).toBe('Ёлка');
    expect(applyDictionary('елка', [{ word: 'Ёлка' }])).toBe('Ёлка');
  });
  it('не выбирает цель при одинаковых диапазонах Unicode case folding', () => {
    const entries = [{ word: 'Один', pronunciation: 'k' }, { word: 'Два', pronunciation: 'K' }];
    expect(applyDictionary('k', entries)).toBe('k');
    expect(applyDictionary('s', [{ word: 'Один', pronunciation: 's' }, { word: 'Два', pronunciation: 'ſ' }])).toBe('s');
  });
  it('не заменяет на следующей строке и не повреждает переносы', () => {
    const entry = [{ word: 'слитно', pronunciation: 'два слова' }];
    expect(applyDictionary('два\nслова', entry)).toBe('два\nслова');
    expect(applyDictionary('два   слова', entry)).toBe('слитно');
  });
  it('не принимает повторно уже заменённый текст, даже если цели пересекаются', () => {
    const entries = [{ word: 'Бета', pronunciation: 'альфа' }, { word: 'Гамма', pronunciation: 'бета' }];
    expect(applyDictionary('альфа альфа', entries)).toBe('Бета Бета');
  });
});
