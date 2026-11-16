/**
 * ZSpeakly — Electron main process (Windows-first, полностью офлайн).
 *
 * Что делает main:
 *  • окно 1000×640 без системной рамки, тёмный фон, скругления даёт CSS;
 *  • трей + меню (Главная, Настройки, Буфер, Диагностика, О программе);
 *  • глобальные хоткеи: Ctrl+Alt+Space (диктовка), Ctrl+Shift+V (буфер);
 *  • мониторинг буфера обмена через WM_CLIPBOARDUPDATE (Electron clipboard polling);
 *  • хранение профиля в JSON;
 *  • офлайн-распознавание через whisper.cpp (если бинарник и модель на месте);
 *  • вставка текста в активное окно (Ctrl+V через PowerShell SendKeys).
 */

const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { sendUnicodeText } = require('./sendInput.cjs');
// Резидентный помощник ввода: PowerShell поднимается один раз, а не на каждую
// вставку — иначе диктовка ждёт компиляцию C# дважды подряд.
const { host: inputHost } = require('./inputHost.cjs');
const { randomUUID } = require('node:crypto');
const { cleanupTemp } = require('./tempCleanup.cjs');
const {
  app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, globalShortcut,
  clipboard, shell, dialog, screen, session, safeStorage,
} = require('electron');

const { JsonStore } = require('./store.cjs');
const whisper = require('./whisper.cjs');
const { createUpdater } = require('./updater.cjs');
const models = require('./models.cjs');
// Подбор модели под железо: одна и та же модель не может быть быстрой и на
// старом ноутбуке, и на новом ПК.
const hardware = require('./hardware.cjs');
const speedTune = require('./speedTune.cjs');
const { writeWav } = require('./wav.cjs');
const { logger } = require('./logger.cjs');

const isDev = !app.isPackaged;
const DEV_URL = process.env.ZSPEAKLY_DEV_URL || 'http://localhost:5173';
const START_HIDDEN = process.argv.includes('--hidden');

let mainWindow = null;
// автоподготовка распознавания (заполняется при регистрации IPC)
let prepareRecognition = null;
// Подбор модели под железо живёт там же, где IPC, а вызывается при старте окна.
let applyHardwareModel = null;
let tray = null;
let store = null;
// Отдельное «плавающее» окно индикатора диктовки: видно поверх любых
// приложений и не забирает фокус, поэтому вставка идёт туда, где человек печатал.
let hudWindow = null;
// Размеры плашки: в обычном режиме — одна строка текста, при ошибке — две.
const HUD_WIDTH = 360;
const HUD_HEIGHT = 92;
const HUD_HEIGHT_ERROR = 112;
// идёт ли сейчас диктовка (для пункта «Остановить диктовку» в трее)
let hudActive = false;
let clipboardTimer = null;
let updater = null;
let lastClipboardText = '';
let windowHiddenForInsert = false;
let lastInsertedText = '';
let lastInsertedAt = 0;
// Свою же вставку считаем «своей» только пару секунд: иначе человек,
// скопировавший ту же фразу позже, не увидел бы её в истории буфера.
const OWN_TEXT_TTL = 2000;
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
// Сколько занял путь «процесс запущен → окно на экране» и «прогрев модели»:
// это первые два числа, которые объясняют «почему приложение открывается долго».
const BOOT_AT = Date.now();
let startupMs = 0;
let warmMs = 0;

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
    startupMs = Date.now() - BOOT_AT;
    logger.info('app', 'Окно на экране', { keep: true, ms: startupMs });
    // Первая установка: движок уже в комплекте, модель докачиваем сами.
    // Стартуем почти сразу после появления окна: пока человек читает первый
    // экран, модель уже качается. Не блокирует запуск и не мешает, если сети нет.
    setTimeout(() => prepareRecognition?.(), 800);
    // Модель в памяти: поднимаем whisper-server заранее, чтобы первая
    // диктовка не ждала загрузку весов (как в быстрых диктовочных приложениях).
    setTimeout(() => applyHardwareModel?.(), 600);
    setTimeout(() => {
      const cfg = store?.get('zs:settings') || {};
      // 1.6.0: «держать модель в памяти» больше не тумблер — приложение делает
      // это всегда, если профиль явно не против.
      if (cfg.keepModelLoaded === false) return;
      warmRecognition(cfg.whisperModel || 'base');
    }, 500);
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
// Сочетание диктовки можно поменять в приложении — подпись в меню трея
// должна это отражать, иначе там годами висит «Ctrl+Alt+Space».
let trayDictKey = 'Control+Alt+Space';

// Что нибудь в трее объясняет происходящее: открытый «горячим микрофоном»
// поток незаметен иначе, а незнакомый значок в системном индикаторе пугает.
let micWarmOpen = false;
let unreadCount = 0;

function trayTooltip() {
  const base = unreadCount > 0 ? `ZSpeakly — ${unreadCount} новых` : 'ZSpeakly — офлайн голосовой ввод';
  return micWarmOpen ? `${base} · микрофон открыт заранее` : base;
}

function updateTrayTooltip() {
  try {
    tray?.setToolTip(trayTooltip());
  } catch {
    /* ignore */
  }
}

/** Склеивает куски подсказки через запятую, убирая повторы (без учёта регистра). */
function mergePromptParts(...parts) {
  const seen = new Set();
  const words = [];
  for (const part of parts) {
    for (const raw of String(part || '').split(',')) {
      const word = raw.trim();
      if (!word) continue;
      const key = word.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      words.push(word);
    }
  }
  return words.join(', ');
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    {
      label: 'Открыть ZSpeakly',
      click: () => {
        mainWindow?.show();
        mainWindow?.focus();
      },
    },
    { type: 'separator' },
    { label: `Диктовка (старт/стоп) — ${prettyAccel(trayDictKey)}`, click: () => toggleDictation() },
    // Пока идёт запись, из трея можно остановить её, не ища индикатор
    ...(recordingState === 'listening' || hudActive
      ? [
          {
            label: 'Остановить диктовку',
            click: () => mainWindow?.webContents.send('dictation:stop', { from: 'tray' }),
          },
        ]
      : []),
    // Если «горячий микрофон» включён, микрофон открыт прямо сейчас — об этом
    // лучше сказать в меню, чем оставлять пользователя догадываться.
    ...(micWarmOpen
      ? [{ label: 'Микрофон открыт заранее (горячий микрофон)', enabled: false }]
      : []),
    { label: 'Буфер обмена', click: () => navigate('clipboard') },
    { label: 'Настройки', click: () => sendCommand('settings') },
    { type: 'separator' },
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
}

function refreshTrayMenu() {
  try {
    if (tray && !tray.isDestroyed?.()) tray.setContextMenu(buildTrayMenu());
  } catch (err) {
    console.warn('[tray] меню не обновилось', err.message);
  }
}

/**
 * Плавающий индикатор записи.
 *
 * Раньше HUD жил внутри главного окна: стоило свернуть приложение — и человек
 * не видел ни «Слушаю…», ни кнопки «стоп». Теперь это отдельное окно без рамки,
 * всегда сверху, без фокуса (иначе Ctrl+V уходил бы в него, а не в чужое окно).
 */
function createHudWindow() {
  if (hudWindow && !hudWindow.isDestroyed?.()) return hudWindow;
  const { workArea } = screen.getPrimaryDisplay();
  const width = HUD_WIDTH;
  const height = HUD_HEIGHT;
  hudWindow = new BrowserWindow({
    width,
    height,
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + workArea.height - height - 28),
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'hud-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  try {
    hudWindow.setAlwaysOnTop(true, 'screen-saver');
    hudWindow.setVisibleOnAllWorkspaces?.(true, { visibleOnFullScreen: true });
    hudWindow.setIgnoreMouseEvents?.(false);
  } catch {
    /* не на всех платформах есть эти методы */
  }
  hudWindow.loadFile(path.join(__dirname, 'hud.html'));
  hudWindow.on('closed', () => {
    hudWindow = null;
  });
  return hudWindow;
}

function setHudActive(active) {
  if (hudActive === active) return;
  hudActive = active;
  refreshTrayMenu();
}

/**
 * Ставим плашку на тот монитор, где сейчас курсор: на двух экранах прежняя
 * привязка к основному оставляла индикатор на соседнем дисплее, и человек его
 * просто не видел.
 */
function placeHudWindow(win) {
  try {
    const point = screen.getCursorScreenPoint?.();
    const display = point ? screen.getDisplayNearestPoint(point) : screen.getPrimaryDisplay();
    const area = display?.workArea || screen.getPrimaryDisplay().workArea;
    const { width, height } = win.getBounds?.() || { width: HUD_WIDTH, height: HUD_HEIGHT };
    win.setBounds?.({
      x: Math.round(area.x + (area.width - width) / 2),
      y: Math.round(area.y + area.height - height - 28),
      width,
      height,
    });
  } catch {
    /* размеры экрана недоступны — остаёмся там, где открылись */
  }
}

/** Высота плашки: при ошибке вторая строка подсказки должна быть видна. */
function resizeHudWindow(height) {
  const win = hudWindow;
  if (!win || win.isDestroyed?.()) return;
  try {
    const b = win.getBounds?.();
    if (!b || b.height === height) return;
    win.setBounds({ x: b.x, y: b.y + (b.height - height), width: b.width, height });
  } catch {
    /* окно могло закрыться между проверкой и вызовом */
  }
}

