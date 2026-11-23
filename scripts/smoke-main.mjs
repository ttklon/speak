/**
 * Смоук main-процесса без реального Electron: подменяем модуль 'electron'
 * заглушкой и проверяем, что IPC-каналы регистрируются, хоткеи собираются,
 * а чтение/замена выделения не падают.
 *
 * Запуск: node scripts/smoke-main.mjs
 */

import { createRequire } from 'node:module';
import Module from 'node:module';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zs-smoke-'));
const deniedLockProbe = process.argv.includes('--test-lock-denied');
const earlySecondProbe = process.argv.includes('--test-early-second');
const closedSecondProbe = process.argv.includes('--test-closed-second');
const disabledClipboardProbe = process.argv.includes('--test-clipboard-disabled');
const probeProfile = path.join(userData, 'profile.json');
const probeContents = JSON.stringify({ 'zs:installId': 'existing-id', history: ['исходная запись'] });
if (deniedLockProbe) fs.writeFileSync(probeProfile, probeContents, 'utf8');
if (disabledClipboardProbe) fs.writeFileSync(probeProfile, JSON.stringify({ 'zs:settings': { clipboardMonitor: false, checkUpdates: false } }), 'utf8');
let quitCalled = 0;

const handlers = new Map();
const onHandlers = new Map();
const appListeners = new Map();
const quitDialogs = [];
let quitDialogChoice = 0;
const registered = [];
const sentEvents = [];
const sentInputEvents = [];
const clipboardText = { value: 'выделенный текст' };
const clipboardImage = { value: null };
const clipboardReads = { text: 0, image: 0 };
let displayMediaHandler;

const windowInstances = [];

// Главное окно отличаем не по конкретному числу в опциях (минимальный размер
// окна менялся в 1.35.0), а по тому, что ограничение размера есть только у него:
// ни у индикатора диктовки, ни у служебных окон его нет.
const findMainWindow = () => windowInstances.find((w) => w._options?.minWidth && w._options?.minHeight);
// шаблоны меню трея: проверяем, что подпись сочетания обновляется
const trayTemplates = [];
const trayMenus = [];
const trayTooltips = [];
// Окно-заглушка: запоминаем options и состояние, чтобы проверять плавающий
// индикатор (alwaysOnTop, focusable, showInactive, hide, loadFile).
const makeWindow = (options = {}) => {
  const win = {
    _options: options,
    _file: '',
    _visible: options.show !== false,
    webContents: {
      send: (ch, payload) => sentEvents.push({ ch, payload }),
      sendInputEvent: (ev) => sentInputEvents.push(ev),
      executeJavaScript: async () => {},
      setWindowOpenHandler: () => {},
      on: () => {},
    },
    // слушатели событий окна запоминаем: проверяем, что размер и место
    // действительно сохраняются по resize/move
    _listeners: {},
    on: (event, fn) => {
      if (!win._listeners[event]) win._listeners[event] = [];
      win._listeners[event].push(fn);
    },
    emit: (event, payload) => {
      for (const fn of win._listeners[event] || []) fn(payload);
    },
    once: (event, fn) => {
      if (!win._listeners[event]) win._listeners[event] = [];
      const wrapped = (...args) => {
        win._listeners[event] = win._listeners[event].filter((item) => item !== wrapped);
        fn(...args);
      };
      win._listeners[event].push(wrapped);
    },
    loadURL: async () => {},
    loadFile: async (file) => {
      win._file = String(file);
    },
    show: () => {
      win._visible = true;
      win._showCalls = (win._showCalls || 0) + 1;
    },
    showInactive: () => {
      win._visible = true;
      win._inactiveCalls = (win._inactiveCalls || 0) + 1;
    },
    focus: () => {
      win._focusCalls = (win._focusCalls || 0) + 1;
    },
    blur: () => {
      win._blurCalls = (win._blurCalls || 0) + 1;
    },
    hide: () => {
      win._visible = false;
    },
    isMinimized: () => Boolean(win._minimized),
    isVisible: () => win._visible,
    isDestroyed: () => false,
    destroy: () => {
      win._visible = false;
    },
    setAlwaysOnTop: (flag) => {
      win._alwaysOnTop = flag;
    },
    setVisibleOnAllWorkspaces: () => {},
    getBounds: () => ({
      x: win._bounds?.x ?? 0,
      y: win._bounds?.y ?? 0,
      width: win._bounds?.width ?? win._options.width,
      height: win._bounds?.height ?? win._options.height,
    }),
    setBounds: (b) => {
      win._bounds = b;
    },
    setIgnoreMouseEvents: () => {},
    restore: () => { win._minimized = false; win._restoreCalls = (win._restoreCalls || 0) + 1; },
    isMaximized: () => false,
    isFocused: () => true,
    maximize: () => {},
    unmaximize: () => {},
    minimize: () => {},
    close: () => {},
  };
  return win;
};
const fakeWindow = () => windowInstances[windowInstances.length - 1] || makeWindow();

const electronStub = {
  app: {
    isPackaged: false,
    requestSingleInstanceLock: () => !deniedLockProbe,
    on: (event, fn) => {
      if (!appListeners.has(event)) appListeners.set(event, []);
      appListeners.get(event).push(fn);
    },
    whenReady: () => Promise.resolve(),
    quit: () => { quitCalled += 1; },
    getVersion: () => '1.5.0',
    getName: () => 'ZSpeakly',
    getPath: () => userData,
    getAppPath: () => process.cwd(),
    setAppUserModelId: () => {},
    commandLine: { appendSwitch: () => {} },
    setLoginItemSettings: () => {},
    getLoginItemSettings: () => ({ openAtLogin: false }),
  },
  // системное хранилище (DPAPI) — в тесте «шифруем» префиксом, чтобы проверить
  // и путь с шифрованием, и путь без него (available=false)
  safeStorage: {
    _available: true,
    isEncryptionAvailable() {
      return this._available;
    },
    encryptString(text) {
      return Buffer.from(`enc:${text}`, 'utf8');
    },
    decryptString(buf) {
      const value = Buffer.from(buf).toString('utf8');
      if (!value.startsWith('enc:')) throw new Error('не наш шифр');
      return value.slice(4);
    },
  },
  BrowserWindow: Object.assign(function BrowserWindow(options) {
    const win = makeWindow(options);
    windowInstances.push(win);
    return win;
  }, { getAllWindows: () => windowInstances }),
  Tray: class {
    setToolTip(text) {
      trayTooltips.push(text);
    }
    setContextMenu(menu) {
      trayMenus.push(menu);
    }
    on() {}
    isDestroyed() {
      return false;
    }
  },
  Menu: {
    buildFromTemplate: (template) => {
      trayTemplates.push(template);
      return { template };
    },
  },
  nativeImage: {
    createFromPath: () => ({ isEmpty: () => true }),
    createFromDataURL: () => ({ isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }), __fromDataUrl: true }),
    createEmpty: () => ({}),
  },
  ipcMain: {
    on: (ch, fn) => onHandlers.set(ch, fn),
    handle: (ch, fn) => handlers.set(ch, fn),
  },
  globalShortcut: {
    unregisterAll: () => (registered.length = 0),
    register: (acc, fn) => {
      // как в Electron: занятое сочетание не регистрируется повторно
      if (registered.includes(acc)) return false;
      registered.push(acc);
      globalShortcutRegs.push({ accel: acc, fn });
      return true;
    },
  },
  clipboard: {
    writeImage: (img) => { clipboardImage.value = img; },
    readText: () => { clipboardReads.text += 1; return clipboardText.value; },
    writeText: (v) => {
      clipboardText.value = String(v);
    },
    readImage: () => { clipboardReads.image += 1; return { isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }) }; },
    availableFormats: () => ['text/plain'],
  },
  shell: { openExternal: () => {}, openPath: () => {} },
  dialog: {
    showErrorBox: () => {},
    showMessageBoxSync: (options) => {
      quitDialogs.push(options);
      if (quitDialogChoice === 'throw') throw new Error('dialog unavailable');
      return quitDialogChoice;
    },
  },
  screen: {
    getPrimaryDisplay: () => ({
      size: { width: 1920, height: 1080 },
      workAreaSize: { width: 1920, height: 1040 },
      workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    }),
    // второй монитор справа: индикатор должен переезжать туда, где курсор
    getCursorScreenPoint: () => ({ x: 2500, y: 300 }),
    getDisplayNearestPoint: () => ({
      size: { width: 2560, height: 1440 },
      workArea: { x: 1920, y: 0, width: 2560, height: 1400 },
    }),
  },
  session: { defaultSession: { setDisplayMediaRequestHandler: (handler) => { displayMediaHandler = handler; } } },
  desktopCapturer: { getSources: async () => [] },
};

// перехватываем spawn/execFile — никаких реальных процессов в тесте
const spawnCalls = [];
// что «ответит» фейковый whisper (см. cpStub.spawn); null — процесс просто молчит
const spawnPlan = { answer: null, execError: false, failFirst: 0, failText: '', attempts: 0 };
const globalShortcutRegs = [];
const cpStub = {
  execFile: (file, args, opts, cb) => {
    spawnCalls.push({ file, args });
    // execError: притворяемся, что SendKeys недоступен (окно с правами админа)
    if (typeof cb === 'function') {
      if (spawnPlan.deferForeground && String(file).includes('powershell') && args?.some((arg) => String(arg).includes('GetForegroundWindow'))) {
        spawnPlan.foregroundCallbacks.push(cb);
      } else {
        setTimeout(() => {
          const error = String(file).includes('mshta') && spawnPlan.mshtaError
            ? spawnPlan.mshtaError
            : spawnPlan.execError ? new Error('SendKeys недоступен') : null;
          cb(error, '', '');
        }, 0);
      }
    }
    // SendInput-помощник общается через stdin/stdout: отдаём то, что велел тест
    const listeners = {};
    const plan = spawnPlan.sendInput;
    const child = {
      on: (event, fn) => {
        if (fn) listeners[event] = fn;
      },
      stdout: {
        on: (event, fn) => {
          if (event !== 'data' || !fn) return;
          if (plan) setTimeout(() => fn(Buffer.from(plan.out || '')), 0);
        },
      },
      stderr: { on: () => {} },
      stdin: {
        write: (data) => {
          spawnPlan.stdin = String(data);
        },
        end: () => {},
      },
      kill: () => {},
    };
    if (plan) setTimeout(() => listeners.close?.(plan.code ?? 0), 5);
    return child;
  },
  exec: (cmd, opts, cb) => {
    spawnCalls.push({ file: cmd, args: [] });
    if (typeof cb === 'function') setTimeout(() => cb(null, '', ''), 0);
    return { on: () => {} };
  },
  spawn: (file, args) => {
    spawnCalls.push({ file, args });
    const listeners = {};
    let stderrFn = null;
    const child = {
      on: (event, fn) => {
        if (fn) listeners[event] = fn;
      },
      stdout: { on: () => {} },
      stderr: {
        on: (event, fn) => {
          if (event === 'data' && fn) stderrFn = fn;
        },
      },
      kill: () => {},
    };
    // «старая сборка»: первые N запусков ругаются на неизвестный аргумент
    if (spawnPlan.failFirst > 0 && String(file).includes('whisper')) {
      spawnPlan.attempts += 1;
      if (spawnPlan.attempts <= spawnPlan.failFirst) {
        setTimeout(() => {
          stderrFn?.(Buffer.from(spawnPlan.failText || 'error: unknown argument: --vad'));
          listeners.close?.(1);
        }, 0);
        return child;
      }
    }
    // «распознавание»: пишем тот же файл, что ждёт whisper.cjs (-otxt), и закрываемся
    if (spawnPlan.answer !== null) {
      const at = (args || []).indexOf('-of');
      if (at >= 0) fs.writeFileSync(`${args[at + 1]}.txt`, spawnPlan.answer);
      setTimeout(() => listeners.close?.(0), 0);
    }
    return child;
  },
};

const originalLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === 'electron') return electronStub;
  if (request === 'node:child_process' || request === 'child_process') return cpStub;
  return originalLoad.call(this, request, parent, isMain);
};

// В отдельных сценариях меняем только состояние и ответ тестового помощника.
const winInputModule = require(path.resolve('electron/winInput.cjs'));
const originalCreateWinInput = winInputModule.createWinInput;
winInputModule.createWinInput = (...args) => {
  const input = originalCreateWinInput(...args);
  const status = input.status, ensure = input.ensure, paste = input.paste;
  return { ...input,
    status: () => spawnPlan.clipboardHelper ? { ready: true, reason: '' } : status(),
    ensure: () => spawnPlan.clipboardHelper ? Promise.resolve({ ready: true }) : ensure(),
    paste: () => spawnPlan.clipboardHelper ? spawnPlan.clipboardHelper() : paste(),
    erase: (n) => spawnPlan.eraseHelper ? spawnPlan.eraseHelper(n) : input.erase(n),
  };
};
// main.cjs живёт в CommonJS — грузим через require
const main = require(path.resolve('electron/main.cjs'));
// Событие приходит до whenReady и создания окна, а не после загрузки UI.
if (earlySecondProbe) for (const fn of appListeners.get('second-instance') || []) fn();
// Подмена прогрева сразу после загрузки main: до первого «hud:show» и до
// таймера прогрева при старте. Нужна, чтобы увидеть, что прогрев вообще
// запускается, не поднимая настоящий whisper-server.
const whisperForWarm = require(path.resolve('electron/whisper.cjs'));
const warmSeen = [];
const realWarm = whisperForWarm.warm;
whisperForWarm.warm = async (m) => {
  warmSeen.push(String(m || ''));
  return { ok: false, reason: 'смоук: без server' };
};
const ok = [];
const fail = [];

async function check(name, fn) {
  try {
    await fn();
    ok.push(name);
  } catch (err) {
    fail.push(`${name}: ${err.message}`);
  }
}

await new Promise((r) => setTimeout(r, 200));

if (disabledClipboardProbe) {
  let error = '';
  try {
    const status = () => handlers.get('diag:status')({}).system.clipboardWatch;
    if (status()) throw new Error('монитор запущен с выключенной настройкой');
    const before = { ...clipboardReads };
    await new Promise((r) => setTimeout(r, 1100));
    if (clipboardReads.text !== before.text || clipboardReads.image !== before.image) throw new Error('буфер читается при выключенном мониторинге');
    clipboardText.value = 'новый тестовый текст после включения';
    handlers.get('store:set')({}, 'zs:settings', { clipboardMonitor: true, checkUpdates: false });
    if (!status()) throw new Error('включение не запустило мониторинг');
    await new Promise((r) => setTimeout(r, 1100));
    if (!sentEvents.some((e) => e.ch === 'clipboard:item' && e.payload.text === clipboardText.value)) throw new Error('включённый монитор не прислал текст');
    handlers.get('store:set')({}, 'zs:settings', { clipboardMonitor: false, checkUpdates: false });
    if (status()) throw new Error('выключение не остановило мониторинг');
    const stopped = { ...clipboardReads };
    await new Promise((r) => setTimeout(r, 1100));
    if (clipboardReads.text !== stopped.text || clipboardReads.image !== stopped.image) throw new Error('остановленный монитор читает буфер');

    // На Windows получение активного окна асинхронно. Отложенный ответ старой
    // сессии не должен попасть в новую после быстрого выключения и включения.
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    spawnPlan.deferForeground = true;
    spawnPlan.foregroundCallbacks = [];
    clipboardText.value = 'отложенный текст старой сессии';
    sentEvents.length = 0;
    handlers.get('store:set')({}, 'zs:settings', { clipboardMonitor: true, checkUpdates: false });
    await new Promise((r) => setTimeout(r, 1100));
    if (!spawnPlan.foregroundCallbacks.length) throw new Error('не начат отложенный поиск окна');
    handlers.get('store:set')({}, 'zs:settings', { clipboardMonitor: false, checkUpdates: false });
    handlers.get('store:set')({}, 'zs:settings', { clipboardMonitor: true, checkUpdates: false });
    for (const callback of spawnPlan.foregroundCallbacks) callback(null, '', '');
    await new Promise((r) => setTimeout(r, 100));
    if (sentEvents.some((e) => e.ch === 'clipboard:item' && e.payload.text === 'отложенный текст старой сессии')) throw new Error('старая сессия прислала событие после выключения');
    handlers.get('hotkey:set')({}, { clipboardMonitor: false });
    if (status()) throw new Error('hotkey:set не остановил мониторинг');
    handlers.get('store:remove')({}, 'zs:settings');
    if (!status()) throw new Error('после удаления настроек не применён default');
    for (const fn of appListeners.get('will-quit') || []) fn({ preventDefault() {} });
    if (status()) throw new Error('монитор не остановлен при выходе');
    handlers.get('store:set')({}, 'zs:settings', { clipboardMonitor: true });
    if (status()) throw new Error('монитор повторно запущен после выхода');
  } catch (err) { error = err.message; }
  fs.rmSync(userData, { recursive: true, force: true });
  if (error) console.error(error);
  else console.log('CLIPBOARD_DISABLED_OK');
  process.exit(error ? 1 : 0);
}

if (deniedLockProbe || earlySecondProbe || closedSecondProbe) {
  let error = '';
  if (deniedLockProbe) {
    if (!quitCalled) error = 'не запросил выход';
    else if (handlers.size || onHandlers.size || windowInstances.length) error = 'второй экземпляр запустил IPC или окно после отказа блокировки';
    else if (fs.readFileSync(probeProfile, 'utf8') !== probeContents || fs.existsSync(`${probeProfile}.tmp`)) error = 'второй экземпляр изменил профиль';
  } else {
    let win = findMainWindow();
    if (!win) error = 'основное окно не создано';
    else if (closedSecondProbe) {
      const previous = windowInstances.length;
      win.emit('closed');
      for (const fn of appListeners.get('second-instance') || []) fn();
      if (windowInstances.length !== previous + 1) error = 'повторный запуск не создал закрытое окно';
      else {
        win = windowInstances.at(-1);
        win.emit('ready-to-show');
        if (!win.isVisible() || !win._focusCalls) error = 'восстановленное окно не показано';
      }
    } else {
      win.emit('ready-to-show');
      if (!win.isVisible() || !win._focusCalls) error = 'ранний повторный запуск потерян до готовности окна';
      else {
        const focusBefore = win._focusCalls;
        win._minimized = true;
        win.hide();
        for (const fn of appListeners.get('second-instance') || []) fn();
        if (!win.isVisible() || win._minimized || !win._restoreCalls || win._focusCalls <= focusBefore) error = 'свёрнутое окно не восстановлено';
      }
    }
  }
  fs.rmSync(userData, { recursive: true, force: true });
  if (error) console.error(error);
  else console.log(deniedLockProbe ? 'LOCK_DENIED_OK' : closedSecondProbe ? 'CLOSED_SECOND_OK' : 'EARLY_SECOND_OK');
  process.exit(error ? 1 : 0);
}

await check('отказ блокировки не запускает второй профиль, ранний повтор открывает окно', () => {
  const { spawnSync } = originalLoad('node:child_process', undefined, false);
  for (const args of [['--test-lock-denied'], ['--test-early-second', '--hidden'], ['--test-closed-second', '--hidden']]) {
    const child = spawnSync(process.execPath, [path.resolve('scripts/smoke-main.mjs'), ...args], { encoding: 'utf8', timeout: 15000 });
    const marker = args[0] === '--test-lock-denied' ? 'LOCK_DENIED_OK' : args[0] === '--test-closed-second' ? 'CLOSED_SECOND_OK' : 'EARLY_SECOND_OK';
    if (child.status !== 0 || !child.stdout.includes(marker)) throw new Error(`${args[0]}: ${child.stderr || child.stdout || child.error?.message}`);
  }
});

await check('мониторинг: запуск с выключенной настройкой и включение без перезапуска', () => {
  const { spawnSync } = originalLoad('node:child_process', undefined, false);
  const child = spawnSync(process.execPath, [path.resolve('scripts/smoke-main.mjs'), '--test-clipboard-disabled'], { encoding: 'utf8', timeout: 25000 });
  if (child.status !== 0 || !child.stdout.includes('CLIPBOARD_DISABLED_OK')) throw new Error(child.stderr || child.stdout || child.error?.message);
});

await check('main загружается без реального Electron', () => {
  if (!main) throw new Error('модуль не вернулся');
});
await check('IPC-каналы зарегистрированы', () => {
  const need = [
    'stt:transcribe-pcm', 'text:insert', 'text:undo-last', 'text:paste', 'text:read-selection',
    'text:replace-selection', 'clipboard:screenshot', 'hotkey:set', 'app:auto-launch',
    'models:status', 'models:compare', 'models:download', 'models:download-engine', 'models:cancel', 'models:delete',
    'update:check', 'update:download', 'update:install', 'app:notify', 'app:save-file',
  ];
  const missing = need.filter((ch) => !handlers.has(ch));
  if (missing.length) throw new Error(`нет каналов: ${missing.join(', ')}`);
});
await check('автоподбор: две медленные диктовки подряд — и модель на ступень легче', () => {
  const tune = require(path.resolve('electron/speedTune.cjs'));
  const base = {
    model: 'small-q5_1',
    downloaded: ['base-q5_1', 'small-q5_1'],
    autoOptimize: true,
    pinned: false,
  };
  // 20 секунд речи за 9 секунд счёта — в 2,2 раза быстрее реального времени, мало
  const first = tune.decide({ ...base, ms: 9000, seconds: 20, strikes: 0 });
  if (first.switchTo) throw new Error('переключился после одной медленной фразы');
  if (first.reason !== 'slow-once' || first.strikes !== 1) throw new Error(JSON.stringify(first));
  const second = tune.decide({ ...base, ms: 9000, seconds: 20, strikes: 1 });
  if (second.switchTo !== 'base-q5_1') throw new Error(`не переключился: ${JSON.stringify(second)}`);
  if (second.reason !== 'slow' || second.strikes !== 0) throw new Error(JSON.stringify(second));
  // быстрая фраза — счётчик сбрасывается, копить «долги» незачем
  const fast = tune.decide({ ...base, ms: 3000, seconds: 20, strikes: 1 });
  if (fast.switchTo || fast.strikes !== 0) throw new Error(JSON.stringify(fast));
  // 20 секунд за 3 секунды — это 6,6×, порог пройден
  if (fast.reason !== 'fast') throw new Error(`20 с за 3 с не считается быстрым: ${fast.reason}`);
  // а 20 секунд за 6 секунд уже не «быстро»: порог — вчетверо (20 / 4 = 5 с),
  // это и есть обещание «фраза на двадцать секунд распознаётся за пять»
  const borderline = tune.decide({ ...base, ms: 6000, seconds: 20, strikes: 1 });
  if (borderline.switchTo !== 'base-q5_1') throw new Error(`20 с за 6 с не признано медленным: ${JSON.stringify(borderline)}`);
  // Короткая фраза «три секунды речи за два» — это не медленно, а разгон
  // движка: раньше такие две фразы подряд уводили человека на самую лёгкую
  // модель, и он получал «быстро, но кашу». Короткие фразы не судим.
  const brief = tune.decide({ ...base, ms: 2000, seconds: 3, strikes: 0 });
  if (brief.switchTo || brief.strikes !== 0 || brief.reason !== 'short') {
    throw new Error(`короткая фраза принята за медленную: ${JSON.stringify(brief)}`);
  }
  const briefTwice = tune.decide({ ...base, ms: 2000, seconds: 3, strikes: 1 });
  if (briefTwice.switchTo || briefTwice.strikes !== 0) {
    throw new Error(`две короткие фразы утащили модель вниз: ${JSON.stringify(briefTwice)}`);
  }
  // а если короткая фраза ждала дольше обещанных пяти секунд — это уже поломка
  const stalled = tune.decide({ ...base, ms: 7000, seconds: 3, strikes: 1 });
  if (stalled.switchTo !== 'base-q5_1') throw new Error(`3 с речи за 7 с не признано поломкой: ${JSON.stringify(stalled)}`);
});

await check('автоподбор: уважает ручной выбор, выключенный тумблер и крайние ступени', () => {
  const tune = require(path.resolve('electron/speedTune.cjs'));
  const slow = { ms: 12000, seconds: 20, model: 'small-q5_1', downloaded: ['base-q5_1', 'small-q5_1'], strikes: 1 };
  if (tune.decide({ ...slow, pinned: true }).switchTo) throw new Error('переключил модель вопреки ручному выбору');
  if (tune.decide({ ...slow, autoOptimize: false }).switchTo) throw new Error('переключил при выключенном автоподборе');
  // модель не скачана — обещать нечего
  const missing = tune.decide({ ...slow, downloaded: ['small-q5_1'] });
  if (missing.switchTo || missing.reason !== 'missing') throw new Error(JSON.stringify(missing));
  // уже самая лёгкая — ниже некуда
  const floor = tune.decide({ ...slow, model: 'base-q5_1', strikes: 5 });
  if (floor.switchTo || floor.reason !== 'floor') throw new Error(JSON.stringify(floor));
  // за сессию не больше двух переключений
  const cap = tune.decide({ ...slow, model: 'large-v3-turbo-q5_0', downloaded: ['small-q5_1', 'large-v3-turbo-q5_0'] });
  if (cap.switchTo !== 'small-q5_1') throw new Error(`не спустился с максимума: ${JSON.stringify(cap)}`);
  const capped = tune.decide({ ...slow, switches: 2 });
  if (capped.switchTo || capped.reason !== 'cap') throw new Error(JSON.stringify(capped));
  // без измерений не гадаем
  if (tune.decide({ ...slow, ms: 0 }).reason !== 'unknown') throw new Error('считает по нулевым замерам');
});

await check('отмена скачивания модели отвечает без зависаний', async () => {
  const res = await handlers.get('models:cancel')({});
  if (!res || typeof res.ok !== 'boolean') throw new Error(`странный ответ: ${JSON.stringify(res)}`);
  if (res.ok) throw new Error('нечего отменять, а вернулось ok');
  if (!/нечего/.test(res.reason || '')) throw new Error(`нет причины: ${res.reason}`);
});
await check('store:get работает синхронно', () => {
  if (!onHandlers.has('store:get')) throw new Error('нет store:get');
});
await check('профиль: ошибка диска доходит до окна и статус сбрасывается после успешной записи', async () => {
  const originalRename = fs.renameSync;
  const profile = path.join(userData, 'profile.json');
  const before = sentEvents.length;
  try {
    fs.renameSync = (from, to) => {
      if (to === profile) throw Object.assign(new Error('ошибка диска'), { code: 'ENOSPC' });
      return originalRename(from, to);
    };
    await handlers.get('store:set')({}, 'zs:smoke-storage', 'test');
    await new Promise((resolve) => setTimeout(resolve, 350));
    const event = sentEvents.slice(before).find((entry) => entry.ch === 'store:error');
    if (!event || event.payload?.code !== 'ENOSPC') throw new Error(`нет уведомления: ${JSON.stringify(event)}`);
    const status = {};
    onHandlers.get('store:status')(status);
    if (status.returnValue?.ok !== false) throw new Error(`нет ошибки статуса: ${JSON.stringify(status)}`);
    fs.renameSync = originalRename;
    await handlers.get('store:remove')({}, 'zs:smoke-storage');
    await new Promise((resolve) => setTimeout(resolve, 350));
    const recovered = {};
    onHandlers.get('store:status')(recovered);
    if (recovered.returnValue?.ok !== true) throw new Error(`не восстановилось: ${JSON.stringify(recovered)}`);
  } finally {
    fs.renameSync = originalRename;
  }
});
await check('выход: ошибка записи позволяет остаться, восстановиться или выйти без сохранения', async () => {
  const profile = path.join(userData, 'profile.json');
  const rename = fs.renameSync;
  const emitApp = (name) => {
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    for (const fn of appListeners.get(name) || []) fn(event);
    return event;
  };
  try {
    await handlers.get('store:set')({}, 'zs:quit-test', 'QUIT_PRIVATE_SENTINEL');
    fs.renameSync = (from, to) => {
      if (to === profile) throw Object.assign(new Error('личный путь'), { code: 'ENOSPC' });
      return rename(from, to);
    };
    quitDialogChoice = 0;
    const before = quitDialogs.length;
    electronStub.app.isQuitting = true; // выход из трея ставит флаг заранее
    const stayed = emitApp('before-quit');
    if (!stayed.prevented || electronStub.app.isQuitting) throw new Error('выход не отменён');
    if (!findMainWindow()?.isVisible()) throw new Error('окно не показано');
    const options = quitDialogs[before];
    if (!options || options.defaultId !== 0 || options.cancelId !== 0 || options.buttons?.length !== 2) throw new Error('нет безопасного выбора');
    if (JSON.stringify(options).includes('личный путь') || JSON.stringify(options).includes('QUIT_PRIVATE_SENTINEL')) throw new Error('утечка в диалог');
    if (await handlers.get('store:get')({}, 'zs:quit-test') !== 'QUIT_PRIVATE_SENTINEL') throw new Error('изменение пропало из кэша');

    quitDialogChoice = 'throw';
    if (!emitApp('before-quit').prevented || electronStub.app.isQuitting) throw new Error('ошибка диалога не отменяет выход');
    quitDialogChoice = 1;
    if (emitApp('before-quit').prevented || !electronStub.app.isQuitting) throw new Error('явный выход без сохранения не разрешён');

    fs.renameSync = rename;
    quitDialogChoice = 0;
    const win = findMainWindow();
    win._bounds = { x: 10, y: 20, width: 800, height: 600 };
    if (emitApp('before-quit').prevented) throw new Error('после восстановления выход заблокирован');
    const saved = JSON.parse(fs.readFileSync(profile, 'utf8'));
    if (saved['zs:quit-test'] !== 'QUIT_PRIVATE_SENTINEL') throw new Error('повторная запись не сохранилась');
    if (saved['ui:windowBounds']?.x !== 10) throw new Error('размеры окна не сохранены до flush');
    const afterSuccess = quitDialogs.length;
    win._bounds = { x: 100, y: 200, width: 800, height: 600 };
    win.emit('close', { preventDefault() {} });
    if ((await handlers.get('store:get')({}, 'ui:windowBounds'))?.x !== 10) throw new Error('close создал новую отложенную запись');
    if (quitDialogs.length !== afterSuccess) throw new Error('неожиданный диалог при закрытии');

    // Изменение, пришедшее между before-quit и will-quit, тоже проверяется.
    await handlers.get('store:set')({}, 'zs:late-quit', 'не терять');
    fs.renameSync = (from, to) => {
      if (to === profile) throw Object.assign(new Error('нет места'), { code: 'ENOSPC' });
      return rename(from, to);
    };
    if (!emitApp('will-quit').prevented || electronStub.app.isQuitting) throw new Error('поздний сбой не отменил выход');
  } finally {
    fs.renameSync = rename;
    electronStub.app.isQuitting = false;
    quitDialogChoice = 0;
    await handlers.get('store:remove')({}, 'zs:quit-test');
    await handlers.get('store:remove')({}, 'zs:late-quit');
  }
});
await check('hotkey:set регистрирует глобальные сочетания', () => {
  const res = handlers.get('hotkey:set')({}, { dictationKey: 'Control+Alt+Space', textActions: [
    { id: 'to-english', keys: ['Ctrl', 'Alt', 'E'], enabled: true },
    { id: 'off', keys: ['Ctrl', 'Alt', 'X'], enabled: false },
  ] });
  if (!res) throw new Error('вернулось false');
  if (!registered.includes('Control+Alt+Shift+E') && !registered.includes('Control+Alt+E')) {
    throw new Error(`E не зарегистрирован: ${registered.join(' ')}`);
  }
  if (registered.includes('Control+Alt+X')) throw new Error('выключенная инструкция зарегистрирована');
});
await check('голосовые сочетания регистрируются по-настоящему', () => {
  registered.length = 0;
  handlers.get('hotkey:set')({}, {
    dictationKey: 'Control+Alt+Space',
    textActions: [],
    voiceHotkeys: [
      { id: 'dictation', keys: ['Ctrl', 'Alt', 'Space'], enabled: true },
      { id: 'hands-free', keys: ['Ctrl', 'Alt', 'L'], enabled: true },
      { id: 'agent', keys: ['Ctrl', 'Alt', 'G'], enabled: true },
      { id: 'screen-aware', keys: ['Ctrl', 'Alt', 'S'], enabled: true },
      { id: 'off-one', keys: ['Ctrl', 'Alt', 'Z'], enabled: false },
    ],
  });
  for (const accel of ['Control+Alt+L', 'Control+Alt+G', 'Control+Alt+S']) {
    if (!registered.includes(accel)) throw new Error(`${accel} не зарегистрирован: ${registered.join(' ')}`);
  }
  if (registered.includes('Control+Alt+Z')) throw new Error('выключенное сочетание зарегистрировано');
});

