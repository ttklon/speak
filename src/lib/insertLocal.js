/**
 * Вставка диктовки в поле, где человек действительно пишет.
 *
 * Раньше был один путь: спрятать окно ZSpeakly и послать Ctrl+V в чужое окно.
 * Если человек диктовал, стоя курсором в поле самого приложения (поиск, заметки,
 * инструкция, правка расшифровки), текст уходил в *предыдущее* окно — то есть
 * не туда, где человек писал. Теперь сначала пробуем вставить прямо в
 * сфокусированное поле приложения, и только если его нет — идём системным путём.
 */

/** Активное поле ввода: input/textarea или contenteditable. */
export function focusedEditable(doc = typeof document === 'undefined' ? null : document) {
  if (!doc) return null;
  const el = doc.activeElement;
  if (!el || el === doc.body) return null;
  const tag = String(el.tagName || '').toLowerCase();
  if (tag === 'textarea') return el.readOnly || el.disabled ? null : el;
  if (tag === 'input') {
    const type = String(el.type || 'text').toLowerCase();
    // кнопки, чекбоксы, файлы — не поля для текста
    const textish = ['text', 'search', 'url', 'tel', 'email', 'password', 'number', ''];
    if (!textish.includes(type)) return null;
    return el.readOnly || el.disabled ? null : el;
  }
  // isContentEditable есть не везде (jsdom, часть webview) — смотрим и атрибут
  if (el.isContentEditable || String(el.getAttribute?.('contenteditable') || '') === 'true') return el;
  return null;
}

/** Поле редактируемое по содержимому? (одинаково в Chromium и в тестах) */
function isEditableRoot(el) {
  return Boolean(el?.isContentEditable) || String(el?.getAttribute?.('contenteditable') || '') === 'true';
}

/**
 * Записать значение так, чтобы это увидел React: напрямую `el.value = …`
 * контролируемое поле не обновляет (React помнит своё значение), поэтому
 * используем нативный сеттер прототипа и событие `input`.
 */
function setNativeValue(el, value) {
  const proto =
    el instanceof el.ownerDocument.defaultView.HTMLTextAreaElement
      ? el.ownerDocument.defaultView.HTMLTextAreaElement.prototype
      : el.ownerDocument.defaultView.HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
  if (descriptor && descriptor.set) descriptor.set.call(el, value);
  else el.value = value;
}

/**
 * Вставить текст в сфокусированное поле.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {Document} [opts.doc]
 * @param {HTMLElement} [opts.el] — конкретное поле (для тестов)
 * @returns {{inserted: boolean, field?: string}}
 */
export function insertIntoFocusedField(text, { doc, el } = {}) {
  const value = String(text || '');
  const document_ = doc || (typeof document === 'undefined' ? null : document);
  if (!value || !document_) return { inserted: false };
  // Окно приложения могло потерять фокус, пока шло распознавание: тогда
  // activeElement всё ещё «наше» поле, но человек уже печатает в другом
  // приложении — вставлять в наше окно нельзя, иначе текст пропадёт не туда.
  if (!el && document_.hasFocus?.() === false) return { inserted: false };
  const field = el || focusedEditable(document_);
  if (!field) return { inserted: false };

  // contenteditable: execCommand умеет и каретку, и отмену, и события input
  if (isEditableRoot(field)) {
    try {
      field.focus();
      const ok = document_.execCommand('insertText', false, value);
      if (ok) return { inserted: true, field: 'contenteditable' };
    } catch {
      /* падаем в запасной путь ниже */
    }
    try {
      const selection = document_.getSelection();
      const range = selection && selection.rangeCount ? selection.getRangeAt(0) : null;
      if (range) {
        range.deleteContents();
        range.insertNode(document_.createTextNode(value));
        range.collapse(false);
        return { inserted: true, field: 'contenteditable' };
      }
    } catch {
      /* не смогли — честно скажем «не вставили» */
    }
    return { inserted: false };
  }

  const start = Number.isFinite(field.selectionStart) ? field.selectionStart : field.value.length;
  const end = Number.isFinite(field.selectionEnd) ? field.selectionEnd : field.value.length;
  const before = field.value.slice(0, start);
  const after = field.value.slice(end);
  // Пробел перед текстом, если человек писал вплотную: иначе слова слипнутся.
  const glue = before && !/\s$/.test(before) ? ' ' : '';
  const next = `${before}${glue}${value}${after}`;
  setNativeValue(field, next);
  const caret = before.length + glue.length + value.length;
  try {
    field.setSelectionRange(caret, caret);
  } catch {
    /* поле без выделения (например, type=number) — не критично */
  }
  field.dispatchEvent(new field.ownerDocument.defaultView.Event('input', { bubbles: true }));
  return { inserted: true, field: 'value' };
}
