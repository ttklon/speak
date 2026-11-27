#!/usr/bin/env node
/** Запись синтетического CI-экрана настоящим Electron, проверка сохранения и декодирования. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

if (process.platform !== 'win32' || process.env.CI !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted') {
  throw new Error('Захват разрешён только в изолированном Windows CI');
}
const electron = require('electron');
const entry = path.resolve('scripts/e2e/electron-screen-recording-entry.cjs');

async function run(profile, videoDir) {
  const env = { ...process.env, ZS_E2E_PROFILE: profile, ZSPEAKLY_DEV_URL: 'none', ZS_SCREEN_E2E: '1', ZS_SCREEN_VIDEO_DIR: videoDir };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [entry, '--hidden'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let timedOut = false;
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (part) => { output = (output + part.toString()).slice(-30000); });
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, 105000);
  try {
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    if (timedOut || result.code !== 0 || !output.includes('SCREEN_E2E_OK ')) {
      throw new Error(`Electron screen recording: ${timedOut ? 'timeout' : `${result.code}/${result.signal}`}\n${output}`);
    }
    console.log(output.split(/\r?\n/).find((line) => line.startsWith('SCREEN_E2E_OK ')));
  } finally { clearTimeout(timer); }
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zs-screen-e2e-'));
  const profile = path.join(root, 'профиль');
  const videos = path.join(root, "Видео O'Brien 😀");
  fs.mkdirSync(profile, { recursive: true });
  fs.mkdirSync(videos, { recursive: true });
  const settings = { onboarded: true, speedFix151: true, modelTiers165: true, language: 'ru',
    whisperModel: 'small-q5_1', closeToTray: false, autoOptimize: false, micPreroll: false,
    keepModelLoaded: false, clipboardMonitor: false, checkUpdates: false, diagnostics: false };
  fs.writeFileSync(path.join(profile, 'profile.json'), JSON.stringify({ 'zs.settings': settings, 'zs:settings': settings }));
  try {
    await run(profile, videos);
    const files = fs.readdirSync(videos).filter((name) => name.endsWith('.webm'));
    assert.equal(files.length, 1, 'должен остаться один файл');
    const data = fs.readFileSync(path.join(videos, files[0]));
    assert.ok(data.length >= 1024);
    assert.equal(data.subarray(0, 4).toString('hex'), '1a45dfa3');
    console.log('Electron screen recording: реальный захват CI-экрана, сохранение и декодирование синтетического кадра — OK');
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
