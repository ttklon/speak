import { describe, expect, it } from 'vitest';
import { isReplaceableClipboardDuplicate as replaceable } from './clipboardHistory.js';

describe('повторные записи буфера', () => {
  it('заменяет только незакреплённый повтор простого текста', () => {
    const text = { kind: 'text', text: 'пример' };
    expect(replaceable(text, { ...text })).toBe(true);
    expect(replaceable({ ...text, pinned: true }, { ...text })).toBe(false);
    expect(replaceable(text, { kind: 'text', text: 'другой' })).toBe(false);
    expect(replaceable(text, { kind: 'password', text: 'пример' })).toBe(false);
    expect(replaceable({ ...text, image: 'a' }, { ...text })).toBe(false);
    expect(replaceable(text, { ...text, image: 'b' })).toBe(false);
  });

  it('шифр сравнивается с шифром, а открытый текст с текстом', () => {
    const cipher = { kind: 'password', text: '', cipher: 'cipher-a' };
    expect(replaceable(cipher, { ...cipher })).toBe(true);
    expect(replaceable({ ...cipher, pinned: true }, { ...cipher })).toBe(false);
    expect(replaceable(cipher, { ...cipher, cipher: 'cipher-b' })).toBe(false);
    expect(replaceable(cipher, { kind: 'password', text: 'cipher-a' })).toBe(false);
    expect(replaceable({ kind: 'password', text: 'открытый' }, { kind: 'password', text: 'открытый' })).toBe(true);
  });

  it('одинаковая подпись не заменяет другие файлы, заметки, картинки или форматы', () => {
    for (const kind of ['file', 'note', 'image', 'format']) {
      expect(replaceable({ kind, text: 'одинаково', image: 'one' }, { kind, text: 'одинаково', image: 'two' })).toBe(false);
      expect(replaceable({ kind, text: 'одинаково' }, { kind, text: 'одинаково' })).toBe(false);
    }
  });

  it('пустые и некорректные значения не считаются совпадениями', () => {
    expect(replaceable(null, {})).toBe(false);
    expect(replaceable({ kind: 'text', text: '' }, { kind: 'text', text: '' })).toBe(false);
    expect(replaceable({ kind: 'text', text: 123 }, { kind: 'text', text: 123 })).toBe(false);
    expect(replaceable({ kind: 'password', cipher: '' }, { kind: 'password', cipher: '' })).toBe(false);
  });
});
