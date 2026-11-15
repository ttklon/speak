/**
 * Очистка сохранённых данных перед показом.
 *
 * Профиль может испортиться: аварийное выключение, правка JSON руками, старая
 * версия приложения. Раньше «не массив» или `null` внутри массива доезжали до
 * рендера, и приложение открывалось белым экраном — без единого сообщения.
 * Здесь мусор отбрасывается, а нормальные записи остаются.
 */

let counter = 0;

/** Идентификатор для записей, у которых его не оказалось. */
function fallbackId(prefix = 'fix') {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

/**
 * Привести сохранённый список к безопасному виду: только массив, только
 * элементы, которые принял нормализатор. Одна битая запись не стоит всего списка.
 */
export function asList(stored, normalize, fallback = []) {
  if (!Array.isArray(stored)) return fallback;
  const out = [];
  for (const item of stored) {
    try {
      const clean = normalize(item);
      if (clean) out.push(clean);
    } catch {
      /* пропускаем битый элемент */
    }
  }
  return out;
}

export function sanitizeDictations(stored, fallback = []) {
  return asList(
    stored,
    (item) => {
      if (!item || typeof item !== 'object') return null;
      const text = typeof item.text === 'string' ? item.text : '';
      if (!text.trim()) return null;
      return {
        ...item,
        id: item.id || fallbackId('d'),
        text,
        createdAt: Number(item.createdAt) || Date.now(),
        durationMs: Number(item.durationMs) || 0,
        words: Number(item.words) || 0,
      };
    },
    fallback,
  );
}

export function sanitizeDictionary(stored, fallback = []) {
  return asList(
    stored,
    (item) => {
      if (!item || typeof item !== 'object') return null;
      const word = typeof item.word === 'string' ? item.word.trim() : '';
      if (!word) return null;
      return { ...item, id: item.id || fallbackId('w'), word };
    },
    fallback,
  );
}

export function sanitizeClipboard(stored, fallback = []) {
  return asList(
    stored,
    (item) => {
      if (!item || typeof item !== 'object') return null;
      const text = typeof item.text === 'string' ? item.text : '';
      const hasImage = typeof item.image === 'string' && item.image.startsWith('data:image/');
      // Пароль из системного хранилища — это шифр, а не текст: `text` у него
      // пустой по замыслу. Раньше такие записи отбрасывались при загрузке, и
      // хранилище паролей выглядело пустым после перезапуска.
      const hasCipher = typeof item.cipher === 'string' && item.cipher.length > 0;
      if (!text && !hasImage && !hasCipher) return null;
      return {
        ...item,
        id: item.id || fallbackId('c'),
        text,
        createdAt: Number(item.createdAt) || Date.now(),
      };
    },
    fallback,
  );
}

export function sanitizeHotkeys(stored, fallback = []) {
  return asList(
    stored,
    (item) => {
      if (!item || typeof item !== 'object') return null;
      const keys = Array.isArray(item.keys) ? item.keys.filter((k) => typeof k === 'string') : [];
      if (!item.id || !keys.length) return null;
      return { ...item, keys, enabled: item.enabled !== false };
    },
    fallback,
  );
}

export function sanitizePresets(stored, fallback = []) {
  return asList(
    stored,
    (item) => {
      if (!item || typeof item !== 'object') return null;
      const name = typeof item.name === 'string' ? item.name.trim() : '';
      if (!name) return null;
      return { ...item, id: item.id || fallbackId('p'), name };
    },
    fallback,
  );
}

export function sanitizeInstructions(stored, fallback = []) {
  return asList(
    stored,
    (item) => {
      if (!item || typeof item !== 'object') return null;
      const title = typeof item.title === 'string' ? item.title.trim() : '';
      if (!title) return null;
      return { ...item, id: item.id || fallbackId('i'), title, text: typeof item.text === 'string' ? item.text : '' };
    },
    fallback,
  );
}

export function sanitizeStats(stored, fallback) {
  const base = fallback || { wordsTotal: 0, secondsTotal: 0, sessions: 0 };
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return base;
  return {
    ...base,
    wordsTotal: Number(stored.wordsTotal) || 0,
    secondsTotal: Number(stored.secondsTotal) || 0,
    sessions: Number(stored.sessions) || 0,
  };
}
