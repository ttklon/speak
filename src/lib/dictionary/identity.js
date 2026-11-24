/** Идентичность записи словаря: ё и е различаются, канонические формы Unicode — нет. */
export function dictionaryWordKey(word) {
  return String(word ?? '').normalize('NFC').toLowerCase().replace(/\s+/gu, ' ').trim();
}
