// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const https = require('node:https');
const http = require('node:http');
const cp = require('node:child_process');
let dir;
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') return { app: { getPath: () => dir } };
  return originalLoad.call(this, name, ...args);
};
let models;
try { models = require('../../electron/models.cjs'); }
finally { Module._load = originalLoad; }

let server, base, originalGet, originalExec;
let behavior;
let requested;
let requestSeen;
const oldEngine = 'старая сборка';
const zipContents = Buffer.from('тестовый архив');
let archive;
const digest = (data) => `sha256:${createHash('sha256').update(data).digest('hex')}`;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "zs-engine-'-"));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'whisper-cli.exe'), oldEngine);
  behavior = 'ok';
  archive = zipContents;
  requested = new Promise((resolve) => { requestSeen = resolve; });
  server = createServer((req, res) => {
    if (req.url === '/releases') {
      if (behavior === 'wait') { requestSeen(); return; }
      if (behavior === 'body-wait') { res.writeHead(200); res.write('['); requestSeen(); return; }
      if (behavior === 'too-large') { res.end(Buffer.alloc(8 * 1024 * 1024 + 1, 0x20)); return; }
      if (behavior === 'broken') { res.writeHead(200, { 'Content-Length': '500' }); res.write('['); setTimeout(() => res.destroy(), 10); return; }
      if (behavior === 'http-error') { res.writeHead(503); res.end('ошибка'); return; }
      if (behavior === 'bad-json') { res.end('{'); return; }
      const size = behavior === 'wrong-size' ? archive.length + 1 : behavior === 'oversize' ? archive.length - 1 : archive.length;
      const hash = behavior === 'wrong-hash' ? digest('не тот архив') : behavior === 'invalid-hash' ? 'unknown:123' : behavior === 'no-hash' ? null : digest(archive);
      const url = behavior === 'insecure' ? 'http://example.test/zip' : 'https://example.test/zip';
      res.end(JSON.stringify([{ tag_name: 'test', assets: [{ name: 'whisper-bin-x64.zip', browser_download_url: url, size, digest: hash }] }]));
      return;
    }
    if (req.url === '/zip' && behavior === 'archive-wait') {
      res.writeHead(200, { 'Content-Length': '100' }); res.write('часть'); requestSeen(); return;
    }
    if (req.url === '/zip') { res.end(archive); return; }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  originalGet = https.get;
  originalExec = cp.execFile;
  https.get = (url, options, cb) => http.get(`${base}${new URL(url).hostname === 'api.github.com' ? '/releases' : '/zip'}`, options, cb);
});

afterEach(async () => {
  models.cancelDownload();
  https.get = originalGet;
  cp.execFile = originalExec;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('операция зависла')), 3000); })]); }
  finally { clearTimeout(timer); }
}

function fakeUnpack({ delayedClose = false, includeCli = true } = {}) {
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  cp.execFile = (_file, args, options, callback) => {
    const child = new EventEmitter();
    const out = join(dir, 'bin', '_unpacked');
    mkdirSync(join(out, 'Release'), { recursive: true });
    if (includeCli) writeFileSync(join(out, 'Release', 'whisper-cli.exe'), 'новая сборка');
    writeFileSync(join(out, 'Release', 'whisper-server.exe'), 'сервер');
    started({ args, options });
    if (delayedClose) {
      options.signal.addEventListener('abort', () => {
        callback(new Error('отмена'));
        setTimeout(() => child.emit('close', 1, null), 80);
      }, { once: true });
    } else {
      setTimeout(() => { callback(null); child.emit('close', 0, null); }, 0);
    }
    return child;
  };
  return ready;
}

