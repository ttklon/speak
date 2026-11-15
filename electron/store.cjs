/**
 * Файловое хранилище профиля ZSpeakly (замена localStorage в Electron).
 * Один JSON-файл: %APPDATA%\ZSpeakly\profile.json, атомарная запись.
 */

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

class JsonStore {
  constructor(fileName = 'profile.json') {
    this.dir = app.getPath('userData');
    this.file = path.join(this.dir, fileName);
    this.cache = {};
    this.timer = null;
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
        const backup = `${this.file}.broken-${stamp}`;
        fs.copyFileSync(this.file, backup);
        console.warn('[store] битый профиль сохранён как', backup);
      } catch (copyErr) {
        console.warn('[store] не удалось сохранить копию битого профиля', copyErr.message);
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

  flush() {
    try {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.cache), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('[store] flush failed', err);
    }
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
