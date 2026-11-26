import { describe, expect, it } from 'vitest';
import { backupRetentionImpact } from './backupPreview.js';

describe('последствия срока хранения при восстановлении', () => {
  const now = 1800000000000;
  const old = now - 40 * 86400000;
  const settings = { dictationRetentionDays: 30, clipboardRetentionDays: 30 };

  it('учитывает настройки из копии, текущую историю и закреплённый буфер', () => {
    const impact = backupRetentionImpact({
      prepared: { settings: { dictationRetentionDays: 0, clipboardRetentionDays: 0 } }, settings, now,
      dictations: [{ createdAt: now }],
      clipboard: [{ createdAt: now, text: 'секрет' }, { createdAt: now, pinned: true }, { createdAt: 0 }],
    });
    expect(impact).toEqual({ dictations: 1, clipboard: 1, importedHistory: false });
  });

  it('для заменяемой истории показывает риск для копии, а не текущих записей', () => {
    expect(backupRetentionImpact({
      prepared: { dictations: [{ createdAt: old }, { createdAt: now }] }, settings, now,
      dictations: [{ createdAt: old }, { createdAt: old }], clipboard: [],
    })).toEqual({ dictations: 1, clipboard: 0, importedHistory: true });
  });

  it('бессрочный срок и отсутствие даты не удаляют записи', () => {
    expect(backupRetentionImpact({
      prepared: { settings: { dictationRetentionDays: 3650, clipboardRetentionDays: 3650 } }, settings, now,
      dictations: [{ createdAt: old }], clipboard: [{ createdAt: old }],
    })).toEqual({ dictations: 0, clipboard: 0, importedHistory: false });
    expect(backupRetentionImpact({ prepared: {}, settings, now,
      dictations: [{ createdAt: 0 }], clipboard: [{ createdAt: 0 }],
    })).toEqual({ dictations: 0, clipboard: 0, importedHistory: false });
  });
});

describe('выбор разделов резервной копии', () => {
  it('оставляет метку версии и только выбранные разделы, не меняя исходный файл', async () => {
    const { selectBackupSections, backupSectionSummary } = await import('./backupPreview.js');
    const payload = { app: 'ZSpeakly', format: 1, exportedAt: '2026-01-02', dictations: [{ text: 'личное' }], dictionary: [], settings: { language: 'ru' }, future: 'секрет' };
    expect(selectBackupSections(payload, ['dictionary', 'settings'])).toEqual({ app: 'ZSpeakly', format: 1, exportedAt: '2026-01-02', dictionary: [], settings: { language: 'ru' } });
    expect(payload.dictations).toHaveLength(1);
    expect(backupSectionSummary('dictations', { dictations: [1, 2] }, { dictations: [3] })).toBe('Сейчас: 1 · в копии: 2');
    expect(backupSectionSummary('dictionary', { dictionary: [] }, { dictionary: [1, 2, 3] })).toBe('Сейчас: 3 · в копии: 0 · раздел будет очищен');
    expect(backupSectionSummary('settings', { settings: {} }, { settings: {} })).toMatch(/замен/i);
  });
  it('подсчитывает пересекающиеся и исчезающие ID без раскрытия содержимого', async () => {
    const { backupIdentitySummary } = await import('./backupPreview.js');
    const current = [{ id: 'a', text: 'секрет' }, { id: 'b' }];
    const incoming = [{ id: 'b', text: 'другой секрет' }, { id: 'c' }];
    expect(backupIdentitySummary('dictations', { dictations: incoming }, { dictations: current }))
      .toBe('Общих ID: 1 · прежних ID нет в копии: 1');
    expect(backupIdentitySummary('dictations', { dictations: [{ id: 'b' }, { id: 'b' }] }, { dictations: current })).toBe('');
    expect(backupIdentitySummary('dictations', { dictations: [{ text: 'без id' }] }, { dictations: current })).toBe('');
    expect(backupIdentitySummary('settings', { settings: {} }, { settings: {} })).toBe('');
  });

  it('не допускает пустой, неизвестный или отсутствующий выбор', async () => {
    const { selectBackupSections } = await import('./backupPreview.js');
    expect(typeof selectBackupSections).toBe('function');
    for (const sections of [[], ['unknown'], ['settings'], ['dictations', 'dictations']]) {
      expect(() => selectBackupSections({ dictations: [] }, sections)).toThrow();
    }
  });
});
