#!/usr/bin/env node
/** Реальный графический установщик 1.38.0 и обновление до текущей сборки.
 * Исключительно на одноразовом Windows runner; профиль и каталоги временные. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const asar = require('@electron/asar');
const pkg = require('../package.json');
assert.equal(process.platform, 'win32');
assert.equal(process.env.CI, 'true');
assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.ZS_INPUT_INTERACTIVE, '1');
assert.ok(process.env.RUNNER_TEMP && process.env.APPDATA && process.env.ZS_PREVIOUS_INSTALLER);
assert.ok(!fs.existsSync(path.join(process.env.APPDATA, 'ZSpeakly')), 'отказ: стандартный профиль существует');
assert.ok(!fs.existsSync(path.join(process.env.LOCALAPPDATA || '', 'Programs', 'ZSpeakly')), 'отказ: установка по умолчанию уже существует');
const previousInstaller = path.resolve(process.env.ZS_PREVIOUS_INSTALLER);
const installer = path.resolve('release', `ZSpeakly-Setup-${pkg.version}.exe`);
assert.ok(fs.existsSync(previousInstaller), 'нет закреплённого установщика v1.38.0');
assert.ok(fs.existsSync(installer), 'нет установщика текущей сборки');
const root = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, 'zs-previous-'));
const installDir = path.join(root, 'gui install', 'ZSpeakly');
const exe = path.join(installDir, 'ZSpeakly.exe');
const uninstall = path.join(installDir, 'Uninstall ZSpeakly.exe');
const profile = path.join(root, 'profile');
const nonce = `old-profile-${process.pid}-${Date.now()}`;
const text = 'Проверка истории до обновления';
const settings = { onboarded: true, speedFix151: true, language: 'ru', micPreroll: false,
  keepModelLoaded: false, clipboardMonitor: false, checkUpdates: false, diagnostics: false,
  soundFeedback: false, closeToTray: false, autoOptimize: false, whisperModel: 'tiny' };
fs.mkdirSync(path.join(profile, 'models'), { recursive: true });
// Не даём старому и новому процессу начать фоновую загрузку Whisper/VAD.
// Эти заглушки не распознают речь и не проверяют качество Whisper.
fs.writeFileSync(path.join(profile, 'models', 'ggml-tiny.bin'), 'not-a-real-model');
fs.writeFileSync(path.join(profile, 'models', 'ggml-silero-v6.2.0.bin'), 'not-a-real-model');
fs.writeFileSync(path.join(profile, 'profile.json'), JSON.stringify({
  'zs.settings': settings, 'zs:settings': settings, 'zs:test-id': nonce,
  'zs.dictations': [{ id: 'migration-ci', text, createdAt: Date.now(), durationMs: 3000, words: 4 }],
  'zs.dictionary': [{ id: 'migration-word', word: 'миграция', pinned: true, hits: 2 }],
}));
function run(file, args, opts = {}) {
  const r = spawnSync(file, args, { cwd: process.cwd(), encoding: 'utf8', windowsHide: true,
    windowsVerbatimArguments: Boolean(opts.verbatim),
    timeout: opts.timeout || 180000, maxBuffer: 5 * 1024 * 1024, env: { ...process.env, ...opts.env } });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  // Опубликованная 1.38 может падать на старом дефекте NSIS при запуске.
  // Повторяем только до появления окна и только для этого кода; не скрываем сбой.
  if (opts.allowOldStartupCrash && r.status !== 0 &&
      (r.stderr || '').includes('Installer exited with code -1073741819') &&
      !(r.stdout || '').includes('Wizard button:') && !fs.existsSync(exe)) {
    return 'OLD_INSTALLER_STARTUP_CRASH';
  }
  assert.equal(r.status, 0, `${opts.label || file}: ${r.error?.message || `код ${r.status}; ${r.signal}`}`);
  return r.stdout || '';
}
function installedVersion() {
  const archive = path.join(installDir, 'resources', 'app.asar');
  assert.ok(fs.existsSync(archive), `нет ${archive}`);
  // У обновлённого архива тот же путь, но другие смещения файлов.
  asar.uncache(archive);
  return JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8')).version;
}
async function checkProfile(version) {
  const { default: puppeteer } = await import('puppeteer-core');
  let browser;
  try {
    browser = await puppeteer.launch({ executablePath: exe, headless: false, ignoreDefaultArgs: true,
      env: { ...process.env, ZSPEAKLY_DEV_URL: 'none' },
      args: [`--user-data-dir=${profile}`], timeout: 60000 });
    const target = await browser.waitForTarget((t) => t.type() === 'page' && t.url().includes('index.html'), { timeout: 30000 });
    const page = await target.page();
    const errors = [];
    page.on('pageerror', (err) => errors.push(String(err.message || err)));
    await page.waitForSelector('.app-window', { timeout: 30000 });
    // Проверяем не только raw IPC: React должен показать прежнюю диктовку.
    await page.waitForFunction((expected) =>
      Array.from(document.querySelectorAll('.recent__text')).some((el) => el.textContent.includes(expected)),
    { timeout: 30000 }, text);
    const data = await page.evaluate(async () => ({
      nonce: window.zspeakly.store.getSync('zs:test-id'),
      dictations: await window.zspeakly.store.get('zs.dictations'),
      dictionary: await window.zspeakly.store.get('zs.dictionary'),
      settings: await window.zspeakly.store.get('zs.settings'),
    }));
    assert.equal(data.nonce, nonce, 'приложение использовало чужой профиль');
    assert.ok(data.dictations.some((item) => item.id === 'migration-ci' && item.text === text), 'история пропала');
    assert.ok(data.dictionary.some((item) => item.id === 'migration-word' && item.word === 'миграция'), 'словарь пропал');
    assert.equal(data.settings.language, 'ru', 'язык изменился');
    assert.equal(data.settings.onboarded, true, 'настройки первого запуска потеряны');
    assert.equal(errors.length, 0, errors.join('; '));
    await new Promise((resolve) => setTimeout(resolve, 800));
    console.log(`Открыта ${version}: история показана в UI, словарь и настройки прочитаны через настоящий IPC.`);
  } finally { if (browser) await browser.close(); }
}
(async () => {
  let cleaned = false;
  try {
    let output;
    for (let attempt = 1; attempt <= 4; attempt++) {
      output = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', path.resolve('scripts/e2e/nsis-gui.ps1'), '-Setup', previousInstaller, '-InstallPath', installDir],
      { timeout: 300000, label: 'графический установщик v1.38.0', allowOldStartupCrash: true });
      if (output !== 'OLD_INSTALLER_STARTUP_CRASH') break;
      console.log(`WARNING: опубликованный установщик 1.38.0 упал с 0xC0000005 до открытия окна; попытка ${attempt}/4.`);
    }
    assert.match(output, /GUI completed/, 'публикация 1.38.0 не запустилась после четырёх попыток');
    assert.ok(fs.existsSync(exe), `GUI не установил ${exe}`);
    assert.equal(installedVersion(), '1.38.0');
    await checkProfile('1.38.0');
    run(installer, ['--updated', '/S', `/D=${installDir}`], { label: 'обновление до текущей сборки' });
    assert.ok(fs.existsSync(exe), 'обновление не установило приложение');
    assert.equal(installedVersion(), pkg.version, 'установилась неверная версия');
    await checkProfile(pkg.version);
    const outputDictation = run(process.execPath, ['scripts/test-wininput-window.cjs'], {
      timeout: 240000, label: 'диктовка обновлённой программы',
      env: { ZS_TEST_ELECTRON: '1', ZS_TEST_PACKAGED: '1', ZS_TEST_WINDOWS_DICTATION: '1', ZS_TEST_PACKAGED_EXE: exe },
    });
    if (outputDictation.includes('SKIP:')) console.log('SKIP: окно не получило фокус, диктовка после обновления не проверена.');
    else assert.match(outputDictation, /Виртуальная диктовка Windows \+ приложение после NSIS/);
    console.log(`Обновление ${'1.38.0'} → ${pkg.version}: проверены установленный EXE и прежний профиль.`);
    run(uninstall, ['/S', `_?=${installDir}`], { label: 'деинсталляция', timeout: 180000, verbatim: true });
    assert.ok(!fs.existsSync(exe), 'после удаления остался EXE');
    assert.ok(fs.existsSync(path.join(profile, 'profile.json')), 'профиль пропал при удалении');
    cleaned = true;
  } finally {
    if (!cleaned && fs.existsSync(uninstall)) {
      try { run(uninstall, ['/S', `_?=${installDir}`], { label: 'очистка установки', verbatim: true }); }
      catch (error) { console.error(`Очистка не удалась: ${error.message}`); }
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
