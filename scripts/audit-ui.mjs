/**
 * Аудит интерфейса: «а эта кнопка вообще что-нибудь делает?»
 *
 * Скрипт проходит по всем экранам, находит каждый интерактивный элемент
 * (кнопки, тумблеры, поля, селекты), дёргает его и смотрит, есть ли
 * наблюдаемый результат: вызов моста, изменение localStorage, смена адреса,
 * появление тоста/диалога или изменение текста на экране. Элементы, после
 * которых ничего не произошло, печатаются списком — их и надо смотреть руками.
 *
 * Это не тест с порогом «сколько найдено»: у части кнопок результата в моменте
 * и не должно быть (фокус, наведение, выбор пункта). Задача — показать слепые
 * места, а не «покрасить» прогон.
 *
 * Запуск:
 *   LD_LIBRARY_PATH=/tmp/al2023/lib CHROME_PATH=/tmp/chromium \
 *   ZS_BASE_URL=http://localhost:5173 node scripts/audit-ui.mjs
 */

import puppeteer from 'puppeteer-core';
import { installMockBridge } from './e2e/mock-bridge.mjs';
import { buildSeedClipboard, buildSeedDictations, SEED_DICTIONARY } from '../src/lib/seed.js';

const BASE = (process.env.ZS_BASE_URL || 'http://127.0.0.1:5173').replace(/\/$/, '');
const EXE = process.env.CHROME_PATH || '/usr/bin/chromium';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ROUTES = [
  { hash: '#/home', name: 'Главная' },
  { hash: '#/clipboard', name: 'Буфер обмена' },
  { hash: '#/dictionary', name: 'Словарь' },
  { hash: '#/hotkeys', name: 'Горячие клавиши' },
  { hash: '#/instructions', name: 'Инструкции' },
  { hash: '#/settings?section=app&from=home', name: 'Настройки → Приложение' },
  { hash: '#/settings?section=features&from=home', name: 'Настройки → Функции' },
  { hash: '#/settings?section=data&from=home', name: 'Настройки → Данные' },
  { hash: '#/settings?section=network&from=home', name: 'Настройки → Сеть' },
  { hash: '#/settings?section=diagnostics&from=home', name: 'Настройки → Диагностика' },
  { hash: '#/settings?section=about&from=home', name: 'Настройки → О программе' },
];

const SEED_SETTINGS = {
  onboarded: true,
  userName: 'Тест',
  speedFix151: true,
  theme: 'dark',
  language: 'ru',
  whisperModel: 'small-q5_1',
  aiEndpoint: 'http://localhost:11434',
  aiModel: 'qwen2.5:0.5b',
  diagnostics: false,
  keepModelLoaded: false,
};

/**
 * Доступные имена: у кнопки-иконки без подписи человек без зрения (и подсказка
 * при наведении) не понимает, что она делает; поле без подписи нельзя найти
 * поиском по настройкам. Проверяем это отдельно от «нажал — что-то произошло».
 */
async function auditNames(page) {
  return page.evaluate(() => {
    const visible = (el) => el.offsetParent !== null && !el.disabled && el.type !== 'hidden';
    const text = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    const labelledBy = (el) => {
      const id = el.getAttribute('aria-labelledby');
      if (!id) return '';
      return id
        .split(/\s+/)
        .map((one) => document.getElementById(one)?.textContent || '')
        .join(' ')
        .trim();
    };
    const hasLabel = (el) => {
      if (el.getAttribute('aria-label')) return true;
      if (labelledBy(el)) return true;
      if (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) return true;
      if (el.closest('label')) return true;
      if (el.getAttribute('title')) return true;
      if (el.getAttribute('placeholder')) return true;
      return Boolean(text(el));
    };

    const describe = (el) =>
      `<${el.tagName.toLowerCase()}${el.getAttribute('type') ? ` type=${el.getAttribute('type')}` : ''}> ${
        (el.getAttribute('class') || '').slice(0, 50) || '(без класса)'
      }`;

    const unnamed = [...document.querySelectorAll('button, [role="switch"], [role="button"], a[href]')]
      .filter(visible)
      .filter((el) => !hasLabel(el))
      .map(describe);

    const unlabeled = [...document.querySelectorAll('input, select, textarea')]
      .filter(visible)
      .filter((el) => !hasLabel(el))
      .map(describe);

    return { unnamed, unlabeled };
  });
}

async function openPage(browser, hash) {
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !/favicon/i.test(msg.text())) errors.push(msg.text().slice(0, 300));
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${String(err?.message || err).slice(0, 300)}`));
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument(installMockBridge);
  await page.evaluateOnNewDocument(
    ([seed, dictations, clipboard, dictionary]) => {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith('mockstore:')) localStorage.removeItem(key);
      }
      localStorage.setItem('mockstore:zs.settings', JSON.stringify(seed));
      localStorage.setItem('mockstore:zs.dictations', JSON.stringify(dictations));
      localStorage.setItem('mockstore:zs.clipboard', JSON.stringify(clipboard));
      localStorage.setItem('mockstore:zs.dictionary', JSON.stringify(dictionary));
    },
    [SEED_SETTINGS, buildSeedDictations(), buildSeedClipboard(), SEED_DICTIONARY],
  );
  await page.goto(`${BASE}/${hash}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.app-window', { timeout: 15_000 });
  await sleep(450);
  page.__errors = errors;
  return page;
}