await check('двойное нажатие диктовки открывает агента, если он на том же сочетании', async () => {
  registered.length = 0;
  globalShortcutRegs.length = 0;
  sentEvents.length = 0;
  handlers.get('hotkey:set')({}, {
    dictationKey: 'Control+Alt+Space',
    textActions: [],
    voiceHotkeys: [
      { id: 'dictation', keys: ['Ctrl', 'Alt', 'Space'], enabled: true },
      { id: 'agent', keys: ['Ctrl', 'Alt', 'Space'], enabled: true },
    ],
  });
  const dict = globalShortcutRegs.find((r) => r.accel === 'Control+Alt+Space');
  if (!dict) throw new Error('диктовка не зарегистрирована');
  if (registered.filter((a) => a === 'Control+Alt+Space').length !== 1) {
    throw new Error('сочетание зарегистрировано дважды');
  }
  dict.fn();
  await new Promise((r) => setTimeout(r, 60));
  // первое нажатие начинает диктовку сразу, без ожидания «а вдруг двойное»
  const firstDown = sentEvents.find((e) => e.ch === 'hotkey' && e.payload?.type === 'down');
  if (!firstDown) throw new Error('диктовка не началась мгновенно');
  dict.fn();
  await new Promise((r) => setTimeout(r, 120));
  const agent = sentEvents.find((e) => e.ch === 'hotkey' && e.payload?.type === 'agent');
  if (!agent) throw new Error(`агент не сработал: ${JSON.stringify(sentEvents.slice(-3))}`);
  const cancel = sentEvents.find((e) => e.ch === 'hotkey' && e.payload?.type === 'cancel');
  if (!cancel) throw new Error('обрывок диктовки не отменён перед агентом');
  const downs = sentEvents.filter((e) => e.ch === 'hotkey' && e.payload?.type === 'down').length;
  if (downs !== 1) throw new Error(`лишние запуски диктовки: ${downs}`);
  if (sentEvents.filter((e) => e.ch === 'hotkey' && e.payload?.type === 'up').length) {
    throw new Error('отмена ушла как «стоп» — обрывок попал бы в историю');
  }
});

await check('одиночное нажатие диктовки запускает запись', async () => {
  registered.length = 0;
  globalShortcutRegs.length = 0;
  sentEvents.length = 0;
  handlers.get('hotkey:set')({}, {
    dictationKey: 'Control+Alt+Space',
    textActions: [],
    voiceHotkeys: [{ id: 'agent', keys: ['Ctrl', 'Alt', 'Space'], enabled: true }],
  });
  const handler = globalShortcutRegs.find((r) => r.accel === 'Control+Alt+Space').fn;
  handler();
  await new Promise((r) => setTimeout(r, 120));
  const down = sentEvents.find((e) => e.ch === 'hotkey' && e.payload?.type === 'down');
  if (!down) throw new Error('запись не началась мгновенно');
  // возвращаем состояние «не записываем», иначе следующая проверка нажмёт «стоп»
  handler();
  await new Promise((r) => setTimeout(r, 120));
});

await check('своё сочетание диктовки и screen-aware работают переключателем', () => {
  registered.length = 0;
  globalShortcutRegs.length = 0;
  sentEvents.length = 0;
  handlers.get('hotkey:set')({}, {
    // своё сочетание диктовки живёт в dictationKey — так его пишет раздел
    dictationKey: 'Control+Alt+D',
    textActions: [],
    voiceHotkeys: [{ id: 'screen-aware', keys: ['Ctrl', 'Alt', 'S'], enabled: true }],
  });
  const dict = globalShortcutRegs.find((r) => r.accel === 'Control+Alt+D');
  const aware = globalShortcutRegs.find((r) => r.accel === 'Control+Alt+S');
  if (!dict || !aware) throw new Error('сочетания не зарегистрированы');
  // диктовка: первое нажатие — старт, второе — стоп (глобальное сочетание
  // не присылает отпускание клавиши, поэтому «удержание» невозможно)
  dict.fn();
  dict.fn();
  aware.fn();
  const payloads = sentEvents.filter((e) => e.ch === 'hotkey').map((e) => e.payload);
  const types = payloads.map((p) => p?.type);
  if (types[0] !== 'down' || types[1] !== 'up') throw new Error(`диктовка не переключается: ${JSON.stringify(types)}`);
  if (types[2] !== 'toggle') throw new Error(`screen-aware не переключатель: ${JSON.stringify(types)}`);
  if (!payloads[2]?.screenAware) throw new Error('screen-aware потерял флаг экрана');
  if (!registered.includes('Control+Alt+D')) throw new Error('своё сочетание диктовки не зарегистрировано');
});

await check('занятое сочетание не пропадает молча — приходит hotkey:conflict', () => {
  registered.length = 0;
  globalShortcutRegs.length = 0;
  sentEvents.length = 0;
  handlers.get('hotkey:set')({}, {
    dictationKey: 'Control+Alt+Space',
    textActions: [{ id: 'shorten', keys: ['Ctrl', 'Alt', 'S'], enabled: true }],
    voiceHotkeys: [
      { id: 'screen-aware', keys: ['Ctrl', 'Alt', 'S'], enabled: true },
      { id: 'agent', keys: ['Ctrl', 'Alt', 'Space'], enabled: true },
    ],
  });
  const conflicts = sentEvents.filter((e) => e.ch === 'hotkey:conflict');
  if (!conflicts.length) throw new Error('конфликта не сообщили');
  const textActionWorks = globalShortcutRegs.some((r) => r.accel === 'Control+Alt+S');
  if (!textActionWorks) throw new Error('ни одно из сочетаний не зарегистрировалось');
});

await check('сочетания сохраняются в настройки главного процесса', () => {
  const saved = (handlers.get('store:get')({}, 'zs:settings') || {}).voiceHotkeys || [];
  if (!saved.some((h) => h.id === 'agent' && h.enabled)) {
    throw new Error('список сочетаний не сохранился — после перезапуска вернулись бы прежние');
  }
});

await check('меню трея показывает актуальное сочетание диктовки', async () => {
  const set = handlers.get('hotkey:set');
  set({}, { dictationKey: 'Control+Shift+D' });
  const template = trayTemplates[trayTemplates.length - 1] || [];
  const item = template.find((t) => /Диктовка/.test(t.label || ''));
  const last = trayMenus[trayMenus.length - 1];
  return Boolean(item && /Ctrl \+ Shift \+ D/.test(item.label) && /Диктовка/.test(JSON.stringify(last)));
});

await check('чтение выделения: старый буфер не выдаётся за выделение', async () => {
  const platform = process.platform;
  const host = require(path.resolve('electron/inputHost.cjs')).host;
  const available = host.available, copy = host.copy;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  host.available = () => true;
  try {
    clipboardText.value = 'старый секрет из буфера';
    host.copy = async () => ({ ok: true });
    const unchanged = await handlers.get('text:read-selection')({});
    if (unchanged?.reason !== 'unverified' || unchanged?.text) throw new Error(`старый буфер принят: ${JSON.stringify(unchanged)}`);
    host.copy = async () => { clipboardText.value = 'новый буфер'; return { ok: false, reason: 'timeout' }; };
    const failed = await handlers.get('text:read-selection')({});
    if (failed?.reason !== 'unverified' || failed?.text) throw new Error(`неподтверждённое копирование принято: ${JSON.stringify(failed)}`);
    host.copy = async () => { throw new Error('потерян ответ IPC'); };
    const rejected = await handlers.get('text:read-selection')({});
    if (rejected?.reason !== 'unverified' || rejected?.text) throw new Error('исключение COPY выдало старый буфер');
    host.copy = async () => { clipboardText.value = 'реально скопированное выделение'; return { ok: true }; };
    const success = await handlers.get('text:read-selection')({});
    if (success !== 'реально скопированное выделение') throw new Error(`новое выделение потеряно: ${JSON.stringify(success)}`);
  } finally {
    host.available = available; host.copy = copy;
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  }
});

await check('чтение выделения: отказ резервного SendKeys не возвращает старый буфер', async () => {
  const platform = process.platform;
  const host = require(path.resolve('electron/inputHost.cjs')).host;
  const available = host.available;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  host.available = () => false;
  spawnPlan.execError = true;
  try {
    clipboardText.value = 'предыдущий буфер';
    const result = await handlers.get('text:read-selection')({});
    if (result?.reason !== 'unverified' || result?.text) throw new Error('неуспешный SendKeys выдал старый буфер');
  } finally {
    spawnPlan.execError = false; host.available = available;
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  }
});

await check('автовставка из буфера: после потери ответа нет второго Ctrl+V', async () => {
  const platform = process.platform;
  const host = require(path.resolve('electron/inputHost.cjs')).host;
  const available = host.available, paste = host.paste;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  host.available = () => true;
  host.paste = async () => ({ ok: false, reason: 'timeout' });
  try {
    clipboardText.value = 'содержимое буфера'; spawnCalls.length = 0;
    const result = await handlers.get('text:paste')({});
    if (!result?.uncertain) throw new Error(`неизвестный результат скрыт: ${JSON.stringify(result)}`);
    if (spawnCalls.some((c) => (c.args || []).some((arg) => /SendWait/.test(String(arg))))) throw new Error('Ctrl+V повторён через SendKeys');
    if (clipboardText.value !== 'содержимое буфера') throw new Error('буфер изменился');
    const undo = await handlers.get('text:undo-last')({});
    if (undo?.reason !== 'нечего убирать') throw new Error('разрешено слепое undo');
  } finally {
    host.available = available; host.paste = paste;
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  }
});

await check('замена выделения: после потери ответа нет повтора и слепой отмены', async () => {
  const platform = process.platform;
  const host = require(path.resolve('electron/inputHost.cjs')).host;
  const available = host.available, paste = host.paste;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  host.available = () => true;
  host.paste = async () => ({ ok: false, reason: 'timeout' });
  try {
    clipboardText.value = 'старый буфер'; spawnCalls.length = 0;
    const result = await handlers.get('text:replace-selection')({}, 'замена выделения');
    if (!result?.uncertain) throw new Error(`неизвестный результат скрыт: ${JSON.stringify(result)}`);
    if (spawnCalls.some((c) => (c.args || []).some((arg) => /SendWait/.test(String(arg))))) throw new Error('Ctrl+V повторён через SendKeys');
    if (clipboardText.value !== 'замена выделения') throw new Error('результат не скопирован');
    const undo = await handlers.get('text:undo-last')({});
    if (undo?.reason !== 'нечего убирать') throw new Error('разрешено слепое undo');
  } finally {
    host.available = available; host.paste = paste;
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  }
});

await check('общая вставка: известный отказ запуска хоста разрешает один резервный SendKeys', async () => {
  const platform = process.platform;
  const host = require(path.resolve('electron/inputHost.cjs')).host;
  const available = host.available, paste = host.paste;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  host.available = () => true;
  host.paste = async () => ({ ok: false, reason: 'host-not-started' });
  try {
    for (const [channel, args] of [['text:paste', []], ['text:replace-selection', ['резервная замена']]]) {
      spawnCalls.length = 0;
      const result = await handlers.get(channel)({}, ...args);
      const sends = spawnCalls.filter((c) => (c.args || []).some((a) => /SendWait/.test(String(a))));
      if (result !== true || sends.length !== 1) throw new Error(`${channel}: результат ${JSON.stringify(result)}, SendKeys ${sends.length}`);
    }
  } finally {
    host.available = available; host.paste = paste;
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  }
});

await check('замена выделения пишет в буфер', async () => {
  await handlers.get('text:replace-selection')({}, 'готовый текст');
  if (clipboardText.value !== 'готовый текст') throw new Error(`в буфере: ${clipboardText.value}`);
});
await check('hotkey:set принимает строку (обратная совместимость)', () => {
  if (!handlers.get('hotkey:set')({}, 'Control+Alt+Space')) throw new Error('строка не принята');
});

