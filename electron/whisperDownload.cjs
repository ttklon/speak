/** Подготовка Whisper: одна операция за раз, отмена и очистка .part. */
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const { pipeline } = require('node:stream/promises');

function removeTemporary(entries) {
  const failures = [];
  for (const [file, options] of entries) {
    try { fs.rmSync(file, options); }
    catch (err) { failures.push(`${file}: ${err.message}`); }
  }
  if (failures.length) {
    const failure = new Error(`не удалось удалить временные данные: ${failures.join('; ')}`);
    failure.cleanupFailed = true;
    throw failure;
  }
}

function createDownloadManager() {
  let active = null;

  function cancelDownload() {
    if (!active || active.controller.signal.aborted) return { ok: false, reason: 'нечего отменять' };
    active.controller.abort();
    return { ok: true };
  }

  function transfer(url, temporary, onProgress, signal, redirects = 0, maxBytes) {
    return new Promise((resolve, reject) => {
      if (redirects > 5) return reject(new Error('слишком много перенаправлений'));
      let address;
      try {
        address = new URL(url);
        if (!['http:', 'https:'].includes(address.protocol)) throw new Error();
      } catch {
        return reject(new Error('неверный адрес загрузки'));
      }
      const client = address.protocol === 'https:' ? https : http;
      let responseStarted = false;
      const req = client.get(address, {
        headers: { 'User-Agent': 'ZSpeakly', Accept: '*/*' },
        timeout: 120000,
        signal,
      }, (res) => {
        responseStarted = true;
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.on('error', () => {});
          res.resume();
          let next;
          try {
            next = new URL(res.headers.location, address);
            if (!['http:', 'https:'].includes(next.protocol) ||
                (address.protocol === 'https:' && next.protocol !== 'https:')) throw new Error();
          } catch {
            reject(new Error('неверный адрес перенаправления'));
            return;
          }
          transfer(next.toString(), temporary, onProgress, signal, redirects + 1, maxBytes).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.on('error', () => {});
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const total = Number(res.headers['content-length'] || 0);
        let received = 0;
        let nextProgressAt = 0;
        res.on('data', (chunk) => {
          received += chunk.length;
          if (maxBytes != null && received > maxBytes) {
            res.destroy(new Error('файл больше указанного размера'));
            return;
          }
          if (total && Date.now() >= nextProgressAt) {
            nextProgressAt = Date.now() + 200;
            try { onProgress?.(Math.round(received / total * 100), received, total); }
            catch (err) { res.destroy(err); }
          }
        });
        const file = fs.createWriteStream(temporary);
        pipeline(res, file, { signal }).then(() => {
          if (!received) throw new Error('сервер вернул пустой файл');
          if (total && received !== total) throw new Error('неполный файл');
          return received;
        }).then(resolve, reject);
      });
      req.on('timeout', () => req.destroy(new Error('таймаут загрузки')));
      req.on('error', (err) => { if (!responseStarted) reject(err); });
    });
  }

  // Для движка блокировка занимает и поиск релиза, и распаковку, а не только сеть.
  async function runExclusive(work) {
    if (active) throw new Error('другая операция подготовки уже выполняется');
    const operation = { controller: new AbortController() };
    active = operation;
    const signal = operation.controller.signal;
    try {
      return await work({ signal, download: (url, dest, onProgress, options) => downloadFile(url, dest, onProgress, signal, options) });
    } catch (err) {
      if (signal.aborted && !err.cleanupFailed) throw new Error('скачивание отменено');
      throw err;
    } finally {
      if (active === operation) active = null;
    }
  }

  async function downloadFile(url, dest, onProgress, signal, { maxBytes } = {}) {
    const tmp = `${dest}.part`;
    try {
      const bytes = await transfer(url, tmp, onProgress, signal, 0, maxBytes);
      if (signal.aborted) throw new Error('скачивание отменено');
      fs.renameSync(tmp, dest);
      return { bytes };
    } finally {
      // pipeline уже дождался закрытия файла — удаление безопаснее на Windows.
      removeTemporary([[tmp, { force: true }]]);
    }
  }

  function download(url, dest, onProgress) {
    return runExclusive((operation) => operation.download(url, dest, onProgress));
  }

  return { download, cancelDownload, runExclusive, isBusy: () => Boolean(active) };
}

module.exports = { createDownloadManager, removeTemporary };
