#!/usr/bin/env node
/** Настоящее отдельное окно WinForms, SendInput и Ctrl+V в Windows CI.
 * Запускать только в специально выделенной интерактивной Windows-сессии:
 * искусственные клавиши идут в ОС. Никакой ввод, если наше окно не в фокусе. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { createWinInput } = require('../electron/winInput.cjs');
const { InputHost } = require('../electron/inputHost.cjs');
const { sendUnicodeText } = require('../electron/sendInput.cjs');

if (process.platform !== 'win32' || process.env.ZS_INPUT_INTERACTIVE !== '1') {
  console.error('Нужна выделенная Windows-сессия и ZS_INPUT_INTERACTIVE=1');
  process.exit(2);
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zs-input-window-'));
const title = `ZSpeakly input test ${process.pid}-${Date.now()}`;
const target = spawn('powershell.exe', ['-NoProfile', '-STA', '-NonInteractive', '-WindowStyle', 'Hidden',
  '-File', path.resolve('scripts/e2e/wininput-target.ps1'), '-Directory', dir, '-Title', title],
{ windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let stderr = '';
target.stderr.on('data', (data) => { stderr += data; });
let spawnError;
target.on('error', (error) => { spawnError = error; });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFile(file, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (!fs.existsSync(file)) {
    if (spawnError || target.exitCode !== null) throw new Error(`окно закрылось: ${spawnError || stderr}`);
    const err = path.join(dir, 'error.txt');
    if (fs.existsSync(err)) throw new Error(fs.readFileSync(err, 'utf8'));
    if (Date.now() > deadline) throw new Error(`окно не ответило: ${file}; ${stderr}`);
    await sleep(50);
  }
}
let seq = 0;
async function command(command, text) {
  const id = ++seq;
  const request = path.join(dir, 'request.json');
  const temporary = path.join(dir, 'request.tmp');
  const response = path.join(dir, `response-${id}.json`);
  fs.writeFileSync(temporary, JSON.stringify({ id, command, text }), 'utf8');
  fs.renameSync(temporary, request);
  await waitFile(response);
  return JSON.parse(fs.readFileSync(response, 'utf8'));
}
async function active() {
  const state = await command('focus');
  return state.foreground === true;
}
async function assertText(expected, label) {
  const deadline = Date.now() + 5000;
  let state;
  do {
    state = await command('state');
    if (state.text === expected) return;
    await sleep(100);
  } while (Date.now() < deadline);
  throw new Error(`${label}: ожидали ${JSON.stringify(expected)}, получили ${JSON.stringify(state.text)}; focus=${state.foreground}`);
}
async function main() {
  const host = new InputHost({ timeoutMs: 15000 });
  try {
    await waitFile(path.join(dir, 'ready'));
    if (!await active()) {
      console.log('SKIP: тестовое окно не смогло получить фокус; ввод в другие окна не выполнялся.');
      return;
    }
    const helper = createWinInput({ baseDir: dir });
    const built = await helper.ensure();
    assert.equal(built.ready, true, JSON.stringify(built));
    for (const [label, input] of [
      ['compiled helper', (text) => helper.type(text)],
      ['resident host', (text) => host.type(text)],
      ['PowerShell fallback', (text) => sendUnicodeText({ text, execFile })],
    ]) {
      await command('clear');
      assert.equal(await active(), true, `перед ${label} потерян фокус`);
      const text = 'Привет, café 123!';
      const result = await input(text);
      assert.equal(result.ok, true, `${label}: ${JSON.stringify(result)}`);
      await assertText(text, label);
      console.log(`${label}: текст попал в отдельное WinForms-окно`);
    }
    for (const [label, paste] of [
      ['compiled helper', () => helper.paste()], ['resident host', () => host.paste()],
    ]) {
      const text = 'Вставка clipboard 42';
      await command('clear');
      await command('clipboard', text);
      assert.equal(await active(), true, `перед ${label} Ctrl+V потерян фокус`);
      const result = await paste();
      assert.equal(result.ok, true, `${label} Ctrl+V: ${JSON.stringify(result)}`);
      await assertText(text, `${label} Ctrl+V`);
      console.log(`${label}: Ctrl+V доставлен в отдельное WinForms-окно`);
    }
    if (process.env.ZS_TEST_ELECTRON === '1') {
      const executable = require('electron');
      assert.ok(fs.existsSync(executable), 'нет Electron для проверки IPC');
      assert.ok(fs.existsSync('dist/index.html'), 'сначала соберите интерфейс');
      const profile = path.join(dir, 'profile');
      fs.mkdirSync(profile);
      const settings = { onboarded: true, speedFix151: true, micPreroll: false,
        keepModelLoaded: false, clipboardMonitor: false, checkUpdates: false,
        soundFeedback: false, closeToTray: false, autoOptimize: false };
      fs.writeFileSync(path.join(profile, 'profile.json'), JSON.stringify({
        'zs.settings': settings, 'zs:settings': settings,
      }));
      const { default: puppeteer } = await import('puppeteer-core');
      let browser;
      try {
        browser = await puppeteer.launch({
          executablePath: executable, headless: false, ignoreDefaultArgs: true,
          env: { ...process.env, ZS_E2E_PROFILE: profile, ZSPEAKLY_DEV_URL: 'none' },
          args: [path.resolve('scripts/e2e/electron-entry.cjs')], timeout: 60000,
        });
        const pageTarget = await browser.waitForTarget((t) => t.type() === 'page' && t.url().includes('index.html'), { timeout: 30000 });
        const page = await pageTarget.page();
        await page.waitForSelector('.app-window', { timeout: 30000 });
        await page.waitForFunction(() => Boolean(window.zspeakly?.isElectron && window.zspeakly?.native?.insertText), { timeout: 15000 });
        for (const mode of ['sendinput', 'clipboard']) {
          const text = `Electron ${mode}: Привет, café!`;
          const previous = `До вставки ${mode}`;
          await command('clear');
          await command('clipboard', previous);
          await page.evaluate(async (method) => {
            const current = await window.zspeakly.store.get('zs:settings');
            await window.zspeakly.store.set('zs:settings', { ...current, insertMethod: method });
          }, mode);
          assert.equal(await active(), true, `перед Electron ${mode} потерян фокус`);
          const result = await page.evaluate((value) => window.zspeakly.native.insertText(value), text);
          assert.equal(result.ok, true, `Electron ${mode}: ${JSON.stringify(result)}`);
          await assertText(text, `Electron ${mode}`);
          await sleep(1200);
          const after = await command('readClipboard');
          assert.equal(after.text, previous, `Electron ${mode}: прежний буфер не сохранён`);
          console.log(`Electron IPC ${mode}: текст получен окном, прежний буфер сохранён (метод ${result.method})`);
        }
      } finally {
        if (browser) await browser.close();
      }
    }
  } finally {
    host.stop();
    try { if (fs.existsSync(path.join(dir, 'ready'))) await command('close'); } catch { /* target мог упасть */ }
    // Дать форме выполнить finally и восстановить исходный системный буфер.
    if (target.exitCode === null) {
      await Promise.race([
        new Promise((resolve) => target.once('exit', resolve)),
        sleep(3000),
      ]);
    }
    if (target.exitCode === null) target.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
