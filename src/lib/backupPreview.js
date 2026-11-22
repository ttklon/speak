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
