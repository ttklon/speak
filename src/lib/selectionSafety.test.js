import { afterEach, describe, expect, it } from 'vitest';
import { writeSelectionText } from './hotkeys/selection.js';

afterEach(() => { delete window.zspeakly; });
describe('результат замены выделения', () => {
  it('не сообщает об успехе, если ответ о вставке неизвестен или потерян', async () => {
    window.zspeakly = { native: { replaceSelection: async () => ({ uncertain: true }) } };
    expect(await writeSelectionText('тест')).toBe('uncertain');
    window.zspeakly.native.replaceSelection = async () => { throw new Error('IPC потерян'); };
    expect(await writeSelectionText('тест')).toBe('uncertain');
    window.zspeakly.native.replaceSelection = async () => undefined;
    expect(await writeSelectionText('тест')).toBe('uncertain');
  });
  it('сохраняет известные результаты старого моста', async () => {
    window.zspeakly = { native: { replaceSelection: async () => true } };
    expect(await writeSelectionText('тест')).toBe('inserted');
    window.zspeakly.native.replaceSelection = async () => false;
    expect(await writeSelectionText('тест')).toBe('failed');
  });
});
