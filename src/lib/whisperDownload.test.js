// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const fs = require('node:fs');
const { createDownloadManager } = require('../../electron/whisperDownload.cjs');
let dir, server, base, manager, dest;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'zs-whisper-download-'));
  dest = join(dir, 'model.bin');
  manager = createDownloadManager();
  server = createServer((req, res) => {
    if (req.url === '/wait') return;
    if (req.url === '/stall') { res.writeHead(200, { 'Content-Length': '100' }); res.write('часть'); return; }
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/good' }); res.end(); return; }
    if (req.url === '/redirect-wait') { res.writeHead(302, { Location: '/wait' }); res.end(); return; }
    if (req.url === '/loop') { res.writeHead(302, { Location: '/loop' }); res.end(); return; }
    if (req.url === '/invalid') { res.writeHead(302, { Location: 'file:///file' }); res.end(); return; }
    if (req.url === '/broken') {
      res.writeHead(200, { 'Content-Length': '100' });
      res.write('часть');
      setTimeout(() => res.destroy(), 20);
      return;
    }
    if (req.url === '/empty') { res.end(); return; }
    if (req.url === '/good') { res.end('модель'); return; }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterEach(async () => {
  manager.cancelDownload();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

async function withTimeout(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('загрузка зависла')), 2000); })]);
  } finally { clearTimeout(timer); }
}

describe('загрузка Whisper', () => {
  it('следует относительному перенаправлению и сохраняет файл', async () => {
    const progress = [];
    const result = await manager.download(`${base}/redirect`, dest, (...args) => progress.push(args));
    expect(result.bytes).toBe(Buffer.byteLength('модель'));
    expect(readFileSync(dest, 'utf8')).toBe('модель');
    expect(readdirSync(dir)).toEqual(['model.bin']);
    expect(progress.at(-1)).toEqual([100, result.bytes, result.bytes]);
  });

  it.each(['/wait', '/redirect-wait'])('отменяет ожидание ответа %s и позволяет повторить', async (route) => {
    const requested = new Promise((resolve) => server.on('request', function listener(req) {
      if (req.url === '/wait') { server.off('request', listener); resolve(); }
    }));
    const task = manager.download(base + route, dest);
    const result = expect(withTimeout(task)).rejects.toThrow(/скачивание отменено/);
    await requested;
    expect(manager.cancelDownload()).toEqual({ ok: true });
    await result;
    expect(readdirSync(dir)).toEqual([]);
    await manager.download(`${base}/good`, dest);
    expect(readFileSync(dest, 'utf8')).toBe('модель');
  });

  it('отменяет поток после заголовков и удаляет .part до завершения', async () => {
    let cancel;
    const started = new Promise((resolve) => { cancel = resolve; });
    const task = manager.download(`${base}/stall`, dest, () => cancel());
    const result = expect(withTimeout(task)).rejects.toThrow(/скачивание отменено/);
    await started;
    expect(manager.cancelDownload().ok).toBe(true);
    await result;
    expect(readdirSync(dir)).toEqual([]);
  });

  it('не скрывает ошибку удаления временного файла при отмене', async () => {
    let cancel;
    const started = new Promise((resolve) => { cancel = resolve; });
    const task = manager.download(`${base}/stall`, dest, () => cancel());
    const original = fs.rmSync;
    const result = withTimeout(task).then(() => null, (err) => err);
    try {
      await started;
      fs.rmSync = (file, ...args) => {
        if (String(file) === `${dest}.part`) throw new Error('файл занят');
        return original(file, ...args);
      };
      expect(manager.cancelDownload().ok).toBe(true);
      const error = await result;
      expect(error.message).toMatch(/не удалось удалить.*файл занят/);
      expect(existsSync(`${dest}.part`)).toBe(true);
    } finally { fs.rmSync = original; }
  });

  it('не позволяет второй загрузке перезаписать активную и отменить её работу', async () => {
    const requested = new Promise((resolve) => server.once('request', resolve));
    const first = manager.download(`${base}/wait`, dest);
    const result = expect(withTimeout(first)).rejects.toThrow(/скачивание отменено/);
    await requested;
    await expect(manager.download(`${base}/good`, dest)).rejects.toThrow(/уже выполняется/);
    expect(manager.cancelDownload().ok).toBe(true);
    await result;
    expect(readdirSync(dir)).toEqual([]);
  });

  it('не заменяет существующий файл при обрыве', async () => {
    writeFileSync(dest, 'старый');
    await expect(withTimeout(manager.download(`${base}/broken`, dest))).rejects.toThrow();
    expect(readFileSync(dest, 'utf8')).toBe('старый');
    expect(existsSync(`${dest}.part`)).toBe(false);
  });

  it.each(['/loop', '/invalid', '/missing', '/empty'])('не оставляет файл при ошибке %s', async (route) => {
    await expect(withTimeout(manager.download(base + route, dest))).rejects.toThrow();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('закрывает поток и удаляет временный файл, если обработчик прогресса не сработал', async () => {
    await expect(withTimeout(manager.download(`${base}/good`, dest, () => { throw new Error('ошибка прогресса'); })))
      .rejects.toThrow('ошибка прогресса');
    expect(readdirSync(dir)).toEqual([]);
    await manager.download(`${base}/good`, dest);
    expect(readFileSync(dest, 'utf8')).toBe('модель');
  });

  it('отменяет сразу после запуска', async () => {
    const task = manager.download(`${base}/wait`, dest);
    expect(manager.cancelDownload().ok).toBe(true);
    await expect(withTimeout(task)).rejects.toThrow(/скачивание отменено/);
    expect(manager.cancelDownload().ok).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });
});
