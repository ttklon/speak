import { describe, expect, it, beforeEach } from 'vitest';
import { renderToString } from 'react-dom/server';
import { createElement } from 'react';
import { AppDataProvider } from './state/AppDataProvider.jsx';
import { DictationProvider } from './state/DictationProvider.jsx';
import { ToastProvider } from './state/ToastProvider.jsx';
import App from './App.jsx';

function renderApp(hash) {
  window.location.hash = hash;
  return renderToString(
    createElement(
      ToastProvider,
      null,
      createElement(
        AppDataProvider,
        null,
        createElement(DictationProvider, null, createElement(App, null)),
      ),
    ),
  );
}

describe('рендер приложения', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('главная: слоган и список «Недавние»', () => {
    const html = renderApp('#/home');
    expect(html).toContain('Не печатай');
    expect(html).toContain('ZSpeakly');
    expect(html).toContain('Недавние');
    expect(html).toContain('Пригласить друзей');
  });

  it('словарь', () => {
    const html = renderApp('#/dictionary');
    expect(html).toContain('Словарь');
    expect(html).toContain('Добавить');
  });

  it('горячие клавиши: голосовые сочетания и тогглы', () => {
    const html = renderApp('#/hotkeys');
    expect(html).toContain('Горячие клавиши');
    expect(html).toContain('Диктовка');
    expect(html).toContain('Режим агента');
    expect(html).toContain('role="switch"');
  });

  it('заметки встреч: три карточки действий', () => {
    const html = renderApp('#/meetings');
    expect(html).toContain('Заметки о встречах');
    expect(html).toContain('Подключить календарь');
    expect(html).toContain('Новая заметка');
    expect(html).toContain('Import File');
  });

  it('живой перевод: режимы и кнопка сессии', () => {
    const html = renderApp('#/translate');
    expect(html).toContain('Живой перевод');
    expect(html).toContain('Транскрипт');
    expect(html).toContain('Субтитры');
    expect(html).toContain('Начать сессию');
  });

  it('буфер обмена: вкладки и поиск', () => {
    const html = renderApp('#/clipboard');
    expect(html).toContain('Буфер обмена');
    expect(html).toContain('Поиск по истории буфера');
    expect(html).toContain('Изображение');
  });

  it('сайдбар содержит все разделы', () => {
    const html = renderApp('#/home');
    ['Главная', 'Словарь', 'Горячие клавиши', 'Заметки встреч', 'Живой перевод', 'Буфер обмена'].forEach(
      (label) => expect(html).toContain(label),
    );
    expect(html).toContain('НОВОЕ');
  });
});
