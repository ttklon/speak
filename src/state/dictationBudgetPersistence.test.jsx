import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

// Маленький бюджет позволяет проверить реальные пути React без многомегабайтных полей.
vi.mock('../lib/dictationBudget.js', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    DICTATION_MAX_BYTES: 500,
    DICTATION_MAX_ITEMS: 2,
    trimDictations: (items, limits = {}) => original.trimDictations(items, { maxBytes: 500, maxItems: 2, ...limits }),
  };
});

import { AppDataProvider, useAppData } from './AppDataProvider.jsx';
import { ToastProvider } from './ToastProvider.jsx';

const item = (id, length) => ({ id, text: 'x'.repeat(length), createdAt: Date.now() });

describe('бюджет истории при загрузке и правке', () => {
  let root, container, state;
  function Probe() { state = useAppData(); return null; }
  async function mount() {
    root = createRoot(container);
    await act(async () => root.render(createElement(StrictMode, null,
      createElement(ToastProvider, null, createElement(AppDataProvider, null, createElement(Probe))))));
  }
  async function remount() {
    await act(async () => root.unmount());
    root = null;
    await mount();
  }
  afterEach(async () => {
    if (root) await act(async () => root.unmount());
    root = null;
    container?.remove();
    localStorage.clear();
    vi.unstubAllGlobals();
  });
  function seed(items) {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    localStorage.setItem('zs:zs.dictations', JSON.stringify(items));
    container = document.createElement('div');
    document.body.appendChild(container);
  }

  it('отклоняет правку, которая превысит общий бюджет и при перезапуске выбросит старую запись', async () => {
    seed([item('new', 40), item('old', 40)]); // 240 + 240 = 480 байт
    await mount();
    let accepted;
    await act(async () => { accepted = state.updateDictation('new', { text: 'y'.repeat(70) }); });
    expect(accepted).toBe(false);
    expect(state.dictations.map((x) => x.text.length)).toEqual([40, 40]);
    await remount();
    expect(state.dictations.map((x) => x.id)).toEqual(['new', 'old']);
  });

  it('не удаляет уже существующую большую историю при загрузке или попытке добавить запись', async () => {
    seed([item('large', 180), item('old', 10)]); // первая запись тяжелее 500 байт
    await mount();
    expect(state.dictations.map((x) => x.id)).toEqual(['large', 'old']);
    let accepted;
    await act(async () => { accepted = state.addDictation(item('new', 2)); });
    expect(accepted).toBe(false);
    expect(state.dictations.map((x) => x.id)).toEqual(['large', 'old']);
    expect(container.querySelector('.toast__recover')?.value).toBe('xx');
    await remount();
    expect(state.dictations.map((x) => x.id)).toEqual(['large', 'old']);
    await act(async () => { accepted = state.updateDictation('large', { text: 'z'.repeat(100) }); });
    expect(accepted).toBe(true); // уменьшение, хотя история ещё выше лимита
    expect(state.dictations[0].text.length).toBe(100);
    await act(async () => {
      state.deleteDictation('old');
      state.updateDictation('large', { text: 'z'.repeat(70) });
      accepted = state.addDictation(item('new', 2));
    });
    expect(accepted).toBe(true); // удаление и добавление в одном batch
    await remount();
    expect(state.dictations.map((x) => x.id)).toEqual(['new', 'large']);
  });

  it('учитывает несколько изменений в одном React batch', async () => {
    seed([item('new', 40), item('old', 40)]);
    await mount();
    let first, second;
    await act(async () => {
      first = state.updateDictation('new', { text: 'a'.repeat(50) }); // 500 всего
      second = state.updateDictation('old', { text: 'b'.repeat(41) }); // 502 всего
    });
    expect([first, second]).toEqual([true, false]);
    expect(state.dictations.map((x) => x.text.length)).toEqual([50, 40]);
    await remount();
    expect(state.dictations.map((x) => x.text.length)).toEqual([50, 40]);
  });

  it('учитывает все записи с одинаковым ID и не применяет позднюю правку к изменённому тексту', async () => {
    seed([item('same', 40), item('same', 40)]);
    await mount();
    let accepted;
    await act(async () => { accepted = state.updateDictation('same', { text: 'y'.repeat(45) }); });
    expect(accepted).toBe(true); // 250 + 250 ровно 500
    await act(async () => { accepted = state.updateDictation('same', { text: 'z'.repeat(46) }); });
    expect(accepted).toBe(false);
    await act(async () => { accepted = state.updateDictation('same', { text: 'q'.repeat(100) }, { expectedText: 'устарело' }); });
    expect(accepted).toBe(true); // запрос принят, но совпадений нет
    expect(state.dictations.map((x) => x.text)).toEqual(['y'.repeat(45), 'y'.repeat(45)]);
    expect(state.getDictationSnapshot('same')).toBeNull(); // неоднозначный ID
  });

  it('не обрезает унаследованную историю, превышающую число записей', async () => {
    seed([item('a', 1), item('b', 1), item('c', 1)]); // 486 байт, но больше двух записей
    await mount();
    let accepted;
    await act(async () => { accepted = state.addDictation(item('new', 1)); });
    expect(accepted).toBe(false);
    await remount();
    expect(state.dictations.map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });


  it('снимок меняется при правке и при удалении с восстановлением, даже если текст прежний', async () => {
    seed([item('one', 10)]);
    await mount();
    const initial = state.getDictationSnapshot('one');
    await act(async () => state.updateDictation('one', { text: 'новый текст' }));
    expect(state.getDictationSnapshot('one')).not.toBe(initial);
    await act(async () => state.updateDictation('one', { text: initial.text }));
    const restoredText = state.getDictationSnapshot('one');
    expect(restoredText).not.toBe(initial);
    expect(restoredText.text).toBe(initial.text);
    await act(async () => {
      state.deleteDictation('one');
      expect(state.getDictationSnapshot('one')).toBeNull();
      state.addDictation(restoredText);
    });
    expect(state.getDictationSnapshot('one')).not.toBe(restoredText);
    expect(state.getDictationSnapshot('one').text).toBe(initial.text);
  });

  it('не применяет черновик к другой версии, даже если текст вернулся к прежнему', async () => {
    seed([item('one', 10)]); await mount();
    const snapshot = state.getDictationSnapshot('one');
    let result;
    await act(async () => {
      state.updateDictation('one', { text: 'изменено' });
      state.updateDictation('one', { text: snapshot.text });
      result = state.saveDictationEdit(snapshot, { text: 'черновик', words: 1 });
    });
    expect(result).toEqual({ ok: false, reason: 'changed' });
    await remount();
    expect(state.dictations[0].text).toBe(snapshot.text);
  });
  it('не правит удалённую или неоднозначную запись и отличает превышение бюджета', async () => {
    seed([item('one', 10)]); await mount();
    const snapshot = state.getDictationSnapshot('one');
    let tooBig, deleted;
    await act(async () => {
      tooBig = state.saveDictationEdit(snapshot, { text: 'z'.repeat(180) });
      state.deleteDictation('one');
      deleted = state.saveDictationEdit(snapshot, { text: 'текст' });
    });
    expect(tooBig).toEqual({ ok: false, reason: 'budget' });
    expect(deleted).toEqual({ ok: false, reason: 'changed' });
  });
  it('сохраняет текст и счётчик, когда версия не менялась', async () => {
    seed([item('one', 10)]); await mount();
    let result;
    await act(async () => { result = state.saveDictationEdit(state.getDictationSnapshot('one'), { text: '  два слова\n', words: 2 }); });
    expect(result).toEqual({ ok: true });
    await remount();
    expect(state.dictations[0]).toMatchObject({ text: '  два слова\n', words: 2 });
  });

  it('не изменяет записи с неоднозначным ID даже по одной из версий', async () => {
    seed([item('same', 10), item('same', 11)]); await mount();
    const first = state.dictations[0]; let result;
    await act(async () => { result = state.saveDictationEdit(first, { text: 'черновик' }); });
    expect(result).toEqual({ ok: false, reason: 'changed' });
    await remount(); expect(state.dictations.map((d) => d.text.length)).toEqual([10, 11]);
  });
  it('не заменяет удалённую и восстановленную запись', async () => {
    seed([item('one', 10)]); await mount();
    const snapshot = state.getDictationSnapshot('one'); let result;
    await act(async () => {
      state.deleteDictation('one'); state.addDictation(snapshot);
      result = state.saveDictationEdit(snapshot, { text: 'черновик' });
    });
    expect(result).toEqual({ ok: false, reason: 'changed' });
    await remount(); expect(state.dictations[0].text).toBe(snapshot.text);
  });

});
