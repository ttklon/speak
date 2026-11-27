import { describe, expect, it } from 'vitest';
import {
  CHUNK_MAX_MS,
  CHUNK_MIN_MS,
  CHUNK_OVERLAP_MS,
  CHUNK_SILENCE_MS,
  createSpeechTracker,
  joinChunks,
  mergeOverlap,
  shouldPreChunk,
} from './chunks.js';

/** Речь заданной длины с шагом 100 мс. */
const speak = (samples, { from, to, level = 0.5, step = 100 }) => {
  for (let t = from; t < to; t += step) samples.push([level, t]);
};

const feedLevels = (tracker, samples) => {
  const cuts = [];
  for (const [level, atMs] of samples) {
    const cut = tracker.feed({ level, atMs });
    if (cut) cuts.push(cut);
  }
  return cuts;
};

describe('границы кусков по паузам в речи', () => {
  it('короткая речь без паузы не режется по таймеру — выигрыша нет, расход есть', () => {
    const tracker = createSpeechTracker();
    const samples = [];
    for (let t = 0; t <= 5000; t += 100) samples.push([0.4, t]);
    expect(feedLevels(tracker, samples)).toEqual([]);
    expect(tracker.committedMs).toBe(0);
  });

  it('на паузе отдаёт кусок раньше таймера и режет середину паузы', () => {
    const tracker = createSpeechTracker();
    const samples = [];
    // речи больше минимума, но меньше таймера — сработает именно пауза
    const speechTo = CHUNK_MIN_MS + 500;
    speak(samples, { from: 0, to: speechTo });
    speak(samples, { from: speechTo, to: speechTo + 1000, level: 0 });
    const cuts = feedLevels(tracker, samples);
    expect(cuts).toHaveLength(1);
    expect(cuts[0].fromMs).toBe(0);
    expect(cuts[0].timed).toBe(false);
    // середина паузы: слово не распадается
    expect(cuts[0].atMs).toBeGreaterThan(speechTo);
    expect(cuts[0].atMs).toBeLessThan(speechTo + CHUNK_SILENCE_MS);
    expect(tracker.committedMs).toBe(cuts[0].atMs);
  });

  it('короткая фраза целиком уходит в хвост: резать нечего', () => {
    const tracker = createSpeechTracker();
    const samples = [];
    // короче минимума куска — резать не на что
    speak(samples, { from: 0, to: 3000 });
    speak(samples, { from: 3000, to: CHUNK_MIN_MS - 200, level: 0 });
    expect(feedLevels(tracker, samples)).toEqual([]);
  });

  it('второй кусок — только после нового минимума речи', () => {
    const tracker = createSpeechTracker();
    const samples = [];
    // первый кусок и его пауза
    speak(samples, { from: 0, to: CHUNK_MIN_MS + 500 });
    speak(samples, { from: CHUNK_MIN_MS + 500, to: CHUNK_MIN_MS + 1500, level: 0 });
    // речи меньше минимума — второй кусок не нарезается
    speak(samples, { from: CHUNK_MIN_MS + 1500, to: CHUNK_MIN_MS + 3000 });
    speak(samples, { from: CHUNK_MIN_MS + 3000, to: CHUNK_MIN_MS + 4000, level: 0 });
    expect(feedLevels(tracker, samples)).toHaveLength(1);
    // набрался новый минимум — нарезается и второй
    const more = [];
    speak(more, { from: CHUNK_MIN_MS + 4000, to: CHUNK_MIN_MS + 6000 });
    speak(more, { from: CHUNK_MIN_MS + 6000, to: CHUNK_MIN_MS + 7000, level: 0 });
    expect(feedLevels(tracker, more)).toHaveLength(1);
    expect(CHUNK_MIN_MS).toBeGreaterThan(4000);
  });

  it('откат возвращает границу назад, чтобы звук не потерялся', () => {
    const tracker = createSpeechTracker();
    const speechTo = CHUNK_MIN_MS + 500;
    for (let t = 0; t < speechTo; t += 100) tracker.feed({ level: 0.5, atMs: t });
    let cut = null;
    for (let t = speechTo; t <= speechTo + 1000; t += 100) {
      cut = tracker.feed({ level: 0, atMs: t }) || cut;
    }
    expect(cut).not.toBeNull();
    tracker.rollback(cut.fromMs);
    expect(tracker.committedMs).toBe(0);
    // после отката тот же звук можно нарезать снова
    let again = null;
    for (let t = speechTo + 1000; t <= speechTo + 2000; t += 100) {
      again = tracker.feed({ level: 0, atMs: t }) || again;
    }
    expect(again).not.toBeNull();
  });

  it('pendingMs показывает, сколько ещё не отправлено', () => {
    const tracker = createSpeechTracker();
    expect(tracker.pendingMs(5000)).toBe(5000);
    for (let t = 0; t < 9000; t += 100) tracker.feed({ level: 0.5, atMs: t });
    for (let t = 9000; t <= 10000; t += 100) tracker.feed({ level: 0, atMs: t });
    expect(tracker.committedMs).toBeGreaterThan(0);
    // остаток меньше таймера: после стопа считать придётся немного
    expect(tracker.pendingMs(12000)).toBeLessThan(7000);
  });
});