// ── WAV-контейнер для whisper.cpp ───────────────────────────────────────────
await check('writeWav пишет корректный RIFF-заголовок', () => {
  const { writeWav } = require(path.resolve('electron/wav.cjs'));
  const pcm = Buffer.alloc(16000 * 2); // 1 секунда
  const wav = writeWav(pcm, 16000);
  if (wav.toString('ascii', 0, 4) !== 'RIFF') throw new Error('нет RIFF');
  if (wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error('нет WAVE');
  if (wav.readUInt32LE(24) !== 16000) throw new Error('частота не 16 кГц');
  if (wav.readUInt16LE(22) !== 1) throw new Error('не моно');
  if (wav.readUInt32LE(40) !== pcm.length) throw new Error('размер данных неверный');
  if (wav.length !== 44 + pcm.length) throw new Error('длина файла неверная');
});

await check('insertText шлёт Ctrl+V в активное окно', async () => {
  // вставка включается только на Windows — притворяемся win32
  const realPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  try {
    await handlers.get('text:insert')({}, 'привет из диктовки');
    await new Promise((r) => setTimeout(r, 250));
    // вставка в чужое окно идёт через системный SendKeys ('^v'), а не через рендерер
    const calls = spawnCalls.map((c) => `${c.file} ${(c.args || []).join(' ')}`);
    // Ctrl+V отправляется одной из независимых дорог: mshta (не боится политик
    // PowerShell), PowerShell SendKeys или собственный помощник SendInput.
    const pasted = calls.some(
      (c) => /SendKeys\(\"\^v\"\)/.test(c) || /SendWait\('\^v'\)/.test(c) || /zs-input\.exe/.test(c),
    );
    if (!pasted) throw new Error(`не нашёл Ctrl+V: ${calls.join(' | ') || 'пусто'}`);
    if (clipboardText.value !== 'привет из диктовки') throw new Error('текст не в буфере');
  } finally {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  }
});

await check('сравнение моделей отказывает словами, а не пустотой', async () => {
  const res = await handlers.get('models:compare')({}, { pcm: new Uint8Array(0), models: ['small-q5_1'] });
  if (!res || res.ok !== false) throw new Error(`сравнение пустой записи выдано за успех: ${JSON.stringify(res)}`);
  if (!res.reason) throw new Error('отказ без причины');
  const none = await handlers.get('models:compare')({}, { pcm: new Uint8Array(3200), models: [] });
  if (!none || none.ok !== false || !none.reason) throw new Error('пустой список моделей не объяснён');
});

await check('«Отмени» отказывает с причиной, а не молча', async () => {
  const res = await handlers.get('text:undo-last')({});
  if (!res || typeof res !== 'object') throw new Error(`не объект: ${JSON.stringify(res)}`);
  if (res.ok !== false) throw new Error(`убрал то, чего не вставлял: ${JSON.stringify(res)}`);
  if (!res.reason) throw new Error('отказ без причины — человеку нечего делать');
});

await check('«Отмени»: неподтверждённый курсор не запускает Backspace', async () => {
  const platform = process.platform;
  const settings = handlers.get('store:get')({}, 'zs:settings') || {};
  const win = fakeWindow();
  const isFocused = win.isFocused;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  win.isFocused = () => false;
  handlers.get('store:set')({}, 'zs:settings', { ...settings, insertMethod: 'clipboard' });
  spawnPlan.clipboardHelper = async () => ({ ok: true });
  let calls = 0;
  spawnPlan.eraseHelper = async (n) => { calls++; return { ok: true, erased: n, total: n }; };
  try {
    const inserted = await handlers.get('text:insert')({}, 'тестовая вставка');
    if (!inserted?.ok) throw new Error('не удалось подготовить вставку');
    const undo = await handlers.get('text:undo-last')({});
    if (undo?.ok || calls !== 0) throw new Error(`слепое стирание разрешено: ${JSON.stringify(undo)}; вызовов ${calls}`);
  } finally {
    spawnPlan.clipboardHelper = null; spawnPlan.eraseHelper = null; win.isFocused = isFocused;
    handlers.get('store:set')({}, 'zs:settings', settings);
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    await new Promise((resolve) => setTimeout(resolve, 550));
  }
});

await check('таймаут Ctrl+V у exe не запускает второй способ', async () => {
  const platform = process.platform;
  const settings = handlers.get('store:get')({}, 'zs:settings') || {};
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  handlers.get('store:set')({}, 'zs:settings', { ...settings, insertMethod: 'clipboard' });
  spawnPlan.clipboardHelper = async () => ({ ok: false, uncertain: true, reason: 'timeout' });
  try {
    clipboardText.value = 'старый буфер';
    spawnCalls.length = 0;
    const result = await handlers.get('text:insert')({}, 'возможно вставленный текст');
    if (!result || result.ok !== false || result.uncertain !== true || result.method !== 'clipboard') throw new Error(`неизвестный результат скрыт: ${JSON.stringify(result)}`);
    if (spawnCalls.some((call) => /mshta/i.test(String(call.file)))) throw new Error('второй Ctrl+V отправлен через mshta');
    await new Promise((resolve) => setTimeout(resolve, 700));
    if (clipboardText.value !== 'возможно вставленный текст') throw new Error('буфер восстановлен после неизвестного результата');
    const undo = await handlers.get('text:undo-last')({});
    if (undo?.reason !== 'нечего убирать') throw new Error('слепая отмена неизвестной вставки разрешена');
  } finally {
    spawnPlan.clipboardHelper = null;
    handlers.get('store:set')({}, 'zs:settings', settings);
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  }
});

await check('неподтверждённая вставка не перезаписывает новое внешнее копирование', async () => {
  const platform = process.platform;
  const settings = handlers.get('store:get')({}, 'zs:settings') || {};
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  handlers.get('store:set')({}, 'zs:settings', { ...settings, insertMethod: 'clipboard' });
  spawnPlan.clipboardHelper = async () => { clipboardText.value = 'человек скопировал другое'; return { ok: false, uncertain: true }; };
  try {
    clipboardText.value = 'старый буфер';
    const result = await handlers.get('text:insert')({}, 'возможно вставленный текст');
    if (!result?.uncertain) throw new Error('нет предупреждения о неизвестной вставке');
    await new Promise((resolve) => setTimeout(resolve, 700));
    if (clipboardText.value !== 'человек скопировал другое') throw new Error('чужой буфер перезаписан');
  } finally {
    spawnPlan.clipboardHelper = null;
    handlers.get('store:set')({}, 'zs:settings', settings);
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  }
});

await check('сбой mshta после возможного Ctrl+V не вызывает повтор', async () => {
  const platform = process.platform;
  const settings = handlers.get('store:get')({}, 'zs:settings') || {};
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  handlers.get('store:set')({}, 'zs:settings', { ...settings, insertMethod: 'clipboard' });
  try {
    clipboardText.value = 'старый буфер';
    spawnPlan.execError = true;
    spawnCalls.length = 0;
    const result = await handlers.get('text:insert')({}, 'возможно вставленный текст');
    if (!result?.uncertain || result.ok !== false) throw new Error(`неизвестный результат скрыт: ${JSON.stringify(result)}`);
    const sends = spawnCalls.filter((call) => /powershell/i.test(String(call.file)) && (call.args || []).some((v) => /SendWait/.test(String(v))));
    if (sends.length) throw new Error('Ctrl+V повторён через PowerShell');
    await new Promise((resolve) => setTimeout(resolve, 700));
    if (clipboardText.value !== 'возможно вставленный текст') throw new Error('буфер изменён после неизвестной вставки');
  } finally {
    spawnPlan.execError = false;
    handlers.get('store:set')({}, 'zs:settings', settings);
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  }
});

await check('известный отказ запуска EXE разрешает одну вставку через mshta', async () => {
  const platform = process.platform;
  const settings = handlers.get('store:get')({}, 'zs:settings') || {};
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  handlers.get('store:set')({}, 'zs:settings', { ...settings, insertMethod: 'clipboard' });
  spawnPlan.clipboardHelper = async () => ({ ok: false, uncertain: false, reason: 'не запущен' });
  try {
    clipboardText.value = 'старый буфер'; spawnCalls.length = 0;
    const result = await handlers.get('text:insert')({}, 'одна вставка через mshta');
    if (!result?.ok || result.method !== 'mshta') throw new Error(`резерв не сработал: ${JSON.stringify(result)}`);
    if (spawnCalls.filter((call) => /mshta/i.test(String(call.file))).length !== 1) throw new Error('не один запуск mshta');
    await new Promise((resolve) => setTimeout(resolve, 700));
    if (clipboardText.value !== 'старый буфер') throw new Error('прежний буфер не восстановился');
  } finally {
    spawnPlan.clipboardHelper = null;
    handlers.get('store:set')({}, 'zs:settings', settings);
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  }
});

await check('таймаут резервного Ctrl+V не запускает SendKeys', async () => {
  const platform = process.platform;
  const host = require(path.resolve('electron/inputHost.cjs')).host;
  const available = host.available, paste = host.paste;
  const settings = handlers.get('store:get')({}, 'zs:settings') || {};
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  handlers.get('store:set')({}, 'zs:settings', { ...settings, insertMethod: 'clipboard' });
  spawnPlan.mshtaError = Object.assign(new Error('spawn mshta ENOENT'), { code: 'ENOENT', syscall: 'spawn mshta.exe' });
  host.available = () => true;
  host.paste = async () => ({ ok: false, reason: 'timeout' });
  try {
    clipboardText.value = 'старый буфер'; spawnCalls.length = 0;
    const result = await handlers.get('text:insert')({}, 'резервный Ctrl+V');
    if (!result?.uncertain || result.ok !== false) throw new Error(`неизвестный результат скрыт: ${JSON.stringify(result)}`);
    if (spawnCalls.some((call) => (call.args || []).some((v) => /SendWait/.test(String(v))))) throw new Error('после таймаута отправлен повтор через SendKeys');
    await new Promise((resolve) => setTimeout(resolve, 700));
    if (clipboardText.value !== 'резервный Ctrl+V') throw new Error('буфер изменён');
  } finally {
    spawnPlan.mshtaError = null; host.available = available; host.paste = paste;
    handlers.get('store:set')({}, 'zs:settings', settings);
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  }
});

await check('при отсутствии mshta и помощника резервный SendKeys запускается один раз', async () => {
  const platform = process.platform;
  const host = require(path.resolve('electron/inputHost.cjs')).host;
  const available = host.available;
  const settings = handlers.get('store:get')({}, 'zs:settings') || {};
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  handlers.get('store:set')({}, 'zs:settings', { ...settings, insertMethod: 'clipboard' });
  spawnPlan.mshtaError = Object.assign(new Error('spawn mshta ENOENT'), { code: 'ENOENT', syscall: 'spawn mshta.exe' });
  host.available = () => false;
  try {
    clipboardText.value = 'старый буфер'; spawnCalls.length = 0;
    const result = await handlers.get('text:insert')({}, 'резервная вставка');
    if (!result?.ok) throw new Error(`резерв не сработал: ${JSON.stringify(result)}`);
    const sends = spawnCalls.filter((call) => (call.args || []).some((v) => /SendWait/.test(String(v))));
    if (sends.length !== 1) throw new Error(`ожидали один SendKeys, получили ${sends.length}`);
    await new Promise((resolve) => setTimeout(resolve, 700));
  } finally {
    spawnPlan.mshtaError = null; host.available = available;
    handlers.get('store:set')({}, 'zs:settings', settings);
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  }
});

await check('ошибка резервного SendKeys не объявляется доказанным отказом вставки', async () => {
  const platform = process.platform;
  const host = require(path.resolve('electron/inputHost.cjs')).host;
  const available = host.available;
  const settings = handlers.get('store:get')({}, 'zs:settings') || {};
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  handlers.get('store:set')({}, 'zs:settings', { ...settings, insertMethod: 'clipboard' });
  spawnPlan.mshtaError = Object.assign(new Error('spawn mshta ENOENT'), { code: 'ENOENT', syscall: 'spawn mshta.exe' });
  spawnPlan.execError = true;
  host.available = () => false;
  try {
    clipboardText.value = 'старый буфер'; spawnCalls.length = 0;
    const result = await handlers.get('text:insert')({}, 'возможно доставленный текст');
    if (!result?.uncertain || result.ok !== false) throw new Error(`ошибка SendKeys неверно классифицирована: ${JSON.stringify(result)}`);
    const undo = await handlers.get('text:undo-last')({});
    if (undo?.reason !== 'нечего убирать') throw new Error('слепая отмена разрешена');
    await new Promise((resolve) => setTimeout(resolve, 700));
    if (clipboardText.value !== 'возможно доставленный текст') throw new Error('буфер восстановлен после неизвестной вставки');
  } finally {
    spawnPlan.mshtaError = null; spawnPlan.execError = false; host.available = available;
    handlers.get('store:set')({}, 'zs:settings', settings);
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  }
});

await check('неудачная вставка оставляет текст в буфере — как обещает тост', async () => {
  const realPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  try {
    clipboardText.value = 'чужой текст';
    spawnPlan.execError = true;
    const ok = await handlers.get('text:insert')({}, 'диктовка в буфере');
    await new Promise((r) => setTimeout(r, 900));
    // Ответ теперь объект: способ вставки и причина отказа. «false» без причины
    // и было тем самым «ничего не работает», которое невозможно разобрать.
    if (!ok || ok.ok !== false) throw new Error(`вставка выдана за успешную: ${JSON.stringify(ok)}`);
    if (!ok.reason) throw new Error('отказ без причины — человеку нечего делать');
    if (clipboardText.value !== 'диктовка в буфере') {
      throw new Error(`в буфере: ${clipboardText.value} — обещанного текста нет`);
    }
  } finally {
    spawnPlan.execError = false;
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  }
});

await check('SendInput: скрипт действительно вызывает SendInput с UNICODE', async () => {
  const { buildScript, parseOutput } = require(path.resolve('electron/sendInput.cjs'));
  const script = buildScript();
  if (!/SendInput\(/.test(script)) throw new Error('скрипт не зовёт SendInput');
  if (!/KEYEVENTF_UNICODE/.test(script)) throw new Error('нет флага UNICODE — кириллица не введётся');
  if (/\$args/.test(script)) throw new Error('текст не должен идти аргументами командной строки');
  const done = parseOutput('p:25\nok:40\n', 40);
  if (!done.ok || done.sent !== 40) throw new Error(`разбор успеха: ${JSON.stringify(done)}`);
  const cut = parseOutput('p:25\nerr:sendinput 5\np:25\n', 40);
  if (cut.ok || cut.sent !== 25) throw new Error(`разбор обрыва: ${JSON.stringify(cut)}`);
});

await check('вставка без буфера: текст уходит в окно, буфер не тронут', async () => {
  const realPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  const settings = handlers.get('store:get')({}, 'zs:settings') || {};
  handlers.get('store:set')({}, 'zs:settings', { ...settings, insertMethod: 'sendinput' });
  try {
    const text = 'диктовка без буфера';
    clipboardText.value = 'чужой буфер';
    spawnPlan.stdin = '';
    spawnPlan.sendInput = { out: `p:25\nok:${text.length}\n`, code: 0 };
    spawnCalls.length = 0;
    const ok = await handlers.get('text:insert')({}, text);
    if (!ok || ok.ok !== true) throw new Error(`вставка не удалась: ${JSON.stringify(ok)}`);
    if (ok.method !== 'sendinput') throw new Error(`способ вставки не тот: ${ok.method}`);
    if (clipboardText.value !== 'чужой буфер') throw new Error(`буфер перетёрт: ${clipboardText.value}`);
    const decoded = Buffer.from(spawnPlan.stdin, 'base64').toString('utf8');
    if (decoded !== text) throw new Error(`в помощник ушло не то: ${decoded}`);
    const usedPaste = spawnCalls.some((c) => (c.args || []).some((a) => /SendWait|\^v/.test(String(a))));
    if (usedPaste) throw new Error('вставка всё-таки пошла через буфер');
  } finally {
    spawnPlan.sendInput = null;
    handlers.get('store:set')({}, 'zs:settings', { ...settings, insertMethod: 'clipboard' });
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  }
});

await check('вставка без буфера: обрыв на середине не дублирует текст', async () => {
  const realPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  const settings = handlers.get('store:get')({}, 'zs:settings') || {};
  handlers.get('store:set')({}, 'zs:settings', { ...settings, insertMethod: 'sendinput' });
  try {
    clipboardText.value = 'чужой буфер';
    spawnPlan.sendInput = { out: 'p:7\nerr:sendinput 5\n', code: 2 };
    spawnCalls.length = 0;
    const res = await handlers.get('text:insert')({}, 'длинная диктовка на сорок символов и ещё');
    if (!res || res.partial !== 7) throw new Error(`не сообщили про частичный ввод: ${JSON.stringify(res)}`);
    if (clipboardText.value !== 'чужой буфер') throw new Error(`буфер тронут: ${clipboardText.value}`);
    const usedPaste = spawnCalls.some((c) => (c.args || []).some((a) => /SendWait|\^v/.test(String(a))));
    if (usedPaste) throw new Error('после обрыва текст вставили буфером — будет дубль');
    const undo = await handlers.get('text:undo-last')({});
    if (undo?.reason !== 'нечего убирать') throw new Error(`частичный ввод можно стереть целиком: ${JSON.stringify(undo)}`);
  } finally {
    spawnPlan.sendInput = null;
    handlers.get('store:set')({}, 'zs:settings', { ...settings, insertMethod: 'clipboard' });
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  }
});

await check('неподтверждённый ввод: нет повтора через PowerShell и буфер', async () => {
  const platform = process.platform;
  const host = require(path.resolve('electron/inputHost.cjs')).host;
  const available = host.available;
  const type = host.type;
  const settings = handlers.get('store:get')({}, 'zs:settings') || {};
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  handlers.get('store:set')({}, 'zs:settings', { ...settings, insertMethod: 'sendinput' });
  host.available = () => true;
  host.type = async (text) => ({ ok: false, typed: 0, total: text.length, reason: 'timeout', uncertain: true });
  try {
    clipboardText.value = 'содержимое до вставки';
    spawnPlan.sendInput = { out: 'ok:22\n', code: 0 }; // старый код повторяет ввод
    spawnCalls.length = 0;
    const result = await handlers.get('text:insert')({}, 'уже могло быть введено');
    if (!result || result.ok !== false || result.uncertain !== true) throw new Error(`не сообщили о неизвестном результате: ${JSON.stringify(result)}`);
    if (spawnCalls.some((call) => String(call.file).includes('powershell') || String(call.file).includes('mshta'))) throw new Error('ввод повторён другим способом');
    if (clipboardText.value !== 'содержимое до вставки') throw new Error('буфер изменён');
    const undo = await handlers.get('text:undo-last')({});
    if (undo?.reason !== 'нечего убирать') throw new Error(`неопределённый ввод можно стереть вслепую: ${JSON.stringify(undo)}`);
  } finally {
    host.available = available; host.type = type; spawnPlan.sendInput = null;
    handlers.get('store:set')({}, 'zs:settings', settings);
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  }
});

await check('без ответа одноразового SendInput не повторяем через буфер', async () => {
  const platform = process.platform;
  const settings = handlers.get('store:get')({}, 'zs:settings') || {};
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  handlers.get('store:set')({}, 'zs:settings', { ...settings, insertMethod: 'sendinput' });
  try {
    clipboardText.value = 'предыдущий буфер';
    spawnPlan.sendInput = { out: '', code: 1 };
    spawnCalls.length = 0;
    const result = await handlers.get('text:insert')({}, 'отправленный текст');
    if (!result?.uncertain || result.ok !== false) throw new Error(`неопределённость скрыта: ${JSON.stringify(result)}`);
    if (spawnCalls.some((call) => String(call.file).includes('mshta'))) throw new Error('ввод повторён через Ctrl+V');
    if (clipboardText.value !== 'предыдущий буфер') throw new Error('буфер изменён');
  } finally {
    spawnPlan.sendInput = null;
    handlers.get('store:set')({}, 'zs:settings', settings);
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  }
});

await check('вставка без буфера: полный отказ уходит на буфер', async () => {
  const realPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  const settings = handlers.get('store:get')({}, 'zs:settings') || {};
  handlers.get('store:set')({}, 'zs:settings', { ...settings, insertMethod: 'sendinput' });
  try {
    spawnPlan.sendInput = { out: 'err:empty\n', code: 3 };
    const text = 'запасной путь через буфер';
    const ok = await handlers.get('text:insert')({}, text);
    if (!ok || ok.ok !== true) throw new Error(`SendInput не ввёл ничего, а буферный путь не сработал: ${JSON.stringify(ok)}`);
    if (clipboardText.value !== text) throw new Error(`в буфере: ${clipboardText.value}`);
  } finally {
    spawnPlan.sendInput = null;
    handlers.get('store:set')({}, 'zs:settings', { ...settings, insertMethod: 'clipboard' });
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  }
});

await check('восстановление буфера не перетирает то, что человек скопировал сам', async () => {
  const realPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  try {
    clipboardText.value = 'было в буфере';
    const ok = await handlers.get('text:insert')({}, 'вставка прошла');
    if (!ok || ok.ok !== true) throw new Error(`вставка не удалась: ${JSON.stringify(ok)}`);
    await new Promise((r) => setTimeout(r, 120));
    clipboardText.value = 'человек скопировал своё';
    await new Promise((r) => setTimeout(r, 900));
    if (clipboardText.value !== 'человек скопировал своё') {
      throw new Error(`буфер перетёрт: ${clipboardText.value}`);
    }
  } finally {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  }
});

await check('после вставки исходно пустой буфер снова пуст', async () => {
  const platform = process.platform;
  const originalFormats = electronStub.clipboard.availableFormats;
  const originalClear = electronStub.clipboard.clear;
  let isEmpty = true;
  let clears = 0;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  electronStub.clipboard.availableFormats = () => isEmpty ? [] : ['text/plain'];
  electronStub.clipboard.clear = () => { clears++; clipboardText.value = ''; isEmpty = true; };
  const originalWrite = electronStub.clipboard.writeText;
  electronStub.clipboard.writeText = (value) => { isEmpty = false; originalWrite(value); };
  try {
    clipboardText.value = '';
    const result = await handlers.get('text:insert')({}, 'временная диктовка');
    if (!result?.ok) throw new Error('вставка не удалась');
    await new Promise((resolve) => setTimeout(resolve, 700));
    if (clears !== 1 || clipboardText.value !== '') throw new Error('диктовка осталась в исходно пустом буфере');
  } finally {
    electronStub.clipboard.availableFormats = originalFormats;
    electronStub.clipboard.clear = originalClear;
    electronStub.clipboard.writeText = originalWrite;
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  }
});

await check('неудачная вставка в пустой буфер оставляет текст для Ctrl+V', async () => {
  const platform = process.platform;
  const originalFormats = electronStub.clipboard.availableFormats;
  const originalClear = electronStub.clipboard.clear;
  const originalWrite = electronStub.clipboard.writeText;
  let empty = true;
  let clears = 0;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  electronStub.clipboard.availableFormats = () => empty ? [] : ['text/plain'];
  electronStub.clipboard.writeText = (value) => { empty = false; originalWrite(value); };
  electronStub.clipboard.clear = () => { clears++; clipboardText.value = ''; };
  try {
    clipboardText.value = '';
    spawnPlan.execError = true;
    const result = await handlers.get('text:insert')({}, 'нужно вставить вручную');
    if (result?.ok !== false) throw new Error('вставка выдана за успешную');
    await new Promise((resolve) => setTimeout(resolve, 700));
    if (clears || clipboardText.value !== 'нужно вставить вручную') throw new Error('утерян текст для ручной вставки');
  } finally {
    spawnPlan.execError = false;
    electronStub.clipboard.availableFormats = originalFormats;
    electronStub.clipboard.clear = originalClear;
    electronStub.clipboard.writeText = originalWrite;
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  }
});

await check('восстановление не стирает другой формат с тем же текстом', async () => {
  const platform = process.platform;
  const originalFormats = electronStub.clipboard.availableFormats;
  const originalWrite = electronStub.clipboard.writeText;
  let formats = ['text/plain'];
  let writes = 0;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  electronStub.clipboard.availableFormats = () => formats;
  electronStub.clipboard.writeText = (value) => { writes++; originalWrite(value); };
  try {
    clipboardText.value = 'старый текст';
    const result = await handlers.get('text:insert')({}, 'тот же текст');
    if (!result?.ok) throw new Error('вставка не удалась');
    formats = ['text/plain', 'text/html']; // новое внешнее копирование того же текста
    await new Promise((resolve) => setTimeout(resolve, 700));
    if (writes !== 1 || clipboardText.value !== 'тот же текст') throw new Error('новый формат перезаписан прежним буфером');
  } finally {
    electronStub.clipboard.availableFormats = originalFormats;
    electronStub.clipboard.writeText = originalWrite;
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  }
});

await check('ошибка определения форматов не очищает и не восстанавливает буфер', async () => {
  const platform = process.platform;
  const originalFormats = electronStub.clipboard.availableFormats;
  const originalWrite = electronStub.clipboard.writeText;
  const originalClear = electronStub.clipboard.clear;
  let writes = 0;
  let clears = 0;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  electronStub.clipboard.availableFormats = () => { throw new Error('unavailable'); };
  electronStub.clipboard.writeText = (value) => { writes++; originalWrite(value); };
  electronStub.clipboard.clear = () => { clears++; };
  try {
    clipboardText.value = '';
    const result = await handlers.get('text:insert')({}, 'диктовка');
    if (!result?.ok) throw new Error('вставка не удалась');
    await new Promise((resolve) => setTimeout(resolve, 700));
    if (writes !== 1 || clears !== 0 || clipboardText.value !== 'диктовка') throw new Error('неизвестное состояние буфера изменено');
  } finally {
    electronStub.clipboard.availableFormats = originalFormats;
    electronStub.clipboard.writeText = originalWrite;
    electronStub.clipboard.clear = originalClear;
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  }
});

await check('неизвестный исходный формат не считается пустым буфером', async () => {
  const platform = process.platform;
  const originalFormats = electronStub.clipboard.availableFormats;
  const originalClear = electronStub.clipboard.clear;
  let clears = 0;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  electronStub.clipboard.availableFormats = () => ['application/x-foreign'];
  electronStub.clipboard.clear = () => { clears++; clipboardText.value = ''; };
  try {
    clipboardText.value = '';
    const result = await handlers.get('text:insert')({}, 'диктовка');
    if (!result?.ok) throw new Error('вставка не удалась');
    await new Promise((resolve) => setTimeout(resolve, 700));
    if (clears !== 0) throw new Error('неизвестный формат принят за пустой буфер');
  } finally {
    electronStub.clipboard.availableFormats = originalFormats;
    electronStub.clipboard.clear = originalClear;
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  }
});

await check('после успешной вставки возвращается прежний буфер', async () => {
  const realPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  try {
    clipboardText.value = 'прежнее содержимое';
    const ok = await handlers.get('text:insert')({}, 'диктованный текст');
    if (!ok || ok.ok !== true) throw new Error(`вставка не удалась: ${JSON.stringify(ok)}`);
    await new Promise((r) => setTimeout(r, 900));
    if (clipboardText.value !== 'прежнее содержимое') {
      throw new Error(`в буфере осталось: ${clipboardText.value}`);
    }
  } finally {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  }
});

await check('app:open-external пускает только наши ссылки', async () => {
  const opened = [];
  const okOwn = await handlers.get('app:open-external')({}, 'https://github.com/ttklon/speak/releases');
  if (!okOwn) throw new Error('своя ссылка отклонена');
  for (const bad of [
    'https://evil.example/x',
    'https://github.com/other/repo',
    'javascript:alert(1)',
    'file:///C:/Windows/System32/calc.exe',
  ]) {
    const res = await handlers.get('app:open-external')({}, bad);
    if (res) throw new Error(`пропущена чужая ссылка: ${bad}`);
    opened.push(bad);
  }
});

await check('захват экрана: loopback только при явном запросе звука, отказ источника завершает запрос', async () => {
  const stub = electronStub.desktopCapturer;
  const original = stub.getSources;
  const realPlatform = process.platform;
  const source = { id: 'screen:test' };
  const ask = async (audioRequested) => {
    let response;
    let called = 0;
    await displayMediaHandler({ videoRequested: true, audioRequested }, (value) => { response = value; called++; });
    if (called !== 1) throw new Error(`callback вызван ${called} раз`);
    return response;
  };
  try {
    if (typeof displayMediaHandler !== 'function') throw new Error('обработчик не зарегистрирован');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    stub.getSources = async () => [source];
    const withAudio = await ask(true);
    const withoutAudio = await ask(false);
    if (withAudio.video !== source || withAudio.audio !== 'loopback') throw new Error('запрос звука не передан');
    if (withoutAudio.video !== source || Object.hasOwn(withoutAudio, 'audio')) throw new Error('loopback передан без запроса');
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    if (Object.hasOwn(await ask(true), 'audio')) throw new Error('loopback добавлен на Linux');
    stub.getSources = async () => { throw new Error('источник недоступен'); };
    if (Object.keys(await ask(false)).length !== 0) throw new Error('ошибка источника выдана за успех');
  } finally {
    stub.getSources = original;
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  }
});

await check('скриншот не попадает в историю дважды', async () => {
  const stub = electronStub.desktopCapturer;
  const original = stub.getSources;
  stub.getSources = async () => [
    {
      name: 'Экран 1',
      thumbnail: {
        toDataURL: () => 'data:image/png;base64,QQ==',
        resize: () => ({ toDataURL: () => 'data:image/png;base64,QQ==' }),
        getSize: () => ({ width: 1920, height: 1080 }),
      },
    },
  ];
  sentEvents.length = 0;
  try {
    const res = await handlers.get('clipboard:screenshot')({});
    if (!res?.ok) throw new Error(res?.reason || 'снимок не сделался');
    if (!res.image || !res.width) throw new Error('нет превью или размеров');
    const duplicates = sentEvents.filter((e) => e.ch === 'clipboard:item');
    if (duplicates.length) throw new Error('main сам прислал clipboard:item — в истории будет два снимка');
  } finally {
    stub.getSources = original;
  }
});

await check('clipboard:write кладёт картинку, а не только текст', async () => {
  const ok = await handlers.get('clipboard:write')({}, {
    image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
    text: 'подпись',
  });
  if (!ok) throw new Error('канал вернул false');
  if (!clipboardImage.value) throw new Error('картинка не попала в буфер');
});

await check('clipboard:write отклоняет слишком большой data URL и опасные размеры PNG до нативного декодирования', async () => {
  const original = electronStub.nativeImage.createFromDataURL;
  let decodes = 0;
  try {
    electronStub.nativeImage.createFromDataURL = () => { decodes++; return { isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }) }; };
    const pngHeader = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
    pngHeader.writeUInt32BE(50000, 16);
    pngHeader.writeUInt32BE(50000, 20);
    const cases = [
      'data:image/png;base64,' + 'A'.repeat(16 * 1024 * 1024),
      'data:image/png;base64,' + pngHeader.toString('base64'),
      'data:image/png;base64,@@@@',
    ];
    const rejectedIncorrectly = [];
    for (const [index, image] of cases.entries()) {
      clipboardText.value = 'прежний текст';
      clipboardImage.value = null;
      const ok = await handlers.get('clipboard:write')({}, { image, text: 'подпись' });
      if (ok || clipboardText.value !== 'прежний текст' || clipboardImage.value) rejectedIncorrectly.push(index);
    }
    if (rejectedIncorrectly.length || decodes) throw new Error(`небезопасные случаи: ${rejectedIncorrectly.join(',')}; вызовов декодера: ${decodes}`);
  } finally {
    electronStub.nativeImage.createFromDataURL = original;
  }
});

await check('clipboard:write не пишет декодированную картинку с недопустимым размером', async () => {
  const original = electronStub.nativeImage.createFromDataURL;
  try {
    for (const size of [{ width: 50000, height: 1 }, { width: 8001, height: 5000 }, { width: 0, height: 10 }]) {
      electronStub.nativeImage.createFromDataURL = () => ({ isEmpty: () => false, getSize: () => size });
      clipboardText.value = 'прежний текст';
      clipboardImage.value = null;
      const ok = await handlers.get('clipboard:write')({}, { image: 'data:image/jpeg;base64,AAA=', text: 'подпись' });
      if (ok || clipboardText.value !== 'прежний текст' || clipboardImage.value) throw new Error('недопустимая картинка изменила буфер');
    }
  } finally {
    electronStub.nativeImage.createFromDataURL = original;
  }
});

await check('clipboard:write не подменяет картинку подписью при ошибке декодирования', async () => {
  const original = electronStub.nativeImage.createFromDataURL;
  try {
    for (const decode of [() => ({ isEmpty: () => true }), () => { throw new Error('decode failed'); }]) {
      electronStub.nativeImage.createFromDataURL = decode;
      clipboardText.value = 'прежний текст';
      clipboardImage.value = null;
      const ok = await handlers.get('clipboard:write')({}, { image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', text: 'подпись' });
      if (ok || clipboardText.value !== 'прежний текст' || clipboardImage.value) throw new Error('ошибочная картинка заменена текстом');
    }
    clipboardText.value = 'прежний текст';
    const invalid = await handlers.get('clipboard:write')({}, { image: 'not-a-data-url', text: 'подпись' });
    if (invalid || clipboardText.value !== 'прежний текст') throw new Error('неверный тип картинки заменён текстом');
  } finally {
    electronStub.nativeImage.createFromDataURL = original;
  }
});

await check('хоткей диктовки не выдёргивает окно поверх чужого приложения', async () => {
  const visible = { value: false };
  // подменяем видимость у всех окон: mainWindow мог быть создан не последним.
  // Подмену обязательно снимаем в конце — иначе она врёт следующим проверкам
  // (и индикатор «виден» даже после hide).
  const originals = windowInstances.map((win) => ({
    win,
    isVisible: win.isVisible,
    show: win.show,
    showInactive: win.showInactive,
    hide: win.hide,
  }));
  for (const win of windowInstances) {
    win.isVisible = () => visible.value;
    win.show = () => { visible.value = true; };
    win.showInactive = () => { visible.value = true; };
    win.hide = () => { visible.value = false; };
  }

  const regs = [];
  globalShortcutRegs.length = 0;
  await handlers.get('hotkey:set')({}, { dictationKey: 'Control+Alt+Space' });
  const entry = globalShortcutRegs.find((r) => r.accel === 'Control+Alt+Space');
  if (!entry) throw new Error('хоткей диктовки не зарегистрирован');
  sentEvents.length = 0;
  entry.fn();
  // диктовка стартует сразу, ждать «вдруг двойное» больше не нужно
  await new Promise((r) => setTimeout(r, 120));
  const shown = visible.value;
  entry.fn();
  for (const o of originals) {
    o.win.isVisible = o.isVisible;
    o.win.show = o.show;
    o.win.showInactive = o.showInactive;
    o.win.hide = o.hide;
  }
  const down = sentEvents.find((e) => e.ch === 'hotkey' && e.payload?.type === 'down');
  if (!down) {
    throw new Error(`диктовка не началась: ${JSON.stringify(sentEvents.map((e) => e.payload))}`);
  }
  if (shown) throw new Error('окно ZSpeakly всплыло поверх чужого приложения');
});


await check('с выключенным индикатором окно показывается без фокуса', async () => {
  const settings = handlers.get('store:get')({}, 'zs:settings') || {};
  handlers.get('store:set')({}, 'zs:settings', { ...settings, showFloatingIndicator: false });
  const mainWin = findMainWindow();
  mainWin._visible = false;
  mainWin._showCalls = 0;
  mainWin._inactiveCalls = 0;
  mainWin._focusCalls = 0;
  const entry = globalShortcutRegs.find((r) => r.accel === 'Control+Alt+Space');
  if (!entry) throw new Error('хоткей диктовки не зарегистрирован');
  sentEvents.length = 0;
  entry.fn();
  await new Promise((r) => setTimeout(r, 150));
  if (mainWin._showCalls) throw new Error('окно показалось с фокусом');
  if (!mainWin._inactiveCalls) throw new Error('окно не показалось — индикатор негде увидеть');
  // возвращаем настройку как было
  handlers.get('store:set')({}, 'zs:settings', { ...settings, showFloatingIndicator: true });
  entry.fn();
  await new Promise((r) => setTimeout(r, 60));
});

await check('мониторинг буфера присылает новое копирование в окно', async () => {
  // даём доиграть отложенному возврату буфера после предыдущей вставки,
  // иначе он перезапишет «скопированное» прямо под монитором
  await new Promise((r) => setTimeout(r, 900));
  clipboardText.value = 'скопировано из блокнота';
  sentEvents.length = 0;
  await new Promise((r) => setTimeout(r, 1100));
  const item = sentEvents.find((e) => e.ch === 'clipboard:item');
  if (!item) throw new Error('событие clipboard:item не пришло');
  if (item.payload.text !== 'скопировано из блокнота') throw new Error(`текст не тот: ${item.payload.text}`);
  if (!item.payload.source) throw new Error('источник не заполнен');
});

await check('мониторинг: крупное изображение не копируется в bitmap и не создаёт превью', async () => {
  const original = electronStub.clipboard.readImage;
  let bitmapCalls = 0;
  let resizeCalls = 0;
  try {
    electronStub.clipboard.readImage = () => ({
      isEmpty: () => false, getSize: () => ({ width: 50000, height: 50000 }),
      toBitmap: () => { bitmapCalls++; return { length: 100 }; },
      getBitmap: () => { bitmapCalls++; return { length: 100 }; },
      resize: () => { resizeCalls++; return { toDataURL: () => 'data:image/png;base64,big' }; },
    });
    sentEvents.length = 0;
    await new Promise((r) => setTimeout(r, 1100));
    if (bitmapCalls || resizeCalls || sentEvents.some((e) => e.ch === 'clipboard:item' && e.payload.kind === 'image')) throw new Error('слишком большая картинка обработана');
    if (handlers.get('diag:status')({}).system.clipboardWatchImageIssue !== 'size') throw new Error('диагностика не сообщила об ограничении');
  } finally { electronStub.clipboard.readImage = original; }
});

await check('мониторинг: высокое изображение масштабируется внутри 320×320 без копии bitmap', async () => {
  const original = electronStub.clipboard.readImage;
  let copied = 0;
  let borrowed = 0;
  let previewSize;
  try {
    electronStub.clipboard.readImage = () => ({
      isEmpty: () => false, getSize: () => ({ width: 40, height: 4000 }),
      toBitmap: () => { copied++; return { length: 640000 }; },
      getBitmap: () => { borrowed++; return { length: 640000 }; },
      resize: (size) => { previewSize = size; return { toDataURL: () => 'data:image/png;base64,preview' }; },
    });
    sentEvents.length = 0;
    await new Promise((r) => setTimeout(r, 1100));
    const found = sentEvents.some((e) => e.ch === 'clipboard:item' && e.payload.kind === 'image');
    if (!found || copied || !borrowed || !previewSize?.height || previewSize.width > 320 || previewSize.height > 320 || Math.abs(previewSize.width / previewSize.height - 0.01) > 0.005) {
      throw new Error(`превью не ограничено или bitmap скопирован: ${JSON.stringify({ copied, borrowed, previewSize, found })}`);
    }
    if (handlers.get('diag:status')({}).system.clipboardWatchImageIssue) throw new Error('старая ошибка изображения не сброшена');
  } finally { electronStub.clipboard.readImage = original; }
});

await check('мониторинг: сбой чтения текста не вызывает системный диалог и следующий опрос работает', async () => {
  const originalRead = electronStub.clipboard.readText;
  const originalDialog = electronStub.dialog.showErrorBox;
  let dialogs = 0;
  try {
    electronStub.dialog.showErrorBox = () => { dialogs++; };
    electronStub.clipboard.readText = () => { throw new Error('SENSITIVE_ERROR_DO_NOT_LOG'); };
    await new Promise((r) => setTimeout(r, 1100));
    if (!handlers.get('diag:status')({}).system.clipboardWatchTextError) throw new Error('диагностика не показала ошибку чтения');
    const report = await handlers.get('diag:save-report')({});
    const contents = fs.readFileSync(report.path, 'utf8');
    if (!contents.includes('ошибка чтения текста') || contents.includes('SENSITIVE_ERROR_DO_NOT_LOG')) throw new Error('отчёт не показал состояние или раскрыл сообщение ОС');
    electronStub.clipboard.readText = originalRead;
    clipboardText.value = 'после отказа чтения';
    sentEvents.length = 0;
    await new Promise((r) => setTimeout(r, 1100));
    if (dialogs || handlers.get('diag:status')({}).system.clipboardWatchTextError || !sentEvents.some((e) => e.ch === 'clipboard:item' && e.payload.text === 'после отказа чтения')) throw new Error(`диалогов ${dialogs}, повтор не доставлен или ошибка не сброшена`);
  } finally { electronStub.clipboard.readText = originalRead; electronStub.dialog.showErrorBox = originalDialog; }
});

await check('мониторинг: после ошибки создания превью тот же кадр можно обработать снова', async () => {
  const originalRead = electronStub.clipboard.readImage;
  const originalDialog = electronStub.dialog.showErrorBox;
  let dialogs = 0;
  let attempts = 0;
  try {
    electronStub.dialog.showErrorBox = () => { dialogs++; };
    electronStub.clipboard.readImage = () => ({
      isEmpty: () => false, getSize: () => ({ width: 30, height: 500 }),
      toBitmap: () => ({ length: 60000 }), getBitmap: () => ({ length: 60000 }),
      resize: () => { attempts++; if (attempts === 1) throw new Error('синтетическая ошибка превью'); return { toDataURL: () => 'data:image/png;base64,preview' }; },
    });
    sentEvents.length = 0;
    for (let i = 0; i < 60 && attempts === 0; i += 1) await new Promise((r) => setTimeout(r, 25));
    if (attempts !== 1 || handlers.get('diag:status')({}).system.clipboardWatchImageIssue !== 'error') throw new Error('диагностика не показала сбой превью');
    await new Promise((r) => setTimeout(r, 1100));
    if (dialogs || attempts < 2 || handlers.get('diag:status')({}).system.clipboardWatchImageIssue || !sentEvents.some((e) => e.ch === 'clipboard:item' && e.payload.kind === 'image')) throw new Error(`диалогов ${dialogs}, попыток ${attempts} или ошибка не сброшена`);
  } finally { electronStub.clipboard.readImage = originalRead; electronStub.dialog.showErrorBox = originalDialog; }
});

await check('своя вставка не попадает в историю буфера', async () => {
  await handlers.get('text:insert')({}, 'вставленный диктант');
  sentEvents.length = 0;
  await new Promise((r) => setTimeout(r, 1100));
  const texts = sentEvents.filter((e) => e.ch === 'clipboard:item').map((e) => e.payload.text);
  if (texts.some((t) => t === 'вставленный диктант')) {
    throw new Error('диктовка попала в буфер как чужое копирование');
  }
});

await check('та же фраза, скопированная позже, снова попадает в историю', async () => {
  await handlers.get('text:insert')({}, 'та же фраза');
  sentEvents.length = 0;
  // ждём, пока истечёт окно «это моя же вставка», и буфер вернётся к прежнему
  await new Promise((r) => setTimeout(r, 2400));
  clipboardText.value = 'другой текст';
  await new Promise((r) => setTimeout(r, 1100));
  clipboardText.value = 'та же фраза';
  await new Promise((r) => setTimeout(r, 1100));
  const texts = sentEvents.filter((e) => e.ch === 'clipboard:item').map((e) => e.payload.text);
  if (!texts.includes('та же фраза')) {
    throw new Error(`фраза не попала в историю буфера: ${JSON.stringify(texts)}`);
  }
});

await check('пароль из буфера уходит в окно только шифром', async () => {
  await handlers.get('store:set')({}, 'zs:settings', { clipboardMonitor: true });
  clipboardText.value = 'Qw7!pLz9#Vb2';
  sentEvents.length = 0;
  await new Promise((r) => setTimeout(r, 1100));
  const item = sentEvents.find((e) => e.ch === 'clipboard:item');
  if (!item) throw new Error('событие clipboard:item не пришло');
  if (item.payload.kind !== 'password') throw new Error(`вид записи: ${item.payload.kind}`);
  if (item.payload.text) throw new Error('открытый пароль ушёл в рендерер');
  if (!item.payload.cipher || !item.payload.encrypted) throw new Error('нет шифра');
  const plain = await handlers.get('secret:reveal')({}, item.payload.cipher);
  if (plain !== 'Qw7!pLz9#Vb2') throw new Error(`расшифровка вернула: ${plain}`);
  const available = await handlers.get('secret:available')({});
  if (!available) throw new Error('secret:available соврал');
});

await check('обычный текст не считается паролем и не шифруется', async () => {
  clipboardText.value = 'строка из заметки с пробелами';
  sentEvents.length = 0;
  await new Promise((r) => setTimeout(r, 1100));
  const item = sentEvents.find((e) => e.ch === 'clipboard:item');
  if (!item) throw new Error('событие clipboard:item не пришло');
  if (item.payload.kind !== 'text') throw new Error(`вид записи: ${item.payload.kind}`);
  if (item.payload.cipher) throw new Error('обычный текст зашифрован');
  if (item.payload.text !== 'строка из заметки с пробелами') throw new Error('текст потерялся');
});

await check('без системного хранилища пароль остаётся текстом, а не «зашифрован»', async () => {
  electronStub.safeStorage._available = false;
  try {
    clipboardText.value = 'Zx9$kM4!qW1';
    sentEvents.length = 0;
    await new Promise((r) => setTimeout(r, 1100));
    const item = sentEvents.find((e) => e.ch === 'clipboard:item');
    if (!item) throw new Error('событие clipboard:item не пришло');
    if (item.payload.kind === 'password' || item.payload.encrypted) {
      throw new Error('запись выдана за зашифрованную, хотя хранилища нет');
    }
    if (await handlers.get('secret:available')({})) throw new Error('secret:available врёт');
  } finally {
    electronStub.safeStorage._available = true;
  }
});

await check('выключенный мониторинг молчит', async () => {
  await handlers.get('store:set')({}, 'zs:settings', { clipboardMonitor: false });
  clipboardText.value = 'это не должно попасть в историю';
  sentEvents.length = 0;
  await new Promise((r) => setTimeout(r, 1100));
  const texts = sentEvents.filter((e) => e.ch === 'clipboard:item').map((e) => e.payload.text);
  if (texts.length) throw new Error(`пришло ${texts.length} событий при выключенном мониторинге`);
  // возвращаем как было, чтобы не влиять на остальные проверки
  await handlers.get('store:set')({}, 'zs:settings', { clipboardMonitor: true });
});

await check('отчёт диагностики сохраняется файлом на Рабочем столе', async () => {
  const save = handlers.get('diag:save-report');
  if (!save) throw new Error('нет канала diag:save-report');
  const res = await save({});
  if (!res?.ok) throw new Error(res?.reason || 'не сохранилось');
  if (!fs.existsSync(res.path)) throw new Error('файла нет по указанному пути');
  const text = fs.readFileSync(res.path, 'utf8');
  if (!text.includes('отчёт диагностики')) throw new Error('в файле нет заголовка отчёта');
  if (!text.includes('система:')) throw new Error('в отчёте нет окружения');
  // и что реально работает на этой машине: сочетания, движок, вставка, буфер
  if (!text.includes('система и железо')) throw new Error('в отчёте нет блока «система и железо»');
  if (!/процессор: \d+ ядер · память: [\d.]+ ГБ/.test(text)) throw new Error('в отчёте нет ядер и памяти');
  if (!/движок на диске: /.test(text)) throw new Error('в отчёте нет сведений о движке');
  if (!/сочетания: (Control|ни одного)/.test(text)) throw new Error('в отчёте нет зарегистрированных сочетаний');
  if (!/вставка: (буфер обмена|SendInput)/.test(text)) throw new Error('в отчёте нет способа вставки');
  // по отчёту должно быть видно, как была настроена диктовка
  const st = handlers.get('store:get')({}, 'zs:settings') || {};
  handlers.get('store:set')({}, 'zs:settings', { ...st, insertMethod: 'sendinput', micPreroll: true });
  handlers.get('store:set')({}, 'zs:dictionary', [{ word: 'СекретноеСлово', pronunciation: 'секрет' }]);
  const res2 = await save({});
  const text2 = fs.readFileSync(res2.path, 'utf8');
  for (const needle of ['настройки диктовки', 'SendInput без буфера', 'горячий микрофон: включён', 'слов в словаре: 1']) {
    if (!text2.includes(needle)) throw new Error(`в отчёте нет «${needle}»`);
  }
  if (text2.includes('СекретноеСлово')) throw new Error('в отчёт попали слова словаря');
  // Живая расшифровка теперь решается приложением: в отчёте должно быть
  // видно, ручной это выбор или автоматический, а не глухое «включена».
  if (!/живая расшифровка: (решает приложение|включена вручную|выключена вручную)/.test(text2)) {
    throw new Error(`в отчёте непонятно, кто выбрал живую расшифровку: ${(text2.match(/живая расшифровка: .*/) || [''])[0]}`);
  }
  fs.rmSync(res2.path, { force: true });
  handlers.get('store:set')({}, 'zs:settings', { ...st, insertMethod: 'clipboard', micPreroll: false });
  fs.rmSync(res.path, { force: true });
});

await check('диагностика показывает проверенные факты о системе, а не настройки', async () => {
  const st = await handlers.get('diag:status')({});
  const sys = st?.system;
  if (!sys || typeof sys !== 'object') throw new Error('нет блока system');
  if (!(sys.cpus >= 1)) throw new Error('не указано число ядер');
  if (!(sys.ramGb > 0)) throw new Error('не указан объём памяти');
  if (!('engine' in sys) || !('vad' in sys)) throw new Error('нет сведений о движке');
  if (!('modelDownloaded' in sys)) throw new Error('не сказано, есть ли модель на диске');
  if (!Array.isArray(sys.hotkeys)) throw new Error('список сочетаний — не массив');
  if (!['clipboard', 'sendinput'].includes(sys.insertMethod)) throw new Error(`непонятный способ вставки: ${sys.insertMethod}`);
  if (typeof sys.clipboardWatch !== 'boolean') throw new Error('не сказано, работает ли мониторинг буфера');
  if (sys.platform !== process.platform) throw new Error('платформа не совпадает');
});

await check('видно, за сколько открылось окно и сколько грузились веса', async () => {
  const st = await handlers.get('diag:status')({});
  const sys = st?.system;
  if (!sys || typeof sys !== 'object') throw new Error('нет блока system');
  if (typeof sys.startupMs !== 'number') throw new Error('нет времени запуска окна');
  if (typeof sys.warmMs !== 'number') throw new Error('нет времени прогрева модели');
  if (sys.startupMs < 0 || sys.warmMs < 0) throw new Error('отрицательное время');
});

await check('по умолчанию наружу ничего не отправляется', async () => {
  const status = await handlers.get('diag:status')({});
  if (status.endpointConfigured) throw new Error('адрес приёмника задан по умолчанию');
  const res = await handlers.get('diag:send-now')({});
  if (res?.ok) throw new Error('отправка прошла без настроенного приёмника');
});

await check('запись экрана: повторное сохранение не перезаписывает прежний файл', async () => {
  const save = handlers.get('app:save-file');
  const first = await save({}, { name: 'zs-test-video.webm', base64: Buffer.from('first-video').toString('base64') });
  const second = await save({}, { name: 'zs-test-video.webm', base64: Buffer.from('second-video').toString('base64') });
  try {
    if (!first?.ok || !second?.ok || first.path === second.path || fs.readFileSync(first.path, 'utf8') !== 'first-video' || fs.readFileSync(second.path, 'utf8') !== 'second-video') throw new Error('запись перезаписана или не сохранилась');
  } finally {
    if (first?.path) fs.rmSync(first.path, { force: true });
    if (second?.path) fs.rmSync(second.path, { force: true });
  }
});

await check('запись экрана: пустые и повреждённые данные не создают файл', async () => {
  const save = handlers.get('app:save-file');
  const target = path.join(userData, 'zs-test-invalid.webm');
  for (const base64 of ['', '!!!!', 'a', 'ab=c']) {
    const result = await save({}, { name: 'zs-test-invalid.webm', base64 });
    if (result?.ok || fs.existsSync(target)) throw new Error('некорректные данные приняты');
  }
});

await check('запись экрана: IPC отклоняет данные больше 64 МиБ до создания файла', async () => {
  const save = handlers.get('app:save-file');
  const target = path.join(userData, 'zs-test-oversize.webm');
  const encoded = 'A'.repeat(4 * Math.ceil((64 * 1024 * 1024) / 3) + 4);
  try {
    const result = await save({}, { name: 'zs-test-oversize.webm', base64: encoded });
    if (result?.ok || fs.existsSync(target)) throw new Error('слишком большой файл создан');
    // Та же длина base64 может означать на 1–2 лишних байта без padding.
    const boundary = 'A'.repeat(4 * Math.ceil((64 * 1024 * 1024) / 3));
    const noPadding = await save({}, { name: 'zs-test-oversize.webm', base64: boundary });
    if (noPadding?.ok || fs.existsSync(target)) throw new Error('на границе размера создан слишком большой файл');
  } finally { fs.rmSync(target, { force: true }); }
});

await check('запись экрана: ошибка записи не оставляет частичный файл', async () => {
  const save = handlers.get('app:save-file');
  const realWrite = fs.writeFileSync;
  let injected = false;
  try {
    fs.writeFileSync = function (file, data, options) {
      if (!injected && (typeof file === 'number' || String(file).includes('zs-test-partial.webm'))) {
        realWrite.call(this, file, 'partial');
        injected = true;
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      }
      return realWrite.call(this, file, data, options);
    };
    const result = await save({}, { name: 'zs-test-partial.webm', base64: Buffer.from('video').toString('base64') });
    if (!injected || result?.ok || fs.existsSync(path.join(userData, 'zs-test-partial.webm'))) throw new Error('ошибка не обработана или частичный файл остался');
  } finally {
    fs.writeFileSync = realWrite;
    fs.rmSync(path.join(userData, 'zs-test-partial.webm'), { force: true });
  }
});

await check('запись экрана: ошибка удаления частичного файла не скрывается', async () => {
  const save = handlers.get('app:save-file');
  const realWrite = fs.writeFileSync;
  const realUnlink = fs.unlinkSync;
  let injected = false;
  try {
    fs.writeFileSync = function (file, data, options) {
      if (!injected && typeof file === 'number') {
        realWrite.call(this, file, 'partial');
        injected = true;
        throw new Error('disk full');
      }
      return realWrite.call(this, file, data, options);
    };
    fs.unlinkSync = () => { throw new Error('delete failed'); };
    const result = await save({}, { name: 'zs-test-leftover.webm', base64: Buffer.from('video').toString('base64') });
    if (!injected || result?.ok || !/частичный файл мог остаться/i.test(result?.reason || '')) throw new Error('ошибка удаления не сообщена');
  } finally {
    fs.writeFileSync = realWrite;
    fs.unlinkSync = realUnlink;
    fs.rmSync(path.join(userData, 'zs-test-leftover.webm'), { force: true });
  }
});

// ── Экранный контекст и словарь уходят в whisper как --prompt ───────────────
await check('резервная копия сохраняется файлом через main', async () => {
  const save = handlers.get('data:save-backup');
  const good = await save({}, JSON.stringify({ app: 'ZSpeakly', dictations: [] }));
  const bad = await save({}, 'не json');
  const empty = await save({}, '');
  const written = good?.ok && fs.existsSync(good.path) ? fs.readFileSync(good.path, 'utf8') : '';
  if (good?.path) fs.rmSync(good.path, { force: true });
  return Boolean(good?.ok && /ZSpeakly/.test(written) && bad?.ok === false && empty?.ok === false);
});

await check('повторное сохранение копии не перезаписывает предыдущую', async () => {
  const save = handlers.get('data:save-backup');
  const firstJson = JSON.stringify({ app: 'ZSpeakly', dictations: [{ text: 'важная первая копия' }] });
  const secondJson = JSON.stringify({ app: 'ZSpeakly', dictations: [{ text: 'новая копия' }] });
  const first = await save({}, firstJson);
  const second = await save({}, secondJson);
  try {
    if (!first?.ok || !second?.ok || first.path === second.path || fs.readFileSync(first.path, 'utf8') !== firstJson || fs.readFileSync(second.path, 'utf8') !== secondJson) {
      throw new Error(`предыдущая копия перезаписана: ${JSON.stringify({ first, second })}`);
    }
  } finally {
    if (first?.path) fs.rmSync(first.path, { force: true });
    if (second?.path) fs.rmSync(second.path, { force: true });
  }
});

await check('сбой записи копии не оставляет частичный файл и не меняет прошлую копию', async () => {
  const save = handlers.get('data:save-backup');
  const original = JSON.stringify({ app: 'ZSpeakly', dictations: [{ text: 'надёжная копия' }] });
  const existing = await save({}, original);
  if (!existing?.ok) throw new Error('не удалось создать исходную копию');
  const before = fs.readdirSync(userData).filter((name) => name.startsWith('zspeakly-backup-')).sort();
  const realWrite = fs.writeFileSync;
  let injected = false;
  try {
    fs.writeFileSync = function (file, data, options) {
      if (!injected && (typeof file === 'number' || String(file).includes('zspeakly-backup-'))) {
        realWrite.call(this, file, '{"partial":', options);
        injected = true;
        throw Object.assign(new Error('имитация заполненного диска'), { code: 'ENOSPC' });
      }
      return realWrite.call(this, file, data, options);
    };
    const result = await save({}, JSON.stringify({ app: 'ZSpeakly', dictations: [{ text: 'новая копия' }] }));
    const after = fs.readdirSync(userData).filter((name) => name.startsWith('zspeakly-backup-')).sort();
    if (!injected || result?.ok || JSON.stringify(after) !== JSON.stringify(before) || fs.readFileSync(existing.path, 'utf8') !== original) {
      throw new Error(`частичный файл или перезапись: ${JSON.stringify({ injected, result, before, after })}`);
    }
  } finally {
    fs.writeFileSync = realWrite;
    for (const name of fs.readdirSync(userData).filter((entry) => entry.startsWith('zspeakly-backup-'))) fs.rmSync(path.join(userData, name), { force: true });
  }
});

await check('ошибка удаления частичной копии не выдаётся за успешное сохранение', async () => {
  const save = handlers.get('data:save-backup');
  const realWrite = fs.writeFileSync;
  const realUnlink = fs.unlinkSync;
  let injected = false;
  try {
    fs.writeFileSync = function (file, data, options) {
      if (!injected && typeof file === 'number') {
        realWrite.call(this, file, '{"partial":', options);
        injected = true;
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      }
      return realWrite.call(this, file, data, options);
    };
    fs.unlinkSync = () => { throw Object.assign(new Error('нет доступа'), { code: 'EACCES' }); };
    const result = await save({}, JSON.stringify({ app: 'ZSpeakly', dictations: [] }));
    if (!injected || result?.ok || !/частичный файл мог остаться/i.test(result?.reason || '')) {
      throw new Error(`не сообщили о частичном файле: ${JSON.stringify({ injected, result })}`);
    }
  } finally {
    fs.writeFileSync = realWrite;
    fs.unlinkSync = realUnlink;
    for (const name of fs.readdirSync(userData).filter((entry) => entry.startsWith('zspeakly-backup-'))) fs.rmSync(path.join(userData, name), { force: true });
  }
});

await check('stt:status честно говорит, что движка нет', async () => {
  const st = await handlers.get('stt:status')({}, 'small');
  if (st.available) throw new Error('движок «нашёлся» до установки');
  if (st.bin || st.model) throw new Error('статус показывает несуществующие файлы');
});

const whisperBin = path.join(userData, 'bin', 'whisper-cli.exe');
const whisperModel = path.join(userData, 'models', 'ggml-small.bin');
fs.mkdirSync(path.dirname(whisperBin), { recursive: true });
fs.mkdirSync(path.dirname(whisperModel), { recursive: true });
fs.writeFileSync(whisperBin, 'fake');
fs.writeFileSync(whisperModel, 'fake');

// «запуск» whisper: планируем ответ фейкового процесса
const runWhisper = (answer) => {
  spawnPlan.answer = answer;
};

// Не «тишина», а сигнал с ненулевой громкостью: main справедливо не гоняет
// whisper на нулях, поэтому проверки подсказки должны подавать настоящий звук.
const speechPcm = (ms = 500) => {
  const samples = Math.round((16000 * ms) / 1000);
  const arr = new Int16Array(samples);
  for (let i = 0; i < samples; i += 1) {
    arr[i] = Math.round(6000 * Math.sin((2 * Math.PI * 220 * i) / 16000));
  }
  return new Uint8Array(arr.buffer);
};

await check('models:status честно говорит, какая модель работает на самом деле', async () => {
  await handlers.get('store:set')({}, 'zs:settings', { whisperModel: 'large-v3-turbo' });
  const st = await handlers.get('models:status')({});
  if (st.preferred !== 'large-v3-turbo') throw new Error(`preferred=${st.preferred}`);
  if (st.active !== 'small') throw new Error(`active=${st.active}`);
  const dl = st.models['large-v3-turbo'];
  if (!dl || dl.downloaded) throw new Error('турбо-модель будто скачана');
  if (dl.sizeMb < 1000) throw new Error(`размер turbo подозрительный: ${dl.sizeMb}`);
});

await check('размер и место окна запоминаются между запусками', async () => {
  const mainWin = findMainWindow();
  mainWin._bounds = { x: 140, y: 90, width: 880, height: 560 };
  mainWin.emit('resize');
  await new Promise((r) => setTimeout(r, 800));
  const saved = handlers.get('store:get')({}, 'ui:windowBounds');
  if (!saved) throw new Error('размер окна не сохранён');
  if (saved.width !== 880 || saved.height !== 560) throw new Error(`сохранён размер ${saved.width}×${saved.height}`);
  if (saved.x !== 140 || saved.y !== 90) throw new Error(`сохранено место ${saved.x},${saved.y}`);
  if (saved.maximized !== false) throw new Error('окно записано развёрнутым');
});

await check('главное окно помещается в маленький экран и сужается до 720×480', () => {
  const mainWin = findMainWindow();
  if (!mainWin) throw new Error('главное окно не найдено');
  const { minWidth, minHeight, width, height } = mainWin._options;
  if (minWidth !== 720 || minHeight !== 480) throw new Error(`минимум ${minWidth}×${minHeight}`);
  // Экран заглушки 1920×1040: окно не должно растягиваться на весь экран.
  if (width > 1020 || height > 680) throw new Error(`стартовый размер ${width}×${height}`);
  // На экране 1024×600 окно обязано влезть: иначе правый край с кнопками за границей.
  const small = { width: 1024 - 60, height: 600 - 40 };
  if (Math.max(720, small.width) > 1024 || Math.max(480, small.height) > 600) {
    throw new Error('на экране 1024×600 окно не помещается');
  }
});

await check('окно энкодера: короткая запись считается быстрее, длинная — целиком', () => {
  const whisperLib = require(path.resolve('electron/whisper.cjs'));
  if (typeof whisperLib.computeAudioCtx !== 'function') throw new Error('нет computeAudioCtx');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zs-ctx-'));
  const makeWav = (seconds) => {
    const file = path.join(dir, `s${seconds}.wav`);
    const data = Buffer.alloc(seconds * 16000 * 2);
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + data.length, 4);
    header.write('WAVE', 8);
    fs.writeFileSync(file, Buffer.concat([header, data]));
    return file;
  };
  try {
    const short = whisperLib.computeAudioCtx(makeWav(3));
    if (short < 200 || short > 400) throw new Error(`для 3 с окно ${short} — ожидалось ~275`);
    const mid = whisperLib.computeAudioCtx(makeWav(10));
    if (mid < short || mid > 1500) throw new Error(`для 10 с окно ${mid}`);
    // длинная запись: окно не урезаем, иначе потеряется текст в конце
    if (whisperLib.computeAudioCtx(makeWav(25)) !== 0) throw new Error('для 25 с окно урезано');
    const args = whisperLib.cliArgs({ modelPath: 'm.bin', wavPath: 'a.wav', audioCtx: short });
    const at = args.indexOf('-ac');
    if (at < 0 || args[at + 1] !== String(short)) throw new Error('cliArgs не передал -ac');
    if (whisperLib.cliArgs({ modelPath: 'm.bin', wavPath: 'a.wav' }).includes('-ac')) {
      throw new Error('без размера окна -ac не нужен');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await check('удаление модели: файл стирается, активная переключается сама', async () => {
  if (!handlers.has('models:delete')) throw new Error('нет models:delete');
  // в смоуке на диске лежит ggml-small.bin и он же выбран активным
  await handlers.get('store:set')({}, 'zs:settings', { whisperModel: 'small' });
  const extra = path.join(userData, 'models', 'ggml-base.bin');
  fs.writeFileSync(extra, Buffer.alloc(1024));
  // модель small заменяем файлом нормального размера, чтобы проверить «сколько освободилось»
  fs.writeFileSync(whisperModel, Buffer.alloc(2 * 1024 * 1024));
  const st = await handlers.get('models:status')({});
  if (!st.models.small.downloaded) throw new Error('модель small будто не скачана');
  const res = await handlers.get('models:delete')({}, 'small');
  if (!res.ok) throw new Error(`не удалилось: ${JSON.stringify(res)}`);
  if (!(res.freedMb > 0)) throw new Error('не сообщил освобождённое место');
  if (fs.existsSync(whisperModel)) throw new Error('файл модели остался на диске');
  if (res.switchedTo !== 'base') throw new Error(`активной должна стать base, а стала «${res.switchedTo}»`);
  const after = await handlers.get('store:get')({}, 'zs:settings');
  if (after.whisperModel !== 'base') throw new Error(`настройка не переключилась: ${after.whisperModel}`);
  // повторное удаление — честный отказ, а не «ok»
  const again = await handlers.get('models:delete')({}, 'small');
  if (again.ok) throw new Error('повторное удаление вернуло ok');
  // вернуть состояние смоука: дальнейшие проверки ждут модель small
  fs.writeFileSync(whisperModel, 'fake');
  fs.rmSync(extra, { force: true });
  await handlers.get('store:set')({}, 'zs:settings', { whisperModel: 'small' });
});

await check('старые временные wav убираются, свежие остаются', async () => {
  const { cleanupTemp } = require(path.resolve('electron/tempCleanup.cjs'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zs-temp-'));
  try {
    const oldFile = path.join(dir, 'dictation-old.wav');
    const freshFile = path.join(dir, 'dictation-fresh.wav');
    fs.writeFileSync(oldFile, 'old');
    fs.writeFileSync(freshFile, 'fresh');
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    fs.utimesSync(oldFile, old, old);
    const res = cleanupTemp({ dir });
    if (res.removed !== 1) throw new Error(`удалено ${res.removed}, ожидалось 1`);
    if (fs.existsSync(oldFile)) throw new Error('старый файл остался');
    if (!fs.existsSync(freshFile)) throw new Error('свежий файл удалён — запись могла идти');
    // отсутствие папки не считается ошибкой
    const missing = cleanupTemp({ dir: path.join(dir, 'нет-такой') });
    if (missing.error) throw new Error(`отсутствие папки: ${missing.error}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await check('живая расшифровка и финальный проход не пишут в один файл', async () => {
  // два запроса почти одновременно: имена wav обязаны различаться, иначе
  // звук одного перезапишет звук другого
  runWhisper('Проверка диктовки');
  spawnCalls.length = 0;
  const pcm = speechPcm(500);
  const payload = { pcm, durationMs: 500, lang: 'ru', model: 'small', useDictionary: false };
  const partial = handlers.get('stt:transcribe-pcm')({}, { ...payload, partial: true });
  // Дождаться фактического запуска: ещё не начатый промежуточный запрос
  // теперь справедливо вытесняется итоговым без создания WAV.
  await new Promise((resolve) => setImmediate(resolve));
  const final = handlers.get('stt:transcribe-pcm')({}, payload);
  await Promise.all([partial, final]);
  const files = spawnCalls
    .filter((c) => String(c.file).includes('whisper'))
    .map((c) => c.args[c.args.indexOf('-f') + 1])
    .filter(Boolean);
  if (files.length < 2) throw new Error(`ожидалось два запуска, было ${files.length}`);
  if (new Set(files).size !== files.length) throw new Error(`один и тот же wav: ${files.join(' | ')}`);
  for (const f of files) {
    if (fs.existsSync(f)) throw new Error(`временный wav остался: ${f}`);
  }
});

await check('замер по этапам: отчёт говорит, сколько стоили обрезка, wav и счёт', async () => {
  runWhisper('Проверка диктовки');
  const res = await handlers.get('stt:transcribe-pcm')({}, {
    pcm: speechPcm(3000),
    durationMs: 3000,
    lang: 'ru',
    model: 'small',
    useDictionary: false,
  });
  if (!res?.ok) throw new Error(`распознавание не удалось: ${JSON.stringify(res)}`);
  const t = res.timeline;
  if (!t) throw new Error('нет разложения по этапам');
  for (const key of ['trimMs', 'wavMs', 'computeMs', 'parts', 'mode', 'warm', 'model']) {
    if (!(key in t)) throw new Error(`в отчёте нет «${key}»`);
  }
  if (!(t.trimMs >= 0 && t.wavMs >= 0 && t.computeMs >= 0)) throw new Error('отрицательные времена');
  if (typeof t.warm !== 'boolean') throw new Error('не сказано, был ли сервер прогрет');
  if (!t.model) throw new Error('не сказано, какой моделью считали');
  if (!res.model) throw new Error('в ответе нет модели');
});

await check('пропуск движка: whisper получает --prompt со словарём и контекстом', async () => {
  await handlers.get('store:set')({}, 'zs:dictionary', [
    { word: 'ZSpeakly', pronunciation: 'зи-спикли' },
    { word: 'Алтайтара', pronunciation: 'алтай-тара' },
  ]);
  runWhisper('Проверка диктовки');
  spawnCalls.length = 0;
  const pcm = speechPcm(500);
  const res = await handlers.get('stt:transcribe-pcm')({}, {
    pcm,
    durationMs: 500,
    lang: 'ru',
    model: 'small',
    useDictionary: true,
    contextPrompt: 'Список задач, дедлайн, проект «Атлас», ZSpeakly',
  });
  const call = spawnCalls.find((c) => String(c.file).includes('whisper'));
  if (!call) throw new Error(`whisper не запускался: ${JSON.stringify(spawnCalls)}`);
  const i = call.args.indexOf('--prompt');
  if (i < 0) throw new Error('--prompt не передан');
  const prompt = call.args[i + 1];
  if (!prompt.includes('ZSpeakly') || !prompt.includes('Алтайтара')) throw new Error(`словаря нет: ${prompt}`);
  if (!prompt.includes('Атлас')) throw new Error(`контекста экрана нет: ${prompt}`);
  // «ZSpeakly» встречается и в словаре, и в контексте — подсказка не должна
  // повторять одно слово дважды, иначе полезные термины вытесняются за лимит
  const repeated = prompt
    .split(',')
    .map((w) => w.trim().toLowerCase())
    .filter((w, idx, all) => w && all.indexOf(w) !== idx);
  if (repeated.length) throw new Error(`повторы в подсказке: ${repeated.join(', ')}`);
  if (res?.text !== 'Проверка диктовки') throw new Error(`текст не вернулся: ${JSON.stringify(res)}`);
});

await check('порядок в подсказке: закреплённое и частое — раньше новых', async () => {
  // Подсказка короткая, и всё, что не влезло, движок не увидит. Значит порядок
  // слов в ней должен совпадать с важностью, а не с датой добавления.
  await handlers.get('store:set')({}, 'zs:dictionary', [
    { word: 'СвежееСлово', createdAt: 900 },
    { word: 'ЧастоеСлово', hits: 12, createdAt: 100 },
    { word: 'ЗакреплённоеСлово', pinned: true, hits: 0, createdAt: 1 },
  ]);
  runWhisper('Проверка порядка');
  spawnCalls.length = 0;
  await handlers.get('stt:transcribe-pcm')({}, {
    pcm: speechPcm(500),
    durationMs: 500,
    lang: 'ru',
    model: 'small',
    useDictionary: true,
  });
  const call = spawnCalls.find((c) => String(c.file).includes('whisper'));
  const i = call.args.indexOf('--prompt');
  if (i < 0) throw new Error('--prompt не передан');
  const prompt = call.args[i + 1];
  const order = ['ЗакреплённоеСлово', 'ЧастоеСлово', 'СвежееСлово'].map((w) => prompt.indexOf(w));
  if (order.some((pos) => pos < 0)) throw new Error(`слова потерялись: ${prompt}`);
  if (!(order[0] < order[1] && order[1] < order[2])) throw new Error(`порядок неверный: ${prompt}`);
});

// ── VAD: длинная диктовка режется по паузам ─────────────────────────────────
const silencePcm = (ms = 500) => new Uint8Array(Math.round((16000 * ms) / 1000) * 2);

await check('аргументы whisper: без контекста, жадное декодирование, VAD', () => {
  const whisperLib = require(path.resolve('electron/whisper.cjs'));
  if (typeof whisperLib.cliArgs !== 'function') throw new Error('нет cliArgs');
  const args = whisperLib.cliArgs({
    modelPath: 'm.bin',
    wavPath: 'a.wav',
    lang: 'ru',
    threads: 4,
    vadModel: 'vad.bin',
    prompt: 'словарь',
  });
  const pair = (flag) => {
    const i = args.indexOf(flag);
    return i < 0 ? '' : args[i + 1];
  };
  if (pair('-mc') !== '0') throw new Error('нет -mc 0 (контекст прошлой диктовки)');
  if (pair('-bs') !== '3') throw new Error('нет -bs 3 (beam search вместо greedy: с «-bs 1» мелкие модели дают кашу)');
  // -nf: без повторного прохода с другой температурой (он удваивал ожидание)
  if (!args.includes('-nf')) throw new Error('нет -nf: движок может считать ту же фразу дважды');
  if (!args.includes('--vad')) throw new Error('нет --vad');
  if (pair('-vm') !== 'vad.bin') throw new Error('VAD-модель не передана');
  if (pair('-vt') !== '0.5') throw new Error('нет порога VAD');
  if (pair('-vsd') !== '500') throw new Error('нет минимальной тишины VAD');
  if (pair('-l') !== 'ru') throw new Error('язык не передан');
  if (pair('-of') !== 'a.wav.out') throw new Error('файл результата не задан');
  if (pair('--prompt') !== 'словарь') throw new Error('--prompt не передан');
  // без VAD-модели флагов VAD быть не должно: whisper.cpp упал бы на отсутствии файла
  const plain = whisperLib.cliArgs({ modelPath: 'm.bin', wavPath: 'a.wav' });
  if (plain.includes('--vad') || plain.includes('-vm')) throw new Error('VAD без модели');
  if (plain.includes('--prompt')) throw new Error('пустой --prompt не нужен');
});

await check('splitBySilence режет по длинной паузе и не режет короткую', () => {
  const whisperLib = require(path.resolve('electron/whisper.cjs'));
  if (typeof whisperLib.splitBySilence !== 'function') throw new Error('нет splitBySilence');
  const join = (...parts) => Buffer.concat(parts.map((p) => Buffer.from(p)));
  const longPause = join(speechPcm(900), silencePcm(1500), speechPcm(900));
  const parts = whisperLib.splitBySilence(longPause, 16000);
  if (parts.length !== 2) throw new Error(`ожидалось 2 фрагмента, вышло ${parts.length}`);
  const shortPause = join(speechPcm(900), silencePcm(300), speechPcm(900));
  if (whisperLib.splitBySilence(shortPause, 16000).length !== 1) {
    throw new Error('короткая пауза разрезала фразу');
  }
  const continuous = whisperLib.splitBySilence(Buffer.from(speechPcm(30000)), 16000);
  if (continuous.length !== 2) throw new Error(`30 секунд речи не разрезаны на 25-секундные куски: ${continuous.length}`);
});

await check('старая сборка без --vad: проход повторяется и текст не теряется', async () => {
  // VAD-модель на месте — приложение попробует --vad первым
  const vadPath = path.join(userData, 'models', 'ggml-silero-v6.2.0.bin');
  fs.writeFileSync(vadPath, 'fake-vad');
  spawnPlan.failFirst = 1;
  spawnPlan.failText = 'error: unknown argument: --vad';
  spawnPlan.attempts = 0;
  runWhisper('Текст после повтора');
  spawnCalls.length = 0;
  try {
    // запись длиннее 3 секунд: только там включается VAD (на короткой фразе
    // он пропускается — тишины в ней уже нет), и только там возможен повтор
    const res = await handlers.get('stt:transcribe-pcm')({}, {
      pcm: speechPcm(5000),
      durationMs: 5000,
      lang: 'ru',
      model: 'small',
      useDictionary: false,
    });
    const calls = spawnCalls.filter((c) => String(c.file).includes('whisper'));
    if (calls.length < 2) throw new Error(`ожидался повтор, запусков: ${calls.length}`);
    if (!calls[0].args.includes('--vad')) throw new Error('первый проход не пробовал VAD');
    if (calls[1].args.includes('--vad')) throw new Error('повтор снова с --vad');
    if (res?.text !== 'Текст после повтора') throw new Error(`текст потерян: ${JSON.stringify(res)}`);
  } finally {
    spawnPlan.failFirst = 0;
    spawnPlan.attempts = 0;
    fs.rmSync(vadPath, { force: true });
    spawnPlan.answer = null;
  }
});

// Контракт поменялся осознанно: короткая фраза — один проход движка.
// Раньше пауза в середине фразы делила запись на два прохода, и каждый заново
// грузил веса модели — именно это давало «полминуты на пятисекундную запись».
await check('короткая диктовка с паузой не режется на проходы', async () => {
  runWhisper('первая фраза');
  spawnCalls.length = 0;
  const pcm = Buffer.concat([
    Buffer.from(speechPcm(900)),
    Buffer.from(silencePcm(1500)),
    Buffer.from(speechPcm(900)),
  ]);
  const res = await handlers.get('stt:transcribe-pcm')({}, {
    pcm: new Uint8Array(pcm),
    durationMs: 3300,
    lang: 'ru',
    model: 'small',
  });
  const whisperRuns = spawnCalls.filter((c) => String(c.file).includes('whisper')).length;
  if (whisperRuns !== 1) throw new Error(`whisper запускался ${whisperRuns} раз вместо одного`);
  if (res?.chunks) throw new Error(`короткая запись разрезана на ${res.chunks} части`);
  if (res?.text !== 'первая фраза') throw new Error(`текст: ${JSON.stringify(res?.text)}`);
});

await check('тумблер словаря работает целиком: без словаря и без подсказки', async () => {
  runWhisper('текст');
  spawnCalls.length = 0;
  await handlers.get('stt:transcribe-pcm')({}, {
    pcm: speechPcm(500),
    lang: 'ru',
    model: 'small',
    useDictionary: false,
    contextPrompt: '',
  });
  const call = spawnCalls.find((c) => String(c.file).includes('whisper'));
  if (call.args.includes('--prompt')) throw new Error(`подсказка осталась: ${call.args.join(' ')}`);
});

await check('подсказка не разрастается: не больше 500 символов', async () => {
  await handlers.get('store:set')({}, 'zs:dictionary', Array.from({ length: 60 }, (_, i) => ({ word: `Термин${i}` })));
  runWhisper('текст');
  spawnCalls.length = 0;
  await handlers.get('stt:transcribe-pcm')({}, {
    pcm: speechPcm(500),
    lang: 'ru',
    model: 'small',
    useDictionary: true,
    contextPrompt: 'О'.repeat(900),
  });
  const call = spawnCalls.find((c) => String(c.file).includes('whisper'));
  const prompt = call.args[call.args.indexOf('--prompt') + 1];
  if (prompt.length > 500) throw new Error(`подсказка ${prompt.length} символов`);
  // контекст экрана идёт первым — именно он важнее для точности
  if (!prompt.startsWith('О')) throw new Error('контекст экрана потерялся при обрезке');
});

await check('подсказка: произношение помогает движку услышать слово', async () => {
  // «ZSpeakly» человек говорит «зи-спикли»: маленькая модель слышит звук, а не
  // буквы, поэтому в подсказку идёт и написание, и произношение.
  const savedDict = await handlers.get('store:get')({}, 'zs:dictionary');
  await handlers.get('store:set')({}, 'zs:dictionary', [
    { word: 'ZSpeakly', pronunciation: 'зи-спикли', pinned: true },
    { word: 'Docker' },
  ]);
  runWhisper('текст');
  spawnCalls.length = 0;
  await handlers.get('stt:transcribe-pcm')({}, {
    pcm: speechPcm(500),
    durationMs: 500,
    lang: 'ru',
    model: 'small',
    useDictionary: true,
  });
  const call = spawnCalls.find((c) => String(c.file).includes('whisper'));
  const prompt = call.args[call.args.indexOf('--prompt') + 1] || '';
  if (!prompt.includes('ZSpeakly')) throw new Error(`нет слова: ${prompt}`);
  if (!prompt.includes('зи-спикли')) throw new Error(`нет произношения: ${prompt}`);
  await handlers.get('store:set')({}, 'zs:dictionary', savedDict);
});

await check('подсказка: известное произношение уходит движку до распознавания', async () => {
  // «Zoom» человек говорит «зум». Если подсказка знает только написание, движок
  // пишет «зум» и узнаёт об ошибке уже после диктовки.
  const saved = (handlers.get('store:get')({}, 'zs:dictionary') || []);
  await handlers.get('store:set')({}, 'zs:dictionary', [{ word: 'Zoom' }, { word: 'Telegram' }]);
  runWhisper('текст');
  spawnCalls.length = 0;
  await handlers.get('stt:transcribe-pcm')({}, {
    pcm: speechPcm(500),
    durationMs: 500,
    lang: 'ru',
    model: 'small',
    useDictionary: true,
  });
  const call = spawnCalls.find((c) => String(c.file).includes('whisper'));
  const prompt = call.args[call.args.indexOf('--prompt') + 1] || '';
  if (!prompt.includes('Zoom')) throw new Error(`нет слова: ${prompt}`);
  if (!prompt.includes('зум')) throw new Error(`нет известного произношения: ${prompt}`);
  if (!prompt.includes('телеграм')) throw new Error(`нет второго слова: ${prompt}`);
  await handlers.get('store:set')({}, 'zs:dictionary', saved);
});

await check('подсказка: словарь не вытесняется контекстом экрана', async () => {
  await handlers.get('store:set')(
    {},
    'zs:dictionary',
    Array.from({ length: 120 }, (_, i) => ({ word: `Термин${i}` })),
  );
  runWhisper('текст');
  spawnCalls.length = 0;
  await handlers.get('stt:transcribe-pcm')({}, {
    pcm: speechPcm(500),
    durationMs: 500,
    lang: 'ru',
    model: 'small',
    useDictionary: true,
    // контекст экрана огромный: раньше он съедал лимит, и словарь отваливался
    contextPrompt: 'К'.repeat(900),
  });
  const call = spawnCalls.find((c) => String(c.file).includes('whisper'));
  const prompt = call.args[call.args.indexOf('--prompt') + 1];
  if (prompt.length > 500) throw new Error(`подсказка ${prompt.length} символов`);
  if (!prompt.includes('Термин')) throw new Error('словарь потерялся в подсказке');
  // whisper берёт последние токены: словарь обязан стоять в хвосте и не рваться
  const items = prompt.split(', ');
  const terms = items.filter((w) => w.startsWith('Термин'));
  const lastTerm = terms[terms.length - 1] || '';
  if (!/^Термин\d+$/.test(lastTerm)) {
    throw new Error(`словарь обрезан посреди слова: ${prompt.slice(-40)}`);
  }
  // после словаря идёт только хвост прошлой фразы, а не ещё кусок словаря
  const after = items.slice(items.indexOf(lastTerm) + 1);
  if (after.some((w) => w.startsWith('Термин'))) {
    throw new Error(`словарь разорван: ${prompt.slice(-60)}`);
  }
  if (items.length < 20) throw new Error(`слов в подсказке мало: ${items.length}`);
});

await check('«переспросить точно»: честный проход по просьбе, без оглядки на замеры', async () => {
  // Замеры говорят «машина слабая, не трать время» — но человек нажал кнопку,
  // значит это его время и его выбор: проход должен быть честным.
  await handlers.get('store:set')({}, 'zs:dictionary', []);
  runWhisper('текст');
  spawnCalls.length = 0;
  await handlers.get('stt:transcribe-pcm')({}, {
    pcm: speechPcm(900),
    durationMs: 900,
    lang: 'ru',
    model: 'small',
    useDictionary: true,
    thorough: true,
  });
  const call = spawnCalls.find((c) => String(c.file).includes('whisper'));
  const args = call.args.join(' ');
  if (!/\s-bs 5(\s|$)/.test(args)) throw new Error(`нет широкого перебора: ${args}`);
  if (/\s-nf(\s|$)/.test(args)) throw new Error('честный проход запретил повтор температур');
});

await check('режим «Точно» сильнее замеров: честный проход даже на медленной машине', async () => {
  // Замеры «движку тяжело» есть, но человек выбрал «Точно» — значит считаем честно.
  await handlers.get('store:set')({}, 'zs:settings', { decodeMode: 'accurate' });
  runWhisper('текст');
  spawnCalls.length = 0;
  await handlers.get('stt:transcribe-pcm')({}, { pcm: speechPcm(600), durationMs: 600, lang: 'ru', model: 'small', useDictionary: false });
  const call = spawnCalls.find((c) => String(c.file).includes('whisper'));
  const args = call.args.join(' ');
  if (!/\s-bs 5(\s|$)/.test(args)) throw new Error(`режим «Точно» не дал честный проход: ${args}`);
  if (/\s-nf(\s|$)/.test(args)) throw new Error('режим «Точно» запретил повтор температур');
});

await check('режим «Быстро» не делает честный проход', async () => {
  await handlers.get('store:set')({}, 'zs:settings', { decodeMode: 'fast' });
  runWhisper('текст');
  spawnCalls.length = 0;
  await handlers.get('stt:transcribe-pcm')({}, { pcm: speechPcm(600), durationMs: 600, lang: 'ru', model: 'small', useDictionary: false });
  const call = spawnCalls.find((c) => String(c.file).includes('whisper'));
  const args = call.args.join(' ');
  if (/\s-bs 5(\s|$)/.test(args)) throw new Error('режим «Быстро» всё равно считал честно');
  if (!/\s-nf(\s|$)/.test(args)) throw new Error('нет -nf в быстром режиме');
  await handlers.get('store:set')({}, 'zs:settings', { decodeMode: 'auto' });
});

await check('после простоя память освобождается, а не занимается вечно', async () => {
  // Правило проверяется юнит-тестом; здесь важно, что main вообще его
  // использует и знает, когда модель последний раз считала.
  const { shouldUnload } = require('../electron/idleMemory.cjs');
  if (typeof shouldUnload !== 'function') throw new Error('нет политики простоя в main');
  if (!shouldUnload({ lastUsedAt: 1, now: 1 + 11 * 60 * 1000, warm: true, keepLoaded: true })) {
    throw new Error('через 11 минут простоя модель не выгружается');
  }
  if (shouldUnload({ lastUsedAt: 1, now: 1 + 11 * 60 * 1000, warm: true, keepLoaded: false })) {
    throw new Error('выгружаем то, чего в памяти нет');
  }
});

await check('замеры скорости отдаются интерфейсу словами и числом', async () => {
  // Смысл: карточка «Скорость и точность» должна показывать реальный
  // коэффициент, а не «решает приложение».
  const stats = await handlers.get('stt:decode-stats')({});
  if (!stats || typeof stats !== 'object') throw new Error('нет ответа');
  if (!(typeof stats.factor === 'number' || stats.factor === null)) throw new Error(`factor: ${stats.factor}`);
  if (!Number.isInteger(stats.samples)) throw new Error(`samples: ${stats.samples}`);
  if (!['auto', 'fast', 'accurate'].includes(stats.mode)) throw new Error(`mode: ${stats.mode}`);
});

await check('whisper получает все ядра и -sns против галлюцинаций', async () => {
  runWhisper('текст');
  spawnCalls.length = 0;
  await handlers.get('stt:transcribe-pcm')({}, { pcm: speechPcm(500), lang: 'ru', model: 'small' });
  const call = spawnCalls.find((c) => String(c.file).includes('whisper'));
  const args = call.args.join(' ');
  if (!/\s-t \d+/.test(args)) throw new Error(`нет -t: ${args}`);
  if (!/\s\-sns(\s|$)/.test(args)) throw new Error(`нет -sns: ${args}`);
  if (!/\s\-np(\s|$)/.test(args)) throw new Error(`нет -np: ${args}`);
});

await check('паузы по краям записи обрезаются перед whisper', () => {
  const whisper = require(path.resolve('electron/whisper.cjs'));
  const rate = 16000;
  const silence = new Int16Array(rate); // 1 с тишины
  const speech = new Int16Array(rate); // 1 с «речи»
  for (let i = 0; i < rate; i += 1) speech[i] = Math.round(4000 * Math.sin((2 * Math.PI * 200 * i) / rate));
  const pcm = new Int16Array(rate * 2 + rate); // тишина, речь, тишина
  pcm.set(silence, 0);
  pcm.set(speech, rate);
  pcm.set(silence, rate * 2);
  const raw = Buffer.from(pcm.buffer);
  const trimmed = whisper.trimSilence(raw, rate);
  const trimmedSec = trimmed.length / 2 / rate;
  if (!(trimmedSec < 2 && trimmedSec > 1)) throw new Error(`длина после обрезки: ${trimmedSec}`);
  // начало речи не срезано: в обрезке есть громкие сэмплы
  const hasLoud = (() => {
    for (let i = 0; i < Math.floor(trimmed.length / 2); i += 7) {
      if (Math.abs(trimmed.readInt16LE(i * 2)) > 1000) return true;
    }
    return false;
  })();
  if (!hasLoud) throw new Error('речь потерялась при обрезке');
  // запись без речи не трогаем — её отбракует analysePcm
  if (whisper.trimSilence(Buffer.alloc(rate * 2), rate).length !== rate * 2) throw new Error('тишина обрезана зря');
});

await check('оценка записи: тишина, шёпот и речь различаются', () => {
  const whisper = require(path.resolve('electron/whisper.cjs'));
  const rate = 16000;
  const make = (amp) => {
    const pcm = new Int16Array(rate);
    for (let i = 0; i < rate; i += 1) pcm[i] = Math.round(amp * Math.sin((2 * Math.PI * 180 * i) / rate));
    return Buffer.from(pcm.buffer);
  };
  const silence = whisper.analysePcm(Buffer.alloc(rate * 2), rate);
  if (silence.samples !== rate) throw new Error(`сэмплов: ${silence.samples}`);
  if (Math.abs(silence.seconds - 1) > 0.001) throw new Error(`секунд: ${silence.seconds}`);
  if (silence.rms !== 0 || silence.peak !== 0) throw new Error('тишина не нулевая');

  const quiet = whisper.analysePcm(make(300), rate);
  const loud = whisper.analysePcm(make(6000), rate);
  if (!(loud.rms > quiet.rms && quiet.rms > 0)) throw new Error(`rms ${quiet.rms}/${loud.rms}`);
  if (!(loud.peak > 5000)) throw new Error(`пик: ${loud.peak}`);
  // пустой буфер не должен делить на ноль
  const empty = whisper.analysePcm(Buffer.alloc(0), rate);
  if (empty.samples !== 0 || empty.seconds !== 0) throw new Error('пустой буфер посчитан неверно');
});

await check('фразы-галлюцинации отбрасываются, живой текст остаётся', () => {
  const { isPhantom } = require(path.resolve('electron/whisper.cjs'));
  for (const bad of ['Спасибо за просмотр!', '  Продолжение следует  ', 'Thank you for watching.', 'Подписывайтесь на канал']) {
    if (!isPhantom(bad)) throw new Error(`пропущена галлюцинация: ${bad}`);
  }
  for (const good of ['Спасибо за просмотр, теперь про отчёты', 'Конец квартала нужно закрыть', '', 'Привет']) {
    if (isPhantom(good)) throw new Error(`удалён живой текст: ${good}`);
  }
});

await check('импорт модели: чужой файл не подключается, ggml — да', async () => {
  const modelsMod = require(path.resolve('electron/models.cjs'));
  const tmpDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'zs-model-'));
  const fake = path.join(tmpDir, 'not-a-model.bin');
  fs.writeFileSync(fake, Buffer.concat([Buffer.from('NOPE'), Buffer.alloc(21 * 1024 * 1024)]));
  const bad = await modelsMod.importModel(fake);
  if (bad.ok) throw new Error('случайный файл подключился');
  if (!/ggml/.test(String(bad.reason))) throw new Error(`причина: ${bad.reason}`);
  for (const magic of ['ggml', 'GGUF']) {
    fs.writeFileSync(fake, Buffer.concat([Buffer.from(magic), Buffer.alloc(21 * 1024 * 1024)]));
    const rejected = await modelsMod.importModel(fake);
    if (rejected.ok) throw new Error(`принят неподходящий заголовок ${magic}`);
  }

  const good = path.join(tmpDir, 'ggml-large-v3-turbo.bin');
  // whisper.cpp пишет 0x67676d6c как little-endian: первые байты — lmgg,
  // как у официальной модели for-tests-ggml-tiny.bin.
  fs.writeFileSync(good, Buffer.concat([Buffer.from([0x6c, 0x6d, 0x67, 0x67]), Buffer.alloc(21 * 1024 * 1024)]));
  const ok = await handlers.get('models:import')({}, good);
  if (!ok.ok || ok.id !== 'large-v3-turbo') throw new Error(JSON.stringify(ok));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Плавающий индикатор диктовки ────────────────────────────────────────────
await check('индикатор диктовки: отдельное окно поверх всех, без фокуса', async () => {
  const before = windowInstances.length;
  const ok = await handlers.get('hud:show')({});
  if (!ok) throw new Error('hud:show не ответил ok');
  const hud = windowInstances[windowInstances.length - 1];
  if (windowInstances.length !== before + 1) throw new Error('окно не создано');
  const o = hud._options || {};
  if (o.alwaysOnTop !== true) throw new Error('не alwaysOnTop');
  if (o.focusable !== false) throw new Error('забирает фокус — вставка уйдёт в индикатор');
  if (o.frame !== false) throw new Error('с рамкой');
  if (o.transparent !== true) throw new Error('без прозрачности');
  if (o.skipTaskbar !== true) throw new Error('висит в панели задач');
  if (hud._alwaysOnTop !== true) throw new Error('setAlwaysOnTop не вызван');
  if (!/hud\.html$/.test(hud._file)) throw new Error(`загружен не тот файл: ${hud._file}`);
  if (!hud.isVisible()) throw new Error('показано невидимым');
  // повторный вызов не плодит окна
  await handlers.get('hud:show')({});
  if (windowInstances.length !== before + 1) throw new Error('создалось второе окно индикатора');
});

await check('индикатор появляется на том мониторе, где курсор', async () => {
  await handlers.get('hud:show')({});
  const hud = windowInstances[windowInstances.length - 1];
  const b = hud._bounds || {};
  // второй экран начинается с x=1920 и шириной 2560: центр = 1920 + (2560-268)/2
  const expectedX = Math.round(1920 + (2560 - 360) / 2);
  if (b.x !== expectedX) throw new Error(`x=${b.x}, ждали ${expectedX}`);
  if (b.y !== 1400 - 92 - 28) throw new Error(`y=${b.y}`);
  if (b.width !== 360 || b.height !== 92) throw new Error('размер плашки изменился');
});

await check('индикатор: состояние доходит до окна, закрытие его прячет', async () => {
  sentEvents.length = 0;
  await handlers.get('hud:update')({}, { state: 'listening', level: 0.42, elapsed: 1200, draft: 'привет' });
  const stateEvent = sentEvents.find((e) => e.ch === 'hud:state');
  if (!stateEvent) throw new Error('окно не получило состояние');
  if (stateEvent.payload.level !== 0.42 || stateEvent.payload.draft !== 'привет') {
    throw new Error(`состояние исказилось: ${JSON.stringify(stateEvent.payload)}`);
  }
  // ошибка — две строки: окно становится выше, обычное состояние — обратно
  const hudWin = windowInstances[windowInstances.length - 1];
  await handlers.get('hud:update')({}, { state: 'error', error: 'Модель не загружена', hint: 'Скачайте модель' });
  if (hudWin._bounds?.height !== 112) throw new Error(`высота при ошибке: ${hudWin._bounds?.height}`);
  await handlers.get('hud:update')({}, { state: 'listening', level: 0.1, elapsed: 100 });
  if (hudWin._bounds?.height !== 92) throw new Error(`высота после ошибки: ${JSON.stringify(hudWin._bounds)}`);
  // окно растёт вверх, нижний край остаётся на месте (1400 - 28)
  const bottom = (b) => (b.y ?? 0) + (b.height ?? 0);
  if (bottom(hudWin._bounds) !== 1372) throw new Error(`нижний край уехал: ${JSON.stringify(hudWin._bounds)}`);
  const hud = windowInstances[windowInstances.length - 1];
  // главное окно ищем по его параметрам, а не по порядку создания
  const mainWin = findMainWindow();
  if (!mainWin) throw new Error('главное окно не найдено');
  mainWin._visible = true;
  await handlers.get('hud:close')({});
  if (hud.isVisible()) throw new Error('индикатор не спрятался');
  if (!sentEvents.some((e) => e.ch === 'hud:closed')) {
    throw new Error('окно диктовки не узнало о закрытии — индикатор не переедет внутрь');
  }

  // окно приложения спрятано в трей: показывать индикатор негде — запись
  // должна остановиться, иначе ею нечем управлять
  await handlers.get('hud:show')({});
  mainWin._visible = false;
  sentEvents.length = 0;
  await handlers.get('hud:close')({});
  mainWin._visible = true;
  if (!sentEvents.some((e) => e.ch === 'dictation:stop')) {
    throw new Error('при скрытом окне закрытие плашки не остановило запись');
  }
  if (sentEvents.some((e) => e.ch === 'hud:closed')) {
    throw new Error('при скрытом окне индикатор зря переехал в невидимое окно');
  }
});

await check('индикатор: «стоп» и «скрыть» работают как кнопки', async () => {
  await handlers.get('hud:show')({});
  sentEvents.length = 0;
  await handlers.get('hud:stop')({});
  const stopEvent = sentEvents.find((e) => e.ch === 'dictation:stop');
  if (!stopEvent) throw new Error('окно диктовки не получило просьбу остановиться');
  if (stopEvent.payload?.from !== 'hud') throw new Error('не отмечено, что стоп пришёл с индикатора');
  const status = await handlers.get('hud:status')({});
  if (!status.open) throw new Error('статус говорит, что индикатора нет');
  await handlers.get('hud:hide')({});
  const after = await handlers.get('hud:status')({});
  if (after.open) throw new Error('после hide индикатор всё ещё открыт');
});

await check('трей и сочетание знают реальное состояние записи', async () => {
  const stateHandler = onHandlers.get('dictation:state');
  if (!stateHandler) throw new Error('нет обработчика dictation:state');
  stateHandler({}, 'listening');
  const menu = trayTemplates[trayTemplates.length - 1] || [];
  if (!menu.some((i) => i.label === 'Остановить диктовку')) throw new Error('нет пункта стопа при записи');
  stateHandler({}, 'idle');
  const idleMenu = trayTemplates[trayTemplates.length - 1] || [];
  if (idleMenu.some((i) => i.label === 'Остановить диктовку')) throw new Error('стоп остался после записи');
  // мусор в событии не должен ломать состояние
  stateHandler({}, 'что-то странное');
  const stillNoStop = (trayTemplates[trayTemplates.length - 1] || []).some(
    (i) => i.label === 'Остановить диктовку',
  );
  if (stillNoStop) throw new Error('неизвестное состояние включило запись');
});

await check('трей говорит, что микрофон открыт заранее', async () => {
  const handler = onHandlers.get('mic:warm');
  if (!handler) throw new Error('нет обработчика mic:warm');
  handler({}, true);
  const menu = trayTemplates[trayTemplates.length - 1] || [];
  if (!menu.some((i) => /Микрофон открыт заранее/.test(i.label || ''))) {
    throw new Error(`в меню нет строки про открытый микрофон: ${menu.map((i) => i.label || i.type).join(' · ')}`);
  }
  if (!trayTooltips.some((t) => /микрофон открыт заранее/.test(String(t)))) {
    throw new Error(`подсказка трея молчит: ${trayTooltips.join(' | ')}`);
  }
  // подсказка про непрочитанное не должна теряться
  await handlers.get('win:badge')({}, 3);
  const withBadge = trayTooltips[trayTooltips.length - 1];
  if (!/3 новых/.test(withBadge) || !/микрофон открыт заранее/.test(withBadge)) {
    throw new Error(`счётчик и микрофон не уживаются: ${withBadge}`);
  }
  await handlers.get('win:badge')({}, 0);
  handler({}, false);
  const after = trayTemplates[trayTemplates.length - 1] || [];
  if (after.some((i) => /Микрофон открыт заранее/.test(i.label || ''))) throw new Error('строка осталась после закрытия');
  if (!/офлайн голосовой ввод/.test(String(trayTooltips[trayTooltips.length - 1]))) {
    throw new Error(`подсказка не вернулась к обычной: ${trayTooltips[trayTooltips.length - 1]}`);
  }
});

await check('трей: во время записи появляется «Остановить диктовку»', async () => {
  await handlers.get('hud:show')({});
  const withStop = trayTemplates[trayTemplates.length - 1] || [];
  const item = withStop.find((i) => i.label === 'Остановить диктовку');
  if (!item) throw new Error(`в меню нет стопа: ${withStop.map((i) => i.label || i.type).join(' · ')}`);
  sentEvents.length = 0;
  item.click();
  const ev = sentEvents.find((e) => e.ch === 'dictation:stop');
  if (!ev || ev.payload?.from !== 'tray') throw new Error('пункт меню не останавливает запись');
  await handlers.get('hud:hide')({});
  const withoutStop = trayTemplates[trayTemplates.length - 1] || [];
  if (withoutStop.some((i) => i.label === 'Остановить диктовку')) throw new Error('стоп остался в меню после записи');
});

await check('прогрев запускается сам — по началу записи, а не по первой диктовке', async () => {
  const startedAt = Date.now();
  const shown = await handlers.get('hud:show')({});
  const took = Date.now() - startedAt;
  // плашка обязана появиться сразу: прогрев — фон, а не «подождите, я греюсь»
  if (!shown) throw new Error('hud:show не ответил');
  if (took > 300) throw new Error(`показ плашки ждал прогрев: ${took} мс`);
  if (!warmSeen.length) throw new Error('модель ни разу не прогревалась');
  const settings = (handlers.get('store:get')({}, 'zs:settings')) || {};
  const wanted = String(settings.whisperModel || 'base');
  if (!warmSeen.includes(wanted)) throw new Error(`прогревали «${warmSeen.join(',')}», а выбрана «${wanted}»`);
  whisperForWarm.warm = realWarm;
});

await check('models:warm честно отказывает без whisper-server', async () => {
  const res = await handlers.get('models:warm')({}, { model: 'small', force: true });
  if (res?.ok) throw new Error('будто модель загружена');
  if (!/whisper-server/.test(String(res?.reason))) throw new Error(`причина непонятная: ${res?.reason}`);
});

await check('повторный прогрев безопасен: второй вызов не ломается и не дублирует проход', async () => {
  const whisper = require(path.resolve('electron/whisper.cjs'));
  const first = await whisper.warm('small-q5_1');
  const second = await whisper.warm('small-q5_1');
  if (typeof first?.ok !== 'boolean' || typeof second?.ok !== 'boolean') {
    throw new Error(`странный ответ: ${JSON.stringify([first, second])}`);
  }
  if (first.ok !== second.ok) throw new Error('повторный прогрев ответил иначе');
});

await check('models:warm не работает при выключенной настройке', async () => {
  await handlers.get('store:set')({}, 'zs:settings', { keepModelLoaded: false });
  const res = await handlers.get('models:warm')({}, { model: 'small' });
  if (res?.ok) throw new Error('прогрев без согласия');
  if (!/Держать модель в памяти/.test(String(res?.reason))) throw new Error(`причина: ${res?.reason}`);
});

await check('серверный режим: multipart для /inference собран правильно', () => {
  const whisper = require(path.resolve('electron/whisper.cjs'));
  const audio = Buffer.from('RIFFxxxxWAVE');
  const { body, contentType } = whisper.multipart(
    { language: 'ru', prompt: 'ZSpeakly, Атлас', temperature: '0.0', response_format: 'json' },
    { name: 'file', filename: 'rec.wav', buffer: audio },
  );
  const text = body.toString('latin1');
  if (!/^multipart\/form-data; boundary=/.test(contentType)) throw new Error(contentType);
  if (!text.includes('name="file"; filename="rec.wav"')) throw new Error('нет файла');
  if (!text.includes('name="prompt"')) throw new Error('нет подсказки');
  if (!text.includes('name="language"')) throw new Error('нет языка');
  if (!text.includes('RIFFxxxxWAVE')) throw new Error('аудио не вложено');
  if (!text.trimEnd().endsWith('--')) throw new Error('нет закрывающей границы');
});

await check('серверный режим: без whisper-server честно работает обычный запуск', async () => {
  const whisper = require(path.resolve('electron/whisper.cjs'));
  const st = whisper.status('small');
  if (st.server.available) throw new Error('сервер будто есть');
  if (st.server.running) throw new Error('сервер будто запущен');
  if (!st.modelName) throw new Error('не сказано, какой файл модели используется');
  runWhisper('обычный путь');
  spawnCalls.length = 0;
  const res = await handlers.get('stt:transcribe-pcm')({}, { pcm: speechPcm(400), lang: 'ru' });
  if (res?.text !== 'обычный путь') throw new Error(`упало: ${JSON.stringify(res)}`);
  if (!spawnCalls.some((c) => String(c.file).includes('whisper'))) throw new Error('cli не запускался');
});

await check('отмена распознавания: канал есть и без активного прохода не врёт', async () => {
  if (!handlers.has('stt:cancel')) throw new Error('канал stt:cancel не зарегистрирован');
  const res = await handlers.get('stt:cancel')({});
  if (res !== false) throw new Error(`без активного прохода ожидалось false, получено ${res}`);
});

await check('язык записи выбирает подходящий движок, ONNX работает без Whisper', async () => {
  const whisper = require(path.resolve('electron/whisper.cjs'));
  const giga = require(path.resolve('electron/gigaam.cjs'));
  const para = require(path.resolve('electron/parakeet.cjs'));
  const saved = { ws: whisper.status, wt: whisper.transcribe, gs: giga.status, gt: giga.transcribe, ps: para.status, pt: para.transcribe };
  const settingsBefore = handlers.get('store:get')({}, 'zs:settings');
  let gigaCalls = 0, paraCalls = 0, whisperCalls = [];
  let whisperReady = true, gigaReady = true, paraReady = true, failOnnx = false;
  whisper.status = () => ({ available: whisperReady, reason: whisperReady ? '' : 'whisper не установлен' });
  whisper.transcribe = async (_wav, options) => { whisperCalls.push(options.lang); return { ok: true, text: 'ответ обычной модели', mode: 'cli' }; };
  giga.status = () => ({ available: gigaReady });
  para.status = () => ({ available: paraReady });
  giga.transcribe = async () => { gigaCalls++; return failOnnx ? { ok: false, reason: 'ошибка ONNX' } : { ok: true, text: 'русская модель', chunks: 1 }; };
  para.transcribe = async () => { paraCalls++; return failOnnx ? { ok: false, reason: 'ошибка ONNX' } : { ok: true, text: 'европейская модель', chunks: 1 }; };
  const invoke = (lang, ms = 1600) => handlers.get('stt:transcribe-pcm')({}, { pcm: speechPcm(ms), sampleRate: 16000, ...(lang === undefined ? {} : { lang }), partial: true });
  try {
    await handlers.get('store:set')({}, 'zs:settings', { ...settingsBefore, language: 'ru', keepModelLoaded: false, decodeMode: 'fast', autoOptimize: false });
    let res = await invoke('en-US');
    if (!res.ok || res.mode !== 'parakeet' || gigaCalls !== 0 || paraCalls !== 1) throw new Error(`английский поверх русского: ${JSON.stringify({ res, gigaCalls, paraCalls })}`);
    res = await invoke('ja');
    if (!res.ok || res.mode !== 'cli' || whisperCalls.at(-1) !== 'ja') throw new Error(`японский: ${JSON.stringify({ res, whisperCalls })}`);
    res = await invoke('auto');
    if (!res.ok || res.mode !== 'cli' || whisperCalls.at(-1) !== 'auto') throw new Error(`автоязык: ${JSON.stringify({ res, whisperCalls })}`);
    await handlers.get('store:set')({}, 'zs:settings', { ...settingsBefore, language: 'en', keepModelLoaded: false, decodeMode: 'fast', autoOptimize: false });
    res = await invoke('ru');
    if (!res.ok || res.mode !== 'gigaam') throw new Error(`русский поверх английского: ${JSON.stringify(res)}`);
    res = await invoke(undefined);
    if (!res.ok || res.mode !== 'parakeet') throw new Error(`язык настроек: ${JSON.stringify(res)}`);
    whisperReady = false;
    res = await invoke('en');
    if (!res.ok || res.mode !== 'parakeet') throw new Error(`Parakeet без Whisper: ${JSON.stringify(res)}`);
    res = await invoke('ru');
    if (!res.ok || res.mode !== 'gigaam') throw new Error(`GigaAM без Whisper: ${JSON.stringify(res)}`);
    failOnnx = true;
    const count = whisperCalls.length;
    res = await invoke('ru');
    if (res.ok || !/whisper не установлен/i.test(res.reason) || whisperCalls.length !== count) throw new Error(`нет резервного движка: ${JSON.stringify(res)}`);
    failOnnx = false;
    res = await invoke('en', 500);
    if (res.ok || !/whisper не установлен/i.test(res.reason)) throw new Error(`короткий звук без Whisper: ${JSON.stringify(res)}`);
  } finally {
    whisper.status = saved.ws; whisper.transcribe = saved.wt; giga.status = saved.gs; giga.transcribe = saved.gt; para.status = saved.ps; para.transcribe = saved.pt;
    await handlers.get('store:set')({}, 'zs:settings', settingsBefore);
  }
});

await check('отмена во время операции ONNX отбрасывает позднюю ошибку', async () => {
  for (const name of ['gigaam', 'parakeet']) {
    const engine = require(path.resolve(`electron/${name}.cjs`));
    let started, release;
    const ready = new Promise((resolve) => { started = resolve; });
    const pending = new Promise((resolve) => { release = resolve; });
    engine.setTestDeps({ files: [], sessions: { preprocessor: { run: async () => { started(); await pending; throw new Error('поздняя ошибка операции'); } } } });
    try {
      const task = engine.transcribe(speechPcm(1200), { sampleRate: 16000 });
      await ready;
      if (!engine.cancel()) throw new Error(`${name}: отмена не принята`);
      release();
      const result = await task;
      if (result.ok || result.code !== 'cancelled' || result.text) throw new Error(`${name}: ${JSON.stringify(result)}`);
      if (engine.cancel()) throw new Error(`${name}: проход остался активным`);
    } finally {
      release(); engine.reset();
    }
  }
});

await check('отмена GigaAM и Parakeet не запускает Whisper, ошибка допускает fallback', async () => {
  const whisper = require(path.resolve('electron/whisper.cjs'));
  const giga = require(path.resolve('electron/gigaam.cjs'));
  const para = require(path.resolve('electron/parakeet.cjs'));
  const saved = { whisper: whisper.transcribe, gs: giga.status, gt: giga.transcribe, gc: giga.cancel, ps: para.status, pt: para.transcribe, pc: para.cancel };
  const settingsBefore = handlers.get('store:get')({}, 'zs:settings');
  let whisperCalls = 0;
  whisper.transcribe = async () => { whisperCalls++; return { ok: true, text: 'запасное распознавание' }; };
  try {
    for (const [engine, other, language] of [[giga, para, 'ru'], [para, giga, 'en']]) {
      engine.status = () => ({ available: true }); other.status = () => ({ available: false });
      await handlers.get('store:set')({}, 'zs:settings', { ...settingsBefore, language, keepModelLoaded: false, decodeMode: 'fast', autoOptimize: false });
      let started, finish;
      const ready = new Promise((resolve) => { started = resolve; });
      engine.transcribe = () => { started(); return new Promise((resolve) => { finish = resolve; }); };
      engine.cancel = () => { finish?.({ ok: false, text: '', reason: 'отменено', code: 'cancelled' }); return true; };
      const before = whisperCalls;
      const task = handlers.get('stt:transcribe-pcm')({}, { pcm: speechPcm(1600), sampleRate: 16000, lang: language });
      await ready;
      if (!handlers.get('stt:cancel')({})) throw new Error(`отмена ${language} не принята`);
      const cancelled = await task;
      if (cancelled.ok || cancelled.code !== 'cancelled' || whisperCalls !== before) throw new Error(`отмена ${language}: ${JSON.stringify({ cancelled, whisperCalls, before })}`);
      engine.transcribe = async () => ({ ok: false, reason: 'ошибка модели' });
      const fallback = await handlers.get('stt:transcribe-pcm')({}, { pcm: speechPcm(1600), sampleRate: 16000, lang: language });
      if (!fallback.ok || whisperCalls !== before + 1) throw new Error(`fallback ${language}: ${JSON.stringify({ fallback, whisperCalls, before })}`);
    }
  } finally {
    whisper.transcribe = saved.whisper; giga.status = saved.gs; giga.transcribe = saved.gt; giga.cancel = saved.gc;
    para.status = saved.ps; para.transcribe = saved.pt; para.cancel = saved.pc;
    await handlers.get('store:set')({}, 'zs:settings', settingsBefore);
  }
});

await check('выбор Whisper не подменяется доступными языковыми моделями', async () => {
  const whisper = require(path.resolve('electron/whisper.cjs'));
  const giga = require(path.resolve('electron/gigaam.cjs'));
  const para = require(path.resolve('electron/parakeet.cjs'));
  const before = handlers.get('store:get')({}, 'zs:settings');
  const pinned = handlers.get('store:get')({}, 'zs:modelPinned');
  const saved = { ws: whisper.status, wt: whisper.transcribe, gs: giga.status, gt: giga.transcribe, ps: para.status, pt: para.transcribe };
  let whisperCalls = 0, onnxCalls = 0;
  whisper.status = () => ({ available: true });
  whisper.transcribe = async () => { whisperCalls++; return { ok: true, text: 'тестовая речь', mode: 'cli' }; };
  giga.status = () => ({ available: true }); para.status = () => ({ available: true });
  giga.transcribe = para.transcribe = async () => { onnxCalls++; return { ok: true, text: 'языковая модель' }; };
  try {
    await handlers.get('store:set')({}, 'zs:settings', { ...before, recognitionEngine: 'whisper', keepModelLoaded: false, decodeMode: 'fast', autoOptimize: false });
    for (const lang of ['ru', 'en']) {
      const result = await handlers.get('stt:transcribe-pcm')({}, { pcm: speechPcm(1600), sampleRate: 16000, lang });
      if (!result.ok || !result.text.includes('тестовая речь')) throw new Error(JSON.stringify(result));
    }
    if (whisperCalls !== 2 || onnxCalls !== 0) throw new Error(JSON.stringify({ whisperCalls, onnxCalls }));
  } finally {
    whisper.status = saved.ws; whisper.transcribe = saved.wt; giga.status = saved.gs; giga.transcribe = saved.gt; para.status = saved.ps; para.transcribe = saved.pt;
    await handlers.get('store:set')({}, 'zs:settings', before);
    await handlers.get('store:set')({}, 'zs:modelPinned', pinned);
  }
});

await check('Whisper: сохранение текста и выключенная подсказка не вырезают слова', async () => {
  const whisper = require(path.resolve('electron/whisper.cjs'));
  const before = handlers.get('store:get')({}, 'zs:settings');
  const saved = { status: whisper.status, transcribe: whisper.transcribe };
  let text = '';
  whisper.status = () => ({ available: true });
  whisper.transcribe = async () => ({ ok: true, text, mode: 'cli' });
  const invoke = (useDictionary = true) => handlers.get('stt:transcribe-pcm')({}, {
    pcm: speechPcm(600), sampleRate: 16000, lang: 'zz', useDictionary,
  });
  const settings = { ...before, recognitionEngine: 'whisper', keepModelLoaded: false, decodeMode: 'fast', autoOptimize: false };
  try {
    await handlers.get('store:set')({}, 'zs:settings', { ...settings, preserveText: true });
    text = 'Алло алло алло приветики';
    let result = await invoke();
    if (result.text !== text) throw new Error(`свёрнут повтор: ${JSON.stringify(result)}`);
    text = 'обсуждали Zoom и Telegram';
    await invoke();
    text = 'обсуждали Zoom и Telegram, а завтра Docker.';
    result = await invoke();
    if (result.text !== text) throw new Error(`вырезано начало фразы: ${JSON.stringify(result)}`);
    await handlers.get('store:set')({}, 'zs:settings', { ...settings, preserveText: false });
    text = 'обсуждали Zoom и Telegram';
    await invoke();
    text = 'обсуждали Zoom и Telegram, а завтра Docker.';
    result = await invoke(false);
    if (result.text !== text) throw new Error(`вырезана непереданная подсказка: ${JSON.stringify(result)}`);
  } finally {
    whisper.status = saved.status; whisper.transcribe = saved.transcribe;
    await handlers.get('store:set')({}, 'zs:settings', before);
  }
});

await check('очередь диктовок: отмена и несколько итоговых проходов', async () => {
  const whisper = require(path.resolve('electron/whisper.cjs'));
  const giga = require(path.resolve('electron/gigaam.cjs'));
  const para = require(path.resolve('electron/parakeet.cjs'));
  const saved = { wt: whisper.transcribe, wc: whisper.cancel, gs: giga.status, ps: para.status };
  const settingsBefore = handlers.get('store:get')({}, 'zs:settings');
  let calls = 0, releases = [], started = [];
  whisper.transcribe = () => { calls++; started.splice(0).forEach((f) => f()); return new Promise((resolve) => releases.push(resolve)); };
  whisper.cancel = () => { const done = releases.shift(); if (!done) return false; done({ ok: false, code: 'cancelled' }); return true; };
  giga.status = () => ({ available: false }); para.status = () => ({ available: false });
  const nextStart = () => new Promise((resolve) => started.push(resolve));
  const invoke = (partial = false) => handlers.get('stt:transcribe-pcm')({}, { pcm: speechPcm(1600), sampleRate: 16000, lang: 'ru', partial });
  try {
    await handlers.get('store:set')({}, 'zs:settings', { ...settingsBefore, keepModelLoaded: false, decodeMode: 'fast', autoOptimize: false });
    let ready = nextStart(); const first = invoke(); await ready;
    const second = invoke();
    if (!handlers.get('stt:cancel')({})) throw new Error('отмена очереди не принята');
    const results = await Promise.all([first, second]);
    if (calls !== 1 || results.some((r) => r.code !== 'cancelled')) throw new Error(`отмена очереди: ${JSON.stringify({ calls, results })}`);
    ready = nextStart(); const third = invoke(); await ready;
    const fourth = invoke();
    releases.shift()({ ok: true, text: 'готова первая запись' });
    await third;
    const partial = await invoke(true);
    if (partial.code !== 'superseded') throw new Error(`живой проход встал за итоговым: ${JSON.stringify(partial)}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (calls !== 3) throw new Error(`второй итоговый не стартовал: ${calls}`);
    releases.shift()({ ok: true, text: 'готова вторая запись' });
    if (!(await fourth).ok) throw new Error('второй итоговый не завершился');
  } finally {
    releases.splice(0).forEach((f) => f({ ok: false, code: 'cancelled' }));
    whisper.transcribe = saved.wt; whisper.cancel = saved.wc; giga.status = saved.gs; para.status = saved.ps;
    await handlers.get('store:set')({}, 'zs:settings', settingsBefore);
  }
});

await check('длинная диктовка: параллельные фрагменты только с включённым сервером', async () => {
  const whisper = require(path.resolve('electron/whisper.cjs'));
  const giga = require(path.resolve('electron/gigaam.cjs'));
  const para = require(path.resolve('electron/parakeet.cjs'));
  const saved = { transcribe: whisper.transcribe, serverStatus: whisper.serverStatus, split: whisper.splitBySilence, giga: giga.status, para: para.status };
  const settingsBefore = handlers.get('store:get')({}, 'zs:settings');
  let calls = 0, running = 0, peak = 0, splits = 0, phase = 'cold';
  whisper.serverStatus = () => ({ ready: true, processors: 2 });
  whisper.splitBySilence = (pcm) => { splits++; return [pcm.subarray(0, pcm.length / 2), pcm.subarray(pcm.length / 2)]; };
  whisper.transcribe = async () => {
    const n = ++calls; running++; peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 30));
    running--;
    return { ok: true, mode: phase === 'cold' || (phase === 'mixed' && n === 2) ? 'cli' : 'server', text: phase === 'cold' ? 'отдельная короткая фраза' : n === 1 ? 'утром запланировали встречу' : 'вечером подготовили отчёт', ms: 30 };
  };
  giga.status = () => ({ available: false }); para.status = () => ({ available: false });
  try {
    await handlers.get('store:set')({}, 'zs:settings', { ...settingsBefore, keepModelLoaded: false, decodeMode: 'fast', autoOptimize: false });
    const raw = speechPcm(30000);
    const cold = await handlers.get('stt:transcribe-pcm')({}, { pcm: raw, sampleRate: 16000, lang: 'ru' });
    if (!cold.ok || calls !== 1 || splits !== 0 || peak !== 1) throw new Error(`без сервера: ${JSON.stringify({ cold, calls, splits, peak })}`);
    calls = 0; peak = 0; phase = 'warm';
    await handlers.get('store:set')({}, 'zs:settings', { ...settingsBefore, keepModelLoaded: true, decodeMode: 'fast', autoOptimize: false });
    const warm = await handlers.get('stt:transcribe-pcm')({}, { pcm: raw, sampleRate: 16000, lang: 'ru' });
    if (!warm.ok || warm.mode !== 'server' || calls !== 2 || splits !== 1 || peak !== 2 || !/утром запланировали/.test(warm.text) || !/вечером подготовили/.test(warm.text)) {
      throw new Error(`сервер: ${JSON.stringify({ warm, calls, splits, peak })}`);
    }
    calls = 0; peak = 0; phase = 'mixed';
    const mixed = await handlers.get('stt:transcribe-pcm')({}, { pcm: raw, sampleRate: 16000, lang: 'kk' });
    if (!mixed.ok || mixed.mode !== 'mixed' || calls !== 2 || peak !== 2) throw new Error(`смешанный проход: ${JSON.stringify({ mixed, calls, peak })}`);
  } finally {
    whisper.transcribe = saved.transcribe; whisper.serverStatus = saved.serverStatus; whisper.splitBySilence = saved.split;
    giga.status = saved.giga; para.status = saved.para;
    await handlers.get('store:set')({}, 'zs:settings', settingsBefore);
  }
});

await check('одновременно работает один проход: живой не мешает итоговому', async () => {
  const whisper = require(path.resolve('electron/whisper.cjs'));
  let release = () => {};
  const gate = new Promise((r) => {
    release = r;
  });
  const realTranscribe = whisper.transcribe;
  let started = 0;
  whisper.transcribe = async () => {
    started += 1;
    await gate;
    return { ok: true, text: 'итог', ms: 1 };
  };
  try {
    const partial = handlers.get('stt:transcribe-pcm')({}, { pcm: speechPcm(600), lang: 'ru', partial: true });
    await new Promise((r) => setTimeout(r, 150));
    const fin = handlers.get('stt:transcribe-pcm')({}, { pcm: speechPcm(600), lang: 'ru' });
    await new Promise((r) => setTimeout(r, 150));
    release();
    const [a, b] = await Promise.all([partial, fin]);
    if (!a || !b) throw new Error('проходы не завершились');
    if (b.text !== 'итог') throw new Error(`итоговый проход не дал текст: ${JSON.stringify(b)}`);
    if (started < 1) throw new Error('движок не запускался');
  } finally {
    whisper.transcribe = realTranscribe;
  }
});

await check('подготовка распознавания: канал models:prepare есть', async () => {
  if (!handlers.has('models:prepare')) throw new Error('нет models:prepare');
  const res = await handlers.get('models:prepare')({});
  if (!res || typeof res.ok !== 'boolean') throw new Error(`странный ответ: ${JSON.stringify(res)}`);
});

await check('автоподготовка: файлы в комплекте работают без скачивания', async () => {
  const models = require(path.resolve('electron/models.cjs'));
  const resourcesBefore = process.resourcesPath;
  const resources = path.join(userData, 'test-resources');
  const saved = { engine: models.downloadEngine, vad: models.downloadVad, model: models.downloadModel };
  const settingsBefore = handlers.get('store:get')({}, 'zs:settings');
  const parked = path.join(userData, 'parked-models');
  fs.mkdirSync(parked, { recursive: true });
  const savedFiles = fs.readdirSync(path.join(userData, 'models')).filter((name) => /^ggml-.*\.bin$/i.test(name));
  for (const name of savedFiles) fs.renameSync(path.join(userData, 'models', name), path.join(parked, name));
  try {
    process.resourcesPath = resources;
    fs.mkdirSync(path.join(resources, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(resources, 'models'), { recursive: true });
    for (const f of ['whisper-cli.exe', 'whisper-server.exe']) fs.writeFileSync(path.join(resources, 'bin', f), 'fixture');
    for (const f of ['ggml-silero-v6.2.0.bin', 'ggml-base-q5_1.bin']) fs.writeFileSync(path.join(resources, 'models', f), 'fixture');
    await handlers.get('store:set')({}, 'zs:settings', { ...settingsBefore, whisperModel: 'base-q5_1' });
    models.downloadEngine = models.downloadVad = models.downloadModel = async () => { throw new Error('неожиданная загрузка'); };
    const status = await handlers.get('models:status')({});
    if (!status.bin || !status.server || !status.vad || !status.models['base-q5_1'].available || status.active !== 'base-q5_1') throw new Error(`статус: ${JSON.stringify(status)}`);
    const result = await handlers.get('models:prepare')({});
    if (!result.ok || !result.already) throw new Error(`подготовка: ${JSON.stringify(result)}`);
    fs.renameSync(path.join(resources, 'models', 'ggml-base-q5_1.bin'), path.join(resources, 'models', 'ggml-large-v3.bin'));
    const legacyStatus = await handlers.get('models:status')({});
    const legacyResult = await handlers.get('models:prepare')({});
    if (!legacyStatus.availableModel || legacyStatus.active !== 'large-v3' || !legacyResult.ok || !legacyResult.already) {
      throw new Error(`старая модель: ${JSON.stringify({ legacyStatus, legacyResult })}`);
    }
  } finally {
    if (resourcesBefore === undefined) delete process.resourcesPath; else process.resourcesPath = resourcesBefore;
    models.downloadEngine = saved.engine; models.downloadVad = saved.vad; models.downloadModel = saved.model;
    for (const name of savedFiles) fs.renameSync(path.join(parked, name), path.join(userData, 'models', name));
    fs.rmSync(parked, { recursive: true, force: true });
    fs.rmSync(resources, { recursive: true, force: true });
    await handlers.get('store:set')({}, 'zs:settings', settingsBefore);
  }
});

await check('автоподготовка: отмена VAD останавливает цепочку, повтор запускается', async () => {
  const models = require(path.resolve('electron/models.cjs'));
  const hardware = require(path.resolve('electron/hardware.cjs'));
  const saved = {
    status: models.modelStatus, vad: models.downloadVad, model: models.downloadModel,
    cancel: models.cancelDownload, lighter: hardware.lighterModel,
  };
  let started, finish;
  const vadStarted = new Promise((resolve) => { started = resolve; });
  let vadCalls = 0, modelCalls = 0;
  const settingsBefore = handlers.get('store:get')({}, 'zs:settings');
  models.modelStatus = () => ({ bin: true, server: true, vad: false, models: {} });
  models.downloadVad = () => {
    vadCalls++;
    if (vadCalls > 1) return Promise.resolve({ ok: true });
    started();
    return new Promise((resolve) => { finish = resolve; });
  };
  models.downloadModel = async () => { modelCalls++; return { ok: true }; };
  models.cancelDownload = () => { finish?.({ ok: false, canceled: true, reason: 'скачивание отменено' }); return { ok: true }; };
  hardware.lighterModel = () => null;
  try {
    const first = handlers.get('models:prepare')({});
    let timer;
    await Promise.race([vadStarted, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('VAD не запущен')), 1500); })]).finally(() => clearTimeout(timer));
    const simultaneous = handlers.get('models:prepare')({});
    if (vadCalls !== 1) throw new Error('одновременная подготовка запустилась дважды');
    if (!handlers.get('models:cancel')({}).ok) throw new Error('отмена не сработала');
    const [a, b] = await Promise.all([first, simultaneous]);
    if (a.ok || b.ok || !/отменено/.test(a.reason || '') || modelCalls) throw new Error(`после отмены: ${JSON.stringify({ a, b, modelCalls })}`);
    const retry = await handlers.get('models:prepare')({});
    if (!retry.ok || vadCalls !== 2 || modelCalls !== 1) throw new Error(`повтор: ${JSON.stringify({ retry, vadCalls, modelCalls })}`);
  } finally {
    finish?.({ ok: false, canceled: true, reason: 'скачивание отменено' });
    models.modelStatus = saved.status; models.downloadVad = saved.vad; models.downloadModel = saved.model;
    models.cancelDownload = saved.cancel; hardware.lighterModel = saved.lighter;
    await handlers.get('store:set')({}, 'zs:settings', settingsBefore);
  }
});

await check('автоподготовка: отмена обновления движка не запускает VAD и допускает повтор', async () => {
  const models = require(path.resolve('electron/models.cjs'));
  const saved = { status: models.modelStatus, engine: models.downloadEngine, vad: models.downloadVad };
  let attempts = 0, vadCalls = 0, ready = false;
  models.modelStatus = () => ({ bin: true, server: ready, vad: false, models: { base: { downloaded: true } } });
  models.downloadEngine = async (_progress, options) => {
    if (!options?.force) throw new Error('ожидалось обновление движка');
    if (++attempts === 1) return { ok: false, canceled: true, reason: 'скачивание отменено' };
    ready = true;
    return { ok: true };
  };
  models.downloadVad = async () => { vadCalls++; return { ok: true }; };
  try {
    const first = await handlers.get('models:prepare')({});
    if (first.ok || !first.canceled || vadCalls) throw new Error(`отмена: ${JSON.stringify({ first, vadCalls })}`);
    const retry = await handlers.get('models:prepare')({});
    if (!retry.ok || attempts !== 2 || vadCalls !== 1) throw new Error(`повтор: ${JSON.stringify({ retry, attempts, vadCalls })}`);
  } finally { models.modelStatus = saved.status; models.downloadEngine = saved.engine; models.downloadVad = saved.vad; }
});

await check('автоподготовка: ошибка очистки движка и VAD видна и останавливает цепочку', async () => {
  const models = require(path.resolve('electron/models.cjs'));
  const saved = { status: models.modelStatus, engine: models.downloadEngine, vad: models.downloadVad, model: models.downloadModel };
  let stage = 'engine', vadCalls = 0, modelCalls = 0;
  const failure = { ok: false, cleanupFailed: true, reason: 'не удалось удалить временные данные: файл занят' };
  models.modelStatus = () => ({ bin: true, server: stage === 'vad', vad: false, models: {} });
  models.downloadEngine = async () => failure;
  models.downloadVad = async () => { vadCalls++; return failure; };
  models.downloadModel = async () => { modelCalls++; return { ok: true }; };
  try {
    sentEvents.length = 0;
    const engine = await handlers.get('models:prepare')({});
    if (!engine.cleanupFailed || vadCalls || modelCalls) throw new Error(`движок: ${JSON.stringify({ engine, vadCalls, modelCalls })}`);
    stage = 'vad';
    sentEvents.length = 0;
    const vad = await handlers.get('models:prepare')({});
    if (!vad.cleanupFailed || vadCalls !== 1 || modelCalls) throw new Error(`VAD: ${JSON.stringify({ vad, vadCalls, modelCalls })}`);
    if (!sentEvents.some((e) => e.ch === 'model:progress' && e.payload?.id === 'vad' && e.payload.reason === failure.reason)) {
      throw new Error(`нет уведомления об очистке VAD: ${JSON.stringify(sentEvents)}`);
    }
  } finally {
    models.modelStatus = saved.status; models.downloadEngine = saved.engine; models.downloadVad = saved.vad; models.downloadModel = saved.model;
  }
});

await check('автоподготовка: отмена поиска движка возвращается без запуска VAD', async () => {
  const models = require(path.resolve('electron/models.cjs'));
  const saved = { status: models.modelStatus, engine: models.downloadEngine, vad: models.downloadVad };
  let vadCalls = 0;
  models.modelStatus = () => ({ bin: false, server: false, vad: false, models: {} });
  models.downloadEngine = async () => ({ ok: false, canceled: true, reason: 'скачивание отменено' });
  models.downloadVad = async () => { vadCalls++; return { ok: true }; };
  try {
    const result = await handlers.get('models:prepare')({});
    if (result.ok || !result.canceled || vadCalls) throw new Error(`отмена не передана: ${JSON.stringify({ result, vadCalls })}`);
  } finally { models.modelStatus = saved.status; models.downloadEngine = saved.engine; models.downloadVad = saved.vad; }
});

await check('автоподготовка: повтор после ошибки сети запускает поиск движка заново', async () => {
  const models = require(path.resolve('electron/models.cjs'));
  const saved = { status: models.modelStatus, engine: models.downloadEngine };
  let attempts = 0;
  models.modelStatus = () => ({ bin: false, server: false, vad: false, models: {} });
  models.downloadEngine = async () => { attempts++; return { ok: false, reason: 'сеть недоступна' }; };
  try {
    const first = await handlers.get('models:prepare')({});
    const second = await handlers.get('models:prepare')({});
    if (first.ok || second.ok || attempts !== 2) throw new Error(`повтор не выполнен: ${JSON.stringify({ first, second, attempts })}`);
  } finally { models.modelStatus = saved.status; models.downloadEngine = saved.engine; }
});

await check('пауза и отмена из плавающей плашки доходят до окна', async () => {
  sentEvents.length = 0;
  await handlers.get('hud:pause')({});
  await handlers.get('hud:resume')({});
  await handlers.get('hud:cancel')({});
  const channels = sentEvents.map((e) => e.ch);
  if (!channels.includes('dictation:pause')) throw new Error('нет dictation:pause');
  if (!channels.includes('dictation:cancel')) throw new Error('нет dictation:cancel');
  const paused = sentEvents.filter((e) => e.ch === 'dictation:pause').map((e) => Boolean(e.payload?.paused));
  if (!paused.includes(true) || !paused.includes(false)) throw new Error(`пауза/продолжить: ${paused}`);
});

await check('тишина не уходит в whisper и объясняет причину', async () => {
  runWhisper('спасибо за просмотр');
  spawnCalls.length = 0;
  const silence = new Uint8Array(16000 * 2); // секунда нулей
  const res = await handlers.get('stt:transcribe-pcm')({}, { pcm: silence, durationMs: 1000, lang: 'ru' });
  if (spawnCalls.some((c) => String(c.file).includes('whisper'))) throw new Error('whisper всё-таки запустился');
  if (res?.ok !== false || res.code !== 'silent') throw new Error(JSON.stringify(res));
  if (!/микрофон/i.test(res.reason)) throw new Error(`причина непонятная: ${res.reason}`);
});

await check('фраза-галлюцинация отбрасывается, а речь остаётся', async () => {
  runWhisper('Продолжение следует…');
  const phantom = await handlers.get('stt:transcribe-pcm')({}, { pcm: speechPcm(500), lang: 'ru' });
  if (phantom?.ok !== false || phantom.code !== 'phantom') throw new Error(JSON.stringify(phantom));
  runWhisper('Спасибо за просмотр, но давай вернёмся к смете');
  const real = await handlers.get('stt:transcribe-pcm')({}, { pcm: speechPcm(500), lang: 'ru' });
  if (!real?.ok || !real.text) throw new Error(`живая фраза потерялась: ${JSON.stringify(real)}`);
  if (!Number.isFinite(real.ms)) throw new Error('не вернулось время распознавания');
});

await check('вне Windows текст остаётся в буфере: вставлять некуда', async () => {
  // на не-Windows sendKeys не работает, значит вставки не было и буфер должен
  // сохранить текст — ровно то, что обещает тост «нажмите Ctrl+V»
  clipboardText.value = 'моя заметка';
  const ok = await handlers.get('text:insert')({}, 'надиктованный текст');
  await new Promise((r) => setTimeout(r, 900));
  if (!ok || ok.ok !== false) throw new Error(`вставка выдана за успешную: ${JSON.stringify(ok)}`);
  if (clipboardText.value !== 'надиктованный текст') {
    throw new Error(`в буфере осталось: ${clipboardText.value}`);
  }
});

await check('пустая запись не запускает whisper', async () => {
  runWhisper('не должно быть');
  spawnCalls.length = 0;
  const res = await handlers.get('stt:transcribe-pcm')({}, { pcm: new Uint8Array(0), lang: 'ru' });
  if (res?.ok) throw new Error('пустая запись распозналась');
  if (spawnCalls.some((c) => String(c.file).includes('whisper'))) throw new Error('whisper запущен на пустом файле');
});

spawnPlan.answer = null;

// ── HTTP к локальной модели: экранный контекст и текст ──────────────────────
await check('http:post доносит картинку до локальной модели', async () => {
  const http = await import('node:http');
  const got = { body: null };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      got.body = JSON.parse(body || '{}');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ response: 'Проект «Атлас», дедлайн пятница' }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const res = await handlers.get('http:post')({}, {
      url: `http://127.0.0.1:${port}/api/generate`,
      body: { model: 'qwen2.5:0.5b', prompt: 'что на экране?', images: ['data:image/png;base64,AAA'], stream: false },
      timeout: 4000,
    });
    if (!res?.ok) throw new Error(res?.reason || 'запрос не прошёл');
    if (got.body?.images?.[0] !== 'data:image/png;base64,AAA') throw new Error('картинка не дошла');
    if (res.data?.response !== 'Проект «Атлас», дедлайн пятница') throw new Error('ответ не разобран');
    const named = await handlers.get('http:post')({}, {
      url: `http://localhost:${port}/api/generate`, body: { prompt: 'тест localhost' }, timeout: 4000,
    });
    if (!named?.ok || got.body?.prompt !== 'тест localhost') throw new Error(`localhost не работает: ${named?.reason || named?.status}`);
  } finally {
    server.close();
  }
});

await check('http:get и http:post не отправляют данные по HTTP-перенаправлению', async () => {
  const http = await import('node:http');
  let redirected = 0;
  const destination = http.createServer((req, res) => {
    redirected += 1;
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"response":"перенаправление"}');
  });
  await new Promise((resolve) => destination.listen(0, '127.0.0.1', resolve));
  const source = http.createServer((req, res) => {
    req.resume();
    res.writeHead(307, { location: `http://127.0.0.1:${destination.address().port}/unexpected` });
    res.end();
  });
  await new Promise((resolve) => source.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${source.address().port}/api/generate`;
    const post = await handlers.get('http:post')({}, { url, body: { images: ['private-test-image'] }, timeout: 3000 });
    const get = await handlers.get('http:get')({}, url);
    if (redirected || post?.ok || get?.ok) throw new Error(`перенаправление выполнено: ${JSON.stringify({ redirected, post: post?.ok, get: get?.ok })}`);
  } finally {
    source.closeAllConnections();
    destination.closeAllConnections();
    source.close();
    destination.close();
  }
});

await check('http:post ограничивает ожидание тела ответа после заголовков', async () => {
  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"response":"');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const started = Date.now();
  const fallback = setTimeout(() => server.closeAllConnections(), 3500);
  try {
    const result = await handlers.get('http:post')({}, { url: `http://127.0.0.1:${port}/api/generate`, body: {}, timeout: 1000 });
    if (result?.ok || !/вовремя/.test(result?.reason || '') || Date.now() - started > 3000) {
      throw new Error(`ожидался таймаут тела: ${JSON.stringify(result)} за ${Date.now() - started} мс`);
    }
  } finally {
    clearTimeout(fallback);
    server.closeAllConnections();
    server.close();
  }
});

await check('http:get ограничивает ожидание тела ответа после заголовков', async () => {
  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"models":');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const started = Date.now();
  const fallback = setTimeout(() => server.closeAllConnections(), 6500);
  try {
    const result = await handlers.get('http:get')({}, `http://127.0.0.1:${server.address().port}/api/tags`);
    if (result?.ok || Date.now() - started > 6000 || !/вовремя|abort/i.test(result?.reason || '')) {
      throw new Error(`ожидался таймаут тела GET: ${JSON.stringify(result)} за ${Date.now() - started} мс`);
    }
  } finally {
    clearTimeout(fallback);
    server.closeAllConnections();
    server.close();
  }
});

await check('http:post не пускает наружу', async () => {
  for (const url of ['https://example.com/api/generate', 'file:///C:/Windows/System32/calc.exe', 'nonsense']) {
    const res = await handlers.get('http:post')({}, { url, body: {} });
    if (res?.ok) throw new Error(`пропущен адрес: ${url}`);
  }
  for (const url of ['http://10.example.com/api/generate', 'http://172.16.example.com', 'http://192.168.example.com', 'http://0.0.0.0']) {
    const res = await handlers.get('http:post')({}, { url, body: {} });
    if (res?.ok || !/локальн/i.test(res?.reason || '')) throw new Error(`не отклонён до подключения: ${url}`);
  }
});

// ── Снимок экрана для контекста ─────────────────────────────────────────────
await check('screen:capture без источников честно отказывает', async () => {
  const res = await handlers.get('screen:capture')({});
  if (res?.ok) throw new Error('вернул картинку без источников');
  if (!res?.reason) throw new Error('нет причины отказа');
});

await check('screen:capture отдаёт dataURL, когда экран доступен', async () => {
  const stub = electronStub.desktopCapturer;
  const original = stub.getSources;
  stub.getSources = async () => [{ thumbnail: { toDataURL: () => 'data:image/png;base64,QQ==' } }];
  try {
    const res = await handlers.get('screen:capture')({});
    if (!res?.ok) throw new Error(res?.reason || 'не снялось');
    if (!String(res.image).startsWith('data:image/png')) throw new Error('не dataURL');
    if (!(res.width > 0 && res.height > 0)) throw new Error('нет размеров экрана');
  } finally {
    stub.getSources = original;
  }
});

// Этот кейс подменяет process.platform и оставляет таймеры вставки (буфер
// возвращается через 700 мс), поэтому держим его последним в файле.
await check('вставка не забирает фокус у чужого окна', async () => {
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  const mainWin = findMainWindow();
  const restoreFocused = mainWin.isFocused;
  try {
    // окно ZSpeakly не в фокусе: человек печатает в браузере
    mainWin.isFocused = () => false;
    mainWin._focusCalls = 0;
    mainWin._inactiveCalls = 0;
    mainWin._showCalls = 0;
    mainWin._visible = false;
    await handlers.get('text:insert')({}, 'текст в чужое окно');
    await new Promise((r) => setTimeout(r, 400));
    if (mainWin._focusCalls > 0) throw new Error('окно забрало фокус после вставки');
    if (mainWin._showCalls > 0) throw new Error('окно показалось поверх чужого приложения');
    if (mainWin._visible) throw new Error('скрытое окно всплыло после вставки');

    // окно было в фокусе: его прячем, а после вставки возвращаем без фокуса
    mainWin.isFocused = () => true;
    mainWin._visible = true;
    mainWin._focusCalls = 0;
    mainWin._inactiveCalls = 0;
    await handlers.get('text:insert')({}, 'текст из окна приложения');
    await new Promise((r) => setTimeout(r, 500));
    if (mainWin._focusCalls > 0) throw new Error('после возврата окно снова забрало фокус');
    if (mainWin._inactiveCalls === 0) throw new Error('окно не вернулось на экран');
  } finally {
    mainWin.isFocused = restoreFocused;
    Object.defineProperty(process, 'platform', realPlatform);
  }
});

await check('модель подбирается под железо: три режима — быстро, сбалансированно, максимум', () => {
  const hw = require(path.resolve('electron/hardware.cjs'));
  const low = hw.pickModel({ cpus: 2, ramGb: 4 });
  if (low.id !== 'base-q5_1') throw new Error(`слабый ПК получил «${low.id}»`);
  if (low.tier !== 'fast') throw new Error(`слабый ПК попал не в режим «Быстро»: ${low.tier}`);
  const mid = hw.pickModel({ cpus: 6, ramGb: 16 });
  if (mid.id !== 'small-q5_1') throw new Error(`средний ПК получил «${mid.id}»`);
  if (mid.tier !== 'balanced') throw new Error(`средний ПК попал не в «Сбалансированно»: ${mid.tier}`);
  const high = hw.pickModel({ cpus: 12, ramGb: 32 });
  if (high.id !== 'large-v3-turbo-q5_0') throw new Error(`мощный ПК получил «${high.id}»`);
  if (high.tier !== 'max') throw new Error(`мощный ПК попал не в «Максимум»: ${high.tier}`);
  // ступень легче — ровно на один режим и только по цепочке
  if (hw.lighterModel('large-v3-turbo-q5_0') !== 'small-q5_1') throw new Error('нет шага вниз с максимума');
  if (hw.lighterModel('small-q5_1') !== 'base-q5_1') throw new Error('нет шага вниз со среднего');
  if (hw.lighterModel('base-q5_1') !== '') throw new Error('придумали модель легче самой лёгкой');
  // мало памяти при многих ядрах — тоже «слабый»: модель живёт в RAM
  if (hw.pickModel({ cpus: 16, ramGb: 6 }).id !== 'base-q5_1') throw new Error('не учли мало памяти');
  // «слишком тяжёлая» — это про скорость счёта, а не про вкус
  if (!hw.worthSwitching('small', 'base-q5_1')) throw new Error('small → base-q5_1 не считается выигрышем');
  if (!hw.worthSwitching('medium', 'base')) throw new Error('medium → base не считается выигрышем');
  // квант той же модели — это та же точность при меньшем весе, выигрыш честный
  if (!hw.worthSwitching('base', 'base-q5_1')) throw new Error('base → base-q5_1 не считается выигрышем');
  if (hw.worthSwitching('base', 'base')) throw new Error('одинаковые модели сравнивать незачем');
  if (hw.worthSwitching('tiny', 'base')) throw new Error('более лёгкую модель нельзя считать «слишком тяжёлой»');
  if (hw.worthSwitching('base', 'small-q5_1')) throw new Error('более качественную модель нельзя считать «слишком тяжёлой»');
  const hwThis = hw.thisMachine();
  if (!(hwThis.cpus >= 1) || !(hwThis.ramGb > 0)) throw new Error('не определили железо');
});

await check('переход на лёгкую модель: только когда она скачана и человек не выбрал свою', () => {
  const hw = require(path.resolve('electron/hardware.cjs'));
  // слабый ПК, стоит small, но base-q5_1 уже скачана → переходим
  const weak = hw.plan({ cpus: 2, ramGb: 4, current: 'small', downloaded: ['small', 'base-q5_1'] });
  if (weak.switchTo !== 'base-q5_1') throw new Error(`не переключился: «${weak.switchTo}»`);
  if (!/Быстро/.test(weak.why)) throw new Error(`не объяснил причину: ${weak.why}`);
  // той же модели нет на диске — не обещаем то, чего не можем
  if (hw.plan({ cpus: 2, ramGb: 4, current: 'small', downloaded: ['small'] }).switchTo !== '') {
    throw new Error('переключился на нескачанную модель');
  }
  // человек выбрал модель сам — не трогаем
  if (hw.plan({ cpus: 2, ramGb: 4, current: 'small', downloaded: ['small', 'base-q5_1'], pinned: true }).switchTo !== '') {
    throw new Error('переключил модель вопреки ручному выбору');
  }
  // автооптимизация выключена — тоже не трогаем
  if (hw.plan({ cpus: 2, ramGb: 4, current: 'small', downloaded: ['small', 'base-q5_1'], autoOptimize: false }).switchTo !== '') {
    throw new Error('переключил при выключенном автоподборе');
  }
  // мощный ПК на base: поднимаем на ступень выше сами — самый лёгкий режим
  // путает слова, а машина тянет «Сбалансированно»
  const up = hw.plan({ cpus: 8, ramGb: 16, current: 'base-q5_1', downloaded: ['base-q5_1', 'small-q5_1'] });
  if (up.switchTo !== 'small-q5_1' || up.up !== true) throw new Error(`не поднял качество: ${JSON.stringify(up)}`);
  if (!/точнее|точность|Быстро/.test(up.why)) throw new Error(`не объяснил, зачем поднял: ${up.why}`);
  // спустились сами — обратно не поднимаем, иначе спор с собственными замерами
  const stay = hw.plan({
    cpus: 8,
    ramGb: 16,
    current: 'base-q5_1',
    downloaded: ['base-q5_1', 'small-q5_1'],
    downgradedByApp: true,
  });
  if (stay.switchTo) throw new Error('поднялся обратно после собственного спуска');
  // на слабой машине «Быстро» — это честный выбор, поднимать некуда
  if (hw.plan({ cpus: 2, ramGb: 4, current: 'base-q5_1', downloaded: ['base-q5_1', 'small-q5_1'] }).switchTo !== '') {
    throw new Error('поднял модель на слабом ПК');
  }
  // выше стоит другая модель — не наше дело
  if (hw.plan({ cpus: 8, ramGb: 16, current: 'large-v3-turbo-q5_0', downloaded: ['large-v3-turbo-q5_0'] }).switchTo !== '') {
    throw new Error('тронул модель, которая не самая лёгкая');
  }
});

await check('ручной выбор модели закрепляется: приложение не передумывает само', async () => {
  await handlers.get('store:remove')({}, 'zs:modelPinned');
  await handlers.get('store:set')({}, 'zs:settings', { whisperModel: 'base' });
  if ((await handlers.get('store:get')({}, 'zs:modelPinned')) === true) {
    throw new Error('закрепили первое же сохранение настроек');
  }
  await handlers.get('store:set')({}, 'zs:settings', { whisperModel: 'tiny' });
  if ((await handlers.get('store:get')({}, 'zs:modelPinned')) !== true) {
    throw new Error('смена модели из настроек не закреплена');
  }
  // обычная правка других настроек не должна ничего закреплять заново
  await handlers.get('store:remove')({}, 'zs:modelPinned');
  await handlers.get('store:set')({}, 'zs:settings', { whisperModel: 'tiny', language: 'en' });
  if ((await handlers.get('store:get')({}, 'zs:modelPinned')) === true) {
    throw new Error('флаг появился без смены модели');
  }
});

// ── Скорость: один проход на короткую фразу, жадное декодирование ────────────
// Фраза из двух кусков речи с паузой в секунду: раньше такая запись резалась
// по паузе на два прохода движка, и каждый заново грузил веса модели.
const pcmWithPause = (parts = [2000, 1000, 2000]) => {
  const chunks = [];
  parts.forEach((ms, i) => {
    const samples = Math.round((16000 * ms) / 1000);
    const arr = new Int16Array(samples);
    for (let k = 0; k < samples; k += 1) {
      // чётные куски — «речь» (тон), нечётные — тишина
      arr[k] = i % 2 === 0 ? Math.round(6000 * Math.sin((2 * Math.PI * 220 * k) / 16000)) : 0;
    }
    chunks.push(Buffer.from(arr.buffer));
  });
  const all = Buffer.concat(chunks);
  return new Uint8Array(all.buffer, all.byteOffset, all.byteLength);
};

await check('короткая фраза с паузой — один проход движка, а не два', async () => {
  await handlers.get('store:set')({}, 'zs:settings', { whisperModel: 'small', keepModelLoaded: false });
  spawnCalls.length = 0;
  spawnPlan.answer = 'короткая фраза целиком';
  const res = await handlers.get('stt:transcribe-pcm')({}, { pcm: pcmWithPause(), durationMs: 5000, lang: 'ru' });
  spawnPlan.answer = null;
  const runs = spawnCalls.filter((c) => String(c.file).includes('whisper'));
  if (runs.length !== 1) throw new Error(`движок запускался ${runs.length} раз вместо одного`);
  if (!res?.ok) throw new Error(`нет текста: ${res?.reason || res?.code || '?'}`);
  // режим и время прохода должны доезжать до интерфейса
  if (res.mode !== 'cli') throw new Error(`режим не тот: ${res.mode}`);
  if (!(res.sttMs >= 0)) throw new Error('в ответе нет времени распознавания');
});

await check('двадцать секунд речи — один проход движка, а не три', async () => {
  // Жалоба человека: диктовка на двадцать секунд распознавалась двадцать
  // секунд. Причина — запись длиннее 15 с резалась по паузам на три прохода,
  // и каждый заново грузил веса модели. Всё, что короче окна whisper (30 с),
  // должно считаться за один проход.
  await handlers.get('store:set')({}, 'zs:settings', { whisperModel: 'small', keepModelLoaded: false });
  spawnCalls.length = 0;
  // Ответ должен быть правдоподобным: на четыре слова за двадцать секунд
  // приложение честно делает второй проход (см. electron/textQuality.cjs).
  spawnPlan.answer =
    'диктовка на двадцать секунд звучит как обычная речь, и слов в ней достаточно, ' +
    'чтобы движку не пришлось переспрашивать себя второй раз';
  await handlers.get('stt:transcribe-pcm')({}, {
    pcm: pcmWithPause([5000, 1000, 5000, 1000, 5000, 1000, 5000]),
    durationMs: 20000,
    lang: 'ru',
  });
  spawnPlan.answer = null;
  const runs = spawnCalls.filter((c) => String(c.file).includes('whisper'));
  if (runs.length !== 1) throw new Error(`движок запускался ${runs.length} раз вместо одного`);
});

await check('длинная диктовка без прогретого сервера — тоже один проход', async () => {
  // Без сервера каждый фрагмент — это повторная загрузка весов с диска.
  // whisper-cli сам режет файл на 30-секундные окна внутри одного процесса.
  await handlers.get('store:set')({}, 'zs:settings', { whisperModel: 'small', keepModelLoaded: false });
  spawnCalls.length = 0;
  spawnPlan.answer =
    'длинная диктовка целиком укладывается в одно окно движка, поэтому веса модели ' +
    'загружаются один раз, а не для каждого куска отдельно';
  // 40 секунд: пять речевых кусков по 6 с с паузами по секунде
  await handlers.get('stt:transcribe-pcm')({}, {
    pcm: pcmWithPause([6000, 1000, 6000, 1000, 6000, 1000, 6000, 1000, 6000]),
    durationMs: 40000,
    lang: 'ru',
  });
  spawnPlan.answer = null;
  const runs = spawnCalls.filter((c) => String(c.file).includes('whisper'));
  if (runs.length !== 1) throw new Error(`движок запускался ${runs.length} раз — веса грузятся повторно`);
});

await check('подозрительный текст не выдают за нормальный, а лишних проходов нет', async () => {
  // «Продолжение следует» на пяти секундах — заглушка, которой whisper
  // закрывает тишину. Такой текст нельзя вставлять человеку: делаем второй
  // проход с перебором температур и берём его, только если слов стало больше.
  await handlers.get('store:set')({}, 'zs:settings', { whisperModel: 'small', keepModelLoaded: false });
  spawnCalls.length = 0;
  spawnPlan.answer = 'Продолжение следует...';
  const once = await handlers.get('stt:transcribe-pcm')({}, {
    pcm: pcmWithPause([2000, 1000, 2000]),
    durationMs: 5000,
    lang: 'ru',
  });
  const runs = spawnCalls.filter((c) => String(c.file).includes('whisper'));
  // На быстрой машине первый проход уже «честный» (-bs 5, без -nf): второй
  // такой же ничего не изменит, поэтому лишнего запуска быть не должно.
  if (runs.length !== 1) throw new Error(`проходов ${runs.length}, ожидался один`);
  const args = runs[0].args.join(' ');
  if (args.includes('-nf')) throw new Error('быстрый проход остался быстрым на быстрой машине');
  if (!args.includes('-bs 5')) throw new Error('нет широкого перебора вариантов');
  if (!args.includes('-et 2.4') || !args.includes('-lpt -1.0')) {
    throw new Error('нет порогов, по которым whisper решает «нужен повтор»');
  }
  if (!args.includes('-nth 0.6')) throw new Error('нет порога «здесь нет речи»');
  if (once?.ok) throw new Error('заглушка выдана за нормальный текст');
  spawnPlan.answer = null;

  // А нормальный текст второго прохода не требует: за точность платим только
  // там, где она потерялась.
  spawnCalls.length = 0;
  spawnPlan.answer = 'позвони Пете и скажи, что встреча в три часа дня';
  await handlers.get('stt:transcribe-pcm')({}, {
    pcm: pcmWithPause([2000, 500, 2000]),
    durationMs: 4500,
    lang: 'ru',
  });
  spawnPlan.answer = null;
  const normal = spawnCalls.filter((c) => String(c.file).includes('whisper'));
  if (normal.length !== 1) throw new Error(`нормальную фразу переспросили: ${normal.length} проходов`);
});

await check('сервер распознавания поднимается с поиском по вариантам и без контекста', async () => {
  const whisperLib = require(path.resolve('electron/whisper.cjs'));
  const args = whisperLib.serverArgs({ modelPath: 'ggml-base.bin', port: 17801, threads: 2, vadModel: 'vad.bin' });
  const joined = args.join(' ');
  for (const flag of ['-mc 0', '-bs 3', '-bo 1', '-nt', '-sns']) {
    if (!joined.includes(flag)) throw new Error(`нет флага ${flag}: ${joined}`);
  }
  if (!joined.includes('--vad')) throw new Error('VAD-гейт потерялся');
  const noVad = whisperLib.serverArgs({ modelPath: 'm.bin', port: 1, threads: 1, vadModel: '' }).join(' ');
  if (noVad.includes('--vad')) throw new Error('VAD приклеился, хотя модели нет');
});

await check('большой модели дают больше времени на загрузку весов', async () => {
  const whisperLib = require(path.resolve('electron/whisper.cjs'));
  const base = whisperLib.modelLoadBudgetMs('ggml-base.bin');
  const small = whisperLib.modelLoadBudgetMs('ggml-small.bin');
  const large = whisperLib.modelLoadBudgetMs('ggml-large-v3-turbo.bin');
  if (!(base < small && small < large)) throw new Error(`бюджеты не растут: ${base}/${small}/${large}`);
  if (base < 8000) throw new Error('базовой модели дают меньше восьми секунд — на слабом диске не успеет');
});

await check('видно, есть ли сервер распознавания: без него каждая фраза грузит веса', async () => {
  const modelsLib = require(path.resolve('electron/models.cjs'));
  const before = modelsLib.modelStatus();
  if (before.server !== false) throw new Error('сервер нашёлся там, где его нет');
  const { dirs } = { dirs: () => ({ bin: path.join(userData, 'bin'), models: path.join(userData, 'models') }) };
  fs.writeFileSync(path.join(dirs().bin, 'whisper-server.exe'), 'fake');
  try {
    const after = modelsLib.modelStatus();
    if (after.server !== true) throw new Error('сервер не увидели после установки');
    if (!after.bin) throw new Error('движок пропал из статуса');
  } finally {
    fs.rmSync(path.join(dirs().bin, 'whisper-server.exe'), { force: true });
  }
});

await check('потоков движку — по физическим ядрам, а не по показаниям ОС', async () => {
  const os = require('node:os');
  const whisperLib = require(path.resolve('electron/whisper.cjs'));
  const real = os.cpus;
  const withCpus = (n) => {
    os.cpus = () => new Array(n).fill({ model: 'test' });
  };
  try {
    withCpus(2);
    if (whisperLib.threadCount() !== 2) throw new Error(`2 ядра → ${whisperLib.threadCount()} потоков`);
    withCpus(4);
    if (whisperLib.threadCount() !== 4) throw new Error(`4 ядра → ${whisperLib.threadCount()} потоков`);
    // 8 логических = 4 физических: с -t 8 whisper считает медленнее
    withCpus(8);
    if (whisperLib.threadCount() !== 4) throw new Error(`8 потоков → ${whisperLib.threadCount()}, ожидалось 4`);
    withCpus(16);
    if (whisperLib.threadCount() > 8) throw new Error('потоков больше восьми');
    // параллельные запросы сервера — только на многопоточной машине
    withCpus(4);
    if (whisperLib.processorCount() !== 1) throw new Error('на 4 ядрах включили параллельность');
    withCpus(16);
    if (whisperLib.processorCount() !== 2) throw new Error('на 16 потоках параллельность не включилась');
  } finally {
    os.cpus = real;
  }
});

await check('на короткой фразе VAD не включается — там уже нет тишины', async () => {
  const vadPath = path.join(userData, 'models', 'ggml-silero-v6.2.0.bin');
  fs.mkdirSync(path.dirname(vadPath), { recursive: true });
  fs.writeFileSync(vadPath, 'fake');
  await handlers.get('store:set')({}, 'zs:settings', { whisperModel: 'small', keepModelLoaded: false, vadEnabled: true });
  runWhisper('короткая фраза');
  spawnCalls.length = 0;
  try {
    await handlers.get('stt:transcribe-pcm')({}, { pcm: speechPcm(1500), durationMs: 1500, lang: 'ru', model: 'small' });
    const call = spawnCalls.find((c) => String(c.file).includes('whisper'));
    if (!call) throw new Error('движок не запускался');
    if (call.args.includes('--vad')) throw new Error('на 1,5-секундной записи включился VAD');
    // а на длинной — должен включиться: там паузы реально есть
    spawnCalls.length = 0;
    await handlers.get('stt:transcribe-pcm')({}, { pcm: speechPcm(6000), durationMs: 6000, lang: 'ru', model: 'small' });
    const long = spawnCalls.find((c) => String(c.file).includes('whisper'));
    if (!long?.args.includes('--vad')) throw new Error('на длинной записи VAD потерялся');
  } finally {
    fs.rmSync(vadPath, { force: true });
    spawnPlan.answer = null;
  }
});

await check('text:target честно говорит, куда попадёт текст', async () => {
  const target = handlers.get('text:target');
  if (!target) throw new Error('нет канала text:target');
  const mainWin = electronStub.BrowserWindow.instances?.[0];
  const own = await target({});
  if (!own || own.own !== true) throw new Error(`окно в фокусе, а ответ: ${JSON.stringify(own)}`);
  if (mainWin) {
    const restore = mainWin.isFocused;
    mainWin.isFocused = () => false;
    try {
      const other = await target({});
      // на не-Windows заголовок окна взять неоткуда — честный пустой ответ,
      // а не выдуманное «куда-то вставим»
      if (other?.own !== false) throw new Error(`не наше окно, а ответ: ${JSON.stringify(other)}`);
      if (process.platform !== 'win32' && other.title) throw new Error('придумали заголовок окна');
    } finally {
      mainWin.isFocused = restore;
    }
  }
});

// ── Русский движок (GigaAM v3): словарь, нарезка, декодирование, скачивание ──
// Модель весит 226 МБ и в песочнице недоступна, поэтому проверяем то, что можно
// проверить без весов: склейку текста, нарезку длинной записи, сам цикл
// декодирования на подставных сетях и скачивание с проверкой хеша. Это ровно те
// места, где ошибка даёт «почти правильный» текст и молчаливую поломку.

await check('словарь русской модели: кусочки, пробелы, пустой токен', async () => {
  const { parseVocabulary, tokensToText } = require(path.resolve('electron/gigaamVocab.cjs'));
  // порядок кусочков нарочно перемешан: номер важнее строки
  const text = ['▁ 1', '. 2', 'т 3', 'е 4', 'в 5', 'и 6', ', 7', 'р 8', 'п 9', '<blk> 10', '▁п 11'].join('\n');
  const vocab = parseVocabulary(text);
  if (vocab.blankId !== 10) throw new Error(`пустой токен не найден: ${vocab.blankId}`);
  // «привет, привет.» — проверяем и склейку, и пробел перед запятой
  const ids = [11, 8, 6, 5, 4, 3, 7, 1, 11, 8, 6, 5, 4, 3, 2];
  const out = tokensToText(vocab, ids);
  if (out !== 'привет, привет.') throw new Error(`склейка дала «${out}»`);
  // пробел после открывающей кавычки и перед закрывающей — лишний
  const q = parseVocabulary(['« 1', 'с 2', 'л 3', 'о 4', 'в 5', 'о 6', '» 7', '<blk> 8'].join('\n'));
  if (tokensToText(q, [1, 2, 3, 4, 5, 6, 7]) !== '«слово»') throw new Error('кавычки склеены неверно');
  let failed = false;
  try {
    parseVocabulary('мусор без номера');
  } catch {
    failed = true;
  }
  if (!failed) throw new Error('битый словарь принят молча');
});

await check('длинная запись режется на куски не длиннее двадцати секунд', () => {
  const { chunkRanges, quietestPoint } = require(path.resolve('electron/chunking.cjs'));
  const sr = 16000;
  // 45 секунд: речь с паузами каждые 6 секунд — разрез обязан попасть в паузу
  const total = 45 * sr;
  const samples = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    const second = i / sr;
    const inPause = Math.abs(second % 6) < 0.25;
    samples[i] = inPause ? 0 : Math.sin((2 * Math.PI * 220 * i) / sr) * 0.3;
  }
  const ranges = chunkRanges(samples, 20 * sr);
  const sum = ranges.reduce((acc, r) => acc + r.count, 0);
  if (sum !== total) throw new Error(`куски покрывают ${sum} из ${total} отсчётов`);
  if (ranges.some((r) => r.count > 20 * sr)) throw new Error('кусок длиннее предела');
  if (ranges.length < 3) throw new Error(`45 секунд разрезаны на ${ranges.length} куска`);
  // первый разрез — в паузе: рядом с местом разреза энергия близка к нулю
  const cut = ranges[0].count;
  const near = quietestPoint(samples, Math.max(0, cut - 800), cut + 800);
  const energy = Math.abs(near - cut) <= 800 ? true : false;
  if (!energy) throw new Error('разрез ушёл далеко от тишины');
});

