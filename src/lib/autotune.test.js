import { describe, it, expect } from 'vitest';
import { TUNED, TUNED_KEYS, tuneSettings } from './autotune.js';
import { DEFAULT_SETTINGS } from './config.js';

describe('настройки, которые выбирает приложение', () => {
  it('все ключи существуют в DEFAULT_SETTINGS — иначе значение не сохранится', () => {
    for (const key of TUNED_KEYS) expect(DEFAULT_SETTINGS, key).toHaveProperty(key);
  });

  it('скорость важнее украшений: VAD включён, автоподбор модели включён', () => {
    expect(TUNED.vadEnabled).toBe(true);
    expect(TUNED.autoOptimize).toBe(true);
    expect(TUNED.aiPolishBudgetMs).toBeLessThanOrEqual(1000);
    expect(TUNED.typingEffect).toBe(false);
  });

  it('то, что зависит от вкуса или приватности, остаётся человеку', () => {
    // эти ключи НЕ заставляются: живая расшифровка, горячий микрофон и «держать
    // модель в памяти» — реальные тумблеры, у каждого свой ответ
    expect(TUNED).not.toHaveProperty('liveWhisper');
    expect(TUNED).not.toHaveProperty('micPreroll');
    expect(TUNED).not.toHaveProperty('keepModelLoaded');
  });

  it('полировка не задерживает вставку, а включается в config.js по умолчанию', () => {
    expect(TUNED.aiPolishBudgetMs).toBeLessThanOrEqual(1000);
    expect(DEFAULT_SETTINGS.aiDictationRewrite).toBe(true);
    expect(TUNED).not.toHaveProperty('aiDictationRewrite');
  });

  it('текст всегда чистится, пароли всегда скрыты, вставка — через буфер', () => {
    expect(TUNED.aiProcessing).toBe(true);
    expect(TUNED.hidePasswords).toBe(true);
    expect(TUNED.insertMethod).toBe('clipboard');
  });

  it('ничего нечего менять — возвращается тот же объект (без лишних перерисовок)', () => {
    const tuned = { ...DEFAULT_SETTINGS, ...TUNED };
    expect(tuneSettings(tuned)).toBe(tuned);
  });

  it('испорченные сохранённые значения заменяются идеальными', () => {
    const stored = { ...DEFAULT_SETTINGS, ...TUNED, aiPolishBudgetMs: 9000, vadEnabled: false };
    const fixed = tuneSettings(stored);
    expect(fixed).not.toBe(stored);
    expect(fixed.aiPolishBudgetMs).toBe(900);
    expect(fixed.vadEnabled).toBe(true);
  });

  it('остальные настройки не трогаются: выбор человека сохраняется', () => {
    const stored = { ...DEFAULT_SETTINGS, ...TUNED, theme: 'light', language: 'en', userName: 'Аня' };
    expect(tuneSettings(stored)).toBe(stored);
  });

  it('пустой профиль (первый запуск) получает идеальные значения', () => {
    const fixed = tuneSettings({});
    expect(fixed).toMatchObject(TUNED);
  });

  it('мусор на входе не роняет', () => {
    expect(tuneSettings(null)).toMatchObject(TUNED);
    expect(tuneSettings('строка')).toMatchObject(TUNED);
  });
});
