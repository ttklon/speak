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
const { writeWav } = require('./wav.cjs');
const { logger } = require('./logger.cjs');

const isDev = !app.isPackaged;
const DEV_URL = process.env.ZSPEAKLY_DEV_URL || 'http://localhost:5173';
const START_HIDDEN = process.argv.includes('--hidden');

let mainWindow = null;
let tray = null;
let store = null;
let clipboardTimer = null;
let updater = null;
let lastClipboardText = '';
let windowHiddenForInsert = false;
let lastInsertedText = '';
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
    // Витрина для «пришлите логи, если что-то не работает»
    { label: 'Диагностика', click: () => sendCommand('diagnostics') },
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
let windowWasHiddenForDictation = false;

function toggleDictation() {
  dictationActive = !dictationActive;
  mainWindow?.webContents.send('hotkey', { type: dictationActive ? 'down' : 'up' });
  // если окно скрыто в трее — на время диктовки оно должно быть на экране,
  // иначе человек не видит индикатор и не понимает, слушают его или нет
  if (dictationActive) {
    if (!mainWindow?.isVisible()) mainWindow?.show();
    mainWindow?.showInactive();
    windowWasHiddenForDictation = true;
  } else if (windowWasHiddenForDictation) {
    windowWasHiddenForDictation = false;
    setTimeout(() => {
      if (dictationActive) return;
      const toTray = store?.get('zs:settings')?.closeToTray !== false;
      if (toTray && !mainWindow?.isFocused?.()) mainWindow?.hide();
    }, 900);
  }
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
    globalShortcut.register(dictKey, () => toggleDictation());
  } catch (err) {
    console.warn('[hotkeys] dictation failed', err.message);
  }
  try {
    globalShortcut.register('Control+Shift+V', () => navigate('clipboard'));
    globalShortcut.register('Control+,', () => sendCommand('settings'));
    // сочетания из раздела «Буфер обмена» — раньше это были только подписи в UI
    const clipActions = [
      ['Shift+Control+A', 'screenshot'],
      ['Shift+Control+R', 'record'],
      ['Shift+Control+S', 'note'],
    ];
    for (const [accel, action] of clipActions) {
      globalShortcut.register(accel, () => {
        if (!mainWindow?.isVisible()) mainWindow?.show();
        mainWindow?.webContents.send('clipboard:action', action);
        if (action !== 'panel') mainWindow?.webContents.send('navigate', 'clipboard');
      });
    }
  } catch (err) {
    console.warn('[hotkeys] служебные сочетания не зарегистрированы', err.message);
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
    // свой вставленный диктант не пишем в историю буфера
    const ownText = Boolean(text) && text === lastInsertedText;
    if (ownText) lastClipboardText = text;
    else if (text && text !== lastClipboardText) {
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
  // Асинхронное чтение: preload.store.get() ходит через invoke, а не sendSync.
  // Без этого обработчика вызов молча зависал.
  ipcMain.handle('store:get', (_e, key) => store.get(key) ?? null);

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

  ipcMain.handle('stt:transcribe-pcm', async (_e, payload) => {
    const model = (store?.get('zs:settings') || {}).whisperModel || payload?.model || 'small';
    const status = whisper.status(model);
    if (!status.available) {
      logger.error('stt', 'Распознавание недоступно', { model, reason: status.reason });
      return { ok: false, text: '', reason: status.reason };
    }
    // ВАЖНО: Buffer.from(Int16Array) копирует ПОБАЙТОВО значения (младший байт),
    // а не сырые байты — звук превращался в мусор и whisper возвращал пустоту.
    // Uint8Array/Buffer — уже байты, их можно передавать как есть.
    const pcmView = payload?.pcm;
    const raw =
      pcmView instanceof Uint8Array
        ? Buffer.from(pcmView.buffer, pcmView.byteOffset, pcmView.byteLength)
        : Buffer.from(pcmView?.buffer || pcmView || [], pcmView?.byteOffset || 0, pcmView?.byteLength || 0);
    if (!raw.length) {
      logger.error('stt', 'Пустая запись пришла в распознавание', { bytes: 0 });
      return { ok: false, text: '', reason: 'пустая запись' };
    }
    logger.info('stt', 'Начало распознавания', {
      keep: true,
      model,
      bytes: raw.length,
      seconds: payload?.durationMs ? Math.round(payload.durationMs / 100) / 10 : undefined,
    });
    const dir = path.join(app.getPath('temp'), 'zspeakly');
    fs.mkdirSync(dir, { recursive: true });
    const wav = path.join(dir, `dictation-${Date.now()}.wav`);
    try {
      fs.writeFileSync(wav, writeWav(raw, payload?.sampleRate || 16000));
    } catch (err) {
      return { ok: false, text: '', reason: `не записал wav: ${err.message}` };
    }
    const prompt = (store?.get('zs:dictionary') || [])
      .map((d) => d.word)
      .slice(0, 40)
      .join(', ');
    try {
      const started = Date.now();
      const res = await whisper.transcribe(wav, { lang: payload?.lang || 'ru', model, prompt });
      // Пишем только факт и причину — распознанный текст остаётся на устройстве.
      logger[res?.ok ? 'info' : 'error']('stt', res?.ok ? 'Распознавание завершено' : 'Распознавание не удалось', {
        keep: true,
        ms: Date.now() - started,
        chars: String(res?.text || '').length,
        reason: res?.reason || '',
      });
      return res;
    } catch (err) {
      logger.error('stt', 'Исключение в распознавании', { stack: String(err?.stack || err) });
      return { ok: false, text: '', reason: String(err?.message || err) };
    } finally {
      fs.rmSync(wav, { force: true });
    }
  });

  ipcMain.handle('stt:status', (_e, model) => whisper.status(model));
  ipcMain.handle('stt:transcribe', async (_e, payload) => whisper.transcribe(payload?.wav, payload || {}));

  ipcMain.handle('text:insert', async (_e, text) => {
    const value = String(text || '');
    if (!value) return false;
    lastInsertedText = value;
    lastClipboardText = value; // чтобы мониторинг не добавил это в историю
    clipboard.writeText(value);
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
      // превью отдаём и вызывающему: заметка со скриншотом строится из него
      return {
        ok: true,
        width: image.getSize().width,
        height: image.getSize().height,
        image: item.image,
      };
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
    if (!payload) return false;
    // картинка приоритетнее текста: «Копировать» для снимка должен дать сам снимок
    const image = payload.image;
    if (typeof image === 'string' && image.startsWith('data:image/')) {
      try {
        const { nativeImage } = require('electron');
        const img = nativeImage.createFromDataURL(image);
        if (!img.isEmpty()) {
          clipboard.writeImage(img);
          return true;
        }
      } catch (err) {
        console.warn('[clipboard] image write failed', err.message);
      }
    }
    if (payload.text) {
      clipboard.writeText(String(payload.text));
      return true;
    }
    return false;
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

  // ── Диагностика: логи, статус, ручная отправка ─────────────────────
  ipcMain.handle('diag:log', (_e, payload) => {
    const level = ['debug', 'info', 'warn', 'error'].includes(payload?.level) ? payload.level : 'info';
    logger.log(level, payload?.scope, payload?.message, payload?.data);
    return true;
  });
  // Локальный сервер ИИ (Ollama) может стоять на любом порту и адресе:
  // политика страницы (CSP) такие запросы режет, поэтому оба метода идут
  // через главный процесс, а он пускает только локальную сеть.
  const isLocalTarget = (url) => {
    let target;
    try {
      target = new URL(String(url || ''));
    } catch {
      return { error: 'некорректный адрес' };
    }
    if (!['http:', 'https:'].includes(target.protocol)) return { error: 'разрешены только http и https' };
    const host = target.hostname;
    const local =
      ['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'].includes(host) ||
      host.endsWith('.local') ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host);
    if (!local) return { error: 'разрешены только локальные адреса' };
    return { target };
  };

  // Проверка локального сервера ИИ (Ollama) из «Сеть». Из окна обычный fetch
  // упирается в CSP страницы, поэтому запрос идёт из главного процесса.
  ipcMain.handle('http:get', async (_e, url) => {
    const { target, error } = isLocalTarget(url);
    if (error) return { ok: false, status: 0, reason: error };
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      const res = await fetch(target.toString(), { signal: controller.signal });
      clearTimeout(timer);
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = { raw: text.slice(0, 500) };
      }
      return { ok: res.ok, status: res.status, data };
    } catch (err) {
      return { ok: false, status: 0, reason: String(err?.message || err) };
    }
  });

  // POST для локальной модели: /api/generate и подобные
  ipcMain.handle('http:post', async (_e, { url, body, timeout } = {}) => {
    const { target, error } = isLocalTarget(url);
    if (error) return { ok: false, status: 0, reason: error };
    try {
      const controller = new AbortController();
      const limit = Math.min(Math.max(Number(timeout) || 8000, 1000), 120000);
      const timer = setTimeout(() => controller.abort(), limit);
      const res = await fetch(target.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body || {}),
        signal: controller.signal,
      });
      clearTimeout(timer);
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = { raw: text.slice(0, 2000) };
      }
      return { ok: res.ok, status: res.status, data };
    } catch (err) {
      const aborted = err?.name === 'AbortError';
      return {
        ok: false,
        status: 0,
        reason: aborted ? 'локальная модель не ответила вовремя' : String(err?.message || err),
      };
    }
  });

  ipcMain.handle('diag:status', () => logger.status());
  ipcMain.handle('diag:recent', (_e, limit) => logger.recent(limit));
  ipcMain.handle('diag:set-enabled', (_e, enabled) => {
    logger.setEnabled(Boolean(enabled));
    logger.info('diagnostics', enabled ? 'Отправка диагностики включена' : 'Отправка диагностики выключена', {
      keep: true,
    });
    return logger.status();
  });
  ipcMain.handle('diag:send-now', async () => logger.sendNow());
  ipcMain.handle('diag:ping', async () => logger.ping());
  ipcMain.handle('diag:clear', async () => logger.clear());

  ipcMain.handle('app:open-logs', async () => {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const err = await shell.openPath(dir);
    return { ok: !err, path: dir, reason: err || '' };
  });

  ipcMain.handle('app:open-data-folder', async () => {
    // Возвращаем объект, а не boolean: раньше UI показывал «не удалось»,
    // потому что `if (opened)` было false при любом успехе.
    const target = app.getPath('userData');
    try {
      fs.mkdirSync(target, { recursive: true });
      const err = await shell.openPath(target);
      return err ? { ok: false, path: target, reason: err } : { ok: true, path: target };
    } catch (err) {
      return { ok: false, path: target, reason: String(err?.message || err) };
    }
  });
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
  ipcMain.handle('models:import', async (_e, sourcePath) => models.importModel(sourcePath));
  ipcMain.handle('models:download-engine', async () => {
    const res = await models.downloadEngine((percent) => {
      mainWindow?.webContents.send('model:progress', { id: 'engine', percent });
    });
    mainWindow?.webContents.send('model:progress', { id: 'engine', percent: res.ok ? 100 : 0, done: true, ...res });
    return res;
  });

  ipcMain.handle('update:check', () => updater?.check() || { status: 'unavailable', reason: 'updater не готов' });
  ipcMain.handle('update:channel', (_e, channel) => {
    updater?.setChannel?.(channel);
    return true;
  });
  ipcMain.handle('update:download', () => updater?.download() || { status: 'error', reason: 'updater не готов' });
  ipcMain.handle('update:install', () => Boolean(updater?.install()));
  ipcMain.handle('app:notify', (_e, payload) => showNotification(payload));

  // Открыть ссылку в браузере. Белый список: приложение не должно уметь
  // открывать произвольные адреса (это дырка, если в UI попадёт чужой текст).
  ipcMain.handle('app:open-external', (_e, rawUrl) => {
    const url = String(rawUrl || '');
    const allowed = [
      'https://github.com/ttklon/speak',
      'https://github.com/ttklon/speak/releases',
    ];
    if (!allowed.some((base) => url === base || url.startsWith(`${base}/`))) {
      console.warn('[open-external] отклонено:', url.slice(0, 120));
      return false;
    }
    require('electron').shell.openExternal(url);
    return true;
  });
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
    lastInsertedText = String(text || '');
    lastClipboardText = lastInsertedText;
    clipboard.writeText(String(text || ''));
    setTimeout(() => {
      const ok = pasteToActiveWindow();
      setTimeout(() => resolve(ok), 180);
    }, 60);
  });
}

