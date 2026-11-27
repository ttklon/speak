import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

vi.mock('../lib/dictationBudget.js', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original, DICTATION_MAX_BYTES: 500, DICTATION_MAX_ITEMS: 2,
    trimDictations: (items, limits = {}) => original.trimDictations(items, { maxBytes: 500, maxItems: 2, ...limits }),
  };
});
import { AppDataProvider, useAppData } from './AppDataProvider.jsx';
import { ToastProvider } from './ToastProvider.jsx';

const item = (id, text, extra = {}) => ({ id, text, rawText: 'распознанный текст', createdAt: Date.now(), source: 'file', fileName: 'test.wav', ...extra });

describe('безопасное удаление и возврат диктовки', () => {
  let state, root, container;
  function Probe() { state = useAppData(); return null; }
  async function mount(items) {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    localStorage.setItem('zs:zs.dictations', JSON.stringify(items));
    container = document.createElement('div'); document.body.appendChild(container);
    await remount();
  }
  async function remount() {
    if (root) await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(createElement(StrictMode, null, createElement(ToastProvider, null, createElement(AppDataProvider, null, createElement(Probe))))));
  }
  afterEach(async () => {
    if (root) await act(async () => root.unmount());
    root = null; container?.remove(); localStorage.clear(); vi.unstubAllGlobals();
  });

  it('не удаляет запись, изменённую после открытия окна', async () => {
    await mount([item('one', 'старый текст')]);
    const snapshot = state.dictations[0]; let removed;
    await act(async () => {
      state.updateDictation('one', { text: 'новый текст' });
      removed = state.deleteDictation(snapshot);
    });
    expect(removed).toBe(false);
    await remount(); expect(state.dictations[0].text).toBe('новый текст');
  });

  it('наследованные записи с одинаковым ID получают разные ID и удаляются по одной', async () => {
    await mount([item('same', 'первая'), item('same', 'вторая')]);
    expect(new Set(state.dictations.map((d) => d.id)).size).toBe(2);
    let removed;
    await act(async () => { removed = state.deleteDictation(state.dictations[0]); });
    expect(removed).toBe(true);
    await remount(); expect(state.dictations.map((d) => d.text)).toEqual(['вторая']);
  });

  it('возврат не вытесняет новую или старую запись при заполненном лимите', async () => {
    await mount([item('old', 'первая'), item('keep', 'вторая')]);
    const snapshot = state.dictations[0]; let restored;
    await act(async () => {
      state.deleteDictation(snapshot);
      state.addDictation(item('new', 'третья'));
      restored = state.restoreDictation(snapshot);
    });
    expect(restored).toBe(false);
    expect(JSON.parse(container.querySelector('.toast__recover').value)).toMatchObject({ id: 'old', text: 'первая', rawText: 'распознанный текст', fileName: 'test.wav' });
    await remount(); expect(state.dictations.map((d) => d.id)).toEqual(['new', 'keep']);
  });

  it('возврат не создаёт дубли ID и предлагает полные данные для ручного восстановления', async () => {
    await mount([item('one', 'старый текст')]);
    const snapshot = state.dictations[0]; let restored;
    await act(async () => {
      state.deleteDictation(snapshot);
      state.addDictation(item('one', 'новый текст'));
      restored = state.restoreDictation(snapshot);
    });
    expect(restored).toBe(false);
    expect(JSON.parse(container.querySelector('.toast__recover').value)).toMatchObject({ id: 'one', text: 'старый текст', fileName: 'test.wav' });
    await remount(); expect(state.dictations.map((d) => d.text)).toEqual(['новый текст']);
  });

  it('возвращает полный объект как новую версию без потери других записей', async () => {
    await mount([item('one', 'первый', { extra: 'дополнительные данные' }), item('two', 'второй')]);
    const snapshot = state.dictations[0]; let restored;
    await act(async () => { state.deleteDictation(snapshot); restored = state.restoreDictation(snapshot); });
    expect(restored).toBe(true); expect(state.dictations[0]).not.toBe(snapshot);
    await remount(); expect(state.dictations.map((d) => d.id)).toEqual(['one', 'two']);
    expect(state.dictations[0]).toMatchObject({ text: 'первый', rawText: 'распознанный текст', fileName: 'test.wav', extra: 'дополнительные данные' });
  });

  it('не добавляет новую диктовку поверх существующего ID', async () => {
    await mount([item('one', 'старый текст')]); let accepted;
    await act(async () => { accepted = state.addDictation(item('one', 'новый текст')); });
    expect(accepted).toBe(false);
    expect(container.querySelector('.toast__recover')?.value).toBe('новый текст');
    await remount(); expect(state.dictations.map((d) => d.text)).toEqual(['старый текст']);
  });
  it('не вытесняет запись при нехватке байтов даже без превышения числа записей', async () => {
    await mount([item('old', 'a'.repeat(60))]);
    const snapshot = state.dictations[0]; let restored;
    await act(async () => {
      state.deleteDictation(snapshot);
      state.addDictation(item('new', 'b'.repeat(100)));
      restored = state.restoreDictation(snapshot);
    });
    expect(restored).toBe(false);
    expect(JSON.parse(container.querySelector('.toast__recover').value).text).toBe(snapshot.text);
    await remount(); expect(state.dictations.map((d) => d.id)).toEqual(['new']);
  });

  it('не удаляет восстановленную запись по старому снимку даже с прежним текстом', async () => {
    await mount([item('one', 'старый текст')]);
    const snapshot = state.dictations[0]; let again;
    await act(async () => {
      expect(state.deleteDictation(snapshot)).toBe(true);
      expect(state.restoreDictation(snapshot)).toBe(true);
      again = state.deleteDictation(snapshot);
    });
    expect(again).toBe(false);
    await remount(); expect(state.dictations.map((d) => d.text)).toEqual(['старый текст']);
  });

  it('после освобождения места позволяет повторить возврат из уведомления', async () => {
    await mount([item('old', 'первая'), item('keep', 'вторая')]);
    const snapshot = state.dictations[0];
    await act(async () => {
      state.deleteDictation(snapshot);
      state.addDictation(item('new', 'третья'));
      expect(state.restoreDictation(snapshot)).toBe(false);
    });
    await act(async () => state.deleteDictation(state.getDictationSnapshot('new')));
    const retry = container.querySelector('.toast__action');
    expect(retry?.textContent).toMatch(/Повторить/);
    await act(async () => retry.click());
    await remount(); expect(state.dictations.map((d) => d.id)).toEqual(['old', 'keep']);
  });

});
