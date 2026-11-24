import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import EditDictationModal from './EditDictationModal.jsx';

const { update, push, add } = vi.hoisted(() => ({ update: vi.fn(), push: vi.fn(), add: vi.fn() }));
vi.mock('../../state/AppDataProvider.jsx', () => ({
  useAppData: () => ({ dictionary: [], addDictionaryWord: add, saveDictationEdit: update }),
}));
vi.mock('../../state/ToastProvider.jsx', () => ({ useToast: () => ({ push }) }));

describe('редактирование длинной расшифровки', () => {
  let root, container;
  afterEach(async () => {
    if (root) await act(async () => root.unmount());
    container?.remove();
    root = null;
    update.mockReset(); push.mockReset(); add.mockReset(); vi.unstubAllGlobals();
  });
  it('при отказе истории оставляет поле открытым и не сообщает об успешной правке', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    update.mockReturnValue({ ok: false, reason: 'budget' });
    const close = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(createElement(EditDictationModal, {
      open: true, item: { id: 'one', text: 'старый текст', createdAt: Date.now() }, onClose: close,
    })));
    const area = document.querySelector('.modal textarea');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(area, 'тестовая правка');
      area.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => [...document.querySelectorAll('.modal button')].find((b) => /Сохранить/.test(b.textContent)).click());
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ id: 'one' }), { text: 'тестовая правка', words: 2 });
    expect(document.querySelector('.modal textarea')?.value).toBe('тестовая правка');
    expect(close).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith(expect.objectContaining({ title: 'Правка превышает бюджет истории', tone: 'warn' }));
    expect(push).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Расшифровка обновлена' }));
  });
  it('не сообщает об успешном сохранении пустого текста', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const close = vi.fn(); container = document.createElement('div'); document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(createElement(EditDictationModal, { open: true, item: { id: 'one', text: 'старый текст', createdAt: Date.now() }, onClose: close })));
    const area = document.querySelector('.modal textarea');
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(area, '  '); area.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => [...document.querySelectorAll('.modal button')].find((b) => /Сохранить/.test(b.textContent)).click());
    expect(close).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Расшифровка обновлена' }));
    expect(document.querySelector('.modal textarea')?.value).toBe('  ');
  });

  it('не сообщает о добавлении всех слов, когда часть отклонена', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    update.mockReturnValue({ ok: true });
    add.mockReturnValueOnce({ word: 'зеленку' }).mockReturnValueOnce(null);
    const close = vi.fn(); container = document.createElement('div'); document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(createElement(EditDictationModal, { open: true, item: { id: 'one', text: 'тест зелинку и купиру', createdAt: Date.now() }, onClose: close })));
    const area = document.querySelector('.modal textarea');
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(area, 'тест зеленку и купюру'); area.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => [...document.querySelectorAll('.modal button')].find((b) => /Сохранить/.test(b.textContent)).click());
    expect(document.querySelector('.learn-card')?.textContent).toMatch(/купюру/);
    expect(document.querySelector('.modal textarea').readOnly).toBe(true);
    await act(async () => [...document.querySelectorAll('.modal button')].find((b) => /Добавить/.test(b.textContent)).click());
    expect(close).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Добавлено в словарь' }));
    expect(push).toHaveBeenCalledWith(expect.objectContaining({ title: 'Не все слова добавлены', tone: 'warn' }));
    expect(document.querySelector('.learn-card')?.textContent).toMatch(/купюру/);
    expect(document.querySelector('.learn-card')?.textContent).not.toMatch(/зеленку/);
  });

  it('сохраняет отступы и переносы в отредактированном тексте', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    update.mockReturnValue({ ok: true });
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    await act(async () => root.render(createElement(EditDictationModal, { open: true, item: { id: 'one', text: 'старый', createdAt: Date.now() }, onClose: vi.fn() })));
    const area = document.querySelector('.modal textarea');
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(area, '  новый текст\n'); area.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => [...document.querySelectorAll('.modal button')].find((b) => /Сохранить/.test(b.textContent)).click());
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ id: 'one' }), expect.objectContaining({ text: '  новый текст\n' }));
  });

  it('при конфликте версии оставляет черновик в открытом поле', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    update.mockReturnValue({ ok: false, reason: 'changed' });
    const close = vi.fn(); container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    await act(async () => root.render(createElement(EditDictationModal, { open: true, item: { id: 'one', text: 'старый текст', createdAt: Date.now() }, onClose: close })));
    const area = document.querySelector('.modal textarea');
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(area, 'черновик'); area.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => [...document.querySelectorAll('.modal button')].find((b) => /Сохранить/.test(b.textContent)).click());
    expect(area.value).toBe('черновик'); expect(close).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith(expect.objectContaining({ title: 'Запись изменилась', tone: 'warn' }));
  });

});
