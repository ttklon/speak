/** Сквозная проверка backup в настоящем Electron с изолированным профилем.
 * Диалог выбора файла заменён установкой File в input; проводник не открывается. */
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, shell } = require('electron');
const mode = process.env.ZS_BACKUP_MODE;
const desktop = process.env.ZS_BACKUP_DESKTOP;
if (!['export', 'import', 'verify'].includes(mode) || !desktop) throw new Error('Не задан режим проверки копии');
app.setPath('desktop', desktop);
shell.showItemInFolder = () => {};
require('./electron-entry.cjs');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { last = await fn(); if (last) return last; } catch { /* страница ещё загружается */ }
    await wait(100);
  }
  throw new Error(`Не дождались: ${label}`);
}
function fail(err) {
  console.error('BACKUP_E2E_FAILURE', err?.stack || err);
  app.exit(1);
}

app.whenReady().then(async () => {
  const timer = setTimeout(() => fail(new Error('Истёк срок проверки backup')), 60000);
  timer.unref();
  const win = await until(async () => {
    const w = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes('index.html'));
    if (!w || w.webContents.isLoading()) return null;
    return await w.webContents.executeJavaScript('Boolean(window.zspeakly?.store?.get && document.querySelector(".app-window"))') ? w : null;
  }, 'интерфейс');
  const evaluate = (code) => win.webContents.executeJavaScript(code);
  await wait(800); // фоновые миграции и начальные записи профиля
  if (mode !== 'verify') {
    await evaluate("location.hash = '#/settings?section=data&from=home'");
    await until(() => evaluate('Boolean(document.querySelector(".settings-main input[type=file]"))'), 'настройки данных');
  }
  if (mode === 'export') {
    const clipboard = await evaluate("window.zspeakly.store.get('zs.clipboard')");
    if (!clipboard?.some((item) => item.id === 'backup-e2e-clipboard')) throw new Error('Контрольная запись буфера отсутствует в исходном профиле');
    for (let i = 0; i < 2; i += 1) {
      const clicked = await evaluate(`(() => {
        const button = [...document.querySelectorAll('.settings-main button')].find((item) => item.textContent.trim() === 'Скачать');
        if (!button) return false;
        button.click(); return true;
      })()`);
      if (!clicked) throw new Error('Кнопка экспорта не найдена');
      await until(() => fs.readdirSync(desktop).filter((name) => /^zspeakly-backup-.*\.json$/.test(name)).length >= i + 1, 'файл экспорта');
    }
    await until(() => evaluate("document.body.innerText.includes('Копия сохранена')"), 'подтверждение экспорта');
  } else if (mode === 'import') {
    const backup = fs.readFileSync(process.env.ZS_BACKUP_FILE, 'utf8');
    const script = `(() => {
      const input = document.querySelector('.settings-main input[type=file]');
      const transfer = new DataTransfer();
      transfer.items.add(new File([${JSON.stringify(backup)}], ${JSON.stringify("копия O'Brien.json")}, { type: 'application/json' }));
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`;
    await evaluate(script);
    await until(() => evaluate('Boolean(document.querySelector(".confirm__text"))'), 'предпросмотр');
    const clicked = await evaluate(`(() => {
      const modal = document.querySelector('.confirm__text')?.closest('.modal');
      const button = [...(modal?.querySelectorAll('button') || [])].find((item) => item.textContent.trim() === 'Восстановить');
      if (!button) return false;
      button.click(); return true;
    })()`);
    if (!clicked) throw new Error('Подтверждение импорта не найдено');
    await until(() => evaluate("document.body.innerText.includes('Данные применены в приложении')"), 'применение копии');
    await until(async () => {
      const history = await evaluate("window.zspeakly.store.get('zs.dictations')");
      const dictionary = await evaluate("window.zspeakly.store.get('zs.dictionary')");
      return history?.some((item) => item.id === 'backup-e2e-history') && dictionary?.some((item) => item.id === 'backup-e2e-word');
    }, 'передача данных в main');
    await until(() => {
      try {
        const profile = JSON.parse(fs.readFileSync(path.join(process.env.ZS_E2E_PROFILE, 'profile.json'), 'utf8'));
        return profile['zs.dictations']?.some((item) => item.id === 'backup-e2e-history') && profile['zs.dictionary']?.some((item) => item.id === 'backup-e2e-word');
      } catch { return false; }
    }, 'запись разделов на диск');
  } else {
    const state = await evaluate(`Promise.all([
      window.zspeakly.store.get('zs.dictations'),
      window.zspeakly.store.get('zs.dictionary'),
      window.zspeakly.store.get('zs.snippets'),
      window.zspeakly.store.get('zs.clipboard')
    ])`);
    if (!state[0]?.some((item) => item.id === 'backup-e2e-history') ||
        !state[1]?.some((item) => item.id === 'backup-e2e-word') ||
        !state[2]?.some((item) => item.id === 'backup-e2e-snippet') ||
        state[3]?.some((item) => item.id === 'backup-e2e-clipboard')) throw new Error('Разделы после перезапуска не совпали');
  }
  console.log(`BACKUP_E2E_OK ${mode}`);
  app.quit();
}).catch(fail);