/** Снимок «что вообще изменилось»: мост, хранилище, адрес, картинка экрана. */
async function snapshot(page) {
  return page.evaluate(() => {
    const calls = (window.__bridgeCalls || []).map((c) => c.channel).join(',');
    const store = Object.keys(localStorage)
      .filter((k) => k.startsWith('mockstore:'))
      .sort()
      .map((k) => `${k}=${localStorage.getItem(k)}`)
      .join('|');
    return {
      calls,
      store,
      hash: location.hash,
      text: document.body.innerText.slice(0, 4000),
      dialogs: document.querySelectorAll('[role="dialog"], .modal, .confirm').length,
      toasts: document.querySelectorAll('.toast, .toaster__item').length,
    };
  });
}

async function auditRoute(browser, route) {
  const page = await openPage(browser, route.hash);
  const findings = [];
  const total = await page.evaluate(() => {
    // Активные пункты навигации и «уже включённые» тумблеры не считаем: у них
    // реакции и не должно быть — это текущее состояние, а не действие.
    window.__auditNodes = [...document.querySelectorAll('button, [role="switch"], input, select, textarea')].filter(
      (el) =>
        el.offsetParent !== null &&
        !el.disabled &&
        el.type !== 'hidden' &&
        !el.matches('[aria-current="page"], .is-active') &&
        !el.closest('.nav-item.is-active'),
    );
    return window.__auditNodes.length;
  });

  for (let i = 0; i < total; i += 1) {
    const meta = await page.evaluate((index) => {
      const el = window.__auditNodes[index];
      if (!el || !document.contains(el)) return null;
      el.scrollIntoView({ block: 'center' });
      return {
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type') || '',
        label: (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.name || '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 60),
        role: el.getAttribute('role') || '',
        cls: String(el.className || '').slice(0, 60),
      };
    }, i);
    if (!meta) continue;

    const before = await snapshot(page);
    await page.evaluate((index) => {
      const el = window.__auditNodes[index];
      if (!el) return;
      if (el.tagName === 'SELECT') {
        // селект проверяем сменой значения: фокус ничего не меняет
        const options = [...el.options].filter((o) => !o.disabled && o.value !== el.value);
        if (options.length) {
          el.value = options[0].value;
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return;
      }
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        el.focus();
      } else {
        el.click();
      }
    }, i);
    await sleep(140);
    // для полей: ещё и ввод
    if (meta.tag === 'input' || meta.tag === 'textarea') {  // селект уже изменён выше
      await page.keyboard.type('абв');
      await sleep(120);
    }
    const after = await snapshot(page);

    const changed =
      before.calls !== after.calls ||
      before.store !== after.store ||
      before.hash !== after.hash ||
      before.text !== after.text ||
      before.dialogs !== after.dialogs ||
      before.toasts !== after.toasts;
    if (!changed) {
      findings.push({ ...meta, index: i });
    }
    // закрываем возможные диалоги, чтобы следующий элемент был доступен
    if (after.dialogs > before.dialogs) {
      await page.keyboard.press('Escape');
      await sleep(120);
    }
    // перерисовка могла заменить узлы — обновляем список
    const stillThere = await page.evaluate((index) => Boolean(window.__auditNodes[index] && document.contains(window.__auditNodes[index])), i);
    if (!stillThere) {
      await page.evaluate(() => {
        window.__auditNodes = [...document.querySelectorAll('button, [role="switch"], input, select, textarea')].filter(
          (el) => el.offsetParent !== null && !el.disabled && el.type !== 'hidden',
        );
      });
    }
  }

  const names = await auditNames(page);
  const errors = page.__errors.filter((e) => !/ResizeObserver|favicon/i.test(e));
  await page.close();
  return { route, total, findings, errors, names };
}

const browser = await puppeteer.launch({
  executablePath: EXE,
  headless: 'new',
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
});

let silent = 0;
let broken = 0;
let unnamed = 0;
let unlabeled = 0;
for (const route of ROUTES) {
  const res = await auditRoute(browser, route);
  const head = `${route.name} — элементов: ${res.total}, без видимой реакции: ${res.findings.length}`;
  console.log(`\n${head}`);
  for (const f of res.findings) {
    console.log(`  · <${f.tag}${f.type ? ` type=${f.type}` : ''}> «${f.label || f.cls}»`);
    silent += 1;
  }
  for (const e of res.errors) {
    console.log(`  ! ошибка консоли: ${e}`);
    broken += 1;
  }
  for (const el of res.names.unnamed) {
    console.log(`  · кнопка без подписи: ${el}`);
    unnamed += 1;
  }
  for (const el of res.names.unlabeled) {
    console.log(`  · поле без подписи: ${el}`);
    unlabeled += 1;
  }
}

console.log(
  `\nИтого: элементов без видимой реакции — ${silent}, ошибок консоли — ${broken}, ` +
    `кнопок без подписи — ${unnamed}, полей без подписи — ${unlabeled}`,
);
await browser.close();
