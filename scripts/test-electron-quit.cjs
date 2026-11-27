#!/usr/bin/env node
/** Изолированный тест обычного выхода через настоящий Electron и IPC.
 * Нужен дисплей (на Linux — xvfb-run); системный диалог подменён. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const executable = require('electron');
const entry = path.resolve('scripts/e2e/electron-quit-entry.cjs');

async function run(mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zs-quit-e2e-'));
  const settings = { onboarded: true, speedFix151: true, modelTiers165: true, language: 'ru',
    whisperModel: 'small-q5_1', closeToTray: false, autoOptimize: false,
    keepModelLoaded: false, clipboardMonitor: false, checkUpdates: false, diagnostics: false };
  fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify({ 'zs.settings': settings, 'zs:settings': settings }));
  const env = { ...process.env, ZS_E2E_PROFILE: dir, ZSPEAKLY_DEV_URL: 'none', ZS_QUIT_MODE: mode };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    const result = await new Promise((resolve, reject) => {
      const args = process.platform === 'linux' ? ['--no-sandbox', entry] : [entry];
      const child = spawn(executable, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      const collect = (chunk) => { output = (output + chunk.toString()).slice(-30000); };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      const timer = setTimeout(() => { child.kill(); reject(new Error(`Electron не завершился: ${mode}\n${output}`)); }, 60000);
      child.on('error', (error) => { clearTimeout(timer); reject(error); });
      child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, output }); });
    });
    assert.equal(result.code, 0, `Electron ${mode}: exit=${result.code}, signal=${result.signal}\n${result.output}`);
    assert.ok(result.output.includes(`QUIT_E2E_OK ${mode}`), `нет подтверждения ${mode}:\n${result.output}`);
    console.log(`Electron: ${mode} — OK (подменены ошибка диска и системный диалог)`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

(async () => {
  await run('stay');
  await run('force');
})().catch((error) => { console.error(error); process.exitCode = 1; });
