/** Настоящий preload/IPC и системный буфер одноразового Windows CI. */
const assert = require('node:assert/strict');
const { app, BrowserWindow, clipboard } = require('electron');

if (process.platform !== 'win32' || process.env.CI !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || process.env.ZS_CLIPBOARD_IMAGE_E2E !== '1') {
  throw new Error('Проверка буфера разрешена только в изолированном Windows CI');
}
require('./electron-entry.cjs');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
const sentinel = 'ZSpeakly isolated CI clipboard test';

app.whenReady().then(async () => {
  let timer;
  try {
    timer = setTimeout(() => {
      try { clipboard.clear(); } catch { /* runner одноразовый */ }
      console.error('CLIPBOARD_IMAGE_E2E_FAILURE timeout');
      app.exit(1);
    }, 75000);
    timer.unref();
    let win;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      win = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes('index.html') && !item.webContents.isLoading());
      if (win && await win.webContents.executeJavaScript('Boolean(window.zspeakly?.native?.writeClipboard)')) break;
      win = null;
      await wait(150);
    }
    assert.ok(win, 'не дождались окна с preload');
    const invoke = (expression) => win.webContents.executeJavaScript(`window.zspeakly.native.writeClipboard(${expression})`, true);
    clipboard.writeText(sentinel);
    const oversized = await invoke(`({ image: 'data:image/png;base64,' + 'A'.repeat(16 * 1024 * 1024), text: 'other' })`);
    assert.equal(oversized, false);
    assert.equal(clipboard.readText(), sentinel);
    const huge = Buffer.from(png, 'base64');
    huge.writeUInt32BE(50000, 16);
    huge.writeUInt32BE(50000, 20);
    const invalidImages = [`data:image/png;base64,${huge.toString('base64')}`, 'data:image/png;base64,@@@@'];
    for (const image of invalidImages) {
      assert.equal(await invoke(JSON.stringify({ image, text: 'other' })), false);
      assert.equal(clipboard.readText(), sentinel);
    }
    assert.equal(await invoke(JSON.stringify({ image: `data:image/png;base64,${png}`, text: 'other' })), true);
    const image = clipboard.readImage();
    assert.equal(image.isEmpty(), false);
    assert.deepEqual(image.getSize(), { width: 1, height: 1 });
    console.log('CLIPBOARD_IMAGE_E2E_OK');
    clearTimeout(timer);
    clipboard.clear();
    app.exit(0);
  } catch (error) {
    if (timer) clearTimeout(timer);
    try { clipboard.clear(); } catch { /* runner одноразовый */ }
    console.error('CLIPBOARD_IMAGE_E2E_FAILURE', error?.stack || error);
    app.exit(1);
  }
}).catch((error) => { console.error('CLIPBOARD_IMAGE_E2E_FAILURE', error?.stack || error); app.exit(1); });
