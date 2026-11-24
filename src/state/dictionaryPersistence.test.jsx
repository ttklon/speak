import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppDataProvider, useAppData } from './AppDataProvider.jsx';
import { ToastProvider } from './ToastProvider.jsx';

const old = { id: 'w1', word: 'Термин', pronunciation: 'тер мин', pinned: true, hits: 23, lastUsedAt: 123, createdAt: 100, extra: 'сохранить' };

describe('словарь: сохранность записей при добавлении и удалении', () => {
  let root, container, state;
  function Probe() { state = useAppData(); return null; }
  function seed(items) {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    localStorage.setItem('zs:zs.dictionary', JSON.stringify(items));
    container = document.createElement('div'); document.body.appendChild(container);
  }
  async function mount() {
    root = createRoot(container);
    await act(async () => root.render(createElement(StrictMode, null,
      createElement(ToastProvider, null, createElement(AppDataProvider, null, createElement(Probe))))));
  }
  async function remount() { await act(async () => root.unmount()); root = null; await mount(); }
  afterEach(async () => {
    if (root) await act(async () => root.unmount());
    root = null; container?.remove(); localStorage.clear(); vi.unstubAllGlobals();
  });

  it('не затирает произношение, закрепление и статистику повторным добавлением', async () => {
    seed([old]); await mount();
    let result;
    await act(async () => { result = state.addDictionaryWord('термин', 'новое'); });
    expect(result).toBeNull();
    await remount();
    expect(state.dictionary).toEqual([old]);
  });
  it('не теряет первое добавление, если оба происходят в одном batch', async () => {
    seed([]); await mount();
    let first, second;
    await act(async () => {
      first = state.addDictionaryWord('Имя', 'первое', { pinned: true });
      second = state.addDictionaryWord('имя', 'другое');
    });
    expect(first?.pronunciation).toBe('первое');
    expect(second).toBeNull();
    await remount();
    expect(state.dictionary).toHaveLength(1);
    expect(state.dictionary[0]).toMatchObject({ word: 'Имя', pronunciation: 'первое', pinned: true });
  });
  it('распознаёт Unicode-эквивалентное написание, не смешивая ё и е', async () => {
    seed([{ ...old, word: 'café' }]); await mount();
    let same, distinct;
    await act(async () => {
      same = state.addDictionaryWord('cafe\u0301', 'другое');
      state.addDictionaryWord('осёл', 'осёл');
      distinct = state.addDictionaryWord('осел', 'осел');
    });
    expect(same).toBeNull();
    expect(distinct?.word).toBe('осел');
    await remount();
    expect(state.dictionary).toHaveLength(3);
  });
  it('возвращает удалённое слово со всеми полями, не заменяя новое с тем же именем', async () => {
    seed([old]); await mount();
    await act(async () => {
      state.removeDictionaryWord(old.id);
      state.addDictionaryWord(old.word, 'новое');
      expect(state.restoreDictionaryWord(old)).toBe(true);
    });
    await remount();
    expect(state.dictionary).toHaveLength(2);
    expect(state.dictionary.find((w) => w.id === old.id)).toEqual(old);
    expect(state.dictionary.find((w) => w.id !== old.id)?.pronunciation).toBe('новое');
  });
  it('не удаляет две унаследованные записи с одинаковым ID', async () => {
    seed([old, { ...old, word: 'Второе', pronunciation: 'второе' }]); await mount();
    expect(new Set(state.dictionary.map((w) => w.id)).size).toBe(2);
    const id = state.dictionary[0].id;
    await act(async () => state.removeDictionaryWord(id));
    await remount();
    expect(state.dictionary.map((w) => w.word)).toEqual(['Второе']);
  });
  it('отклоняет устаревшую правку, сохраняя новое закрепление и черновик', async () => {
    seed([old]); await mount();
    const snapshot = state.dictionary[0];
    let result;
    await act(async () => {
      state.toggleDictionaryPin(snapshot.id);
      result = state.updateDictionaryWord(snapshot, { word: 'Новое', pronunciation: 'произношение', pinned: true });
    });
    expect(result).toBeNull();
    await remount();
    expect(state.dictionary).toEqual([{ ...old, pinned: false }]);
  });
  it('явная правка сохраняет идентификатор, статистику и остальные поля', async () => {
    seed([old]); await mount();
    let result;
    await act(async () => {
      result = state.updateDictionaryWord(state.dictionary[0], { word: 'Другое', pronunciation: '', pinned: false });
    });
    expect(result).toMatchObject({ id: old.id, word: 'Другое', pronunciation: '', pinned: false, hits: 23, lastUsedAt: 123, extra: 'сохранить' });
    await remount();
    expect(state.dictionary[0]).toEqual(result);
  });
  it('при конфликте ID не перезаписывает новую запись и предлагает исходные данные для копирования', async () => {
    seed([old]); await mount();
    const lost = { ...old, word: 'Удалённое', pronunciation: 'своё' };
    let restored;
    await act(async () => { restored = state.restoreDictionaryWord(lost); });
    expect(restored).toBe(false);
    expect(JSON.parse(container.querySelector('.toast__recover')?.value)).toEqual(lost);
    expect(state.dictionary).toEqual([old]);
  });
  it('после удаления и возврата отклоняет старую правку даже без изменения полей', async () => {
    seed([old]); await mount();
    const snapshot = state.dictionary[0]; let result;
    await act(async () => {
      state.removeDictionaryWord(snapshot.id); state.restoreDictionaryWord(snapshot);
      result = state.updateDictionaryWord(snapshot, { word: 'Черновик', pronunciation: 'другое', pinned: false });
    });
    expect(result).toBeNull();
    await remount(); expect(state.dictionary).toEqual([old]);
  });

});
