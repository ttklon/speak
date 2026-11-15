import { describe, it, expect } from 'vitest';
import pkg from '../../package.json';
import { APP, NAV, LANGUAGES, MODELS, STORAGE_KEYS, DEFAULT_SETTINGS, DEFAULT_VOICE_HOTKEYS, DEFAULT_AI_PRESETS } from './config.js';
import { PAGES } from './router.js';

const unique = (arr) => new Set(arr).size === arr.length;

describe('настройки по умолчанию', () => {
  it('версия в приложении совпадает с package.json', () => {
    expect(APP.version).toBe(pkg.version);
  });

  it('все значения простые: строка, число или флаг', () => {
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      const type = Array.isArray(value) ? 'array' : typeof value;
      expect(['string', 'number', 'boolean', 'array'], `настройка ${key}`).toContain(type);
      if (type === 'array') expect(value.length, `настройка ${key}`).toBeGreaterThan(0);
    }
  });

  it('числовые настройки в разумных пределах', () => {
    expect(DEFAULT_SETTINGS.aiPolishBudgetMs).toBeGreaterThan(0);
    expect(DEFAULT_SETTINGS.aiPolishBudgetMs).toBeLessThanOrEqual(5000);
    expect(DEFAULT_SETTINGS.clipboardRetentionDays).toBeGreaterThan(0);
    expect(DEFAULT_SETTINGS.dictationRetentionDays).toBeGreaterThan(0);
    expect(DEFAULT_SETTINGS.clipboardMaxItems).toBeGreaterThan(0);
    expect(['clipboard', 'sendinput']).toContain(DEFAULT_SETTINGS.insertMethod);
    expect(['stable', 'beta']).toContain(DEFAULT_SETTINGS.updateChannel);
    expect(['dark', 'light']).toContain(DEFAULT_SETTINGS.theme);
  });

  it('язык по умолчанию есть в списке языков', () => {
    expect(LANGUAGES.map((l) => l.id)).toContain(DEFAULT_SETTINGS.language);
    expect(LANGUAGES.map((l) => l.id)).toContain(DEFAULT_SETTINGS.translateTarget);
  });
});

describe('справочники', () => {
  it('языки: без повторов, у каждого есть подпись', () => {
    expect(unique(LANGUAGES.map((l) => l.id))).toBe(true);
    for (const lang of LANGUAGES) expect(lang.label && lang.native).toBeTruthy();
  });

  it('модели: без повторов, рекомендованная ровно одна и быстрая', () => {
    expect(unique(MODELS.map((m) => m.id))).toBe(true);
    const recommended = MODELS.filter((m) => m.recommended);
    expect(recommended).toHaveLength(1);
    for (const model of MODELS) expect(model.label && model.size && model.speed).toBeTruthy();
    expect(MODELS.map((m) => m.id)).toContain(DEFAULT_SETTINGS.whisperModel);
  });

  it('ключи хранилища не пересекаются и с префиксом zs.', () => {
    const keys = Object.values(STORAGE_KEYS);
    expect(unique(keys)).toBe(true);
    for (const key of keys) expect(key).toMatch(/^zs\./);
  });

  it('разделы навигации совпадают с маршрутами', () => {
    expect(unique(NAV.map((n) => n.id))).toBe(true);
    expect(NAV.map((n) => n.id).sort()).toEqual([...PAGES].sort());
    for (const item of NAV) expect(item.label).toBeTruthy();
  });

  it('голосовые сочетания: id уникальны, клавиши на месте, диктовка включена', () => {
    expect(unique(DEFAULT_VOICE_HOTKEYS.map((h) => h.id))).toBe(true);
    for (const hk of DEFAULT_VOICE_HOTKEYS) {
      expect(Array.isArray(hk.keys) && hk.keys.length).toBeTruthy();
      expect(hk.title).toBeTruthy();
      expect(hk.description.length).toBeGreaterThan(10);
    }
    expect(DEFAULT_VOICE_HOTKEYS.find((h) => h.id === 'dictation').enabled).toBe(true);
    expect(DEFAULT_VOICE_HOTKEYS.find((h) => h.id === 'dictation').keys).toEqual(DEFAULT_SETTINGS.dictationKeys);
  });

  it('AI-пресеты: уникальные id и непустые подсказки', () => {
    expect(unique(DEFAULT_AI_PRESETS.map((p) => p.id))).toBe(true);
    for (const preset of DEFAULT_AI_PRESETS) {
      expect(preset.title).toBeTruthy();
      expect(preset.prompt.length).toBeGreaterThan(10);
    }
  });
});
