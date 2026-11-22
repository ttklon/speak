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
    this.dirty = false;
    this.lastWriteError = null;
    this.writeProtectionCode = null;
    this.onError = typeof onError === 'function' ? onError : null;
    this.load();
    if (!this.writeProtectionCode) this.checkPendingWrite();
  }

  // Остаток temp может содержать единственную копию незавершённой записи.
  // Автоматически выбирать его вместо профиля нельзя: он может быть частичным,
  // устаревшим или не содержать подтверждённого пользователем состояния.
  checkPendingWrite() {
    try {
      fs.lstatSync(`${this.file}.tmp`);
      this.writeProtectionCode = 'RECOVERY_PENDING';
    } catch (err) {
      if (err?.code === 'ENOENT') return;
      this.writeProtectionCode = 'RECOVERY_UNCHECKED';
    }
    this.reportError(this.writeProtectionCode);
  }

  load() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      let raw;
      try {
        raw = fs.readFileSync(this.file, 'utf8');
      } catch (err) {
        // Только отсутствие файла означает новый профиль. existsSync скрывает
        // ошибки доступа и может ошибочно представить существующий файл пустым.
        if (err?.code === 'ENOENT') return;
        throw err;
      }
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('некорректный формат профиля');
      }
      this.cache = parsed;
    } catch (err) {
      console.error('[store] load failed', err);
      this.cache = {};
      // Даже успешная копия не восстанавливает профиль. Не перезаписываем
      // оригинал в этой сессии и сообщаем об этом интерфейсу.
      this.writeProtectionCode = 'PROFILE_UNREADABLE';
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
        this.writeProtectionCode = 'BACKUP_FAILED';
      }
      this.reportError(this.writeProtectionCode);
    }
  }

  get(key) {
    return this.cache[key] === undefined ? null : this.cache[key];
  }

  set(key, value) {
    this.cache[key] = value;
    this.dirty = true;
    this.scheduleFlush();
    return true;
  }

  remove(key) {
    delete this.cache[key];
    this.dirty = true;
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
    if (!this.dirty) return true;
    if (this.writeProtectionCode) {
      this.reportError(this.writeProtectionCode);
      return false;
    }
    try {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.cache), 'utf8');
      fs.renameSync(tmp, this.file);
      this.dirty = false;
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
