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
async function command(command, text, { lockRequest = false } = {}) {
  const id = ++seq;
  const request = path.join(dir, 'request.json');
  const temporary = path.join(dir, 'request.tmp');
  const response = path.join(dir, `response-${id}.json`);
  let locker;
  try {
    if (lockRequest) fs.writeFileSync(path.join(dir, 'pause'), 'pause');
    fs.writeFileSync(temporary, JSON.stringify({ id, command, text }), 'utf8');
    fs.renameSync(temporary, request);
    if (lockRequest) {
      locker = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File',
        path.resolve('scripts/e2e/wininput-lock.ps1'), '-Directory', dir],
      { windowsHide: true, stdio: 'ignore' });
      await waitFile(path.join(dir, 'lock-ready'));
    }
    await waitFile(response);
    return JSON.parse(fs.readFileSync(response, 'utf8'));
  } finally {
    if (locker && locker.exitCode === null) locker.kill();
    if (lockRequest) fs.rmSync(path.join(dir, 'pause'), { force: true });
  }
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
    // Hold a request with FileShare.None while the target polls it. The target
    // must wait for release and execute it once, without creating error.txt.
    const lockedState = await command('state', undefined, { lockRequest: true });
    assert.equal(lockedState.ok, true, 'locked request was not processed after release');
    assert.equal(fs.existsSync(path.join(dir, 'lock-seen')), true, 'target never observed the lock');
    assert.equal(fs.existsSync(path.join(dir, 'error.txt')), false, 'transient lock reported as fatal');
    fs.rmSync(path.join(dir, 'lock-ready'), { force: true });
    fs.rmSync(path.join(dir, 'lock-seen'), { force: true });
    console.log('WinForms target: temporary exclusive request lock is retried');
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
      const dictation = process.env.ZS_TEST_WINDOWS_DICTATION === '1';
      const packaged = process.env.ZS_TEST_PACKAGED === '1';
      if (packaged) assert.equal(process.env.CI, 'true', 'проверка сборки допускается только на выделенном CI');
      const executable = packaged
        ? path.resolve(process.env.ZS_TEST_PACKAGED_EXE || 'release/win-unpacked/ZSpeakly.exe')
        : require('electron');
      assert.ok(fs.existsSync(executable), `нет Electron для проверки IPC: ${executable}`);
      assert.ok(fs.existsSync('dist/index.html'), 'сначала соберите интерфейс');
      const profile = path.join(dir, 'profile');
      fs.mkdirSync(profile);
      const settings = { onboarded: true, speedFix151: true, language: 'ru', micPreroll: false,
        liveWhisper: false, aiDictationRewrite: false,
        keepModelLoaded: false, clipboardMonitor: false, checkUpdates: false,
        soundFeedback: false, closeToTray: false, autoOptimize: false };
      const nonce = `zs-packaged-${process.pid}-${Date.now()}`;
      fs.writeFileSync(path.join(profile, 'profile.json'), JSON.stringify({
        'zs.settings': settings, 'zs:settings': settings, 'zs:test-id': nonce,
      }));
      const { default: puppeteer } = await import('puppeteer-core');
      let browser, padded;
      try {
        const args = packaged ? [`--user-data-dir=${profile}`] : [path.resolve('scripts/e2e/electron-entry.cjs')];
        if (dictation) {
          assert.ok(process.env.ZS_USER_DATA && process.env.ZS_DICTATION_WAV, 'не заданы модель и WAV');
          const modelRoot = path.resolve(process.env.ZS_USER_DATA, 'models');
          assert.ok(fs.existsSync(path.join(modelRoot, 'gigaam')), 'нет модели GigaAM');
          // Junction не требует прав разработчика Windows. Сборке также нужны
          // тестовые заглушки Whisper/VAD, чтобы не начинать фоновую загрузку.
          if (packaged) {
            const modelDir = path.join(profile, 'models');
            fs.mkdirSync(modelDir);
            fs.symlinkSync(path.join(modelRoot, 'gigaam'), path.join(modelDir, 'gigaam'), 'junction');
            fs.writeFileSync(path.join(modelDir, 'ggml-tiny.bin'), 'not-a-real-model');
            fs.writeFileSync(path.join(modelDir, 'ggml-silero-v6.2.0.bin'), 'not-a-real-model');
          } else {
            fs.symlinkSync(modelRoot, path.join(profile, 'models'), 'junction');
          }
          const { readWav } = await import('./lib/engine-cli.mjs');
          const { createPaddedWav } = await import('./lib/virtual-mic-wav.mjs');
          const wav = readWav(process.env.ZS_DICTATION_WAV);
          assert.equal(wav.sampleRate, 16000);
          assert.ok(wav.pcm.length >= 32000 && wav.pcm.length <= 15 * 32000);
          padded = createPaddedWav(wav.pcm, wav.sampleRate);
          args.push('--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
            `--use-file-for-fake-audio-capture=${padded.file}%noloop`);
        }
        browser = await puppeteer.launch({
          executablePath: executable, headless: false, ignoreDefaultArgs: true,
          env: { ...process.env, ZS_E2E_PROFILE: profile, ZSPEAKLY_DEV_URL: 'none' },
          args, timeout: 60000,
        });
        const pageTarget = await browser.waitForTarget((t) => t.type() === 'page' && t.url().includes('index.html'), { timeout: 30000 });
        const page = await pageTarget.page();
        await page.waitForSelector('.app-window', { timeout: 30000 });
        await page.waitForFunction(() => Boolean(window.zspeakly?.isElectron && window.zspeakly?.native?.insertText), { timeout: 15000 });
        const seenNonce = await page.evaluate(() => window.zspeakly.store.getSync('zs:test-id'));
        assert.equal(seenNonce, nonce, 'приложение не использует изолированный тестовый профиль');
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
        if (process.env.CI === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted') {
          // Same window and field, but the caret moved after a real insertion.
          // Blind Backspace would delete pre-existing text, so no keys may be sent.
          const original = 'Чужие слова: ';
          const insertedText = 'тестовая вставка';
          assert.equal(await active(), true, 'перед подготовкой undo потерян фокус');
          await command('selectText', original);
          await command('deselectText');
          await page.evaluate(async () => {
            const current = await window.zspeakly.store.get('zs:settings');
            await window.zspeakly.store.set('zs:settings', { ...current, insertMethod: 'clipboard' });
          });
          assert.equal((await command('state')).foreground, true, 'перед вставкой для undo потерян фокус');
          const insertion = await page.evaluate((text) => window.zspeakly.native.insertText(text), insertedText);
          assert.equal(insertion.ok, true, JSON.stringify(insertion));
          const expected = original + insertedText;
          await assertText(expected, 'подготовка теста undo');
          await command('caretAt', '3');
          const caretState = await command('state');
          assert.equal(caretState.foreground, true, 'перед проверкой undo потерян фокус');
          assert.equal(caretState.selectionStart, 3, 'курсор не перемещён');
          assert.equal(caretState.selectionLength, 0, 'неожиданное выделение');
          const undo = await page.evaluate(() => window.zspeakly.native.undoLastInsert());
          assert.equal(undo.ok, false, JSON.stringify(undo));
          assert.equal(undo.reason, 'неподтверждённая позиция курсора', JSON.stringify(undo));
          await sleep(1200);
          assert.equal((await command('state')).text, expected, 'слепой undo удалил чужой текст');
          const repeatedUndo = await page.evaluate(() => window.zspeakly.native.undoLastInsert());
          assert.equal(repeatedUndo.ok, false, JSON.stringify(repeatedUndo));
          assert.equal((await command('state')).text, expected, 'повтор undo удалил текст');
          console.log('UNDO_CARET_MOVED_E2E_OK: после реальной вставки и смены позиции курсора текст не изменился');
          await page.waitForFunction(async () => Boolean((await window.zspeakly.native.inputStatus())?.helper?.ready), { timeout: 30000, polling: 300 });
          const oldClipboard = 'Старый синтетический буфер';
          const selected = 'Выделенный синтетический текст';
          await command('clipboard', oldClipboard);
          assert.equal(await active(), true, 'перед чтением выделения потерян фокус');
          await command('selectText', selected);
          assert.equal((await command('state')).foreground, true, 'фокус изменился до Ctrl+C');
          assert.equal(await page.evaluate(() => window.zspeakly.native.readSelection()), selected);
          assert.equal((await command('readClipboard')).text, selected);
          // The selected text equals the existing clipboard: deliberately fail closed.
          assert.equal(await active(), true, 'перед одинаковым выделением потерян фокус');
          await command('selectText', selected);
          const same = await page.evaluate(() => window.zspeakly.native.readSelection());
          assert.equal(same.reason, 'unverified', JSON.stringify(same));
          assert.equal(same.text, '');
          await command('clipboard', oldClipboard);
          assert.equal(await active(), true, 'перед отсутствующим выделением потерян фокус');
          await command('deselectText');
          const none = await page.evaluate(() => window.zspeakly.native.readSelection());
          assert.equal(none.reason, 'unverified', JSON.stringify(none));
          assert.equal(none.text, '');
          assert.equal((await command('readClipboard')).text, oldClipboard);
          console.log('SELECTION_STALE_CLIPBOARD_E2E_OK: реальный Ctrl+C, отсутствие выделения и совпадающий текст');
        }
        // Only disposable CI may start with a deliberately empty system clipboard.
        if (process.env.CI === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted') {
          const text = 'Синтетическая вставка в пустой буфер';
          await command('clear');
          await command('clipboardClearIsolatedCi');
          assert.equal((await command('clipboardFormatsIsolatedCi')).count, 0, 'буфер не пуст перед тестом');
          await page.evaluate(async () => {
            const current = await window.zspeakly.store.get('zs:settings');
            await window.zspeakly.store.set('zs:settings', { ...current, insertMethod: 'clipboard' });
          });
          assert.equal(await active(), true, 'перед вставкой в пустой буфер потерян фокус');
          const result = await page.evaluate((value) => window.zspeakly.native.insertText(value), text);
          assert.equal(result.ok, true, `Electron clipboard empty: ${JSON.stringify(result)}`);
          await assertText(text, 'Electron clipboard empty');
          await sleep(1200);
          assert.equal((await command('clipboardFormatsIsolatedCi')).count, 0, 'после вставки буфер не пуст');
          console.log('CLIPBOARD_EMPTY_RESTORE_E2E_OK: текст в WinForms, исходно пустой буфер снова пуст');
        }
        if (dictation) {
          const status = await page.evaluate(() => window.zspeakly.native.modelsStatus());
          assert.equal(status.russian.available, true, `GigaAM недоступна: ${status.russian.reason}`);
          const previous = 'Сохранённый системный буфер';
          await command('clear');
          await command('clipboard', previous);
          await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => /Начать диктовку/.test(b.innerText)), { timeout: 15000 });
          await page.evaluate(async () => {
            const current = await window.zspeakly.store.get('zs:settings');
            await window.zspeakly.store.set('zs:settings', { ...current, insertMethod: 'clipboard' });
            [...document.querySelectorAll('button')].find((b) => /Начать диктовку/.test(b.innerText)).click();
          });
          await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => /Слушаю/.test(b.innerText)), { timeout: 15000 });
          assert.equal(await active(), true, 'во время записи тестовое окно не получило фокус');
          await sleep(Math.ceil(padded.seconds * 1000) + 700);
          assert.equal((await command('state')).foreground, true, 'до остановки записи фокус потерян');
          await page.evaluate(() => {
            const stop = [...document.querySelectorAll('button')].find((b) => /Слушаю/.test(b.innerText));
            if (!stop) throw new Error('не найдена кнопка остановки');
            stop.click();
          });
          await page.waitForFunction(() => {
            const list = window.zspeakly.store.getSync('zs.dictations');
            return Array.isArray(list) && list.length > 0;
          }, { timeout: 90000 });
          const entry = (await page.evaluate(() => window.zspeakly.store.get('zs.dictations')))[0];
          assert.equal(entry.sttMode, 'gigaam', JSON.stringify(entry));
          assert.match(entry.text, /привет/iu);
          assert.match(entry.text, /распознаван/iu);
          await assertText(entry.text, 'диктовка GigaAM в окно Windows');
          const inputStatus = await page.evaluate(() => window.zspeakly.native.inputStatus());
          assert.equal(inputStatus.last.ok, true, JSON.stringify(inputStatus.last));
          await sleep(1200);
          assert.equal((await command('readClipboard')).text, previous, 'буфер не восстановлен после диктовки');
          const build = process.env.ZS_TEST_PACKAGED_EXE ? 'приложение после NSIS' : packaged ? 'упакованное приложение' : 'Electron из исходников';
          console.log(`Виртуальная диктовка Windows + ${build} + GigaAM → WinForms: ${entry.text}; метод ${inputStatus.last.method}, буфер сохранён.`);
        }
        if (!packaged && process.env.CI === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted') {
          // Separate process with the real host and IPC: only the host's
          // acknowledgement is replaced after a confirmed real key injection.
          await browser.close();
          browser = await puppeteer.launch({
            executablePath: executable, headless: false, ignoreDefaultArgs: true,
            env: { ...process.env, ZS_E2E_PROFILE: profile, ZSPEAKLY_DEV_URL: 'none', ZS_INPUT_LOST_E2E: '1' },
            args: [path.resolve('scripts/e2e/electron-input-lost-entry.cjs')], timeout: 60000,
          });
          const lostTarget = await browser.waitForTarget((t) => t.type() === 'page' && t.url().includes('index.html'), { timeout: 30000 });
          const lostPage = await lostTarget.page();
          await lostPage.waitForSelector('.app-window', { timeout: 30000 });
          await lostPage.waitForFunction(async () => Boolean((await window.zspeakly?.native?.inputStatus())?.helper?.ready), { timeout: 30000, polling: 300 });
          assert.equal(await lostPage.evaluate(() => window.zspeakly.store.getSync('zs:test-id')), nonce);
          await lostPage.evaluate(async () => {
            const current = await window.zspeakly.store.get('zs:settings');
            await window.zspeakly.store.set('zs:settings', { ...current, insertMethod: 'sendinput' });
          });
          const text = 'Один реальный ввод при потере ответа';
          const previous = 'Тестовый буфер при потере ответа';
          await command('clear');
          await command('clipboard', previous);
          assert.equal(await active(), true, 'перед проверкой потери ответа потерян фокус');
          const result = await lostPage.evaluate((value) => window.zspeakly.native.insertText(value), text);
          assert.equal(result.ok, false, JSON.stringify(result));
          assert.equal(result.uncertain, true, JSON.stringify(result));
          await assertText(text, 'неподтверждённый ввод');
          await sleep(1500);
          assert.equal((await command('state')).text, text, 'текст повторно отправлен после потери ответа');
          assert.equal((await command('readClipboard')).text, previous, 'буфер изменился после потери ответа');
          const undo = await lostPage.evaluate(() => window.zspeakly.native.undoLastInsert());
          assert.equal(undo.reason, 'нечего убирать', JSON.stringify(undo));
          console.log('SENDINPUT_LOST_ACK_E2E_OK: реальный ввод в WinForms однократно; ответ искусственно потерян, повтор и слепая отмена запрещены');
          await lostPage.evaluate(async () => {
            const current = await window.zspeakly.store.get('zs:settings');
            await window.zspeakly.store.set('zs:settings', { ...current, insertMethod: 'clipboard' });
          });
          const pasteText = 'Одна вставка Ctrl+V при потере ответа';
          await command('clear');
          await command('clipboard', 'Предыдущий синтетический буфер');
          assert.equal(await active(), true, 'перед потерей ответа Ctrl+V потерян фокус');
          const pasteResult = await lostPage.evaluate((value) => window.zspeakly.native.insertText(value), pasteText);
          assert.equal(pasteResult.ok, false, JSON.stringify(pasteResult));
          assert.equal(pasteResult.uncertain, true, JSON.stringify(pasteResult));
          assert.equal(pasteResult.method, 'clipboard', JSON.stringify(pasteResult));
          await assertText(pasteText, 'неподтверждённый Ctrl+V');
          await sleep(1500);
          assert.equal((await command('state')).text, pasteText, 'Ctrl+V отправлен повторно');
          assert.equal((await command('readClipboard')).text, pasteText, 'буфер неожиданно восстановлен');
          const pasteUndo = await lostPage.evaluate(() => window.zspeakly.native.undoLastInsert());
          assert.equal(pasteUndo.reason, 'нечего убирать', JSON.stringify(pasteUndo));
          console.log('PASTE_LOST_ACK_E2E_OK: реальный Ctrl+V в WinForms однократно; ответ искусственно потерян, повтор и слепая отмена запрещены');
          const historyText = 'Вставка из истории при потере ответа';
          await command('clear');
          await command('clipboard', historyText);
          assert.equal(await active(), true, 'перед автовставкой потерян фокус');
          const historyResult = await lostPage.evaluate(() => window.zspeakly.native.pasteToActive());
          assert.equal(historyResult.uncertain, true, JSON.stringify(historyResult));
          await assertText(historyText, 'автовставка из истории');
          await sleep(1500);
          assert.equal((await command('state')).text, historyText, 'автовставка повторилась');
          assert.equal((await lostPage.evaluate(() => window.zspeakly.native.undoLastInsert())).reason, 'нечего убирать');
          const replacement = 'Замена при потере ответа';
          assert.equal(await active(), true, 'перед заменой потерян фокус');
          await command('selectText', 'Старое выделение');
          assert.equal((await command('state')).foreground, true, 'перед заменой выделения потерян фокус');
          const replaceResult = await lostPage.evaluate((value) => window.zspeakly.native.replaceSelection(value), replacement);
          assert.equal(replaceResult.uncertain, true, JSON.stringify(replaceResult));
          await assertText(replacement, 'замена выделения');
          await sleep(1500);
          assert.equal((await command('state')).text, replacement, 'замена повторилась');
          assert.equal((await lostPage.evaluate(() => window.zspeakly.native.undoLastInsert())).reason, 'нечего убирать');
          assert.equal((await command('readClipboard')).text, replacement, 'результат замены отсутствует в буфере');
          console.log('SHARED_PASTE_LOST_ACK_E2E_OK: история и замена: реальный Ctrl+V однократно, ответ искусственно потерян');

          // Fresh process: the actual paste happens once, then its response is
          // held so a second IPC request definitely overlaps the first one.
          await browser.close();
          browser = await puppeteer.launch({
            executablePath: executable, headless: false, ignoreDefaultArgs: true,
            env: { ...process.env, ZS_E2E_PROFILE: profile, ZSPEAKLY_DEV_URL: 'none',
              ZS_CONCURRENT_E2E: '1', ZS_CONCURRENT_DIR: dir },
            args: [path.resolve('scripts/e2e/electron-insert-concurrency-entry.cjs')], timeout: 60000,
          });
          const concurrentTarget = await browser.waitForTarget((t) => t.type() === 'page' && t.url().includes('index.html'), { timeout: 30000 });
          const concurrentPage = await concurrentTarget.page();
          await concurrentPage.waitForSelector('.app-window', { timeout: 30000 });
          await concurrentPage.waitForFunction(async () => Boolean((await window.zspeakly?.native?.inputStatus())?.ready), { timeout: 30000, polling: 300 });
          await concurrentPage.evaluate(async () => {
            const current = await window.zspeakly.store.get('zs:settings');
            await window.zspeakly.store.set('zs:settings', { ...current, insertMethod: 'clipboard' });
          });
          const initial = 'Исходный синтетический буфер';
          const firstText = 'Первая синтетическая фраза';
          const secondText = 'Вторая синтетическая фраза';
          await command('clear');
          await command('clipboard', initial);
          assert.equal(await active(), true, 'перед проверкой параллельной вставки потерян фокус');
          let firstPending;
          try {
            firstPending = concurrentPage.evaluate((value) => window.zspeakly.native.insertText(value), firstText);
            await waitFile(path.join(dir, 'concurrent-paste-ready'));
            await assertText(firstText, 'первая параллельная вставка');
            const second = await concurrentPage.evaluate((value) => window.zspeakly.native.insertText(value), secondText);
            assert.equal(second.ok, false, JSON.stringify(second));
            assert.equal(second.busy, true, JSON.stringify(second));
            assert.equal((await command('state')).text, firstText, 'вторая вставка попала в окно');
            assert.equal((await command('readClipboard')).text, firstText, 'вторая вставка изменила буфер');
            fs.writeFileSync(path.join(dir, 'concurrent-paste-release'), 'release');
            const first = await firstPending;
            assert.equal(first.ok, true, JSON.stringify(first));
            await sleep(1200);
            assert.equal((await command('readClipboard')).text, initial, 'исходный буфер не восстановлен');
            assert.equal(await active(), true, 'перед повтором потерян фокус');
            const retry = await concurrentPage.evaluate((value) => window.zspeakly.native.insertText(value), secondText);
            assert.equal(retry.ok, true, JSON.stringify(retry));
            await assertText(firstText + secondText, 'повтор после освобождения');
            await sleep(1200);
            assert.equal((await command('readClipboard')).text, initial, 'буфер изменился после ручного повтора');
            console.log('DICTATION_OVERLAP_E2E_OK: реальный Ctrl+V, задержанный ответ, отказ второй вставке и ручной повтор');
          } finally {
            fs.writeFileSync(path.join(dir, 'concurrent-paste-release'), 'release');
            if (firstPending) await firstPending.catch(() => {});
          }

        }
      } finally {
        if (browser) await browser.close();
        padded?.cleanup();
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
