/**
 * «Как распозналось» — сырой текст движка рядом с готовым.
 *
 * Зачем: приложение меняет текст после распознавания (словарь, голосовые
 * команды, чистка, оформление под окно). Пока правки были невидимы, человек не
 * мог отличить ошибку движка от правки приложения — и не мог вернуть то, что
 * сказал. Храним сырой вариант только когда он действительно отличается, и
 * только в разумных пределах: история и так живёт в бюджете профиля.
 */

/** Длиннее этого сырой текст не храним: это уже не «фраза», а расшифровка. */
export const RAW_TEXT_LIMIT = 2000;

/**
 * @param {string} raw что вернул движок
 * @param {string} final что в итоге попало в текст
 * @returns {string|undefined} сырой текст для истории или ничего
 */
export function rawTextFor(raw, final) {
  const engineText = String(raw ?? '').trim();
  const finalText = String(final ?? '').trim();
  if (!engineText || !finalText) return undefined;
  if (engineText === finalText) return undefined;
  if (engineText.length > RAW_TEXT_LIMIT) return undefined;
  return engineText;
}

/** Есть ли что показывать в истории: поле заполнено и отличается от текста. */
export function hasRawText(item) {
  const raw = typeof item?.rawText === 'string' ? item.rawText.trim() : '';
  const text = typeof item?.text === 'string' ? item.text.trim() : '';
  return Boolean(raw) && raw !== text;
}
