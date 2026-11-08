/**
 * ZSpeakly — Electron main process (Windows-first, полностью офлайн).
 *
 * Что делает main:
 *  • окно 1000×640 без системной рамки, тёмный фон, скругления даёт CSS;
 *  • трей + меню (Главная, Настройки, Буфер, Мобильное приложение);
 *  • глобальные хоткеи: Ctrl+Alt+Space (диктовка), Ctrl+Shift+V (буфер);
 *  • мониторинг буфера обмена через WM_CLIPBOARDUPDATE (Electron clipboard polling);
 *  • хранение профиля в JSON;
 *  • офлайн-распознавание через whisper.cpp (если бинарник и модель на месте);
 *  • вставка текста в активное окно (Ctrl+V через PowerShell SendKeys).
 */

const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const {
  app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, globalShortcut,
  clipboard, shell, dialog, screen, session,
} = require('electron');

const { JsonStore } = require('./store.cjs');
const whisper = require('./whisper.cjs');
const { createUpdater } = require('./updater.cjs');
const models = require('./models.cjs');

const isDev = !app.isPackaged;
const DEV_URL = process.env.ZSPEAKLY_DEV_URL || 'http://localhost:5173';
const START_HIDDEN = process.argv.includes('--hidden');

let mainWindow = null;
let tray = null;
let store = null;
let clipboardTimer = null;
let updater = null;
let lastClipboardText = '';
let lastClipboardImageHash = '';

// ── Одиночный экземпляр ────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

app.setAppUserModelId('app.zspeakly.desktop');
app.commandLine.appendSwitch('enable-features', 'MediaFoundationWidevineCdm');

