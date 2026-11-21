import { describe, expect, it } from 'vitest';
import {
  DICTATION_MAX_BYTES,
  DICTATION_MAX_ITEMS,
  dictationBytes,
  dictationsBytes,
  trimDictations,
} from './dictationBudget.js';

/** Запись с текстом заданной длины. */
const item = (id, chars) => ({ id, text: 'я'.repeat(chars), createdAt: Number(id) || 0 });

describe('бюджет истории диктовок', () => {
  it('вес считает текст и служебные поля', () => {
    expect(dictationBytes(item('1', 10))).toBe((10 + 80) * 2);
    expect(dictationBytes(null)).toBe(0);
    expect(dictationsBytes([item('1', 10), item('2', 10)])).toBe((10 + 80) * 4);
  });

  it('маленькая история не трогается (тот же массив)', () => {
    const list = [item('1', 100), item('2', 200)];
    expect(trimDictations(list)).toBe(list);
  });

  it('количество записей ограничено, новые остаются', () => {
    const list = Array.from({ length: 10 }, (_, i) => item(String(10 - i), 5));
    const kept = trimDictations(list, { maxItems: 3 });
    expect(kept.map((x) => x.id)).toEqual(['10', '9', '8']);
  });

  it('вес ограничен: длинные старые записи выпадают', () => {
    // бюджет 10 000 байт, каждая запись ≈ (2000+80)*2 = 4160
    const list = [item('1', 2000), item('2', 2000), item('3', 2000)];
    const kept = trimDictations(list, { maxBytes: 10_000 });
    expect(kept.map((x) => x.id)).toEqual(['1', '2']);
  });

  it('запись, которая не влезает целиком, не обрезается посередине', () => {
    const list = [item('1', 100), item('2', 5000)];
    const kept = trimDictations(list, { maxBytes: 1000 });
    expect(kept.map((x) => x.id)).toEqual(['1']);
  });

  it('пустая история и мусор', () => {
    expect(trimDictations([])).toEqual([]);
    expect(trimDictations(null)).toBeNull();
  });

  it('по умолчанию лимиты разумные', () => {
    expect(DICTATION_MAX_ITEMS).toBeGreaterThanOrEqual(1000);
    expect(DICTATION_MAX_BYTES).toBeGreaterThanOrEqual(4 * 1024 * 1024);
    expect(trimDictations(Array.from({ length: 2100 }, (_, i) => item(String(i), 10)))).toHaveLength(
      DICTATION_MAX_ITEMS,
    );
  });
});
