// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const { downloadFiles, hashFile } = require('../../electron/modelDownload.cjs');
const digest = (data) => createHash('sha256').update(data).digest('hex');
let dir;
let server;
let baseUrl;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'zs-model-test-'));
  server = createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/good' }); res.end(); return; }
    if (req.url === '/stall') { res.writeHead(200); res.write('часть'); return; }
    if (req.url === '/waiting') return;
    if (req.url === '/bursts') {
      let sent = 0;
      const timer = setInterval(() => {
        res.write('x');
        if (++sent === 20) { clearInterval(timer); res.end(); }
      }, 2);
      res.on('close', () => clearInterval(timer));
      return;
    }
    if (req.url === '/loop') { res.writeHead(302, { Location: '/loop' }); res.end(); return; }
    if (req.url === '/invalid') { res.writeHead(302, { Location: 'http://[' }); res.end(); return; }
    if (req.url === '/protocol') { res.writeHead(302, { Location: 'file:///tmp/file' }); res.end(); return; }
    if (req.url === '/broken') { res.writeHead(200, { 'Content-Length': '500' }); res.write('часть'); res.socket.destroy(); return; }
    if (req.url === '/good' || req.url === '/file') { res.end('модель'); return; }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

const manifest = (name, data = 'модель', size = Buffer.byteLength(data)) => ({ name, size, sha256: digest(data) });
const run = (file, state = { cancelled: false }, onProgress) => downloadFiles({ dir, files: [file], baseUrl, missing: [file.name], state, onProgress });

describe('безопасная загрузка модели', () => {
  it('скачивает после перенаправления и проверяет размер и хеш', async () => {
    const progress = [];
    const file = manifest('redirect');
    const result = await run(file, { cancelled: false }, (p) => progress.push(p.received));
    expect(readFileSync(join(dir, file.name), 'utf8')).toBe('модель');
    expect(result.received).toBe(file.size);
    expect(progress.at(-1)).toBe(file.size);
    expect(readdirSync(dir)).toEqual(['redirect']);
  });

  it('не принимает файл с другим размером даже при совпадающем хеше', async () => {
    await expect(run(manifest('file', 'модель', 100))).rejects.toThrow(/размер/i);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('не заменяет ранее сохранённый файл при неверном хеше', async () => {
    writeFileSync(join(dir, 'file'), 'старая модель');
    const file = { name: 'file', size: Buffer.byteLength('модель'), sha256: digest('не та') };
    await expect(run(file)).rejects.toThrow(/повреждён/);
    expect(readFileSync(join(dir, 'file'), 'utf8')).toBe('старая модель');
    expect(readdirSync(dir)).toEqual(['file']);
  });

  it('после обрыва соединения удаляет временный файл', async () => {
    await expect(run(manifest('broken'))).rejects.toThrow();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('отменяет зависшую загрузку, не дожидаясь конца ответа', async () => {
    const state = { cancelled: false };
    const task = run(manifest('stall'), state, () => {
      state.cancelled = true;
      state.abort?.();
    });
    let timer;
    try {
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('отмена зависла')), 2000); });
      await expect(Promise.race([task, timeout])).rejects.toThrow(/скачивание отменено/);
      expect(readdirSync(dir)).toEqual([]);
    } finally { clearTimeout(timer); }
  });

  it('отменяет запрос, если сервер ещё не прислал заголовки', async () => {
    const state = { cancelled: false };
    const requested = new Promise((resolve) => server.once('request', resolve));
    const task = run(manifest('waiting'), state);
    const rejection = expect(task).rejects.toThrow(/скачивание отменено/);
    await requested;
    state.cancelled = true;
    state.abort();
    await rejection;
    expect(readdirSync(dir)).toEqual([]);
  });

  it('останавливает скачивание, если сервер прислал больше положенного', async () => {
    await expect(run(manifest('file', 'модель', 2))).rejects.toThrow(/размер/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('после отмены второго файла оставляет первый завершённый', async () => {
    const first = manifest('file');
    const second = manifest('stall');
    const state = { cancelled: false };
    const task = downloadFiles({ dir, files: [first, second], baseUrl, missing: [first.name, second.name], state,
      onProgress: ({ file }) => { if (file === 'stall') { state.cancelled = true; state.abort(); } },
    });
    await expect(task).rejects.toThrow(/скачивание отменено/);
    expect(readdirSync(dir)).toEqual(['file']);
    expect(readFileSync(join(dir, 'file'), 'utf8')).toBe('модель');
  });

  it('завершает ошибкой цикл перенаправлений и ответ 404', async () => {
    await expect(run(manifest('loop'))).rejects.toThrow(/перенаправлений/);
    await expect(run(manifest('missing'))).rejects.toThrow(/404/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('ограничивает частые обновления прогресса и сообщает итог', async () => {
    const progress = [];
    const file = manifest('bursts', 'x'.repeat(20));
    await run(file, { cancelled: false }, ({ received }) => progress.push(received));
    expect(progress[0]).toBeGreaterThan(0);
    expect(progress.at(-1)).toBe(20);
    expect(progress.length).toBeLessThan(20);
  });

  it('отклоняет неверный адрес или неподходящий протокол перенаправления', async () => {
    await expect(run(manifest('invalid'))).rejects.toThrow(/адрес перенаправления/);
    await expect(run(manifest('protocol'))).rejects.toThrow(/адрес перенаправления/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('проверку хеша тоже можно отменить', async () => {
    const file = join(dir, 'local');
    writeFileSync(file, 'модель');
    const controller = new AbortController();
    controller.abort();
    await expect(hashFile(file, controller.signal)).rejects.toThrow();
  });
});
