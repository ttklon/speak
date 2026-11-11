/**
 * Скриншоты интерфейса для README и документации.
 *
 * Запуск (нужен работающий dev-сервер, `npm run dev` в другом окне):
 *   npm run screenshots
 *
 * Зависимости для скриншотов не входят в проект, чтобы не утяжелять установку.
 * Один раз поставьте их локально:
 *   npm i --no-save puppeteer-core@23 @sparticuz/chromium@131
 * На Windows проще взять свой Chrome:
 *   CHROME_PATH="C:\Program Files\Google\Chrome\Application\chrome.exe" npm run screenshots
 *
 * Результат — docs/screenshots/*.png (светлая тема — отдельным кадром).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'docs', 'screenshots');
const BASE = process.env.ZS_BASE_URL || 'http://127.0.0.1:5173';

fs.mkdirSync(outDir, { recursive: true });

async function loadBrowser() {
  const puppeteer = await import('puppeteer-core').catch(() => null);
  if (!puppeteer) {
    throw new Error(
      'нет puppeteer-core. Установите: npm i --no-save puppeteer-core@23 @sparticuz/chromium@131',
    );
  }
  const custom = process.env.CHROME_PATH;
  if (custom) {
    return {
      puppeteer: puppeteer.default,
      executablePath: custom,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    };
  }
  const chromium = await import('@sparticuz/chromium').catch(() => null);
  if (!chromium) {
    throw new Error(
      'нет браузера. Либо CHROME_PATH=путь\\к\\chrome.exe, либо npm i --no-save @sparticuz/chromium@131',
    );
  }
  const executablePath = await chromium.default.executablePath();
  return {
    puppeteer: puppeteer.default,
    executablePath,
    args: [
      ...chromium.default.args,
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--font-render-hinting=none',
    ],
    chromiumLibs: '/tmp/al2023/lib',
  };
}

const SHOTS = [
  { file: '01-home.png', hash: '#/home', scope: 'window' },
  { file: '02-hotkeys.png', hash: '#/hotkeys', scope: 'window' },
  { file: '03-clipboard.png', hash: '#/clipboard', scope: 'window' },
  { file: '04-dictionary.png', hash: '#/dictionary', scope: 'window' },
  {
    file: '05-clipboard-list.png',
    hash: '#/clipboard',
    scope: 'window',
    async before(page) {
      await page.click('.clip-toolbar__view button:nth-child(2)');
      await pause(250);
    },
  },
  {
    file: '06-settings-app.png',
    hash: '#/settings?section=app&from=home',
    scope: 'viewport',
  },
  {
    file: '07-settings-features.png',
    hash: '#/settings?section=features&from=home',
    scope: 'viewport',
  },
  {
    file: '08-settings-diagnostics.png',
    hash: '#/settings?section=diagnostics&from=home',
    scope: 'viewport',
  },
  {
    file: '09-light-home.png',
    hash: '#/home',
    scope: 'window',
    settings: { theme: 'light' },
  },
  {
    file: '10-light-settings.png',
    hash: '#/settings?section=app&from=home',
    scope: 'viewport',
    settings: { theme: 'light' },
  },
  { file: '12-light-hotkeys.png', hash: '#/hotkeys', scope: 'window', settings: { theme: 'light' } },
  { file: '13-light-clipboard.png', hash: '#/clipboard', scope: 'window', settings: { theme: 'light' } },
  { file: '14-light-dictionary.png', hash: '#/dictionary', scope: 'window', settings: { theme: 'light' } },
];

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const { puppeteer, executablePath, args, chromiumLibs } = await loadBrowser();
  if (chromiumLibs && !process.env.LD_LIBRARY_PATH?.includes(chromiumLibs) && fs.existsSync(chromiumLibs)) {
    process.env.LD_LIBRARY_PATH = `${chromiumLibs}:${process.env.LD_LIBRARY_PATH || ''}`;
  }

  const browser = await puppeteer.launch({ executablePath, args, headless: true });
  const done = [];

  for (const shot of SHOTS) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 });

    // первый запуск в превью показывает онбординг — для снимков он не нужен
    const settings = { onboarded: true, userName: 'Максим', ...(shot.settings || {}) };
    await page.evaluateOnNewDocument((data) => {
      localStorage.setItem('zs:zs.settings', JSON.stringify(data));
    }, settings);

    await page.goto(`${BASE}/${shot.hash}`, { waitUntil: 'networkidle2', timeout: 45000 });
    await pause(700);
    if (shot.before) await shot.before(page);
    await pause(250);

    const target = path.join(outDir, shot.file);
    if (shot.scope === 'window') {
      const el = await page.$('.app-window');
      await (el || page).screenshot({ path: target, type: 'png' });
    } else {
      await page.screenshot({ path: target, type: 'png' });
    }
    const size = Math.round(fs.statSync(target).size / 1024);
    done.push(`${shot.file} (${size} КБ)`);
    await page.close();
  }

  await browser.close();
  console.log(`Готово: ${done.length} снимков в docs/screenshots`);
  done.forEach((line) => console.log(`  · ${line}`));
}

main().catch((err) => {
  console.error('[screenshots]', err.message);
  process.exit(1);
});