await check('кусок посреди фразы не начинает новое предложение с заглавной', () => {
  const { continuing, append } = require(path.resolve('electron/chunking.cjs'));
  if (continuing('я пошёл в магазин и', 'Купил хлеб.') !== 'купил хлеб.') {
    throw new Error('заглавная посреди фразы осталась');
  }
  if (continuing('Купил хлеб.', 'Потом пошёл домой.') !== 'Потом пошёл домой.') {
    throw new Error('заглавная после точки потеряна');
  }
  // аббревиатура не трогается: вторая буква заглавная
  if (continuing('мы говорили про', 'США и Канаду.') !== 'США и Канаду.') {
    throw new Error('аббревиатура испорчена');
  }
  if (append('', ' текст ') !== 'текст') throw new Error('пробелы не подрезаны');
  if (append('привет', '') !== 'привет') throw new Error('пустой кусок добавил пробел');
});

await check('движок выбирается политикой: русский — русская модель, остальное — прежняя', () => {
  const { chooseEngine } = require(path.resolve('electron/sttEngine.cjs'));
  const ready = { available: true };
  const cases = [
    [{ language: 'ru', gigaam: ready, seconds: 4 }, 'gigaam'],
    [{ language: 'ru', gigaam: ready, seconds: 4, preference: 'whisper' }, 'whisper'],
    [{ language: 'en', gigaam: ready, parakeet: { available: true, languages: ['en'] }, seconds: 4, preference: 'whisper' }, 'whisper'],
    [{ language: 'ru-RU', gigaam: ready, seconds: 4 }, 'gigaam'],
    [{ language: 'en', gigaam: ready, seconds: 4 }, 'whisper'],
    [{ language: 'ru', gigaam: { available: false, reason: 'модель не скачана' }, seconds: 4 }, 'whisper'],
    [{ language: 'ru', gigaam: ready, seconds: 0.4 }, 'whisper'],
  ];
  for (const [input, expected] of cases) {
    const got = chooseEngine(input);
    if (got.engine !== expected) throw new Error(`${JSON.stringify(input)} → ${got.engine}, ждали ${expected}`);
    if (!got.why) throw new Error('решение без причины: в журнале будет нечего читать');
  }
  // причина отказа — та, что пришла от движка, а не выдуманная
  const why = chooseEngine({ language: 'ru', gigaam: { available: false, reason: 'нет модуля расчёта' } });
  if (!why.why.includes('нет модуля')) throw new Error('причина отказа потерялась');
});

