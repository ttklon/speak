#!/usr/bin/env node
/** Настоящий IPC и системный буфер только одноразового GitHub-hosted Windows. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

if (process.platform !== 'win32' || process.env.CI !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted') {
  throw new Error('Проверка буфера разрешена только в изолированном Windows CI');
}
const electron = require('electron');
const entry = path.resolve('scripts/e2e/electron-clipboard-image-entry.cjs');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zs-clipboard-image-e2e-'));
  const settings = { onboarded: true, speedFix151: true, modelTiers165: true, language: 'ru',
    whisperModel: 'small-q5_1', closeToTray: false, autoOptimize: false, micPreroll: false,
    keepModelLoaded: false, clipboardMonitor: false, checkUpdates: false, diagnostics: false };
  const pinned = { id: 'pinned-ci', kind: 'text', text: 'закреплённая строка для CI', source: 'исходный источник', createdAt: Date.now() - 10000, pinned: true };
  fs.writeFileSync(path.join(root, 'profile.json'), JSON.stringify({ 'zs.settings': settings, 'zs:settings': settings, 'zs.clipboard': [pinned] }));
  try {
    const env = { ...process.env, ZS_E2E_PROFILE: root, ZSPEAKLY_DEV_URL: 'none', ZS_CLIPBOARD_IMAGE_E2E: '1' };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electron, [entry, '--hidden'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (part) => { output = (output + part.toString()).slice(-30000); });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 90000);
    let result;
    try {
      result = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal }));
      });
    } finally { clearTimeout(timer); }
    if (timedOut || result.code !== 0 || !output.includes('CLIPBOARD_IMAGE_E2E_OK') || !output.includes('CLIPBOARD_PIN_E2E_OK')) {
      throw new Error(`Electron clipboard: ${timedOut ? 'timeout' : `${result.code}/${result.signal}`}\n${output}`);
    }
    const profile = JSON.parse(fs.readFileSync(path.join(root, 'profile.json'), 'utf8'));
    const original = profile['zs.clipboard']?.find((item) => item.id === pinned.id);
    if (!original?.pinned || original.text !== pinned.text || original.source !== pinned.source || original.createdAt !== pinned.createdAt) {
      throw new Error('Закреплённая запись не сохранена в тестовом профиле');
    }
    console.log('CLIPBOARD_IMAGE_E2E_OK CLIPBOARD_PIN_E2E_OK: реальный IPC, системный буфер и сохранение закреплённого на изолированном Windows CI');
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
