import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import http from 'node:http';
import { gzipSync } from 'node:zlib';

const require = createRequire(import.meta.url);
const { localTarget, requestLocal, MAX_RESPONSE_BYTES } = require('../../electron/localHttp.cjs');

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const close = (server) => { server.closeAllConnections(); server.close(); };

describe('граница локального HTTP', () => {
  it('проверяет целый IP, а не начало имени; сохраняет локальные адреса', () => {
    for (const url of ['http://localhost:11434', 'http://127.0.0.1', 'http://10.2.3.4', 'http://172.16.3.4', 'https://192.168.1.2', 'http://[::1]', 'http://[fc00::1]', 'http://[fe80::1]', 'http://ollama.local']) {
      expect(localTarget(url).target, url).toBeTruthy();
    }
    for (const url of ['http://10.example.com', 'http://192.168.example.com', 'http://172.16.example.com', 'http://0.0.0.0', 'http://8.8.8.8', 'http://172.32.1.1', 'http://[fc::1]', 'http://[fe8::1]', 'http://[::ffff:8.8.8.8]', 'http://example.com', 'file:///etc/passwd', 'http://user:secret@localhost']) {
      expect(localTarget(url).error, url).toBeTruthy();
    }
  });

  it('подставной DNS .local не приводит к подключению к внешнему адресу', async () => {
    let calls = 0;
    const lookup = (_host, _options, cb) => { calls += 1; cb(null, [{ address: '8.8.8.8', family: 4 }]); };
    const result = await requestLocal('http://model.local:12345/api/generate', { method: 'POST', body: { prompt: 'private' }, timeout: 1000, lookup });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/локальн/i);
    expect(calls).toBe(1);
  });

  it('фиксирует разрешённый DNS-адрес на соединении и читает gzip', async () => {
    const server = http.createServer((req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
      res.end(gzipSync(JSON.stringify({ response: 'готово' })));
    });
    await listen(server);
    let calls = 0;
    try {
      const lookup = (_host, _options, cb) => { calls += 1; cb(null, [{ address: '127.0.0.1', family: 4 }, { address: '8.8.8.8', family: 4 }]); };
      const result = await requestLocal(`http://model.local:${server.address().port}/api/generate`, { method: 'POST', body: { prompt: 'test' }, timeout: 2000, lookup });
      expect(result).toMatchObject({ ok: true, status: 200, data: { response: 'готово' } });
      expect(calls).toBe(1);
    } finally { close(server); }
  });

  it('не выдаёт повреждённый сжатый ответ за успех', async () => {
    const server = http.createServer((req, res) => {
      req.resume();
      res.writeHead(200, { 'content-encoding': 'gzip' });
      res.end('не gzip');
    });
    await listen(server);
    try {
      const result = await requestLocal(`http://127.0.0.1:${server.address().port}/`, { timeout: 2000 });
      expect(result.ok).toBe(false);
      expect(result.status).toBe(0);
    } finally { close(server); }
  });

  it('ограничивает распакованный ответ и не раскрывает содержимое', async () => {
    const compressed = gzipSync(Buffer.alloc(MAX_RESPONSE_BYTES + 1, 65));
    const server = http.createServer((req, res) => {
      req.resume();
      res.writeHead(200, { 'content-encoding': 'gzip' });
      res.end(compressed);
    });
    await listen(server);
    try {
      const result = await requestLocal(`http://127.0.0.1:${server.address().port}/`, { timeout: 5000 });
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/слишком велик/i);
      expect(result.data).toBeUndefined();
    } finally { close(server); }
  });

  it('поздний DNS после таймаута не открывает соединение', async () => {
    let received = 0;
    const server = http.createServer((_req, res) => { received += 1; res.end('{}'); });
    await listen(server);
    try {
      const lookup = (_host, _options, cb) => setTimeout(() => cb(null, [{ address: '127.0.0.1', family: 4 }]), 150);
      const result = await requestLocal(`http://slow.local:${server.address().port}/`, { timeout: 40, lookup });
      expect(result.ok).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(received).toBe(0);
    } finally { close(server); }
  });
});
