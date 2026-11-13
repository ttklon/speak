/**
 * Мост renderer ↔ main. Ничего лишнего: только явный allowlist API.
 */

const { contextBridge, ipcRenderer, clipboard, webFrame } = require('electron');

const on = (channel, cb) => {
  const listener = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('zspeakly', {
  isElectron: true,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },

  store: {
    getSync: (key) => ipcRenderer.sendSync('store:get', key),
    get: (key) => ipcRenderer.invoke('store:get', key),
    set: (key, value) => ipcRenderer.invoke('store:set', key, value),
    remove: (key) => ipcRenderer.invoke('store:remove', key),
    sizeSync: () => ipcRenderer.sendSync('store:size'),
  },

  window: {
    minimize: () => ipcRenderer.invoke('win:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('win:toggle-maximize'),
    close: () => ipcRenderer.invoke('win:close'),
    setBadge: (value) => ipcRenderer.invoke('win:badge', value),
  },

  native: {
    available: true,
    platform: process.platform,
    sttStatus: (model) => ipcRenderer.invoke('stt:status', model),
    transcribe: (payload) => ipcRenderer.invoke('stt:transcribe', payload),
    transcribePcm: (payload) => ipcRenderer.invoke('stt:transcribe-pcm', payload),
    insertText: (text) => ipcRenderer.invoke('text:insert', text),
    pasteToActive: () => ipcRenderer.invoke('text:paste'),
    readSelection: () => ipcRenderer.invoke('text:read-selection'),
    replaceSelection: (text) => ipcRenderer.invoke('text:replace-selection', text),
    readClipboard: () => ipcRenderer.invoke('clipboard:read'),
    screenshot: () => ipcRenderer.invoke('clipboard:screenshot'),
    writeClipboard: (payload) => ipcRenderer.invoke('clipboard:write', payload),
    openDataFolder: () => ipcRenderer.invoke('app:open-data-folder'),
    openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
    setAutoLaunch: (enabled) => ipcRenderer.invoke('app:auto-launch', enabled),
    openLogs: () => ipcRenderer.invoke('app:open-logs'),
    log: (entry) => ipcRenderer.invoke('diag:log', entry),
    diagStatus: () => ipcRenderer.invoke('diag:status'),
    diagRecent: (limit) => ipcRenderer.invoke('diag:recent', limit),
    diagSetEnabled: (enabled) => ipcRenderer.invoke('diag:set-enabled', enabled),
    diagSetEndpoint: (url) => ipcRenderer.invoke('diag:set-endpoint', url),
    diagSaveReport: () => ipcRenderer.invoke('diag:save-report'),
    diagSendNow: () => ipcRenderer.invoke('diag:send-now'),
    diagPing: () => ipcRenderer.invoke('diag:ping'),
    diagClear: () => ipcRenderer.invoke('diag:clear'),
    setDictationHotkey: (payload) => ipcRenderer.invoke('hotkey:set', payload),
    httpGet: (url) => ipcRenderer.invoke('http:get', url),
    httpPost: (payload) => ipcRenderer.invoke('http:post', payload),
    notify: (payload) => ipcRenderer.invoke('app:notify', payload),
    saveFile: (payload) => ipcRenderer.invoke('app:save-file', payload),
    modelsStatus: () => ipcRenderer.invoke('models:status'),
    modelsCancel: () => ipcRenderer.invoke('models:cancel'),
    modelsWarm: (model) => ipcRenderer.invoke('models:warm', model),
    downloadModel: (id) => ipcRenderer.invoke('models:download', id),
    saveBackup: (json) => ipcRenderer.invoke('data:save-backup', json),
    downloadEngine: () => ipcRenderer.invoke('models:download-engine'),
    importModel: (filePath) => ipcRenderer.invoke('models:import', filePath),
    onModelProgress: (cb) => on('model:progress', cb),
    // плавающий индикатор диктовки (отдельное окно поверх всех приложений)
    hudShow: () => ipcRenderer.invoke('hud:show'),
    hudHide: () => ipcRenderer.invoke('hud:hide'),
    hudUpdate: (state) => ipcRenderer.invoke('hud:update', state),
    hudStatus: () => ipcRenderer.invoke('hud:status'),
    onDictationStop: (cb) => on('dictation:stop', cb),
    onHudClosed: (cb) => on('hud:closed', cb),
    checkUpdates: () => ipcRenderer.invoke('update:check'),
    setUpdateChannel: (channel) => ipcRenderer.invoke('update:channel', channel),
    downloadUpdate: () => ipcRenderer.invoke('update:download'),
    installUpdate: () => ipcRenderer.invoke('update:install'),
    onUpdateStatus: (cb) => on('update:status', cb),
    getSystemAudio: () => ipcRenderer.invoke('app:noop'),
    onHotkeyConflict: (cb) => {
      const handler = (_e, payload) => cb(payload);
      ipcRenderer.on('hotkey:conflict', handler);
      return () => ipcRenderer.removeListener('hotkey:conflict', handler);
    },
    captureScreen: () => ipcRenderer.invoke('screen:capture'),
    onHotkey: (cb) => on('hotkey', cb),
    onTextAction: (cb) => on('text-action', cb),
    onCommand: (cb) => on('command', cb),
    onClipboardAction: (cb) => {
      const handler = (_e, action) => cb(action);
      ipcRenderer.on('clipboard:action', handler);
      return () => ipcRenderer.removeListener('clipboard:action', handler);
    },
    onClipboard: (cb) => on('clipboard:item', cb),
  },

  // Синхронное чтение буфера — удобно для страницы буфера обмена
  clipboard: {
    readText: () => clipboard.readText(),
    writeText: (text) => clipboard.writeText(String(text ?? '')),
  },

  onNavigate: (cb) => on('navigate', cb),
  setZoom: (factor) => {
    try {
      webFrame.setZoomFactor(factor);
    } catch {
      /* ignore */
    }
  },
});
