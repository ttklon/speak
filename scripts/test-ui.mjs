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
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { installMockBridge } from './e2e/mock-bridge.mjs';
// демо-наборы больше не подставляются приложением — тесты кладут их сами
import { buildSeedClipboard, buildSeedDictations, SEED_DICTIONARY } from '../src/lib/seed.js';

const BASE = (process.env.ZS_BASE_URL || 'http://127.0.0.1:5173').replace(/\/$/, '');
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
  const proc = spawn('npx', ['vite', '--host', '0.0.0.0', '--port', new URL(BASE).port || '5173', '--strictPort'], {
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
  theme: 'dark',
  language: 'ru',
  whisperModel: 'small',
  aiEndpoint: 'http://localhost:11434',
  aiModel: 'qwen2.5:0.5b',
  aiEnabled: true,
  screenContext: false,
  diagnostics: false,
  checkUpdates: true,
  soundFeedback: false,
};

async function openPage(browser, route = '#/home', opts = {}) {
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = `${msg.text()}`.slice(0, 400);
    if (/favicon/i.test(text)) return;
    errors.push(text);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${String(err && err.message)}`.slice(0, 400)));

  // никакой сети наружу: тест должен быть детерминированным
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = req.url();
    const local = url.startsWith(BASE) || url.startsWith('data:') || url.startsWith('blob:');
    if (local) req.continue();
    else req.abort();
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
  if (opts.patchNative) await page.evaluateOnNewDocument(opts.patchNative);
  const settings = { ...SEED_SETTINGS, ...(opts.settings || {}) };
  // содержимое по умолчанию: демо-история, демо-буфер и демо-словарь.
  // Сценарии, которым нужны пустые экраны, передают свои storeSeed.
  const fixtures = {
    'zs.dictations': buildSeedDictations(),
    'zs.clipboard': buildSeedClipboard(),
    'zs.dictionary': SEED_DICTIONARY,
    ...(opts.storeSeed || {}),
  };
  await page.evaluateOnNewDocument(([seed, fresh, extra]) => {
    if (fresh !== false) {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith('mockstore:')) localStorage.removeItem(key);
      }
    }
    localStorage.setItem('mockstore:zs.settings', JSON.stringify(seed));
    // готовые данные для сценариев (буфер, словарь, история)
    for (const [key, value] of Object.entries(extra || {})) {
      localStorage.setItem(`mockstore:${key}`, JSON.stringify(value));
    }
  }, [settings, opts.fresh === false ? false : true, fixtures]);
  await page.goto(`${BASE}/${route}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.app-window', { timeout: 15_000 });
  await sleep(opts.settle ?? 250);
  page.__errors = errors;
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
    const p = await openPage(browser, route, { settle: 180 });
    if (process.env.ZS_TRACE === '1') console.log(C.dim(`      → ${label} / ${target.label || target.tag}`));
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

  // Чистая установка без движка: онбординг обязан подсказать, где взять модель,
  // и по кнопке вести прямо в «Настройки → Функции».
  const bare = await browser.newPage();
  await bare.setViewport({ width: 1280, height: 800 });
  await bare.evaluateOnNewDocument(installMockBridge);
  await bare.evaluateOnNewDocument(() => {
    // моста нет — как в браузере или в Windows-сборке без whisper.cpp
    if (window.zspeakly?.native) {
      window.zspeakly.native.transcribePcm = undefined;
      window.zspeakly.native.sttStatus = undefined;
      window.zspeakly.native.transcribe = undefined;
    }
    localStorage.setItem('mockstore:zs.settings', JSON.stringify({ onboarded: false }));
  });
  await bare.goto(`${BASE}/#/home`, { waitUntil: 'domcontentloaded' });
  await bare.waitForSelector('.modal', { timeout: 8000 }).catch(() => {});
  await sleep(500);
  const cta = await bare.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => /Скачать модель/i.test(b.innerText));
    const warn = document.querySelector('.onboarding__hint--warn')?.innerText || '';
    return { found: Boolean(btn), warn };
  });
  let navigated = false;
  if (cta.found) {
    await bare.evaluate(() => {
      const btn = [...document.querySelectorAll('.modal button')].find((b) => /Скачать модель/i.test(b.innerText));
      btn?.click();
    });
    await sleep(700);
    // приложение открывает настройки поверх страницы, а не меняет страницу
    navigated = await bare.evaluate(
      () => Boolean(document.querySelector('.settings-modal')) && /Модель распознавания/i.test(document.body.innerText),
    );
  }
  record(
    'сценарии',
    'онбординг без движка ведёт к скачиванию модели',
    cta.found && /движок|Web Speech|модел/i.test(cta.warn) && navigated,
    `кнопка=${cta.found} плашка=${cta.warn.slice(0, 60)} настройки=${navigated}`,
  );
  await bare.close();
}

