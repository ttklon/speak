import { describe, it, expect, beforeEach } from 'vitest';
import { focusedEditable, insertIntoFocusedField } from './insertLocal.js';

function mount(html) {
  document.body.innerHTML = html;
  return document.body.firstElementChild;
}

describe('вставка в поле, где человек пишет', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('находит активное поле: textarea, input, contenteditable', () => {
    const area = mount('<textarea></textarea>');
    area.focus();
    expect(focusedEditable(document)).toBe(area);

    const input = mount('<input type="text" />');
    document.body.prepend(area);
    input.focus();
    expect(focusedEditable(document)).toBe(input);

    const editable = mount('<div contenteditable="true"></div>');
    document.body.prepend(input);
    document.body.appendChild(editable);
    editable.focus();
    expect(focusedEditable(document)).toBe(editable);
  });

  it('не считает полем кнопки, чекбоксы и read-only', () => {
    const box = mount('<input type="checkbox" />');
    box.focus();
    expect(focusedEditable(document)).toBeNull();

    document.body.innerHTML = '<textarea readonly></textarea>';
    const ro = document.body.firstElementChild;
    ro.focus();
    expect(focusedEditable(document)).toBeNull();
  });

  it('вставляет текст в textarea по каретке и сообщает через input', () => {
    const area = mount('<textarea></textarea>');
    area.value = 'привет ';
    area.focus();
    area.setSelectionRange(7, 7);
    let fired = 0;
    area.addEventListener('input', () => {
      fired += 1;
    });
    const res = insertIntoFocusedField('мир', { doc: document });
    expect(res.inserted).toBe(true);
    expect(area.value).toBe('привет мир');
    expect(fired).toBe(1);
    // каретка — после вставленного текста
    expect(area.selectionStart).toBe(10);
  });

  it('заменяет выделение, а не дописывает рядом', () => {
    const input = mount('<input type="text" value="скажи это" />');
    input.focus();
    input.setSelectionRange(6, 9); // «это»
    insertIntoFocusedField('то', { doc: document });
    expect(input.value).toBe('скажи то');
  });

  it('ставит пробел, если человек писал вплотную', () => {
    const input = mount('<input type="text" value="готово" />');
    input.focus();
    input.setSelectionRange(6, 6);
    insertIntoFocusedField('точка', { doc: document });
    expect(input.value).toBe('готово точка');
  });

  it('вставляет в contenteditable через выделение', () => {
    const div = mount('<div contenteditable="true">Текст: </div>');
    div.focus();
    const range = document.createRange();
    range.selectNodeContents(div);
    range.collapse(false);
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const res = insertIntoFocusedField('дописано', { doc: document });
    expect(res.inserted).toBe(true);
    expect(div.textContent).toContain('дописано');
  });

  it('без сфокусированного поля молчит, а не вставляет в body', () => {
    document.body.innerHTML = '<p>просто текст</p>';
    document.body.focus?.();
    expect(insertIntoFocusedField('текст', { doc: document }).inserted).toBe(false);
    expect(document.body.textContent).toBe('просто текст');
  });

  it('не вставляет в своё окно, если фокус ушёл в другое приложение', () => {
    const area = mount('<textarea>начало</textarea>');
    area.focus();
    const realHasFocus = document.hasFocus;
    document.hasFocus = () => false;
    try {
      const res = insertIntoFocusedField('чужой текст', { doc: document });
      expect(res.inserted).toBe(false);
      expect(area.value).toBe('начало');
    } finally {
      document.hasFocus = realHasFocus;
    }
  });

  it('пустой текст ничего не меняет', () => {
    const area = mount('<textarea>x</textarea>');
    area.focus();
    expect(insertIntoFocusedField('', { doc: document }).inserted).toBe(false);
    expect(area.value).toBe('x');
  });
});
