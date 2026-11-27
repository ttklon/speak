#!/usr/bin/env node
/** Экспорт → отдельный чистый профиль → импорт → перезапуск настоящего Electron.
 * Системный выбор файла и проводник подменены; нужен дисплей. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const electron = require('electron');
const entry = path.resolve('scripts/e2e/electron-backup-entry.cjs');
const text = "Встреча O'Brien 😀\nВторая строка — привет!";
const settings = { onboarded: true, speedFix151: true, modelTiers165: true, language: 'ru',
  whisperModel: 'small-q5_1', closeToTray: false, autoOptimize: false,
  micPreroll: false, keepModelLoaded: false, clipboardMonitor: false, checkUpdates: false, diagnostics: false };

function run(mode, profile, desktop, backupFile = '') {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ZS_E2E_PROFILE: profile, ZSPEAKLY_DEV_URL: 'none',
      ZS_BACKUP_DESKTOP: desktop, ZS_BACKUP_MODE: mode, ZS_BACKUP_FILE: backupFile };
    delete env.ELECTRON_RUN_AS_NODE;
    const args = [...(process.platform === 'linux' ? ['--no-sandbox'] : []), entry, '--hidden'];
    const child = spawn(electron, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const collect = (chunk) => { output = (output + chunk.toString()).slice(-30000); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Таймаут Electron ${mode}:\n${output}`)); }, 70000);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0 || !output.includes(`BACKUP_E2E_OK ${mode}`)) {
        reject(new Error(`Electron ${mode}: ${code}/${signal}\n${output}`));
      } else resolve();
    });
  });
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zs-backup-e2e-'));
  const desktop = path.join(root, "Копии O'Brien 😀 с пробелами");
  const source = path.join(root, 'исходный профиль');
  const target = path.join(root, 'новый профиль');
  const failedTarget = path.join(root, 'профиль отказа');
  for (const dir of [desktop, source, target, failedTarget]) fs.mkdirSync(dir, { recursive: true });
  const sourceProfile = {
    'zs.settings': settings, 'zs:settings': settings,
    'zs.dictations': [{ id: 'backup-e2e-history', text, rawText: 'Оригинал 😀', createdAt: Date.now(), source: 'file', fileName: 'запись.wav', words: 5 }],
    'zs.dictionary': [{ id: 'backup-e2e-word', word: 'Термин', pronunciation: 'тэрмин', pinned: true, hits: 7, lastUsedAt: 1000, createdAt: Date.now() }],
    'zs.snippets': [{ id: 'backup-e2e-snippet', trigger: 'моя подпись', body: 'Первая строка\nВторая 😀', createdAt: Date.now() }],
    'zs.clipboard': [{ id: 'backup-e2e-clipboard', text: 'PRIVATE_CLIPBOARD_SENTINEL', createdAt: Date.now(), pinned: true }],
    'zs.profile': { name: 'Имя из копии' },
  };
  fs.writeFileSync(path.join(source, 'profile.json'), JSON.stringify(sourceProfile));
  fs.writeFileSync(path.join(target, 'profile.json'), JSON.stringify({ 'zs.settings': settings, 'zs:settings': settings }));
  fs.writeFileSync(path.join(failedTarget, 'profile.json'), JSON.stringify({ 'zs.settings': settings, 'zs:settings': settings,
    'zs.dictations': [{ id: 'old-history', text: 'старый текст', createdAt: Date.now() }],
    'zs.dictionary': [{ id: 'old-word', word: 'старое слово' }] }));
  try {
    await run('export', source, desktop);
    const files = fs.readdirSync(desktop).filter((name) => /^zspeakly-backup-.*\.json$/.test(name));
    assert.equal(files.length, 2, 'две копии должны иметь разные имена');
    const exports = files.map((name) => JSON.parse(fs.readFileSync(path.join(desktop, name), 'utf8')));
    for (const data of exports) {
      assert.equal(data.app, 'ZSpeakly');
      assert.equal(data.format, 1);
      assert.equal(data.dictations.find((item) => item.id === 'backup-e2e-history')?.text, text);
      assert.equal(data.dictionary.find((item) => item.id === 'backup-e2e-word')?.hits, 7);
      assert.equal(data.snippets.find((item) => item.id === 'backup-e2e-snippet')?.body, 'Первая строка\nВторая 😀');
      assert.equal(Object.hasOwn(data, 'clipboard'), false);
      assert.doesNotMatch(JSON.stringify(data), /PRIVATE_CLIPBOARD_SENTINEL/);
    }
    const file = path.join(desktop, files[0]);
    await run('import', target, desktop, file);
    await run('verify', target, desktop);
    await run('failure', failedTarget, desktop, file);
    const profile = JSON.parse(fs.readFileSync(path.join(target, 'profile.json'), 'utf8'));
    assert.equal(profile['zs.dictations'].find((item) => item.id === 'backup-e2e-history')?.text, text);
    assert.equal(profile['zs.dictations'].find((item) => item.id === 'backup-e2e-history')?.rawText, 'Оригинал 😀');
    assert.equal(profile['zs.dictionary'].find((item) => item.id === 'backup-e2e-word')?.hits, 7);
    assert.equal(profile['zs.snippets'].find((item) => item.id === 'backup-e2e-snippet')?.body, 'Первая строка\nВторая 😀');
    assert.equal(profile['zs.profile']?.name, 'Имя из копии');
    assert.ok(!profile['zs.clipboard']?.some((item) => item.id === 'backup-e2e-clipboard'));
    console.log('Electron backup: экспорт в Unicode-путь, импорт в отдельный профиль, перезапуск и отказ rename — OK (выбор файла и проводник подменены)');
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