// ── Окно ───────────────────────────────────────────────────────────────────
function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    width: Math.min(1020, width - 60),
    height: Math.min(680, height - 60),
    minWidth: 860,
    minHeight: 560,
    backgroundColor: '#1e1e1e',
    show: false,
    frame: false,
    titleBarStyle: 'hidden',
    roundedCorners: true,
    autoHideMenuBar: true,
    icon: iconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    if (!START_HIDDEN) mainWindow.show();
  });

  if (isDev && process.env.ZSPEAKLY_DEV_URL !== 'none') {
    mainWindow.loadURL(DEV_URL).catch(() => {
      // Vite не запущен — открываем production-сборку, если она есть
      const index = path.join(__dirname, '..', 'dist', 'index.html');
      if (fs.existsSync(index)) mainWindow.loadFile(index);
    });
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  mainWindow.on('close', (e) => {
    const closeToTray = store?.get('zs:settings')?.closeToTray !== false;
    if (closeToTray && !app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Внешние ссылки — в системный браузер
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(DEV_URL) && !url.startsWith('file://')) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
}

/** Нативное уведомление Windows: тост в трее. */
function showNotification({ title = 'ZSpeakly', body = '', silent = true } = {}) {
  try {
    const { Notification, nativeImage: ni } = require('electron');
    if (!Notification.isSupported()) return false;
    const n = new Notification({
      title: String(title),
      body: String(body),
      silent: Boolean(silent),
      icon: ni.createFromPath(iconPath() || ''),
    });
    n.on('click', () => {
      mainWindow?.show();
      mainWindow?.focus();
    });
    n.show();
    return true;
  } catch (err) {
    console.warn('[notify] failed', err.message);
    return false;
  }
}

function iconPath() {
  const candidates = [
    path.join(__dirname, '..', 'icons', 'icon.png'),
    path.join(__dirname, '..', 'build', 'icon.png'),
    path.join(process.resourcesPath || '', 'icons', 'icon.png'),
  ];
  return candidates.find((p) => p && fs.existsSync(p));
}

// ── Трей ───────────────────────────────────────────────────────────────────
function createTray() {
  const icon = nativeImage.createFromPath(iconPath() || '');
  const trayIcon = icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 18, height: 18 });

  tray = new Tray(trayIcon);
  tray.setToolTip('ZSpeakly — офлайн голосовой ввод');
  const menu = Menu.buildFromTemplate([
    {
      label: 'Открыть ZSpeakly',
      click: () => {
        mainWindow?.show();
        mainWindow?.focus();
      },
    },
    { type: 'separator' },
    { label: 'Диктовка (старт/стоп)', accelerator: 'Control+Alt+Space', click: () => toggleDictation() },
    { label: 'Буфер обмена', click: () => navigate('clipboard') },
    { label: 'Настройки', click: () => sendCommand('settings') },
    { type: 'separator' },
    { label: 'Мобильное приложение', click: () => sendCommand('mobile') },
    { label: 'О программе', click: () => sendCommand('about') },
    { type: 'separator' },
    {
      label: 'Выход',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
  tray.on('double-click', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
}

// ── Хоткеи ─────────────────────────────────────────────────────────────────
let dictationActive = false;

function toggleDictation() {
  dictationActive = !dictationActive;
  mainWindow?.webContents.send('hotkey', { type: dictationActive ? 'down' : 'up' });
}

function navigate(page) {
  mainWindow?.show();
  mainWindow?.webContents.send('navigate', page);
  mainWindow?.webContents.executeJavaScript(`location.hash = '#/${page}'`).catch(() => {});
}

function sendCommand(command) {
  mainWindow?.show();
  mainWindow?.webContents.send('command', command);
}

function accelerator(keys = []) {
  const map = { Ctrl: 'Control', Cmd: 'Command', Win: 'Super', Esc: 'Escape' };
  return keys.map((k) => map[k] || k).join('+');
}

function registerShortcuts(settings = {}) {
  globalShortcut.unregisterAll();
  const dictKey = settings.dictationKey || 'Control+Alt+Space';
  try {
    globalShortcut.register(dictKey, () => {
      dictationActive = !dictationActive;
      mainWindow?.webContents.send('hotkey', { type: dictationActive ? 'down' : 'up' });
    });
  } catch (err) {
    console.warn('[hotkeys] dictation failed', err.message);
  }
  try {
    globalShortcut.register('Control+Shift+V', () => navigate('clipboard'));
    globalShortcut.register('Control+,', () => sendCommand('settings'));
  } catch {
    /* ignore */
  }

  // AI-инструкции из раздела «Горячие клавиши» (пресеты + свои инструкции)
  const actions = Array.isArray(settings.textActions) ? settings.textActions : [];
  for (const action of actions) {
    if (!action?.enabled || !action.keys?.length) continue;
    try {
      globalShortcut.register(accelerator(action.keys), () => {
        mainWindow?.webContents.send('text-action', action.id);
      });
    } catch (err) {
      console.warn('[hotkeys] action failed', action.id, err.message);
    }
  }
}

// ── Определение активного окна (откуда скопировали) ────────────────────────
let foregroundCache = { title: '', app: '', at: 0 };

function foregroundWindow() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32' || Date.now() - foregroundCache.at < 1500) {
      resolve(foregroundCache);
      return;
    }
    // C# в одну строку: PowerShell не любит многострочные here-string в -Command
    const cs = [
      'using System;',
      'using System.Runtime.InteropServices;',
      'using System.Text;',
      'public class W {',
      '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
      '[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);',
      '[DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);',
      'public static string Title() { var b = new StringBuilder(512); GetWindowText(GetForegroundWindow(), b, 512); return b.ToString(); }',
      'public static int Pid() { int p; GetWindowThreadProcessId(GetForegroundWindow(), out p); return p; }',
      '}',
    ].join(' ');
    const ps = `Add-Type -TypeDefinition @'\n${cs}\n'@; Write-Output (W::Title()); Write-Output (W::Pid())`;

    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps],
      { windowsHide: true, timeout: 4000 },
      (err, stdout) => {
        if (err || !stdout) {
          resolve(foregroundCache);
          return;
        }
        const [title = '', pid = ''] = String(stdout).trim().split(/\r?\n/);
        const app = processName(Number(pid));
        foregroundCache = { title: title.slice(0, 120), app, at: Date.now() };
        resolve(foregroundCache);
      },
    );
  });
}

