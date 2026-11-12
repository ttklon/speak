/** Хелперы: форматирование, склонения, работа с клавишами и текстом. */

export function plural(n, one, few, many) {
  const abs = Math.abs(n) % 100;
  const n1 = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (n1 > 1 && n1 < 5) return few;
  if (n1 === 1) return one;
  return many;
}

export function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 18:14 — как в списке «Недавние» */
export function timeHM(value) {
  const d = value instanceof Date ? value : new Date(value);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** «Сегодня, 14:02» — как в буфере обмена */
export function dayLabel(value, now = new Date()) {
  const d = value instanceof Date ? value : new Date(value);
  const a = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.round((b - a) / 86400000);
  if (diff === 0) return 'Сегодня';
  if (diff === 1) return 'Вчера';
  if (diff < 7) return `${diff} ${plural(diff, 'день', 'дня', 'дней')} назад`;
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: 'short' });
}

export function relativeTime(value, now = new Date()) {
  const d = value instanceof Date ? value : new Date(value);
  const mins = Math.max(0, Math.round((now - d) / 60000));
  if (mins < 1) return 'только что';
  if (mins < 60) return `${mins} ${plural(mins, 'минуту', 'минуты', 'минут')} назад`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} ${plural(hours, 'час', 'часа', 'часов')} назад`;
  const days = Math.round(hours / 24);
  return `${days} ${plural(days, 'день', 'дня', 'дней')} назад`;
}

export function words(text = '') {
  const matches = String(text).match(/[\p{L}\p{N}’'-]+/gu);
  return matches ? matches.length : 0;
}

export function formatMinutes(totalMinutes) {
  const m = Math.max(0, Math.round(totalMinutes));
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} ч ${rest} мин` : `${h} ч`;
}

export function formatK(n) {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return `${k >= 10 ? Math.round(k) : k.toFixed(1).replace('.0', '')} к`;
}

export function formatSeconds(ms) {
  const s = Math.max(0, ms) / 1000;
  return `${s.toFixed(1)} с`;
}

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

