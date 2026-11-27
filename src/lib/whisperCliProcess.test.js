// @vitest-environment node
// Настоящий дочерний процесс Node имитирует CLI; это не запуск модели Whisper.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const cp = require('node:child_process');
let whisper, root, wav, originalLoad, originalSpawn;
let scenario = '';

describe('Whisper CLI: поток от настоящего дочернего процесса-заглушки', () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'zs-cli-process-'));
    mkdirSync(join(root, 'bin')); mkdirSync(join(root, 'models'));
    writeFileSync(join(root, 'bin', 'whisper-cli.exe'), 'placeholder');
    writeFileSync(join(root, 'models', 'ggml-small.bin'), 'placeholder');
    wav = join(root, 'voice.wav'); writeFileSync(wav, Buffer.alloc(32044));
    const fixture = join(root, 'fake-cli.cjs');
    writeFileSync(fixture, `
      const fs = require('node:fs');
      const [scenario, out] = process.argv.slice(2);
      if (scenario === 'split') {
        const text = Buffer.from('Привет мир');
        process.stdout.write(text.subarray(0, 1));
        setTimeout(() => process.stdout.end(text.subarray(1)), 30);
      } else {
        process.stdout.write('начало ' + 'a'.repeat(41000) + ' конец');
        if (scenario === 'file') fs.writeFileSync(out + '.txt', 'полный ответ из файла');
      }
    `);
    chmodSync(fixture, 0o700);
    originalLoad = Module._load; originalSpawn = cp.spawn;
    Module._load = function (name, ...args) {
      if (name === 'electron') return { app: { getPath: () => root, getAppPath: () => join(root, 'app') } };
      return originalLoad.call(this, name, ...args);
    };
    cp.spawn = (_bin, args, options) => originalSpawn(process.execPath, [fixture, scenario, args[args.indexOf('-of') + 1]], options);
    try { whisper = require('../../electron/whisper.cjs'); }
    finally { Module._load = originalLoad; cp.spawn = originalSpawn; }
  });
  afterAll(() => { whisper?.cancel(); rmSync(root, { recursive: true, force: true }); });

  it('сохраняет символ UTF-8 через две записи в stdout', async () => {
    scenario = 'split';
    const res = await whisper.transcribe(wav, { model: 'small', timeout: 5000 });
    expect(res).toMatchObject({ ok: true, text: 'Привет мир' });
  });

  it('отмечает усечённый stdout как неполный', async () => {
    scenario = 'long';
    const res = await whisper.transcribe(wav, { model: 'small', timeout: 5000 });
    expect(res).toMatchObject({ ok: false, text: '', code: 'cli-output-truncated' });
    expect(res.partialText).toMatch(/обрезан/);
    expect(res.partialText).toMatch(/конец/);
  });

  it('берёт файл при длинном журнале процесса', async () => {
    scenario = 'file';
    const res = await whisper.transcribe(wav, { model: 'small', timeout: 5000 });
    expect(res).toMatchObject({ ok: true, text: 'полный ответ из файла' });
  });
});
