/**
 * Файловое хранилище профиля ZSpeakly (замена localStorage в Electron).
 * Один JSON-файл: %APPDATA%\ZSpeakly\profile.json, атомарная запись.
 */

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

class JsonStore {
  constructor(fileName = 'profile.json', { onError } = {}) {
    this.dir = app.getPath('userData');
    this.file = path.join(this.dir, fileName);
    this.cache = {};
    this.timer = null;
    this.lastWriteError = null;
    this.writeProtected = false;
    this.onError = typeof onError === 'function' ? onError : null;
    this.load();
  }

  load() {
    try {
      if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
      if (fs.existsSync(this.file)) {
        const raw = fs.readFileSync(this.file, 'utf8');
        this.cache = raw ? JSON.parse(raw) : {};
      }
    } catch (err) {
      console.error('[store] load failed', err);
      this.cache = {};
      // Профиль мог испортиться при аварийном выключении или ручной правке.
      // Молча затирать его нельзя: человек потерял бы историю диктовок без
      // единого шанса её достать. Откладываем копию рядом — она ещё пригодится.
      try {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        let backup;
        for (let index = 0; index < 100; index += 1) {
          const candidate = `${this.file}.broken-${stamp}${index ? `-${index}` : ''}`;
          try {
            fs.copyFileSync(this.file, candidate, fs.constants.COPYFILE_EXCL);
            backup = candidate;
            break;
          } catch (copyErr) {
            if (copyErr?.code !== 'EEXIST') throw copyErr;
          }
        }
        if (!backup) throw new Error('не удалось подобрать имя резервной копии');
        console.warn('[store] битый профиль сохранён как', backup);
      } catch (copyErr) {
        console.warn('[store] не удалось сохранить копию битого профиля', copyErr.message);
        // Нельзя заменять исходный профиль пустым, если не удалось сохранить
        // копию или даже определить, существует ли файл. До перезапуска все
        // изменения остаются только в памяти.
        this.writeProtected = true;
        this.reportError('BACKUP_FAILED');
      }
    }
  }

  get(key) {
    return this.cache[key] === undefined ? null : this.cache[key];
  }

  set(key, value) {
    this.cache[key] = value;
    this.scheduleFlush();
    return true;
  }

  remove(key) {
    delete this.cache[key];
    this.scheduleFlush();
    return true;
  }

  scheduleFlush() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 180);
  }

  reportError(code) {
    this.lastWriteError = { code };
    try { this.onError?.(this.status()); } catch { /* окно могло закрыться */ }
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.writeProtected) {
      this.reportError('BACKUP_FAILED');
      return false;
    }
    try {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.cache), 'utf8');
      fs.renameSync(tmp, this.file);
      this.lastWriteError = null;
      return true;
    } catch (err) {
      console.error('[store] flush failed', err);
      // Не отправляем сообщение ОС целиком: в нём может быть путь с именем.
      const code = /^[A-Z0-9_]{1,32}$/.test(String(err?.code || '')) ? err.code : 'UNKNOWN';
      this.reportError(code);
      return false;
    }
  }

  status() {
    return this.lastWriteError ? { ok: false, ...this.lastWriteError } : { ok: true };
  }

  sizeSync() {
    try {
      return fs.statSync(this.file).size;
    } catch {
      return 0;
    }
  }
}

module.exports = { JsonStore };