/**
 * Вставка в активное окно другого приложения.
 *
 * sendInputEvent бьёт только в наш рендерер, поэтому для чужих окон нужен
 * системный ввод. По умолчанию — WScript.Shell SendKeys (PowerShell, ~0.3 с).
 * Если в переменной окружения ZSPEAKLY_INPUT=app указан путь к helper.exe
 * (SendInput, вставка за ~30 мс), используется он.
 */
function pasteToActiveWindow() {
  if (process.platform !== 'win32') return false;

  // прячем окно, чтобы фокус вернулся туда, где человек печатал
  try {
    if (mainWindow?.isFocused?.() && mainWindow.isVisible?.()) mainWindow.hide();
    else mainWindow?.blur();
    windowHiddenForInsert = true;
  } catch {}

  const helper = process.env.ZSPEAKLY_INPUT;
  if (helper && fs.existsSync(helper)) {
    execFile(helper, ['ctrl+v'], { windowsHide: true }, (err) => {
      if (err) {
        console.warn('[paste] helper failed, fallback', err.message);
        setTimeout(() => sendKeys('^v'), 120);
        restoreWindowAfterInsert();
      }
    });
    return true;
  }

  setTimeout(() => {
    sendKeys('^v');
    restoreWindowAfterInsert();
  }, 60);
  return true;
}

