import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import SectionErrorBoundary from './SectionErrorBoundary.jsx';

const Broken = () => { throw new Error('ошибка раздела'); };

describe('защита раздела настроек', () => {
  it('изолирует ошибку и при смене раздела снова показывает содержимое', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.fn();
    window.zspeakly = { native: { log } };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(createElement(SectionErrorBoundary, { key: 'data' }, createElement(Broken))));
      expect(container.querySelector('[role="alert"]').textContent).toContain('Не удалось открыть этот раздел');
      expect(container.textContent).toContain('Перезагрузить окно');
      expect(log).toHaveBeenCalledWith(expect.objectContaining({ level: 'error', message: expect.stringContaining('ошибка раздела') }));
      await act(async () => root.render(createElement(SectionErrorBoundary, { key: 'app' }, createElement('p', null, 'Другой раздел'))));
      expect(container.textContent).toContain('Другой раздел');
      expect(container.querySelector('[role="alert"]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
      delete window.zspeakly;
      errors.mockRestore();
    }
  });
});
