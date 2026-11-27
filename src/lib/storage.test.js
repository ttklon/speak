import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { assertBackupImportAllowed, commitBackupSections, read, write, remove, storageBytes, formatBytes, isElectron } from './storage.js';

beforeEach(() => {
  localStorage.clear();
  delete window.zspeakly;
});

afterEach(() => {
  delete window.zspeakly;
});

describe('хранилище в браузере', () => {
  it('запись и чтение возвращают то же значение', () => {
    expect(write('zs.settings', { theme: 'dark' })).toBe(true);
    expect(read('zs.settings')).toEqual({ theme: 'dark' });
    expect(localStorage.getItem('zs:zs.settings')).toBe('{"theme":"dark"}');
  });

  it('удаление убирает ключ', () => {
    write('zs.stats', { wordsTotal: 5 });
    expect(remove('zs.stats')).toBe(true);
    expect(read('zs.stats')).toBeNull();
  });

  it('битый JSON не роняет приложение — читаем как пусто', () => {
    localStorage.setItem('zs:zs.dictations', '{не json');
    expect(read('zs.dictations')).toBeNull();
  });

  it('переполнение хранилища: запись честно возвращает false и сообщает наружу', () => {
    const heard = [];
    const onError = (e) => heard.push(e.detail);
    window.addEventListener('zs:storage-error', onError);
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(write('zs.clipboard', [1, 2, 3])).toBe(false);
    spy.mockRestore();
    window.removeEventListener('zs:storage-error', onError);
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatchObject({ key: 'zs.clipboard' });
    expect(heard[0].reason).toMatch(/Quota/);
  });

  it('занятое место считает только свои ключи', () => {
    write('zs.stats', { a: 1 });
    localStorage.setItem('чужой-ключ', 'не считаем');
    const bytes = storageBytes();
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThan(2000);
  });
});

describe('хранилище в Electron', () => {
  it('импорт отклоняется при ошибке, отсутствии или исключении статуса; путь не раскрывается', () => {
    expect(() => assertBackupImportAllowed()).not.toThrow(); // браузер не умеет проверять будущую запись
    for (const statusSync of [undefined, () => ({ ok: false, code: 'ENOSPC' }), () => ({}), () => { throw new Error('личный путь'); }]) {
      window.zspeakly = { isElectron: true, store: { statusSync } };
      expect(() => assertBackupImportAllowed()).toThrow(/Текущие данные не изменены/);
      try { assertBackupImportAllowed(); } catch (err) { expect(err.message).not.toContain('личный путь'); }
    }
    window.zspeakly = { isElectron: true, store: { statusSync: () => ({ ok: true }) } };
    expect(() => assertBackupImportAllowed()).not.toThrow();
  });

  it('не применяет импорт в Electron без подтверждённой пакетной записи', () => {
    for (const commitBackupSync of [undefined, () => false, () => { throw new Error('личный путь'); }]) {
      window.zspeakly = { isElectron: true, store: { statusSync: () => ({ ok: true }), commitBackupSync } };
      expect(() => commitBackupSections({ 'zs.dictations': [] })).toThrow(/не удалось подтвердить/i);
      try { commitBackupSections({ 'zs.dictations': [] }); } catch (err) { expect(err.message).not.toContain('личный путь'); }
    }
    const commitBackupSync = vi.fn(() => true);
    window.zspeakly = { isElectron: true, store: { statusSync: () => ({ ok: true }), commitBackupSync } };
    expect(commitBackupSections({ 'zs.dictations': [] })).toBe(true);
    expect(commitBackupSync).toHaveBeenCalledWith({ 'zs.dictations': [] });
    window.zspeakly.isElectron = false;
    expect(commitBackupSections({ 'zs.dictations': [] })).toBe(false);
  });

  it('ходит через мост, а не в localStorage', () => {
    const store = {
      getSync: vi.fn(() => ({ theme: 'light' })),
      set: vi.fn(),
      remove: vi.fn(),
      sizeSync: vi.fn(() => 4096),
    };
    window.zspeakly = { isElectron: true, store };
    expect(isElectron()).toBe(true);
    expect(read('zs.settings')).toEqual({ theme: 'light' });
    expect(write('zs.settings', { theme: 'dark' })).toBe(true);
    expect(store.set).toHaveBeenCalledWith('zs.settings', { theme: 'dark' });
    remove('zs.settings');
    expect(store.remove).toHaveBeenCalledWith('zs.settings');
    expect(storageBytes()).toBe(4096);
    expect(localStorage.length).toBe(0);
  });

  it('асинхронный отказ IPC записи и удаления доходит до интерфейса', async () => {
    const events = [];
    const listener = (event) => events.push(event.detail);
    window.addEventListener('zs:storage-error', listener);
    window.zspeakly = { isElectron: true, store: {
      set: () => Promise.reject(new Error('IPC закрыт')),
      remove: () => Promise.resolve(false),
    } };
    expect(write('zs.dictations', [])).toBe(true); // запрос принят, ответ позже
    expect(remove('zs.dictations')).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    window.removeEventListener('zs:storage-error', listener);
    expect(events).toHaveLength(2);
    expect(events.every((event) => event.source === 'electron')).toBe(true);
    expect(events.map((event) => event.reason)).toEqual(['IPC закрыт', 'мост отклонил удаление']);
  });

  it('мост упал — приложение не падает', () => {
    window.zspeakly = {
      isElectron: true,
      store: {
        getSync: () => { throw new Error('мост закрыт'); },
        set: () => { throw new Error('мост закрыт'); },
        remove: () => { throw new Error('мост закрыт'); },
        sizeSync: () => { throw new Error('мост закрыт'); },
      },
    };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(read('zs.settings')).toBeNull();
    expect(write('zs.settings', {})).toBe(false);
    expect(remove('zs.settings')).toBe(false);
    expect(storageBytes()).toBe(0);
    vi.restoreAllMocks();
  });
});

describe('человеческий размер', () => {
  it('байты, килобайты, мегабайты', () => {
    expect(formatBytes(0)).toBe('0 Б');
    expect(formatBytes(-1)).toBe('0 Б');
    expect(formatBytes(512)).toBe('512 Б');
    expect(formatBytes(2048)).toBe('2 КБ');
    expect(formatBytes(1536)).toBe('1.5 КБ');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5 МБ');
    expect(formatBytes(1024 ** 4)).toBe('1 ТБ');
  });
});
