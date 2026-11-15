import { describe, it, expect } from 'vitest';
import { CLIPBOARD_MAX_BYTES, itemBytes, trimByBytes, totalBytes } from './clipboardBudget.js';

const text = (id, value = 'строка') => ({ id, kind: 'text', text: value });
const image = (id, kb) => ({ id, kind: 'image', image: 'x'.repeat(kb * 512) }); // 512 символов ≈ 1 КБ

describe('бюджет истории буфера', () => {
  it('вес считается по содержимому, картинки тяжелее текста', () => {
    expect(itemBytes(image('i', 100))).toBeGreaterThan(itemBytes(text('t')) * 100);
    expect(itemBytes(null)).toBe(0);
    expect(itemBytes({})).toBeGreaterThan(0);
  });

  it('под бюджетом ничего не режется и массив остаётся тем же', () => {
    const items = [text('a'), text('b'), text('c')];
    expect(trimByBytes(items, 1024 * 1024)).toBe(items);
  });

  it('старые записи уходят, свежие остаются', () => {
    const items = [text('new'), text('old1'), text('old2')];
    const one = itemBytes(text('x')) + 10;
    const kept = trimByBytes(items, one);
    expect(kept.length).toBeLessThan(items.length);
    expect(kept[0].id).toBe('new');
  });

  it('закреплённое не выбрасывается даже при переполнении', () => {
    const items = [image('big', 200), { ...image('pin', 100), pinned: true }, text('tail')];
    const kept = trimByBytes(items, 50 * 1024);
    expect(kept.map((i) => i.id)).toEqual(['pin']);
  });

  it('по умолчанию бюджет — 24 МБ', () => {
    expect(CLIPBOARD_MAX_BYTES).toBe(24 * 1024 * 1024);
    const heavy = Array.from({ length: 40 }, (_, i) => image(`img${i}`, 1024)); // ≈40 МБ
    const kept = trimByBytes(heavy);
    expect(kept.length).toBeLessThan(heavy.length);
    expect(totalBytes(kept)).toBeLessThanOrEqual(CLIPBOARD_MAX_BYTES + itemBytes(image('x', 1024)));
    expect(kept[0].id).toBe('img0');
  });

  it('пустой список и мусор не роняют', () => {
    expect(trimByBytes([])).toEqual([]);
    expect(trimByBytes(null)).toBeNull();
    expect(totalBytes(null)).toBe(0);
  });
});
