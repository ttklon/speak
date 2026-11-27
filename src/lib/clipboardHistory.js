/** Можно заменить только незакреплённый повтор простой текстовой записи.
 * Подписи к разным изображениям и файлам могут совпадать, не делая их одной записью. */
export function isReplaceableClipboardDuplicate(previous, incoming) {
  if (!previous || !incoming || previous.pinned || previous.kind !== incoming.kind) return false;
  if (previous.kind !== 'text' && previous.kind !== 'password') return false;
  if (previous.image || incoming.image) return false;

  const oldCipher = typeof previous.cipher === 'string' ? previous.cipher : '';
  const newCipher = typeof incoming.cipher === 'string' ? incoming.cipher : '';
  if (oldCipher || newCipher) return Boolean(oldCipher && newCipher && oldCipher === newCipher);
  const oldText = typeof previous.text === 'string' ? previous.text : '';
  const newText = typeof incoming.text === 'string' ? incoming.text : '';
  return Boolean(oldText && oldText === newText);
}