function processName(pid) {
  if (!pid) return '';
  try {
    const out = require('node:child_process').execFileSync(
      'tasklist.exe',
      ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
      { windowsHide: true, timeout: 1500, encoding: 'utf8' },
    );
    const name = String(out).split(',')[0].replace(/"/g, '').trim();
    return name.replace(/\.exe$/i, '');
  } catch {
    return '';
  }
}

// ── Буфер обмена ───────────────────────────────────────────────────────────
function startClipboardWatch() {
  stopClipboardWatch();
  clipboardTimer = setInterval(() => {
    const settings = store?.get('zs:settings') || {};
    if (settings.clipboardMonitor === false) return;

    const text = clipboard.readText();
    if (text && text !== lastClipboardText) {
      lastClipboardText = text;
      foregroundWindow().then((win) => {
        const source = win.app
          ? `${win.app}${win.title ? ` — ${win.title}` : ''}`
          : 'Системный буфер';
        mainWindow?.webContents.send('clipboard:item', {
          kind: 'text',
          text,
          source,
          app: win.app || '',
          windowTitle: win.title || '',
          createdAt: Date.now(),
        });
      });
    }

    const image = clipboard.readImage();
    if (image && !image.isEmpty()) {
      const size = image.getSize();
      const hash = `${size.width}x${size.height}:${image.toBitmap().length}`;
      if (hash !== lastClipboardImageHash) {
        lastClipboardImageHash = hash;
        mainWindow?.webContents.send('clipboard:item', {
          kind: 'image',
          text: '',
          image: image.resize({ width: 320 }).toDataURL(),
          source: 'Снимок экрана',
          createdAt: Date.now(),
        });
      }
    }
  }, 900);
}

function stopClipboardWatch() {
  if (clipboardTimer) clearInterval(clipboardTimer);
  clipboardTimer = null;
}

// ── IPC ────────────────────────────────────────────────────────────────────
function registerIpc() {
  ipcMain.on('store:get', (event, key) => {
    event.returnValue = store.get(key);
  });
  ipcMain.on('store:size', (event) => {
    event.returnValue = store.sizeSync();
  });
  ipcMain.handle('store:set', (_e, key, value) => store.set(key, value));
  ipcMain.handle('store:remove', (_e, key) => store.remove(key));

  ipcMain.handle('win:minimize', () => mainWindow?.minimize());
  ipcMain.handle('win:toggle-maximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.handle('win:close', () => mainWindow?.close());
  ipcMain.handle('win:badge', (_e, value) => {
    // На Windows бейдж не поддерживается — обновляем подсказку в трее.
    try {
      tray?.setToolTip(Number(value) ? `ZSpeakly — ${value} новых` : 'ZSpeakly — офлайн голосовой ввод');
    } catch {
      /* ignore */
    }
  });

  ipcMain.handle('stt:status', (_e, model) => whisper.status(model));
  ipcMain.handle('stt:transcribe', async (_e, payload) => whisper.transcribe(payload?.wav, payload || {}));

  ipcMain.handle('text:insert', async (_e, text) => {
    clipboard.writeText(String(text || ''));
    return pasteToActiveWindow();
  });
  ipcMain.handle('text:paste', () => pasteToActiveWindow());
  ipcMain.handle('text:read-selection', () => readSelection());
  ipcMain.handle('text:replace-selection', (_e, text) => replaceSelection(text));

  ipcMain.handle('clipboard:screenshot', async () => {
    try {
      const { desktopCapturer } = require('electron');
      const display = screen.getPrimaryDisplay();
      const { width, height } = display.size;
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width, height },
      });
      const source = sources[0];
      if (!source) return { ok: false, reason: 'экран недоступен' };
      const image = source.thumbnail;
      clipboard.writeImage(image);
      const item = {
        kind: 'image',
        text: '',
        image: image.resize({ width: 480 }).toDataURL(),
        source: `Снимок экрана — ${source.name || 'дисплей'}`,
        createdAt: Date.now(),
      };
      mainWindow?.webContents.send('clipboard:item', item);
      return { ok: true, width: image.getSize().width, height: image.getSize().height };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  });

  ipcMain.handle('clipboard:read', () => ({
    text: clipboard.readText(),
    hasImage: !clipboard.readImage().isEmpty(),
    formats: clipboard.availableFormats(),
  }));
  ipcMain.handle('clipboard:write', (_e, payload) => {
    if (payload?.text) clipboard.writeText(payload.text);
    return true;
  });

  ipcMain.handle('hotkey:set', (_e, payload) => {
    // payload: строка-акселератор (диктовка) или { dictationKey, textActions }
    if (!payload) return false;
    if (typeof payload === 'string') {
      const current = store.get('zs:settings') || {};
      registerShortcuts({ ...current, dictationKey: payload });
      return true;
    }
    registerShortcuts(payload);
    return true;
  });

  ipcMain.handle('app:open-data-folder', () => shell.openPath(app.getPath('userData')));
  ipcMain.handle('app:auto-launch', (_e, enabled) => {
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled), args: ['--hidden'] });
    return app.getLoginItemSettings().openAtLogin;
  });
  ipcMain.handle('app:save-file', async (_e, payload) => {
    // payload: { name, base64 } — сохраняем в «Видео» / «Загрузки»
    try {
      const dir = app.getPath('videos');
      fs.mkdirSync(dir, { recursive: true });
      const target = path.join(dir, String(payload?.name || 'zspeakly.webm').replace(/[\\/:*?"<>|]/g, '_'));
      fs.writeFileSync(target, Buffer.from(String(payload?.base64 || ''), 'base64'));
      return { ok: true, path: target };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  });

  ipcMain.handle('models:status', () => models.modelStatus());
  ipcMain.handle('models:download', async (_e, id) => {
    const res = await models.downloadModel(id, (percent, received, total) => {
      mainWindow?.webContents.send('model:progress', { id, percent, received, total });
    });
    mainWindow?.webContents.send('model:progress', { id, percent: res.ok ? 100 : 0, done: true, ...res });
    return res;
  });
  ipcMain.handle('models:download-engine', async () => {
    const res = await models.downloadEngine((percent) => {
      mainWindow?.webContents.send('model:progress', { id: 'engine', percent });
    });
    mainWindow?.webContents.send('model:progress', { id: 'engine', percent: res.ok ? 100 : 0, done: true, ...res });
    return res;
  });

  ipcMain.handle('update:check', () => updater?.check() || { status: 'unavailable', reason: 'updater не готов' });
  ipcMain.handle('update:download', () => updater?.download() || { status: 'error', reason: 'updater не готов' });
  ipcMain.handle('update:install', () => Boolean(updater?.install()));
  ipcMain.handle('app:notify', (_e, payload) => showNotification(payload));
  ipcMain.handle('app:noop', () => null);

  // Выбор источника для getDisplayMedia (запись экрана / системный звук)
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    const { desktopCapturer } = require('electron');
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    if (!sources.length) {
      callback({});
      return;
    }
    const wantsSystemAudio = process.platform === 'win32';
    callback(
      wantsSystemAudio
        ? { video: sources[0], audio: 'loopback' }
        : { video: sources[0] },
    );
  });
}

// Отправка клавиш в активное окно через PowerShell SendKeys (Windows-only)
function sendKeys(keys) {
  if (process.platform !== 'win32') return false;
  const script = `Add-Type -AssemblyName System.Windows.Forms; Start-Sleep -Milliseconds 90; [System.Windows.Forms.SendKeys]::SendWait('${keys}')`;
  execFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
    { windowsHide: true },
    (err) => {
      if (err) console.warn('[sendKeys] failed', err.message);
    },
  );
  return true;
}

