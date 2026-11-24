import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppDataProvider, useAppData } from './AppDataProvider.jsx';
import { ToastProvider } from './ToastProvider.jsx';

const make = (i) => ({ id: `s${i}`, trigger: `блок ${i}`, body: `текст ${i}`, createdAt: 1700000000000 + i });

describe('быстрые блоки: сохранение и границы', () => {
  let root, container, state;
  function Probe() { state = useAppData(); return null; }
  function seed(items) {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    localStorage.setItem('zs:zs.snippets', JSON.stringify(items));
    container = document.createElement('div');
    document.body.appendChild(container);
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

  it('не вытесняет 200-й блок при добавлении и повторном запуске', async () => {
    seed(Array.from({ length: 200 }, (_, i) => make(i)));
    await mount();
    let result;
    await act(async () => { result = state.addSnippet('новый блок', 'новый текст'); });
    expect(result).toBeNull();
    expect(state.snippets).toHaveLength(200);
    await remount();
    expect(state.snippets.map((x) => x.id)).toEqual(Array.from({ length: 200 }, (_, i) => `s${i}`));
  });

  it('сохраняет уже существующие блоки сверх лимита при запуске и дальнейшей записи', async () => {
    const old = Array.from({ length: 201 }, (_, i) => make(i));
    seed(old); await mount();
    expect(state.snippets).toHaveLength(201);
    await act(async () => { state.removeSnippet('s0'); });
    await remount();
    expect(state.snippets.map((x) => x.id)).toEqual(old.slice(1).map((x) => x.id));
  });

  it('удаление одного старого блока с повторным ID не удаляет второй', async () => {
    const old = [make(0), { ...make(1), id: 's0' }];
    seed(old); await mount();
    const firstId = state.snippets[0].id;
    expect(new Set(state.snippets.map((s) => s.id)).size).toBe(2);
    await act(async () => { state.removeSnippet(firstId); });
    await remount();
    expect(state.snippets.map((s) => s.body)).toEqual([old[1].body]);
  });

  it('не заменяет существующий блок похожим триггером и учитывает React batch', async () => {
    seed([]); await mount();
    let one, duplicate;
    await act(async () => {
      one = state.addSnippet('Моя подпись', 'Оригинал');
      duplicate = state.addSnippet('моя, подпись!', 'Новая версия');
    });
    expect(one?.body).toBe('Оригинал');
    expect(duplicate).toBeNull();
    expect(state.snippets.map((x) => x.body)).toEqual(['Оригинал']);
    await remount();
    expect(state.snippets.map((x) => x.body)).toEqual(['Оригинал']);
  });

  it('возвращает удалённый старый блок целиком, не заменяя вновь созданный с той же фразой', async () => {
    const old = { ...make(0), body: `  ${'x'.repeat(4100)}\n` };
    seed([old]); await mount();
    await act(async () => {
      state.removeSnippet(old.id);
      state.addSnippet(old.trigger, 'новый');
      expect(state.restoreSnippet(old)).toBe(true);
    });
    await remount();
    expect(state.snippets).toHaveLength(2);
    expect(state.snippets.find((s) => s.id === old.id)).toEqual(old);
    expect(state.snippets.find((s) => s.id !== old.id).body).toBe('новый');
  });

  it('при конфликте идентификаторов возвращает текст в уведомлении', async () => {
    const old = make(0);
    seed([old]); await mount();
    let restored;
    await act(async () => { restored = state.restoreSnippet({ ...old, body: 'удалённый текст' }); });
    expect(restored).toBe(false);
    expect(container.querySelector('.toast__recover')?.value).toBe('удалённый текст');
    expect(state.snippets).toEqual([old]);
  });

  it('не обещает срабатывание триггера с кавычками, которые защищены как цитата', async () => {
    seed([]); await mount();
    let result;
    await act(async () => { result = state.addSnippet('«моя подпись»', 'текст'); });
    expect(result).toBeNull();
    expect(state.snippets).toEqual([]);
    expect(container.textContent).toMatch(/кавычки/i);
  });

  it('не обрезает длинный блок и сохраняет авторские пробелы', async () => {
    seed([]); await mount();
    let tooLong, valid;
    await act(async () => {
      tooLong = state.addSnippet('большой', 'x'.repeat(4001));
      valid = state.addSnippet('обычный', '  строка\n    код\n');
    });
    expect(tooLong).toBeNull();
    expect(valid?.body).toBe('  строка\n    код\n');
    await remount();
    expect(state.snippets[0].body).toBe('  строка\n    код\n');
  });
});
