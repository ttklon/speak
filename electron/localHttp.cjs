'use strict';

// Запросы к модели выполняются в main: проверяем именно адрес сокета,
// не следуем редиректам и не считаем DNS-имя доказательством локальности.
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');
const net = require('node:net');
const zlib = require('node:zlib');

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

function isLocalAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 127 || a === 10 || (a === 192 && b === 168) ||
      (a === 172 && b >= 16 && b <= 31);
  }
  if (family === 6) {
    const value = address.toLowerCase();
    return value === '::1' || /^f[cd][0-9a-f]{2}:/.test(value) || /^fe[89ab][0-9a-f]:/.test(value);
  }
  return false;
}

function localTarget(url) {
  let target;
  try { target = new URL(String(url || '')); } catch { return { error: 'некорректный адрес' }; }
  if (!['http:', 'https:'].includes(target.protocol)) return { error: 'разрешены только http и https' };
  if (target.username || target.password) return { error: 'адрес с именем пользователя или паролем не поддерживается' };
  const host = target.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const name = host.endsWith('.') ? host.slice(0, -1) : host;
  if (!(isLocalAddress(host) || name === 'localhost' || (name.endsWith('.local') && name.length > 6))) {
    return { error: 'разрешены только локальные адреса' };
  }
  return { target };
}

/** Один HTTP-запрос, без перенаправлений; `lookup` можно подменить для тестов. */
async function requestLocal(url, { method = 'GET', body, timeout = 4000, lookup = dns.lookup } = {}) {
  const { target, error } = localTarget(url);
  if (error) return { ok: false, status: 0, reason: error };
  let data;
  try {
    if (method === 'POST') data = typeof body === 'string' ? body : JSON.stringify(body || {});
  } catch {
    return { ok: false, status: 0, reason: 'не удалось подготовить запрос' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await new Promise((resolve) => {
      let done = false;
      let response;
      let reader;
      const finish = (result) => {
        if (done) return;
        done = true;
        resolve(result);
      };
      const fail = (err) => {
        finish({
          ok: false, status: 0,
          reason: controller.signal.aborted ? 'локальная модель не ответила вовремя' : String(err?.message || err),
        });
        response?.destroy();
        if (reader && reader !== response) reader.destroy();
      };
      const safeLookup = (hostname, options, callback) => {
        // Node использует all:true для выбора IPv4/IPv6. Из всех ответов DNS
        // в сокет передаются только проверенные локальные IP, без повторного DNS.
        lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
          if (err) return callback(err);
          const local = (Array.isArray(addresses) ? addresses : []).filter((item) =>
            item && net.isIP(item.address) === item.family && isLocalAddress(item.address) &&
            (!(options.family === 4 || options.family === 6) || options.family === item.family));
          if (!local.length) return callback(new Error('имя не указывает на локальный адрес'));
          if (options.all) callback(null, local);
          else callback(null, local[0].address, local[0].family);
        });
      };
      let req;
      try {
        req = (target.protocol === 'https:' ? https : http).request(target, {
          method,
          signal: controller.signal,
          lookup: safeLookup,
          headers: method === 'POST' ? { 'Content-Type': 'application/json' } : {},
        }, (res) => {
          response = res;
          const code = res.statusCode || 0;
          if (code >= 300 && code < 400) {
            res.destroy();
            finish({ ok: false, status: code, reason: 'перенаправления локальной модели не поддерживаются' });
            return;
          }
          const encoding = String(res.headers['content-encoding'] || '').toLowerCase().trim();
          if (encoding && encoding !== 'identity') {
            if (encoding === 'gzip' || encoding === 'x-gzip') reader = zlib.createGunzip();
            else if (encoding === 'deflate') reader = zlib.createInflate();
            else if (encoding === 'br') reader = zlib.createBrotliDecompress();
            else { res.destroy(); finish({ ok: false, status: 0, reason: 'неподдерживаемое сжатие ответа' }); return; }
            res.pipe(reader);
          } else reader = res;
          const chunks = [];
          let size = 0;
          res.on('error', fail);
          res.on('aborted', () => fail(new Error('ответ локальной модели прерван')));
          reader.on('error', fail);
          reader.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_RESPONSE_BYTES) {
              finish({ ok: false, status: 0, reason: 'ответ локальной модели слишком велик' });
              reader.destroy();
              res.destroy();
              return;
            }
            chunks.push(chunk);
          });
          reader.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let parsed = null;
            try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text.slice(0, method === 'GET' ? 500 : 2000) }; }
            finish({ ok: code >= 200 && code < 300, status: code, data: parsed });
          });
        });
        req.on('error', fail);
        req.end(data);
      } catch (err) {
        response?.destroy();
        reader?.destroy();
        req?.destroy();
        fail(err);
      }
    });
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { isLocalAddress, localTarget, requestLocal, MAX_RESPONSE_BYTES };
