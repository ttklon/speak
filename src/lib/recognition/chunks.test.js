import { describe, expect, it } from 'vitest';
import {
  CHUNK_MIN_MS,
  CHUNK_SILENCE_MS,
  createSpeechTracker,
  joinChunks,
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
  it('на непрерывной речи не режет ничего — нечего считать заранее', () => {
    const tracker = createSpeechTracker();
    const samples = [];
    for (let t = 0; t <= 20000; t += 100) samples.push([0.4, t]);
    expect(feedLevels(tracker, samples)).toEqual([]);
    expect(tracker.committedMs).toBe(0);
  });

  it('на паузе после длинной речи отдаёт кусок и режет середину паузы', () => {
    const tracker = createSpeechTracker();
    const samples = [];
    // десять секунд речи, потом тишина
    for (let t = 0; t < 10000; t += 100) samples.push([0.5, t]);
    // тишина начинается около 10 000, длится секунду
    for (let t = 10000; t <= 11000; t += 100) samples.push([0, t]);
    const cuts = feedLevels(tracker, samples);
    expect(cuts).toHaveLength(1);
    expect(cuts[0].fromMs).toBe(0);
    // середина паузы: 10 000 + 650/2 ≈ 10 325 — слово не распадается
    expect(cuts[0].atMs).toBeGreaterThan(10000);
    expect(cuts[0].atMs).toBeLessThan(10000 + CHUNK_SILENCE_MS);
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
    for (let t = 0; t < 10000; t += 100) tracker.feed({ level: 0.5, atMs: t });
    let cut = null;
    for (let t = 10000; t <= 11000; t += 100) cut = tracker.feed({ level: 0, atMs: t }) || cut;
    expect(cut).not.toBeNull();
    tracker.rollback(cut.fromMs);
    expect(tracker.committedMs).toBe(0);
    // после отката тот же звук можно нарезать снова
    let again = null;
    for (let t = 11000; t <= 12000; t += 100) again = tracker.feed({ level: 0, atMs: t }) || again;
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
});
