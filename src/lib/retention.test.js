import { describe, it, expect } from 'vitest';
import { pruneByAge, isForever, FOREVER_DAYS } from './retention.js';

const DAY = 86400000;
const now = 1_700_000_000_000;
const item = (daysAgo, extra = {}) => ({ createdAt: now - daysAgo * DAY, text: `d${daysAgo}`, ...extra });

describe('срок хранения записей', () => {
  it('«Бессрочно» и пустое значение ничего не удаляют', () => {
    const items = [item(1), item(4000)];
    expect(isForever(FOREVER_DAYS)).toBe(true);
    expect(isForever(undefined)).toBe(true);
    expect(pruneByAge(items, FOREVER_DAYS, { now })).toBe(items);
    expect(pruneByAge(items, undefined, { now })).toBe(items);
  });

  it('удаляет записи старше срока и оставляет свежие', () => {
    const items = [item(1), item(10), item(40)];
    const kept = pruneByAge(items, 30, { now });
    expect(kept.map((i) => i.text)).toEqual(['d1', 'd10']);
  });

  it('«Не хранить» (0) оставляет только закреплённое', () => {
    const items = [item(0), item(0, { pinned: true })];
    const kept = pruneByAge(items, 0, { keepPinned: true, now });
    expect(kept).toHaveLength(1);
    expect(kept[0].pinned).toBe(true);
  });

  it('без keepPinned закреплённое тоже удаляется', () => {
    expect(pruneByAge([item(100, { pinned: true })], 7, { now })).toHaveLength(0);
  });

  it('записи без даты не стираются — возраст неизвестен', () => {
    const items = [{ text: 'из старой копии' }, { text: 'битая дата', createdAt: 'вчера' }, item(1)];
    expect(pruneByAge(items, 1, { now })).toHaveLength(3);
  });

  it('не меняет массив, если удалять нечего (React не перерисовывается зря)', () => {
    const items = [item(0), item(1)];
    expect(pruneByAge(items, 30, { now })).toBe(items);
  });

  it('пустой список и мусор на входе не роняют', () => {
    expect(pruneByAge([], 5, { now })).toEqual([]);
    expect(pruneByAge(null, 5, { now })).toEqual([]);
  });
});