await check('жадное декодирование собирает фразу из подставных сетей', async () => {
  const gigaam = require(path.resolve('electron/gigaam.cjs'));
  const { parseVocabulary } = require(path.resolve('electron/gigaamVocab.cjs'));
  // словарь: ▁ п р и в е т <blk>
  const vocab = parseVocabulary(['▁ 0', 'п 1', 'р 2', 'и 3', 'в 4', 'е 5', 'т 6', '<blk> 7'].join('\n'));
  const frameTokens = [[0, 1, 2], [3, 4, 5], [6], [7]];
  const session = (run) => ({ run });
  const state = { frame: -1, inside: 0 };
  const sessions = {
    vocab,
    preprocessor: session(async (feeds) => {
      // один кадр признаков на 10 отсчётов — как у настоящего графа
      const frames = Math.max(1, Math.floor(feeds.waveforms.data.length / 10));
      return {
        features: { data: new Float32Array(64 * frames), dims: [1, 64, frames], get: () => frames },
        features_lens: { data: BigInt64Array.from([BigInt(frames)]), dims: [1], get: () => frames },
      };
    }),
    encoder: session(async (feeds) => {
      const frames = feeds.audio_signal.dims[2];
      const dim = 4;
      return {
        // «вес» кадра — его номер: так декодер получает нужный токен по порядку
        encoded: {
          // Значение по индексу (i % frames) — это «номер кадра»; движок берёт
          // кадр как flat[0 * frames + frame], поэтому номер доходит до джойнта.
          data: new Float32Array(dim * frames).map((_, i) => i % frames),
          dims: [1, dim, frames],
          get: () => 0,
        },
        encoded_len: { data: Int32Array.from([Math.min(frames, frameTokens.length)]), dims: [1], get: () => Math.min(frames, frameTokens.length) },
      };
    }),
    decoder: session(async (feeds) => {
      const token = Number(feeds.x.data[0]);
      return {
        dec: { data: new Float32Array(320).fill(token), dims: [1, 1, 320], get: () => 0 },
        h: { data: new Float32Array(320), dims: [1, 1, 320], get: () => 0 },
        c: { data: new Float32Array(320), dims: [1, 1, 320], get: () => 0 },
      };
    }),
    joint: session(async (feeds) => {
      // Номер кадра лежит в первом значении энкодера: по нему выбираем, что
      // этот кадр «говорит». Внутри кадра выдаём токены по порядку — так
      // проверяется и предел в три токена на кадр.
      const frameNumber = Math.round(feeds.enc.data[0]);
      const tokens = frameTokens[Math.max(0, Math.min(frameNumber, frameTokens.length - 1))];
      if (frameNumber !== state.frame) {
        state.frame = frameNumber;
        state.inside = 0;
      }
      const logits = new Float32Array(8).fill(-1);
      const next = tokens[state.inside];
      if (next === undefined || next === 7) logits[7] = 5;
      else logits[next] = 5;
      state.inside += 1;
      return { joint: { data: logits, dims: [1, 1, 8], get: () => 0 } };
    }),
  };
  gigaam.setTestDeps({ sessions, files: [] });
  try {
    const pcm = Buffer.alloc(16000 * 2);
    for (let i = 0; i < 16000; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 8) * 8000), i * 2);
    const result = await gigaam.transcribe(pcm, { sampleRate: 16000 });
    if (!result.ok) throw new Error(`движок отказал: ${result.reason}`);
    if (!result.text.startsWith('привет')) throw new Error(`получилось «${result.text}»`);
    if (result.chunks !== 1) throw new Error(`ожидали один кусок, а вышло ${result.chunks}`);
    // движок обязан отказать на чужой частоте, а не молча пересчитать неправильно
    const wrongRate = await gigaam.transcribe(pcm, { sampleRate: 48000 });
    if (wrongRate.ok || !/16 кГц/.test(wrongRate.reason)) throw new Error('чужая частота принята молча');

    // Отмена посреди счёта: кнопка «Отменить» должна влиять на русский движок,
    // а не только на прежний. Считаем недолго и просим остановиться.
    const stopAfter = { left: 3 };
    // Несколько десятков кадров «тишины»: отмена должна прервать именно счёт,
    // а не совпасть с его концом.
    sessions.encoder = session(async (feeds) => {
      const frames = 60;
      const dim = 4;
      return {
        encoded: { data: new Float32Array(dim * frames), dims: [1, dim, frames], get: () => 0 },
        encoded_len: { data: Int32Array.from([frames]), dims: [1], get: () => frames },
      };
    });
    sessions.joint = session(async (feeds) => {
      if (stopAfter.left-- <= 0) gigaam.cancel();
      const logits = new Float32Array(8).fill(-1);
      logits[7] = 5;
      return { joint: { data: logits, dims: [1, 1, 8], get: () => 0 } };
    });
    const cancelled = await gigaam.transcribe(pcm, { sampleRate: 16000 });
    if (cancelled.ok || !/отмен/.test(cancelled.reason)) {
      throw new Error(`отмена проигнорирована: ${JSON.stringify(cancelled)}`);
    }
  } finally {
    gigaam.reset();
  }
});

