import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from './config.js';
import { migrateSettings, SPEED_FIX_MARKER } from './settingsMigration.js';

describe('миграция настроек 1.5.1', () => {
  it('старые умолчания переводятся на быстрые: base вместо small, живая расшифровка выключена', () => {
    const prev = { whisperModel: 'small', liveWhisper: true, keepModelLoaded: undefined };
    const next = migrateSettings(prev, DEFAULT_SETTINGS);
    expect(next.whisperModel).toBe('base');
    expect(next.liveWhisper).toBe(false);
    expect(next.keepModelLoaded).toBe(true);
    expect(next[SPEED_FIX_MARKER]).toBe(true);
  });

  it('осознанный выбор модели и живой расшифровки не перезаписывается', () => {
    const prev = { whisperModel: 'medium', liveWhisper: false, keepModelLoaded: false };
    const next = migrateSettings(prev, DEFAULT_SETTINGS);
    expect(next.whisperModel).toBe('medium');
    expect(next.liveWhisper).toBe(false);
    expect(next.keepModelLoaded).toBe(false);
  });

  it('повторная миграция ничего не меняет', () => {
    const prev = { ...DEFAULT_SETTINGS, whisperModel: 'small', liveWhisper: true, [SPEED_FIX_MARKER]: true };
    const next = migrateSettings(prev, DEFAULT_SETTINGS);
    expect(next.whisperModel).toBe('small');
    expect(next.liveWhisper).toBe(true);
  });

  it('остальные настройки сохраняются, а новые поля берутся из умолчаний', () => {
    const prev = { whisperModel: 'small', theme: 'light' };
    const next = migrateSettings(prev, DEFAULT_SETTINGS);
    expect(next.theme).toBe('light');
    expect(next.insertMethod).toBe(DEFAULT_SETTINGS.insertMethod);
  });
});
