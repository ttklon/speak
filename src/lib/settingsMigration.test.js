import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from './config.js';
import { migrateSettings, SPEED_FIX_MARKER, MODEL_TIER_FIX_MARKER } from './settingsMigration.js';
import { TIER_MODELS } from './modelTiers.js';

describe('миграция настроек 1.5.1', () => {
  it('старый small переводится в соответствующий режим, живая расшифровка — «сама»', () => {
    const prev = { whisperModel: 'small', liveWhisper: true, keepModelLoaded: undefined };
    const next = migrateSettings(prev, DEFAULT_SETTINGS);
    expect(next.whisperModel).toBe('small-q5_1');
    // раньше здесь было жёсткое false; теперь решение принимает
    // lib/liveDraftPolicy.js, и выбор человека не выключается навсегда
    expect(next.liveWhisper).toBe('auto');
    expect(next.keepModelLoaded).toBe(true);
    expect(next[SPEED_FIX_MARKER]).toBe(true);
  });

  it('осознанный выбор модели и живой расшифровки не перезаписывается', () => {
    const prev = { whisperModel: 'medium', liveWhisper: false, keepModelLoaded: false };
    const next = migrateSettings(prev, DEFAULT_SETTINGS);
    expect(next.whisperModel).toBe('large-v3-turbo-q5_0');
    expect(next.liveWhisper).toBe(false);
    expect(next.keepModelLoaded).toBe(false);
  });

  it('повторная миграция ничего не меняет', () => {
    const prev = {
      ...DEFAULT_SETTINGS,
      whisperModel: 'small',
      liveWhisper: true,
      [SPEED_FIX_MARKER]: true,
      [MODEL_TIER_FIX_MARKER]: true,
    };
    const next = migrateSettings(prev, DEFAULT_SETTINGS);
    expect(next.whisperModel).toBe('small');
    expect(next.liveWhisper).toBe(true);
  });

  it.each([undefined, false, true])('старый small не понижается при маркере скорости %s', (marker) => {
    const old = { whisperModel: 'small', [SPEED_FIX_MARKER]: marker };
    const next = migrateSettings(old, DEFAULT_SETTINGS);
    expect(next.whisperModel).toBe('small-q5_1');
    expect(next[MODEL_TIER_FIX_MARKER]).toBe(true);
    expect(migrateSettings(next, DEFAULT_SETTINGS)).toEqual(next);
  });

  it('не пытается восстановить уже мигрированный base: нельзя знать, что выбрал пользователь', () => {
    const prev = { whisperModel: 'base-q5_1', [SPEED_FIX_MARKER]: true, [MODEL_TIER_FIX_MARKER]: true };
    expect(migrateSettings(prev, DEFAULT_SETTINGS).whisperModel).toBe('base-q5_1');
  });

  it('остальные настройки сохраняются, а новые поля берутся из умолчаний', () => {
    const prev = { whisperModel: 'small', theme: 'light' };
    const next = migrateSettings(prev, DEFAULT_SETTINGS);
    expect(next.theme).toBe('light');
    expect(next.insertMethod).toBe(DEFAULT_SETTINGS.insertMethod);
  });

  it('старое имя модели переводится на существующий режим — и никогда не остаётся вне каталога', () => {
    for (const old of ['base', 'small', 'tiny', 'medium', 'large', 'tiny-q5_1', 'medium-q5_0']) {
      const next = migrateSettings({ whisperModel: old }, DEFAULT_SETTINGS);
      expect(TIER_MODELS).toContain(next.whisperModel);
      expect(next[MODEL_TIER_FIX_MARKER]).toBe(true);
    }
  });

  it('неизвестное имя модели заменяется умолчанием, а не остаётся мёртвым', () => {
    const next = migrateSettings({ whisperModel: 'my-custom-model' }, DEFAULT_SETTINGS);
    expect(next.whisperModel).toBe(DEFAULT_SETTINGS.whisperModel);
  });

  it('имя режима сохраняется как есть', () => {
    const next = migrateSettings({ whisperModel: 'large-v3-turbo-q5_0' }, DEFAULT_SETTINGS);
    expect(next.whisperModel).toBe('large-v3-turbo-q5_0');
  });
});
