// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, openSync, closeSync, writeSync, ftruncateSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
let dir;
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') return { app: { getPath: () => dir } };
  return originalLoad.call(this, name, ...args);
};
let models;
try { models = require('../../electron/models.cjs'); }
finally { Module._load = originalLoad; }
let source, target;
const originalCopy = fs.copyFileSync;
const originalAsyncCopy = fs.promises.copyFile;
const originalRename = fs.renameSync;
const originalRemove = fs.rmSync;
const originalGet = https.get;

beforeEach(() => {
  Module._load = function (name, ...args) {
    if (name === 'electron') return { app: { getPath: () => dir } };
    return originalLoad.call(this, name, ...args);
  };
  dir = mkdtempSync(join(tmpdir(), 'zs-import-'));
  mkdirSync(join(dir, 'models'));
  mkdirSync(join(dir, 'source'));
  source = join(dir, 'source', 'ggml-tiny.bin');
  target = join(dir, 'models', 'ggml-tiny.bin');
  const fd = openSync(source, 'w');
  writeSync(fd, Buffer.from('lmgg'), 0, 4, 0);
  ftruncateSync(fd, 21 * 1024 * 1024);
  closeSync(fd);
});
afterEach(() => {
  Module._load = originalLoad;
  models.cancelDownload();
  fs.copyFileSync = originalCopy;
  fs.promises.copyFile = originalAsyncCopy;
  fs.renameSync = originalRename;
  fs.rmSync = originalRemove;
  https.get = originalGet;
  rmSync(dir, { recursive: true, force: true });
});

describe('безопасное подключение модели Whisper', () => {
  it('подключает подходящий файл и удаляет временные данные', async () => {
    writeFileSync(target, 'старая модель');
    const result = await models.importModel(source);
    expect(result).toMatchObject({ ok: true, id: 'tiny', path: target });
    expect(statSync(target).size).toBe(statSync(source).size);
    const fd = openSync(target, 'r');
    try { const head = Buffer.alloc(4); fs.readSync(fd, head, 0, 4, 0); expect(head.toString()).toBe('lmgg'); }
    finally { closeSync(fd); }
    expect(readdirSync(join(dir, 'models'))).toEqual(['ggml-tiny.bin']);
  });

  it('ошибка копирования не повреждает предыдущую модель', async () => {
    writeFileSync(target, 'старая модель');
    fs.promises.copyFile = async (_source, destination) => {
      writeFileSync(destination, 'оборванная копия');
      throw new Error('нет места');
    };
    const result = await models.importModel(source);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/нет места/);
    expect(readFileSync(target, 'utf8')).toBe('старая модель');
    expect(readdirSync(join(dir, 'models'))).toEqual(['ggml-tiny.bin']);
  });

  it('ошибка переименования не повреждает предыдущую модель', async () => {
    writeFileSync(target, 'старая модель');
    fs.renameSync = () => { throw new Error('файл занят'); };
    const result = await models.importModel(source);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/файл занят/);
    expect(readFileSync(target, 'utf8')).toBe('старая модель');
    expect(readdirSync(join(dir, 'models'))).toEqual(['ggml-tiny.bin']);
  });

  it('подключение того же файла не копирует и не изменяет его', async () => {
    originalCopy(source, target);
    fs.promises.copyFile = async () => { throw new Error('ненужная копия'); };
    const result = await models.importModel(target);
    expect(result).toMatchObject({ ok: true, id: 'tiny' });
    expect(statSync(target).size).toBe(statSync(source).size);
    expect(readdirSync(join(dir, 'models'))).toEqual(['ggml-tiny.bin']);
  });

  it('во время копирования не блокирует другие события и отмена не заменяет модель', async () => {
    writeFileSync(target, 'старая модель');
    let started, release;
    const ready = new Promise((resolve) => { started = resolve; });
    const pause = new Promise((resolve) => { release = resolve; });
    fs.promises.copyFile = async (_source, destination) => {
      writeFileSync(destination, 'недокопировано');
      started();
      await pause;
    };
    const task = models.importModel(source);
    try {
      await ready;
      // Другая операция может обратиться к менеджеру, пока копирование ждёт.
      const conflict = await models.downloadModel('base');
      expect(conflict.reason).toMatch(/уже выполняется/);
      expect(models.cancelDownload().ok).toBe(true);
      release();
      expect(await task).toMatchObject({ ok: false, canceled: true });
      expect(readFileSync(target, 'utf8')).toBe('старая модель');
      expect(readdirSync(join(dir, 'models'))).toEqual(['ggml-tiny.bin']);
    } finally { release(); await task; }
  });

  it('при отмене сообщает, если не удалось удалить временную копию', async () => {
    writeFileSync(target, 'старая модель');
    let started, release;
    const ready = new Promise((resolve) => { started = resolve; });
    const pause = new Promise((resolve) => { release = resolve; });
    fs.promises.copyFile = async (_source, destination) => {
      writeFileSync(destination, 'часть'); started(); await pause;
    };
    const task = models.importModel(source);
    try {
      await ready;
      fs.rmSync = (file, ...args) => {
        if (String(file).includes('.import-')) throw new Error('файл занят');
        return originalRemove(file, ...args);
      };
      expect(models.cancelDownload().ok).toBe(true);
      release();
      const result = await task;
      expect(result.ok).toBe(false);
      expect(result.canceled).not.toBe(true);
      expect(result.cleanupFailed).toBe(true);
      expect(result.reason).toMatch(/не удалось удалить.*файл занят/);
      expect(readFileSync(target, 'utf8')).toBe('старая модель');
    } finally { release(); await task; fs.rmSync = originalRemove; }
  });

  it('не перезаписывает модель во время другой подготовки', async () => {
    let started;
    const requested = new Promise((resolve) => { started = resolve; });
    const server = createServer((_req, _res) => started());
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    https.get = (_url, options, cb) => http.get(`http://127.0.0.1:${server.address().port}/`, options, cb);
    let task;
    try {
      task = models.downloadModel('base');
      await requested;
      const result = await models.importModel(source);
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/уже выполняется/);
      expect(readdirSync(join(dir, 'models'))).toEqual([]);
      expect(models.cancelDownload().ok).toBe(true);
      expect(await task).toMatchObject({ ok: false, canceled: true });
    } finally {
      models.cancelDownload();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await task;
    }
  });
});
