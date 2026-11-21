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
 * Возвращает строку; пустая строка означает «выделения нет».
 */
export async function readSelectionText() {
  const bridge = nativeBridge();
  if (bridge?.readSelection) {
    const selected = await bridge.readSelection();
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
 * 'failed' — не получилось ни то, ни другое.
 */
export async function writeSelectionText(text) {
  const bridge = nativeBridge();
  if (bridge?.replaceSelection) {
    const ok = await bridge.replaceSelection(text);
    return ok ? 'inserted' : 'failed';
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
