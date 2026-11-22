/** Тест настоящего single-instance Electron; профиль временный, фоновые загрузки выключены. */
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const role = process.env.ZS_SINGLE_ROLE;
if (!['primary', 'secondary'].includes(role)) throw new Error('Не задана роль проверки блокировки');

const originalLock = app.requestSingleInstanceLock.bind(app);
app.requestSingleInstanceLock = (...args) => {
  const got = originalLock(...args);
  console.log(`SINGLE_LOCK ${role} ${got}`);
  return got;
};
if (role === 'secondary') {
  const { JsonStore } = require('../../electron/store.cjs');
  const load = JsonStore.prototype.load;
  JsonStore.prototype.load = function (...args) {
    console.error('SECONDARY_PROFILE_LOADED');
    return load.apply(this, args);
  };
}
require('./electron-entry.cjs');

if (role === 'primary') {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const fail = (error) => { console.error('SINGLE_E2E_FAILURE', error?.stack || error); app.exit(1); };
  let win;
  app.on('second-instance', () => {
    setTimeout(() => {
      if (!win || win.isDestroyed() || !win.isVisible()) return fail(new Error('Повторный запуск не показал исходное окно'));
      console.log('SINGLE_SECOND_SHOWN');
    }, 150);
  });
  // На Windows команда через stdin не завершила процесс в CI; причина неизвестна.
  // Сигнал находится в уже изолированном временном каталоге теста.
  const quitSignal = path.join(process.env.ZS_E2E_PROFILE, 'single-e2e-quit');
  const quitTimer = setInterval(() => {
    if (!fs.existsSync(quitSignal)) return;
    clearInterval(quitTimer);
    console.log('SINGLE_QUIT_REQUESTED');
    app.quit();
  }, 100);
  quitTimer.unref();
  app.on('will-quit', () => console.log('SINGLE_WILL_QUIT'));
  app.whenReady().then(async () => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('index.html'));
      if (win && !win.webContents.isLoading()) {
        try {
          if (await win.webContents.executeJavaScript('Boolean(window.zspeakly?.store?.set)')) break;
        } catch { /* окно ещё загружается */ }
      }
      win = null;
      await sleep(100);
    }
    if (!win) throw new Error('Интерфейс первого экземпляра не загрузился');
    if (win.isVisible()) throw new Error('Тест ожидал запуск с --hidden');
    await win.webContents.executeJavaScript("window.zspeakly.store.set('zs:single-e2e', 'FIRST_PROCESS_DATA')");
    const file = path.join(process.env.ZS_E2E_PROFILE, 'profile.json');
    let saved = false;
    while (Date.now() < deadline) {
      try { saved = JSON.parse(fs.readFileSync(file, 'utf8'))['zs:single-e2e'] === 'FIRST_PROCESS_DATA'; } catch { /* ждём flush */ }
      if (saved) break;
      await sleep(100);
    }
    if (!saved) throw new Error('Первый экземпляр не сохранил тестовую запись');
    console.log('SINGLE_PRIMARY_READY');
  }).catch(fail);
}
