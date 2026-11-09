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
    // рекламные блоки из чужого приложения убраны
    expect(html).not.toContain('Пригласить друзей');
    expect(html).not.toContain('Мобильное прилож');
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

  it('буфер обмена: вкладки и поиск', () => {
    const html = renderApp('#/clipboard');
    expect(html).toContain('Буфер обмена');
    expect(html).toContain('Поиск по истории буфера');
    expect(html).toContain('Изображение');
  });

  it('сайдбар содержит только нужные разделы', () => {
    const html = renderApp('#/home');
    ['Главная', 'Словарь', 'Горячие клавиши', 'Буфер обмена'].forEach((label) =>
      expect(html).toContain(label),
    );
    // убраны по просьбе автора видео
    expect(html).not.toContain('Заметки встреч');
    expect(html).not.toContain('Живой перевод');
    expect(html).toContain('AI-инструкции');
  });

  it('удалённые разделы открывают главную', () => {
    expect(renderApp('#/meetings')).toContain('Не печатай');
    expect(renderApp('#/translate')).toContain('Не печатай');
  });
});

describe('устойчивость настроек', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('частичные настройки в профиле не ломают рендер', () => {
    // старый профиль после обновления: только имя, без остальных полей
    localStorage.setItem('zs:zs.settings', JSON.stringify({ onboarded: true, userName: 'Максим' }));
    const html = renderApp('#/home');
    expect(html).toMatch(/Привет, (<!-- -->)?Максим/);
    expect(html).toContain('Не печатай');
  });

  it('настройки открываются по прямой ссылке', () => {
    localStorage.setItem('zs:zs.settings', JSON.stringify({ onboarded: true, userName: 'Максим' }));
    const html = renderApp('#/settings?section=app');
    // модалка рендерится в портал — на сервере её нет, но приложение живо
    expect(html).toContain('ZSpeakly');
  });
});
