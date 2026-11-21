// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const cp = require('node:child_process');
const oldLoad = Module._load, oldSpawn = cp.spawn, oldRandom = Math.random;
let dir, children;
function fakeSpawn(file) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.exitCode = null;
  child.kill = () => { child.exitCode = 1; queueMicrotask(() => child.emit('close', 1)); return true; };
  children.push({ file, child });
  if (!String(file).includes('whisper-server')) queueMicrotask(() => {
    child.stdout.emit('data', Buffer.from('повтор через CLI'));
    child.exitCode = 0; child.emit('close', 0);
  });
  return child;
}
Module._load = function (name, ...args) {
  if (name === 'electron') return { app: { getPath: () => dir, getAppPath: () => join(dir, 'app') } };
  return oldLoad.call(this, name, ...args);
};
cp.spawn = fakeSpawn;
let whisper;
try { whisper = require('../../electron/whisper.cjs'); }
finally { Module._load = oldLoad; cp.spawn = oldSpawn; }
let server, port, wav, stage, requestStarted, clientClosed, bothStarted, bothClosed;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function bounded(task, ms = 3000) {
  let timer;
  try { return await Promise.race([task, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('таймаут теста')), ms); })]); }
  finally { clearTimeout(timer); }
}
async function bind(server) {
  for (let candidate = 17800; candidate < 18200; candidate++) {
    const ok = await new Promise((resolve) => {
      const fail = () => { server.off('listening', success); resolve(false); };
      const success = () => { server.off('error', fail); resolve(true); };
      server.once('error', fail); server.once('listening', success); server.listen(candidate, '127.0.0.1');
    });
    if (ok) return candidate;
  }
  throw new Error('нет свободного порта для сервера');
}
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'zs-runtime-http-'));
  mkdirSync(join(dir, 'bin')); mkdirSync(join(dir, 'models'));
  writeFileSync(join(dir, 'bin', 'whisper-cli.exe'), 'fixture');
  writeFileSync(join(dir, 'bin', 'whisper-server.exe'), 'fixture');
  writeFileSync(join(dir, 'models', 'ggml-small.bin'), 'fixture');
  wav = join(dir, 'voice.wav'); writeFileSync(wav, Buffer.alloc(32044));
  children = []; stage = 'warm';
  let started, closed, startedBoth, closedBoth, startedCount = 0, closedCount = 0;
  requestStarted = new Promise((resolve) => { started = resolve; });
  clientClosed = new Promise((resolve) => { closed = resolve; });
  bothStarted = new Promise((resolve) => { startedBoth = resolve; });
  bothClosed = new Promise((resolve) => { closedBoth = resolve; });
  server = createServer((req, res) => {
    if (req.method === 'GET') { res.end('{}'); return; }
    req.resume();
    if (stage === 'hold') {
      res.on('close', () => { closed(); if (++closedCount === 2) closedBoth(); });
      started(); if (++startedCount === 2) startedBoth();
      return;
    }
    if (stage === 'broken') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"text":');
      setTimeout(() => res.socket?.destroy(), 10);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ text: 'ответ сервера' }));
  });
  port = await bind(server);
  Math.random = () => (port - 17800 + 0.1) / 400;
});
afterEach(async () => {
  whisper.cancel(); whisper.stopServer(); Math.random = oldRandom;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await wait(10);
  rmSync(dir, { recursive: true, force: true });
});

describe('сервер Whisper: реальное локальное HTTP-соединение', () => {
  it('отмена закрывает запрос, не запускает CLI и допускает повтор', async () => {
    expect(await bounded(whisper.warm('small'))).toMatchObject({ ok: true, port });
    stage = 'hold';
    const task = whisper.transcribe(wav, { model: 'small', keepLoaded: true });
    await bounded(requestStarted);
    expect(whisper.isBusy()).toBe(true);
    expect(whisper.cancel()).toBe(true);
    expect(await bounded(task)).toMatchObject({ ok: false, code: 'cancelled' });
    await bounded(clientClosed);
    expect(children.filter((item) => !String(item.file).includes('whisper-server'))).toHaveLength(0);
    stage = 'ready';
    expect(await bounded(whisper.transcribe(wav, { model: 'small', keepLoaded: true }))).toMatchObject({ ok: true, mode: 'server', text: 'ответ сервера' });
  });
  it('отмена закрывает оба параллельных серверных фрагмента', async () => {
    expect(await bounded(whisper.warm('small'))).toMatchObject({ ok: true });
    stage = 'hold';
    const a = whisper.transcribe(wav, { model: 'small', keepLoaded: true });
    const b = whisper.transcribe(wav, { model: 'small', keepLoaded: true });
    await bounded(bothStarted);
    expect(whisper.cancel()).toBe(true);
    expect(await bounded(Promise.all([a, b]))).toEqual([expect.objectContaining({ code: 'cancelled' }), expect.objectContaining({ code: 'cancelled' })]);
    await bounded(bothClosed);
    expect(whisper.isBusy()).toBe(false);
    expect(children.filter((item) => !String(item.file).includes('whisper-server'))).toHaveLength(0);
  });
  it('обрыв ответа после заголовков переключает распознавание на CLI', async () => {
    expect(await bounded(whisper.warm('small'))).toMatchObject({ ok: true });
    stage = 'broken';
    expect(await bounded(whisper.transcribe(wav, { model: 'small', keepLoaded: true }))).toMatchObject({ ok: true, mode: 'cli', text: 'повтор через CLI' });
  });
});
