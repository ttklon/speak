/** Проверка реального жизненного цикла Electron с отдельным временным профилем.
 * Подменены только системный диалог и отказ rename; настоящее отображение
 * нативного окна диалога этот тест не проверяет. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, dialog } = require('electron');

const profile = path.join(process.env.ZS_E2E_PROFILE, 'profile.json');
const mode = process.env.ZS_QUIT_MODE;
if (!['stay', 'force'].includes(mode)) throw new Error('Некорректный режим теста выхода');
const rename = fs.renameSync;
let failRename = false;
let dialogs = 0;
fs.renameSync = function (from, to, ...rest) {
  if (failRename && path.resolve(to) === path.resolve(profile)) {
    throw Object.assign(new Error('искусственный отказ записи'), { code: 'ENOSPC' });
  }
  return rename.call(this, from, to, ...rest);
};
dialog.showMessageBoxSync = (options) => {
  dialogs += 1;
  assert.equal(options.defaultId, 0);
  assert.equal(options.cancelId, 0);
  assert.equal(options.buttons.length, 2);
  assert.ok(!JSON.stringify(options).includes('E2E_QUIT_SENTINEL'));
  return mode === 'stay' ? 0 : 1;
};

require('./electron-entry.cjs');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function fail(error) {
  console.error('QUIT_E2E_FAILURE', error?.stack || error);
  app.exit(1);
}

app.whenReady().then(async () => {
  const timer = setTimeout(() => fail(new Error('Истёк срок ожидания теста выхода')), 45000);
  timer.unref();
  let win;
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('index.html'));
    if (win && !win.webContents.isLoading()) {
      try {
        if (await win.webContents.executeJavaScript('Boolean(window.zspeakly?.store?.set)')) break;
      } catch { /* рендерер ещё загружается */ }
    }
    win = null;
    await wait(100);
  }
  assert.ok(win, 'интерфейс Electron не загрузился');
  failRename = true;
  await win.webContents.executeJavaScript("window.zspeakly.store.set('zs:quit-e2e', 'E2E_QUIT_SENTINEL')");

  app.on('will-quit', () => {
    try {
      const saved = JSON.parse(fs.readFileSync(profile, 'utf8'));
      if (mode === 'stay') assert.equal(saved['zs:quit-e2e'], 'E2E_QUIT_SENTINEL');
      else assert.notEqual(saved['zs:quit-e2e'], 'E2E_QUIT_SENTINEL');
      assert.equal(dialogs, 1);
      console.log(`QUIT_E2E_OK ${mode}`);
    } catch (error) {
      fail(error);
    }
  });

  app.quit();
  if (mode === 'force') return;
  const dialogDeadline = Date.now() + 5000;
  while (!dialogs && Date.now() < dialogDeadline) await wait(50);
  assert.equal(dialogs, 1, 'ошибка не вызвала диалог');
  assert.equal(app.isQuitting, false, 'отмена не восстановила состояние приложения');
  assert.ok(!win.isDestroyed(), 'окно закрыто несмотря на отмену');
  assert.equal(await win.webContents.executeJavaScript("window.zspeakly.store.get('zs:quit-e2e')"), 'E2E_QUIT_SENTINEL');
  failRename = false;
  app.quit();
}).catch(fail);
