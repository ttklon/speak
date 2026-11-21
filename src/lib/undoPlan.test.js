import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { planUndo, UNDO_TTL_MS } = require('../../electron/undoLast.cjs');

const base = {
  text: 'привет, мир',
  at: 1000,
  now: 2000,
  platform: 'win32',
  own: false,
  targetApp: 'Telegram',
  currentApp: 'Telegram',
};

describe('planUndo', () => {
  it('разрешает стереть столько символов, сколько вставили', () => {
    const plan = planUndo(base);
    expect(plan).toEqual({ ok: true, chars: 11 });
  });

  it('считает символы, а не байты: эмодзи — один Backspace', () => {
    expect(planUndo({ ...base, text: 'ок 🙂' }).chars).toBe(4);
  });

  it('не трогает пустую вставку', () => {
    expect(planUndo({ ...base, text: '' }).ok).toBe(false);
    expect(planUndo({ ...base, text: '   ' }).reason).toMatch(/нечего/);
  });

  it('отказывает после двух минут', () => {
    const old = planUndo({ ...base, now: 1000 + UNDO_TTL_MS + 1 });
    expect(old.ok).toBe(false);
    expect(old.reason).toMatch(/двух минут/);
    expect(planUndo({ ...base, now: 1000 + UNDO_TTL_MS }).ok).toBe(true);
  });

  it('без отметки времени не стирает: непонятно, что именно убирать', () => {
    expect(planUndo({ ...base, at: 0 }).ok).toBe(false);
  });

  it('вне Windows объясняет, почему нельзя', () => {
    const plan = planUndo({ ...base, platform: 'linux' });
    expect(plan.ok).toBe(false);
    expect(plan.reason).toMatch(/Windows/);
  });

  it('не стирает в собственном окне', () => {
    expect(planUndo({ ...base, own: true }).reason).toMatch(/ZSpeakly/);
  });

  it('сверяет приложение и прощает .exe и регистр', () => {
    expect(planUndo({ ...base, currentApp: 'telegram.exe' }).ok).toBe(true);
    const other = planUndo({ ...base, currentApp: 'Code' });
    expect(other.ok).toBe(false);
    expect(other.reason).toContain('Telegram');
    expect(other.reason).toContain('Code');
  });

  it('если окно не прочиталось — не отказывает', () => {
    expect(planUndo({ ...base, targetApp: '', currentApp: '' }).ok).toBe(true);
    expect(planUndo({ ...base, currentApp: '' }).ok).toBe(true);
  });
});
