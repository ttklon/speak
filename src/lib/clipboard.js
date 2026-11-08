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

/** Записать текст (и/или картинку) в системный буфер. */
export async function writeClipboard(text, image) {
  const value = String(text ?? '');

  const bridge = native();
  if (bridge?.writeClipboard) {
    try {
      const ok = await bridge.writeClipboard({ text: value, image });
      if (ok) return 'native';
    } catch {
      /* падать не должны — идём дальше */
    }
  }

  // предзагруженный мост буфера (sendSync, доступен даже из file://)
  if (typeof window !== 'undefined' && window.zspeakly?.clipboard?.writeText) {
    try {
      window.zspeakly.clipboard.writeText(value);
      return 'bridge';
    } catch {
      /* идём дальше */
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
  try {
    const area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    if (ok) return 'execCommand';
  } catch {
    /* совсем не вышло */
  }

  throw new Error('clipboard-unavailable');
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