describe('подготовка движка Whisper', () => {
  it('отменяет поиск до ответа и запрещает другую загрузку до окончания', async () => {
    behavior = 'wait';
    const first = models.downloadEngine(undefined, { force: true });
    await bounded(requested);
    const duplicate = await models.downloadEngine(undefined, { force: true });
    expect(duplicate.ok).toBe(false);
    expect(duplicate.reason).toMatch(/уже выполняется/);
    const model = await models.downloadModel('tiny');
    expect(model.ok).toBe(false);
    expect(model.reason).toMatch(/уже выполняется/);
    expect(models.cancelDownload().ok).toBe(true);
    const result = await bounded(first);
    expect(result).toMatchObject({ ok: false, canceled: true, reason: 'скачивание отменено' });
    expect(readFileSync(join(dir, 'bin', 'whisper-cli.exe'), 'utf8')).toBe(oldEngine);
    expect(readdirSync(join(dir, 'bin'))).toEqual(['whisper-cli.exe']);
  });

  it('отменяет ожидание незаконченного списка релизов', async () => {
    behavior = 'body-wait';
    const task = models.downloadEngine(undefined, { force: true });
    await bounded(requested);
    expect(models.cancelDownload().ok).toBe(true);
    expect(await bounded(task)).toMatchObject({ ok: false, canceled: true });
    expect(readdirSync(join(dir, 'bin'))).toEqual(['whisper-cli.exe']);
  });

  it.each(['broken', 'http-error', 'bad-json', 'too-large'])('сообщает ошибку поиска %s и разрешает повтор', async (mode) => {
    behavior = mode;
    expect((await bounded(models.downloadEngine(undefined, { force: true }))).ok).toBe(false);
    expect(readFileSync(join(dir, 'bin', 'whisper-cli.exe'), 'utf8')).toBe(oldEngine);
    behavior = 'ok';
    fakeUnpack();
    expect((await bounded(models.downloadEngine(undefined, { force: true }))).ok).toBe(true);
  });

  it('отменяет загрузку архива и сохраняет прежнюю сборку', async () => {
    behavior = 'archive-wait';
    const task = models.downloadEngine(undefined, { force: true });
    await bounded(requested);
    expect(models.cancelDownload().ok).toBe(true);
    expect(await bounded(task)).toMatchObject({ ok: false, canceled: true });
    expect(readdirSync(join(dir, 'bin'))).toEqual(['whisper-cli.exe']);
    expect(readFileSync(join(dir, 'bin', 'whisper-cli.exe'), 'utf8')).toBe(oldEngine);
  });

  it('после отмены распаковки ждёт закрытия процесса и освобождает файлы', async () => {
    const ready = fakeUnpack({ delayedClose: true });
    const task = models.downloadEngine(undefined, { force: true });
    const { args } = await bounded(ready);
    expect(args.at(-1)).toContain("''"); // апостроф в пути PowerShell экранирован
    expect(models.cancelDownload().ok).toBe(true);
    await wait(20);
    expect(existsSync(join(dir, 'bin', 'whisper-bin-x64.zip'))).toBe(true);
    expect(existsSync(join(dir, 'bin', '_unpacked'))).toBe(true);
    expect((await models.downloadEngine(undefined, { force: true })).reason).toMatch(/уже выполняется/);
    const result = await bounded(task);
    expect(result).toMatchObject({ ok: false, canceled: true });
    expect(readdirSync(join(dir, 'bin'))).toEqual(['whisper-cli.exe']);
    expect(readFileSync(join(dir, 'bin', 'whisper-cli.exe'), 'utf8')).toBe(oldEngine);
    fakeUnpack();
    expect((await bounded(models.downloadEngine(undefined, { force: true }))).ok).toBe(true);
  });

  it('устанавливает файлы после распаковки и очищает временные', async () => {
    const progress = [];
    fakeUnpack();
    const result = await bounded(models.downloadEngine((p) => progress.push(p), { force: true }));
    expect(result).toMatchObject({ ok: true, bin: true, server: true });
    expect(readFileSync(join(dir, 'bin', 'whisper-cli.exe'), 'utf8')).toBe('новая сборка');
    expect(readdirSync(join(dir, 'bin')).sort()).toEqual(['whisper-cli.exe', 'whisper-server.exe']);
    expect(progress.at(-1)).toBe(100);
  });

  it.each(['wrong-size', 'oversize', 'wrong-hash', 'invalid-hash', 'insecure'])('отклоняет архив при ошибке данных GitHub: %s', async (mode) => {
    behavior = mode;
    let unpacked = false;
    cp.execFile = () => { unpacked = true; throw new Error('распаковка не должна запускаться'); };
    const result = await bounded(models.downloadEngine(undefined, { force: true }));
    expect(result.ok).toBe(false);
    expect(unpacked).toBe(false);
    expect(readdirSync(join(dir, 'bin'))).toEqual(['whisper-cli.exe']);
    expect(readFileSync(join(dir, 'bin', 'whisper-cli.exe'), 'utf8')).toBe(oldEngine);
  });

  it('при отсутствии хеша у GitHub проверяет размер и распаковывает', async () => {
    behavior = 'no-hash';
    fakeUnpack();
    expect((await bounded(models.downloadEngine(undefined, { force: true }))).ok).toBe(true);
  });

  it.skipIf(process.platform !== 'win32').each([1, 2, 3])('распаковывает архив настоящим PowerShell при апострофе в пути — проверка %i', async () => {
    const source = join(dir, 'source');
    const fixture = join(dir, 'fixture.zip');
    mkdirSync(source);
    writeFileSync(join(source, 'whisper-cli.exe'), 'настоящая распаковка');
    writeFileSync(join(source, 'whisper-server.exe'), 'сервер');
    const quote = (value) => value.replace(/'/g, "''");
    cp.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Compress-Archive -Path '${quote(join(source, '*'))}' -DestinationPath '${quote(fixture)}' -Force`], { timeout: 30000 });
    archive = readFileSync(fixture);
    cp.execFile = (file, args, options, callback) => originalExec(file, args, options, (err, stdout, stderr) => {
      if (err) console.error('Ошибка проверочной распаковки:', err.message, stderr);
      callback(err, stdout, stderr);
    });
    const result = await models.downloadEngine(undefined, { force: true });
    expect(result, `результат установки: ${JSON.stringify(result)}`).toMatchObject({ ok: true, bin: true, server: true });
    expect(readFileSync(join(dir, 'bin', 'whisper-cli.exe'), 'utf8')).toBe('настоящая распаковка');
    expect(readdirSync(join(dir, 'bin')).sort()).toEqual(['whisper-cli.exe', 'whisper-server.exe']);
  }, 60000);

  it('не принимает архив без программы распознавания', async () => {
    fakeUnpack({ includeCli: false });
    const result = await bounded(models.downloadEngine(undefined, { force: true }));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/нет программы распознавания/);
    expect(readdirSync(join(dir, 'bin'))).toEqual(['whisper-cli.exe']);
    expect(readFileSync(join(dir, 'bin', 'whisper-cli.exe'), 'utf8')).toBe(oldEngine);
  });
});