describe('склейка кусков', () => {
  it('ставит пробел между предложениями', () => {
    expect(joinChunks(['Смотри, мне нужно.', 'Сделай программу.'])).toBe(
      'Смотри, мне нужно. Сделай программу.',
    );
  });

  it('не отрывает знак препинания от слова', () => {
    expect(joinChunks(['Привет', ', как дела'])).toBe('Привет, как дела');
    expect(joinChunks(['готово', '.'])).toBe('готово.');
  });

  it('не теряет хвост слова на дефисе', () => {
    expect(joinChunks(['по-', 'русски'])).toBe('по-русски');
  });

  it('убирает лишние пробелы и пустые куски', () => {
    expect(joinChunks(['  Привет   мир ', '', null, '  и  тебе  '])).toBe('Привет мир и тебе');
  });

  it('из ничего получается пустая строка', () => {
    expect(joinChunks([])).toBe('');
    expect(joinChunks()).toBe('');
  });

  it('непрерывная речь без паузы режется по времени — иначе хвост был бы всей фразой', () => {
    const tracker = createSpeechTracker();
    const cuts = [];
    for (let t = 0; t <= 30000; t += 100) {
      const cut = tracker.feed({ level: 0.5, atMs: t });
      if (cut) cuts.push(cut);
    }
    expect(cuts.length).toBeGreaterThanOrEqual(2);
    expect(cuts[0].timed).toBe(true);
    // граница не у самого края: недописанное слово остаётся в следующем куске
    expect(cuts[0].atMs).toBeLessThanOrEqual(CHUNK_MAX_MS - 100);
    expect(CHUNK_MAX_MS).toBeGreaterThan(CHUNK_MIN_MS);
    expect(CHUNK_OVERLAP_MS).toBeLessThan(1000);
  });

  it('по таймеру режет в самом тихом месте — там кончается слово, а не посередине', () => {
    const tracker = createSpeechTracker();
    const cuts = [];
    // громко-тихо-громко: тихий провал на 5 000 мс попадает в окно выбора
    for (let t = 0; t <= 12000; t += 100) {
      const level = t >= 5000 && t <= 5200 ? 0.09 : 0.5;
      const cut = tracker.feed({ level, atMs: t });
      if (cut) cuts.push(cut);
    }
    expect(cuts.length).toBeGreaterThanOrEqual(1);
    // разрез — в провале, а не в громкой речи рядом с ним
    expect(cuts[0].atMs).toBeGreaterThanOrEqual(5000);
    expect(cuts[0].atMs).toBeLessThanOrEqual(5200);
    expect(cuts[0].timed).toBe(true);
  });

  it('перекрытие отдаётся отдельным числом, чтобы движок знал, сколько повторить', () => {
    expect(createSpeechTracker().overlapMs).toBe(CHUNK_OVERLAP_MS);
  });
});

