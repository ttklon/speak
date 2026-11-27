/**
 * Выделенный текст в чужом окне: прочитать и заменить.
 *
 * Вынесено из `useTextAction`, потому что теперь это нужно двум вещам:
 * инструкциям по сочетанию клавиш и командному режиму («сократи это» голосом).
 * Один способ читать выделение — один способ и писать обратно.
 */

function nativeBridge() {
  return typeof window !== 'undefined' ? window.zspeakly?.native : null;
}

/**
 * Забрать выделенный текст: нативное копирование, а в браузере — буфер.
 * Возвращает строку; при неподтверждённом выделении бросает ошибку,
 * чтобы старый буфер не отправлялся как контекст.
 */
export async function readSelectionText() {
  const bridge = nativeBridge();
  if (bridge?.readSelection) {
    const selected = await bridge.readSelection();
    if (selected?.reason === 'busy') {
      const error = new Error('Другая операция с текстом ещё выполняется. Выделение не читалось; попробуйте позже.');
      error.code = 'selection-busy';
      throw error;
    }
    if (selected?.reason === 'unverified') {
      const error = new Error('Не удалось подтвердить выделение. Если оно совпадает с буфером, скопируйте другой безопасный текст, затем снова выделите нужное.');
      error.code = 'selection-unverified';
      throw error;
    }
    // мост отдаёт строку; объект {text} тоже примем — иначе выделение молча
    // превращалось в «[object Object]» и инструкция «ничего не меняла».
    // Пустая строка — это ответ «выделения нет», а не повод лезть в буфер:
    // иначе командой «сократи» правился бы случайный текст из буфера обмена.
    if (typeof selected === 'string') return selected;
    if (selected && typeof selected.text === 'string') return selected.text;
    return '';
  }
  try {
    // Только ленивая загрузка: в браузере чтение идёт через navigator.clipboard,
    // и без этого импорта модуль тянул бы пол-приложения в тестах.
    const { readClipboard } = await import('../clipboard.js');
    return await readClipboard();
  } catch {
    return '';
  }
}

/**
 * Вернуть текст на место выделения.
 * 'inserted' — вставили в чужое окно, 'copied' — только в буфер (браузер),
 * 'failed' — известный отказ, 'busy' — операция не начиналась,
 * 'uncertain' — результат вставки неизвестен; clipboard-changed и
 * clipboard-changed-uncertain — конфликт до или во время Ctrl+V.
 */
export async function writeSelectionText(text) {
  const bridge = nativeBridge();
  if (bridge?.replaceSelection) {
    try {
      const outcome = await bridge.replaceSelection(text);
      if (outcome === true) return 'inserted';
      if (outcome === false) return 'failed';
      if (outcome?.busy === true) return 'busy';
      if (outcome?.clipboardChanged === true) return outcome.uncertain === true ? 'clipboard-changed-uncertain' : 'clipboard-changed';
      return 'uncertain';
    } catch {
      // Ответ IPC может потеряться уже после отправки клавиш.
      return 'uncertain';
    }
  }
  try {
    const { writeClipboard } = await import('../clipboard.js');
    await writeClipboard(text);
    return 'copied';
  } catch {
    return 'failed';
  }
}

export default { readSelectionText, writeSelectionText };