/**
 * Забрать выделенный текст из активного окна: уходим в трей, жмём Ctrl+C,
 * читаем буфер. Возвращает '' если в буфере не текст.
 */
function readSelection() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve(clipboard.readText() || '');
      return;
    }
    const previous = clipboard.readText();
    mainWindow?.blur();
    setTimeout(() => {
      sendKeys('^c');
      setTimeout(() => {
        const text = clipboard.readText();
        mainWindow?.focus();
        resolve(text && text !== previous ? text : text || '');
      }, 220);
    }, 120);
  });
}

/** Заменить выделение результатом: кладём в буфер и жмём Ctrl+V. */
function replaceSelection(text) {
  return new Promise((resolve) => {
    clipboard.writeText(String(text || ''));
    setTimeout(() => {
      const ok = pasteToActiveWindow();
      setTimeout(() => resolve(ok), 180);
    }, 60);
  });
}

/** Вставка текста в активное окно: Ctrl+V через PowerShell SendKeys */
function pasteToActiveWindow() {
  if (process.platform !== 'win32') return false;
  mainWindow?.blur();
  const script =
    "Add-Type -AssemblyName System.Windows.Forms; Start-Sleep -Milliseconds 90; [System.Windows.Forms.SendKeys]::SendWait('^v')";
  execFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
    { windowsHide: true },
    (err) => {
      if (err) console.warn('[paste] failed', err.message);
      mainWindow?.focus();
    },
  );
  return true;
}

// ── Жизненный цикл ─────────────────────────────────────────────────────────
app.on('before-quit', () => {
  app.isQuitting = true;
  store?.flush?.();
});

app.whenReady().then(() => {
  store = new JsonStore();
  registerIpc();
  createWindow();
  createTray();

  updater = createUpdater({
    onStatus: (state) => mainWindow?.webContents.send('update:status', state),
  });
  // тихая проверка раз в сутки при наличии сети (настройка checkUpdates)
  const initial = store.get('zs:settings') || {};
  if (initial.checkUpdates !== false) {
    setTimeout(() => {
      updater?.check().catch(() => {});
    }, 15000);
  }

  const settings = store.get('zs:settings') || {};
  registerShortcuts({
    dictationKey: settings.dictationKey || 'Control+Alt+Space',
    textActions: settings.textActions || [],
  });
  if (settings.clipboardMonitor !== false) startClipboardWatch();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else mainWindow?.show();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // Остаёмся в трее: приложение продолжает слушать хоткей
    if (app.isQuitting) app.quit();
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopClipboardWatch();
});

process.on('uncaughtException', (err) => {
  console.error('[main] uncaught', err);
  dialog.showErrorBox?.('ZSpeakly', String(err?.message || err));
});
