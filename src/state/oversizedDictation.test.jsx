import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { AppDataProvider, useAppData } from './AppDataProvider.jsx';
import { ToastProvider, useToast } from './ToastProvider.jsx';
import { DICTATION_MAX_BYTES } from '../lib/dictationBudget.js';

describe('слишком большая новая запись истории', () => {
  let root;
  afterEach(async () => {
    if (root) await act(async () => root.unmount());
    root = null;
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('не стирает прежние записи и оставляет полный результат для ручного сохранения', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const previous = { id: 'previous', text: 'прежняя запись', createdAt: Date.now(), words: 2 };
    localStorage.setItem('zs:zs.dictations', JSON.stringify([previous]));
    const element = document.createElement('div');
    document.body.appendChild(element);
    let state, toast;
    function Probe() { state = useAppData(); toast = useToast(); return null; }
    root = createRoot(element);
    await act(async () => root.render(createElement(ToastProvider, null, createElement(AppDataProvider, null, createElement(Probe)))));
    const oversized = 'я'.repeat(Math.ceil(DICTATION_MAX_BYTES / 2));
    let accepted;
    await act(async () => { accepted = state.addDictation({ id: 'oversized', text: oversized, createdAt: Date.now() }); });
    expect(state.dictations.map((item) => item.id)).toEqual(['previous']);
    expect(accepted).toBe(false);
    expect(JSON.parse(localStorage.getItem('zs:zs.dictations')).map((item) => item.id)).toEqual(['previous']);
    expect(element.querySelector('.toast__recover')?.value).toBe(oversized);
    expect(element.textContent).toMatch(/не сохранена в истории/i);
    await act(async () => { accepted = state.addDictation({ id: 'next', text: 'новая запись', createdAt: Date.now() }); });
    expect(accepted).toBe(true);
    expect(state.dictations.map((item) => item.id)).toEqual(['next', 'previous']);
    await act(async () => { accepted = state.updateDictation('next', { text: oversized }); });
    expect(accepted).toBe(false);
    expect(state.dictations.map((item) => item.text)).toEqual(['новая запись', 'прежняя запись']);
    expect(JSON.parse(localStorage.getItem('zs:zs.dictations')).map((item) => item.text)).toEqual(['новая запись', 'прежняя запись']);
    await act(async () => {
      for (let i = 0; i < 6; i += 1) toast.push({ title: `Уведомление ${i}`, ttl: 0 });
    });
    expect(element.querySelector('.toast__recover')?.value).toBe(oversized);
    expect(element.querySelector('.toast__recover')?.readOnly).toBe(true);
    await act(async () => root.unmount());
    root = createRoot(element);
    await act(async () => root.render(createElement(ToastProvider, null, createElement(AppDataProvider, null, createElement(Probe)))));
    expect(state.dictations.map((item) => item.id)).toEqual(['next', 'previous']);
    element.remove();
  });

  it('при реальном лимите отклоняет правку сверх общего бюджета и не теряет старую запись после перезапуска', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const chars = Math.floor(DICTATION_MAX_BYTES / 4) - 100;
    const now = Date.now();
    const original = [
      { id: 'new', text: 'a'.repeat(chars), createdAt: now },
      { id: 'old', text: 'b'.repeat(chars), createdAt: now },
    ];
    localStorage.setItem('zs:zs.dictations', JSON.stringify(original));
    const element = document.createElement('div');
    document.body.appendChild(element);
    let state;
    function Probe() { state = useAppData(); return null; }
    root = createRoot(element);
    await act(async () => root.render(createElement(ToastProvider, null, createElement(AppDataProvider, null, createElement(Probe)))));
    let accepted;
    await act(async () => { accepted = state.updateDictation('new', { text: 'a'.repeat(chars + 50) }); });
    expect(accepted).toBe(false);
    expect(state.dictations.map((x) => x.text.length)).toEqual([chars, chars]);
    await act(async () => root.unmount());
    root = createRoot(element);
    await act(async () => root.render(createElement(ToastProvider, null, createElement(AppDataProvider, null, createElement(Probe)))));
    expect(state.dictations.map((x) => x.id)).toEqual(['new', 'old']);
    expect(state.dictations.map((x) => x.text.length)).toEqual([chars, chars]);
    element.remove();
  });


  it('при реальном лимите сохраняет унаследованную oversized запись и соседнюю при загрузке', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const now = Date.now();
    const oversized = 'x'.repeat(Math.floor(DICTATION_MAX_BYTES / 2));
    localStorage.setItem('zs:zs.dictations', JSON.stringify([
      { id: 'large', text: oversized, createdAt: now },
      { id: 'older', text: 'предыдущая запись', createdAt: now },
    ]));
    const element = document.createElement('div');
    document.body.appendChild(element);
    let state;
    function Probe() { state = useAppData(); return null; }
    root = createRoot(element);
    await act(async () => root.render(createElement(ToastProvider, null, createElement(AppDataProvider, null, createElement(Probe)))));
    expect(state.dictations.map((x) => x.id)).toEqual(['large', 'older']);
    let accepted;
    await act(async () => { accepted = state.addDictation({ id: 'new', text: 'новый текст', createdAt: now }); });
    expect(accepted).toBe(false);
    expect(element.querySelector('.toast__recover')?.value).toBe('новый текст');
    expect(JSON.parse(localStorage.getItem('zs:zs.dictations')).map((x) => x.id)).toEqual(['large', 'older']);
    await act(async () => root.unmount());
    root = createRoot(element);
    await act(async () => root.render(createElement(ToastProvider, null, createElement(AppDataProvider, null, createElement(Probe)))));
    expect(state.dictations.map((x) => x.id)).toEqual(['large', 'older']);
    expect(state.dictations[0].text).toBe(oversized);
    element.remove();
  });

});