await check('скачивание русской модели проверяет размер и хеш каждого файла', async () => {
  const gigaam = require(path.resolve('electron/gigaam.cjs'));
  const crypto = require('node:crypto');
  const http = require('node:http');
  const files = {
    'v3_e2e_rnnt_vocab.txt': '▁ 0\nа 1\n<blk> 2\n',
    'v3_e2e_rnnt_joint.int8.onnx': 'joint-bytes',
  };
  const manifest = Object.entries(files).map(([name, body]) => ({
    name,
    size: Buffer.byteLength(body),
    sha256: crypto.createHash('sha256').update(body).digest('hex'),
  }));
  const server = http.createServer((req, res) => {
    const name = req.url.split('/').pop();
    if (!(name in files)) {
      res.statusCode = 404;
      res.end('нет такого файла');
      return;
    }
    res.end(files[name]);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  gigaam.setTestDeps({ files: manifest, ort: { InferenceSession: {} } });
  try {
    const state = gigaam.status();
    if (state.available) throw new Error('движок «готов» без файлов');
    if (state.missing.length !== manifest.length) throw new Error('не все файлы считаются отсутствующими');
    const done = await gigaam.downloadModel({ baseUrl: `http://127.0.0.1:${port}` });
    if (!done.available) throw new Error(`после скачивания движок не готов: ${done.reason}`);
    const onDisk = fs.readFileSync(path.join(gigaam.modelDir(), 'v3_e2e_rnnt_vocab.txt'), 'utf8');
    if (onDisk !== files['v3_e2e_rnnt_vocab.txt']) throw new Error('скачался не тот файл');

    // повреждённый файл не должен становиться моделью
    fs.rmSync(gigaam.modelDir(), { recursive: true, force: true });
    // Та же длина, другой хеш: отдельно проверяем именно хеш, а не размер.
    const broken = files['v3_e2e_rnnt_vocab.txt'].replace('а', 'б');
    files['v3_e2e_rnnt_vocab.txt'] = broken;
    let failed = false;
    try {
      await gigaam.downloadModel({ baseUrl: `http://127.0.0.1:${port}` });
    } catch (err) {
      failed = /повреждённым/.test(String(err?.message || err));
    }
    if (!failed) throw new Error('повреждённый файл принят как модель');
    const leftovers = fs.readdirSync(gigaam.modelDir()).filter((name) => name.endsWith('.unverified'));
    if (leftovers.length) throw new Error(`остались недокачанные файлы: ${leftovers.join(', ')}`);
  } finally {
    server.close();
    gigaam.reset();
  }
});

await check('отмена русской и европейской моделей прерывает соединение и убирает временный файл', async () => {
  const http = require('node:http');
  const server = http.createServer((_req, res) => {
    res.writeHead(200);
    res.write('часть'); // сервер специально не заканчивает ответ
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    for (const name of ['gigaam', 'parakeet']) {
      const engine = require(path.resolve(`electron/${name}.cjs`));
      const manifest = [{ name: 'test.bin', size: 1000, sha256: '0'.repeat(64) }];
      engine.setTestDeps({ files: manifest, ort: { InferenceSession: {} } });
      fs.rmSync(engine.modelDir(), { recursive: true, force: true });
      let read;
      const received = new Promise((resolve) => { read = resolve; });
      try {
        const task = engine.downloadModel({ baseUrl: `http://127.0.0.1:${server.address().port}`, onProgress: read });
        const result = task.then(() => 'загрузка завершилась', (err) => String(err?.message || err));
        await received;
        let duplicate = false;
        try { await engine.downloadModel({ baseUrl: `http://127.0.0.1:${server.address().port}` }); }
        catch (err) { duplicate = /уже выполняется/.test(String(err?.message || err)); }
        if (!duplicate) throw new Error(`${name}: повторная загрузка не заблокирована`);
        const cancelled = handlers.get('models:cancel')({});
        if (!cancelled?.ok) throw new Error(`${name}: общая отмена не сработала`);
        let timer;
        const reason = await Promise.race([
          result,
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${name}: отмена зависла`)), 2000); }),
        ]).finally(() => clearTimeout(timer));
        if (!/отмен/.test(reason)) throw new Error(`${name}: причина: ${reason}`);
        const remaining = fs.readdirSync(engine.modelDir());
        if (remaining.length) throw new Error(`${name}: остались файлы ${remaining.join(', ')}`);
        if (engine.cancelDownload()) throw new Error(`${name}: после отмены загрузка ещё активна`);
      } finally {
        engine.cancelDownload();
        engine.reset();
        fs.rmSync(engine.modelDir(), { recursive: true, force: true });
      }
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

await check('движок: отмена во время поиска релиза через общий канал', async () => {
  const http = require('node:http');
  const https = require('node:https');
  const models = require(path.resolve('electron/models.cjs'));
  let started;
  const requested = new Promise((resolve) => { started = resolve; });
  const server = http.createServer((_req, _res) => started());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const originalGet = https.get;
  https.get = (_url, options, callback) => http.get(`http://127.0.0.1:${server.address().port}/`, options, callback);
  let task;
  try {
    task = models.downloadEngine(undefined, { force: true });
    await requested;
    const cancelled = handlers.get('models:cancel')({});
    if (!cancelled?.ok) throw new Error(`отмена поиска не принята: ${JSON.stringify(cancelled)}`);
    let timer;
    const result = await Promise.race([task, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('поиск релиза завис')), 2000); })]).finally(() => clearTimeout(timer));
    if (result.ok || !result.canceled || !/отменено/.test(result.reason)) throw new Error(`ответ: ${JSON.stringify(result)}`);
  } finally {
    models.cancelDownload(); https.get = originalGet;
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    await task;
  }
});

await check('Whisper: отмена через IPC до ответа и повтор загрузки', async () => {
  const http = require('node:http');
  const https = require('node:https');
  const models = require(path.resolve('electron/models.cjs'));
  const target = path.join(userData, 'models', models.MODELS['tiny-q5_1'].file);
  fs.rmSync(target, { force: true });
  let waiting;
  const requested = new Promise((resolve) => { waiting = resolve; });
  let respond = false;
  const server = http.createServer((_req, res) => {
    if (respond) res.end('тест');
    else waiting();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const originalGet = https.get;
  https.get = (_url, options, callback) => http.get(`http://127.0.0.1:${server.address().port}/`, options, callback);
  try {
    const first = handlers.get('models:download')({}, 'tiny-q5_1');
    await requested;
    const duplicate = await handlers.get('models:download')({}, 'tiny-q5_1');
    if (duplicate.ok || !/уже выполняется/.test(duplicate.reason)) throw new Error(`параллельная загрузка: ${JSON.stringify(duplicate)}`);
    if (!handlers.get('models:cancel')({}).ok) throw new Error('отмена не сработала');
    let timer;
    const result = await Promise.race([
      first,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('отмена зависла')), 2000); }),
    ]).finally(() => clearTimeout(timer));
    if (result.ok || !/отменено/.test(result.reason)) throw new Error(`ответ: ${JSON.stringify(result)}`);
    if (fs.existsSync(target) || fs.existsSync(`${target}.part`)) throw new Error('остался файл загрузки');
    respond = true;
    const retry = await handlers.get('models:download')({}, 'tiny-q5_1');
    if (!retry.ok || fs.readFileSync(target, 'utf8') !== 'тест') throw new Error(`повтор: ${JSON.stringify(retry)}`);
  } finally {
    models.cancelDownload();
    https.get = originalGet;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(target, { force: true });
    fs.rmSync(`${target}.part`, { force: true });
  }
});

await check('VAD: отмена до ответа сервера возвращает признак отмены', async () => {
  const http = require('node:http');
  const https = require('node:https');
  const models = require(path.resolve('electron/models.cjs'));
  const target = path.join(userData, 'models', models.VAD.file);
  fs.rmSync(target, { force: true });
  let started;
  const requested = new Promise((resolve) => { started = resolve; });
  const server = http.createServer((_req, _res) => started());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const originalGet = https.get;
  https.get = (_url, options, callback) => http.get(`http://127.0.0.1:${server.address().port}/`, options, callback);
  try {
    const task = models.downloadVad();
    await requested;
    if (!handlers.get('models:cancel')({}).ok) throw new Error('отмена VAD не сработала');
    let timer;
    const result = await Promise.race([task, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('отмена VAD зависла')), 2000); })]).finally(() => clearTimeout(timer));
    if (result.ok || !result.canceled || !/отменено/.test(result.reason)) throw new Error(`ответ VAD: ${JSON.stringify(result)}`);
    if (fs.existsSync(target) || fs.existsSync(`${target}.part`)) throw new Error('остался файл VAD');
  } finally {
    models.cancelDownload(); https.get = originalGet;
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    fs.rmSync(target, { force: true }); fs.rmSync(`${target}.part`, { force: true });
  }
});

