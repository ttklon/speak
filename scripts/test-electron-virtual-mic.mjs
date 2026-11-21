/**
 * Electron + настоящий preload/IPC + ONNX + виртуальный WAV-микрофон.
 * Тест запускается на Linux под Xvfb; физического устройства здесь нет.
 * Системная вставка на Linux не поддерживается, проверяем настоящий fallback
 * в системный буфер. Фоновая загрузка недостающего Whisper отключена в entry.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { readWav } from './lib/engine-cli.mjs';

const [name, file] = process.argv.slice(2);
if (!['gigaam', 'parakeet'].includes(name) || !file || !fs.existsSync(file) || !process.env.ZS_USER_DATA) {
  console.error('Нужны имя модели, WAV и ZS_USER_DATA с готовыми весами');
  process.exit(2);
}
const modelRoot = path.resolve(process.env.ZS_USER_DATA, 'models');
assert.ok(fs.existsSync(path.join(modelRoot, name)), 'нет файлов модели');
const wav = path.resolve(file);
const source = readWav(wav);
assert.equal(source.sampleRate, 16000);
const seconds = source.pcm.length / 32000;
assert.ok(seconds >= 1 && seconds <= 15, 'неподходящая длительность WAV');
const executable = path.resolve('node_modules/electron/dist/electron');
assert.ok(fs.existsSync(executable), 'не установлен бинарник Electron');
assert.ok(fs.existsSync('dist/index.html'), 'сначала соберите интерфейс: npm run build');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'zs-electron-virtual-'));
fs.symlinkSync(modelRoot, path.join(profile, 'models'), 'dir');
const settings = {
  onboarded: true, speedFix151: true, language: name === 'gigaam' ? 'ru' : 'en',
  micPreroll: false, liveWhisper: false, aiDictationRewrite: false,
  soundFeedback: false, keepModelLoaded: false, diagnostics: false,
  checkUpdates: false, clipboardMonitor: false, autoOptimize: false,
  closeToTray: false,
};
fs.writeFileSync(path.join(profile, 'profile.json'), JSON.stringify({
  'zs.settings': settings, 'zs:settings': settings, 'zs.dictations': [],
}));
let browser;
try {
  browser = await puppeteer.launch({
    executablePath: executable,
    headless: false,
    ignoreDefaultArgs: true,
    dumpio: process.env.ZS_CHROME_DEBUG === '1',
    env: { ...process.env, ZS_E2E_PROFILE: profile, ZSPEAKLY_DEV_URL: 'none' },
    args: [
      path.resolve('scripts/e2e/electron-entry.cjs'),
      '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
      '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${wav}%noloop`,
    ],
    timeout: 60000,
  });
  const target = await browser.waitForTarget((t) => t.type() === 'page' && t.url().includes('index.html'), { timeout: 30000 });
  const page = await target.page();
  assert.ok(page, 'главное окно Electron не найдено');
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err.message || err)));
  await page.waitForSelector('.app-window', { timeout: 30000 });
  await page.waitForFunction(() => Boolean(window.zspeakly?.isElectron && window.zspeakly?.native?.transcribePcm), { timeout: 15000 });
  const status = await page.evaluate(async () => window.zspeakly.native.modelsStatus());
  assert.equal(name === 'gigaam' ? status.russian.available : status.european.available, true, 'настоящая модель не готова');
  console.log(`Electron ${await page.evaluate(() => window.zspeakly.versions.electron)}; ${name} найдена через настоящий IPC.`);
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => /Начать диктовку/.test(b.innerText)), { timeout: 15000 });
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => /Начать диктовку/.test(b.innerText)).click());
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => /Слушаю/.test(b.innerText)), { timeout: 10000 });
  await new Promise((resolve) => setTimeout(resolve, Math.ceil(seconds * 1000) + 700));
  await page.evaluate(() => {
    const stop = document.querySelector('[aria-label="Остановить запись"]') || [...document.querySelectorAll('button')].find((b) => /Слушаю/.test(b.innerText));
    if (!stop) throw new Error('кнопка остановки не найдена');
    stop.click();
  });
  await page.waitForFunction(() => {
    const list = window.zspeakly.store.getSync('zs.dictations');
    return Array.isArray(list) && list.length > 0;
  }, { timeout: 60000 });
  const result = await page.evaluate(async () => ({
    history: await window.zspeakly.store.get('zs.dictations'),
    clipboard: await window.zspeakly.native.readClipboard(),
    inputStatus: await window.zspeakly.native.inputStatus(),
    pageText: document.body.innerText,
  }));
  assert.equal(errors.length, 0, `ошибки страницы: ${errors.join('; ')}`);
  const entry = result.history[0];
  assert.equal(entry.sttMode, name, `использован не тот движок: ${JSON.stringify(entry)}`);
  const patterns = name === 'gigaam' ? [/привет/iu, /распознаван/iu] : [/ask/i, /country/i];
  for (const pattern of patterns) assert.match(entry.text || '', pattern);
  // Linux здесь не отправляет Ctrl+V в другие программы. Приложение должно
  // честно оставить текст в настоящем системном буфере, а не заявить успех.
  await page.waitForFunction(async () => {
    const st = await window.zspeakly.native.inputStatus();
    return st.last?.ok === false;
  }, { timeout: 15000 });
  const clipboard = await page.evaluate(async () => window.zspeakly.native.readClipboard());
  assert.equal(clipboard.text, entry.text, 'после отказа вставки текст не остался в системном буфере');
  console.log(`История (${entry.sttMode}): ${entry.text}`);
  console.log('Настоящий Electron IPC и системный буфер проверены; микрофон виртуальный, ввод в другое окно не проверялся.');
} finally {
  if (browser) await browser.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
