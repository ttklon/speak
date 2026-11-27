import { afterEach, describe, expect, it } from 'vitest';
import { readSelectionText, writeSelectionText } from './hotkeys/selection.js';

afterEach(() => { delete window.zspeakly; });
describe('результат замены выделения', () => {
  it('отличает занятое действие от неизвестной вставки', async () => {
    window.zspeakly = { native: { replaceSelection: async () => ({ busy: true }) } };
    expect(await writeSelectionText('тест')).toBe('busy');
  });

  it('не сообщает об успехе, если ответ о вставке неизвестен или потерян', async () => {
    window.zspeakly = { native: { replaceSelection: async () => ({ uncertain: true }) } };
    expect(await writeSelectionText('тест')).toBe('uncertain');
    window.zspeakly.native.replaceSelection = async () => { throw new Error('IPC потерян'); };
    expect(await writeSelectionText('тест')).toBe('uncertain');
    window.zspeakly.native.replaceSelection = async () => undefined;
    expect(await writeSelectionText('тест')).toBe('uncertain');
  });
  it('различает изменение буфера до и во время замены', async () => {
    window.zspeakly = { native: { replaceSelection: async () => ({ clipboardChanged: true }) } };
    expect(await writeSelectionText('тест')).toBe('clipboard-changed');
    window.zspeakly.native.replaceSelection = async () => ({ clipboardChanged: true, uncertain: true });
    expect(await writeSelectionText('тест')).toBe('clipboard-changed-uncertain');
  });
  it('сохраняет известные результаты старого моста', async () => {
    window.zspeakly = { native: { replaceSelection: async () => true } };
    expect(await writeSelectionText('тест')).toBe('inserted');
    window.zspeakly.native.replaceSelection = async () => false;
    expect(await writeSelectionText('тест')).toBe('failed');
  });
});


describe('чтение выделения', () => {
  it('сообщает, что выделение не читалось, если другая операция занята', async () => {
    window.zspeakly = { native: { readSelection: async () => ({ text: '', reason: 'busy' }) } };
    await expect(readSelectionText()).rejects.toMatchObject({ code: 'selection-busy' });
  });

  it('не передаёт неподтверждённый буфер в команду', async () => {
    window.zspeakly = { native: { readSelection: async () => ({ text: 'старый секрет', reason: 'unverified' }) } };
    await expect(readSelectionText()).rejects.toMatchObject({ code: 'selection-unverified' });
  });
  it('принимает строку, пустое значение и прежний объект с текстом', async () => {
    window.zspeakly = { native: { readSelection: async () => 'выделение' } };
    expect(await readSelectionText()).toBe('выделение');
    window.zspeakly.native.readSelection = async () => '';
    expect(await readSelectionText()).toBe('');
    window.zspeakly.native.readSelection = async () => ({ text: 'другой мост' });
    expect(await readSelectionText()).toBe('другой мост');
  });
});