export function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function truncate(text = '', max = 120) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trimEnd()}…`;
}

/** Подсветка найденных фрагментов: "Привет, как дела?" → результаты по слову. */
export function normalizeQuery(q = '') {
  return q
    .toLowerCase()
    .replace(/[«»"'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function searchScore(text = '', query = '') {
  const q = normalizeQuery(query);
  if (!q) return 0;
  const t = normalizeQuery(text);
  if (!t) return 0;
  if (t.includes(q)) return 100 - Math.min(50, t.indexOf(q) / 20);
  const tokens = q.split(' ').filter((w) => w.length > 2);
  if (!tokens.length) return 0;
  const hit = tokens.filter((w) => t.includes(w)).length;
  return (hit / tokens.length) * 60;
}

/** Keys: ['Ctrl','Alt','Space'] → «Ctrl + Alt + Space» */
export function keysLabel(keys = []) {
  return keys.join(' + ');
}

/** Хоткей в формате Electron accelerator: «Ctrl+Alt+Space» */
export function toAccelerator(keys = []) {
  const map = {
    ctrl: 'Control',
    control: 'Control',
    alt: 'Alt',
    shift: 'Shift',
    cmd: 'Command',
    meta: 'Super',
    win: 'Super',
    space: 'Space',
    esc: 'Escape',
    escape: 'Escape',
    enter: 'Return',
    return: 'Return',
    tab: 'Tab',
    backspace: 'Backspace',
    delete: 'Delete',
    up: 'Up',
    down: 'Down',
    left: 'Left',
    right: 'Right',
    '↑': 'Up',
    '↓': 'Down',
    '←': 'Left',
    '→': 'Right',
  };
  return keys
    .map((k) => {
      const lower = String(k).toLowerCase();
      if (map[lower]) return map[lower];
      if (lower.length === 1) return lower.toUpperCase();
      return k;
    })
    .join('+');
}

const MODIFIER_CODES = new Set([
  'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight',
  'MetaLeft', 'MetaRight', 'CapsLock', 'Fn',
]);

export function keyNameFromEvent(e) {
  if (MODIFIER_CODES.has(e.code)) {
    if (e.code.startsWith('Control')) return 'Ctrl';
    if (e.code.startsWith('Alt')) return 'Alt';
    if (e.code.startsWith('Shift')) return 'Shift';
    if (e.code.startsWith('Meta')) return 'Win';
    if (e.code === 'CapsLock') return 'Caps Lock';
    return null;
  }
  if (e.code === 'Space') return 'Space';
  if (e.code === 'Escape') return 'Esc';
  if (e.code === 'Enter') return 'Enter';
  if (e.code === 'Tab') return 'Tab';
  if (e.code === 'Backspace') return 'Backspace';
  if (/^F\d{1,2}$/.test(e.key)) return e.key;
  if (e.key.length === 1) return e.key.toUpperCase();
  if (e.key === 'ArrowUp') return '↑';
  if (e.key === 'ArrowDown') return '↓';
  if (e.key === 'ArrowLeft') return '←';
  if (e.key === 'ArrowRight') return '→';
  return e.key;
}

/** «Ctrl + Alt + Space» из нажатия (для записи сочетания в UI) */
export function captureCombo(e) {
  const parts = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Win');
  const key = keyNameFromEvent(e);
  if (key && !['Ctrl', 'Alt', 'Shift', 'Win'].includes(key)) parts.push(key);
  return parts;
}

export function isComboComplete(combo) {
  if (!combo || !combo.length) return false;
  const mods = new Set(['Ctrl', 'Alt', 'Shift', 'Win']);
  return combo.some((k) => !mods.has(k)) || combo.filter((k) => mods.has(k)).length >= 2;
}

/** Применяет словарь к распознанному тексту (регистронезависимо по границам слов). */
export function applyDictionary(text, entries = []) {
  if (!text) return text;
  let out = text;
  for (const entry of entries) {
    if (!entry || !entry.word) continue;
    const word = entry.word.trim();
    if (!word) continue;
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const variants = [escaped];
    if (entry.pronunciation) {
      variants.push(entry.pronunciation.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    }
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${variants.join('|')})(?=$|[^\\p{L}\\p{N}])`, 'giu');
    out = out.replace(re, (m, pre, _hit, offset) => {
      // сохраняем заглавную букву в начале предложения
      const startsUpper = /[A-ZА-ЯЁ]/.test(_hit[0]);
      const replacement = startsUpper ? word[0].toUpperCase() + word.slice(1) : word;
      return `${pre}${replacement}`;
    });
  }
  return out;
}

/** Простая пост-обработка: капитализация, лишние пробелы, пробел перед знаком. */
export function postProcess(text = '', { capitalize = true } = {}) {
  let out = String(text).replace(/\s+/g, ' ').trim();
  if (!out) return '';
  out = out.replace(/\s+([,.;:!?])/g, '$1');
  out = out.replace(/([,.;:!?])(?=[^\s\d])/g, '$1 ');
  out = out.replace(/\s{2,}/g, ' ').trim();
  out = out.replace(/(^|[.!?]\s+)([а-яёa-z])/gu, (m, pre, ch) => `${pre}${ch.toUpperCase()}`);
  if (!capitalize) return out;
  return out;
}

export function escapeRegExp(s = '') {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Цвет по типу буфера/элемента */
export function kindLabel(kind) {
  return (
    {
      text: 'ТЕКСТ',
      format: 'ФОРМАТ',
      image: 'ИЗОБРАЖЕНИЕ',
      file: 'ФАЙЛ',
      password: 'ЗАШИФРОВАНО',
      note: 'ЗАМЕТКА',
      link: 'ССЫЛКА',
    }[kind] || 'ТЕКСТ'
  );
}
