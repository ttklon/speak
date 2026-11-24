import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import EditDictationModal from './EditDictationModal.jsx';

const { update, push } = vi.hoisted(() => ({ update: vi.fn(), push: vi.fn() }));
vi.mock('../../state/AppDataProvider.jsx', () => ({
  useAppData: () => ({ dictionary: [], addDictionaryWord: vi.fn(), updateDictation: update }),
}));
vi.mock('../../state/ToastProvider.jsx', () => ({ useToast: () => ({ push }) }));

describe('редактирование длинной расшифровки', () => {
  let root, container;
  afterEach(async () => {
    if (root) await act(async () => root.unmount());
    container?.remove();
    root = null;
    update.mockReset(); push.mockReset(); vi.unstubAllGlobals();
  });
  it('при отказе истории оставляет поле открытым и не сообщает об успешной правке', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    update.mockReturnValue(false);
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
    expect(update).toHaveBeenCalledWith('one', { text: 'тестовая правка' });
    expect(document.querySelector('.modal textarea')?.value).toBe('тестовая правка');
    expect(close).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith(expect.objectContaining({ title: 'Правка превышает бюджет истории', tone: 'warn' }));
    expect(push).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Расшифровка обновлена' }));
  });
});
