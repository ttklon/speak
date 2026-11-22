#!/usr/bin/env node
/** Два настоящих Electron с одним временным профилем; нужен дисплей. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const electron = require('electron');
const entry = path.resolve('scripts/e2e/electron-single-entry.cjs');

function start(role, dir) {
  const env = { ...process.env, ZS_E2E_PROFILE: dir, ZS_SINGLE_ROLE: role, ZSPEAKLY_DEV_URL: 'none' };
  delete env.ELECTRON_RUN_AS_NODE;
  const args = [...(process.platform === 'linux' ? ['--no-sandbox'] : []), entry, '--hidden'];
  const child = spawn(electron, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const state = { child, output: '', exited: false };
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { state.output = (state.output + chunk.toString()).slice(-50000); });
  state.finished = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => { state.exited = true; resolve({ code, signal }); });
  });
  return state;
}

async function waitFor(state, marker, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (state.output.includes(marker)) return;
    if (state.exited) throw new Error(`Процесс завершился без ${marker}:\n${state.output}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Не дождались ${marker}:\n${state.output}`);
}

async function finish(state, timeout = 20000) {
  let timer;
  try {
    return await Promise.race([
      state.finished,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Процесс не завершился:\n${state.output}`)), timeout); }),
    ]);
  } finally { clearTimeout(timer); }
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zs-single-e2e-'));
  const settings = { onboarded: true, speedFix151: true, modelTiers165: true, language: 'ru',
    whisperModel: 'small-q5_1', closeToTray: false, autoOptimize: false,
    keepModelLoaded: false, clipboardMonitor: false, checkUpdates: false, diagnostics: false };
  const file = path.join(dir, 'profile.json');
  fs.writeFileSync(file, JSON.stringify({ 'zs.settings': settings, 'zs:settings': settings }));
  let first;
  let second;
  try {
    first = start('primary', dir);
    await waitFor(first, 'SINGLE_PRIMARY_READY');
    assert.match(first.output, /SINGLE_LOCK primary true/);
    second = start('secondary', dir);
    const result = await finish(second);
    assert.equal(result.code, 0, `Второй процесс: ${result.code}/${result.signal}\n${second.output}`);
    assert.match(second.output, /SINGLE_LOCK secondary false/);
    assert.doesNotMatch(second.output, /SECONDARY_PROFILE_LOADED/);
    await waitFor(first, 'SINGLE_SECOND_SHOWN');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))['zs:single-e2e'], 'FIRST_PROCESS_DATA');
    first.child.stdin.write('quit\n');
    const firstExit = await finish(first);
    assert.equal(firstExit.code, 0, `Первый процесс: ${firstExit.code}/${firstExit.signal}\n${first.output}`);
    console.log('Electron: два процесса с общим профилем — второй отказан, первое окно показано, данные сохранены');
  } finally {
    for (const state of [first, second]) {
      if (state && !state.exited) { state.child.kill(); try { await finish(state, 5000); } catch { /* ОС завершает процесс */ } }
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
