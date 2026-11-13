/**
 * Мостик для отдельного окна индикатора диктовки (electron/hud.html).
 *
 * Окно показывает «Слушаю…», уровень микрофона и две кнопки: стоп и закрыть.
 * Оно не забирает фокус, поэтому текст вставляется в то приложение, где человек
 * печатал, а не в ZSpeakly.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hudBridge', {
  stop: () => ipcRenderer.invoke('hud:stop'),
  close: () => ipcRenderer.invoke('hud:close'),
  onState: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('hud:state', listener);
    return () => ipcRenderer.removeListener('hud:state', listener);
  },
});
