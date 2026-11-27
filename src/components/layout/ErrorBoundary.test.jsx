import { describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { createElement } from 'react';
import ErrorBoundary from './ErrorBoundary.jsx';

const Boom = () => {
  throw new Error('сломалось на экране');
};

describe('аварийный экран', () => {
  it('без ошибки просто показывает детей', () => {
    const html = renderToString(
      createElement(ErrorBoundary, null, createElement('p', null, 'всё хорошо')),
    );
    expect(html).toContain('всё хорошо');
  });

  it('при ошибке объясняет, что данные целы, и даёт выход вместо белого окна', async () => {
    // Было белое окно: падение любого компонента размонтировало всё дерево,
    // и человек не мог открыть ни настройки, ни диагностику.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(ErrorBoundary, null, createElement(Boom, null)));
    });
    const text = container.textContent || '';
    expect(text).toContain('Что-то сломалось на этом экране');
    expect(text).toContain('данные хранятся на этом компьютере');
    expect(text).toContain('Перезагрузить окно');
    expect(text).toContain('Открыть диагностику');
    await act(async () => root.unmount());
    container.remove();
    spy.mockRestore();
  });
});
