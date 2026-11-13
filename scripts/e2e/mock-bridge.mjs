/**
 * Мок-мост `window.zspeakly` для E2E-прогона интерфейса в браузере.
 *
 * Зачем: в браузере моста нет, и половина кнопок молча ничего не делает —
 * такой прогон проверял бы вёрстку, а не поведение. Мок повторяет allowlist
 * из `electron/preload.cjs` и складывает все вызовы в `window.__bridgeCalls`,
 * поэтому тест может утверждать «кнопка действительно позвала IPC».
 *
 * Правила:
 *  - данные лежат в localStorage с префиксом `mockstore:` (переживают reload);
 *  - ничего не ходит в сеть: `httpGet`/`httpPost` отвечают как живая Ollama;
 *  - функция уходит в страницу целиком (page.evaluateOnNewDocument), поэтому
 *    внутри нельзя ссылаться на модульные переменные.
 */

export function installMockBridge() {
  if (typeof window === 'undefined' || window.zspeakly) return;

  const PREFIX = 'mockstore:';
  const calls = [];
  window.__bridgeCalls = calls;

  const record = (channel, args) => {
    calls.push({ channel, args });
    // не даём журналу расти бесконечно на длинном прогоне
    if (calls.length > 500) calls.splice(0, calls.length - 500);
  };

  // флажок отмены скачивания модели (см. downloadModel/modelsCancel)
  let modelCancel = false;

  const readStore = (key) => {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };

  const writeStore = (key, value) => {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  };

  const store = {
    getSync: (key) => readStore(key),
    get: async (key) => readStore(key),
    set: async (key, value) => {
      record('store:set', [key]);
      writeStore(key, value);
      return true;
    },
    remove: async (key) => {
      record('store:remove', [key]);
      localStorage.removeItem(PREFIX + key);
      return true;
    },
    sizeSync: () => JSON.stringify(localStorage).length,
  };

  const ok = (channel) => async (payload) => {
    record(channel, [payload]);
    return { ok: true };
  };

  let clipboardText = 'текст в системном буфере';

  // 1×1 PNG — чтобы «снимок экрана» был настоящей картинкой для <img src>
  const PIXEL_PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  // Подписки main → renderer. Не заглушки: тест может выстрелить событием
  // через window.__e2e.emit, и тогда проверяется вся реакция интерфейса.
  const subscriptions = new Map();
  const subscribe = (channel) => (cb) => {
    const list = subscriptions.get(channel) || [];
    list.push(cb);
    subscriptions.set(channel, list);
    return () => {
      const current = subscriptions.get(channel) || [];
      subscriptions.set(
        channel,
        current.filter((fn) => fn !== cb),
      );
    };
  };
  const emit = (channel, payload) => {
    record(`emit:${channel}`, [payload]);
    for (const fn of subscriptions.get(channel) || []) fn(payload);
  };
  const noopSubscription = subscribe;

  const native = {
    // плавающий индикатор диктовки (в Electron — отдельное окно поверх всех)
    hudShow: async () => {
      record('hud:show');
      return true;
    },
    hudHide: async () => {
      record('hud:hide');
      return true;
    },
    hudUpdate: async (state) => {
      record('hud:update', [state]);
      return true;
    },
    hudStatus: async () => {
      record('hud:status');
      return { open: true };
    },
    onDictationStop: subscribe('dictation:stop'),
    onHudClosed: subscribe('hud:closed'),
    dictationState: (state) => record('dictation:state', [state]),
    available: true,
    platform: 'win32',

    sttStatus: async (model) => {
      record('stt:status', [model]);
      return { available: true, bin: true, model: `ggml-${model || 'small'}.bin`, path: 'C:\\ZSpeakly\\whisper-cli.exe' };
    },
    // контракт main-процесса: { ok, text, reason } — без ok движок считает,
    // что whisper ничего не распознал
    transcribe: async (payload) => {
      record('stt:transcribe', [payload]);
      return { ok: true, text: 'Проверка диктовки: раз, два, три.', engine: 'whisper' };
    },
    transcribePcm: async (payload) => {
      // pcm целиком в журнал не кладём, но всё, что влияет на распознавание,
      // сохраняем — иначе подсказку с экрана невозможно проверить
      record('stt:transcribe-pcm', [
        {
          keys: Object.keys(payload || {}),
          lang: payload?.lang,
          model: payload?.model,
          useDictionary: payload?.useDictionary,
          contextPrompt: payload?.contextPrompt,
        },
      ]);
      return { ok: true, text: 'Проверка диктовки: раз, два, три.', engine: 'whisper' };
    },

    insertText: ok('text:insert'),
    pasteToActive: async () => {
      record('text:paste');
      return true;
    },
    readSelection: async () => {
      record('text:read-selection');
      return { text: 'выделенный текст со страницы' };
    },
    replaceSelection: ok('text:replace-selection'),

    readClipboard: async () => {
      record('clipboard:read');
      return { text: clipboardText, kind: 'text' };
    },
    writeClipboard: async (payload) => {
      record('clipboard:write', [payload]);
      if (payload && typeof payload.text === 'string') clipboardText = payload.text;
      return true;
    },
    screenshot: async () => {
      // как в main.cjs: ok + размеры + превью, событие не дублируется
      record('clipboard:screenshot');
      return { ok: true, image: PIXEL_PNG, width: 1280, height: 800, source: 'Снимок экрана' };
    },
    captureScreen: async () => {
      // как в main.cjs: ok: false без картинки, ok: true с data-URL
      record('screen:capture');
      return { ok: true, image: PIXEL_PNG, width: 1280, height: 800 };
    },

    openDataFolder: async () => {
      record('app:open-data-folder');
      return true;
    },
    openExternal: async (url) => {
      record('app:open-external', [url]);
      return true;
    },
    setAutoLaunch: async (enabled) => {
      record('app:auto-launch', [enabled]);
      return true;
    },
    openLogs: async () => {
      record('app:open-logs');
      return true;
    },
    notify: ok('app:notify'),
    saveFile: async (payload) => {
      record('app:save-file', [payload && payload.name]);
      return { ok: true, path: `C:\\Users\\test\\Desktop\\${(payload && payload.name) || 'файл'}` };
    },
    getSystemAudio: async () => {
      record('app:noop');
      return true;
    },

    log: async (entry) => {
      record('diag:log', [entry]);
      return true;
    },
    diagStatus: async () => {
      record('diag:status');
      return {
        enabled: false,
        endpoint: '',
        endpointConfigured: false,
        logFile: 'C:\\Users\\test\\AppData\\Roaming\\ZSpeakly\\logs\\zspeakly.log',
        installId: 'e2e-install',
        entries: 3,
        pending: 0,
      };
    },
    diagRecent: async (limit) => {
      record('diag:recent', [limit]);
      return [
        { at: Date.now() - 5000, level: 'info', event: 'app:start', detail: 'E2E-прогон' },
        { at: Date.now() - 4000, level: 'warn', event: 'stt:missing', detail: 'модель не найдена' },
        { at: Date.now() - 3000, level: 'info', event: 'hotkey:set', detail: 'Ctrl+Alt+Space' },
      ];
    },
    diagSetEnabled: async (enabled) => {
      record('diag:set-enabled', [enabled]);
      return { ok: true, status: { enabled, endpoint: '', endpointConfigured: false } };
    },
    diagSetEndpoint: async (url) => {
      record('diag:set-endpoint', [url]);
      return { ok: true, endpoint: url, status: { enabled: false, endpoint: url, endpointConfigured: Boolean(url) } };
    },
    saveBackup: async (json) => {
      record('data:save-backup', [typeof json === 'string' ? json.length : 0]);
      return { ok: true, path: 'C:\\Users\\test\\Desktop\\zspeakly-backup.json' };
    },
    diagSaveReport: async () => {
      record('diag:save-report');
      return { ok: true, path: 'C:\\Users\\test\\Desktop\\zspeakly-report.txt' };
    },
    diagSendNow: async () => {
      record('diag:send-now');
      return { ok: true, sent: 2 };
    },
    diagPing: async () => {
      record('diag:ping');
      return { ok: true, status: 200 };
    },
    diagClear: async () => {
      record('diag:clear');
      return { ok: true };
    },

    setDictationHotkey: async (payload) => {
      record('hotkey:set', [payload]);
      return { ok: true };
    },

    httpGet: async (url) => {
      record('http:get', [url]);
      return {
        ok: true,
        status: 200,
        data: { models: [{ name: 'qwen2.5:0.5b' }, { name: 'qwen2.5:1.5b' }] },
      };
    },
    httpPost: async (payload) => {
      record('http:post', [payload && payload.url]);
      const body = payload && payload.body;
      const isVision = Boolean(body && Array.isArray(body.images));
      return {
        ok: true,
        status: 200,
        data: {
          response: isVision
            ? 'Список задач, дедлайн, проект «Атлас»'
            : 'Переписанный текст: коротко и по делу.',
        },
      };
    },

    modelsStatus: async () => {
      record('models:status');
      return {
        bin: true,
        models: {
          tiny: { id: 'tiny', downloaded: false, size: 78_000_000 },
          small: { id: 'small', downloaded: true, size: 488_000_000 },
          medium: { id: 'medium', downloaded: false, size: 1_500_000_000 },
        },
      };
    },
    downloadModel: async (id) => {
      record('models:download', [id]);
      // держим скачивание «в полёте», чтобы успеть нажать «Отменить»
      modelCancel = false;
      await new Promise((r) => setTimeout(r, 1200));
      if (modelCancel) return { ok: false, reason: 'скачивание отменено' };
      return { ok: true };
    },
    modelsWarm: async (payload) => {
      record('models:warm', [payload]);
      return { ok: true, port: 17842 };
    },
    modelsCancel: async () => {
      record('models:cancel');
      modelCancel = true;
      return { ok: true };
    },
    downloadEngine: async () => {
      record('models:download-engine');
      return { ok: true };
    },
    importModel: async (filePath) => {
      record('models:import', [filePath]);
      return { ok: true };
    },

    checkUpdates: async () => {
      record('update:check');
      return { status: 'not-available', version: null };
    },
    setUpdateChannel: async (channel) => {
      record('update:channel', [channel]);
      return { ok: true };
    },
    downloadUpdate: async () => {
      record('update:download');
      return { ok: true };
    },
    installUpdate: async () => {
      record('update:install');
      return { ok: true };
    },

    onModelProgress: subscribe('model:progress'),
    onUpdateStatus: subscribe('update:status'),
    onHotkeyConflict: subscribe('hotkey:conflict'),
    onHotkey: subscribe('hotkey'),
    onTextAction: subscribe('text-action'),
    onCommand: subscribe('command'),
    onClipboardAction: subscribe('clipboard:action'),
    onClipboard: subscribe('clipboard:item'),
  };

  window.zspeakly = {
    isElectron: true,
    versions: { electron: '33.2.1', chrome: '130.0.0', node: '20.18.0' },
    store,
    window: {
      minimize: async () => {
        record('win:minimize');
        return true;
      },
      toggleMaximize: async () => {
        record('win:toggle-maximize');
        return true;
      },
      close: async () => {
        record('win:close');
        return true;
      },
      setBadge: async (value) => {
        record('win:badge', [value]);
        return true;
      },
    },
    native,
    clipboard: {
      readText: () => clipboardText,
      writeText: (text) => {
        record('clipboard:write-text', [String(text ?? '')]);
        clipboardText = String(text ?? '');
      },
    },
    onNavigate: subscribe('navigate'),
    setZoom: (factor) => record('zoom', [factor]),
  };

  // хелперы только для теста
  window.__e2e = {
    calls,
    resetCalls: () => {
      calls.length = 0;
    },
    /** последний вызов канала или null */
    last: (channel) => [...calls].reverse().find((c) => c.channel === channel) || null,
    countOf: (channel) => calls.filter((c) => c.channel === channel).length,
    seed: (key, value) => writeStore(key, value),
    read: (key) => readStore(key),
    emit,
    emitCount: () => (subscriptions.get('x') || []).length,
  };
}
