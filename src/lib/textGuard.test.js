import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { collapseRepetition, looksLikeLoop } = require('../../electron/textGuard.cjs');

describe('сворачивание повторов движка', () => {
  it('одна и та же фраза подряд остаётся один раз', () => {
    expect(
      collapseRepetition(
        'Спасибо за просмотр. Спасибо за просмотр. Спасибо за просмотр.',
      ),
    ).toBe('Спасибо за просмотр.');
  });

  it('два повтора — это ещё речь, не трогаем', () => {
    const text = 'Очень важно. Очень важно.';
    expect(collapseRepetition(text)).toBe(text);
  });

  it('сворачивает длинный повтор, а не только короткий', () => {
    const line = 'нам нужно сделать программу на снижение цен';
    expect(collapseRepetition(`${line} ${line} ${line} ${line}`)).toBe(line);
  });

  it('не портит нормальный текст с разными словами', () => {
    const text = 'Смотри, мне нужно, чтобы ты сделал программу на снижение цен. Всё в автоматическом режиме.';
    expect(collapseRepetition(text)).toBe(text);
  });

  it('реальный повтор внутри фразы сохраняется, если он не подряд и не втрое', () => {
    const text = 'я сказал что это важно и это правда важно';
    expect(collapseRepetition(text)).toBe(text);
  });

  it('пустой текст остаётся пустым', () => {
    expect(collapseRepetition('')).toBe('');
    expect(collapseRepetition(null)).toBe('');
  });
});

describe('признак зацикливания', () => {
  it('петля распознаётся', () => {
    expect(
      looksLikeLoop('Спасибо за просмотр. Спасибо за просмотр. Спасибо за просмотр. Спасибо за просмотр.'),
    ).toBe(true);
  });

  it('обычная длинная речь петлёй не считается', () => {
    expect(
      looksLikeLoop(
        'Смотри, мне нужно, чтобы ты сейчас сделал программу на снижение цен, всё в автоматическом режиме, без ручной работы.',
      ),
    ).toBe(false);
  });

  it('короткая фраза не считается петлёй, даже если совпала', () => {
    expect(looksLikeLoop('да да да')).toBe(false);
  });
});