function showHudWindow() {
  const win = createHudWindow();
  placeHudWindow(win);
  try {
    if (!win.isVisible?.()) win.showInactive();
  } catch {
    /* ignore */
  }
  setHudActive(true);
  return true;
}

function hideHudWindow() {
  try {
    hudWindow?.hide();
  } catch {
    /* ignore */
  }
  setHudActive(false);
  return true;
}

function sendHudState(state) {
  if (!hudWindow || hudWindow.isDestroyed?.()) return;
  try {
    hudWindow.webContents.send('hud:state', state);
  } catch {
    /* окно могло закрыться между кадрами */
  }
}

// Рендерер сообщает, что реально происходит с записью: по этому состоянию
// трей показывает «Остановить диктовку», а глобальное сочетание понимает,
// слушаем мы сейчас или нет.
let recordingState = 'idle';

function registerHudIpc() {
  ipcMain.on('dictation:state', (_e, next) => {
    const state = ['listening', 'processing', 'done', 'idle'].includes(next) ? next : 'idle';
    if (state === recordingState) return;
    recordingState = state;
    dictationActive = state === 'listening';
    // Человек начал говорить — самое время поднять помощника ввода: пока идёт
    // запись, PowerShell успевает стартовать, и вставка не ждёт старта.
    if (state === 'listening') {
      warmInputHost();
      // И модель: пока человек говорит, веса успевают загрузиться, и итоговый
      // проход идёт уже в прогретый сервер. Раньше прогрев начинался только
      // после неудачной диктовки — то есть слишком поздно.
      try {
        const cfg = store?.get('zs:settings') || {};
        const server = whisper.serverStatus?.() || {};
        // Только если сервера нет вовсе: если он уже греется, второй прогрев
        // отнял бы ядра у распознавания этой же фразы.
        if (cfg.keepModelLoaded !== false && !server.ready && !server.running && !whisper.isBusy?.()) {
          warmRecognition(cfg.whisperModel || 'base');
        }
      } catch {
        /* прогрев — не критичный путь */
      }
    }
    refreshTrayMenu();
  });
  ipcMain.on('mic:warm', (_e, open) => {
    const next = !!open;
    if (next === micWarmOpen) return;
    micWarmOpen = next;
    updateTrayTooltip();
    refreshTrayMenu();
  });
  ipcMain.handle('hud:show', () => {
    // Началась запись — начинаем прогрев. Пока человек говорит, whisper-server
    // успевает загрузить модель, и итоговый проход считается уже в памяти, а не
    // холодным whisper-cli. Именно это отличает «фраза на двадцать секунд
    // распознана за три» от «за двадцать»: прогрев по хоткею, а не по факту.
    try {
      const cfg = store.get('zs:settings') || {};
      if (cfg.keepModelLoaded !== false) warmRecognition(cfg.whisperModel || 'base');
    } catch {
      /* прогрев — не повод ломать показ плашки */
    }
    return showHudWindow();
  });
  ipcMain.handle('hud:hide', () => hideHudWindow());
  ipcMain.handle('hud:update', (_e, state) => {
    // Ошибку показываем двумя строками — для этого плашка становится выше.
    resizeHudWindow(state?.error ? HUD_HEIGHT_ERROR : HUD_HEIGHT);
    sendHudState(state || {});
    return true;
  });
  // Кнопки на плавающем индикаторе: стоп просим у окна диктовки,
  // закрытие прячет только индикатор — запись продолжается.
  ipcMain.handle('hud:pause', () => {
    mainWindow?.webContents.send('dictation:pause', { paused: true, from: 'hud' });
    return true;
  });

  ipcMain.handle('hud:resume', () => {
    mainWindow?.webContents.send('dictation:pause', { paused: false, from: 'hud' });
    return true;
  });

  ipcMain.handle('hud:cancel', () => {
    mainWindow?.webContents.send('dictation:cancel', { from: 'hud' });
    return true;
  });

  ipcMain.handle('hud:stop', () => {
    mainWindow?.webContents.send('dictation:stop', { from: 'hud' });
    return true;
  });
  ipcMain.handle('hud:close', () => {
    hideHudWindow();
    // Если окно приложения на экране — оно нарисует индикатор внутри себя,
    // и запись можно остановить оттуда. Если окно свёрнуто в трей, показать
    // индикатор негде: закрытие плашки завершает запись, иначе она осталась бы
    // без единой кнопки.
    if (mainWindow?.isVisible?.()) mainWindow.webContents.send('hud:closed');
    else mainWindow?.webContents.send('dictation:stop', { from: 'hud' });
    return true;
  });
  ipcMain.handle('hud:status', () => ({
    open: Boolean(hudWindow && !hudWindow.isDestroyed?.() && hudWindow.isVisible?.()),
  }));
}

function createTray() {
  const icon = nativeImage.createFromPath(iconPath() || '');
  const trayIcon = icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 18, height: 18 });

  tray = new Tray(trayIcon);
  updateTrayTooltip();
  tray.setContextMenu(buildTrayMenu());
  tray.on('double-click', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
}

// ── Хоткеи ─────────────────────────────────────────────────────────────────
let dictationActive = false;

function toggleDictation() {
  // Обычно переключаем своё состояние, но если запись остановили кнопкой на
  // плашке, рендерер уже сообщил «idle» — тогда следующее нажатие начинает
  // заново, а не пытается «остановить» пустоту.
  dictationActive = !dictationActive;
  mainWindow?.webContents.send('hotkey', { type: dictationActive ? 'down' : 'up' });
  // Окно ZSpeakly не показываем: индикатор записи — отдельная плашка поверх
  // всех приложений. Раньше окно выпрыгивало при каждом нажатии хоткея и
  // закрывало собой то приложение, куда человек диктует.
  if (dictationActive) showWindowIfIndicatorOff();
}

/**
 * Если плавающий индикатор выключен в настройках, единственное место, где
 * видно запись, — окно приложения. Тогда его надо показать (без фокуса).
 */