describe('склейка кусков с перекрытием', () => {
  it('не удаляет отрицание или служебное слово, совпавшее с концом предыдущего', () => {
    expect(mergeOverlap('Кнопка на машине', 'не нажимайте')).toBe('Кнопка на машине не нажимайте');
    expect(mergeOverlap('Работает в режиме', 'и в фоне')).toBe('Работает в режиме и в фоне');
    expect(mergeOverlap('Запрос программе', 'е покажем')).toBe('Запрос программе е покажем');
  });
  it('не угадывает повтор из одного или двух совпавших слов', () => {
    expect(mergeOverlap('Он сказал не', 'не отправлять')).toBe('Он сказал не не отправлять');
    expect(mergeOverlap('Нужно сто процентов', 'сто процентов проверить')).toBe('Нужно сто процентов сто процентов проверить');
    expect(mergeOverlap('Первый сигнал. Да.', 'Да. Следующий сигнал.')).toBe('Первый сигнал. Да. Да. Следующий сигнал.');
  });
  it('прибирает только достаточно длинный точный стык, но не произвольный суффикс слова', () => {
    expect(mergeOverlap('проверка один два три', 'один два три готово')).toBe('проверка один два три готово');
    expect(mergeOverlap('готово', 'готово')).toBe('готово готово');
    // Пустые после нормализации знаки — не три совпадающих слова.
    expect(mergeOverlap('Внимание ! ! !', '! ! ! дальше')).toBe(joinChunks(['Внимание ! ! !', '! ! ! дальше']));
    expect(mergeOverlap('Первое. Да ! ! .', 'Да. Дальше')).toBe(joinChunks(['Первое. Да ! ! .', 'Да. Дальше']));
  });
  it('не сворачивает длинный совпавший стык с отрицанием, цифрами или повторами', () => {
    expect(mergeOverlap('Хорошо. Не отправляй деньги.', 'Не отправляй деньги. Завтра.'))
      .toBe('Хорошо. Не отправляй деньги. Не отправляй деньги. Завтра.');
    expect(mergeOverlap('Хорошо не отправляй деньги', 'не отправляй деньги завтра'))
      .toBe('Хорошо не отправляй деньги не отправляй деньги завтра');
    expect(mergeOverlap('номер 100 200', 'номер 100 200 для сверки')).toBe('номер 100 200 номер 100 200 для сверки');
    expect(mergeOverlap('скажи очень очень часто', 'очень очень часто бывает')).toBe('скажи очень очень часто очень очень часто бывает');
  });
  it('режим сохранения текста не вырезает даже длинный совпавший стык', () => {
    expect(mergeOverlap('проверка один два три', 'один два три готово', { preserve: true }))
      .toBe('проверка один два три один два три готово');
    expect(mergeOverlap('Сначала. Сделай программу сегодня.', 'Сделай программу сегодня. Готово.', { preserve: true }))
      .toBe('Сначала. Сделай программу сегодня. Сделай программу сегодня. Готово.');
  });
  it('снимает дубль на стыке', () => {
    expect(mergeOverlap('Смотри, мне очень нужно.', 'мне очень нужно. Сделай программу.')).toBe(
      'Смотри, мне очень нужно. Сделай программу.',
    );
  });

  it('сохраняет возможный обрывок: его нельзя безопасно отличить от отдельного слова', () => {
    expect(mergeOverlap('Сделай программу', 'му на снижение цен')).toBe(
      'Сделай программу му на снижение цен',
    );
    expect(mergeOverlap('в автоматическом режиме', 'е на Windows')).toBe(
      'в автоматическом режиме е на Windows',
    );
  });

  it('без перекрытия склеивает как обычные куски', () => {
    expect(mergeOverlap('Привет', 'как дела')).toBe('Привет как дела');
  });

  it('не съедает осмысленный повтор, если человек правда повторил слово', () => {
    expect(mergeOverlap('да, да', 'да')).toBe('да, да да');
  });

  it('с одним пустым куском возвращает другой', () => {
    expect(mergeOverlap('', 'текст')).toBe('текст');
    expect(mergeOverlap('текст', '')).toBe('текст');
  });

  it('нарезка только на прогретом сервере: на холодном движке она была бы медленнее', () => {
    // сервер отвечал — режем: каждый кусок считается без загрузки весов
    expect(shouldPreChunk('server')).toBe(true);
    // whisper-cli: каждый кусок = новая загрузка модели с диска
    expect(shouldPreChunk('cli')).toBe(false);
    // ещё не знаем, чем считает (первая диктовка) — не режем
    expect(shouldPreChunk('')).toBe(false);
    expect(shouldPreChunk(undefined)).toBe(false);
  });

  it('повторившееся целое предложение на стыке не задваивается', () => {
    // Хвост иногда распознаётся вместе с последним предложением предыдущего
    // куска — в окне это выглядело бы как «просто повторы».
    expect(
      mergeOverlap('Смотри, мне нужно. Сделай программу сегодня.', 'Сделай программу сегодня. На снижение цен.'),
    ).toBe('Смотри, мне нужно. Сделай программу сегодня. На снижение цен.');
  });

  it('одно и то же единственное предложение не выкидывается целиком', () => {
    expect(mergeOverlap('Сделай программу.', 'Сделай программу.')).toBe('Сделай программу. Сделай программу.');
  });
});
