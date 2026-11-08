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
    insertText: (text) => ipcRenderer.invoke('text:insert', text),
    pasteToActive: () => ipcRenderer.invoke('text:paste'),
    readSelection: () => ipcRenderer.invoke('text:read-selection'),
    replaceSelection: (text) => ipcRenderer.invoke('text:replace-selection', text),
    readClipboard: () => ipcRenderer.invoke('clipboard:read'),
    screenshot: () => ipcRenderer.invoke('clipboard:screenshot'),
    writeClipboard: (payload) => ipcRenderer.invoke('clipboard:write', payload),
    openDataFolder: () => ipcRenderer.invoke('app:open-data-folder'),
    setAutoLaunch: (enabled) => ipcRenderer.invoke('app:auto-launch', enabled),
    setDictationHotkey: (payload) => ipcRenderer.invoke('hotkey:set', payload),
    notify: (payload) => ipcRenderer.invoke('app:notify', payload),
    saveFile: (payload) => ipcRenderer.invoke('app:save-file', payload),
    modelsStatus: () => ipcRenderer.invoke('models:status'),
    downloadModel: (id) => ipcRenderer.invoke('models:download', id),
    downloadEngine: () => ipcRenderer.invoke('models:download-engine'),
    onModelProgress: (cb) => on('model:progress', cb),
    checkUpdates: () => ipcRenderer.invoke('update:check'),
    downloadUpdate: () => ipcRenderer.invoke('update:download'),
    installUpdate: () => ipcRenderer.invoke('update:install'),
    onUpdateStatus: (cb) => on('update:status', cb),
    getSystemAudio: () => ipcRenderer.invoke('app:noop'),
    onHotkey: (cb) => on('hotkey', cb),
    onTextAction: (cb) => on('text-action', cb),
    onCommand: (cb) => on('command', cb),
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
