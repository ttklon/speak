import { describe, it, expect } from 'vitest';
import { parseHash, toHash, navigate, PAGES } from './router.js';

describe('маршруты по хешу', () => {
  it('разбирает страницу и параметры', () => {
    expect(parseHash('#/clipboard')).toMatchObject({ page: 'clipboard', params: {} });
    expect(parseHash('#/settings?section=features&from=home')).toMatchObject({
      page: 'settings',
      params: { section: 'features', from: 'home' },
    });
  });

  it('неизвестный адрес ведёт на главную, а не в пустоту', () => {
    expect(parseHash('#/что-то-своё').page).toBe('home');
    // старая ссылка на инструкции ведёт в «Горячие клавиши», а не на главную
    expect(parseHash('#/instructions')).toMatchObject({
      page: 'hotkeys',
      params: { tab: 'recommended' },
    });
    expect(parseHash('').page).toBe('home');
    expect(parseHash('#/').page).toBe('home');
  });

  it('собирает адрес и пропускает пустые параметры', () => {
    expect(toHash('home')).toBe('#/home');
    expect(toHash('settings', { section: 'data', from: '' })).toBe('#/settings?section=data');
  });

  it('кириллица в параметрах не ломается', () => {
    const hash = toHash('settings', { q: 'словарь кар' });
    expect(parseHash(hash).params.q).toBe('словарь кар');
  });

  it('все страницы из NAV разбираются в свою страницу', () => {
    for (const page of PAGES) {
      expect(parseHash(toHash(page)).page).toBe(page);
    }
  });

  it('navigate не трогает адрес, если он уже такой', () => {
    location.hash = '#/home';
    navigate('home');
    expect(location.hash).toBe('#/home');
    navigate('dictionary');
    expect(location.hash).toBe('#/dictionary');
    expect(parseHash(location.hash).page).toBe('dictionary');
  });
});
