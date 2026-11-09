/**
 * Проверки «настроек, которые раньше были заглушками»:
 * срок хранения записей, звук, эффект печати, скрытие паролей, тема.
 *
 * Тесты держат именно поведение, а не наличие тумблера в разметке.
 */
import { describe, expect, it, vi } from 'vitest';
import { typeOut, playCue } from './lib/feedback.js';
import { isForever, pruneByAge } from './lib/retention.js';

describe('эффект печати', () => {
  it('выдаёт текст частями и заканчивается полным текстом', async () => {
    const seen = [];
    const text = 'привет как дела у тебя сегодня';
    const result = await typeOut(text, (partial) => seen.push(partial), { stepMs: 0, wordsPerStep: 2 });
    expect(result).toBe(text);
    expect(seen.length).toBeGreaterThan(1);
    expect(seen[seen.length - 1]).toBe(text);
    // каждый следующий кусок длиннее предыдущего
    for (let i = 1; i < seen.length; i += 1) {
      expect(seen[i].length).toBeGreaterThan(seen[i - 1].length);
    }
  });

  it('пустой текст — нечего печатать, но промис закрывается', async () => {
    const onTick = vi.fn();
    await expect(typeOut('   ', onTick, { stepMs: 0 })).resolves.toBe('   ');
    expect(onTick).not.toHaveBeenCalled();
  });

  it('отмена возвращает полный текст', async () => {
    const controller = { aborted: true };
    const onTick = vi.fn();
    await expect(typeOut('раз два три', onTick, { signal: controller, stepMs: 0 })).resolves.toBe(
      'раз два три',
    );
    expect(onTick).not.toHaveBeenCalled();
  });
});

describe('звуковой отклик', () => {
  it('не падает без WebAudio (тестовая среда)', () => {
    expect(() => playCue('start')).not.toThrow();
    expect(() => playCue('stop')).not.toThrow();
  });
});

describe('срок хранения записей', () => {
  const day = 86400000;
  const now = 1_800_000_000_000;
  const items = [
    { id: 'fresh', createdAt: now - 1 * day },
    { id: 'week', createdAt: now - 6 * day },
    { id: 'old', createdAt: now - 40 * day },
    { id: 'ancient', createdAt: now - 400 * day },
    { id: 'pinned-old', createdAt: now - 40 * day, pinned: true },
  ];

  it('бессрочно ничего не удаляет', () => {
    expect(isForever(3650)).toBe(true);
    expect(pruneByAge(items, 3650, { now })).toBe(items);
  });

  it('неделя оставляет только свежее', () => {
    expect(pruneByAge(items, 7, { now }).map((i) => i.id)).toEqual(['fresh', 'week']);
  });

  it('месяц оставляет закреплённое и записи за месяц', () => {
    expect(pruneByAge(items, 30, { now, keepPinned: true }).map((i) => i.id)).toEqual([
      'fresh',
      'week',
      'pinned-old',
    ]);
  });

  it('«Не хранить» очищает всё', () => {
    expect(pruneByAge(items, 0, { now })).toEqual([]);
  });

  it('некорректный срок считается бессрочным, пустой список не ломает', () => {
    expect(isForever(undefined)).toBe(true);
    expect(pruneByAge([], 7, { now })).toEqual([]);
    expect(pruneByAge(null, 7, { now })).toEqual([]);
  });
});
