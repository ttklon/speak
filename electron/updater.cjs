/**
 * Автообновление ZSpeakly через electron-updater.
 *
 * Источник — GitHub Releases этого репозитория (`owner/repo` в package.json →
 * `build.publish`). Обновление качает установщик и предлагает перезапуск;
 * никакой телеметрии, только HTTPS-запрос к GitHub.
 *
 * В dev-режиме и в portable-сборке обновление недоступно — там честно
 * возвращаем reason, чтобы интерфейс не врал.
 */

const isDev = process.env.NODE_ENV !== 'production' && !require('electron').app.isPackaged;

function createUpdater({ onStatus } = {}) {
  let updater = null;
  let lastState = { status: 'idle', version: null, percent: 0, reason: '' };

  const push = (patch) => {
    lastState = { ...lastState, ...patch };
    try {
      onStatus?.(lastState);
    } catch {
      /* окно могло закрыться */
    }
  };

  function load() {
    if (updater) return updater;
    try {
      // require внутри функции: electron-updater тянет electron и падает в тестах
      const { autoUpdater } = require('electron-updater');
      autoUpdater.autoDownload = false;
      autoUpdater.autoInstallOnAppQuit = true;
      autoUpdater.logger = null;

      autoUpdater.on('checking-for-update', () => push({ status: 'checking', percent: 0 }));
      autoUpdater.on('update-available', (info) =>
        push({ status: 'available', version: info?.version || null }),
      );
      autoUpdater.on('update-not-available', () => push({ status: 'latest', percent: 0 }));
      autoUpdater.on('download-progress', (p) =>
        push({ status: 'downloading', percent: Math.round(p?.percent || 0) }),
      );
      autoUpdater.on('update-downloaded', (info) =>
        push({ status: 'downloaded', version: info?.version || lastState.version }),
      );
      autoUpdater.on('error', (err) => push({ status: 'error', reason: String(err?.message || err) }));
      updater = autoUpdater;
      return updater;
    } catch (err) {
      push({ status: 'error', reason: `не удалось загрузить updater: ${err.message}` });
      return null;
    }
  }

  function unsupported() {
    if (isDev) return 'в dev-режиме обновления выключены';
    if (process.env.PORTABLE_EXECUTABLE_DIR) return 'portable-версия не обновляется автоматически';
    return '';
  }

  async function check() {
    const reason = unsupported();
    if (reason) {
      push({ status: 'unavailable', reason });
      return lastState;
    }
    const autoUpdater = load();
    if (!autoUpdater) return lastState;
    push({ status: 'checking' });
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      push({ status: 'error', reason: String(err?.message || err) });
    }
    return lastState;
  }

  async function download() {
    const autoUpdater = load();
    if (!autoUpdater) return lastState;
    try {
      push({ status: 'downloading', percent: 0 });
      await autoUpdater.downloadUpdate();
    } catch (err) {
      push({ status: 'error', reason: String(err?.message || err) });
    }
    return lastState;
  }

  function install() {
    const autoUpdater = load();
    if (!autoUpdater) return false;
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return true;
  }

  return { check, download, install, state: () => lastState };
}

module.exports = { createUpdater };
