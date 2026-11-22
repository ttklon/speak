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
