import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { diag, localEvents, installErrorHooks } from './diagnostics.js';

const KEY = 'zs.diagnostics.buffer';

beforeEach(() => {
  localStorage.clear();
  delete window.zspeakly;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  delete window.zspeakly;
  vi.restoreAllMocks();
});

describe('журнал диагностики в браузере', () => {
  it('событие попадает в локальный буфер с уровнем и областью', () => {
    const entry = diag.error('диктовка', 'не удалось распознать', { code: 'stt' });
    expect(entry).toMatchObject({ level: 'error', scope: 'диктовка', message: 'не удалось распознать', data: { code: 'stt' } });
    expect(entry.at).toBeGreaterThan(0);
    expect(localEvents()).toHaveLength(1);
    expect(localEvents()[0].message).toBe('не удалось распознать');
  });

  it('буфер не растёт бесконечно — держим последние 200', () => {
    for (let i = 0; i < 250; i += 1) diag.info('тест', `событие ${i}`);
    const events = localEvents();
    expect(events).toHaveLength(200);
    expect(events.at(-1).message).toBe('событие 249');
  });

  it('слишком длинное сообщение обрезается, а не раздувает файл', () => {
    const entry = diag.warn('тест', 'я'.repeat(5000));
    expect(entry.message).toHaveLength(1000);
  });

  it('битый буфер читается как пустой', () => {
    localStorage.setItem(KEY, 'не json');
    expect(localEvents()).toEqual([]);
  });

  it('ошибка и предупреждение видны в консоли, обычная запись — нет', () => {
    diag.error('тест', 'беда');
    expect(console.error).toHaveBeenCalledTimes(1);
    diag.warn('тест', 'внимание');
    expect(console.warn).toHaveBeenCalledTimes(1);
    diag.info('тест', 'просто факт');
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });
});

describe('журнал в приложении', () => {
  it('с мостом пишет в main, а локальный буфер не трогает', () => {
    const log = vi.fn(() => Promise.resolve());
    window.zspeakly = { native: { log } };
    diag.info('тест', 'через мост');
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ message: 'через мост', level: 'info' }));
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('мост не вернул промис — не падаем', () => {
    window.zspeakly = { native: { log: () => undefined } };
    expect(() => diag.error('тест', 'синхронный мост')).not.toThrow();
  });
});

describe('перехватчики ошибок', () => {
  it('ловит падение интерфейса и отказ промиса', () => {
    const off = installErrorHooks();
    window.dispatchEvent(new ErrorEvent('error', { message: 'упал компонент', filename: 'app.js', lineno: 12 }));
    const rejection = new Event('unhandledrejection');
    rejection.reason = new Error('отказ');
    window.dispatchEvent(rejection);
    const errors = localEvents().filter((e) => e.level === 'error');
    expect(errors.some((e) => e.message === 'упал компонент')).toBe(true);
    expect(errors.some((e) => e.message === 'Необработанный отказ промиса')).toBe(true);
    expect(errors[0].data.source).toBe('app.js:12');
    off();
    expect(window.__zsDiagHooked).toBe(false);
  });

  it('при запуске отмечает старт и ставится один раз', () => {
    const off = installErrorHooks();
    expect(localEvents().some((e) => e.message === 'Интерфейс запущен')).toBe(true);
    const again = installErrorHooks();
    expect(localEvents().filter((e) => e.message === 'Интерфейс запущен')).toHaveLength(1);
    again();
    off();
  });
});