/** Вернуть окно ZSpeakly, когда вставка уже случилась. */
function restoreWindowAfterInsert() {
  if (!windowHiddenForInsert) return;
  windowHiddenForInsert = false;
  setTimeout(() => {
    try {
      if (mainWindow && !mainWindow.isVisible?.()) mainWindow.show();
      mainWindow?.focus?.();
    } catch {}
  }, 220);
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
    channel: (store.get('zs:settings') || {}).updateChannel || 'stable',
  });
  // Тихая проверка обновлений: при старте (через 15 с, чтобы не тормозить
  // запуск) и дальше раз в сутки. Раньше проверка была однократной, хотя
  // в настройках обещано «раз в сутки» — то есть обновление могло не прийти.
  const initial = store.get('zs:settings') || {};
  if (initial.checkUpdates !== false) {
    const CHECK_EVERY = 24 * 60 * 60 * 1000;
    let lastCheck = 0;

    const quietCheck = () => {
      if ((store.get('zs:settings') || {}).checkUpdates === false) return;
      lastCheck = Date.now();
      updater?.check().catch(() => {});
    };

    setTimeout(quietCheck, 15000);
    const updateTimer = setInterval(() => {
      if (Date.now() - lastCheck >= CHECK_EVERY) quietCheck();
    }, 30 * 60 * 1000);
    updateTimer.unref?.();
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
