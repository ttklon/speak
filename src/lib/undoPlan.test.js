import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { planUndo } = require('../../electron/undoLast.cjs');

describe('безопасная отмена', () => {
  it('не стирает без подтверждения позиции курсора даже в том же приложении', () => {
    const base = { text: 'привет', at: Date.now(), platform: 'win32', targetApp: 'Telegram', currentApp: 'Telegram' };
    expect(planUndo(base)).toEqual({ ok: false, reason: 'неподтверждённая позиция курсора' });
  });
  it('не стирает при неизвестном окне или после смены окна', () => {
    expect(planUndo({ text: 'слова', targetApp: '', currentApp: '' }).ok).toBe(false);
    expect(planUndo({ text: 'слова', targetApp: 'Telegram', currentApp: 'Code' }).ok).toBe(false);
  });
  it('не стирает длинный и составной текст, где длина не равна числу Backspace', () => {
    for (const text of ['🙂', 'e\u0301', '\r\n', 'x'.repeat(4001)]) expect(planUndo({ text }).ok).toBe(false);
  });
  it('без предыдущего текста объясняет, что нечего убирать', () => {
    expect(planUndo()).toEqual({ ok: false, reason: 'нечего убирать' });
    expect(planUndo({ text: '   ' }).reason).toBe('нечего убирать');
  });
});
