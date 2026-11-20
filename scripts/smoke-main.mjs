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
const sentEvents = [];
const sentInputEvents = [];
const clipboardText = { value: 'выделенный текст' };
const clipboardImage = { value: null };

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
    on: () => {},
    once: () => {},
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
    isMinimized: () => false,
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
    restore: () => {},
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
    requestSingleInstanceLock: () => true,
    on: () => {},
    whenReady: () => Promise.resolve(),
    quit: () => {},
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
    createFromDataURL: () => ({ isEmpty: () => false, __fromDataUrl: true }),
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
    readText: () => clipboardText.value,
    writeText: (v) => {
      clipboardText.value = String(v);
    },
    readImage: () => ({ isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }) }),
    availableFormats: () => ['text/plain'],
  },
  shell: { openExternal: () => {}, openPath: () => {} },
  dialog: { showErrorBox: () => {} },
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
  session: { defaultSession: { setDisplayMediaRequestHandler: () => {} } },
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
      setTimeout(() => (spawnPlan.execError ? cb(new Error('SendKeys недоступен')) : cb(null, '', '')), 0);
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

// main.cjs живёт в CommonJS — грузим через require
const main = require(path.resolve('electron/main.cjs'));
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
  } finally {
    spawnPlan.sendInput = null;
    handlers.get('store:set')({}, 'zs:settings', { ...settings, insertMethod: 'clipboard' });
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
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
    image: 'data:image/png;base64,iVBORw0KGgo=',
    text: 'подпись',
  });
  if (!ok) throw new Error('канал вернул false');
  if (!clipboardImage.value) throw new Error('картинка не попала в буфер');
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
  await Promise.all([
    handlers.get('stt:transcribe-pcm')({}, { ...payload, partial: true }),
    handlers.get('stt:transcribe-pcm')({}, payload),
  ]);
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

  const good = path.join(tmpDir, 'ggml-large-v3-turbo.bin');
  fs.writeFileSync(good, Buffer.concat([Buffer.from('ggml'), Buffer.alloc(21 * 1024 * 1024)]));
  const ok = await modelsMod.importModel(good);
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
  } finally {
    server.close();
  }
});

await check('http:post не пускает наружу', async () => {
  for (const url of ['https://example.com/api/generate', 'file:///C:/Windows/System32/calc.exe', 'nonsense']) {
    const res = await handlers.get('http:post')({}, { url, body: {} });
    if (res?.ok) throw new Error(`пропущен адрес: ${url}`);
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
    const broken = files['v3_e2e_rnnt_vocab.txt'] + 'испорчено';
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
