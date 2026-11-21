// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const originalLoad = Module._load;
let root;
Module._load = function (name, ...args) {
  if (name === 'electron') return { app: { getPath: () => join(root, 'profile'), getAppPath: () => join(root, 'app') } };
  return originalLoad.call(this, name, ...args);
};
let whisper, models;
try {
  whisper = require('../../electron/whisper.cjs');
  models = require('../../electron/models.cjs');
} finally { Module._load = originalLoad; }
let resources, originalResources, originalPath;
function put(dir, name) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, 'fixture');
  return file;
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'zs-discovery-'));
  resources = join(root, 'resources');
  originalResources = process.resourcesPath;
  originalPath = process.env.PATH;
  process.resourcesPath = resources;
  process.env.PATH = join(root, 'empty-path');
});
afterEach(() => {
  if (originalResources === undefined) delete process.resourcesPath; else process.resourcesPath = originalResources;
  if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
  rmSync(root, { recursive: true, force: true });
});

describe('файлы Whisper в комплекте и профиле', () => {
  it('считает поставленные в комплекте движок, сервер и VAD доступными', () => {
    put(join(resources, 'bin'), 'whisper-cli.exe');
    put(join(resources, 'bin'), 'whisper-server.exe');
    const vad = put(join(resources, 'models'), 'ggml-silero-v6.2.0.bin');
    put(join(resources, 'models'), 'ggml-base-q5_1.bin');
    expect(models.modelStatus()).toMatchObject({ bin: true, server: true, vad: true, vadPath: vad, models: { 'base-q5_1': { downloaded: false, available: true } } });
  });
  it('не скачивает уже поставленные движок и VAD', async () => {
    put(join(resources, 'bin'), 'whisper-cli.exe');
    const vad = put(join(resources, 'models'), 'ggml-silero-v6.2.0.bin');
    const model = put(join(resources, 'models'), 'ggml-base-q5_1.bin');
    expect(await models.downloadEngine()).toMatchObject({ ok: true, already: true, path: join(resources, 'bin') });
    expect(await models.downloadVad()).toMatchObject({ ok: true, already: true, path: vad });
    expect(await models.downloadModel('base-q5_1')).toMatchObject({ ok: true, already: true, path: model });
  });
  it('после установки сервера выбирает CLI и сервер одного комплекта', () => {
    put(join(resources, 'bin'), 'whisper-cli.exe');
    const cli = put(join(root, 'profile', 'bin'), 'whisper-cli.exe');
    put(join(root, 'profile', 'bin'), 'whisper-server.exe');
    expect(whisper.findBinary()).toBe(cli);
    expect(whisper.serverStatus().available).toBe(true);
  });
  it('не объявляет сервер из чужого комплекта частью одинокого CLI', () => {
    put(join(resources, 'bin'), 'whisper-cli.exe');
    put(join(root, 'profile', 'bin'), 'whisper-server.exe');
    expect(whisper.findBinary()).toBe(join(resources, 'bin', 'whisper-cli.exe'));
    expect(whisper.serverStatus().available).toBe(false);
  });
  it('новый комплект приложения имеет приоритет над старым полным комплектом профиля', () => {
    const cli = put(join(resources, 'bin'), 'whisper-cli.exe');
    put(join(resources, 'bin'), 'whisper-server.exe');
    put(join(root, 'profile', 'bin'), 'whisper-cli.exe');
    put(join(root, 'profile', 'bin'), 'whisper-server.exe');
    expect(whisper.findBinary()).toBe(cli);
    expect(whisper.serverStatus().available).toBe(true);
  });
  it('учитывает в статусе поддерживаемую старую модель, не входящую в каталог загрузок', () => {
    put(join(resources, 'models'), 'ggml-large-v3.bin');
    expect(models.modelStatus().availableModel).toBe(true);
    expect(whisper.findModel('base-q5_1')).toBe(join(resources, 'models', 'ggml-large-v3.bin'));
  });
  it('находит выбранную модель в профиле до запасной из комплекта', () => {
    put(join(resources, 'models'), 'ggml-small.bin');
    const wanted = put(join(root, 'profile', 'models'), 'ggml-base-q5_1.bin');
    expect(whisper.findModel('base-q5_1')).toBe(wanted);
  });
  it('при одинаковом имени использует модель из профиля, а не старую копию из комплекта', () => {
    put(join(resources, 'models'), 'ggml-small-q5_1.bin');
    const chosen = put(join(root, 'profile', 'models'), 'ggml-small-q5_1.bin');
    expect(whisper.findModel('small-q5_1')).toBe(chosen);
  });
  it.each(['tiny-q5_1', 'base-q5_1', 'small-q5_1', 'large-v3-turbo-q8_0'])('использует %s как запасную модель', (id) => {
    const fallback = put(join(root, 'profile', 'models'), `ggml-${id}.bin`);
    expect(whisper.findModel('medium')).toBe(fallback);
  });
});