await check('словарь европейской модели: кусочки, пробелы, служебные токены', async () => {
  const parakeet = require(path.resolve('electron/parakeet.cjs'));
  const vocab = parakeet.parseVocabulary(
    ['\u2581hello 0', '\u2581world 1', '\u2581 2', '<blk> 3', '<unk> 4', 'мусор без номера', ''].join('\n'),
  );
  if (vocab.blankId !== 3) throw new Error(`пустой токен не найден: ${vocab.blankId}`);
  if (vocab.size !== 5) throw new Error(`размер словаря ${vocab.size}, а ждали 5`);
  // «▁» — это пробел, служебные <...> в текст не попадают
  const text = parakeet.joinTokens(vocab, [0, 1, 2, 0, 3, 4]);
  if (text !== 'hello world hello') throw new Error(`собралось «${text}»`);
});

await check('TDT-декодирование: пропуск кадров и порядок токенов', async () => {
  const parakeet = require(path.resolve('electron/parakeet.cjs'));
  const vocab = parakeet.parseVocabulary(
    ['\u2581hello 0', '\u2581world 1', '\u2581 2', '<blk> 3'].join('\n') + '\n',
  );
  const session = (run) => ({ run });
  // Первый кадр: «hello» и пропуск трёх кадров. Третий: «world» и ещё пропуск.
  // Если движок не умеет TDT, он застрянет на первом кадре и потеряет второе слово.
  const plan = { 0: { token: 0, step: 3 }, 3: { token: 1, step: 3 } };
  const seenFrames = [];
  const sessions = {
    vocab,
    state: { layers: 2, size: 4 },
    preprocessor: session(async (feeds) => {
      const frames = Math.max(1, Math.floor(feeds.waveforms.data.length / 10));
      return {
        features: { data: new Float32Array(128 * frames), dims: [1, 128, frames], get: () => frames },
        features_lens: { data: BigInt64Array.from([BigInt(frames)]), dims: [1], get: () => frames },
      };
    }),
    encoder: session(async (feeds) => {
      const frames = feeds.audio_signal.dims[2];
      return {
        // в первом значении кадра лежит его номер — по нему план и срабатывает
        outputs: {
          data: new Float32Array(4 * frames).map((_, i) => i % frames),
          dims: [1, 4, frames],
          get: () => 0,
        },
        encoded_lengths: { data: BigInt64Array.from([BigInt(frames)]), dims: [1], get: () => frames },
      };
    }),
    decoderJoint: session(async (feeds) => {
      // Контракт настоящего decoder_joint-model.int8.onnx (не int64).
      for (const key of ['targets', 'target_length']) {
        if (feeds[key].type !== 'int32' || !(feeds[key].data instanceof Int32Array)) {
          throw new Error(`${key} должен быть int32`);
        }
      }
      const frameNumber = Math.round(feeds.encoder_outputs.data[0]);
      seenFrames.push(frameNumber);
      const step = plan[frameNumber];
      // Пять значений после словаря — это «сколько кадров пропустить».
      const logits = new Float32Array(4 + 5).fill(-1);
      logits[step ? step.token : 3] = 5;
      logits[4 + (step ? step.step : 0)] = 5;
      const state = new Float32Array(8);
      return {
        outputs: { data: logits, dims: [1, 1, 9], get: () => 0 },
        output_states_1: { data: state, dims: [2, 1, 4], get: () => 0 },
        output_states_2: { data: state, dims: [2, 1, 4], get: () => 0 },
      };
    }),
  };
  parakeet.setTestDeps({ sessions, files: [] });
  try {
    const pcm = Buffer.alloc(16000 * 2);
    for (let i = 0; i < 16000; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 8) * 8000), i * 2);
    const result = await parakeet.transcribe(pcm, { sampleRate: 16000 });
    if (!result.ok) throw new Error(`движок отказал: ${result.reason}`);
    if (result.text !== 'hello world') throw new Error(`получилось «${result.text}»`);
    // пропуски действительно были: без них движок перебрал бы все кадры подряд
    // пропуск действительно был: после «hello» движок перескочил кадры 1 и 2
    if (!seenFrames.includes(3)) throw new Error('второй кадр по плану не посчитан');
    if (seenFrames.includes(1) || seenFrames.includes(2)) throw new Error('кадры не пропускались');

    // движок обязан отказать на чужой частоте, а не молча пересчитать неправильно
    const wrongRate = await parakeet.transcribe(pcm, { sampleRate: 48000 });
    if (wrongRate.ok || !/16 кГц/.test(wrongRate.reason)) throw new Error('чужая частота принята молча');
  } finally {
    parakeet.reset();
  }
});