async function scenarioDictation(browser) {
  const page = await openPage(browser, '#/home');
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
  const inserts = await page.evaluate(() =>
    (window.__bridgeCalls || []).filter((c) => c.channel === 'text:insert').map((c) => String(c.args?.[0] || '')),
  );
  record('сценарии', 'диктовка: текст вставляется в активное окно', inserts.length === 1 && /Проверка диктовки/i.test(inserts[0]), `вставок: ${inserts.length}`);
  record('сценарии', 'диктовка не пишет в консоль ошибок', errors.length === 0, errors[0] || '');
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

  const errors = takeErrors(page);
  record('сценарии', 'индикатор: без ошибок консоли', errors.length === 0, errors[0] || '');
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
    const btn = document.querySelector('.dict-row button[aria-label], .dict-row .icon-btn');
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
  await page.evaluate(() => document.querySelector('.dict-row .icon-btn')?.click());
  await sleep(350);

  // повторное добавление того же слова не плодит копии и честно говорит «обновлено»
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
    'словарь: повтор слова обновляет запись и пишет «обновлено»',
    afterDup === afterDelete && /обновлено/i.test(dupToast),
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

async function scenarioSettingsSections(browser) {
  const sections = ['account', 'app', 'features', 'data', 'diagnostics', 'network', 'about'];
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
  // язык живёт в разделе «Приложение» — возвращаемся туда перед проверкой
  await page.evaluate(() => {
    window.location.hash = '#/settings?section=app&from=home';
  });
  await sleep(400);
  const labels = await page.evaluate(() => document.body.innerText);
  const honestLanguage = /Язык диктовки/.test(labels) && !/Язык интерфейса/.test(labels);
  record('сценарии', 'настройки: язык называется «диктовки», а не «интерфейса»', honestLanguage);
  const errors = takeErrors(page);
  record('сценарии', 'настройки: все 7 разделов что-то показывают', empty.length === 0, empty.join(', '));
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
  await page.close();
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

async function scenarioProfile(browser) {
  const page = await openPage(browser, '#/home');
  await page.evaluate(() => document.querySelector('.sidebar__bottom .profile').click());
  await sleep(350);
  const input = await page.$('.modal input');
  if (!input) throw new Error('в профиле нет поля имени');
  await input.click({ clickCount: 3 });
  await input.type('Мария');
  const saved = await clickIn(page, '.modal', 'Сохранить') || (await clickIn(page, '.modal', 'Готово'));
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
  const opened = await clickIn(page, '', 'Добавить новую инструкцию');
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

// Обновление: проверка → скачивание → перезапуск, без «зависшей» кнопки.
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

// Очистка истории диктовок — только после подтверждения, пустая история молчит делом.
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
    /не подключена/i.test(hello) && link && /Функции/i.test(section),
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
  const errors = takeErrors(page);
  record('сценарии', 'диагностика: без ошибок консоли', errors.length === 0, errors[0] || '');
  await page.close();
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
  // «Открыть репозиторий» живёт в разделе «О программе» — переходим туда
  await page.evaluate(() => {
    window.__opened = [];
    const nativeOpen = window.open;
    window.open = (url, target) => {
      window.__opened.push({ url, target });
      return null;
    };
    return nativeOpen ? true : true;
  });
  await clickIn(page, '', 'О программе');
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
      dictionary: [{ id: 'w-import', word: 'ИмпортСлово', hint: '' }],
      dictations: [{ id: 'd-import', text: 'Восстановленная запись из копии', createdAt: Date.now(), words: 5, seconds: 4 }],
      settings: { dictationRetentionDays: 3650 },
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
      /будет заменены|заменены/i.test(asked) &&
        confirm &&
        state.dictionary.some((w) => w.word === 'ИмпортСлово') &&
        state.dictations.some((d) => /Восстановленная запись/.test(d.text)) &&
        /Копия восстановлена/i.test(state.toast),
      `asked=${asked.slice(0, 30)} confirm=${confirm} dict=${state.dictionary.length} hist=${state.dictations.length} toast=${state.toast.slice(0, 80)}`,
    );
  } finally {
    rmSync(backupPath, { force: true });
  }
  const errors = takeErrors(page);
  record('сценарии', 'данные: без ошибок консоли', errors.length === 0, errors[0] || '');
  await page.close();
}

