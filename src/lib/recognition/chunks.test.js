import { describe, expect, it } from 'vitest';
import {
  CHUNK_MAX_MS,
  CHUNK_MIN_MS,
  CHUNK_OVERLAP_MS,
  CHUNK_SILENCE_MS,
  createSpeechTracker,
  joinChunks,
  mergeOverlap,
} from './chunks.js';

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
    // семь секунд речи — меньше таймера, значит сработает именно пауза
    for (let t = 0; t < 7000; t += 100) samples.push([0.5, t]);
    // тишина начинается около 7 000, длится секунду
    for (let t = 7000; t <= 8000; t += 100) samples.push([0, t]);
    const cuts = feedLevels(tracker, samples);
    expect(cuts).toHaveLength(1);
    expect(cuts[0].fromMs).toBe(0);
    expect(cuts[0].timed).toBe(false);
    // середина паузы: 7 000 + 650/2 ≈ 7 325 — слово не распадается
    expect(cuts[0].atMs).toBeGreaterThan(7000);
    expect(cuts[0].atMs).toBeLessThan(7000 + CHUNK_SILENCE_MS);
    expect(tracker.committedMs).toBe(cuts[0].atMs);
  });

  it('короткая фраза целиком уходит в хвост: резать нечего', () => {
    const tracker = createSpeechTracker();
    const samples = [];
    for (let t = 0; t < 3000; t += 100) samples.push([0.5, t]);
    for (let t = 3000; t <= 5000; t += 100) samples.push([0, t]);
    expect(feedLevels(tracker, samples)).toEqual([]);
  });

  it('второй кусок — только после нового минимума речи', () => {
    const tracker = createSpeechTracker();
    const samples = [];
    for (let t = 0; t < 8000; t += 100) samples.push([0.5, t]);
    for (let t = 8000; t <= 9000; t += 100) samples.push([0, t]);
    // ещё немного речи — меньше минимума куска
    for (let t = 9000; t < 11000; t += 100) samples.push([0.5, t]);
    for (let t = 11000; t <= 12000; t += 100) samples.push([0, t]);
    const cuts = feedLevels(tracker, samples);
    expect(cuts).toHaveLength(1);
    expect(CHUNK_MIN_MS).toBeGreaterThan(4000);
  });

  it('откат возвращает границу назад, чтобы звук не потерялся', () => {
    const tracker = createSpeechTracker();
    for (let t = 0; t < 7000; t += 100) tracker.feed({ level: 0.5, atMs: t });
    let cut = null;
    for (let t = 7000; t <= 8000; t += 100) cut = tracker.feed({ level: 0, atMs: t }) || cut;
    expect(cut).not.toBeNull();
    tracker.rollback(cut.fromMs);
    expect(tracker.committedMs).toBe(0);
    // после отката тот же звук можно нарезать снова
    let again = null;
    for (let t = 8000; t <= 9000; t += 100) again = tracker.feed({ level: 0, atMs: t }) || again;
    expect(again).not.toBeNull();
  });

  it('pendingMs показывает, сколько ещё не отправлено', () => {
    const tracker = createSpeechTracker();
    expect(tracker.pendingMs(5000)).toBe(5000);
    for (let t = 0; t < 9000; t += 100) tracker.feed({ level: 0.5, atMs: t });
    for (let t = 9000; t <= 10000; t += 100) tracker.feed({ level: 0, atMs: t });
    expect(tracker.committedMs).toBeGreaterThan(0);
    expect(tracker.pendingMs(12000)).toBeLessThan(3000);
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
    // громко-тихо-громко: тихий провал на 8 200 мс — там и должен быть разрез
    for (let t = 0; t <= 12000; t += 100) {
      const level = t >= 8100 && t <= 8300 ? 0.09 : 0.5;
      const cut = tracker.feed({ level, atMs: t });
      if (cut) cuts.push(cut);
    }
    expect(cuts.length).toBeGreaterThanOrEqual(1);
    // в тихом провале 8 100…8 300 — там слово и кончается
    expect(cuts[0].atMs).toBeGreaterThanOrEqual(8100);
    expect(cuts[0].atMs).toBeLessThanOrEqual(8300);
    expect(cuts[0].timed).toBe(true);
  });

  it('перекрытие отдаётся отдельным числом, чтобы движок знал, сколько повторить', () => {
    expect(createSpeechTracker().overlapMs).toBe(CHUNK_OVERLAP_MS);
  });
});

describe('склейка кусков с перекрытием', () => {
  it('снимает дубль на стыке', () => {
    expect(mergeOverlap('Смотри, мне нужно.', 'мне нужно. Сделай программу.')).toBe(
      'Смотри, мне нужно. Сделай программу.',
    );
  });

  it('выбрасывает обрывок слова на границе', () => {
    expect(mergeOverlap('Сделай программу', 'му на снижение цен')).toBe(
      'Сделай программу на снижение цен',
    );
    expect(mergeOverlap('в автоматическом режиме', 'е на Windows')).toBe(
      'в автоматическом режиме на Windows',
    );
  });

  it('без перекрытия склеивает как обычные куски', () => {
    expect(mergeOverlap('Привет', 'как дела')).toBe('Привет как дела');
  });

  it('не съедает осмысленный повтор, если человек правда повторил слово', () => {
    expect(mergeOverlap('да, да', 'да')).toBe('да, да');
  });

  it('с одним пустым куском возвращает другой', () => {
    expect(mergeOverlap('', 'текст')).toBe('текст');
    expect(mergeOverlap('текст', '')).toBe('текст');
  });
});
