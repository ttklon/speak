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

const handlers = new Map();
const onHandlers = new Map();
const registered = [];
const clipboardText = { value: 'выделенный текст' };

const fakeWindow = () => ({
  webContents: {
    send: () => {},
    executeJavaScript: async () => {},
    setWindowOpenHandler: () => {},
    on: () => {},
  },
  on: () => {},
  once: () => {},
  loadURL: async () => {},
  loadFile: async () => {},
  show: () => {},
  focus: () => {},
  blur: () => {},
  hide: () => {},
  isMinimized: () => false,
  restore: () => {},
  isMaximized: () => false,
  maximize: () => {},
  unmaximize: () => {},
  minimize: () => {},
  close: () => {},
});

const electronStub = {
  app: {
    isPackaged: false,
    requestSingleInstanceLock: () => true,
    on: () => {},
    whenReady: () => Promise.resolve(),
    quit: () => {},
    getPath: () => userData,
    getAppPath: () => process.cwd(),
    setAppUserModelId: () => {},
    commandLine: { appendSwitch: () => {} },
    setLoginItemSettings: () => {},
    getLoginItemSettings: () => ({ openAtLogin: false }),
  },
  BrowserWindow: Object.assign(function BrowserWindow() {
    return fakeWindow();
  }, { getAllWindows: () => [] }),
  Tray: class {
    setToolTip() {}
    setContextMenu() {}
    on() {}
  },
  Menu: { buildFromTemplate: () => ({}) },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }), createEmpty: () => ({}) },
  ipcMain: {
    on: (ch, fn) => onHandlers.set(ch, fn),
    handle: (ch, fn) => handlers.set(ch, fn),
  },
  globalShortcut: {
    unregisterAll: () => registered.length = 0,
    register: (acc) => registered.push(acc),
  },
  clipboard: {
    readText: () => clipboardText.value,
    writeText: (v) => {
      clipboardText.value = String(v);
    },
    readImage: () => ({ isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }) }),
    availableFormats: () => ['text/plain'],
  },
  shell: { openExternal: () => {}, openPath: () => {} },
  dialog: { showErrorBox: () => {} },
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) },
  session: { defaultSession: { setDisplayMediaRequestHandler: () => {} } },
  desktopCapturer: { getSources: async () => [] },
};

const originalLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === 'electron') return electronStub;
  return originalLoad.call(this, request, parent, isMain);
};

// main.cjs живёт в CommonJS — грузим через require
const main = require(path.resolve('electron/main.cjs'));
const ok = [];
const fail = [];

function check(name, fn) {
  try {
    fn();
    ok.push(name);
  } catch (err) {
    fail.push(`${name}: ${err.message}`);
  }
}

await new Promise((r) => setTimeout(r, 200));

check('main загружается без реального Electron', () => {
  if (!main) throw new Error('модуль не вернулся');
});
check('IPC-каналы зарегистрированы', () => {
  const need = [
    'stt:transcribe', 'text:insert', 'text:paste', 'text:read-selection',
    'text:replace-selection', 'clipboard:screenshot', 'hotkey:set', 'app:auto-launch',
  ];
  const missing = need.filter((ch) => !handlers.has(ch));
  if (missing.length) throw new Error(`нет каналов: ${missing.join(', ')}`);
});
check('store:get работает синхронно', () => {
  if (!onHandlers.has('store:get')) throw new Error('нет store:get');
});
check('hotkey:set регистрирует глобальные сочетания', () => {
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
check('замена выделения пишет в буфер', async () => {
  await handlers.get('text:replace-selection')({}, 'готовый текст');
  if (clipboardText.value !== 'готовый текст') throw new Error(`в буфере: ${clipboardText.value}`);
});
check('hotkey:set принимает строку (обратная совместимость)', () => {
  if (!handlers.get('hotkey:set')({}, 'Control+Alt+Space')) throw new Error('строка не принята');
});

await new Promise((r) => setTimeout(r, 600));

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