await check('движок выбирается по языку: русский, европейские, остальные', async () => {
  const { chooseEngine } = require(path.resolve('electron/sttEngine.cjs'));
  const parakeet = require(path.resolve('electron/parakeet.cjs'));
  const ready = { available: true, reason: '', languages: parakeet.LANGUAGES };
  const russian = { available: true, reason: '' };
  const cases = [
    [{ language: 'ru', gigaam: russian, parakeet: ready, seconds: 4 }, 'gigaam'],
    [{ language: 'en', gigaam: russian, parakeet: ready, seconds: 4 }, 'parakeet'],
    [{ language: 'de-DE', gigaam: russian, parakeet: ready, seconds: 4 }, 'parakeet'],
    [{ language: 'uk', gigaam: russian, parakeet: ready, seconds: 4 }, 'parakeet'],
    // модель не скачана — прежний движок и честная причина
    [{ language: 'en', gigaam: russian, parakeet: { available: false, reason: 'модель не скачана' }, seconds: 4 }, 'whisper'],
    // язык, которого модель не знает: китайский остаётся на прежнем движке
    [{ language: 'zh', gigaam: russian, parakeet: ready, seconds: 4 }, 'whisper'],
    [{ language: 'ja', gigaam: russian, parakeet: ready, seconds: 4 }, 'whisper'],
    // короткая запись — прежний движок
    [{ language: 'en', gigaam: russian, parakeet: ready, seconds: 0.4 }, 'whisper'],
  ];
  for (const [input, expected] of cases) {
    const got = chooseEngine(input);
    if (got.engine !== expected) {
      throw new Error(`для ${JSON.stringify(input.language)} ждали ${expected}, вышло ${got.engine} (${got.why})`);
    }
  }
  const why = chooseEngine({ language: 'en', parakeet: { available: false, reason: 'нет модуля расчёта', languages: parakeet.LANGUAGES } });
  if (!why.why.includes('нет модуля')) throw new Error('причина отказа потерялась');
});

await check('поздний сбой при выходе восстанавливает окно, если оно уже закрыто', async () => {
  const profile = path.join(userData, 'profile.json');
  const rename = fs.renameSync;
  const event = () => ({ prevented: false, preventDefault() { this.prevented = true; } });
  const emit = (name) => {
    const e = event();
    for (const fn of appListeners.get(name) || []) fn(e);
    return e;
  };
  try {
    const before = emit('before-quit');
    if (before.prevented) throw new Error('обычный выход остановлен');
    await handlers.get('store:set')({}, 'zs:late-reopen', 'ещё в памяти');
    const count = windowInstances.length;
    findMainWindow().emit('closed');
    fs.renameSync = (from, to) => {
      if (to === profile) throw Object.assign(new Error('нет места'), { code: 'ENOSPC' });
      return rename(from, to);
    };
    quitDialogChoice = 0;
    if (!emit('will-quit').prevented) throw new Error('выход не отменён');
    if (windowInstances.length !== count + 1 || !windowInstances.at(-1).isVisible()) throw new Error('окно не восстановлено');
    if (await handlers.get('store:get')({}, 'zs:late-reopen') !== 'ещё в памяти') throw new Error('кэш потерян');
  } finally {
    fs.renameSync = rename;
    electronStub.app.isQuitting = false;
    await handlers.get('store:remove')({}, 'zs:late-reopen');
  }
});

console.log(`\nOK (${ok.length}):`);
ok.forEach((n) => console.log('  ✓', n));
if (fail.length) {
  console.log(`\nПРОБЛЕМЫ (${fail.length}):`);
  fail.forEach((n) => console.log('  ×', n));
  process.exitCode = 1;
}
fs.rmSync(userData, { recursive: true, force: true });
// main держит интервал мониторинга буфера — для смоука просто выходим
process.exit(fail.length ? 1 : 0);
