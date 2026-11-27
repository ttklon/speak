/**
 * Буфер обмена с честным фолбэком.
 *
 * Порядок важен: в установленном Electron окно грузится через file://, где
 * navigator.clipboard может быть запрещён. Раньше код сначала пробовал его,
 * получал отказ и показывал «Буфер обмена недоступен» — хотя нативный мост
 * рядом и работает. Теперь сначала мост, потом браузерное API.
 */

function native() {
  return typeof window !== 'undefined' ? window.zspeakly?.native : null;
}

function copyError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

/** Тексты отказов без содержимого буфера или скопированных секретов. */
export function clipboardCopyError(err, fallbackDescription = '') {
  if (err?.code === 'clipboard-busy') return {
    title: 'Буфер занят',
    description: 'Другая операция с текстом ещё выполняется. Копирование не запускалось; повторите позже.',
    tone: 'warn',
  };
  if (err?.code === 'clipboard-uncertain') return {
    title: 'Не удалось подтвердить копирование',
    description: 'Буфер мог измениться. Проверьте его перед повтором.',
    tone: 'warn',
  };
  return { title: 'Не удалось скопировать', description: fallbackDescription, tone: 'warn' };
}

/** Записать текст (и/или картинку) в системный буфер. */
export async function writeClipboard(text, image) {
  const value = String(text ?? '');
  const electron = typeof window !== 'undefined' && window.zspeakly?.isElectron === true;
  const bridge = native();
  if (bridge?.writeClipboard) {
    let result;
    try { result = await bridge.writeClipboard({ text: value, image }); }
    catch {
      // IPC мог оборваться после записи: не обходить main другим способом.
      if (electron) throw copyError('clipboard-uncertain');
    }
    if (result === true) return 'native';
    if (result?.busy === true) throw copyError('clipboard-busy');
    if (electron) {
      if (result !== false) throw copyError('clipboard-uncertain');
      throw copyError(image != null && image !== '' ? 'clipboard-image-unavailable' : 'clipboard-unavailable');
    }
  } else if (electron) {
    // Прямой preload/браузерный путь обошёл бы блокировку main-процесса.
    throw copyError('clipboard-unavailable');
  }

  // Текстовый fallback не может заменить изображение.
  if (image != null && image !== '') throw copyError('clipboard-image-unavailable');

  if (typeof window !== 'undefined' && window.zspeakly?.clipboard?.writeText) {
    try {
      const result = await window.zspeakly.clipboard.writeText(value);
      if (result?.busy === true) throw copyError('clipboard-busy');
      if (result !== false) return 'bridge';
    } catch (err) {
      if (err?.code === 'clipboard-busy') throw err;
    }
  }

  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return 'browser';
    } catch {
      /* остался последний вариант */
    }
  }

  // document.execCommand('copy') — старый, но работает без разрешений
  let area;
  try {
    area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    if (document.execCommand('copy')) return 'execCommand';
  } catch {
    /* совсем не вышло */
  } finally {
    try { if (area) area.value = ''; } catch { /* окно уже закрывается */ }
    try { if (area?.parentNode) area.parentNode.removeChild(area); } catch { /* окно уже закрывается */ }
  }

  throw copyError('clipboard-unavailable');
}

/** Прочитать текст из буфера. */
export async function readClipboard() {
  const bridge = native();
  if (bridge?.readClipboard) {
    try {
      const text = await bridge.readClipboard();
      if (typeof text === 'string') return text;
    } catch {
      /* идём дальше */
    }
  }

  if (typeof window !== 'undefined' && window.zspeakly?.clipboard?.readText) {
    try {
      return window.zspeakly.clipboard.readText() || '';
    } catch {
      /* идём дальше */
    }
  }

  if (typeof navigator !== 'undefined' && navigator.clipboard?.readText) {
    return await navigator.clipboard.readText();
  }

  return '';
}

export default { writeClipboard, readClipboard };
