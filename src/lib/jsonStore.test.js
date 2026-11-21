// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const Module = require('node:module');
let dir;
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') return { app: { getPath: () => dir } };
  return originalLoad.call(this, name, ...args);
};
let JsonStore;
try { ({ JsonStore } = require('../../electron/store.cjs')); }
finally { Module._load = originalLoad; }

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zs-profile-test-'));
  vi.useFakeTimers();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('профиль Electron: сбой записи', () => {
  it('не затирает старый профиль при ошибке замены, сообщает и сохраняет кэш для повторной записи', () => {
    const file = path.join(dir, 'profile.json');
    fs.writeFileSync(file, JSON.stringify({ history: ['старое'] }));
    const notify = vi.fn();
    const store = new JsonStore('profile.json', { onError: notify });
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('путь содержит личные данные'), { code: 'EACCES' });
    });
    store.set('history', ['новое']);
    expect(store.status()).toEqual({ ok: true }); // отложенная запись ещё не выполнялась
    vi.advanceTimersByTime(180);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ history: ['старое'] });
    expect(store.get('history')).toEqual(['новое']);
    expect(store.status()).toEqual({ ok: false, code: 'EACCES' });
    expect(notify).toHaveBeenCalledWith({ ok: false, code: 'EACCES' });
    rename.mockRestore();
    expect(store.flush()).toBe(true);
    expect(store.status()).toEqual({ ok: true });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ history: ['новое'] });
  });

  it('не скрывает ошибку записи temp и не передаёт исключение или путь в событие', () => {
    const notify = vi.fn();
    const store = new JsonStore('profile.json', { onError: notify });
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => { throw new Error('секретный путь'); });
    store.set('secret', 'личный текст');
    expect(store.flush()).toBe(false);
    expect(notify).toHaveBeenCalledWith({ ok: false, code: 'UNKNOWN' });
    expect(JSON.stringify(notify.mock.calls)).not.toContain('секретный');
    expect(JSON.stringify(notify.mock.calls)).not.toContain('личный текст');
  });

  it('при неудаче создания резервной копии не перезаписывает повреждённый профиль', () => {
    const file = path.join(dir, 'profile.json');
    const broken = '{незаконченный оригинал';
    fs.writeFileSync(file, broken);
    vi.spyOn(fs, 'copyFileSync').mockImplementation(() => { throw Object.assign(new Error('нет прав'), { code: 'EACCES' }); });
    const store = new JsonStore();
    expect(store.status()).toEqual({ ok: false, code: 'BACKUP_FAILED' });
    store.set('dictations', ['новая запись']);
    vi.advanceTimersByTime(180);
    expect(store.flush()).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe(broken);
    expect(store.get('dictations')).toEqual(['новая запись']);
  });

  it.each(['', 'null', '[]', '42', '"строка"', '{незаконченный'])('не заменяет нечитаемый профиль и при успешной копии: %s', (raw) => {
    const file = path.join(dir, 'profile.json');
    fs.writeFileSync(file, raw);
    const notify = vi.fn();
    const store = new JsonStore('profile.json', { onError: notify });
    expect(store.status()).toEqual({ ok: false, code: 'PROFILE_UNREADABLE' });
    const backup = fs.readdirSync(dir).find((f) => f.startsWith('profile.json.broken-'));
    expect(backup).toBeTruthy();
    expect(fs.readFileSync(path.join(dir, backup), 'utf8')).toBe(raw);
    store.set('new', 'value');
    vi.advanceTimersByTime(180);
    expect(store.flush()).toBe(false);
    expect(store.status()).toEqual({ ok: false, code: 'PROFILE_UNREADABLE' });
    expect(fs.readFileSync(file, 'utf8')).toBe(raw);
    expect(notify).toHaveBeenCalledWith({ ok: false, code: 'PROFILE_UNREADABLE' });
  });

  it('при ошибке чтения не заменяет даже корректный файл, скопированный в резерв', () => {
    const file = path.join(dir, 'profile.json');
    const raw = JSON.stringify({ history: ['важное'] });
    fs.writeFileSync(file, raw);
    const read = vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw Object.assign(new Error('запрещено'), { code: 'EACCES' });
    });
    const store = new JsonStore();
    read.mockRestore();
    expect(store.status()).toEqual({ ok: false, code: 'PROFILE_UNREADABLE' });
    store.set('history', ['новое']);
    expect(store.flush()).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe(raw);
  });

  it('отсутствующий профиль создаётся и успешно читается после перезапуска', () => {
    const store = new JsonStore();
    expect(store.status()).toEqual({ ok: true });
    store.set('history', ['сохранено']);
    expect(store.flush()).toBe(true);
    expect(new JsonStore().get('history')).toEqual(['сохранено']);
  });

  it('не затирает прежнюю резервную копию при двух ошибках в одну секунду', () => {
    const file = path.join(dir, 'profile.json');
    fs.writeFileSync(file, '{первый');
    new JsonStore();
    fs.writeFileSync(file, '{второй');
    new JsonStore();
    const backups = fs.readdirSync(dir).filter((f) => f.startsWith('profile.json.broken-'));
    expect(backups).toHaveLength(2);
    expect(backups.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).sort()).toEqual(['{второй', '{первый']);
  });

  it('сбой уведомления не мешает сохранению кэша и status виден позднему слушателю', () => {
    const store = new JsonStore('profile.json', { onError: () => { throw new Error('окно закрыто'); } });
    vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw Object.assign(new Error(), { code: 'ENOSPC' }); });
    store.set('count', 1);
    expect(store.flush()).toBe(false);
    expect(store.get('count')).toBe(1);
    expect(store.status()).toEqual({ ok: false, code: 'ENOSPC' });
  });
});