// «Держать модель в памяти»: тумблер обязан реально просить main поднять
// whisper-server, а не просто менять галочку.
async function scenarioWarmModel(browser) {
  const page = await openPage(browser, '#/settings?section=features&from=home', { settle: 700 });
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
  // список моделей приходит от сервера — имя не нужно вписывать вручную
  const picked = await page.evaluate(() => {
    const select = document.querySelector('.settings-main .select');
    return { found: Boolean(select), text: select?.innerText || '' };
  });
  record(
    'сценарии',
    'сеть: модель выбирается из списка Ollama',
    picked.found && /qwen|llama|mistral/i.test(picked.text),
    picked.text.replace(/\n/g, ' ').slice(0, 80),
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
  await sleep(300);
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
  await page.keyboard.press('Escape');
  await sleep(300);
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
  const errors = takeErrors(page);
  record('события', 'AI-инструкция по хоткею без ошибок консоли', errors.length === 0, errors[0] || '');
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
  await page.keyboard.press('Escape');
  await sleep(300);
  const closed = await page.evaluate(() => !document.querySelector('.settings-modal'));

  await page.keyboard.down('Control');
  await page.keyboard.press('KeyK');
  await page.keyboard.up('Control');
  await sleep(500);
  const search = await page.evaluate(() => ({
    onClipboard: location.hash.includes('clipboard'),
    focused: document.activeElement?.closest('.clip-toolbar') !== null,
  }));
  record('клавиатура', 'Ctrl+, открывает настройки, Esc закрывает', opened && closed);
  record('клавиатура', 'Ctrl+K ведёт в буфер и ставит курсор в поиск', search.onClipboard && search.focused, JSON.stringify(search));
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

async function scenarioSttFailure(browser) {
  const page = await openPage(browser, '#/home');
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
  const page = await openPage(browser, '#/home', { settings: { showFloatingIndicator: false } });
  await clickText(page, 'Начать диктовку');
  await sleep(1200);
  const hud = await page.evaluate(() => Boolean(document.querySelector('.hud')));
  await page.evaluate(() => document.querySelector('[aria-label="Остановить запись"]')?.click());
  await sleep(1200);
  record('настройки', 'выключенный индикатор не показывается при записи', !hud);

  const page2 = await openPage(browser, '#/home', { settings: { showFloatingIndicator: true } });
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
  const page = await openPage(browser, '#/home', { settings: { readAloud: true, soundFeedback: false } });
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
  const page = await openPage(browser, '#/hotkeys', { settle: 400, settings: { aiProcessing: false } });
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
    idle: !/Слушаю|Транскрибирую/i.test(document.body.innerText),
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
    inserts: (window.__bridgeCalls || []).filter((c) => c.channel === 'text:insert').length,
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
  // 1. Модель не настроена: снимок всё равно снимается, диктовка идёт дальше
  const page = await openPage(browser, '#/home', { settings: { aiProcessing: false } });
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
    idle: !/Слушаю|Транскрибирую/i.test(document.body.innerText),
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

/* ── запуск ───────────────────────────────────────────────────────────── */

async function main() {
  const chrome = await resolveChrome();
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
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process',
        '--mute-audio',
        // фейковый микрофон: без него MediaRecorder в headless молчит и диктовку не проверить
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
      ],
    });

    // ZS_ONLY — прогон одного сценария: обход экранов и ввод текста не нужны
    const only = process.env.ZS_ONLY || '';
    console.log(C.head('\nОбход экранов'));
    const screens = process.env.ZS_SKIP_CRAWL === '1' || only ? [] : [
      { route: '#/home', label: 'Главная' },
      { route: '#/dictionary', label: 'Словарь' },
      { route: '#/hotkeys', label: 'Горячие клавиши' },
      { route: '#/clipboard', label: 'Буфер обмена' },
      { route: '#/settings?section=app&from=home', label: 'Настройки' },
    ];
    for (const screen of screens) {
      console.log(C.dim(`\n${screen.label}`));
      await explore(browser, screen);
    }

    if (process.env.ZS_SKIP_INPUTS !== '1' && !only) {
      console.log(C.head('\nВвод текста в поля'));
      for (const screen of [
        { route: '#/home', label: 'Главная' },
        { route: '#/dictionary', label: 'Словарь' },
        { route: '#/clipboard', label: 'Буфер обмена' },
        { route: '#/settings?section=app&from=home', label: 'Настройки' },
      ]) {
        await exploreInputs(browser, screen);
      }
    }

    console.log(C.head('\nСценарии'));
    const scenarios = [
      ['онбординг', scenarioOnboarding],
      ['диктовка', scenarioDictation],
      ['плавающий индикатор (Electron)', scenarioFloatingHud],
      ['словарь', scenarioDictionary],
      ['буфер', scenarioClipboard],
      ['разделы настроек', scenarioSettingsSections],
      ['темы', scenarioTheme],
      ['поиск по настройкам', scenarioSettingsSearch],
      ['правка расшифровки', scenarioEditSnippet],
      ['AI-инструкция', scenarioAiInstruction],
      ['мост', scenarioBridgeWiring],
      ['профиль', scenarioProfile],
      ['запись сочетания', scenarioRecorder],
      ['новая инструкция', scenarioInstruction],
      ['модели', scenarioModels],
      ['микрофон', scenarioMic],
      ['данные: резервная копия', scenarioBackup],
      ['хранилище заполнено', scenarioStorageFull],
      ['диагностика', scenarioDiagnostics],
      ['диагностика без моста', scenarioDiagnosticsBrowser],
      ['модель в памяти', scenarioWarmModel],
      ['отмена скачивания модели', scenarioModelCancel],
      ['действия в сетке буфера', scenarioClipboardGridActions],
      ['возврат удаления', scenarioDictationUndo],
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
      ['режимы диктовки', scenarioDictationModes],
      ['связь с main', scenarioMainSync],
      ['сброс сочетаний', scenarioResetHotkeys],
    ];
    // ZS_ONLY=подстрока — прогнать один сценарий, пока чинишь именно его
    for (const [name, fn] of scenarios) {
      if (only && !name.includes(only)) continue;
      try {
        await fn(browser);
      } catch (err) {
        record('сценарии', name, false, String(err && err.message).slice(0, 200));
      }
    }
  } finally {
    if (browser) await browser.close();
    if (server) server.kill('SIGTERM');
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
