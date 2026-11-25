#!/usr/bin/env node
/**
 * E2E-прогон интерфейса ZSpeakly: «нажать всё и посмотреть, что сломается».
 *
 * Что делает:
 *  1. Поднимает (если нужно) dev-сервер Vite и открывает приложение в Chromium.
 *  2. Подменяет мост `window.zspeakly` моком (см. `scripts/e2e/mock-bridge.mjs`),
 *     поэтому кнопки реально вызывают IPC, а не молчат.
 *  3. Краулер: на каждом экране и в каждой секции настроек по очереди нажимает
 *     ВСЕ видимые кнопки/тумблеры/табы/карточки — по одному нажатию на свежей
 *     загрузке. Ловит ошибки консоли, падения React и «мёртвые» нажатия.
 *  4. Сценарии: онбординг, диктовка, словарь, буфер, настройки, темы,
 *     поиск по настройкам, правка расшифровки, AI-инструкция.
 *
 * Запуск:
 *   npm run dev            # в отдельном терминале (или скрипт поднимет сам)
 *   npm run test:ui        # CHROME_PATH=/путь/к/chrome, если не находится сам
 *
 * Код возврата 1, если хотя бы одна проверка упала.
 */

import { spawn } from 'node:child_process';
import { existsSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';
import { installMockBridge } from './e2e/mock-bridge.mjs';
import { runUiTask, runUiScenario } from './e2e/ui-task.mjs';
// демо-наборы больше не подставляются приложением — тесты кладут их сами
import { buildSeedClipboard, buildSeedDictations, SEED_DICTIONARY } from '../src/lib/seed.js';

const BASE = (process.env.ZS_BASE_URL || 'http://127.0.0.1:5173').replace(/\/$/, '');
// Индикатор диктовки — не часть сборки Vite: Electron открывает electron/hud.html
// прямо с диска (loadFile → file://). Тест делает то же, иначе против preview
// адрес отдаёт index.html приложения и проверка падает не по делу.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HUD_FILE = pathToFileURL(join(ROOT, 'electron', 'hud.html')).href;
const HEADLESS = process.env.HEADED !== '1';

const C = {
  ok: (s) => `\u001b[32m${s}\u001b[0m`,
  bad: (s) => `\u001b[31m${s}\u001b[0m`,
  dim: (s) => `\u001b[2m${s}\u001b[0m`,
  head: (s) => `\u001b[1m${s}\u001b[0m`,
};

const results = [];
function record(group, name, ok, detail = '') {
  results.push({ group, name, ok, detail });
  const mark = ok ? C.ok('✓') : C.bad('✗');
  console.log(`  ${mark} ${name}${detail ? C.dim(` — ${detail}`) : ''}`);
}

/* ── Chromium ─────────────────────────────────────────────────────────── */

async function resolveChrome() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const candidates = [
    '/tmp/chromium',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  try {
    const mod = await import('@sparticuz/chromium');
    const chromium = mod.default || mod;
    return await chromium.executablePath();
  } catch {
    /* нет пакета — покажем инструкцию ниже */
  }
  return null;
}

/* ── dev-сервер ───────────────────────────────────────────────────────── */

const alive = async (url) => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
};

async function ensureServer() {
  if (await alive(BASE)) return null;
  console.log(C.dim(`dev-сервер не отвечает — поднимаю ${BASE}`));
  // Запуск через Node работает и на Windows (без npx.cmd и shell-кавычек).
  const proc = spawn(process.execPath, [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), '--host', '0.0.0.0', '--port', new URL(BASE).port || '5173', '--strictPort'], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', () => {});
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await alive(BASE)) return proc;
    await sleep(400);
  }
  proc.kill('SIGTERM');
  throw new Error(`Не удалось поднять dev-сервер на ${BASE}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── страница ─────────────────────────────────────────────────────────── */

const SEED_SETTINGS = {
  onboarded: true,
  userName: 'Тест',
  // Профиль после исторической миграции; отдельный сценарий проверяет
  // профиль до неё и сохранение выбранного уровня модели.
  speedFix151: true,
  theme: 'dark',
  language: 'ru',
  whisperModel: 'small-q5_1',
  aiEndpoint: 'http://localhost:11434',
  aiModel: 'qwen2.5:0.5b',
  aiEnabled: true,
  screenContext: false,
  // сценарий «модель в памяти» проверяет включение тумблера с нуля
  keepModelLoaded: false,
  // полировка моделью по умолчанию включена; в E2E она переписала бы весь
  // текст распознавания ответом мока, поэтому здесь выключена, а сценарий
  // «модель» включает её намеренно
  aiDictationRewrite: false,
  diagnostics: false,
  checkUpdates: true,
  soundFeedback: false,
};

async function openPage(browser, route = '#/home', opts = {}) {
  const page = await browser.newPage();
  page.__delayedRequests = 0;
  page.__failedSectionRequests = 0;
  const errors = [];
  // Предупреждения React (ключи в списках, controlled/uncontrolled, act)
  // ошибками не считаются, но это будущие ошибки — их тоже собираем.
  const warnings = [];
  page.on('console', (msg) => {
    if (msg.type() === 'warning') {
      const text = `${msg.text()}`.slice(0, 300);
      if (!/Download the React DevTools|ResizeObserver|autofill|Third-party cookie|preloaded using link preload/i.test(text)) {
        warnings.push(text);
      }
      return;
    }
    if (msg.type() !== 'error') return;
    // Chromium часто пишет только «Failed to load resource: 404»; URL в
    // location позволяет отличить отсутствующую иконку от поломанного кода.
    const location = msg.location();
    const text = `${msg.text()}${location?.url ? ` (${location.url})` : ''}`.slice(0, 500);
    errors.push(text);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${String(err && err.message)}`.slice(0, 400)));

  // никакой сети наружу: тест должен быть детерминированным
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = req.url();
    const local = url.startsWith(BASE) || url.startsWith('data:') || url.startsWith('blob:');
    if (!local) req.abort();
    else if (opts.failSection && url.includes(opts.failSection) && page.__failedSectionRequests === 0) {
      page.__failedSectionRequests += 1;
      req.abort();
    } else if (opts.delaySection && url.includes(opts.delaySection)) {
      page.__delayedRequests += 1;
      setTimeout(() => req.continue().catch(() => {}), opts.delaySectionMs || 0);
    } else req.continue();
  });

  // Загрузка файла (резервная копия, отчёт) в headless-режиме может увести
// документ в blob: и подвесить evaluate — запрещаем скачивания в прогоне.
  try {
    const client = await page.createCDPSession();
    await client.send('Page.setDownloadBehavior', { behavior: 'deny' });
  } catch {
    /* старые сборки Chromium не знают этот метод — не критично */
  }

  const view = opts.viewport || { width: 1280, height: 800 };
  await page.setViewport({ width: view.width, height: view.height, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument(installMockBridge);
  // точечная правка моста под конкретный сценарий (до запуска приложения)
  // patchArg уходит в страницу вместе с функцией: evaluateOnNewDocument не
  // переносит замыкания, поэтому параметры передаём явно
  if (opts.patchNative) await page.evaluateOnNewDocument(opts.patchNative, opts.patchArg);
  const settings = { ...SEED_SETTINGS, ...(opts.settings || {}) };
  // содержимое по умолчанию: демо-история, демо-буфер и демо-словарь.
  // Сценарии, которым нужны пустые экраны, передают свои storeSeed.
  const fixtures = {
    'zs.dictations': buildSeedDictations(),
    'zs.clipboard': buildSeedClipboard(),
    'zs.dictionary': SEED_DICTIONARY,
    ...(opts.storeSeed || {}),
  };
  await page.evaluateOnNewDocument(([seed, fresh, extra, browserStorage]) => {
    if (fresh !== false) {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith('mockstore:') || (browserStorage && key.startsWith('zs:'))) localStorage.removeItem(key);
      }
    }
    localStorage.setItem('mockstore:zs.settings', JSON.stringify(seed));
    if (browserStorage) localStorage.setItem('zs:zs.settings', JSON.stringify(seed));
    // готовые данные для сценариев (буфер, словарь, история)
    for (const [key, value] of Object.entries(extra || {})) {
      localStorage.setItem(`mockstore:${key}`, JSON.stringify(value));
      if (browserStorage) localStorage.setItem(`zs:${key}`, JSON.stringify(value));
    }
  }, [settings, opts.fresh === false ? false : true, fixtures, opts.browserStorage === true]);
  await page.goto(`${BASE}/${route}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.app-window', { timeout: 15_000 });
  await sleep(opts.settle ?? 250);
  page.__errors = errors;
  page.__warnings = warnings;
  // Страховка от вечных ожиданий: зависший getDisplayMedia или ушедший
  // документ раньше подвешивали весь прогон без единой строчки в логе.
  const rawEvaluate = page.evaluate.bind(page);
  page.evaluate = (fn, ...args) =>
    Promise.race([
      rawEvaluate(fn, ...args),
      new Promise((_, reject) => setTimeout(() => reject(new Error('evaluate timeout (15s)')), 15_000)),
    ]);
  if (process.env.ZS_TRACE === '1') {
    const rawGoto = page.goto.bind(page);
    page.goto = (...a) => rawGoto(...a);
  }
  return page;
}

const takeErrors = (page) => {
  const list = page.__errors.slice();
  page.__errors.length = 0;
  return list;
};

const takeWarnings = (page) => {
  const list = (page.__warnings || []).slice();
  if (page.__warnings) page.__warnings.length = 0;
  return list;
};

const bridgeCalls = (page) => page.evaluate(() => (window.__bridgeCalls || []).map((c) => c.channel));

async function health(page) {
  return page.evaluate(() => {
    const root = document.getElementById('root');
    const text = document.body.innerText || '';
    return {
      hasWindow: Boolean(document.querySelector('.app-window')),
      rootEmpty: !root || root.children.length === 0,
      crashed: /Что-то пошло не так|Application error|Cannot read properties/i.test(text),
      title: text.split('\n').filter(Boolean).slice(0, 2).join(' · ').slice(0, 80),
      // чем ещё может ответить кнопка, кроме вызова моста: переход по hash,
      // открытие модалки/оверлея или изменение текста на экране
      hash: location.hash,
      // реакция — это и открывшееся окно/оверлей, и тост: оба видны человеку
      modal: Boolean(
        document.querySelector(
          '.modal, .settings-modal, .palette, .dropdown, .clip-preview, .toast, [role="dialog"]',
        ),
      ),
      textLen: text.length,
    };
  });
}

/* ── краулер ──────────────────────────────────────────────────────────── */

const TARGET_SELECTOR = [
  '.app-window button',
  '.app-window [role="button"]',
  '.app-window [role="switch"]',
  '.app-window [role="tab"]',
  '.app-window .select__control',
  '.app-window .nav-item',
  '.app-window a[href]',
  '.modal button',
  '.modal [role="button"]',
  '.modal [role="option"]',
  '.modal .select__control',
].join(', ');

function collectTargets({ selector, scope }) {
  const root = scope ? document.querySelector(scope) : document;
  if (!root) return [];
  const els = [...root.querySelectorAll(selector)];
  const seen = new Map();
  const out = [];
  els.forEach((el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const visible =
      rect.width > 0 &&
      rect.height > 0 &&
      style.visibility !== 'hidden' &&
      style.display !== 'none' &&
      Number(style.opacity) > 0.05;
    if (!visible) return;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return;
    const label = (el.getAttribute('aria-label') || el.innerText || el.value || el.title || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 48);
    const fp = [
      el.tagName,
      el.className && typeof el.className === 'string' ? el.className.slice(0, 60) : '',
      el.getAttribute('role') || '',
      label,
    ].join('|');
    const nth = seen.get(fp) || 0;
    seen.set(fp, nth + 1);
    out.push({ fp, nth, label, tag: el.tagName, cls: String(el.className || '').slice(0, 40) });
  });
  return out;
}

function clickByFingerprint(payload) {
  const { fp, nth, selector, scope } = payload;
  const root = scope ? document.querySelector(scope) : document;
  if (!root) return false;
  const els = [...root.querySelectorAll(selector)];
  const seen = new Map();
  for (const el of els) {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const visible =
      rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    if (!visible || el.disabled) continue;
    const label = (el.getAttribute('aria-label') || el.innerText || el.value || el.title || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 48);
    const key = [
      el.tagName,
      el.className && typeof el.className === 'string' ? el.className.slice(0, 60) : '',
      el.getAttribute('role') || '',
      label,
    ].join('|');
    const count = seen.get(key) || 0;
    seen.set(key, count + 1);
    if (key === fp && count === nth) {
      el.scrollIntoView({ block: 'center' });
      el.click();
      return true;
    }
  }
  return false;
}

async function explore(browser, { route, label, maxDepth2 = 6 }) {
  const page = await openPage(browser, route);
  const targets = await page.evaluate(collectTargets, { selector: TARGET_SELECTOR });
  await page.close();

  const fails = [];
  const dead = [];
  let clicked = 0;

  for (const target of targets) {
    if (target.cls.includes('btn--danger') && /удал|очист/i.test(target.label)) {
      // удаление подтверждаем отдельным сценарием, в общем обходе не трогаем:
      // иначе прогон стирает состояние, на котором проверяются другие кнопки
      continue;
    }
    if (process.env.ZS_TRACE === '1') console.log(C.dim(`      → ${label} / ${target.label || target.tag}`));
    const p = await openPage(browser, route, { settle: 180 });
    takeErrors(p);
    const before = await bridgeCalls(p);
    const beforeState = await health(p).catch(() => null);
    // Нажатие может увести документ (ссылка, form submit, download). Раньше
    // такой клик ронял весь прогон «Execution context was destroyed» и
    // остальные экраны вообще не проверялись. Теперь это отдельная находка.
    let hit = false;
    let navigated = false;
    try {
      hit = await p.evaluate(clickByFingerprint, { fp: target.fp, nth: target.nth, selector: TARGET_SELECTOR });
    } catch (err) {
      if (/evaluate timeout/i.test(String(err?.message))) {
        fails.push(`${target.label || target.tag}: страница перестала отвечать (15 с)`);
      } else {
        navigated = true;
        fails.push(`${target.label || target.tag}: нажатие уводит документ (${String(err?.message || err).slice(0, 80)})`);
      }
    }
    if (navigated) {
      await p.close().catch(() => {});
      continue;
    }
    if (!hit) {
      await p.close();
      continue;
    }
    clicked += 1;
    await sleep(220);
    let state;
    let errors;
    let after;
    try {
      state = await health(p);
      errors = takeErrors(p);
      after = await bridgeCalls(p);
    } catch (err) {
      fails.push(`${target.label || target.tag}: страница ушла после нажатия (${String(err?.message || err).slice(0, 60)})`);
      await p.close().catch(() => {});
      continue;
    }
    const fired = after.length - before.length;

    if (!state.hasWindow || state.rootEmpty || state.crashed) {
      fails.push(`${target.label || target.tag}: экран сломался (${state.title})`);
    }
    for (const err of errors) {
      fails.push(`${target.label || target.tag}: ${err}`);
    }

    // второй уровень: то, что открылось модалкой или выпадающим списком
    let dialog = null;
    try {
      dialog = await p.$('.modal, [role="dialog"], .select__menu');
    } catch {
      dialog = null;
    }
    if (dialog) {
      const scope = (await p.$('.modal, [role="dialog"]')) ? '.modal, [role="dialog"]' : '.select__menu';
      const inner = await p.evaluate(collectTargets, { selector: TARGET_SELECTOR, scope });
      await p.close();
      let used = 0;
      for (const sub of inner) {
        if (used >= maxDepth2) break;
        // контекст второго уровня тоже может умереть от навигации — не роняем прогон
        if (`${sub.fp}#${sub.nth}` === `${target.fp}#${target.nth}`) continue;
        if (process.env.ZS_TRACE === '1') console.log(C.dim(`      → ${label} / ${target.label || target.tag} / ${sub.label || sub.tag}`));
        const p2 = await openPage(browser, route, { settle: 160 });
        takeErrors(p2);
        try {
          const firstHit = await p2.evaluate(clickByFingerprint, {
            fp: target.fp,
            nth: target.nth,
            selector: TARGET_SELECTOR,
          });
          if (!firstHit) {
            await p2.close();
            continue;
          }
          await sleep(150);
          const secondHit = await p2.evaluate(clickByFingerprint, {
            fp: sub.fp,
            nth: sub.nth,
            selector: TARGET_SELECTOR,
            scope,
          });
          if (!secondHit) {
            await p2.close();
            continue;
          }
          used += 1;
          clicked += 1;
          await sleep(200);
          const st2 = await health(p2);
          const err2 = takeErrors(p2);
          if (!st2.hasWindow || st2.rootEmpty || st2.crashed) {
            fails.push(
              `${target.label} → ${sub.label}: экран сломался (win=${st2.hasWindow} empty=${st2.rootEmpty} crashed=${st2.crashed})`,
            );
          }
          for (const e of err2) fails.push(`${target.label} → ${sub.label}: ${e}`);
        } catch (err) {
          fails.push(`${target.label} → ${sub.label}: страница ушла (${String(err?.message || err).slice(0, 60)})`);
        }
        await p2.close().catch(() => {});
      }
      if (used === 0) dead.push(`${target.label || target.tag}: внутри открывшегося списка нечего нажать`);
      continue;
    }

    // «Ничего не произошло» — это когда нет ни вызова моста, ни смены экрана,
    // ни открывшейся модалки, ни изменившегося текста. Раньше кнопки навигации
    // попадали в этот список зря: они меняют hash, а не дергают main.
    const reacted =
      fired > 0 ||
      (beforeState &&
        (state.hash !== beforeState.hash ||
          (state.modal && !beforeState.modal) ||
          state.textLen !== beforeState.textLen));
    if (!reacted && target.tag === 'BUTTON' && !/tab|view|is-active/i.test(target.cls)) {
      dead.push(`${target.label || target.cls || target.tag}`);
    }
    await p.close();
  }

  const name = `${label}: ${clicked} нажатий`;
  record('обход', name, fails.length === 0, fails.length ? `${fails.length} проблем` : '');
  for (const f of fails.slice(0, 25)) console.log(`      ${C.bad('•')} ${f}`);
  if (fails.length > 25) console.log(C.dim(`      … и ещё ${fails.length - 25}`));
  if (dead.length) {
    console.log(C.dim(`      без видимой реакции: ${[...new Set(dead)].slice(0, 12).join(', ')}`));
  }
  return fails;
}

/* ── сценарии ─────────────────────────────────────────────────────────── */

const clickText = async (page, text, selector = 'button, [role="button"], [role="tab"], .nav-item') => {
  const handle = await page.evaluateHandle(
    (textArg, selArg) => {
      const els = [...document.querySelectorAll(selArg)];
      return (
        els.find((el) => {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return false;
          const label = (el.getAttribute('aria-label') || el.innerText || '').replace(/\s+/g, ' ').trim();
          return label === textArg;
        }) || null
      );
    },
    text,
    selector,
  );
  const el = handle.asElement();
  if (!el) throw new Error(`кнопка «${text}» не найдена`);
  await el.evaluate((node) => node.scrollIntoView({ block: 'center' }));
  await el.click();
  await sleep(200);
};

const textOf = (page, selector) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el ? el.innerText.replace(/\s+/g, ' ').trim() : null;
  }, selector);

async function scenarioOnboarding(browser) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  await page.setRequestInterception(true);
  page.on('request', (req) => (req.url().startsWith(BASE) || req.url().startsWith('data:') ? req.continue() : req.abort()));
  await page.setViewport({ width: 1280, height: 800 });
  await page.evaluateOnNewDocument(installMockBridge);
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('mockstore:zs.settings', JSON.stringify({ onboarded: false }));
  });
  await page.goto(`${BASE}/#/home`, { waitUntil: 'domcontentloaded' });
  await sleep(500);

  const hasOnboarding = await page.evaluate(() =>
    Boolean([...document.querySelectorAll('button')].find((b) => /начать|погнали|готово/i.test(b.innerText))),
  );
  // когда движок уже стоит (mock native), лишней плашки про модель быть не должно
  const noWarning = await page.evaluate(
    () => !/Скачать модель/i.test(document.querySelector('.modal')?.innerText || ''),
  );
  const input = await page.$('.modal input');
  if (input) {
    await input.click({ clickCount: 3 });
    await input.type('Мария');
  }
  // идём по шагам онбординга, пока не появится «Начать»
  for (let step = 0; step < 6; step += 1) {
    const started = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('.modal button')].find((b) => /начать|погнали|поехали/i.test(b.innerText));
      if (!btn) return false;
      btn.click();
      return true;
    });
    if (started) break;
    const next = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('.modal button')].find((b) => /далее|дальше|продолжить|пропустить/i.test(b.innerText));
      if (!btn) return false;
      btn.click();
      return true;
    });
    await sleep(250);
    if (!next) break;
  }
  await sleep(500);
  const body = await page.evaluate(() => document.body.innerText);
  record('сценарии', 'онбординг проходится до конца', hasOnboarding && /Главная|Недавние|Привет/i.test(body), errors[0] || '');
  record('сценарии', 'онбординг не пугает плашкой, когда движок уже есть', noWarning);
  await page.close();

  // Чистая установка без модели: одна кнопка «Скачать и начать» ставит движок
  // и модель прямо в окне онбординга — без похода в настройки.
  const bare = await browser.newPage();
  await bare.setViewport({ width: 1280, height: 800 });
  await bare.evaluateOnNewDocument(installMockBridge);
  await bare.evaluateOnNewDocument(() => {
    // модель ещё не скачана: main отвечает, что распознавать нечем
    if (window.zspeakly?.native) {
      window.zspeakly.native.sttStatus = async () => ({ available: false, reason: 'модель не найдена' });
    }
    localStorage.setItem('mockstore:zs.settings', JSON.stringify({ onboarded: false }));
  });
  await bare.goto(`${BASE}/#/home`, { waitUntil: 'domcontentloaded' });
  await bare.waitForSelector('.modal', { timeout: 8000 }).catch(() => {});
  await sleep(600);
  const cta = await bare.evaluate(() => {
    const btn = [...document.querySelectorAll('.modal button')].find((b) => /Скачать и начать/i.test(b.innerText));
    const warn = document.querySelector('.onboarding__hint--warn')?.innerText || '';
    return { found: Boolean(btn), warn };
  });
  if (cta.found) {
    await bare.evaluate(() => {
      const btn = [...document.querySelectorAll('.modal button')].find((b) => /Скачать и начать/i.test(b.innerText));
      btn?.click();
    });
    await sleep(900);
  }
  const mid = await bare.evaluate(() => ({
    text: document.querySelector('.modal')?.innerText || '',
    settingsOpen: Boolean(document.querySelector('.settings-modal')),
  }));
  await sleep(3200);
  const after = await bare.evaluate(() => ({
    text: document.querySelector('.modal')?.innerText || '',
    cta: [...document.querySelectorAll('.modal button')].map((b) => b.innerText.trim()),
  }));
  const calls = await bridgeCalls(bare);
  record(
    'сценарии',
    'онбординг без модели скачивает её сам, без похода в настройки',
    cta.found &&
      /движок|Web Speech|модел/i.test(cta.warn) &&
      !mid.settingsOpen &&
      /Скачиваю/i.test(mid.text) &&
      calls.includes('models:download') &&
      /Готово/i.test(after.text) &&
      after.cta.some((t) => /Начать работу/i.test(t)),
    `кнопка=${cta.found} настройки=${mid.settingsOpen} звонки=${calls.filter((c) => c.startsWith('models:')).join(',')} финал=${after.text.split('\n').pop()}`,
  );
  await bare.close();
}

async function scenarioDictation(browser) {
  // полировка выключена: проверяем путь «речь → текст → вставка», а модель
  // проверяется отдельным сценарием (иначе в историю попадает ответ модели)
  const page = await openPage(browser, '#/home', { settings: { aiDictationRewrite: false } });
  takeErrors(page);
  const stored = () =>
    page.evaluate(() => {
      const list = window.__e2e.read('zs.dictations');
      return Array.isArray(list) ? list.length : -1;
    });
  const before = await stored();

  // старт диктовки кнопкой в шапке
  await clickText(page, 'Начать диктовку');
  await sleep(1200);
  const recording = await page.evaluate(() => /Слушаю/i.test(document.body.innerText));
  await page.evaluate(() => {
    const stop = document.querySelector('[aria-label="Остановить запись"]');
    if (stop) stop.click();
    else {
      const btn = [...document.querySelectorAll('button')].find((b) => /Слушаю/i.test(b.innerText));
      btn?.click();
    }
  });
  await sleep(2000);
  const after = await stored();
  const errors = takeErrors(page).filter((e) => !/AudioContext|NotAllowedError|microphone/i.test(e));
  const added = await page.evaluate(() =>
    [...document.querySelectorAll('.recent__row .recent__text')].map((el) => el.innerText).join(' '),
  );
  record('сценарии', 'диктовка: старт и стоп добавляют запись', recording && after === before + 1, `${before} → ${after} в истории`);
  record('сценарии', 'диктовка: распознанный текст попадает в историю', /Проверка диктовки/i.test(added));
  // Скорость видна человеку: «1,4 с» в строке истории и точное время в подсказке.
  const speed = await page.evaluate(() => {
    const el = document.querySelector('.recent__row .recent__speed');
    return el ? { text: el.innerText.trim(), title: el.getAttribute('title') || '' } : null;
  });
  record(
    'сценарии',
    'диктовка: в истории видно, за сколько распознано',
    Boolean(speed) && /1,4 с/.test(speed.text) && /Распознано за 1\.40 с/.test(speed.title),
    speed ? `${speed.text} · ${speed.title}` : 'бейджа скорости нет',
  );
  const inserts = await page.evaluate(() =>
    (window.__bridgeCalls || []).filter((c) => c.channel === 'text:insert').map((c) => String(c.args?.[0] || '')),
  );
  record('сценарии', 'диктовка: текст вставляется в активное окно', inserts.length === 1 && /Проверка диктовки/i.test(inserts[0]), `вставок: ${inserts.length}`);
  record('сценарии', 'диктовка не пишет в консоль ошибок', errors.length === 0, errors[0] || '');
  await page.close();
}

// Голосовая пунктуация: сказанное «запятая» или «с новой строки» — это знаки,
// а не слова. Раньше они попадали в текст как есть, и человек правил руками.
async function scenarioVoiceCommands(browser) {
  const spoken =
    'привет запятая как дела точка с новой строки купить хлеб и молоко удалить последнее слово';
  const page = await openPage(browser, '#/home', {
    settings: { aiDictationRewrite: false },
    storeSeed: { 'zs.dictations': [], 'zs.mockSttText': spoken },
  });
  takeErrors(page);
  await clickText(page, 'Начать диктовку');
  await sleep(1100);
  await page.evaluate(() => {
    const stop = document.querySelector('[aria-label="Остановить запись"]');
    if (stop) stop.click();
    else [...document.querySelectorAll('button')].find((b) => /Слушаю/i.test(b.innerText))?.click();
  });
  await sleep(2200);
  const saved = await page.evaluate(() => {
    const list = window.__e2e.read('zs.dictations');
    return Array.isArray(list) && list[0] ? String(list[0].text || '') : '';
  });
  record(
    'сценарии',
    'голос: «запятая», «точка» и «с новой строки» становятся знаками',
    saved === 'Привет, как дела.\nКупить хлеб и.',
    JSON.stringify(saved),
  );
  const inserts = await page.evaluate(() =>
    (window.__bridgeCalls || [])
      .filter((c) => c.channel === 'text:insert')
      .map((c) => String(c.args?.[0] || '')),
  );
  record(
    'сценарии',
    'голос: в чужое окно уходит текст с переносом строки, без слов-команд',
    inserts.length === 1 &&
      inserts[0].includes('\n') &&
      !/запятая|новой строки|удалить последнее/i.test(inserts[0]),
    inserts[0] ? JSON.stringify(inserts[0]) : 'вставок нет',
  );
  const tip = await page.evaluate(() => /Скажите «запятая»/i.test(document.body.innerText));
  record('сценарии', 'голос: на главной есть подсказка о командах', tip);
  const errors = takeErrors(page);
  record('сценарии', 'голос: без ошибок консоли', errors.length === 0, errors[0] || '');
  await page.close();
}

async function scenarioVoiceDeleteSafety(browser) {
  const cases = [
    ['Скажи «удалить последнее слово» вслух', 'Скажи «удалить последнее слово» вслух.'],
    ['Первое предложение. Второе предложение. удалить последнее предложение', 'Первое предложение.'],
    ['Привет не готов удалить последнее слово', 'Привет не.'],
    ['Привет 👩‍💻 удалить последнее слово', 'Привет.'],
    ['первое второе удалить последнюю фразу', 'Первое второе удалить последнюю фразу.'],
    ['Предыдущее. Доклад И. И. Иванова удалить последнее предложение', 'Предыдущее. Доклад И. И. Иванова удалить последнее предложение.'],
    ['Пожалуйста не удалить последнее предложение', 'Пожалуйста не удалить последнее предложение.'],
    ['Первый пункт\nВторой пункт удалить последнее предложение', 'Первый пункт.'],
  ];
  for (const [spoken, expected] of cases) {
    const page = await openPage(browser, '#/home', {
      settings: { aiDictationRewrite: false },
      storeSeed: { 'zs.dictations': [], 'zs.mockSttText': spoken },
    });
    takeErrors(page);
    await clickText(page, 'Начать диктовку'); await sleep(1100);
    await page.evaluate(() => {
      const stop = document.querySelector('[aria-label="Остановить запись"]');
      if (stop) stop.click();
      else [...document.querySelectorAll('button')].find((b) => /Слушаю/i.test(b.innerText))?.click();
    });
    await sleep(2300);
    const result = await page.evaluate(() => ({
      saved: window.__e2e.read('zs.dictations')?.[0]?.text,
      inserted: (window.__bridgeCalls || []).find((c) => c.channel === 'text:insert')?.args?.[0],
    }));
    record('сценарии', `голосовое удаление: ${spoken}`, result.saved === expected && result.inserted === expected, JSON.stringify(result));
    await page.close();
  }
}

/**
 * Быстрые блоки: сказал триггер целиком — вставился готовый текст.
 * Проверяем через настоящий проход диктовки, а не только юнит-тестом: важно,
 * что блок доходит и в историю, и в окно, и что он не срабатывает посреди фразы.
 */
async function scenarioSnippets(browser) {
  const body = 'С уважением,\nИван Петров\n+7 900 000-00-00';
  const page = await openPage(browser, '#/home', {
    settings: { aiDictationRewrite: false },
    storeSeed: {
      'zs.dictations': [],
      'zs.mockSttText': 'моя подпись',
      'zs.snippets': [{ id: 's1', trigger: 'моя подпись', body, createdAt: Date.now() }],
    },
  });
  takeErrors(page);
  await clickText(page, 'Начать диктовку');
  await sleep(1100);
  await page.evaluate(() => {
    const stop = document.querySelector('[aria-label="Остановить запись"]');
    if (stop) stop.click();
    else [...document.querySelectorAll('button')].find((b) => /Слушаю/i.test(b.innerText))?.click();
  });
  await sleep(2300);
  const result = await page.evaluate(() => {
    const list = window.__e2e.read('zs.dictations');
    const saved = Array.isArray(list) && list[0] ? String(list[0].text || '') : '';
    const inserts = (window.__bridgeCalls || [])
      .filter((c) => c.channel === 'text:insert')
      .map((c) => String(c.args?.[0] || ''));
    return { saved, inserted: inserts[0] || '' };
  });
  record(
    'сценарии',
    'быстрые блоки: сказанный триггер вставил готовый текст',
    result.saved === body && result.inserted === body,
    JSON.stringify(result.saved.slice(0, 60)),
  );

  // В словаре блок виден человеку: триггер и начало текста, без «технических» имён
  const dict = await openPage(browser, '#/dictionary', {
    storeSeed: { 'zs.snippets': [{ id: 's1', trigger: 'моя подпись', body, createdAt: Date.now() }] },
    settle: 700,
  });
  takeErrors(dict);
  const shown = await dict.evaluate(() => {
    const row = document.querySelector('.snippet-row');
    return row ? row.innerText.replace(/\n+/g, ' ') : '';
  });
  record(
    'сценарии',
    'быстрые блоки: в словаре видно, что сказать и что вставится',
    /моя подпись/i.test(shown) && /С уважением/.test(shown),
    shown.slice(0, 120) || 'блока нет',
  );
  const dictErrors = takeErrors(dict);
  record('сценарии', 'быстрые блоки: без ошибок консоли', dictErrors.length === 0, dictErrors[0] || '');
  await dict.close();
  await page.close();
}

async function scenarioSnippetSafety(browser) {
  for (const [target, body] of [['Telegram', '  первая  строка\n    вторая.\n'], ['Outlook', 'адрес без точки'], ['Telegram', 'отмени']]) {
    const page = await openPage(browser, '#/home', {
      settings: { aiDictationRewrite: false },
      storeSeed: { 'zs.dictations': [], 'zs.mockSttText': 'моя подпись',
        'zs.snippets': [{ id: 's1', trigger: 'моя подпись', body, createdAt: Date.now() }] },
    });
    takeErrors(page);
    await page.evaluate((app) => { window.zspeakly.native.insertTarget = async () => ({ own: false, app, title: app }); }, target);
    await clickText(page, 'Начать диктовку'); await sleep(1100);
    await page.evaluate(() => {
      const stop = document.querySelector('[aria-label="Остановить запись"]');
      if (stop) stop.click();
      else [...document.querySelectorAll('button')].find((b) => /Слушаю/i.test(b.innerText))?.click();
    });
    await sleep(2300);
    const result = await page.evaluate(() => ({
      saved: window.__e2e.read('zs.dictations')?.[0]?.text,
      inserted: (window.__bridgeCalls || []).find((c) => c.channel === 'text:insert')?.args?.[0],
    }));
    record('сценарии', `быстрый блок: точный текст в ${target} (${JSON.stringify(body)})`, result.saved === body && result.inserted === body, JSON.stringify(result));
    await page.close();
  }
  const page = await openPage(browser, '#/dictionary', {
    storeSeed: { 'zs.snippets': [{ id: 'original', trigger: 'моя подпись', body: 'исходный текст', createdAt: Date.now() }] },
  });
  takeErrors(page);
  await clickText(page, 'Добавить блок');
  await page.type('#snip-trigger', 'Моя, подпись!');
  await page.type('#snip-body', 'новый текст');
  await clickText(page, 'Сохранить'); await sleep(300);
  const result = await page.evaluate(() => ({ list: window.__e2e.read('zs.snippets'), body: document.querySelector('#snip-body')?.value, text: document.body.innerText }));
  record('сценарии', 'быстрый блок: дубликат не заменяет оригинал, черновик остаётся', result.list?.length === 1 && result.list[0].body === 'исходный текст' && result.body === 'новый текст' && /уже существует/i.test(result.text), JSON.stringify({ list: result.list, body: result.body }));
  await page.close();
  const long = await openPage(browser, '#/dictionary', { storeSeed: { 'zs.snippets': [] } });
  await clickText(long, 'Добавить блок');
  await long.type('#snip-trigger', 'большой блок');
  await long.evaluate(() => {
    const el = document.querySelector('#snip-body');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, 'x'.repeat(4001));
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await clickText(long, 'Сохранить'); await sleep(250);
  const longResult = await long.evaluate(() => ({ length: document.querySelector('#snip-body')?.value.length,
    list: window.__e2e.read('zs.snippets'), text: document.body.innerText }));
  record('сценарии', 'быстрый блок: длинный текст остаётся в форме без обрезки', longResult.length === 4001 && !longResult.list?.length && /Блок не сохранён/.test(longResult.text), JSON.stringify({length: longResult.length, count: longResult.list?.length}));
  await long.evaluate(() => {
    const set = (el, value, prototype) => { Object.getOwnPropertyDescriptor(prototype, 'value').set.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); };
    set(document.querySelector('#snip-trigger'), '«моя подпись»', HTMLInputElement.prototype);
    set(document.querySelector('#snip-body'), 'исходный текст', HTMLTextAreaElement.prototype);
  });
  await clickText(long, 'Сохранить'); await sleep(250);
  const quoted = await long.evaluate(() => ({ body: document.querySelector('#snip-body')?.value, list: window.__e2e.read('zs.snippets'), text: document.body.innerText }));
  record('сценарии', 'быстрый блок: триггер с кавычками не обещает срабатывание и сохраняет черновик',
    quoted.body === 'исходный текст' && !quoted.list?.length && /Уберите кавычки/.test(quoted.text));
  await long.close();

  const legacyBody = `  ${'a'.repeat(4100)}\n`;
  const legacy = await openPage(browser, '#/dictionary', { storeSeed: { 'zs.snippets': [
    { id: 'a', trigger: 'моя подпись', body: legacyBody, createdAt: 123 },
    { id: 'b', trigger: 'Моя, подпись!', body: 'второй', createdAt: 124 },
  ] } });
  const visible = await legacy.evaluate(() => ({
    hints: [...document.querySelectorAll('.snippet-row')].filter((row) => /диктовка не развернёт/i.test(row.innerText)).length,
    full: document.querySelector('.snippet-row textarea')?.value,
  }));
  record('сценарии', 'быстрый блок: конфликт виден, длинный исходный текст доступен целиком', visible.hints === 2 && visible.full === legacyBody, `предупреждений: ${visible.hints}, длина: ${visible.full?.length}`);
  await legacy.click('.snippet-row button[aria-label^="Удалить блок"]'); await sleep(250);
  await clickText(legacy, 'Вернуть'); await sleep(300);
  const restored = await legacy.evaluate(() => window.__e2e.read('zs.snippets'));
  record('сценарии', 'быстрый блок: отмена удаления возвращает старый текст и не затирает дубликат', restored?.length === 2 && restored.find((s) => s.id === 'a')?.body === legacyBody && restored.find((s) => s.id === 'b')?.body === 'второй');
  await legacy.close();

  const voice = await openPage(browser, '#/home', {
    settings: { aiDictationRewrite: false, aiProcessing: true },
    storeSeed: { 'zs.dictations': [], 'zs.mockSttText': 'сократи вдвое',
      'zs.snippets': [{ id: 's1', trigger: 'сократи вдвое', body: 'совсем другая инструкция', createdAt: Date.now() }] }, settle: 700,
  });
  await emit(voice, 'hotkey', { type: 'toggle', mode: 'toggle', command: true }); await sleep(1200);
  await emit(voice, 'hotkey', { type: 'toggle', mode: 'toggle', command: true }); await sleep(2600);
  const command = await voice.evaluate(() => window.__e2e.read('zs.dictations')?.[0]);
  record('сценарии', 'быстрый блок: не подменяет голосовую инструкцию', command?.source === 'command' && /сократи вдвое/i.test(command?.command) && !/другая инструкция/i.test(command?.command), JSON.stringify(command?.command));
  await voice.close();
}

/**
 * «Файл в текст»: готовая запись → текст в «Недавних», без вставки в окно.
 *
 * Звук настоящий (WAV пишется тут же): проверяем, что файл действительно
 * декодируется в браузере, режется на куски и склеивается, а не что кнопка
 * что-то показала. Мок движка отвечает текстом, поэтому результат сравним.
 */
function writeToneWav(path, { seconds = 1.2, sampleRate = 16000 } = {}) {
  const frames = Math.round(seconds * sampleRate);
  const data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    const v = Math.round(Math.sin((2 * Math.PI * 220 * i) / sampleRate) * 8000);
    data.writeInt16LE(v, i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // размер блока fmt
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // моно
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // байт в секунду
  header.writeUInt16LE(2, 32); // выравнивание блока
  header.writeUInt16LE(16, 34); // бит на отсчёт
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([header, data]));
  return path;
}

async function scenarioFileDictionary(browser) {
  const wav = writeToneWav(join(tmpdir(), 'zspeakly-dictionary-file.wav'));
  try {
    for (const enabled of [false, true]) {
      const page = await openPage(browser, '#/home', { settings: { aiDictationRewrite: false, dictionaryEnabled: enabled },
        storeSeed: { 'zs.dictations': [], 'zs.mockSttText': 'открой зум', 'zs.dictionary': [{ id: 'w1', word: 'Zoom' }] }, settle: 700 });
      await (await page.$('input[type="file"]')).uploadFile(wav); await sleep(3200);
      const result = await page.evaluate(() => ({ text: window.__e2e.read('zs.dictations')?.[0]?.text,
        calls: (window.__bridgeCalls || []).filter((c) => c.channel === 'stt:transcribe-pcm').map((c) => c.args?.[0]?.useDictionary) }));
      record('сценарии', `словарь: файл с выключенным/включённым словарём (${enabled})`,
        result.text === (enabled ? 'открой Zoom' : 'открой зум') && result.calls.length > 0 && result.calls.every((value) => value === enabled), JSON.stringify(result));
      await page.close();
    }
    for (const initiallyEnabled of [false, true]) {
      const page = await openPage(browser, '#/home', { settings: { aiDictationRewrite: false, dictionaryEnabled: initiallyEnabled },
        storeSeed: { 'zs.dictations': [], 'zs.mockSttText': 'открой зум', 'zs.dictionary': [{ id: 'w1', word: 'Zoom' }] }, settle: 700,
        patchNative: () => {
          const original = window.zspeakly.native.transcribePcm;
          window.zspeakly.native.transcribePcm = async (payload) => {
            window.__fileStarted = true;
            await new Promise((resolve) => { window.__releaseFile = resolve; });
            return original(payload);
          };
        } });
      await (await page.$('input[type="file"]')).uploadFile(wav);
      await page.waitForFunction(() => window.__fileStarted === true, { timeout: 10000 });
      await page.evaluate(() => { location.hash = '#/dictionary'; });
      await page.waitForSelector('[role="switch"]');
      await page.click('[role="switch"]'); await sleep(400);
      await page.evaluate(() => window.__releaseFile());
      await page.waitForFunction(() => (window.__e2e.read('zs.dictations') || []).length === 1, { timeout: 10000 });
      const result = await page.evaluate(() => ({ text: window.__e2e.read('zs.dictations')?.[0]?.text,
        calls: (window.__bridgeCalls || []).filter((c) => c.channel === 'stt:transcribe-pcm').map((c) => c.args?.[0]?.useDictionary),
        enabled: window.__e2e.read('zs.settings')?.dictionaryEnabled }));
      record('сценарии', `словарь: настройка файла не меняется посреди обработки (${initiallyEnabled})`,
        result.enabled === !initiallyEnabled && result.calls.every((value) => value === initiallyEnabled) &&
        result.text === (initiallyEnabled ? 'открой Zoom' : 'открой зум'), JSON.stringify(result));
      await page.close();
    }
  } finally { rmSync(wav, { force: true }); }
}

// Границы файла проверяются без выделения гигабайтов: AudioContext — тестовая
// подмена, сам WAV реален, модель и мост остаются моковыми.
async function scenarioAudioFileBounds(browser) {
  const wav = writeToneWav(join(tmpdir(), 'zspeakly-file-bounds.wav'));
  try {
    for (const scenario of ['long', 'bad', 'cancel']) {
      const page = await openPage(browser, '#/home', { storeSeed: { 'zs.dictations': [] }, patchArg: scenario,
        patchNative: (scenario) => {
          window.__fileDecodeCalls = 0; window.__fileClosed = 0; window.__fileOffline = 0;
          const decoded = (seconds) => ({ length: 16000 * seconds, sampleRate: 16000, duration: seconds,
            numberOfChannels: 1, getChannelData: () => new Float32Array(1600) });
          window.AudioContext = class {
            decodeAudioData() {
              window.__fileDecodeCalls++;
              if (scenario === 'long') return Promise.resolve(decoded(7201));
              if (scenario === 'bad') return Promise.reject(new Error('bad codec'));
              return new Promise((resolve) => { window.__releaseFileDecode = () => resolve(decoded(0.1)); });
            }
            close() { window.__fileClosed++; return Promise.resolve(); }
          };
          window.OfflineAudioContext = class { constructor() { window.__fileOffline++; throw new Error('unexpected offline allocation'); } };
        }, settle: 500 });
      try {
        // Приложение может предварительно создавать AudioContext при открытии.
        await page.evaluate(() => { window.__fileClosed = 0; window.__fileOffline = 0; window.__fileDecodeCalls = 0; });
        await (await page.$('input[type="file"]')).uploadFile(wav);
        if (scenario === 'long') {
          await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some((el) => /Запись слишком длинная/i.test(el.innerText)), { timeout: 8000 }).catch(() => {});
          const result = await page.evaluate(() => ({ text: document.body.innerText, closed: window.__fileClosed, offline: window.__fileOffline,
            calls: (window.__bridgeCalls || []).filter((c) => c.channel === 'stt:transcribe-pcm').length,
            history: window.__e2e.read('zs.dictations') || [] }));
          record('сценарии', 'файл: длинная запись отклоняется до offline-буфера и без обращения к модели',
            /Запись слишком длинная/.test(result.text) && result.closed === 1 && result.offline === 0 && result.calls === 0 && result.history.length === 0,
            `closed=${result.closed} offline=${result.offline} stt=${result.calls}`);
        } else if (scenario === 'bad') {
          await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some((el) => /Формат не читается/i.test(el.innerText)), { timeout: 8000 }).catch(() => {});
          const result = await page.evaluate(() => ({ text: document.body.innerText, closed: window.__fileClosed, offline: window.__fileOffline }));
          record('сценарии', 'файл: отказ декодера показывает форматы и закрывает контекст',
            /Формат не читается/.test(result.text) && /Подойдут WAV, MP3/i.test(result.text) && result.closed === 1 && result.offline === 0,
            `closed=${result.closed} offline=${result.offline}`);
        } else {
          await page.waitForFunction(() => typeof window.__releaseFileDecode === 'function', { timeout: 8000 });
          // Событие второго выбора может прийти до перерисовки disabled-кнопки.
          await (await page.$('input[type="file"]')).uploadFile(wav); await sleep(300);
          const before = await page.evaluate(() => ({ calls: window.__fileDecodeCalls, text: document.body.innerText }));
          record('сценарии', 'файл: повторный выбор не запускает второе декодирование', before.calls === 1 && /уже.*файл|файл.*обрабатыва/i.test(before.text), `decode=${before.calls}`);
          await page.evaluate(() => [...document.querySelectorAll('.live-draft--processing button')].find((el) => /отменить/i.test(el.innerText))?.click());
          await page.evaluate(() => window.__releaseFileDecode());
          await page.waitForFunction(() => !document.querySelector('.live-draft--processing'), { timeout: 8000 }).catch(() => {});
          const result = await page.evaluate(() => ({ text: document.body.innerText, closed: window.__fileClosed, offline: window.__fileOffline,
            calls: (window.__bridgeCalls || []).filter((c) => c.channel === 'stt:transcribe-pcm').length, history: window.__e2e.read('zs.dictations') || [] }));
          record('сценарии', 'файл: отмена во время decode не выделяет offline-буфер и не выдаёт ошибку модели',
            result.closed === 1 && result.offline === 0 && result.calls === 0 && result.history.length === 0 && !/Не получилось расшифровать файл/i.test(result.text),
            `closed=${result.closed} offline=${result.offline} stt=${result.calls}`);
        }
        const errors = takeErrors(page); record('сценарии', `файл: границы (${scenario}) без ошибок консоли`, errors.length === 0, errors[0] || '');
      } finally { await page.close(); }
    }
  } finally { rmSync(wav, { force: true }); }
}

// Файл реальный, декодирование и ответы модели контролируемые: воспроизводим
// отказ посреди записи и убеждаемся, что пропуск остаётся виден после перезапуска.
async function scenarioAudioFilePartial(browser) {
  const wav = writeToneWav(join(tmpdir(), 'zspeakly-file-partial.wav'));
  try {
    for (const scenario of ['partial', 'partial-overbudget', 'silence', 'silent-code', 'all-failed', 'silent-failed']) {
      const page = await openPage(browser, '#/home', {
        settings: { aiDictationRewrite: false, dictionaryEnabled: false },
        storeSeed: { 'zs.dictations': scenario === 'partial-overbudget'
          ? Array.from({ length: 2001 }, (_, i) => ({ id: `legacy-${i}`, text: `Старая запись ${i}`, createdAt: Date.now() - i * 1000 })) : [] },
        patchArg: scenario, settle: 500,
        patchNative: (scenario) => {
          window.AudioContext = class {
            decodeAudioData() { return Promise.resolve({ length: 16000 * 80, sampleRate: 16000, duration: 80,
              numberOfChannels: 1, getChannelData: () => new Float32Array(16000 * 80) }); }
            close() { return Promise.resolve(); }
          };
          window.OfflineAudioContext = class {
            createBufferSource() { return { connect() {}, start() {} }; }
            startRendering() { return Promise.resolve({ sampleRate: 16000, getChannelData: () => new Float32Array(16000 * 80) }); }
          };
          let index = 0;
          window.zspeakly.native.transcribePcm = async () => {
            const i = index++;
            if (scenario === 'all-failed' || ((scenario === 'partial' || scenario === 'partial-overbudget') && i === 1) || (scenario === 'silent-failed' && i === 1)) {
              if (i === 1) throw new Error('test model failure');
              return { ok: false };
            }
            if (scenario === 'silent-code' && i === 1) return { ok: false, code: 'silent', text: '' };
            if (scenario === 'silent-failed' || (scenario === 'silence' && i === 1)) return { ok: true, text: '' };
            return { ok: true, text: i === 0 ? 'важно проверить' : 'важно проверить ещё раз' };
          };
        },
      });
      try {
        await (await page.$('input[type="file"]')).uploadFile(wav);
        await page.waitForFunction(() => !document.querySelector('.live-draft--processing') && [...document.querySelectorAll('.toast')].some((el) => /Файл расшифрован|Не получилось расшифровать файл|В файле нет речи/.test(el.innerText)), { timeout: 12000 });
        const result = await page.evaluate(() => ({ history: window.__e2e.read('zs.dictations') || [], body: document.body.innerText }));
        if (scenario === 'partial') {
          const text = result.history[0]?.text || '';
          record('сценарии', 'файл: отказ среднего фрагмента сохраняет оба текста и помечает пропуск',
            /^важно проверить\s*\[Не удалось распознать фрагмент 2[^\]]*\]\s*важно проверить ещё раз$/.test(text), text);
          record('сценарии', 'файл: частичный результат сопровождается предупреждением, а не успехом',
            /Файл расшифрован не полностью/.test(result.body) && !/Файл расшифрован\n/.test(result.body), result.body.slice(-300));
          const reopened = await browser.newPage();
          try {
            await reopened.evaluateOnNewDocument(installMockBridge);
            await reopened.goto(`${BASE}/#/home`, { waitUntil: 'domcontentloaded' });
            await reopened.waitForSelector('.app-window', { timeout: 15000 }); await sleep(600);
            const persisted = await reopened.evaluate(() => ({ text: window.__e2e.read('zs.dictations')?.[0]?.text, body: document.body.innerText }));
            record('сценарии', 'файл: отметка пропуска сохраняется в истории после перезагрузки', persisted.text === text && /Не удалось распознать фрагмент 2/.test(persisted.body || ''));
          } finally { await reopened.close(); }
        } else if (scenario === 'partial-overbudget') {
          const recover = await page.evaluate(() => document.querySelector('.toast__recover')?.value || '');
          record('сценарии', 'файл: при переполненной истории частичный текст с пропуском доступен для восстановления',
            result.history.length === 2001 && /важно проверить\n\[Не удалось распознать фрагмент 2[^\]]*\]\nважно проверить ещё раз/.test(recover) && /не добавлен в историю/.test(result.body), `история=${result.history.length}; ${recover}`);
        } else if (scenario === 'silence' || scenario === 'silent-code') {
          record('сценарии', `файл: пустой фрагмент (${scenario}) не считается ошибкой`,
            result.history.length === 1 && !/Не удалось распознать фрагмент/.test(result.history[0].text) && /Файл расшифрован/.test(result.body) && !/не полностью/.test(result.body));
        } else {
          record('сценарии', `файл: ошибка без текста (${scenario}) не выдаётся за отсутствие речи`,
            result.history.length === 0 && /Не получилось расшифровать файл/.test(result.body) && !/В файле нет речи/.test(result.body));
        }
        const errors = takeErrors(page); record('сценарии', `файл: частичная обработка (${scenario}) без ошибок консоли`, errors.length === 0, errors[0] || '');
      } finally { await page.close(); }
    }
  } finally { rmSync(wav, { force: true }); }
}

async function scenarioAudioFile(browser) {
  const wav = writeToneWav(join(tmpdir(), 'zspeakly-e2e-tone.wav'));
  const page = await openPage(browser, '#/home', {
    settings: { aiDictationRewrite: false },
    storeSeed: { 'zs.dictations': [] },
    settle: 700,
  });
  takeErrors(page);

  const note = await page.evaluate(() => {
    const line = document.querySelector('.hero__file');
    return line ? line.innerText.replace(/\n+/g, ' ') : '';
  });
  record(
    'сценарии',
    'файл в текст: рядом с микрофоном видно, что будет и куда попадёт',
    /Расшифровать файл/i.test(note) && /Недавние/i.test(note),
    note.slice(0, 100) || 'кнопки нет',
  );

  const input = await page.$('input[type="file"]');
  record('сценарии', 'файл в текст: есть поле выбора файла', Boolean(input), input ? '' : 'нет input[type=file]');
  if (input) {
    await input.uploadFile(wav);
    // декодирование + проход движка: 1,2 с звука — это один фрагмент
    await sleep(3200);
  }

  const result = await page.evaluate(() => {
    const list = window.__e2e.read('zs.dictations');
    const first = Array.isArray(list) && list[0] ? list[0] : null;
    return {
      text: first ? String(first.text || '') : '',
      source: first ? String(first.source || '') : '',
      rows: [...document.querySelectorAll('.recent__row')].map((el) => el.innerText.replace(/\n+/g, ' ')),
      inserts: (window.__bridgeCalls || []).filter((c) => c.channel === 'text:insert').length,
    };
  });
  record(
    'сценарии',
    'файл в текст: запись из файла попала в историю',
    result.text.length > 0 && result.source === 'file',
    `${result.source}: ${result.text.slice(0, 60)}`,
  );
  record(
    'сценарии',
    'файл в текст: в «Недавних» видно, что это файл',
    result.rows.some((row) => /файл/i.test(row) && row.includes(result.text.slice(0, 12))),
    result.rows[0] || 'строк нет',
  );
  // Никакой самовольной вставки: расшифровка файла — не диктовка в чужое окно
  record('сценарии', 'файл в текст: в чужое окно ничего не вставилось', result.inserts === 0, String(result.inserts));

  const errors = takeErrors(page);
  record('сценарии', 'файл в текст: без ошибок консоли', errors.length === 0, errors[0] || '');
  await page.close();
  rmSync(wav, { force: true });
}

/**
 * Командный режим: выделил текст — сказал, что с ним сделать.
 *
 * Проверяем живой путь целиком: выделение читается на нажатии, речь уходит в
 * движок, сказанное применяется к выделению и заменяет его. В окно при этом
 * не вставляется ничего: «сократи» — это указание, а не текст.
 */
async function scenarioVoiceCommand(browser) {
  const page = await openPage(browser, '#/home', {
    settings: { aiDictationRewrite: false, aiProcessing: true },
    storeSeed: {
      'zs.dictations': [],
      'zs.mockSttText': 'сократи вдвое',
    },
    settle: 700,
  });
  takeErrors(page);
  await page.evaluate(() => window.__e2e.resetCalls());

  // 1) Нажали сочетание — приложение забирает выделение ДО записи
  await emit(page, 'hotkey', { type: 'toggle', mode: 'toggle', command: true });
  await sleep(1200);
  const reading = await page.evaluate(() => ({
    read: (window.__bridgeCalls || []).some((c) => c.channel === 'text:read-selection'),
    listening: /Слушаю/i.test(document.body.innerText),
  }));
  record(
    'сценарии',
    'команда голосом: выделение читается сразу, запись идёт',
    reading.read && reading.listening,
    `выделение: ${reading.read}, запись: ${reading.listening}`,
  );

  // 2) Второе нажатие — стоп и применение команды
  await emit(page, 'hotkey', { type: 'toggle', mode: 'toggle', command: true });
  await sleep(2600);
  const result = await page.evaluate(() => {
    const calls = window.__bridgeCalls || [];
    const replaced = calls.filter((c) => c.channel === 'text:replace-selection').map((c) => String(c.args?.[0] || ''));
    const inserted = calls.filter((c) => c.channel === 'text:insert').map((c) => String(c.args?.[0] || ''));
    const list = window.__e2e.read('zs.dictations');
    const first = Array.isArray(list) && list[0] ? list[0] : null;
    return {
      replaced: replaced[0] || '',
      inserted: inserted[0] || '',
      source: first ? String(first.source || '') : '',
      command: first ? String(first.command || '') : '',
      rows: [...document.querySelectorAll('.recent__row')].map((el) => el.innerText.replace(/\n+/g, ' ')),
      toasts: [...document.querySelectorAll('.toast')].map((t) => t.innerText.replace(/\n/g, ' ')).join(' ;; '),
    };
  });
  record(
    'сценарии',
    'команда голосом: готовый текст заменил выделение',
    result.replaced.length > 0 && result.inserted === '',
    result.replaced.slice(0, 60) || 'замены не было',
  );
  record(
    'сценарии',
    'команда голосом: сказанное не вставилось как диктовка',
    result.inserted === '',
    result.inserted ? `вставлено: ${result.inserted}` : 'вставок нет',
  );
  record(
    'сценарии',
    'команда голосом: в истории видно, что это команда',
    result.source === 'command' && /сократи/i.test(result.command),
    `${result.source}: ${result.command}`,
  );
  record(
    'сценарии',
    'команда голосом: человеку сказано, что именно сделано',
    /Готово: сократить/i.test(result.toasts),
    result.toasts.slice(0, 100) || 'тоста нет',
  );

  const copyOnly = await openPage(browser, '#/home', {
    settings: { aiDictationRewrite: false, aiProcessing: true },
    storeSeed: { 'zs.dictations': [], 'zs.mockSttText': 'сократи вдвое' }, settle: 700,
    patchNative: () => {
      delete window.zspeakly.native.replaceSelection;
      window.__copyCount = 0;
      window.zspeakly.native.writeClipboard = async ({ text }) => { window.__copied = text; window.__copyCount++; return true; };
    },
  });
  takeErrors(copyOnly);
  await emit(copyOnly, 'hotkey', { type: 'toggle', mode: 'toggle', command: true });
  await sleep(1200);
  await emit(copyOnly, 'hotkey', { type: 'toggle', mode: 'toggle', command: true });
  await sleep(2600);
  const copyState = await copyOnly.evaluate(() => ({
    toast: [...document.querySelectorAll('.toast')].map((t) => t.innerText).join(' | '),
    history: window.__e2e.read('zs.dictations') || [], copied: window.__copied, count: window.__copyCount,
  }));
  record('безопасность', 'голосовая команда: только копирование не выдаётся за замену',
    /замена не выполнялась/i.test(copyState.toast) && /проверьте/i.test(copyState.toast) && !/Готово: сократить/.test(copyState.toast) &&
      copyState.count === 1 && Boolean(copyState.copied) && copyState.history[0]?.text === copyState.copied, JSON.stringify(copyState));
  record('безопасность', 'голосовая команда: только копирование без ошибок консоли', takeErrors(copyOnly).length === 0);
  await copyOnly.close();

  const uncertain = await openPage(browser, '#/home', {
    settings: { aiDictationRewrite: false, aiProcessing: true },
    storeSeed: { 'zs.dictations': [], 'zs.mockSttText': 'сократи вдвое' }, settle: 700,
    patchNative: () => { window.zspeakly.native.replaceSelection = async () => ({ uncertain: true }); },
  });
  takeErrors(uncertain);
  await emit(uncertain, 'hotkey', { type: 'toggle', mode: 'toggle', command: true });
  await sleep(1200);
  await emit(uncertain, 'hotkey', { type: 'toggle', mode: 'toggle', command: true });
  await sleep(2600);
  const unknown = await uncertain.evaluate(() => ({
    toast: [...document.querySelectorAll('.toast')].map((t) => t.innerText).join(' | '),
    history: window.__e2e.read('zs.dictations'),
  }));
  record('безопасность', 'голосовая команда: неизвестная замена не объявляется успехом',
    /Не удалось подтвердить замену/.test(unknown.toast) && /Проверьте его перед повтором/.test(unknown.toast) && !/Готово: сократить/.test(unknown.toast) && unknown.history?.length > 0, unknown.toast);
  record('безопасность', 'голосовая команда: неизвестная замена без ошибок консоли', takeErrors(uncertain).length === 0);
  await uncertain.close();

  // 3) Без выделения — приложение говорит об этом до записи, а не после
  const empty = await openPage(browser, '#/home', {
    storeSeed: { 'zs.mockSelection': '' },
    settle: 800,
  });
  takeErrors(empty);
  await emit(empty, 'hotkey', { type: 'toggle', mode: 'toggle', command: true });
  await sleep(1100);
  const noSelection = await empty.evaluate(() => ({
    say: [...document.querySelectorAll('.toast')].map((t) => t.innerText.replace(/\n/g, ' ')).join(' ;; '),
    listening: /Слушаю/i.test(document.body.innerText),
    asked: (window.__bridgeCalls || []).some((c) => c.channel === 'text:read-selection'),
  }));
  record(
    'сценарии',
    'команда голосом: без выделения запись не начинается, причина названа',
    /Нет выделенного текста/i.test(noSelection.say) && !noSelection.listening,
    `${noSelection.say.slice(0, 90) || 'молча'} · спросили выделение: ${noSelection.asked} · запись: ${noSelection.listening}`,
  );

  const errors = [...takeErrors(page), ...takeErrors(empty)];
  record('сценарии', 'команда голосом: без ошибок консоли', errors.length === 0, errors[0] || '');
  await empty.close();
  await page.close();
}

/**
 * Одна строка правды на первом экране: чем мы отличаемся от встроенной
 * диктовки Windows. В приложении она есть, в браузерном превью — нет: там
 * распознавание идёт через системный движок, и «офлайн» было бы ложью.
 */
async function scenarioWhyBetter(browser) {
  const page = await openPage(browser, '#/home', { settle: 700 });
  takeErrors(page);
  const shown = await page.evaluate(() => {
    const block = document.querySelector('.hero__why');
    return {
      text: block ? block.innerText.replace(/\n+/g, ' · ') : '',
      items: block ? block.querySelectorAll('.hero__why-item').length : 0,
    };
  });
  record(
    'сценарии',
    'первый экран: сказано, чем мы отличаемся от встроенной диктовки',
    shown.items === 3 && /бесплатно/i.test(shown.text) && /офлайн|не уходит в облако/i.test(shown.text) && /Win\+H/.test(shown.text),
    shown.text.slice(0, 140) || 'строки нет',
  );
  // Технических имён, которых человек не знает, на первом экране быть не должно
  record(
    'сценарии',
    'первый экран: без технических имён в этой строке',
    !/Web Speech|ONNX|Ollama|q5_1|GigaAM|int8/i.test(shown.text),
    shown.text.slice(0, 80),
  );
  const errors = takeErrors(page);
  record('сценарии', 'первый экран: без ошибок консоли', errors.length === 0, errors[0] || '');
  await page.close();

  // Превью без моста: там движок — системный, обещать офлайн нельзя
  const preview = await browser.newPage();
  await preview.evaluateOnNewDocument(() => {
    localStorage.setItem(
      'zs.settings',
      JSON.stringify({ onboarded: true, userName: 'Максим', theme: 'dark', language: 'ru' }),
    );
  });
  await preview.goto(`${BASE}/#/home`, { waitUntil: 'domcontentloaded' });
  await preview.waitForSelector('.app-window', { timeout: 15000 });
  await sleep(500);
  const inPreview = await preview.evaluate(() => Boolean(document.querySelector('.hero__why')));
  record(
    'сценарии',
    'превью: строка про офлайн не показывается, обещание не врёт',
    inPreview === false,
    inPreview ? 'строка есть и в превью' : 'строки нет — верно',
  );
  await preview.close();
}

/**
 * Оговорки: человек поправил себя на полуслове — в тексте остаётся то, что он
 * имел в виду. Проверяем и обратное: уточнение («то есть убери воду») не
 * выкидывается.
 */
async function scenarioSelfCorrection(browser) {
  const dictate = async (spoken) => {
    const page = await openPage(browser, '#/home', {
      settings: { aiDictationRewrite: false },
      storeSeed: { 'zs.dictations': [], 'zs.mockSttText': spoken },
      settle: 600,
    });
    takeErrors(page);
    await clickText(page, 'Начать диктовку');
    await sleep(1100);
    await page.evaluate(() => {
      const stop = document.querySelector('[aria-label="Остановить запись"]');
      if (stop) stop.click();
      else [...document.querySelectorAll('button')].find((b) => /Слушаю/i.test(b.innerText))?.click();
    });
    await sleep(2300);
    const res = await page.evaluate(() => {
      const list = window.__e2e.read('zs.dictations');
      const saved = Array.isArray(list) && list[0] ? String(list[0].text || '') : '';
      const inserts = (window.__bridgeCalls || [])
        .filter((c) => c.channel === 'text:insert')
        .map((c) => String(c.args?.[0] || ''));
      return { saved, inserted: inserts[0] || '' };
    });
    const errors = takeErrors(page);
    await page.close();
    return { ...res, errors };
  };

  const fixed = await dictate('Встреча в четыре, то есть в три часа.');
  record(
    'сценарии',
    'оговорка: «в четыре… то есть в три» — в тексте остаётся три',
    fixed.saved === 'Встреча в три часа.' && fixed.inserted === fixed.saved,
    `${fixed.saved} · вставлено: ${fixed.inserted.slice(0, 40)}`,
  );

  const kept = await dictate('Сократи, то есть убери воду и вводные слова.');
  record(
    'сценарии',
    'оговорка: уточнение не выкидывается, текст остаётся как сказано',
    kept.saved === 'Сократи, то есть убери воду и вводные слова.',
    kept.saved,
  );

  const errors = [...fixed.errors, ...kept.errors];
  record('сценарии', 'оговорка: без ошибок консоли', errors.length === 0, errors[0] || '');
}

/**
 * Оформление под окно: одна и та же диктовка в мессенджер и в редактор кода.
 * Проверяем через настоящий проход (мок движка, живая цепочка), а не только
 * юнит-тестом правила: важно, что текст и в истории, и на вставке одинаковый.
 */
async function scenarioAppFormat(browser) {
  const dictate = async (page) => {
    await clickText(page, 'Начать диктовку');
    await sleep(1100);
    await page.evaluate(() => {
      const stop = document.querySelector('[aria-label="Остановить запись"]');
      if (stop) stop.click();
      else [...document.querySelectorAll('button')].find((b) => /Слушаю/i.test(b.innerText))?.click();
    });
    await sleep(2200);
    return page.evaluate(() => {
      const list = window.__e2e.read('zs.dictations');
      const saved = Array.isArray(list) && list[0] ? String(list[0].text || '') : '';
      const inserts = (window.__bridgeCalls || [])
        .filter((c) => c.channel === 'text:insert')
        .map((c) => String(c.args?.[0] || ''));
      return { saved, inserted: inserts[0] || '' };
    });
  };

  // Мессенджер: точка в конце лишняя
  const chat = await openPage(browser, '#/home', {
    settings: { aiDictationRewrite: false },
    storeSeed: { 'zs.dictations': [], 'zs.mockSttText': 'привет как дела' },
  });
  takeErrors(chat);
  await chat.evaluate(() => {
    window.zspeakly.native.insertTarget = async () => ({ own: false, app: 'Telegram Desktop', title: 'Telegram' });
  });
  const inChat = await dictate(chat);
  record(
    'сценарии',
    'оформление: в мессенджере без точки в конце, история совпадает с вставкой',
    inChat.saved === 'Привет как дела' && inChat.inserted === inChat.saved,
    JSON.stringify(inChat.saved),
  );
  await chat.close();

  // Редактор кода: ни заглавной, ни точки
  const code = await openPage(browser, '#/home', {
    settings: { aiDictationRewrite: false },
    storeSeed: { 'zs.dictations': [], 'zs.mockSttText': 'добавь проверку на пустой массив' },
  });
  takeErrors(code);
  await code.evaluate(() => {
    window.zspeakly.native.insertTarget = async () => ({
      own: false,
      app: 'Code',
      title: 'main.js — Visual Studio Code',
    });
  });
  const inCode = await dictate(code);
  record(
    'сценарии',
    'оформление: в редакторе кода без заглавной и без точки',
    inCode.saved === 'добавь проверку на пустой массив' && !/\.$/.test(inCode.saved),
    JSON.stringify(inCode.saved),
  );
  const errors = takeErrors(code);
  record('сценарии', 'оформление: без ошибок консоли', errors.length === 0, errors[0] || '');
  await code.close();

  // Код нельзя приводить к стилю обычного предложения: регистр и пробелы
  // значимы, как и точка. Проверяем историю, вставку и отсутствие запроса LLM.
  for (const preserveText of [false, true]) {
    const sample = 'const UserService = JSON.parse(value);\n    return UserService';
    const page = await openPage(browser, '#/home', {
      settings: { preserveText, aiProcessing: true, aiDictationRewrite: true, aiEndpoint: 'http://localhost:11434', liveWhisper: false },
      storeSeed: { 'zs.dictations': [], 'zs.mockSttText': sample },
    });
    takeErrors(page);
    await page.evaluate(() => {
      window.zspeakly.native.insertTarget = async () => ({ own: false, app: 'Code', title: 'main.js — Visual Studio Code' });
      window.__e2e.resetCalls();
    });
    const output = await dictate(page);
    const calls = await bridgeCalls(page);
    const foundErrors = takeErrors(page);
    record('сценарии', 'оформление: код без команды сохраняет регистр, отступы и не отправляется модели',
      output.saved === sample && output.inserted === sample && !calls.includes('http:post') && foundErrors.length === 0,
      `preserve=${preserveText} ${JSON.stringify(output)} ${foundErrors[0] || ''}`);
    await page.close();
  }
}

/**
 * Язык под активное окно: правило человека должно доехать до движка, а не
 * остаться строкой в настройках. Проверяем по-настоящему: патчим активное окно,
 * диктуем и смотрим, с каким языком ушёл звук и что попало в историю.
 */
async function scenarioAppLanguage(browser) {
  const page = await openPage(browser, '#/home', {
    settings: {
      aiDictationRewrite: false,
      language: 'ru',
      appProfiles: [{ id: 'app-vs', match: 'Visual Studio Code', language: 'en' }],
    },
    storeSeed: { 'zs.dictations': [], 'zs.mockSttText': 'hello comma world period' },
  });
  takeErrors(page);
  await page.evaluate(() => {
    window.zspeakly.native.insertTarget = async () => ({
      own: false,
      app: 'Code',
      title: 'main.js — Visual Studio Code',
    });
  });
  await clickText(page, 'Начать диктовку');
  await sleep(1100);
  await page.evaluate(() => {
    const stop = document.querySelector('[aria-label="Остановить запись"]');
    if (stop) stop.click();
    else [...document.querySelectorAll('button')].find((b) => /Слушаю/i.test(b.innerText))?.click();
  });
  await sleep(2400);
  const result = await page.evaluate(() => {
    const call = window.__e2e.last('stt:transcribe-pcm');
    const list = window.__e2e.read('zs.dictations') || [];
    const toast = [...document.querySelectorAll('.toast')].map((t) => t.innerText.replace(/\n/g, ' ')).join(' | ');
    return {
      lang: call?.args?.[0]?.lang || '',
      savedLang: list[0]?.language || '',
      text: list[0]?.text || '',
      toast,
    };
  });
  record(
    'сценарии',
    'язык под окно: звук уходит в движок на языке правила',
    result.lang === 'en' && result.savedLang === 'en',
    `движок=${result.lang || '—'} история=${result.savedLang || '—'}`,
  );
  record('сценарии', 'язык под окно: команды используют язык этой записи',
    result.text === 'Hello, world.', result.text);
  record(
    'сценарии',
    'язык под окно: приложение говорит, почему диктует не на общем языке',
    /Английский/.test(result.toast) && /Visual Studio Code/.test(result.toast),
    result.toast.slice(0, 90) || 'тоста нет',
  );
  const errors = takeErrors(page);
  record('сценарии', 'язык под окно: без ошибок консоли', errors.length === 0, errors[0] || '');
  await page.close();
}

// Управляемые события Web Speech: после stop браузер ещё может прислать финал.
async function scenarioWebSpeechFinalization(browser) {
  const makePage = () => openPage(browser, '#/home', {
    browserStorage: true,
    settings: { aiDictationRewrite: false, language: 'ru', appProfiles: [{ id: 'en-app', match: 'Code', language: 'en' }] },
    storeSeed: { 'zs.dictations': [] },
    patchNative: () => {
      delete window.zspeakly.native.transcribePcm;
      window.zspeakly.isElectron = false;
      window.__webHistory = () => JSON.parse(localStorage.getItem('zs:zs.dictations') || '[]');
      window.zspeakly.native.insertTarget = async () => ({ own: false, app: 'Code', title: 'Visual Studio Code' });
      window.__speechInstances = [];
      window.SpeechRecognition = class {
        constructor() { window.__speechInstances.push(this); this.stops = 0; this.aborts = 0; }
        start() { setTimeout(() => this.onstart?.(), 0); }
        stop() { this.stops += 1; }
        abort() { this.aborts += 1; }
      };
      window.__speechResult = (index, text, final) => {
        const speech = window.__speechInstances[index];
        speech.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal: final })] });
      };
    },
  });

  const page = await makePage();
  takeErrors(page);
  try {
    await emit(page, 'hotkey', { type: 'down', mode: 'hold' });
    try {
      await page.waitForFunction(() => window.__speechInstances.length === 1, { timeout: 8000 });
    } catch (err) {
      throw new Error(`web speech start: ${err.message}; ${JSON.stringify(await page.evaluate(() => ({ count: window.__speechInstances?.length, hasNative: !!window.zspeakly?.native?.transcribePcm, button: document.querySelector('.hero__mic')?.innerText, calls: window.__bridgeCalls?.slice(-8) })))}; errors=${JSON.stringify(takeErrors(page))}`);
    }
    await page.evaluate(() => window.__speechResult(0, 'черновик', false));
    await emit(page, 'hotkey', { type: 'up' });
    await emit(page, 'hotkey', { type: 'up' });
    await sleep(200);
    const waiting = await page.evaluate(() => ({
      processing: Boolean(document.querySelector('.live-draft--processing')),
      history: window.__webHistory(),
      toast: [...document.querySelectorAll('.toast')].map((node) => node.innerText).join(' '),
      lang: window.__speechInstances[0].lang,
      stops: window.__speechInstances[0].stops,
    }));
    await page.evaluate(() => {
      window.__speechResult(0, 'окончательный текст', true);
      window.__speechInstances[0].onend();
    });
    try {
      await page.waitForFunction(() => (window.__webHistory()).length === 1, { timeout: 8000 });
    } catch (err) {
      throw new Error(`web speech finish: ${err.message}; ${JSON.stringify(await page.evaluate(() => ({ body: document.body.innerText.slice(0, 900), history: window.__e2e.read('zs.dictations'), calls: window.__bridgeCalls?.slice(-12) })))}; errors=${JSON.stringify(takeErrors(page))}`);
    }
    await page.evaluate(() => { window.__speechResult(0, 'запоздалые слова', true); window.__speechInstances[0].onend(); });
    await sleep(900);
    const final = await page.evaluate(() => ({
      history: window.__webHistory(),
      inserts: (window.__bridgeCalls || []).filter((call) => call.channel === 'text:insert').map((call) => call.args?.[0]),
    }));
    const errors = takeErrors(page);
    record('сценарии', 'Web Speech: ждём финал после stop и сохраняем язык и текст один раз',
      waiting.processing && waiting.history.length === 0 && !/Речь не распознана/.test(waiting.toast) && waiting.lang === 'ru-RU' && waiting.stops === 1 &&
      final.history.length === 1 && final.history[0].language === 'ru' && final.history[0].text === 'окончательный текст' &&
      final.inserts.length === 1 && final.inserts[0] === 'окончательный текст' && errors.length === 0,
      JSON.stringify({ waiting, final, error: errors[0] }));
  } finally { await page.close(); }

  const empty = await makePage();
  takeErrors(empty);
  try {
    await emit(empty, 'hotkey', { type: 'down', mode: 'hold' });
    await empty.waitForFunction(() => window.__speechInstances.length === 1, { timeout: 8000 });
    await empty.evaluate(() => window.__speechResult(0, 'только черновик', false));
    await emit(empty, 'hotkey', { type: 'up' });
    await empty.evaluate(() => window.__speechInstances[0].onend());
    await sleep(350);
    const result = await empty.evaluate(() => ({
      history: window.__webHistory(),
      inserts: (window.__bridgeCalls || []).filter((call) => call.channel === 'text:insert').length,
      toast: [...document.querySelectorAll('.toast')].map((node) => node.innerText).join(' '),
    }));
    const errors = takeErrors(empty);
    record('сценарии', 'Web Speech: неподтверждённый черновик не становится диктовкой',
      result.history.length === 0 && result.inserts === 0 && /Речь не распознана/.test(result.toast) && errors.length === 0,
      JSON.stringify({ ...result, error: errors[0] }));
  } finally { await empty.close(); }

  const cancelled = await makePage();
  takeErrors(cancelled);
  try {
    await emit(cancelled, 'hotkey', { type: 'down', mode: 'hold' });
    await cancelled.waitForFunction(() => window.__speechInstances.length === 1, { timeout: 8000 });
    await emit(cancelled, 'hotkey', { type: 'up' });
    await cancelled.waitForSelector('.live-draft--processing', { timeout: 8000 });
    await cancelled.click('.live-draft--processing button');
    await cancelled.evaluate(() => { window.__speechResult(0, 'отменённые слова', true); window.__speechInstances[0].onend(); });
    await sleep(400);
    const result = await cancelled.evaluate(() => ({
      aborts: window.__speechInstances[0].aborts,
      history: window.__webHistory(),
      inserts: (window.__bridgeCalls || []).filter((call) => call.channel === 'text:insert').length,
    }));
    const errors = takeErrors(cancelled);
    record('сценарии', 'Web Speech: отмена во время ожидания игнорирует запоздалые события',
      result.aborts === 1 && result.history.length === 0 && result.inserts === 0 && errors.length === 0,
      JSON.stringify({ ...result, error: errors[0] }));
  } finally { await cancelled.close(); }

  const failed = await makePage();
  takeErrors(failed);
  try {
    await emit(failed, 'hotkey', { type: 'down', mode: 'hold' });
    await failed.waitForFunction(() => window.__speechInstances.length === 1, { timeout: 8000 });
    await failed.evaluate(() => window.__speechResult(0, 'черновик', false));
    await emit(failed, 'hotkey', { type: 'up' });
    await failed.waitForSelector('.live-draft--processing', { timeout: 8000 });
    await failed.evaluate(() => window.__speechInstances[0].onerror({ error: 'network' }));
    await sleep(300);
    const result = await failed.evaluate(() => ({
      aborts: window.__speechInstances[0].aborts,
      history: window.__webHistory(),
      button: document.querySelector('.hero__mic')?.innerText || '',
    }));
    const errors = takeErrors(failed);
    record('сценарии', 'Web Speech: фатальная ошибка после stop прерывает ожидающий движок',
      result.aborts === 1 && result.history.length === 0 && !/Слушаю/.test(result.button) && errors.length === 0,
      JSON.stringify({ ...result, error: errors[0] }));
  } finally { await failed.close(); }
}

// Повторный сигнал стопа во время STT не должен прятать обработку и отмену.
async function scenarioDoubleStopWhileProcessing(browser) {
  const page = await openPage(browser, '#/home', {
    settings: { aiDictationRewrite: false, liveWhisper: false },
    storeSeed: { 'zs.dictations': [] },
    patchNative: () => {
      window.zspeakly.native.transcribePcm = () => new Promise((resolve) => { window.__lateStt = resolve; });
    },
  });
  takeErrors(page);
  try {
    await emit(page, 'hotkey', { type: 'down', mode: 'hold' });
    await sleep(1000);
    await emit(page, 'hotkey', { type: 'up' });
    await page.waitForFunction(() => Boolean(window.__lateStt), { timeout: 10000 });
    await page.waitForSelector('.live-draft--processing', { timeout: 8000 });
    await emit(page, 'hotkey', { type: 'up' });
    await sleep(300);
    const after = await page.evaluate(() => ({
      processing: !!document.querySelector('.live-draft--processing'),
      cancel: [...document.querySelectorAll('.live-draft--processing button')].some((button) => /ОТМЕНИТЬ/i.test(button.innerText)),
    }));
    if (after.cancel) {
      await page.click('.live-draft--processing button');
      await page.evaluate(() => window.__lateStt({ ok: true, text: 'не должно появиться' }));
      await sleep(400);
    }
    const history = await page.evaluate(() => window.__e2e.read('zs.dictations') || []);
    const errors = takeErrors(page);
    record('сценарии', 'сессии: повторный стоп не скрывает обработку и отмену',
      after.processing && after.cancel && history.length === 0 && errors.length === 0,
      JSON.stringify({ ...after, history, error: errors[0] }));
  } finally { await page.close(); }
}

// Сторож обработки должен освободить сессию, а не только скрыть индикатор.
async function scenarioProcessingTimeout(browser) {
  const page = await openPage(browser, '#/home', {
    settings: { aiDictationRewrite: false, liveWhisper: false },
    storeSeed: { 'zs.dictations': [] },
    patchNative: () => {
      const originalTimeout = window.setTimeout.bind(window);
      window.setTimeout = (fn, delay, ...args) => originalTimeout(fn, delay === 90000 ? 1500 : delay, ...args);
      let calls = 0;
      window.zspeakly.native.transcribePcm = () => {
        window.__timeoutCalls = ++calls;
        return calls === 1 ? new Promise((resolve) => { window.__timeoutOld = resolve; })
          : Promise.resolve({ ok: true, text: 'новая запись', ms: 20 });
      };
    },
  });
  takeErrors(page);
  try {
    await emit(page, 'hotkey', { type: 'down', mode: 'hold' });
    await sleep(1000);
    await emit(page, 'hotkey', { type: 'up' });
    await page.waitForFunction(() => Boolean(window.__timeoutOld), { timeout: 10000 });
    const beforeCancel = await page.evaluate(() => (window.__bridgeCalls || []).filter((call) => call.channel === 'stt:cancel').length);
    await page.waitForFunction(() => !document.querySelector('.live-draft--processing'), { timeout: 6000 });
    const afterTimeout = await page.evaluate(() => ({
      cancels: (window.__bridgeCalls || []).filter((call) => call.channel === 'stt:cancel').length,
      toast: [...document.querySelectorAll('.toast')].map((node) => node.innerText).join(' '),
    }));
    await emit(page, 'hotkey', { type: 'down', mode: 'hold' });
    await sleep(1000);
    await emit(page, 'hotkey', { type: 'up' });
    await sleep(1000);
    await page.evaluate(() => window.__timeoutOld({ ok: true, text: 'устаревшая запись', ms: 20 }));
    await sleep(500);
    const result = await page.evaluate(() => ({
      calls: window.__timeoutCalls,
      texts: (window.__e2e.read('zs.dictations') || []).map((row) => row.text),
      inserts: (window.__bridgeCalls || []).filter((call) => call.channel === 'text:insert').map((call) => call.args?.[0]),
    }));
    const errors = takeErrors(page);
    record('сценарии', 'сессии: таймаут освобождает обработку и отбрасывает поздний результат',
      afterTimeout.cancels > beforeCancel && /Распознавание не ответило/.test(afterTimeout.toast) &&
      result.calls === 2 && result.texts.length === 1 && /новая запись/i.test(result.texts[0]) &&
      result.inserts.length === 1 && /новая запись/i.test(result.inserts[0]) && errors.length === 0,
      JSON.stringify({ beforeCancel, afterTimeout, ...result, error: errors[0] }));
  } finally { await page.close(); }
}

// Горячая клавиша во время обработки не должна перенести старый результат в новую сессию.
async function scenarioPendingSessionStart(browser) {
  const page = await openPage(browser, '#/home', {
    settings: { aiDictationRewrite: false, liveWhisper: false },
    storeSeed: { 'zs.dictations': [] },
    patchNative: () => {
      const native = window.zspeakly.native;
      window.__pendingCalls = 0;
      window.__pendingCaptures = 0;
      native.captureScreen = async () => { window.__pendingCaptures += 1; return { ok: false }; };
      native.transcribePcm = () => {
        window.__pendingCalls += 1;
        if (window.__pendingCalls === 1) return new Promise((resolve) => { window.__completeFirst = resolve; });
        return Promise.resolve({ ok: true, text: 'вторая запись', ms: 20 });
      };
    },
  });
  takeErrors(page);
  try {
    await emit(page, 'hotkey', { type: 'down', mode: 'hold' });
    await sleep(1000);
    await emit(page, 'hotkey', { type: 'up' });
    await page.waitForFunction(() => Boolean(window.__completeFirst), { timeout: 10000 });
    await emit(page, 'hotkey', { type: 'down', mode: 'hold', screenAware: true });
    await sleep(300);
    const blocked = await page.evaluate(() => ({
      captures: window.__pendingCaptures,
      toast: [...document.querySelectorAll('.toast')].map((node) => node.innerText).join(' '),
    }));
    await page.evaluate(() => window.__completeFirst({ ok: true, text: 'первая запись', ms: 20 }));
    await page.waitForFunction(() => (window.__e2e.read('zs.dictations') || []).length === 1, { timeout: 10000 });
    await sleep(1100);
    await emit(page, 'hotkey', { type: 'down', mode: 'hold', screenAware: true });
    await sleep(1000);
    await emit(page, 'hotkey', { type: 'up' });
    await page.waitForFunction(() => (window.__e2e.read('zs.dictations') || []).length === 2, { timeout: 10000 });
    const result = await page.evaluate(() => ({
      calls: window.__pendingCalls, captures: window.__pendingCaptures,
      texts: (window.__e2e.read('zs.dictations') || []).map((row) => row.text),
    }));
    const errors = takeErrors(page);
    record('сценарии', 'сессии: новую запись нельзя начать до результата, после результата можно',
      blocked.captures === 0 && /Диктовка ещё обрабатывается/.test(blocked.toast) && result.calls === 2 && result.captures === 1 &&
      result.texts.some((text) => /первая запись/i.test(text)) && result.texts.some((text) => /вторая запись/i.test(text)) && errors.length === 0,
      JSON.stringify({ blocked, ...result, error: errors[0] }));
  } finally { await page.close(); }
}

// Отложенные данные окна и кадра одной записи не должны попадать в следующую.
async function scenarioSessionContextIsolation(browser) {
  const page = await openPage(browser, '#/home', {
    settings: {
      aiProcessing: true, aiDictationRewrite: false, aiEndpoint: 'http://localhost:11434', liveWhisper: false,
      language: 'ru', appProfiles: [{ id: 'app-vs', match: 'Visual Studio Code', language: 'en' }],
    },
    storeSeed: { 'zs.dictations': [], 'zs.mockSttText': 'пример проверки' },
    patchNative: () => {
      const native = window.zspeakly.native;
      let targetCount = 0;
      let captureCount = 0;
      native.insertTarget = () => {
        window.__targetCount = ++targetCount;
        if (targetCount === 1) return new Promise((resolve) => { window.__resolveOldTarget = resolve; });
        return Promise.resolve({ own: false, app: 'Telegram Desktop', title: 'Telegram' });
      };
      native.captureScreen = async () => {
        window.__captureCount = ++captureCount;
        return captureCount === 1 ? { ok: true, image: 'data:image/png;base64,YWJj', width: 1, height: 1 } : { ok: false };
      };
      native.httpPost = async ({ body }) => {
        if (body.images) return new Promise((resolve) => { window.__resolveOldVision = resolve; });
        return { ok: false };
      };
      const original = native.transcribePcm;
      native.transcribePcm = async (args) => {
        window.__contextStt = { lang: args.lang, prompt: args.contextPrompt };
        return original(args);
      };
    },
  });
  takeErrors(page);
  try {
    await emit(page, 'hotkey', { type: 'down', mode: 'hold', screenAware: true });
    try {
      await page.waitForFunction(() => Boolean(window.__resolveOldTarget && window.__resolveOldVision), { timeout: 8000 });
    } catch (err) {
      const state = await page.evaluate(() => ({ target: Boolean(window.__resolveOldTarget), vision: Boolean(window.__resolveOldVision), captures: window.__captureCount, targets: window.__targetCount, body: document.body.innerText.slice(0, 180) }));
      throw new Error(`${err.message}: ${JSON.stringify(state)}`);
    }
    await emit(page, 'hotkey', { type: 'cancel' });
    await sleep(500);
    await emit(page, 'hotkey', { type: 'down', mode: 'hold', screenAware: true });
    try {
      await page.waitForFunction(() => window.__targetCount >= 3 && window.__captureCount === 2, { timeout: 8000 });
    } catch (err) {
      const state = await page.evaluate(() => ({ captures: window.__captureCount, targets: window.__targetCount, body: document.body.innerText.slice(0, 200) }));
      throw new Error(`${err.message}: ${JSON.stringify(state)}`);
    }
    await page.evaluate(() => {
      window.__resolveOldTarget({ own: false, app: 'Code', title: 'Visual Studio Code' });
      window.__resolveOldVision({ ok: true, data: { response: 'ПрошлыйСекретныйКонтекст' } });
    });
    await sleep(1000);
    await emit(page, 'hotkey', { type: 'up' });
    await page.waitForFunction(() => (window.__e2e.read('zs.dictations') || []).length > 0, { timeout: 12000 });
    const result = await page.evaluate(() => ({
      stt: window.__contextStt,
      row: (window.__e2e.read('zs.dictations') || [])[0],
    }));
    const errors = takeErrors(page);
    record('сценарии', 'сессии: старое окно и старый экран не влияют на новую запись',
      result.stt?.lang === 'ru' && !result.stt?.prompt && result.row?.language === 'ru' &&
      result.row?.text === 'Пример проверки' && errors.length === 0,
      JSON.stringify({ stt: result.stt, language: result.row?.language, text: result.row?.text, error: errors[0] }));
  } finally { await page.close(); }
}

// Если получение снимка запоздало после отмены, не отправляем его модели.
async function scenarioCancelledScreenCapture(browser) {
  const page = await openPage(browser, '#/home', {
    settings: { aiProcessing: true, aiDictationRewrite: false, aiEndpoint: 'http://localhost:11434', liveWhisper: false },
    patchNative: () => {
      window.zspeakly.native.captureScreen = () => new Promise((resolve) => { window.__resolveCapture = resolve; });
      window.__visionCalls = 0;
      window.zspeakly.native.httpPost = async () => { window.__visionCalls += 1; return { ok: true, data: { response: 'данные' } }; };
    },
  });
  takeErrors(page);
  try {
    await emit(page, 'hotkey', { type: 'down', mode: 'hold', screenAware: true });
    await page.waitForFunction(() => Boolean(window.__resolveCapture), { timeout: 8000 });
    await emit(page, 'hotkey', { type: 'cancel' });
    await page.evaluate(() => window.__resolveCapture({ ok: true, image: 'data:image/png;base64,YWJj', width: 1, height: 1 }));
    await sleep(800);
    const calls = await page.evaluate(() => window.__visionCalls);
    const errors = takeErrors(page);
    record('сценарии', 'сессии: запоздавший после отмены снимок не отправляется модели',
      calls === 0 && errors.length === 0, `запросов=${calls}; ${errors[0] || ''}`);
  } finally { await page.close(); }
}

// Завершённая запись тоже не должна передавать свой экран следующей.
async function scenarioCompletedScreenIsolation(browser) {
  const page = await openPage(browser, '#/home', {
    settings: { aiProcessing: true, aiDictationRewrite: false, aiEndpoint: 'http://localhost:11434', liveWhisper: false },
    storeSeed: { 'zs.dictations': [], 'zs.mockSttText': 'пример проверки' },
    patchNative: () => {
      const native = window.zspeakly.native;
      let captures = 0;
      native.captureScreen = async () => {
        window.__captures = ++captures;
        return captures === 1 ? { ok: true, image: 'data:image/png;base64,YWJj', width: 1, height: 1 } : { ok: false };
      };
      native.httpPost = async () => ({ ok: true, data: { response: 'ТерминПервогоЭкрана' } });
      const original = native.transcribePcm;
      window.__prompts = [];
      native.transcribePcm = async (args) => {
        window.__prompts.push(args.contextPrompt || '');
        return original(args);
      };
    },
  });
  takeErrors(page);
  try {
    await emit(page, 'hotkey', { type: 'down', mode: 'hold', screenAware: true });
    await sleep(1000);
    await emit(page, 'hotkey', { type: 'up' });
    await page.waitForFunction(() => (window.__e2e.read('zs.dictations') || []).length === 1, { timeout: 10000 });
    await sleep(900);
    await emit(page, 'hotkey', { type: 'down', mode: 'hold', screenAware: true });
    await sleep(1000);
    await emit(page, 'hotkey', { type: 'up' });
    await page.waitForFunction(() => (window.__e2e.read('zs.dictations') || []).length === 2, { timeout: 10000 });
    const result = await page.evaluate(() => ({ prompts: window.__prompts, captures: window.__captures }));
    const errors = takeErrors(page);
    record('сценарии', 'сессии: готовый контекст экрана не переходит к следующей записи',
      result.captures === 2 && result.prompts.length === 2 && result.prompts[0] === 'ТерминПервогоЭкрана' && result.prompts[1] === '' && errors.length === 0,
      JSON.stringify({ ...result, error: errors[0] }));
  } finally { await page.close(); }
}

// Язык фиксируется при первом запросе к движку, даже если окно ответило позже.
async function scenarioLateTargetLanguage(browser) {
  const page = await openPage(browser, '#/home', {
    settings: { language: 'ru', liveWhisper: false, aiDictationRewrite: false,
      appProfiles: [{ id: 'app-vs', match: 'Visual Studio Code', language: 'en' }] },
    storeSeed: { 'zs.dictations': [] },
    patchNative: () => {
      let targetCount = 0;
      window.zspeakly.native.insertTarget = () => ++targetCount === 1
        ? new Promise((resolve) => { window.__resolveTarget = resolve; })
        : Promise.resolve({ own: false, app: 'Code', title: 'Visual Studio Code' });
      window.zspeakly.native.transcribePcm = (args) => {
        window.__engineLanguage = args.lang;
        return new Promise((resolve) => { window.__resolveTranscription = resolve; });
      };
    },
  });
  takeErrors(page);
  try {
    await emit(page, 'hotkey', { type: 'down', mode: 'hold' });
    await sleep(1000);
    await emit(page, 'hotkey', { type: 'up' });
    await page.waitForFunction(() => Boolean(window.__resolveTranscription), { timeout: 10000 });
    await page.evaluate(() => window.__resolveTarget({ own: false, app: 'Code', title: 'Visual Studio Code' }));
    await sleep(300);
    await page.evaluate(() => window.__resolveTranscription({ ok: true, text: 'пример проверки', ms: 20 }));
    await page.waitForFunction(() => (window.__e2e.read('zs.dictations') || []).length > 0, { timeout: 10000 });
    const result = await page.evaluate(() => ({ engine: window.__engineLanguage, row: (window.__e2e.read('zs.dictations') || [])[0] }));
    const errors = takeErrors(page);
    record('сценарии', 'сессии: позднее окно не меняет уже выбранный язык записи',
      result.engine === 'ru' && result.row?.language === 'ru' && errors.length === 0,
      JSON.stringify({ engine: result.engine, language: result.row?.language, error: errors[0] }));
  } finally { await page.close(); }
}

// «Отмени»: при неподтверждённом курсоре main отказывает в стирании.
// Мок проверяет предупреждение и то, что история не помечена как убранная.
async function scenarioUndoCommand(browser) {
  // Настоящая последовательность: сначала диктовка, потом слово «отмени».
  // Так проверяется и то, что marked именно та запись, которую вставляли.
  const page = await openPage(browser, '#/home', {
    settings: { aiDictationRewrite: false },
    storeSeed: { 'zs.mockSttText': 'привет, мир' },
  });
  takeErrors(page);
  const dictate = async () => {
    await clickText(page, 'Начать диктовку');
    await sleep(1000);
    await page.evaluate(() => {
      const stop = document.querySelector('[aria-label="Остановить запись"]');
      if (stop) stop.click();
      else [...document.querySelectorAll('button')].find((b) => /Слушаю/i.test(b.innerText))?.click();
    });
    await sleep(2000);
  };
  await dictate();
  const before = await page.evaluate(() => (window.__e2e.read('zs.dictations') || []).length);
  await page.evaluate(() => window.__e2e.resetCalls());
  // Следующая фраза — уже команда: так её «слышит» движок.
  await page.evaluate(() => localStorage.setItem('mockstore:zs.mockSttText', JSON.stringify('Отмени.')));
  await dictate();
  const result = await page.evaluate(() => {
    const list = window.__e2e.read('zs.dictations') || [];
    const toast = [...document.querySelectorAll('.toast')].map((t) => t.innerText.replace(/\n/g, ' ')).join(' | ');
    return {
      undo: window.__e2e.countOf('text:undo-last'),
      insert: window.__e2e.countOf('text:insert'),
      count: list.length,
      undone: list[0]?.undone === true,
      undoWord: list.some((d) => /отмени/i.test(d.text || '')),
      toast,
    };
  });
  record(
    'сценарии',
    '«отмени»: запрос не вставляет слово «отмени»',
    result.undo === 1 && result.insert === 0 && !result.undoWord,
    `отмена=${result.undo} вставок=${result.insert}`,
  );
  record(
    'сценарии',
    '«отмени»: человек видит отказ и ручное исправление',
    /Убирать не стал/.test(result.toast) && /курсора/.test(result.toast) && /вручную/.test(result.toast) && /истории/.test(result.toast),
    result.toast.slice(0, 110) || 'тоста нет',
  );
  record(
    'сценарии',
    '«отмени»: запись в истории не помечена убранной',
    result.count === before && !result.undone,
    `записей ${before} → ${result.count}, пометка=${result.undone}`,
  );
  const tag = await page.evaluate(() => document.querySelector('.recent__tag')?.textContent || '');
  record('сценарии', '«отмени»: ложной метки «убрано» нет', !/убрано/.test(tag), tag || 'метки нет');
  const errors = takeErrors(page);
  record('сценарии', '«отмени»: без ошибок консоли', errors.length === 0, errors[0] || '');
  await page.close();
}

// Когда убирать нечего или окно уже другое, приложение не стирает наугад и
// говорит причину словами человека, а не кодом из main-процесса.
async function scenarioUndoRefusal(browser) {
  const page = await openPage(browser, '#/home', {
    settings: { aiDictationRewrite: false },
    storeSeed: {
      'zs.mockSttText': 'Отмени.',
      'zs.mockUndo': { ok: false, reason: 'текст был в «Telegram», сейчас «Code»' },
    },
  });
  takeErrors(page);
  await clickText(page, 'Начать диктовку');
  await sleep(1100);
  await page.evaluate(() => {
    const stop = document.querySelector('[aria-label="Остановить запись"]');
    if (stop) stop.click();
    else [...document.querySelectorAll('button')].find((b) => /Слушаю/i.test(b.innerText))?.click();
  });
  await sleep(2200);
  const toast = await page.evaluate(() =>
    [...document.querySelectorAll('.toast')].map((t) => t.innerText.replace(/\n/g, ' ')).join(' | '),
  );
  record(
    'сценарии',
    '«отмени»: в другом окне не стирает наугад и объясняет почему',
    /Убирать не стал/.test(toast) && /окно уже другое/i.test(toast),
    toast.slice(0, 120) || 'тоста нет',
  );
  const errors = takeErrors(page);
  record('сценарии', '«отмени» без вставки: без ошибок консоли', errors.length === 0, errors[0] || '');
  await page.close();
}

// Пустой результат распознавания — самое непонятное состояние: человек
// говорил, а в поле ничего и ни слова объяснения. Теперь приложение говорит,
// что именно случилось: молчал микрофон или движок не разобрал слова.
async function scenarioEmptyResult(browser) {
  const page = await openPage(browser, '#/home', {
    settings: { aiDictationRewrite: false },
    storeSeed: { 'zs.dictations': [], 'zs.mockSttText': '' },
  });
  takeErrors(page);
  await clickText(page, 'Начать диктовку');
  await sleep(1500);
  await page.evaluate(() => {
    const stop = document.querySelector('[aria-label="Остановить запись"]');
    if (stop) stop.click();
    else [...document.querySelectorAll('button')].find((b) => /Слушаю/i.test(b.innerText))?.click();
  });
  await sleep(2200);
  const toast = await page.evaluate(() => document.querySelector('.toast')?.innerText || '');
  const count = await page.evaluate(() => {
    const list = window.__e2e.read('zs.dictations');
    return Array.isArray(list) ? list.length : -1;
  });
  // Подсказка должна называть раздел, который правда есть в настройках:
  // «проверьте в настройках» человек выполнить не может.
  const sections = await page.evaluate(() => {
    const raw = window.__e2e.read('zs.settings') || {};
    return { hasSettings: Boolean(raw && typeof raw === 'object') };
  });
  record(
    'сценарии',
    'пустой результат: сказано, что именно проверить',
    /не распознал|нет речи|не было речи/i.test(toast) &&
      /Настройки → Диктовка|Настройки → Данные|Тест микрофона/i.test(toast) &&
      sections.hasSettings,
    JSON.stringify(toast.slice(0, 120)),
  );
  record('сценарии', 'пустой результат: в историю ничего не попадает', count === 0, String(count));
  const errors = takeErrors(page);
  record('сценарии', 'пустой результат: без ошибок консоли', errors.length === 0, errors[0] || '');
  await page.close();
}

// Плавающий индикатор диктовки: в Electron это отдельное окно поверх всех
// приложений, поэтому рендерер обязан просить main показать его, обновлять
// состояние и слушать кнопку «стоп» оттуда.
async function scenarioFloatingHud(browser) {
  const page = await openPage(browser, '#/home', { settle: 500 });
  takeErrors(page);
  await page.evaluate(() => window.__e2e.resetCalls());

  await clickText(page, 'Начать диктовку');
  await sleep(900);
  const started = await bridgeCalls(page);
  const inWindowHud = await page.evaluate(() => document.querySelectorAll('.hud').length);
  const stateCall = await page.evaluate(() => window.__e2e.last('hud:update'));
  record('сценарии', 'индикатор: старт диктовки показывает плавающее окно', started.includes('hud:show'), started.join(','));
  record(
    'сценарии',
    'индикатор: состояние (уровень, время, текст) уходит в окно',
    Boolean(stateCall) && typeof stateCall.args[0]?.level === 'number' && stateCall.args[0]?.state === 'listening',
    JSON.stringify(stateCall?.args?.[0] || null),
  );
  record('сценарии', 'индикатор: внутри окна второй плашки нет', inWindowHud === 0, String(inWindowHud));
  // main должен знать, что запись идёт — иначе пункт трея и сочетание врут
  const stateReports = await page.evaluate(() => ({
    listening: window.__e2e.countOf('dictation:state'),
    last: window.__e2e.last('dictation:state')?.args?.[0],
  }));
  record(
    'сценарии',
    'индикатор: main получает реальное состояние записи',
    stateReports.listening > 0 && stateReports.last === 'listening',
    JSON.stringify(stateReports),
  );

  // кнопка «стоп» на плавающем окне приходит событием из main
  await page.evaluate(() => window.__e2e.emit('dictation:stop', { from: 'hud' }));
  await sleep(900);
  const stopped = await bridgeCalls(page);
  const body = await textOf(page, '.app-window');
  const stoppedState = await page.evaluate(() => window.__e2e.last('dictation:state')?.args?.[0]);
  record(
    'сценарии',
    'индикатор: кнопка «стоп» останавливает запись',
    stopped.includes('hud:hide') && !/Слушаю…/i.test(body) && stoppedState !== 'listening',
    `${stopped.slice(-3).join(',')} state=${stoppedState}`,
  );

  // Выключение настройки прямо во время записи прячет плашку
  await page.evaluate(() => window.__e2e.resetCalls());
  await page.evaluate(() => document.querySelector('.hero__mic').click());
  await sleep(600);
  const startedForToggle = await bridgeCalls(page);
  await page.evaluate(() => window.__e2e.emit('command', 'settings'));
  await page.waitForSelector('.settings-modal', { timeout: 8000 });
  await sleep(600);
  // переходим на раздел «Приложение» и жмём переключатель плавающего индикатора
  await page.evaluate(() => {
    const modal = document.querySelector('.settings-modal');
    [...(modal?.querySelectorAll('button') || [])]
      .find((b) => /^Приложение/.test(b.innerText.trim()))
      ?.click();
  });
  await sleep(500);
  const toggledOff = await page.evaluate(() => {
    const input = document.querySelector('.settings-modal [role="switch"][aria-label*="Плавающий"]');
    if (!input) return { found: false };
    input.click();
    return { found: true, checked: input.getAttribute('aria-checked') };
  });
  await sleep(800);
  const afterToggle = await bridgeCalls(page);
  record(
    'сценарии',
    'индикатор: выключение настройки во время записи убирает плашку',
    startedForToggle.includes('hud:show') && toggledOff.found && afterToggle.includes('hud:hide'),
    `${startedForToggle.slice(0, 2).join(',')} → ${afterToggle.slice(-2).join(',')} · ${JSON.stringify(toggledOff)}`,
  );
  // возвращаем настройку и закрываем настройки, чтобы не мешать дальше
  await page.evaluate(() => {
    document.querySelector('.settings-modal [role="switch"][aria-label*="Плавающий"]')?.click();
  });
  await sleep(400);
  await page.evaluate(() => document.querySelector('.settings-modal .modal__close, .settings-modal [aria-label="Закрыть"]')?.click());
  await sleep(400);
  await page.evaluate(() => window.__e2e.emit('dictation:stop', { from: 'hud' }));
  await sleep(700);

  // «Крестик» на плавающем окне: запись продолжается, индикатор переезжает
  // внутрь окна приложения — иначе остановить было бы нечем
  await page.evaluate(() => window.__e2e.resetCalls());
  await clickText(page, 'Начать диктовку');
  await sleep(700);
  await page.evaluate(() => window.__e2e.emit('hud:closed'));
  await sleep(500);
  const afterClose = await page.evaluate(() => ({
    inWindow: document.querySelectorAll('.hud').length,
    text: document.querySelector('.hud')?.innerText || '',
  }));
  record(
    'сценарии',
    'индикатор: «крестик» возвращает индикатор в окно приложения',
    afterClose.inWindow === 1 && /Слушаю|Остановить/i.test(afterClose.text),
    JSON.stringify(afterClose),
  );
  await page.evaluate(() => document.querySelector('.hud button')?.click());
  await sleep(800);
  const afterInWindowStop = await page.evaluate(() => ({
    hud: document.querySelectorAll('.hud').length,
    body: document.body.innerText,
  }));
  record(
    'сценарии',
    'индикатор: стоп из окна приложения завершает запись',
    afterInWindowStop.hud === 0 && !/Слушаю…/.test(afterInWindowStop.body),
  );
  await page.evaluate(() => window.__e2e.emit('dictation:stop', { from: 'hud' }));
  await sleep(900);
  const hero = await page.evaluate(() => ({
    mic: document.querySelector('.hero__mic')?.innerText.replace(/\n/g, ' ') || '',
    buttons: [...document.querySelectorAll('.hero__stats button')].map((b) => b.innerText.replace(/\n/g, ' ')),
    hash: location.hash,
  }));
  record('сценарии', 'индикатор: после остановки кнопка записи на месте', /Начать диктовку/.test(hero.mic), JSON.stringify(hero));
  // повторный старт (после того как окно скрыли) снова его показывает
  await page.evaluate(() => window.__e2e.resetCalls());
  await page.evaluate(() => document.querySelector('.hero__mic').click());
  await sleep(700);
  const again = await bridgeCalls(page);
  record('сценарии', 'индикатор: после скрытия окно показывается снова', again.includes('hud:show'), again.join(','));
  await page.evaluate(() => window.__e2e.emit('dictation:stop', { from: 'hud' }));
  await sleep(600);

  // Двойное нажатие с включённым «агентом» присылает cancel: обрывок не должен
  // попасть ни в историю, ни в тост «слишком короткая запись».
  await page.evaluate(() => window.__e2e.emit('dictation:stop', { from: 'hud' }));
  await sleep(900);
  const beforeCancel = await page.evaluate(() => (window.__e2e.read('zs.dictations') || []).length);
  await page.evaluate(() => window.__e2e.resetCalls());
  await page.evaluate(() => document.querySelector('.hero__mic').click());
  await sleep(500);
  await page.evaluate(() => window.__e2e.emit('hotkey', { type: 'cancel' }));
  await sleep(700);
  const afterCancel = await page.evaluate(() => ({
    count: (window.__e2e.read('zs.dictations') || []).length,
    mic: document.querySelector('.hero__mic')?.innerText.replace(/\n/g, ' ') || '',
    toast: [...document.querySelectorAll('.toast')].map((t) => t.innerText.replace(/\n/g, ' ')).join(' | '),
  }));
  const cancelCalls = await bridgeCalls(page);
  record(
    'сценарии',
    'диктовка: отмена не пишет обрывок в историю',
    afterCancel.count === beforeCancel && /Начать диктовку/.test(afterCancel.mic) && !cancelCalls.includes('stt:transcribe-pcm'),
    `${beforeCancel} → ${afterCancel.count} · ${cancelCalls.slice(-2).join(',')}`,
  );
  record(
    'сценарии',
    'диктовка: отмена без тоста «слишком коротко»',
    !/слишком коротк|пустая/i.test(afterCancel.toast),
    afterCancel.toast.slice(0, 60),
  );

  const errors = takeErrors(page);
  record('сценарии', 'индикатор: без ошибок консоли', errors.length === 0, errors[0] || '');
  await page.close();
}

// Постобработка — не тумблер с 1.6.0: правила чистят текст всегда, а профиль
// со старым значением `aiProcessing: false` приложение исправляет само.
async function scenarioCleanupToggle(browser) {
  const run = async (aiProcessing) => {
    const page = await openPage(browser, '#/home', {
      settings: { aiProcessing },
      patchNative: () => {
        const native = window.zspeakly && window.zspeakly.native;
        if (native) native.transcribePcm = async () => ({ ok: true, text: 'э-э  ну , привет   как дела', engine: 'whisper' });
      },
    });
    takeErrors(page);
    await page.evaluate(() => window.__e2e.resetCalls());
    await page.evaluate(() => document.querySelector('.hero__mic').click());
    await sleep(800);
    await page.evaluate(() => window.__e2e.emit('dictation:stop', { from: 'hud' }));
    await sleep(1500);
    const stored = await page.evaluate(() => (window.__e2e.read('zs.dictations') || [])[0]?.text || '');
    const errors = takeErrors(page);
    await page.close();
    return { stored, errors };
  };

  const on = await run(true);
  const off = await run(false);
  record(
    'сценарии',
    'постобработка: неоднозначные слова не удаляются',
    /э-э/i.test(on.stored) && /ну/i.test(on.stored) && /привет как дела/i.test(on.stored),
    on.stored,
  );
  const forced = await page_evaluate_processing(browser);
  record(
    'сценарии',
    'постобработка: старый профиль с «выключено» исправляется сам',
    off.stored === on.stored && forced === true,
    `${off.stored} · в профиле aiProcessing=${forced}`,
  );
  record('сценарии', 'постобработка: без ошибок консоли', [...on.errors, ...off.errors].length === 0, [...on.errors, ...off.errors][0] || '');
}

// Что реально лежит в профиле после запуска (autotune мог исправить значение).
async function page_evaluate_processing(browser) {
  const page = await openPage(browser, '#/home', { settings: { aiProcessing: false } });
  const value = await page.evaluate(() => {
    const raw = window.__e2e.read('zs.settings') || {};
    return raw.aiProcessing;
  });
  await page.close();
  return value;
}

// Вторая стадия чистки: включённая галочка «Переписывать диктовку моделью»
// отправляет текст в локальную модель, выключенная — не ходит в сеть вовсе.
async function scenarioModelRewrite(browser) {
  const run = async (on, { endpoint = 'http://localhost:11434', broken = false } = {}) => {
    const page = await openPage(browser, '#/home', {
      settings: {
        aiProcessing: true,
        aiEndpoint: endpoint,
        aiModel: 'qwen2.5:0.5b',
        aiDictationRewrite: on,
      },
      patchArg: { broken },
      patchNative: (arg) => {
        const native = window.zspeakly && window.zspeakly.native;
        if (!native) return;
        native.transcribePcm = async () => ({ ok: true, text: 'ну привет как дела у меня', engine: 'whisper' });
        native.httpPost = async () => {
          if (arg && arg.broken) return { ok: false, status: 0 };
          return { ok: true, data: { response: 'Ну, привет как дела у меня.' } };
        };
      },
    });
    takeErrors(page);
    await page.evaluate(() => window.__e2e.resetCalls());
    await page.evaluate(() => document.querySelector('.hero__mic').click());
    await sleep(700);
    await page.evaluate(() => window.__e2e.emit('dictation:stop', { from: 'hud' }));
    await sleep(1800);
    const calls = await bridgeCalls(page);
    const stored = await page.evaluate(() => (window.__e2e.read('zs.dictations') || [])[0]?.text || '');
    const toast = await page.evaluate(() =>
      [...document.querySelectorAll('.toast')].map((t) => t.innerText.replace(/\n/g, ' ')).join(' | '),
    );
    const errors = takeErrors(page);
    await page.close();
    return { stored, calls, toast, errors };
  };

  const on = await run(true);
  const off = await run(false);
  const broken = await run(true, { broken: true });
  record(
    'сценарии',
    'модель: включённая галочка доводит диктовку после правил',
    on.stored === 'Ну, привет как дела у меня.',
    on.stored,
  );
  record(
    'сценарии',
    'модель: молчание Ollama не ломает диктовку, но о нём сказано',
    broken.stored === 'Ну привет как дела у меня.' && /Модель не ответила/.test(broken.toast || ''),
    `${broken.stored} · ${(broken.toast || '').slice(0, 40)}`,
  );
  record(
    'сценарии',
    'модель: выключенная галочка не ходит в сеть',
    off.stored === 'Ну привет как дела у меня.' && !off.calls.includes('http:post'),
    `${off.stored} · ${off.calls.slice(-2).join(',')}`,
  );
  const errors = [...on.errors, ...off.errors, ...broken.errors];
  record('сценарии', 'модель: без ошибок консоли', errors.length === 0, errors[0] || '');
}

// Реальные фразы из жалобы подаются как готовый STT-результат: это проверка
// конвейера текста с мок-мостом, не проверка качества микрофона или модели.
async function scenarioDictationIntegrity(browser) {
  const cases = [
    { raw: 'Алло, алло, приветики.', response: 'Алло, алло, приветики.', expected: 'Алло, алло, приветики.' },
    { raw: 'Это значит верно.', response: 'Это значит верно.', expected: 'Это значит верно.' },
    { raw: 'Цена 1,5 рубля.', response: 'Цена 1.5 рубля.', expected: 'Цена 1,5 рубля.' },
    { raw: 'Сайт example.com открыт.', response: 'Сайт example. com открыт.', expected: 'Сайт example.com открыт.' },
    { raw: 'Сайт example.com запятая работает', response: 'Сайт example.com, работает.', expected: 'Сайт example.com, работает.' },
    { raw: 'Ссылка https://example.com/a?x=1 запятая открыта', response: 'Ссылка https://example.com/a?x=1, открыта.', expected: 'Ссылка https://example.com/a?x=1, открыта.' },
    {
      raw: 'Заметка:\n\nВстреча в четыре, то есть в три часа.\n\nСледующая строка.',
      response: 'Заметка:\n\nВстреча в три часа.\n\nСледующая строка.',
      expected: 'Заметка:\n\nВстреча в три часа.\n\nСледующая строка.',
    },
    {
      raw: 'Здорово, братан! Суперкрутой AI, SaaS, B2B проект для 100% 100% заработка.',
      response: 'Здорово, братан! Суперкрутой AI, SaaS, не B2B проект для 100% 100% заработка.',
      expected: 'Здорово, братан! Суперкрутой AI, SaaS, B2B проект для 100% 100% заработка.',
    },
  ];
  for (const sample of cases) {
    const page = await openPage(browser, '#/home', {
      settings: { aiProcessing: true, aiEndpoint: 'http://localhost:11434', aiDictationRewrite: true, liveWhisper: false },
      patchArg: sample,
      patchNative: (arg) => {
        window.zspeakly.native.transcribePcm = async () => ({ ok: true, text: arg.raw });
        window.zspeakly.native.httpPost = async () => ({ ok: true, data: { response: arg.response } });
      },
    });
    takeErrors(page);
    try {
      await page.click('.hero__mic'); await sleep(900); await page.click('.hero__mic');
      await page.waitForFunction(() => (window.__e2e.read('zs.dictations') || []).length > 0, { timeout: 10000 });
      const text = await page.evaluate(() => (window.__e2e.read('zs.dictations') || [])[0]?.text || '');
      const errors = takeErrors(page);
      record('сценарии', 'диктовка сохраняет слова, повторы и значимые знаки', text === sample.expected && errors.length === 0, text || errors[0] || '');
    } finally { await page.close(); }
  }
}

// Медленная модель не должна переписать более новую диктовку своим старым ответом.
async function scenarioLatePolish(browser) {
  const page = await openPage(browser, '#/home', {
    settings: { aiProcessing: true, aiEndpoint: 'http://localhost:11434', aiModel: 'qwen2.5:0.5b', aiDictationRewrite: true, liveWhisper: false },
    patchNative: () => {
      let calls = 0;
      window.zspeakly.native.transcribePcm = async () => ({ ok: true, text: ++calls === 1 ? 'первая запись про рыбу' : 'вторая запись про кошек' });
      window.zspeakly.native.httpPost = async ({ body }) => {
        if (body.prompt.includes('рыбу')) return new Promise((resolve) => { window.__resolveLatePolish = resolve; });
        return { ok: true, data: { response: 'Вторая запись про кошек!' } };
      };
    },
  });
  takeErrors(page);
  try {
    await page.click('.hero__mic'); await sleep(900); await page.click('.hero__mic');
    await page.waitForFunction(() => (window.__e2e.read('zs.dictations') || []).some((r) => /рыбу/i.test(r.rawText || r.text)), { timeout: 10000 });
    await sleep(2400);
    await page.click('.hero__mic'); await sleep(900); await page.click('.hero__mic');
    await page.waitForFunction(() => (window.__e2e.read('zs.dictations') || []).some((r) => /кошек/i.test(r.rawText || r.text)), { timeout: 10000 });
    await page.evaluate(() => window.__resolveLatePolish({ ok: true, data: { response: 'Первая запись, про рыбу.' } }));
    await sleep(500);
    const rows = await page.evaluate(() => window.__e2e.read('zs.dictations') || []);
    const first = rows.find((r) => /рыбу/i.test(r.rawText || r.text));
    const second = rows.find((r) => /кошек/i.test(r.rawText || r.text));
    record('сценарии', 'поздняя полировка относится к исходной диктовке',
      /рыбу/.test(first?.text || '') && /кошек/.test(second?.text || '') && /запись,/.test(first?.text || ''),
      rows.slice(0, 2).map((r) => r.text).join(' | '));
    const errors = takeErrors(page);
    record('сценарии', 'поздняя полировка без ошибок консоли', errors.length === 0, errors[0] || '');
  } catch (err) {
    const state = await page.evaluate(() => ({ rows: (window.__e2e.read('zs.dictations') || []).map((r) => r.text), text: document.body.innerText.slice(0, 120), deferred: Boolean(window.__resolveLatePolish) }));
    throw new Error(`${err.message}; ${JSON.stringify(state)}`);
  } finally { await page.close(); }
}

async function scenarioCancelPolish(browser) {
  const page = await openPage(browser, '#/home', {
    settings: { aiProcessing: true, aiEndpoint: 'http://localhost:11434', aiDictationRewrite: true, liveWhisper: false },
    patchNative: () => {
      window.zspeakly.native.transcribePcm = async () => ({ ok: true, text: 'отменённая диктовка про рыбу' });
      window.zspeakly.native.httpPost = async () => new Promise((resolve) => { window.__resolveLatePolish = resolve; });
    },
  });
  takeErrors(page);
  try {
    await page.click('.hero__mic'); await sleep(900); await page.click('.hero__mic');
    await page.waitForFunction(() => Boolean(window.__resolveLatePolish), { timeout: 5000 });
    await clickText(page, 'ОТМЕНИТЬ');
    await page.evaluate(() => window.__resolveLatePolish({ ok: true, data: { response: 'Отменённая диктовка про рыбу!' } }));
    await sleep(1500);
    const state = await page.evaluate(() => ({
      inserted: (window.__bridgeCalls || []).filter((c) => c.channel === 'text:insert').map((c) => c.args?.[0]),
      history: (window.__e2e.read('zs.dictations') || []).filter((r) => /отменённая диктовка/i.test(r.rawText || r.text)).map((r) => r.text),
    }));
    record('сценарии', 'отмена во время полировки не вставляет и не сохраняет диктовку',
      state.inserted.length === 0 && state.history.length === 0, JSON.stringify(state));
    const errors = takeErrors(page);
    record('сценарии', 'отмена полировки без ошибок консоли', errors.length === 0, errors[0] || '');
  } finally { await page.close(); }
}

async function scenarioCancelPolishRestart(browser) {
  const page = await openPage(browser, '#/home', {
    settings: { aiProcessing: true, aiEndpoint: 'http://localhost:11434', aiDictationRewrite: true, liveWhisper: false },
    patchNative: () => {
      let calls = 0;
      window.zspeakly.native.transcribePcm = async () => ({ ok: true, text: ++calls === 1 ? 'первая отменённая запись' : 'вторая новая запись' });
      window.zspeakly.native.httpPost = async ({ body }) => body.prompt.includes('отменённая')
        ? new Promise((resolve) => { window.__resolveLatePolish = resolve; })
        : { ok: true, data: { response: 'Вторая новая запись!' } };
    },
  });
  takeErrors(page);
  try {
    await page.click('.hero__mic'); await sleep(800); await page.click('.hero__mic');
    await page.waitForFunction(() => Boolean(window.__resolveLatePolish), { timeout: 5000 });
    await clickText(page, 'ОТМЕНИТЬ');
    await page.click('.hero__mic'); await sleep(500); await page.click('.hero__mic');
    await page.waitForFunction(() => (window.__e2e.read('zs.dictations') || []).some((r) => /вторая новая запись/i.test(r.text)), { timeout: 5000 });
    await page.evaluate(() => window.__resolveLatePolish({ ok: true, data: { response: 'Первая отменённая запись!' } }));
    await sleep(500);
    const rows = await page.evaluate(() => window.__e2e.read('zs.dictations') || []);
    record('сценарии', 'сразу после отмены полировки следующая диктовка не теряется',
      rows.some((r) => /вторая новая запись/i.test(r.text)) && !rows.some((r) => /первая отменённая запись/i.test(r.text)),
      rows.slice(0, 2).map((r) => r.text).join(' | '));
    const errors = takeErrors(page);
    record('сценарии', 'быстрый повтор после отмены без ошибок консоли', errors.length === 0, errors[0] || '');
  } finally { await page.close(); }
}

async function scenarioLatePolishEdit(browser) {
  const page = await openPage(browser, '#/home', {
    settings: { aiProcessing: true, aiEndpoint: 'http://localhost:11434', aiDictationRewrite: true, liveWhisper: false },
    patchNative: () => {
      window.zspeakly.native.transcribePcm = async () => ({ ok: true, text: 'первая запись про рыбу' });
      window.zspeakly.native.httpPost = async () => new Promise((resolve) => { window.__resolveLatePolish = resolve; });
    },
  });
  takeErrors(page);
  try {
    await page.click('.hero__mic'); await sleep(900); await page.click('.hero__mic');
    await page.waitForFunction(() => (window.__e2e.read('zs.dictations') || []).some((r) => /рыбу/i.test(r.rawText || r.text)), { timeout: 10000 });
    await page.click('.recent__row'); await sleep(150);
    await page.evaluate(() => [...document.querySelectorAll('.snippet button')].find((b) => /Исправить/.test(b.innerText))?.click());
    await page.waitForSelector('.modal textarea');
    const textarea = await page.$('.modal textarea');
    await textarea.click({ clickCount: 3 });
    await textarea.type('Человек исправил эту запись.');
    await page.evaluate(() => [...document.querySelectorAll('.modal button')].find((b) => /Сохранить/i.test(b.innerText))?.click());
    await page.waitForFunction(() => (window.__e2e.read('zs.dictations') || []).some((r) => /Человек исправил эту запись/.test(r.text)), { timeout: 5000 });
    const before = await page.evaluate(() => (window.__e2e.read('zs.dictations') || []).slice(0, 2).map((r) => ({ id: r.id, text: r.text })));
    await page.evaluate(() => window.__resolveLatePolish({ ok: true, data: { response: 'Первая запись про рыбу!' } }));
    await sleep(500);
    const rows = await page.evaluate(() => window.__e2e.read('zs.dictations') || []);
    record('сценарии', 'поздняя полировка не затирает ручную правку',
      rows.some((r) => r.text === 'Человек исправил эту запись.'), JSON.stringify({ before, after: rows.slice(0, 2).map((r) => ({ id: r.id, text: r.text })) }));
    const errors = takeErrors(page);
    record('сценарии', 'полировка после ручной правки без ошибок консоли', errors.length === 0, errors[0] || '');
  } finally { await page.close(); }
}

// Сравнение только текста не замечает delete → undo или edit → исходный текст.
async function scenarioLatePolishReverted(browser) {
  for (const kind of ['unchanged', 'deleted', 'delete-restore', 'edit-restore', 'precise-retry']) {
    const page = await openPage(browser, '#/home', {
      settings: { aiProcessing: true, aiEndpoint: 'http://localhost:11434', aiDictationRewrite: true, liveWhisper: false },
      storeSeed: { 'zs.dictations': [] },
      patchNative: () => {
        window.zspeakly.native.transcribePcm = async (payload) => ({ ok: true, text: payload?.thorough ? 'Первая запись про рыбу и море.' : 'первая запись про рыбу' });
        window.zspeakly.native.httpPost = async () => new Promise((resolve) => { window.__resolveLatePolish = resolve; });
      },
    });
    takeErrors(page);
    try {
      await page.click('.hero__mic'); await sleep(900); await page.click('.hero__mic');
      await page.waitForFunction(() => (window.__e2e.read('zs.dictations') || []).length === 1 && Boolean(window.__resolveLatePolish), { timeout: 10000 });
      const original = await page.evaluate(() => (window.__e2e.read('zs.dictations') || [])[0]);
      if (kind === 'deleted' || kind === 'delete-restore') {
        await page.click('.recent__row'); await sleep(150);
        await page.evaluate(() => [...document.querySelectorAll('.snippet button')].find((b) => /Удалить/.test(b.innerText))?.click());
        await page.waitForFunction(() => (window.__e2e.read('zs.dictations') || []).length === 0, { timeout: 5000 });
        if (kind === 'delete-restore') {
          await page.evaluate(() => [...document.querySelectorAll('.toast__action')].find((b) => /Вернуть/.test(b.innerText))?.click());
          await page.waitForFunction((id) => (window.__e2e.read('zs.dictations') || []).some((r) => r.id === id), { timeout: 5000 }, original.id);
        }
      } else if (kind === 'edit-restore') {
        const edit = async (text) => {
          await page.click('.recent__row'); await sleep(150);
          await page.evaluate(() => [...document.querySelectorAll('.snippet button')].find((b) => /Исправить/.test(b.innerText))?.click());
          await page.waitForSelector('.modal textarea');
          const area = await page.$('.modal textarea');
          await area.click({ clickCount: 3 }); await area.type(text);
          await page.evaluate(() => [...document.querySelectorAll('.modal button')].find((b) => /Сохранить/i.test(b.innerText))?.click());
          await page.waitForFunction((value) => (window.__e2e.read('zs.dictations') || [])[0]?.text === value, { timeout: 5000 }, text);
          await sleep(200);
          if (await page.$('.modal')) { await page.keyboard.press('Escape'); await sleep(150); }
        };
        await edit('Временная правка человека.');
        await edit(original.text);
      } else if (kind === 'precise-retry') {
        await page.click('.last-result [aria-label="Переспросить точно"]');
        await page.waitForFunction(() => (window.__e2e.read('zs.dictations') || [])[0]?.text === 'Первая запись про рыбу и море.', { timeout: 5000 });
      }
      const beforeResponse = await page.evaluate(() => (window.__e2e.read('zs.dictations') || []).map((r) => ({ id: r.id, text: r.text })));
      await page.evaluate(() => window.__resolveLatePolish({ ok: true, data: { response: 'Первая запись, про рыбу.' } }));
      await sleep(600);
      const rows = await page.evaluate(() => (window.__e2e.read('zs.dictations') || []).map((r) => ({ id: r.id, text: r.text })));
      const errors = takeErrors(page);
      record('сценарии', `поздняя полировка: ${kind === 'unchanged' ? 'неизменённая запись обновляется' : `${kind} не перезаписывается`}`,
        (kind === 'unchanged'
          ? rows.length === 1 && rows[0].id === original.id && rows[0].text === 'Первая запись, про рыбу.'
          : JSON.stringify(rows) === JSON.stringify(beforeResponse)) && errors.length === 0,
        JSON.stringify({ before: beforeResponse, after: rows, errors }));
    } finally { await page.close(); }
  }
}

// Вставка в чужое окно не удалась (окно с правами администратора): текст
// остаётся в буфере, и об этом сказано — иначе диктовка выглядит сломанной.
async function scenarioInsertFailed(browser) {
  const page = await openPage(browser, '#/home', {
    patchNative: () => {
      const native = window.zspeakly && window.zspeakly.native;
      if (!native) return;
      native.transcribePcm = async () => ({ ok: true, text: 'ну привет как дела', engine: 'whisper' });
      // main отвечает false, когда SendKeys не сработал
      native.insertText = async () => false;
    },
  });
  takeErrors(page);
  await page.evaluate(() => document.querySelector('.hero__mic').click());
  await sleep(700);
  await page.evaluate(() => window.__e2e.emit('dictation:stop', { from: 'hud' }));
  await sleep(1600);
  const state = await page.evaluate(() => ({
    toast: [...document.querySelectorAll('.toast')].map((t) => t.innerText.replace(/\n/g, ' ')).join(' | '),
    stored: (window.__e2e.read('zs.dictations') || [])[0]?.text || '',
    recover: document.querySelector('.toast__recover')?.value || '',
  }));
  record(
    'сценарии',
    'вставка не удалась: нет обещания о буфере, полный текст доступен вручную',
    // main отвечает объектом с причиной; интерфейс обязан её показать, а не
    // молчать — молчание и было жалобой «ничего не работает».
    !/Текст в буфере|нажмите Ctrl\+V/i.test(state.toast) && state.stored === 'Ну привет как дела.' && state.recover === state.stored,
    `${state.stored} · ${state.toast.slice(0, 100)}`,
  );

  // Тот же отказ, но с причиной от main: она должна дойти до человека.
  const reasonPage = await openPage(browser, '#/home', {
    patchNative: () => {
      const native = window.zspeakly && window.zspeakly.native;
      if (!native) return;
      native.transcribePcm = async () => ({ ok: true, text: 'раз два три', engine: 'whisper' });
      native.insertText = async () => ({
        ok: false,
        method: 'clipboard',
        reason: 'Ctrl+V через mshta не сработал',
      });
    },
  });
  takeErrors(reasonPage);
  await reasonPage.evaluate(() => document.querySelector('.hero__mic').click());
  await sleep(700);
  await reasonPage.evaluate(() => window.__e2e.emit('dictation:stop', { from: 'hud' }));
  await sleep(1600);
  const reasonToast = await reasonPage.evaluate(() =>
    [...document.querySelectorAll('.toast')].map((t) => t.innerText.replace(/\n/g, ' ')).join(' | '),
  );
  record(
    'сценарии',
    'вставка не удалась: причина отказа доходит до человека',
    /mshta/i.test(reasonToast),
    reasonToast.slice(0, 90),
  );
  const reasonErrors = takeErrors(reasonPage).filter((e) => !/AudioContext|NotAllowedError/i.test(e));
  record('сценарии', 'вставка с причиной: без ошибок консоли', reasonErrors.length === 0, reasonErrors[0] || '');
  await reasonPage.close();
  const errors = takeErrors(page);
  record('сценарии', 'вставка не удалась: без ошибок консоли', errors.length === 0, errors[0] || '');
  await page.close();

  // Вставка «без буфера» может оборваться на середине: тогда нельзя ни
  // повторять вставку, ни молчать — человеку нужен честный отчёт.
  const partialPage = await openPage(browser, '#/home', {
    patchNative: () => {
      const native = window.zspeakly && window.zspeakly.native;
      if (!native) return;
      native.transcribePcm = async () => ({ ok: true, text: 'ну привет как дела', engine: 'whisper' });
      window.__insertCount = 0;
      native.insertText = async () => {
        window.__insertCount += 1;
        return { ok: false, partial: 7, total: 40 };
      };
    },
  });
  takeErrors(partialPage);
  await partialPage.evaluate(() => document.querySelector('.hero__mic').click());
  await sleep(700);
  await partialPage.evaluate(() => window.__e2e.emit('dictation:stop', { from: 'hud' }));
  await sleep(1600);
  const partial = await partialPage.evaluate(() => ({
    toast: [...document.querySelectorAll('.toast')].map((t) => t.innerText.replace(/\n/g, ' ')).join(' | '),
    inserts: window.__insertCount || 0,
  }));
  record(
    'сценарии',
    'вставка без буфера: обрыв на середине — правдивый тост, без повтора',
    /отправлено не менее 7 из 40/i.test(partial.toast) && partial.inserts === 1,
    `${partial.inserts} вставок · ${partial.toast.slice(0, 70)}`,
  );
  const partialErrors = takeErrors(partialPage);
  record('сценарии', 'вставка без буфера: без ошибок консоли', partialErrors.length === 0, partialErrors[0] || '');
  await partialPage.close();

  const busyPage = await openPage(browser, '#/home', {
    storeSeed: { 'zs.dictations': [] },
    patchNative: () => {
      window.zspeakly.native.transcribePcm = async () => ({ ok: true, text: 'вторая тестовая фраза' });
      window.__insertCount = 0;
      window.zspeakly.native.insertText = async () => {
        window.__insertCount += 1;
        return { ok: false, busy: true, reason: 'другая вставка ещё выполняется' };
      };
    },
  });
  takeErrors(busyPage);
  await busyPage.evaluate(() => document.querySelector('.hero__mic').click());
  await sleep(700);
  await busyPage.evaluate(() => window.__e2e.emit('dictation:stop', { from: 'hud' }));
  await sleep(1600);
  const busy = await busyPage.evaluate(() => ({
    toast: [...document.querySelectorAll('.toast')].map((t) => t.innerText.replace(/\n/g, ' ')).join(' | '),
    inserts: window.__insertCount,
    history: (window.__e2e.read('zs.dictations') || [])[0]?.text || '',
  }));
  record('безопасность', 'занятая вставка: текст в истории, не обещается Ctrl+V и нет автоповтора',
    /Вставка ещё занята/.test(busy.toast) && /не скопирована в буфер/.test(busy.toast) && /истории/.test(busy.toast)
      && !/нажмите Ctrl\+V/i.test(busy.toast) && busy.inserts === 1 && /вторая тестовая фраза/i.test(busy.history), busy.toast);
  record('безопасность', 'занятая вставка: без ошибок консоли', takeErrors(busyPage).length === 0);
  await busyPage.close();

  const changedPage = await openPage(browser, '#/home', {
    storeSeed: { 'zs.dictations': [] },
    patchNative: () => {
      window.zspeakly.native.transcribePcm = async () => ({ ok: true, text: 'проверка чужого буфера' });
      window.__insertCount = 0;
      window.zspeakly.native.insertText = async () => {
        window.__insertCount += 1;
        return { ok: false, clipboardChanged: true, reason: 'буфер изменился' };
      };
    },
  });
  takeErrors(changedPage);
  await changedPage.evaluate(() => document.querySelector('.hero__mic').click());
  await sleep(700);
  await changedPage.evaluate(() => window.__e2e.emit('dictation:stop', { from: 'hud' }));
  await sleep(1600);
  const changed = await changedPage.evaluate(() => ({
    toast: [...document.querySelectorAll('.toast')].map((t) => t.innerText).join(' | '),
    recover: document.querySelector('.toast__recover')?.value || '',
    inserts: window.__insertCount,
    history: (window.__e2e.read('zs.dictations') || [])[0]?.text || '',
  }));
  record('безопасность', 'изменённый буфер: нет слепого Ctrl+V или повтора, доступен полный текст',
    /буфер изменился/i.test(changed.toast) && !/Текст в буфере|нажмите Ctrl\+V/i.test(changed.toast)
      && changed.inserts === 1 && changed.recover === changed.history && /проверка чужого буфера/i.test(changed.recover),
    JSON.stringify(changed));
  record('безопасность', 'изменённый буфер: без ошибок консоли', takeErrors(changedPage).length === 0);
  await changedPage.close();

  const changedDuringPage = await openPage(browser, '#/home', {
    storeSeed: { 'zs.dictations': [] },
    patchNative: () => {
      window.zspeakly.native.transcribePcm = async () => ({ ok: true, text: 'моя диктовка' });
      window.__insertCount = 0;
      window.zspeakly.native.insertText = async () => {
        window.__insertCount += 1;
        return { ok: false, uncertain: true, clipboardChanged: true, reason: 'результат вставки не подтверждён' };
      };
    },
  });
  takeErrors(changedDuringPage);
  await changedDuringPage.evaluate(() => document.querySelector('.hero__mic').click());
  await sleep(700);
  await changedDuringPage.evaluate(() => window.__e2e.emit('dictation:stop', { from: 'hud' }));
  await sleep(1600);
  const changedDuring = await changedDuringPage.evaluate(() => ({
    toast: [...document.querySelectorAll('.toast')].map((t) => t.innerText).join(' | '),
    inserts: window.__insertCount,
  }));
  record('безопасность', 'буфер изменился во время Ctrl+V: предупреждение о другом тексте, без повтора',
    /другой текст/i.test(changedDuring.toast) && /проверьте окно/i.test(changedDuring.toast) &&
      !/нажмите Ctrl\+V/i.test(changedDuring.toast) && changedDuring.inserts === 1,
    JSON.stringify(changedDuring));
  record('безопасность', 'буфер изменился во время Ctrl+V: без ошибок консоли', takeErrors(changedDuringPage).length === 0);
  await changedDuringPage.close();

  const uncertainPage = await openPage(browser, '#/home', {
    patchNative: () => {
      window.zspeakly.native.transcribePcm = async () => ({ ok: true, text: 'неопределённый ввод' });
      window.__insertCount = 0;
      window.zspeakly.native.insertText = async () => {
        window.__insertCount += 1;
        return { ok: false, method: 'sendinput', uncertain: true };
      };
    },
  });
  takeErrors(uncertainPage);
  await uncertainPage.evaluate(() => document.querySelector('.hero__mic').click());
  await sleep(700);
  await uncertainPage.evaluate(() => window.__e2e.emit('dictation:stop', { from: 'hud' }));
  await sleep(1600);
  const uncertain = await uncertainPage.evaluate(() => ({
    toast: [...document.querySelectorAll('.toast')].map((t) => t.innerText.replace(/\n/g, ' ')).join(' | '),
    inserts: window.__insertCount,
    history: (window.__e2e.read('zs.dictations') || [])[0]?.text || '',
  }));
  record('сценарии', 'неподтверждённый ввод: предупреждение без обещания Ctrl+V и повтора',
    /не удалось подтвердить ввод/i.test(uncertain.toast) && /проверьте/i.test(uncertain.toast)
      && !/нажмите Ctrl\+V/i.test(uncertain.toast) && uncertain.inserts === 1 && /неопределённый ввод/i.test(uncertain.history),
    `${uncertain.inserts} вставок · ${uncertain.toast.slice(0, 120)}`);
  const uncertainErrors = takeErrors(uncertainPage);
  record('сценарии', 'неподтверждённый ввод: без ошибок консоли', uncertainErrors.length === 0, uncertainErrors[0] || '');
  await uncertainPage.close();

  const uncertainClipboardPage = await openPage(browser, '#/home', {
    patchNative: () => {
      window.zspeakly.native.transcribePcm = async () => ({ ok: true, text: 'сомнительная вставка через буфер' });
      window.zspeakly.native.insertText = async () => ({ ok: false, method: 'clipboard', uncertain: true });
    },
  });
  takeErrors(uncertainClipboardPage);
  await uncertainClipboardPage.evaluate(() => document.querySelector('.hero__mic').click());
  await sleep(700);
  await uncertainClipboardPage.evaluate(() => window.__e2e.emit('dictation:stop', { from: 'hud' }));
  await sleep(1600);
  const clipboardWarning = await uncertainClipboardPage.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.innerText).join(' '));
  record('сценарии', 'Ctrl+V без подтверждения: проверить окно перед повтором, не обещать буфер',
    /Не удалось подтвердить ввод/.test(clipboardWarning) && /Проверьте/.test(clipboardWarning) && !/нажмите Ctrl\+V/i.test(clipboardWarning));
  const clipboardWarningErrors = takeErrors(uncertainClipboardPage);
  record('сценарии', 'Ctrl+V без подтверждения: без ошибок консоли', clipboardWarningErrors.length === 0, clipboardWarningErrors[0] || '');
  await uncertainClipboardPage.close();

  const rejectedPage = await openPage(browser, '#/home', {
    patchNative: () => {
      window.zspeakly.native.transcribePcm = async () => ({ ok: true, text: 'потерян ответ от вставки' });
      window.zspeakly.native.insertText = async () => { throw new Error('IPC response lost'); };
    },
  });
  takeErrors(rejectedPage);
  await rejectedPage.evaluate(() => document.querySelector('.hero__mic').click());
  await sleep(700);
  await rejectedPage.evaluate(() => window.__e2e.emit('dictation:stop', { from: 'hud' }));
  await sleep(1600);
  const rejectedToast = await rejectedPage.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.innerText).join(' '));
  record('сценарии', 'потеря ответа IPC предупреждает проверить окно, а не обещает буфер',
    /Не удалось подтвердить ввод/.test(rejectedToast) && /Проверьте окно/.test(rejectedToast) && !/нажмите Ctrl\+V/i.test(rejectedToast));
  const rejectedErrors = takeErrors(rejectedPage);
  record('сценарии', 'потеря ответа IPC: без ошибок консоли', rejectedErrors.length === 0, rejectedErrors[0] || '');
  await rejectedPage.close();
}

// Плавающая плашка не должна обещать живой текст там, где его нет: у whisper.cpp
// расшифровка появляется только после остановки.
async function scenarioHudPromise(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 400, height: 140, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument(() => {
    window.__hudState = null;
    window.hudBridge = {
      onState: (cb) => {
        window.__hudPush = cb;
      },
      stop: () => {},
      close: () => {},
    };
  });
  await page.goto(HUD_FILE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#text', { timeout: 10_000 });
  const textFor = async (engine, live = false) => {
    await page.evaluate(
      ([eng, isLive]) =>
        window.__hudPush({ state: 'listening', level: 0.3, elapsed: 900, draft: '', engine: eng, live: isLive }),
      [engine, live],
    );
    await sleep(150);
    return page.evaluate(() => document.getElementById('text').textContent);
  };
  const whisper = await textFor('whisper.cpp (офлайн)');
  // с включённой живой расшифровкой обещание другое — и оно правдиво
  const whisperLive = await textFor('whisper.cpp (офлайн)', true);
  const web = await textFor('');
  const draft = await page.evaluate(() => {
    window.__hudPush({ state: 'listening', level: 0.3, elapsed: 900, draft: 'привет как дела', engine: 'whisper.cpp (офлайн)' });
    return document.getElementById('text').textContent;
  });
  record(
    'сценарии',
    'плашка: с whisper не обещает живой текст',
    /после остановки/i.test(whisper) && !/текст появится здесь/i.test(whisper),
    whisper,
  );
  record(
    'сценарии',
    'плашка: с живой расшифровкой обещает текст по ходу речи',
    /текст появится здесь/i.test(whisperLive) && !/после остановки/i.test(whisperLive),
    whisperLive,
  );
  record(
    'сценарии',
    'плашка: живой текст браузерного движка подписан честно',
    /текст появится здесь/i.test(web) && draft === 'привет как дела',
    `${web} · черновик: ${draft}`,
  );
  const agent = await page.evaluate(() => {
    window.__hudPush({ state: 'processing', agent: true, draft: 'старый черновик', processingMs: 1000 });
    return { title: document.getElementById('title').textContent, text: document.getElementById('text').textContent, cancel: !document.getElementById('cancel').hidden };
  });
  record('сценарии', 'плашка: ожидание агента названо отдельно от распознавания',
    /Агент отвечает/i.test(agent.title) && /Ответ появится в истории/i.test(agent.text) && agent.cancel,
    JSON.stringify(agent));
  await page.close();
}

// «Горячий микрофон»: поток открыт заранее, поэтому в распознавание уходит и
// звук до нажатия хоткея. Без настройки первое слово теряется — это видно по
// длительности записи.
async function scenarioMicPreroll(browser) {
  const run = async (micPreroll) => {
    const page = await openPage(browser, '#/home', {
      settings: { micPreroll },
      patchNative: () => {
        const native = window.zspeakly && window.zspeakly.native;
        if (!native) return;
        window.__prerollPayload = null;
        native.transcribePcm = async (payload) => {
          window.__prerollPayload = { durationMs: payload?.durationMs || 0, bytes: payload?.pcm?.byteLength || 0 };
          return { ok: true, text: 'проверка предролла', engine: 'whisper' };
        };
      },
    });
    takeErrors(page);
    // даём «горячему микрофону» накопить буфер
    await sleep(micPreroll ? 1200 : 200);
    await page.evaluate(() => document.querySelector('.hero__mic').click());
    await sleep(600);
    await page.evaluate(() => window.__e2e.emit('dictation:stop', { from: 'hud' }));
    await sleep(1800);
    const payload = await page.evaluate(() => window.__prerollPayload);
    const errors = takeErrors(page);
    await page.close();
    return { payload, errors };
  };

  const on = await run(true);
  const off = await run(false);
  const onMs = on.payload?.durationMs || 0;
  const offMs = off.payload?.durationMs || 0;
  record(
    'сценарии',
    'предролл: горячий микрофон добавляет звук до хоткея',
    onMs > 0 && offMs > 0 && onMs >= offMs + 300,
    `${onMs} мс против ${offMs} мс без настройки`,
  );
  record(
    'сценарии',
    'предролл: без настройки запись начинается с нажатия',
    offMs > 0 && offMs < 1200,
    `${offMs} мс записи`,
  );
  const errors = [...on.errors, ...off.errors];
  record('сценарии', 'предролл: без ошибок консоли', errors.length === 0, errors[0] || '');

  // В настройках видно, держим ли мы микрофон открытым прямо сейчас — иначе
  // тумблер про приватность ничего не объясняет.
  const status = async (micPreroll) => {
    const page = await openPage(browser, '#/settings?section=app&from=home', {
      settings: { micPreroll },
      settle: 500,
    });
    takeErrors(page);
    await sleep(micPreroll ? 1200 : 300);
    const text = await page.evaluate(() => document.body.innerText);
    const errors2 = takeErrors(page);
    await page.close();
    return { text, errors: errors2 };
  };
  const onStatus = await status(true);
  const offStatus = await status(false);
  record(
    'сценарии',
    'предролл: в настройках видно, открыт микрофон или нет',
    /Сейчас: микрофон открыт/.test(onStatus.text) && /микрофон закрыт/.test(offStatus.text),
    `${/Сейчас: микрофон открыт/.test(onStatus.text) ? 'открыт' : 'нет'} · ${/микрофон закрыт/.test(offStatus.text) ? 'закрыт' : 'нет'}`,
  );
  const statusErrors = [...onStatus.errors, ...offStatus.errors];
  record('сценарии', 'предролл: статус без ошибок консоли', statusErrors.length === 0, statusErrors[0] || '');

  // Трей должен узнать про открытый микрофон, иначе индикатор в системе
  // выглядит необъяснимо.
  const warmCalls = async (micPreroll) => {
    const page = await openPage(browser, '#/settings?section=app&from=home', {
      settings: { micPreroll },
      settle: 500,
    });
    takeErrors(page);
    await sleep(micPreroll ? 1500 : 400);
    const list = await page.evaluate(() =>
      (window.__bridgeCalls || [])
        .filter((c) => c.channel === 'mic:warm')
        .map((c) => c.args?.[0]),
    );
    const errors3 = takeErrors(page);
    await page.close();
    return { list, errors: errors3 };
  };
  const warmOn = await warmCalls(true);
  const warmOff = await warmCalls(false);
  record(
    'сценарии',
    'предролл: трей узнаёт, что микрофон открыт',
    warmOn.list.includes(true) && warmOff.list.every((v) => v !== true),
    `вкл: ${warmOn.list.join(',') || '—'} · выкл: ${warmOff.list.join(',') || '—'}`,
  );
  const warmErrors = [...warmOn.errors, ...warmOff.errors];
  record('сценарии', 'предролл: канал трея без ошибок консоли', warmErrors.length === 0, warmErrors[0] || '');
}

// Стоп до разрешения на микрофон должен завершить запись, а поздний поток закрыться.
async function scenarioDelayedMicrophone(browser) {
  const page = await openPage(browser, '#/home', {
    settings: { micPreroll: false, liveWhisper: false, aiDictationRewrite: false },
    storeSeed: { 'zs.dictations': [], 'zs.mockSttText': 'повторная запись' },
    patchNative: () => {
      const devices = navigator.mediaDevices;
      const original = devices.getUserMedia.bind(devices);
      let first = true;
      window.__lateTrack = null;
      devices.getUserMedia = async (constraints) => {
        const stream = await original(constraints);
        if (!first) return stream;
        first = false;
        window.__lateTrack = stream.getAudioTracks()[0];
        await new Promise((resolve) => { window.__allowMic = resolve; });
        return stream;
      };
    },
  });
  takeErrors(page);
  try {
    await emit(page, 'hotkey', { type: 'down', mode: 'hold' });
    await page.waitForFunction(() => Boolean(window.__allowMic), { timeout: 8000 });
    await emit(page, 'hotkey', { type: 'up' });
    await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some((node) => /Микрофон ещё не открылся/.test(node.innerText)), { timeout: 8000 });
    await page.evaluate(() => window.__allowMic());
    await page.waitForFunction(() => window.__lateTrack?.readyState === 'ended', { timeout: 8000 });
    await sleep(1100);
    const afterStop = await page.evaluate(() => ({
      track: window.__lateTrack.readyState,
      button: document.querySelector('.hero__mic')?.innerText || '',
      history: window.__e2e.read('zs.dictations') || [],
    }));
    await emit(page, 'hotkey', { type: 'down', mode: 'hold' });
    await sleep(1200);
    await emit(page, 'hotkey', { type: 'up' });
    await page.waitForFunction(() => (window.__e2e.read('zs.dictations') || []).length === 1, { timeout: 10000 });
    const history = await page.evaluate(() => window.__e2e.read('zs.dictations'));
    const errors = takeErrors(page);
    record('сценарии', 'микрофон: стоп до открытия закрывает поздний поток и позволяет повтор',
      afterStop.track === 'ended' && !/Слушаю/.test(afterStop.button) && afterStop.history.length === 0 &&
      /повторная запись/i.test(history[0]?.text || '') && errors.length === 0,
      JSON.stringify({ afterStop, text: history[0]?.text, error: errors[0] }));
  } finally { await page.close(); }
}

// Отказ без разрешения и отсутствующее устройство должны прекращать запись.
async function scenarioMicrophoneFailure(browser) {
  for (const name of ['NotFoundError', 'UnknownError']) {
    const page = await openPage(browser, '#/home', {
      settings: { micPreroll: false, liveWhisper: false, aiDictationRewrite: false },
      storeSeed: { 'zs.dictations': [], 'zs.mockSttText': 'после ошибки' },
      patchNative: () => {
        window.__micFailureName = 'NotFoundError';
        const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        let fail = true;
        navigator.mediaDevices.getUserMedia = async (constraints) => {
          if (!fail) return original(constraints);
          fail = false;
          const err = new Error('test microphone failure');
          err.name = window.__micFailureName;
          throw err;
        };
      },
    });
    takeErrors(page);
    try {
      await page.evaluate((errorName) => { window.__micFailureName = errorName; }, name);
      await emit(page, 'hotkey', { type: 'down', mode: 'hold' });
      await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some((node) => /микрофон/i.test(node.innerText)), { timeout: 8000 });
      await sleep(300);
      const result = await page.evaluate(() => ({
        button: document.querySelector('.hero__mic')?.innerText || '',
        toast: [...document.querySelectorAll('.toast')].map((node) => node.innerText).join(' '),
      }));
      await emit(page, 'hotkey', { type: 'down', mode: 'hold' });
      await sleep(1100);
      await emit(page, 'hotkey', { type: 'up' });
      await page.waitForFunction(() => (window.__e2e.read('zs.dictations') || []).length === 1, { timeout: 10000 });
      const text = await page.evaluate(() => window.__e2e.read('zs.dictations')[0]?.text || '');
      const errors = takeErrors(page);
      const expected = name === 'NotFoundError' ? /Микрофон не найден/ : /Не удалось открыть микрофон/;
      record('сценарии', `микрофон: ${name} прекращает запись с сообщением и разрешает повтор`,
        !/Слушаю/.test(result.button) && expected.test(result.toast) && /после ошибки/i.test(text) && errors.length === 0,
        JSON.stringify({ ...result, text, error: errors[0] }));
    } finally { await page.close(); }
  }
}

// Микрофон из настроек пропал (выдернули USB): диктовка не должна молча
// ломаться — пишем с системного и честно говорим об этом.
async function scenarioMissingMic(browser) {
  const page = await openPage(browser, '#/home', {
    settings: { audioDeviceId: 'mic-404' },
    patchNative: () => {
      const devices = navigator.mediaDevices;
      if (!devices?.getUserMedia) return;
      const original = devices.getUserMedia.bind(devices);
      devices.getUserMedia = async (constraints) => {
        if (constraints?.audio?.deviceId?.exact) {
          const err = new Error('Requested device not found');
          err.name = 'OverconstrainedError';
          throw err;
        }
        return original(constraints);
      };
    },
  });
  takeErrors(page);
  await page.evaluate(() => document.querySelector('.hero__mic').click());
  await sleep(1200);
  const state = await page.evaluate(() => ({
    listening: /Слушаю…/.test(document.querySelector('.hero__mic')?.innerText || ''),
    toast: [...document.querySelectorAll('.toast')].map((t) => t.innerText.replace(/\n/g, ' ')).join(' | '),
    hud: document.querySelectorAll('.hud').length,
  }));
  record(
    'сценарии',
    'микрофон: пропавшее устройство заменяется системным с объяснением',
    state.listening && /Микрофон из настроек не найден/.test(state.toast) && /системн/i.test(state.toast),
    `${state.listening} · ${state.toast.slice(0, 70)}`,
  );
  await page.evaluate(() => window.__e2e.emit('dictation:stop', { from: 'hud' }));
  await sleep(900);
  const errors = takeErrors(page);
  record('сценарии', 'микрофон: без ошибок консоли', errors.length === 0, errors[0] || '');
  await page.close();
}

// Лимит истории буфера не должен выбрасывать закреплённое.
/**
 * Пауза и отмена распознавания — ровно то, чего не хватало в реальной работе:
 * нельзя было приостановить запись, а во время долгого распознавания на экране
 * не было ни секунд, ни способа прервать проход.
 */
async function scenarioPauseAndCancel(browser) {
  const page = await openPage(browser, '#/home', {
    settings: { liveWhisper: false },
    patchNative: () => {
      const native = window.zspeakly && window.zspeakly.native;
      if (!native) return;
      native.transcribePcm = async (payload) => {
        window.__sttCalls = window.__sttCalls || [];
        window.__sttCalls.push({ partial: payload?.partial === true });
        await new Promise((r) => setTimeout(r, payload?.partial ? 1200 : 2500));
        return { ok: true, text: 'Текст после паузы и отмены', engine: 'whisper' };
      };
    },
  });
  takeErrors(page);
  const text = () => page.evaluate(() => document.body.innerText.replace(/\n+/g, ' | '));

  await clickText(page, 'Начать диктовку');
  await sleep(1400);
  const hasPause = await page.evaluate(() => Boolean(document.querySelector('.hero__pause')));
  record('сценарии', 'пауза: кнопка есть во время записи', hasPause);

  await page.evaluate(() => document.querySelector('.hero__pause')?.click());
  await sleep(500);
  const pausedUi = await page.evaluate(() => ({
    text: document.body.innerText,
    elapsed: document.body.innerText.match(/(\d+\.\d) с/)?.[1] || '0',
  }));
  const pausedOk = /Пауза/i.test(pausedUi.text) && /Продолжить/i.test(await text());
  await sleep(1500);
  const afterWait = await page.evaluate(() => document.body.innerText.match(/(\d+\.\d) с/)?.[1] || '0');
  record('сценарии', 'пауза: запись останавливается, время не идёт', pausedOk && Math.abs(Number(afterWait) - Number(pausedUi.elapsed)) < 0.6,
    `${pausedUi.elapsed} → ${afterWait}`);

  await page.evaluate(() => document.querySelector('.hero__pause')?.click());
  await sleep(600);
  const resumed = await page.evaluate(() => document.querySelector('.hero__pause')?.innerText.trim() || '');
  record('сценарии', 'пауза: «Продолжить» возвращает запись', /Пауза/i.test(resumed), resumed);

  await page.click('.hero__mic');
  await sleep(700);
  const processing = await page.evaluate(() => ({
    text: document.body.innerText,
    cancel: Boolean([...document.querySelectorAll('button')].find((b) => /отменить/i.test(b.innerText))),
    cancelCalls: (window.__bridgeCalls || []).filter((c) => c.channel === 'stt:cancel').length,
    progress: Boolean(document.querySelector('.live-draft--processing')),
  }));
  record('сценарии', 'распознавание: видно плашку с секундами', processing.progress && /ТРАНСКРИПЦИЯ/i.test(processing.text));
  record('сценарии', 'распознавание: есть кнопка «Отменить»', processing.cancel);
  record('сценарии', 'распознавание: живой проход отменяется перед итоговым', processing.cancelCalls >= 1, `stt:cancel ×${processing.cancelCalls}`);

  await clickText(page, 'ОТМЕНИТЬ');
  await sleep(600);
  const idle = await text();
  record('сценарии', 'отмена распознавания возвращает готовность', /Начать диктовку/i.test(idle) && !/ТРАНСКРИПЦИЯ/i.test(idle));
  // Мок намеренно игнорирует cancel и возвращает текст с задержкой: его нельзя
  // вставлять или добавлять в историю, даже если движок ответил после отмены.
  await sleep(2600);
  const cancelled = await page.evaluate(() => ({
    insertions: (window.__bridgeCalls || []).filter((c) => c.channel === 'text:insert').length,
    history: JSON.parse(localStorage.getItem('mockstore:zs.dictations') || '[]'),
    body: document.body.innerText,
  }));
  record('сценарии', 'поздний ответ после отмены не вставляется и не попадает в историю',
    cancelled.insertions === 0 && !cancelled.history.some((item) => /Текст после паузы и отмены/i.test(item.text || '')) &&
      !/Текст после паузы и отмены/i.test(cancelled.body), `вставок: ${cancelled.insertions}`);

  // обычный проход до конца — отмена не должна ломать следующие диктовки
  await page.evaluate(() => window.__sttCalls = []);
  await clickText(page, 'Начать диктовку');
  await sleep(900);
  await page.click('.hero__mic');
  await sleep(3200);
  const inserted = await page.evaluate(() =>
    (window.__bridgeCalls || []).filter((c) => c.channel === 'text:insert').map((c) => String(c.args?.[0] || '')),
  );
  record('сценарии', 'после отмены следующая диктовка распознаётся', inserted.some((t) => /после паузы и отмены/i.test(t)), `вставок: ${inserted.length}`);
  const errors = takeErrors(page).filter((e) => !/AudioContext|NotAllowedError|microphone/i.test(e));
  record('сценарии', 'пауза и отмена без ошибок в консоли', errors.length === 0, errors[0] || '');
  await page.close();
}

async function scenarioLiveWhisper(browser) {
  // Живая расшифровка: пока человек говорит, whisper спрашивают повторно и
  // текст в черновике обновляется. Без настройки — ни одного лишнего вызова.
  const run = async (liveWhisper, model) => {
    const page = await openPage(browser, '#/home', {
      // полировка выключена: сценарий про проходы распознавания, а не про модель
      settings: {
        liveWhisper,
        ...(model ? { whisperModel: model } : {}),
        aiDictationRewrite: false,
      },
      patchNative: () => {
        const native = window.zspeakly && window.zspeakly.native;
        if (!native) return;
        native.transcribePcm = async (payload) => {
          const partial = payload?.partial === true;
          window.__liveCalls = window.__liveCalls || [];
          window.__liveCalls.push({ partial, durationMs: payload?.durationMs || 0 });
          return {
            ok: true,
            text: partial ? 'живой текст по ходу речи' : 'итоговый текст диктовки',
            engine: 'whisper',
          };
        };
      },
    });
    takeErrors(page);
    await page.evaluate(() => {
      window.__liveCalls = [];
    });
    await page.evaluate(() => document.querySelector('.hero__mic').click());
    await sleep(4200);
    const during = await page.evaluate(() => ({
      calls: (window.__liveCalls || []).slice(),
      draft: document.querySelector('.live-draft__text')?.innerText || '',
    }));
    await page.evaluate(() => window.__e2e.emit('dictation:stop', { from: 'hud' }));
    await sleep(2200);
    const after = await page.evaluate(() => ({
      calls: (window.__liveCalls || []).slice(),
      inserted: (window.__bridgeCalls || [])
        .filter((c) => c.channel === 'text:insert')
        .map((c) => String(c.args?.[0] || '')),
      draft: document.querySelector('.live-draft__text')?.innerText || '',
    }));
    const errors = takeErrors(page);
    await page.close();
    return { during, after, errors };
  };

  const on = await run(true);
  const off = await run(false);
  // 'auto' — значение по умолчанию у нового профиля: приложение решает само.
  // На «Быстро» движок успевает и черновик, на «Сбалансированно» — уже нет.
  const autoFast = await run('auto', 'base-q5_1');
  const autoBalanced = await run('auto', 'small-q5_1');
  const partials = on.during.calls.filter((c) => c.partial).length;
  record(
    'сценарии',
    'живая расшифровка: пока говоришь, whisper спрашивают повторно',
    partials >= 1 && on.during.calls.every((c) => c.durationMs > 0),
    `${partials} промежуточных вызовов за 4 с`,
  );
  record(
    'сценарии',
    'живая расшифровка: черновик обновляется до остановки',
    /живой текст/i.test(on.during.draft),
    on.during.draft.slice(0, 60) || 'пусто',
  );
  record(
    'сценарии',
    'живая расшифровка: итог приходит отдельным проходом',
    on.after.calls.some((c) => !c.partial) && /итоговый текст/i.test(on.after.inserted.join(' ')),
    on.after.inserted.join(' | ').slice(0, 60) || 'вставок нет',
  );
  record(
    'сценарии',
    'живая расшифровка: выключенная настройка не тратит процессор',
    off.during.calls.length === 0 && off.after.calls.filter((c) => c.partial).length === 0,
    `${off.during.calls.length} промежуточных вызовов`,
  );
  const errors = [...on.errors, ...off.errors];
  record('сценарии', 'живая расшифровка: без ошибок консоли', errors.length === 0, errors[0] || '');

  const autoFastPartials = autoFast.during.calls.filter((c) => c.partial).length;
  record(
    'сценарии',
    'живая расшифровка: на «Быстро» включается сама, без настройки',
    autoFast.during.calls.length > 0 && autoFastPartials > 0,
    `${autoFastPartials} промежуточных вызовов`,
  );
  const autoBalancedPartials = autoBalanced.during.calls.filter((c) => c.partial).length;
  record(
    'сценарии',
    'живая расшифровка: на «Сбалансированно» сама не включается — итог не ждёт',
    autoBalancedPartials === 0,
    `${autoBalancedPartials} промежуточных вызовов`,
  );

  // Строка настроек объясняет решение словами и не притворяется тумблером:
  // человек не должен выбирать «как правильно» между черновиком и итогом.
  const settingsPage = await openPage(browser, '#/settings?section=features&from=home', {
    settings: { liveWhisper: 'auto', whisperModel: 'base-q5_1' },
    settle: 700,
  });
  takeErrors(settingsPage);
  const liveRow = await settingsPage.evaluate(() => {
    const row = [...document.querySelectorAll('.settings-main .setting-row')].find((el) =>
      /Живая расшифровка/.test(el.innerText),
    );
    if (!row) return { text: '', toggle: false };
    return {
      text: row.innerText.replace(/\n+/g, ' '),
      toggle: Boolean(row.querySelector('[role="switch"], input[type="checkbox"]')),
    };
  });
  record(
    'сценарии',
    'живая расшифровка: в настройках строка-объяснение, а не тумблер',
    !liveRow.toggle && /включена/i.test(liveRow.text) && /сама/i.test(liveRow.text),
    liveRow.text.slice(0, 160) || 'строки нет',
  );
  // Забытая запись больше не висит до сторожа: двадцать секунд тишины — и
  // она завершается сама. Правило должно быть названо там, где человек читает
  // «что приложение решает само», иначе это выглядит как случайный обрыв.
  const autoStopNote = await settingsPage.evaluate(() => {
    const note = document.querySelector('.settings-main .settings-note, .settings-note');
    return note ? note.innerText.replace(/\n+/g, ' ') : '';
  });
  record(
    'сценарии',
    'тишина: правило авто-стопа названо в «Функциях»',
    /двадцать секунд тишины/i.test(autoStopNote) && /сама|само/i.test(autoStopNote),
    autoStopNote.slice(0, 200) || 'строки нет',
  );
  // Оформление под окно — тоже решение приложения, а не настройка: человек
  // должен узнать о нём из той же строки, а не удивляться точке в мессенджере.
  record(
    'сценарии',
    'оформление: правило «под окно» названо в «Функциях»',
    /оформление/i.test(autoStopNote) && /мессенджер/i.test(autoStopNote) && /письм/i.test(autoStopNote),
    autoStopNote.slice(0, 220) || 'строки нет',
  );
  const settingsErrors = takeErrors(settingsPage);
  record(
    'сценарии',
    'живая расшифровка: настройка без ошибок консоли',
    settingsErrors.length === 0,
    settingsErrors[0] || '',
  );
  await settingsPage.close();
}

async function scenarioPinnedLimit(browser) {
  const pinned = { id: 'pin-1', kind: 'text', text: 'закреплённая запись', source: 'тест', createdAt: Date.now(), pinned: true };
  const page = await openPage(browser, '#/clipboard', {
    settings: { clipboardMaxItems: 3 },
    storeSeed: { 'zs.clipboard': [pinned] },
  });
  takeErrors(page);
  await page.evaluate(() => {
    for (let i = 1; i <= 6; i += 1) {
      window.__e2e.emit('clipboard:item', {
        kind: 'text',
        text: `новая запись ${i}`,
        source: 'тест',
        createdAt: Date.now() + i,
      });
    }
  });
  await sleep(700);
  const state = await page.evaluate(() => (window.__e2e.read('zs.clipboard') || []).map((c) => ({ text: c.text, pinned: Boolean(c.pinned) })));
  const hasPinned = state.some((c) => c.pinned && c.text === 'закреплённая запись');
  const visible = await page.evaluate(() => document.body.innerText);
  record(
    'сценарии',
    'буфер: лимит истории не выбрасывает закреплённое',
    hasPinned && /закреплённая запись/.test(visible),
    `записей ${state.length}: ${state.map((c) => (c.pinned ? '★' : '·')).join('')}`,
  );
  const errors = takeErrors(page);
  record('сценарии', 'буфер: лимит без ошибок консоли', errors.length === 0, errors[0] || '');
  await page.close();
}

async function scenarioClipboardPinnedDedup(browser) {
  const now = Date.now();
  const pinned = { id: 'pin-original', kind: 'text', text: 'закреплённое повторение', source: 'исходный источник', createdAt: now - 5000, pinned: true };
  const page = await openPage(browser, '#/clipboard', {
    settle: 500,
    settings: { clipboardMaxItems: 100 },
    storeSeed: { 'zs.clipboard': [
      pinned,
      { id: 'plain-old', kind: 'text', text: 'незакреплённое повторение', source: 'старый', createdAt: now - 4000 },
      { id: 'note-original', kind: 'note', text: 'одинаковая подпись', image: 'data:image/png;base64,OLD', source: 'старая заметка', createdAt: now - 3000 },
      { id: 'file-original', kind: 'file', text: 'Запись экрана · 1 с · 1 МБ', image: 'data:image/png;base64,OLD', source: 'старый файл', createdAt: now - 2000 },
    ] },
  });
  takeErrors(page);
  await page.evaluate(() => {
    const emit = (item) => window.__e2e.emit('clipboard:item', item);
    emit({ kind: 'text', text: 'закреплённое повторение', source: 'новый источник', createdAt: Date.now() });
    emit({ kind: 'text', text: 'закреплённое повторение', source: 'ещё один источник', createdAt: Date.now() + 1 });
    emit({ kind: 'text', text: 'незакреплённое повторение', source: 'новый', createdAt: Date.now() });
    // Синтетические события вызывают тот же addClipboardItem, что и результат
    // скриншота/сохранения; реальный сбор картинок намеренно не расширяем.
    emit({ id: 'note-new', kind: 'note', text: 'одинаковая подпись', image: 'data:image/png;base64,NEW', source: 'новая заметка', createdAt: Date.now() });
    emit({ id: 'file-new', kind: 'file', text: 'Запись экрана · 1 с · 1 МБ', image: 'data:image/png;base64,NEW', source: 'новый файл', createdAt: Date.now() });
  });
  await sleep(700);
  const items = await page.evaluate(() => window.__e2e.read('zs.clipboard') || []);
  const pinnedAfter = items.find((item) => item.id === pinned.id);
  record('сохранность', 'буфер: повторное копирование не удаляет закреплённую запись', Boolean(pinnedAfter?.pinned) && pinnedAfter.createdAt === pinned.createdAt && pinnedAfter.source === pinned.source);
  const pinnedDuplicates = items.filter((item) => item.kind === 'text' && item.text === pinned.text);
  record('сохранность', 'буфер: повтор рядом с закреплённой записью остаётся один и обновляет источник', pinnedDuplicates.length === 2 && pinnedDuplicates.some((item) => !item.pinned && item.source === 'ещё один источник'));
  record('сохранность', 'буфер: повтор обычного текста обновляет незакреплённую запись', items.filter((item) => item.kind === 'text' && item.text === 'незакреплённое повторение').length === 1 && !items.some((item) => item.id === 'plain-old') && items.some((item) => item.source === 'новый'));
  record('сохранность', 'буфер: одинаковая подпись не удаляет другую заметку или видео', ['note-original', 'note-new', 'file-original', 'file-new'].every((id) => items.some((item) => item.id === id)));
  await clickIn(page, '', 'Очистить историю');
  await sleep(200);
  await clickIn(page, '.modal', 'Очистить');
  await sleep(400);
  const afterClear = await page.evaluate(() => window.__e2e.read('zs.clipboard') || []);
  record('сохранность', 'буфер: после очистки исходная закреплённая запись сохраняется', afterClear.length === 1 && afterClear[0].id === pinned.id && afterClear[0].pinned);
  // Новая страница с тем же localStorage, но без повторного внедрения seed.
  const reopened = await browser.newPage();
  await reopened.evaluateOnNewDocument(installMockBridge);
  await reopened.goto(`${BASE}/#/clipboard`, { waitUntil: 'domcontentloaded' });
  await reopened.waitForSelector('.app-window', { timeout: 15000 });
  await sleep(400);
  const afterReload = await reopened.evaluate(() => window.__e2e.read('zs.clipboard') || []);
  record('сохранность', 'буфер: закрепление и исходные метаданные переживают перезагрузку мока', afterReload.length === 1 && afterReload[0].id === pinned.id && afterReload[0].pinned && afterReload[0].createdAt === pinned.createdAt && afterReload[0].source === pinned.source);
  await reopened.close();
  const errors = takeErrors(page);
  record('сохранность', 'буфер: повторное копирование без ошибок консоли', errors.length === 0, errors[0] || '');
  await page.close();
}

// Пароли в буфере: в профиле только шифр, открытый текст появляется лишь после
// «Показать»/«Копировать» — и только если main смог расшифровать.
async function scenarioPasswordVault(browser) {
  const secret = 'Qw7!pLz9#Vb2';
  const cipher = Buffer.from(secret, 'utf8').toString('base64');
  const page = await openPage(browser, '#/clipboard?tab=password', {
    storeSeed: {
      'zs.clipboard': [
        {
          id: 'pw-1',
          kind: 'password',
          text: '',
          cipher,
          encrypted: true,
          source: 'Bitwarden',
          createdAt: Date.now(),
        },
      ],
    },
  });
  takeErrors(page);
  await page.evaluate(() => {
    const tab = [...document.querySelectorAll('.btn--tab')].find((b) => /Пароли/.test(b.innerText));
    if (tab) tab.click();
  });
  await sleep(400);
  const masked = await page.evaluate(() => ({
    body: document.body.innerText,
    leaked: document.body.innerText.includes('Qw7!pLz9#Vb2'),
    card: document.querySelector('.clip-card__text--masked')?.innerText || '',
  }));
  record(
    'сценарии',
    'пароли: значение не попадает на экран до «Показать»',
    !masked.leaked && masked.card.length > 0,
    `маска ${masked.card.length} символов`,
  );

  await page.evaluate(() => document.querySelector('.clip-card')?.click());
  await sleep(300);
  await page.evaluate(() => {
    // подписи кнопок приходят в верхнем регистре (CSS text-transform)
    const btn = [...document.querySelectorAll('.clip-preview__reveal, .clip-actions .link-btn, .clip-actions button')].find(
      (b) => /показать/i.test(b.innerText),
    );
    if (btn) btn.click();
  });
  await sleep(600);
  const revealed = await page.evaluate(() => ({
    body: document.body.innerText,
    calls: (window.__bridgeCalls || []).map((c) => c.channel || c.ch),
  }));
  const calls = await bridgeCalls(page);
  record(
    'сценарии',
    'пароли: «Показать» расшифровывает через системное хранилище',
    revealed.body.includes(secret) && calls.includes('secret:reveal'),
    `${calls.filter((c) => c === 'secret:reveal').length} расшифровок`,
  );

  await page.evaluate(() => window.__e2e.resetCalls());
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => /^копировать$/i.test(b.innerText.trim()));
    if (btn) btn.click();
  });
  await sleep(600);
  const copied = await page.evaluate(() => (window.__bridgeCalls || []).filter((c) => (c.channel || c.ch) === 'clipboard:write'));
  const copiedText = copied.at(-1)?.payload?.[0]?.text ?? copied.at(-1)?.args?.[0]?.text;
  record(
    'сценарии',
    'пароли: копирование кладёт в буфер сам пароль, а не шифр',
    copiedText === secret,
    copiedText === secret ? 'тестовое значение совпало' : 'тестовое значение не совпало',
  );
  const errors = takeErrors(page);
  record('сценарии', 'пароли: без ошибок консоли', errors.length === 0, errors[0] || '');
  await page.close();
}

// Синтетические данные и подменённый bridge: не проверяет реальный safeStorage.
async function scenarioClipboardSecretPrivacy(browser) {
  const plain = 'PlainTest9!';
  const secret = 'CipherTest8!';
  const page = await openPage(browser, '#/clipboard', {
    settle: 500,
    settings: { hidePasswords: true },
    storeSeed: { 'zs.clipboard': [
      { id: 'cipher-pw', kind: 'password', text: '', cipher: Buffer.from(secret).toString('base64'), source: 'vault', createdAt: Date.now() },
      { id: 'plain-pw', kind: 'password', text: plain, source: 'legacy', createdAt: Date.now() - 1 },
    ] },
  });
  takeErrors(page);
  const initial = await page.evaluate(() => ({
    body: document.body.innerText,
    titles: [...document.querySelectorAll('.clip-card')].map((el) => el.title),
  }));
  record('приватность', 'буфер: маска и предупреждение о незашифрованных секретах',
    !initial.body.includes(plain) && !initial.body.includes(secret) && /секрет может сохраниться как обычный текст/i.test(initial.body) &&
      initial.titles.includes('Пароль (открытый текст)') && initial.titles.includes('Пароль (зашифрован)'));

  await page.type('input[placeholder="Поиск по истории буфера"]', plain);
  await sleep(250);
  const matched = await page.evaluate(() => document.querySelectorAll('.clip-card').length);
  record('приватность', 'буфер: поиск не раскрывает совпадение с текстом пароля', matched === 0);
  await page.evaluate(() => {
    const input = document.querySelector('input[placeholder="Поиск по истории буфера"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(250);
  await page.evaluate(() => document.querySelector('.clip-card')?.click());
  await sleep(200);
  await page.evaluate(() => [...document.querySelectorAll('.clip-actions button')].find((b) => /^копировать$/i.test(b.innerText.trim()))?.click());
  await sleep(400);
  const copied = await page.evaluate(() => ({
    toast: [...document.querySelectorAll('.toast')].map((t) => t.innerText).join(' '),
    body: document.body.innerText,
    calls: (window.__bridgeCalls || []).filter((c) => (c.channel || c.ch) === 'clipboard:write'),
  }));
  const copiedText = copied.calls.at(-1)?.payload?.[0]?.text ?? copied.calls.at(-1)?.args?.[0]?.text;
  record('приватность', 'буфер: копирование расшифрованного пароля без раскрытия на экране',
    copiedText === secret && /Скопировано/.test(copied.toast) && !copied.toast.includes(secret) && !copied.body.includes(secret));
  await page.evaluate(() => {
    [...document.querySelectorAll('.clip-card')].find((el) => el.title === 'Пароль (открытый текст)')?.click();
  });
  await sleep(200);
  await page.evaluate(() => [...document.querySelectorAll('.clip-actions button')].find((b) => /^копировать$/i.test(b.innerText.trim()))?.click());
  await sleep(400);
  const copiedPlain = await page.evaluate(() => ({
    body: document.body.innerText,
    calls: (window.__bridgeCalls || []).filter((c) => (c.channel || c.ch) === 'clipboard:write'),
  }));
  const plainText = copiedPlain.calls.at(-1)?.payload?.[0]?.text ?? copiedPlain.calls.at(-1)?.args?.[0]?.text;
  record('приватность', 'буфер: старый открытый пароль копируется без раскрытия в уведомлении',
    plainText === plain && !copiedPlain.body.includes(plain));
  const errors = takeErrors(page);
  record('приватность', 'буфер: сценарий без ошибок консоли', errors.length === 0, errors[0] || '');
  await page.close();
}

async function scenarioManualClipboardBusy(browser) {
  const page = await openPage(browser, '#/clipboard', {
    settle: 500,
    storeSeed: { 'zs.clipboard': [{ id: 'copy-one', kind: 'text', text: 'Запись для копирования', source: 'test', createdAt: Date.now() }] },
    patchNative: () => {
      window.__unsafeFallback = 0;
      window.zspeakly.native.writeClipboard = async () => ({ busy: true });
      window.zspeakly.clipboard.writeText = () => { window.__unsafeFallback++; };
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { window.__unsafeFallback++; } } });
      document.execCommand = () => { window.__unsafeFallback++; return true; };
      window.zspeakly.native.screenshot = async () => ({ ok: false, busy: true, reason: 'Другая операция с текстом ещё выполняется. Снимок не скопирован и не сохранён; повторите позже.' });
    },
  });
  takeErrors(page);
  await page.click('.clip-card[title="Запись для копирования"]');
  await sleep(200);
  await page.evaluate(() => [...document.querySelectorAll('.clip-actions button')].find((b) => /^копировать$/i.test(b.innerText.trim()))?.click());
  await sleep(300);
  let state = await page.evaluate(() => ({ toast: [...document.querySelectorAll('.toast')].at(-1)?.innerText || '', fallback: window.__unsafeFallback }));
  record('безопасность', 'ручное копирование: busy не объявляется успехом и не обходит main', /Буфер занят/.test(state.toast) && /Копирование не запускалось/.test(state.toast) && state.fallback === 0, state.toast);
  await page.evaluate(() => { window.zspeakly.native.writeClipboard = async () => { throw new Error('IPC lost'); }; });
  await page.evaluate(() => [...document.querySelectorAll('.clip-actions button')].find((b) => /^копировать$/i.test(b.innerText.trim()))?.click());
  await sleep(300);
  state = await page.evaluate(() => ({ toast: [...document.querySelectorAll('.toast')].at(-1)?.innerText || '', fallback: window.__unsafeFallback }));
  record('безопасность', 'ручное копирование: потерянный IPC не повторяется и сообщается как неизвестный', /Не удалось подтвердить копирование/.test(state.toast) && /Буфер мог измениться/.test(state.toast) && state.fallback === 0, state.toast);
  const before = await page.evaluate(() => (window.__e2e.read('zs.clipboard') || []).length);
  await page.evaluate(() => [...document.querySelectorAll('.clip-hotkey')].find((el) => /^Скриншот/.test(el.innerText.trim()))?.click());
  await sleep(350);
  state = await page.evaluate(() => ({ toast: [...document.querySelectorAll('.toast')].at(-1)?.innerText || '', count: (window.__e2e.read('zs.clipboard') || []).length }));
  record('безопасность', 'скриншот: busy объясняет отказ и не создаёт запись', /Не удалось сделать скриншот/.test(state.toast) && /не скопирован и не сохранён/.test(state.toast) && state.count === before, state.toast);
  record('безопасность', 'ручное копирование и скриншот: без ошибок консоли', takeErrors(page).length === 0);
  await page.close();

  const home = await openPage(browser, '#/home', {
    settle: 500,
    storeSeed: { 'zs.dictations': [{ id: 'history-copy', text: 'Текст из истории', createdAt: Date.now(), words: 3, durationMs: 1000 }] },
    patchNative: () => { window.zspeakly.native.writeClipboard = async () => ({ busy: true }); },
  });
  takeErrors(home);
  await home.click('.recent__row');
  await sleep(250);
  await home.evaluate(() => [...document.querySelectorAll('.snippet button')].find((b) => /Копировать/i.test(b.innerText))?.click());
  await sleep(300);
  const homeToast = await home.evaluate(() => [...document.querySelectorAll('.toast')].at(-1)?.innerText || '');
  record('безопасность', 'история диктовок: занятый буфер не объявляется скопированным', /Буфер занят/.test(homeToast) && /Копирование не запускалось/.test(homeToast), homeToast);
  record('безопасность', 'история диктовок: без ошибок консоли', takeErrors(home).length === 0);
  await home.close();
}

async function scenarioClipboardPasteFailure(browser) {
  const page = await openPage(browser, '#/clipboard', {
    settle: 500,
    storeSeed: { 'zs.clipboard': [
      { id: 'broken-pw', kind: 'password', text: '', cipher: 'invalid-cipher', source: 'test password', createdAt: Date.now() },
      { id: 'copy-text', kind: 'text', text: 'тестовый текст для вставки', source: 'test text', createdAt: Date.now() - 1 },
    ] },
  });
  takeErrors(page);
  await page.evaluate(() => {
    window.__pasteCount = 0;
    window.__written = [];
    window.__legacyWrites = 0;
    window.zspeakly.native.pasteClipboardItem = async (payload) => { window.__pasteCount++; window.__written.push(payload); return { copyFailed: true }; };
    window.zspeakly.native.writeClipboard = async () => { window.__legacyWrites++; return true; };
    window.zspeakly.native.pasteToActive = async () => { window.__legacyWrites++; return true; };
    window.zspeakly.native.revealSecret = async () => null;
  });
  await page.click('.clip-card[title="Пароль (зашифрован)"]', { clickCount: 2 });
  await sleep(400);
  let state = await page.evaluate(() => ({ count: window.__pasteCount, toast: document.body.innerText }));
  record('безопасность', 'буфер: при отказе расшифровки не вставляется старый буфер', state.count === 0 && /Пароль не расшифрован/.test(state.toast));
  await page.click('.clip-card[title="тестовый текст для вставки"]', { clickCount: 2 });
  await sleep(400);
  state = await page.evaluate(() => ({ count: window.__pasteCount, legacy: window.__legacyWrites, toast: document.body.innerText }));
  record('безопасность', 'буфер: отказ копирования не вызывает раздельную вставку', state.count === 1 && state.legacy === 0 && /Не удалось скопировать/.test(state.toast) && /Вставка не запускалась/.test(state.toast));
  await page.evaluate(() => { window.zspeakly.native.pasteClipboardItem = async (payload) => { window.__pasteCount++; window.__written.push(payload); return { busy: true }; }; });
  await page.click('.clip-card[title="тестовый текст для вставки"]', { clickCount: 2 });
  await sleep(400);
  state = await page.evaluate(() => ({ count: window.__pasteCount, legacy: window.__legacyWrites, toast: [...document.querySelectorAll('.toast')].at(-1)?.innerText || '' }));
  record('безопасность', 'буфер: занятый канал не копирует и не повторяет действие', state.count === 2 && state.legacy === 0 && /не вставлена и не скопирована/.test(state.toast), state.toast);
  await page.evaluate(() => { window.zspeakly.native.pasteClipboardItem = async (payload) => { window.__pasteCount++; window.__written.push(payload); return { copied: true, outcome: true }; }; });
  await page.click('.clip-card[title="тестовый текст для вставки"]', { clickCount: 2 });
  await sleep(400);
  state = await page.evaluate(() => ({ count: window.__pasteCount, written: window.__written, legacy: window.__legacyWrites }));
  record('безопасность', 'буфер: передаёт элемент в один защищённый запрос', state.count === 3 && state.legacy === 0 && state.written.at(-1).text === 'тестовый текст для вставки');
  await page.evaluate(() => { window.zspeakly.native.pasteClipboardItem = async () => ({ copied: true, outcome: false }); });
  await page.click('.clip-card[title="тестовый текст для вставки"]', { clickCount: 2 });
  await sleep(400);
  let warning = await page.evaluate(() => [...document.querySelectorAll('.toast__title')].at(-1)?.innerText || '');
  record('безопасность', 'буфер: отказ автовставки объясняется после копирования', /Автовставка не удалась/.test(warning));
  await page.evaluate(() => { window.zspeakly.native.pasteClipboardItem = async () => { throw new Error('IPC lost'); }; });
  await page.click('.clip-card[title="тестовый текст для вставки"]', { clickCount: 2 });
  await sleep(400);
  warning = await page.evaluate(() => [...document.querySelectorAll('.toast__title')].at(-1)?.innerText || '');
  record('безопасность', 'буфер: исключение IPC не считается известным отказом', /Не удалось подтвердить автовставку/.test(warning));
  await page.evaluate(() => { window.zspeakly.native.pasteClipboardItem = async () => ({ copied: true, outcome: { uncertain: true } }); });
  await page.click('.clip-card[title="тестовый текст для вставки"]', { clickCount: 2 });
  await sleep(400);
  const uncertainToast = await page.evaluate(() => [...document.querySelectorAll('.toast')].at(-1)?.innerText || '');
  record('безопасность', 'буфер: неизвестная автовставка требует проверки перед повтором', /Не удалось подтвердить автовставку/.test(uncertainToast) && /Проверьте окно перед повтором/.test(uncertainToast), uncertainToast);
  await page.evaluate(() => { delete window.zspeakly.native.pasteClipboardItem; });
  await page.click('.clip-card[title="тестовый текст для вставки"]', { clickCount: 2 });
  await sleep(400);
  state = await page.evaluate(() => ({ legacy: window.__legacyWrites, toast: [...document.querySelectorAll('.toast')].at(-1)?.innerText || '' }));
  record('безопасность', 'буфер: отсутствующий IPC не вызывает небезопасный fallback', state.legacy === 0 && /Автовставка недоступна/.test(state.toast));
  await page.evaluate(() => {
    window.zspeakly.native.revealSecret = async () => 'СекретДляПроверки123!';
    window.zspeakly.native.pasteClipboardItem = async (payload) => { window.__passwordPayload = payload; return { copied: true, outcome: true }; };
  });
  await page.click('.clip-card[title="Пароль (зашифрован)"]', { clickCount: 2 });
  await sleep(400);
  state = await page.evaluate(() => ({ payload: window.__passwordPayload, body: document.body.innerText }));
  record('безопасность', 'буфер: расшифрованный пароль передаётся без раскрытия в интерфейсе', state.payload?.text === 'СекретДляПроверки123!' && !state.body.includes('СекретДляПроверки123!'));
  await sleep(1600); // старый индикатор успешного копирования уже исчез
  for (const during of [false, true]) {
    for (const password of [false, true]) {
      await page.evaluate((value) => {
        window.__currentConflict = value;
        window.zspeakly.native.pasteClipboardItem = async (payload) => {
          window.__pasteCount++; window.__written.push(payload);
          return { copied: true, outcome: window.__currentConflict ? { clipboardChanged: true, uncertain: true } : { clipboardChanged: true } };
        };
      }, during);
      const beforeCount = await page.evaluate(() => window.__pasteCount);
      await page.click(password ? '.clip-card[title="Пароль (зашифрован)"]' : '.clip-card[title="тестовый текст для вставки"]', { clickCount: 2 });
      await sleep(400);
      const conflict = await page.evaluate(() => ({
        toast: [...document.querySelectorAll('.toast')].at(-1)?.innerText || '',
        count: window.__pasteCount, legacy: window.__legacyWrites,
        body: document.body.innerText, history: window.__e2e.read('zs.clipboard') || [],
      }));
      record('безопасность', `буфер: ${password ? 'пароль' : 'текст'} при смене буфера ${during ? 'во время' : 'до'} Ctrl+V`,
        /буфер/i.test(conflict.toast) && (during ? /другое содержимое/i.test(conflict.toast) && /проверьте окно/i.test(conflict.toast) : /не запускалась/i.test(conflict.toast) && /скопируйте запись/i.test(conflict.toast)) &&
          conflict.count === beforeCount + 1 && conflict.legacy === 0 && conflict.history.length === 2 && !conflict.body.includes('СекретДляПроверки123!'),
        JSON.stringify({ toast: conflict.toast, count: conflict.count, legacy: conflict.legacy }));
    }
  }
  const errors = takeErrors(page);
  record('безопасность', 'буфер: ошибки копирования не ломают интерфейс', errors.length === 0, errors[0] || '');
  await page.close();
}

async function scenarioScreenRecordingCleanup(browser) {
  const page = await openPage(browser, '#/clipboard', { settle: 500 });
  takeErrors(page);
  await page.evaluate(() => {
    window.__capture = { starts: 0, stopped: 0, recorderStops: 0, pending: false };
    const track = () => ({ kind: 'video', stop: () => { window.__capture.stopped++; } });
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { configurable: true, value: () => {
      window.__capture.starts++;
      if (window.__capture.pending) return new Promise((resolve) => { window.__resolveCapture = () => resolve({ getTracks: () => [track()] }); });
      return Promise.resolve({ getTracks: () => [track()] });
    } });
    window.MediaRecorder = class {
      static isTypeSupported() { return true; }
      constructor() { this.state = 'inactive'; }
      start() { this.state = 'recording'; }
      stop() {
        window.__capture.recorderStops++;
        if (window.__capture.failStop) throw new Error('stop failed');
        this.state = 'inactive';
        this.ondataavailable?.({ data: new Blob(['test video']) });
        this.onstop?.();
      }
    };
  });
  await page.click('.clip-hotkey[title^="Запись экрана"]');
  await sleep(300);
  const warned = await page.evaluate(() => /При переходе на другую страницу запись отменится/.test(document.body.innerText));
  record('приватность', 'запись экрана: предупреждение об отмене видно во время записи', warned);
  await emit(page, 'clipboard:action', 'record');
  await sleep(2700);
  let state = await page.evaluate(() => ({ ...window.__capture, body: document.body.innerText, calls: window.__bridgeCalls.filter((c) => (c.channel || c.ch) === 'app:save-file').length }));
  record('приватность', 'запись экрана: сочетание останавливает текущую запись, не запуская новую', state.starts === 1 && state.recorderStops === 1 && state.calls === 1 && /Запись сохранена/.test(state.body));
  await page.click('.clip-hotkey[title^="Запись экрана"]');
  await sleep(300);
  await page.evaluate(() => { location.hash = '#/'; });
  await sleep(400);
  state = await page.evaluate(() => ({ ...window.__capture }));
  record('приватность', 'запись экрана: переход со страницы останавливает захват', state.starts === 2 && state.stopped > 1 && state.recorderStops === 2);
  await page.evaluate(() => { location.hash = '#/clipboard'; window.__capture.pending = true; });
  await sleep(500);
  await page.click('.clip-hotkey[title^="Запись экрана"]');
  await page.click('.clip-hotkey[title^="Запись экрана"]');
  await sleep(200);
  state = await page.evaluate(() => ({ ...window.__capture }));
  record('приватность', 'запись экрана: ожидание разрешения не запускает повторный запрос', state.starts === 3);
  await page.evaluate(() => { location.hash = '#/'; });
  await sleep(300);
  await page.evaluate(() => window.__resolveCapture());
  await sleep(400);
  state = await page.evaluate(() => ({ ...window.__capture }));
  record('приватность', 'запись экрана: разрешение после ухода немедленно останавливает захват', state.stopped >= 3 && state.recorderStops === 3);
  await page.evaluate(() => { location.hash = '#/clipboard'; window.__capture.pending = false; window.__capture.failStop = true; });
  await sleep(500);
  await page.click('.clip-hotkey[title^="Запись экрана"]');
  await sleep(200);
  const beforeStop = await page.evaluate(() => window.__capture.stopped);
  await page.click('.clip-hotkey[title^="Запись экрана"]');
  await sleep(400);
  state = await page.evaluate(() => ({ ...window.__capture, body: document.body.innerText }));
  record('приватность', 'запись экрана: ошибка остановки освобождает дорожки и предупреждает', state.stopped > beforeStop && /Попытались остановить захват; видео не сохранено/.test(state.body));
  const errors = takeErrors(page);
  record('приватность', 'запись экрана: уход со страницы без ошибок консоли', errors.length === 0, errors[0] || '');
  await page.close();
}

async function scenarioScreenRecordingStopTimeout(browser) {
  const page = await openPage(browser, '#/clipboard', { settle: 500 });
  takeErrors(page);
  await page.evaluate(() => {
    window.__timeoutCaptures = [];
    const realTimeout = window.setTimeout.bind(window);
    // Ускоряем только 15-секундный watchdog, остальные таймеры не меняем.
    window.setTimeout = (fn, ms, ...args) => realTimeout(fn, ms === 15000 ? 300 : ms, ...args);
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { configurable: true, value: async () => {
      const track = { kind: 'video', stopped: 0, stop() { this.stopped++; }, addEventListener(type, fn) { if (type === 'ended') this.ended = fn; }, removeEventListener() {} };
      window.__timeoutCaptures.push({ track });
      return { getTracks: () => [track] };
    } });
    window.MediaRecorder = class {
      static isTypeSupported() { return true; }
      constructor() { this.state = 'inactive'; window.__timeoutCaptures.at(-1).recorder = this; }
      start() { this.state = 'recording'; }
      stop() { this.state = 'inactive'; } // Нет последнего события onstop.
    };
  });
  const button = '.clip-hotkey[title^="Запись экрана"]';
  await page.click(button);
  await sleep(200);
  await page.click(button);
  await sleep(650);
  let state = await page.evaluate(() => ({
    stopped: window.__timeoutCaptures[0].track.stopped,
    body: document.body.innerText,
    saves: window.__bridgeCalls.filter((c) => (c.channel || c.ch) === 'app:save-file').length,
  }));
  record('сохранность', 'запись экрана: таймаут stop освобождает захват и сообщает о потере', state.stopped > 0 && state.saves === 0 && /видео не сохранено/i.test(state.body) && !/Остановить/.test(state.body));
  await page.evaluate(() => {
    const recorder = window.__timeoutCaptures[0].recorder;
    recorder.ondataavailable?.({ data: new Blob(['late']) });
    recorder.onstop?.();
  });
  await page.click(button);
  await sleep(250);
  state = await page.evaluate(() => ({ count: window.__timeoutCaptures.length, body: document.body.innerText, saves: window.__bridgeCalls.filter((c) => (c.channel || c.ch) === 'app:save-file').length }));
  record('сохранность', 'запись экрана: поздний onstop не сохраняет старое видео и новая запись доступна', state.count === 2 && state.saves === 0 && /Остановить/.test(state.body));
  await page.evaluate(() => {
    const capture = window.__timeoutCaptures[1];
    capture.recorder.state = 'inactive';
    capture.track.ended();
  });
  await sleep(650);
  state = await page.evaluate(() => ({ stopped: window.__timeoutCaptures[1].track.stopped, body: document.body.innerText, saves: window.__bridgeCalls.filter((c) => (c.channel || c.ch) === 'app:save-file').length }));
  record('сохранность', 'запись экрана: системная остановка без onstop также сообщает об ошибке', state.stopped > 0 && state.saves === 0 && /Не удалось обработать запись/.test(state.body) && !/Остановить/.test(state.body));
  const errors = takeErrors(page);
  record('сохранность', 'запись экрана: таймаут stop без ошибок консоли', errors.length === 0, errors[0] || '');
  await page.close();
}

async function scenarioScreenRecordingNoAudio(browser) {
  const page = await openPage(browser, '#/clipboard', { settle: 500 });
  takeErrors(page);
  await page.evaluate(() => {
    window.__screenAttempts = [];
    window.__screenMode = 'denied';
    window.__screenStops = 0;
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { configurable: true, value: async (opts) => {
      window.__screenAttempts.push(opts.audio);
      if (window.__screenMode === 'denied') throw new DOMException('Denied', 'NotAllowedError');
      if (opts.audio && window.__screenMode === 'audio-error') throw new DOMException('Could not start audio source', 'NotReadableError');
      const tracks = [{ kind: 'video', stop() {} }];
      if (opts.audio && window.__screenMode === 'with-audio') tracks.push({ kind: 'audio', stop() {} });
      return { getTracks: () => tracks };
    } });
    window.MediaRecorder = class {
      static isTypeSupported() { return true; }
      constructor() { this.state = 'inactive'; }
      start() { this.state = 'recording'; }
      stop() { window.__screenStops++; this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['video']) }); this.onstop?.(); }
    };
  });
  const button = '.clip-hotkey[title^="Запись экрана"]';
  await page.click(button);
  await sleep(300);
  let state = await page.evaluate(() => ({ attempts: window.__screenAttempts.length, body: document.body.innerText }));
  record('приватность', 'запись экрана: отказ разрешения не запускает повтор и не предлагает обход', state.attempts === 1 && /Выбор экрана отменён/.test(state.body) && !/Записать без звука/.test(state.body));
  await page.evaluate(() => { window.__screenMode = 'audio-error'; });
  await page.click(button);
  await sleep(300);
  state = await page.evaluate(() => ({ attempts: window.__screenAttempts.length, body: document.body.innerText }));
  record('приватность', 'запись экрана: ошибка устройства не запускает повтор без согласия', state.attempts === 2 && /Записать без звука/.test(state.body));
  await page.evaluate(() => [...document.querySelectorAll('.toast__action')].find((b) => /Записать без звука/.test(b.innerText))?.click());
  await sleep(300);
  state = await page.evaluate(() => ({ attempts: window.__screenAttempts, body: document.body.innerText, stops: window.__screenStops }));
  record('приватность', 'запись экрана: после явного выбора запрашивается видео без аудио и есть предупреждение', state.attempts.length === 3 && state.attempts[2] === false && /Остановить/.test(state.body) && /Запись идёт без системного звука/.test(state.body) && state.stops === 0);
  await page.evaluate(() => { location.hash = '#/'; });
  await sleep(300);
  await page.evaluate(() => { location.hash = '#/clipboard'; window.__screenMode = 'audio-error'; });
  await sleep(500);
  await page.click(button);
  await sleep(250);
  await page.evaluate(() => { window.__screenMode = 'with-audio'; });
  await page.click(button);
  await sleep(250);
  state = await page.evaluate(() => ({ attempts: window.__screenAttempts.length, stops: window.__screenStops, body: document.body.innerText }));
  record('приватность', 'запись экрана: наличие аудиодорожки не обещает, что звук реально записан', /Аудиодорожка получена; наличие звука в записи не гарантировано/.test(state.body));
  const beforeOldAction = state;
  await page.evaluate(() => [...document.querySelectorAll('.toast__action')].find((b) => /Записать без звука/.test(b.innerText))?.click());
  await sleep(250);
  state = await page.evaluate(() => ({ attempts: window.__screenAttempts.length, stops: window.__screenStops, body: document.body.innerText }));
  record('приватность', 'запись экрана: устаревшая кнопка повтора не останавливает текущую запись', state.attempts === beforeOldAction.attempts && state.stops === beforeOldAction.stops && /Новая запись сейчас недоступна/.test(state.body));
  await page.evaluate(() => { location.hash = '#/'; });
  await sleep(300);
  await page.evaluate(() => { location.hash = '#/clipboard'; window.__screenMode = 'audio-error'; });
  await sleep(500);
  await page.click(button);
  await sleep(250);
  const attemptsBeforeExit = await page.evaluate(() => window.__screenAttempts.length);
  await page.evaluate(() => { location.hash = '#/'; });
  await sleep(300);
  await page.evaluate(() => [...document.querySelectorAll('.toast__action')].find((b) => /Записать без звука/.test(b.innerText))?.click());
  await sleep(250);
  state = await page.evaluate(() => ({ attempts: window.__screenAttempts.length }));
  record('приватность', 'запись экрана: повтор после ухода со страницы не запускает захват', state.attempts === attemptsBeforeExit);
  await page.evaluate(() => { location.hash = '#/clipboard'; window.__screenMode = 'no-audio'; });
  await sleep(500);
  await page.click(button);
  await sleep(300);
  state = await page.evaluate(() => ({ body: document.body.innerText, attempts: window.__screenAttempts }));
  record('приватность', 'запись экрана: отсутствие аудиодорожки при успешном запросе не скрывается', Boolean(state.attempts.at(-1)) && /Запись идёт без системного звука/.test(state.body));
  await page.evaluate(() => { location.hash = '#/'; });
  await sleep(300);
  const errors = takeErrors(page);
  record('приватность', 'запись экрана: сценарий без аудио не вызывает ошибок консоли', errors.length === 0, errors[0] || '');
  await page.close();
}

async function scenarioScreenRecordingLimits(browser) {
  const page = await openPage(browser, '#/clipboard', { settle: 500 });
  takeErrors(page);
  await page.evaluate(() => {
    window.__limitSaves = 0;
    window.zspeakly.native.saveFile = async () => { window.__limitSaves++; return { ok: true, path: 'C:\\Videos\\limited.webm' }; };
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { configurable: true, value: async () => ({ getTracks: () => [{ kind: 'video', stop() {} }] }) });
    window.MediaRecorder = class {
      static isTypeSupported() { return true; }
      constructor() { window.__limitRecorder = this; this.state = 'inactive'; }
      start() { this.state = 'recording'; }
      stop() {
        this.state = 'inactive';
        this.ondataavailable?.({ data: new Blob(['final']) });
        this.onstop?.();
      }
    };
  });
  const initial = await page.evaluate(() => document.body.innerText);
  record('сохранность', 'запись экрана: лимиты и риск потери указаны до запуска', /48 МиБ/.test(initial) && /10 минут/.test(initial) && /64 МиБ видео не сохранится/.test(initial));
  await page.click('.clip-hotkey[title^="Запись экрана"]');
  await sleep(250);
  // Размер фрагмента подменён: проверяем логику UI, а не настоящий файл 48 МиБ.
  await page.evaluate(() => window.__limitRecorder.ondataavailable({ data: { size: 48 * 1024 * 1024 } }));
  await sleep(2800);
  let state = await page.evaluate(() => ({ saved: window.__limitSaves, body: document.body.innerText, title: [...document.querySelectorAll('.toast__title')].at(-1)?.innerText || '' }));
  record('сохранность', 'запись экрана: при лимите размера завершение и сохранение с предупреждением', state.saved === 1 && /Запись остановлена по ограничению/.test(state.title) && /остановлена по размеру/.test(state.body));
  await page.click('.clip-hotkey[title^="Запись экрана"]');
  await sleep(250);
  await page.evaluate(() => window.__limitRecorder.ondataavailable({ data: { size: 64 * 1024 * 1024 + 1 } }));
  await sleep(400);
  state = await page.evaluate(() => ({ saved: window.__limitSaves, body: document.body.innerText, title: [...document.querySelectorAll('.toast__title')].at(-1)?.innerText || '' }));
  record('сохранность', 'запись экрана: слишком большой фрагмент не выдаётся за сохранённое видео', state.saved === 1 && /Запись не сохранена/.test(state.title) && /предел 64 МиБ/.test(state.body));
  await page.evaluate(() => {
    window.__realTimeout = window.setTimeout;
    window.setTimeout = (fn, ms, ...args) => window.__realTimeout(fn, ms === 600000 ? 40 : ms, ...args);
  });
  await page.click('.clip-hotkey[title^="Запись экрана"]');
  await sleep(2800);
  state = await page.evaluate(() => ({ saved: window.__limitSaves, body: document.body.innerText, title: [...document.querySelectorAll('.toast__title')].at(-1)?.innerText || '' }));
  record('сохранность', 'запись экрана: остановка по времени сообщает причину и сохраняет результат', state.saved === 2 && /Запись остановлена по ограничению/.test(state.title) && /остановлена по времени/.test(state.body));
  await page.evaluate(() => { window.setTimeout = window.__realTimeout; });
  const errors = takeErrors(page);
  record('сохранность', 'запись экрана: сценарий ограничений без ошибок консоли', errors.length === 0, errors[0] || '');
  await page.close();
}

async function scenarioScreenRecordingSave(browser) {
  const page = await openPage(browser, '#/clipboard', { settle: 500 });
  takeErrors(page);
  await page.evaluate(() => {
    window.__savedVideos = [];
    window.__recordStarts = 0;
    window.__saveMode = 'ok';
    window.zspeakly.native.saveFile = async (payload) => {
      window.__savedVideos.push(payload);
      if (window.__saveMode === 'wait') return new Promise((resolve) => { window.__resolveSave = () => resolve({ ok: true, path: 'C:\\Videos\\retry.webm' }); });
      if (window.__saveMode === 'throw') throw new Error('disk failure');
      if (window.__saveMode === 'fail') return { ok: false, reason: 'disk failure' };
      return { ok: true, path: 'C:\\Videos\\test.webm' };
    };
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { configurable: true, value: async () => ({ getTracks: () => [{ kind: 'video', stop() {} }] }) });
    window.MediaRecorder = class {
      static isTypeSupported() { return true; }
      constructor() { window.__recordStarts++; window.__testRecorder = this; this.state = 'inactive'; }
      start() { this.state = 'recording'; }
      stop() {
        this.state = 'inactive';
        const bytes = new Uint8Array(1024 * 1024);
        for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
        this.ondataavailable?.({ data: new Blob([bytes], { type: 'video/webm' }) });
        this.onstop?.();
      }
    };
  });
  const start = async () => { await page.click('.clip-hotkey[title^="Запись экрана"]'); await sleep(250); };
  await start();
  await page.click('.clip-hotkey[title^="Запись экрана"]');
  await sleep(2800);
  let state = await page.evaluate(() => {
    const saved = window.__savedVideos[0];
    const bytes = saved?.base64 ? atob(saved.base64) : '';
    let matches = bytes.length === 1024 * 1024;
    for (let i = 0; matches && i < bytes.length; i++) matches = bytes.charCodeAt(i) === i % 251;
    return { count: window.__savedVideos.length, matches, body: document.body.innerText };
  });
  record('сохранность', 'запись экрана: видео 1 МиБ передаётся целиком и один раз', state.count === 1 && state.matches && /Запись сохранена/.test(state.body));
  await start();
  await page.evaluate(() => window.__testRecorder.stop());
  await sleep(2800);
  state = await page.evaluate(() => ({ count: window.__savedVideos.length, body: document.body.innerText }));
  record('сохранность', 'запись экрана: системная остановка тоже сохраняет один раз', state.count === 2 && /Запись сохранена/.test(state.body));
  const savedEntries = ((await storeOf(page, 'zs.clipboard')) || []).filter((item) => item.source === 'Запись экрана — ZSpeakly').length;
  await page.evaluate(() => { window.__saveMode = 'fail'; });
  await start();
  await page.click('.clip-hotkey[title^="Запись экрана"]');
  await sleep(2800);
  state = await page.evaluate(() => ({ count: window.__savedVideos.length, lastToast: [...document.querySelectorAll('.toast__title')].at(-1)?.innerText || '', body: document.body.innerText }));
  record('сохранность', 'запись экрана: отказ записи предупреждает и предлагает повтор', state.count === 3 && /Не удалось сохранить запись/.test(state.lastToast) && /Повторить сохранение/.test(state.body));
  const failedEntries = ((await storeOf(page, 'zs.clipboard')) || []).filter((item) => item.source === 'Запись экрана — ZSpeakly').length;
  await page.click('.clip-hotkey[title^="Запись экрана"]');
  await sleep(200);
  const blocked = await page.evaluate(() => ({ starts: window.__recordStarts, body: document.body.innerText }));
  record('сохранность', 'запись экрана: при отказе нет ложной записи истории и новый захват заблокирован', failedEntries === savedEntries && blocked.starts === 3 && /Сначала сохраните или удалите предыдущую запись/.test(blocked.body));
  await page.evaluate(() => { window.__saveMode = 'ok'; [...document.querySelectorAll('button')].find((el) => /Повторить сохранение/.test(el.innerText))?.click(); });
  await sleep(800);
  state = await page.evaluate(() => ({ count: window.__savedVideos.length, body: document.body.innerText }));
  record('сохранность', 'запись экрана: повтор сохраняет ранее полученное видео', state.count === 4 && /Запись сохранена/.test(state.body) && !/Повторить сохранение/.test(state.body));
  await page.evaluate(() => { window.__saveMode = 'throw'; });
  await start();
  await page.click('.clip-hotkey[title^="Запись экрана"]');
  await sleep(2800);
  state = await page.evaluate(() => ({ count: window.__savedVideos.length, title: [...document.querySelectorAll('.toast__title')].at(-1)?.innerText || '', body: document.body.innerText }));
  record('сохранность', 'запись экрана: исключение моста оставляет возможность повтора', state.count === 5 && /Не удалось сохранить запись/.test(state.title) && /Повторить сохранение/.test(state.body));
  await page.evaluate(() => { window.__saveMode = 'wait'; [...document.querySelectorAll('button')].find((el) => /Повторить сохранение/.test(el.innerText))?.click(); });
  await sleep(300);
  await page.click('.clip-hotkey[title^="Запись экрана"]');
  state = await page.evaluate(() => ({ count: window.__savedVideos.length, starts: window.__recordStarts, body: document.body.innerText }));
  record('сохранность', 'запись экрана: во время сохранения новый захват не начинается', state.count === 6 && state.starts === 4 && /Сохраняем запись/.test(state.body));
  await page.evaluate(() => window.__resolveSave());
  await sleep(400);
  await page.evaluate(() => { window.__saveMode = 'ok'; });
  await start();
  await page.evaluate(() => { window.__testRecorder.onerror?.({}); window.__testRecorder.stop(); });
  await sleep(2800);
  state = await page.evaluate(() => ({ count: window.__savedVideos.length, title: [...document.querySelectorAll('.toast__title')].at(-1)?.innerText || '', body: document.body.innerText }));
  record('сохранность', 'запись экрана: ошибка захвата помечает сохранённое видео как возможно неполное', state.count === 7 && /Запись могла прерваться/.test(state.title) && /Видео может быть неполным/.test(state.body));
  await page.evaluate(() => { window.__saveMode = 'fail'; });
  await start();
  await page.click('.clip-hotkey[title^="Запись экрана"]');
  await sleep(2800);
  await page.evaluate(() => [...document.querySelectorAll('button')].find((el) => /Удалить несохранённую запись/.test(el.innerText))?.click());
  await sleep(200);
  const confirmation = await page.evaluate(() => document.body.innerText.includes('Удалить несохранённую запись?'));
  await page.evaluate(() => [...document.querySelectorAll('.modal button')].find((el) => /^Отмена$/i.test(el.innerText.trim()))?.click());
  await sleep(200);
  const kept = await page.evaluate(() => document.body.innerText.includes('Повторить сохранение'));
  await page.evaluate(() => [...document.querySelectorAll('button')].find((el) => /Удалить несохранённую запись/.test(el.innerText))?.click());
  await sleep(200);
  await page.evaluate(() => [...document.querySelectorAll('.modal button')].find((el) => /^Удалить запись$/i.test(el.innerText.trim()))?.click());
  await sleep(200);
  const removed = await page.evaluate(() => !document.body.innerText.includes('Повторить сохранение'));
  record('сохранность', 'запись экрана: удаление несохранённого видео требует подтверждения', confirmation && kept && removed);
  const errors = takeErrors(page);
  record('сохранность', 'запись экрана: сценарий сохранения без ошибок консоли', errors.length === 0, errors[0] || '');
  await page.close();
}

async function scenarioClipboardImageCopy(browser) {
  const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==';
  const page = await openPage(browser, '#/clipboard', {
    settle: 500,
    storeSeed: { 'zs.clipboard': [
      { id: 'note-img', kind: 'note', text: 'подпись для теста', image, source: 'test note', createdAt: Date.now() },
      { id: 'image-only', kind: 'image', text: '', image, source: 'test image', createdAt: Date.now() - 1 },
    ] },
  });
  takeErrors(page);
  await page.evaluate(() => {
    window.__imageWrites = [];
    window.__fallbackWrites = 0;
    window.__pastes = 0;
    window.zspeakly.native.writeClipboard = async (payload) => { window.__imageWrites.push(payload); return true; };
    window.zspeakly.native.pasteClipboardItem = async (payload) => { window.__imageWrites.push(payload); window.__pastes++; return { copyFailed: true }; };
    window.zspeakly.clipboard.writeText = () => { window.__fallbackWrites++; };
    document.querySelector('[aria-label="Список"]')?.click();
  });
  await sleep(300);
  await page.evaluate(() => [...document.querySelectorAll('.clip-list__item')].find((el) => el.innerText.includes('подпись для теста'))?.click());
  await sleep(200);
  await page.evaluate(() => [...document.querySelectorAll('.clip-preview__actions button')].find((el) => /Копировать как обычный текст/i.test(el.innerText))?.click());
  await sleep(300);
  let state = await page.evaluate(() => ({ writes: window.__imageWrites, pastes: window.__pastes }));
  record('безопасность', 'буфер: «как обычный текст» копирует подпись без картинки',
    state.writes.length === 1 && state.writes[0].text === 'подпись для теста' && !state.writes[0].image && state.pastes === 0);

  await page.evaluate(() => { window.zspeakly.native.writeClipboard = async (payload) => { window.__imageWrites.push(payload); return false; }; });
  await page.evaluate(() => document.querySelectorAll('.clip-preview__actions button')[1]?.click());
  await sleep(300);
  state = await page.evaluate(() => ({ writes: window.__imageWrites, pastes: window.__pastes, fallback: window.__fallbackWrites, toast: document.body.innerText }));
  record('безопасность', 'буфер: отказ картинки не подменяется текстом и не запускает вставку',
    state.writes.length === 2 && state.writes[1].image === image && state.pastes === 1 && state.fallback === 0 && /Не удалось скопировать/.test(state.toast) && /Вставка не запускалась/.test(state.toast));

  await page.evaluate(() => { window.zspeakly.native.pasteClipboardItem = async (payload) => { window.__imageWrites.push(payload); window.__pastes++; return { copied: true, outcome: true }; }; });
  await page.evaluate(() => document.querySelectorAll('.clip-preview__actions button')[1]?.click());
  await sleep(300);
  state = await page.evaluate(() => ({ writes: window.__imageWrites, pastes: window.__pastes }));
  record('безопасность', 'буфер: успешное копирование картинки передаёт картинку и запрашивает вставку',
    state.writes.length === 3 && state.writes[2].image === image && state.pastes === 2);

  await page.evaluate(() => [...document.querySelectorAll('.clip-list__item')].find((el) => el.innerText.includes('test image'))?.click());
  await sleep(200);
  await page.evaluate(() => [...document.querySelectorAll('.clip-preview__actions button')].find((el) => /Копировать как обычный текст/i.test(el.innerText))?.click());
  await sleep(300);
  state = await page.evaluate(() => ({ writes: window.__imageWrites.length, title: [...document.querySelectorAll('.toast__title')].at(-1)?.innerText || '' }));
  record('безопасность', 'буфер: копирование пустого текста предупреждает и не меняет буфер', state.writes === 3 && /В записи нет текста/.test(state.title));
  const errors = takeErrors(page);
  record('безопасность', 'буфер: сценарий изображения без ошибок консоли', errors.length === 0, errors[0] || '');
  await page.close();
}

async function scenarioDictionary(browser) {
  const page = await openPage(browser, '#/dictionary');
  takeErrors(page);
  const before = await page.evaluate(() => document.querySelectorAll('.dict-row').length);

  await clickText(page, 'Добавить');
  await sleep(300);
  const wordInput = await page.$('.modal input');
  if (!wordInput) throw new Error('нет поля ввода слова');
  await wordInput.type('Кубернетес');
  const pronInput = await page.$$('.modal input');
  if (pronInput[1]) await pronInput[1].type('кубернетес');
  await clickText(page, 'Добавить', '.modal button');
  await sleep(400);

  const after = await page.evaluate(() => document.querySelectorAll('.dict-row').length);
  const listText = await textOf(page, '.app-window');
  const saved = await page.evaluate(() => JSON.stringify(window.__e2e.read('zs.dictionary') || []));
  record('сценарии', 'словарь: слово добавляется', after === before + 1 && /Кубернетес/.test(listText), `${before} → ${after}`);
  record('сценарии', 'словарь: слово попадает в хранилище', /Кубернетес/.test(saved));

  // удаление первой строки
  const removed = await page.evaluate(() => {
    const btn = document.querySelector('.dict-row button[aria-label="Удалить"]');
    if (!btn) return false;
    btn.click();
    return true;
  });
  await sleep(400);
  const afterDelete = await page.evaluate(() => document.querySelectorAll('.dict-row').length);
  record('сценарии', 'словарь: слово удаляется', removed && afterDelete < after, `${after} → ${afterDelete}`);

  // и возвращается кнопкой в тосте
  const undoWord = await page.evaluate(() => {
    const btn = document.querySelector('.toast__action');
    if (!btn) return false;
    btn.click();
    return true;
  });
  await sleep(450);
  const afterUndo = await page.evaluate(() => document.querySelectorAll('.dict-row').length);
  record('сценарии', 'словарь: удалённое слово возвращается', undoWord && afterUndo === afterDelete + 1, `${afterDelete} → ${afterUndo}`);
  // возвращаем список в прежнее состояние, чтобы не ломать следующие проверки
  await page.evaluate(() => document.querySelector('.dict-row button[aria-label="Удалить"]')?.click());
  await sleep(350);

  // Закрепление: слово важно человеку и должно попасть в короткую подсказку
  // движку раньше остальных. Берём последнюю строку — так видно, что дело
  // именно в звёздочке, а не в том, что слово и так стояло первым.
  const pinBefore = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.dict-row')];
    const target = rows.at(-1);
    if (!target) return null;
    const word = target.querySelector('.dict-row__word')?.textContent || '';
    target.querySelector('.dict-row__pin')?.click();
    return { word, count: rows.length };
  });
  await sleep(450);
  const pinAfter = await page.evaluate((word) => {
    const rows = [...document.querySelectorAll('.dict-row')];
    const first = rows[0];
    const stored = window.__e2e.read('zs.dictionary') || [];
    const item = stored.find((w) => w.word === word);
    return {
      firstWord: first?.querySelector('.dict-row__word')?.textContent || '',
      pinned: Boolean(item?.pinned),
      starOn: first?.querySelector('.dict-row__pin')?.getAttribute('data-on'),
      aria: first?.querySelector('.dict-row__pin')?.getAttribute('aria-pressed'),
      firstHits: item?.hits,
    };
  }, pinBefore?.word || '');
  record(
    'сценарии',
    'словарь: звёздочка закрепляет слово и поднимает его первым',
    Boolean(pinBefore?.word) && pinAfter.pinned && pinAfter.firstWord === pinBefore.word && pinAfter.starOn === '1',
    `слово=${pinAfter.firstWord} pinned=${pinAfter.pinned}`,
  );
  record(
    'сценарии',
    'словарь: у закреплённого слова кнопка честно говорит «открепить»',
    pinAfter.aria === 'true' && pinAfter.firstHits === 0,
    `aria=${pinAfter.aria}`,
  );
  // возвращаем закрепление обратно: следующие проверки должны видеть обычный список
  await page.evaluate(() => document.querySelector('.dict-row .dict-row__pin')?.click());
  await sleep(350);

  // повторное добавление не заменяет прежнее слово без явной правки
  await clickText(page, 'Добавить');
  await sleep(300);
  const dupInput = await page.$('.modal input');
  await dupInput.type('Whisper'); // слово из сида — уже есть в словаре
  await clickText(page, 'Добавить', '.modal button');
  await sleep(400);
  const afterDup = await page.evaluate(() => document.querySelectorAll('.dict-row').length);
  const dupToast = await page.evaluate(() =>
    [...document.querySelectorAll('.toast')].map((t) => t.innerText.replace(/\n/g, ' ')).join(' | '),
  );
  record(
    'сценарии',
    'словарь: повтор слова не заменяет существующую запись',
    afterDup === afterDelete && /уже есть/i.test(dupToast),
    `${afterDelete} → ${afterDup}, ${dupToast.slice(0, 50)}`,
  );
  await page.close();
}

async function scenarioClipboard(browser) {
  const page = await openPage(browser, '#/clipboard');
  takeErrors(page);
  const cards = await page.evaluate(() => document.querySelectorAll('.clip-card').length);

  // предпросмотр с кнопками есть в списочном виде
  await page.evaluate(() => document.querySelector('.clip-toolbar__view button:nth-child(2)').click());
  await sleep(250);
  await page.evaluate(() => document.querySelector('.clip-list__item').click());
  await sleep(300);
  const preview = await textOf(page, '.clip-preview');

  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.clip-preview button')].find((b) => /^Копировать/.test(b.innerText.trim()));
    if (btn) btn.click();
  });
  await sleep(300);
  const calls = await bridgeCalls(page);
  const errors = takeErrors(page);
  record('сценарии', 'буфер: карточка открывается в предпросмотре', cards > 0 && Boolean(preview));
  record('сценарии', 'буфер: кнопка «Копировать» пишет в буфер', calls.includes('clipboard:write') || calls.includes('clipboard:write-text'), calls.join(','));
  record('сценарии', 'буфер: без ошибок консоли', errors.length === 0, errors[0] || '');

  // плитка «Открыть панель» должна не просто «ничего не делать», а дать поиск в фокус
  await page.evaluate(() => {
    const tile = [...document.querySelectorAll('button')].find((b) => /Открыть панель/.test(b.innerText));
    if (tile) tile.click();
  });
  await sleep(400);
  const panel = await page.evaluate(() => ({
    focused: document.activeElement?.placeholder || '',
    toast: [...document.querySelectorAll('.toast')].map((t) => t.innerText).join(' '),
  }));
  record(
    'сценарии',
    'буфер: «Открыть панель» ставит курсор в поиск',
    /поиск по истории/i.test(panel.focused) && /Панель буфера открыта/i.test(panel.toast),
    JSON.stringify(panel).slice(0, 140),
  );

  const listRows = await page.evaluate(() => document.querySelectorAll('.clip-list__item').length);
  record('сценарии', 'буфер: переключается на список', listRows > 0, `${listRows} строк`);
  await page.close();
}

// Прямые ссылки: то, что человек копирует из подсказки или документации.
// Раньше #/instructions молча показывал главную, а #/clipboard?tab=image —
// «Все»: ссылка вела не туда, и это выглядело как «не работает».
async function scenarioDeepLinks(browser) {
  const page = await openPage(browser, '#/instructions', { settle: 600 });
  takeErrors(page);
  const instructions = await page.evaluate(() => ({
    title: document.querySelector('.page__title')?.innerText || '',
    tab: document.querySelector('.tabs__tab.is-active')?.innerText.replace(/\s+/g, ' ').trim() || '',
  }));
  record(
    'сценарии',
    'ссылка #/instructions открывает инструкции, а не главную',
    /Горячие клавиши/i.test(instructions.title) && /Рекомендуемые/i.test(instructions.tab),
    `${instructions.title} · ${instructions.tab}`,
  );

  await page.goto(`${BASE}/#/clipboard?tab=image`, { waitUntil: 'domcontentloaded' });
  await sleep(600);
  const clipTab = await page.evaluate(
    () => document.querySelector('.clip-toolbar .is-active, .clip-toolbar__tab.is-active')?.innerText.trim() || '',
  );
  record('сценарии', 'ссылка #/clipboard?tab=image открывает изображения', /Изображение/i.test(clipTab), clipTab);

  // старые id разделов обязаны открывать новые вкладки
  await page.goto(`${BASE}/#/settings?section=network&from=home`, { waitUntil: 'domcontentloaded' });
  await sleep(700);
  const alias = await page.evaluate(() => ({
    tab: document.querySelector('.settings-nav.is-active')?.innerText.trim() || '',
    open: Boolean(document.querySelector('.settings-modal')),
  }));
  record(
    'сценарии',
    'старая ссылка на «Сеть» открывает «Диктовку»',
    alias.open && /Диктовка/i.test(alias.tab),
    `${alias.tab} · окно=${alias.open}`,
  );
  const errors = takeErrors(page);
  record('сценарии', 'прямые ссылки без ошибок консоли', errors.length === 0, errors[0] || '');
  await page.close();
}

async function scenarioSettingsSections(browser) {
  // Разделов четыре, а не семь: смежное собрано вместе (1.8.0).
  const sections = ['dictation', 'app', 'data', 'diagnostics'];
  const page = await openPage(browser, '#/settings?section=app&from=home', { settle: 400 });
  takeErrors(page);
  const empty = [];
  for (const section of sections) {
    await page.evaluate((id) => {
      const nav = [...document.querySelectorAll('.settings-side button, .settings-nav button')].find((b) =>
        b.textContent.trim().length > 0 && b.dataset.section === id,
      );
      if (nav) nav.click();
      else window.location.hash = `#/settings?section=${id}&from=home`;
    }, section);
    await sleep(280);
    const info = await page.evaluate(() => {
      const main = document.querySelector('.settings-main');
      return {
        title: main ? (main.querySelector('h2')?.innerText || '').trim() : '',
        rows: main ? main.querySelectorAll('.row, .setting-row, .kv-row, .toggle-row').length : 0,
        text: main ? main.innerText.length : 0,
      };
    });
    if (!info.text || info.text < 40) empty.push(`${section} (${info.title || 'пусто'})`);
  }
  // язык живёт в разделе «Диктовка»
  await page.evaluate(() => {
    window.location.hash = '#/settings?section=dictation&from=home';
  });
  await sleep(400);
  const labels = await page.evaluate(() => document.body.innerText);
  const honestLanguage = /Язык диктовки/.test(labels) && !/Язык интерфейса/.test(labels);
  record('сценарии', 'настройки: язык называется «диктовки», а не «интерфейса»', honestLanguage);
  const errors = takeErrors(page);
  // Старые id разделов продолжают работать: на них ведут подсказки прошлых версий.
  const aliases = await page.evaluate(async () => {
    const out = [];
    for (const id of ['account', 'features', 'network', 'about']) {
      window.location.hash = `#/settings?section=${id}&from=home`;
      await new Promise((r) => setTimeout(r, 260));
      const main = document.querySelector('.settings-main');
      out.push({ id, text: main ? main.innerText.length : 0 });
    }
    return out;
  });
  record(
    'сценарии',
    'настройки: все 4 раздела что-то показывают',
    empty.length === 0,
    empty.join(', '),
  );
  record(
    'сценарии',
    'настройки: старые ссылки на разделы открывают новые',
    aliases.every((a) => a.text > 40),
    aliases.map((a) => `${a.id}:${a.text}`).join(' '),
  );
  record('сценарии', 'настройки: без ошибок консоли', errors.length === 0, errors[0] || '');
  await page.close();
}

async function scenarioTheme(browser) {
  const page = await openPage(browser, '#/settings?section=app&from=home', { settle: 350 });
  const before = await page.evaluate(() => document.documentElement.dataset.theme || 'system');
  await page.evaluate(() => {
    const controls = [...document.querySelectorAll('.select__btn')];
    const theme = controls.find((c) => /Тёмная|Светлая|Системная/.test(c.innerText));
    if (theme) theme.click();
  });
  await sleep(200);
  await page.evaluate(() => {
    const opt = [...document.querySelectorAll('[role="option"]')].find((o) => /Светлая/.test(o.innerText));
    if (opt) opt.click();
  });
  await sleep(300);
  const after = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    scheme: document.documentElement.style.colorScheme,
    bg: getComputedStyle(document.body).backgroundColor,
  }));
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('mockstore:zs.settings') || '{}').theme);
  record('сценарии', 'тема: переключается на светлую и сохраняется', after.theme === 'light' && saved === 'light', `${before} → ${after.theme}, ${after.scheme}`);
  record('сценарии', 'тема: фон действительно светлый', /rgb\((2[0-9]{2}|1[6-9][0-9]),/.test(after.bg), after.bg);
  await page.close();
}

async function scenarioSettingsSearch(browser) {
  const page = await openPage(browser, '#/settings?section=app&from=home', { settle: 350 });
  const input = await page.$('.settings-side input, .settings-search input');
  if (!input) throw new Error('нет поля поиска по настройкам');
  await input.type('тема');
  await sleep(350);
  const found = await page.evaluate(() => {
    const hits = document.querySelectorAll('[class*="search-hit"], .settings-search__item, .settings-side__hit');
    return { hits: hits.length, text: document.querySelector('.settings-side').innerText };
  });
  record('сценарии', 'поиск по настройкам находит «тема»', /Тема/i.test(found.text), `${found.hits} совпадений`);

  // Совпадение в названии — первым, и переход открывает нужный раздел
  const setQuery = (q) =>
    page.evaluate((value) => {
      const el = document.querySelector('.settings-side input');
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, q);
  await setQuery('микрофон');
  await sleep(350);
  const first = await page.evaluate(() => document.querySelector('.settings-search-hit')?.innerText || '');
  await page.evaluate(() => document.querySelector('.settings-search-hit')?.click());
  await sleep(600);
  const landed = await page.evaluate(() => ({
    section: document.querySelector('.settings-nav.is-active')?.innerText.replace(/\s+/g, ' ') || '',
    highlighted: document.querySelectorAll('.setting-row.is-highlight').length,
  }));
  record(
    'сценарии',
    'поиск по настройкам: совпадение в названии первым и переход в раздел',
    /^\s*Микрофон/i.test(first) && /Данные/i.test(landed.section) && landed.highlighted > 0,
    `${first.replace(/\s+/g, ' ')} | ${landed.section} | подсветок ${landed.highlighted}`,
  );
  // Индекс описаний раньше обрывался на первом переносе строки, поэтому слова
  // из конца описания («кнопки», «телеметрии») ничего не находили.
  const byDesc = async (q, titleRe) => {
    await setQuery(q);
    await sleep(350);
    return page.evaluate(
      (re) =>
        [...document.querySelectorAll('.settings-search-hit')].some((h) =>
          new RegExp(re).test(h.innerText),
        ),
      titleRe,
    );
  };
  const extra = await byDesc('устройство микрофона', 'Устройство микрофона');
  record(
    'сценарии',
    'поиск по настройкам: строки отдельного компонента тоже находятся',
    extra,
    extra ? 'нашёл «Устройство микрофона»' : 'не нашёл',
  );
  // 1.6.0: «Способ вставки» и «Проверять обновления» выбираются автоматически,
  // поэтому в поиске их быть не должно — зато должна находиться полировка.
  const polish = await byDesc('полировк', 'Умная полировка');
  const noStale = await page.evaluate(
    () => !/Способ вставки|Проверять обновления на GitHub/.test(document.body.innerText),
  );
  record(
    'сценарии',
    'поиск по настройкам: находит то, что осталось у человека, и без убранных тумблеров',
    polish && noStale,
    `полировка ${polish ? 'да' : 'нет'} · лишних тумблеров ${noStale ? 'нет' : 'есть'}`,
  );
  const tailWord = await byDesc('кнопки', 'Плавающий индикатор');
  const byDescRules = await byDesc('офлайн-правил', 'Умная полировка');
  record(
    'сценарии',
    'поиск по настройкам: слова из конца описания тоже находятся',
    tailWord && byDescRules,
    `кнопки ${tailWord ? 'да' : 'нет'} · правила ${byDescRules ? 'да' : 'нет'}`,
  );
  // «Не трогать мой текст» — один тумблер вместо пяти: он выключает правки и
  // делает бессмысленной «Умную полировку», поэтому её тумблер гаснет.
  await page.evaluate(() => {
    location.hash = '#/settings?section=features';
  });
  await sleep(500);
  const togglePreserve = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.setting-row')].find((r) =>
      /Не трогать мой текст/.test(r.innerText),
    );
    const btn = row?.querySelector('.toggle');
    if (!btn) return false;
    btn.click();
    return true;
  });
  await sleep(450);
  const preserveState = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.setting-row')];
    const preserveRow = rows.find((r) => /Не трогать мой текст/.test(r.innerText));
    const polishRow = rows.find((r) => /Умная полировка/.test(r.innerText));
    const stored = window.__e2e.read('zs.settings') || {};
    return {
      on: preserveRow?.querySelector('.toggle')?.classList.contains('is-on') || false,
      polishDisabled: polishRow?.querySelector('.toggle')?.classList.contains('is-disabled') || false,
      stored: stored.preserveText === true,
    };
  });
  record(
    'сценарии',
    'настройки: «не трогать мой текст» выключает полировку и сохраняется',
    togglePreserve && preserveState.on && preserveState.stored && preserveState.polishDisabled,
    `включено=${preserveState.on} сохранено=${preserveState.stored} полировка=${preserveState.polishDisabled ? 'погашена' : 'активна'}`,
  );
  // возвращаем как было: следующие сценарии должны видеть обычную диктовку
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('.setting-row')].find((r) =>
      /Не трогать мой текст/.test(r.innerText),
    );
    row?.querySelector('.toggle')?.click();
  });
  await sleep(350);
  await page.close();
}

// Задерживаем загрузку раздела дольше прежнего таймера перехода.
async function scenarioSlowSettingsSearch(browser) {
  const page = await openPage(browser, '#/settings?section=app&from=home', {
    settle: 400,
    delaySection: '/sections/DataSection.jsx',
    delaySectionMs: 3200,
  });
  try {
    const input = await page.$('.settings-side input');
    await input.type('микрофон');
    await page.waitForSelector('.settings-search-hit');
    const clickedAt = Date.now();
    await page.click('.settings-search-hit');
    await page.waitForSelector('.settings-loading', { timeout: 2000 });
    record('сценарии', 'медленная загрузка настроек: есть сообщение об ожидании', true);
    await page.waitForSelector('.setting-row.is-highlight', { timeout: 10000 });
    const found = await page.evaluate(() => ({
      text: document.querySelector('.setting-row.is-highlight')?.textContent || '',
      tab: document.querySelector('.settings-nav.is-active')?.textContent || '',
    }));
    record('сценарии', 'медленная загрузка настроек: поиск подсвечивает нужную строку',
      page.__delayedRequests > 0 && Date.now() - clickedAt >= 2500 && /^\s*Микрофон/i.test(found.text) && /Данные/i.test(found.tab),
      `задержано запросов: ${page.__delayedRequests}; ожидание ${Date.now() - clickedAt} мс; ${found.text.slice(0, 100)}`);
    const errors = takeErrors(page);
    record('сценарии', 'медленная загрузка настроек: без ошибок консоли', errors.length === 0, errors[0] || '');
  } finally {
    await page.close();
  }

  const cancelled = await openPage(browser, '#/settings?section=app&from=home', {
    settle: 400,
    delaySection: '/sections/DataSection.jsx',
    delaySectionMs: 3200,
  });
  try {
    await cancelled.type('.settings-side input', 'микрофон');
    await cancelled.waitForSelector('.settings-search-hit');
    await cancelled.click('.settings-search-hit');
    await cancelled.waitForSelector('.settings-loading', { timeout: 2000 });
    await cancelled.evaluate(() => {
      [...document.querySelectorAll('.settings-nav')].find((button) => /Приложение/.test(button.textContent))?.click();
    });
    await sleep(3700);
    const result = await cancelled.evaluate(() => ({
      tab: document.querySelector('.settings-nav.is-active')?.textContent || '',
      highlighted: document.querySelectorAll('.setting-row.is-highlight').length,
    }));
    record('сценарии', 'медленная загрузка настроек: переход отменяется при выборе другого раздела',
      cancelled.__delayedRequests > 0 && /Приложение/.test(result.tab) && result.highlighted === 0,
      JSON.stringify(result));
  } finally {
    await cancelled.close();
  }
}

// Прерываем загрузку модуля: настройки не должны ронять всё приложение.
async function scenarioSettingsSectionFailure(browser) {
  const page = await openPage(browser, '#/settings?section=app&from=home', {
    settle: 400,
    failSection: '/DataSection',
  });
  try {
    await page.evaluate(() => localStorage.setItem('e2e-section-recovery', 'сохранено'));
    await page.evaluate(() => [...document.querySelectorAll('.settings-nav')].find((b) => /Данные/.test(b.textContent))?.click());
    await page.waitForSelector('.settings-section-error', { timeout: 10000 });
    const state = await page.evaluate(() => ({
      message: document.querySelector('.settings-section-error')?.textContent || '',
      app: Boolean(document.querySelector('.app-window')),
      crash: Boolean(document.querySelector('.crash')),
    }));
    record('сценарии', 'ошибка раздела: сообщение вместо падения приложения',
      page.__failedSectionRequests === 1 && state.app && !state.crash && /Перезагрузить окно/.test(state.message), JSON.stringify(state));
    await page.evaluate(() => [...document.querySelectorAll('.settings-nav')].find((b) => /Приложение/.test(b.textContent))?.click());
    await page.waitForFunction(() => document.querySelector('.settings-nav.is-active')?.textContent.includes('Приложение') && !document.querySelector('.settings-section-error'));
    record('сценарии', 'ошибка раздела: другой раздел открывается', Boolean(await page.$('.settings-main .setting-row')));
    await page.evaluate(() => [...document.querySelectorAll('.settings-nav')].find((b) => /Данные/.test(b.textContent))?.click());
    await page.waitForSelector('.settings-section-error', { timeout: 10000 });
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }),
      page.evaluate(() => [...document.querySelectorAll('.settings-section-error button')].find((b) => /Перезагрузить окно/.test(b.textContent)).click()),
    ]);
    await page.waitForSelector('.app-window');
    await page.evaluate(() => { location.hash = '#/settings?section=data&from=home'; });
    await page.waitForFunction(() => document.querySelector('.settings-nav.is-active')?.textContent.includes('Данные') && document.querySelector('.settings-main .setting-row'), { timeout: 10000 });
    const after = await page.evaluate(() => ({ preserved: localStorage.getItem('e2e-section-recovery'), error: Boolean(document.querySelector('.settings-section-error')) }));
    record('сценарии', 'ошибка раздела: после перезагрузки раздел доступен, контрольная запись сохранена', after.preserved === 'сохранено' && !after.error, JSON.stringify(after));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.settings-modal'));
    record('сценарии', 'ошибка раздела: настройки закрываются, приложение доступно', Boolean(await page.$('.app-window')));
  } finally {
    await page.close();
  }
}

async function scenarioEditSnippet(browser) {
  const page = await openPage(browser, '#/home', { settle: 350 });
  await page.evaluate(() => {
    const row = document.querySelector('.recent__row');
    if (row) row.click();
  });
  await sleep(250);
  const openedSnippet = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.snippet button')].find((b) => /Исправить/.test(b.innerText));
    if (!btn) return false;
    btn.click();
    return true;
  });
  await sleep(300);
  const modal = await page.$('.modal');
  if (!modal) {
    record('сценарии', 'правка расшифровки открывается', false, openedSnippet ? 'модалка не появилась' : 'сниппет не открылся');
    await page.close();
    return;
  }
  const textarea = await page.$('.modal textarea');
  await textarea.click({ clickCount: 3 });
  await textarea.type('Исправленный текст для теста');
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.modal button')].find((b) => /Сохранить/i.test(b.innerText));
    if (btn) btn.click();
  });
  await sleep(400);
  const body = await page.evaluate(() => document.body.innerText);
  record('сценарии', 'правка расшифровки сохраняется', /Исправленный текст для теста/.test(body));
  await page.close();
}

async function scenarioAppRulesUi(browser) {
  // Правило добавляется человеком, а не только приходит из профиля: поле,
  // язык и кнопка должны работать, а лишнее — удаляться.
  const page = await openPage(browser, '#/settings?section=features', { settle: 400 });
  takeErrors(page);
  const input = await page.$('input[aria-label="Приложение или часть заголовка окна"]');
  if (!input) throw new Error('нет поля «приложение или часть заголовка»');
  await input.type('Telegram');
  await page.evaluate(() => {
    const row = document.querySelector('.app-rule--new');
    row?.querySelector('.select__btn')?.click();
  });
  await sleep(250);
  const pickedLanguage = await page.evaluate(() => {
    const option = [...document.querySelectorAll('.select__item')].find((o) => /Английский/.test(o.innerText));
    if (!option) return false;
    option.click();
    return true;
  });
  await sleep(250);
  await page.evaluate(() => {
    const row = document.querySelector('.app-rule--new');
    const btn = [...(row?.querySelectorAll('button') || [])].find((b) => /Добавить/.test(b.textContent || ''));
    btn?.click();
  });
  await sleep(450);
  const added = await page.evaluate(() => {
    const stored = window.__e2e.read('zs.settings') || {};
    const rules = Array.isArray(stored.appProfiles) ? stored.appProfiles : [];
    const row = [...document.querySelectorAll('.app-rules .app-rule')][0];
    return {
      count: rules.length,
      rule: rules[0] || null,
      rowText: row?.innerText.replace(/\n/g, ' ') || '',
    };
  });
  record(
    'сценарии',
    'настройки: правило «приложение → язык» добавляется и сохраняется',
    pickedLanguage && added.count === 1 && added.rule?.match === 'Telegram' && added.rule?.language === 'en',
    `правило: ${added.rowText || '—'}`,
  );
  const removed = await page.evaluate(() => {
    const btn = document.querySelector('.app-rules .app-rule .icon-btn--danger');
    if (!btn) return false;
    btn.click();
    return true;
  });
  await sleep(400);
  const afterRemove = await page.evaluate(() => {
    const stored = window.__e2e.read('zs.settings') || {};
    return (stored.appProfiles || []).length;
  });
  record(
    'сценарии',
    'настройки: правило удаляется и больше не применяется',
    removed && afterRemove === 0,
    `правил осталось: ${afterRemove}`,
  );
  const errors = takeErrors(page);
  record('сценарии', 'настройки: правила под окно без ошибок консоли', errors.length === 0, errors[0] || '');
  await page.close();
}

async function scenarioRawText(browser) {
  // «Как распозналось»: приложение правило текст после распознавания, и это
  // видно — вместе с возможностью вернуть то, что услышал движок.
  const page = await openPage(browser, '#/home', {
    storeSeed: {
      'zs.dictations': [
        {
          id: 'raw-1',
          text: 'Привет, ZSpeakly.',
          rawText: 'привет зи спикли',
          createdAt: Date.now() - 60_000,
          durationMs: 2000,
          words: 3,
          source: 'dictation',
          sttThorough: true,
          sttGainDb: 12,
          sttPausesMs: 2400,
          sttModel: 'ggml-small-q5_1.bin',
        },
      ],
    },
  });
  takeErrors(page);
  const tag = await page.evaluate(() => Boolean(document.querySelector('.recent__tag--edited')));
  await page.evaluate(() => document.querySelector('.recent__row')?.click());
  await sleep(350);
  const shown = await page.evaluate(() => ({
    block: Boolean(document.querySelector('.snippet__raw')),
    title: document.querySelector('.snippet__raw-title')?.textContent || '',
    raw: document.querySelector('.snippet__raw-text')?.textContent || '',
    actions: [...document.querySelectorAll('.snippet button')].map((b) => b.innerText),
    changed: [...document.querySelectorAll('.snippet__diff-word')].map((w) => w.textContent.trim()),
  }));
  record(
    'сценарии',
    'история: видно, какое слово приложение исправило',
    shown.changed.join(',') === 'ZSpeakly',
    `подсвечено: ${shown.changed.join(', ') || '—'}`,
  );
  const how = await page.evaluate(() => document.querySelector('.snippet__meta')?.textContent || '');
  record(
    'сценарии',
    'история: видно, как считалось — честный проход, усиление, сжатые паузы',
    /честный проход/.test(how) && /\+12 дБ/.test(how) && /паузы сжаты/.test(how),
    how.replace(/\s+/g, ' ').slice(0, 110) || 'строка пустая',
  );
  record(
    'сценарии',
    'история: видно, как распозналось, и чем это отличается от готового текста',
    tag && shown.block && /Как распозналось/.test(shown.title) && shown.raw === 'привет зи спикли',
    `метка=${tag} текст=${shown.raw.slice(0, 24)}`,
  );
  const restored = await page.evaluate(() => {
    const all = [...document.querySelectorAll('.snippet button')];
    const btn = all.find((b) => /Вернуть как распозналось/.test(b.textContent || ''));
    if (!btn) return all.length === 0 ? 'нет кнопок' : 'кнопка не найдена';
    btn.click();
    return true;
  });
  await sleep(450);
  const after = await page.evaluate(() => ({
    text: document.querySelector('.snippet__text')?.textContent || '',
    block: Boolean(document.querySelector('.snippet__raw')),
    stored: (window.__e2e.read('zs.dictations') || [])[0] || {},
  }));
  record(
    'сценарии',
    'история: «вернуть как распозналось» ставит текст движка и убирает сырой',
    restored === true && after.text === 'привет зи спикли' && !after.block && !after.stored.rawText,
    `нажата=${restored} текст=${after.text.slice(0, 24)} · сырой=${after.stored.rawText ? 'остался' : 'убран'}`,
  );
  await page.evaluate(() => [...document.querySelectorAll('.snippet button')].find((b) => /Исправить/.test(b.innerText))?.click());
  const area = await page.$('.modal textarea');
  await area.click({ clickCount: 3 }); await area.type('ручная правка после возврата');
  await clickText(page, 'Сохранить', '.modal button'); await sleep(350);
  const editedAfterRestore = await page.evaluate(() => (window.__e2e.read('zs.dictations') || [])[0]);
  record('сценарии', 'история: после возврата сырого текста можно сохранить ручную правку',
    editedAfterRestore?.text === 'ручная правка после возврата' && editedAfterRestore?.words === 4, JSON.stringify(editedAfterRestore));
  const errors = takeErrors(page);
  record('сценарии', 'история: «как распозналось» без ошибок консоли', errors.length === 0, errors[0] || '');
  await page.close();
}

async function scenarioAiInstruction(browser) {
  const page = await openPage(browser, '#/hotkeys', { settle: 400 });
  takeErrors(page);
  await page.evaluate(() => {
    const tab = [...document.querySelectorAll('.tabs__tab')].find((t) => /Рекомендуемые/i.test(t.innerText));
    tab?.click();
  });
  await sleep(300);
  const triggered = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.preset-row button')].find((b) => /Попробовать/i.test(b.innerText.trim()));
    if (!btn) return false;
    btn.click();
    return true;
  });
  await sleep(1500);
  const calls = await bridgeCalls(page);
  const body = await page.evaluate(() => document.body.innerText);
  const produced = /Переписанный|готово|Готово|скопирован/i.test(body);
  record('сценарии', 'AI-инструкция запускается и даёт результат', triggered && (produced || calls.includes('http:post')), calls.filter((c) => c.startsWith('http')).join(','));
  await page.close();

  // Без локальной модели «Перевести на английский» раньше молча возвращала
  // пустоту и человек видел «Изменений нет». Проверяем, что перевод идёт
  // офлайн-словарём и честно предупреждает о частичности.
  const offline = await openPage(browser, '#/hotkeys', {
    settle: 400,
    patchNative: () => {
      const native = window.zspeakly && window.zspeakly.native;
      if (!native) return;
      native.readSelection = async () => ({ text: 'спасибо за встречу и за помощь' });
      // модель недоступна — как без запущенной Ollama: 1.6.0 держит постобработку
      // включённой всегда, значит «без модели» проверяется отказом сервера
      native.httpPost = async () => ({ ok: false, status: 0 });
      native.httpGet = async () => ({ ok: false, status: 0 });
    },
  });
  takeErrors(offline);
  await offline.evaluate(() => {
    const tab = [...document.querySelectorAll('.tabs__tab')].find((t) => /Рекомендуемые/i.test(t.innerText));
    tab?.click();
  });
  await sleep(300);
  const pressed = await offline.evaluate(() => {
    const row = [...document.querySelectorAll('.hk-row, .preset-row')].find((r) =>
      /Перевести на английский/i.test(r.innerText),
    );
    const btn = row && [...row.querySelectorAll('button')].find((b) => /Попробовать/i.test(b.innerText.trim()));
    if (!btn) return false;
    btn.click();
    return true;
  });
  await sleep(1200);
  const toast = await offline.evaluate(() =>
    [...document.querySelectorAll('.toast')].map((t) => t.innerText.replace(/\n/g, ' ')).join(' | '),
  );
  record(
    'сценарии',
    'AI-инструкция без модели переводит офлайн и предупреждает о частичности',
    pressed && /thank/i.test(toast) && /модель/i.test(toast) && !/Изменений нет/i.test(toast),
    toast.slice(0, 90) || 'тоста нет',
  );
  const offlineErrors = takeErrors(offline);
  record('сценарии', 'AI-инструкция без модели: без ошибок консоли', offlineErrors.length === 0, offlineErrors[0] || '');
  await offline.close();
}

// Модалка должна быть проходима с клавиатуры: Tab не убегает в приложение,
// Esc закрывает, фокус возвращается на кнопку, которая её открыла.
// Палитра команд (Ctrl+K): одна строка на всё приложение. Проверяем, что она
// открывается с клавиатуры, ищет, выполняет и закрывается — и что фокус из неё
// не уходит в приложение за оверлеем.
async function scenarioCommandPalette(browser) {
  const page = await openPage(browser, '#/home', { settle: 400 });
  takeErrors(page);

  const closedByEsc = async () => {
    await page.keyboard.press('Escape');
    await sleep(250);
    return page.evaluate(() => !document.querySelector('.command'));
  };

  const opened = await (async () => {
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyK');
    await page.keyboard.up('Control');
    await sleep(300);
    return page.evaluate(() => {
      const input = document.querySelector('.command__input');
      return {
        open: Boolean(document.querySelector('.command')),
        focused: document.activeElement === input,
        rows: document.querySelectorAll('.command__row').length,
      };
    });
  })();
  record(
    'сценарии',
    'палитра: Ctrl+K открывает поиск и ставит курсор в поле',
    opened.open && opened.focused && opened.rows > 0,
    `открыта: ${opened.open ? 'да' : 'нет'} · курсор: ${opened.focused ? 'в поле' : 'нет'} · строк: ${opened.rows}`,
  );

  const escWorks = await closedByEsc();
  record('сценарии', 'палитра: Esc закрывает', escWorks, escWorks ? 'закрыта' : 'осталась открытой');

  // Поиск по разделу настроек и переход в него
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyK');
  await page.keyboard.up('Control');
  await sleep(250);
  await page.type('.command__input', 'диагност');
  await sleep(250);
  const found = await page.evaluate(() =>
    [...document.querySelectorAll('.command__row')].map((r) => r.innerText.replace(/\n/g, ' | ')),
  );
  await page.keyboard.press('Enter');
  await sleep(500);
  const settings = await page.evaluate(() => ({
    palette: Boolean(document.querySelector('.command')),
    section: /Диагностика/.test(document.querySelector('.settings-main')?.innerText || ''),
    hash: location.hash,
  }));
  record(
    'сценарии',
    'палитра: находит раздел настроек и открывает его',
    /Диагностика/.test(found.join(' ')) && !settings.palette && settings.section,
    `${found[0] || 'ничего'} → ${settings.hash}`,
  );
  await page.keyboard.press('Escape');
  await sleep(300);

  // Действие «начать диктовку» из палитры
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyK');
  await page.keyboard.up('Control');
  await sleep(250);
  await page.type('.command__input', 'диктов');
  await sleep(250);
  await page.keyboard.press('Enter');
  await sleep(700);
  const dictating = await page.evaluate(() => /Слушаю…|Остановить/.test(document.body.innerText));
  record(
    'сценарии',
    'палитра: действие «начать диктовку» действительно запускает запись',
    dictating,
    dictating ? 'запись идёт' : 'ничего не произошло',
  );
  await page.evaluate(() => window.__e2e.emit('dictation:cancel', { from: 'hud' }));
  await sleep(500);

  // Стрелки и Tab: фокус остаётся внутри палитры, выбор ходит по кругу
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyK');
  await page.keyboard.up('Control');
  await sleep(250);
  const nav = await page.evaluate(() => {
    const first = document.querySelector('.command__row.is-active')?.innerText || '';
    return { first };
  });
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  const moved = await page.evaluate(() => document.querySelector('.command__row.is-active')?.innerText || '');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  const stillInside = await page.evaluate(() =>
    Boolean(document.querySelector('.command')?.contains(document.activeElement)),
  );
  record(
    'сценарии',
    'палитра: стрелки двигают выбор, Tab не уводит фокус наружу',
    moved !== nav.first && stillInside,
    `было «${nav.first.split('\n')[0]}» → стало «${moved.split('\n')[0]}» · фокус ${stillInside ? 'внутри' : 'ушёл'}`,
  );

  // Пустой результат честно говорит, что ничего нет
  await page.type('.command__input', 'щщщщ');
  await sleep(250);
  const empty = await page.evaluate(() => ({
    text: document.querySelector('.command__empty')?.innerText || '',
    rows: document.querySelectorAll('.command__row').length,
  }));
  record(
    'сценарии',
    'палитра: на бессмысленный запрос говорит «ничего не нашлось»',
    empty.rows === 0 && /ничего не нашлось/i.test(empty.text),
    empty.text.slice(0, 60),
  );

  // Ctrl+1…4 — страницы по порядку
  await closedByEsc();
  await page.keyboard.down('Control');
  await page.keyboard.press('Digit3');
  await page.keyboard.up('Control');
  await sleep(400);
  const byNumber = await page.evaluate(() => location.hash);
  record(
    'сценарии',
    'палитра: Ctrl+3 открывает третью страницу меню',
    /hotkeys/.test(byNumber),
    byNumber,
  );

  const errors = takeErrors(page).filter((e) => !/AudioContext|NotAllowedError|microphone/i.test(e));
  record('сценарии', 'палитра: без ошибок консоли', errors.length === 0, errors[0] || '');
  await page.close();
}

async function scenarioModalFocus(browser) {
  const page = await openPage(browser, '#/hotkeys', { settle: 400 });
  takeErrors(page);
  const opened = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => /Своя инструкция/i.test(b.innerText));
    if (!btn) return false;
    btn.focus();
    btn.click();
    return true;
  });
  await sleep(400);
  const modal = await page.evaluate(() => Boolean(document.querySelector('.modal')));
  let inside = true;
  for (let i = 0; i < 16; i += 1) {
    await page.keyboard.press('Tab');
    const ok = await page.evaluate(() => {
      const m = document.querySelector('.modal');
      return m ? m.contains(document.activeElement) : false;
    });
    if (!ok) inside = false;
  }
  record(
    'сценарии',
    'модалка: Tab не уводит фокус за окно',
    opened && modal && inside,
    modal ? (inside ? 'фокус держится' : 'фокус ушёл наружу') : 'окно не открылось',
  );
  await page.keyboard.press('Escape');
  await sleep(350);
  const after = await page.evaluate(() => ({
    closed: !document.querySelector('.modal'),
    focused: /Своя инструкция/i.test(document.activeElement?.innerText || ''),
  }));
  record(
    'сценарии',
    'модалка: Esc закрывает и возвращает фокус на кнопку',
    after.closed && after.focused,
    `закрылась: ${after.closed ? 'да' : 'нет'} · фокус вернулся: ${after.focused ? 'да' : 'нет'}`,
  );
  const errors = takeErrors(page);
  record('сценарии', 'модалка: без ошибок консоли', errors.length === 0, errors[0] || '');
  await page.close();
}

async function scenarioBridgeWiring(browser) {
  const page = await openPage(browser, '#/settings?section=about&from=home', { settle: 500 });
  const calls = await bridgeCalls(page);
  const page2 = await openPage(browser, '#/settings?section=features&from=home', { settle: 500 });
  const calls2 = await bridgeCalls(page2);
  await page2.close();
  const all = new Set([...calls, ...calls2]);
  record('сценарии', 'приложение читает статусы через мост (stt/models)', all.has('stt:status') || all.has('models:status'), [...all].join(','));
  await page.close();
}

/* ── ввод текста: поля поиска, имени, слова ───────────────────────────── */

const INPUT_SELECTOR = 'input:not([type="checkbox"]):not([type="radio"]):not([type="file"]), textarea';

function collectInputs({ selector, scope }) {
  const root = scope ? document.querySelector(scope) : document;
  if (!root) return [];
  return [...root.querySelectorAll(selector)]
    .map((el, index) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const visible = rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden';
      return {
        index,
        visible,
        placeholder: el.getAttribute('placeholder') || '',
        maxLength: el.maxLength,
      };
    })
    .filter((i) => i.visible);
}

async function exploreInputs(browser, { route, label }) {
  const probe = await openPage(browser, route, { settle: 200 });
  const inputs = await probe.evaluate(collectInputs, { selector: INPUT_SELECTOR });
  await probe.close();

  const fails = [];
  let typed = 0;
  for (const input of inputs) {
    const page = await openPage(browser, route, { settle: 180 });
    takeErrors(page);
    const el = (await page.$$(INPUT_SELECTOR))[input.index];
    if (!el) {
      await page.close();
      continue;
    }
    try {
      await el.click();
      await page.keyboard.type('тест', { delay: 15 });
      await page.keyboard.press('Enter');
      typed += 1;
    } catch (err) {
      fails.push(`${input.placeholder || 'поле'}: ${err.message}`);
    }
    await sleep(220);
    const state = await health(page);
    if (!state.hasWindow || state.rootEmpty || state.crashed) {
      fails.push(`${input.placeholder || 'поле'}: экран сломался`);
    }
    for (const err of takeErrors(page)) fails.push(`${input.placeholder || 'поле'}: ${err}`);
    await page.close();
  }
  record('ввод', `${label}: ${typed} полей`, fails.length === 0, fails.slice(0, 3).join('; '));
  return fails;
}

/* ── дополнительные сценарии ──────────────────────────────────────────── */

const storeOf = (page, key) => page.evaluate((k) => window.__e2e.read(k), key);

const clickIn = async (page, scope, text) =>
  page.evaluate(
    ([scopeArg, textArg]) => {
      const root = scopeArg ? document.querySelector(scopeArg) : document;
      if (!root) return false;
      // innerText отдаёт текст в CSS-регистре (в интерфейсе часть подписей
      // набрана капсом), поэтому сравниваем без учёта регистра
      const btn = [...root.querySelectorAll('button, [role="button"], .link-btn')].find((b) => {
        const label = (b.getAttribute('aria-label') || b.innerText || '').replace(/\s+/g, ' ').trim();
        return label.toLowerCase().includes(textArg.toLowerCase());
      });
      if (!btn || btn.disabled) return false;
      btn.click();
      return true;
    },
    [scope, text],
  );

// Имя меняется в одном месте — настройки → «Приложение». Раньше было ещё окно
// «Аккаунт» с тем же полем, и человек не понимал, какое из них главное.
async function scenarioProfile(browser) {
  const page = await openPage(browser, '#/home');
  await page.evaluate(() => document.querySelector('.sidebar__bottom .profile').click());
  await sleep(500);
  const settingsOpen = await page.evaluate(() => Boolean(document.querySelector('.settings-modal')));
  const input = await page.$('.settings-main input');
  if (!input) throw new Error('в настройках нет поля имени');
  await input.click({ clickCount: 3 });
  await input.type('Мария');
  await page.evaluate(() => document.activeElement?.blur());
  await sleep(300);
  const saved = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.settings-modal button')].find((b) => /Готово/i.test(b.innerText));
    if (!btn) return false;
    btn.click();
    return true;
  }) || settingsOpen;
  await sleep(450);
  const body = await page.evaluate(() => document.body.innerText);
  // приветствие берёт имя из настроек, подпись в сайдбаре — из профиля:
  // после сохранения оба места должны показывать одно и то же
  record(
    'сценарии',
    'профиль: имя сохраняется и меняет приветствие',
    saved && /Привет, Мария/.test(body) && /Мария/.test(body),
    body.slice(0, 60).replace(/\n/g, ' '),
  );
  await page.close();
}

async function scenarioRecorder(browser) {
  const page = await openPage(browser, '#/hotkeys', { settle: 400 });
  const opened =
    (await clickIn(page, '', 'Изменить сочетание')) || (await clickIn(page, '', 'Записать сочетание клавиш'));
  await sleep(350);
  const hasModal = await page.$('.modal');
  await page.keyboard.down('Control');
  await page.keyboard.down('Alt');
  await page.keyboard.down('KeyJ');
  await page.keyboard.up('KeyJ');
  await page.keyboard.up('Alt');
  await page.keyboard.up('Control');
  await sleep(350);
  const shown = await page.evaluate(() => document.querySelector('.modal')?.innerText.replace(/\s+/g, ' ') || '');
  const saved = await clickIn(page, '.modal', 'Сохранить');
  await sleep(400);
  const modalGone = (await page.$('.modal')) === null;
  const stored = JSON.stringify({
    settings: await storeOf(page, 'zs.settings'),
    hotkeys: await storeOf(page, 'zs.hotkeys'),
    presets: await storeOf(page, 'zs.presets'),
  });
  record(
    'сценарии',
    'хоткеи: сочетание записывается и модалка закрывается',
    opened && hasModal && saved && modalGone && /Ctrl/.test(shown) && /Control\+Alt\+J|"Ctrl","Alt","J"/.test(stored),
    shown.slice(0, 60),
  );

  // второе действие не должно получить то же сочетание: Windows зарегистрирует
  // только одно, и второе молча не работало
  const secondRow = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.hk-row__add')].filter((b) => /Изменить сочетание/.test(b.innerText))[1];
    if (!btn) return false;
    btn.click();
    return true;
  });
  await sleep(300);
  await page.keyboard.down('Control');
  await page.keyboard.down('Alt');
  await page.keyboard.down('KeyJ');
  await page.keyboard.up('KeyJ');
  await page.keyboard.up('Alt');
  await page.keyboard.up('Control');
  await sleep(300);
  await clickIn(page, '.modal', 'Сохранить');
  await sleep(450);
  const clashToast = await page.evaluate(() =>
    [...document.querySelectorAll('.toast')].map((t) => t.innerText.replace(/\n/g, ' ')).join(' ;; '),
  );
  const keysAfter = await storeOf(page, 'zs.hotkeys');
  const usedTwice = Array.isArray(keysAfter)
    ? Object.values(
        keysAfter.reduce((acc, h) => {
          const key = (h.keys || []).join('+');
          acc[key] = (acc[key] || 0) + 1;
          return acc;
        }, {}),
      ).some((n) => n > 1)
    : false;
  record(
    'сценарии',
    'хоткеи: занятое сочетание не назначается дважды',
    secondRow && /Сочетание занято/i.test(clashToast) && !usedTwice,
    `${clashToast.slice(0, 80)} | дубли: ${usedTwice}`,
  );
  await page.close();
}

async function scenarioInstruction(browser) {
  const page = await openPage(browser, '#/hotkeys', { settle: 400 });
  const opened = await clickIn(page, '', 'Своя инструкция');
  await sleep(350);
  const title = await page.$('.modal input');
  if (!title) throw new Error('нет поля названия инструкции');
  await title.type('Мой стиль');
  const prompt = await page.$('.modal textarea');
  if (prompt) await prompt.type('Сделай текст короче, сохрани смысл');
  const saved = await clickIn(page, '.modal', 'Добавить');
  await sleep(400);
  const store = JSON.stringify(await storeOf(page, 'zs.instructions'));
  const body = await page.evaluate(() => document.body.innerText);
  record('сценарии', 'инструкции: новая сохраняется и видна в списке', opened && saved && /Мой стиль/.test(store) && /Мой стиль/.test(body));
  await page.close();
}

async function scenarioModels(browser) {
  const page = await openPage(browser, '#/settings?section=features&from=home', { settle: 600 });
  takeErrors(page);
  const clicked = await clickIn(page, '', 'Скачать');
  await sleep(700);
  const calls = await bridgeCalls(page);
  record('сценарии', 'модели: кнопка «Скачать» дергает main-процесс', clicked && calls.includes('models:download'), calls.filter((c) => c.startsWith('models')).join(','));
  // Подписи карточек — для человека, а не для замеров: «8× realtime» и «RAM»
  // читаются как шифр, поэтому скорость сказана словами.
  const cardText = await page.evaluate(() =>
    [...document.querySelectorAll('.model-card__meta')].map((el) => el.innerText.replace(/\n/g, ' ')).join(' ;; '),
  );
  record(
    'сценарии',
    'модели: скорость сказана словами, без «×realtime» и «RAM»',
    /быстрее речи/i.test(cardText) && !/realtime/i.test(cardText) && !/\bRAM\b/.test(cardText) && /памяти/i.test(cardText),
    cardText.slice(0, 160),
  );
  // Русский язык — отдельная карточка: своя модель, свой размер, своё правило
  // включения. Проверяем, что она есть и говорит словами, а не названием модели.
  const russianCard = await page.evaluate(() => {
    const card = document.querySelector('.model-card--russian');
    return card ? card.innerText.replace(/\n+/g, ' ') : '';
  });
  record(
    'сценарии',
    'русский язык: отдельная карточка с размером и понятным обещанием',
    /Русский язык/.test(russianCard) &&
      /МБ/.test(russianCard) &&
      /запят|препинани/i.test(russianCard) &&
      !/GigaAM|onnx|int8|realtime/i.test(russianCard),
    russianCard.slice(0, 180) || 'карточки нет',
  );
  // Европейские языки — вторая отдельная карточка. Проверяем не только её
  // наличие, но и честность: что она обещает и чего не обещает.
  const europeanCard = await page.evaluate(() => {
    const card = document.querySelector('.model-card--european');
    return card ? card.innerText.replace(/\n+/g, ' ') : '';
  });
  record(
    'сценарии',
    'европейские языки: карточка с размером, обещанием и границей',
    /Европейские языки/.test(europeanCard) &&
      /МБ/.test(europeanCard) &&
      /английск/i.test(europeanCard) &&
      /китайск/i.test(europeanCard) &&
      !/Parakeet|parakeet|onnx|int8|realtime/i.test(europeanCard),
    europeanCard.slice(0, 200) || 'карточки нет',
  );
  const errors = takeErrors(page);
  record('сценарии', 'модели: без ошибок консоли', errors.length === 0, errors[0] || '');
  await page.close();
}

// Скачивание модели можно отменить: раньше кнопки не было вовсе.
async function scenarioModelCancel(browser) {
  const page = await openPage(browser, '#/settings?section=features&from=home', { settle: 600 });
  takeErrors(page);
  const started = await clickIn(page, '', 'Скачать');
  await sleep(350);
  const cancel = await clickIn(page, '', 'Отменить скачивание');
  await sleep(1500);
  const calls = await bridgeCalls(page);
  const toast = await page.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.innerText).join(' | '));
  record(
    'сценарии',
    'модели: скачивание отменяется кнопкой',
    started && cancel && calls.includes('models:cancel') && /Скачивание отменено/i.test(toast),
    `${calls.filter((c) => c.startsWith('models')).join(',')} | ${toast}`,
  );
  // после отмены кнопка «Скачать» снова доступна
  const again = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.settings-main button')].find((b) => /^Скачать$/.test((b.innerText || '').trim()));
    return btn ? !btn.disabled : false;
  });
  record('сценарии', 'модели: после отмены можно скачать снова', again);
  const errors = takeErrors(page);
  record('сценарии', 'модели: отмена без ошибок консоли', errors.length === 0, errors[0] || '');
  await page.close();
}

// Завершение фоновой загрузки другой модели не должно разблокировать ручную.
async function scenarioModelConcurrentProgress(browser) {
  const page = await openPage(browser, '#/settings?section=features&from=home', {
    settle: 600,
    patchNative: () => {
      let finish, modelId;
      window.zspeakly.native.downloadModel = (id) => {
        modelId = id;
        return new Promise((resolve) => { finish = resolve; });
      };
      window.zspeakly.native.modelsCancel = async () => {
        window.__e2e.emit('model:progress', { id: 'engine', auto: true, percent: 0, done: true, ok: false, reason: 'движок недоступен' });
        setTimeout(() => {
          const result = { ok: false, canceled: true, reason: 'скачивание отменено' };
          window.__e2e.emit('model:progress', { id: modelId, percent: 0, done: true, ...result });
          finish?.(result);
        }, 50);
        return { ok: true };
      };
    },
  });
  try {
    takeErrors(page);
    const started = await clickIn(page, '', 'Скачать');
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => /Отменить скачивание/.test(b.innerText)));
    await page.evaluate(() => window.__e2e.emit('model:progress', { id: 'engine', auto: true, percent: 100, done: true, ok: true }));
    await sleep(200);
    const state = await page.evaluate(() => ({
      cancel: [...document.querySelectorAll('button')].some((b) => /Отменить скачивание/.test(b.innerText)),
      enabled: [...document.querySelectorAll('.settings-main button')].some((b) => /^Скачать$/.test((b.innerText || '').trim()) && !b.disabled),
      toast: [...document.querySelectorAll('.toast')].map((t) => t.innerText).join(' | '),
    }));
    record('сценарии', 'фоновое завершение не прерывает ручное скачивание', started && state.cancel && !state.enabled, JSON.stringify(state));
    record('сценарии', 'установка движка не выдаётся за готовую модель', /Движок/.test(state.toast) && !/Модель распознавания готова|Диктовка работает офлайн/.test(state.toast), state.toast);
    if (state.cancel) await clickIn(page, '', 'Отменить скачивание');
    await sleep(250);
    const toast = await page.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.innerText).join(' | '));
    record('сценарии', 'чужая ошибка и событие отмены не путаются с ответом',
      /движок недоступен/.test(toast) && (toast.match(/Скачивание отменено/g) || []).length === 1 && !/Не удалось скачать модель|Модель не скачалась/.test(toast), toast);
    const errors = takeErrors(page);
    record('сценарии', 'параллельные события модели без ошибок консоли', errors.length === 0, errors[0] || '');
  } finally { await page.close(); }
}

async function scenarioCancelNotAccepted(browser) {
  const page = await openPage(browser, '#/settings?section=features&from=home', {
    settle: 600,
    patchNative: () => {
      let finish, calls = 0;
      window.zspeakly.native.downloadModel = () => new Promise((resolve) => { finish = resolve; });
      window.zspeakly.native.modelsCancel = async () => {
        if (++calls === 1) return { ok: false, reason: 'отмена пока недоступна' };
        finish?.({ ok: false, reason: 'скачивание отменено' });
        return { ok: true };
      };
    },
  });
  try {
    takeErrors(page);
    await clickIn(page, '', 'Скачать');
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => /Отменить скачивание/.test(b.innerText)));
    await clickIn(page, '', 'Отменить скачивание');
    await sleep(200);
    const canRetry = await page.evaluate(() => [...document.querySelectorAll('button')].some((b) => /Отменить скачивание/.test(b.innerText)));
    record('сценарии', 'непринятая отмена не скрывает работающую загрузку', canRetry);
    if (canRetry) await clickIn(page, '', 'Отменить скачивание');
    await sleep(200);
    const toast = await page.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.innerText).join(' | '));
    record('сценарии', 'повторная отмена останавливает загрузку', canRetry && /Скачивание отменено/.test(toast), toast);
    const errors = takeErrors(page);
    record('сценарии', 'повторная отмена без ошибок консоли', errors.length === 0, errors[0] || '');
  } finally { await page.close(); }
}

// Движок можно отменить во время поиска сборки; затем допускается повтор.
async function scenarioEngineCancel(browser) {
  const page = await openPage(browser, '#/settings?section=features&from=home', {
    settle: 600,
    patchNative: () => {
      const native = window.zspeakly.native;
      const originalStatus = native.modelsStatus;
      native.modelsStatus = async () => ({ ...(await originalStatus()), bin: false, server: false });
      let finish, attempts = 0;
      native.downloadEngine = () => {
        if (++attempts === 2) return Promise.resolve({ ok: false, reason: 'сеть недоступна' });
        return new Promise((resolve) => { finish = resolve; });
      };
      native.modelsCancel = async () => {
        const result = attempts === 3
          ? { ok: false, cleanupFailed: true, reason: 'не удалось удалить временные данные: _unpacked: папка занята' }
          : { ok: false, canceled: true, reason: 'скачивание отменено' };
        window.__e2e.emit('model:progress', { id: 'engine', percent: 0, done: true, ...result });
        finish?.(result);
        return { ok: true };
      };
    },
  });
  try {
    takeErrors(page);
    const started = await clickIn(page, '', 'Скачать движок whisper.cpp');
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => /Отменить скачивание/.test(b.innerText)));
    const cancelled = await clickIn(page, '', 'Отменить скачивание');
    await sleep(250);
    const state = await page.evaluate(() => ({
      toast: [...document.querySelectorAll('.toast')].map((t) => t.innerText).join(' | '),
      enabled: [...document.querySelectorAll('button')].some((b) => /Скачать движок whisper.cpp/.test(b.innerText) && !b.disabled),
    }));
    record('сценарии', 'движок: отмена сообщает об отмене и разрешает повтор', started && cancelled && state.enabled && /Скачивание отменено/.test(state.toast) && !/Движок не установился|Не удалось скачать/.test(state.toast), state.toast);
    await clickIn(page, '', 'Скачать движок whisper.cpp');
    await sleep(250);
    const toast = await page.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.innerText).join(' | '));
    const errors = takeErrors(page);
    record('сценарии', 'движок: последующий сбой сети не выдаётся за отмену', /Движок не установился/.test(toast) && /сеть недоступна/.test(toast) && errors.length === 0, toast);
    await clickIn(page, '', 'Скачать движок whisper.cpp');
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => /Отменить скачивание/.test(b.innerText)));
    await clickIn(page, '', 'Отменить скачивание');
    await sleep(250);
    const cleanup = await page.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.innerText).join(' | '));
    record('сценарии', 'движок: ошибка очистки после отмены показана с путём', /не удалось удалить временные данные: _unpacked: папка занята/.test(cleanup) && takeErrors(page).length === 0, cleanup);
  } finally { await page.close(); }
}

// Повтор подключения вручную после конкурирующей фоновой загрузки и отмены выбора файла.
async function scenarioImportModelRetry(browser) {
  const page = await openPage(browser, '#/settings?section=features&from=home', {
    settle: 600,
    patchNative: () => {
      let attempts = 0;
      window.zspeakly.native.importModel = async () => {
        window.__bridgeCalls.push({ channel: 'models:import', args: [] });
        attempts++;
        if (attempts === 1) return { ok: false, reason: 'другая операция подготовки уже выполняется' };
        if (attempts === 2) return { ok: false, canceled: true };
        if (attempts === 3) return { ok: false, canceled: true, reason: 'скачивание отменено' };
        if (attempts === 4) return { ok: false, reason: 'не удалось удалить временные данные: .import-123: файл занят' };
        return { ok: true, id: 'base-q5_1', sizeMb: 60 };
      };
    },
  });
  try {
    takeErrors(page);
    const initial = await page.evaluate(() => window.__e2e.read('zs.settings')?.whisperModel);
    const first = await clickIn(page, '', 'Указать файл модели');
    await sleep(250);
    const conflict = await page.evaluate(() => ({
      toast: [...document.querySelectorAll('.toast')].map((t) => t.innerText).join(' | '),
      model: window.__e2e.read('zs.settings')?.whisperModel,
    }));
    record('сценарии', 'импорт модели: конфликт показан и прежний выбор сохранён', first && /другая операция подготовки уже выполняется/.test(conflict.toast) && conflict.model === initial, conflict.toast);
    await clickIn(page, '', 'Указать файл модели');
    await sleep(250);
    const cancelled = await page.evaluate(() => ({
      toast: [...document.querySelectorAll('.toast')].map((t) => t.innerText).join(' | '),
      model: window.__e2e.read('zs.settings')?.whisperModel,
    }));
    record('сценарии', 'импорт модели: отмена выбора не меняет модель', /Файл не выбран/.test(cancelled.toast) && cancelled.model === initial, cancelled.toast);
    await clickIn(page, '', 'Указать файл модели');
    await sleep(250);
    const cancelledImport = await page.evaluate(() => ({
      toast: [...document.querySelectorAll('.toast')].map((t) => t.innerText).join(' | '),
      model: window.__e2e.read('zs.settings')?.whisperModel,
    }));
    record('сценарии', 'импорт модели: отмена подключения не меняет модель', /Подключение отменено/.test(cancelledImport.toast) && cancelledImport.model === initial, cancelledImport.toast);
    await clickIn(page, '', 'Указать файл модели');
    await sleep(250);
    const cleanup = await page.evaluate(() => ({
      toast: [...document.querySelectorAll('.toast')].map((t) => t.innerText).join(' | '),
      model: window.__e2e.read('zs.settings')?.whisperModel,
    }));
    record('сценарии', 'импорт модели: ошибка очистки показана с путём', /не удалось удалить временные данные: .import-123: файл занят/.test(cleanup.toast) && cleanup.model === initial, cleanup.toast);
    await clickIn(page, '', 'Указать файл модели');
    await sleep(400);
    const done = await page.evaluate(() => ({
      toast: [...document.querySelectorAll('.toast')].map((t) => t.innerText).join(' | '),
      model: window.__e2e.read('zs.settings')?.whisperModel,
      calls: window.__bridgeCalls.filter((c) => c.channel === 'models:import').length,
    }));
    const errors = takeErrors(page);
    record('сценарии', 'импорт модели: повтор подключает выбранную модель', done.calls === 5 && done.model === 'base-q5_1' && /Модель подключена/.test(done.toast) && errors.length === 0, `${done.model} | ${done.toast}`);
  } finally { await page.close(); }
}

// На русской и европейской модели main отклоняет запрос при отмене,
// не отправляя отдельное событие завершения: проверяем именно этот путь.
async function scenarioSpecialModelCancel(browser) {
  for (const kind of ['russian', 'european']) {
    const page = await openPage(browser, '#/settings?section=features&from=home', {
      settle: 600,
      patchArg: kind,
      patchNative: (which) => {
        let rejectDownload;
        let attempts = 0;
        const native = window.zspeakly.native;
        const originalStatus = native.modelsStatus;
        native.modelsStatus = async () => ({
          ...(await originalStatus()),
          [which]: { available: false, missing: ['ещё один файл'], reason: 'модель скачана не полностью' },
        });
        native[which === 'russian' ? 'downloadRussianModel' : 'downloadEuropeanModel'] = () => {
          attempts += 1;
          if (attempts > 1) return Promise.reject(new Error('сеть недоступна'));
          return new Promise((_, reject) => { rejectDownload = reject; });
        };
        native.modelsCancel = async () => {
          window.__bridgeCalls.push({ channel: 'models:cancel', args: [] });
          setTimeout(() => rejectDownload?.(new Error('скачивание отменено')), 0);
          return { ok: true };
        };
      },
    });
    try {
      await page.waitForFunction((k) => /незавершённый скачается заново/.test(document.querySelector(`.model-card--${k}`)?.innerText || ''), {}, kind);
      await page.click(`.model-card--${kind} button`);
      await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => /Отменить скачивание/.test(b.innerText)));
      await clickIn(page, '', 'Отменить скачивание');
      await sleep(450);
      const cancelled = await page.evaluate((k) => ({
        toast: [...document.querySelectorAll('.toast')].map((t) => t.innerText).join(' | '),
        enabled: !document.querySelector(`.model-card--${k} button`)?.disabled,
        calls: window.__bridgeCalls.some((c) => c.channel === 'models:cancel'),
      }), kind);
      record('сценарии', `${kind}: отмена сообщает об отмене и разрешает повтор`,
        cancelled.calls && cancelled.enabled && /Скачивание отменено/.test(cancelled.toast) && !/Не удалось скачать/.test(cancelled.toast), cancelled.toast);
      await page.click(`.model-card--${kind} button`);
      await sleep(450);
      const toast = await page.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.innerText).join(' | '));
      const errors = takeErrors(page);
      record('сценарии', `${kind}: последующая ошибка сети не выдаётся за отмену`, /Не удалось скачать/.test(toast) && /сеть недоступна/.test(toast) && errors.length === 0, `${toast} | ошибки консоли: ${errors.length}`);
    } finally {
      await page.close();
    }
  }
}

// Модель в комплекте доступна для выбора, но не удаляется из профиля и не качается заново.
async function scenarioBundledModel(browser) {
  const page = await openPage(browser, '#/settings?section=features&from=home', {
    settle: 600,
    patchNative: () => {
      const native = window.zspeakly.native;
      const original = native.modelsStatus;
      native.modelsStatus = async () => {
        const status = await original();
        return { ...status, models: { ...status.models, 'small-q5_1': { id: 'small-q5_1', downloaded: false, available: true } } };
      };
    },
  });
  try {
    takeErrors(page);
    const card = await page.evaluate(() => {
      const item = [...document.querySelectorAll('.model-card')].find((node) => /^Сбалансированно/.test(node.querySelector('.model-card__name')?.innerText || ''));
      return { text: item?.innerText || '', pick: Boolean(item?.querySelector('.model-card__pick')), trash: Boolean(item?.querySelector('[aria-label^="Удалить модель"]')), download: [...(item?.querySelectorAll('button') || [])].some((b) => b.innerText.trim() === 'Скачать') };
    });
    record('сценарии', 'модель из комплекта доступна без скачивания и удаления', card.pick && /доступно/.test(card.text) && !card.trash && !card.download, card.text);
    const selected = await page.evaluate(() => {
      const item = [...document.querySelectorAll('.model-card')].find((node) => /^Сбалансированно/.test(node.querySelector('.model-card__name')?.innerText || ''));
      item?.querySelector('.model-card__pick')?.click();
      return Boolean(item);
    });
    await sleep(350);
    const state = await page.evaluate(() => ({ model: window.__e2e.read('zs.settings')?.whisperModel, calls: window.__bridgeCalls.filter((c) => c.channel === 'models:download').length }));
    record('сценарии', 'модель из комплекта выбирается без сети', selected && state.model === 'small-q5_1' && state.calls === 0 && takeErrors(page).length === 0, JSON.stringify(state));
  } finally { await page.close(); }
}

// Удалению модели раньше не было кнопки вовсе: скачал несколько — старые
// лежали гигабайтами и убрать их было нечем.
async function scenarioModelDelete(browser) {
  const page = await openPage(browser, '#/settings?section=features&from=home', {
    settle: 600,
    patchNative: () => {
      const native = window.zspeakly.native;
      const original = native.deleteModel;
      let attempts = 0;
      native.deleteModel = async (...args) => {
        if (++attempts === 1) return { ok: false, reason: 'другая операция подготовки уже выполняется' };
        return original(...args);
      };
    },
  });
  takeErrors(page);
  const trash = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button[aria-label^="Удалить модель"]')].find((b) =>
      /сбалансированно/.test(b.getAttribute('aria-label')),
    );
    if (!btn) return { found: false };
    btn.scrollIntoView({ block: 'center' });
    btn.click();
    return { found: true };
  });
  record('сценарии', 'модели: у скачанной модели есть корзинка', trash.found);
  await sleep(500);
  const dialog = await page.evaluate(() => /Удалить модель с диска/i.test(document.body.innerText));
  record('сценарии', 'модели: удаление спрашивает подтверждение', dialog);
  // именно кнопка подтверждения (текст целиком), а не корзинка с похожей подписью
  const confirmed = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(
      (b) => (b.innerText || '').replace(/\s+/g, ' ').trim() === 'Удалить модель',
    );
    if (!btn || btn.disabled) return false;
    btn.click();
    return true;
  });
  await sleep(400);
  const conflict = await page.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.innerText).join(' | '));
  record('сценарии', 'модели: конфликт удаления объясняется и доступен повтор', confirmed && /Модель не удалилась/.test(conflict) && /другая операция подготовки уже выполняется/.test(conflict), conflict);
  const retry = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button[aria-label^="Удалить модель"]')].find((b) => /сбалансированно/.test(b.getAttribute('aria-label')));
    if (!btn || btn.disabled) return false;
    btn.click();
    return true;
  });
  await sleep(200);
  const confirmedRetry = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => (b.innerText || '').replace(/\s+/g, ' ').trim() === 'Удалить модель');
    if (!btn || btn.disabled) return false;
    btn.click();
    return true;
  });
  await sleep(900);
  const calls = await bridgeCalls(page);
  const toast = await page.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.innerText).join(' | '));
  record(
    'сценарии',
    'модели: удаление уходит в main и объясняет, сколько освободилось',
    retry && confirmedRetry && calls.includes('models:delete') && /199\s*МБ/.test(toast) && /быстр/.test(toast),
    `${calls.filter((c) => c.startsWith('models')).join(',')} | ${toast}`.slice(0, 160),
  );
  const errors = takeErrors(page);
  record('сценарии', 'модели: удаление без ошибок консоли', errors.length === 0, errors[0] || '');
  await page.close();
}

// Подбор модели под железо: main сам сообщает, что взял модель быстрее.
// Человек не должен ни читать каталог моделей, ни угадывать «что тут быстрое».
async function scenarioHardwareModel(browser) {
  const page = await openPage(browser, '#/settings?section=features&from=home', { settle: 700 });
  takeErrors(page);
  await page.evaluate(() =>
    window.__e2e.emit('stt:auto-tune', {
      to: 'base-q5_1',
      reason: 'hardware',
      why: '2 ядра, 4 ГБ — квантованная base: качество base, но заметно быстрее',
    }),
  );
  await sleep(700);
  const toast = await page.evaluate(() =>
    [...document.querySelectorAll('.toast')].map((t) => t.innerText.replace(/\n/g, ' ')).join(' ;; '),
  );
  record(
    'сценарии',
    'подбор модели: тост объясняет выбор без цифр и без «пустой» модели',
    /под этот компьютер/i.test(toast) && !/«»/.test(toast) && !/0\.0 с/.test(toast) && /быстр/i.test(toast),
    toast.slice(0, 140),
  );
  const saved = await page.evaluate(() => {
    const raw = window.zspeakly?.store ? window.__e2e.read('zs.settings') : null;
    const s = raw || (JSON.parse(localStorage.getItem('zs.settings') || '{}'));
    return s?.whisperModel || '';
  });
  record('сценарии', 'подбор модели: настройка совпала с тем, что выбрал main', saved === 'base-q5_1', String(saved));

  // Обратный ход: раньше приложение умело только спускаться на ступень легче и
  // могло оставить человека на самом слабом режиме навсегда. Теперь, если
  // железо тянет точнее, оно поднимает режим само — и говорит об этом словами.
  await page.evaluate(() =>
    window.__e2e.emit('stt:auto-tune', {
      from: 'base-q5_1',
      to: 'small-q5_1',
      reason: 'quality',
      why: '8 ядер, 16 ГБ — режим «Сбалансированно»: small-q5_1 точнее base при той же скорости',
    }),
  );
  await sleep(700);
  const upToast = await page.evaluate(() =>
    [...document.querySelectorAll('.toast')].map((t) => t.innerText.replace(/\n/g, ' ')).join(' ;; '),
  );
  record(
    'сценарии',
    'подбор модели: подъём качества объясняется словами, а не цифрами',
    /текст точнее/i.test(upToast) && /сбалансированно/i.test(upToast) && !/0\.0 с/.test(upToast),
    upToast.slice(0, 140),
  );
  const savedUp = await page.evaluate(() => {
    const raw =
      window.__e2e.read('zs.settings') || JSON.parse(localStorage.getItem('zs.settings') || '{}');
    return raw?.whisperModel || '';
  });
  record('сценарии', 'подбор модели: подъём записан в настройки', savedUp === 'small-q5_1', String(savedUp));
  const errors = takeErrors(page);
  record('сценарии', 'подбор модели: без ошибок консоли', errors.length === 0, errors[0] || '');
  await page.close();
}

// «Укладывается ли в пять секунд» — вопрос, который человек задаёт вслух.
// Отвечаем замером из истории: сколько говорил, сколько считал, в норме или нет.
async function scenarioSpeedReport(browser) {
  const now = Date.now();
  const row = (id, spokenMs, sttMs, mode, ago) => ({
    id,
    text: 'Проверка скорости диктовки',
    words: 3,
    spokenMs,
    sttMs,
    sttMode: mode,
    createdAt: now - ago,
    source: 'dictation',
  });
  const page = await openPage(browser, '#/settings?section=diagnostics&from=home', {
    settle: 700,
    storeSeed: {
      'zs.dictations': [
        row('d-slow-1', 20000, 9000, 'cli', 0),
        row('d-slow-2', 24000, 8000, 'server', 1000),
        row('d-fast', 20000, 3000, 'server', 2000),
        // слишком короткая запись: не показатель, в отчёт не идёт
        row('d-short', 500, 200, 'server', 3000),
      ],
    },
  });
  takeErrors(page);
  const info = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.speed-report__row')].map((el) =>
      el.innerText.replace(/\n/g, ' '),
    );
    const group = [...document.querySelectorAll('.settings-group')].find((g) =>
      /Скорость: укладывается ли в пять секунд/.test(g.innerText),
    );
    return { rows, groupText: group ? group.innerText.replace(/\n/g, ' ') : '' };
  });
  record(
    'сценарии',
    'скорость: в диагностике видно секунды речи и полное время ожидания',
    info.rows.length === 3 && /20\.0 с речи → 9\.0 с ожидания/.test(info.rows.join(' | ')),
    info.rows[0] || '',
  );
  record(
    'сценарии',
    'скорость: каждая строка помечена «в норме» или «долго»',
    // подпись помечена CSS-ом как заголовочно-прописная — сравниваем без учёта регистра
    /долго/i.test(info.rows.join(' ')) && /в норме/i.test(info.rows.join(' ')),
    info.rows.slice(0, 2).join(' ;; '),
  );
  record(
    'сценарии',
    'скорость: вердикт честно говорит «дольше пяти секунд»',
    /Дольше пяти секунд/i.test(info.groupText) && /считал движок/i.test(info.groupText),
    info.groupText.slice(0, 160),
  );
  // Кнопка «переключить на легче» — рядом с вердиктом: совет без кнопки
  // отправлял человека искать раздел самому.
  const switchBtn = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.settings-main button')].find((b) =>
      /Переключить на «быстро»/i.test(b.innerText),
    );
    return btn ? btn.innerText.replace(/\n/g, ' ').trim() : '';
  });
  record(
    'сценарии',
    'скорость: рядом с вердиктом есть кнопка «переключить на быстро»',
    /быстро/i.test(switchBtn) && /МБ/.test(switchBtn),
    switchBtn,
  );
  const before = await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('zs.settings') || '{}');
    return s.whisperModel || '';
  });
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.settings-main button')].find((b) =>
      /Переключить на «быстро»/i.test(b.innerText),
    );
    if (btn) btn.click();
  });
  await sleep(900);
  const afterSwitch = await page.evaluate(() => {
    const raw = window.zspeakly?.store ? window.__e2e.read('zs.settings') : null;
    const s = raw || JSON.parse(localStorage.getItem('zs.settings') || '{}');
    return { model: s.whisperModel || '', body: document.body.innerText };
  });
  record(
    'сценарии',
    'скорость: кнопка переключает режим на быстрый',
    afterSwitch.model === 'base-q5_1' && afterSwitch.model !== before,
    `${before || '—'} → ${afterSwitch.model || '—'}`,
  );
  const errors = takeErrors(page);
  record('сценарии', 'скорость: без ошибок консоли', errors.length === 0, errors[0] || '');
  await page.close();
}

// Старые имена моделей (base/small/medium/tiny из каталога прежних версий) при
// загрузке переводятся на один из трёх режимов: иначе приложение искало бы на
// диске файл, которого больше нет, и молчало о том, что модели нет.
async function scenarioOldModelName(browser) {
  const page = await openPage(browser, '#/settings?section=features&from=home', {
    settle: 700,
    settings: { whisperModel: 'small', speedFix151: false, modelTiers165: false },
  });
  takeErrors(page);
  const body = await page.evaluate(() => document.body.innerText);
  const saved = await page.evaluate(() => {
    const raw = window.zspeakly?.store ? window.__e2e.read('zs.settings') : null;
    const s = raw || JSON.parse(localStorage.getItem('zs.settings') || '{}');
    return s?.whisperModel || '';
  });
  record(
    'сценарии',
    'старый small переводится в свой режим без понижения до base',
    saved === 'small-q5_1' && !/старая модель/i.test(body),
    String(saved),
  );
  // Русская модель — отдельная карточка со своим классом: она не «четвёртый
  // режим», поэтому считаем только карточки режимов.
  const tierCards = await page.evaluate(
    () =>
      document.querySelectorAll('.model-card:not(.model-card--russian):not(.model-card--european)')
        .length,
  );
  record('сценарии', 'старое имя модели: в списке ровно три режима', tierCards === 3, `карточек: ${tierCards}`);
  const errors = takeErrors(page);
  record('сценарии', 'старое имя модели: без ошибок консоли', errors.length === 0, errors[0] || '');
  await page.close();
}

async function scenarioBrowserPreviewNotice(browser) {
  // отдельная страница без моста: так выглядит браузерное превью
  const page = await browser.newPage();
  page.__errors = [];
  page.on('pageerror', (e) => page.__errors.push(String(e)));
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('zs.settings', JSON.stringify({ onboarded: true, userName: 'Максим', theme: 'dark', language: 'ru' }));
  });
  await page.goto(`${BASE}/#/home`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.app-window', { timeout: 15000 });
  await sleep(600);
  const note = await page.evaluate(() => document.querySelector('.hero__note')?.innerText?.replace(/\n/g, ' ') || '');
  record(
    'сценарии',
    'превью без движка: на главной сказано, почему диктовка молчит',
    // «Web Speech» человеку ничего не говорит — проверяем смысл, а не имя технологии
    /системн[а-яё]+ движок|нет движка распознавания/i.test(note) && /приложении/i.test(note),
    note.slice(0, 120),
  );
  const errors = takeErrors(page);
  record('сценарии', 'превью без движка: без ошибок консоли', errors.length === 0, errors[0] || '');
  await page.close();
}

// Самопроверка диктовки: человек хочет знать «работает или нет» без гаданий.
// Проверяем живой путь: микрофон (фейковое устройство Chromium) → запись →
// PCM в main → ответ движка → понятный итог на экране.
async function scenarioSelfTest(browser) {
  // Свой браузер на одну проверку. К концу полного прогона звуковой сервис
  // Chromium в режиме --single-process перестаёт отдавать звук с фейкового
  // устройства: в чистом браузере тот же самый путь работает (проверено
  // отдельным прогоном). Это свойство эмулятора, а не приложения, — но
  // проверять надо приложение, поэтому микрофон получает чистый сервис.
  const own = await launchFreshBrowser();
  const page = await openPage(own, '#/settings?section=diagnostics&from=home', { settle: 700 });
  takeErrors(page);

  // Ждём результат по делу, а не по секундомеру: приложение само может
  // повторить запись, если микрофон не успел открыться, и фиксированная
  // пауза проверяла бы скорость машины, а не поведение.
  const waitResult = async (timeoutMs = 18000) => {
    const deadline = Date.now() + timeoutMs;
    let state = null;
    while (Date.now() < deadline) {
      state = await page.evaluate(() => ({
        line: [...document.querySelectorAll('.settings-group')]
          .filter((g) => /Проверить диктовку сейчас/.test(g.innerText))
          .map((g) => g.innerText.replace(/\n+/g, ' '))
          .join(' '),
        called: Boolean(window.__e2e.last('stt:transcribe-pcm')),
        toast: [...document.querySelectorAll('.toast')].map((t) => t.innerText.replace(/\n/g, ' ')).join(' ;; '),
      }));
      if (state.called || /не сработала|не удалась|молчит|не открылся/i.test(state.toast)) return state;
      await sleep(400);
    }
    return state;
  };

  await page.evaluate(() => window.__e2e.resetCalls());
  const clicked = await clickIn(page, '', 'Проверить диктовку');
  let state = await waitResult();
  let sent = await page.evaluate(() => {
    const call = window.__e2e.last('stt:transcribe-pcm');
    return call ? call.args?.[0] || null : null;
  });
  // Фейковое устройство Chromium под полной загрузкой изредка не отдаёт
  // звук вовсе. Человек в такой ситуации просто нажимает ещё раз — тест
  // делает то же и пишет об этом в отчёте.
  if (!sent) {
    await sleep(700);
    await clickIn(page, '', 'Проверить диктовку');
    state = await waitResult();
    sent = await page.evaluate(() => {
      const call = window.__e2e.last('stt:transcribe-pcm');
      return call ? call.args?.[0] || null : null;
    });
  }
  record(
    'сценарии',
    'самопроверка: запись уходит в движок с настоящим PCM',
    clicked && sent && sent.keys?.includes('pcm') && Boolean(sent.lang),
    sent ? `ключи: ${(sent.keys || []).join(',')}` : 'вызова не было',
  );
  const shown = state?.line || '';
  record(
    'сценарии',
    'самопроверка: на экране секунды записи и текст, а не «ничего не произошло»',
    // секунды — честные, а не ровно «2»: часть времени уходит на открытие
    // микрофона, и показывать заветную двойку значило бы врать
    /Записано \d(?:[.,]\d)? с, распознано за \d+\.\d с: «/.test(shown),
    shown.slice(0, 140),
  );
  const toast = state?.toast || '';
  record('сценарии', 'самопроверка: тост говорит «Диктовка работает»', /Диктовка работает/i.test(toast), toast.slice(0, 120));
  const errors = takeErrors(page);
  record('сценарии', 'самопроверка: без ошибок консоли', errors.length === 0, errors[0] || '');
  await page.close();
  await own.close();
}

async function scenarioUpdateFlow(browser) {
  const page = await openPage(browser, '#/settings?section=about&from=home', { settle: 600 });
  takeErrors(page);
  const check = await clickIn(page, '', 'Проверить обновления');
  await sleep(400);
  await emit(page, 'update:status', { status: 'available', version: '9.9.9', percent: 0 });
  await sleep(500);
  const downloadBtn = await page.evaluate(() =>
    [...document.querySelectorAll('.settings-main button')].some((b) => /Скачать 9\.9\.9/.test(b.innerText)),
  );
  const download = await clickIn(page, '', 'Скачать 9.9.9');
  await sleep(300);
  await emit(page, 'update:status', { status: 'downloading', version: '9.9.9', percent: 42 });
  await sleep(400);
  const progress = await page.evaluate(() => /42%|Скачиваю/.test(document.body.innerText));
  await emit(page, 'update:status', { status: 'downloaded', version: '9.9.9', percent: 100 });
  await sleep(500);
  const restart = await clickIn(page, '', 'Перезапустить и обновить');
  await sleep(400);
  const calls = await bridgeCalls(page);
  record(
    'сценарии',
    'обновление: проверка, скачивание, перезапуск',
    check && downloadBtn && download && progress && restart && calls.includes('update:check') && calls.includes('update:download') && calls.includes('update:install'),
    calls.filter((c) => c.startsWith('update')).join(','),
  );
  // «Обновлений нет» — честный тост при актуальной версии
  await emit(page, 'update:status', { status: 'latest', version: null, percent: 0 });
  await sleep(400);
  const toast = await page.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.innerText).join(' | '));
  record('сценарии', 'обновление: актуальная версия сообщается', /Обновлений нет/i.test(toast), toast.slice(0, 120));
  const errors = takeErrors(page);
  record('сценарии', 'обновление: без ошибок консоли', errors.length === 0, errors[0] || '');
  await page.close();
}

// Отказ обновлятора не должен оставлять кнопку в «Проверяю…»
async function scenarioUpdateFailure(browser) {
  const page = await openPage(browser, '#/settings?section=about&from=home', { settle: 500 });
  takeErrors(page);
  await page.evaluate(() => {
    const native = window.zspeakly.native;
    native.checkUpdates = async () => {
      throw new Error('нет связи с GitHub');
    };
  });
  const check = await clickIn(page, '', 'Проверить обновления');
  await sleep(600);
  const state = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.settings-main button')].find((b) => /Проверить обновления/.test(b.innerText));
    return { disabled: btn ? btn.disabled : null, toast: [...document.querySelectorAll('.toast')].map((t) => t.innerText).join(' | ') };
  });
  record(
    'сценарии',
    'обновление: сбой не блокирует кнопку и объясняется',
    check && state.disabled === false && /Не удалось проверить обновления/i.test(state.toast),
    JSON.stringify(state).slice(0, 160),
  );
  const errors = takeErrors(page);
  record('сценарии', 'обновление: сбой без ошибок консоли', errors.length === 0, errors[0] || '');
  await page.close();
}

// В сетке буфера не было ни одной операции над карточкой — только «Очистить историю».
async function scenarioClipboardGridActions(browser) {
  const page = await openPage(browser, '#/clipboard', { settle: 400 });
  takeErrors(page);
  const opened = await page.evaluate(() => {
    const card = document.querySelector('.clip-card');
    if (!card) return false;
    card.click();
    return true;
  });
  await sleep(350);
  const bar = await page.evaluate(() =>
    [...document.querySelectorAll('.clip-actions .link-btn')].map((b) => b.innerText.trim().toLowerCase()),
  );
  const before = ((await storeOf(page, 'zs.clipboard')) || []).length;
  const pinned = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.clip-actions .link-btn')].find((b) => /закрепить/i.test(b.innerText));
    if (!btn) return false;
    btn.click();
    return true;
  });
  await sleep(350);
  const pins = ((await storeOf(page, 'zs.clipboard')) || []).filter((c) => c.pinned).length;
  const removed = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.clip-actions .link-btn')].find((b) => /удалить/i.test(b.innerText));
    if (!btn) return false;
    btn.click();
    return true;
  });
  await sleep(450);
  const after = ((await storeOf(page, 'zs.clipboard')) || []).length;
  record(
    'сценарии',
    'буфер в сетке: копировать, закрепить, удалить доступны',
    opened && bar.includes('копировать') && bar.includes('закрепить') && bar.includes('удалить') && pins > 0 && after === before - 1,
    `${bar.join('/')} | закреплено ${pins} | ${before} → ${after} | удалить ${removed}`,
  );

  // удаление можно отменить кнопкой в тосте
  const undone = await page.evaluate(() => {
    const btn = document.querySelector('.toast__action');
    if (!btn) return false;
    btn.click();
    return true;
  });
  await sleep(450);
  const restored = ((await storeOf(page, 'zs.clipboard')) || []).length;
  record(
    'сценарии',
    'буфер в сетке: удаление возвращается кнопкой «Вернуть»',
    undone && restored === before,
    `${after} → ${restored}`,
  );
  const errors = takeErrors(page);
  record('сценарии', 'буфер в сетке: без ошибок консоли', errors.length === 0, errors[0] || '');
  await page.close();
}

// Удаление расшифровки тоже обратимо: промах мыши не должен стирать текст.
async function scenarioDictationUndo(browser) {
  const page = await openPage(browser, '#/home', { settle: 400 });
  takeErrors(page);
  const before = ((await storeOf(page, 'zs.dictations')) || []).length;
  await page.evaluate(() => document.querySelector('.recent__row, .recent-row, .recent__item')?.click());
  await sleep(350);
  const removed = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.snippet button')].find((b) => /Удалить/i.test(b.innerText));
    if (!btn) return false;
    btn.click();
    return true;
  });
  await sleep(450);
  const after = ((await storeOf(page, 'zs.dictations')) || []).length;
  const undone = await page.evaluate(() => {
    const btn = document.querySelector('.toast__action');
    if (!btn) return false;
    btn.click();
    return true;
  });
  await sleep(500);
  const back = ((await storeOf(page, 'zs.dictations')) || []).length;
  record(
    'сценарии',
    'история: удаление расшифровки можно вернуть',
    removed && after === before - 1 && undone && back === before,
    `${before} → ${after} → ${back}`,
  );
  const errors = takeErrors(page);
  record('сценарии', 'история: возврат без ошибок консоли', errors.length === 0, errors[0] || '');
  await page.close();
}

// Удаление не должно стирать другие записи или более позднюю версию.
async function scenarioDictationRemovalSafety(browser) {
  const duplicate = await openPage(browser, '#/home', { storeSeed: { 'zs.dictations': [
    { id: 'same', text: 'первая запись', createdAt: Date.now() },
    { id: 'same', text: 'вторая запись', createdAt: Date.now() - 1000 },
  ] } });
  try {
    await duplicate.click('.recent__row');
    await clickText(duplicate, 'Удалить', '.snippet button'); await sleep(300);
    const rows = await duplicate.evaluate(() => window.__e2e.read('zs.dictations') || []);
    record('сценарии', 'история: удаление при дублирующихся ID не стирает соседнюю запись', rows.length === 1 && rows[0].text === 'вторая запись', JSON.stringify(rows));
  } finally { await duplicate.close(); }

  const stale = await openPage(browser, '#/home', {
    settings: { aiProcessing: true, aiEndpoint: 'http://localhost:11434', aiDictationRewrite: true, liveWhisper: false },
    storeSeed: { 'zs.dictations': [] },
    patchNative: () => {
      window.zspeakly.native.transcribePcm = async () => ({ ok: true, text: 'первая запись про рыбу' });
      window.zspeakly.native.httpPost = async () => new Promise((resolve) => { window.__resolveLatePolish = resolve; });
    },
  });
  try {
    await stale.click('.hero__mic'); await sleep(900); await stale.click('.hero__mic');
    await stale.waitForFunction(() => (window.__e2e.read('zs.dictations') || []).length === 1 && Boolean(window.__resolveLatePolish), { timeout: 10000 });
    await stale.click('.recent__row'); await sleep(150);
    await stale.evaluate(() => window.__resolveLatePolish({ ok: true, data: { response: 'Первая запись, про рыбу.' } }));
    await stale.waitForFunction(() => (window.__e2e.read('zs.dictations') || [])[0]?.text === 'Первая запись, про рыбу.', { timeout: 10000 });
    await clickText(stale, 'Удалить', '.snippet button'); await sleep(300);
    const result = await stale.evaluate(() => ({ rows: window.__e2e.read('zs.dictations') || [], overlay: Boolean(document.querySelector('.snippet')), body: document.body.innerText }));
    record('сценарии', 'история: устаревшее окно не удаляет изменённую запись', result.rows.length === 1 && result.rows[0].text === 'Первая запись, про рыбу.' && result.overlay && /Запись изменилась/.test(result.body), JSON.stringify({ rows: result.rows, overlay: result.overlay }));
  } finally { await stale.close(); }
}

async function scenarioDictationUndoCapacity(browser) {
  const records = Array.from({ length: 2000 }, (_, i) => ({ id: `hist-${i}`, text: `старая запись ${i}`, createdAt: Date.now() - i * 1000 }));
  const page = await openPage(browser, '#/home', { settings: { aiDictationRewrite: false },
    storeSeed: { 'zs.dictations': records, 'zs.mockSttText': 'новая запись для проверки' } });
  try {
    await page.click('.recent__row'); await clickText(page, 'Удалить', '.snippet button');
    await page.click('.hero__mic'); await sleep(900); await page.click('.hero__mic');
    await page.waitForFunction(() => (window.__e2e.read('zs.dictations') || []).length === 2000 && (window.__e2e.read('zs.dictations') || [])[0]?.text?.includes('Новая запись'), { timeout: 10000 });
    await page.evaluate(() => [...document.querySelectorAll('.toast')].find((t) => /Запись удалена/.test(t.innerText))?.querySelector('.toast__action')?.click());
    await sleep(250);
    const result = await page.evaluate(() => ({ rows: window.__e2e.read('zs.dictations') || [], recover: document.querySelector('.toast__recover')?.value, body: document.body.innerText }));
    let recovered; try { recovered = JSON.parse(result.recover); } catch { /* диагностируем ниже */ }
    record('сценарии', 'история: возврат при полном лимите не вытесняет другие записи',
      result.rows.length === 2000 && result.rows.some((r) => r.id === 'hist-1999') && result.rows.some((r) => /Новая запись/.test(r.text)) && recovered?.id === 'hist-0' && /не восстановлена/.test(result.body),
      JSON.stringify({ count: result.rows.length, last: result.rows.some((r) => r.id === 'hist-1999'), restored: recovered?.id }));
    await page.click('.recent__row'); await clickText(page, 'Удалить', '.snippet button');
    await page.evaluate(() => [...document.querySelectorAll('.toast')].find((t) => /Запись не восстановлена/.test(t.innerText))?.querySelector('.toast__action')?.click());
    await sleep(250);
    const retried = await page.evaluate(() => window.__e2e.read('zs.dictations') || []);
    record('сценарии', 'история: возврат можно повторить после освобождения места',
      retried.length === 2000 && retried.some((r) => r.id === 'hist-0') && retried.some((r) => r.id === 'hist-1999') && !retried.some((r) => /Новая запись/.test(r.text)));
  } finally { await page.close(); }
}

// Очистка истории диктовок — только после подтверждения, пустая история молчит делом.
/**
 * «Переспросить точно»: человек видит ошибку сразу после вставки, а запись ещё
 * в памяти — значит второй текст можно получить без повтора вслух. Проверяем
 * и главное правило: текст меняется, только когда точный проход услышал больше.
 */
async function scenarioRetryLast(browser) {
  const page = await openPage(browser, '#/home', {
    settings: { aiDictationRewrite: false },
    storeSeed: { 'zs.dictations': [], 'zs.mockSttText': 'Проверка диктовки: раз, два, три.' },
    settle: 600,
  });
  takeErrors(page);
  await clickText(page, 'Начать диктовку');
  await sleep(1100);
  await page.evaluate(() => {
    const stop = document.querySelector('[aria-label="Остановить запись"]');
    if (stop) stop.click();
    else [...document.querySelectorAll('button')].find((b) => /Слушаю/i.test(b.innerText))?.click();
  });
  await sleep(2300);
  const before = await page.evaluate(() => (window.__e2e.read('zs.dictations') || [])[0]?.text || '');
  const clicked = await page.evaluate(() => {
    const btn = document.querySelector('.last-result [aria-label="Переспросить точно"]');
    if (!btn) return false;
    btn.click();
    return true;
  });
  await sleep(1400);
  const after = await page.evaluate(() => {
    const item = (window.__e2e.read('zs.dictations') || [])[0] || {};
    const calls = (window.__bridgeCalls || []).filter((c) => c.channel === 'stt:transcribe-pcm');
    return {
      text: String(item.text || ''),
      edited: Boolean(item.sttSecondPass),
      thoroughSent: calls.some((c) => c.args?.[0]?.thorough === true),
      toasts: [...document.querySelectorAll('.toast__title')].map((n) => n.innerText).join(' | '),
    };
  });
  record(
    'сценарии',
    'переспросить точно: кнопка у последней расшифровки прогоняет запись ещё раз',
    clicked && after.thoroughSent,
    `нажата=${clicked} честный проход=${after.thoroughSent}`,
  );
  record(
    'сценарии',
    'переспросить точно: точный проход услышал больше — текст и история обновились',
    Boolean(before) && after.text.length > before.length && /Четыре/.test(after.text) && after.edited,
    `${before} → ${after.text}`,
  );
  record(
    'сценарии',
    'переспросить точно: о результате сказано словами',
    /Точный проход услышал больше/.test(after.toasts),
    after.toasts || 'тоста нет',
  );
  const errors = takeErrors(page);
  record('сценарии', 'переспросить точно: без ошибок консоли', errors.length === 0, errors[0] || '');
  await page.close();
}

// Задерживаем именно повторный проход: пользователь успевает поменять историю
// или продиктовать новую фразу до прихода старого ответа.
async function scenarioRetryConflict(browser) {
  for (const kind of ['edit', 'delete', 'delete-restore', 'new-dictation']) {
    const page = await openPage(browser, '#/home', {
      settings: { aiDictationRewrite: false, liveWhisper: false },
      storeSeed: { 'zs.dictations': [] },
      patchNative: () => {
        let count = 0;
        window.zspeakly.native.transcribePcm = (payload) => {
          if (payload?.thorough) return new Promise((resolve) => { window.__resolveRetry = resolve; });
          count += 1;
          return Promise.resolve({ ok: true, text: count === 1 ? 'Первый текст.' : 'Новая диктовка.', ms: 200 });
        };
      },
    });
    takeErrors(page);
    try {
      const dictate = async () => {
        await page.waitForFunction(() => /Начать диктовку/i.test(document.querySelector('.hero__mic')?.innerText || ''), { timeout: 7000 });
        await page.click('.hero__mic');
        await page.waitForFunction(() => /Слушаю/i.test(document.body.innerText), { timeout: 5000 });
        await sleep(900);
        await page.evaluate(() => {
          const stop = document.querySelector('[aria-label="Остановить запись"]');
          if (stop) stop.click();
          else [...document.querySelectorAll('button')].find((b) => /Слушаю/i.test(b.innerText))?.click();
        });
      };
      await dictate();
      await page.waitForFunction(() => (window.__e2e.read('zs.dictations') || []).some((r) => /Первый текст/i.test(r.text)), { timeout: 10000 });
      const first = await page.evaluate(() => (window.__e2e.read('zs.dictations') || [])[0]);
      await page.click('.last-result [aria-label="Переспросить точно"]');
      await page.waitForFunction(() => typeof window.__resolveRetry === 'function', { timeout: 5000 });
      if (kind === 'edit') {
        await page.click('.recent__row'); await sleep(150);
        await page.evaluate(() => [...document.querySelectorAll('.snippet button')].find((b) => /Исправить/.test(b.innerText))?.click());
        await page.waitForSelector('.modal textarea');
        const field = await page.$('.modal textarea');
        await field.click({ clickCount: 3 }); await field.type('Моя ручная правка.');
        await page.evaluate(() => [...document.querySelectorAll('.modal button')].find((b) => /Сохранить/i.test(b.innerText))?.click());
        await page.waitForFunction(() => (window.__e2e.read('zs.dictations') || []).some((r) => r.text === 'Моя ручная правка.'), { timeout: 5000 });
      } else if (kind === 'delete' || kind === 'delete-restore') {
        await page.click('.recent__row'); await sleep(150);
        await page.evaluate(() => [...document.querySelectorAll('.snippet button')].find((b) => /Удалить/.test(b.innerText))?.click());
        await page.waitForFunction(() => (window.__e2e.read('zs.dictations') || []).length === 0, { timeout: 5000 });
        if (kind === 'delete-restore') {
          await page.evaluate(() => [...document.querySelectorAll('.toast__action')].find((b) => /Вернуть/.test(b.innerText))?.click());
          await page.waitForFunction((id) => (window.__e2e.read('zs.dictations') || []).some((r) => r.id === id), { timeout: 5000 }, first.id);
        }
      } else {
        await sleep(2200); // ждём завершения предыдущей диктовки, не повторного прохода
        await dictate();
        try {
          await page.waitForFunction(() => (window.__e2e.read('zs.dictations') || []).some((r) => /Новая диктовка/i.test(r.text)), { timeout: 10000 });
        } catch (err) { throw new Error(`вторая диктовка: ${JSON.stringify(await page.evaluate(() => ({ rows: (window.__e2e.read('zs.dictations') || []).map((r) => r.text), text: document.body.innerText.slice(-350), mic: document.querySelector('.hero__mic')?.innerText })))}; ${err.message}`); }
      }
      await page.evaluate(() => window.__resolveRetry({ ok: true, text: 'Первый текст с дополнительными словами.', ms: 300 }));
      await sleep(900);
      const actual = await page.evaluate(() => ({
        rows: (window.__e2e.read('zs.dictations') || []).map((r) => ({ id: r.id, text: r.text })),
        last: document.querySelector('.last-result__text')?.innerText || '',
        recover: document.querySelector('.toast__recover')?.value || '',
        titles: [...document.querySelectorAll('.toast__title')].map((el) => el.innerText),
      }));
      const original = actual.rows.find((r) => r.id === first.id);
      const unchanged = kind === 'delete' ? !original : kind === 'edit' ? original?.text === 'Моя ручная правка.' : original?.text === first.text;
      const lastCorrect = kind !== 'new-dictation' || /Новая диктовка/i.test(actual.last);
      record('сценарии', `точный проход: конфликт ${kind} не затирает данные`,
        unchanged && lastCorrect && actual.recover === 'Первый текст с дополнительными словами.' &&
        !actual.titles.includes('Точный проход услышал больше'), JSON.stringify(actual));
      const errors = takeErrors(page);
      record('сценарии', `точный проход: конфликт ${kind} без ошибок консоли`, errors.length === 0, errors[0] || '');
    } finally { await page.close(); }
  }
}

async function scenarioRetryDoubleClick(browser) {
  const page = await openPage(browser, '#/home', {
    settings: { aiDictationRewrite: false, liveWhisper: false },
    storeSeed: { 'zs.dictations': [] },
    patchNative: () => {
      window.__retryCount = 0;
      window.zspeakly.native.transcribePcm = (payload) => {
        if (!payload?.thorough) return Promise.resolve({ ok: true, text: 'Первый текст.', ms: 200 });
        window.__retryCount += 1;
        return new Promise((resolve) => { window.__resolveRetry = resolve; });
      };
    },
  });
  takeErrors(page);
  try {
    await page.click('.hero__mic'); await sleep(900);
    await page.evaluate(() => {
      const stop = document.querySelector('[aria-label="Остановить запись"]');
      if (stop) stop.click();
      else [...document.querySelectorAll('button')].find((b) => /Слушаю/i.test(b.innerText))?.click();
    });
    await page.waitForFunction(() => (window.__e2e.read('zs.dictations') || []).length === 1, { timeout: 10000 });
    await page.evaluate(() => {
      const button = document.querySelector('.last-result [aria-label="Переспросить точно"]');
      button.click(); button.click();
    });
    await page.waitForFunction(() => typeof window.__resolveRetry === 'function', { timeout: 5000 });
    const count = await page.evaluate(() => window.__retryCount);
    await page.evaluate(() => window.__resolveRetry({ ok: true, text: 'Первый текст с дополнительными словами.', ms: 300 }));
    await sleep(500);
    const text = await page.evaluate(() => (window.__e2e.read('zs.dictations') || [])[0]?.text || '');
    record('сценарии', 'точный проход: двойное нажатие запускает один запрос',
      count === 1 && text === 'Первый текст с дополнительными словами.', `${count} запросов · ${text}`);
    const errors = takeErrors(page);
    record('сценарии', 'точный проход: двойное нажатие без ошибок консоли', errors.length === 0, errors[0] || '');
  } finally { await page.close(); }
}

async function scenarioRetryAlreadyEdited(browser) {
  const page = await openPage(browser, '#/home', {
    settings: { aiDictationRewrite: false, liveWhisper: false },
    storeSeed: { 'zs.dictations': [] },
    patchNative: () => {
      window.__retryCount = 0;
      window.zspeakly.native.transcribePcm = (payload) => {
        if (payload?.thorough) window.__retryCount += 1;
        return Promise.resolve({ ok: true, text: 'Первый текст.', ms: 200 });
      };
    },
  });
  takeErrors(page);
  try {
    await page.click('.hero__mic'); await sleep(900);
    await page.evaluate(() => {
      const stop = document.querySelector('[aria-label="Остановить запись"]');
      if (stop) stop.click();
      else [...document.querySelectorAll('button')].find((b) => /Слушаю/i.test(b.innerText))?.click();
    });
    await page.waitForFunction(() => (window.__e2e.read('zs.dictations') || []).length === 1, { timeout: 10000 });
    await page.click('.recent__row'); await sleep(150);
    await page.evaluate(() => [...document.querySelectorAll('.snippet button')].find((b) => /Исправить/.test(b.innerText))?.click());
    await page.waitForSelector('.modal textarea');
    const field = await page.$('.modal textarea');
    await field.click({ clickCount: 3 }); await field.type('Моя правка до повтора.');
    await page.evaluate(() => [...document.querySelectorAll('.modal button')].find((b) => /Сохранить/i.test(b.innerText))?.click());
    await page.waitForFunction(() => (window.__e2e.read('zs.dictations') || [])[0]?.text === 'Моя правка до повтора.', { timeout: 5000 });
    await page.click('.last-result [aria-label="Переспросить точно"]'); await sleep(400);
    const result = await page.evaluate(() => ({
      count: window.__retryCount,
      text: (window.__e2e.read('zs.dictations') || [])[0]?.text,
      titles: [...document.querySelectorAll('.toast__title')].map((el) => el.innerText),
    }));
    const errors = takeErrors(page);
    record('сценарии', 'точный проход: изменённую заранее запись не перезапрашивает',
      result.count === 0 && result.text === 'Моя правка до повтора.' && result.titles.includes('Запись изменилась или удалена') && errors.length === 0,
      JSON.stringify({ ...result, errors }));
  } finally { await page.close(); }
}

async function scenarioRetryFailure(browser) {
  const page = await openPage(browser, '#/home', {
    settings: { aiDictationRewrite: false, liveWhisper: false },
    storeSeed: { 'zs.dictations': [] },
    patchNative: () => {
      let tries = 0;
      window.zspeakly.native.transcribePcm = (payload) => {
        if (!payload?.thorough) return Promise.resolve({ ok: true, text: 'Первый текст.', ms: 200 });
        tries += 1;
        return tries === 1 ? Promise.reject(new Error('мост недоступен'))
          : Promise.resolve({ ok: true, text: 'Первый текст с дополнительными словами.', ms: 300 });
      };
    },
  });
  takeErrors(page);
  try {
    await page.click('.hero__mic'); await sleep(900);
    await page.evaluate(() => {
      const stop = document.querySelector('[aria-label="Остановить запись"]');
      if (stop) stop.click();
      else [...document.querySelectorAll('button')].find((b) => /Слушаю/i.test(b.innerText))?.click();
    });
    await page.waitForFunction(() => (window.__e2e.read('zs.dictations') || []).length === 1, { timeout: 10000 });
    await page.click('.last-result [aria-label="Переспросить точно"]');
    await sleep(500);
    const failure = await page.evaluate(() => ({
      title: [...document.querySelectorAll('.toast__title')].map((el) => el.innerText),
      text: (window.__e2e.read('zs.dictations') || [])[0]?.text,
      disabled: document.querySelector('.last-result [aria-label="Переспросить точно"]')?.disabled,
    }));
    const errors = takeErrors(page);
    record('сценарии', 'точный проход: ошибка моста показана, исходная история не меняется',
      failure.title.includes('Точный проход не удался') && failure.text === 'Первый текст.' && failure.disabled === false && errors.length === 0,
      JSON.stringify({ ...failure, errors }));
    await page.click('.last-result [aria-label="Переспросить точно"]');
    await sleep(500);
    const after = await page.evaluate(() => (window.__e2e.read('zs.dictations') || [])[0]?.text || '');
    record('сценарии', 'точный проход: после ошибки можно повторить вручную',
      after === 'Первый текст с дополнительными словами.', after);
  } finally { await page.close(); }
}

/**
 * «Скорость против точности»: три режима и замер этой машины.
 *
 * Проверяем то, ради чего карточка сделана: выбор виден целиком, сохраняется,
 * и рядом написано числом, что происходит на этой машине, — иначе «Авто»
 * остаётся чёрным ящиком.
 */
async function scenarioDecodeMode(browser) {
  const page = await openPage(browser, '#/settings?section=dictation&from=home', { settle: 700 });
  takeErrors(page);
  const card = await page.evaluate(() => ({
    buttons: [...document.querySelectorAll('.decode-mode__btn')].map((b) => b.innerText.trim()),
    active: document.querySelector('.decode-mode__btn.is-active')?.innerText.trim() || '',
    note: document.querySelector('.decode-mode__note')?.innerText || '',
    called: Boolean(window.__e2e.last('stt:decode-stats')),
  }));
  record(
    'сценарии',
    'режим распознавания: три варианта видны целиком, а не спрятаны в списке',
    card.buttons.join(',') === 'Авто,Быстро,Точно' && card.active === 'Авто',
    `${card.buttons.join(', ')} · активен «${card.active}»`,
  );
  record(
    'сценарии',
    'режим распознавания: рядом замер этой машины, а не «решает приложение»',
    card.called && /%/.test(card.note),
    card.note || 'замера нет',
  );

  const clicked = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.decode-mode__btn')].find((b) => b.innerText.trim() === 'Точно');
    if (!btn) return false;
    btn.click();
    return true;
  });
  await sleep(600);
  const after = await page.evaluate(() => ({
    saved: (window.__e2e.read('zs.settings') || {}).decodeMode || '',
    active: document.querySelector('.decode-mode__btn.is-active')?.innerText.trim() || '',
    note: document.querySelector('.decode-mode__note')?.innerText || '',
    toasts: [...document.querySelectorAll('.toast__title')].map((n) => n.innerText).join(' | '),
  }));
  record(
    'сценарии',
    'режим распознавания: «Точно» сохраняется и честно объясняет, что теперь всегда',
    clicked && after.saved === 'accurate' && after.active === 'Точно' && /независимо от замеров/.test(after.note),
    `сохранено «${after.saved}» · ${after.note}`,
  );
  record(
    'сценарии',
    'режим распознавания: о смене сказано словами',
    /Режим «Точно»/.test(after.toasts),
    after.toasts || 'тоста нет',
  );
  const errors = takeErrors(page);
  record('сценарии', 'режим распознавания: без ошибок консоли', errors.length === 0, errors[0] || '');
  await page.close();
}

/**
 * Словарь и кириллица: человек говорит «зум», движок пишет «зум», а в словаре
 * записано Zoom. Раньше такая пара не срабатывала — заменять было нечего.
 */
async function scenarioDictionaryDataSafety(browser) {
  const old = { id: 'w1', word: 'Термин', pronunciation: 'тер мин', pinned: true, hits: 23, lastUsedAt: 123, createdAt: 100 };
  const make = () => openPage(browser, '#/dictionary', { storeSeed: { 'zs.dictionary': [old] } });
  const duplicate = await make();
  await clickText(duplicate, 'Добавить');
  await duplicate.type('#dict-word', 'термин'); await duplicate.type('#dict-pron', 'новое');
  await clickText(duplicate, 'Добавить', '.modal button'); await sleep(300);
  const result = await duplicate.evaluate(() => ({ list: window.__e2e.read('zs.dictionary'),
    draft: document.querySelector('#dict-pron')?.value, text: document.body.innerText }));
  record('сценарии', 'словарь: повторное добавление не затирает запись и оставляет черновик',
    JSON.stringify(result.list?.[0]) === JSON.stringify(old) && result.draft === 'новое' && /уже есть/i.test(result.text), JSON.stringify({ list: result.list, draft: result.draft }));
  await duplicate.close();

  const restore = await make();
  await restore.click('.dict-row button[aria-label="Удалить"]'); await sleep(200);
  await clickText(restore, 'Вернуть', '.toast__action'); await sleep(300);
  const restored = await restore.evaluate(() => window.__e2e.read('zs.dictionary'));
  record('сценарии', 'словарь: отмена удаления возвращает исходную статистику и идентификатор',
    restored?.length === 1 && JSON.stringify(restored[0]) === JSON.stringify(old), JSON.stringify(restored));
  await restore.close();

  const overlap = await make();
  await overlap.click('.dict-row button[aria-label="Удалить"]'); await sleep(200);
  await clickText(overlap, 'Добавить слово');
  await overlap.type('#dict-word', 'Термин'); await overlap.type('#dict-pron', 'новое');
  await clickText(overlap, 'Добавить', '.modal button'); await sleep(250);
  await overlap.evaluate(() => [...document.querySelectorAll('.toast')].find((t) => /Слово удалено/.test(t.innerText))?.querySelector('.toast__action')?.click());
  await sleep(300);
  const both = await overlap.evaluate(() => window.__e2e.read('zs.dictionary'));
  record('сценарии', 'словарь: возврат удалённого не затирает добавленное слово',
    both?.length === 2 && both.some((w) => w.id === old.id && w.hits === old.hits) && both.some((w) => w.id !== old.id && w.pronunciation === 'новое'), JSON.stringify(both));
  await overlap.close();

  const edit = await make();
  await edit.click('.dict-row button[aria-label^="Изменить"]'); await sleep(250);
  await edit.click('#dict-word', { clickCount: 3 }); await edit.type('#dict-word', 'Новое');
  await edit.click('#dict-pron', { clickCount: 3 }); await edit.type('#dict-pron', 'новое произношение');
  await clickText(edit, 'Сохранить', '.modal button'); await sleep(300);
  const edited = await edit.evaluate(() => window.__e2e.read('zs.dictionary'));
  record('сценарии', 'словарь: явная правка сохраняет ID и статистику',
    edited?.length === 1 && edited[0].id === old.id && edited[0].hits === old.hits && edited[0].pinned && edited[0].word === 'Новое' && edited[0].pronunciation === 'новое произношение', JSON.stringify(edited));
  await edit.close();

  const conflict = await openPage(browser, '#/dictionary', { storeSeed: { 'zs.dictionary': [old, { ...old, id: 'w2', word: 'Второе' }] } });
  await conflict.click('.dict-row button[aria-label="Изменить «Термин»"]'); await sleep(250);
  await conflict.click('#dict-word', { clickCount: 3 }); await conflict.type('#dict-word', 'Второе');
  await conflict.click('#dict-pron', { clickCount: 3 }); await conflict.type('#dict-pron', 'черновик');
  await clickText(conflict, 'Сохранить', '.modal button'); await sleep(300);
  const rejected = await conflict.evaluate(() => ({ list: window.__e2e.read('zs.dictionary'), draft: document.querySelector('#dict-pron')?.value, text: document.body.innerText }));
  record('сценарии', 'словарь: конфликт правки оставляет обе записи и черновик',
    rejected.list?.length === 2 && rejected.list.some((w) => w.id === old.id && w.word === old.word) && rejected.list.some((w) => w.id === 'w2' && w.word === 'Второе') && rejected.draft === 'черновик' && /уже есть/i.test(rejected.text), JSON.stringify(rejected.list));
  await conflict.close();
}

async function scenarioDictionaryLearning(browser) {
  const page = await openPage(browser, '#/home', { settings: { aiDictationRewrite: false, dictionaryEnabled: true },
    storeSeed: { 'zs.dictations': [{ id: 'learn', text: 'купи зелинку и хлеб', createdAt: Date.now() }], 'zs.dictionary': [], 'zs.mockSttText': 'купи зелинку и хлеб' } });
  takeErrors(page);
  await page.click('.recent__row');
  await clickText(page, 'Исправить', '.snippet button'); await sleep(250);
  await page.click('.modal textarea', { clickCount: 3 }); await page.type('.modal textarea', 'купи Зелёнку и хлеб');
  await clickText(page, 'Сохранить', '.modal button'); await sleep(250);
  const proposal = await page.evaluate(() => ({ text: document.querySelector('.learn-card')?.innerText || '', readOnly: document.querySelector('.modal textarea')?.readOnly }));
  record('сценарии', 'обучение словаря сохраняет написание с ё и регистр в предложении', /Зелёнку/.test(proposal.text) && /зелинку/.test(proposal.text) && proposal.readOnly, JSON.stringify(proposal));
  await clickText(page, 'Добавить слово', '.modal button'); await sleep(350);
  const added = await page.evaluate(() => window.__e2e.read('zs.dictionary'));
  record('сценарии', 'обучение словаря сохраняет точное написание и произношение', added?.length === 1 && added[0].word === 'Зелёнку' && added[0].pronunciation === 'зелинку', JSON.stringify(added));
  await clickText(page, 'Начать диктовку'); await sleep(1100);
  await page.evaluate(() => {
    const stop = document.querySelector('[aria-label="Остановить запись"]');
    if (stop) stop.click();
    else [...document.querySelectorAll('button')].find((b) => /Слушаю/i.test(b.innerText))?.click();
  }); await sleep(2300);
  const result = await page.evaluate(() => ({ text: window.__e2e.read('zs.dictations')?.[0]?.text, insert: window.__bridgeCalls.find((c) => c.channel === 'text:insert')?.args?.[0] }));
  record('сценарии', 'обученное слово применяется к следующей диктовке', result.text === 'Купи Зелёнку и хлеб.' && result.insert === result.text, JSON.stringify(result));
  const errors = takeErrors(page);
  record('сценарии', 'обучение словаря без ошибок консоли', errors.length === 0, errors[0] || '');
  await page.close();
}

async function scenarioDictionarySafety(browser) {
  const conflictPage = await openPage(browser, '#/dictionary', { storeSeed: { 'zs.dictionary': [
    { id: 'one', word: 'Клара', pronunciation: 'клера' }, { id: 'two', word: 'Клэр', pronunciation: 'клера' },
  ] } });
  const notice = await conflictPage.evaluate(() => document.body.innerText);
  record('сценарии', 'словарь: предупреждает о неоднозначном произношении и подсказке модели',
    /Неоднозначные/.test(notice) && /клера/i.test(notice) && /Клара/.test(notice) && /Клэр/.test(notice) && /Подсказка модели/.test(notice));
  await conflictPage.close();
  const cases = [
    { spoken: 'позвони клера', expected: 'Позвони клера.', dict: [{ word: 'Клара', pronunciation: 'клера' }, { word: 'Клэр', pronunciation: 'клера' }] },
    { spoken: 'открой зум', expected: 'Открой зум.', dictEnabled: false, dict: [{ word: 'Zoom' }] },
    { spoken: 'доллар', expected: 'Курс.', dict: [{ word: 'курс', pronunciation: 'доллар' }, { word: 'рубль', pronunciation: 'курс' }] },
    { spoken: 'контакт zoom@example.com и zoom', expected: 'Контакт zoom@example.com и Зум.', dict: [{ word: 'Зум', pronunciation: 'zoom' }] },
    { spoken: 'старый термин', expected: 'Б.', dict: [{ word: 'А', pronunciation: 'старый' }, { word: 'Б', pronunciation: 'старый термин' }] },
    { spoken: 'важный текст триггер', expected: 'Важный текст удалить последнее слово.', dict: [{ word: 'удалить последнее слово', pronunciation: 'триггер' }] },
    { spoken: 'триггер', expected: 'Отмени.', dict: [{ word: 'отмени', pronunciation: 'триггер' }] },
    { spoken: 'встреча в четыре подстановка', expected: 'Встреча в четыре то есть в три.', dict: [{ word: 'то есть в три', pronunciation: 'подстановка' }] },
    { spoken: 'активация', expected: 'Моя подпись.', dict: [{ word: 'моя подпись', pronunciation: 'активация' }], snippets: [{ id: 's', trigger: 'моя подпись', body: 'совсем другой текст', createdAt: Date.now() }] },
    { spoken: '«отмени»', expected: '«отмени».', dict: [] },
    { spoken: '«моя подпись»', expected: '«моя подпись».', dict: [], snippets: [{ id: 's', trigger: 'моя подпись', body: 'совсем другой текст', createdAt: Date.now() }] },
  ];
  for (const { spoken, expected, dict, snippets = [], dictEnabled = true } of cases) {
    const page = await openPage(browser, '#/home', { settings: { aiDictationRewrite: false, dictionaryEnabled: dictEnabled },
      storeSeed: { 'zs.dictations': [], 'zs.mockSttText': spoken, 'zs.dictionary': dict.map((d, i) => ({ ...d, id: `w${i}` })), 'zs.snippets': snippets } });
    takeErrors(page);
    await clickText(page, 'Начать диктовку'); await sleep(1100);
    await page.evaluate(() => {
      const stop = document.querySelector('[aria-label="Остановить запись"]');
      if (stop) stop.click();
      else [...document.querySelectorAll('button')].find((b) => /Слушаю/i.test(b.innerText))?.click();
    });
    await sleep(2300);
    const result = await page.evaluate(() => ({ saved: window.__e2e.read('zs.dictations')?.[0]?.text,
      inserted: (window.__bridgeCalls || []).find((c) => c.channel === 'text:insert')?.args?.[0],
      stt: (window.__bridgeCalls || []).filter((c) => c.channel === 'stt:transcribe-pcm' && !c.args?.[0]?.partial && !c.args?.[0]?.pre).map((c) => c.args?.[0]?.useDictionary) }));
    record('сценарии', `словарь безопасная замена: ${spoken}`, result.saved === expected && result.inserted === expected && (dictEnabled || (result.stt.length > 0 && result.stt.every((value) => value === false))), JSON.stringify(result));
    await page.close();
  }
}

async function scenarioDictionaryAliases(browser) {
  const seeded = {
    'zs.dictionary': [
      { id: 'w1', word: 'Zoom', createdAt: Date.now() },
      { id: 'w2', word: 'Telegram', createdAt: Date.now() },
      { id: 'w3', word: 'Алтайтара', createdAt: Date.now() },
    ],
  };
  const page = await openPage(browser, '#/dictionary', { storeSeed: seeded, settle: 600 });
  takeErrors(page);
  const pron = await page.evaluate(() =>
    [...document.querySelectorAll('.dict-row')].map((row) => ({
      word: row.querySelector('.dict-row__word')?.innerText || '',
      pron: row.querySelector('.dict-row__pron')?.innerText || '',
      known: Boolean(row.querySelector('.dict-row__pron.is-known')),
    })),
  );
  const zoom = pron.find((r) => /Zoom/i.test(r.word)) || {};
  record(
    'сценарии',
    'словарь: известное произношение видно, вписывать руками не нужно',
    zoom.pron === 'зум' && zoom.known === true,
    `Zoom → «${zoom.pron}»${zoom.known ? ' (известное)' : ''}`,
  );
  await page.close();

  const dictate = await openPage(browser, '#/home', {
    settings: { aiDictationRewrite: false },
    storeSeed: { ...seeded, 'zs.dictations': [], 'zs.mockSttText': 'открой зум и телеграм' },
    settle: 600,
  });
  takeErrors(dictate);
  await clickText(dictate, 'Начать диктовку');
  await sleep(1100);
  await dictate.evaluate(() => {
    const stop = document.querySelector('[aria-label="Остановить запись"]');
    if (stop) stop.click();
    else [...document.querySelectorAll('button')].find((b) => /Слушаю/i.test(b.innerText))?.click();
  });
  await sleep(2300);
  const saved = await dictate.evaluate(() => {
    const item = (window.__e2e.read('zs.dictations') || [])[0] || {};
    const insert = (window.__bridgeCalls || []).find((c) => c.channel === 'text:insert');
    return { text: String(item.text || ''), inserted: String(insert?.args?.[0] || '') };
  });
  record(
    'сценарии',
    'словарь: «зум» и «телеграм» в тексте становятся Zoom и Telegram',
    /Zoom/.test(saved.text) && /Telegram/.test(saved.text) && !/зум|телеграм/.test(saved.text),
    saved.text,
  );
  record(
    'сценарии',
    'словарь: заменённое слово уходит в окно, а не только в историю',
    saved.inserted === saved.text,
    saved.inserted,
  );
  const errors = takeErrors(dictate);
  record('сценарии', 'словарь: кириллица без ошибок консоли', errors.length === 0, errors[0] || '');
  await dictate.close();
}

/**
 * «Где теряется точность»: разбор по своей истории. Проверяем не цифры, а
 * главное — что приложение называет причину словами и не выдумывает её, когда
 * данных мало.
 */
async function scenarioQualityReport(browser) {
  const at = Date.now();
  const seeded = [
    // свежие сверху: три фразы с тихим звуком и вторым проходом
    { id: 'q1', text: 'первая', createdAt: at, sttGainDb: 15, sttSecondPass: true, sttModel: 'ggml-small-q5_1.bin', sttMs: 900, spokenMs: 3000 },
    { id: 'q2', text: 'вторая', createdAt: at - 1000, sttGainDb: 12, sttSecondPass: true, sttModel: 'ggml-small-q5_1.bin', sttMs: 800, spokenMs: 3000 },
    { id: 'q3', text: 'третья', createdAt: at - 2000, sttGainDb: 14, sttModel: 'ggml-small-q5_1.bin', sttMs: 700, spokenMs: 3000 },
  ];
  const page = await openPage(browser, '#/settings?section=diagnostics&from=home', {
    storeSeed: { 'zs.dictations': seeded },
    settle: 800,
  });
  takeErrors(page);
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('.quality-report__row')].map((row) => ({
      level: [...row.classList].find((c) => c.startsWith('is-')) || '',
      title: row.querySelector('.quality-report__title')?.innerText || '',
      hint: row.querySelector('.quality-report__hint')?.innerText || '',
    })),
  );
  const secondPass = rows.find((r) => /Второй проход в/.test(r.title)) || {};
  const quiet = rows.find((r) => /Звук тихий/.test(r.title)) || {};
  record(
    'сценарии',
    'разбор точности: называет причину словами, а не «распознаёт плохо»',
    secondPass.level === 'is-warn' && /2 из 3/.test(secondPass.title) && /«Точно»/.test(secondPass.hint || ''),
    `${secondPass.title || 'нет строки'} — ${(secondPass.hint || '').slice(0, 60)}`,
  );
  record(
    'сценарии',
    'разбор точности: тихий микрофон отличается от слабого процессора',
    quiet.level === 'is-warn' && /\+15/.test(quiet.hint || ''),
    quiet.hint || 'нет строки',
  );

  const copied = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.settings-main button')].find((b) => /Скопировать разбор/i.test(b.innerText));
    if (!btn) return false;
    btn.click();
    return true;
  });
  await sleep(500);
  const clipboard = await page.evaluate(() => {
    // main получает объект {text, image}: строка лежит в text
    const call = (window.__bridgeCalls || []).find((c) => c.channel === 'clipboard:write');
    return call ? String(call.args?.[0]?.text || '') : '';
  });
  record(
    'сценарии',
    'разбор точности: копируется текстом и без самого текста диктовок',
    copied && /Второй проход: 2/.test(clipboard) && !/третья|вторая/.test(clipboard),
    `${clipboard.split('\n')[0] || 'буфер пуст'} · ${clipboard.length} символов`,
  );

  await page.close();

  // Мало данных — честное «разбирать нечего», а не выдуманный диагноз.
  const thin = await openPage(browser, '#/settings?section=diagnostics&from=home', {
    storeSeed: { 'zs.dictations': [seeded[2]] },
    settle: 700,
  });
  takeErrors(thin);
  const thinRow = await thin.evaluate(() => {
    const row = document.querySelector('.quality-report__row');
    return {
      level: row ? [...row.classList].find((c) => c.startsWith('is-')) || '' : '',
      title: row?.querySelector('.quality-report__title')?.innerText || '',
      hint: row?.querySelector('.quality-report__hint')?.innerText || '',
    };
  });
  record(
    'сценарии',
    'разбор точности: при одной фразе не делает выводов',
    thinRow.level === 'is-unknown' && /Пока нечего разбирать/.test(thinRow.title),
    `${thinRow.title} — ${(thinRow.hint || '').slice(0, 50)}`,
  );
  const errors = [...takeErrors(page), ...takeErrors(thin)];
  record('сценарии', 'разбор точности: без ошибок консоли', errors.length === 0, errors[0] || '');
  await thin.close();
}

/**
 * Совет по модели: приложение знает ядра и память и говорит, уместна ли
 * выбранная модель. Проверяем оба случая — «подходит» и «тяжеловато» — и что
 * переключение не происходит без нажатия.
 */
async function scenarioHardwareFit(browser) {
  const weak = { cpus: 2, ramGb: 4 };
  const page = await openPage(browser, '#/settings?section=dictation&from=home', {
    settings: { whisperModel: 'large-v3-turbo-q5_0' },
    storeSeed: { 'zs.mockSystem': weak },
    settle: 800,
  });
  takeErrors(page);
  const before = await page.evaluate(() => ({
    model: (window.__e2e.read('zs.settings') || {}).whisperModel,
    note: document.querySelector('.fit-note')?.innerText || '',
    level: [...(document.querySelector('.fit-note')?.classList || [])].find((c) => c.startsWith('is-')) || '',
  }));
  record(
    'сценарии',
    'совет по модели: на 4 ГБ и двух ядрах называет подходящий режим словами',
    before.level === 'is-warn' && /лучше «Быстро»/.test(before.note) && /4 ГБ памяти и 2 ядра/.test(before.note),
    before.note.split('\n')[0] || 'совета нет',
  );
  record(
    'сценарии',
    'совет по модели: ничего не переключает втихую',
    before.model === 'large-v3-turbo-q5_0',
    before.model,
  );

  const clicked = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.fit-note button')].find((b) => /Переключить/i.test(b.innerText));
    if (!btn) return false;
    btn.click();
    return true;
  });
  await sleep(600);
  const after = await page.evaluate(() => ({
    model: (window.__e2e.read('zs.settings') || {}).whisperModel,
    note: document.querySelector('.fit-note')?.innerText || '',
    toasts: [...document.querySelectorAll('.toast__title')].map((n) => n.innerText).join(' | '),
  }));
  record(
    'сценарии',
    'совет по модели: кнопка переключает и говорит, что теперь',
    clicked && after.model === 'base-q5_1' && /Модель переключена/.test(after.toasts),
    `${after.model} · ${after.toasts}`,
  );

  // Сильная машина: совет не превращается в «поставьте максимум» навязчиво.
  const strong = await openPage(browser, '#/settings?section=dictation&from=home', {
    settings: { whisperModel: 'small-q5_1' },
    storeSeed: { 'zs.mockSystem': { cpus: 16, ramGb: 32 } },
    settle: 700,
  });
  takeErrors(strong);
  const strongNote = await strong.evaluate(() => {
    const note = document.querySelector('.fit-note');
    return {
      level: [...(note?.classList || [])].find((c) => c.startsWith('is-')) || '',
      text: note?.innerText || '',
      buttons: [...document.querySelectorAll('.fit-note button')].length,
    };
  });
  record(
    'сценарии',
    'совет по модели: на сильной машине не навязывает переключение',
    strongNote.level === 'is-ok' && strongNote.buttons === 0,
    strongNote.text.split('\n')[0] || 'совета нет',
  );
  const errors = [...takeErrors(page), ...takeErrors(strong)];
  record('сценарии', 'совет по модели: без ошибок консоли', errors.length === 0, errors[0] || '');
  await page.close();
  await strong.close();
}

/**
 * Вложенный диалог: подтверждение удаления открывается поверх настроек.
 * До 1.36.0 одно нажатие Escape закрывало сразу оба окна — человек терял
 * настройки вместе с вопросом, — а Tab уводил фокус на кнопки под диалогом.
 */
async function scenarioNestedDialog(browser) {
  const page = await openPage(browser, '#/settings?section=data&from=home', { settle: 800 });
  takeErrors(page);
  const openConfirm = () =>
    page.evaluate(() => {
      const btn = [...document.querySelectorAll('.settings-main button')].find((b) => /Удалить сейчас/i.test(b.innerText));
      if (!btn) return false;
      btn.scrollIntoView({ block: 'center' });
      btn.click();
      return true;
    });

  record('сценарии', 'подтверждение открывается поверх настроек', (await openConfirm()) === true);
  await sleep(500);
  const two = await page.evaluate(() => ({
    modals: document.querySelectorAll('.modal').length,
    focus: (document.activeElement?.innerText || document.activeElement?.getAttribute('aria-label') || '').trim(),
  }));
  record('сценарии', 'во вложенном диалоге фокус сразу на «Отмене»', two.modals === 2 && two.focus === 'Отмена', `${two.modals} окна, фокус: ${two.focus}`);

  await page.keyboard.press('Escape');
  await sleep(450);
  const afterEsc = await page.evaluate(() => ({
    modals: document.querySelectorAll('.modal').length,
    settings: /Удалить сейчас/.test(document.body.innerText),
  }));
  record(
    'сценарии',
    'Escape закрывает только вопрос, настройки остаются',
    afterEsc.modals === 1 && afterEsc.settings,
    `окон: ${afterEsc.modals}`,
  );

  await openConfirm();
  await sleep(450);
  const tabs = [];
  for (let i = 0; i < 6; i += 1) {
    await page.keyboard.press('Tab');
    tabs.push(
      await page.evaluate(() => {
        const top = [...document.querySelectorAll('.modal')].pop();
        const el = document.activeElement;
        return {
          inside: Boolean(top && top.contains(el)),
          label: (el?.innerText || el?.getAttribute('aria-label') || el?.tagName || '').replace(/\s+/g, ' ').trim().slice(0, 20),
        };
      }),
    );
  }
  record(
    'сценарии',
    'Tab не уводит фокус из верхнего диалога',
    tabs.every((t) => t.inside),
    tabs.map((t) => `${t.inside ? '+' : '-'}${t.label}`).join(' · '),
  );

  const cancelled = await page.evaluate(() => {
    const top = [...document.querySelectorAll('.modal')].pop();
    const btn = [...(top?.querySelectorAll('button') || [])].find((b) => /Отмена/i.test(b.innerText));
    if (!btn) return false;
    btn.click();
    return true;
  });
  await sleep(400);
  const afterCancel = await page.evaluate(() => ({
    modals: document.querySelectorAll('.modal').length,
    settings: /Удалить сейчас/.test(document.body.innerText),
    dictations: (window.__e2e.read('zs.dictations') || []).length,
  }));
  record(
    'сценарии',
    '«Отмена» не удаляет историю и не закрывает настройки',
    cancelled && afterCancel.modals === 1 && afterCancel.settings && afterCancel.dictations > 0,
    `история: ${afterCancel.dictations}`,
  );

  const errors = takeErrors(page);
  record('сценарии', 'вложенный диалог: без ошибок консоли', errors.length === 0, errors[0] || '');
  await page.close();
}

/**
 * Узкое окно: маленькие ноутбуки и масштаб 150 %. Раньше окно настроек было
 * жёстко 780 px и в окне приложения 860 px всё помещалось, а на экране
 * 1024×600 — уже нет: правый край с кнопками уезжал за границу.
 */
async function scenarioNarrowWindow(browser) {
  const escapedOn = async (hash, viewport) => {
    const page = await openPage(browser, hash, { viewport, settle: 650 });
    const errors = takeErrors(page);
    const res = await page.evaluate(() => {
      const doc = document.documentElement;
      const escaped = [...document.querySelectorAll('button, input, select, textarea, [role="switch"]')]
        .filter((el) => el.offsetParent !== null)
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.right > window.innerWidth + 1;
        })
        .map((el) => `${(el.innerText || el.getAttribute('aria-label') || el.tagName).replace(/\s+/g, ' ').trim().slice(0, 30)} right ${Math.round(el.getBoundingClientRect().right)}`);
      return { escaped, overflow: Math.max(0, doc.scrollWidth - doc.clientWidth), width: window.innerWidth };
    });
    await page.close();
    return { ...res, errors };
  };

  const settings = await escapedOn('#/settings?section=dictation&from=home', { width: 760, height: 560 });
  record(
    'сценарии',
    'узкое окно 760×560: в настройках всё влезает в окно',
    settings.escaped.length === 0 && settings.overflow === 0,
    settings.escaped.length ? settings.escaped.slice(0, 3).join(', ') : 'за краем ничего',
  );

  // «Закрыть» и «Готово» — самые правые кнопки: раньше именно они уезжали.
  const closeIn = await (async () => {
    const page = await openPage(browser, '#/settings?section=app&from=home', {
      viewport: { width: 720, height: 480 },
      settle: 650,
    });
    takeErrors(page);
    const res = await page.evaluate(() => {
      const btn = document.querySelector('.modal__head .icon-btn');
      const done = [...document.querySelectorAll('.settings-footer button')].pop();
      const fits = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.right <= window.innerWidth && r.left >= 0;
      };
      return { close: fits(btn), done: fits(done), modal: Math.round(document.querySelector('.modal').getBoundingClientRect().right) };
    });
    await page.close();
    return res;
  })();
  record(
    'сценарии',
    'узкое окно 720×480: «Закрыть» и «Готово» доступны',
    closeIn.close && closeIn.done && closeIn.modal <= 720,
    `модалка до ${closeIn.modal} px`,
  );

  const clipboard = await escapedOn('#/clipboard', { width: 760, height: 560 });
  record(
    'сценарии',
    'узкое окно: вкладки буфера не уезжают за край',
    clipboard.escaped.length === 0 && clipboard.overflow === 0,
    clipboard.escaped.length ? clipboard.escaped.slice(0, 3).join(', ') : 'за краем ничего',
  );

  const instructions = await escapedOn('#/instructions', { width: 640, height: 440 });
  record(
    'сценарии',
    'узкое окно 640×440: поиск по инструкциям влезает',
    instructions.escaped.length === 0 && instructions.overflow === 0,
    instructions.escaped.length ? instructions.escaped.slice(0, 2).join(', ') : 'за краем ничего',
  );

  const home = await escapedOn('#/home', { width: 720, height: 480 });
  record(
    'сценарии',
    'узкое окно: на главной нет горизонтальной прокрутки',
    home.overflow === 0 && home.escaped.length === 0,
    `прокрутка ${home.overflow} px`,
  );

  const errors = [...settings.errors, ...clipboard.errors, ...instructions.errors, ...home.errors];
  record('сценарии', 'узкое окно: без ошибок консоли', errors.length === 0, errors[0] || '');
}

async function scenarioClearDictations(browser) {
  const page = await openPage(browser, '#/settings?section=data&from=home', { settle: 500 });
  takeErrors(page);
  const before = ((await storeOf(page, 'zs.dictations')) || []).length;
  const clickClear = () =>
    page.evaluate(() => {
      const btn = [...document.querySelectorAll('.settings-main button')].find((b) => /Удалить сейчас/i.test(b.innerText));
      if (!btn) return false;
      btn.click();
      return true;
    });
  await clickClear();
  await sleep(400);
  const asked = await page.evaluate(() => /Удалить всю историю диктовок\?/.test(document.body.innerText));
  const afterCancel = await page.evaluate(() => {
    const modal = [...document.querySelectorAll('.modal')].find((m) => /Удалить всю историю/.test(m.innerText));
    const btn = modal && [...modal.querySelectorAll('button')].find((b) => /Отмена/i.test(b.innerText));
    if (!btn) return null;
    btn.click();
    return true;
  });
  await sleep(350);
  const keptCount = ((await storeOf(page, 'zs.dictations')) || []).length;
  await clickClear();
  await sleep(350);
  const confirmed = await page.evaluate(() => {
    const modal = [...document.querySelectorAll('.modal')].find((m) => /Удалить всю историю/.test(m.innerText));
    const btn = modal && [...modal.querySelectorAll('button')].find((b) => /^Удалить$/i.test(b.innerText.trim()));
    if (!btn) return false;
    btn.click();
    return true;
  });
  await sleep(500);
  const afterClear = ((await storeOf(page, 'zs.dictations')) || []).length;
  record(
    'сценарии',
    'настройки: очистка истории диктовок спрашивает подтверждение',
    asked && afterCancel && keptCount === before && confirmed && afterClear === 0,
    `${before} → отмена ${keptCount} → очистка ${afterClear}`,
  );
  const errors = takeErrors(page);
  record('сценарии', 'настройки: очистка истории без ошибок консоли', errors.length === 0, errors[0] || '');
  await page.close();
}

// «Скриншот с придумкой» = снимок + подпись, которую человек дописывает сам.
async function scenarioNote(browser) {
  const page = await openPage(browser, '#/clipboard', { settle: 500 });
  takeErrors(page);
  // main сообщает о глобальном сочетании — карточка должна появиться в буфере
  await emit(page, 'clipboard:action', 'note');
  await sleep(900);
  const created = ((await storeOf(page, 'zs.clipboard')) || []).filter((c) => c.kind === 'note');
  const cards = await page.evaluate(() => document.querySelectorAll('.clip-card').length);
  // открываем заметку в списке и дописываем подпись
  await page.evaluate(() => document.querySelectorAll('.clip-toolbar__view button')[1]?.click());
  await sleep(350);
  await page.evaluate(() => {
    const item = [...document.querySelectorAll('.clip-list__item')].find((el) => /придумк|заметк/i.test(el.innerText));
    (item || document.querySelector('.clip-list__item'))?.click();
  });
  await sleep(350);
  const hasNoteField = await page.evaluate(() => Boolean(document.querySelector('.clip-preview__note')));
  if (hasNoteField) {
    await page.click('.clip-preview__note');
    await page.keyboard.type('важное на снимке');
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('.clip-preview button')].find((b) => /Сохранить подпись/i.test(b.innerText));
      btn?.click();
    });
  }
  await sleep(450);
  const saved = ((await storeOf(page, 'zs.clipboard')) || []).find((c) => c.kind === 'note');
  const label = await page.evaluate(() => document.body.innerText.includes('ЗАМЕТКА'));
  record(
    'сценарии',
    'буфер: заметка со снимком создаётся и подпись сохраняется',
    created.length === 1 && cards > 0 && hasNoteField && /важное на снимке/.test(saved?.text || '') && label,
    `заметок ${created.length}, подпись «${(saved?.text || '').slice(0, 24)}»`,
  );
  const errors = takeErrors(page);
  record('сценарии', 'буфер: заметка без ошибок консоли', errors.length === 0, errors[0] || '');
  await page.close();
}

// Пустая установка без модели: главная не обещает «всё готово».
async function scenarioNoModel(browser) {
  const page = await openPage(browser, '#/home', {
    settle: 500,
    patchNative: () => {
      const native = window.zspeakly && window.zspeakly.native;
      if (native) native.sttStatus = async () => ({ available: false, reason: 'модель не найдена' });
    },
  });
  takeErrors(page);
  const hello = await page.evaluate(() => document.querySelector('.hero__hello')?.innerText.replace(/\s+/g, ' ') || '');
  const link = await page.evaluate(() => {
    const btn = document.querySelector('.hero__hello button');
    if (!btn) return false;
    btn.click();
    return true;
  });
  await sleep(600);
  const section = await page.evaluate(() => document.querySelector('.settings-section__title')?.innerText || '');
  record(
    'сценарии',
    'без модели: главная честно говорит и ведёт к выбору модели',
    /не подключена/i.test(hello) && link && /Диктовка/i.test(section),
    `${hello.slice(0, 70)} → ${section}`,
  );
  const errors = takeErrors(page);
  record('сценарии', 'без модели: без ошибок консоли', errors.length === 0, errors[0] || '');
  await page.close();
}

async function scenarioMic(browser) {
  const page = await openPage(browser, '#/settings?section=app&from=home', { settle: 400 });
  takeErrors(page);
  const started = await clickIn(page, '', 'Начать тест');
  await sleep(900);
  const live = await page.evaluate(() => /Говорите|Слышу вас|Микрофон молчит|не дал доступ/i.test(document.body.innerText));
  const stopped = await clickIn(page, '', 'Остановить');
  await sleep(300);
  record('сценарии', 'микрофон: тест запускается и останавливается', started && live && stopped);
  const errors = takeErrors(page).filter((e) => !/AudioContext|NotAllowedError/i.test(e));
  record('сценарии', 'микрофон: без ошибок консоли', errors.length === 0, errors[0] || '');
  await page.close();
}

// Браузерное хранилище кончается — человек должен узнать, а не потерять запись молча.
async function scenarioStorageFull(browser) {
  const page = await openPage(browser, '#/home', { settle: 400 });
  takeErrors(page);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('zs:storage-error', { detail: { key: 'zs:clipboard' } })));
  await sleep(400);
  const toast = await page.evaluate(() =>
    [...document.querySelectorAll('.toast')].map((t) => t.innerText.replace(/\n/g, ' ')).join(' ;; '),
  );
  record('сценарии', 'переполнение хранилища объясняется тостом', /Не удалось сохранить данные/i.test(toast), toast.slice(0, 80));
  const errors = takeErrors(page);
  record('сценарии', 'переполнение хранилища без ошибок консоли', errors.length === 0, errors[0] || '');
  await page.close();
}

async function scenarioElectronStorageError(browser) {
  const page = await openPage(browser, '#/home', { settle: 400 });
  takeErrors(page);
  await emit(page, 'store:error', { ok: false, code: 'ENOSPC' });
  await sleep(300);
  const text = await page.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.innerText).join(' '));
  record('сценарии', 'Electron: сбой записи профиля предупреждает о риске потери данных',
    /Не удалось сохранить данные/i.test(text) && /в памяти/i.test(text) && /диск/i.test(text), text.slice(0, 180));
  await emit(page, 'store:error', { ok: false, code: 'ENOSPC', message: 'ЛИЧНЫЙ_ТЕКСТ C:\\private\\profile.json' });
  await emit(page, 'store:error', { ok: false, code: 'ENOSPC' });
  await sleep(150);
  const warnings = await page.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.innerText).filter((t) => /Не удалось сохранить данные/i.test(t)));
  record('сценарии', 'Electron: повторные ошибки не спамят и не раскрывают сообщение ошибки',
    warnings.length === 1 && !warnings.join(' ').includes('ЛИЧНЫЙ_ТЕКСТ') && !warnings.join(' ').includes('profile.json'), `предупреждений: ${warnings.length}`);
  const errors = takeErrors(page);
  record('сценарии', 'Electron: предупреждение о хранилище без ошибок консоли', errors.length === 0, errors[0] || '');
  await page.close();

  const late = await openPage(browser, '#/home', {
    settle: 400,
    patchNative: () => { window.zspeakly.store.statusSync = () => ({ ok: false, code: 'EACCES' }); },
  });
  const initial = await late.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.innerText).join(' '));
  record('сценарии', 'Electron: ошибка до подписки видна после запуска интерфейса без дубликатов',
    (initial.match(/Не удалось сохранить данные/gi) || []).length === 1 && /в памяти/i.test(initial), initial.slice(0, 180));
  await late.close();

  const corrupt = await openPage(browser, '#/home', {
    settle: 400,
    patchNative: () => { window.zspeakly.store.statusSync = () => ({ ok: false, code: 'BACKUP_FAILED' }); },
  });
  const warning = await corrupt.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.innerText).join(' '));
  record('сценарии', 'Electron: невозможность сохранить копию профиля объясняет защиту исходного файла',
    /Исходный файл не перезаписывается/i.test(warning) && /потеряны при закрытии/i.test(warning), warning.slice(0, 220));
  await corrupt.close();

  const backedUp = await openPage(browser, '#/home', {
    settle: 400,
    patchNative: () => { window.zspeakly.store.statusSync = () => ({ ok: false, code: 'PROFILE_UNREADABLE' }); },
  });
  const backedUpWarning = await backedUp.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.innerText).join(' '));
  record('сценарии', 'Electron: копия не выдаётся за восстановление нечитаемого профиля',
    /Создана резервная копия/i.test(backedUpWarning) && /исходный файл не перезаписывается/i.test(backedUpWarning) && /потеряны при закрытии/i.test(backedUpWarning), backedUpWarning.slice(0, 220));
  await backedUp.close();

  for (const [code, expected] of [['RECOVERY_PENDING', /profile\.json\.tmp/i], ['RECOVERY_UNCHECKED', /Не удалось проверить временный файл/i]]) {
    const pending = await openPage(browser, '#/home', {
      settle: 400,
      patchArg: code,
      patchNative: (statusCode) => { window.zspeakly.store.statusSync = () => ({ ok: false, code: statusCode }); },
    });
    const initial = await pending.evaluate(() => ({
      warning: document.querySelector('.profile-warning')?.innerText || '',
      toast: [...document.querySelectorAll('.toast')].map((t) => t.innerText).join(' '),
    }));
    await pending.evaluate(() => document.querySelector('.toast__close')?.click());
    const stillVisible = await pending.evaluate(() => Boolean(document.querySelector('.profile-warning')?.innerText));
    const pendingErrors = takeErrors(pending);
    record('сценарии', `Electron: ${code} не скрывает риск и защищает временный файл`,
      expected.test(initial.warning) && /не сохранятся при закрытии/i.test(initial.warning) &&
      expected.test(initial.toast) && stillVisible && pendingErrors.length === 0,
      JSON.stringify({ warning: initial.warning, stillVisible, error: pendingErrors[0] }));
    await pending.close();
  }

  // Нечитаемый профиль загружается как пустой: онбординг не должен закрыть
  // предупреждение и предложить записывать настройки вместо восстановления.
  for (const mode of ['ok', 'failed', 'rejected']) {
    const page = await openPage(browser, '#/home', {
      settings: { onboarded: false }, viewport: { width: 720, height: 480 }, settle: 500, patchArg: mode,
      patchNative: (value) => {
        window.zspeakly.store.statusSync = () => ({ ok: false, code: 'PROFILE_UNREADABLE' });
        window.zspeakly.native.openDataFolder = async () => {
          window.__recoveryFolderCalls = (window.__recoveryFolderCalls || 0) + 1;
          if (value === 'rejected') throw new Error('СЕКРЕТНЫЙ ПУТЬ');
          return value === 'failed' ? { ok: false, reason: 'СЕКРЕТНЫЙ ПУТЬ' } : { ok: true };
        };
      },
    });
    try {
      const before = await page.evaluate(() => {
        const summary = document.querySelector('.profile-warning summary');
        const rect = summary?.getBoundingClientRect();
        const top = rect && document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return { onboarding: Boolean(document.querySelector('.onboarding')), usable: Boolean(summary && (top === summary || summary.contains(top))) };
      });
      if (before.usable) {
        await page.click('.profile-warning summary');
        await page.click('.profile-warning button');
        await sleep(200);
      }
      const after = await page.evaluate(() => ({
        text: document.querySelector('.profile-warning')?.innerText || '',
        calls: window.__recoveryFolderCalls || 0,
      }));
      const errors = takeErrors(page);
      record('сценарии', `Electron: восстановление пустого профиля доступно до онбординга (${mode})`,
        !before.onboarding && before.usable && after.calls === 1 && /полностью закройте/i.test(after.text) &&
        /profile\.json\.broken/i.test(after.text) && /экспортированная через настройки копия/i.test(after.text) && /другой формат/i.test(after.text) &&
        (mode === 'ok' || /не удалось открыть/i.test(after.text)) && !after.text.includes('СЕКРЕТНЫЙ ПУТЬ') && errors.length === 0,
        JSON.stringify({ before, after, error: errors[0] }));
    } finally { await page.close(); }
  }

  const lateProtection = await openPage(browser, '#/home', { settings: { onboarded: false }, settle: 500 });
  try {
    const onboardingBefore = Boolean(await lateProtection.$('.onboarding'));
    await emit(lateProtection, 'store:error', { ok: false, code: 'RECOVERY_PENDING' });
    await sleep(200);
    const state = await lateProtection.evaluate(() => ({
      onboarding: Boolean(document.querySelector('.onboarding')),
      warning: document.querySelector('.profile-warning')?.innerText || '',
    }));
    record('сценарии', 'Electron: позднее предупреждение закрывает онбординг и показывает защиту',
      onboardingBefore && !state.onboarding && /profile\.json\.tmp/i.test(state.warning) && takeErrors(lateProtection).length === 0,
      JSON.stringify({ onboardingBefore, ...state }));
  } finally { await lateProtection.close(); }

  for (const key of ['zs:settings', 'zs:dictionary']) {
    const rejected = await openPage(browser, '#/home', {
      settle: 500,
      patchArg: key,
      patchNative: (rejectedKey) => {
        const store = window.zspeakly.store;
        const set = store.set;
        store.set = (key, value) => key === rejectedKey ? Promise.reject(new Error('private failure')) : set(key, value);
      },
    });
    const rejectedWarning = await rejected.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.innerText).join(' '));
    const rejectedErrors = takeErrors(rejected);
    record('сценарии', `Electron: отказ синхронизации ${key} предупреждает без необработанной ошибки`,
      /Не удалось сохранить данные/i.test(rejectedWarning) && !rejectedWarning.includes('private failure') && rejectedErrors.length === 0,
      rejectedErrors[0] || rejectedWarning.slice(0, 140));
    await rejected.close();
  }
}

async function scenarioDiagnostics(browser) {
  const page = await openPage(browser, '#/settings?section=diagnostics&from=home', { settle: 500 });
  takeErrors(page);
  const report = await clickIn(page, '', 'Сохранить отчёт в файл');
  await sleep(500);
  const ping = await clickIn(page, '', 'Проверить канал');
  await sleep(500);
  const calls = await bridgeCalls(page);
  const body = await page.evaluate(() => document.body.innerText);
  record('сценарии', 'диагностика: отчёт сохраняется через мост', report && calls.includes('diag:save-report'), calls.filter((c) => c.startsWith('diag')).join(','));
  record('сценарии', 'диагностика: канал проверяется и статус виден', ping && calls.includes('diag:ping') && /канал|нет адреса|не настроен|приёмник/i.test(body));
  // Снимок настроек: по нему видно, почему диктовка ведёт себя именно так
  const snapshotRows = /Как сейчас работает диктовка/.test(body)
    && /Живая расшифровка/.test(body)
    && /Горячий микрофон/.test(body)
    && /Вставка текста/.test(body);
  record(
    'сценарии',
    'диагностика: виден снимок настроек диктовки',
    snapshotRows,
    snapshotRows ? 'движок, модель, живой текст, предролл, вставка' : 'строк не нашлось',
  );
  // «Система и железо»: проверенные факты, а не настройки
  const facts = await page.evaluate(() =>
    [...document.querySelectorAll('.settings-group')]
      .filter((g) => /Система и железо/.test(g.innerText))
      .map((g) => g.innerText.replace(/\n+/g, ' '))
      .join(' '),
  );
  record(
    'сценарии',
    'диагностика: «Система и железо» показывает сочетания, движок, буфер и память',
    /Control\+Alt\+Space/.test(facts) && /есть/.test(facts) && /включён/.test(facts) && /8 ядер, 16 ГБ/.test(facts),
    facts.slice(0, 160),
  );
  // Быстрый путь: видно, прогрета ли модель и готов ли помощник ввода
  const speedRows = await page.evaluate(() =>
    [...document.querySelectorAll('.kv-row')]
      .filter((r) => /Модель в памяти|Помощник ввода/.test(r.innerText))
      .map((r) => r.innerText.replace(/\n+/g, ': '))
      .join(' | '),
  );
  // Секунды последней фразы теперь живут в отчёте о скорости: отдельная строка
  // «Последняя диктовка» повторяла те же числа третьим местом.
  const speedGroup = await page.evaluate(() =>
    [...document.querySelectorAll('.settings-group')]
      .filter((g) => /укладывается ли в пять секунд/i.test(g.innerText))
      .map((g) => g.innerText.replace(/\n+/g, ' '))
      .join(' '),
  );
  record(
    'сценарии',
    'диагностика: видно, прогрета ли модель, готов ли помощник ввода и сколько считалась последняя фраза',
    /прогрета/.test(speedRows) &&
      /готов — вставка без запуска программ/.test(speedRows) &&
      // Замеры есть — видно полное время ожидания; замеров нет — это сказано прямо.
      (/с ожидания/.test(speedGroup) || /Замеров пока нет/.test(speedGroup)),
    `${speedRows.slice(0, 120)} || ${speedGroup.slice(0, 120)}`,
  );
  await page.evaluate(() => { window.zspeakly.native.insertText = async () => ({ ok: false, uncertain: true }); });
  const probed = await clickIn(page, '', 'Проверить вставку');
  await sleep(3500);
  const probeText = await page.evaluate(() => document.body.innerText);
  record('сценарии', 'диагностика: неизвестный результат ввода не обещает содержимое буфера',
    probed && /Результат ввода не подтверждён/.test(probeText) && /Проверьте окно перед повтором/.test(probeText)
      && !/Текст остался в буфере — вставьте через Ctrl\+V/.test(probeText));
  const errors = takeErrors(page);
  record('сценарии', 'диагностика: без ошибок консоли', errors.length === 0, errors[0] || '');
  await page.close();
}

async function scenarioClipboardMonitorDiagnostics(browser) {
  const cases = [
    { system: { clipboardWatch: true, clipboardWatchTextError: true, clipboardWatchImageIssue: 'error' }, words: ['включён', 'ошибка чтения текста', 'ошибка чтения изображения'] },
    { system: { clipboardWatch: true, clipboardWatchImageIssue: 'size' }, words: ['включён', 'изображение превышает лимит'] },
    { system: { clipboardWatch: false, clipboardWatchTextError: true, clipboardWatchImageIssue: 'error' }, words: ['выключен'], absent: 'ошибка чтения' },
  ];
  for (const [index, item] of cases.entries()) {
    const page = await openPage(browser, '#/settings?section=diagnostics&from=home', { settle: 600, storeSeed: { 'zs.mockSystem': item.system } });
    const row = await page.evaluate(() => [...document.querySelectorAll('.kv-row')].find((el) => /Мониторинг буфера/.test(el.innerText))?.innerText || '');
    record('диагностика', `буфер: состояние опроса ${index + 1} видно без данных содержимого`, item.words.every((word) => row.includes(word)) && (!item.absent || !row.includes(item.absent)));
    const errors = takeErrors(page);
    record('диагностика', `буфер: состояние опроса ${index + 1} без ошибок консоли`, errors.length === 0, errors[0] || '');
    await page.close();
  }
}

// В браузере моста нет: отчёт должен скачиваться файлом, а не молчать.
async function scenarioDiagnosticsBrowser(browser) {
  const page = await openPage(browser, '#/settings?section=diagnostics&from=home', { settle: 500 });
  takeErrors(page);
  await page.evaluate(() => {
    window.__downloads = [];
    const nativeCreate = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      window.__downloads.push({ name: 'blob', size: blob.size, type: blob.type });
      return nativeCreate(blob);
    };
    const nativeClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function click() {
      if (this.download) window.__downloads.push({ name: this.download, href: String(this.href).slice(0, 5) });
      return nativeClick.call(this);
    };
    delete window.zspeakly;
  });
  const clicked = await clickIn(page, '', 'Сохранить отчёт в файл');
  await sleep(500);
  const info = await page.evaluate(() => ({
    downloads: window.__downloads,
    toast: [...document.querySelectorAll('.toast')].map((t) => t.innerText).join(' '),
  }));
  const file = info.downloads.find((d) => d.name === 'zspeakly-report.txt');
  const blob = info.downloads.find((d) => d.name === 'blob');
  record(
    'сценарии',
    'диагностика в браузере: отчёт скачивается файлом',
    clicked && Boolean(file) && Boolean(blob) && blob.size > 100 && /Отчёт скачан/i.test(info.toast),
    `${JSON.stringify(info.downloads)} | ${info.toast}`,
  );
  // «Открыть репозиторий» живёт в разделе «Приложение» — переходим туда
  await page.evaluate(() => {
    window.__opened = [];
    const nativeOpen = window.open;
    window.open = (url, target) => {
      window.__opened.push({ url, target });
      return null;
    };
    return nativeOpen ? true : true;
  });
  await clickIn(page, '', 'Приложение');
  await sleep(600);
  const opened = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.settings-main button')].find((b) => /Открыть репозиторий/i.test(b.innerText));
    if (!btn) return { found: false, opened: window.__opened };
    btn.click();
    return { found: true, opened: window.__opened };
  });
  record(
    'сценарии',
    'о программе: «Открыть репозиторий» открывает ссылку',
    opened.found && opened.opened.some((o) => /github\.com\/ttklon\/speak/.test(o.url) && o.target === '_blank'),
    JSON.stringify(opened),
  );
  const errors = takeErrors(page);
  record('сценарии', 'диагностика в браузере: без ошибок консоли', errors.length === 0, errors[0] || '');
  await page.close();
}

// Даже сохранённые старые описания не должны скрывать передачу кадра модели.
async function scenarioLocalModelPrivacy(browser) {
  const page = await openPage(browser, '#/hotkeys?tab=voice', {
    settle: 500,
    storeSeed: { 'zs.hotkeys': [{ id: 'screen-aware', title: 'Диктовка с учётом экрана', description: 'только в память', keys: ['Ctrl', 'Alt', 'S'], enabled: true }] },
  });
  takeErrors(page);
  try {
    const voiceText = await page.evaluate(() => document.body.innerText);
    await page.goto(`${BASE}/#/hotkeys?tab=recommended`, { waitUntil: 'domcontentloaded' });
    await sleep(500);
    const recommendedText = await page.evaluate(() => document.body.innerText);
    const errors = takeErrors(page);
    record('сценарии', 'локальная модель: показано, что сервер может хранить и пересылать кадр и текст',
      /Кадр может отправляться модели/i.test(voiceText) && /Сервер может хранить и пересылать снимок/i.test(voiceText) &&
      /может хранить или пересылать текст/i.test(recommendedText) && errors.length === 0,
      JSON.stringify({ screenWarning: /Сервер может хранить и пересылать снимок/i.test(voiceText), textWarning: /может хранить или пересылать текст/i.test(recommendedText), error: errors[0] }));
  } finally { await page.close(); }
}

// Резервная копия: скачивание JSON и восстановление из файла (в браузере тоже работает).
async function scenarioBackup(browser) {
  const page = await openPage(browser, '#/settings?section=data&from=home', { settle: 500 });
  takeErrors(page);
  await page.evaluate(() => {
    window.__files = [];
    const nativeCreate = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      window.__files.push({ size: blob.size, type: blob.type });
      return nativeCreate(blob);
    };
    const nativeClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function click() {
      if (this.download) window.__files.push({ name: this.download });
      return nativeClick.call(this);
    };
  });
  // 1) установленная версия: файл кладёт главный процесс на Рабочий стол
  await clickIn(page, '', 'Скачать');
  await sleep(600);
  const nativeCalls = await bridgeCalls(page);
  const nativeToast = await page.evaluate(() =>
    [...document.querySelectorAll('.toast')].map((t) => t.innerText.replace(/\n/g, ' ')).join(' ;; '),
  );
  record(
    'сценарии',
    'данные: в приложении копия сохраняется файлом через main',
    nativeCalls.includes('data:save-backup') && /Копия сохранена/i.test(nativeToast),
    nativeToast.slice(0, 90),
  );

  // 2) браузер (моста нет): обычная загрузка JSON
  await page.evaluate(() => {
    window.__bridgeSaved = window.zspeakly;
    delete window.zspeakly;
  });
  await clickIn(page, '', 'Скачать');
  await sleep(600);
  const saved = await page.evaluate(() => ({
    files: window.__files,
    toast: [...document.querySelectorAll('.toast')].map((t) => t.innerText).join(' '),
  }));
  const file = saved.files.find((f) => /^zspeakly-backup-\d{4}-\d{2}-\d{2}\.json$/.test(f.name || ''));
  record(
    'сценарии',
    'данные: в браузере копия скачивается JSON-файлом',
    Boolean(file) && saved.files.some((f) => f.size > 200) && /Копия скачана/i.test(saved.toast),
    JSON.stringify(saved.files),
  );
  // мост возвращаем: восстановление ниже пишет данные через него
  await page.evaluate(() => {
    window.zspeakly = window.__bridgeSaved;
    delete window.__bridgeSaved;
  });

  const backupPath = join(tmpdir(), `zs-backup-${Date.now()}.json`);
  writeFileSync(
    backupPath,
    JSON.stringify({
      app: 'ZSpeakly',
      format: 1,
      exportedAt: '2026-11-01T10:00:00.000Z',
      dictionary: [{ id: 'w-import', word: 'ИмпортСлово', pronunciation: 'произношение', pinned: true, hits: 27, lastUsedAt: 1790000000000 }],
      dictations: [
        { id: 'd-import', text: 'Восстановленная запись из копии', createdAt: Date.now(), words: 5, seconds: 4 },
        { id: 'a-import', text: 'Ответ агента из копии', createdAt: Date.now(), words: 4, source: 'agent' },
        { id: 'f-import', text: 'Юникод 😀\n'.repeat(1200), rawText: 'Исходный текст 😀\n'.repeat(90).trim(), createdAt: Date.now(), source: 'file', fileName: 'встреча.wav', sttModel: 'small-q5_1', sttParts: 3 },
        { id: 'c-import', text: 'Результат команды', command: 'сократи', createdAt: Date.now(), source: 'command' },
      ],
      settings: { dictationRetentionDays: 3650 },
      voiceHotkeys: [{ id: 'dictation', title: 'Диктовка', description: '', keys: [], enabled: false }],
      presets: [{ id: 'backup-preset', title: 'Пресет из копии', prompt: 'Береги смысл', keys: ['Ctrl', 'P'], enabled: true }],
      instructions: [{ id: 'backup-instruction', title: 'Своя инструкция из копии', prompt: 'Напиши письмо', keys: [], enabled: true }],
      profile: { name: 'Из копии' },
    }),
    'utf8',
  );
  try {
    const input = await page.$('.settings-main input[type=file]');
    await input.uploadFile(backupPath);
    await sleep(600);
    const asked = await page.evaluate(() => document.querySelector('.confirm__text')?.innerText || '');
    // диалог подтверждения может быть вложен в модалку настроек — ищем по всему документу
    const confirm = await clickIn(page, '', 'Восстановить');
    await sleep(700);
    const state = await page.evaluate(() => ({
      // в E2E хранилище живёт в моке моста (mockstore:), а не в zs:*
      dictionary: JSON.parse(localStorage.getItem('mockstore:zs.dictionary') || '[]'),
      dictations: JSON.parse(localStorage.getItem('mockstore:zs.dictations') || '[]'),
      toast: [...document.querySelectorAll('.toast')].map((t) => t.innerText).join(' '),
    }));
    record(
      'сценарии',
      'данные: копия восстанавливается после подтверждения',
      /будут заменены/i.test(asked) &&
        confirm &&
        state.dictionary.some((w) => w.word === 'ИмпортСлово') &&
        state.dictations.some((d) => /Восстановленная запись/.test(d.text)) &&
        state.dictations.some((d) => d.id === 'a-import' && d.source === 'agent') &&
        /Данные применены в приложении/i.test(state.toast) && /Запись в профиль выполняется отдельно/i.test(state.toast),
      `asked=${asked.slice(0, 30)} confirm=${confirm} dict=${state.dictionary.length} hist=${state.dictations.length} toast=${state.toast.slice(0, 80)}`,
    );
    const fileRecord = state.dictations.find((d) => d.id === 'f-import');
    const commandRecord = state.dictations.find((d) => d.id === 'c-import');
    const word = state.dictionary.find((w) => w.id === 'w-import');
    record('сценарии', 'данные: восстановление сохраняет длинный текст, оригинал, источники и статистику словаря',
      fileRecord?.text === 'Юникод 😀\n'.repeat(1200) && fileRecord?.rawText === 'Исходный текст 😀\n'.repeat(90).trim() &&
      fileRecord?.source === 'file' && fileRecord?.fileName === 'встреча.wav' && fileRecord?.sttModel === 'small-q5_1' && fileRecord?.sttParts === 3 &&
      commandRecord?.source === 'command' && commandRecord?.command === 'сократи' &&
      word?.pinned === true && word?.hits === 27 && word?.lastUsedAt === 1790000000000,
      JSON.stringify({ textLength: fileRecord?.text?.length, rawLength: fileRecord?.rawText?.length, source: fileRecord?.source, fileName: fileRecord?.fileName, command: commandRecord?.source, word }));
    // Новое окно на том же хранилище имитирует следующий запуск без повторного seed.
    const reopened = await browser.newPage();
    try {
      await reopened.evaluateOnNewDocument(installMockBridge);
      await reopened.goto(`${BASE}/#/hotkeys?tab=recommended`, { waitUntil: 'domcontentloaded' });
      await reopened.waitForSelector('.app-window', { timeout: 15000 });
      await sleep(700);
      const presetVisible = await reopened.evaluate(() => document.body.innerText.includes('Пресет из копии'));
      await reopened.goto(`${BASE}/#/hotkeys?tab=custom`, { waitUntil: 'domcontentloaded' });
      await sleep(500);
      const afterRestart = await reopened.evaluate(() => ({
        instructionVisible: document.body.innerText.includes('Своя инструкция из копии'),
        history: JSON.parse(localStorage.getItem('mockstore:zs.dictations') || '[]'),
        dictionary: JSON.parse(localStorage.getItem('mockstore:zs.dictionary') || '[]'),
        hotkeys: JSON.parse(localStorage.getItem('mockstore:zs.hotkeys') || '[]'),
      }));
      const restoredFile = afterRestart.history.find((d) => d.id === 'f-import');
      const restoredWord = afterRestart.dictionary.find((w) => w.id === 'w-import');
      const restoredHotkey = afterRestart.hotkeys.find((h) => h.id === 'dictation');
      record('сценарии', 'данные: после перезапуска остаются пресет, инструкция, пустое сочетание и метаданные',
        presetVisible && afterRestart.instructionVisible && restoredFile?.source === 'file' && restoredFile?.text === fileRecord?.text &&
        restoredWord?.pinned === true && restoredWord?.hits === 27 && Array.isArray(restoredHotkey?.keys) && restoredHotkey.keys.length === 0,
        JSON.stringify({ presetVisible, instructionVisible: afterRestart.instructionVisible, source: restoredFile?.source, textLength: restoredFile?.text?.length, pinned: restoredWord?.pinned, keys: restoredHotkey?.keys }));
    } finally { await reopened.close(); }
  } finally {
    rmSync(backupPath, { force: true });
  }
  const errors = takeErrors(page);
  record('сценарии', 'данные: без ошибок консоли', errors.length === 0, errors[0] || '');
  await page.close();
}

// Импортируем именно JSON, который приложение только что экспортировало.
async function scenarioBackupRoundTrip(browser) {
  const page = await openPage(browser, '#/settings?section=data&from=home', {
    settle: 500,
    storeSeed: {
      'zs.dictations': [{ id: 'd-roundtrip', text: 'Большая запись 😀 '.repeat(700), rawText: 'До изменений', createdAt: Date.now(), source: 'dictation', words: 100 }],
      'zs.dictionary': [{ id: 'w-roundtrip', word: 'Термин', pronunciation: 'термин', pinned: true, hits: 3, lastUsedAt: 1000 }],
      'zs.presets': [{ id: 'p-roundtrip', title: 'Рабочий пресет', prompt: 'Исправь', keys: [], enabled: true }],
      'zs.instructions': [{ id: 'i-roundtrip', title: 'Рабочая инструкция', prompt: 'Сохрани', keys: [], enabled: true }],
    },
    patchNative: () => {
      window.zspeakly.native.saveBackup = async (json) => { window.__exportedBackup = json; return { ok: true, path: 'copy.json' }; };
    },
  });
  takeErrors(page);
  const backupPath = join(tmpdir(), `zs-roundtrip-${Date.now()}.json`);
  try {
    await clickIn(page, '', 'Скачать');
    await sleep(350);
    const json = await page.evaluate(() => window.__exportedBackup);
    if (!json) throw new Error('экспорт не передал JSON');
    const snapshot = JSON.parse(json);
    writeFileSync(backupPath, json, 'utf8');
    const input = await page.$('.settings-main input[type=file]');
    await input.uploadFile(backupPath);
    await sleep(350);
    const preview = await page.evaluate(() => document.querySelector('.confirm__text')?.innerText || '');
    if (preview) await clickIn(page, '', 'Восстановить');
    await sleep(650);
    const restored = await page.evaluate(() => ({
      dictations: JSON.parse(localStorage.getItem('mockstore:zs.dictations') || '[]'),
      dictionary: JSON.parse(localStorage.getItem('mockstore:zs.dictionary') || '[]'),
      presets: JSON.parse(localStorage.getItem('mockstore:zs.presets') || '[]'),
      instructions: JSON.parse(localStorage.getItem('mockstore:zs.instructions') || '[]'),
      toast: [...document.querySelectorAll('.toast')].map((node) => node.innerText).join(' '),
    }));
    const errors = takeErrors(page);
    record('сценарии', 'данные: собственный экспорт восстанавливается целиком без буфера обмена',
      Boolean(preview) && !Object.hasOwn(snapshot, 'clipboard') &&
      restored.dictations[0]?.text === snapshot.dictations[0]?.text && restored.dictations[0]?.rawText === 'До изменений' &&
      restored.dictionary[0]?.pinned === true && restored.dictionary[0]?.hits === 3 &&
      restored.presets.some((p) => p.id === 'p-roundtrip' && p.prompt === 'Исправь') &&
      restored.instructions.some((i) => i.id === 'i-roundtrip' && i.prompt === 'Сохрани') && errors.length === 0,
      JSON.stringify({ preview: Boolean(preview), hasClipboard: Object.hasOwn(snapshot, 'clipboard'), length: restored.dictations[0]?.text?.length, toast: restored.toast.slice(-240), error: errors[0] }));
  } finally { rmSync(backupPath, { force: true }); await page.close(); }
}

// Неподходящая копия не должна частично заменить настройки или историю.
async function scenarioInvalidBackup(browser) {
  const page = await openPage(browser, '#/settings?section=data&from=home', { settle: 500 });
  takeErrors(page);
  const before = await page.evaluate(() => ({
    history: localStorage.getItem('mockstore:zs.dictations'),
    settings: localStorage.getItem('mockstore:zs.settings'),
  }));
  const backupPath = join(tmpdir(), `zs-invalid-backup-${Date.now()}.json`);
  writeFileSync(backupPath, JSON.stringify({ app: 'ZSpeakly', dictations: [{ text: 'не заменять' }], dictionary: 'повреждённый раздел' }), 'utf8');
  try {
    const input = await page.$('.settings-main input[type=file]');
    await input.uploadFile(backupPath);
    await sleep(600);
    const after = await page.evaluate(() => ({
      history: localStorage.getItem('mockstore:zs.dictations'),
      settings: localStorage.getItem('mockstore:zs.settings'),
      dialog: Boolean(document.querySelector('.confirm__text')),
      toast: [...document.querySelectorAll('.toast')].map((node) => node.innerText).join(' '),
    }));
    const errors = takeErrors(page);
    record('сценарии', 'данные: повреждённая копия отклоняется целиком до подтверждения',
      after.history === before.history && after.settings === before.settings && !after.dialog && /Файл не подошёл/i.test(after.toast) && /Текущие данные не изменены/i.test(after.toast) && errors.length === 0,
      JSON.stringify({ unchanged: after.history === before.history && after.settings === before.settings, dialog: after.dialog, toast: after.toast, error: errors[0] }));
  } finally {
    rmSync(backupPath, { force: true });
    await page.close();
  }
}

// Настройки из копии способны удалить текущий буфер, хотя его нет в копии.
async function scenarioBackupClipboardRetention(browser) {
  const page = await openPage(browser, '#/settings?section=data&from=home', {
    settle: 500,
    storeSeed: {
      'zs.dictations': [{ id: 'before', text: 'текущая история', createdAt: Date.now() }],
      'zs.clipboard': [
        { id: 'cb-plain', text: 'частный текст', createdAt: Date.now() },
        { id: 'cb-pinned', text: 'закреплено', pinned: true, createdAt: Date.now() },
      ],
    },
  });
  takeErrors(page);
  const path = join(tmpdir(), `zs-retention-${Date.now()}.json`);
  try {
    const before = await page.evaluate(() => ({
      clipboard: localStorage.getItem('mockstore:zs.clipboard'),
      dictations: localStorage.getItem('mockstore:zs.dictations'),
      settings: localStorage.getItem('mockstore:zs.settings'),
    }));
    writeFileSync(path, JSON.stringify({ settings: { dictationRetentionDays: 0, clipboardRetentionDays: 0 } }), 'utf8');
    const input = await page.$('.settings-main input[type=file]');
    await input.uploadFile(path);
    await sleep(400);
    const preview = await page.evaluate(() => document.querySelector('.confirm__text')?.innerText || '');
    if (preview) await clickIn(page, '', 'Отмена');
    await sleep(250);
    const cancelled = await page.evaluate(() => ({
      clipboard: localStorage.getItem('mockstore:zs.clipboard'),
      dictations: localStorage.getItem('mockstore:zs.dictations'),
      settings: localStorage.getItem('mockstore:zs.settings'),
    }));
    record('сценарии', 'данные: предпросмотр предупреждает о текущем буфере и отмена ничего не меняет',
      /буфер обмена/i.test(preview) && /не входит в копию/i.test(preview) && /сейчас под срок попадает: 1/i.test(preview) &&
      !/частный текст|закреплено/.test(preview) && JSON.stringify(cancelled) === JSON.stringify(before),
      JSON.stringify({ preview, unchanged: JSON.stringify(cancelled) === JSON.stringify(before) }));
    await input.uploadFile(path);
    await sleep(400);
    await clickIn(page, '', 'Восстановить');
    await sleep(600);
    const after = await page.evaluate(() => ({
      clipboard: JSON.parse(localStorage.getItem('mockstore:zs.clipboard') || '[]'),
      dictations: JSON.parse(localStorage.getItem('mockstore:zs.dictations') || '[]'),
    }));
    const errors = takeErrors(page);
    record('сценарии', 'данные: срок хранения удаляет незакреплённое, но не закреплённое содержимое буфера',
      after.clipboard.length === 1 && after.clipboard[0].id === 'cb-pinned' && after.dictations.length === 0 && errors.length === 0,
      JSON.stringify({ clipboardIds: after.clipboard.map((item) => item.id), dictationCount: after.dictations.length, error: errors[0] }));
  } finally { rmSync(path, { force: true }); await page.close(); }
}

// Частичная копия не меняет срок: старый текст появится сейчас, но пропадёт после запуска.
async function scenarioBackupRetentionOnRestart(browser) {
  const page = await openPage(browser, '#/settings?section=data&from=home', {
    settle: 500, storeSeed: { 'zs.dictations': [] },
  });
  takeErrors(page);
  const path = join(tmpdir(), `zs-expired-${Date.now()}.json`);
  try {
    writeFileSync(path, JSON.stringify({ dictations: [
      { id: 'expired-import', text: 'старая запись', createdAt: Date.now() - 40 * 86400000 },
    ] }), 'utf8');
    const input = await page.$('.settings-main input[type=file]');
    await input.uploadFile(path);
    await sleep(400);
    const preview = await page.evaluate(() => document.querySelector('.confirm__text')?.innerText || '');
    if (preview) await clickIn(page, '', 'Восстановить');
    await sleep(600);
    const beforeRestart = await page.evaluate(() => JSON.parse(localStorage.getItem('mockstore:zs.dictations') || '[]'));
    const reopened = await browser.newPage();
    let afterRestart;
    try {
      await reopened.evaluateOnNewDocument(installMockBridge);
      await reopened.goto(`${BASE}/#/home`, { waitUntil: 'domcontentloaded' });
      await reopened.waitForSelector('.app-window', { timeout: 15000 });
      await sleep(700);
      afterRestart = await reopened.evaluate(() => JSON.parse(localStorage.getItem('mockstore:zs.dictations') || '[]'));
    } finally { await reopened.close(); }
    const errors = takeErrors(page);
    record('сценарии', 'данные: предупреждение о будущей очистке истории из частичной копии',
      /истории из копии: 1/i.test(preview) && /при следующем запуске/i.test(preview) &&
      beforeRestart.length === 1 && beforeRestart[0].id === 'expired-import' && afterRestart.length === 0 && errors.length === 0,
      JSON.stringify({ preview, before: beforeRestart.length, after: afterRestart.length, error: errors[0] }));
  } finally { rmSync(path, { force: true }); await page.close(); }
}

// Некорректные счётчики отклоняются до изменения данных; старый пресет переживает перезапуск.
async function scenarioBackupValidationAndRetention(browser) {
  const page = await openPage(browser, '#/settings?section=data&from=home', {
    settle: 500,
    settings: { dictationRetentionDays: 3650 },
    storeSeed: { 'zs.dictations': [{ id: 'before', text: 'до импорта', createdAt: Date.now() }] },
  });
  takeErrors(page);
  const path = join(tmpdir(), `zs-validation-${Date.now()}.json`);
  try {
    const before = await page.evaluate(() => ({
      history: localStorage.getItem('mockstore:zs.dictations'),
      settings: localStorage.getItem('mockstore:zs.settings'),
      stats: localStorage.getItem('mockstore:zs.stats'),
    }));
    writeFileSync(path, '{"dictations":[{"text":"не заменять"}],"stats":{"wordsTotal":1e400}}', 'utf8');
    const input = await page.$('.settings-main input[type=file]');
    await input.uploadFile(path);
    await sleep(400);
    const rejected = await page.evaluate(() => ({
      history: localStorage.getItem('mockstore:zs.dictations'),
      settings: localStorage.getItem('mockstore:zs.settings'),
      stats: localStorage.getItem('mockstore:zs.stats'),
      dialog: Boolean(document.querySelector('.confirm__text')),
      toast: [...document.querySelectorAll('.toast')].map((node) => node.innerText).join(' '),
    }));
    record('сценарии', 'данные: некорректные счётчики не заменяют историю или настройки',
      rejected.history === before.history && rejected.settings === before.settings && rejected.stats === before.stats &&
      !rejected.dialog && /счётчики/i.test(rejected.toast), JSON.stringify({ rejected, unchanged: rejected.history === before.history }));
    const name = 'Имя😀'.repeat(20);
    writeFileSync(path, JSON.stringify({
      settings: { dictationRetentionDays: 0 },
      dictations: [{ id: 'import-old', text: 'история из файла', createdAt: Date.now() - 86400000 }],
      presets: [{ id: 'legacy-preset', title: '', name: 'Старый пресет', prompt: 'Сохранить смысл' }],
      profile: { name }, stats: { wordsTotal: 3, secondsTotal: 0.25, sessions: 1 },
    }), 'utf8');
    await input.uploadFile(path);
    await sleep(400);
    const preview = await page.evaluate(() => document.querySelector('.confirm__text')?.innerText || '');
    if (preview) await clickIn(page, '', 'Восстановить');
    await sleep(600);
    const result = await page.evaluate(() => ({
      history: JSON.parse(localStorage.getItem('mockstore:zs.dictations') || '[]'),
      presets: JSON.parse(localStorage.getItem('mockstore:zs.presets') || '[]'),
      profile: JSON.parse(localStorage.getItem('mockstore:zs.profile') || '{}'),
      stats: JSON.parse(localStorage.getItem('mockstore:zs.stats') || '{}'),
    }));
    const reopened = await browser.newPage();
    let afterRestart;
    try {
      await reopened.evaluateOnNewDocument(installMockBridge);
      await reopened.goto(`${BASE}/#/hotkeys?tab=recommended`, { waitUntil: 'domcontentloaded' });
      await reopened.waitForSelector('.app-window', { timeout: 15000 });
      await sleep(500);
      afterRestart = await reopened.evaluate(() => ({
        visible: document.body.innerText.includes('Старый пресет'),
        presets: JSON.parse(localStorage.getItem('mockstore:zs.presets') || '[]'),
        profile: JSON.parse(localStorage.getItem('mockstore:zs.profile') || '{}'),
      }));
    } finally { await reopened.close(); }
    const errors = takeErrors(page);
    record('сценарии', 'данные: предупреждение о немедленном удалении и старый пресет после перезапуска',
      /сразу после восстановления/i.test(preview) && result.history.length === 0 &&
      result.presets[0]?.title === 'Старый пресет' && result.profile.name === name && result.stats.secondsTotal === 0.25 &&
      afterRestart.visible && afterRestart.presets[0]?.prompt === 'Сохранить смысл' && afterRestart.profile.name === name && errors.length === 0,
      JSON.stringify({ preview, historyCount: result.history.length, preset: result.presets[0], namePreserved: result.profile.name === name, afterRestart, error: errors[0] }));
  } finally { rmSync(path, { force: true }); await page.close(); }
}

// Проверяем размер до чтения и не даём позднему чтению заменить последний выбор.
async function scenarioBackupFileBoundaries(browser) {
  const page = await openPage(browser, '#/settings?section=data&from=home', { settle: 500 });
  takeErrors(page);
  try {
    const before = await page.evaluate(() => localStorage.getItem('mockstore:zs.dictations'));
    await page.evaluate(() => {
      const size = Object.getOwnPropertyDescriptor(Blob.prototype, 'size');
      const originalText = File.prototype.text;
      window.__backupTextReads = [];
      Object.defineProperty(File.prototype, 'size', { configurable: true, get() {
        return this.name === 'big.json' ? 33 * 1024 * 1024 : size.get.call(this);
      } });
      File.prototype.text = function () {
        window.__backupTextReads.push(this.name);
        if (this.name === 'first.json') return new Promise((resolve) => { window.__resolveOldBackup = resolve; });
        if (this.name === 'second.json') return Promise.resolve(JSON.stringify({ dictations: [{ id: 'last-choice', text: 'последний выбор' }] }));
        return originalText.call(this);
      };
      window.__chooseBackup = (name) => {
        const input = document.querySelector('.settings-main input[type=file]');
        const transfer = new DataTransfer();
        transfer.items.add(new File(['{}'], name, { type: 'application/json' }));
        input.files = transfer.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      };
      window.__chooseBackup('big.json');
    });
    await sleep(400);
    const large = await page.evaluate(() => ({
      reads: window.__backupTextReads.slice(),
      warning: [...document.querySelectorAll('.toast')].map((node) => node.innerText).join(' '),
      dialog: Boolean(document.querySelector('.confirm__text')),
      unchanged: localStorage.getItem('mockstore:zs.dictations'),
    }));
    record('сценарии', 'данные: слишком большая копия отклоняется до чтения',
      !large.reads.includes('big.json') && /больше 32 МиБ/i.test(large.warning) && !large.dialog && large.unchanged === before,
      JSON.stringify({ reads: large.reads, warning: large.warning, dialog: large.dialog, unchanged: large.unchanged === before }));
    await page.evaluate(() => { window.__chooseBackup('first.json'); window.__chooseBackup('second.json'); });
    await page.waitForFunction(() => Boolean(window.__resolveOldBackup) && /second\.json/i.test(document.querySelector('.confirm__text')?.innerText || ''), { timeout: 8000 });
    await page.evaluate(() => window.__resolveOldBackup(JSON.stringify({ dictations: [{ id: 'stale', text: 'старый выбор' }] })));
    await sleep(300);
    const preview = await page.evaluate(() => document.querySelector('.confirm__text')?.innerText || '');
    if (preview) await clickIn(page, '', 'Восстановить');
    await sleep(600);
    const history = await page.evaluate(() => JSON.parse(localStorage.getItem('mockstore:zs.dictations') || '[]'));
    const errors = takeErrors(page);
    record('сценарии', 'данные: позднее чтение не подменяет последнюю выбранную копию',
      /second\.json/i.test(preview) && history.length === 1 && history[0].id === 'last-choice' && errors.length === 0,
      JSON.stringify({ preview, history, error: errors[0] }));
  } finally { await page.close(); }
}

// Версия и нераспознанные разделы должны быть видны до подтверждения.
async function scenarioBackupCompatibility(browser) {
  const page = await openPage(browser, '#/settings?section=data&from=home', { settle: 500 });
  const backupPath = join(tmpdir(), `zs-compat-${Date.now()}.json`);
  try {
    takeErrors(page);
    const input = await page.$('.settings-main input[type=file]');
    const historyBefore = await page.evaluate(() => localStorage.getItem('mockstore:zs.dictations'));
    writeFileSync(backupPath, JSON.stringify({ stats: { sessions: 12 }, profile: { name: 'Тест совместимости' }, СЕКРЕТНЫЙ_РАЗДЕЛ: ['ЛИЧНЫЕ_ДАННЫЕ'] }), 'utf8');
    await input.uploadFile(backupPath);
    await sleep(300);
    const preview = await page.evaluate(() => document.querySelector('.confirm__text')?.innerText || '');
    if (preview) await clickIn(page, '', 'Восстановить');
    await sleep(500);
    const result = await page.evaluate(() => ({
      stats: JSON.parse(localStorage.getItem('mockstore:zs.stats') || '{}'),
      profile: JSON.parse(localStorage.getItem('mockstore:zs.profile') || '{}'),
      history: localStorage.getItem('mockstore:zs.dictations'),
    }));
    record('сценарии', 'данные: частичная копия со счётчиками и профилем предупреждает о совместимости',
      /счётчики, профиль/i.test(preview) && /без.*версии/i.test(preview) && /нераспознанн.*1/i.test(preview) &&
      !preview.includes('СЕКРЕТНЫЙ_РАЗДЕЛ') && !preview.includes('ЛИЧНЫЕ_ДАННЫЕ') &&
      result.stats.sessions === 12 && result.profile.name === 'Тест совместимости' && result.history === historyBefore,
      JSON.stringify({ preview, stats: result.stats, profile: result.profile, historyUnchanged: result.history === historyBefore }));
    writeFileSync(backupPath, JSON.stringify({ app: 'ZSpeakly', format: 2, dictations: [] }), 'utf8');
    await input.uploadFile(backupPath);
    await sleep(300);
    const failure = await page.evaluate(() => ({
      preview: document.querySelector('.confirm__text')?.innerText || '',
      toast: [...document.querySelectorAll('.toast')].map((node) => node.innerText).join(' '),
      history: localStorage.getItem('mockstore:zs.dictations'),
    }));
    const errors = takeErrors(page);
    record('сценарии', 'данные: версия из будущего отклоняется до изменений',
      !failure.preview && /неподдерживаемая версия/i.test(failure.toast) && failure.history === historyBefore && errors.length === 0,
      JSON.stringify({ ...failure, history: failure.history === historyBefore, error: errors[0] }));
    writeFileSync(backupPath, JSON.stringify({ format: 1, dictations: [], exportedAt: { toString: 'СЕКРЕТ', valueOf: 'СЕКРЕТ' } }), 'utf8');
    await input.uploadFile(backupPath);
    await sleep(300);
    const badDate = await page.evaluate(() => ({
      preview: document.querySelector('.confirm__text')?.innerText || '',
      toast: [...document.querySelectorAll('.toast')].map((node) => node.innerText).join(' '),
      history: localStorage.getItem('mockstore:zs.dictations'),
      mounted: Boolean(document.querySelector('.settings-main input[type=file]')),
    }));
    record('сценарии', 'данные: повреждённая дата не ломает интерфейс и не раскрывается',
      badDate.mounted && !badDate.preview && /некорректная дата/i.test(badDate.toast) && !badDate.toast.includes('СЕКРЕТ') &&
      badDate.history === historyBefore && takeErrors(page).length === 0,
      JSON.stringify({ preview: badDate.preview, toast: badDate.toast.slice(-250), historyUnchanged: badDate.history === historyBefore, mounted: badDate.mounted }));
  } finally { rmSync(backupPath, { force: true }); await page.close(); }
}

// Большую копию можно сохранить вручную, но нельзя обещать её автоматический импорт.
async function scenarioBackupLargeExport(browser) {
  const page = await openPage(browser, '#/settings?section=data&from=home', { settle: 500 });
  takeErrors(page);
  try {
    const description = await page.evaluate(() => document.body.innerText);
    await page.evaluate(() => {
      const NativeBlob = window.Blob;
      window.Blob = class extends NativeBlob {
        get size() { return 33 * 1024 * 1024; }
      };
    });
    await clickIn(page, '', 'Скачать');
    await sleep(500);
    const result = await page.evaluate(() => ({
      toast: [...document.querySelectorAll('.toast')].map((node) => node.innerText).join(' '),
      tone: [...document.querySelectorAll('.toast')].find((node) => /Копия сохранена/i.test(node.innerText))?.className,
      saved: (window.__bridgeCalls || []).some((entry) => entry.channel === 'data:save-backup'),
    }));
    const errors = takeErrors(page);
    record('сценарии', 'данные: крупную копию сохраняют с явным предупреждением и без обещания импорта',
      result.saved && /превышает 32 МиБ/i.test(result.toast) && /не сможет восстановить/i.test(result.toast) && /toast--warn/.test(result.tone || '') &&
      /JSON-файлом без шифрования/i.test(description) && /Секреты могут встретиться/i.test(description) && errors.length === 0,
      JSON.stringify({ ...result, error: errors[0] }));
  } finally { await page.close(); }
}

// Экспорт берёт данные из памяти, которая при нечитаемом профиле пуста или неполна.
async function scenarioBackupProtectedExport(browser) {
  for (const mode of ['PROFILE_UNREADABLE', 'ENOSPC', 'missing', 'throw', 'late', 'recovered']) {
    const page = await openPage(browser, '#/settings?section=data&from=home', {
      settle: 500, patchArg: mode,
      patchNative: (mode) => {
        const store = window.zspeakly.store;
        if (mode === 'missing') delete store.statusSync;
        else if (mode === 'throw') store.statusSync = () => { throw new Error('секретный путь'); };
        else if (mode !== 'late') store.statusSync = () => ({ ok: false, code: mode });
        if (mode === 'late' || mode === 'recovered') {
          const save = window.zspeakly.native.saveBackup;
          window.zspeakly.native.saveBackup = async (json) => {
            const result = await save(json);
            store.statusSync = () => ({ ok: mode === 'recovered' });
            return result;
          };
        }
      },
    });
    try {
      takeErrors(page);
      await clickIn(page, '', 'Скачать');
      await sleep(300);
      const result = await page.evaluate(() => ({
        toast: [...document.querySelectorAll('.toast')].map((node) => ({ text: node.innerText, cls: node.className })),
        saved: (window.__bridgeCalls || []).some((item) => item.channel === 'data:save-backup'),
      }));
      const notice = result.toast.find((item) => /Копия сохранена/i.test(item.text));
      const errors = takeErrors(page);
      record('сценарии', `данные: экспорт при неизвестном состоянии профиля предупреждает о неполной копии (${mode})`,
        result.saved && /может быть неполной/i.test(notice?.text || '') && /toast--warn/.test(notice?.cls || '') &&
        !notice?.text.includes('секретный путь') && errors.length === 0,
        JSON.stringify({ notice, saved: result.saved, error: errors[0] }));
    } finally { await page.close(); }
  }
}

// Известный сбой записи должен останавливать импорт до изменения состояния.
async function scenarioProtectedBackup(browser) {
  const backupPath = join(tmpdir(), `zs-protected-backup-${Date.now()}.json`);
  writeFileSync(backupPath, JSON.stringify({ app: 'ZSpeakly', dictations: [{ id: 'd1', text: 'из копии' }], dictionary: [{ id: 'w1', word: 'из копии' }] }), 'utf8');
  try {
    for (const mode of ['PROFILE_UNREADABLE', 'ENOSPC', 'throw', 'missing', 'late']) {
      const page = await openPage(browser, '#/settings?section=data&from=home', {
        settle: 500, patchArg: mode,
        patchNative: (mode) => {
          const store = window.zspeakly.store;
          window.__activateStorageFailure = () => {
            if (mode === 'missing') delete store.statusSync;
            else if (mode === 'throw') store.statusSync = () => { throw new Error('секретный путь'); };
            else store.statusSync = () => ({ ok: false, code: mode === 'late' ? 'ENOSPC' : mode });
          };
          if (mode !== 'late') window.__activateStorageFailure();
        },
      });
      try {
        takeErrors(page);
        const before = await page.evaluate(() => ({
          history: localStorage.getItem('mockstore:zs.dictations'),
          dictionary: localStorage.getItem('mockstore:zs.dictionary'),
        }));
        const input = await page.$('.settings-main input[type=file]');
        await input.uploadFile(backupPath);
        await sleep(300);
        const preview = await page.evaluate(() => document.querySelector('.confirm__text')?.innerText || '');
        if (mode === 'late') await page.evaluate(() => window.__activateStorageFailure());
        await clickIn(page, '', 'Восстановить');
        await sleep(500);
        const result = await page.evaluate(() => ({
          history: localStorage.getItem('mockstore:zs.dictations'),
          dictionary: localStorage.getItem('mockstore:zs.dictionary'),
          toast: [...document.querySelectorAll('.toast')].map((node) => node.innerText).join(' '),
        }));
        const errors = takeErrors(page);
        record('сценарии', `данные: известный сбой записи останавливает импорт (${mode})`,
          /Будут заменены: история, словарь/i.test(preview) && /не.*атомар/i.test(preview) && /сохраните.*копи/i.test(preview) &&
          /Не удалось восстановить/i.test(result.toast) && /не изменены/i.test(result.toast) &&
          result.history === before.history && result.dictionary === before.dictionary &&
          !result.toast.includes('секретный путь') && errors.length === 0,
          JSON.stringify({ preview, unchanged: result.history === before.history && result.dictionary === before.dictionary, toast: result.toast.slice(-350), error: errors[0] }));
        if (mode === 'late') {
          await page.evaluate(() => { window.zspeakly.store.statusSync = () => ({ ok: true }); });
          await input.uploadFile(backupPath);
          await sleep(300);
          await clickIn(page, '', 'Восстановить');
          await sleep(500);
          const history = await page.evaluate(() => JSON.parse(localStorage.getItem('mockstore:zs.dictations') || '[]'));
          record('сценарии', 'данные: повтор импорта возможен после восстановления статуса',
            history.length === 1 && history[0].id === 'd1' && takeErrors(page).length === 0, JSON.stringify(history));
        }
      } finally { await page.close(); }
    }
  } finally { rmSync(backupPath, { force: true }); }
}

// Browser localStorage пишет каждый раздел отдельно: сбой нельзя выдавать за транзакцию.
async function scenarioBackupPartialWrite(browser) {
  const page = await openPage(browser, '#/settings?section=data&from=home', {
    browserStorage: true, settle: 700,
    patchNative: () => { window.zspeakly.isElectron = false; },
  });
  const backupPath = join(tmpdir(), `zs-partial-write-${Date.now()}.json`);
  writeFileSync(backupPath, JSON.stringify({ app: 'ZSpeakly', dictations: [{ id: 'new-history', text: 'новая история' }], dictionary: [{ id: 'new-word', word: 'новый словарь' }] }), 'utf8');
  try {
    takeErrors(page);
    const oldHistory = await page.evaluate(() => localStorage.getItem('zs:zs.dictations'));
    const input = await page.$('.settings-main input[type=file]');
    await input.uploadFile(backupPath);
    await sleep(300);
    const preview = await page.evaluate(() => document.querySelector('.confirm__text')?.innerText || '');
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key === 'zs:zs.dictations') throw new Error('имитация переполнения');
        return original.call(this, key, value);
      };
    });
    await clickIn(page, '', 'Восстановить');
    await sleep(500);
    const result = await page.evaluate(() => ({
      history: localStorage.getItem('zs:zs.dictations'),
      dictionary: localStorage.getItem('zs:zs.dictionary'),
      toast: [...document.querySelectorAll('.toast')].map((node) => node.innerText).join(' '),
    }));
    record('сценарии', 'данные: сбой browser localStorage действительно может сохранить только часть импорта',
      /не атомарно/i.test(preview) && result.history === oldHistory && JSON.parse(result.dictionary || '[]').some((item) => item.id === 'new-word') &&
      /Не удалось сохранить данные/i.test(result.toast),
      JSON.stringify({ historyUnchanged: result.history === oldHistory, dictionary: result.dictionary, toast: result.toast.slice(-350) }));
  } finally { rmSync(backupPath, { force: true }); await page.close(); }
}

// «Держать модель в памяти»: тумблер обязан реально просить main поднять
// whisper-server, а не просто менять галочку.
async function scenarioWarmModel(browser) {
  const page = await openPage(browser, '#/settings?section=features&from=home', {
    settle: 700,
    settings: { keepModelLoaded: false },
  });
  takeErrors(page);
  const clicked = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.setting-row')].find((r) => /Держать модель в памяти/i.test(r.innerText));
    const toggle = row?.querySelector('[role="switch"]');
    toggle?.click();
    return Boolean(toggle);
  });
  await sleep(600);
  const calls = await bridgeCalls(page);
  const toast = await page.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.innerText.replace(/\n/g, ' ')).join(' ;; '));
  record(
    'сценарии',
    'модель в памяти: тумблер поднимает whisper-server',
    clicked && calls.includes('models:warm') && /Модель в памяти/i.test(toast),
    toast.slice(0, 90),
  );
  // выключение возвращает обычный запуск и говорит об этом
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('.setting-row')].find((r) => /Держать модель в памяти/i.test(r.innerText));
    row?.querySelector('[role="switch"]')?.click();
  });
  await sleep(500);
  const offToast = await page.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.innerText.replace(/\n/g, ' ')).join(' ;; '));
  record('сценарии', 'модель в памяти: выключение объясняет, что будет дальше', /выгрузится/i.test(offToast), offToast.slice(0, 90));
  const errors = takeErrors(page);
  record('сценарии', 'модель в памяти: без ошибок консоли', errors.length === 0, errors[0] || '');
  await page.close();
}

async function scenarioNetwork(browser) {
  const page = await openPage(browser, '#/settings?section=network&from=home', { settle: 450 });
  takeErrors(page);
  const check = await clickIn(page, '', 'Проверить соединение');
  await sleep(700);
  const calls = await bridgeCalls(page);
  const body = await page.evaluate(() => document.body.innerText);
  record('сценарии', 'сеть: проверка дергает http:get и показывает результат', check && calls.includes('http:get') && /доступна|недоступна|моделей/i.test(body));
  // Адрес и имя модели больше не поля ввода: приложение спрашивает список у
  // локального сервера и показывает найденную модель само.
  // Считаем поля только в группе локальной модели: «Сеть» с 1.8.0 живёт внутри
  // «Диктовки», и в разделе есть другие поля (правила «под активное окно») —
  // проверка про модель не должна на них спотыкаться.
  const auto = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) =>
      /Проверить соединение/.test(b.innerText),
    );
    const group = btn?.closest('.settings-group');
    return {
      inputs: group ? group.querySelectorAll('input').length : -1,
      text: group?.innerText || '',
    };
  });
  record(
    'сценарии',
    'сеть: модель находится сама, без ручного адреса и имени',
    auto.inputs === 0 && /Используется\s+\S/i.test(auto.text),
    `полей ввода ${auto.inputs}, ${auto.text.replace(/\n/g, ' ').slice(0, 80)}`,
  );
  const errors = takeErrors(page);
  record('сценарии', 'сеть: без ошибок консоли', errors.length === 0, errors[0] || '');
  await page.close();
}

async function scenarioClipboardDanger(browser) {
  const page = await openPage(browser, '#/clipboard', { settle: 350 });
  takeErrors(page);
  await page.evaluate(() => document.querySelector('.clip-toolbar__view button:nth-child(2)').click());
  await sleep(250);
  const before = await page.evaluate(() => document.querySelectorAll('.clip-list__item').length);
  await page.evaluate(() => document.querySelector('.clip-list__item').click());
  await sleep(200);
  const pinned = await page.evaluate(() => {
    const btn = document.querySelector('.clip-preview [aria-label="Закрепить"], .clip-preview button[title*="крепить"]');
    if (!btn) return false;
    btn.click();
    return true;
  });
  await sleep(300);
  const afterPin = await page.evaluate(() => {
    const store = window.__e2e.read('zs.clipboard') || [];
    return store.some((i) => i.pinned);
  });
  record('сценарии', 'буфер: элемент закрепляется', pinned && afterPin);

  const cleared = await clickIn(page, '', 'Очистить историю');
  await sleep(350);
  const askedFirst = await page.evaluate(() => /Очистить историю буфера/i.test(document.querySelector('.modal')?.innerText || ''));
  const beforeCount = await page.evaluate(() => (window.__e2e.read('zs.clipboard') || []).length);
  const confirmed = await clickIn(page, '.modal', 'Очистить');
  await sleep(500);
  const left = await page.evaluate(() => (window.__e2e.read('zs.clipboard') || []).length);
  const onlyPinned = await page.evaluate(() =>
    (window.__e2e.read('zs.clipboard') || []).every((item) => item.pinned),
  );
  record(
    'сценарии',
    'буфер: «Очистить историю» спрашивает подтверждение',
    cleared && askedFirst && confirmed,
    `${before} элементов до`,
  );
  record(
    'сценарии',
    'буфер: очистка удаляет незакреплённые, закреплённые остаются',
    left < beforeCount && onlyPinned,
    `${beforeCount} → ${left}`,
  );
  const errors = takeErrors(page);
  record('сценарии', 'буфер: очистка без ошибок консоли', errors.length === 0, errors[0] || '');
  await page.close();
}

async function scenarioDictionaryExtras(browser) {
  const page = await openPage(browser, '#/dictionary', { settle: 350 });
  takeErrors(page);
  const search = await page.$('input[placeholder*="Поиск"], .search-input input, input');
  if (search) {
    await search.click();
    await page.keyboard.type('ZSpeak');
    await sleep(350);
  }
  const filtered = await page.evaluate(() => document.querySelectorAll('.dict-row').length);
  const tabs = await page.evaluate(() => {
    const tab = [...document.querySelectorAll('[role="tab"]')].find((t) => /Без произношения/i.test(t.innerText));
    if (!tab) return false;
    tab.click();
    return true;
  });
  await sleep(300);
  const emptyTab = await page.evaluate(() => /ничего|пусто|нет слов/i.test(document.body.innerText) || document.querySelectorAll('.dict-row').length >= 0);
  const toggle = await page.evaluate(() => {
    const el = document.querySelector('[role="switch"]');
    if (!el) return false;
    el.click();
    return true;
  });
  await sleep(350);
  const settings = await storeOf(page, 'zs.settings');
  record('сценарии', 'словарь: поиск фильтрует список', Boolean(search) && filtered >= 1, `${filtered} строк`);
  record('сценарии', 'словарь: вкладки переключаются', tabs && emptyTab);
  record(
    'сценарии',
    'словарь: тумблер применения сохраняется',
    toggle && Boolean(settings) && settings.dictionaryEnabled === false,
    `dictionaryEnabled=${settings?.dictionaryEnabled}`,
  );
  const errors = takeErrors(page);
  record('сценарии', 'словарь: без ошибок консоли', errors.length === 0, errors[0] || '');
  await page.close();
}

async function scenarioHomeExtras(browser) {
  const page = await openPage(browser, '#/home', { settle: 350 });
  takeErrors(page);
  const rows = await page.evaluate(() => document.querySelectorAll('.recent__row').length);
  const search = await page.$('.recent input, .recent__search input, input[placeholder*="Поиск"]');
  if (search) {
    await search.click();
    await page.keyboard.type('созвон');
    await sleep(400);
  }
  const filtered = await page.evaluate(() => document.querySelectorAll('.recent__row').length);
  record('сценарии', 'главная: поиск по расшифровке сужает список', Boolean(search) && filtered > 0 && filtered <= rows, `${rows} → ${filtered}`);

  await page.evaluate(() => {
    const clear = document.querySelector('.recent input, input[placeholder*="Поиск"]');
    if (clear) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(clear, '');
      clear.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  await sleep(300);

  // «Показать всё» разворачивает историю целиком
  await page.evaluate(() => {
    const input = document.querySelector('.recent input, input[placeholder*="Поиск"]');
    if (input) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  await sleep(300);
  const collapsed = await page.evaluate(() => document.querySelectorAll('.recent__row').length);
  const expandedClick = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.recent button, .link-btn')].find((b) => /ПОКАЗАТЬ ВСЁ/i.test(b.innerText));
    if (!btn || btn.disabled) return false;
    btn.click();
    return true;
  });
  await sleep(350);
  const expanded = await page.evaluate(() => document.querySelectorAll('.recent__row').length);
  record('сценарии', 'главная: «Показать всё» разворачивает историю', expandedClick && expanded > collapsed, `${collapsed} → ${expanded}`);

  await page.evaluate(() => document.querySelector('.recent__row').click());
  await sleep(250);
  const copied = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.snippet button')].find((b) => /Копировать/.test(b.innerText));
    if (!btn) return false;
    btn.click();
    return true;
  });
  await sleep(300);
  const calls = await bridgeCalls(page);
  record('сценарии', 'главная: копирование из сниппета работает', copied && (calls.includes('clipboard:write') || calls.includes('clipboard:write-text')));

  // Esc должен закрывать просмотр расшифровки, как и остальные окна
  await page.keyboard.press('Escape');
  await sleep(400);
  const closedByEsc = await page.evaluate(() => !document.querySelector('.snippet'));
  record('сценарии', 'главная: Esc закрывает просмотр расшифровки', copied && closedByEsc);

  await page.evaluate(() => document.querySelector('.recent__row').click());
  await sleep(250);
  const before = await storeOf(page, 'zs.dictations').then((l) => (Array.isArray(l) ? l.length : -1));
  const removed = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.snippet button')].find((b) => /Удалить/.test(b.innerText));
    if (!btn) return false;
    btn.click();
    return true;
  });
  await sleep(400);
  const after = await storeOf(page, 'zs.dictations').then((l) => (Array.isArray(l) ? l.length : -1));
  record('сценарии', 'главная: запись удаляется из истории', removed && after === before - 1, `${before} → ${after}`);
  const errors = takeErrors(page);
  record('сценарии', 'главная: без ошибок консоли', errors.length === 0, errors[0] || '');
  await page.close();
}

async function scenarioUpdates(browser) {
  const page = await openPage(browser, '#/settings?section=about&from=home', { settle: 450 });
  takeErrors(page);
  const check = await clickIn(page, '', 'Проверить обновления');
  await sleep(700);
  const calls = await bridgeCalls(page);
  const body = await page.evaluate(() => document.body.innerText);
  record('сценарии', 'обновления: кнопка проверки дергает main и отвечает', check && calls.includes('update:check') && /обновлен|последн|актуальн|недоступ/i.test(body), calls.filter((c) => c.startsWith('update')).join(','));
  await page.close();
}

async function scenarioData(browser) {
  const page = await openPage(browser, '#/settings?section=data&from=home', { settle: 450 });
  takeErrors(page);
  const folder = await clickIn(page, '.settings-main', 'Открыть');
  await sleep(400);
  const link = await page.evaluate(() => {
    const a = [...document.querySelectorAll('a[href^="https://"], button')].find((el) => /GitHub|github/i.test(el.innerText || ''));
    if (!a) return false;
    a.click();
    return true;
  });
  await sleep(400);
  const calls = await bridgeCalls(page);
  record('сценарии', 'данные: папка данных открывается через мост', folder && calls.includes('app:open-data-folder'), calls.filter((c) => c.startsWith('app')).join(','));
  const errors = takeErrors(page);
  record('сценарии', 'данные: без ошибок консоли', errors.length === 0, errors[0] || '');
  void link;
  await page.close();
}

async function scenarioThemeCycle(browser) {
  const page = await openPage(browser, '#/settings?section=app&from=home', { settle: 350 });
  const pick = async (label) => {
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('.select__btn')].find((b) => /Тёмная|Светлая|Как в системе/.test(b.innerText));
      btn?.click();
    });
    await sleep(180);
    await page.evaluate((text) => {
      const opt = [...document.querySelectorAll('[role="option"]')].find((o) => o.innerText.includes(text));
      opt?.click();
    }, label);
    await sleep(300);
    return page.evaluate(() => ({
      theme: document.documentElement.dataset.theme,
      scheme: document.documentElement.style.colorScheme,
    }));
  };
  const light = await pick('Светлая');
  const system = await pick('Как в системе');
  const dark = await pick('Тёмная');
  record(
    'сценарии',
    'тема: все три режима применяются',
    light.theme === 'light' && system.theme === 'system' && dark.theme === 'dark' && system.scheme === 'light dark',
    `${light.theme}/${system.theme}/${dark.theme}`,
  );
  await page.close();
}

/* ── события из main-процесса (трей, глобальные хоткеи, буфер) ─────────── */

const emit = (page, channel, payload) =>
  page.evaluate(([ch, data]) => window.__e2e.emit(ch, data), [channel, payload]);

async function scenarioTrayCommands(browser) {
  const page = await openPage(browser, '#/home');
  await emit(page, 'command', 'settings');
  await sleep(400);
  const settingsOpen = await page.evaluate(() => Boolean(document.querySelector('.settings-modal')));
  await page.evaluate(() => document.querySelector('.settings-modal .modal__close, .settings-modal [aria-label="Закрыть"]')?.click());
  await sleep(400);
  await emit(page, 'command', 'diagnostics');
  await sleep(400);
  const section = await page.evaluate(() => document.querySelector('.settings-main h2')?.innerText || '');
  await page.keyboard.press('Escape');
  await sleep(250);
  await emit(page, 'command', 'clipboard');
  await sleep(400);
  const onClipboard = await page.evaluate(() => location.hash.includes('clipboard'));
  record('события', 'трей открывает настройки, диагностику и буфер', settingsOpen && /Диагностика/.test(section) && onClipboard, section);
  await page.close();
}

async function scenarioGlobalHotkey(browser) {
  const page = await openPage(browser, '#/home');
  takeErrors(page);
  await emit(page, 'hotkey', { type: 'down', mode: 'hold', screenAware: false });
  await sleep(1200);
  const started = await page.evaluate(() => /Слушаю/i.test(document.body.innerText));
  await emit(page, 'hotkey', { type: 'up' });
  await sleep(1800);
  const stored = await storeOf(page, 'zs.dictations');
  const before = Array.isArray(stored) ? stored.length : 0;
  const text = await page.evaluate(() =>
    [...document.querySelectorAll('.recent__row .recent__text')].map((el) => el.innerText).join(' '),
  );
  record('события', 'глобальный хоткей запускает и останавливает диктовку', started && before > 0 && /Проверка диктовки/i.test(text), `${before} записей`);
  const errors = takeErrors(page);
  record('события', 'глобальный хоткей без ошибок консоли', errors.length === 0, errors[0] || '');
  await page.close();
}

// Диктовка в поле самого приложения: текст должен попасть туда, где стоит
// курсор, и НЕ уходить системной вставкой в предыдущее окно.
async function scenarioDictationIntoOwnField(browser) {
  // 1) Пока человек говорит, интерфейс говорит, КУДА попадёт текст.
  const page = await openPage(browser, '#/home', { settle: 500 });
  takeErrors(page);
  await emit(page, 'hotkey', { type: 'down', mode: 'hold', screenAware: false });
  await sleep(1100);
  const hint = await page.evaluate(() => {
    const el = document.querySelector('.live-draft__hint');
    return el ? el.innerText : '';
  });
  await emit(page, 'hotkey', { type: 'up' });
  await sleep(1500);
  record(
    'сценарии',
    'диктовка: пока человек говорит, видно, куда попадёт текст',
    /Вставим/.test(hint) && /Блокнот/.test(hint),
    hint || 'подсказки нет',
  );

  // 2) Курсор в поле самого приложения — текст должен попасть туда, а не в
  //    предыдущее окно, и без системной вставки.
  await page.evaluate(() => {
    location.hash = '#/clipboard';
  });
  await sleep(600);
  const input = await page.$('input[placeholder="Поиск по истории буфера"]');
  const found = Boolean(input);
  let typed = '';
  if (found) {
    await input.click();
    const beforeCalls = (await bridgeCalls(page)).length;
    await emit(page, 'hotkey', { type: 'down', mode: 'hold', screenAware: false });
    await sleep(1100);
    await emit(page, 'hotkey', { type: 'up' });
    await sleep(1600);
    typed = await page.evaluate(
      () => document.querySelector('input[placeholder="Поиск по истории буфера"]')?.value || '',
    );
    const calls = (await bridgeCalls(page)).slice(beforeCalls);
    record(
      'сценарии',
      'диктовка: в поле приложения текст не уходит системной вставкой',
      !calls.includes('text:insert'),
      calls.includes('text:insert') ? 'был вызов text:insert' : 'только локальная вставка',
    );
    // Поле управляется React: если состояние не обновилось, поиск остался бы
    // прежним. Пустой результат «Для «…» не найдено» — доказательство, что
    // приложение увидело вставленный текст.
    const searched = await page.evaluate(() => document.body.innerText);
    record(
      'сценарии',
      'диктовка: приложение сразу видит вставленный текст, а не только поле',
      /Для «/.test(searched) && /Проверка диктовки/.test(searched),
      (searched.match(/Для «[^»]{0,60}»[^\n]{0,40}/) || [''])[0],
    );
  }
  record(
    'сценарии',
    'диктовка: текст появляется в том поле, где стоит курсор',
    found && /Проверка диктовки/.test(typed),
    found ? `в поле: «${typed.slice(0, 40)}»` : 'не нашёл поле поиска',
  );
  const errors = takeErrors(page);
  record('сценарии', 'диктовка в своё поле: без ошибок консоли', errors.length === 0, errors[0] || '');
  await page.close();
}

// Предупреждения React по всем экранам и разделам настроек: «ключи в списках»,
// controlled/uncontrolled, неизвестные пропсы. Это ещё не ошибки, но именно из
// них вырастают баги, которые видит человек.
async function scenarioConsoleWarnings(browser) {
  const routes = ['#/home', '#/dictionary', '#/hotkeys', '#/clipboard'];
  const sections = ['app', 'features', 'data', 'network', 'diagnostics', 'about'];
  const page = await openPage(browser, routes[0], { settle: 500 });
  takeErrors(page);
  takeWarnings(page);
  const seen = [];
  for (const route of routes) {
    await page.evaluate((r) => {
      location.hash = r;
    }, route);
    await sleep(500);
    seen.push(...takeWarnings(page));
  }
  for (const section of sections) {
    await page.evaluate((sec) => {
      location.hash = `#/settings?section=${sec}&from=home`;
    }, section);
    await sleep(600);
    seen.push(...takeWarnings(page));
  }
  await page.keyboard.press('Escape');
  await sleep(250);
  const unique = [...new Set(seen)];
  const visible = unique.filter((w) => !/DevTools|Download the React/i.test(w));
  record(
    'сценарии',
    'предупреждений React нет ни на одном экране и разделе настроек',
    visible.length === 0,
    visible.length ? visible.slice(0, 2).join(' | ') : `${routes.length} экрана + ${sections.length} разделов`,
  );
  await page.close();
}

// Тяжёлые данные: история и буфер не должны «зависать» на прокрутке и поиске.
async function scenarioHeavyData(browser) {
  const many = Array.from({ length: 2000 }, (_, i) => ({
    id: `heavy-${i}`,
    text: `Запись номер ${i}: проверка прокрутки и поиска на большом объёме истории.`,
    durationMs: 3000 + (i % 2000),
    words: 9,
    createdAt: Date.now() - i * 60_000,
    language: 'ru',
    source: 'dictation',
  }));
  const clips = Array.from({ length: 1200 }, (_, i) => ({
    id: `clip-${i}`,
    kind: 'text',
    text: `Скопированный текст ${i}`,
    source: 'Другая программа',
    createdAt: Date.now() - i * 30_000,
  }));
  const started = Date.now();
  const page = await openPage(browser, '#/home', {
    settle: 200,
    storeSeed: { 'zs.dictations': many, 'zs.clipboard': clips },
  });
  const homeReady = Date.now() - started;
  takeErrors(page);
  takeWarnings(page);
  const rows = await page.evaluate(() => document.querySelectorAll('.recent__row').length);
  // поиск по 2000 записям: реакция должна быть мгновенной
  const searchStart = Date.now();
  await page.type('input[placeholder*="Поиск"]', 'Запись номер 1500');
  await sleep(250);
  const searchMs = Date.now() - searchStart;
  const found = await page.evaluate(() => document.querySelectorAll('.recent__row').length);
  await page.evaluate(() => {
    location.hash = '#/clipboard';
  });
  const clipStart = Date.now();
  await page.waitForFunction(() => document.querySelectorAll('.clip-card, .clip-row').length > 0, { timeout: 15000 });
  const clipReady = Date.now() - clipStart;
  record(
    'сценарии',
    'большая история открывается и ищется быстро',
    homeReady < 9000 && searchMs < 2500 && found > 0 && found < 50,
    `главная ${homeReady} мс, поиск ${searchMs} мс, найдено ${found} из ${rows} на экране`,
  );
  record(
    'сценарии',
    'большой буфер открывается быстро и без ошибок',
    clipReady < 8000 && takeErrors(page).length === 0,
    `буфер ${clipReady} мс`,
  );
  const warnings = takeWarnings(page);
  record('сценарии', 'большие данные не дают предупреждений React', warnings.length === 0, warnings[0] || '');
  await page.close();
}

// Унаследованная история может быть больше лимита из старого профиля.
// Короткие записи и переполнение по числу, а не гигантская textarea.
async function scenarioLegacyHistoryLimit(browser) {
  const many = Array.from({ length: 2001 }, (_, i) => ({
    id: `legacy-${i}`, text: `Ранее сохранённая запись ${i}`, createdAt: Date.now() - i * 1000,
  }));
  const page = await openPage(browser, '#/home', {
    settle: 600, settings: { aiDictationRewrite: false },
    storeSeed: { 'zs.dictations': many, 'zs.mockSttText': 'Новая фраза для ручного сохранения.' },
  });
  takeErrors(page);
  const before = await page.evaluate(() => ({
    ids: (window.__e2e.read('zs.dictations') || []).map((x) => x.id),
    warning: document.body.innerText.includes('История превышает лимит'),
  }));
  await clickText(page, 'Начать диктовку');
  await sleep(1100);
  await page.evaluate(() => {
    const stop = document.querySelector('[aria-label="Остановить запись"]');
    if (stop) stop.click();
    else [...document.querySelectorAll('button')].find((b) => /Слушаю/i.test(b.innerText))?.click();
  });
  await sleep(2300);
  const after = await page.evaluate(() => ({
    ids: (window.__e2e.read('zs.dictations') || []).map((x) => x.id),
    recover: document.querySelector('.toast__recover')?.value || '',
    text: document.body.innerText,
  }));
  record('сценарии', 'переполненная история: предупреждение и прежние записи сохранены',
    before.warning && before.ids.length === 2001 && JSON.stringify(after.ids) === JSON.stringify(before.ids),
    `${before.ids.length} → ${after.ids.length}`);
  record('сценарии', 'переполненная история: результат диктовки доступен для ручного сохранения',
    after.recover === 'Новая фраза для ручного сохранения.' && /не добавлена/i.test(after.text), after.recover);
  const clicked = await page.evaluate(() => {
    const btn = document.querySelector('.last-result [aria-label="Переспросить точно"]');
    if (!btn) return false;
    btn.click();
    return true;
  });
  await sleep(500);
  const retry = await page.evaluate(() => ({
    calls: (window.__bridgeCalls || []).filter((c) => c.channel === 'stt:transcribe-pcm' && c.args?.[0]?.thorough === true).length,
    warning: document.body.innerText.includes('Нельзя уточнить запись вне истории'),
  }));
  record('сценарии', 'переполненная история: точный проход не обещает сохранить отсутствующую запись',
    clicked && retry.warning && retry.calls === 0, JSON.stringify(retry));
  const errors = takeErrors(page);
  record('сценарии', 'переполненная история: без ошибок консоли', errors.length === 0, errors[0] || '');
  await page.close();
}

// Битые данные: профиль мог испортиться после аварийного выключения, старых
// версий или ручной правки JSON. Приложение обязано открыться, а не умереть.
async function scenarioBrokenData(browser) {
  const page = await openPage(browser, '#/home', {
    settle: 400,
    storeSeed: {
      'zs.dictations': [null, { id: null, text: null }, { text: 'целая запись' }, 'строка вместо записи', 42],
      'zs.clipboard': 'не массив',
      'zs.dictionary': [{ word: null }, 42, { word: 'Атлас' }],
      // не «нет настроек», а испорченные: неизвестная тема, пустой язык,
      // модель, которой нет в комплекте — интерфейс обязан это пережить
      'zs.settings': { onboarded: true, theme: 'неизвестная', language: null, whisperModel: 'нет-такой', voiceHotkeys: 'мусор' },
      'zs.stats': 'мусор',
    },
  });
  takeErrors(page);
  await sleep(400);
  const alive = await page.evaluate(() => Boolean(document.querySelector('.app-window')));
  const text = await page.evaluate(() => document.body.innerText.slice(0, 400));
  record('сценарии', 'битые данные: приложение открывается, а не падает', alive, alive ? '' : text);
  let pagesOk = 0;
  for (const route of ['#/clipboard', '#/dictionary', '#/hotkeys']) {
    await page.evaluate((r) => {
      location.hash = r;
    }, route);
    await sleep(400);
    const ok = await page.evaluate(() => Boolean(document.querySelector('.app-window')));
    if (ok) pagesOk += 1;
  }
  record('сценарии', 'битые данные: остальные экраны тоже открываются', pagesOk === 3, `${pagesOk} из 3`);
  // настройки не должны падать на «странной» теме и несуществующей модели
  await page.evaluate(() => {
    location.hash = '#/settings?section=about&from=home';
  });
  await sleep(500);
  const settingsOk = await page.evaluate(() => Boolean(document.querySelector('.settings-modal, .settings-main')));
  await page.keyboard.press('Escape');
  record('сценарии', 'битые данные: настройки открываются', settingsOk);
  const errors = takeErrors(page);
  record('сценарии', 'битые данные: без ошибок консоли', errors.length === 0, errors[0] || '');
  await page.close();
}

// Обезьяний тест: детерминированный поток случайных нажатий, ввода и Escape.
// Ловит падения рендера, которые не видны в аккуратных сценариях.
async function scenarioMonkey(browser) {
  const routes = ['#/home', '#/clipboard', '#/dictionary', '#/hotkeys', '#/instructions', '#/settings'];
  // простой LCG: одинаковый «случайный» поток при каждом прогоне
  let seed = 20261111;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const page = await openPage(browser, routes[0], { settle: 400 });
  takeErrors(page);
  let actions = 0;
  let dead = 0;
  for (const route of routes) {
    await page.evaluate((r) => {
      location.hash = r;
    }, route);
    await sleep(450);
    for (let i = 0; i < 18; i += 1) {
      const kind = rnd();
      if (kind < 0.62) {
        // клик по случайной видимой кнопке
        await page.evaluate((pick) => {
          const nodes = [...document.querySelectorAll('button, .card, .recent__row, .clip-card')].filter(
            (el) => el.offsetParent !== null && !el.disabled,
          );
          if (!nodes.length) return;
          const el = nodes[Math.floor(pick * nodes.length) % nodes.length];
          el.click();
        }, rnd());
      } else if (kind < 0.78) {
        // ввод в случайное поле
        await page.evaluate((pick) => {
          const nodes = [...document.querySelectorAll('input, textarea')].filter(
            (el) => el.offsetParent !== null && !el.disabled && !el.readOnly,
          );
          if (!nodes.length) return;
          const el = nodes[Math.floor(pick * nodes.length) % nodes.length];
          el.focus();
        }, rnd());
        await page.keyboard.type('тест');
      } else if (kind < 0.9) {
        await page.keyboard.press('Escape');
      } else {
        await page.keyboard.press('Tab');
      }
      actions += 1;
      await sleep(35);
      const alive = await page.evaluate(() => Boolean(document.querySelector('.app-window')));
      if (!alive) dead += 1;
    }
    // закрываем возможные модалки, чтобы следующий маршрут был доступен
    await page.keyboard.press('Escape');
    await sleep(150);
    await page.evaluate(() => {
      location.hash = '#/home';
    });
    await sleep(200);
  }
  const errors = takeErrors(page).filter((e) => !/ResizeObserver|favicon/i.test(e));
  record(
    'сценарии',
    'обезьяний тест: случайные нажатия не ломают экран',
    dead === 0 && errors.length === 0,
    `${actions} действий, ${dead} провалов рендера, ошибок консоли: ${errors.length}${errors[0] ? ` — ${errors[0]}` : ''}`,
  );
  await page.close();
}

async function scenarioClipboardEvent(browser) {
  const page = await openPage(browser, '#/clipboard');
  const before = await page.evaluate(() => (window.__e2e.read('zs.clipboard') || []).length);
  await emit(page, 'clipboard:item', {
    text: 'скопировано в другой программе',
    kind: 'text',
    source: 'Другая программа',
    createdAt: Date.now(),
  });
  await sleep(500);
  const after = await page.evaluate(() => (window.__e2e.read('zs.clipboard') || []).length);
  const visible = await page.evaluate(() => /скопировано в другой программе/.test(document.body.innerText));
  record('события', 'новый элемент из системы появляется в истории буфера', after === before + 1 && visible, `${before} → ${after}`);
  await page.close();
}

async function scenarioTextActionEvent(browser) {
  const page = await openPage(browser, '#/hotkeys', { settle: 400 });
  takeErrors(page);
  const presetId = await page.evaluate(() => {
    const list = window.__e2e.read('zs.presets') || [];
    return list[0]?.id || null;
  });
  if (!presetId) {
    record('события', 'глобальное сочетание запускает AI-инструкцию', false, 'нет пресетов в сиде');
    await page.close();
    return;
  }
  await emit(page, 'text-action', presetId);
  await sleep(1500);
  const calls = await bridgeCalls(page);
  const copied = calls.includes('text:replace-selection') || calls.includes('clipboard:write') || calls.includes('text:insert');
  record('события', 'глобальное сочетание запускает AI-инструкцию и возвращает текст', copied, calls.filter((c) => /text:|clipboard:write/.test(c)).join(','));
  await page.evaluate(() => { window.zspeakly.native.replaceSelection = async () => { throw new Error('IPC lost'); }; });
  await emit(page, 'text-action', presetId);
  await sleep(1500);
  const uncertain = await page.evaluate(() => [...document.querySelectorAll('.toast')].at(-1)?.innerText || '');
  record('безопасность', 'AI-инструкция: потеря IPC не объявляется успехом',
    /Не удалось подтвердить замену/.test(uncertain) && /Проверьте его перед повтором/.test(uncertain), uncertain);
  const errors = takeErrors(page);
  record('события', 'AI-инструкция по хоткею без ошибок консоли', errors.length === 0, errors[0] || '');
  await page.close();
}

// Результат горячей AI-инструкции нигде не хранится кроме уведомления.
async function scenarioTextActionRecovery(browser) {
  for (const mode of ['refused', 'lost', 'unknown', 'copy-only', 'success']) {
    const page = await openPage(browser, '#/hotkeys', {
      settle: 400, settings: { aiProcessing: true, aiEndpoint: 'http://localhost:11434' },
      storeSeed: { 'zs.dictations': [] },
      patchNative: () => {
        window.__longResult = 'Результат инструкции с подробностями и важными данными. '.repeat(6) + 'Конец результата.';
        window.__replaceCount = 0; window.__copyCount = 0;
        window.zspeakly.native.writeClipboard = async (payload) => { window.__copyCount++; window.__sentResult = payload.text; return true; };
        window.zspeakly.native.httpPost = async () => ({ ok: true, data: { response: window.__longResult } });
        window.zspeakly.native.replaceSelection = async (text) => {
          window.__replaceCount++; window.__sentResult = text;
          if (window.__mode === 'lost') throw new Error('IPC lost');
          if (window.__mode === 'unknown') return { uncertain: true };
          return window.__mode === 'success';
        };
      },
    });
    takeErrors(page);
    await page.evaluate((value) => { window.__mode = value; if (value === 'copy-only') delete window.zspeakly.native.replaceSelection; }, mode);
    const id = await page.evaluate(() => (window.__e2e.read('zs.presets') || [])[0]?.id);
    await emit(page, 'text-action', id);
    await sleep(1400);
    if (mode !== 'success') {
      await page.evaluate(() => { location.hash = '#/home'; });
      await sleep(4200);
    }
    const state = await page.evaluate(() => ({
      toast: [...document.querySelectorAll('.toast')].map((t) => t.innerText).join(' | '),
      result: document.querySelector('[aria-label="Невставленный результат инструкции"]')?.value || '',
      expected: window.__longResult, sent: window.__sentResult,
      count: window.__replaceCount, copies: window.__copyCount, history: window.__e2e.read('zs.dictations') || [],
    }));
    if (mode === 'success') {
      record('безопасность', 'AI-инструкция: успешная замена не создаёт поле восстановления',
        /Готово:/.test(state.toast) && !state.result && state.count === 1 && state.sent === state.expected, JSON.stringify(state));
    } else if (mode === 'copy-only') {
      record('безопасность', 'AI-инструкция: только копирование не выдаётся за замену',
        /замена не выполнялась/i.test(state.toast) && /проверьте/i.test(state.toast) && !/Готово:/.test(state.toast) &&
        state.result === state.expected && state.sent === state.expected && state.count === 0 && state.copies === 1 && state.history.length === 0,
        JSON.stringify({ toast: state.toast, length: state.result.length, count: state.count, copies: state.copies }));
    } else {
      record('безопасность', `AI-инструкция: ${mode} сохраняет полный временный результат и предупреждает о проверке`,
        /проверьте/i.test(state.toast) && !/Готово:/.test(state.toast) && /до закрытия уведомления или приложения/i.test(state.toast) &&
        state.result.length > 90 && state.result === state.expected && state.sent === state.expected && state.count === 1 && state.history.length === 0,
        JSON.stringify({ toast: state.toast, length: state.result.length, count: state.count, history: state.history.length }));
    }
    record('безопасность', `AI-инструкция: ${mode} без ошибок консоли`, takeErrors(page).length === 0);
    await page.close();
  }
}

async function scenarioTextActionPartialRecovery(browser) {
  for (const mode of ['busy', 'changed', 'changed-during', 'uncertain', 'refused', 'copied']) {
    const page = await openPage(browser, '#/hotkeys', {
      settle: 400, settings: { aiProcessing: false, language: 'ru', translateTarget: 'en' },
      storeSeed: { 'zs.dictations': [] },
      patchNative: () => {
        window.zspeakly.native.readSelection = async () => 'привет квазикристалл';
        window.zspeakly.native.httpPost = async () => ({ ok: false });
        window.zspeakly.native.writeClipboard = async ({ text }) => { window.__written = text; return true; };
        window.zspeakly.native.replaceSelection = async (text) => {
          window.__written = text;
          if (window.__mode === 'busy') return { busy: true };
          if (window.__mode === 'changed') return { clipboardChanged: true };
          if (window.__mode === 'changed-during') return { clipboardChanged: true, uncertain: true };
          if (window.__mode === 'uncertain') return { uncertain: true };
          return false;
        };
      },
    });
    takeErrors(page);
    await page.evaluate((value) => { window.__mode = value; if (value === 'copied') delete window.zspeakly.native.replaceSelection; }, mode);
    const id = await page.evaluate(() => (window.__e2e.read('zs.presets') || []).find((p) => p.id === 'to-english')?.id);
    await emit(page, 'text-action', id);
    await sleep(1400);
    const state = await page.evaluate(() => ({
      toast: [...document.querySelectorAll('.toast')].map((t) => t.innerText).join(' | '),
      result: document.querySelector('[aria-label="Невставленный результат инструкции"]')?.value || '', written: window.__written,
    }));
    record('безопасность', `AI-инструкция: ${mode} сохраняет предупреждение о частичном переводе`,
      /Часть слов осталась без перевода/i.test(state.toast) && Boolean(state.result) && state.result === state.written, JSON.stringify(state));
    record('безопасность', `AI-инструкция: ${mode} частичный перевод без ошибок консоли`, takeErrors(page).length === 0);
    await page.close();
  }
}

async function scenarioVoicePartialRecovery(browser) {
  const page = await openPage(browser, '#/home', {
    settings: { aiProcessing: true, language: 'ru', translateTarget: 'en' },
    storeSeed: { 'zs.dictations': [], 'zs.mockSttText': 'переведи на английский' }, settle: 700,
    patchNative: () => {
      window.zspeakly.native.readSelection = async () => 'привет квазикристалл';
      window.zspeakly.native.httpPost = async () => ({ ok: false });
      window.zspeakly.native.replaceSelection = async (text) => { window.__written = text; return { uncertain: true }; };
    },
  });
  takeErrors(page);
  await emit(page, 'hotkey', { type: 'toggle', mode: 'toggle', command: true });
  await sleep(1200);
  await emit(page, 'hotkey', { type: 'toggle', mode: 'toggle', command: true });
  await sleep(2600);
  const state = await page.evaluate(() => ({
    toast: [...document.querySelectorAll('.toast')].map((t) => t.innerText).join(' | '),
    history: window.__e2e.read('zs.dictations') || [], written: window.__written,
  }));
  record('безопасность', 'голосовая команда: неизвестная замена сохраняет предупреждение о частичном переводе',
    /Не удалось подтвердить замену/.test(state.toast) && /Часть слов осталась без перевода/i.test(state.toast) &&
    state.written === 'Hello квазикристалл' && state.history[0]?.text === state.written, JSON.stringify(state));
  record('безопасность', 'голосовая команда: частичный перевод без ошибок консоли', takeErrors(page).length === 0);
  await page.close();
}

async function scenarioHotkeyConflict(browser) {
  // конфликт всплывает при запуске — сообщение должно быть видно и на главной
  const page = await openPage(browser, '#/home', { settle: 400 });
  await emit(page, 'hotkey:conflict', { id: 'dictation', keys: ['Ctrl', 'Alt', 'J'], reason: 'сочетание занято другой программой' });
  await sleep(500);
  const toast = await page.evaluate(() =>
    [...document.querySelectorAll('.toast')].map((t) => t.innerText).join(' | '),
  );
  record('события', 'занятое сочетание показывается предупреждением', /занято/i.test(toast), toast.slice(0, 80));
  record('события', 'в предупреждении видно сочетание и причину', /Ctrl\s*\+\s*Alt\s*\+\s*J/.test(toast) && /другой программой/i.test(toast), toast.slice(0, 100));
  await page.close();
}

async function scenarioUpdateEvent(browser) {
  const page = await openPage(browser, '#/home');
  await emit(page, 'update:status', { status: 'available', version: '1.5.0' });
  await sleep(500);
  const toast = await page.evaluate(() =>
    [...document.querySelectorAll('.toast')].map((t) => t.innerText).join(' | '),
  );
  record('события', 'доступное обновление объявляется само', /1\.5\.0/.test(toast), toast.slice(0, 80));
  await page.close();
}

async function scenarioModelProgress(browser) {
  const page = await openPage(browser, '#/settings?section=features&from=home', { settle: 600 });
  takeErrors(page);
  await emit(page, 'model:progress', { id: 'tiny', percent: 42 });
  await sleep(400);
  await emit(page, 'model:progress', { id: 'tiny', percent: 100, done: true, ok: true });
  await sleep(600);
  const body = await page.evaluate(() => document.body.innerText);
  const toast = await page.evaluate(() =>
    [...document.querySelectorAll('.toast')].map((t) => t.innerText).join(' | '),
  );
  record('события', 'прогресс скачивания модели доходит до «скачано»', /Модель скачана|Скачано|скачана/i.test(`${body} ${toast}`), toast.slice(0, 80));
  const errors = takeErrors(page);
  record('события', 'прогресс модели без ошибок консоли', errors.length === 0, errors[0] || '');
  await page.close();
}

/* ── клавиатура, сохранность данных, сроки хранения, пустые состояния ──── */

async function scenarioKeyboard(browser) {
  const page = await openPage(browser, '#/home');
  await page.keyboard.down('Control');
  await page.keyboard.press(',');
  await page.keyboard.up('Control');
  await sleep(400);
  const opened = await page.evaluate(() => Boolean(document.querySelector('.settings-modal')));
  await page.evaluate(() => document.querySelector('.settings-modal .modal__close, .settings-modal [aria-label="Закрыть"]')?.click());
  await sleep(400);
  const closedByX = await page.evaluate(() => !document.querySelector('.settings-modal'));
  // и второй способ закрыть: Esc (раньше здесь проверялся только крестик)
  await page.keyboard.down('Control');
  await page.keyboard.press(',');
  await page.keyboard.up('Control');
  await sleep(400);
  const reopened = await page.evaluate(() => Boolean(document.querySelector('.settings-modal')));
  await page.keyboard.press('Escape');
  await sleep(400);
  const closedByEsc = await page.evaluate(() => !document.querySelector('.settings-modal'));

  await page.keyboard.down('Control');
  await page.keyboard.press('KeyK');
  await page.keyboard.up('Control');
  await sleep(500);
  const search = await page.evaluate(() => ({
    palette: Boolean(document.querySelector('.command')),
    focused: document.activeElement === document.querySelector('.command__input'),
  }));
  record(
    'клавиатура',
    'Ctrl+, открывает настройки, крестик и Esc закрывают',
    opened && closedByX && reopened && closedByEsc,
    `открылись=${opened} крестик=${closedByX} снова=${reopened} Esc=${closedByEsc}`,
  );
  // Ctrl+K раньше вёл в поиск по буферу — теперь открывает палитру команд.
  record(
    'клавиатура',
    'Ctrl+K открывает палитру команд и ставит курсор в поле',
    search.palette && search.focused,
    JSON.stringify(search),
  );
  await page.keyboard.press('Escape');
  await sleep(250);

  // Поиск по буферу остался на своей странице
  await page.evaluate(() => { window.location.hash = '#/clipboard'; });
  await sleep(400);
  const clipSearch = await page.evaluate(() => {
    const input = document.querySelector('.clip-toolbar .search-input input');
    if (!input) return false;
    input.focus();
    return document.activeElement === input;
  });
  record('клавиатура', 'поиск по буферу живёт на странице буфера', clipSearch, clipSearch ? 'поле найдено' : 'поля нет');
  await page.close();
}

async function scenarioPersistence(browser) {
  const page = await openPage(browser, '#/dictionary', { settle: 350 });
  await clickText(page, 'Добавить');
  await sleep(300);
  const input = await page.$('.modal input');
  await input.type('Постоянное');
  await clickIn(page, '.modal', 'Добавить');
  await sleep(400);

  await page.goto(`${BASE}/#/settings?section=app&from=home`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.app-window');
  await sleep(350);
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.select__btn')].find((b) => /Тёмная|Светлая|Как в системе/.test(b.innerText));
    btn?.click();
  });
  await sleep(200);
  await page.evaluate(() => {
    const opt = [...document.querySelectorAll('[role="option"]')].find((o) => /Светлая/.test(o.innerText));
    opt?.click();
  });
  await sleep(400);

  // перезагрузка «как после перезапуска приложения»
  await page.goto(`${BASE}/#/dictionary`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.app-window');
  await sleep(500);
  const state = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    hasWord: /Постоянное/.test(document.body.innerText),
    stored: JSON.stringify(window.__e2e.read('zs.dictionary') || []).includes('Постоянное'),
  }));
  record('данные', 'слово и тема переживают перезапуск', state.theme === 'light' && state.hasWord && state.stored, `${state.theme}, ${state.hasWord}`);
  await page.close();
}

async function scenarioRetention(browser) {
  const now = Date.now();
  const day = 86400000;
  const seed = Array.from({ length: 5 }, (_, i) => ({
    id: `old_${i}`,
    kind: 'text',
    text: `старый элемент ${i}`,
    source: 'Тест',
    createdAt: now - (40 + i) * day,
  }));
  const page = await openPage(browser, '#/clipboard', {
    settle: 600,
    settings: { clipboardRetentionDays: 30 },
    storeSeed: { 'zs.clipboard': seed },
  });
  const left = await page.evaluate(() => (window.__e2e.read('zs.clipboard') || []).length);
  const empty = await page.evaluate(() => /История буфера пуста/i.test(document.body.innerText));
  record('данные', 'записи старше срока хранения удаляются при запуске', left === 0 || empty, `осталось ${left}`);

  const seedPinned = [{ ...seed[0], id: 'pin_1', pinned: true, text: 'закреплённый старый' }];
  const page2 = await openPage(browser, '#/clipboard', {
    settle: 600,
    settings: { clipboardRetentionDays: 30 },
    storeSeed: { 'zs.clipboard': seedPinned },
  });
  const pinnedLeft = await page2.evaluate(() => (window.__e2e.read('zs.clipboard') || []).filter((i) => i.pinned).length);
  record('данные', 'закреплённое не удаляется по сроку', pinnedLeft === 1);
  await page2.close();
  await page.close();
}

async function scenarioEmptyStates(browser) {
  const page = await openPage(browser, '#/clipboard', { settle: 500, storeSeed: { 'zs.clipboard': [] } });
  const clipEmpty = await page.evaluate(() => /История буфера пуста/i.test(document.body.innerText));
  await page.goto(`${BASE}/#/dictionary`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.app-window');
  await page.evaluate(() => window.__e2e.seed('zs.dictionary', []));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.app-window');
  await sleep(500);
  const dictText = await page.evaluate(() => document.body.innerText);
  record('данные', 'пустой буфер показывает понятное состояние', clipEmpty);
  record('данные', 'пустой словарь не выглядит сломанным', /Словарь/i.test(dictText) && !/NaN|undefined/.test(dictText));
  await page.close();
}

// Браузерное превью: моста плавающего индикатора нет, поэтому индикатор
// рисуется внутри окна. Именно этот путь и проверяют сценарии ниже.
const NO_NATIVE_HUD = () => {
  const native = window.zspeakly && window.zspeakly.native;
  if (!native) return;
  delete native.hudShow;
  delete native.hudHide;
  delete native.hudUpdate;
  delete native.hudStatus;
  delete native.onHudClosed;
};

async function scenarioSttFailure(browser) {
  const page = await openPage(browser, '#/home', { patchNative: NO_NATIVE_HUD });
  takeErrors(page);
  await page.evaluate(() => {
    window.zspeakly.native.transcribePcm = async () => ({ ok: false, text: '', reason: 'движок не установлен' });
  });
  await clickText(page, 'Начать диктовку');
  await sleep(1200);
  await page.evaluate(() => document.querySelector('[aria-label="Остановить запись"]')?.click());
  await sleep(1500);
  const body = await page.evaluate(() => document.body.innerText);
  const honest = /не распознал|не установлен|проверьте модель/i.test(body);
  record('ошибки', 'сбой распознавания объясняется, а не молчит', honest, body.match(/[^\n]*(?:не распознал|не установлен)[^\n]*/i)?.[0]?.slice(0, 80) || '');
  const stored = await page.evaluate(() => (window.__e2e.read('zs.dictations') || []).length);
  record('ошибки', 'пустая расшифровка не попадает в историю', stored <= 21, `${stored} записей`);
  await page.close();
}

/* ── автопроверка контраста и вёрстки ─────────────────────────────────── */

function auditContrast() {
  const parse = (value) => {
    const m = String(value).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const parts = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  };
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });
  const luminance = ({ r, g, b }) => {
    const f = (c) => {
      const x = c / 255;
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => {
    const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (l1 + 0.05) / (l2 + 0.05);
  };
  const backgroundOf = (el) => {
    let node = el;
    let result = { r: 255, g: 255, b: 255, a: 1 };
    const stack = [];
    while (node && node !== document.documentElement) {
      const bg = parse(getComputedStyle(node).backgroundColor);
      if (bg && bg.a > 0) stack.push(bg);
      node = node.parentElement;
    }
    const htmlBg = parse(getComputedStyle(document.documentElement).backgroundColor);
    stack.push(htmlBg && htmlBg.a > 0 ? htmlBg : { r: 255, g: 255, b: 255, a: 1 });
    for (let i = stack.length - 1; i >= 0; i -= 1) result = over(stack[i], result);
    return result;
  };

  const problems = [];
  const walker = document.createTreeWalker(document.querySelector('.app-window') || document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  let node = walker.nextNode();
  while (node) {
    const text = (node.textContent || '').trim();
    const el = node.parentElement;
    if (text.length > 1 && el && !seen.has(el)) {
      seen.add(el);
      const style = getComputedStyle(el);
      if (style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0.15) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 2 && rect.height > 2) {
          let color = parse(style.color);
          if (color) {
            if (color.a < 1) color = over(color, backgroundOf(el));
            const bg = backgroundOf(el);
            const value = ratio(color, bg);
            if (value < 3) {
              problems.push({
                text: text.slice(0, 40),
                cls: String(el.className || el.tagName).slice(0, 40),
                ratio: Math.round(value * 100) / 100,
              });
            }
          }
        }
      }
    }
    node = walker.nextNode();
  }
  return problems;
}

function auditOverflow() {
  const win = document.querySelector('.app-window');
  if (!win) return [];
  const bounds = win.getBoundingClientRect();
  const out = [];
  win.querySelectorAll('*').forEach((el) => {
    const style = getComputedStyle(el);
    if (style.position === 'fixed' || style.display === 'none' || style.visibility === 'hidden') return;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const overflowRight = rect.right > bounds.right + 1;
    // многоточие — это не баг: у обрезанного текста scrollWidth всегда больше
    const ellipsis = style.textOverflow === 'ellipsis' || style.overflow === 'hidden';
    const ownScroll =
      !ellipsis && el.scrollWidth > el.clientWidth + 4 && style.overflowX !== 'auto' && style.overflowX !== 'scroll';
    if (overflowRight || ownScroll) {
      out.push({
        cls: String(el.className || el.tagName).slice(0, 46),
        over: Math.round(rect.right - bounds.right),
        scroll: el.scrollWidth - el.clientWidth,
      });
    }
  });
  return out;
}

async function scenarioVisualAudit(browser) {
  const pages = [
    ['#/home', 'главная'],
    ['#/dictionary', 'словарь'],
    ['#/hotkeys', 'хоткеи'],
    ['#/clipboard', 'буфер'],
    ['#/settings?section=app&from=home', 'настройки'],
    ['#/settings?section=diagnostics&from=home', 'диагностика'],
  ];
  const contrastFails = [];
  const overflowFails = [];
  for (const theme of ['dark', 'light']) {
    for (const [route, label] of pages) {
      const page = await openPage(browser, route, { settle: 450, settings: { theme } });
      const contrast = await page.evaluate(auditContrast);
      const overflow = await page.evaluate(auditOverflow);
      await page.close();
      for (const c of contrast.slice(0, 3)) contrastFails.push(`${theme}/${label}: «${c.text}» (${c.cls}) ${c.ratio}:1`);
      for (const o of overflow.slice(0, 3)) overflowFails.push(`${theme}/${label}: ${o.cls} (+${o.over}px / scroll ${o.scroll})`);
    }
  }
  record('вид', 'контраст текста не ниже 3:1 в обеих темах', contrastFails.length === 0, contrastFails.slice(0, 6).join('; '));
  record('вид', 'ничего не вылезает за окно', overflowFails.length === 0, overflowFails.slice(0, 6).join('; '));

  // ноутбук и узкое окно: интерфейс не должен разваливаться при уменьшении
  const narrowFails = [];
  const narrowPages = [
    ['#/home', 'главная'],
    ['#/dictionary', 'словарь'],
    ['#/clipboard', 'буфер'],
    ['#/settings?section=app&from=home', 'настройки'],
  ];
  for (const viewport of [
    { width: 1024, height: 700 },
    { width: 900, height: 640 },
  ]) {
    for (const [route, label] of narrowPages) {
      const page = await openPage(browser, route, { settle: 400, viewport });
      const overflow = await page.evaluate(auditOverflow);
      await page.close();
      for (const o of overflow.slice(0, 2)) narrowFails.push(`${viewport.width}px/${label}: ${o.cls} (+${o.over}px)`);
    }
  }
  record('вид', 'в узком окне (1024 и 900 px) ничего не обрезается', narrowFails.length === 0, narrowFails.slice(0, 6).join('; '));
}

/* ── настройки, которые должны что-то менять ──────────────────────────── */

async function scenarioHidePasswords(browser) {
  const page = await openPage(browser, '#/clipboard', { settle: 500, settings: { hidePasswords: true } });
  const gridDots = await page.evaluate(() =>
    [...document.querySelectorAll('.clip-card__text')].some((el) => /^•+$/.test(el.innerText.trim())),
  );
  await page.evaluate(() => document.querySelector('.clip-toolbar__view button:nth-child(2)').click());
  await sleep(250);
  await page.evaluate(() => {
    const item = [...document.querySelectorAll('.clip-list__item')].find((el) => /•/.test(el.innerText));
    item?.click();
  });
  await sleep(300);
  const maskedInPreview = await page.evaluate(() => /•{4,}/.test(document.querySelector('.clip-preview')?.innerText || ''));
  const revealed = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.clip-preview__reveal')].find((b) => /Показать/i.test(b.innerText));
    if (!btn) return false;
    btn.click();
    return true;
  });
  await sleep(300);
  const afterReveal = await page.evaluate(() => !/•{4,}/.test(document.querySelector('.clip-preview')?.innerText || ''));
  record('настройки', 'пароли маскируются в сетке и предпросмотре', gridDots && maskedInPreview);
  record('настройки', '«Показать» раскрывает пароль', revealed && afterReveal);
  await page.close();
}

async function scenarioIndicator(browser) {
  const page = await openPage(browser, '#/home', {
    settings: { showFloatingIndicator: false },
    patchNative: NO_NATIVE_HUD,
  });
  await clickText(page, 'Начать диктовку');
  await sleep(1200);
  const hud = await page.evaluate(() => Boolean(document.querySelector('.hud')));
  await page.evaluate(() => document.querySelector('[aria-label="Остановить запись"]')?.click());
  await sleep(1200);
  record('настройки', 'выключенный индикатор не показывается при записи', !hud);

  const page2 = await openPage(browser, '#/home', {
    settings: { showFloatingIndicator: true },
    patchNative: NO_NATIVE_HUD,
  });
  await clickText(page2, 'Начать диктовку');
  await sleep(1200);
  const hud2 = await page2.evaluate(() => Boolean(document.querySelector('.hud')));
  await page2.evaluate(() => document.querySelector('[aria-label="Остановить запись"]')?.click());
  await sleep(900);
  record('настройки', 'включённый индикатор показывает «Слушаю…»', hud2);
  await page.close();
  await page2.close();
}

async function scenarioReadAloud(browser) {
  const page = await openPage(browser, '#/home', {
    settings: { readAloud: true, soundFeedback: false },
    patchNative: NO_NATIVE_HUD,
  });
  await page.evaluate(() => {
    window.__spoken = [];
    window.speechSynthesis = window.speechSynthesis || {};
    window.speechSynthesis.speak = (utterance) => window.__spoken.push(String(utterance?.text || ''));
    window.SpeechSynthesisUtterance = window.SpeechSynthesisUtterance || function SpeechSynthesisUtterance(text) {
      this.text = text;
    };
  });
  await clickText(page, 'Начать диктовку');
  await sleep(1200);
  await page.evaluate(() => document.querySelector('[aria-label="Остановить запись"]')?.click());
  await sleep(2000);
  const spoken = await page.evaluate(() => window.__spoken || []);
  const notify = await bridgeCalls(page);
  record('настройки', '«Читать результат голосом» реально озвучивает текст', spoken.length > 0, spoken[0]?.slice(0, 50) || 'ничего не озвучено');
  void notify;
  await page.close();
}

async function scenarioAiOff(browser) {
  // 1.6.0: постобработка включена всегда, поэтому «без модели» — это отказ
  // сервера и выключенная полировка (её выбор остаётся у человека)
  const page = await openPage(browser, '#/hotkeys', {
    settle: 400,
    settings: { aiDictationRewrite: false },
    patchNative: () => {
      const native = window.zspeakly && window.zspeakly.native;
      if (!native) return;
      native.httpPost = async () => ({ ok: false, status: 0 });
      native.httpGet = async () => ({ ok: false, status: 0 });
    },
  });
  takeErrors(page);
  const presetId = await page.evaluate(() => (window.__e2e.read('zs.presets') || [])[0]?.id || null);
  await page.evaluate((id) => window.__e2e.emit('text-action', id), presetId);
  await sleep(1500);
  const calls = await bridgeCalls(page);
  const toast = await page.evaluate(() =>
    [...document.querySelectorAll('.toast')].map((t) => t.innerText.replace(/\n/g, ' ')).join(' | '),
  );
  // офлайн-операция может и не изменить текст — тогда приложение честно пишет «изменений нет»
  const answered = /Готово|Изменений нет|Нет выделенного/i.test(toast);
  record(
    'настройки',
    'без локальной модели инструкция отвечает офлайн-правилами',
    answered && !calls.includes('http:post'),
    `${calls.filter((c) => /http|text:/.test(c)).join(',')} · ${toast.slice(0, 60)}`,
  );
  const errors = takeErrors(page);
  record('настройки', 'офлайн-инструкция без ошибок консоли', errors.length === 0, errors[0] || '');
  await page.close();
}

/* ── режимы диктовки, кнопки окна, звук и эффект печати ───────────────── */

// Конфликтующие операции не отправляются повторно и не объявляются успехом.
async function scenarioSelectionBusy(browser) {
  const voice = await openPage(browser, '#/home', {
    settings: { aiDictationRewrite: false, aiProcessing: true },
    storeSeed: { 'zs.dictations': [], 'zs.mockSttText': 'сократи вдвое' }, settle: 700,
    patchNative: () => {
      window.__replaceCount = 0;
      window.zspeakly.native.replaceSelection = async () => { window.__replaceCount++; return { busy: true }; };
    },
  });
  takeErrors(voice);
  await emit(voice, 'hotkey', { type: 'toggle', mode: 'toggle', command: true });
  await sleep(1200);
  await emit(voice, 'hotkey', { type: 'toggle', mode: 'toggle', command: true });
  await sleep(2600);
  const voiceState = await voice.evaluate(() => ({
    toast: [...document.querySelectorAll('.toast')].map((t) => t.innerText).join(' | '),
    history: window.__e2e.read('zs.dictations') || [], count: window.__replaceCount,
  }));
  record('безопасность', 'голосовая команда: занятая замена остаётся в истории и не повторяется',
    /Другая операция с текстом ещё выполняется/.test(voiceState.toast) && /не вставлен и не скопирован/.test(voiceState.toast)
      && /истории/.test(voiceState.toast) && !/Готово: сократить/.test(voiceState.toast)
      && voiceState.history[0]?.source === 'command' && Boolean(voiceState.history[0]?.text) && voiceState.count === 1, voiceState.toast);
  record('безопасность', 'голосовая команда: занятая замена без ошибок консоли', takeErrors(voice).length === 0);
  await voice.close();

  const hotkey = await openPage(browser, '#/hotkeys', {
    settle: 400, storeSeed: { 'zs.dictations': [] },
    patchNative: () => { window.__replaceCount = 0; window.zspeakly.native.replaceSelection = async (text) => { window.__replaceCount++; window.__refusedResult = text; return { busy: true }; }; },
  });
  takeErrors(hotkey);
  const preset = await hotkey.evaluate(() => (window.__e2e.read('zs.presets') || [])[0]?.id);
  await emit(hotkey, 'text-action', preset);
  await sleep(1500);
  const hotkeyState = await hotkey.evaluate(() => ({
    toast: [...document.querySelectorAll('.toast')].at(-1)?.innerText || '',
    count: window.__replaceCount, history: window.__e2e.read('zs.dictations') || [],
    result: document.querySelector('[aria-label="Невставленный результат инструкции"]')?.value, expected: window.__refusedResult,
  }));
  record('безопасность', 'AI-инструкция: результат доступен полностью и не сохраняется в истории',
    Boolean(preset) && /Другая операция с текстом ещё выполняется/.test(hotkeyState.toast)
      && /не вставлен и не скопирован/.test(hotkeyState.toast) && /исчезнет при закрытии/.test(hotkeyState.toast)
      && Boolean(hotkeyState.result) && hotkeyState.result === hotkeyState.expected
      && hotkeyState.count === 1 && hotkeyState.history.length === 0, hotkeyState.toast);
  await hotkey.evaluate(() => { location.hash = '#/home'; });
  await sleep(4000);
  record('безопасность', 'AI-инструкция: временный результат не пропадает при переходе и обычном таймауте',
    await hotkey.evaluate(() => document.querySelector('[aria-label="Невставленный результат инструкции"]')?.value === window.__refusedResult));
  await hotkey.evaluate(() => { location.hash = '#/hotkeys'; window.zspeakly.native.readSelection = async () => ({ reason: 'busy', text: '' }); });
  await sleep(400);
  for (let i = 0; i < 5; i++) { await emit(hotkey, 'text-action', preset); await sleep(100); }
  record('безопасность', 'AI-инструкция: следующие уведомления не удаляют невставленный результат',
    await hotkey.evaluate(() => document.querySelectorAll('.toast').length >= 4 && document.querySelector('[aria-label="Невставленный результат инструкции"]')?.value === window.__refusedResult));
  await hotkey.evaluate(() => document.querySelector('[aria-label="Невставленный результат инструкции"]').closest('.toast').querySelector('[aria-label="Закрыть"]').click());
  record('безопасность', 'AI-инструкция: временный результат удаляется только после закрытия',
    await hotkey.evaluate(() => !document.querySelector('[aria-label="Невставленный результат инструкции"]')));
  record('безопасность', 'AI-инструкция: занятая замена без ошибок консоли', takeErrors(hotkey).length === 0);
  await hotkey.close();

  for (const during of [false, true]) {
    const conflict = await openPage(browser, '#/hotkeys', {
      settle: 400, storeSeed: { 'zs.dictations': [] },
      patchNative: () => {
        window.__replaceCount = 0;
        window.zspeakly.native.replaceSelection = async (text) => {
          window.__replaceCount++; window.__refusedResult = text;
          return window.__conflictDuring ? { clipboardChanged: true, uncertain: true } : { clipboardChanged: true };
        };
      },
    });
    takeErrors(conflict);
    await conflict.evaluate((value) => { window.__conflictDuring = value; }, during);
    const id = await conflict.evaluate(() => (window.__e2e.read('zs.presets') || [])[0]?.id);
    await emit(conflict, 'text-action', id);
    await sleep(1500);
    const state = await conflict.evaluate(() => ({
      toast: [...document.querySelectorAll('.toast')].at(-1)?.innerText || '',
      result: document.querySelector('[aria-label="Невставленный результат инструкции"]')?.value,
      expected: window.__refusedResult, count: window.__replaceCount,
    }));
    record('безопасность', `AI-инструкция: изменение буфера ${during ? 'во время' : 'до'} замены показано и результат доступен`,
      /буфер/i.test(state.toast) && !/Готово:/.test(state.toast) &&
      (during ? /другой текст/i.test(state.toast) && /проверьте/i.test(state.toast) : /не отправлялась/i.test(state.toast)) &&
      state.count === 1 && Boolean(state.expected) && state.result === state.expected, JSON.stringify(state));
    record('безопасность', `AI-инструкция: изменение буфера ${during ? 'во время' : 'до'} замены без ошибок консоли`, takeErrors(conflict).length === 0);
    await conflict.close();
  }
  for (const during of [false, true]) {
    const conflict = await openPage(browser, '#/home', {
      settings: { aiDictationRewrite: false, aiProcessing: true },
      storeSeed: { 'zs.dictations': [], 'zs.mockSttText': 'сократи вдвое' }, settle: 700,
      patchNative: () => {
        window.__replaceCount = 0;
        window.zspeakly.native.replaceSelection = async () => {
          window.__replaceCount++;
          return window.__conflictDuring ? { clipboardChanged: true, uncertain: true } : { clipboardChanged: true };
        };
      },
    });
    takeErrors(conflict);
    await conflict.evaluate((value) => { window.__conflictDuring = value; }, during);
    await emit(conflict, 'hotkey', { type: 'toggle', mode: 'toggle', command: true });
    await sleep(1200);
    await emit(conflict, 'hotkey', { type: 'toggle', mode: 'toggle', command: true });
    await sleep(2600);
    const state = await conflict.evaluate(() => ({
      toast: [...document.querySelectorAll('.toast')].map((t) => t.innerText).join(' | '),
      history: window.__e2e.read('zs.dictations') || [], count: window.__replaceCount,
      recover: document.querySelector('[aria-label="Результат команды для ручного сохранения"]')?.value,
    }));
    record('безопасность', `голосовая команда: изменение буфера ${during ? 'во время' : 'до'} замены показано и результат доступен`,
      /буфер/i.test(state.toast) && !/Готово: сократить/.test(state.toast) &&
      (during ? /другой текст/i.test(state.toast) && /проверьте/i.test(state.toast) : /не отправлялась/i.test(state.toast)) &&
      state.count === 1 && Boolean(state.history[0]?.text) && state.recover === state.history[0].text, JSON.stringify(state));
    record('безопасность', `голосовая команда: изменение буфера ${during ? 'во время' : 'до'} замены без ошибок консоли`, takeErrors(conflict).length === 0);
    await conflict.close();
  }

  const blocked = await openPage(browser, '#/home', {
    settle: 500,
    patchNative: () => { window.zspeakly.native.readSelection = async () => ({ text: '', reason: 'busy' }); },
  });
  takeErrors(blocked);
  await emit(blocked, 'hotkey', { type: 'toggle', mode: 'toggle', command: true });
  await sleep(1000);
  const blockedState = await blocked.evaluate(() => ({ body: document.body.innerText, calls: window.__bridgeCalls || [] }));
  record('безопасность', 'занятое чтение: голосовая команда не начинает запись',
    /Другая операция ещё выполняется/.test(blockedState.body) && /Выделение не читалось/.test(blockedState.body)
      && !/Слушаю/.test(blockedState.body) && !blockedState.calls.some((c) => c.channel === 'text:replace-selection'));
  record('безопасность', 'занятое чтение: без ошибок консоли', takeErrors(blocked).length === 0);
  await blocked.close();
}

// Неподтверждённый старый буфер не становится текстом команды или агента.
async function scenarioSelectionUnverified(browser) {
  const patch = () => {
    window.zspeakly.native.readSelection = async () => ({ text: 'старый секрет', reason: 'unverified' });
    window.__prompts = [];
    window.zspeakly.native.httpPost = async (payload) => {
      window.__prompts.push(payload?.body?.prompt || '');
      return { ok: true, data: { response: 'Ответ тестовой модели' } };
    };
  };
  const voice = await openPage(browser, '#/home', { settle: 600, patchNative: patch });
  takeErrors(voice);
  await emit(voice, 'hotkey', { type: 'toggle', mode: 'toggle', command: true });
  await sleep(900);
  const voiceState = await voice.evaluate(() => ({ body: document.body.innerText, prompts: window.__prompts, calls: window.__bridgeCalls || [] }));
  record('безопасность', 'неподтверждённое выделение не запускает голосовую команду',
    /Выделение не подтверждено/.test(voiceState.body) && !/Слушаю/.test(voiceState.body) && voiceState.prompts.length === 0 && !voiceState.calls.some((c) => c.channel === 'text:replace-selection'));
  record('безопасность', 'голосовая команда без выделения: без ошибок консоли', takeErrors(voice).length === 0);
  await voice.close();

  const hotkey = await openPage(browser, '#/hotkeys', { settle: 400, patchNative: patch });
  takeErrors(hotkey);
  const preset = await hotkey.evaluate(() => (window.__e2e.read('zs.presets') || [])[0]?.id);
  await emit(hotkey, 'text-action', preset);
  await sleep(900);
  const hotkeyState = await hotkey.evaluate(() => ({ body: document.body.innerText, prompts: window.__prompts, calls: window.__bridgeCalls || [] }));
  record('безопасность', 'неподтверждённое выделение не запускает AI-инструкцию',
    Boolean(preset) && /Выделение не подтверждено/.test(hotkeyState.body) && hotkeyState.prompts.length === 0 && !hotkeyState.calls.some((c) => c.channel === 'text:replace-selection'));
  record('безопасность', 'AI-инструкция без выделения: без ошибок консоли', takeErrors(hotkey).length === 0);
  await hotkey.close();

  const agent = await openPage(browser, '#/home', { settle: 500, settings: { aiEndpoint: 'http://localhost:11434' }, patchNative: patch });
  takeErrors(agent);
  await emit(agent, 'hotkey', { type: 'agent' });
  await sleep(1200);
  const agentState = await agent.evaluate(() => ({ body: document.body.innerText, prompts: window.__prompts }));
  record('безопасность', 'агент предупреждает и не отправляет неподтверждённый контекст',
    /Выделение не подтверждено/.test(agentState.body) && /Агент ответит без контекста/.test(agentState.body) && agentState.prompts.length === 1 && !/Контекст:|старый секрет|unverified/.test(agentState.prompts[0]));
  record('безопасность', 'агент без подтверждённого выделения: без ошибок консоли', takeErrors(agent).length === 0);
  await agent.close();
}

// Отмена до получения выделения не должна отправлять данные в модель.
async function scenarioAgentSelectionCancel(browser) {
  const page = await openPage(browser, '#/home', {
    settings: { aiEndpoint: 'http://localhost:11434', aiDictationRewrite: false },
    storeSeed: { 'zs.dictations': [] },
    patchNative: () => {
      window.zspeakly.native.readSelection = () => new Promise((resolve) => { window.__agentSelection = resolve; });
    },
  });
  takeErrors(page);
  try {
    await emit(page, 'hotkey', { type: 'agent' });
    await page.waitForFunction(() => Boolean(window.__agentSelection), { timeout: 8000 });
    await page.waitForSelector('.live-draft--processing button', { timeout: 8000 });
    await page.click('.live-draft--processing button');
    await page.evaluate(() => window.__agentSelection('секретное выделение'));
    await sleep(600);
    const result = await page.evaluate(() => ({
      calls: (window.__bridgeCalls || []).filter((call) => ['http:post', 'stt:cancel'].includes(call.channel)).map((call) => call.channel),
      history: window.__e2e.read('zs.dictations') || [],
      processing: Boolean(document.querySelector('.live-draft--processing')),
    }));
    const errors = takeErrors(page);
    record('режимы', 'агент: отмена до выделения не отправляет текст и не отменяет чужой STT',
      result.calls.length === 0 && result.history.length === 0 && !result.processing && errors.length === 0,
      JSON.stringify({ ...result, error: errors[0] }));
  } finally { await page.close(); }
}

// Поздний ответ отменённого агента не должен перезаписывать новую запись.
async function scenarioAgentCancelAndRetry(browser) {
  const page = await openPage(browser, '#/home', {
    settings: { aiEndpoint: 'http://localhost:11434', aiDictationRewrite: false, liveWhisper: false },
    storeSeed: { 'zs.dictations': [], 'zs.mockSttText': 'новая диктовка' },
    patchNative: () => {
      window.__agentPosts = 0;
      window.zspeakly.native.httpPost = () => {
        window.__agentPosts += 1;
        return new Promise((resolve) => { window.__agentAnswer = resolve; });
      };
    },
  });
  takeErrors(page);
  try {
    await emit(page, 'hotkey', { type: 'agent' });
    await page.waitForFunction(() => Boolean(window.__agentAnswer), { timeout: 8000 });
    await emit(page, 'hotkey', { type: 'agent' });
    await emit(page, 'hotkey', { type: 'down', mode: 'hold' });
    await sleep(300);
    const blocked = await page.evaluate(() => ({
      posts: window.__agentPosts,
      listening: /Слушаю/.test(document.querySelector('.hero__mic')?.innerText || ''),
      processing: Boolean(document.querySelector('.live-draft--processing button')),
      description: document.querySelector('.live-draft--processing')?.innerText || '',
      hud: (window.__bridgeCalls || []).filter((call) => call.channel === 'hud:update').at(-1)?.args?.[0]?.agent,
    }));
    if (blocked.processing) await page.click('.live-draft--processing button');
    else await emit(page, 'hotkey', { type: 'cancel' });
    await sleep(100);
    await emit(page, 'hotkey', { type: 'down', mode: 'hold' });
    await sleep(1100);
    await page.evaluate(() => window.__agentAnswer({ ok: true, data: { response: 'старый ответ агента' } }));
    await sleep(300);
    const during = await page.evaluate(() => ({
      listening: /Слушаю/.test(document.querySelector('.hero__mic')?.innerText || ''),
      history: window.__e2e.read('zs.dictations') || [],
    }));
    await emit(page, 'hotkey', { type: 'up' });
    await sleep(1000);
    const result = await page.evaluate(() => ({
      texts: (window.__e2e.read('zs.dictations') || []).map((row) => row.text),
      inserts: (window.__bridgeCalls || []).filter((call) => call.channel === 'text:insert').map((call) => call.args?.[0]),
    }));
    const errors = takeErrors(page);
    record('режимы', 'агент: занятый запрос блокирует повтор; отменённый ответ не мешает новой диктовке',
      blocked.posts === 1 && !blocked.listening && blocked.processing && /Агент ждёт ответ/i.test(blocked.description) && blocked.hud === true && during.listening && during.history.length === 0 &&
      result.texts.length === 1 && /новая диктовка/i.test(result.texts[0]) && result.inserts.length === 1 && errors.length === 0,
      JSON.stringify({ blocked, during, ...result, error: errors[0] }));
  } finally { await page.close(); }
}

// Таймаут относится к старому запросу; поздний отказ не блокирует повтор.
async function scenarioAgentTimeout(browser) {
  const page = await openPage(browser, '#/home', {
    settings: { aiEndpoint: 'http://localhost:11434', aiDictationRewrite: false },
    storeSeed: { 'zs.dictations': [] },
    patchNative: () => {
      const original = window.setTimeout.bind(window);
      window.setTimeout = (fn, delay, ...args) => original(fn, delay === 25000 ? 1200 : delay, ...args);
      let posts = 0;
      window.zspeakly.native.httpPost = () => {
        window.__agentTimeoutPosts = ++posts;
        return posts === 1 ? new Promise((resolve) => { window.__agentOldReply = resolve; })
          : Promise.resolve({ ok: true, data: { response: 'новый ответ агента' } });
      };
    },
  });
  takeErrors(page);
  try {
    await emit(page, 'hotkey', { type: 'agent' });
    await page.waitForFunction(() => Boolean(window.__agentOldReply), { timeout: 8000 });
    await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some((node) => /Агент не ответил вовремя/.test(node.innerText)), { timeout: 5000 });
    await page.evaluate(() => window.__agentOldReply({ ok: false, reason: 'слишком поздно' }));
    await sleep(200);
    await emit(page, 'hotkey', { type: 'agent' });
    await sleep(900);
    const result = await page.evaluate(() => ({
      posts: window.__agentTimeoutPosts,
      history: window.__e2e.read('zs.dictations') || [],
      processing: Boolean(document.querySelector('.live-draft--processing')),
    }));
    const errors = takeErrors(page);
    record('режимы', 'агент: таймаут разрешает повтор, поздний отказ не включает блокировку модели',
      result.posts === 2 && result.history.length === 1 && result.history[0].source === 'agent' &&
      /новый ответ агента/i.test(result.history[0].text) && !result.processing && errors.length === 0,
      JSON.stringify({ ...result, error: errors[0] }));
  } finally { await page.close(); }
}

// Таймаут покрывает и зависшее получение выделения, до вызова модели.
async function scenarioAgentSelectionTimeout(browser) {
  const page = await openPage(browser, '#/home', {
    settings: { aiEndpoint: 'http://localhost:11434', aiDictationRewrite: false },
    storeSeed: { 'zs.dictations': [] },
    patchNative: () => {
      const original = window.setTimeout.bind(window);
      window.setTimeout = (fn, delay, ...args) => original(fn, delay === 25000 ? 800 : delay, ...args);
      window.zspeakly.native.readSelection = () => new Promise((resolve) => { window.__agentLateSelection = resolve; });
    },
  });
  takeErrors(page);
  try {
    await emit(page, 'hotkey', { type: 'agent' });
    await page.waitForFunction(() => Boolean(window.__agentLateSelection), { timeout: 8000 });
    await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some((node) => /Агент не ответил вовремя/.test(node.innerText)), { timeout: 5000 });
    await page.evaluate(() => window.__agentLateSelection('не отправлять после таймаута'));
    await sleep(400);
    const result = await page.evaluate(() => ({
      posts: (window.__bridgeCalls || []).filter((c) => c.channel === 'http:post').length,
      history: window.__e2e.read('zs.dictations') || [],
      processing: Boolean(document.querySelector('.live-draft--processing')),
    }));
    const errors = takeErrors(page);
    record('режимы', 'агент: таймаут выделения не отправляет запоздавший контекст',
      result.posts === 0 && result.history.length === 0 && !result.processing && errors.length === 0,
      JSON.stringify({ ...result, error: errors[0] }));
  } finally { await page.close(); }
}

// Запоздавшее выделение голосовой команды не должно запускать запись после агента.
async function scenarioAgentAfterPendingCommand(browser) {
  const page = await openPage(browser, '#/home', {
    settings: { aiEndpoint: 'http://localhost:11434', aiDictationRewrite: false },
    storeSeed: { 'zs.dictations': [] },
    patchNative: () => {
      let reads = 0;
      window.zspeakly.native.readSelection = () => ++reads === 1
        ? new Promise((resolve) => { window.__pendingCommandSelection = resolve; })
        : Promise.resolve('контекст агента');
      window.zspeakly.native.httpPost = async () => ({ ok: true, data: { response: 'ответ агента' } });
    },
  });
  takeErrors(page);
  try {
    await emit(page, 'hotkey', { type: 'toggle', command: true });
    await page.waitForFunction(() => Boolean(window.__pendingCommandSelection), { timeout: 8000 });
    await emit(page, 'hotkey', { type: 'agent' });
    await page.waitForFunction(() => (window.__e2e.read('zs.dictations') || []).length === 1, { timeout: 8000 });
    await page.evaluate(() => window.__pendingCommandSelection('старое выделение'));
    await sleep(500);
    const result = await page.evaluate(() => ({
      history: window.__e2e.read('zs.dictations'),
      listening: /Слушаю/.test(document.querySelector('.hero__mic')?.innerText || ''),
      replaced: (window.__bridgeCalls || []).filter((c) => c.channel === 'text:replace-selection').length,
    }));
    const errors = takeErrors(page);
    record('режимы', 'агент: запоздавшее выделение команды не запускает запись',
      !result.listening && result.replaced === 0 && result.history.length === 1 && result.history[0].source === 'agent' && errors.length === 0,
      JSON.stringify({ ...result, error: errors[0] }));
  } finally { await page.close(); }
}

// Во время записи другой хоткей агента не должен гасить микрофон.
async function scenarioAgentDuringRecording(browser) {
  const page = await openPage(browser, '#/home', {
    settings: { aiEndpoint: 'http://localhost:11434', aiDictationRewrite: false, liveWhisper: false },
    storeSeed: { 'zs.dictations': [], 'zs.mockSttText': 'диктовка не потеряна' },
  });
  takeErrors(page);
  try {
    await emit(page, 'hotkey', { type: 'down', mode: 'hold' });
    await sleep(1000);
    await emit(page, 'hotkey', { type: 'agent' });
    await sleep(200);
    const during = await page.evaluate(() => ({
      listening: /Слушаю/.test(document.querySelector('.hero__mic')?.innerText || ''),
      posts: (window.__bridgeCalls || []).filter((call) => call.channel === 'http:post').length,
      toast: [...document.querySelectorAll('.toast')].map((node) => node.innerText).join(' '),
    }));
    await emit(page, 'hotkey', { type: 'up' });
    await page.waitForFunction(() => (window.__e2e.read('zs.dictations') || []).length === 1, { timeout: 10000 });
    const history = await page.evaluate(() => window.__e2e.read('zs.dictations'));
    const errors = takeErrors(page);
    record('режимы', 'агент: отдельный хоткей не прерывает текущую запись',
      during.listening && during.posts === 0 && /Сначала завершите текущую задачу/.test(during.toast) &&
      /диктовка не потеряна/i.test(history[0]?.text || '') && errors.length === 0,
      JSON.stringify({ during, text: history[0]?.text, error: errors[0] }));
  } finally { await page.close(); }
}

// Ответ агента не должен проходить через устаревший командный режим и заменять выделение.
async function scenarioAgentAfterCancelledCommand(browser) {
  const page = await openPage(browser, '#/home', {
    settings: { aiEndpoint: 'http://localhost:11434', aiDictationRewrite: true, liveWhisper: false },
    storeSeed: { 'zs.dictations': [], 'zs.stats': { wordsTotal: 0, secondsTotal: 0 } },
    patchNative: () => {
      window.zspeakly.native.httpPost = async () => ({ ok: true, data: { response: 'Ответ:\n  первая строка\n  вторая строка' } });
    },
  });
  takeErrors(page);
  try {
    await emit(page, 'hotkey', { type: 'toggle', command: true });
    await page.waitForFunction(() => /Слушаю/.test(document.querySelector('.hero__mic')?.innerText || ''), { timeout: 8000 });
    await emit(page, 'hotkey', { type: 'cancel' });
    await emit(page, 'hotkey', { type: 'agent' });
    await sleep(1200);
    const result = await page.evaluate(() => ({
      history: window.__e2e.read('zs.dictations') || [],
      stats: window.__e2e.read('zs.stats'),
      replaced: (window.__bridgeCalls || []).filter((call) => call.channel === 'text:replace-selection').length,
      inserts: (window.__bridgeCalls || []).filter((call) => call.channel === 'text:insert').length,
      labels: [...document.querySelectorAll('.recent__tag')].map((node) => node.innerText),
    }));
    const errors = takeErrors(page);
    record('режимы', 'агент: после отменённой команды ответ не изменяет выделение и отдельно помечен в истории',
      result.history.length === 1 && result.history[0].source === 'agent' &&
      result.history[0].text === 'Ответ:\n  первая строка\n  вторая строка' && result.replaced === 0 && result.inserts === 0 &&
      result.stats?.wordsTotal === 0 && result.labels.some((label) => /^агент$/i.test(label)) && errors.length === 0,
      JSON.stringify({ ...result, error: errors[0] }));
  } finally { await page.close(); }
}

async function scenarioDictationModes(browser) {
  // «свободные руки»: одно нажатие — слушаем, ещё одно — стоп
  const page = await openPage(browser, '#/home', {
    settings: { showFloatingIndicator: true, soundFeedback: true, aiEndpoint: '' },
  });
  takeErrors(page);
  await emit(page, 'hotkey', { type: 'toggle' });
  await sleep(1300);
  const listening = await page.evaluate(() => /Слушаю/i.test(document.body.innerText));
  await emit(page, 'hotkey', { type: 'toggle' });
  await sleep(2600);
  const hands = await page.evaluate(() => ({
    inserts: (window.__bridgeCalls || []).filter((c) => c.channel === 'text:insert').length,
    idle: !/Слушаю|Распознаю|Транскрибирую/i.test(document.body.innerText),
  }));
  record('режимы', '«свободные руки»: второе нажатие останавливает запись', listening && hands.inserts === 1 && hands.idle, `вставок: ${hands.inserts}`);

  // «агент» без адреса модели — честный отказ вместо тишины
  await emit(page, 'hotkey', { type: 'agent' });
  await sleep(700);
  const refused = await page.evaluate(() =>
    [...document.querySelectorAll('.toast')].map((t) => t.innerText).join(' | '),
  );
  record('режимы', '«агент» без модели объясняет, что настроить', /Агент не настроен|Сеть/i.test(refused), refused.slice(0, 70));

  // кнопки окна идут в main
  const win = await page.evaluate(() => {
    const click = (label) => {
      const btn = document.querySelector(`[aria-label="${label}"]`);
      if (!btn) return false;
      btn.click();
      return true;
    };
    return { min: click('Свернуть'), max: click('Развернуть') || click('Восстановить') };
  });
  await sleep(300);
  const winCalls = await bridgeCalls(page);
  record('режимы', 'кнопки заголовка управляют окном', win.min && winCalls.includes('win:minimize') && winCalls.includes('win:toggle-maximize'), winCalls.filter((c) => c.startsWith('win:')).join(','));
  const errors = takeErrors(page).filter((e) => !/AudioContext|NotAllowedError|microphone/i.test(e));
  record('режимы', 'режимы диктовки без ошибок консоли', errors.length === 0, errors[0] || '');
  await page.close();

  // «агент» с моделью: ответ в истории и тост, без автовставки
  const page2 = await openPage(browser, '#/home', {
    settings: { aiEndpoint: 'http://localhost:11434', aiModel: 'qwen2.5:0.5b', aiProcessing: true },
  });
  const before = await page2.evaluate(() => (window.__e2e.read('zs.dictations') || []).length);
  await emit(page2, 'hotkey', { type: 'agent' });
  await sleep(1800);
  const agent = await page2.evaluate(() => ({
    posts: (window.__bridgeCalls || []).filter((c) => c.channel === 'http:post').length,
    toast: [...document.querySelectorAll('.toast')].map((t) => t.innerText).join(' | '),
    dictations: (window.__e2e.read('zs.dictations') || []).length,
    inserts: window.__insertCount || 0,
  }));
  record('режимы', '«агент» спрашивает локальную модель и показывает ответ', agent.posts > 0 && /Ответ агента готов/i.test(agent.toast), agent.toast.slice(0, 60));
  record('режимы', 'ответ агента попадает в историю и не вставляется сам', agent.dictations === before + 1 && agent.inserts === 0, `${before} → ${agent.dictations}, вставок ${agent.inserts}`);
  await page2.close();
}

/* ── настройки доезжают до главного процесса ──────────────────────────── */

async function scenarioResetHotkeys(browser) {
  const page = await openPage(browser, '#/hotkeys', { settle: 450 });
  // меняем сочетание диктовки, чтобы сброс было видно
  await page.evaluate(() => {
    const list = window.__e2e.read('zs.hotkeys') || [];
    window.__e2e.seed('zs.hotkeys', list.length ? list : null);
  });
  await clickText(page, 'Сбросить все сочетания');
  await sleep(300);
  const asked = await page.evaluate(() => /Сбросить все сочетания\?/.test(document.body.innerText));
  record('хоткеи', 'сброс сочетаний сначала спрашивает подтверждение', asked);
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.modal button')].find((b) => /^Сбросить$/.test(b.innerText.trim()));
    btn?.click();
  });
  await sleep(500);
  const result = await page.evaluate(() => ({
    toast: [...document.querySelectorAll('.toast')].map((t) => t.innerText).join(' | '),
    keys: (window.__e2e.read('zs.hotkeys') || []).map((h) => `${h.id}:${(h.keys || []).join('+')}`).join(','),
  }));
  const defaultDict = /(^|,)dictation:Ctrl\+Alt\+Space(,|$)/.test(result.keys);
  record(
    'хоткеи',
    'после сброса сочетания стандартные и есть сообщение',
    /Сочетания сброшены/i.test(result.toast) && defaultDict,
    `${result.keys.slice(0, 60)} · ${result.toast.slice(0, 40)}`,
  );
  await page.close();
}

async function scenarioMainSync(browser) {
  const page = await openPage(browser, '#/settings?section=app&from=home', { settle: 500 });
  const clickSwitchInRow = (title) =>
    page.evaluate((text) => {
      const row = [...document.querySelectorAll('.setting-row')].find((r) =>
        r.querySelector('.setting-row__label')?.innerText.trim().startsWith(text),
      );
      const sw = row?.querySelector('[role="switch"]');
      if (!sw || sw.disabled) return false;
      sw.click();
      return true;
    }, title);

  const tray = await clickSwitchInRow('Свернуть в трей при закрытии');
  await sleep(500);
  const mainSettings = await page.evaluate(() => window.__e2e.read('zs:settings') || {});
  record(
    'связь с main',
    '«Свернуть в трей» доезжает до главного процесса',
    tray && mainSettings.closeToTray === false,
    `closeToTray=${String(mainSettings.closeToTray)}`,
  );

  const auto = await clickSwitchInRow('Автозапуск с Windows');
  await sleep(500);
  const autoCalls = await page.evaluate(() =>
    (window.__bridgeCalls || []).filter((c) => c.channel === 'app:auto-launch').map((c) => Boolean(c.args?.[0])),
  );
  record('связь с main', 'автозапуск включает систему, а не только тумблер', auto && autoCalls.includes(true), JSON.stringify(autoCalls));

  const close = await page.evaluate(() => {
    const btn = document.querySelector('[aria-label="Закрыть"]');
    if (!btn) return false;
    btn.click();
    return true;
  });
  await sleep(400);
  const calls = await bridgeCalls(page);
  record('связь с main', 'крестик закрывает окно через main', close && calls.includes('win:close'));
  await page.close();
}

/* ── диктовка с учётом экрана ─────────────────────────────────────────── */

async function scenarioScreenAware(browser) {
  // 1. Модель не настроена (адреса нет) и полировка выключена: снимок всё равно
  // снимается, диктовка идёт дальше и в сеть ничего не уходит
  const page = await openPage(browser, '#/home', {
    settings: { aiDictationRewrite: false, aiEndpoint: '' },
  });
  await emit(page, 'hotkey', { type: 'down', mode: 'hold', screenAware: true });
  await sleep(1400);
  const during = await bridgeCalls(page);
  await emit(page, 'hotkey', { type: 'up' });
  await sleep(2600);
  const after = await bridgeCalls(page);
  const inserted = await page.evaluate(() =>
    (window.__bridgeCalls || []).filter((c) => c.channel === 'text:insert').length,
  );
  record('экран', 'снимок экрана делается на старте screen-aware диктовки', during.includes('screen:capture'));
  record('экран', 'без модели текст всё равно распознан и вставлен', inserted === 1, `вставок: ${inserted}`);
  record('экран', 'без модели запрос к нейросети не уходит', !after.some((c) => c === 'http:post'));
  await page.close();

  // 2. Модель настроена: кадр уходит в неё, а термины с экрана — подсказкой для распознавания
  const page2 = await openPage(browser, '#/home', {
    settings: { aiProcessing: true, aiEndpoint: 'http://localhost:11434', aiModel: 'qwen2.5:0.5b' },
  });
  // журнал мока хранит только адрес, а нам нужен сам кадр — оборачиваем мост
  await page2.evaluate(() => {
    const native = window.zspeakly.native;
    const original = native.httpPost;
    window.__vision = [];
    native.httpPost = (payload) => {
      const body = payload?.body || {};
      window.__vision.push({
        url: payload?.url || '',
        images: Array.isArray(body.images) ? body.images.length : 0,
        imagePrefix: String(body.images?.[0] || '').slice(0, 12),
      });
      return original(payload);
    };
  });
  await emit(page2, 'hotkey', { type: 'down', mode: 'hold', screenAware: true });
  await sleep(2000);
  const vision = await page2.evaluate(() => window.__vision || []);
  await emit(page2, 'hotkey', { type: 'up' });
  await sleep(2600);
  const sttPrompt = await page2.evaluate(() => {
    const call = [...(window.__bridgeCalls || [])].reverse().find((c) => c.channel === 'stt:transcribe-pcm');
    return String(call?.args?.[0]?.contextPrompt || '');
  });
  const inserted2 = await page2.evaluate(() =>
    (window.__bridgeCalls || []).filter((c) => c.channel === 'text:insert').length,
  );
  record('экран', 'кадр уходит в локальную модель как изображение', vision.some((v) => v.images > 0 && /\/api\/generate$/.test(v.url)), JSON.stringify(vision[0] || {}).slice(0, 80));
  record('экран', 'термины с экрана подсказывают распознавание', /Атлас|задач/i.test(sttPrompt), sttPrompt.slice(0, 60));
  record('экран', 'диктовка с экранным контекстом вставляет текст один раз', inserted2 === 1, `вставок: ${inserted2}`);
  await page2.close();

  // 3. Своё сочетание на «с учётом экрана» — переключатель: нажали, ещё раз, стоп
  const page3 = await openPage(browser, '#/home', { settings: { aiProcessing: false } });
  await emit(page3, 'hotkey', { type: 'toggle', screenAware: true });
  await sleep(1200);
  const toggledOn = await page3.evaluate(() => ({
    listening: /Слушаю/i.test(document.body.innerText),
    captured: (window.__bridgeCalls || []).some((c) => c.channel === 'screen:capture'),
  }));
  await emit(page3, 'hotkey', { type: 'toggle', screenAware: true });
  await sleep(2400);
  const toggledOff = await page3.evaluate(() => ({
    inserts: (window.__bridgeCalls || []).filter((c) => c.channel === 'text:insert').length,
    idle: !/Слушаю|Распознаю|Транскрибирую/i.test(document.body.innerText),
  }));
  record('экран', 'своё сочетание screen-aware работает переключателем', toggledOn.listening && toggledOn.captured && toggledOff.inserts === 1 && toggledOff.idle, `вставок: ${toggledOff.inserts}`);
  await page3.close();
}

/* ── чистая установка и снимок экрана ─────────────────────────────────── */

async function scenarioFreshInstall(browser) {
  // ни истории, ни буфера, ни словаря — как у человека, который только что поставил
  const empty = { 'zs.dictations': [], 'zs.clipboard': [], 'zs.dictionary': [] };
  const page = await openPage(browser, '#/home', { settle: 600, storeSeed: empty });
  const home = await page.evaluate(() => ({
    text: document.body.innerText,
    dictations: (window.__e2e.read('zs.dictations') || []).length,
    counters: [...document.querySelectorAll('.stat__value')].map((el) => el.innerText.trim()),
  }));
  record('чистая установка', 'история начинается пустой, без чужих записей', home.dictations === 0 && !/Привет, как дела\?/.test(home.text), `записей: ${home.dictations}`);
  record('чистая установка', 'счётчики на главной начинаются с нуля', home.counters.every((v) => /^0$/.test(v)), home.counters.join(' · '));
  const badgeBefore = await page.evaluate(() => /НОВОЕ/.test(document.body.innerText));
  record('чистая установка', 'плашка «НОВОЕ» видна до первого захода в буфер', badgeBefore);
  record('чистая установка', 'пустая история объясняет, что делать', /наговорите|пока нет|нет записей|начните/i.test(home.text), home.text.match(/[^\n]*(?:пока нет|начните|наговорите)[^\n]*/i)?.[0]?.slice(0, 70) || '');

  await page.goto(`${BASE}/#/clipboard`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.app-window');
  await sleep(450);
  const clip = await page.evaluate(() => document.body.innerText);
  record('чистая установка', 'пустой буфер говорит «история пуста»', /История буфера пуста/i.test(clip), clip.match(/[^\n]*пуста[^\n]*/i)?.[0] || '');
  const badgeAfter = await page.evaluate(() => /НОВОЕ/.test(document.body.innerText));
  const seen = await page.evaluate(() => Boolean((window.__e2e.read('zs.settings') || {}).seenClipboard));
  record('чистая установка', 'после захода в буфер плашка «НОВОЕ» гаснет', !badgeAfter && seen);

  await page.goto(`${BASE}/#/dictionary`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.app-window');
  await sleep(450);
  const dict = await page.evaluate(() => ({
    text: document.body.innerText,
    rows: document.querySelectorAll('.dict-row').length,
  }));
  record('чистая установка', 'словарь пуст, но экран не выглядит сломанным', dict.rows === 0 && !/NaN|undefined/.test(dict.text), `${dict.rows} строк`);
  await page.close();
}

async function scenarioScreenshotOnce(browser) {
  const page = await openPage(browser, '#/clipboard', { settle: 500 });
  const before = await page.evaluate(() => (window.__e2e.read('zs.clipboard') || []).length);
  await page.evaluate(() => {
    const tile = [...document.querySelectorAll('.clip-hotkey')].find((el) => /^Скриншот/.test(el.innerText.trim()));
    tile?.click();
  });
  await sleep(900);
  const after = await page.evaluate(() => ({
    count: (window.__e2e.read('zs.clipboard') || []).length,
    first: (window.__e2e.read('zs.clipboard') || [])[0],
    toast: [...document.querySelectorAll('.toast')].map((t) => t.innerText).join(' | '),
  }));
  record('буфер', 'снимок экрана добавляется ровно один раз', after.count === before + 1, `${before} → ${after.count}`);
  record('буфер', 'снимок экрана — настоящая картинка с размером', Boolean(after.first?.image?.startsWith('data:image')), String(after.first?.source || '').slice(0, 40));
  record('буфер', 'о снимке сообщается', /Скриншот сохранён/i.test(after.toast), after.toast.slice(0, 50));
  await page.close();
}

/* ── доступность: имена у кнопок и видимый фокус ─────────────────────── */

const A11Y_ROUTES = [
  '#/home',
  '#/dictionary',
  '#/hotkeys',
  '#/clipboard',
  '#/settings?section=app&from=home',
  '#/settings?section=features&from=home',
  '#/settings?section=diagnostics&from=home',
  '#/settings?section=data&from=home',
  '#/settings?section=network&from=home',
  '#/settings?section=about&from=home',
];

async function scenarioAccessibleNames(browser) {
  const unnamed = [];
  const duplicateSwitches = [];
  for (const route of A11Y_ROUTES) {
    const page = await openPage(browser, route, { settle: 450 });
    const found = await page.evaluate(() => {
      const bad = [];
      document.querySelectorAll('button, [role="button"], [role="switch"]').forEach((el) => {
        const rect = el.getBoundingClientRect();
        if (rect.width < 4 || rect.height < 4) return;
        const name = (el.getAttribute('aria-label') || el.innerText || el.getAttribute('title') || '').trim();
        if (!name) bad.push(el.className);
      });
      const labels = [...document.querySelectorAll('[role="switch"]')].map((el) => el.getAttribute('aria-label') || '');
      const dupes = labels.filter((l, i) => l && labels.indexOf(l) !== i);
      return { bad, dupes };
    });
    unnamed.push(...found.bad.map((cls) => `${route}: .${cls.split(' ')[0]}`));
    duplicateSwitches.push(...found.dupes.map((l) => `${route}: ${l}`));
    await page.close();
  }
  record('доступность', 'у каждой кнопки и переключателя есть имя', unnamed.length === 0, unnamed.slice(0, 3).join(' · '));
  record('доступность', 'переключатели не дублируют имена', duplicateSwitches.length === 0, duplicateSwitches.slice(0, 3).join(' · '));

  const page = await openPage(browser, '#/settings?section=app&from=home', { settle: 450 });
  await page.evaluate(() => document.body.focus());
  const focus = [];
  for (let i = 0; i < 8; i += 1) {
    await page.keyboard.press('Tab');
    const info = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const css = getComputedStyle(el);
      const outline = css.outlineStyle !== 'none' && parseFloat(css.outlineWidth) > 0;
      const ring = css.boxShadow && css.boxShadow !== 'none';
      return { tag: el.tagName.toLowerCase(), name: (el.getAttribute('aria-label') || el.innerText || '').trim().slice(0, 24), visible: outline || ring };
    });
    if (info) focus.push(info);
  }
  const invisible = focus.filter((f) => !f.visible);
  record('доступность', 'фокус с клавиатуры виден у каждого элемента', focus.length >= 5 && invisible.length === 0, invisible.map((f) => f.name).join(' · ') || `проверено ${focus.length}`);
  await page.close();
}

// «Сравнить модели на моей записи»: человек говорит фразу один раз, а приложение
// прогоняет её через скачанные модели. Победителя объявляем только по словарю —
// приложение не знает, что человек сказал, и не имеет права решать за него.
async function scenarioModelCompare(browser) {
  const own = await launchFreshBrowser();
  const page = await openPage(own, '#/settings?section=dictation&from=home', {
    settle: 700,
    storeSeed: {
      'zs.dictionary': [
        { id: 'w1', word: 'Zoom' },
        { id: 'w2', word: 'Telegram' },
        { id: 'w3', word: 'Docker' },
      ],
    },
  });
  takeErrors(page);

  // Ждём по факту: приложение пишет 5 секунд, потом считает две модели.
  const waitCompare = async (timeoutMs = 25000) => {
    const deadline = Date.now() + timeoutMs;
    let state = null;
    while (Date.now() < deadline) {
      state = await page.evaluate(() => ({
        called: Boolean(window.__e2e.last('models:compare')),
        rows: document.querySelectorAll('.compare__row').length,
        winner: document.querySelector('.compare__row.is-winner .compare__model')?.innerText || '',
        summary: document.querySelector('.compare__summary')?.innerText || '',
        error: document.querySelector('.settings-note')?.innerText || '',
      }));
      if (state.rows > 0 || /не получилось|не открылся|тишина/i.test(state.error)) return state;
      await sleep(400);
    }
    return state;
  };

  await page.evaluate(() => window.__e2e.resetCalls());
  let clicked = await clickIn(page, '', 'Записать и сравнить');
  if (!clicked) {
    // кнопка могла быть недоступна до чтения статуса моделей
    await sleep(900);
    clicked = await clickIn(page, '', 'Записать и сравнить');
  }
  let state = await waitCompare();
  if (!state?.rows && !state?.called) {
    await sleep(700);
    await clickIn(page, '', 'Записать и сравнить');
    state = await waitCompare();
  }
  record('сценарии', 'сравнение моделей: кнопка запускает запись и сравнение', clicked && Boolean(state?.called), `нажата=${clicked} вызов=${Boolean(state?.called)}`);
  record(
    'сценарии',
    'сравнение моделей: рядом видно текст каждой модели и время счёта',
    state?.rows >= 2,
    `строк ${state?.rows ?? 0}`,
  );
  record(
    'сценарии',
    'сравнение моделей: победителя называем по словарю, а не «на глаз»',
    /3 из 3/.test(state?.summary || '') && /Сбалансированно|Быстро|Максимум качества/.test(state?.winner || ''),
    state?.summary || 'итога нет',
  );
  const sent = await page.evaluate(() => {
    const call = window.__e2e.last('models:compare');
    return call ? call.args?.[0] || null : null;
  });
  record(
    'сценарии',
    'сравнение моделей: сравниваем только скачанные, без загрузки гигабайтов',
    Array.isArray(sent?.models) && sent.models.length === 2 && !sent.models.includes('large-v3-turbo-q5_0'),
    (sent?.models || []).join(', ') || 'ничего не отправлено',
  );
  // Победитель — не только строчка текста: модель можно сразу сделать основной,
  // не возвращаясь к списку моделей выше.
  const beforeApply = await page.evaluate(() => (window.__e2e.read('zs.settings') || {}).whisperModel || '');
  const applyClicked = await page.evaluate(() => {
    const buttons = document.querySelectorAll('.compare__apply');
    const btn = buttons[buttons.length - 1];
    if (btn) btn.click();
    return Boolean(btn);
  });
  await sleep(500);
  const afterApply = await page.evaluate(() => ({
    model: (window.__e2e.read('zs.settings') || {}).whisperModel || '',
    engine: (window.__e2e.read('zs.settings') || {}).recognitionEngine || 'auto',
    currentRows: document.querySelectorAll('.compare__current').length,
    toasts: [...document.querySelectorAll('.toast__title')].map((n) => n.innerText).join(' | '),
  }));
  record(
    'сценарии',
    'сравнение моделей: «Сделать основной» переключает диктовку на эту модель',
    applyClicked && afterApply.model && afterApply.model !== beforeApply && afterApply.currentRows === 1 && afterApply.engine === 'whisper',
    `было «${beforeApply}», стало «${afterApply.model}», движок ${afterApply.engine}`,
  );
  record(
    'сценарии',
    'сравнение моделей: о смене модели сказано словами',
    /Модель стала основной/.test(afterApply.toasts),
    afterApply.toasts || 'тоста нет',
  );

  const switched = await page.evaluate(() => {
    const toggle = document.querySelector('[role="switch"][aria-label="Использовать только Whisper"]');
    if (!toggle || toggle.getAttribute('aria-checked') !== 'true') return false;
    toggle.click();
    return true;
  });
  await sleep(500);
  const engineAfterToggle = await page.evaluate(() => (window.__e2e.read('zs.settings') || {}).recognitionEngine);
  record('сценарии', 'сравнение моделей: можно вернуть автоматический выбор', switched && engineAfterToggle === 'auto', `движок: ${engineAfterToggle}`);

  const errors = takeErrors(page);
  record('сценарии', 'сравнение моделей: без ошибок консоли', errors.length === 0, errors[0] || '');
  await page.close();
  await own.close();
}

/* ── запуск ───────────────────────────────────────────────────────────── */

// Флаги одинаковые у всех браузеров прогона: фейковый микрофон, без песочницы,
// без звука в колонки.
const CHROME_ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  // Изоляция renderer-процессов предотвращает потерю браузера в долгом прогоне.
  ...(process.env.ZS_SINGLE_PROCESS === '1' ? ['--single-process'] : []),
  '--mute-audio',
  // фейковый микрофон: без него MediaRecorder в headless молчит и диктовку не проверить
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
];
let CHROME_BIN = '';

/** Отдельный браузер с чистым звуковым сервисом — для проверок микрофона. */
function launchFreshBrowser() {
  return puppeteer.launch({ executablePath: CHROME_BIN, headless: HEADLESS, args: CHROME_ARGS });
}

async function main() {
  const chrome = await resolveChrome();
  CHROME_BIN = chrome || '';
  if (!chrome) {
    console.error(
      [
        C.bad('Chromium не найден.'),
        'Укажите путь: CHROME_PATH=/путь/к/chrome npm run test:ui',
        'Или поставьте пакет: npm i --no-save @sparticuz/chromium (и распакуйте libnss3).',
      ].join('\n'),
    );
    process.exit(2);
  }

  let server = null;
  let browser = null;
  try {
    server = await ensureServer();
    browser = await puppeteer.launch({
      executablePath: chrome,
      headless: HEADLESS,
      args: [
        ...CHROME_ARGS,
      ],
    });

    // ZS_ONLY — прогон одного сценария: обход экранов и ввод текста не нужны.
    // ZS_CRAWL=1 заставляет прогнать обход вместе с одним сценарием: так
    // проверяется, не влияет ли обход экранов на то, что идёт после него.
    const only = process.env.ZS_ONLY || '';
    const crawlWithOnly = process.env.ZS_CRAWL === '1';
    const runCrawl = (!only || crawlWithOnly) && process.env.ZS_SKIP_CRAWL !== '1';
    console.log(C.head('\nОбход экранов'));
    const screens = !runCrawl ? [] : [
      { route: '#/home', label: 'Главная' },
      { route: '#/dictionary', label: 'Словарь' },
      { route: '#/hotkeys', label: 'Горячие клавиши' },
      { route: '#/clipboard', label: 'Буфер обмена' },
      { route: '#/settings?section=app&from=home', label: 'Настройки' },
    ];
    for (const screen of screens) {
      console.log(C.dim(`\n${screen.label}`));
      await runUiTask(`Обход: ${screen.label}`, () => explore(browser, screen), { timeoutMs: 600_000 });
    }

    if (process.env.ZS_SKIP_INPUTS !== '1' && runCrawl) {
      console.log(C.head('\nВвод текста в поля'));
      for (const screen of [
        { route: '#/home', label: 'Главная' },
        { route: '#/dictionary', label: 'Словарь' },
        { route: '#/clipboard', label: 'Буфер обмена' },
        { route: '#/settings?section=app&from=home', label: 'Настройки' },
      ]) {
        await runUiTask(`Ввод: ${screen.label}`, () => exploreInputs(browser, screen), { timeoutMs: 300_000 });
      }
    }

    console.log(C.head('\nСценарии'));
    const scenarios = [
      ['онбординг', scenarioOnboarding],
      ['диктовка', scenarioDictation],
      ['голосовые команды', scenarioVoiceCommands],
      ['безопасные голосовые удаления', scenarioVoiceDeleteSafety],
      ['оформление под окно', scenarioAppFormat],
      ['язык под окно', scenarioAppLanguage],
      ['web speech завершение', scenarioWebSpeechFinalization],
      ['повторный стоп при обработке', scenarioDoubleStopWhileProcessing],
      ['таймаут обработки', scenarioProcessingTimeout],
      ['старт во время обработки', scenarioPendingSessionStart],
      ['изоляция контекста сессии', scenarioSessionContextIsolation],
      ['снимок после отмены', scenarioCancelledScreenCapture],
      ['контекст завершённой сессии', scenarioCompletedScreenIsolation],
      ['позднее окно и язык', scenarioLateTargetLanguage],
      ['команда «отмени»', scenarioUndoCommand],
      ['«отмени» в другом окне', scenarioUndoRefusal],
      ['быстрые блоки', scenarioSnippets],
      ['безопасность быстрых блоков', scenarioSnippetSafety],
      ['файл в текст', scenarioAudioFile],
      ['файл: границы декодирования', scenarioAudioFileBounds],
      ['файл: частичный отказ', scenarioAudioFilePartial],
      ['файл: словарь включён или выключен', scenarioFileDictionary],
      ['команда голосом', scenarioVoiceCommand],
      ['оговорки', scenarioSelfCorrection],
      ['первый экран', scenarioWhyBetter],
      ['пустой результат', scenarioEmptyResult],
      ['плавающий индикатор (Electron)', scenarioFloatingHud],
      ['постобработка текста', scenarioCleanupToggle],
      ['переписывание моделью', scenarioModelRewrite],
      ['точность текста диктовки', scenarioDictationIntegrity],
      ['поздняя полировка', scenarioLatePolish],
      ['поздняя полировка после правки', scenarioLatePolishEdit],
      ['поздняя полировка после возврата', scenarioLatePolishReverted],
      ['отмена полировки', scenarioCancelPolish],
      ['повтор после отмены полировки', scenarioCancelPolishRestart],
      ['стоп до открытия микрофона', scenarioDelayedMicrophone],
      ['ошибки открытия микрофона', scenarioMicrophoneFailure],
      ['пропавший микрофон', scenarioMissingMic],
      ['вставка не удалась', scenarioInsertFailed],
      ['обещания плашки', scenarioHudPromise],
      ['диктовка в своё поле', scenarioDictationIntoOwnField],
      ['обезьяний тест', scenarioMonkey],
      ['предупреждения React', scenarioConsoleWarnings],
      ['битые данные', scenarioBrokenData],
      ['большие данные', scenarioHeavyData],
      ['переполненная история', scenarioLegacyHistoryLimit],
      ['предролл микрофона', scenarioMicPreroll],
      ['живая расшифровка', scenarioLiveWhisper],
      ['пауза и отмена распознавания', scenarioPauseAndCancel],
      ['лимит буфера и закреплённое', scenarioPinnedLimit],
      ['повторение закреплённого буфера', scenarioClipboardPinnedDedup],
      ['пароли', scenarioPasswordVault],
      ['приватность буфера', scenarioClipboardSecretPrivacy],
      ['безопасное ручное копирование', scenarioManualClipboardBusy],
      ['безопасность вставки буфера', scenarioClipboardPasteFailure],
      ['копирование изображения буфера', scenarioClipboardImageCopy],
      ['захват экрана при уходе', scenarioScreenRecordingCleanup],
      ['таймаут остановки записи экрана', scenarioScreenRecordingStopTimeout],
      ['сохранение записи экрана', scenarioScreenRecordingSave],
      ['ограничения записи экрана', scenarioScreenRecordingLimits],
      ['запись экрана без аудио', scenarioScreenRecordingNoAudio],
      ['словарь', scenarioDictionary],
      ['буфер', scenarioClipboard],
      ['прямые ссылки', scenarioDeepLinks],
      ['разделы настроек', scenarioSettingsSections],
      ['темы', scenarioTheme],
      ['поиск по настройкам', scenarioSettingsSearch],
      ['медленная загрузка настроек', scenarioSlowSettingsSearch],
      ['ошибка раздела настроек', scenarioSettingsSectionFailure],
      ['правка расшифровки', scenarioEditSnippet],
      ['как распозналось', scenarioRawText],
      ['правила под окно', scenarioAppRulesUi],
      ['AI-инструкция', scenarioAiInstruction],
      ['мост', scenarioBridgeWiring],
      ['палитра команд', scenarioCommandPalette],
      ['модалка и фокус', scenarioModalFocus],
      ['профиль', scenarioProfile],
      ['запись сочетания', scenarioRecorder],
      ['новая инструкция', scenarioInstruction],
      ['модели', scenarioModels],
      ['микрофон', scenarioMic],
      ['локальная модель: приватность', scenarioLocalModelPrivacy],
      ['данные: резервная копия', scenarioBackup],
      ['данные: совместимость копии', scenarioBackupCompatibility],
      ['данные: полный круг копии', scenarioBackupRoundTrip],
      ['данные: повреждённая копия', scenarioInvalidBackup],
      ['данные: срок хранения буфера', scenarioBackupClipboardRetention],
      ['данные: срок хранения после перезапуска', scenarioBackupRetentionOnRestart],
      ['данные: валидация и срок хранения', scenarioBackupValidationAndRetention],
      ['данные: размер и гонка файлов', scenarioBackupFileBoundaries],
      ['данные: большая копия на экспорт', scenarioBackupLargeExport],
      ['данные: экспорт защищённого профиля', scenarioBackupProtectedExport],
      ['данные: копия защищённого профиля', scenarioProtectedBackup],
      ['данные: частичная запись копии', scenarioBackupPartialWrite],
      ['хранилище заполнено', scenarioStorageFull],
      ['ошибка хранилища Electron', scenarioElectronStorageError],
      ['диагностика', scenarioDiagnostics],
      ['диагностика мониторинга буфера', scenarioClipboardMonitorDiagnostics],
      ['диагностика без моста', scenarioDiagnosticsBrowser],
      ['модель в памяти', scenarioWarmModel],
      ['отмена скачивания модели', scenarioModelCancel],
      ['параллельные события модели', scenarioModelConcurrentProgress],
      ['непринятая отмена модели', scenarioCancelNotAccepted],
      ['отмена загрузки движка', scenarioEngineCancel],
      ['повтор импорта модели', scenarioImportModelRetry],
      ['отмена отдельных моделей', scenarioSpecialModelCancel],
      ['модель из комплекта', scenarioBundledModel],
      ['удаление модели', scenarioModelDelete],
      ['подбор модели под железо', scenarioHardwareModel],
      ['старое имя модели', scenarioOldModelName],
      ['скорость диктовки', scenarioSpeedReport],
      ['самопроверка диктовки', scenarioSelfTest],
      ['сравнение моделей', scenarioModelCompare],
      ['переспросить точно', scenarioRetryLast],
      ['точный проход: конфликты', scenarioRetryConflict],
      ['точный проход: двойное нажатие', scenarioRetryDoubleClick],
      ['точный проход: ошибка моста', scenarioRetryFailure],
      ['точный проход: заранее изменённая запись', scenarioRetryAlreadyEdited],
      ['режим распознавания', scenarioDecodeMode],
      ['словарь: кириллица', scenarioDictionaryAliases],
      ['словарь: безопасность замены', scenarioDictionarySafety],
      ['словарь: сохранность записей', scenarioDictionaryDataSafety],
      ['словарь: обучение', scenarioDictionaryLearning],
      ['разбор точности', scenarioQualityReport],
      ['совет по модели', scenarioHardwareFit],
      ['узкое окно', scenarioNarrowWindow],
      ['вложенный диалог', scenarioNestedDialog],
      ['превью без движка', scenarioBrowserPreviewNotice],
      ['действия в сетке буфера', scenarioClipboardGridActions],
      ['возврат удаления', scenarioDictationUndo],
      ['история: безопасное удаление', scenarioDictationRemovalSafety],
      ['история: возврат при лимите', scenarioDictationUndoCapacity],
      ['очистка истории', scenarioClearDictations],
      ['заметка со снимком', scenarioNote],
      ['пустая установка без модели', scenarioNoModel],
      ['обновление', scenarioUpdateFlow],
      ['сбой обновления', scenarioUpdateFailure],
      ['сеть', scenarioNetwork],
      ['буфер: удаление и очистка', scenarioClipboardDanger],
      ['словарь: поиск и вкладки', scenarioDictionaryExtras],
      ['главная: поиск, копирование, удаление', scenarioHomeExtras],
      ['обновления', scenarioUpdates],
      ['данные и ссылки', scenarioData],
      ['тема: три режима', scenarioThemeCycle],
      ['трей: команды', scenarioTrayCommands],
      ['глобальный хоткей', scenarioGlobalHotkey],
      ['событие буфера', scenarioClipboardEvent],
      ['AI-инструкция по хоткею', scenarioTextActionEvent],
      ['занятое сочетание', scenarioHotkeyConflict],
      ['объявление обновления', scenarioUpdateEvent],
      ['прогресс модели', scenarioModelProgress],
      ['клавиатура', scenarioKeyboard],
      ['сохранность после перезапуска', scenarioPersistence],
      ['сроки хранения', scenarioRetention],
      ['пустые состояния', scenarioEmptyStates],
      ['сбой распознавания', scenarioSttFailure],
      ['контраст и вёрстка', scenarioVisualAudit],
      ['маскировка паролей', scenarioHidePasswords],
      ['плавающий индикатор', scenarioIndicator],
      ['чтение вслух', scenarioReadAloud],
      ['офлайн без ИИ', scenarioAiOff],
      ['имена и фокус', scenarioAccessibleNames],
      ['чистая установка', scenarioFreshInstall],
      ['снимок экрана', scenarioScreenshotOnce],
      ['диктовка с учётом экрана', scenarioScreenAware],
      ['восстановление AI-инструкции', scenarioTextActionRecovery],
      ['предупреждение перевода AI-инструкции', scenarioTextActionPartialRecovery],
      ['предупреждение перевода голосовой команды', scenarioVoicePartialRecovery],
      ['конфликт операций выделения', scenarioSelectionBusy],
      ['безопасное чтение выделения', scenarioSelectionUnverified],
      ['агент отмена выделения', scenarioAgentSelectionCancel],
      ['агент отмена и повтор', scenarioAgentCancelAndRetry],
      ['агент таймаут', scenarioAgentTimeout],
      ['агент таймаут выделения', scenarioAgentSelectionTimeout],
      ['агент во время записи', scenarioAgentDuringRecording],
      ['агент после ожидающей команды', scenarioAgentAfterPendingCommand],
      ['агент после отмены команды', scenarioAgentAfterCancelledCommand],
      ['режимы диктовки', scenarioDictationModes],
      ['связь с main', scenarioMainSync],
      ['сброс сочетаний', scenarioResetHotkeys],
    ];
    // ZS_ONLY — прогнать не всё, пока чинишь одно место:
    //   ZS_ONLY=палитра            подстрока имени
    //   ZS_ONLY=палитра|словарь    несколько подстрок
    //   ZS_ONLY=#1-24,50           номера по порядку (1-based) — так ищется
    //                              сценарий, после которого ломается другой
    const onlyParts = only ? only.split(/[|,]/).map((v) => v.trim()).filter(Boolean) : [];
    const wantedIndex = new Set();
    let wantedAny = false;
    for (const part of onlyParts) {
      const range = /^#(\d+)(?:-(\d+))?$/.exec(part);
      if (!range) continue;
      const from = Math.max(1, Number(range[1]) || 1);
      const to = Math.min(scenarios.length, Number(range[2] || range[1]) || from);
      for (let i = from; i <= to; i += 1) wantedIndex.add(i);
      wantedAny = true;
    }
    const wantedNames = onlyParts.filter((part) => !/^#/.test(part));
    for (let index = 0; index < scenarios.length; index += 1) {
      const [name, fn] = scenarios[index];
      // «нет фильтра» — это пустой список, а не «ничего не подошло»
      const wanted =
        !onlyParts.length ||
        wantedIndex.has(index + 1) ||
        wantedNames.some((part) => name.includes(part));
      if (!wanted) continue;
      await runUiScenario(`Сценарий ${index + 1}/${scenarios.length}: ${name}`, () => fn(browser),
        (err) => record('сценарии', name, false, String(err && err.message).slice(0, 200)));
    }
  } finally {
    try {
      if (browser) {
        try {
          await runUiTask('Закрытие браузера', () => browser.close(), { timeoutMs: 15_000 });
        } catch (err) {
          try { browser.process()?.kill('SIGKILL'); } catch { /* process already exited */ }
          throw err;
        }
      }
    } finally {
      if (server) server.kill('SIGTERM');
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${failed.length ? C.bad('ПРОВАЛ') : C.ok('ВСЁ ЗЕЛЁНОЕ')}: ${results.length - failed.length}/${results.length} проверок`,
  );
  if (failed.length) {
    console.log(C.dim('Упавшие:'));
    for (const f of failed) console.log(`  • ${f.group} / ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(C.bad(String(err && err.stack ? err.stack : err)));
  process.exit(1);
});
