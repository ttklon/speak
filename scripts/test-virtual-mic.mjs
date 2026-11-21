/**
 * Сквозная проверка диктовки с виртуальным микрофоном Chromium. Виртуальное
 * устройство читает публичный WAV в реальном времени; это НЕ физический микрофон.
 * Рендерер и запись настоящие. Electron IPC и системная вставка заменены тестовым
 * мостом, который отдаёт полученный PCM настоящему ONNX-движку приложения.
 *
 * node scripts/test-virtual-mic.mjs gigaam /path/ru.wav
 * node scripts/test-virtual-mic.mjs parakeet /path/en.wav
 * --capture-only проверяет только захват и интерфейс с фиктивным ответом.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { installMockBridge } from './e2e/mock-bridge.mjs';
import { stubElectron, loadEngine, readWav } from './lib/engine-cli.mjs';
import { createPaddedWav } from './lib/virtual-mic-wav.mjs';

const [name, file, ...flags] = process.argv.slice(2);
if (!['gigaam', 'parakeet'].includes(name) || !file || !existsSync(file)) {
  console.error('Использование: node scripts/test-virtual-mic.mjs gigaam|parakeet файл.wav [--capture-only]');
  process.exit(2);
}
const captureOnly = flags.includes('--capture-only');
const wav = path.resolve(file);
const input = readWav(wav);
assert.equal(input.sampleRate, 16000, 'для виртуального микрофона требуется WAV 16 кГц');
const seconds = input.pcm.length / 32000;
assert.ok(seconds >= 1 && seconds <= 15, 'контрольный WAV должен длиться от 1 до 15 секунд');
let engine;
if (!captureOnly) {
  stubElectron();
  engine = loadEngine(name);
  assert.equal(engine.status().available, true, `модель недоступна: ${engine.status().reason}`);
}
const chrome = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/chromium', '/tmp/chromium']
  .find((p) => p && existsSync(p));
assert.ok(chrome, 'не найден Chromium: укажите CHROME_PATH');
const base = (process.env.ZS_BASE_URL || 'http://127.0.0.1:5189').replace(/\/$/, '');
const port = new URL(base).port || '5189';
let vite, browser;
const padded = createPaddedWav(input.pcm, input.sampleRate);
const records = [];
// Сравниваем огибающие по 20 мс с допуском на сдвиг и ресемплинг браузера.
// Так синус тестового устройства не пройдёт вместо выбранного файла.
function envelope(pcm) {
  const result = [];
  for (let offset = 0; offset + 640 <= pcm.length; offset += 640) {
    let energy = 0;
    for (let i = offset; i < offset + 640; i += 2) energy += pcm.readInt16LE(i) ** 2;
    result.push(Math.sqrt(energy / 320));
  }
  return result;
}
function similarity(reference, recorded) {
  const a = envelope(reference), b = envelope(recorded);
  let best = -1;
  for (let shift = -a.length + 50; shift <= b.length - 50; shift++) {
    const from = Math.max(0, -shift), to = Math.min(a.length, b.length - shift);
    const n = to - from;
    if (n < 50) continue;
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
    for (let i = from; i < to; i++) {
      const x = a[i], y = b[i + shift];
      sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
    }
    const denominator = Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy));
    if (denominator) best = Math.max(best, (n * sxy - sx * sy) / denominator);
  }
  return best;
}
try {
  try {
    if (!(await fetch(base, { signal: AbortSignal.timeout(1000) })).ok) throw new Error('сервер не отвечает');
  } catch {
    vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '0.0.0.0', '--port', port, '--strictPort'], {
      cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
    });
    vite.stdout.on('data', (data) => process.stdout.write(data));
    vite.stderr.on('data', (data) => process.stderr.write(data));
    const deadline = Date.now() + 60000;
    while (true) {
      if (vite.exitCode !== null) throw new Error(`Vite завершился с кодом ${vite.exitCode}`);
      try { if ((await fetch(base, { signal: AbortSignal.timeout(1000) })).ok) break; } catch { /* ждём запуск */ }
      if (Date.now() >= deadline) throw new Error('Vite не запустился');
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    dumpio: process.env.ZS_CHROME_DEBUG === '1',
    args: [
      '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--mute-audio',
      '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
      // Без noloop Chromium начинает фразу заново после конца файла — лишние
      // слова тестовой записи ошибочно выглядят как галлюцинация модели.
      `--use-file-for-fake-audio-capture=${padded.file}%noloop`, '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err.message || err)));
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = req.url();
    if (url.startsWith(base) || url.startsWith('data:') || url.startsWith('blob:')) req.continue();
    else req.abort();
  });
  await page.exposeFunction('__virtualMicTranscribe', async (encoded, info) => {
    const pcm = Buffer.from(encoded, 'base64');
    let peak = 0, sum = 0;
    for (let i = 0; i + 1 < pcm.length; i += 2) {
      const x = pcm.readInt16LE(i);
      peak = Math.max(peak, Math.abs(x));
      sum += x * x;
    }
    const rms = Math.sqrt(sum / (pcm.length / 2 || 1));
    const correlation = similarity(input.pcm, pcm);
    records.push({ bytes: pcm.length, peak, rms, correlation, ...info });
    console.log(`Захвачено ${(pcm.length / 32000).toFixed(2)} с PCM, RMS ${Math.round(rms)}, сходство с WAV ${correlation.toFixed(2)}, язык ${info.lang}`);
    if (captureOnly) return { ok: true, text: 'Проверка виртуального микрофона.', mode: 'test', ms: 1 };
    const result = await engine.transcribe(pcm, { sampleRate: 16000 });
    return { ...result, mode: name, model: name };
  });
  await page.evaluateOnNewDocument(installMockBridge);
  await page.evaluateOnNewDocument(({ language }) => {
    localStorage.clear();
    localStorage.setItem('mockstore:zs.settings', JSON.stringify({
      onboarded: true, speedFix151: true, language, micPreroll: false,
      liveWhisper: false, aiDictationRewrite: false, soundFeedback: false,
      keepModelLoaded: false, diagnostics: false, checkUpdates: false,
    }));
    localStorage.setItem('mockstore:zs.dictations', '[]');
    // Наблюдаем настоящие MediaStreamTrack, не заменяя устройство или звук.
    const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    window.__virtualMicTracks = [];
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await originalGetUserMedia(constraints);
      window.__virtualMicTracks.push(...stream.getTracks());
      return stream;
    };
    window.zspeakly.native.transcribePcm = async (payload) => {
      const bytes = new Uint8Array(payload.pcm.buffer, payload.pcm.byteOffset, payload.pcm.byteLength);
      let str = '';
      for (let i = 0; i < bytes.length; i += 8192) str += String.fromCharCode(...bytes.subarray(i, i + 8192));
      return window.__virtualMicTranscribe(btoa(str), { lang: payload.lang, partial: payload.partial === true });
    };
  }, { language: name === 'gigaam' ? 'ru' : 'en' });
  await page.goto(`${base}/#/home`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.app-window', { timeout: 15000 });
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => /Начать диктовку/.test(b.innerText)), { timeout: 15000 });
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => /Начать диктовку/.test(b.innerText)).click());
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => /Слушаю/.test(b.innerText)), { timeout: 10000 });
  await new Promise((resolve) => setTimeout(resolve, Math.ceil(padded.seconds * 1000) + 700));
  await page.evaluate(() => {
    const stop = document.querySelector('[aria-label="Остановить запись"]') || [...document.querySelectorAll('button')].find((b) => /Слушаю/.test(b.innerText));
    if (!stop) throw new Error('Кнопка остановки не найдена');
    stop.click();
  });
  await page.waitForFunction(() => {
    const list = window.__e2e.read('zs.dictations');
    return Array.isArray(list) && list.length > 0;
  }, { timeout: 60000 });
  const outcome = await page.evaluate(() => ({
    history: window.__e2e.read('zs.dictations'),
    inserts: (window.__bridgeCalls || []).filter((c) => c.channel === 'text:insert').map((c) => c.args?.[0]),
    tracks: (window.__virtualMicTracks || []).map((t) => t.readyState),
  }));
  assert.equal(errors.length, 0, `ошибка страницы: ${errors.join('; ')}`);
  assert.ok(outcome.tracks.length > 0 && outcome.tracks.every((s) => s === 'ended'), `микрофон остался открыт: ${outcome.tracks}`);
  assert.ok(records.length > 0, 'звук не дошёл до распознавателя');
  assert.ok(records.some((r) => r.bytes >= 32000 && r.rms > 100 && r.peak > 1000), 'PCM пустой или слишком тихий');
  assert.ok(records.some((r) => r.correlation > 0.4), 'поступил звук не из контрольного WAV');
  assert.ok(records.every((r) => r.lang === (name === 'gigaam' ? 'ru' : 'en')), 'неверный язык записи');
  const text = String(outcome.history[0]?.text || '');
  const expected = captureOnly ? [/виртуального микрофона/i] : name === 'gigaam' ? [/привет/iu, /распознаван/iu] : [/ask/i, /country/i];
  for (const pattern of expected) assert.match(text, pattern, `неожиданный текст в истории: ${text}`);
  assert.equal(outcome.inserts.length, 1, 'ожидалась одна вставка через подставной мост');
  console.log(`История: ${text}`);
  console.log(`Виртуальный микрофон: ${captureOnly ? 'только захват, ответ подставной' : `${name}, настоящие ONNX-веса`}; вставка и IPC подставные.`);
} finally {
  if (browser) await browser.close();
  if (vite) vite.kill('SIGTERM');
  engine?.unload();
  padded.cleanup();
}
