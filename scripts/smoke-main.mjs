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
const makeWindow = () => ({
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
  isFocused: () => true,
  maximize: () => {},
  unmaximize: () => {},
  minimize: () => {},
  close: () => {},
  webContents: {
    send: (ch, payload) => sentEvents.push({ ch, payload }),
    sendInputEvent: (ev) => sentInputEvents.push(ev),
    executeJavaScript: async () => {},
    setWindowOpenHandler: () => {},
    on: () => {},
  },
});
const fakeWindow = () => windowInstances[windowInstances.length - 1] || makeWindow();

const electronStub = {
  app: {
    isPackaged: false,
    requestSingleInstanceLock: () => true,
    on: () => {},
    whenReady: () => Promise.resolve(),
    quit: () => {},
    getVersion: () => '1.4.4',
    getName: () => 'ZSpeakly',
    getPath: () => userData,
    getAppPath: () => process.cwd(),
    setAppUserModelId: () => {},
    commandLine: { appendSwitch: () => {} },
    setLoginItemSettings: () => {},
    getLoginItemSettings: () => ({ openAtLogin: false }),
  },
  BrowserWindow: Object.assign(function BrowserWindow() {
    const win = makeWindow();
    windowInstances.push(win);
    return win;
  }, { getAllWindows: () => windowInstances }),
  Tray: class {
    setToolTip() {}
    setContextMenu() {}
    on() {}
  },
  Menu: { buildFromTemplate: () => ({}) },
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
      registered.push(acc);
      globalShortcutRegs.push({ accel: acc, fn });
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
    }),
  },
  session: { defaultSession: { setDisplayMediaRequestHandler: () => {} } },
  desktopCapturer: { getSources: async () => [] },
};

// перехватываем spawn/execFile — никаких реальных процессов в тесте
const spawnCalls = [];
// что «ответит» фейковый whisper (см. cpStub.spawn); null — процесс просто молчит
const spawnPlan = { answer: null };
const globalShortcutRegs = [];
const cpStub = {
  execFile: (file, args, opts, cb) => {
    spawnCalls.push({ file, args });
    if (typeof cb === 'function') setTimeout(() => cb(null, '', ''), 0);
    return { on: () => {} };
  },
  exec: (cmd, opts, cb) => {
    spawnCalls.push({ file: cmd, args: [] });
    if (typeof cb === 'function') setTimeout(() => cb(null, '', ''), 0);
    return { on: () => {} };
  },
  spawn: (file, args) => {
    spawnCalls.push({ file, args });
    const listeners = {};
    const child = {
      on: (event, fn) => {
        if (fn) listeners[event] = fn;
      },
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      kill: () => {},
    };
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
    'stt:transcribe', 'stt:transcribe-pcm', 'text:insert', 'text:paste', 'text:read-selection',
    'text:replace-selection', 'clipboard:screenshot', 'hotkey:set', 'app:auto-launch',
    'models:status', 'models:download', 'models:download-engine',
    'update:check', 'update:download', 'update:install', 'app:notify', 'app:save-file',
  ];
  const missing = need.filter((ch) => !handlers.has(ch));
  if (missing.length) throw new Error(`нет каналов: ${missing.join(', ')}`);
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

await check('сочетания сохраняются в настройки главного процесса', () => {
  const saved = (handlers.get('store:get')({}, 'zs:settings') || {}).voiceHotkeys || [];
  if (!saved.some((h) => h.id === 'agent' && h.enabled)) {
    throw new Error('список сочетаний не сохранился — после перезапуска вернулись бы прежние');
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
    const pasted = calls.some((c) => /SendKeys\]::SendWait\('\^v'\)/.test(c));
    if (!pasted) throw new Error(`не нашёл Ctrl+V: ${calls.join(' | ') || 'пусто'}`);
    if (clipboardText.value !== 'привет из диктовки') throw new Error('текст не в буфере');
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

await check('clipboard:write кладёт картинку, а не только текст', async () => {
  const ok = await handlers.get('clipboard:write')({}, {
    image: 'data:image/png;base64,iVBORw0KGgo=',
    text: 'подпись',
  });
  if (!ok) throw new Error('канал вернул false');
  if (!clipboardImage.value) throw new Error('картинка не попала в буфер');
});

await check('хоткей диктовки показывает скрытое окно из трея', async () => {
  const win = windowInstances.at(-1);
  const visible = { value: false };
  win.isVisible = () => visible.value;
  win.show = () => { visible.value = true; };
  win.showInactive = () => { visible.value = true; };
  win.hide = () => { visible.value = false; };

  const regs = [];
  globalShortcutRegs.length = 0;
  await handlers.get('hotkey:set')({}, { dictationKey: 'Control+Alt+Space' });
  const entry = globalShortcutRegs.find((r) => r.accel === 'Control+Alt+Space');
  if (!entry) throw new Error('хоткей диктовки не зарегистрирован');
  entry.fn();
  if (!visible.value) throw new Error('окно осталось скрытым во время диктовки');
  entry.fn();
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
  fs.rmSync(res.path, { force: true });
});

await check('по умолчанию наружу ничего не отправляется', async () => {
  const status = await handlers.get('diag:status')({});
  if (status.endpointConfigured) throw new Error('адрес приёмника задан по умолчанию');
  const res = await handlers.get('diag:send-now')({});
  if (res?.ok) throw new Error('отправка прошла без настроенного приёмника');
});

// ── Экранный контекст и словарь уходят в whisper как --prompt ───────────────
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

await check('пропуск движка: whisper получает --prompt со словарём и контекстом', async () => {
  await handlers.get('store:set')({}, 'zs:dictionary', [
    { word: 'ZSpeakly', pronunciation: 'зи-спикли' },
    { word: 'Алтайтара', pronunciation: 'алтай-тара' },
  ]);
  runWhisper('Проверка диктовки');
  spawnCalls.length = 0;
  const pcm = new Uint8Array(16000); // 0.5 с тишины
  const res = await handlers.get('stt:transcribe-pcm')({}, {
    pcm,
    durationMs: 500,
    lang: 'ru',
    model: 'small',
    useDictionary: true,
    contextPrompt: 'Список задач, дедлайн, проект «Атлас»',
  });
  const call = spawnCalls.find((c) => String(c.file).includes('whisper'));
  if (!call) throw new Error(`whisper не запускался: ${JSON.stringify(spawnCalls)}`);
  const i = call.args.indexOf('--prompt');
  if (i < 0) throw new Error('--prompt не передан');
  const prompt = call.args[i + 1];
  if (!prompt.includes('ZSpeakly') || !prompt.includes('Алтайтара')) throw new Error(`словаря нет: ${prompt}`);
  if (!prompt.includes('Атлас')) throw new Error(`контекста экрана нет: ${prompt}`);
  if (res?.text !== 'Проверка диктовки') throw new Error(`текст не вернулся: ${JSON.stringify(res)}`);
});

await check('тумблер словаря работает целиком: без словаря и без подсказки', async () => {
  runWhisper('текст');
  spawnCalls.length = 0;
  await handlers.get('stt:transcribe-pcm')({}, {
    pcm: new Uint8Array(16000),
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
    pcm: new Uint8Array(16000),
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
