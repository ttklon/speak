/**
 * Снимок плавающего индикатора диктовки для документации.
 *
 * Окно индикатора — это отдельный HTML (electron/hud.html), поэтому его можно
 * отрисовать в обычном Chromium и получить точное изображение того, что видит
 * человек: те же стили, те же состояния. Мост `hudBridge` подменяется, чтобы
 * показать состояние «слушаю» с живым текстом.
 *
 *   CHROME_PATH=/путь/к/chrome node scripts/capture-hud.mjs
 *   → docs/screenshots/16-dictation-hud.png
 */

import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const OUT = path.resolve('docs/screenshots/16-dictation-hud.png');
const SCALE = 3;
const WIDTH = 360;
const HEIGHT = 92;

function findChrome() {
  const candidates = [process.env.CHROME_PATH, '/tmp/chromium', '/usr/bin/chromium', '/usr/bin/google-chrome'];
  return candidates.filter(Boolean).find((p) => existsSync(p));
}

const chrome = findChrome();
if (!chrome) {
  console.error('Chromium не найден: укажите CHROME_PATH');
  process.exit(2);
}

await mkdir(path.dirname(OUT), { recursive: true });
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: SCALE });
  await page.evaluateOnNewDocument(() => {
    window.__cbs = [];
    window.hudBridge = {
      stop: () => {},
      close: () => {},
      onState: (cb) => {
        window.__cbs.push(cb);
        return () => {};
      },
    };
  });
  await page.goto(`file://${path.resolve('electron/hud.html')}`);
  const state = {
    state: 'listening',
    level: 0.68,
    elapsed: 4300,
    draft: 'нужно закрыть квартальный отчёт до пятницы',
    error: '',
    hint: '',
  };
  await page.evaluate((payload) => window.__cbs.forEach((cb) => cb(payload)), state);
  // плашка прозрачная: подкладываем «рабочий стол», иначе снимок уйдёт на белом
  await page.addStyleTag({
    content: 'html{background:linear-gradient(160deg,#e9e9ec,#d7d9e0 55%,#c9ccd6);}',
  });
  await new Promise((r) => setTimeout(r, 150));
  await page.screenshot({ path: OUT });
  console.log(`✓ ${path.relative(process.cwd(), OUT)} — ${WIDTH}×${HEIGHT} @${SCALE}x`);
} finally {
  await browser.close();
}