function showWindowIfIndicatorOff() {
  const settings = store?.get('zs:settings') || {};
  if (settings.showFloatingIndicator !== false) return;
  if (!mainWindow?.isVisible?.()) mainWindow?.showInactive?.();
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

// Сочетания, уже занятые внутри приложения: globalShortcut.register на занятое
// сочетание возвращает false и ничего не сообщает. Из-за этого «Режим агента»
// и часть инструкций молча не работали — их сочетания совпадали с диктовкой.
const usedAccels = new Set();

/** Зарегистрировать сочетание или честно сказать, что оно занято. */
function registerAccel(accel, handler, info = {}) {
  if (!accel) return false;
  if (usedAccels.has(accel)) {
    mainWindow?.webContents.send('hotkey:conflict', {
      id: info.id || '',
      keys: info.keys || [],
      reason: 'сочетание уже занято другой функцией ZSpeakly',
    });
    return false;
  }
  try {
    const ok = globalShortcut.register(accel, handler) !== false;
    if (ok) {
      usedAccels.add(accel);
      return true;
    }
    mainWindow?.webContents.send('hotkey:conflict', {
      id: info.id || '',
      keys: info.keys || [],
      reason: 'сочетание занято другой программой',
    });
    return false;
  } catch (err) {
    console.warn('[hotkeys] не удалось зарегистрировать', accel, err.message);
    mainWindow?.webContents.send('hotkey:conflict', {
      id: info.id || '',
      keys: info.keys || [],
      reason: err.message,
    });
    return false;
  }
}

// Одиночное нажатие диктовки и двойное («агент») на одном сочетании:
// глобальные сочетания не дают события отпускания, поэтому различаем по паузе.
let lastDictPress = 0;
let dictPressTimer = null;

function onDictationPress(agentOnDouble) {
  if (!agentOnDouble) {
    toggleDictation();
    return;
  }
  const now = Date.now();
  if (now - lastDictPress < 420) {
    // Второе нажатие: только что начатую диктовку отменяем БЕЗ распознавания
    // (иначе короткий обрывок превращался в «слишком короткую запись»)
    // и открываем «агента».
    clearTimeout(dictPressTimer);
    lastDictPress = 0;
    if (dictationActive) {
      dictationActive = false;
      mainWindow?.webContents.send('hotkey', { type: 'cancel' });
    }
    showWindowForDictation();
    mainWindow?.webContents.send('hotkey', { type: 'agent' });
    return;
  }
  lastDictPress = now;
  clearTimeout(dictPressTimer);
  // Диктовка стартует сразу: раньше она ждала 430 мс, чтобы отличить двойное
  // нажатие, и человек слышал «щелчок» с задержкой.
  toggleDictation();
}

/**
 * Голосовые сочетания из раздела «Горячие клавиши». Раньше список был только
 * подписями в интерфейсе: тумблеры включались, клавиши не работали.
 * Теперь каждое включённое сочетание регистрируется по-настоящему:
 *   • диктовка — удержание (down/up) или переключатель (toggle);
 *   • «свободные руки» — один раз нажал, говоришь, ещё раз — стоп;
 *   • «агент» — двойное нажатие открывает короткий вопрос к локальной модели;
 *   • «с учётом экрана» — удержание, при старте снимается контекст экрана.
 */
function registerVoiceHotkeys(settings = {}) {
  const list = Array.isArray(settings.voiceHotkeys) ? settings.voiceHotkeys : [];
  const dictKey = settings.dictationKey || 'Control+Alt+Space';
  if (dictKey !== trayDictKey) {
    trayDictKey = dictKey;
    refreshTrayMenu();
  }
  for (const hk of list) {
    if (!hk?.enabled || !hk.keys?.length) continue;
    const accel = hk.id === 'dictation' ? dictKey : accelerator(hk.keys);
    if (!accel) continue;
    // «Диктовка» уже висит на этом сочетании, а «Агент» с тем же сочетанием
    // ловится двойным нажатием в её обработчике — второй раз не регистрируем.
    if (accel === dictKey && (hk.id === 'dictation' || hk.id === 'agent')) continue;
    const info = { id: hk.id, keys: hk.keys };
    if (hk.id === 'dictation' || hk.id === 'screen-aware') {
      // глобальные сочетания не присылают отпускание клавиши, поэтому это
      // переключатель: нажали — слушаем, нажали ещё раз — распознаём
      registerAccel(
        accel,
        () => {
          showWindowForDictation();
          mainWindow?.webContents.send('hotkey', {
            type: 'toggle',
            mode: 'toggle',
            screenAware: hk.id === 'screen-aware',
          });
        },
        info,
      );
    } else if (hk.id === 'hands-free') {
      registerAccel(
        accel,
        () => {
          showWindowForDictation();
          mainWindow?.webContents.send('hotkey', { type: 'toggle', mode: 'toggle' });
        },
        info,
      );
    } else if (hk.id === 'agent') {
      // двойное нажатие = «агент», одиночное = обычная диктовка
      let lastAt = 0;
      let timer = null;
      registerAccel(
        accel,
        () => {
          const now = Date.now();
          if (now - lastAt < 420) {
            clearTimeout(timer);
            lastAt = 0;
            showWindowForDictation();
            mainWindow?.webContents.send('hotkey', { type: 'agent' });
            return;
          }
          lastAt = now;
          clearTimeout(timer);
          timer = setTimeout(() => {
            if (lastAt === now) {
              showWindowForDictation();
              mainWindow?.webContents.send('hotkey', { type: 'toggle', mode: 'toggle' });
            }
          }, 430);
        },
        info,
      );
    }
  }
}

/**
 * Диктовка с клавиши или из трея.
 *
 * Окно больше не показываем: состояние видно на плавающем индикаторе, а
 * всплывающее окно перекрывало чужое приложение. Если человек хочет видеть
 * окно — он его откроет сам.
 */
function showWindowForDictation() {
  showWindowIfIndicatorOff();
}

/** Control+Alt+Space → Ctrl + Alt + Space (как в интерфейсе). */
function prettyAccel(accel) {
  return String(accel || '')
    .split('+')
    .map((part) => (part === 'Control' ? 'Ctrl' : part))
    .join(' + ');
}

function registerShortcuts(settings = {}) {
  globalShortcut.unregisterAll();
  usedAccels.clear();
  // Сменили сочетания — история нажатий «для двойного клика» больше не нужна.
  // Иначе одно нажатие сразу после переназначения считалось вторым и вместо
  // диктовки открывало «агента».
  lastDictPress = 0;
  clearTimeout(dictPressTimer);
  const dictKey = settings.dictationKey || 'Control+Alt+Space';
  if (dictKey !== trayDictKey) {
    trayDictKey = dictKey;
    refreshTrayMenu();
  }
  const voice = Array.isArray(settings.voiceHotkeys) ? settings.voiceHotkeys : [];
  // «Агент» по умолчанию висит на том же сочетании, что диктовка: различаем
  // одиночное и двойное нажатие, иначе включённый агент не работал вовсе.
  const agentOnSameKey = voice.some(
    (hk) => hk?.id === 'agent' && hk.enabled && hk.keys?.length && accelerator(hk.keys) === dictKey,
  );
  registerAccel(dictKey, () => onDictationPress(agentOnSameKey), { id: 'dictation' });
  registerVoiceHotkeys({ ...settings, dictationKey: dictKey });
  registerAccel('Control+Shift+V', () => navigate('clipboard'), { id: 'clipboard-panel' });
  registerAccel('Control+,', () => sendCommand('settings'), { id: 'settings' });
  // сочетания из раздела «Буфер обмена» — раньше это были только подписи в UI
  const clipActions = [
    ['Shift+Control+A', 'screenshot'],
    ['Shift+Control+R', 'record'],
    ['Shift+Control+S', 'note'],
  ];
  for (const [accel, action] of clipActions) {
    registerAccel(
      accel,
      () => {
        if (!mainWindow?.isVisible()) mainWindow?.show();
        mainWindow?.webContents.send('clipboard:action', action);
        if (action !== 'panel') mainWindow?.webContents.send('navigate', 'clipboard');
      },
      { id: `clipboard-${action}` },
    );
  }

  // AI-инструкции из раздела «Горячие клавиши» (пресеты + свои инструкции)
  const actions = Array.isArray(settings.textActions) ? settings.textActions : [];
  for (const action of actions) {
    if (!action?.enabled || !action.keys?.length) continue;
    registerAccel(
      accelerator(action.keys),
      () => {
        mainWindow?.webContents.send('text-action', action.id);
      },
      { id: action.id, keys: action.keys },
    );
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

// ── Пароли в буфере обмена ─────────────────────────────────────────────────
/**
 * Похоже ли скопированное на пароль или токен.
 *
 * Задача не «угадать всё», а не хранить открытым текстом то, что человек
 * копирует из менеджера паролей: одна строка, без пробелов, 8–80 символов,
 * минимум три класса символов (строчные, заглавные, цифры, знаки).
 */
function looksLikeSecret(text) {
  const value = String(text || '');
  if (value.length < 8 || value.length > 80) return false;
  if (/\s/.test(value)) return false;
  if (/^https?:\/\//i.test(value)) return false;
  const classes =
    Number(/[a-zа-яё]/.test(value)) +
    Number(/[A-ZА-ЯЁ]/.test(value)) +
    Number(/[0-9]/.test(value)) +
    Number(/[^\w\s]/.test(value));
  return classes >= 3;
}

/** Системное хранилище (DPAPI на Windows) доступно? */
function canEncrypt() {
  try {
    return Boolean(safeStorage?.isEncryptionAvailable?.());
  } catch {
    return false;
  }
}

/** Зашифровать строку → base64 или null, если шифрование недоступно. */
function encryptText(text) {
  try {
    if (!canEncrypt()) return null;
    return safeStorage.encryptString(String(text)).toString('base64');
  } catch {
    return null;
  }
}

/** Расшифровать base64 → строка или null. */
function decryptText(cipher) {
  try {
    if (!cipher || !canEncrypt()) return null;
    return safeStorage.decryptString(Buffer.from(String(cipher), 'base64'));
  } catch {
    return null;
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
    const ownText =
      Boolean(text) && text === lastInsertedText && Date.now() - lastInsertedAt < OWN_TEXT_TTL;
    if (ownText) lastClipboardText = text;
    else if (text && text !== lastClipboardText) {
      lastClipboardText = text;
      // Пароль из менеджера паролей не храним открытым текстом: если системное
      // хранилище доступно (DPAPI на Windows), в профиль уходит только шифр,
      // а в окно — маска. Иначе честно помечаем запись как «незашифрованную».
      const secret = looksLikeSecret(text);
      const cipher = secret ? encryptText(text) : null;
      foregroundWindow().then((win) => {
        const source = win.app
          ? `${win.app}${win.title ? ` — ${win.title}` : ''}`
          : 'Системный буфер';
        mainWindow?.webContents.send('clipboard:item', {
          kind: secret && cipher ? 'password' : 'text',
          // открытый пароль не отправляем в рендерер вовсе
          text: secret && cipher ? '' : text,
          cipher: cipher || undefined,
          encrypted: Boolean(cipher),
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
  // whisper-server держит модель в памяти — при выходе его нужно закрыть,
  // иначе процесс останется висеть после закрытия приложения
  if (!registerIpc._serverHooked) {
    registerIpc._serverHooked = true;
    app.on('before-quit', () => {
      try {
        hudWindow?.destroy?.();
        hudWindow = null;
      } catch {
        /* ignore */
      }
      try {
        require('./whisper.cjs').stopServer();
      } catch {
        /* ignore */
      }
    });
  }
  // Асинхронное чтение: preload.store.get() ходит через invoke, а не sendSync.
  // Без этого обработчика вызов молча зависал.
  ipcMain.handle('store:get', (_e, key) => store.get(key) ?? null);

  ipcMain.on('store:get', (event, key) => {
    event.returnValue = store.get(key);
  });
  ipcMain.on('store:size', (event) => {
    event.returnValue = store.sizeSync();
  });
  // Ручной выбор модели в настройках закрепляем: дальше приложение не будет
  // менять его само (иначе «оно передумало» выглядит как поломка).
  ipcMain.handle('store:set', (_e, key, value) => {
    try {
      if (key === 'zs:settings' && value && typeof value === 'object') {
        const prev = store.get('zs:settings') || {};
        if (prev.whisperModel && value.whisperModel && prev.whisperModel !== value.whisperModel) {
          store.set('zs:modelPinned', true);
        }
      }
    } catch {
      /* не мешаем самой записи */
    }
    return store.set(key, value);
  });
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
    unreadCount = Math.max(0, Number(value) || 0);
    updateTrayTooltip();
  });

  /**
   * Подстройка по фактическим замерам, а не по обещаниям каталога.
   *
   * Человек жалуется не на «модель small», а на «двадцать секунд речи — двадцать
   * секунд ожидания». Поэтому меряем реальность: сколько секунд речи и сколько
   * секунд счёта. Если движок считает медленнее, чем вчетверо быстрее реального
   * времени (двадцать секунд речи дольше пяти), — после двух таких диктовок
   * переходим на ступень легче и говорим об этом словами.
   *
   * Ручной выбор уважаем: если модель выбрана в настройках, стоит zs:modelPinned
   * и мы её не трогаем. За сессию не больше двух переключений, чтобы приложение
   * не «передумывало» каждую минуту.
   */
  let slowStrikes = 0;
  let autoSwitches = 0;

  function downloadedModels() {
    const st = models.modelStatus();
    return Object.keys(st.models || {}).filter((id) => st.models[id]?.downloaded);
  }

  function maybeAutoTune(ms, seconds, model) {
    try {
      const settings = store?.get('zs:settings') || {};
      // само правило — в electron/speedTune.cjs: его проверяет смоук, а не
      // «надеемся, что в бою сработает». Порог там же: вчетверо быстрее
      // реального времени — это и есть обещанные пять секунд на двадцать.
      const verdict = speedTune.decide({
        ms,
        seconds,
        model,
        autoOptimize: settings.autoOptimize !== false,
        pinned: store?.get('zs:modelPinned') === true,
        downloaded: downloadedModels(),
        strikes: slowStrikes,
        switches: autoSwitches,
      });
      slowStrikes = verdict.strikes;
      if (verdict.reason === 'slow-once' || verdict.reason === 'cap') {
        logger.info('stt', 'Движок не успевает — ждём подтверждения', {
          model,
          ms,
          seconds: Math.round(seconds * 10) / 10,
          realtime: Math.round(verdict.realtime * 10) / 10,
          reason: verdict.reason,
        });
      }
      if (!verdict.switchTo) return '';
      const lighter = verdict.switchTo;
      autoSwitches += 1;
      store.set('zs:settings', { ...settings, whisperModel: lighter });
      const payload = {
        from: model,
        to: lighter,
        reason: 'slow',
        ms,
        seconds: Math.round(seconds * 10) / 10,
        realtime: Math.round(verdict.realtime * 10) / 10,
      };
      try {
        mainWindow?.webContents.send('stt:auto-tune', payload);
      } catch {
        /* окна может не быть */
      }
      logger.warn('stt', 'Модель переключена на ступень легче: не успевала', {
        keep: true,
        from: model,
        to: lighter,
        ms,
        seconds: Math.round(seconds * 10) / 10,
        realtime: Math.round(verdict.realtime * 10) / 10,
      });
      return lighter;
    } catch {
      return '';
    }
  }

  /**
   * При старте: если на этой машине стоит заведомо тяжёлая модель (например,
   * small на 2 ядрах), а подходящая уже скачана — переходим на неё сами.
   * Человеческий выбор уважаем: после ручной смены модели в настройках стоит
   * zs:modelPinned, и трогать её мы не будем.
   */
  applyHardwareModel = function applyHardwareModel() {
    try {
      const settings = store?.get('zs:settings') || {};
      const current = settings.whisperModel || 'base';
      const st = models.modelStatus();
      const downloaded = Object.keys(st.models || {}).filter((id) => st.models[id]?.downloaded);
      const decision = hardware.plan({
        ...hardware.thisMachine(),
        current,
        downloaded,
        pinned: store?.get('zs:modelPinned') === true,
        autoOptimize: settings.autoOptimize !== false,
      });
      if (!decision.switchTo) return '';
      const pick = decision.pick;
      store.set('zs:settings', { ...settings, whisperModel: pick.id });
      try {
        mainWindow?.webContents.send('stt:auto-tune', {
          from: current,
          to: pick.id,
          reason: 'hardware',
          why: pick.why,
        });
      } catch {
        /* окна может не быть */
      }
      logger.info('stt', 'Модель подобрана под железо', { keep: true, from: current, to: pick.id, why: pick.why });
      return pick.id;
    } catch {
      return '';
    }
  };

  /** Распознавание PCM: одна запись — один проход whisper (см. `canSplit` ниже). */
  async function transcribePcm(payload) {
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
    // Тишину и «дыхание» в микрофон не отправляем в whisper: на пустом звуке он
    // выдумывает фразы вроде «Продолжение следует», и это выглядит как поломка.
    const audio = whisper.analysePcm?.(raw, payload?.sampleRate || 16000);
    if (audio && audio.seconds < 0.3) {
      logger.warn('stt', 'Запись короче 0,3 с — не распознаём', { keep: true, seconds: audio.seconds });
      return { ok: false, text: '', code: 'too-short', reason: 'запись короче 0,3 секунды' };
    }
    if (audio && audio.rms < 40 && audio.peak < 250) {
      logger.warn('stt', 'В записи тишина — не распознаём', { keep: true, rms: audio.rms, peak: audio.peak });
      return {
        ok: false,
        text: '',
        code: 'silent',
        reason: 'микрофон не слышит голос — проверьте устройство и уровень записи',
      };
    }
    logger.info('stt', 'Начало распознавания', {
      keep: true,
      model,
      bytes: raw.length,
      seconds: payload?.durationMs ? Math.round(payload.durationMs / 100) / 10 : undefined,
    });
    // Паузы по краям записи убираем: whisper точнее на коротком чистом фрагменте.
    const trimmed = whisper.trimSilence?.(raw, payload?.sampleRate || 16000) || raw;
    logger.info('stt', 'Обрезка тишины', {
      keep: true,
      beforeMs: Math.round((raw.length / 2 / (payload?.sampleRate || 16000)) * 1000),
      afterMs: Math.round((trimmed.length / 2 / (payload?.sampleRate || 16000)) * 1000),
    });
    const dir = path.join(app.getPath('temp'), 'zspeakly');
    fs.mkdirSync(dir, { recursive: true });
    // Имя уникальное: живая расшифровка и финальный проход могут идти почти
    // одновременно, и два вызова с одним именем перезаписали бы друг другу звук.
    const wav = path.join(dir, `dictation-${Date.now()}-${randomUUID().slice(0, 8)}.wav`);
    try {
      fs.writeFileSync(wav, writeWav(trimmed, payload?.sampleRate || 16000));
    } catch (err) {
      return { ok: false, text: '', reason: `не записал wav: ${err.message}` };
    }
    // Подсказка движку: термины с экрана (если локальная модель их назвала) +
    // словарь. Словарь не передаём, когда тумблер «Применять словарь при
    // диктовке» выключен: настройка должна работать целиком.
    const context = String(payload?.contextPrompt || '').trim().slice(0, 300);
    const dictionaryPrompt =
      payload?.useDictionary === false
        ? ''
        : (store?.get('zs:dictionary') || [])
            .map((d) => d.word)
            .slice(0, 40)
            .join(', ');
    // Склейка без дублей: «Атлас» из словаря и «Атлас» с экрана — одно слово,
    // иначе подсказка раздувается и вытесняет полезные термины за лимит.
    const prompt = mergePromptParts(context, dictionaryPrompt).slice(0, 500);
    try {
      const started = Date.now();
      const sttSettings = store?.get('zs:settings') || {};
      const keepLoaded = sttSettings.keepModelLoaded === true;
      // VAD включён по умолчанию: тишина не должна занимать движок. Но на
      // короткой фразе тишины по краям уже нет (её срезал trimSilence), а VAD
      // всё равно стоит времени — на записи до 3 секунд он только мешает.
      const useVad = sttSettings.vadEnabled !== false && (audio?.seconds || 0) > 3;
      const sr = payload?.sampleRate || 16000;
      // Сколько проходов движка делает одна диктовка.
      //
      // Раньше запись длиннее 15 секунд резалась по паузам на 2–3 фрагмента —
      // «чтобы whisper не путал фразы через паузу». На деле каждый фрагмент
      // это отдельный проход: без прогретого сервера ещё и повторная загрузка
      // весов с диска. Двадцать секунд речи превращались в три прохода и
      // двадцать секунд ожидания — ровно та жалоба, что пришла от человека.
      //
      // Теперь: окно whisper — 30 секунд, поэтому всё, что короче 28 с, идёт
      // одним проходом. Длиннее — дробим, но только когда есть прогретый
      // сервер (он считает части без повторной загрузки весов) и частей не
      // больше трёх. Без сервера whisper-cli сам режет файл на 30-секундные
      // окна внутри одного процесса: один холодный старт вместо трёх.
      const spokenSeconds = audio?.seconds || 0;
      const serverNow = whisper.serverStatus?.() || {};
      const canSplit = spokenSeconds > 28 && serverNow.ready === true;
      const parts = canSplit ? whisper.splitBySilence?.(trimmed, sr) || [trimmed] : [trimmed];
      const MAX_PARTS = 3;
      let chunks = parts;
      if (parts.length > MAX_PARTS) {
        chunks = [];
        const per = Math.ceil(parts.length / MAX_PARTS);
        for (let i = 0; i < parts.length; i += per) {
          chunks.push(Buffer.concat(parts.slice(i, i + per)));
        }
      }
      const totalParts = chunks.length;
      const reportProgress = (done) => {
        if (totalParts < 2) return;
        try {
          mainWindow?.webContents.send('stt:progress', { done, total: totalParts });
        } catch {
          /* окно уже закрыто */
        }
      };
      let res;
      if (chunks.length > 1) {
        // Части длинной записи считаем параллельно, если прогретый сервер сам
        // умеет несколько запросов (на 8+ логических потоках). На слабой машине
        // — строго по очереди: два whisper-процесса делят ядра и оба медленнее.
        const server = whisper.serverStatus?.() || {};
        const canParallel = server.ready === true && Number(server.processors) > 1;
        const parallel = canParallel ? Math.min(chunks.length, Number(server.processors)) : 1;
        const texts = new Array(chunks.length).fill('');
        let failed = null;
        let done = 0;
        const runPart = async (index) => {
          const partWav = `${wav}.${index}.wav`;
          try {
            fs.writeFileSync(partWav, writeWav(chunks[index], sr));
            const one = await whisper.transcribe(partWav, {
              lang: payload?.lang || 'ru',
              model,
              prompt,
              keepLoaded,
              useVad,
            });
            done += 1;
            reportProgress(done);
            if (!one?.ok) {
              if (!failed) failed = one;
              return;
            }
            if (one.text) texts[index] = String(one.text).trim();
          } finally {
            fs.rmSync(partWav, { force: true });
          }
        };
        if (parallel > 1) {
          let next = 0;
          const workers = Array.from({ length: parallel }, async () => {
            while (next < chunks.length && !failed) {
              const index = next;
              next += 1;
              // eslint-disable-next-line no-await-in-loop
              await runPart(index);
            }
          });
          await Promise.all(workers);
        } else {
          for (let i = 0; i < chunks.length; i += 1) {
            // eslint-disable-next-line no-await-in-loop
            await runPart(i);
            if (failed) break;
          }
        }
        if (failed) {
          // кусок не распознался — честнее отдать ошибку, чем половину текста
          logger.warn('stt', 'Фрагмент диктовки не распознан', { keep: true, reason: failed.reason || '' });
          res = failed;
        } else {
          const joined = texts
            .filter(Boolean)
            .map((t) => (/[.!?…:;]$/.test(t) ? t : `${t}.`))
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
          res = { ok: true, text: joined, parts: texts.length };
          logger.info('stt', 'Диктовка распознана по фрагментам', {
            keep: true,
            parts: texts.length,
            chars: joined.length,
          });
        }
      } else {
        reportProgress(1);
        res = await whisper.transcribe(wav, { lang: payload?.lang || 'ru', model, prompt, keepLoaded, useVad });
      }
      // Пишем только факт и причину — распознанный текст остаётся на устройстве.
      const ms = Date.now() - started;
      // whisper иногда «дослышит» фразу, которой не было (тишина, музыка).
      if (res?.ok && whisper.isPhantom?.(res.text)) {
        logger.warn('stt', 'Отброшена фраза-галлюцинация', { keep: true, chars: res.text.length });
        return { ok: false, text: '', code: 'phantom', reason: 'в записи не было речи' };
      }
      logger[res?.ok ? 'info' : 'error']('stt', res?.ok ? 'Распознавание завершено' : 'Распознавание не удалось', {
        keep: true,
        ms,
        // режим и число фрагментов: по ним видно, платил ли человек за
        // холодную загрузку модели (cli) или считал прогретый сервер (server)
        mode: res?.mode || 'cli',
        parts: totalParts,
        chars: String(res?.text || '').length,
        reason: res?.reason || '',
      });
      if (!res?.ok && res?.code === 'empty') {
        // whisper-cli отработал, но текста не дал. Показывать человеку его
        // служебный stderr («read_audio_data: reading audio data…») бессмысленно.
        logger.warn('stt', 'Движок не расслышал речь', { keep: true, ms });
        return {
          ok: false,
          text: '',
          code: 'unheard',
          reason: 'движок не расслышал речь — говорите ближе к микрофону',
          ms,
        };
      }
      const autoTunedTo = res?.ok ? maybeAutoTune(ms, audio?.seconds || 0, model) : '';
      return {
        ...res,
        ms,
        // sttMs — то же число для интерфейса: «распознано за 0,8 с» вместо
        // «обработка» без объяснений
        sttMs: ms,
        mode: res?.mode || 'cli',
        autoTunedTo: autoTunedTo || undefined,
        audio: audio ? { seconds: Math.round(audio.seconds * 10) / 10, rms: audio.rms } : undefined,
        chunks: totalParts > 1 ? totalParts : undefined,
      };
    } catch (err) {
      logger.error('stt', 'Исключение в распознавании', { stack: String(err?.stack || err) });
      return { ok: false, text: '', reason: String(err?.message || err) };
    } finally {
      fs.rmSync(wav, { force: true });
    }
  }

  // Очередь распознавания. Раньше живая расшифровка и итоговый проход шли
  // одновременно: два whisper-процесса, каждый с моделью в памяти — на слабой
  // машине это «съело всю оперативку» и не дало текста. Теперь:
  //  - одновременно выполняется ровно один проход;
  //  - итоговый проход отменяет живой, а не ждёт его;
  //  - новый живой проход не встаёт в очередь за итоговым.
  let sttLock = Promise.resolve();
  let sttMode = null; // 'partial' | 'final'

  ipcMain.handle('stt:transcribe-pcm', async (_e, payload) => {
    const isPartial = payload?.partial === true;
    if (isPartial && sttMode === 'final') {
      return { ok: false, text: '', code: 'superseded', reason: '' };
    }
    if (!isPartial && sttMode === 'partial') {
      whisper.cancel?.('вытеснено итоговым проходом');
    }
    const prev = sttLock;
    let release = () => {};
    sttLock = new Promise((resolve) => {
      release = resolve;
    });
    sttMode = isPartial ? 'partial' : 'final';
    try {
      await prev;
      return await transcribePcm(payload);
    } finally {
      if (sttMode === (isPartial ? 'partial' : 'final')) sttMode = null;
      release();
    }
  });

  // «Отменить распознавание»: человек не обязан ждать большую модель.
  ipcMain.handle('stt:cancel', () => (whisper.cancel ? whisper.cancel('отменено пользователем') : false));

  ipcMain.handle('stt:status', (_e, model) => whisper.status(model));

  ipcMain.handle('text:insert', async (_e, text) => {
    const value = String(text || '');
    if (!value) return false;
    lastInsertedText = value;
    lastInsertedAt = Date.now();
    // Настройка «Способ вставки»: SendInput не трогает буфер обмена вовсе.
    // Если он не смог ввести ни одного символа — спокойно идём путём буфера.
    const insertMethod = String((store?.get('zs:settings') || {}).insertMethod || 'clipboard');
    if (insertMethod === 'sendinput' && process.platform === 'win32') {
      const direct = await insertViaSendInput(value);
      if (direct !== null) {
        // Буфер остался чужим: мониторинг не должен счесть это своей записью,
        // поэтому запоминаем актуальное содержимое, а не наш текст.
        lastClipboardText = clipboard.readText() || '';
        return direct;
      }
    }
    lastClipboardText = value; // чтобы мониторинг не добавил это в историю
    // Вставляем через буфер обмена, но чужой буфер не съедаем: копируем текст,
    // вставляем его в активное окно и возвращаем прежнее содержимое. Иначе
    // после каждой диктовки у человека пропадало то, что он скопировал.
    const previousText = clipboard.readText();
    const previousImage = clipboard.readImage();
    const hadImage = previousImage && !previousImage.isEmpty();
    clipboard.writeText(value);
    const pasted = await pasteToActiveWindow();
    if (!pasted) {
      // Вставка не удалась — и тогда текст ОСТАЁТСЯ в буфере: именно это
      // обещает тост «Текст скопирован в буфер, нажмите Ctrl+V». Раньше буфер
      // всё равно восстанавливался через 700 мс, и обещанного текста там не было.
      lastClipboardText = value;
      return false;
    }
    setTimeout(() => {
      try {
        // Если за эти полсекунды человек успел что-то скопировать сам — его
        // содержимое важнее нашего восстановления, буфер не перетираем.
        if (clipboard.readText() !== value) {
          lastClipboardText = clipboard.readText();
          return;
        }
        if (hadImage) clipboard.writeImage(previousImage);
        else if (previousText) clipboard.writeText(previousText);
        // буфер вернулся к прежнему значению — мониторинг не должен считать
        // это новой записью
        lastClipboardText = previousText || '';
      } catch {
        /* ignore */
      }
    }, 500);
    return pasted;
  });
  // Куда уйдёт текст: наше окно (значит, вставляем прямо в поле) или чужое
  // приложение с названием — это видно в интерфейсе ещё до вставки.
  ipcMain.handle('text:target', async () => {
    const own = Boolean(mainWindow?.isFocused?.());
    if (own) return { own: true, app: '', title: '' };
    if (process.platform !== 'win32') return { own: false, app: '', title: '' };
    // Сначала резидентный помощник: заголовок окна он отдаёт без запуска новых
    // процессов (иначе на каждую фразу поднимался бы отдельный PowerShell).
    if (inputHost.available() && inputHost.status().ready) {
      const fast = await inputHost.target();
      if (fast?.ok && fast.title) return { own: false, app: '', title: fast.title };
    }
    try {
      const win = await foregroundWindow();
      return { own: false, app: win.app || '', title: win.title || '' };
    } catch {
      return { own: false, app: '', title: '' };
    }
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
      // Событие clipboard:item здесь НЕ отправляем: рендерер сам добавляет
      // снимок по ответу (иначе каждый снимок попадал в историю дважды).
      return {
        ok: true,
        width: image.getSize().width,
        height: image.getSize().height,
        image: image.resize({ width: 480 }).toDataURL(),
        source: `Снимок экрана — ${source.name || 'дисплей'}`,
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
    // payload: строка-акселератор (диктовка) или { dictationKey, textActions, voiceHotkeys }
    if (!payload) return false;
    const current = store.get('zs:settings') || {};
    if (typeof payload === 'string') {
      registerShortcuts({ ...current, dictationKey: payload });
      return true;
    }
    // сохраняем, иначе после перезапуска сочетания вернутся к прежним
    store.set('zs:settings', { ...current, ...payload });
    registerShortcuts({ ...current, ...payload });
    return true;
  });

  // Контекст экрана для «диктовки с учётом экрана»: один снимок, без записи.
  ipcMain.handle('screen:capture', async () => {
    try {
      const { desktopCapturer } = require('electron');
      const display = screen.getPrimaryDisplay();
      const { width, height } = display.size;
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: Math.round(width / 2), height: Math.round(height / 2) },
      });
      const source = sources[0];
      if (!source?.thumbnail) return { ok: false, reason: 'экран недоступен' };
      return { ok: true, image: source.thumbnail.toDataURL(), width, height };
    } catch (err) {
      return { ok: false, reason: String(err?.message || err) };
    }
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

  /**
   * Снимок «что на этой машине работает»: его видно в интерфейсе и он же
   * попадает в отчёт. Раньше человек мог лишь догадываться, зарегистрировались
   * ли глобальные сочетания и включён ли мониторинг буфера.
   */
  function systemReport() {
    try {
      const os = require('node:os');
      const st = models.modelStatus();
      const s = store?.get('zs:settings') || {};
      const model = s.whisperModel || 'base';
      let autoLaunch = null;
      try {
        autoLaunch = app.getLoginItemSettings?.()?.openAtLogin ?? null;
      } catch {
        autoLaunch = null;
      }
      return {
        platform: process.platform,
        version: app.getVersion?.() || '',
        cpus: (os.cpus() || []).length,
        ramGb: Math.round(((os.totalmem() || 0) / 1024 ** 3) * 10) / 10,
        engine: st.bin ? 'есть' : 'нет',
        vad: Boolean(st.vad),
        model,
        modelDownloaded: Boolean(st.models?.[model]?.downloaded),
        hotkeys: [...usedAccels],
        insertMethod: s.insertMethod === 'sendinput' ? 'sendinput' : 'clipboard',
        insertSupported: process.platform === 'win32',
        clipboardWatch: Boolean(clipboardTimer),
        micPreroll: s.micPreroll === true,
        autoLaunch,
        // Готовность быстрого пути: прогрета ли модель в памяти и поднят ли
        // резидентный помощник ввода. Именно эти две вещи решают, будет
        // вставка мгновенной или «через полминуты».
        // время запуска окна и загрузки весов — «почему долго» без гаданий
        startupMs,
        warmMs,
        engineWarm: whisper.serverStatus?.().ready === true,
        engineWarming: whisper.serverStatus?.().warming === true,
        engineMode: whisper.serverStatus?.().last?.mode || '',
        lastSttMs: whisper.serverStatus?.().last?.ms || 0,
        inputHost: inputHost.status(),
      };
    } catch (err) {
      return { error: String(err?.message || err) };
    }
  }

  ipcMain.handle('diag:status', () => ({ ...logger.status(), system: systemReport() }));
  ipcMain.handle('diag:recent', (_e, limit) => logger.recent(limit));
  ipcMain.handle('diag:set-enabled', (_e, enabled) => {
    logger.setEnabled(Boolean(enabled));
    logger.info('diagnostics', enabled ? 'Отправка диагностики включена' : 'Отправка диагностики выключена', {
      keep: true,
    });
    return logger.status();
  });
  ipcMain.handle('diag:set-endpoint', (_e, url) => {
    const res = logger.setEndpoint(url);
    if (res.ok) {
      // запоминаем в настройках, чтобы адрес пережил перезапуск
      const current = store.get('zs:settings') || {};
      store.set('zs:settings', { ...current, diagEndpoint: res.endpoint });
    }
    return { ...res, status: logger.status() };
  });
  // «Сохранить отчёт»: один клик, никаких диалогов и аккаунтов — файл на
  // Рабочем столе и проводник с выделенным файлом.
  ipcMain.handle('diag:save-report', async () => {
    try {
      // снимок настроек: по отчёту должно быть видно, как была настроена
      // диктовка. Слова словаря и id микрофона не выводятся — только счётчики.
      const s = store?.get('zs:settings') || {};
      const text = logger.report({
        limit: 300,
        settings: {
          model: s.whisperModel || 'small',
          keepModelLoaded: s.keepModelLoaded === true,
          language: s.language || 'ru',
          liveWhisper: s.liveWhisper !== false,
          micPreroll: s.micPreroll === true,
          insertMethod: s.insertMethod || 'clipboard',
          customMic: Boolean(s.audioDeviceId && s.audioDeviceId !== 'default'),
          dictionaryWords: (store?.get('zs:dictionary') || []).length,
        },
        system: systemReport(),
      });
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
      const dir = app.getPath('desktop') || app.getPath('documents');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `zspeakly-отчёт-${stamp}.txt`);
      fs.writeFileSync(file, text, 'utf8');
      // показать файл в проводнике — но не считать это частью сохранения
      try {
        shell.showItemInFolder?.(file);
      } catch {
        /* окно не открылось — файл всё равно на месте */
      }
      logger.info('diagnostics', 'Отчёт сохранён', { keep: true, file: '<home>\zspeakly-report.txt' });
      return { ok: true, path: file };
    } catch (err) {
      logger.error('diagnostics', 'Не удалось сохранить отчёт', { reason: String(err?.message || err) });
      return { ok: false, reason: String(err?.message || err) };
    }
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

  // Резервная копия данных: в установленной версии файл кладём на Рабочий стол
  // (как отчёт диагностики) — так пользователь точно знает, где он лежит.
  ipcMain.handle('data:save-backup', async (_e, json) => {
    if (typeof json !== 'string' || !json.trim()) return { ok: false, reason: 'пустые данные' };
    let data;
    try {
      data = JSON.parse(json);
    } catch {
      return { ok: false, reason: 'данные не похожи на JSON' };
    }
    if (!data || typeof data !== 'object') return { ok: false, reason: 'данные не похожи на JSON' };
    try {
      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      const dir = app.getPath('desktop') || app.getPath('documents');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `zspeakly-backup-${stamp}.json`);
      fs.writeFileSync(file, json, 'utf8');
      try {
        shell.showItemInFolder?.(file);
      } catch {
        /* файл всё равно на месте */
      }
      return { ok: true, path: file };
    } catch (err) {
      return { ok: false, reason: String(err?.message || err) };
    }
  });

  registerHudIpc();

  ipcMain.handle('models:warm', async (_e, payload) => {
    const settings = store?.get('zs:settings') || {};
    const id = (payload && typeof payload === 'object' ? payload.model : payload) || settings.whisperModel || 'small';
    const force = Boolean(payload && typeof payload === 'object' && payload.force);
    // явный клик по тумблеру приходит раньше, чем настройка доедет до диска
    if (!force && !settings.keepModelLoaded) return { ok: false, reason: 'включите «Держать модель в памяти»' };
    const res = await whisper.warm(id);
    logger.info('stt', res.ok ? 'Модель загружена в память' : 'Прогрев модели не удался', {
      keep: true,
      model: id,
      port: res.port || 0,
      reason: res.reason || '',
    });
    return res;
  });

  ipcMain.handle('models:status', () => {
    const base = models.modelStatus();
    // Какую модель whisper возьмёт на самом деле: выбранная может быть не
    // скачана, тогда работает ближайшая доступная — интерфейс должен это
    // показывать, а не делать вид, что выбранная уже стоит.
    const preferred = (store?.get('zs:settings') || {}).whisperModel || 'small';
    const active = whisper.findModel(preferred);
    return {
      ...base,
      // движок нашёл VAD-модель сам (в комплекте или в профиле)
      vadActive: Boolean(whisper.findVadModel?.()),
      preferred,
      active: active ? path.basename(active).replace(/^ggml-/, '').replace(/\.bin$/, '') : '',
    };
  });
  /**
   * Удаление модели из профиля. Отдаём и «сколько освободилось», и то,
   * какая модель станет активной: интерфейс должен переключиться сам,
   * а не оставить человека с выбранной, но удалённой моделью.
   */
  ipcMain.handle('models:delete', (_e, id) => {
    const res = models.deleteModel(id);
    if (!res.ok) return res;
    const settings = store?.get('zs:settings') || {};
    let switchedTo = '';
    if (settings.whisperModel === id) {
      // Выбранная модель удалена: берём ближайшую из оставшихся (findModel сам
      // знает порядок замены), чтобы диктовка продолжала работать без ручных
      // действий человека.
      const left = whisper.findModel(id);
      const name = left ? path.basename(left).replace(/^ggml-/, '').replace(/\.bin$/, '') : '';
      if (name && name !== id) {
        // настройку меняем и здесь (main — источник правды для распознавания),
        // и в окне (ответ содержит switchedTo, рендерер обновит подпись)
        switchedTo = name;
        store.set('zs:settings', { ...settings, whisperModel: name });
      }
    }
    // движок в памяти держал веса удалённой модели — освобождаем
    try {
      whisper.stopServer?.();
    } catch {
      /* сервера могло не быть */
    }
    logger.info('stt', 'Модель удалена', { keep: true, id, freedMb: res.freedMb, switchedTo });
    return { ...res, switchedTo };
  });

  ipcMain.handle('models:download', async (_e, id) => {
    const res = await models.downloadModel(id, (percent, received, total) => {
      mainWindow?.webContents.send('model:progress', { id, percent, received, total });
    });
    mainWindow?.webContents.send('model:progress', { id, percent: res.ok ? 100 : 0, done: true, ...res });
    // Только что скачанную модель сразу держим в памяти: иначе первая
    // диктовка после скачивания снова платит за загрузку весов.
    if (res.ok) {
      const cfg = store?.get('zs:settings') || {};
      if (cfg.keepModelLoaded === true) {
        whisper
          .warm(id)
          .then((warmRes) => {
            if (warmRes?.ok) logger.info('stt', 'Модель прогрета после скачивания', { keep: true, id });
          })
          .catch(() => {});
      }
    }
    return res;
  });
  /**
   * Первый запуск: в установщике есть движок, но нет модели. Раньше человек
   * узнавал об этом, наговорив минуту в пустоту. Теперь модель (и движок,
   * если он почему-то не попал в сборку) докачивается в фоне, прогресс
   * уходит в окно, а диктовка честно говорит, что ждёт загрузку.
   */
  let autoPrep = null;
  const autoPrepareRecognition = () => {
    if (autoPrep) return autoPrep;
    const push = (payload) => {
      try {
        mainWindow?.webContents.send('model:progress', { auto: true, ...payload });
      } catch {
        /* окна ещё нет */
      }
    };
    autoPrep = (async () => {
      try {
        let st = models.modelStatus();
        if (!st.bin) {
          logger.warn('stt', 'Движка нет в комплекте — скачиваю', { keep: true });
          push({ id: 'engine', percent: 0 });
          const res = await models.downloadEngine((percent) => push({ id: 'engine', percent }));
          push({ id: 'engine', percent: res.ok ? 100 : 0, done: true, ok: res.ok, reason: res.reason || '' });
          if (!res.ok) return { ok: false, reason: res.reason };
        }
        // Движок есть, а сервера распознавания нет (так было в старых
        // сборках): без него каждая диктовка платит за загрузку весов.
        // Перекачиваем архив один раз — дальше модель живёт в памяти.
        if (models.modelStatus().bin && !models.modelStatus().server) {
          logger.warn('stt', 'В комплекте нет сервера распознавания — докачиваю движок', { keep: true });
          push({ id: 'engine', percent: 0 });
          const res = await models.downloadEngine((percent) => push({ id: 'engine', percent }), {
            force: true,
          });
          push({ id: 'engine', percent: res.ok ? 100 : 0, done: true, ok: res.ok, reason: res.reason || '' });
          logger[res.ok ? 'info' : 'warn'](
            'stt',
            res.ok ? 'Сервер распознавания установлен' : 'Сервер распознавания не скачался',
            { keep: true, reason: res.reason || '' },
          );
        }
        // VAD весит меньше мегабайта — качаем сразу, чтобы тишина не попадала
        // в движок с первой же диктовки
        if (!models.modelStatus().vad) {
          const vadRes = await models.downloadVad();
          logger[vadRes.ok ? 'info' : 'warn'](
            'stt',
            vadRes.ok ? 'VAD-модель установлена' : 'VAD-модель не скачалась',
            { keep: true, reason: vadRes.reason || '' },
          );
        }
        st = models.modelStatus();
        const downloaded = Object.values(st.models).filter((m) => m.downloaded);
        if (downloaded.length) return { ok: true, already: true };
        // Модели нет вообще: берём ту, что подходит железу, а не «base для всех».
        const settings0 = store?.get('zs:settings') || {};
        const hw = hardware.thisMachine();
        const pick = hardware.pickModel(hw);
        const preferred = settings0.autoOptimize === false ? settings0.whisperModel || 'base' : pick.id;
        const id = models.MODELS[preferred] ? preferred : 'base';
        if (settings0.whisperModel !== id) {
          try {
            store.set('zs:settings', { ...settings0, whisperModel: id });
            mainWindow?.webContents.send('stt:auto-tune', { from: '', to: id, reason: 'hardware', why: pick.why });
          } catch {
            /* окна может не быть */
          }
        }
        logger.info('stt', 'Модель не скачана — качаю в фоне', { keep: true, model: id, tier: pick.tier, why: pick.why });
        push({ id, percent: 0 });
        const res = await models.downloadModel(id, (percent, received, total) =>
          push({ id, percent, received, total }),
        );
        push({ id, percent: res.ok ? 100 : 0, done: true, ok: res.ok, reason: res.reason || '' });
        logger[res.ok ? 'info' : 'warn']('stt', res.ok ? 'Модель скачана' : 'Модель не скачалась', {
          keep: true,
          model: id,
          reason: res.reason || '',
        });
        // Страховка для автоподбора: лёгкая модель должна уже лежать на диске.
        // Иначе, когда замеры покажут «не успевает», переключаться будет не на
        // что — именно так автоподбор раньше и не срабатывал. Качаем в фоне
        // через полминуты после основной: это десятки мегабайт, диктовку оно
        // не задерживает.
        if (res.ok) {
          const lighter = hardware.lighterModel(id);
          if (lighter && !models.modelStatus().models?.[lighter]?.downloaded) {
            setTimeout(() => {
              models
                .downloadModel(lighter, (percent) => push({ id: lighter, percent }))
                .then((extra) => {
                  push({ id: lighter, percent: extra.ok ? 100 : 0, done: true, ok: extra.ok, reason: extra.reason || '' });
                  logger[extra.ok ? 'info' : 'warn'](
                    extra.ok ? 'Страховочная модель скачана в фоне' : 'Страховочная модель не скачалась',
                    { keep: true, model: lighter, reason: extra.reason || '' },
                  );
                })
                .catch(() => {});
            }, 30000);
          }
        }
        return res;
      } catch (err) {
        logger.error('stt', 'Автоподготовка распознавания не удалась', { reason: String(err?.message || err) });
        return { ok: false, reason: String(err?.message || err) };
      }
    })();
    return autoPrep;
  };

  // интерфейс может попросить «подготовь ещё раз» (после сбоя сети)
  prepareRecognition = autoPrepareRecognition;
  ipcMain.handle('models:prepare', () => autoPrepareRecognition());

  ipcMain.handle('models:cancel', () => models.cancelDownload());
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
  // Пароли: расшифровка только по запросу из интерфейса («Показать»/«Копировать»).
  ipcMain.handle('secret:available', () => canEncrypt());
  ipcMain.handle('secret:reveal', (_e, cipher) => decryptText(cipher));

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
function sendKeys(keys, onDone) {
  if (process.platform !== 'win32') {
    onDone?.(false);
    return false;
  }
  const script = `Add-Type -AssemblyName System.Windows.Forms; Start-Sleep -Milliseconds 90; [System.Windows.Forms.SendKeys]::SendWait('${keys}')`;
  execFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
    { windowsHide: true },
    (err) => {
      if (err) console.warn('[sendKeys] failed', err.message);
      // SendKeys не работает в окнах с повышенными правами и в некоторых играх:
      // вызывающий код должен узнать, что вставка не удалась, и сказать человеку
      // «текст в буфере, нажмите Ctrl+V» вместо тишины.
      onDone?.(!err);
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
    // С помощником не нужно ждать запуск PowerShell: Ctrl+C уходит сразу,
    // остаётся только дать приложению положить текст в буфер.
    if (inputHost.available()) {
      setTimeout(() => {
        inputHost.copy().then(() => {
          setTimeout(() => {
            const text = clipboard.readText();
            resolve(text && text !== previous ? text : text || '');
          }, 160);
        });
      }, 60);
      return;
    }
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
    lastInsertedAt = Date.now();
    lastClipboardText = lastInsertedText;
    clipboard.writeText(String(text || ''));
    setTimeout(() => {
      const ok = pasteToActiveWindow();
      setTimeout(() => resolve(ok), 180);
    }, 60);
  });
}

/**
 * Поднять помощника ввода заранее. Вызывается при старте приложения и при
 * начале записи: пока человек говорит, PowerShell успевает запуститься, и
 * вставка не платит за холодный старт.
 */
// Прогрев движка один на всё приложение: и при запуске, и при начале записи.
// whisper.cjs сам решает, нужен ли новый сервер (если модель уже в памяти —
// второй не поднимается), поэтому повторный вызов безопасен и дешёвый.
let warmPromise = null;
function warmRecognition(model = 'base') {
  if (warmPromise) return warmPromise;
  const startedAt = Date.now();
  warmPromise = whisper
    .warm(model)
    .then((res) => {
      if (res?.ok) {
        warmMs = Date.now() - startedAt;
        logger.info('stt', 'Модель в памяти', { keep: true, port: res.port || 0, ms: warmMs });
      }
      return res;
    })
    .catch(() => null)
    .finally(() => {
      // через минуту разрешаем ещё раз: модель могли сменить в настройках
      setTimeout(() => {
        warmPromise = null;
      }, 60_000);
    });
  return warmPromise;
}

function warmInputHost() {
  try {
    if (!inputHost.available()) return;
    if (inputHost.start()) {
      // PING заодно проверяет, что процесс действительно отвечает
      inputHost.request('PING').then((res) => {
        if (!res?.ok) logger.warn('input', 'Помощник ввода не ответил', { reason: res?.reason || '' });
      });
    }
  } catch (err) {
    logger.warn('input', 'Помощник ввода не поднялся', { reason: String(err?.message || err) });
  }
}

/**
 * Вставка в активное окно другого приложения.
 *
 * sendInputEvent бьёт только в наш рендерер, поэтому для чужих окон нужен
 * системный ввод. По умолчанию — WScript.Shell SendKeys (PowerShell, ~0.3 с).
 * Если в переменной окружения ZSPEAKLY_INPUT=app указан путь к helper.exe
 * (SendInput, вставка за ~30 мс), используется он.
 */
// Прячем окно, только если фокус был в нём: тогда он вернётся туда, где
// человек печатал. Если окно и так не в фокусе — ничего не трогаем, иначе
// после вставки оно всплывало поверх чужого приложения.
function hideWindowForInsert() {
  try {
    const focused = Boolean(mainWindow?.isFocused?.() && mainWindow?.isVisible?.());
    if (focused) mainWindow.hide();
    else mainWindow?.blur?.();
    windowHiddenForInsert = focused;
  } catch {
    windowHiddenForInsert = false;
  }
}

/**
 * Вставка без буфера обмена: SendInput с UNICODE-сканкодами.
 *
 * Возвращает:
 *   true — текст введён целиком;
 *   { ok: false, partial, total } — введена только часть, повторять нельзя;
 *   null — SendInput не дал ничего, можно спокойно идти путём буфера.
 */
async function insertViaSendInput(value) {
  hideWindowForInsert();
  // Сначала резидентный помощник: С# уже скомпилирован, ввод идёт сразу.
  // Одноразовый PowerShell остаётся запасным путём, если помощника нет.
  let res = null;
  if (inputHost.available()) {
    const fast = await inputHost.type(value);
    if (fast?.ok) {
      restoreWindowAfterInsert();
      return true;
    }
    if (fast?.typed > 0) {
      restoreWindowAfterInsert();
      return { ok: false, partial: fast.typed, total: fast.total, reason: fast.reason || '' };
    }
  }
  res = await sendUnicodeText({ text: value, execFile });
  restoreWindowAfterInsert();
  if (res.ok) return true;
  if (res.sent > 0) {
    // Часть символов уже в чужом окне. Буфером дублировать нельзя: текст
    // задвоится, и человек не поймёт, почему. Пусть интерфейс скажет правду.
    console.warn('[insert] SendInput ввёл часть текста:', res.sent, 'из', res.total);
    return { ok: false, partial: res.sent, total: res.total, reason: res.reason || '' };
  }
  return null;
}

function pasteToActiveWindow() {
  if (process.platform !== 'win32') return Promise.resolve(false);

  hideWindowForInsert();

  // Резидентный помощник: Ctrl+V уходит из уже работающего процесса. Раньше
  // здесь на каждую вставку запускался powershell.exe — на слабом ПК это
  // заметная доля паузы между «замолчал» и «текст появился».
  if (inputHost.available()) {
    return inputHost.paste().then((res) => {
      if (res?.ok) {
        restoreWindowAfterInsert();
        return true;
      }
      return new Promise((resolve) => {
        setTimeout(() => {
          sendKeys('^v', (ok) => {
            restoreWindowAfterInsert();
            resolve(ok);
          });
        }, 60);
      });
    });
  }

  return new Promise((resolve) => {
    const helper = process.env.ZSPEAKLY_INPUT;
    if (helper && fs.existsSync(helper)) {
      execFile(helper, ['ctrl+v'], { windowsHide: true }, (err) => {
        if (!err) {
          restoreWindowAfterInsert();
          resolve(true);
          return;
        }
        console.warn('[paste] helper failed, fallback', err.message);
        setTimeout(() => {
          sendKeys('^v', (ok) => {
            restoreWindowAfterInsert();
            resolve(ok);
          });
        }, 120);
      });
      return;
    }

    setTimeout(() => {
      sendKeys('^v', (ok) => {
        restoreWindowAfterInsert();
        resolve(ok);
      });
    }, 60);
  });
}

/**
 * Вернуть окно ZSpeakly, когда вставка уже случилась.
 *
 * Возвращаем без фокуса: раньше окно забирало фокус на себя сразу после
 * вставки, и текст оказывался в чужом приложении, а курсор — снова в ZSpeakly.
 * Теперь активным остаётся то приложение, куда диктовали.
 */
function restoreWindowAfterInsert() {
  if (!windowHiddenForInsert) return;
  windowHiddenForInsert = false;
  setTimeout(() => {
    try {
      if (mainWindow && !mainWindow.isVisible?.()) mainWindow.showInactive();
    } catch {}
  }, 220);
}


// ── Жизненный цикл ─────────────────────────────────────────────────────────
app.on('before-quit', () => {
  app.isQuitting = true;
  store?.flush?.();
  // Помощник ввода — отдельный процесс: закрываем его вместе с приложением,
  // иначе он останется висеть у человека в диспетчере задач.
  try {
    inputHost.stop();
  } catch {
    /* ignore */
  }
});

app.whenReady().then(() => {
  store = new JsonStore();

  // Помощник ввода (PowerShell + SendInput) поднимаем один раз на всё
  // приложение: дальше вставка и ввод текста идут без холодного старта.
  setTimeout(() => warmInputHost(), 1500);

  // После аварийного закрытия во временной папке остаются wav: живая
  // расшифровка пишет их каждые пару секунд. Свежие не трогаем — они могут
  // принадлежать работающему экземпляру.
  try {
    const swept = cleanupTemp({ dir: path.join(app.getPath('temp'), 'zspeakly') });
    if (swept.removed) console.info('[temp] удалено старых записей:', swept.removed);
  } catch {
    /* уборка не должна мешать запуску */
  }

  // ── Инициализация журнала ─────────────────────────────────────────────
  // Без неё диагностика «включена», но пишет в никуда: файла нет, отправлять
  // нечего. Здесь же задаём installId (случайный, не связан с человеком),
  // версию, платформу и состояние движка — ровно то, что нужно для разбора.
  const saved = store.get('zs:settings') || {};
  const engineInfo = (() => {
    try {
      return whisper.status(saved.whisperModel || 'small');
    } catch {
      return { available: false, reason: 'неизвестно' };
    }
  })();
  const appVersion = (() => {
    try {
      return app.getVersion?.() || '';
    } catch {
      return '';
    }
  })();
  logger.init({
    dir: app.getPath('userData'),
    // выключенный тумблер уважаем; свой адрес приёмника — тоже
    enabled: saved.diagnostics !== false,
    endpoint: saved.diagEndpoint === undefined ? undefined : saved.diagEndpoint,
    context: {
      version: appVersion,
      channel: saved.updateChannel || 'stable',
      platform: process.platform,
      arch: process.arch,
      electron: process.versions?.electron || '',
      engine: engineInfo.available ? 'whisper.cpp' : engineInfo.reason || 'нет',
    },
  });
  const storedId = store.get('zs:installId');
  if (storedId && typeof storedId === 'string') logger.setInstallId(storedId);
  else {
    const fresh = logger.newInstallId();
    store.set('zs:installId', fresh);
    logger.setInstallId(fresh);
  }
  logger.info('app', 'Запуск ZSpeakly', {
    keep: true,
    version: appVersion,
    engine: engineInfo.available ? 'whisper.cpp' : 'нет',
  });

  registerIpc();
  createWindow();
  createTray();

  // Если включено «Держать модель в памяти», грузим её сразу после старта:
  // первая диктовка должна быть такой же быстрой, как десятая.
  try {
    const booleans = store.get('zs:settings') || {};
    if (booleans.keepModelLoaded !== false && whisper.serverStatus().available) {
      setTimeout(() => warmRecognition(booleans.whisperModel || 'base'), 900);
    }
  } catch {
    /* ignore */
  }

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
    voiceHotkeys: settings.voiceHotkeys || [],
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
  logger.error('main', 'Необработанная ошибка', { stack: String(err?.stack || err) });
  dialog.showErrorBox?.('ZSpeakly', String(err?.message || err));
});

process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandled rejection', reason);
  logger.error('main', 'Необработанный промис', {
    reason: String(reason?.message || reason),
    stack: String(reason?.stack || ''),
  });
});
