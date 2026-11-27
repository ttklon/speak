import { pruneByAge } from './retention.js';

/**
 * Оценка на момент предпросмотра: те же правила, что применяет провайдер.
 * Очистка может произойти сразу или при следующем запуске; пока диалог открыт,
 * данные и время могут измениться, поэтому это не гарантия точного числа.
 */
export function backupRetentionImpact({ prepared, settings, dictations, clipboard, now = Date.now() }) {
  const nextSettings = prepared.settings || settings;
  const importedHistory = Object.prototype.hasOwnProperty.call(prepared, 'dictations');
  const history = importedHistory ? prepared.dictations : dictations;
  const keptHistory = pruneByAge(history, nextSettings.dictationRetentionDays, { now });
  const keptClipboard = pruneByAge(clipboard, nextSettings.clipboardRetentionDays, { now, keepPinned: true });
  return {
    dictations: history.length - keptHistory.length,
    clipboard: clipboard.length - keptClipboard.length,
    importedHistory,
  };
}

export const BACKUP_SECTIONS = {
  settings: 'Настройки', dictations: 'История диктовок', dictionary: 'Словарь', snippets: 'Быстрые блоки',
  voiceHotkeys: 'Голосовые сочетания', presets: 'AI-инструкции', instructions: 'Свои инструкции',
  stats: 'Счётчики', profile: 'Профиль',
};

/** Выбранные разделы заменяются целиком, а не объединяются с текущими. */
export function selectBackupSections(payload, selected) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(selected) || !selected.length ||
      new Set(selected).size !== selected.length || selected.some((key) =>
        !Object.hasOwn(BACKUP_SECTIONS, key) || !Object.hasOwn(payload, key))) {
    throw new Error('Выберите хотя бы один доступный раздел копии.');
  }
  const subset = {};
  for (const key of ['app', 'format', 'exportedAt', ...selected]) {
    if (Object.hasOwn(payload, key)) subset[key] = payload[key];
  }
  return subset;
}

export function backupSectionSummary(key, prepared, current) {
  if (Array.isArray(prepared[key]) && Array.isArray(current[key])) {
    return `Сейчас: ${current[key].length} · в копии: ${prepared[key].length}${prepared[key].length === 0 ? ' · раздел будет очищен' : ''}`;
  }
  return 'Текущие данные будут заменены';
}

// Сопоставление только по уникальным ID, без чтения/вывода содержимого.
export function backupIdentitySummary(key, prepared, current) {
  const incoming = prepared[key], existing = current[key];
  if (!Array.isArray(incoming) || !Array.isArray(existing)) return '';
  const ids = (items) => {
    const set = new Set();
    for (const item of items) {
      if (typeof item?.id !== 'string' || !item.id || set.has(item.id)) return null;
      set.add(item.id);
    }
    return set;
  };
  const oldIds = ids(existing), newIds = ids(incoming);
  if (!oldIds || !newIds) return '';
  let common = 0;
  for (const id of oldIds) if (newIds.has(id)) common += 1;
  return `Общих ID: ${common} · прежних ID нет в копии: ${oldIds.size - common}`;
}
