import { describe, it, expect } from 'vitest';
import { buildSeedDictations, buildSeedClipboard, SEED_DICTIONARY } from './seed.js';
import { words } from './utils.js';

const now = new Date('2026-11-11T12:00:00');

describe('демо-данные для тестов и первого запуска', () => {
  it('диктовки: уникальные id, непустой текст, посчитанные слова и длительность', () => {
    const items = buildSeedDictations(now);
    expect(items.length).toBeGreaterThan(10);
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
    for (const item of items) {
      expect(item.text.trim().length).toBeGreaterThan(10);
      expect(item.durationMs).toBeGreaterThan(0);
      expect(item.words).toBe(words(item.text));
      expect(Number.isFinite(item.createdAt)).toBe(true);
    }
  });

  it('диктовки идут от новых к старым', () => {
    const times = buildSeedDictations(now).map((i) => i.createdAt);
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it('буфер: сортировка, дата в прошлом, картинки — data-URL', () => {
    const items = buildSeedClipboard(now);
    const times = items.map((i) => i.createdAt);
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    for (const item of items) {
      expect(item.createdAt).toBeLessThanOrEqual(now.getTime());
      expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
      if (item.kind === 'image') expect(item.image).toMatch(/^data:image\/svg\+xml/);
      else expect(item.text.trim().length).toBeGreaterThan(0);
    }
  });

  it('буфер содержит и текст, и изображения — иначе экран выглядит пустым', () => {
    const items = buildSeedClipboard(now);
    expect(items.some((i) => i.kind !== 'image')).toBe(true);
    expect(items.some((i) => i.kind === 'image')).toBe(true);
  });

  it('словарь: короткие слова без повторов', () => {
    expect(SEED_DICTIONARY.length).toBeGreaterThan(0);
    expect(new Set(SEED_DICTIONARY.map((w) => w.word)).size).toBe(SEED_DICTIONARY.length);
    for (const entry of SEED_DICTIONARY) expect(entry.word.trim()).toBe(entry.word);
  });
});
